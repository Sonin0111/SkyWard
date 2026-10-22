import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../utils/math.js';

/**
 * Procedural 3D Model of the Player's Fixed-Wing Interceptor UAV.
 * Modeled directly after the tactical fixed-wing UAV reference photos in /references:
 * - Sleek white molded composite teardrop fuselage with recessed nose FPV camera & antenna
 * - High-mounted tapered airfoil wing with upturned winglets & dark charcoal animated ailerons
 * - Dihedral V-tail with animated dark charcoal ruddervator control surfaces
 * - Twin rear pusher brushless motor pods with spinning 2-blade carbon propellers & blur discs
 * - Visual damage & structural fragmentation feedback on detonation or impact
 */
export class InterceptorModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'InterceptorUAV';

    // Sub-groups for exterior mesh (hidden in FPV nose camera view to avoid clipping)
    this.airframeGroup = new THREE.Group();
    this.root.add(this.airframeGroup);

    // Control surface pivot groups
    this.leftAileronPivot = new THREE.Group();
    this.rightAileronPivot = new THREE.Group();
    this.leftRuddervatorPivot = new THREE.Group();
    this.rightRuddervatorPivot = new THREE.Group();

    // Propeller spinner groups
    this.leftPropGroup = new THREE.Group();
    this.rightPropGroup = new THREE.Group();
    this.centerPropGroup = new THREE.Group();
    this.propBlurDiscs = [];

    // Detachable structural parts for crash/detonation breakup animation
    this.breakableParts = [];
    this.isDamaged = false;

    this._initMaterials();
    this._buildFuselage();
    this._buildMainWing();
    this._buildVTail();
    this._buildPusherPropulsion();
    this._buildDetailsAndAntennas();
  }

  _initMaterials() {
    this.materials = {
      fuselageWhite: new THREE.MeshStandardMaterial({
        color: 0xf1f4f8,
        roughness: 0.42,
        metalness: 0.06
      }),
      wingWhite: new THREE.MeshStandardMaterial({
        color: 0xeef2f6,
        roughness: 0.46,
        metalness: 0.05
      }),
      controlSurfaceDark: new THREE.MeshStandardMaterial({
        color: 0x22262b,
        roughness: 0.55,
        metalness: 0.15
      }),
      carbonDark: new THREE.MeshStandardMaterial({
        color: 0x16191d,
        roughness: 0.35,
        metalness: 0.45
      }),
      cameraLens: new THREE.MeshStandardMaterial({
        color: 0x090d14,
        roughness: 0.12,
        metalness: 0.85
      }),
      panelSeam: new THREE.MeshStandardMaterial({
        color: 0x9aa4b0,
        roughness: 0.6,
        metalness: 0.1
      }),
      gpsModule: new THREE.MeshStandardMaterial({
        color: 0x6d7f69,
        roughness: 0.4,
        metalness: 0.2
      }),
      propBlur: new THREE.MeshBasicMaterial({
        color: 0x1e2329,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthWrite: false
      }),
      damagedCharred: new THREE.MeshStandardMaterial({
        color: 0x262320,
        roughness: 0.88,
        metalness: 0.1,
        emissive: 0x331100,
        emissiveIntensity: 0.35
      })
    };

    // Tag thermal signature for FLIR mode
    Object.values(this.materials).forEach((m) => {
      m.userData = { thermalSignature: 0.35 };
    });
    this.materials.carbonDark.userData.thermalSignature = 0.85;
  }

  _buildFuselage() {
    // Sculpted aerodynamic teardrop fuselage profile along Z axis
    // Nose at Z = -0.78m, widest payload belly at Z = -0.22m, tapering to tailcone at Z = +0.72m
    const stations = [
      { z: -0.78, rx: 0.018, ryTop: 0.015, ryBot: 0.018, yOff: -0.015 },
      { z: -0.72, rx: 0.052, ryTop: 0.042, ryBot: 0.048, yOff: -0.008 },
      { z: -0.60, rx: 0.088, ryTop: 0.072, ryBot: 0.076, yOff: 0.0 },
      { z: -0.42, rx: 0.118, ryTop: 0.095, ryBot: 0.096, yOff: 0.005 },
      { z: -0.22, rx: 0.126, ryTop: 0.102, ryBot: 0.100, yOff: 0.008 }, // Heavy 7.5kg payload bay
      { z: 0.02,  rx: 0.114, ryTop: 0.094, ryBot: 0.088, yOff: 0.008 },
      { z: 0.26,  rx: 0.084, ryTop: 0.074, ryBot: 0.068, yOff: 0.006 },
      { z: 0.50,  rx: 0.056, ryTop: 0.052, ryBot: 0.048, yOff: 0.005 },
      { z: 0.70,  rx: 0.036, ryTop: 0.035, ryBot: 0.035, yOff: 0.004 }
    ];

    const radialSegments = 24;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let s = 0; s < stations.length; s++) {
      const st = stations[s];
      const v = s / (stations.length - 1);
      for (let r = 0; r <= radialSegments; r++) {
        const u = r / radialSegments;
        const theta = u * Math.PI * 2.0;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        const ry = sinT >= 0 ? st.ryTop : st.ryBot;
        const x = cosT * st.rx;
        const y = sinT * ry + st.yOff;
        const z = st.z;

        positions.push(x, y, z);
        uvs.push(u, v);
      }
    }

    const ringVerts = radialSegments + 1;
    for (let s = 0; s < stations.length - 1; s++) {
      for (let r = 0; r < radialSegments; r++) {
        const a = s * ringVerts + r;
        const b = (s + 1) * ringVerts + r;
        const c = (s + 1) * ringVerts + (r + 1);
        const d = s * ringVerts + (r + 1);

        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    const fuseGeo = new THREE.BufferGeometry();
    fuseGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    fuseGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    fuseGeo.setIndex(indices);
    fuseGeo.computeVertexNormals();

    const fuselageMesh = new THREE.Mesh(fuseGeo, this.materials.fuselageWhite);
    fuselageMesh.castShadow = true;
    fuselageMesh.receiveShadow = true;
    this.airframeGroup.add(fuselageMesh);

    // Dorsal payload hatch cover seam & latches (visible in reference photos)
    const hatchGeo = new THREE.BoxGeometry(0.13, 0.008, 0.46);
    const hatchMesh = new THREE.Mesh(hatchGeo, this.materials.wingWhite);
    hatchMesh.position.set(0, 0.104, -0.26);
    this.airframeGroup.add(hatchMesh);

    const latchGeo = new THREE.BoxGeometry(0.018, 0.012, 0.028);
    const latchL = new THREE.Mesh(latchGeo, this.materials.controlSurfaceDark);
    latchL.position.set(-0.042, 0.106, -0.14);
    const latchR = latchL.clone();
    latchR.position.x = 0.042;
    this.airframeGroup.add(latchL, latchR);
  }

  _buildMainWing() {
    // High-mounted straight tapered wing with airfoil profile & upturned winglets
    // Span = 2.24 m (half-span = 1.12 m), root chord = 0.28 m, tip chord = 0.21 m
    const wingGroup = new THREE.Group();
    wingGroup.position.set(0, 0.045, -0.12);
    this.airframeGroup.add(wingGroup);

    const buildHalfWing = (side) => {
      // side: +1 = Right Wing (+X), -1 = Left Wing (-X)
      const halfGroup = new THREE.Group();

      // Main wing panel from root (0.08m) to outer tip (1.04m)
      const spanLen = 0.98;
      const wingGeo = this._createTaperedAirfoilGeometry(
        spanLen,
        0.28, // root chord
        0.21, // tip chord
        0.034,// root thickness
        0.022,// tip thickness
        side,
        0.035 // slight trailing-edge sweep / leading-edge taper
      );
      const wingMesh = new THREE.Mesh(wingGeo, this.materials.wingWhite);
      wingMesh.position.x = side * 0.07;
      wingMesh.rotation.z = side * 0.022; // subtle dihedral
      wingMesh.castShadow = true;
      wingMesh.receiveShadow = true;
      halfGroup.add(wingMesh);

      // Curved upturned wingtip (winglet) as seen in Screenshot 2026-10-22 164020.png
      const tipGeo = new THREE.BoxGeometry(0.09, 0.014, 0.19);
      const tipMesh = new THREE.Mesh(tipGeo, this.materials.wingWhite);
      tipMesh.position.set(side * 1.075, 0.038, 0.015);
      tipMesh.rotation.z = side * 0.42;
      tipMesh.castShadow = true;
      halfGroup.add(tipMesh);

      // Outer dark-charcoal Aileron control surface (as seen in bpla-2-800x800.jpg & stf1-800x800.jpg)
      const aileronPivot = side > 0 ? this.rightAileronPivot : this.leftAileronPivot;
      aileronPivot.position.set(side * 0.76, 0.014, 0.078);

      const aileronGeo = new THREE.BoxGeometry(0.42, 0.010, 0.056);
      const aileronMesh = new THREE.Mesh(aileronGeo, this.materials.controlSurfaceDark);
      aileronMesh.position.set(0, 0, 0.028); // Hinged along leading edge of aileron
      aileronMesh.castShadow = true;
      aileronPivot.add(aileronMesh);

      halfGroup.add(aileronPivot);
      this._registerBreakable(halfGroup);
      return halfGroup;
    };

    wingGroup.add(buildHalfWing(1));
    wingGroup.add(buildHalfWing(-1));

    // Wing-root fairing saddle
    const saddleGeo = new THREE.BoxGeometry(0.24, 0.035, 0.30);
    const saddleMesh = new THREE.Mesh(saddleGeo, this.materials.fuselageWhite);
    saddleMesh.position.set(0, 0.008, 0.0);
    wingGroup.add(saddleMesh);
  }

  /**
   * Builds a genuine NACA-style cambered airfoil mesh along the span.
   */
  _createTaperedAirfoilGeometry(span, rootChord, tipChord, rootThick, tipThick, side, sweepZ) {
    const chordSteps = 14;
    const spanSteps = 8;
    const positions = [];
    const indices = [];

    // Sample closed airfoil loop around chord (upper surface LE->TE, then lower surface TE->LE)
    const totalProfilePts = chordSteps * 2;

    for (let is = 0; is <= spanSteps; is++) {
      const tSpan = is / spanSteps;
      const x = side * tSpan * span;
      const chord = rootChord + (tipChord - rootChord) * tSpan;
      const thick = rootThick + (tipThick - rootThick) * tSpan;
      const zLead = -chord * 0.45 + tSpan * sweepZ;

      for (let ic = 0; ic <= totalProfilePts; ic++) {
        const isUpper = ic <= chordSteps;
        const xc = isUpper
          ? ic / chordSteps
          : 1.0 - (ic - chordSteps) / chordSteps;

        // NACA 4-digit thickness distribution + subtle positive camber
        const yt = 5.0 * thick * (
          0.2969 * Math.sqrt(Math.max(0, xc)) -
          0.1260 * xc -
          0.3516 * xc * xc +
          0.2843 * xc * xc * xc -
          0.1015 * xc * xc * xc * xc
        );
        const camber = 0.018 * chord * (4.0 * xc * (1.0 - xc));
        const y = isUpper ? camber + yt : camber - yt * 0.65;
        const z = zLead + xc * chord;

        positions.push(x, y, z);
      }
    }

    const ringCount = totalProfilePts + 1;
    for (let is = 0; is < spanSteps; is++) {
      for (let ic = 0; ic < totalProfilePts; ic++) {
        const a = is * ringCount + ic;
        const b = (is + 1) * ringCount + ic;
        const c = (is + 1) * ringCount + (ic + 1);
        const d = is * ringCount + (ic + 1);

        if (side > 0) {
          indices.push(a, d, b);
          indices.push(b, d, c);
        } else {
          indices.push(a, b, d);
          indices.push(b, c, d);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _buildVTail() {
    // Characteristic V-Tail with prominent black ruddervator strips (bpla-2-800x800.jpg & stf1-800x800.jpg)
    const vTailRoot = new THREE.Group();
    vTailRoot.position.set(0, 0.032, 0.56);
    this.airframeGroup.add(vTailRoot);

    const dihedralAngle = 36.0 * (Math.PI / 180.0);

    const buildTailFin = (side) => {
      const finContainer = new THREE.Group();
      finContainer.rotation.z = side * dihedralAngle;

      // White fixed stabilizer fin
      const finSpan = 0.34;
      const finGeo = this._createTaperedAirfoilGeometry(
        finSpan,
        0.18,
        0.12,
        0.018,
        0.012,
        side,
        0.04
      );
      const finMesh = new THREE.Mesh(finGeo, this.materials.wingWhite);
      finMesh.position.x = side * 0.02;
      finMesh.castShadow = true;
      finContainer.add(finMesh);

      // Animated dark-charcoal Ruddervator control surface on trailing edge
      const rvPivot = side > 0 ? this.rightRuddervatorPivot : this.leftRuddervatorPivot;
      rvPivot.position.set(side * 0.19, 0.0, 0.055);

      const rvGeo = new THREE.BoxGeometry(0.29, 0.009, 0.052);
      const rvMesh = new THREE.Mesh(rvGeo, this.materials.controlSurfaceDark);
      rvMesh.position.set(0, 0, 0.026);
      rvMesh.castShadow = true;
      rvPivot.add(rvMesh);

      finContainer.add(rvPivot);
      this._registerBreakable(finContainer);
      return finContainer;
    };

    vTailRoot.add(buildTailFin(1));
    vTailRoot.add(buildTailFin(-1));
  }

  _buildPusherPropulsion() {
    // Twin rear brushless pusher motor pylons & propellers (Screenshot 2026-10-22 164020.png)
    // plus rear tailcone hub cap (stf1-800x800.jpg)
    const propSystemGroup = new THREE.Group();
    propSystemGroup.position.set(0, 0.012, 0.52);
    this.airframeGroup.add(propSystemGroup);

    const createMotorPodAndProp = (side, targetSpinnerGroup) => {
      const podGroup = new THREE.Group();
      const xOffset = side * 0.175;

      // Streamlined composite strut pylon extending from aft fuselage
      const strutGeo = new THREE.BoxGeometry(0.14, 0.016, 0.065);
      const strutMesh = new THREE.Mesh(strutGeo, this.materials.fuselageWhite);
      strutMesh.position.set(side * 0.095, 0.0, -0.02);
      strutMesh.rotation.y = side * -0.18;
      podGroup.add(strutMesh);

      // Brushless motor bell housing (dark metallic carbon)
      const motorGeo = new THREE.CylinderGeometry(0.024, 0.026, 0.048, 16);
      motorGeo.rotateX(Math.PI / 2);
      const motorMesh = new THREE.Mesh(motorGeo, this.materials.carbonDark);
      motorMesh.position.set(xOffset, 0.0, 0.02);
      podGroup.add(motorMesh);

      // Spinner + 2-blade propeller assembly
      targetSpinnerGroup.position.set(xOffset, 0.0, 0.052);

      const hubGeo = new THREE.ConeGeometry(0.018, 0.038, 14);
      hubGeo.rotateX(Math.PI / 2);
      const hubMesh = new THREE.Mesh(hubGeo, this.materials.carbonDark);
      targetSpinnerGroup.add(hubMesh);

      // 2-blade folding/fixed carbon pusher blades
      const bladeGeo = new THREE.BoxGeometry(0.26, 0.022, 0.004);
      const blade1 = new THREE.Mesh(bladeGeo, this.materials.carbonDark);
      blade1.rotation.z = 0.08;
      blade1.rotation.x = 0.24; // blade pitch angle
      targetSpinnerGroup.add(blade1);

      // Translucent rotor blur disc (scales opacity with RPM)
      const discGeo = new THREE.CircleGeometry(0.132, 24);
      const discMesh = new THREE.Mesh(discGeo, this.materials.propBlur);
      discMesh.position.z = -0.002;
      targetSpinnerGroup.add(discMesh);
      this.propBlurDiscs.push(discMesh);

      podGroup.add(targetSpinnerGroup);
      return podGroup;
    };

    propSystemGroup.add(createMotorPodAndProp(1, this.rightPropGroup));
    propSystemGroup.add(createMotorPodAndProp(-1, this.leftPropGroup));

    // Rear fuselage tailcone hub cap (visible in stf1-800x800.jpg)
    const rearCapGeo = new THREE.CylinderGeometry(0.028, 0.032, 0.055, 16);
    rearCapGeo.rotateX(Math.PI / 2);
    const rearCap = new THREE.Mesh(rearCapGeo, this.materials.carbonDark);
    rearCap.position.set(0, -0.006, 0.20);
    propSystemGroup.add(rearCap);
  }

  _buildDetailsAndAntennas() {
    // 1. Nose-mounted recessed FPV optical/IR camera housing & vertical antenna (bpla-2-800x800.jpg)
    const noseBayGroup = new THREE.Group();
    noseBayGroup.position.set(0, -0.004, -0.745);
    this.airframeGroup.add(noseBayGroup);

    // Camera housing body
    const camBodyGeo = new THREE.BoxGeometry(0.036, 0.034, 0.042);
    const camBody = new THREE.Mesh(camBodyGeo, this.materials.carbonDark);
    noseBayGroup.add(camBody);

    // Glass optical lens barrel
    const lensGeo = new THREE.CylinderGeometry(0.013, 0.013, 0.022, 16);
    lensGeo.rotateX(Math.PI / 2);
    const lensMesh = new THREE.Mesh(lensGeo, this.materials.cameraLens);
    lensMesh.position.set(0, -0.002, -0.016);
    noseBayGroup.add(lensMesh);

    // Nose vertical video-transmitter / telemetry antenna stalk (prominent in bpla-2-800x800.jpg)
    const noseAntGeo = new THREE.CylinderGeometry(0.0035, 0.0045, 0.115, 8);
    const noseAnt = new THREE.Mesh(noseAntGeo, this.materials.carbonDark);
    noseAnt.position.set(0, 0.058, 0.015);
    noseAnt.rotation.x = -0.08;
    noseBayGroup.add(noseAnt);

    // 2. Dorsal GPS / compass patch behind wing (visible in bpla-2-800x800.jpg & stf1-800x800.jpg)
    const gpsGeo = new THREE.BoxGeometry(0.028, 0.006, 0.028);
    const gpsMesh = new THREE.Mesh(gpsGeo, this.materials.gpsModule);
    gpsMesh.position.set(0, 0.082, 0.16);
    this.airframeGroup.add(gpsMesh);

    // 3. Twin control-link dipole whisker antennas on aft fuselage sides
    const whiskerGeo = new THREE.CylinderGeometry(0.0018, 0.0018, 0.11, 6);
    const whiskerL = new THREE.Mesh(whiskerGeo, this.materials.carbonDark);
    whiskerL.position.set(-0.082, 0.068, 0.14);
    whiskerL.rotation.z = 0.25;
    whiskerL.rotation.x = -0.15;

    const whiskerR = whiskerL.clone();
    whiskerR.position.x = 0.082;
    whiskerR.rotation.z = -0.25;
    this.airframeGroup.add(whiskerL, whiskerR);
  }

  _registerBreakable(obj) {
    this.breakableParts.push({
      object: obj,
      initialPos: obj.position.clone(),
      initialRot: obj.rotation.clone(),
      vel: new THREE.Vector3(),
      rotVel: new THREE.Vector3()
    });
  }

  /**
   * Animates control surfaces (ailerons & V-tail ruddervators) and twin pusher propellers.
   * @param {Object} actuators - { pitch, roll, yaw, throttle }
   * @param {number} rpm - Current motor RPM
   * @param {number} dt - Frame delta time in seconds
   */
  updateAnimations(actuators, rpm, dt) {
    // 1. Ailerons deflect differentially with roll input:
    // Roll right (+roll): right aileron deflects UP (-X rot), left aileron deflects DOWN (+X rot)
    const maxAileronRad = 0.42; // ~24 degrees
    const rollInput = clamp(actuators.roll || 0.0, -1.0, 1.0);
    this.rightAileronPivot.rotation.x = -rollInput * maxAileronRad;
    this.leftAileronPivot.rotation.x = rollInput * maxAileronRad;

    // 2. V-Tail Ruddervator mixing:
    // Pitch up (+pitch): both ruddervators deflect UP (-X rot)
    // Yaw right (+yaw): differential deflection on V-tail surfaces
    const maxRuddervatorRad = 0.40;
    const pitchInput = clamp(actuators.pitch || 0.0, -1.0, 1.0);
    const yawInput = clamp(actuators.yaw || 0.0, -1.0, 1.0);

    const leftMix = clamp(-pitchInput + yawInput * 0.75, -1.2, 1.2);
    const rightMix = clamp(-pitchInput - yawInput * 0.75, -1.2, 1.2);

    this.leftRuddervatorPivot.rotation.x = leftMix * maxRuddervatorRad;
    this.rightRuddervatorPivot.rotation.x = rightMix * maxRuddervatorRad;

    // 3. Counter-rotating twin pusher propellers + motion-blur disc opacity
    const radPerSec = (rpm / 60.0) * Math.PI * 2.0;
    this.leftPropGroup.rotation.z += radPerSec * dt;
    this.rightPropGroup.rotation.z -= radPerSec * dt;

    const blurAlpha = clamp((rpm - 800) / 10000.0, 0.04, 0.42);
    this.materials.propBlur.opacity = this.isDamaged ? 0.0 : blurAlpha;

    // 4. If damaged/detonated, animate detached structural fragments
    if (this.isDamaged) {
      for (let i = 0; i < this.breakableParts.length; i++) {
        const bp = this.breakableParts[i];
        bp.object.position.addScaledVector(bp.vel, dt);
        bp.vel.y -= 6.5 * dt;
        bp.object.rotation.x += bp.rotVel.x * dt;
        bp.object.rotation.y += bp.rotVel.y * dt;
        bp.object.rotation.z += bp.rotVel.z * dt;
      }
    }
  }

  /**
   * Triggers visual damage / structural breakup on detonation or crash.
   */
  triggerDamageState() {
    if (this.isDamaged) return;
    this.isDamaged = true;

    this.airframeGroup.traverse((child) => {
      if (child.isMesh && child.material !== this.materials.propBlur) {
        child.material = this.materials.damagedCharred;
      }
    });

    for (let i = 0; i < this.breakableParts.length; i++) {
      const bp = this.breakableParts[i];
      const side = i % 2 === 0 ? 1 : -1;
      bp.vel.set(side * (2.5 + i * 0.8), 1.8 + (i % 3) * 0.7, (i - 1.5) * 1.4);
      bp.rotVel.set(side * 4.2, 3.1, -side * 5.0);
    }
  }

  /**
   * Resets model visuals and reattaches structural components on mission restart.
   */
  resetDamageState() {
    if (!this.isDamaged) return;
    this.isDamaged = false;

    for (let i = 0; i < this.breakableParts.length; i++) {
      const bp = this.breakableParts[i];
      bp.object.position.copy(bp.initialPos);
      bp.object.rotation.copy(bp.initialRot);
      bp.vel.set(0, 0, 0);
      bp.rotVel.set(0, 0, 0);
    }

    // Rebuild clean material assignments
    this.airframeGroup.clear();
    this.leftAileronPivot.clear();
    this.rightAileronPivot.clear();
    this.leftRuddervatorPivot.clear();
    this.rightRuddervatorPivot.clear();
    this.leftPropGroup.clear();
    this.rightPropGroup.clear();
    this.propBlurDiscs.length = 0;
    this.breakableParts.length = 0;

    this._buildFuselage();
    this._buildMainWing();
    this._buildVTail();
    this._buildPusherPropulsion();
    this._buildDetailsAndAntennas();
  }

  setFpvVisibility(isFpv) {
    // In FPV nose-cam mode, hide the exterior airframe so the nose cone doesn't block the camera
    this.airframeGroup.visible = !isFpv;
  }
}
