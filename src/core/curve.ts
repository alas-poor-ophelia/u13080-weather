import type { Curve, Harmonic, Keyframe } from "./types";

const TAU = 2 * Math.PI;

/** Wrap a yearPhase into [0, 1). */
export function wrapPhase(t: number): number {
  const r = t - Math.floor(t);
  return r === 1 ? 0 : r;
}

export function isHarmonic(c: Curve): c is Harmonic {
  return typeof c === "object" && !Array.isArray(c);
}

export function isKeyframes(c: Curve): c is Keyframe[] {
  return Array.isArray(c);
}

/**
 * Evaluate a Curve at yearPhase t ∈ [0, 1). Keyframes are interpolated with a
 * periodic monotone cubic (Fritsch–Carlson), so interpolation never overshoots
 * the keyframe values — a probability curve built from probabilities stays a
 * probability.
 */
export function evalCurve(c: Curve, t: number): number {
  if (typeof c === "number") return c;
  if (isHarmonic(c)) return c.mean + c.amplitude * Math.cos(TAU * (t - c.phase));
  return evalKeyframes(c, t);
}

/** Keyframes sorted by `at`, validated once per array identity (arrays are treated as immutable). */
const sortedCache = new WeakMap<Keyframe[], Keyframe[]>();
function sorted(kfs: Keyframe[]): Keyframe[] {
  const hit = sortedCache.get(kfs);
  if (hit) return hit;
  if (kfs.length === 0) throw new RangeError("evalCurve: empty keyframe array");
  const s = [...kfs].sort((a, b) => a.at - b.at);
  for (const k of s) {
    if (!(k.at >= 0 && k.at < 1)) throw new RangeError(`keyframe at=${k.at} must be in [0,1)`);
    if (!Number.isFinite(k.value)) throw new RangeError(`keyframe value must be finite`);
  }
  sortedCache.set(kfs, s);
  return s;
}

function evalKeyframes(kfs: Keyframe[], t: number): number {
  const s = sorted(kfs);
  const n = s.length;
  if (n === 1) return s[0]!.value;
  const x = wrapPhase(t);

  // Periodic extension: segment i runs from s[i] to s[(i+1)%n], with +1 wrap on `at`.
  const at = (i: number) => s[((i % n) + n) % n]!.at + Math.floor(i / n);
  const val = (i: number) => s[((i % n) + n) % n]!.value;

  // find segment i such that at(i) <= x' < at(i+1), where x' may be x or x+1
  let i = 0;
  let xp = x;
  if (x < s[0]!.at) xp = x + 1; // lands in the wrap-around segment from s[n-1] to s[0]+1
  while (!(at(i) <= xp && xp < at(i + 1))) {
    i++;
    if (i > 2 * n) throw new Error("evalKeyframes: segment search failed");
  }

  const h = (k: number) => at(k + 1) - at(k);
  const delta = (k: number) => (val(k + 1) - val(k)) / h(k);

  // Fritsch–Carlson tangents, periodic
  const tangent = (k: number): number => {
    const d0 = delta(k - 1);
    const d1 = delta(k);
    if (d0 * d1 <= 0) return 0;
    const w0 = 2 * h(k) + h(k - 1);
    const w1 = h(k) + 2 * h(k - 1);
    return (w0 + w1) / (w0 / d0 + w1 / d1);
  };

  const x0 = at(i);
  const hh = h(i);
  const s01 = (xp - x0) / hh;
  const y0 = val(i);
  const y1 = val(i + 1);
  const m0 = tangent(i) * hh;
  const m1 = tangent(i + 1) * hh;
  const s2 = s01 * s01;
  const s3 = s2 * s01;
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s01) * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * m1;
}

/** Gregorian month lengths; presets use yearPhase 0 = Jan 1 over a 365-day year. */
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MONTH_START = MONTH_DAYS.reduce<number[]>((a, d, i) => [...a, (a[i - 1] ?? 0) + (i === 0 ? 0 : MONTH_DAYS[i - 1]!)], []);
const YEAR_DAYS = 365;

/** yearPhase of the centre of calendar month m (0 = Jan). */
export function monthCentrePhase(m: number): number {
  return (MONTH_START[m]! + MONTH_DAYS[m]! / 2) / YEAR_DAYS;
}

/** Build 12 keyframes from monthly values at real calendar-month centres (Jan = 0, 365-day year). */
export function monthlyKeyframes(values: readonly number[]): Keyframe[] {
  if (values.length !== 12) throw new RangeError("monthlyKeyframes: need 12 values");
  return values.map((value, m) => ({ at: monthCentrePhase(m), value }));
}

/**
 * Monthly keyframes whose INTERPOLANT has the given calendar-month averages.
 * Placing a month's mean at its centre biases the month average near curve
 * extrema (convex at a minimum → interpolant averages above the keyframe),
 * and by ~0.5 °C per day of misalignment where the curve is steep.
 * A short fixed-point iteration removes the bias: v ← v + (target − monthAvg(v)).
 */
export function monthlyKeyframesBinMatched(targets: readonly number[], iterations: number = 12): Keyframe[] {
  if (targets.length !== 12) throw new RangeError("monthlyKeyframesBinMatched: need 12 values");
  let values = [...targets];
  for (let it = 0; it < iterations; it++) {
    const kf = monthlyKeyframes(values);
    const next = values.slice();
    for (let m = 0; m < 12; m++) {
      let avg = 0;
      for (let d = 0; d < MONTH_DAYS[m]!; d++) avg += evalCurve(kf, (MONTH_START[m]! + d + 0.5) / YEAR_DAYS);
      avg /= MONTH_DAYS[m]!;
      next[m] = values[m]! + (targets[m]! - avg);
    }
    values = next;
  }
  return monthlyKeyframes(values);
}

/** Sample a curve at N evenly spaced phases (used by the Köppen readout, N = 12). */
export function sampleCurve(c: Curve, n: number = 12): number[] {
  return Array.from({ length: n }, (_, i) => evalCurve(c, (i + 0.5) / n));
}

/** yearPhase at which the curve is minimal (coarse search, 1/365 resolution). */
export function argminPhase(c: Curve): number {
  let best = 0;
  let bestV = Infinity;
  for (let d = 0; d < 365; d++) {
    const t = (d + 0.5) / 365;
    const v = evalCurve(c, t);
    if (v < bestV) {
      bestV = v;
      best = t;
    }
  }
  return best;
}

/** Least-squares single-harmonic fit to a curve (diagnostic / Tier A use). */
export function fitHarmonic(c: Curve, n: number = 48): Harmonic {
  let sum = 0;
  let cs = 0;
  let sn = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const v = evalCurve(c, t);
    sum += v;
    cs += v * Math.cos(TAU * t);
    sn += v * Math.sin(TAU * t);
  }
  const mean = sum / n;
  const a = (2 / n) * cs;
  const b = (2 / n) * sn;
  const amplitude = Math.hypot(a, b);
  const phase = wrapPhase(Math.atan2(b, a) / TAU);
  return { mean, amplitude, phase };
}
