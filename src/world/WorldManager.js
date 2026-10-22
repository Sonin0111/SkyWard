import * as THREE from '../../vendor/three.module.js';
import { FLIGHT_CONFIG } from '../config/flightConfig.js';
import { TerrainNoise2D, SeededRandom } from '../utils/prng.js';
import { clamp, smoothstep, lerp } from '../utils/math.js';

/**
 * Large-Scale Procedural World Generator with Chunk Streaming, 3-Ring LOD,
 * Skirted Seamless Terrain Meshes, and GPU-Instanced Forests, Roads & Settlements.
 */
export class WorldManager {
  constructor(scene, config = FLIGHT_CONFIG) {
    this.scene = scene;
    this.config = config;
    this.seed = config.world.defaultSeed;
    this.noise = new TerrainNoise2D(this.seed);

    this.qualityName = 'Medium';
    this.quality = config.world.qualityPresets[this.qualityName];

    this.worldGroup = new THREE.Group();
    this.worldGroup.name = 'WorldEnvironment';
    this.scene.add(this.worldGroup);

    this.chunkGroup = new THREE.Group();
    this.worldGroup.add(this.chunkGroup);

    this.instancedGroup = new THREE.Group();
    this.worldGroup.add(this.instancedGroup);

    // Active terrain chunks keyed by "cx,cz"
    this.activeChunks = new Map();
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;

    this.thermalMode = 'DAY'; // 'DAY' | 'WHITE_HOT' | 'BLACK_HOT'

    this._initLightingAndSky();
    this._initMaterials();
    this._initWater();
    this._buildStaticInstancedProps();
  }

  _initLightingAndSky() {
    // Ambient hemisphere light (sky blue above, warm earth bounce below)
    this.hemiLight = new THREE.HemisphereLight(0xdbeeff, 0x506048, 0.82);
    this.scene.add(this.hemiLight);

    // Main directional sunlight
    this.sunDirection = new THREE.Vector3(0.52, 0.68, -0.51).normalize();
    this.sunLight = new THREE.DirectionalLight(0xfff6e5, 1.85);
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(250);
    this.sunLight.castShadow = this.quality.shadows;
    this.sunLight.shadow.mapSize.width = this.quality.shadowMapSize;
    this.sunLight.shadow.mapSize.height = this.quality.shadowMapSize;
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 600;
    const d = 140;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Atmospheric distance fog
    this.dayFogColor = new THREE.Color(0xb8cee2);
    this.thermalWhiteFogColor = new THREE.Color(0x16191d);
    this.thermalBlackFogColor = new THREE.Color(0xd2d7dc);
    this.scene.fog = new THREE.FogExp2(this.dayFogColor, 0.00011);
    this.scene.background = this.dayFogColor.clone();

    // Custom Atmospheric Sky Dome Shader
    const skyGeo = new THREE.SphereGeometry(18000, 32, 20);
    this.skyUniforms = {
      uSunDir: { value: this.sunDirection.clone() },
      uTopColor: { value: new THREE.Color(0x2b5c94) },
      uHorizonColor: { value: new THREE.Color(0xb8cee2) },
      uGroundColor: { value: new THREE.Color(0x6c7d6e) },
      uThermalMode: { value: 0 } // 0 = DAY, 1 = WHITE_HOT, 2 = BLACK_HOT
    };

    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `
        varying vec3 vWorldDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform vec3 uTopColor;
        uniform vec3 uHorizonColor;
        uniform vec3 uGroundColor;
        uniform int uThermalMode;
        varying vec3 vWorldDir;

        void main() {
          vec3 dir = normalize(vWorldDir);
          float y = dir.y;

          if (uThermalMode == 1) {
            // White-Hot FLIR cold sky dome
            float skyGrad = smoothstep(-0.05, 0.65, y);
            vec3 col = mix(vec3(0.11, 0.13, 0.15), vec3(0.03, 0.04, 0.05), skyGrad);
            gl_FragColor = vec4(col, 1.0);
            return;
          } else if (uThermalMode == 2) {
            // Black-Hot FLIR inverted cold sky dome
            float skyGrad = smoothstep(-0.05, 0.65, y);
            vec3 col = mix(vec3(0.82, 0.84, 0.86), vec3(0.94, 0.95, 0.96), skyGrad);
            gl_FragColor = vec4(col, 1.0);
            return;
          }

          float zenithFactor = pow( max(0.0, y), 0.55 );
          vec3 skyCol = mix(uHorizonColor, uTopColor, zenithFactor);
          if (y < 0.0) {
            skyCol = mix(uHorizonColor, uGroundColor, clamp(-y * 4.0, 0.0, 1.0));
          }

          // Solar scattering aureole & disc
          float sunAmt = max(dot(dir, uSunDir), 0.0);
          skyCol += vec3(1.0, 0.88, 0.68) * pow(sunAmt, 16.0) * 0.32;
          skyCol += vec3(1.0, 0.97, 0.90) * smoothstep(0.9992, 0.9998, sunAmt);

          gl_FragColor = vec4(skyCol, 1.0);
        }
      `
    });

    this.skyDome = new THREE.Mesh(skyGeo, skyMat);
    this.worldGroup.add(this.skyDome);
  }

  _initMaterials() {
    this.terrainDayMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true
    });
    this.terrainThermalWhiteMat = new THREE.MeshBasicMaterial({
      vertexColors: true
    });

    this.waterDayMaterial = new THREE.MeshStandardMaterial({
      color: 0x265475,
      roughness: 0.22,
      metalness: 0.55,
      transparent: true,
      opacity: 0.88
    });
    this.waterThermalWhiteMat = new THREE.MeshBasicMaterial({
      color: 0x101317
    });
    this.waterThermalBlackMat = new THREE.MeshBasicMaterial({
      color: 0xdce1e6
    });

    this.treeDayMaterial = new THREE.MeshLambertMaterial({
      color: 0x2f522b
    });
    this.treeThermalWhiteMat = new THREE.MeshBasicMaterial({
      color: 0x20252a
    });
    this.treeThermalBlackMat = new THREE.MeshBasicMaterial({
      color: 0xbbc2c9
    });

    this.buildingDayMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.68,
      metalness: 0.18
    });
    this.buildingThermalWhiteMat = new THREE.MeshBasicMaterial({
      color: 0x5c6670
    });
    this.buildingThermalBlackMat = new THREE.MeshBasicMaterial({
      color: 0x626b75
    });

    this.siloDayMaterial = new THREE.MeshStandardMaterial({
      color: 0xc5ccd3,
      roughness: 0.45,
      metalness: 0.38
    });
    this.siloThermalWhiteMat = new THREE.MeshBasicMaterial({
      color: 0x76828e
    });
    this.siloThermalBlackMat = new THREE.MeshBasicMaterial({
      color: 0x454d55
    });
  }

  _initWater() {
    const waterGeo = new THREE.PlaneGeometry(26000, 26000, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    this.waterMesh = new THREE.Mesh(waterGeo, this.waterDayMaterial);
    this.waterMesh.position.y = this.config.world.waterLevelM;
    this.waterMesh.receiveShadow = true;
    this.worldGroup.add(this.waterMesh);
  }

  /**
   *Evaluates deterministic terrain elevation (in meters MSL) at world coordinates (x, z).
   * Combines rolling plains, agricultural basins, river valleys, road corridors, and mountain ridges.
   */
  getTerrainHeight = (x, z) => {
    const n = this.noise;
    const scale1 = 0.00026;
    const scale2 = 0.00085;
    const scale3 = 0.0028;

    // Macro continental elevation
    const base = n.fbm(x * scale1, z * scale1, 4, 2.0, 0.5);
    // Medium hills & valleys
    const hills = n.fbm(x * scale2 + 13.7, z * scale2 - 9.2, 4, 2.1, 0.48);
    // Ridged mountain crests further from origin
    const distFromCenter = Math.hypot(x, z - 400);
    const mountainMask = smoothstep(1400.0, 4800.0, distFromCenter);
    const ridges = n.ridged(x * 0.00038 + 5.1, z * 0.00038 + 8.4, 4, 2.1, 0.5);

    // Fine surface undulation
    const detail = n.noise2D(x * scale3, z * scale3) * 4.5;

    let h = 28.0 + base * 55.0 + hills * 38.0 + mountainMask * ridges * 265.0 + detail;

    // Winding main river valley carving East-West & curving North
    const riverCurveZ = -350.0 + Math.sin(x * 0.00045) * 680.0 + Math.cos(x * 0.00018) * 420.0;
    const distToRiver = Math.abs(z - riverCurveZ);
    const riverCarve = 1.0 - smoothstep(35.0, 340.0, distToRiver);
    h -= riverCarve * 36.0;

    // Secondary lake basin in the NW sector
    const lakeDist = Math.hypot(x + 1550.0, z + 1450.0);
    const lakeCarve = 1.0 - smoothstep(180.0, 750.0, lakeDist);
    h -= lakeCarve * 34.0;

    return Math.max(2.0, h);
  };

  /**
   * Computes highway/road proximity in [0, 1] at world coordinates (x, z).
   */
  getRoadFactor(x, z) {
    // North-South winding arterial highway
    const nsRoadX = 240.0 + Math.sin(z * 0.00052) * 380.0;
    const dNS = Math.abs(x - nsRoadX);

    // East-West cross-valley road
    const ewRoadZ = 180.0 + Math.cos(x * 0.00048) * 320.0;
    const dEW = Math.abs(z - ewRoadZ);

    const minRoadDist = Math.min(dNS, dEW);
    if (minRoadDist > 16.0) return 0.0;
    return 1.0 - smoothstep(5.5, 14.0, minRoadDist);
  }

  /**
   * Regenerates the world with a new seed (called on scenario seed change).
   */
  reseed(newSeed) {
    if (this.seed === newSeed && this.activeChunks.size > 0) return;
    this.seed = newSeed;
    this.noise = new TerrainNoise2D(this.seed);

    // Dispose and rebuild chunks + instanced props
    this._clearChunks();
    this._clearInstancedProps();
    this._buildStaticInstancedProps();
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
  }

  setQuality(presetName) {
    if (!this.config.world.qualityPresets[presetName]) return;
    this.qualityName = presetName;
    this.quality = this.config.world.qualityPresets[presetName];

    this.sunLight.castShadow = this.quality.shadows;
    this._clearChunks();
    this._clearInstancedProps();
    this._buildStaticInstancedProps();
    this.lastPlayerChunkX = null;
    this.lastPlayerChunkZ = null;
  }

  /**
   * Switches terrain, sky, water, and instanced structures between Daylight and Thermal FLIR modes.
   * @param {'DAY'|'WHITE_HOT'|'BLACK_HOT'} mode
   */
  setThermalMode(mode) {
    if (this.thermalMode === mode) return;
    this.thermalMode = mode;

    if (mode === 'WHITE_HOT') {
      this.skyUniforms.uThermalMode.value = 1;
      this.scene.fog.color.copy(this.thermalWhiteFogColor);
      this.scene.background.copy(this.thermalWhiteFogColor);
      this.waterMesh.material = this.waterThermalWhiteMat;
      if (this.treeInstancedMesh) this.treeInstancedMesh.material = this.treeThermalWhiteMat;
      if (this.buildingInstancedMesh) this.buildingInstancedMesh.material = this.buildingThermalWhiteMat;
      if (this.siloInstancedMesh) this.siloInstancedMesh.material = this.siloThermalWhiteMat;
    } else if (mode === 'BLACK_HOT') {
      this.skyUniforms.uThermalMode.value = 2;
      this.scene.fog.color.copy(this.thermalBlackFogColor);
      this.scene.background.copy(this.thermalBlackFogColor);
      this.waterMesh.material = this.waterThermalBlackMat;
      if (this.treeInstancedMesh) this.treeInstancedMesh.material = this.treeThermalBlackMat;
      if (this.buildingInstancedMesh) this.buildingInstancedMesh.material = this.buildingThermalBlackMat;
      if (this.siloInstancedMesh) this.siloInstancedMesh.material = this.siloThermalBlackMat;
    } else {
      this.skyUniforms.uThermalMode.value = 0;
      this.scene.fog.color.copy(this.dayFogColor);
      this.scene.background.copy(this.dayFogColor);
      this.waterMesh.material = this.waterDayMaterial;
      if (this.treeInstancedMesh) this.treeInstancedMesh.material = this.treeDayMaterial;
      if (this.buildingInstancedMesh) this.buildingInstancedMesh.material = this.buildingDayMaterial;
      if (this.siloInstancedMesh) this.siloInstancedMesh.material = this.siloDayMaterial;
    }

    // Re-color active terrain chunks for the selected optical/thermal mode
    this.activeChunks.forEach((chunk) => {
      this._applyChunkVertexColors(chunk.geometry, chunk.cx, chunk.cz, chunk.segments);
      chunk.mesh.material = mode === 'DAY' ? this.terrainDayMaterial : this.terrainThermalWhiteMat;
    });
  }

  /**
   * Streams terrain chunks around the aircraft position and updates lighting/fog by altitude.
   */
  update(playerPosition) {
    const chunkSize = this.config.world.chunkSizeM;
    const cx = Math.floor(playerPosition.x / chunkSize);
    const cz = Math.floor(playerPosition.z / chunkSize);

    // Keep sky dome and water centered horizontally on aircraft
    this.skyDome.position.set(playerPosition.x, 0, playerPosition.z);
    this.waterMesh.position.set(playerPosition.x, this.config.world.waterLevelM, playerPosition.z);

    // Update directional shadow frustum to follow player aircraft
    this.sunLight.target.position.copy(playerPosition);
    this.sunLight.position.copy(playerPosition).addScaledVector(this.sunDirection, 220);

    // Altitude-dependent atmospheric perspective (fog thins slightly at higher altitude)
    const altFactor = clamp(playerPosition.y / 2500.0, 0.0, 1.0);
    this.scene.fog.density = lerp(0.000105, 0.000058, altFactor);

    if (cx !== this.lastPlayerChunkX || cz !== this.lastPlayerChunkZ) {
      this.lastPlayerChunkX = cx;
      this.lastPlayerChunkZ = cz;
      this._updateChunkGrid(cx, cz);
    }
  }

  _updateChunkGrid(centerCx, centerCz) {
    const rings = this.quality.ringRadiusChunks; // e.g. [2, 3, 5]
    const maxRadius = rings[2];
    const neededKeys = new Set();

    for (let dz = -maxRadius; dz <= maxRadius; dz++) {
      for (let dx = -maxRadius; dx <= maxRadius; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dz));
        let segments = 16;
        if (dist <= rings[0]) segments = 48;
        else if (dist <= rings[1]) segments = 24;

        const chunkX = centerCx + dx;
        const chunkZ = centerCz + dz;
        const key = `${chunkX},${chunkZ}`;
        neededKeys.add(key);

        const existing = this.activeChunks.get(key);
        if (!existing || existing.segments !== segments) {
          if (existing) {
            this.chunkGroup.remove(existing.mesh);
            existing.geometry.dispose();
          }
          const created = this._createTerrainChunk(chunkX, chunkZ, segments);
          this.activeChunks.set(key, created);
          this.chunkGroup.add(created.mesh);
        }
      }
    }

    // Remove out-of-range chunks and dispose their geometry
    for (const [key, chunk] of this.activeChunks.entries()) {
      if (!neededKeys.has(key)) {
        this.chunkGroup.remove(chunk.mesh);
        chunk.geometry.dispose();
        this.activeChunks.delete(key);
      }
    }
  }

  /**
   * Builds a terrain chunk mesh with edge skirts to prevent any LOD cracks/seams.
   */
  _createTerrainChunk(cx, cz, segments) {
    const chunkSize = this.config.world.chunkSizeM;
    const originX = cx * chunkSize;
    const originZ = cz * chunkSize;

    // Grid has (segments + 3) vertices per axis: outer ring is vertical skirt dropping by 28m
    const gridCount = segments + 3;
    const totalVerts = gridCount * gridCount;
    const positions = new Float32Array(totalVerts * 3);
    const colors = new Float32Array(totalVerts * 3);
    const indices = [];

    let vIdx = 0;
    for (let iz = 0; iz < gridCount; iz++) {
      const isSkirtZ = iz === 0 || iz === gridCount - 1;
      const clampedIz = clamp(iz - 1, 0, segments);
      const wz = originZ + (clampedIz / segments) * chunkSize;

      for (let ix = 0; ix < gridCount; ix++) {
        const isSkirtX = ix === 0 || ix === gridCount - 1;
        const clampedIx = clamp(ix - 1, 0, segments);
        const wx = originX + (clampedIx / segments) * chunkSize;

        let wy = this.getTerrainHeight(wx, wz);
        if (isSkirtX || isSkirtZ) {
          wy -= 28.0; // Skirt drop eliminates any LOD seam
        }

        positions[vIdx * 3] = wx;
        positions[vIdx * 3 + 1] = wy;
        positions[vIdx * 3 + 2] = wz;
        vIdx++;
      }
    }

    for (let iz = 0; iz < gridCount - 1; iz++) {
      for (let ix = 0; ix < gridCount - 1; ix++) {
        const a = iz * gridCount + ix;
        const b = (iz + 1) * gridCount + ix;
        const c = (iz + 1) * gridCount + (ix + 1);
        const d = iz * gridCount + (ix + 1);

        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    this._applyChunkVertexColors(geometry, cx, cz, segments);

    const mat = this.thermalMode === 'DAY' ? this.terrainDayMaterial : this.terrainThermalWhiteMat;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    return { cx, cz, segments, geometry, mesh };
  }

  /**
   * Computes biome & agricultural patchwork vertex colors (or cool grayscale FLIR tones).
   */
  _applyChunkVertexColors(geometry, cx, cz, segments) {
    const posAttr = geometry.getAttribute('position');
    const normAttr = geometry.getAttribute('normal');
    const colAttr = geometry.getAttribute('color');
    const count = posAttr.count;
    const waterY = this.config.world.waterLevelM;
    const mode = this.thermalMode;

    for (let i = 0; i < count; i++) {
      const wx = posAttr.getX(i);
      const wy = posAttr.getY(i);
      const wz = posAttr.getZ(i);
      const ny = normAttr ? normAttr.getY(i) : 1.0;
      const slope = 1.0 - clamp(ny, 0.0, 1.0);

      const road = this.getRoadFactor(wx, wz);

      // Agricultural field patchwork cell ID
      const fieldCellX = Math.floor((wx + Math.sin(wz * 0.0012) * 90.0) / 260.0);
      const fieldCellZ = Math.floor((wz + Math.cos(wx * 0.0012) * 90.0) / 260.0);
      const fieldHash = Math.abs(Math.sin(fieldCellX * 12.9898 + fieldCellZ * 78.233) * 43758.5453) % 1.0;

      if (mode === 'WHITE_HOT' || mode === 'BLACK_HOT') {
        // Cool dark grayscale thermal signature for terrain (0.08 - 0.30 in White-Hot)
        let lum = 0.14 + clamp((wy - waterY) / 380.0, 0.0, 0.12) - slope * 0.05;
        if (wy < waterY + 2.5) lum = 0.09; // Cool riverbank
        if ( fieldHash > 0.65 && wy < 70.0 ) lum += 0.035; // Warm plowed soil field
        if (road > 0.1) lum = lerp(lum, 0.32, road); // Asphalt retains solar heat

        if (mode === 'BLACK_HOT') {
          lum = 0.92 - lum;
        }
        colAttr.setXYZ(i, lum, lum * 1.02, lum * 1.04);
        continue;
      }

      // Standard Optical Daylight biome coloring
      let r = 0.30, g = 0.44, b = 0.24;

      if (wy < waterY + 2.8) {
        // Sandy/silty river bank
        r = 0.56; g = 0.52; b = 0.40;
      } else if (wy < 68.0 && slope < 0.16) {
        // Patchwork agricultural fields & plains
        if (fieldHash < 0.28) {
          // Golden wheat crop field
          r = 0.62; g = 0.57; b = 0.28;
        } else if (fieldHash < 0.52) {
          // Lush green crop field
          r = 0.31; g = 0.49; b = 0.23;
        } else if (fieldHash < 0.72) {
          // Dark plowed farmland soil
          r = 0.34; g = 0.31; b = 0.23;
        } else {
          // Olive meadow pasture
          r = 0.40; g = 0.50; b = 0.27;
        }
        // Subtle field border hedgerow darkening
        const fx = Math.abs(((wx / 260.0) % 1.0 + 1.0) % 1.0 - 0.5);
        const fz = Math.abs(((wz / 260.0) % 1.0 + 1.0) % 1.0 - 0.5);
        if (fx > 0.47 || fz > 0.47) {
          r *= 0.72; g *= 0.75; b *= 0.72;
        }
      } else if (wy < 185.0) {
        // Forested hill slopes
        const nVal = this.noise.noise2D(wx * 0.006, wz * 0.006) * 0.05;
        r = 0.23 + nVal;
        g = 0.38 + nVal;
        b = 0.20 + nVal * 0.5;
      } else {
        // Highland rocky ridges & alpine scree
        const rockMix = smoothstep(185.0, 290.0, wy);
        r = lerp(0.28, 0.48, rockMix);
        g = lerp(0.37, 0.47, rockMix);
        b = lerp(0.24, 0.45, rockMix);
      }

      // Steep rocky cliff face override
      if (slope > 0.24) {
        const cliffFactor = smoothstep(0.24, 0.52, slope);
        r = lerp(r, 0.46, cliffFactor);
        g = lerp(g, 0.44, cliffFactor);
        b = lerp(b, 0.41, cliffFactor);
      }

      // Asphalt highway overlay
      if (road > 0.05 && wy > waterY + 1.5) {
        r = lerp(r, 0.24, road);
        g = lerp(g, 0.25, road);
        b = lerp(b, 0.27, road);
      }

      colAttr.setXYZ(i, r, g, b);
    }

    colAttr.needsUpdate = true;
  }

  /**
   * Generates GPU-instanced forests, industrial warehouses, village buildings, and silos.
   */
  _buildStaticInstancedProps() {
    const rng = new SeededRandom((this.seed ^ 0x7f4a7c15) >>> 0);
    const waterY = this.config.world.waterLevelM;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    // 1. Instanced Forest Trees (Conifer / Deciduous canopy cones)
    const maxTrees = this.quality.treeCount;
    const treeGeo = new THREE.ConeGeometry(4.2, 13.5, 7);
    treeGeo.translate(0, 6.5, 0);
    this.treeInstancedMesh = new THREE.InstancedMesh(
      treeGeo,
      this.thermalMode === 'DAY' ? this.treeDayMaterial : this.treeThermalWhiteMat,
      maxTrees
    );
    this.treeInstancedMesh.castShadow = this.quality.shadows;
    this.treeInstancedMesh.receiveShadow = true;

    let treeIdx = 0;
    const spreadRadius = 5600.0;
    for (let attempt = 0; attempt < maxTrees * 2 && treeIdx < maxTrees; attempt++) {
      const tx = rng.range(-spreadRadius, spreadRadius);
      const tz = rng.range(-spreadRadius, spreadRadius);
      const ty = this.getTerrainHeight(tx, tz);

      // Place trees primarily on hills (55m - 210m) and hedgerows away from water & roads
      if (ty < waterY + 6.0 || ty > 220.0) continue;
      if (this.getRoadFactor(tx, tz) > 0.05) continue;

      const forestDensity = this.noise.noise2D(tx * 0.0012, tz * 0.0012);
      if (ty < 65.0 && forestDensity < 0.25) continue;

      const scale = rng.range(0.75, 1.55);
      dummy.position.set(tx, ty - 0.4, tz);
      dummy.rotation.set(0, rng.range(0, Math.PI * 2), 0);
      dummy.scale.set(scale, scale * rng.range(0.85, 1.25), scale);
      dummy.updateMatrix();
      this.treeInstancedMesh.setMatrixAt(treeIdx, dummy.matrix);

      const shade = rng.range(0.75, 1.18);
      color.setRGB(0.22 * shade, 0.38 * shade, 0.18 * shade);
      this.treeInstancedMesh.setColorAt(treeIdx, color);
      treeIdx++;
    }
    this.treeInstancedMesh.count = treeIdx;
    this.treeInstancedMesh.instanceMatrix.needsUpdate = true;
    if (this.treeInstancedMesh.instanceColor) this.treeInstancedMesh.instanceColor.needsUpdate = true;
    this.instancedGroup.add(this.treeInstancedMesh);

    // 2. Settlements & Industrial Complexes (Warehouses, Village Buildings, Silos/Towers)
    const maxBuildings = this.quality.buildingCount;
    const bldgGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0);
    bldgGeo.translate(0, 0.5, 0);
    this.buildingInstancedMesh = new THREE.InstancedMesh(
      bldgGeo,
      this.thermalMode === 'DAY' ? this.buildingDayMaterial : this.buildingThermalWhiteMat,
      maxBuildings
    );
    this.buildingInstancedMesh.castShadow = this.quality.shadows;
    this.buildingInstancedMesh.receiveShadow = true;

    const maxSilos = Math.floor(maxBuildings * 0.35);
    const siloGeo = new THREE.CylinderGeometry(1.0, 1.05, 1.0, 12);
    siloGeo.translate(0, 0.5, 0);
    this.siloInstancedMesh = new THREE.InstancedMesh(
      siloGeo,
      this.thermalMode === 'DAY' ? this.siloDayMaterial : this.siloThermalWhiteMat,
      maxSilos
    );
    this.siloInstancedMesh.castShadow = this.quality.shadows;

    // Define 10 settlement / industrial cluster hubs across the map
    const clusters = [
      { x: 260, z: 160, radius: 320, industrial: true },    // Central Highway Junction Complex
      { x: -750, z: -420, radius: 280, industrial: false }, // West Valley Village
      { x: 920, z: -880, radius: 350, industrial: true },   // NE Industrial Depot
      { x: -320, z: -1550, radius: 310, industrial: true }, // North Logistics Hub
      { x: 1450, z: 420, radius: 290, industrial: false },  // East Agricultural Town
      { x: -1650, z: 680, radius: 320, industrial: true },  // SW Refinery / Silo Yard
      { x: 480, z: -2450, radius: 340, industrial: true },  // Far North Radar & Storage Base
      { x: -1350, z: -2100, radius: 280, industrial: false },
      { x: 2100, z: -1600, radius: 330, industrial: true },
      { x: 120, z: 1650, radius: 260, industrial: false }
    ];

    let bldgIdx = 0;
    let siloIdx = 0;

    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[c];
      const itemsInCluster = Math.floor(maxBuildings / clusters.length);

      for (let i = 0; i < itemsInCluster && bldgIdx < maxBuildings; i++) {
        const angle = rng.range(0, Math.PI * 2);
        const dist = rng.range(25.0, cl.radius);
        const bx = cl.x + Math.cos(angle) * dist;
        const bz = cl.z + Math.sin(angle) * dist;
        const by = this.getTerrainHeight(bx, bz);

        if (by < waterY + 3.5 || by > 165.0) continue;

        const isWarehouse = cl.industrial && rng.next() < 0.45;
        const w = isWarehouse ? rng.range(18.0, 38.0) : rng.range(9.0, 16.0);
        const d = isWarehouse ? rng.range(24.0, 52.0) : rng.range(10.0, 18.0);
        const h = isWarehouse ? rng.range(8.5, 14.0) : rng.range(6.0, 16.0);

        dummy.position.set(bx, by - 0.5, bz);
        dummy.rotation.set(0, rng.int(0, 3) * (Math.PI * 0.5) + rng.range(-0.08, 0.08), 0);
        dummy.scale.set(w, h, d);
        dummy.updateMatrix();
        this.buildingInstancedMesh.setMatrixAt(bldgIdx, dummy.matrix);

        if (isWarehouse) {
          color.setRGB(rng.range(0.55, 0.68), rng.range(0.58, 0.70), rng.range(0.62, 0.74));
        } else {
          color.setRGB(rng.range(0.68, 0.82), rng.range(0.64, 0.76), rng.range(0.58, 0.70));
        }
        this.buildingInstancedMesh.setColorAt(bldgIdx, color);
        bldgIdx++;

        // Add industrial silos / cooling towers / comms masts in industrial clusters
        if (cl.industrial && siloIdx < maxSilos && rng.next() < 0.38) {
          const sx = bx + rng.range(-28, 28);
          const sz = bz + rng.range(-28, 28);
          const sy = this.getTerrainHeight(sx, sz);
          const isTower = rng.next() < 0.25;
          const radius = isTower ? rng.range(1.2, 2.0) : rng.range(4.5, 8.0);
          const height = isTower ? rng.range(38.0, 68.0) : rng.range(14.0, 26.0);

          dummy.position.set(sx, sy - 0.5, sz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(radius, height, radius);
          dummy.updateMatrix();
          this.siloInstancedMesh.setMatrixAt(siloIdx, dummy.matrix);
          siloIdx++;
        }
      }
    }

    this.buildingInstancedMesh.count = bldgIdx;
    this.buildingInstancedMesh.instanceMatrix.needsUpdate = true;
    if (this.buildingInstancedMesh.instanceColor) this.buildingInstancedMesh.instanceColor.needsUpdate = true;

    this.siloInstancedMesh.count = siloIdx;
    this.siloInstancedMesh.instanceMatrix.needsUpdate = true;

    this.instancedGroup.add(this.buildingInstancedMesh);
    this.instancedGroup.add(this.siloInstancedMesh);
  }

  _clearChunks() {
    for (const chunk of this.activeChunks.values()) {
      this.chunkGroup.remove(chunk.mesh);
      chunk.geometry.dispose();
    }
    this.activeChunks.clear();
  }

  _clearInstancedProps() {
    if (this.treeInstancedMesh) {
      this.instancedGroup.remove(this.treeInstancedMesh);
      this.treeInstancedMesh.geometry.dispose();
      this.treeInstancedMesh = null;
    }
    if (this.buildingInstancedMesh) {
      this.instancedGroup.remove(this.buildingInstancedMesh);
      this.buildingInstancedMesh.geometry.dispose();
      this.buildingInstancedMesh = null;
    }
    if (this.siloInstancedMesh) {
      this.instancedGroup.remove(this.siloInstancedMesh);
      this.siloInstancedMesh.geometry.dispose();
      this.siloInstancedMesh = null;
    }
  }

  dispose() {
    this._clearChunks();
    this._clearInstancedProps();
    this.waterMesh.geometry.dispose();
    this.skyDome.geometry.dispose();
  }
}
