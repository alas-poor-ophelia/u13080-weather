/**
 * C1 Body: a continuous clock with an exact rational period (docs/SESHAT-v0.md §2.2).
 *
 * Body phase is the continuous remainder of day / period + epoch, computed as
 * an integer remainder and ONE division, so it is exact up to that single
 * correctly rounded step and identical in every JS engine.
 */
import { approximate, frac, fromNumber, rational, SAFE, type Rational } from "./rational";

export class Body {
  /** period P/Q days and epoch phase E/F (E/F in [0, 1)) */
  private readonly P: number;
  private readonly Q: number;
  private readonly E: number;
  private readonly F: number;

  constructor(
    readonly period: Rational,
    readonly epoch: Rational,
  ) {
    if (period.n <= 0) throw new RangeError(`a body's period must be positive (got ${period.n}/${period.d})`);
    const e = frac(epoch);
    this.P = period.n;
    this.Q = period.d;
    this.E = e.n;
    this.F = e.d;
    // phaseAt multiplies (d mod P)·Q and adds r·F + E·P: every intermediate must stay a safe integer (V5)
    if (this.P * this.Q > SAFE || 2 * this.P * this.F > SAFE) throw new RangeError(`body ${period.n}/${period.d} with epoch ${e.n}/${e.d} is too fine for safe-integer phases`);
  }

  /** Phase in [0, 1) at day d: frac(d / period + epoch), exactly, then one division. */
  phaseAt(d: number): number {
    let m = d % this.P;
    if (m < 0) m += this.P;
    const r = (m * this.Q) % this.P; // d·Q mod P, i.e. frac(d / period) · P
    const den = this.P * this.F;
    return ((r * this.F + this.E * this.P) % den) / den;
  }
}

const bodies = new Map<string, Body | null>();

/** The body for a stored (period, epoch) pair, memoized by value; null when no body can represent it (e.g. a non-positive period). */
export function bodyFor(periodDays: number, epochPhase: number): Body | null {
  const key = `${periodDays}|${epochPhase}`;
  let b = bodies.get(key);
  if (b === undefined) {
    try {
      b = bodyFromNumbers(periodDays, epochPhase);
    } catch {
      b = null;
    }
    bodies.set(key, b);
  }
  return b;
}

/**
 * A body from the numbers a calendar stores (a period in days and an epoch
 * phase). Each is taken at its shortest decimal; if the pair would overflow
 * safe integers, the period and then the epoch are replaced by their best
 * approximations under caps that fit (V5: the AST records the result).
 */
export function bodyFromNumbers(periodDays: number, epochPhase: number): Body {
  let period = fromNumber(periodDays);
  let epoch = frac(fromNumber(epochPhase));
  if (period.n * period.d > SAFE) {
    // P ≈ p·Q, so P·Q ≈ p·Q² must stay under SAFE
    period = approximate(periodDays, Math.max(1, Math.floor(Math.sqrt(SAFE / Math.max(periodDays, 1)) / 2)));
  }
  if (2 * period.n * epoch.d > SAFE) epoch = frac(approximate(epochPhase - Math.floor(epochPhase), Math.max(1, Math.floor(SAFE / (2 * period.n)))));
  return new Body(period, rational(epoch.n, epoch.d));
}
