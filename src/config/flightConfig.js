/**
 * Centralized Flight Physics, World, AI, and Gameplay Configuration for SkyWard.
 * All physical constants and aerodynamic parameters are tuned to the real-world
 * technical specifications of the 15.3 kg fixed-wing interceptor UAV.
 */

export const FLIGHT_CONFIG = {
  // 1. Airframe & Mass Properties (Section 3)
  airframe: {
    name: 'SW-15 Interceptor UAV',
    type: 'Fixed-Wing Pusher Interceptor',
    totalMassKg: 15.3,          // Total takeoff mass including warhead
    warheadMassKg: 7.5,         // Heavy 7.5 kg payload (high pitch/yaw inertia)
    wingAreaM2: 0.56,           // Wing planform area S (m^2) -> 2.24m span x 0.25m mean chord
    wingSpanM: 2.24,            // Wingspan b (m)
    meanChordM: 0.25,           // Mean aerodynamic chord c_bar (m)
    aspectRatio: 8.96,          // b^2 / S
    // Principal moments of inertia (kg * m^2) in body frame (X: right, Y: up, Z: aft)
    // Heavy 7.5 kg payload near forward-center fuselage increases pitch (Ixx) & yaw (Iyy) inertia
    inertia: {
      pitch: 2.95,              // Ixx (pitch axis around right wing)
      yaw: 3.45,                // Iyy (yaw axis around vertical body)
      roll: 1.85                // Izz (roll axis along fuselage centerline)
    }
  },

  // 2. Speed & Altitude Envelope (Section 3)
  envelope: {
    stallSpeedKmh: 55.0,        // ~15.28 m/s
    stallSpeedMs: 15.28,
    minOperationalSpeedKmh: 70.0, // ~19.44 m/s
    cruiseSpeedKmh: 110.0,      // ~30.56 m/s
    cruiseSpeedMs: 30.56,
    maxSpeedKmh: 150.0,         // ~41.67 m/s
    maxSpeedMs: 41.67,
    neverExceedSpeedKmh: 195.0, // ~54.17 m/s (dive speed structural limit)
    operationalAltMinM: 300.0,
    operationalAltMaxM: 500.0,
    serviceCeilingMinM: 2000.0,
    serviceCeilingMaxM: 4500.0
  },

  // 3. Aerodynamic Coefficients (Section 4)
  // Calibrated so that at rho=1.225 kg/m^3, S=0.56 m^2, W = 15.3 * 9.80665 = 150.04 N:
  // - At V_stall = 15.28 m/s (55 km/h), q = 143.0 Pa -> CL_max = 150.04 / (143.0 * 0.56) = 1.873
  // - At V_cruise = 30.56 m/s (110 km/h), q = 572.0 Pa -> CL_cruise = 150.04 / (572.0 * 0.56) = 0.468
  aero: {
    CL0: 0.30,                  // Zero-AoA lift coefficient (cambered tactical wing airfoil)
    CLAlpha: 6.10,              // Lift slope per radian
    CLMax: 1.88,                // Peak lift coefficient right at stall (~55 km/h)
    CLMin: -1.10,               // Inverted peak negative lift coefficient
    alphaStallPosDeg: 14.8,     // Positive stall angle of attack (degrees)
    alphaStallNegDeg: -12.0,    // Negative stall angle of attack (degrees)
    postStallDropWidthDeg: 8.5, // Smoothness of stall transition (degrees)
    postStallLiftFactor: 0.82,  // Flat-plate post-stall lift factor

    // Drag polar: CD = CD0 + k * CL^2 + CD_beta * beta^2 + CD_stall
    CD0: 0.0285,                // Parasitic zero-lift drag coefficient (clean molded airframe)
    oswaldEfficiency: 0.81,     // Oswald span efficiency factor e
    inducedDragFactorK: 0.044,  // 1 / (pi * AR * e)
    CDStallMax: 1.05,           // Form drag at 90-degree flat-plate stall
    CDSideslip: 0.28,           // Extra drag due to sideslip angle beta

    // Side force coefficient
    CYBeta: -0.62,              // Restoring side force per radian of sideslip

    // Stability & damping derivatives
    pitchTrimAlphaRad: 0.028,   // Trim angle of attack for ~110 km/h cruise (~1.6 deg)
    CmAlpha: -0.95,             // Longitudinal static stability (restoring pitch moment)
    CmQ: -11.5,                 // Pitch rate damping derivative
    CmStallNoseDown: -0.65,     // Strong nose-down recovery moment when stalled

    ClBeta: -0.14,              // Dihedral roll stability effect
    ClP: -5.8,                  // Roll rate aerodynamic damping
    ClR: 0.16,                  // Roll moment due to yaw rate (proverse lift differential)

    CnBeta: 0.26,               // Weathercock directional yaw stability
    CnR: -3.6,                  // Yaw rate damping derivative
    CnP: -0.045,                // Adverse yaw from roll rate

    // Control surface authority (torques scaled by dynamic pressure factor)
    elevatorAuthority: 2.35,    // Pitch moment capability (scales with q_bar)
    aileronAuthority: 3.8,      // Roll moment capability
    rudderAuthority: 1.75,      // Yaw moment capability
    bankTurnCoordFactor: 0.72,  // Natural coordinated turn yaw rate coupling: g/V * tan(phi)
    maxBankAngleDeg: 60.0,      // FBWA bank angle limit (degrees) for predictable turn holding

    // Control surface actuator smoothing (servo response speed in 1/s)
    servoRatePitch: 11.0,
    servoRateRoll: 14.0,
    servoRateYaw: 10.0,
    servoRateThrottle: 4.5,

    // Reference speed for control authority scaling
    controlRefSpeedMs: 28.0,
    minControlEffectiveness: 0.10, // Reduced controllability at very low airspeed
    maxControlEffectiveness: 1.55,

    // Angular rate soft safety limits (rad/s)
    maxRollRateRad: 3.2,        // ~183 deg/s (reflects 15.3 kg mass inertia)
    maxPitchRateRad: 1.85,      // ~106 deg/s (heavy 7.5 kg payload dampens rapid pitch snaps)
    maxYawRateRad: 1.15         // ~66 deg/s
  },

  // 4. Propulsion & Battery System (Section 3)
  propulsion: {
    // Calibrated so 100% throttle at sea level equilibrates drag at V_max = 150 km/h (41.67 m/s)
    // and ~58% throttle cruises level at 110 km/h (30.56 m/s)
    maxStaticThrustN: 58.0,     // Twin brushless pusher static thrust (N)
    propPitchSpeedMs: 56.5,     // Effective propeller pitch efflux speed (m/s)
    maxRpm: 11800,
    idleRpm: 950,

    // 6S Li-Ion High-Density Tactical Battery Pack (70 minutes nominal endurance at cruise)
    batteryCells: 6,
    voltageFull: 25.2,          // 4.20V per cell
    voltageNominal: 22.2,       // 3.70V per cell
    voltageCutoff: 18.0,        // 3.00V per cell
    capacityMah: 28000,         // 28,000 mAh (28 Ah) 6S Li-Ion pack
    nominalEnduranceMinutes: 70,// 60-80 minutes cruise endurance
    avionicsBaseCurrentA: 1.4,  // OSD, VTX, flight controller, gimbal draw
    cruiseCurrentA: 22.5,       // ~60-80 min endurance at cruise throttle
    maxThrottleCurrentA: 68.0,  // Accelerated battery drain at 100% throttle!
    internalResistanceOhm: 0.028 // Causes realistic voltage sag under full throttle load
  },

  // 5. Atmosphere & Physics Constants
  environment: {
    gravity: 9.80665,           // m/s^2
    seaLevelDensity: 1.225,     // kg/m^3 (ISA sea level)
    fixedTimeStep: 1 / 120,     // 120 Hz fixed physics step (0.008333 s)
    maxSubSteps: 10             // Clamped accumulator steps on focus loss
  },

  // 6. Player Initial Spawn State
  spawn: {
    x: 0,
    altitudeAboveGroundM: 360,  // Spawns in operational altitude band (300-500 m)
    z: 950,
    headingDeg: 0,              // Facing North (-Z)
    initialSpeedKmh: 110.0,     // Spawns in stable cruise flight (110 km/h)
    initialThrottle: 0.58       // Cruise throttle setting
  },

  // 7. Enemy Reconnaissance UAV & Interception Parameters (Sections 9 & 10)
  interception: {
    enemySpeedKmhMin: 82.0,
    enemySpeedKmhMax: 102.0,
    enemyAltMinM: 310.0,
    enemyAltMaxM: 490.0,
    enemyMinTerrainClearanceM: 120.0,
    worldPlayableRadiusM: 6500.0,
    routeWaypointCount: 8,

    // Proximity & Detonation radii (meters)
    optimalKillRadiusM: 28.0,   // Direct lethal interception radius
    damageBlastRadiusM: 55.0,   // Partial damage / proximity shockwave radius
    kineticImpactRadiusM: 5.5,  // Direct airframe collision distance
    autoArmDistanceM: 160.0     // Distance at which warhead auto-arms (can also manually arm)
  },

  // 8. World & Quality Presets (Sections 8 & 12)
  world: {
    chunkSizeM: 1200,           // Size of each terrain chunk (m)
    waterLevelM: 12.0,          // River/lake water surface elevation
    maxTerrainHeightM: 420.0,   // Highest mountain ridge elevation
    defaultSeed: 20261022,
    qualityPresets: {
      Low: {
        pixelRatio: 1.0,
        shadows: false,
        shadowMapSize: 512,
        ringRadiusChunks: [1, 2, 4],
        treeCount: 1500,
        buildingCount: 220,
        viewDistanceM: 9000
      },
      Medium: {
        pixelRatio: Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1.5),
        shadows: true,
        shadowMapSize: 1024,
        ringRadiusChunks: [2, 3, 5],
        treeCount: 3800,
        buildingCount: 450,
        viewDistanceM: 13000
      },
      High: {
        pixelRatio: Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2.0),
        shadows: true,
        shadowMapSize: 2048,
        ringRadiusChunks: [2, 4, 7],
        treeCount: 6500,
        buildingCount: 700,
        viewDistanceM: 16500
      }
    }
  }
};
