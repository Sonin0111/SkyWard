import * as THREE from '../../vendor/three.module.js';
import { FLIGHT_CONFIG } from '../config/flightConfig.js';
import { clamp, lerp, damp, DEG2RAD, RAD2DEG, wrapHeadingDeg, computeAirDensityISA } from '../utils/math.js';

/**
 * 6-DOF Rigid-Body Aerodynamic Flight Simulator for the 15.3 kg Fixed-Wing Interceptor UAV.
 *
 * Coordinate Convention (Three.js Standard):
 * - World Frame: +X = East, +Y = Up (Altitude MSL), -Z = North
 * - Body Frame:  +X = Right Wing, +Y = Dorsal Up, -Z = Nose Forward (+Z = Tail Aft)
 *
 * Fixed-timestep integration with state snapshots and interpolation for decoupled rendering.
 * Zero heap allocations inside step() to guarantee 60+ FPS without GC pauses.
 */
export class FlightPhysics {
  constructor(config = FLIGHT_CONFIG) {
    this.config = config;

    // Current and previous physical state for render interpolation
    this.position = new THREE.Vector3();
    this.prevPosition = new THREE.Vector3();

    this.velocity = new THREE.Vector3();
    this.prevVelocity = new THREE.Vector3();

    this.quaternion = new THREE.Quaternion();
    this.prevQuaternion = new THREE.Quaternion();

    // Body-frame angular velocity (rad/s): x = pitch rate, y = yaw rate, z = roll rate
    this.angularVelocity = new THREE.Vector3();
    this.prevAngularVelocity = new THREE.Vector3();

    // Smoothed actuator positions: pitch, roll, yaw in [-1, 1], throttle in [0, 1]
    this.actuators = {
      pitch: 0.0,
      roll: 0.0,
      yaw: 0.0,
      throttle: config.spawn.initialThrottle
    };

    // Physical control surface deflections for 3D mesh animation
    this.surfaceDeflections = {
      pitch: 0.0,
      roll: 0.0,
      yaw: 0.0
    };

    // Derived flight telemetry (updated every physics step)
    this.telemetry = {
      airspeedMs: 0.0,
      airspeedKmh: 0.0,
      groundSpeedKmh: 0.0,
      verticalSpeedMs: 0.0,
      altitudeMSL: 0.0,
      altitudeAGL: 0.0,
      terrainHeightM: 0.0,
      alphaRad: 0.0,
      alphaDeg: 0.0,
      betaRad: 0.0,
      betaDeg: 0.0,
      pitchDeg: 0.0,
      rollDeg: 0.0,
      headingDeg: 0.0,
      gLoad: 1.0,
      liftForceN: 0.0,
      dragForceN: 0.0,
      thrustForceN: 0.0,
      airDensity: 1.225,
      dynamicPressurePa: 0.0,
      CL: 0.0,
      CD: 0.0,
      stallFactor: 0.0,
      isStalling: false,
      isNearCeiling: false,
      controlEffectiveness: 1.0,
      rpm: 0.0,
      throttlePercent: 0.0,
      // Battery telemetry
      batteryPercent: 100.0,
      batteryVoltage: config.propulsion.voltageFull,
      cellVoltage: config.propulsion.voltageFull / config.propulsion.batteryCells,
      currentDrawA: 0.0,
      mahUsed: 0.0,
      remainingMinutes: config.propulsion.nominalEnduranceMinutes,
      // Status flags
      crashed: false,
      detonated: false,
      batteryDepleted: false,
      flightTimeSec: 0.0,
      maxSpeedReachedKmh: 0.0,
      speedSumKmh: 0.0,
      speedSamples: 0
    };

    // Pre-allocated scratch math objects (zero per-frame allocations)
    this._invQuat = new THREE.Quaternion();
    this._deltaQuat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._velBody = new THREE.Vector3();
    this._forceBody = new THREE.Vector3();
    this._forceWorld = new THREE.Vector3();
    this._accelWorld = new THREE.Vector3();
    this._torqueBody = new THREE.Vector3();
    this._angAccel = new THREE.Vector3();
    this._forwardWorld = new THREE.Vector3();
    this._upWorld = new THREE.Vector3();
    this._rightWorld = new THREE.Vector3();
    this._interpPos = new THREE.Vector3();
    this._interpQuat = new THREE.Quaternion();
    this._interpVel = new THREE.Vector3();

    this.reset();
  }

  /**
   * Resets aircraft state to initial trimmed cruise flight.
   * @param {Function} [getTerrainHeight] - Optional terrain height callback (x, z) => y
   * @param {Object} [customSpawn] - Optional override spawn coordinates
   */
  reset(getTerrainHeight = null, customSpawn = null) {
    const spawn = customSpawn || this.config.spawn;
    const groundY = getTerrainHeight ? getTerrainHeight(spawn.x, spawn.z) : 0.0;
    const startAlt = Math.max(groundY + spawn.altitudeAboveGroundM, spawn.altitudeAboveGroundM);

    this.position.set(spawn.x, startAlt, spawn.z);
    this.prevPosition.copy(this.position);

    const headingRad = (spawn.headingDeg || 0.0) * DEG2RAD;
    const speedMs = (spawn.initialSpeedKmh || this.config.envelope.cruiseSpeedKmh) / 3.6;
    const rhoSpawn = computeAirDensityISA(startAlt);
    const qSpawn = 0.5 * rhoSpawn * speedMs * speedMs;
    const weightN = this.config.airframe.totalMassKg * this.config.environment.gravity;
    const clReq = weightN / Math.max(50.0, qSpawn * this.config.airframe.wingAreaM2);
    const trimPitchRad = clamp(
      (clReq - this.config.aero.CL0) / this.config.aero.CLAlpha,
      0.005,
      0.12
    );
    this._euler.set(trimPitchRad, -headingRad, 0.0, 'YXZ');
    this.quaternion.setFromEuler(this._euler);
    this.prevQuaternion.copy(this.quaternion);
    this.velocity.set(
      Math.sin(headingRad) * speedMs,
      0.0,
      -Math.cos(headingRad) * speedMs
    );
    this.prevVelocity.copy(this.velocity);

    this.angularVelocity.set(0, 0, 0);
    this.prevAngularVelocity.set(0, 0, 0);

    this.actuators.pitch = 0.0;
    this.actuators.roll = 0.0;
    this.actuators.yaw = 0.0;
    this.actuators.throttle = spawn.initialThrottle ?? 0.58;

    const prop = this.config.propulsion;
    this.telemetry.mahUsed = 0.0;
    this.telemetry.batteryPercent = 100.0;
    this.telemetry.batteryVoltage = prop.voltageFull;
    this.telemetry.cellVoltage = prop.voltageFull / prop.batteryCells;
    this.telemetry.currentDrawA = prop.cruiseCurrentA;
    this.telemetry.remainingMinutes = prop.nominalEnduranceMinutes;
    this.telemetry.crashed = false;
    this.telemetry.detonated = false;
    this.telemetry.batteryDepleted = false;
    this.telemetry.flightTimeSec = 0.0;
    this.telemetry.maxSpeedReachedKmh = spawn.initialSpeedKmh || 110.0;
    this.telemetry.speedSumKmh = 0.0;
    this.telemetry.speedSamples = 0;

    this._updateDerivedTelemetry(groundY, 1.0);
  }

  /**
   * Computes lift coefficient CL(alpha) with smooth post-stall drop-off
   * and flat-plate Newtonian regime at extreme angles of attack.
   * @param {number} alphaRad - Angle of attack in radians
   * @returns {{ cl: number, stallFactor: number }}
   */
  computeLiftCoefficient(alphaRad) {
    const aero = this.config.aero;
    const alphaStallPos = aero.alphaStallPosDeg * DEG2RAD;
    const alphaStallNeg = aero.alphaStallNegDeg * DEG2RAD;
    const dropWidth = aero.postStallDropWidthDeg * DEG2RAD;

    // Linear attached-flow lift curve
    const clLinear = aero.CL0 + aero.CLAlpha * alphaRad;

    // Post-stall flat-plate approximation: CL_post = 2 * factor * sin(alpha) * cos(alpha)
    const clPostStall = aero.postStallLiftFactor * Math.sin(2.0 * alphaRad);

    let stallFactor = 0.0;
    if (alphaRad > alphaStallPos) {
      const excess = (alphaRad - alphaStallPos) / dropWidth;
      stallFactor = clamp(excess * excess * (3.0 - 2.0 * clamp(excess, 0.0, 1.0)), 0.0, 1.0);
      if (excess >= 1.0) stallFactor = 1.0;
    } else if (alphaRad < alphaStallNeg) {
      const excess = (alphaStallNeg - alphaRad) / dropWidth;
      stallFactor = clamp(excess * excess * (3.0 - 2.0 * clamp(excess, 0.0, 1.0)), 0.0, 1.0);
      if (excess >= 1.0) stallFactor = 1.0;
    }

    const clAttached = clamp(clLinear, aero.CLMin, aero.CLMax);
    const cl = lerp(clAttached, clPostStall, stallFactor);

    return { cl, stallFactor };
  }

  /**
   * Computes total drag coefficient CD(alpha, beta, cl, stallFactor).
   */
  computeDragCoefficient(alphaRad, betaRad, cl, stallFactor) {
    const aero = this.config.aero;
    const inducedDrag = aero.inducedDragFactorK * cl * cl;
    const sideslipDrag = aero.CDSideslip * betaRad * betaRad;
    const sinAlpha = Math.sin(alphaRad);
    const stallDrag = aero.CDStallMax * sinAlpha * sinAlpha * (0.25 + 0.75 * stallFactor);

    return aero.CD0 + inducedDrag + sideslipDrag + stallDrag;
  }

  /**
   * Computes twin-propeller thrust in Newtons as a function of throttle, airspeed, and density.
   * Calibrated so 100% throttle equilibrates level flight at 150 km/h (41.67 m/s)
   * and 58% throttle cruises level at 110 km/h (30.56 m/s).
   */
  computeThrust(throttle, airspeedMs, airDensity, batteryDepleted) {
    if (batteryDepleted || throttle <= 0.001) return 0.0;

    const prop = this.config.propulsion;
    const densityRatio = Math.pow(clamp(airDensity / 1.225, 0.1, 1.2), 0.85);
    const effluxSpeed = 55.55; // m/s propeller pitch efflux velocity
    const speedRatio = clamp(airspeedMs / effluxSpeed, 0.0, 0.985);
    const inflowFactor = Math.max(0.02, 1.0 - Math.pow(speedRatio, 1.35));

    const throttlePower = Math.pow(clamp(throttle, 0.0, 1.0), 1.74);
    return prop.maxStaticThrustN * throttlePower * inflowFactor * densityRatio;
  }

  /**
   * Advances the fixed-timestep 6-DOF flight simulation by dt seconds.
   * @param {number} dt - Fixed physics step in seconds (e.g. 1/120)
   * @param {Object} controls - { pitch, roll, yaw, throttle }
   * @param {Function} getTerrainHeight - (x, z) => terrainElevationM
   */
  step(dt, controls, getTerrainHeight) {
    // Save previous state snapshot for render interpolation
    this.prevPosition.copy(this.position);
    this.prevVelocity.copy(this.velocity);
    this.prevQuaternion.copy(this.quaternion);
    this.prevAngularVelocity.copy(this.angularVelocity);

    const terrainY = getTerrainHeight ? getTerrainHeight(this.position.x, this.position.z) : 0.0;

    // If terminated (crashed or detonated), simulate ballistic falling debris motion
    if (this.telemetry.crashed || this.telemetry.detonated) {
      this._stepTerminatedMotion(dt, terrainY);
      return;
    }

    this.telemetry.flightTimeSec += dt;

    const af = this.config.airframe;
    const aero = this.config.aero;
    const env = this.config.environment;

    // 1. Smooth control surface servo actuators (no instantaneous snapping)
    const targetPitch = clamp(controls.pitch || 0.0, -1.0, 1.0);
    const targetRoll = clamp(controls.roll || 0.0, -1.0, 1.0);
    const targetYaw = clamp(controls.yaw || 0.0, -1.0, 1.0);
    const targetThrottle = clamp(controls.throttle ?? this.actuators.throttle, 0.0, 1.0);

    this.actuators.pitch = damp(this.actuators.pitch, targetPitch, aero.servoRatePitch, dt);
    this.actuators.roll = damp(this.actuators.roll, targetRoll, aero.servoRateRoll, dt);
    this.actuators.yaw = damp(this.actuators.yaw, targetYaw, aero.servoRateYaw, dt);
    this.actuators.throttle = damp(this.actuators.throttle, targetThrottle, aero.servoRateThrottle, dt);

    // 2. Update battery discharge simulation
    this._stepBattery(dt, this.actuators.throttle);

    // 3. Compute atmospheric density at current altitude (ISA + ceiling dropoff)
    const altitudeMSL = this.position.y;
    const rho = computeAirDensityISA(altitudeMSL);

    // 4. Transform world velocity into aircraft body frame
    this._invQuat.copy(this.quaternion).invert();
    this._velBody.copy(this.velocity).applyQuaternion(this._invQuat);

    const vx = this._velBody.x;         // Right (+X)
    const vy = this._velBody.y;         // Up (+Y)
    const vz = this._velBody.z;         // Aft (+Z)
    const forwardSpeed = Math.max(0.0, -vz); // Forward along nose (-Z)
    const airspeedSq = vx * vx + vy * vy + vz * vz;
    const airspeed = Math.sqrt(airspeedSq);

    // 5. Compute Angle of Attack (alpha) and Sideslip Angle (beta)
    let alpha = 0.0;
    let beta = 0.0;
    if (airspeed > 0.5) {
      alpha = Math.atan2(-vy, Math.max(0.5, -vz));
      beta = Math.asin(clamp(vx / airspeed, -1.0, 1.0));
    }

    // Dynamic pressure q_bar = 0.5 * rho * V^2
    const qBar = 0.5 * rho * airspeedSq;
    const S = af.wingAreaM2;
    const b = af.wingSpanM;
    const cBar = af.meanChordM;

    // 6. Compute Lift, Drag, Side Force, and Propulsion Thrust in Body Frame
    const { cl, stallFactor } = this.computeLiftCoefficient(alpha);
    const cd = this.computeDragCoefficient(alpha, beta, cl, stallFactor);
    const cy = aero.CYBeta * beta;

    const liftMag = qBar * S * cl;
    const dragMag = qBar * S * cd;
    const sideMag = qBar * S * cy;
    const thrustMag = this.computeThrust(
      this.actuators.throttle,
      forwardSpeed,
      rho,
      this.telemetry.batteryDepleted
    );

    this._forceBody.set(0.0, 0.0, 0.0);

    if (airspeed > 0.25) {
      // Drag acts strictly opposite to body velocity vector
      const invV = 1.0 / airspeed;
      this._forceBody.x += -dragMag * (vx * invV);
      this._forceBody.y += -dragMag * (vy * invV);
      this._forceBody.z += -dragMag * (vz * invV);

      // Lift acts perpendicular to longitudinal flow in body (Y, Z) plane: (0, cos(alpha), -sin(alpha))
      const cosA = Math.cos(alpha);
      const sinA = Math.sin(alpha);
      this._forceBody.y += liftMag * cosA;
      this._forceBody.z += -liftMag * sinA;

      // Side force acts along body +X
      this._forceBody.x += sideMag;
    }

    // Propulsion thrust acts forward along nose (-Z)
    this._forceBody.z += -thrustMag;

    // 7. Transform aerodynamic + thrust forces to world frame & add gravity
    this._forceWorld.copy(this._forceBody).applyQuaternion(this.quaternion);
    this._accelWorld.copy(this._forceWorld).divideScalar(af.totalMassKg);
    this._accelWorld.y -= env.gravity;

    // Service ceiling soft vertical restoration if climbing past max ceiling (4500m)
    if (altitudeMSL > this.config.envelope.serviceCeilingMaxM && this.velocity.y > 0) {
      const ceilingExcess = altitudeMSL - this.config.envelope.serviceCeilingMaxM;
      this._accelWorld.y -= clamp(ceilingExcess * 0.05, 0.0, 6.0);
    }

    // Integrate linear velocity and position (semi-implicit Euler)
    this.velocity.addScaledVector(this._accelWorld, dt);

    // Clamp never-exceed dive velocity for numerical stability
    const maxSafeSpeedMs = this.config.envelope.neverExceedSpeedKmh / 3.6;
    const newSpeedSq = this.velocity.lengthSq();
    if (newSpeedSq > maxSafeSpeedMs * maxSafeSpeedMs) {
      this.velocity.multiplyScalar(maxSafeSpeedMs / Math.sqrt(newSpeedSq));
    }

    this.position.addScaledVector(this.velocity, dt);

    // 8. Compute Aerodynamic & Control Torques in Body Frame
    // Control surface effectiveness depends on airspeed and stall state:
    // Reduced controllability at low airspeeds (< 70 km/h) and during stall
    const speedRatio = airspeed / aero.controlRefSpeedMs;
    const rawEffectiveness = clamp(
      speedRatio * speedRatio,
      aero.minControlEffectiveness,
      aero.maxControlEffectiveness
    );
    const controlEff = rawEffectiveness * (1.0 - 0.55 * stallFactor) * (rho / 1.225);

    const pRate = this.angularVelocity.x; // Pitch rate around +X (right wing)
    const qRate = this.angularVelocity.y; // Yaw rate around +Y (up)
    const rRate = this.angularVelocity.z; // Roll rate around +Z (aft)

    // Extract current bank angle for coordinated turn coupling
    this._euler.setFromQuaternion(this.quaternion, 'YXZ');
    const currentRollRad = this._euler.z;
    const currentPitchRad = this._euler.x;

    // Dimensionless angular rate damping scale (scales smoothly with airspeed)
    const aeroDampScale = Math.max(0.35, clamp(airspeed / 25.0, 0.35, 2.2) * (rho / 1.225));

    // Natural coordinated turn rate around World +Y when banked: omega_world = (g / V) * tan(phi)
    const clampedBank = clamp(currentRollRad, -1.15, 1.15);
    const worldTurnRate = (env.gravity / Math.max(airspeed, 14.0)) *
      Math.tan(clampedBank) * Math.cos(currentPitchRad) * aero.bankTurnCoordFactor;

    // Project World +Y coordinated turn rate into aircraft Body Frame (+X pitch, +Y yaw)
    const coordPitchRate = worldTurnRate * Math.sin(currentRollRad);
    const coordYawRate = worldTurnRate * Math.cos(currentRollRad);

    // Dynamic equilibrium trim AoA for level flight within the non-stalled cruise/high-speed envelope
    const neutralPitchFactor =
      Math.max(0.0, 1.0 - Math.abs(this.actuators.pitch) * 2.5) *
      (1.0 - stallFactor) *
      clamp((airspeed - this.config.envelope.stallSpeedMs * 1.05) / 6.0, 0.0, 1.0);
    const cosBankSafe = Math.max(0.55, Math.cos(currentRollRad));
    const eqCl = (af.totalMassKg * env.gravity) / Math.max(110.0, qBar * S * cosBankSafe);
    const dynamicTrimAlpha = clamp((eqCl - aero.CL0) / aero.CLAlpha, -0.02, 0.14);
    const targetTrimAlpha = lerp(aero.pitchTrimAlphaRad, dynamicTrimAlpha, neutralPitchFactor);

    // --- Pitch Torque (around +X) ---
    // Positive actuator.pitch = Nose UP (+X rotation)
    const alphaError = alpha - targetTrimAlpha;
    const staticPitchMoment = qBar * S * cBar * aero.CmAlpha * alphaError;
    const stallPitchDrop = stallFactor > 0.01
      ? Math.max(qBar, 80.0) * S * cBar * aero.CmStallNoseDown * stallFactor * Math.sign(alpha || 1.0)
      : 0.0;
    const elevatorTorque = this.actuators.pitch * aero.elevatorAuthority * controlEff * af.inertia.pitch;

    // Pitch attitude envelope restoring moment (prevents runaway vertical loops while allowing stalls)
    const pitchAttitudeError = clamp(currentPitchRad - targetTrimAlpha, -0.85, 0.85);
    const pitchAttitudeRestore =
      -pitchAttitudeError * 2.4 * (1.0 - stallFactor) * Math.max(0.2, Math.cos(currentRollRad)) * af.inertia.pitch;

    // Coordinated turn pitch-rate support + FBWA phugoid vertical-speed damping when elevator stick is neutral
    const coordPitchTorque = (coordPitchRate - pRate) * Math.abs(aero.CmQ) * 0.35 * aeroDampScale;
    const phugoidDampTorque =
      -(this.velocity.y / Math.max(15.0, airspeed)) *
      3.8 *
      neutralPitchFactor *
      Math.max(0.0, Math.cos(currentRollRad)) *
      af.inertia.pitch;

    const pitchTorque =
      elevatorTorque +
      staticPitchMoment +
      stallPitchDrop +
      pitchAttitudeRestore +
      coordPitchTorque +
      phugoidDampTorque;

    // --- Roll Torque (around +Z) ---
    // Note: In Three.js body frame (+X right, +Y up, +Z aft):
    // Right-hand rule around +Z: positive rotation raises +X (right wing) -> banks LEFT.
    // Input convention: controls.roll > 0 is Bank RIGHT (D / Right Arrow / Right stick).
    // In FBWA mode, roll input commands a target bank angle up to maxBankAngleDeg (60 deg),
    // and smoothly returns wings to level when roll input is centered.
    const maxBankRad = (aero.maxBankAngleDeg || 60.0) * DEG2RAD;
    const targetRollRad = -this.actuators.roll * maxBankRad;
    const rollAngleError = targetRollRad - currentRollRad;
    const effAileronCmd = clamp(rollAngleError * 1.95 - rRate * 0.22, -1.0, 1.0);

    const aileronTorque = effAileronCmd * aero.aileronAuthority * controlEff * af.inertia.roll;
    const dihedralTorque = -qBar * S * b * aero.ClBeta * beta; // beta > 0 (slip right) -> raises right wing (+Z)
    const rollDamping = -rRate * Math.abs(aero.ClP) * 0.65 * aeroDampScale;

    // Stall buffet / asymmetric wing-drop perturbation at high AoA stall
    let stallRollBuffet = 0.0;
    if (stallFactor > 0.15) {
      stallRollBuffet = Math.sin(this.telemetry.flightTimeSec * 19.5) *
        Math.cos(this.telemetry.flightTimeSec * 11.3) *
        stallFactor * 2.4;
    }

    const rollTorque =
      aileronTorque +
      dihedralTorque +
      rollDamping +
      stallRollBuffet;

    this.surfaceDeflections.pitch = this.actuators.pitch;
    this.surfaceDeflections.roll = -effAileronCmd;
    this.surfaceDeflections.yaw = this.actuators.yaw;

    // --- Yaw Torque (around +Y) ---
    // Right-hand rule around +Y: positive rotation turns nose (-Z) LEFT (-X).
    // Input convention: controls.yaw > 0 is Yaw RIGHT (E / Right rudder).
    // Therefore, Yaw RIGHT corresponds to negative Y angular acceleration!
    const rudderTorque = -this.actuators.yaw * aero.rudderAuthority * controlEff * af.inertia.yaw;
    const weathercockTorque = -qBar * S * b * aero.CnBeta * beta; // beta > 0 -> yaws nose right (-Y)
    const yawDamping = -qRate * Math.abs(aero.CnR) * 0.75 * aeroDampScale;
    const coordYawTorque = coordYawRate * 2.8 * af.inertia.yaw * aeroDampScale;

    const yawTorque = rudderTorque + weathercockTorque + yawDamping + coordYawTorque;

    // 9. Compute angular accelerations (Euler's equations with gyroscopic coupling)
    const Ix = af.inertia.pitch;
    const Iy = af.inertia.yaw;
    const Iz = af.inertia.roll;

    this._angAccel.set(
      (pitchTorque - (Iz - Iy) * qRate * rRate) / Ix,
      (yawTorque - (Ix - Iz) * pRate * rRate) / Iy,
      (rollTorque - (Iy - Ix) * pRate * qRate) / Iz
    );

    this.angularVelocity.addScaledVector(this._angAccel, dt);

    // Enforce configurable angular-rate limits
    this.angularVelocity.x = clamp(this.angularVelocity.x, -aero.maxPitchRateRad, aero.maxPitchRateRad);
    this.angularVelocity.y = clamp(this.angularVelocity.y, -aero.maxYawRateRad, aero.maxYawRateRad);
    this.angularVelocity.z = clamp(this.angularVelocity.z, -aero.maxRollRateRad, aero.maxRollRateRad);

    // 10. Integrate orientation quaternion: q(t + dt) = normalize(q(t) * exp(0.5 * omega * dt))
    const wx = this.angularVelocity.x;
    const wy = this.angularVelocity.y;
    const wz = this.angularVelocity.z;
    const omegaMag = Math.sqrt(wx * wx + wy * wy + wz * wz);

    if (omegaMag > 1e-7) {
      const halfAngle = 0.5 * omegaMag * dt;
      const sinHalf = Math.sin(halfAngle) / omegaMag;
      this._deltaQuat.set(wx * sinHalf, wy * sinHalf, wz * sinHalf, Math.cos(halfAngle));
      this.quaternion.multiply(this._deltaQuat).normalize();
    }

    // 11. Check ground collision at updated position
    const newTerrainY = getTerrainHeight ? getTerrainHeight(this.position.x, this.position.z) : 0.0;
    if (this.position.y <= newTerrainY + 0.65) {
      this.position.y = newTerrainY + 0.65;
      this.telemetry.crashed = true;
    }

    // 12. Update telemetry readout
    const gLoad = (liftMag / (af.totalMassKg * env.gravity)) * Math.sign(Math.cos(currentRollRad) || 1);
    this._updateDerivedTelemetry(newTerrainY, gLoad, {
      airspeed,
      alpha,
      beta,
      cl,
      cd,
      stallFactor,
      liftMag,
      dragMag,
      thrustMag,
      rho,
      qBar,
      controlEff
    });
  }

  /**
   * Simulates realistic 70-minute 6S Li-Ion battery discharge that accelerates at 100% throttle.
   */
  _stepBattery(dt, throttle) {
    if (this.telemetry.batteryDepleted) return;

    const prop = this.config.propulsion;
    // Non-linear current curve:
    // At 0% throttle -> avionicsBaseCurrentA (1.4 A)
    // At ~58% cruise throttle -> ~22.5 A (~74 minutes on 28,000 mAh pack)
    // At 100% full throttle -> ~68.0 A (~24 minutes on 28,000 mAh pack - 3x faster drain!)
    const t = clamp(throttle, 0.0, 1.0);
    const motorCurrent = (prop.maxThrottleCurrentA - prop.avionicsBaseCurrentA) * Math.pow(t, 2.15);
    const totalCurrentA = prop.avionicsBaseCurrentA + motorCurrent;

    // mAh consumed in dt seconds: I (Amps) * 1000 (mA/A) * (dt / 3600 hours)
    const mahDelta = totalCurrentA * 1000.0 * (dt / 3600.0);
    this.telemetry.mahUsed += mahDelta;

    const pctRemaining = clamp(
      100.0 * (1.0 - this.telemetry.mahUsed / prop.capacityMah),
      0.0,
      100.0
    );
    this.telemetry.batteryPercent = pctRemaining;
    this.telemetry.currentDrawA = totalCurrentA;

    // Open-circuit Li-Ion discharge curve + internal resistance voltage sag under load
    const soc = pctRemaining / 100.0;
    const openCircuitVoltage =
      prop.voltageCutoff +
      (prop.voltageFull - prop.voltageCutoff) * (0.85 * soc + 0.15 * Math.pow(soc, 0.35));
    const voltageSag = totalCurrentA * prop.internalResistanceOhm;

    this.telemetry.batteryVoltage = clamp(
      openCircuitVoltage - voltageSag,
      prop.voltageCutoff - 0.6,
      prop.voltageFull
    );
    this.telemetry.cellVoltage = this.telemetry.batteryVoltage / prop.batteryCells;

    const mahLeft = Math.max(0.0, prop.capacityMah - this.telemetry.mahUsed);
    this.telemetry.remainingMinutes = (mahLeft / 1000.0 / Math.max(1.0, totalCurrentA)) * 60.0;

    if (pctRemaining <= 0.05) {
      this.telemetry.batteryDepleted = true;
      this.actuators.throttle = 0.0;
    }
  }

  /**
   * Freezes player UAV physics upon warhead detonation (or stops on ground crash).
   */
  _stepTerminatedMotion(dt, terrainY) {
    if (this.telemetry.detonated) {
      // Freeze player UAV completely at detonation point
      this.velocity.set(0, 0, 0);
      this.prevVelocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
      this.prevAngularVelocity.set(0, 0, 0);
      this.prevPosition.copy(this.position);
      this.prevQuaternion.copy(this.quaternion);
      return;
    }

    if (this.position.y > terrainY + 0.5) {
      this.velocity.y -= this.config.environment.gravity * dt;
      this.velocity.multiplyScalar(1.0 - 0.35 * dt);
      this.position.addScaledVector(this.velocity, dt);

      // Tumbling rotation
      this._deltaQuat.setFromAxisAngle(new THREE.Vector3(0.4, 0.2, 0.89).normalize(), 3.8 * dt);
      this.quaternion.multiply(this._deltaQuat).normalize();

      if (this.position.y <= terrainY + 0.5) {
        this.position.y = terrainY + 0.5;
        this.velocity.set(0, 0, 0);
      }
    } else {
      this.position.y = terrainY + 0.5;
      this.velocity.set(0, 0, 0);
    }
    this._updateDerivedTelemetry(terrainY, 0.0);
  }

  /**
   * Updates human-readable telemetry values for the OSD and gameplay logic.
   */
  _updateDerivedTelemetry(terrainY, gLoad, details = null) {
    const t = this.telemetry;
    const speedMs = details ? details.airspeed : this.velocity.length();
    const speedKmh = speedMs * 3.6;

    t.airspeedMs = speedMs;
    t.airspeedKmh = speedKmh;
    t.groundSpeedKmh = Math.hypot(this.velocity.x, this.velocity.z) * 3.6;
    t.verticalSpeedMs = this.velocity.y;
    t.altitudeMSL = this.position.y;
    t.terrainHeightM = terrainY;
    t.altitudeAGL = Math.max(0.0, this.position.y - terrainY);

    if (speedKmh > t.maxSpeedReachedKmh && !t.crashed && !t.detonated) {
      t.maxSpeedReachedKmh = speedKmh;
    }
    if (!t.crashed && !t.detonated) {
      t.speedSumKmh += speedKmh;
      t.speedSamples += 1;
    }

    // Extract aircraft Euler attitude (Pitch, Roll, Heading)
    this._forwardWorld.set(0, 0, -1).applyQuaternion(this.quaternion);
    this._upWorld.set(0, 1, 0).applyQuaternion(this.quaternion);
    this._rightWorld.set(1, 0, 0).applyQuaternion(this.quaternion);

    t.pitchDeg = Math.asin(clamp(this._forwardWorld.y, -1.0, 1.0)) * RAD2DEG;
    t.rollDeg = Math.atan2(-this._rightWorld.y, this._upWorld.y) * RAD2DEG;
    t.headingDeg = wrapHeadingDeg(Math.atan2(this._forwardWorld.x, -this._forwardWorld.z) * RAD2DEG);

    t.gLoad = clamp(gLoad, -4.0, 8.0);
    t.throttlePercent = this.actuators.throttle * 100.0;

    const prop = this.config.propulsion;
    t.rpm = t.batteryDepleted || t.crashed || t.detonated
      ? 0
      : prop.idleRpm + (prop.maxRpm - prop.idleRpm) * Math.pow(this.actuators.throttle, 0.85);

    if (details) {
      t.alphaRad = details.alpha;
      t.alphaDeg = details.alpha * RAD2DEG;
      t.betaRad = details.beta;
      t.betaDeg = details.beta * RAD2DEG;
      t.CL = details.cl;
      t.CD = details.cd;
      t.stallFactor = details.stallFactor;
      t.isStalling = details.stallFactor > 0.12 || speedKmh < this.config.envelope.stallSpeedKmh;
      t.isNearCeiling = this.position.y >= this.config.envelope.serviceCeilingMinM;
      t.liftForceN = details.liftMag;
      t.dragForceN = details.dragMag;
      t.thrustForceN = details.thrustMag;
      t.airDensity = details.rho;
      t.dynamicPressurePa = details.qBar;
      t.controlEffectiveness = details.controlEff;
    }
  }

  /**
   * Returns interpolated position, orientation, and velocity for decoupled rendering.
   * @param {number} alpha - Interpolation factor in [0.0, 1.0]
   */
  getInterpolatedState(alpha) {
    const a = clamp(alpha, 0.0, 1.0);
    this._interpPos.lerpVectors(this.prevPosition, this.position, a);
    this._interpQuat.slerpQuaternions(this.prevQuaternion, this.quaternion, a);
    this._interpVel.lerpVectors(this.prevVelocity, this.velocity, a);

    return {
      position: this._interpPos,
      quaternion: this._interpQuat,
      velocity: this._interpVel
    };
  }
}
