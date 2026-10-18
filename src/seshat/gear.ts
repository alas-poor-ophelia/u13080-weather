/**
 * C3 Gear: an O(1) integer count over a unit's occurrence indices
 * (docs/SESHAT-v0.md §2.4), built from interval sets with include/exclude or
 * from a position table. Gregorian leap years are intervals (+4, −100, +400);
 * tabular Islamic and Metonic leap years are positions in a 30- or 19-cycle.
 *
 * Indices are integers well inside ±2^52 (V5), where Math.floor(a / b) is
 * exact for integers: the quotient would have to sit within one ulp below an
 * integer, which needs |a| > 2^53.
 */

export type GearAst =
  | {
      readonly id: string;
      /** the unit whose occurrence index this gear reads */
      readonly on: string;
      readonly kind: "intervals";
      /** index n matches when Σ sign·[n ≡ offset mod every] is 1; the validator checks it is always 0 or 1 */
      readonly terms: ReadonlyArray<{ readonly every: number; readonly offset?: number; readonly sign: 1 | -1 }>;
    }
  | {
      readonly id: string;
      readonly on: string;
      readonly kind: "positions";
      readonly period: number;
      /** index n matches when (n − offset) mod period is listed */
      readonly positions: readonly number[];
      /** shifts the table, as an interval's offset does: a calendar whose years count from 1 has index n = year − 1, so offset −1 */
      readonly offset?: number;
    };

export function mod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r + 0; // + 0 folds −0
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function ceilDiv(a: number, b: number): number {
  return -Math.floor(-a / b);
}

/** Whether occurrence index n matches the gear. */
export function gearMatches(g: GearAst, n: number): boolean {
  if (g.kind === "positions") return g.positions.includes(mod(n - (g.offset ?? 0), g.period));
  let s = 0;
  for (const t of g.terms) if (mod(n - (t.offset ?? 0), t.every) === 0) s += t.sign;
  return s === 1;
}

/**
 * Matches among indices [0, n) for n ≥ 0, and minus the matches among [n, 0)
 * for n < 0, so that matches in [a, b) is always below(b) − below(a).
 */
export function gearBelow(g: GearAst, n: number): number {
  if (g.kind === "positions") {
    const o = g.offset ?? 0;
    return residuesBelow(g, n - o) - residuesBelow(g, -o);
  }
  let c = 0;
  for (const t of g.terms) {
    const o = t.offset ?? 0;
    c += t.sign * (ceilDiv(n - o, t.every) - ceilDiv(-o, t.every));
  }
  return c;
}

/** Integers k in [0, m) (minus those in [m, 0) for m < 0) whose residue mod the period is listed. */
function residuesBelow(g: GearAst & { kind: "positions" }, m: number): number {
  const r = mod(m, g.period);
  let partial = 0;
  for (const q of g.positions) if (q < r) partial++;
  return floorDiv(m, g.period) * g.positions.length + partial;
}

/** The long-run fraction of indices that match. */
export function gearDensity(g: GearAst): number {
  if (g.kind === "positions") return g.positions.length / g.period;
  let d = 0;
  for (const t of g.terms) d += t.sign / t.every;
  return d;
}

/**
 * A bound on |gearBelow(n) − density·n| over every n. A table count strays
 * under its size from its mean share, twice over with the offset's term; each
 * interval term strays under one per ceiling, two ceilings a term.
 */
export function gearDeviation(g: GearAst): number {
  return g.kind === "positions" ? 2 * g.positions.length : 2 * g.terms.length;
}

/** The gear's period: the lcm of its intervals, or its table period. */
export function gearPeriod(g: GearAst): number {
  if (g.kind === "positions") return g.period;
  let p = 1;
  for (const t of g.terms) p = lcm(p, t.every);
  return p;
}

export function lcm(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return (a / x) * b;
}
