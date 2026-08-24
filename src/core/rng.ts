/**
 * Wadjet frozen RNG substrate.
 *
 * THIS FILE IS FROZEN. Its behaviour is part of the plugin's public promise
 * ("same seed → same weather, forever, on every machine"). Any change to the
 * numeric output of any exported function is a breaking change to every
 * existing world and MUST be shipped as a new RNG_VERSION with a new file,
 * never as an edit here. The golden-master suite (test/golden/) exists to
 * make accidental drift fail the build.
 *
 * Design (DESIGN-v1.md §5):
 *  - Every random draw is a pure function of a string key. No sequential
 *    stream exists anywhere; "yesterday" never influences today's noise.
 *  - A key is `seed ␟ zoneId ␟ dayOrdinal ␟ drawName`, and a DrawStream
 *    appends a draw index for algorithms that need several uniforms.
 *  - No dependencies. Only integer ops (Math.imul, >>>), which are exact in
 *    every JS engine, feed the hash. Floating point enters only at the final
 *    uniform → sample step.
 *
 * Cross-engine note: Math.log / Math.sqrt / Math.cos may differ in the last
 * ulp between engines. Hash and uniform outputs are integer-exact; sampled
 * values (normal, gamma) are compared in golden tests at 1e-12 relative
 * tolerance, and all user-visible report fields are rounded (0.1 °C, 0.1 mm)
 * so ulp noise cannot surface except at a rounding boundary.
 */

export const RNG_VERSION = "wadjet-rng/1" as const;

/** Unit separator — cannot appear in any sane seed/zone id, keeps keys unambiguous. */
const SEP = String.fromCharCode(0x1f); // U+001F unit separator

// ---------------------------------------------------------------------------
// MurmurHash3 x86_32 over UTF-16 code units (two code units per 32-bit block).
// Standard constants; the "body" iterates code units rather than bytes, which
// is a deliberate, documented deviation that keeps us independent of any
// TextEncoder behaviour.
// ---------------------------------------------------------------------------
export function hash32(key: string, seed: number = 0): number {
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const len = key.length;
  const nblocks = len >>> 1;

  for (let i = 0; i < nblocks; i++) {
    let k = (key.charCodeAt(2 * i) | (key.charCodeAt(2 * i + 1) << 16)) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }

  if (len & 1) {
    let k = key.charCodeAt(len - 1) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }

  // length in code units, as the tail mix
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEED_HI = 0x9e3779b1; // golden-ratio derived, arbitrary but frozen
const SEED_LO = 0x85ebca77;

/** 53-bit integer in [0, 2^53) from two independent 32-bit hashes. Exact in IEEE doubles. */
export function hash53(key: string): number {
  const hi = hash32(key, SEED_HI) >>> 11; // 21 bits
  const lo = hash32(key, SEED_LO); // 32 bits
  return hi * 4294967296 + lo; // hi * 2^32 + lo  <  2^53
}

const TWO_POW_53 = 9007199254740992;

/** Uniform in [0, 1) with full 53-bit resolution. */
export function uniform(key: string): number {
  return hash53(key) / TWO_POW_53;
}

/** Build the canonical key for a draw. `day` must be an integer. */
export function drawKey(seed: string, zoneId: string, day: number, name: string): string {
  if (!Number.isInteger(day)) throw new RangeError(`drawKey: day must be an integer, got ${day}`);
  return `${seed}${SEP}${zoneId}${SEP}${day}${SEP}${name}`;
}

/**
 * An indexed sequence of uniforms under one key. Algorithms that need more
 * than one uniform (Box–Muller, Marsaglia–Tsang rejection) consume from here.
 * Two streams with the same key are identical; index i of one never depends
 * on how many draws happened elsewhere.
 */
export class DrawStream {
  private i = 0;
  constructor(readonly key: string) {}

  /** Uniform in [0, 1). */
  next(): number {
    return uniform(`${this.key}${SEP}${this.i++}`);
  }

  /** Uniform in (0, 1] — safe for log(). */
  nextOpen(): number {
    return 1 - this.next();
  }

  /** How many uniforms have been consumed (diagnostics / golden tests). */
  get consumed(): number {
    return this.i;
  }
}

// ---------------------------------------------------------------------------
// Samplers. Each is a deterministic function of the stream's key and the
// order of calls. Never reorder draws inside these.
// ---------------------------------------------------------------------------

/** Standard normal via Box–Muller (one output per two uniforms; the second is discarded). */
export function normal(s: DrawStream): number {
  const u1 = s.nextOpen();
  const u2 = s.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Gamma(shape, scale) via Marsaglia & Tsang (2000). For shape < 1 uses the
 * standard boost: Gamma(shape+1) · U^(1/shape).
 */
export function gamma(s: DrawStream, shape: number, scale: number = 1): number {
  if (!(shape > 0) || !(scale > 0)) throw new RangeError(`gamma: shape and scale must be > 0 (got ${shape}, ${scale})`);
  if (shape < 1) {
    const g = gamma(s, shape + 1, 1);
    const u = s.nextOpen();
    return g * Math.pow(u, 1 / shape) * scale;
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(s);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = s.nextOpen();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v * scale;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Bernoulli(p). p is clamped to [0, 1]. */
export function bernoulli(s: DrawStream, p: number): boolean {
  const q = p <= 0 ? 0 : p >= 1 ? 1 : p;
  return s.next() < q;
}

/**
 * Geometric duration in days, ≥ 1, with the given mean (mean ≥ 1).
 * P(k) = (1-p)^(k-1) p with p = 1/mean. Inverse-CDF on one uniform.
 */
export function geometricDuration(s: DrawStream, meanDays: number): number {
  if (!(meanDays >= 1)) throw new RangeError(`geometricDuration: mean must be ≥ 1 (got ${meanDays})`);
  if (meanDays === 1) {
    s.next(); // consume for stream-shape stability
    return 1;
  }
  const p = 1 / meanDays;
  const u = s.nextOpen();
  return 1 + Math.floor(Math.log(u) / Math.log(1 - p));
}

/** Pick an index by weight. Weights need not sum to 1; non-positive weights are ignored. */
export function weightedIndex(s: DrawStream, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) if (w > 0) total += w;
  if (total <= 0) throw new RangeError("weightedIndex: no positive weights");
  let r = s.next() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    if (r < w) return i;
    r -= w;
  }
  // floating-point edge: return last positive index
  for (let i = weights.length - 1; i >= 0; i--) if ((weights[i] ?? 0) > 0) return i;
  return 0;
}
