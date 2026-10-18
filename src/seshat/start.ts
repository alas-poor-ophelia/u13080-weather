/**
 * The start rule of a unit that never resets (docs/SESHAT-v0.md §2.3.1): one
 * linear base, read at k or at a derived index, then its gear terms, then
 * each stage in order. Day from index is closed form; index from day is exact
 * for a bare base and otherwise an estimate from the mean corrected within the
 * V4 bound.
 *
 * Shared by the engine and the validator (which scans real occurrences when
 * stages make lengths depend on neighbouring years).
 */
import type { CycleRule, StageAst } from "./ast";
import { baseIndexAt, baseLengths, baseStart, linearBase, type LinearBase } from "./base";
import { floorDiv, gearBelow, gearDensity, gearDeviation, mod, type GearAst } from "./gear";

export interface StartRule {
  /** day on which occurrence k starts */
  start(k: number): number;
  /** the occurrence holding day d (a whole day within the validated range) */
  indexAt(d: number): number;
  /** the fewest days an occurrence can have, by the bounds below (V3) */
  readonly shortest: number;
  /** the most whole correction steps indexAt can take (V4); 0 when it is exact */
  readonly steps: number;
}

/** Most a stage can move a start, either way. */
export function stageReach(stage: StageAst): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const r of stage.rules) {
    up = Math.max(up, r.add);
    down = Math.max(down, -r.add);
  }
  return { up, down };
}

/** Assumes a validated rule and gears; `id` names the unit in messages. A ledger is layered on by piecewise.ts. */
export function compileStart(u: CycleRule, gears: ReadonlyMap<string, GearAst>, id: string): StartRule {
  const base = linearBase(u);
  const index: LinearBase | null = u.crossing?.index ?? null;
  const terms = (u.gears ?? []).map((t) => ({ add: t.add, g: gears.get(t.gear)! }));
  const stages = u.stages ?? [];

  const level0 = (k: number): number => {
    let s = baseStart(base, index ? floorDiv(k * index.a + index.c, index.L) : k);
    for (const t of terms) s += t.add * gearBelow(t.g, k);
    return s;
  };
  // level j reads level j − 1 only; each stage's window is a few occurrences, so this is O(1)
  const levels: Array<(k: number) => number> = [level0];
  for (const stage of stages) {
    const below = levels[levels.length - 1]!;
    levels.push((k) => {
      const s = below(k);
      for (const r of stage.rules) {
        const hit = "residue" in r ? r.residue.in.includes(mod(s - (r.residue.offset ?? 0), r.residue.mod)) : below(k + r.length.at + 1) - below(k + r.length.at) === r.length.is;
        if (hit) return s + r.add;
      }
      return s;
    });
  }
  const start = levels[levels.length - 1]!;

  // occurrence lengths of the base, read through the index map: n index steps of the base, n each floor or ceil of a/L
  const steps0 = index ? baseLengths(index) : [1];
  const baseShortest = steps0[0]! === 0 ? 0 : steps0[0]! * baseLengths(base)[0]!;
  const reach = stages.map(stageReach);
  const shortest = baseShortest + terms.reduce((a, t) => a + Math.min(0, t.add), 0) - reach.reduce((a, r) => a + r.up + r.down, 0);

  if (!index && !terms.length && !stages.length) return { start, indexAt: (d) => baseIndexAt(base, d), shortest, steps: 0 };

  // start(k) − origin − mean·k stays within `deviation`: the base's floors (under one day each, and under one base
  // occurrence for the index map's floor), each gear's count against its mean, each stage's reach
  const perK = (index ? index.a / index.L : 1) * (base.a / base.L);
  const mean = perK + terms.reduce((a, t) => a + t.add * gearDensity(t.g), 0);
  const origin = ((index ? index.c / index.L : 0) * base.a + base.c) / base.L;
  const deviation =
    (base.L === 1 ? 0 : 1) +
    (index && index.L !== 1 ? Math.ceil(base.a / base.L) : 0) +
    terms.reduce((a, t) => a + Math.abs(t.add) * gearDeviation(t.g), 0) +
    reach.reduce((a, r) => a + Math.max(r.up, r.down), 0);
  const steps = Math.ceil(deviation / Math.max(1, shortest)) + 2;
  return {
    start,
    shortest,
    steps,
    indexAt(d) {
      let i = Math.floor((d - origin) / mean);
      let left = steps;
      while (start(i) > d) i = step(i, -1, left--);
      while (start(i + 1) <= d) i = step(i, 1, left--);
      return i;
    },
  };

  function step(i: number, by: number, left: number): number {
    if (left <= 0) throw new Error(`unreachable: "${id}" needed more correction steps than its V4 bound`);
    return i + by;
  }
}
