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

/** The base in integers. Assumes a validated, resolved unit (safe-integer rationals, positive period; resolve.ts). */
export function linearBase(u: CycleRule): LinearBase {
  if (!u.crossing) return { a: u.length, c: u.anchor, L: 1 };
  const x = u.crossing;
  if (x.body !== undefined) throw new RangeError(`a crossing following body "${x.body.id}" must be resolved before it is read (resolve.ts)`);
  const { period: p, at } = x;
  const L = lcm(p.d, at.d);
  // START=after (§16.4): ceil((k·a + c)/L) = floor((k·a + c + L − 1)/L); the resolve pass folds it into `at`
  return { a: p.n * (L / p.d), c: at.n * (L / at.d) + (x.start === "after" ? L - 1 : 0), L };
}

/** Which base a start rule has (§16.7 P5): the one exhaustive test for "is this unit constant". Reads stored or resolved ASTs. */
export function baseKind(u: CycleRule): "constant" | "crossing" | "body" {
  const x = u.crossing;
  if (x === undefined) return "constant";
  return x.body !== undefined ? "body" : "crossing";
}

/**
 * A cycle with a plain constant base: no crossing (literal or body), no gear
 * terms, no stages, no ledger. Its occurrences all have `length` days.
 */
export function isPlainConstant(u: CycleRule & { readonly ledger?: readonly unknown[]; readonly skips?: string }): u is CycleRule & { readonly anchor: number; readonly length: number } {
  return baseKind(u) === "constant" && !u.gears?.length && !u.stages?.length && !u.ledger?.length && !u.skips;
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
