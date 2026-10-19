/**
 * Direct tests for the Seshat P0 behaviour changes (docs/SESHAT-v0.md §8.2),
 * so a regression is caught by name, not only as golden drift.
 */
import { describe, expect, test } from "bun:test";
import { gregorianTime } from "../src/core/generator";
import { ModifierEngine, YEAR_LENGTH_MAX, sampleEnvelope } from "../src/core/modifiers";
import { inPhase as inPhaseRange } from "../src/seshat/rule";
import type { DayTime, Modifier, Predicate } from "../src/core/types";
import { badMoonsLine } from "../src/plugin/calendar-text";
import { InternalCalendar } from "../src/plugin/time/internal";
import { moonPhase } from "../src/seshat";

describe("B1: window edges honour [lo, hi) exactly", () => {
  test("a phase exactly on a window's start is inside, exactly on its end is outside", () => {
    expect(inPhaseRange(180 / 400, 0.45, 0.72)).toBe(true); // ((0.45 % 1) + 1) % 1 used to give 0.44999999999999996
    expect(inPhaseRange(73 / 365, 0.2, 0.3)).toBe(true);
    expect(inPhaseRange(146 / 365, 0.3, 0.4)).toBe(false);
    expect(inPhaseRange(288 / 400, 0.45, 0.72)).toBe(false);
  });

  test("an envelope is sampled at the exact phase", () => {
    expect(sampleEnvelope([[0.45, 1], [0.5, 0]], 180 / 400)).toBe(1);
  });
});

/** The window a ModifierEngine computes for one spell modifier, given a time source. */
function windowOf(when: Predicate | undefined, timeOf: (d: number) => DayTime): number {
  const m: Modifier = { id: "s", ...(when ? { when } : {}), spell: { meanStartsPerYear: 1, meanDurationDays: 2 }, apply: [] };
  const e = new ModifierEngine({ seed: "seed", zoneId: "z", modifiers: [m], timeOf });
  return (e as unknown as { windowDays: Map<string, number> }).windowDays.get("s")!;
}

/** A calendar of `L` days a year that reports yearLength, with optional tags per day. */
const calendar =
  (L: number, tags: (d: number) => string[] = () => []) =>
  (d: number): DayTime & { yearLength: number } => {
    const doy = ((d % L) + L) % L;
    return { yearPhase: doy / L, dayOfYear: doy, yearLength: L, tags: tags(d) };
  };

describe("B3: the spell window uses the calendar's own year", () => {
  test("no `when`: the window is the calendar's year length, or 365 when none is reported", () => {
    expect(windowOf(undefined, calendar(400))).toBe(400);
    expect(windowOf(undefined, gregorianTime)).toBe(365);
  });

  test("an unusable reported length falls back to 365; a fractional one is floored", () => {
    for (const L of [Number.NaN, 0, 0.5, -3, Number.POSITIVE_INFINITY]) {
      const t = (d: number): DayTime => ({ ...calendar(400)(d), yearLength: L }) as DayTime;
      expect(windowOf(undefined, t)).toBe(365);
    }
    expect(windowOf(undefined, (d) => ({ ...calendar(400)(d), yearLength: 365.2425 }) as DayTime)).toBe(365);
  });

  test("a season-like window is counted over the whole 400-day year", () => {
    expect(windowOf({ yearPhase: [0.25, 0.5] }, calendar(400))).toBe(100);
    expect(windowOf({ yearPhase: [0.25, 0.5] }, calendar(365))).toBe(91); // days 92..182: 0.25·365 = 91.25, and 183/365 ≥ 0.5
  });

  test("a year longer than YEAR_LENGTH_MAX is sampled and the count scaled", () => {
    const L = YEAR_LENGTH_MAX * 3;
    // true on even days only: half of any sample
    const t = (d: number): DayTime => ({ ...calendar(L)(d), tags: d % 2 === 0 ? ["even"] : [] });
    expect(windowOf({ tag: "even" }, t)).toBe(L / 2);
  });

  test("no qualifying day: the window is the whole year, never zero", () => {
    expect(windowOf({ tag: "never" }, calendar(400))).toBe(400);
  });

  test("an era term does not zero the window when the era does not cover the reference year", () => {
    // era:Thaw only from day 1000 on; the window should count Winter days, not fall back to the year
    const t = calendar(400, (d) => (d >= 1000 ? ["era:Thaw"] : []));
    expect(windowOf({ all: [{ tag: "era:Thaw" }, { yearPhase: [0.75, 1] }] }, t)).toBe(100);
  });
});

describe("B3: regime and era terms are unknown, not true, when the window is counted", () => {
  const t = calendar(400, (d) => (d >= 1000 ? ["era:Thaw"] : []));
  const winter: Predicate = { yearPhase: [0.75, 1] };

  test("a positive term counts as before", () => {
    expect(windowOf({ all: [{ tag: "era:Thaw" }, winter] }, t)).toBe(100);
    expect(windowOf({ all: [{ regime: "storm" }, winter] }, t)).toBe(100);
    expect(windowOf({ regime: "storm" }, t)).toBe(400);
  });

  test("a negated term is still unknown, so the window is the winter, not the whole year", () => {
    expect(windowOf({ all: [{ not: { tag: "era:Thaw" } }, winter] }, t)).toBe(100);
    expect(windowOf({ all: [{ not: { regime: "storm" } }, winter] }, t)).toBe(100);
  });

  test("`any` with an unknown term counts every day it could hold", () => {
    expect(windowOf({ any: [{ tag: "era:Thaw" }, winter] }, t)).toBe(400);
  });

  test("an ordinary tag is not unknown: it is read from the reference year", () => {
    expect(windowOf({ all: [{ not: { tag: "season:Never" } }, winter] }, t)).toBe(100);
    expect(windowOf({ all: [{ tag: "season:Never" }, winter] }, t)).toBe(400); // no qualifying day: whole year
  });
});

describe("B2: one exact moon formula, never NaN", () => {
  test("the generator's moon and the shared moonPhase agree, and new moons are exactly 0", () => {
    const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [{ name: "M", cycleDays: 29.53, phaseAtEpoch: 0 }], seasons: [] }, () => 0);
    for (const d of [0, 1, 2953, -2953, 9_999_999]) expect(cal.toContext(d).moons![0]!.phase).toBe(moonPhase(29.53, 0, d));
    expect(moonPhase(29.53, 0, 2953 * 1000)).toBe(0);
  });

  test("a moon no body can represent falls back without throwing or returning NaN", () => {
    for (const cycle of [-5, 0, 5e-324, 1e300]) {
      const p = moonPhase(cycle, 0.25, 1234);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  test("a moon edited in place is picked up at once (bodies are keyed by value)", () => {
    const moon = { name: "M", cycleDays: 29.53, phaseAtEpoch: 0 };
    const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [moon], seasons: [] }, () => 0);
    const before = cal.toContext(10).moons![0]!.phase;
    moon.cycleDays = 20;
    expect(cal.toContext(10).moons![0]!.phase).toBe(0.5);
    expect(before).not.toBe(0.5);
  });

  test("the moons textarea refuses a cycle that is not more than 0 days", () => {
    expect(badMoonsLine("Sable, -5, 0")).toBeDefined();
    expect(badMoonsLine("Sable, 0, 0")).toBeDefined();
    expect(badMoonsLine("Sable, 29.53, 0")).toBeUndefined();
  });
});
