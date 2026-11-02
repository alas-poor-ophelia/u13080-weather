/**
 * The counted line of a cycle that skips filler days (docs/SESHAT-v0.md §19.3,
 * `SKIPS:<slot unit>`): the day line with the filler slots of one slot unit
 * taken out. A week on it never holds Worldsday, and 1 January stays a Sunday.
 *
 * `counted(d) = d − F(k) − (filler days in occurrence k at or before d)`, where
 * k is the parent occurrence holding d and F(k) the filler days in the parent
 * occurrences before it, in closed form per slot. A filler day therefore reads
 * as the counted day before it, so it stays inside the span that contains it.
 *
 * Shared by the engine and the validator, so the two can never read a filler
 * differently. Assumes a validated slot unit: filler slots are constant plus
 * gear terms, and every parent occurrence holds a counted day.
 */
import type { CycleUnitAst, LedgerEntry, SlotsUnitAst } from "./ast";
import { gearBelow, gearMatcher, type GearAst } from "./gear";
import { compileUnit } from "./piecewise";
import { slotLengthsIn } from "./slots";
import { compileStart, type StartRule } from "./start";

export interface Sequence {
  /** the day's number on the counted line; a filler day reads as the counted day before it */
  counted(day: number): number;
  isFiller(day: number): boolean;
  /** the counted day holding counted number `c` */
  dayFromCounted(c: number): number;
}

export function makeSequence(parent: StartRule, slots: SlotsUnitAst, ledger: readonly LedgerEntry[], gears: ReadonlyMap<string, GearAst>): Sequence {
  const matchers = new Map<string, (n: number) => boolean>();
  const matches = (gear: string, k: number): boolean => {
    let m = matchers.get(gear);
    if (!m) matchers.set(gear, (m = gearMatcher(gears.get(gear)!)));
    return m(k);
  };
  const fillers = slots.slots.flatMap((s, i) => (s.filler ? [{ i, length: s.length as number, terms: (s.gears ?? []).map((t) => ({ add: t.add, g: gears.get(t.gear)! })) }] : []));
  const overrides = new Map(ledger.flatMap((e) => (e.kind === "slots" && e.unit === slots.id && !e.path?.length ? [[e.from, e.lengths] as const] : [])));

  // a ledger override changes one occurrence's filler days: their differences from the rule, as prefix sums in occurrence order
  const fillerByRule = (k: number): number => fillers.reduce((sum, f) => f.terms.reduce((n, t) => (matches(t.g.id, k) ? n + t.add : n), sum + f.length), 0);
  const changed = [...overrides.keys()].sort((a, b) => a - b);
  const prefix = [0];
  for (const k of changed) prefix.push(prefix[prefix.length - 1]! + fillers.reduce((n, f) => n + overrides.get(k)![f.i]!, 0) - fillerByRule(k));
  const negative = lowerBound(changed, 0);

  /** filler days in the occurrences before k (in [0, k), and minus those in [k, 0) for negative k, as gearBelow counts) */
  const fillerBefore = (k: number): number => {
    let sum = prefix[lowerBound(changed, k)]! - prefix[negative]!;
    for (const f of fillers) {
      sum += f.length * k;
      for (const t of f.terms) sum += t.add * gearBelow(t.g, k);
    }
    return sum;
  };

  let lastK: number | null = null;
  let lastLens: readonly number[] = [];
  const lengths = (k: number): readonly number[] => {
    if (k === lastK) return lastLens;
    const total = parent.start(k + 1) - parent.start(k);
    const got = slotLengthsIn(slots, total, (g) => matches(g, k), overrides.get(k));
    if (typeof got === "string") throw new Error(`unreachable: "${slots.id}" in occurrence ${k}: ${got}`); // the validator checks every reachable occurrence
    lastK = k;
    lastLens = got;
    return got;
  };

  /** The parent occurrence holding `day`, the filler days in it at or before `day`, and whether `day` is one. */
  const walk = (day: number): { k: number; filler: number; isFiller: boolean } => {
    const k = parent.indexAt(day);
    const offset = day - parent.start(k);
    const lens = lengths(k);
    let at = 0;
    let filler = 0;
    for (const [i, len] of lens.entries()) {
      const isFiller = !!slots.slots[i]!.filler;
      if (offset < at + len) return { k, filler: isFiller ? filler + offset - at + 1 : filler, isFiller };
      if (isFiller) filler += len;
      at += len;
    }
    throw new Error(`unreachable: day ${day} falls past the slots of "${slots.id}"`); // the validator makes the slots fill the parent
  };

  /** the counted number of occurrence k's first counted day; strictly increasing, since every occurrence holds a counted day */
  const firstCounted = (k: number): number => parent.start(k) - fillerBefore(k);

  return {
    counted(day) {
      const { k, filler } = walk(day);
      return day - fillerBefore(k) - filler;
    },
    isFiller: (day) => walk(day).isFiller,
    dayFromCounted(c) {
      // the occurrence holding c: gallop out from where the day line puts c, then bisect
      let lo = parent.indexAt(c);
      let hi = lo;
      for (let step = 1; firstCounted(lo) > c; step *= 2) lo -= step;
      for (let step = 1; firstCounted(hi + 1) <= c; step *= 2) hi += step;
      while (lo < hi) {
        const mid = lo + Math.ceil((hi - lo) / 2);
        if (firstCounted(mid) <= c) lo = mid;
        else hi = mid - 1;
      }
      let left = c - firstCounted(lo);
      let at = parent.start(lo);
      for (const [i, len] of lengths(lo).entries()) {
        if (!slots.slots[i]!.filler) {
          if (left < len) return at + left;
          left -= len;
        }
        at += len;
      }
      throw new Error(`unreachable: counted day ${c} falls past the slots of "${slots.id}"`);
    },
  };
}

/**
 * The start rule of a cycle that skips: its own rule, run on the counted line. Its anchor and its pins are days, so
 * they are read through `counted`; a pin's lengths are counted days already. A switch's anchor is the day its `from`
 * occurrence starts: an occurrence 0 far back across the filler days could not be worked out by hand.
 */
export function skippingRule(u: CycleUnitAst, seq: Sequence, gears: ReadonlyMap<string, GearAst>): StartRule {
  const onLine = (day: number): number => seq.counted(day);
  const ledger = u.ledger?.map((e): LedgerEntry => {
    if (e.kind === "starts") return { ...e, startsOn: onLine(e.startsOn) };
    if (e.kind === "switch" && e.rule.anchor !== undefined) {
      const fromZero = compileStart({ ...e.rule, anchor: 0 }, gears, u.id).start(e.from);
      return { ...e, rule: { ...e.rule, anchor: onLine(e.rule.anchor) - fromZero } };
    }
    return e;
  });
  const inner = compileUnit({ ...u, anchor: onLine(u.anchor!), ...(ledger ? { ledger } : {}) } as CycleUnitAst, gears);
  return {
    start: (k) => seq.dayFromCounted(inner.start(k)),
    indexAt: (d) => inner.indexAt(seq.counted(d)),
    shortest: inner.shortest,
    steps: inner.steps,
  };
}

/** The first position in sorted `xs` holding a value ≥ x. */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
