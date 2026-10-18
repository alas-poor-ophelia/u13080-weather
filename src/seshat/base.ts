/**
 * The linear base of a unit that never resets (docs/SESHAT-v0.md §2.3.1–2.3.2):
 * occurrence k starts on floor((k·a + c) / L) for integers a, c and L > 0,
 * before any gear adds. A constant length is a = length, c = anchor, L = 1; a
 * crossing base puts its rational period and the instant of crossing 0 over
 * one common denominator L.
 *
 * Shared by the validator (V5, slot sums) and the engine, so the two can never
 * read a base differently.
 */
import type { CycleRule } from "./ast";
import { ceilDiv, floorDiv, lcm } from "./gear";

export interface LinearBase {
  readonly a: number;
  readonly c: number;
  readonly L: number;
}

/** The base in integers. Assumes a validated unit (safe-integer rationals, positive period). */
export function linearBase(u: CycleRule): LinearBase {
  if (!u.crossing) return { a: u.length, c: u.anchor, L: 1 };
  const { period: p, at } = u.crossing;
  const L = lcm(p.d, at.d);
  return { a: p.n * (L / p.d), c: at.n * (L / at.d), L };
}

/** Day on which occurrence k of the base starts. */
export function baseStart(b: LinearBase, k: number): number {
  return floorDiv(k * b.a + b.c, b.L);
}

/** The occurrence of the base that holds day d, exactly: start_k ≤ d iff k·a + c < (d + 1)·L. */
export function baseIndexAt(b: LinearBase, d: number): number {
  return ceilDiv((d + 1) * b.L - b.c, b.a) - 1;
}

/** The lengths a base occurrence can have, ascending: floor and ceiling of a / L (one value when it divides). */
export function baseLengths(b: LinearBase): number[] {
  const lo = floorDiv(b.a, b.L);
  return b.a % b.L === 0 ? [lo] : [lo, lo + 1];
}
