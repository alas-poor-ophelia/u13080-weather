/**
 * The Studio's exact year seams (Seshat P3b step 0.5, docs/SESHAT-v0.md
 * §14.8 C1, C2, C7, C8, C9):
 *
 *   - the adapter's year model is shared: yearAt(d).start === yearStartAt(its index), within and past the day line;
 *   - engine seam: fractionalYear(d) is toContext's year + yearPhase bit for bit (Object.is), on Gregorian,
 *     Hebrew and Roman, over ±5 years and far days; dayAt finds every day back exactly, edges included;
 *     positions increase strictly and meet Y + 1 at every year seam; a definition edit is seen at once;
 *   - probed seam: the almanac fixture (a 401-day year every fourth) is placed exactly, and adapters
 *     whose contexts cannot place years (no year, a falling or skipping year, a phase out of range, a
 *     throw) are refused;
 *   - yearsFor picks the seam per adapter and notes a refused probe once.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, HEBREW, print, ROMAN, type CalendarAst } from "../src/seshat";
import { InternalCalendar } from "../src/plugin/time/internal";
import { SeshatCalendar, yearAt, yearStartAt } from "../src/plugin/time/seshat";
import type { TimeAdapter, TimeContext } from "../src/plugin/time/adapter";
import { engineYears, probeFault, probedYears, yearsFor, type YearSeam } from "../src/studio/model/years";
import { makeAdapter } from "./fixtures/api/third-party-calendar";
import { firstDayOfYear } from "../src/studio/model/audition";

const CALS: Record<string, CalendarAst> = { GREGORIAN, HEBREW, ROMAN };
const span = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const NEAR = span(-1900, 1900);
const FAR = [...span(9_999_000, 10_002_500), ...span(-10_002_500, -9_999_000), 3_000_000, -3_000_000];

/** The seam's invariants over `days`, against a context function that is the ground truth. */
function checkExact(name: string, seam: YearSeam, ctx: (d: number) => TimeContext, days: number[]) {
  let prev: number | null = null;
  for (const d of days) {
    const c = ctx(d);
    const fy = seam.fractionalYear(d);
    // C7: bit for bit the engine's own coordinate
    expect([name, d, Object.is(fy, c.year! + c.yearPhase)]).toEqual([name, d, true]);
    // C2: a day edge reads as its own day, the middle of a day as that day
    expect([name, d, seam.dayAt(fy)]).toEqual([name, d, d]);
    expect([name, d, seam.dayAt(seam.dayMid(d))]).toEqual([name, d, d]);
    // the middle is the middle, not an edge: halfway between this day's start and the next's
    const next = seam.fractionalYear(d + 1);
    expect([name, d, Math.abs(seam.dayMid(d) - (fy + next) / 2) <= 1e-9 * Math.max(1, Math.abs(fy))]).toEqual([name, d, true]);
    expect([name, d, seam.dayAt(seam.fractionalYear(d + 1) - 1e-12 * Math.max(1, Math.abs(fy)))]).toEqual([name, d, d]);
    const y = seam.yearOf(d);
    expect([name, d, y.year, d - y.start, y.length]).toEqual([name, d, c.year!, c.dayOfYear!, c.yearLength]);
    if (prev !== null && days.includes(d - 1)) expect([name, d, fy > prev]).toEqual([name, d, true]);
    prev = fy;
  }
  // continuity at year seams, and lengths that add up
  for (const Y of [...new Set(days.map((d) => seam.yearOf(d).year))].slice(1, -1)) {
    const s = seam.yearStart(Y);
    const L = seam.yearLength(Y);
    expect([name, Y, seam.fractionalYear(s)]).toEqual([name, Y, Y]);
    expect([name, Y, seam.fractionalYear(s + L)]).toEqual([name, Y, Y + 1]);
    expect([name, Y, seam.yearStart(Y + 1)]).toEqual([name, Y, s + L]);
    expect([name, Y, seam.stepYears(Y)]).toEqual([name, Y, 1 / L]);
    expect([name, Y, seam.dayIndexAt(Y, Y + 0.5)]).toEqual([name, Y, Math.round(0.5 * L)]);
    // a fractional day sits between its day and the next
    const half = seam.fractionalYear(s + 0.5);
    expect([name, Y, half > Y && half < seam.fractionalYear(s + 1)]).toEqual([name, Y, true]);
    expect([name, Y, Math.abs(seam.dayOf(half) - (s + 0.5)) < 1e-6]).toEqual([name, Y, true]);
  }
}

describe("the adapter's year model is one model (C7)", () => {
  for (const [name, ast] of Object.entries(CALS)) {
    test(`${name}: yearAt's start is yearStartAt of its index, within and past the day line`, () => {
      const e = new Engine(ast);
      for (const d of [...NEAR, ...FAR]) {
        const y = yearAt(e, d);
        expect([name, d, yearStartAt(e, y.index)]).toEqual([name, d, y.start]);
      }
    });
  }
});

describe("the engine seam (a world that runs a definition)", () => {
  for (const [name, ast] of Object.entries(CALS)) {
    test(`${name}: exact against toContext, near and far`, () => {
      const cal = new SeshatCalendar(print(ast), () => 0);
      const seam = engineYears(cal)!;
      expect(seam.exact).toBe(true);
      expect(seam.epochYear).toBe(cal.toContext(0).year!);
      expect(seam.nominalLength).toBe(cal.describe().yearLength);
      checkExact(name, seam, (d) => cal.toContext(d), NEAR);
      checkExact(`${name} far`, seam, (d) => cal.toContext(d), FAR);
    });
  }

  test("Gregorian leap years are 366 days: day 59 of 2024 is 29 February, and the year is still one unit wide", () => {
    const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
    const seam = engineYears(cal)!;
    const start2024 = seam.yearStart(2024);
    expect(cal.format(start2024)).toBe("2024-01-01");
    expect(seam.yearLength(2024)).toBe(366);
    expect(seam.yearLength(2023)).toBe(365);
    expect(cal.format(start2024 + 59)).toBe("2024-02-29");
    expect(seam.fractionalYear(start2024 + 59)).toBe(2024 + 59 / 366);
  });

  test("a definition edit is seen at once: the seam reads the adapter at every call (C9)", () => {
    const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
    const seam = engineYears(cal)!;
    const before = seam.yearStart(2000);
    cal.update(print({ ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "year" && u.kind === "cycle" && "anchor" in u ? { ...u, anchor: (u.anchor) + 10 } : u)) } as CalendarAst));
    expect(seam.yearStart(2000)).toBe(before + 10);
  });

  test("yearsFor takes a definition world's years from its engine, not by probing its contexts", () => {
    const cal = new SeshatCalendar(print(HEBREW), () => 0);
    let probes = 0;
    const inner = cal.toContext.bind(cal);
    cal.toContext = (d) => (probes++, inner(d));
    const seam = yearsFor(cal, cal.describe())!;
    seam.yearStart(5785);
    seam.dayAt(5785.5);
    seam.fractionalYear(123_456);
    expect(probes).toBe(0);
  });

  test("a faulted definition has no seam", () => {
    expect(engineYears(new SeshatCalendar("not a calendar", () => 0))).toBeNull();
  });
});

describe("the probed seam (a third-party adapter whose contexts carry year)", () => {
  test("the almanac (a 401-day year every fourth) is placed exactly", () => {
    const a = makeAdapter();
    expect(probeFault(a)).toBeNull();
    const seam = probedYears(a)!;
    checkExact("almanac", seam, (d) => a.toContext(d), NEAR);
    checkExact("almanac far", seam, (d) => a.toContext(d), [...span(4_000_000, 4_002_000), ...span(-4_002_000, -4_000_000)]);
    const lengths = [1, 2, 3, 4, 5, 8].map((y) => seam.yearLength(y));
    expect(lengths).toEqual([400, 400, 400, 401, 400, 401]);
  });

  // `over` may break the context on purpose (a missing year), so it is looser than TimeContext
  const base = (over: (d: number) => Record<string, unknown>): TimeAdapter => ({
    id: "bad",
    now: () => null,
    configHash: () => "h",
    toContext: (d) => ({ dayOrdinal: d, yearPhase: (((d % 100) + 100) % 100) / 100, yearLength: 100, year: Math.floor(d / 100) + 1, dayOfYear: ((d % 100) + 100) % 100, source: "bad", ...over(d) }),
  });

  test("a well-formed constant adapter passes; each way of failing is refused with its reason", () => {
    expect(probeFault(base(() => ({})))).toBeNull();
    expect(probeFault(base(() => ({ year: undefined })))).toMatch(/no whole year number/);
    expect(probeFault(base((d) => ({ year: d === 300 ? 0 : Math.floor(d / 100) + 1 })))).toMatch(/falls/);
    expect(probeFault(base((d) => ({ year: Math.floor(d / 100) + 1 + (d >= 500 ? 5 : 0) })))).toMatch(/skips/);
    expect(probeFault(base((d) => ({ yearPhase: d === 7 ? 1 : (((d % 100) + 100) % 100) / 100 })))).toMatch(/phase outside/);
    expect(probeFault(base((d) => ({ yearPhase: d === 50 ? 0.4 : (((d % 100) + 100) % 100) / 100 })))).toMatch(/does not increase/);
    const thrower = base(() => ({}));
    const inner = thrower.toContext;
    thrower.toContext = (d) => {
      if (d === 1_000_000) throw new Error("out of range");
      return inner(d);
    };
    expect(probeFault(thrower)).toMatch(/threw: out of range/);
  });
});

describe("yearsFor picks the seam per adapter", () => {
  test("internal: constant; a definition world: engine (null in a fault); a well-formed third party: probed", () => {
    const internal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [], seasons: [] }, () => 0);
    const c = yearsFor(internal, internal.describe());
    expect(c?.exact).toBe(false);
    expect(c?.nominalLength).toBe(365);
    expect(yearsFor(new SeshatCalendar(print(GREGORIAN), () => 0), null)?.exact).toBe(true);
    expect(yearsFor(new SeshatCalendar("broken", () => 0), null)).toBeNull();
    const almanac = makeAdapter();
    expect(yearsFor(almanac, almanac.describe?.())?.exact).toBe(true);
    expect(yearsFor(undefined, null)).toBeNull();
  });

  test("a third party the probe refuses falls back to the constant seam from its description, noted once", () => {
    let hash = "x";
    const noYear: TimeAdapter = { id: "opaque", now: () => null, configHash: () => hash, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 360, source: "opaque" }), describe: () => ({ label: "Opaque", readOnly: true, yearLength: 360, seasons: [], moons: [] }) };
    const warnings: unknown[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a);
    try {
      const s1 = yearsFor(noYear, noYear.describe!());
      hash = "y"; // probed again: still noted only once
      const s2 = yearsFor(noYear, noYear.describe!());
      expect([s1?.exact, s1?.nominalLength, s2?.exact]).toEqual([false, 360, false]);
      // no description and no years: no calendar
      const { describe: _drop, ...bare } = noYear;
      expect(yearsFor(bare, null)).toBeNull();
    } finally {
      console.warn = orig;
    }
    expect(warnings.length).toBe(2); // once per adapter object: noYear, and the copy without describe
  });

  test("the probe is remembered per configHash and redone when it changes", () => {
    let hash = "a";
    let calls = 0;
    const a = makeAdapter();
    const inner = a.toContext.bind(a);
    const watched: TimeAdapter = { ...a, configHash: () => hash, toContext: (d) => (calls++, inner(d)) };
    yearsFor(watched, null);
    const first = calls;
    yearsFor(watched, null);
    expect(calls).toBe(first); // remembered
    hash = "b";
    yearsFor(watched, null);
    expect(calls).toBeGreaterThan(first); // probed again
  });
});

describe("firstDayOfYear takes exact years from the seam, and trusts a parse only when it is the year's first day (C10)", () => {
  test("a definition world: the seam's year start, no parse", () => {
    const cal = new SeshatCalendar(print(HEBREW), () => 0);
    const seam = engineYears(cal)!;
    let parses = 0;
    const inner = cal.parse.bind(cal);
    cal.parse = (t) => (parses++, inner(t));
    for (const Y of [seam.epochYear - 3, seam.epochYear, seam.epochYear + 7]) {
      const d = firstDayOfYear(cal, Y);
      expect(d).toBe(seam.yearStart(Y));
      expect(cal.toContext(d).dayOfYear).toBe(0);
      expect(cal.toContext(d - 1).year).toBe(Y - 1);
    }
    expect(parses).toBe(0);
  });

  test("a probed third party: its own year starts, the 401-day years included", () => {
    const a = makeAdapter();
    for (const Y of [1, 4, 5, 8, 9]) {
      const d = firstDayOfYear(a, Y);
      expect([Y, a.toContext(d).year, a.toContext(d - 1).year]).toEqual([Y, Y, Y - 1]);
    }
  });

  test("the internal calendar still reads its own parse (unchanged)", () => {
    const internal = new InternalCalendar({ yearLength: 365.25, epochYear: 1, moons: [], seasons: [] }, () => 0);
    let parses = 0;
    const inner = internal.parse.bind(internal);
    internal.parse = (t) => (parses++, inner(t));
    expect(firstDayOfYear(internal, 5)).toBe(inner("5-1")!);
    expect(parses).toBe(1);
  });

  test("a parse that names another day is not trusted: the walk finds the year's first day", () => {
    const base: TimeAdapter = {
      id: "misparse",
      now: () => null,
      configHash: () => "m",
      // no `year` in its contexts, so the probe refuses it and the old path runs (yearOf falls back to floor(d / 100) + 1)
      toContext: (d) => ({ dayOrdinal: d, yearPhase: (((d % 100) + 100) % 100) / 100, yearLength: 100, dayOfYear: ((d % 100) + 100) % 100, source: "misparse" }),
      parse: (t) => (t === "3-1" ? 205 : null), // day 5 of year 3, not its first
    };
    expect(probeFault(base)).not.toBeNull();
    expect(firstDayOfYear(base, 3)).toBe(200);
  });
});
