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
 * The engine is the truth; P3b leaves the legacy lane as it is (its drawing is
 * pinned byte for byte by golden-studio-years), so KNOWN stays.
 *
 * Worlds that run a definition (Seshat P3b step 1) draw through the engine
 * year seam and have no KNOWN at all: Gregorian leap years, Hebrew years of
 * 353 to 385 days and Roman years, with `dayOfYear` bounds at, below and past
 * the last day of a short year (drawn nowhere a year does not reach, as the
 * engine matches nowhere there).
 */
import { describe, expect, test } from "bun:test";
import { compilePredicate, generationOptions } from "../src/core/rules";
import type { Predicate } from "../src/core/types";
import { InternalCalendar } from "../src/plugin/time/internal";
import { evaluate, TimeView } from "../src/seshat/rule";
import { fractionalYear, spansFor, type SpanCalendar } from "../src/studio/model/spans";
import { dragToWhen } from "../src/studio/model/device-lanes";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { engineYears } from "../src/studio/model/years";
import { GREGORIAN, HEBREW, print, ROMAN, type CalendarAst } from "../src/seshat";

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

const SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
const DEFINITION_PREDICATES: Predicate[] = [
  { yearPhase: [0.45, 0.72] },
  { yearPhase: [0.9, 0.1] },
  { dayOfYear: [10, 20] },
  { dayOfYear: [0, 0] },
  { dayOfYear: [58, 60] },
  { dayOfYear: [364, 364] },
  { dayOfYear: [365, 365] },
  { dayOfYear: [360, 400] },
  { dayOfYear: [383, 384] },
  { moon: { name: "Luna", phase: [0.95, 0.05] } },
  { moon: { name: "Luna", phase: [0.4, 0.6] } },
  { tag: "season:Summer" },
  { tag: "season:Winter" },
  { all: [{ tag: "season:Winter" }, { moon: { name: "Luna", phase: [0.4, 0.6] } }] },
] as Predicate[];

describe("Studio spans agree with the engine on worlds that run a definition (exact years)", () => {
  const worlds: Array<[string, CalendarAst, number, number]> = [
    // 2019-2025 straddles the 2020 and 2024 leap years
    ["Gregorian", GREGORIAN, 17_897, 20_453],
    ["Hebrew", HEBREW, -1500, 1500],
    ["Roman", ROMAN, -1500, 1500],
  ];
  for (const [name, ast, D0, D1] of worlds) {
    test(`${name}, days ${D0}..${D1}`, () => {
      const def: CalendarAst = { ...ast, seasons: { unit: "year", marks: SEASONS }, bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 1, d: 3 }, moon: { name: "Luna" } }] };
      const cal = new SeshatCalendar(print(def), () => 0);
      expect(cal.fault).toBeNull();
      const d = cal.describe();
      const years = engineYears(cal)!;
      const scal: SpanCalendar = { yearLength: d.yearLength, epochYear: d.epochYear!, seasons: d.seasons, moons: d.moons, eras: [], years };
      const window = { a: fractionalYear(D0, scal), b: fractionalYear(D1 + 1, scal) };
      const lengths = new Set<number>();
      for (const p of DEFINITION_PREDICATES) {
        const rule = compilePredicate(p);
        const spans = spansFor(p, undefined, scal, { window, maxSpans: 100_000 });
        const wrong: number[] = [];
        let matched = 0;
        for (let day = D0; day <= D1; day++) {
          const ctx = cal.toContext(day);
          lengths.add(ctx.yearLength);
          const on = evaluate(rule, new TimeView(ctx, day), generationOptions({ seed: "s", zoneId: "z", modifierId: "m", dayOrdinal: day, regime: "" })) === true;
          if (on) matched++;
          const y = fractionalYear(day, scal);
          if (on === spans.some((s) => y >= s.from && y < s.to)) continue;
          if (spans.some((s) => Math.abs(y - s.from) < EDGE || Math.abs(y - s.to) < EDGE)) continue;
          wrong.push(day);
        }
        expect({ name, p, wrong }).toEqual({ name, p, wrong: [] });
        // a predicate the span reaches somewhere is drawn somewhere, and one the engine never matches draws nothing
        expect({ name, p, drawn: spans.length > 0 }).toEqual({ name, p, drawn: matched > 0 });
      }
      // the window really holds years of different lengths
      expect(lengths.size).toBeGreaterThan(1);
    });
  }

  test("dayOfYear exactly on a day edge: the span starts where the engine's day starts, bit for bit", () => {
    const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
    const years = engineYears(cal)!;
    const d = cal.describe();
    const scal: SpanCalendar = { yearLength: d.yearLength, epochYear: d.epochYear!, seasons: [], moons: [], eras: [], years };
    const window = { a: 2023.5, b: 2025.5 };
    const spans = spansFor({ dayOfYear: [59, 59] }, undefined, scal, { window });
    // 2024 is a leap year: day 59 is 29 February
    const s2024 = spans.find((s) => s.id === "doy:2024")!;
    const feb29 = years.yearStart(2024) + 59;
    expect(cal.format(feb29)).toBe("2024-02-29");
    expect(Object.is(s2024.from, years.fractionalYear(feb29))).toBe(true);
    expect(Object.is(s2024.to, years.fractionalYear(feb29 + 1))).toBe(true);
    // 2025 has no day 365: the [365, 365] lane draws 2024 only
    expect(spansFor({ dayOfYear: [365, 365] }, undefined, scal, { window }).map((x) => x.id)).toEqual(["doy:2024"]);
  });
});

describe("a dayOfYear drag on exact years writes what the engine then matches (Seshat P3b step 4)", () => {
  const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
  const years = engineYears(cal)!;
  const d = cal.describe();
  const scal: SpanCalendar = { yearLength: d.yearLength, epochYear: d.epochYear!, seasons: [], moons: [], eras: [], years };
  const mod = (when: Predicate) => ({ id: "m", when, apply: [], tag: "m" }) as unknown as Parameters<typeof dragToWhen>[0];
  const span = (year: number) => ({ id: `doy:${year}`, from: year, to: year + 0.1, kind: "clip" as const, editable: true });

  test("dropping a span where it is drawn writes back the same bounds, in a leap year and a common one", () => {
    for (const [year, range] of [
      [2024, [59, 59]],
      [2023, [59, 59]],
      [2024, [300, 365]],
      [2025, [0, 0]],
    ] as const) {
      const drawn = spansFor({ dayOfYear: [...range] }, undefined, scal, { window: { a: year - 0.5, b: year + 1.5 } }).find((s) => s.id === `doy:${year}`)!;
      const next = dragToWhen(mod({ dayOfYear: [0, 1] }), span(year), drawn.from, drawn.to, scal);
      expect([year, next?.when]).toEqual([year, { dayOfYear: [...range] }]);
    }
  });

  test("a drag to the year's end clamps to that year's own last day: 365 in 2024, 364 in 2025", () => {
    const leap = dragToWhen(mod({ dayOfYear: [0, 1] }), span(2024), 2024 + 300 / 366, 2024 + 1.2, scal);
    const common = dragToWhen(mod({ dayOfYear: [0, 1] }), span(2025), 2025 + 300 / 365, 2025 + 1.2, scal);
    expect(leap?.when).toEqual({ dayOfYear: [300, 365] });
    expect(common?.when).toEqual({ dayOfYear: [300, 364] });
    // and the engine matches exactly those days: the written bounds are in the year's own count
    const lastOf2024 = years.yearStart(2025) - 1;
    expect(cal.format(lastOf2024)).toBe("2024-12-31");
    expect(cal.toContext(lastOf2024).dayOfYear).toBe(365);
  });
});
