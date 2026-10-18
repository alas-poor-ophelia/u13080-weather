/**
 * A unit's start rule with its ledger (docs/SESHAT-v0.md §2.7.1): the unit's
 * own rule, each `switch` rule from its `from` on, and `starts` pins laid over
 * the result. Every rule is absolute (evaluated whole, as if alone), and pins
 * replace a start without moving any other, so an entry changes only what it
 * names. Stages never read pins.
 *
 * Index from day: binary search the anchors (every pinned start and every
 * switch's first start), then ask the rule governing between two anchors once
 * and clamp its answer to the occurrences between them. Exact, because starts
 * are strictly increasing (V7) and each rule is absolute.
 */
import type { CycleUnitAst, LedgerEntry } from "./ast";
import type { GearAst } from "./gear";
import { compileStart, type StartRule } from "./start";

interface Anchor {
  readonly k: number;
  readonly s: number;
}

/** Assumes a validated unit and ledger. */
export function compileUnit(u: CycleUnitAst, gears: ReadonlyMap<string, GearAst>): StartRule {
  const own = compileStart(u, gears, u.id);
  const ledger = u.ledger ?? [];
  if (!ledger.some((e) => e.kind !== "slots")) return own;

  const switches = ledger.filter((e): e is Extract<LedgerEntry, { kind: "switch" }> => e.kind === "switch").map((e) => ({ from: e.from, rule: compileStart(e.rule, gears, u.id) }));
  const pins = new Map<number, number>();
  for (const e of ledger) {
    if (e.kind !== "starts") continue;
    let s = e.startsOn;
    pins.set(e.from, s);
    (e.lengths ?? []).forEach((len, i) => pins.set(e.from + i + 1, (s += len)));
  }

  /** the rule governing occurrence k: the last switch at or before it, else the unit's own */
  const ruleAt = (k: number): StartRule => {
    let r = own;
    for (const sw of switches) if (sw.from <= k) r = sw.rule;
    return r;
  };
  const start = (k: number): number => pins.get(k) ?? ruleAt(k).start(k);

  const anchors: Anchor[] = [...pins.keys(), ...switches.map((sw) => sw.from)].sort((a, b) => a - b).map((k) => ({ k, s: start(k) }));

  return {
    start,
    // the rules' bound only: pinned occurrences are checked one by one (V7), so they need not respect it
    shortest: Math.min(own.shortest, ...switches.map((sw) => sw.rule.shortest)),
    steps: Math.max(own.steps, ...switches.map((sw) => sw.rule.steps)),
    indexAt(d) {
      // the last anchor starting on or before d
      let lo = 0;
      let hi = anchors.length - 1;
      let a = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid]!.s <= d) {
          a = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const next = anchors[a + 1];
      if (a < 0) return Math.min(own.indexAt(d), next!.k - 1); // before every anchor: the unit's own rule
      const { k } = anchors[a]!;
      const upper = next ? next.k - 1 : Infinity;
      if (upper === k) return k;
      // occurrences k + 1 .. upper are unpinned and governed by one rule
      const r = ruleAt(k + 1).indexAt(d);
      return Math.max(k, Math.min(r, upper));
    },
  };
}
