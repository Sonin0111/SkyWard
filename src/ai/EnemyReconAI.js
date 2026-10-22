import * as THREE from '../../vendor/three.module.js';
import { FLIGHT_CONFIG } from '../config/flightConfig.js';
import { SeededRandom } from '../utils/prng.js';
import { clamp, damp, wrapAngleRad, wrapHeadingDeg, DEG2RAD, RAD2DEG } from '../utils/math.js';

const PATTERN_TYPES = [
  'SECTOR_POLYGON_PATROL',
  'FIGURE_EIGHT_SURVEILLANCE',
  'ZIGZAG_CORRIDOR_SCAN',
  'DEEP_VALLEY_RECON'
];

/**
 * Autonomous Flight Controller and Procedural Route Generator for the Enemy Reconnaissance UAV.
 * Independent flight dynamics with smooth bank-to-turn transitions, altitude variation,
 * forward terrain-avoidance lookahead, and seed-reproducible procedural routes.
 */
export class EnemyReconAI {
  constructor(config = FLIGHT_CONFIG) {
    this.config = config;

    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.prevVelocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.prevQuaternion = new THREE.Quaternion();

    this.headingRad = 0.0;
    this.pitchRad = 0.0;
    this.rollRad = 0.0;
    this.speedMs = 25.0;
    this.targetSpeedMs = 25.0;

    this.waypoints = [];
    this.currentWaypointIndex = 0;
    this.patternName = 'SECTOR_POLYGON_PATROL';
    this.activeSeed = config.world.defaultSeed;

    this.isDestroyed = false;
    this.isCrashedOnGround = false;

    // Pre-allocated scratch math objects
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._interpPos = new THREE.Vector3();
    this._interpQuat = new THREE.Quaternion();
    this._toWaypoint = new THREE.Vector3();
  }

  /**
   * Generates a new procedural 3D reconnaissance route from the given seed
   * and spawns the enemy UAV at the start of the route.
   * @param {number|string} seed - Scenario random seed
   * @param {Function} getTerrainHeight - (x, z) => terrainElevationM
   */
  initScenario(seed, getTerrainHeight) {
    this.activeSeed = seed;
    const rng = new SeededRandom(
      typeof seed === 'number' ? (seed ^ 0x5bd1e995) >>> 0 : `${seed}_recon`
    );

    const icfg = this.config.interception;
    const maxR = icfg.worldPlayableRadiusM * 0.62; // Stay well within playable world boundaries
    const numWps = icfg.routeWaypointCount;

    this.patternName = PATTERN_TYPES[rng.int(0, PATTERN_TYPES.length - 1)];
    this.waypoints = [];

    // First waypoint is placed 240m - 380m in the forward northern sector from player spawn
    // so the player can visually acquire, track, and intercept the target in FPV view.
    const startBearing = rng.range(-0.18, 0.18); // ~ -10 deg to +10 deg off North
    const startDist = rng.range(240.0, 380.0);
    const startX = Math.sin(startBearing) * startDist;
    const startZ = this.config.spawn.z - Math.cos(startBearing) * startDist;

    const sampleSafeAlt = (x, z, desiredAlt) => {
      let maxGround = getTerrainHeight ? getTerrainHeight(x, z) : 0.0;
      if (getTerrainHeight) {
        // Sample neighborhood around waypoint to guarantee terrain clearance
        for (let dx = -120; dx <= 120; dx += 120) {
          for (let dz = -120; dz <= 120; dz += 120) {
            maxGround = Math.max(maxGround, getTerrainHeight(x + dx, z + dz));
          }
        }
      }
      return Math.max(desiredAlt, maxGround + icfg.enemyMinTerrainClearanceM);
    };

    const wp0Alt = sampleSafeAlt(startX, startZ, rng.range(icfg.enemyAltMinM, icfg.enemyAltMaxM));
    this.waypoints.push(new THREE.Vector3(startX, wp0Alt, startZ));

    // Generate remaining procedural waypoints according to selected recon pattern
    const centerOffsetAngle = rng.range(0, Math.PI * 2.0);
    const centerX = Math.cos(centerOffsetAngle) * rng.range(300.0, 950.0);
    const centerZ = -400.0 + Math.sin(centerOffsetAngle) * rng.range(300.0, 950.0);

    for (let i = 1; i < numWps; i++) {
      const frac = i / numWps;
      let wx = 0.0;
      let wz = 0.0;

      if (this.patternName === 'FIGURE_EIGHT_SURVEILLANCE') {
        const t = frac * Math.PI * 2.0 + startBearing;
        const lobeRadius = rng.range(1600.0, 2500.0);
        wx = centerX + Math.sin(t) * lobeRadius;
        wz = centerZ + Math.sin(2.0 * t) * (lobeRadius * 0.68);
      } else if (this.patternName === 'ZIGZAG_CORRIDOR_SCAN') {
        const leg = i % 2 === 0 ? 1 : -1;
        wx = centerX + leg * rng.range(1100.0, 2400.0);
        wz = startZ - i * rng.range(480.0, 760.0);
        if (wz < -maxR) wz = -maxR + (i % 3) * 650.0;
      } else if (this.patternName === 'DEEP_VALLEY_RECON') {
        const theta = startBearing + frac * Math.PI * 2.0 * rng.sign();
        const rad = rng.range(1100.0, 2800.0) * (0.65 + 0.35 * Math.sin(i * 1.7));
        wx = centerX + Math.sin(theta) * rad;
        wz = centerZ - Math.cos(theta) * rad;
      } else {
        // SECTOR_POLYGON_PATROL: irregular tactical polygon with varied leg lengths
        const dir = rng.next() < 0.5 ? 1 : -1;
        const angle = startBearing + dir * frac * Math.PI * 2.0 + rng.range(-0.32, 0.32);
        const radius = rng.range(1350.0, 2650.0);
        wx = centerX + Math.sin(angle) * radius;
        wz = centerZ - Math.cos(angle) * radius;
      }

      wx = clamp(wx, -maxR, maxR);
      wz = clamp(wz, -maxR, maxR);

      const desiredAlt = rng.range(icfg.enemyAltMinM, icfg.enemyAltMaxM);
      const wy = sampleSafeAlt(wx, wz, desiredAlt);
      this.waypoints.push(new THREE.Vector3(wx, wy, wz));
    }

    // Initialize UAV state at Waypoint 0 heading toward Waypoint 1
    const wp0 = this.waypoints[0];
    const wp1 = this.waypoints[1];
    this.position.copy(wp0);
    this.prevPosition.copy(wp0);

    const dx = wp1.x - wp0.x;
    const dz = wp1.z - wp0.z;
    this.headingRad = Math.atan2(dx, -dz);
    this.pitchRad = 0.0;
    this.rollRad = 0.0;

    this.speedMs = rng.range(icfg.enemySpeedKmhMin, icfg.enemySpeedKmhMax) / 3.6;
    this.targetSpeedMs = this.speedMs;

    this._euler.set(this.pitchRad, -this.headingRad, this.rollRad, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
    this.prevQuaternion.copy(this.quaternion);

    this.velocity.set(
      Math.sin(this.headingRad) * this.speedMs,
      0.0,
      -Math.cos(this.headingRad) * this.speedMs
    );
    this.prevVelocity.copy(this.velocity);

    this.currentWaypointIndex = 1;
    this.isDestroyed = false;
    this.isCrashedOnGround = false;
  }

  /**
   * Advances autonomous recon flight dynamics by fixed timestep dt.
   */
  step(dt, getTerrainHeight) {
    this.prevPosition.copy(this.position);
    this.prevVelocity.copy(this.velocity);
    this.prevQuaternion.copy(this.quaternion);

    const groundY = getTerrainHeight ? getTerrainHeight(this.position.x, this.position.z) : 0.0;

    // If intercepted/destroyed, simulate spiraling flaming wreck falling to terrain
    if (this.isDestroyed) {
      if (!this.isCrashedOnGround) {
        this.velocity.y -= 9.81 * dt;
        this.velocity.x *= 1.0 - 0.25 * dt;
        this.velocity.z *= 1.0 - 0.25 * dt;
        this.position.addScaledVector(this.velocity, dt);

        this.rollRad += 4.8 * dt;
        this.pitchRad = clamp(this.pitchRad - 1.2 * dt, -1.35, 1.35);
        this.headingRad += 1.6 * dt;
        this._euler.set(this.pitchRad, -this.headingRad, this.rollRad, 'YXZ');
        this.quaternion.setFromEuler(this._euler);

        if (this.position.y <= groundY + 1.0) {
          this.position.y = groundY + 1.0;
          this.velocity.set(0, 0, 0);
          this.isCrashedOnGround = true;
        }
      }
      return;
    }

    const icfg = this.config.interception;
    const targetWp = this.waypoints[this.currentWaypointIndex];

    this._toWaypoint.subVectors(targetWp, this.position);
    const horizontalDist = Math.hypot(this._toWaypoint.x, this._toWaypoint.z);

    // Smoothly advance to next waypoint before reaching exact point (anticipatory turn lead)
    if (horizontalDist < 190.0) {
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.waypoints.length;
    }

    const activeWp = this.waypoints[this.currentWaypointIndex];
    const dx = activeWp.x - this.position.x;
    const dz = activeWp.z - this.position.z;
    const desiredHeading = Math.atan2(dx, -dz);

    // Heading error in [-pi, pi]
    const headingError = wrapAngleRad(desiredHeading - this.headingRad);

    // Bank-to-turn control: bank into the turn proportional to heading error
    const maxBankRad = 32.0 * DEG2RAD;
    const desiredRollRad = clamp(-headingError * 1.35, -maxBankRad, maxBankRad);
    this.rollRad = damp(this.rollRad, desiredRollRad, 3.2, dt);

    // Turn rate from bank angle: omega = (g / V) * tan(bank)
    const turnRate = -(9.80665 / Math.max(18.0, this.speedMs)) * Math.tan(this.rollRad);
    this.headingRad = wrapAngleRad(this.headingRad + turnRate * dt);

    // Forward terrain lookahead at 140m and 280m to guarantee terrain avoidance
    const sinH = Math.sin(this.headingRad);
    const cosH = -Math.cos(this.headingRad);
    let maxLookaheadGround = groundY;
    if (getTerrainHeight) {
      const g1 = getTerrainHeight(this.position.x + sinH * 140.0, this.position.z + cosH * 140.0);
      const g2 = getTerrainHeight(this.position.x + sinH * 280.0, this.position.z + cosH * 280.0);
      maxLookaheadGround = Math.max(groundY, g1, g2);
    }

    const minSafeAlt = maxLookaheadGround + icfg.enemyMinTerrainClearanceM;
    const desiredAlt = Math.max(activeWp.y, minSafeAlt);
    const altError = desiredAlt - this.position.y;

    // Smooth pitch control for altitude transitions
    const maxPitchRad = 16.0 * DEG2RAD;
    const desiredPitchRad = clamp(altError * 0.0085, -maxPitchRad, maxPitchRad);
    this.pitchRad = damp(this.pitchRad, desiredPitchRad, 2.8, dt);

    // Speed varies slightly with pitch (faster in descents, slightly slower in climbs)
    const baseCruiseMs = ((icfg.enemySpeedKmhMin + icfg.enemySpeedKmhMax) * 0.5) / 3.6;
    const targetSpeed = clamp(
      baseCruiseMs - Math.sin(this.pitchRad) * 6.5,
      icfg.enemySpeedKmhMin / 3.6,
      icfg.enemySpeedKmhMax / 3.6
    );
    this.speedMs = damp(this.speedMs, targetSpeed, 1.5, dt);

    // Compute 3D velocity vector from attitude and airspeed
    const cosP = Math.cos(this.pitchRad);
    const sinP = Math.sin(this.pitchRad);
    this.velocity.set(
      Math.sin(this.headingRad) * cosP * this.speedMs,
      sinP * this.speedMs,
      -Math.cos(this.headingRad) * cosP * this.speedMs
    );

    this.position.addScaledVector(this.velocity, dt);

    // Enforce minimum terrain floor safety
    if (this.position.y < groundY + 45.0) {
      this.position.y = groundY + 45.0;
      if (this.velocity.y < 0) this.velocity.y = 2.0;
    }

    this._euler.set(this.pitchRad, -this.headingRad, this.rollRad, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
  }

  triggerIntercepted(blastImpulse = null) {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (blastImpulse) {
      this.velocity.add(blastImpulse);
    }
  }

  getInterpolatedState(alpha) {
    const a = clamp(alpha, 0.0, 1.0);
    this._interpPos.lerpVectors(this.prevPosition, this.position, a);
    this._interpQuat.slerpQuaternions(this.prevQuaternion, this.quaternion, a);

    return {
      position: this._interpPos,
      quaternion: this._interpQuat,
      velocity: this.velocity,
      speedKmh: this.speedMs * 3.6,
      headingDeg: wrapHeadingDeg(this.headingRad * RAD2DEG),
      altitudeMSL: this._interpPos.y
    };
  }
}
