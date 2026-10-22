/**
 * Mathematical utilities, aerodynamic atmosphere functions, and RC curve helpers.
 */

export const DEG2RAD = Math.PI / 180.0;
export const RAD2DEG = 180.0 / Math.PI;

export function clamp(val, min, max) {
  return val < min ? min : val > max ? max : val;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1.0 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

export function wrapAngleRad(angle) {
  let a = (angle + Math.PI) % (2.0 * Math.PI);
  if (a < 0) a += 2.0 * Math.PI;
  return a - Math.PI;
}

export function wrapHeadingDeg(deg) {
  let h = deg % 360.0;
  if (h < 0) h += 360.0;
  return h;
}

/**
 * Applies a small deadzone and cubic exponential (Expo) curve to an RC stick axis.
 * @param {number} raw - Raw axis input in [-1.0, +1.0]
 * @param {number} deadzone - Deadzone threshold (default 0.02)
 * @param {number} expo - Exponential factor in [0.0, 1.0] (default 0.30)
 * @param {boolean} invert - Whether to invert axis sign
 * @returns {number} Smoothed axis value in [-1.0, +1.0]
 */
export function applyDeadzoneAndExpo(raw, deadzone = 0.02, expo = 0.30, invert = false) {
  let val = clamp(Number.isFinite(raw) ? raw : 0.0, -1.0, 1.0);
  if (invert) val = -val;

  const absVal = Math.abs(val);
  if (absVal <= deadzone) {
    return 0.0;
  }

  const sign = val < 0 ? -1.0 : 1.0;
  const normalized = (absVal - deadzone) / Math.max(1e-5, 1.0 - deadzone);
  const x = clamp(normalized, 0.0, 1.0);
  const e = clamp(expo, 0.0, 0.95);

  const curved = (1.0 - e) * x + e * (x * x * x);
  return sign * curved;
}

/**
 * Normalizes an RC Throttle axis from standard [-1.0, +1.0] range to [0.0, 1.0] (0% - 100%).
 * @param {number} raw - Raw axis input in [-1.0, +1.0]
 * @param {boolean} invert - Whether to invert the throttle axis before normalization
 * @param {number} deadzone - End-stop deadzone (default 0.015)
 * @returns {number} Throttle in [0.0, 1.0]
 */
export function normalizeRCThrottle(raw, invert = false, deadzone = 0.015) {
  let val = clamp(Number.isFinite(raw) ? raw : -1.0, -1.0, 1.0);
  if (invert) val = -val;

  let norm = (val + 1.0) * 0.5;
  if (norm < deadzone) norm = 0.0;
  else if (norm > 1.0 - deadzone) norm = 1.0;
  else norm = (norm - deadzone) / (1.0 - 2.0 * deadzone);

  return clamp(norm, 0.0, 1.0);
}

/**
 * Computes air density rho(h) in kg/m^3 as a function of altitude MSL (meters).
 * Combines the International Standard Atmosphere (ISA) troposphere equation
 * with service-ceiling rarefaction between 2000 m and 4500 m so lift and propeller
 * efficiency drop convincingly near the UAV's 2000-4500 m service ceiling.
 * @param {number} altitudeM - Altitude above sea level in meters
 * @returns {number} Air density in kg/m^3
 */
export function computeAirDensityISA(altitudeM) {
  const h = clamp(altitudeM, -200.0, 10000.0);
  const rho0 = 1.225;

  // Standard ISA tropospheric density relation: rho = rho0 * (1 - L*h / T0)^(g*M/(R*L) - 1)
  const tempRatio = Math.max(0.1, 1.0 - 2.25577e-5 * Math.max(0.0, h));
  let rho = rho0 * Math.pow(tempRatio, 4.25588);

  // Additional thin-air ceiling penalty for small tactical propeller Reynolds numbers above 2000 m
  if (h > 2000.0) {
    const ceilingFactor = smoothstep(2000.0, 4600.0, h);
    rho *= (1.0 - 0.36 * ceilingFactor);
  }

  return Math.max(0.15, rho);
}
