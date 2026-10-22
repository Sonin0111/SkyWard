/**
 * Deterministic Seeded Pseudo-Random Number Generator (Mulberry32) and
 * Fast 2D Gradient/Simplex Noise for procedural terrain and target route generation.
 */

export class SeededRandom {
  /**
   * @param {number|string} seed - Numeric or string seed
   */
  constructor(seed = 20261022) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    if (typeof seed === 'string') {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      this.initialSeed = h >>> 0;
    } else {
      this.initialSeed = (Number(seed) || 20261022) >>> 0;
    }
    this.state = this.initialSeed || 1;
  }

  /**
   * Returns a uniform float in [0, 1)
   */
  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296.0;
  }

  /**
   * Returns a uniform float in [min, max)
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Returns an integer in [min, max] inclusive
   */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /**
   * Returns +1 or -1 randomly
   */
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
}

/**
 * Deterministic 2D Value-Gradient Noise for multi-octave terrain and biome synthesis.
 * Zero heap allocations during evaluation.
 */
export class TerrainNoise2D {
  constructor(seed = 20261022) {
    const rng = new SeededRandom(seed);
    this.perm = new Uint8Array(512);
    this.gradX = new Float32Array(256);
    this.gradY = new Float32Array(256);

    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      p[i] = i;
      const angle = (i / 256.0) * Math.PI * 2.0;
      this.gradX[i] = Math.cos(angle);
      this.gradY[i] = Math.sin(angle);
    }

    // Fisher-Yates shuffle with seeded RNG
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
    }
  }

  /**
   * 2D Perlin gradient noise in [-1, 1]
   */
  noise2D(x, y) {
    const xi0 = Math.floor(x);
    const yi0 = Math.floor(y);
    const xf = x - xi0;
    const yf = y - yi0;

    const X = xi0 & 255;
    const Y = yi0 & 255;

    // Quintic fade curve: 6t^5 - 15t^4 + 10t^3
    const u = xf * xf * xf * (xf * (xf * 6.0 - 15.0) + 10.0);
    const v = yf * yf * yf * (yf * (yf * 6.0 - 15.0) + 10.0);

    const perm = this.perm;
    const gx = this.gradX;
    const gy = this.gradY;

    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];

    const dotAA = gx[aa] * xf + gy[aa] * yf;
    const dotBA = gx[ba] * (xf - 1.0) + gy[ba] * yf;
    const dotAB = gx[ab] * xf + gy[ab] * (yf - 1.0);
    const dotBB = gx[bb] * (xf - 1.0) + gy[bb] * (yf - 1.0);

    const x1 = dotAA + u * (dotBA - dotAA);
    const x2 = dotAB + u * (dotBB - dotAB);

    return x1 + v * (x2 - x1);
  }

  /**
   * Multi-octave Fractal Brownian Motion (fBm) in [-1, 1]
   */
  fbm(x, y, octaves = 5, lacunarity = 2.05, gain = 0.48) {
    let sum = 0.0;
    let amp = 1.0;
    let freq = 1.0;
    let norm = 0.0;

    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }

    return sum / norm;
  }

  /**
   * Ridged multifractal noise in [0, 1] for hill crests and river valleys
   */
  ridged(x, y, octaves = 4, lacunarity = 2.1, gain = 0.5) {
    let sum = 0.0;
    let amp = 0.5;
    let freq = 1.0;
    let prev = 1.0;

    for (let i = 0; i < octaves; i++) {
      let n = 1.0 - Math.abs(this.noise2D(x * freq, y * freq));
      n = n * n;
      sum += n * amp * prev;
      prev = n;
      freq *= lacunarity;
      amp *= gain;
    }

    return sum;
  }
}
