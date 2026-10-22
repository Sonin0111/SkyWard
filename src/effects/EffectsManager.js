import * as THREE from '../../vendor/three.module.js';

/**
 * Pooled Visual Effects Manager for explosions, shockwaves, fireball particles,
 * debris fragments, and trailing smoke plumes.
 * Pre-allocates all geometries and materials at initialization to guarantee
 * zero heap allocations or garbage collection spikes during gameplay.
 */
export class EffectsManager {
  constructor(scene) {
    this.scene = scene;
    this.effectsGroup = new THREE.Group();
    this.effectsGroup.name = 'VisualEffectsPool';
    this.scene.add(this.effectsGroup);

    this.maxSmokePuffs = 120;
    this.maxSparks = 80;
    this.smokePool = [];
    this.sparkPool = [];
    this.smokeCursor = 0;
    this.sparkCursor = 0;

    this.shockwaveActive = false;
    this.shockwaveAge = 0.0;
    this.smokeEmitAccum = 0.0;

    this._initPool();
  }

  _initPool() {
    // 1. Shockwave sphere & core fireball (high-contrast white-hot thermal luminance)
    const shockGeo = new THREE.SphereGeometry(1.0, 24, 18);
    this.shockMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.shockMesh = new THREE.Mesh(shockGeo, this.shockMat);
    this.shockMesh.visible = false;
    this.effectsGroup.add(this.shockMesh);

    const coreGeo = new THREE.SphereGeometry(1.0, 20, 16);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff6e0,
      transparent: true,
      opacity: 0.0,
      depthWrite: false
    });
    this.coreMesh = new THREE.Mesh(coreGeo, this.coreMat);
    this.coreMesh.visible = false;
    this.effectsGroup.add(this.coreMesh);

    // Explosion point light
    this.blastLight = new THREE.PointLight(0xff8822, 0.0, 260.0);
    this.effectsGroup.add(this.blastLight);

    // 2. Pooled volumetric smoke puffs
    const smokeGeo = new THREE.DodecahedronGeometry(1.0, 1);
    for (let i = 0; i < this.maxSmokePuffs; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x2a2d30,
        transparent: true,
        opacity: 0.0,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(smokeGeo, mat);
      mesh.visible = false;
      this.effectsGroup.add(mesh);

      this.smokePool.push({
        mesh,
        mat,
        active: false,
        age: 0.0,
        maxLife: 2.5,
        startScale: 1.0,
        endScale: 6.0,
        velocity: new THREE.Vector3(),
        isFire: false
      });
    }

    // 3. Pooled fiery debris & shrapnel sparks
    const sparkGeo = new THREE.BoxGeometry(0.32, 0.14, 0.45);
    for (let i = 0; i < this.maxSparks; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffaa22
      });
      const mesh = new THREE.Mesh(sparkGeo, mat);
      mesh.visible = false;
      this.effectsGroup.add(mesh);

      this.sparkPool.push({
        mesh,
        mat,
        active: false,
        age: 0.0,
        maxLife: 1.8,
        velocity: new THREE.Vector3(),
        rotSpeed: new THREE.Vector3()
      });
    }
  }

  /**
   * Triggers a large warhead detonation or crash explosion at worldPos.
   * @param {THREE.Vector3} worldPos
   * @param {number} scale - Intensity scale (1.0 = full warhead blast, 0.6 = ground impact)
   */
  triggerExplosion(worldPos, scale = 1.0) {
    this.shockwaveActive = true;
    this.shockwaveAge = 0.0;
    this.shockwaveScale = scale;

    this.shockMesh.position.copy(worldPos);
    this.shockMesh.scale.setScalar(1.0);
    this.shockMesh.visible = true;
    this.shockMat.opacity = 0.85;

    this.coreMesh.position.copy(worldPos);
    this.coreMesh.scale.setScalar(1.5 * scale);
    this.coreMesh.visible = true;
    this.coreMat.opacity = 0.95;

    this.blastLight.position.copy(worldPos);
    this.blastLight.intensity = 18.0 * scale;

    // Spawn 42 fireball & thermal smoke bursts
    for (let i = 0; i < 42; i++) {
      const isFire = i < 22;
      const theta = Math.random() * Math.PI * 2.0;
      const phi = Math.acos(2.0 * Math.random() - 1.0);
      const speed = (isFire ? 7.0 + Math.random() * 16.0 : 5.0 + Math.random() * 12.0) * scale;

      const vx = Math.sin(phi) * Math.cos(theta) * speed;
      const vy = Math.cos(phi) * speed + (isFire ? 2.5 : 4.0);
      const vz = Math.sin(phi) * Math.sin(theta) * speed;

      this._spawnSmokePuff(
        worldPos.x + (Math.random() - 0.5) * 2.2,
        worldPos.y + (Math.random() - 0.5) * 2.2,
        worldPos.z + (Math.random() - 0.5) * 2.2,
        vx,
        vy,
        vz,
        isFire ? 1.8 * scale : 2.2 * scale,
        isFire ? 6.5 * scale : 8.5 * scale,
        isFire ? 1.3 + Math.random() * 0.8 : 2.8 + Math.random() * 1.6,
        isFire
      );
    }

    // Spawn 60 high-speed white-hot shrapnel / burning debris sparks
    for (let i = 0; i < 60; i++) {
      const sp = this.sparkPool[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % this.maxSparks;

      const theta = Math.random() * Math.PI * 2.0;
      const phi = Math.acos(2.0 * Math.random() - 1.0);
      const speed = (15.0 + Math.random() * 34.0) * scale;

      sp.active = true;
      sp.age = 0.0;
      sp.maxLife = 1.8 + Math.random() * 1.8;
      sp.mesh.position.copy(worldPos);
      sp.mesh.scale.setScalar(1.3 + Math.random() * 1.2);
      sp.mesh.visible = true;
      sp.mat.color.setHex(i % 2 === 0 ? 0xffffff : 0xffe099);
      sp.velocity.set(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.cos(phi) * speed + 5.0,
        Math.sin(phi) * Math.sin(theta) * speed
      );
      sp.rotSpeed.set(
        (Math.random() - 0.5) * 14.0,
        (Math.random() - 0.5) * 14.0,
        (Math.random() - 0.5) * 14.0
      );
    }
  }

  /**
   * Emits trailing smoke & thermal fire particles from damaged/falling aircraft.
   */
  emitTrailingSmoke(worldPos, isBurning = true) {
    const isFire = isBurning && Math.random() < 0.55;
    this._spawnSmokePuff(
      worldPos.x + (Math.random() - 0.5) * 1.0,
      worldPos.y + (Math.random() - 0.5) * 1.0,
      worldPos.z + (Math.random() - 0.5) * 1.0,
      (Math.random() - 0.5) * 2.5,
      2.2 + Math.random() * 2.5,
      (Math.random() - 0.5) * 2.5,
      isFire ? 1.1 : 1.4,
      isFire ? 3.4 : 6.8,
      isFire ? 0.75 : 2.4,
      isFire
    );
  }

  _spawnSmokePuff(x, y, z, vx, vy, vz, startScale, endScale, maxLife, isFire) {
    const puff = this.smokePool[this.smokeCursor];
    this.smokeCursor = (this.smokeCursor + 1) % this.maxSmokePuffs;

    puff.active = true;
    puff.age = 0.0;
    puff.maxLife = maxLife;
    puff.startScale = startScale;
    puff.endScale = endScale;
    puff.isFire = isFire;

    puff.mesh.position.set(x, y, z);
    puff.mesh.scale.setScalar(startScale);
    puff.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    puff.mesh.visible = true;
    puff.velocity.set(vx, vy, vz);

    if (isFire) {
      puff.mat.color.setHex(0xffffff); // White-hot thermal core
      puff.mat.opacity = 0.94;
    } else {
      puff.mat.color.setHex(0x6e7680); // Warm gray smoke billow visible in both Day & FLIR
      puff.mat.opacity = 0.72;
    }
  }

  update(dt, playerSmokingPos = null, enemySmokingPos = null) {
    // 1. Update shockwave & core fireball
    if (this.shockwaveActive) {
      this.shockwaveAge += dt;
      const t = this.shockwaveAge;

      if (t < 0.75) {
        const s = 1.0 + t * 52.0 * this.shockwaveScale;
        this.shockMesh.scale.setScalar(s);
        this.shockMat.opacity = Math.max(0.0, 0.82 * (1.0 - t / 0.75));
      } else {
        this.shockMesh.visible = false;
      }

      if (t < 1.15) {
        const cs = (1.8 + t * 24.0) * this.shockwaveScale;
        this.coreMesh.scale.setScalar(cs);
        this.coreMat.opacity = Math.max(0.0, 0.95 * (1.0 - t / 1.15));
        this.blastLight.intensity = Math.max(0.0, 18.0 * (1.0 - t / 0.9));
      } else {
        this.coreMesh.visible = false;
        this.blastLight.intensity = 0.0;
        this.shockwaveActive = false;
      }
    }

    // 2. Emit continuous smoke trails for damaged aircraft
    if (playerSmokingPos || enemySmokingPos) {
      this.smokeEmitAccum += dt;
      while (this.smokeEmitAccum >= 0.035) {
        this.smokeEmitAccum -= 0.035;
        if (playerSmokingPos) this.emitTrailingSmoke(playerSmokingPos, true);
        if (enemySmokingPos) this.emitTrailingSmoke(enemySmokingPos, true);
      }
    }

    // 3. Update active smoke puffs
    for (let i = 0; i < this.maxSmokePuffs; i++) {
      const p = this.smokePool[i];
      if (!p.active) continue;

      p.age += dt;
      if (p.age >= p.maxLife) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }

      const frac = p.age / p.maxLife;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.velocity.multiplyScalar(1.0 - 1.4 * dt);

      const scale = p.startScale + (p.endScale - p.startScale) * frac;
      p.mesh.scale.setScalar(scale);

      if (p.isFire) {
        // Transition white-hot thermal core -> warm thermal smoke
        if (frac > 0.65) {
          p.mat.color.setHex(0x9aa4b0);
        } else if (frac > 0.30) {
          p.mat.color.setHex(0xffe8c2);
        }
        p.mat.opacity = 0.94 * (1.0 - frac);
      } else {
        p.mat.opacity = 0.72 * (1.0 - frac * frac);
      }
    }

    // 4. Update active debris sparks
    for (let i = 0; i < this.maxSparks; i++) {
      const sp = this.sparkPool[i];
      if (!sp.active) continue;

      sp.age += dt;
      if (sp.age >= sp.maxLife) {
        sp.active = false;
        sp.mesh.visible = false;
        continue;
      }

      sp.velocity.y -= 14.5 * dt;
      sp.mesh.position.addScaledVector(sp.velocity, dt);
      sp.mesh.rotation.x += sp.rotSpeed.x * dt;
      sp.mesh.rotation.y += sp.rotSpeed.y * dt;
      sp.mesh.rotation.z += sp.rotSpeed.z * dt;
    }
  }

  reset() {
    this.shockwaveActive = false;
    this.shockMesh.visible = false;
    this.coreMesh.visible = false;
    this.blastLight.intensity = 0.0;

    for (let i = 0; i < this.maxSmokePuffs; i++) {
      this.smokePool[i].active = false;
      this.smokePool[i].mesh.visible = false;
    }
    for (let i = 0; i < this.maxSparks; i++) {
      this.sparkPool[i].active = false;
      this.sparkPool[i].mesh.visible = false;
    }
  }

  dispose() {
    this.shockMesh.geometry.dispose();
    this.shockMat.dispose();
    this.coreMesh.geometry.dispose();
    this.coreMat.dispose();
    if (this.smokePool.length > 0) this.smokePool[0].mesh.geometry.dispose();
    if (this.sparkPool.length > 0) this.sparkPool[0].mesh.geometry.dispose();
  }
}
