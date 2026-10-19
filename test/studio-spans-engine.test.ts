/**
 * The Studio's lanes re-derive where a predicate holds (spans.ts) instead of
 * asking the engine, so this pins the two together (Seshat P2, step 2): on
 * every day, "the day's start lies in a span" must equal "the compiled rule
 * holds", for every lane kind spans.ts draws from the calendar. A day exactly
 * on a clip edge can land an ulp to either side (spans add `year + phase`, the
 * day is `epochYear + d / yearLength`); those days are allowed, nothing else.
 *
 * One known disagreement is pinned rather than allowed: in a fractional-length
 * year `dayOfYear` is itself fractional (20.25, 20.5, …). The engine compares
 * `20.5 <= 20` (off); the lane draws day 20 as `[20, 21)` of the year (on).
 * The engine is the truth; the lane is fixed with exact variable-length years
 * in Seshat P3 (bead wadjet-01k.4, KNOWN below).
 */
import { describe, expect, test } from "bun:test";
import { compilePredicate, generationOptions } from "../src/core/rules";
import type { Predicate } from "../src/core/types";
import { InternalCalendar } from "../src/plugin/time/internal";
import { evaluate, TimeView } from "../src/seshat/rule";
import { fractionalYear, spansFor, type SpanCalendar } from "../src/studio/model/spans";

const EDGE = 1e-9;

/** yearLength → predicate → the days the lane gets wrong today (see the header). */
const KNOWN: Record<number, Record<string, number[]>> = {
  365.25: { '{"dayOfYear":[10,20]}': [-710, -345, 386, 751], '{"dayOfYear":[0,0]}': [-730, -365, 366, 731] },
};
const PREDICATES: Predicate[] = [
  { yearPhase: [0.45, 0.72] },
  { yearPhase: [0.9, 0.1] },
  { yearPhase: [0, 0.25] },
  { dayOfYear: [10, 20] },
  { dayOfYear: [0, 0] },
  { moon: { name: "Sable", phase: [0.95, 0.05] } },
  { moon: { name: "Sable", phase: [0, 0.02] } },
  { moon: { name: "Sable", phase: [0.4, 0.6] } },
];

describe("Studio spans agree with the engine's compiled rules", () => {
  for (const yearLength of [365, 400, 365.25]) {
    test(`a ${yearLength}-day year, days -800..800`, () => {
      const cfg = { yearLength, epochYear: 1, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }], seasons: [{ name: "Spring", from: 0 }] };
      const cal = new InternalCalendar(cfg, () => 0);
      const scal: SpanCalendar = { ...cfg, eras: [] };
      const [D0, D1] = [-800, 800];
      const window = { a: fractionalYear(D0, scal), b: fractionalYear(D1 + 1, scal) };
      for (const p of PREDICATES) {
        const rule = compilePredicate(p);
        const spans = spansFor(p, undefined, scal, { window, maxSpans: 100_000 });
        expect(spans.length).toBeGreaterThan(0);
        const wrong: number[] = [];
        for (let d = D0; d <= D1; d++) {
          const on = evaluate(rule, new TimeView(cal.toContext(d), d), generationOptions({ seed: "s", zoneId: "z", modifierId: "m", dayOrdinal: d, regime: "" })) === true;
          const y = fractionalYear(d, scal);
          if (on === spans.some((s) => y >= s.from && y < s.to)) continue;
          if (spans.some((s) => Math.abs(y - s.from) < EDGE || Math.abs(y - s.to) < EDGE)) continue;
          wrong.push(d);
        }
        expect({ p, wrong }).toEqual({ p, wrong: KNOWN[yearLength]?.[JSON.stringify(p)] ?? [] });
      }
    });
  }
});
