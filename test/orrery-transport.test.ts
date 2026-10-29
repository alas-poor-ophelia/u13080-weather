/**
 * The Orrery's transport, scrub bar, season strip and fit (docs/SESHAT-v0.md
 * §18.3 D5 D7, §18.6 item 9; bead wadjet-b6x, slice 1a-ii). Pure helpers in
 * src/studio/model/orrery-transport.ts, checked against the engine's own
 * year facts.
 */
import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, GREGORIAN, HARPTOS, HEBREW, type CalendarAst } from "../src/seshat";
import { buildOrrery, yearFacts, type OrreryModel } from "../src/studio/model/orrery-geometry";
import { orreryFit, scrubDay, scrubFraction, scrubSegments, seasonSegments, SEASON_COLOURS, stepDay, stepYear } from "../src/studio/model/orrery-transport";
import { LUNAR } from "./fixtures/orrery";

function model(ast: CalendarAst, day: number): OrreryModel {
  const m = buildOrrery(ast, day + 0.5);
  if (m.kind !== "orrery") throw new Error(`no orrery: ${m.message}`);
  return m;
}
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("transport ‹ ›", () => {
  test("one day either way, kept on the day line", () => {
    expect(stepDay(20000, 1)).toBe(20001);
    expect(stepDay(20000, -1)).toBe(19999);
    expect(stepDay(20000.7, 1)).toBe(20001);
    expect(stepDay(DAY_LIMIT, 1)).toBe(DAY_LIMIT);
    expect(stepDay(-DAY_LIMIT, -1)).toBe(-DAY_LIMIT);
  });
});

describe("transport « »", () => {
  test("Gregorian: a year either way keeps the day of the year", () => {
    const m = model(GREGORIAN, 20000); // 2024-10-04
    const doy = m.today.dayOfYear;
    const next = stepYear(GREGORIAN, m.year, doy, 1);
    const ny = yearFacts(GREGORIAN, m.year.index + 1)!;
    expect(next).toBe(ny.start + doy);
    const prev = stepYear(GREGORIAN, m.year, doy, -1);
    expect(prev).toBe(yearFacts(GREGORIAN, m.year.index - 1)!.start + doy);
    expect(stepYear(GREGORIAN, m.year, doy, 0)).toBe(20000);
  });

  test("Gregorian: the last day of a leap year lands on the last day of the next, not past it", () => {
    const m = model(GREGORIAN, 20000);
    expect(m.year.length).toBe(366);
    const next = stepYear(GREGORIAN, m.year, 365, 1);
    const ny = yearFacts(GREGORIAN, m.year.index + 1)!;
    expect(ny.length).toBe(365);
    expect(next).toBe(ny.start + 364);
    expect(model(GREGORIAN, next).year.index).toBe(m.year.index + 1);
  });

  test("Hebrew: day 380 of a 385-day year clamps into a shorter year", () => {
    const m = model(HEBREW, 20708); // 5787 starts on D20708, 385 days
    expect(m.year.start).toBe(20708);
    expect(m.year.length).toBe(385);
    const next = stepYear(HEBREW, m.year, 380, 1);
    const ny = yearFacts(HEBREW, m.year.index + 1)!;
    expect(ny.length).toBeLessThan(385);
    expect(next).toBe(ny.start + ny.length - 1);
  });

  test("a year past the day line leaves the day where it was", () => {
    const m = model(GREGORIAN, DAY_LIMIT - 10);
    expect(stepYear(GREGORIAN, m.year, m.today.dayOfYear, 1)).toBe(DAY_LIMIT - 10);
  });
});

describe("scrub bar", () => {
  test("a press at a fraction names a day of the shown year, clamped into it", () => {
    const y = model(GREGORIAN, 20000).year;
    expect(scrubDay(y, 0)).toBe(y.start);
    expect(scrubDay(y, 0.5)).toBe(y.start + Math.floor(0.5 * y.length));
    expect(scrubDay(y, 1)).toBe(y.start + y.length - 1);
    expect(scrubDay(y, -3)).toBe(y.start);
    expect(scrubDay(y, 9)).toBe(y.start + y.length - 1);
    expect(scrubDay(y, Number.NaN)).toBe(y.start);
  });

  test("the playhead is the day's place in the year, and a press there names that day again", () => {
    const m = model(GREGORIAN, 20000);
    const f = scrubFraction(m.year, 20000.5);
    expect(f).toBeCloseTo((20000.5 - m.year.start) / m.year.length, 9);
    expect(scrubDay(m.year, f)).toBe(20000);
  });

  test("Gregorian: twelve month segments tiling the year, the day's month current", () => {
    const m = model(GREGORIAN, 20000);
    const segs = scrubSegments(GREGORIAN, m.year, m.today);
    expect(segs).toHaveLength(12);
    expect(sum(segs.map((s) => s.width))).toBeCloseTo(1, 9);
    expect(segs.filter((s) => s.kind === "current")).toHaveLength(1);
    const cur = segs.find((s) => s.kind === "current")!;
    const at = (20000 - m.year.start) / m.year.length;
    expect(at).toBeGreaterThanOrEqual(cur.left);
    expect(at).toBeLessThan(cur.left + cur.width);
    // February takes the rest of the year; no month is a filler
    expect(segs.filter((s) => s.kind === "rest").map((s) => s.name)).toEqual(["February"]);
    expect(segs.some((s) => s.kind === "filler")).toBe(false);
    // the others alternate by place in the year
    expect(segs.slice(2, 5).map((s) => s.kind)).toEqual(["even", "odd", "even"]);
  });

  test("Harptos: festival days are filler segments", () => {
    const m = model(HARPTOS, 100);
    const segs = scrubSegments(HARPTOS, m.year, m.today);
    expect(segs.filter((s) => s.kind === "filler").length).toBeGreaterThan(0);
    expect(sum(segs.map((s) => s.width))).toBeCloseTo(1, 9);
  });

  test("a month that takes the rest is a rest segment", () => {
    const m = model(LUNAR, 30);
    const segs = scrubSegments(LUNAR, m.year, m.today);
    expect(segs.at(-1)).toMatchObject({ kind: "rest", name: "M12" });
  });
});

describe("season strip", () => {
  test("the marks tile the year; the days before the first mark wear the last season", () => {
    const m = model(LUNAR, 30);
    const segs = seasonSegments(m.year);
    expect(m.year.seasons.length).toBe(3);
    expect(sum(segs.map((s) => s.width))).toBeCloseTo(1, 9);
    const first = [...m.year.seasons].sort((a, b) => a.at - b.at);
    if (first[0]!.at > 0) expect(segs[0]).toMatchObject({ left: 0, name: first.at(-1)!.name, colour: SEASON_COLOURS[first.at(-1)!.order] });
  });

  test("no seasons, no strip", () => {
    expect(seasonSegments(model(GREGORIAN, 20000).year)).toEqual([]);
  });
});

describe("fit", () => {
  test("the handoff's 1200 px in a wide box, capped at the box − 16 in a narrow one", () => {
    expect(orreryFit(1560, 900)).toEqual({ width: 1200, bodyHeight: 640, scope: true });
    expect(orreryFit(1100, 700)).toEqual({ width: 1084, bodyHeight: 588, scope: true });
  });

  test("the body height stays between 480 and 640 px", () => {
    expect(orreryFit(1560, 2000).bodyHeight).toBe(640);
    expect(orreryFit(1560, 300).bodyHeight).toBe(480);
  });

  test("the scope goes once the centre column would fall under 280 px", () => {
    expect(orreryFit(800, 900).scope).toBe(true); // 784 − 2 − 500 = 282
    expect(orreryFit(796, 900).scope).toBe(false); // 780 − 2 − 500 = 278
    expect(orreryFit(600, 900)).toMatchObject({ width: 584, scope: false });
  });
});
