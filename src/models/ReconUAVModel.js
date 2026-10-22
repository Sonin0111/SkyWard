import * as THREE from '../../vendor/three.module.js';

/**
 * Procedural 3D Model of the Enemy Reconnaissance UAV (Twin-Boom Pusher Recon Configuration).
 * Visually distinct from the player's white V-tail interceptor:
 * - Tactical olive-slate central reconnaissance pod with belly EO/IR optical gimbal dome
 * - Wide high-aspect-ratio reconnaissance wings (3.4m span) with twin tail booms
 * - H-Tail / Twin vertical stabilizers with horizontal crossbar elevator
 * - Rear combustion engine block, glowing hot exhaust manifold, and pusher propeller
 * - Dedicated Thermal FLIR material mode where the motor/exhaust & airframe glow with high contrast
 */
export class ReconUAVModel {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'EnemyReconUAV';

    this.propGroup = new THREE.Group();
    this.turretGroup = new THREE.Group();
    this.breakableParts = [];
    this.isDestroyed = false;
    this.thermalMode = 'WHITE_HOT'; // 'DAY' | 'WHITE_HOT' | 'BLACK_HOT'

    this._initMaterials();
    this._buildAirframe();
  }

  _initMaterials() {
    // Daylight materials
    this.dayMaterials = {
      fuselageCamo: new THREE.MeshStandardMaterial({
        color: 0x4b5648,
        roughness: 0.65,
        metalness: 0.12
      }),
      wingSlate: new THREE.MeshStandardMaterial({
        color: 0x5c6659,
        roughness: 0.60,
        metalness: 0.10
      }),
      accentStripe: new THREE.MeshStandardMaterial({
        color: 0xb84a27,
        roughness: 0.50,
        metalness: 0.15
      }),
      engineHot: new THREE.MeshStandardMaterial({
        color: 0x2b2927,
        roughness: 0.45,
        metalness: 0.65,
        emissive: 0x551800,
        emissiveIntensity: 0.45
      }),
      exhaustGlow: new THREE.MeshBasicMaterial({
        color: 0xff5511
      }),
      turretDark: new THREE.MeshStandardMaterial({
        color: 0x1e2226,
        roughness: 0.25,
        metalness: 0.70
      }),
      propBlur: new THREE.MeshBasicMaterial({
        color: 0x222528,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false
      }),
      destroyedCharred: new THREE.MeshStandardMaterial({
        color: 0xffbb66,
        roughness: 0.4,
        metalness: 0.1,
        emissive: 0xff6611,
        emissiveIntensity: 1.8
      })
    };

    // High-contrast Thermal IR (FLIR) override materials (fog: false so thermal signature cuts through haze)
    this.thermalMaterials = {
      airframeWarmWhite: new THREE.MeshBasicMaterial({ color: 0xf2f7ff, fog: false }),
      wingWarmWhite: new THREE.MeshBasicMaterial({ color: 0xe4edf7, fog: false }),
      engineCoreWhiteHot: new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      wreckageWhiteHot: new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }),
      airframeWarmBlack: new THREE.MeshBasicMaterial({ color: 0x0c0e11, fog: false }),
      wingWarmBlack: new THREE.MeshBasicMaterial({ color: 0x16191e, fog: false }),
      engineCoreBlackHot: new THREE.MeshBasicMaterial({ color: 0x010102, fog: false }),
      wreckageBlackHot: new THREE.MeshBasicMaterial({ color: 0x020203, fog: false })
    };
  }

  _buildAirframe() {
    this.root.clear();
    this.propGroup.clear();
    this.turretGroup.clear();
    this.breakableParts.length = 0;

    // 1. Central Reconnaissance Pod Fuselage
    const podGroup = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.14, 0.16, 1.35, 16);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.scale(0.88, 1.0, 1.0);
    const bodyMesh = new THREE.Mesh(bodyGeo, this.dayMaterials.fuselageCamo);
    bodyMesh.castShadow = true;
    bodyMesh.userData.thermalZone = 'airframe';
    podGroup.add(bodyMesh);

    // Nose cone radome
    const noseGeo = new THREE.SphereGeometry(0.14, 16, 12);
    noseGeo.scale(0.88, 0.95, 1.65);
    const noseMesh = new THREE.Mesh(noseGeo, this.dayMaterials.fuselageCamo);
    noseMesh.position.set(0, 0, -0.68);
    noseMesh.userData.thermalZone = 'airframe';
    podGroup.add(noseMesh);

    // Underbelly EO/IR Reconnaissance Gimbal Turret Ball
    this.turretGroup.position.set(0, -0.16, -0.28);
    const turretBallGeo = new THREE.SphereGeometry(0.095, 14, 12);
    const turretBall = new THREE.Mesh(turretBallGeo, this.dayMaterials.turretDark);
    turretBall.userData.thermalZone = 'airframe';
    this.turretGroup.add(turretBall);
    podGroup.add(this.turretGroup);

    // 2. Rear Internal Combustion Engine & Hot Exhaust Plume (bright thermal signature!)
    const engineGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.28, 14);
    engineGeo.rotateX(Math.PI / 2);
    const engineMesh = new THREE.Mesh(engineGeo, this.dayMaterials.engineHot);
    engineMesh.position.set(0, 0.02, 0.72);
    engineMesh.userData.thermalZone = 'engine';
    podGroup.add(engineMesh);

    // Exhaust manifold & thermal heat core
    const exhaustGeo = new THREE.SphereGeometry(0.095, 12, 10);
    exhaustGeo.scale(1.1, 1.0, 1.8);
    const exhaustMesh = new THREE.Mesh(exhaustGeo, this.dayMaterials.exhaustGlow);
    exhaustMesh.position.set(0, 0.02, 0.85);
    exhaustMesh.userData.thermalZone = 'engine';
    podGroup.add(exhaustMesh);

    // Rear Pusher Propeller
    this.propGroup.position.set(0, 0.02, 0.90);
    const bladeGeo = new THREE.BoxGeometry(0.56, 0.038, 0.008);
    const blade = new THREE.Mesh(bladeGeo, this.dayMaterials.turretDark);
    blade.userData.thermalZone = 'engine';
    this.propGroup.add(blade);

    const discGeo = new THREE.CircleGeometry(0.28, 20);
    const disc = new THREE.Mesh(discGeo, this.dayMaterials.propBlur);
    this.propGroup.add(disc);
    podGroup.add(this.propGroup);

    this.root.add(podGroup);

    // 3. High-Mounted Reconnaissance Wing (3.4m wingspan)
    const buildWingSide = (side) => {
      const wGroup = new THREE.Group();
      const halfSpan = 1.68;
      const wGeo = new THREE.BoxGeometry(halfSpan, 0.036, 0.36);
      const wMesh = new THREE.Mesh(wGeo, this.dayMaterials.wingSlate);
      wMesh.position.set(side * (halfSpan * 0.5), 0.13, -0.05);
      wMesh.castShadow = true;
      wMesh.userData.thermalZone = 'wing';
      wGroup.add(wMesh);

      // Wingtip recognition stripe
      const stripeGeo = new THREE.BoxGeometry(0.22, 0.040, 0.365);
      const stripeMesh = new THREE.Mesh(stripeGeo, this.dayMaterials.accentStripe);
      stripeMesh.position.set(side * (halfSpan - 0.14), 0.13, -0.05);
      stripeMesh.userData.thermalZone = 'airframe';
      wGroup.add(stripeMesh);

      this._registerBreakable(wGroup);
      this.root.add(wGroup);
    };

    buildWingSide(1);
    buildWingSide(-1);

    // 4. Twin Tail Booms & H-Tail Stabilizer Assembly
    const buildTailBoom = (side) => {
      const boomGroup = new THREE.Group();
      const boomX = side * 0.62;

      const boomGeo = new THREE.CylinderGeometry(0.026, 0.022, 1.85, 10);
      boomGeo.rotateX(Math.PI / 2);
      const boomMesh = new THREE.Mesh(boomGeo, this.dayMaterials.fuselageCamo);
      boomMesh.position.set(boomX, 0.11, 0.82);
      boomMesh.castShadow = true;
      boomMesh.userData.thermalZone = 'wing';
      boomGroup.add(boomMesh);

      // Twin Vertical Stabilizer Fin
      const vFinGeo = new THREE.BoxGeometry(0.022, 0.42, 0.26);
      const vFinMesh = new THREE.Mesh(vFinGeo, this.dayMaterials.wingSlate);
      vFinMesh.position.set(boomX, 0.24, 1.66);
      vFinMesh.rotation.x = -0.15;
      vFinMesh.castShadow = true;
      vFinMesh.userData.thermalZone = 'wing';
      boomGroup.add(vFinMesh);

      this._registerBreakable(boomGroup);
      this.root.add(boomGroup);
    };

    buildTailBoom(1);
    buildTailBoom(-1);

    // Horizontal Crossbar Elevator connecting the twin vertical fins
    const hStabGroup = new THREE.Group();
    const hStabGeo = new THREE.BoxGeometry(1.32, 0.024, 0.24);
    const hStabMesh = new THREE.Mesh(hStabGeo, this.dayMaterials.wingSlate);
    hStabMesh.position.set(0, 0.42, 1.68);
    hStabMesh.castShadow = true;
    hStabMesh.userData.thermalZone = 'wing';
    hStabGroup.add(hStabMesh);
    this._registerBreakable(hStabGroup);
    this.root.add(hStabGroup);

    this.setThermalMode(this.thermalMode);
  }

  _registerBreakable(group) {
    this.breakableParts.push({
      object: group,
      vel: new THREE.Vector3(),
      rotVel: new THREE.Vector3()
    });
  }

  /**
   * Switches between standard Daylight optical materials and high-contrast FLIR Thermal materials.
   * @param {'DAY'|'WHITE_HOT'|'BLACK_HOT'} mode
   */
  setThermalMode(mode) {
    this.thermalMode = mode;
    if (this.isDestroyed && mode === 'DAY') return;

    this.root.traverse((child) => {
      if (!child.isMesh) return;
      const zone = child.userData.thermalZone;
      if (!zone) return;

      if (mode === 'WHITE_HOT') {
        if (this.isDestroyed) child.material = this.thermalMaterials.wreckageWhiteHot;
        else if (zone === 'engine') child.material = this.thermalMaterials.engineCoreWhiteHot;
        else if (zone === 'airframe') child.material = this.thermalMaterials.airframeWarmWhite;
        else child.material = this.thermalMaterials.wingWarmWhite;
      } else if (mode === 'BLACK_HOT') {
        if (this.isDestroyed) child.material = this.thermalMaterials.wreckageBlackHot;
        else if (zone === 'engine') child.material = this.thermalMaterials.engineCoreBlackHot;
        else if (zone === 'airframe') child.material = this.thermalMaterials.airframeWarmBlack;
        else child.material = this.thermalMaterials.wingWarmBlack;
      } else {
        // Restore Daylight materials
        if (this.isDestroyed) {
          child.material = this.dayMaterials.destroyedCharred;
        } else if (zone === 'engine') {
          child.material = child.geometry.type === 'SphereGeometry'
            ? this.dayMaterials.exhaustGlow
            : this.dayMaterials.engineHot;
        } else if (zone === 'airframe') {
          child.material = this.dayMaterials.fuselageCamo;
        } else {
          child.material = this.dayMaterials.wingSlate;
        }
      }
    });
  }

  /**
   * Triggers visual fragmentation & white-hot burning wreckage state when intercepted.
   */
  triggerDestruction() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.setThermalMode(this.thermalMode);

    for (let i = 0; i < this.breakableParts.length; i++) {
      const bp = this.breakableParts[i];
      const side = i % 2 === 0 ? 1 : -1;
      bp.vel.set(side * (4.2 + i * 1.3), 2.8 + i * 0.8, (i - 2) * 2.2);
      bp.rotVel.set(side * 6.5, 4.5, -side * 7.2);
    }
  }

  reset() {
    this.isDestroyed = false;
    this._buildAirframe();
  }

  update(dt) {
    if (!this.isDestroyed) {
      this.propGroup.rotation.z += 65.0 * dt;
    } else {
      for (let i = 0; i < this.breakableParts.length; i++) {
        const bp = this.breakableParts[i];
        bp.object.position.addScaledVector(bp.vel, dt);
        bp.vel.y -= 7.5 * dt;
        bp.object.rotation.x += bp.rotVel.x * dt;
        bp.object.rotation.y += bp.rotVel.y * dt;
        bp.object.rotation.z += bp.rotVel.z * dt;
      }
    }
  }
}
