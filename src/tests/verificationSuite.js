import { FLIGHT_CONFIG } from '../config/flightConfig.js';
import { FlightPhysics } from '../physics/FlightPhysics.js';
import { EnemyReconAI } from '../ai/EnemyReconAI.js';
import {
  computeAirDensityISA,
  applyDeadzoneAndExpo,
  normalizeRCThrottle,
  DEG2RAD
} from '../utils/math.js';
import { TerrainNoise2D } from '../utils/prng.js';

/**
 * Automated Verification & Physics Test Suite for SkyWard.
 * Executes deterministic tests on the 6-DOF flight model, stall/cruise/max speeds,
 * altitude density decay, battery discharge, RC AETR math, and enemy AI route generation.
 */
export function runVerificationSuite() {
  const results = [];

  const record = (name, passed, details) => {
    results.push({ name, passed: Boolean(passed), details });
  };

  // Test 1: Airframe Mass & ISA Air Density Reduction at Service Ceiling
  {
    const mass = FLIGHT_CONFIG.airframe.totalMassKg;
    const warhead = FLIGHT_CONFIG.airframe.warheadMassKg;
    const rho0 = computeAirDensityISA(0);
    const rho400 = computeAirDensityISA(400);
    const rho3500 = computeAirDensityISA(3500);

    const passed =
      mass === 15.3 &&
      warhead === 7.5 &&
      Math.abs(rho0 - 1.225) < 0.001 &&
      rho400 < rho0 &&
      rho3500 < 0.68;

    record(
      '1. Airframe Mass (15.3kg / 7.5kg Warhead) & Altitude Air Density Decay',
      passed,
      `mass=${mass}kg, warhead=${warhead}kg, rho(0m)=${rho0.toFixed(3)}, rho(400m)=${rho400.toFixed(3)}, rho(3500m)=${rho3500.toFixed(3)} kg/m^3`
    );
  }

  // Test 2: Stall Speed (~55 km/h = 15.28 m/s) & Post-Stall Lift Loss
  {
    const phys = new FlightPhysics(FLIGHT_CONFIG);
    const weightN = FLIGHT_CONFIG.airframe.totalMassKg * FLIGHT_CONFIG.environment.gravity; // 150.04 N
    const stallSpeedMs = 55.0 / 3.6; // 15.278 m/s
    const qStall = 0.5 * 1.225 * stallSpeedMs * stallSpeedMs;

    const peakAero = phys.computeLiftCoefficient(14.5 * DEG2RAD);
    const postStallAero = phys.computeLiftCoefficient(24.0 * DEG2RAD);
    const maxLiftAt55Kmh = qStall * FLIGHT_CONFIG.airframe.wingAreaM2 * peakAero.cl;

    const cdPreStall = phys.computeDragCoefficient(4.0 * DEG2RAD, 0, 0.5, 0);
    const cdPostStall = phys.computeDragCoefficient(24.0 * DEG2RAD, 0, postStallAero.cl, postStallAero.stallFactor);

    const passed =
      Math.abs(maxLiftAt55Kmh - weightN) < 4.0 &&
      postStallAero.cl < peakAero.cl &&
      postStallAero.stallFactor > 0.8 &&
      cdPostStall > cdPreStall * 4.0;

    record(
      '2. Stall Speed (~55 km/h) Max Lift Equilibrium & Post-Stall Lift Drop',
      passed,
      `Weight=${weightN.toFixed(1)}N, MaxLift@55km/h=${maxLiftAt55Kmh.toFixed(1)}N, CL_peak=${peakAero.cl.toFixed(2)}, CL_24deg=${postStallAero.cl.toFixed(2)}, CD_24deg=${cdPostStall.toFixed(3)}`
    );
  }

  // Test 3: 6-DOF Fixed-Timestep Hands-Off Level Cruise Stability (~110 km/h)
  {
    const phys = new FlightPhysics(FLIGHT_CONFIG);
    phys.reset(() => 20.0);

    const dt = 1 / 120;
    // Simulate 15 seconds (1,800 steps) completely hands-off at 58% cruise throttle
    for (let i = 0; i < 1800; i++) {
      phys.step(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.58 }, () => 20.0);
    }

    const finalSpeedKmh = phys.telemetry.airspeedKmh;
    const altChange = Math.abs(phys.position.y - 380.0);
    const isFiniteState =
      Number.isFinite(phys.position.x) &&
      Number.isFinite(phys.position.y) &&
      Number.isFinite(phys.position.z) &&
      Number.isFinite(phys.quaternion.w);

    const passed =
      isFiniteState &&
      finalSpeedKmh >= 102.0 &&
      finalSpeedKmh <= 118.0 &&
      altChange < 15.0 &&
      !phys.telemetry.crashed;

    record(
      '3. 6-DOF Hands-Off Cruise Flight Stability (1,800 Steps @ 120Hz, ~110 km/h)',
      passed,
      `FinalSpeed=${finalSpeedKmh.toFixed(1)} km/h, Alt=${phys.position.y.toFixed(1)}m (dAlt=${altChange.toFixed(1)}m), AoA=${phys.telemetry.alphaDeg.toFixed(2)}deg`
    );
  }

  // Test 4: Max Speed (~150 km/h) Thrust Balance & 60-80 Min Battery Simulation
  {
    const phys = new FlightPhysics(FLIGHT_CONFIG);
    const vMaxMs = 150.0 / 3.6; // 41.67 m/s
    const qMax = 0.5 * 1.225 * vMaxMs * vMaxMs;
    const weightN = FLIGHT_CONFIG.airframe.totalMassKg * FLIGHT_CONFIG.environment.gravity;
    const clAtMax = weightN / (qMax * FLIGHT_CONFIG.airframe.wingAreaM2);
    const cdAtMax = phys.computeDragCoefficient(0.01, 0, clAtMax, 0);
    const dragAt150Kmh = qMax * FLIGHT_CONFIG.airframe.wingAreaM2 * cdAtMax;
    const thrustAt150Kmh = phys.computeThrust(1.0, vMaxMs, 1.225, false);

    // Battery endurance check at 58% cruise throttle vs 100% full throttle
    phys.reset(() => 0);
    phys.step(1.0, { pitch: 0, roll: 0, yaw: 0, throttle: 0.58 }, () => 0);
    const cruiseEnduranceMin = phys.telemetry.remainingMinutes;
    const cruiseCurrentA = phys.telemetry.currentDrawA;

    phys.reset(() => 0);
    phys.actuators.throttle = 1.0;
    phys.step(1.0, { pitch: 0, roll: 0, yaw: 0, throttle: 1.0 }, () => 0);
    const fullThrottleEnduranceMin = phys.telemetry.remainingMinutes;
    const fullCurrentA = phys.telemetry.currentDrawA;

    const passed =
      Math.abs(thrustAt150Kmh - dragAt150Kmh) < 2.5 &&
      cruiseEnduranceMin >= 60.0 &&
      cruiseEnduranceMin <= 85.0 &&
      fullCurrentA > cruiseCurrentA * 2.5 &&
      fullThrottleEnduranceMin < cruiseEnduranceMin * 0.45;

    record(
      '4. Max Speed (150 km/h) Equilibrium & Battery Drain (60-80m Cruise vs 100% Accel)',
      passed,
      `Thrust@150km/h=${thrustAt150Kmh.toFixed(1)}N vs Drag=${dragAt150Kmh.toFixed(1)}N | Cruise=${cruiseCurrentA.toFixed(1)}A (${cruiseEnduranceMin.toFixed(1)}m) vs 100%=${fullCurrentA.toFixed(1)}A (${fullThrottleEnduranceMin.toFixed(1)}m)`
    );
  }

  // Test 5: RC Transmitter AETR Throttle Normalization, Deadzone & Expo Curve
  {
    const tMin = normalizeRCThrottle(-1.0, false);
    const tMid = normalizeRCThrottle(0.0, false);
    const tMax = normalizeRCThrottle(1.0, false);
    const tInv = normalizeRCThrottle(-1.0, true);

    const dzZero = applyDeadzoneAndExpo(0.015, 0.02, 0.30, false);
    const halfStick = applyDeadzoneAndExpo(0.50, 0.02, 0.30, false);
    const fullStick = applyDeadzoneAndExpo(1.0, 0.02, 0.30, false);

    const passed =
      tMin === 0.0 &&
      Math.abs(tMid - 0.5) < 0.001 &&
      tMax === 1.0 &&
      tInv === 1.0 &&
      dzZero === 0.0 &&
      halfStick > 0.30 &&
      halfStick < 0.48 &&
      Math.abs(fullStick - 1.0) < 0.001;

    record(
      '5. RC Transmitter AETR Normalization, Deadzone (0.02) & Expo (0.30)',
      passed,
      `Throttle[-1,0,+1]->[${tMin},${tMid.toFixed(2)},${tMax}], DZ(0.015)=${dzZero}, Expo(0.5)=${halfStick.toFixed(3)}`
    );
  }

  // Test 6: Seeded Procedural Enemy Recon Route Reproducibility & Terrain Clearance
  {
    const noise = new TerrainNoise2D(20261022);
    const mockTerrain = (x, z) => 30.0 + noise.fbm(x * 0.0005, z * 0.0005, 3) * 45.0;

    const ai1 = new EnemyReconAI(FLIGHT_CONFIG);
    const ai2 = new EnemyReconAI(FLIGHT_CONFIG);
    const ai3 = new EnemyReconAI(FLIGHT_CONFIG);

    ai1.initScenario(20261022, mockTerrain);
    ai2.initScenario(20261022, mockTerrain);
    ai3.initScenario(99112233, mockTerrain);

    const sameSeedMatch =
      ai1.waypoints[0].distanceTo(ai2.waypoints[0]) < 1e-4 &&
      ai1.waypoints[3].distanceTo(ai2.waypoints[3]) < 1e-4;
    const diffSeedDistinct = ai1.waypoints[1].distanceTo(ai3.waypoints[1]) > 50.0;

    let allClearTerrain = true;
    for (const wp of ai1.waypoints) {
      const g = mockTerrain(wp.x, wp.z);
      if (wp.y < g + 100.0 || Math.abs(wp.x) > FLIGHT_CONFIG.interception.worldPlayableRadiusM) {
        allClearTerrain = false;
      }
    }

    const passed = sameSeedMatch && diffSeedDistinct && allClearTerrain;
    record(
      '6. Seeded Procedural Enemy UAV Route Reproducibility & Terrain Safety',
      passed,
      `SameSeedMatch=${sameSeedMatch}, DiffSeedDistinct=${diffSeedDistinct}, TerrainClearanceOK=${allClearTerrain}, Pattern=${ai1.patternName}`
    );
  }

  // Test 7: Coordinated Banked Turn, Climb/Dive Response & Wing-Leveling Recovery
  {
    const phys = new FlightPhysics(FLIGHT_CONFIG);
    phys.reset(() => 20.0);
    const dt = 1 / 120;

    // 1. Bank right (roll = +0.65) for 2.0 seconds -> should roll right (rollDeg > 15) and turn heading right (headingDeg > 10)
    for (let i = 0; i < 240; i++) {
      phys.step(dt, { pitch: 0.1, roll: 0.65, yaw: 0, throttle: 0.65 }, () => 20.0);
    }
    const bankedRollDeg = phys.telemetry.rollDeg;
    const turnedHeadingDeg = phys.telemetry.headingDeg;

    // 2. Release stick (roll = 0, pitch = 0) for 4.0 seconds -> wings should level back toward 0 deg
    for (let i = 0; i < 480; i++) {
      phys.step(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.58 }, () => 20.0);
    }
    const recoveredRollDeg = phys.telemetry.rollDeg;

    // 3. Climb command (pitch = +0.7, throttle = 1.0) for 2.0 seconds -> verticalSpeedMs > 3.0 m/s
    for (let i = 0; i < 240; i++) {
      phys.step(dt, { pitch: 0.7, roll: 0, yaw: 0, throttle: 1.0 }, () => 20.0);
    }
    const climbVsiMs = phys.telemetry.verticalSpeedMs;

    const passed =
      bankedRollDeg > 18.0 &&
      turnedHeadingDeg > 8.0 &&
      turnedHeadingDeg < 180.0 &&
      Math.abs(recoveredRollDeg) < bankedRollDeg * 0.45 &&
      climbVsiMs > 3.0 &&
      !phys.telemetry.crashed;

    record(
      '7. Coordinated Banked Turn, Wing-Leveling Stability & Climb Authority',
      passed,
      `BankRoll=${bankedRollDeg.toFixed(1)}deg, Heading=${turnedHeadingDeg.toFixed(1)}deg, RecoveredRoll=${recoveredRollDeg.toFixed(1)}deg, ClimbVSI=+${climbVsiMs.toFixed(1)}m/s`
    );
  }

  return results;
}
