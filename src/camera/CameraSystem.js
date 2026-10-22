import * as THREE from '../../vendor/three.module.js';
import { clamp, damp } from '../utils/math.js';

/**
 * Dual-Perspective Camera Controller (FPV Nose Cam, Dynamic Chase Cam,
 * and Detached Post-Detonation External Spectator Camera) + WebGL FLIR Post-Processing.
 */
export class CameraSystem {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(
      68,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.2,
      19500
    );

    // View mode: 'FPV' | 'CHASE' (default: FPV)
    this.viewMode = 'FPV';

    // Optical mode: 'DAY' | 'WHITE_HOT' | 'BLACK_HOT' (default: WHITE_HOT)
    this.opticalMode = 'WHITE_HOT';

    // Dynamic chase camera state
    this.chaseCurrentPos = new THREE.Vector3(0, 362, 954);
    this.chaseCurrentLookAt = new THREE.Vector3(0, 360, 940);
    this.chaseSmoothQuat = new THREE.Quaternion();
    this.prevSpeedMs = 30.56;
    this.accelLagOffset = 0.0;
    this.shakeIntensity = 0.0;
    this.elapsedTime = 0.0;

    // Detached Post-Detonation Spectator Camera state
    this.isSpectatingBlast = false;
    this.blastCenter = new THREE.Vector3();
    this.spectatorLookTarget = new THREE.Vector3();
    this.spectatorOrbitAngle = 0.0;
    this.spectatorRadiusM = 52.0; // 45-60 meters away from detonation point
    this.spectatorHeightOffsetM = 16.0; // Slightly above detonation point
    this.trackEnemyWreckage = false;

    // Pre-allocated scratch vectors/quaternions (zero per-frame heap allocations)
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._noseOffset = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._levelUp = new THREE.Vector3(0, 1, 0);
    this._blendedUp = new THREE.Vector3();
    this._targetMix = new THREE.Vector3();

    this._initThermalPostProcess();
  }

  _initThermalPostProcess() {
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);

    this.renderTarget = new THREE.WebGLRenderTarget(
      Math.max(1, size.x),
      Math.max(1, size.y),
      {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        depthBuffer: true
      }
    );

    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.flirUniforms = {
      tDiffuse: { value: this.renderTarget.texture },
      uTime: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(size.x, size.y) },
      uPolarity: { value: 0 } // 0 = WHITE_HOT, 1 = BLACK_HOT
    };

    const flirShader = new THREE.ShaderMaterial({
      uniforms: this.flirUniforms,
      depthWrite: false,
      depthTest: false,
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform int uPolarity;
        varying vec2 vUv;

        float hash12(vec2 p) {
          vec3 p3  = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          float scanline = sin(vUv.y * uResolution.y * 1.35 + uTime * 8.0);
          vec2 uv = vUv;

          vec3 texCol = texture2D(tDiffuse, uv).rgb;
          float lum = dot(texCol, vec3(0.299, 0.587, 0.114));

          // Enhance thermal contrast S-curve so hot UAV engine, fireball & debris glow sharply
          float thermal = smoothstep(0.03, 0.96, lum);
          thermal = mix(thermal, pow(thermal, 0.80), 0.58);

          // High-contrast bloom boost on ultra-hot pixels (explosion fireball & UAV motor/wreckage)
          if (lum > 0.68) {
            thermal = mix(thermal, 1.0, smoothstep(0.68, 0.92, lum));
          }

          // Subtle FLIR sensor grain noise & scanline modulation
          float grain = (hash12(uv * uResolution + vec2(uTime * 67.3, uTime * 19.7)) - 0.5) * 0.055;
          float lineMod = scanline * 0.018;
          thermal = clamp(thermal + grain + lineMod, 0.0, 1.0);

          // Vignette darkening around optical sensor edges
          vec2 centered = vUv - 0.5;
          float vig = 1.0 - dot(centered, centered) * 0.48;
          thermal *= clamp(vig, 0.45, 1.0);

          vec3 finalCol = vec3(thermal * 0.97, thermal * 0.99, thermal * 1.01);
          gl_FragColor = vec4(finalCol, 1.0);
        }
      `
    });

    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.postQuad = new THREE.Mesh(quadGeo, flirShader);
    this.postScene.add(this.postQuad);
  }

  /**
   * Toggles between FPV (Nose Camera) and 3rd-Person Chase Camera.
   */
  toggleViewMode() {
    this.viewMode = this.viewMode === 'FPV' ? 'CHASE' : 'FPV';
    this.camera.fov = this.viewMode === 'FPV' ? 68 : 60;
    this.camera.updateProjectionMatrix();
    return this.viewMode;
  }

  /**
   * Cycles Optical Mode: DAY -> WHITE_HOT -> BLACK_HOT -> DAY
   */
  toggleOpticalMode() {
    if (this.opticalMode === 'DAY') {
      this.opticalMode = 'WHITE_HOT';
      this.flirUniforms.uPolarity.value = 0;
    } else if (this.opticalMode === 'WHITE_HOT') {
      this.opticalMode = 'BLACK_HOT';
      this.flirUniforms.uPolarity.value = 1;
    } else {
      this.opticalMode = 'DAY';
    }
    return this.opticalMode;
  }

  setOpticalMode(mode) {
    this.opticalMode = mode;
    this.flirUniforms.uPolarity.value = mode === 'BLACK_HOT' ? 1 : 0;
  }

  addCameraShake(intensity = 1.0) {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  /**
   * Immediately detaches the camera from the player UAV and repositions it to an external
   * spectator observation point 45-60 meters away and slightly above the detonation center,
   * looking directly at the explosion and tracking the falling burning wreckage.
   *
   * @param {THREE.Vector3} blastPos - World position of the detonation center
   * @param {THREE.Quaternion} aircraftQuat - Orientation of player aircraft at detonation
   * @param {boolean} hitEnemy - Whether the enemy UAV was within blast range
   * @param {Function} [getTerrainHeight] - Terrain elevation callback
   */
  enterSpectatorDetonationMode(blastPos, aircraftQuat, hitEnemy = false, getTerrainHeight = null) {
    this.isSpectatingBlast = true;
    this.trackEnemyWreckage = Boolean(hitEnemy);
    this.blastCenter.copy(blastPos);
    this.spectatorLookTarget.copy(blastPos);

    // Place spectator camera 52m away (within 45-60m spec) at an oblique rear-side angle & +16m above
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(aircraftQuat);
    this.spectatorOrbitAngle = Math.atan2(-forward.x, -forward.z) + 0.65;
    this.spectatorRadiusM = 52.0;
    this.spectatorHeightOffsetM = 16.0;

    const camX = blastPos.x + Math.sin(this.spectatorOrbitAngle) * this.spectatorRadiusM;
    const camZ = blastPos.z + Math.cos(this.spectatorOrbitAngle) * this.spectatorRadiusM;
    let camY = blastPos.y + this.spectatorHeightOffsetM;

    if (getTerrainHeight) {
      const groundY = getTerrainHeight(camX, camZ);
      camY = Math.max(camY, groundY + 8.0);
    }

    this.camera.fov = 55;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(camX, camY, camZ);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.blastCenter);
  }

  /**
   * Resets camera back to the player aircraft on mission restart.
   */
  resetToAircraft(aircraftPos, aircraftQuat) {
    this.isSpectatingBlast = false;
    this.trackEnemyWreckage = false;
    this.camera.fov = this.viewMode === 'FPV' ? 68 : 60;
    this.camera.updateProjectionMatrix();

    this.chaseSmoothQuat.copy(aircraftQuat);
    this._desiredPos.set(0, 0.85, 3.6).applyQuaternion(aircraftQuat).add(aircraftPos);
    this.chaseCurrentPos.copy(this._desiredPos);
    this._desiredLook.set(0, 0.1, -12.0).applyQuaternion(aircraftQuat).add(aircraftPos);
    this.chaseCurrentLookAt.copy(this._desiredLook);
    this.accelLagOffset = 0.0;
    this.shakeIntensity = 0.0;
  }

  /**
   * Updates camera transform each frame.
   */
  update(dt, interpState, telemetry, getTerrainHeight, interceptorModel, enemyPosition = null) {
    this.elapsedTime += dt;
    this.flirUniforms.uTime.value = this.elapsedTime;

    // Decay blast/buffet shake
    this.shakeIntensity = Math.max(0.0, this.shakeIntensity - dt * 2.4);

    // 1. Detached External Spectator Camera Mode (Post-Detonation / Crash)
    if (this.isSpectatingBlast || telemetry.detonated || telemetry.crashed) {
      if (!this.isSpectatingBlast) {
        this.enterSpectatorDetonationMode(
          interpState.position,
          interpState.quaternion,
          false,
          getTerrainHeight
        );
      }

      // Slowly orbit around the blast zone at 52m distance
      this.spectatorOrbitAngle += 0.28 * dt;
      const camX = this.blastCenter.x + Math.sin(this.spectatorOrbitAngle) * this.spectatorRadiusM;
      const camZ = this.blastCenter.z + Math.cos(this.spectatorOrbitAngle) * this.spectatorRadiusM;
      let camY = this.blastCenter.y + this.spectatorHeightOffsetM;

      if (getTerrainHeight) {
        const minGround = getTerrainHeight(camX, camZ) + 6.0;
        if (camY < minGround) camY = minGround;
      }

      this.camera.position.set(camX, camY, camZ);
      if (this.shakeIntensity > 0.01) {
        this.camera.position.x += Math.sin(this.elapsedTime * 48.0) * 0.35 * this.shakeIntensity;
        this.camera.position.y += Math.cos(this.elapsedTime * 55.0) * 0.35 * this.shakeIntensity;
      }

      // Track the explosion center and smoothly follow the falling burning enemy UAV wreckage
      if (this.trackEnemyWreckage && enemyPosition) {
        this._targetMix.lerpVectors(this.blastCenter, enemyPosition, 0.65);
        this.spectatorLookTarget.lerp(this._targetMix, 1.0 - Math.exp(-5.0 * dt));
      } else {
        this.spectatorLookTarget.lerp(this.blastCenter, 1.0 - Math.exp(-5.0 * dt));
      }

      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.spectatorLookTarget);
      return;
    }

    const pos = interpState.position;
    const quat = interpState.quaternion;
    const speedMs = telemetry.airspeedMs;
    const stallVibration = telemetry.stallFactor * 0.15;
    const totalVib = this.shakeIntensity + stallVibration;

    if (this.viewMode === 'FPV') {
      // 2. Nose-Mounted FPV Camera Perspective
      interceptorModel.setFpvVisibility(true);

      this._noseOffset.set(0, 0.015, -0.76);
      if (totalVib > 0.001) {
        this._noseOffset.x += Math.sin(this.elapsedTime * 47.0) * 0.012 * totalVib;
        this._noseOffset.y += Math.cos(this.elapsedTime * 59.0) * 0.012 * totalVib;
      }
      this._noseOffset.applyQuaternion(quat).add(pos);

      this.camera.position.copy(this._noseOffset);
      this.camera.quaternion.copy(quat);

      this.chaseSmoothQuat.copy(quat);
      this.chaseCurrentPos.copy(pos);
    } else {
      // 3. Dynamic 3rd-Person Chase Camera with acceleration lag & bank coupling
      interceptorModel.setFpvVisibility(false);

      const accelMs2 = (speedMs - this.prevSpeedMs) / Math.max(0.001, dt);
      this.prevSpeedMs = speedMs;
      const targetLag = clamp(accelMs2 * 0.045, -0.45, 0.85);
      this.accelLagOffset = damp(this.accelLagOffset, targetLag, 4.5, dt);

      this.chaseSmoothQuat.slerp(quat, 1.0 - Math.exp(-9.5 * dt));

      const trailDist = 3.45 + this.accelLagOffset + clamp((speedMs - 25.0) * 0.025, -0.2, 0.55);
      const trailHeight = 0.82;

      this._desiredPos.set(0, trailHeight, trailDist).applyQuaternion(this.chaseSmoothQuat).add(pos);

      if (getTerrainHeight) {
        const groundY = getTerrainHeight(this._desiredPos.x, this._desiredPos.z);
        if (this._desiredPos.y < groundY + 1.2) {
          this._desiredPos.y = groundY + 1.2;
        }
      }

      this.chaseCurrentPos.lerp(this._desiredPos, 1.0 - Math.exp(-16.0 * dt));

      if (totalVib > 0.001) {
        this.chaseCurrentPos.x += Math.sin(this.elapsedTime * 43.0) * 0.08 * totalVib;
        this.chaseCurrentPos.y += Math.cos(this.elapsedTime * 51.0) * 0.08 * totalVib;
      }

      this._desiredLook.set(0, 0.14, -10.0).applyQuaternion(quat).add(pos);
      this.chaseCurrentLookAt.lerp(this._desiredLook, 1.0 - Math.exp(-20.0 * dt));

      this._up.set(0, 1, 0).applyQuaternion(this.chaseSmoothQuat);
      this._blendedUp.lerpVectors(this._levelUp, this._up, 0.45).normalize();

      this.camera.position.copy(this.chaseCurrentPos);
      this.camera.up.copy(this._blendedUp);
      this.camera.lookAt(this.chaseCurrentLookAt);
    }
  }

  /**
   * Renders the 3D scene either directly (Daylight) or through the FLIR post-processing pass.
   * Note: Keeps active Thermal/FLIR shader enabled during post-detonation spectator sequence!
   */
  render() {
    if (this.opticalMode === 'DAY') {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    } else {
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.postScene, this.postCamera);
    }
  }

  onResize(width, height) {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    this.renderTarget.setSize(Math.max(1, size.x), Math.max(1, size.y));
    this.flirUniforms.uResolution.value.set(size.x, size.y);
  }

  dispose() {
    this.renderTarget.dispose();
    this.postQuad.geometry.dispose();
    this.postQuad.material.dispose();
  }
}
