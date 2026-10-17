/**
 * Exact rationals over safe integers (docs/SESHAT-v0.md §2.2, §5 V5, §6).
 *
 * Seshat keeps periods and epochs exact so a phase is one integer remainder
 * and one correctly rounded division: no float drift, no engine-dependent
 * ulps. Plain numbers, never BigInt: every value stays within
 * Number.MAX_SAFE_INTEGER, and anything that would not fit is replaced by its
 * best continued-fraction approximation under a cap.
 */

export interface Rational {
  /** numerator, a safe integer */
  readonly n: number;
  /** denominator, a positive safe integer; n/d is in lowest terms */
  readonly d: number;
}

export const SAFE = Number.MAX_SAFE_INTEGER;

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** n/d in lowest terms with a positive denominator. Throws unless both are safe integers and d ≠ 0. */
export function rational(n: number, d = 1): Rational {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d === 0) throw new RangeError(`not a rational: ${n}/${d}`);
  const g = gcd(n, d) || 1;
  const s = d < 0 ? -1 : 1;
  return { n: (s * n) / g, d: (s * d) / g };
}

export function toNumber(r: Rational): number {
  return r.n / r.d;
}

/**
 * The value a person typed, exactly: the shortest round-trip decimal of `x`
 * (what `String(x)` prints, so 29.53 is 2953/100, not the binary double's
 * 2^-48 fraction). A decimal whose numerator or denominator would not be a
 * safe integer falls back to `approximate(x, maxDen)`.
 */
export function fromNumber(x: number, maxDen = 1e9): Rational {
  if (!Number.isFinite(x)) throw new RangeError(`not a finite number: ${x}`);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
  if (!m) throw new RangeError(`unexpected number format: ${String(x)}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  const digits = Number(int! + frac);
  const pow = Number(exp) - frac.length;
  const n = (sign ? -1 : 1) * (pow >= 0 ? digits * 10 ** pow : digits);
  const d = pow >= 0 ? 1 : 10 ** -pow;
  if (Number.isSafeInteger(n) && Number.isSafeInteger(d) && d <= maxDen) return rational(n, d);
  return approximate(x, maxDen);
}

/** Best rational approximation of `x` with denominator ≤ maxDen (continued-fraction convergents). */
export function approximate(x: number, maxDen: number): Rational {
  if (!Number.isFinite(x) || Math.abs(x) > SAFE) throw new RangeError(`no safe rational for ${x}`);
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = x;
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(v);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDen || !Number.isSafeInteger(h2)) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    const f = v - a;
    if (f === 0) break;
    v = 1 / f;
  }
  return rational(h1, k1);
}

/** r reduced into [0, 1): the fractional part, exactly. */
export function frac(r: Rational): Rational {
  return rational(((r.n % r.d) + r.d) % r.d, r.d);
}
