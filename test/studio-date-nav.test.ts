/**
 * Studio date navigation (bead wadjet-n1z): the go-to box's parse, the window
 * move it makes, the settle-on-year arithmetic a wheel zoom or ruler drag
 * comes to rest by, and the day card's title in the calendar's own words.
 */
import { describe, expect, test } from "bun:test";
import { GREGORIAN, print } from "../src/seshat";
import { InternalCalendar } from "../src/plugin/time/internal";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { dayTitle, goToWindow, parseGoTo } from "../src/studio/model/date-nav";
import { constantYears, engineYears } from "../src/studio/model/years";
import { centreOn, settleOnYears, width, worldBounds } from "../src/studio/model/zoom";

const gregorian = new SeshatCalendar(print(GREGORIAN), () => 0);
const internal = new InternalCalendar(structuredClone(DEFAULT_SETTINGS.calendar), () => 0);
const DAY = 19_783; // 2024-03-01 on the Gregorian definition

describe("the go-to box reads a date as the calendar writes it", () => {
  test("a definition world: its own format round-trips through its own parse", () => {
    const text = gregorian.format(DAY);
    expect(text).toBe("2024-03-01");
    expect(parseGoTo(text, (t) => gregorian.parse(t))).toEqual({ ok: true, day: DAY });
    expect(parseGoTo(`  ${text} `, (t) => gregorian.parse(t))).toEqual({ ok: true, day: DAY });
  });

  test("the legacy calendar: its format (season included) and its Y-D form", () => {
    const text = internal.format(400);
    expect(parseGoTo(text, (t) => internal.parse(t))).toEqual({ ok: true, day: 400 });
    const [y, d] = /^Year (-?\d+), day (\d+)/.exec(text)!.slice(1);
    expect(parseGoTo(`${y}-${d}`, (t) => internal.parse(t))).toEqual({ ok: true, day: 400 });
  });

  test("a whole day number is accepted with or without a calendar parse", () => {
    expect(parseGoTo("1234")).toEqual({ ok: true, day: 1234 });
    expect(parseGoTo("-12", () => null)).toEqual({ ok: true, day: -12 });
  });

  test("anything else is a short message, never a throw", () => {
    expect(parseGoTo("")).toEqual({ ok: false, message: "type a date" });
    expect(parseGoTo("   ")).toEqual({ ok: false, message: "type a date" });
    expect(parseGoTo("Thursday", (t) => gregorian.parse(t))).toEqual({ ok: false, message: "not a date in this calendar" });
    expect(parseGoTo("2024-13-45", (t) => gregorian.parse(t)).ok).toBe(false);
    expect(
      parseGoTo("x", () => {
        throw new Error("boom");
      }),
    ).toEqual({ ok: false, message: "not a date in this calendar" });
    expect(parseGoTo("1.5", () => 1.5)).toEqual({ ok: false, message: "not a date in this calendar" });
    expect(parseGoTo("99999999999999999999")).toEqual({ ok: false, message: "not a date in this calendar" });
  });
});

describe("going to a day centres the window on it and keeps the zoom", () => {
  const years = constantYears(365, 1);
  const bounds = worldBounds(1);

  test("the window's centre lands on the middle of the day, its width unchanged", () => {
    const w = { a: 3, b: 3 + 30 / 365 };
    const next = goToWindow(w, 730, years, bounds)!;
    expect((next.a + next.b) / 2).toBeCloseTo(years.dayMid(730), 12);
    expect(width(next)).toBeCloseTo(width(w), 12);
  });

  test("on exact years the day's own middle is used", () => {
    const seam = engineYears(gregorian)!;
    const w = { a: 2000, b: 2001 };
    const next = goToWindow(w, DAY, seam, worldBounds(1970))!;
    expect((next.a + next.b) / 2).toBeCloseTo(seam.dayMid(DAY), 12);
    expect(seam.dayAt((next.a + next.b) / 2)).toBe(DAY);
  });

  test("a day outside the timeline is refused, not clamped onto somewhere else", () => {
    expect(goToWindow({ a: 1, b: 2 }, 365 * 5000, years, bounds)).toBeNull();
    expect(goToWindow({ a: 1, b: 2 }, -365 * 500, years, bounds)).toBeNull();
    const throwing = { ...years, dayMid: () => { throw new RangeError("past the day limit"); } };
    expect(goToWindow({ a: 1, b: 2 }, 5, throwing, bounds)).toBeNull();
  });

  test("near an edge the window is clamped but still holds the day", () => {
    const w = { a: 10, b: 20 };
    const next = goToWindow(w, 0, years, bounds)!;
    expect(next.a).toBeGreaterThanOrEqual(bounds.min);
    expect(width(next)).toBeCloseTo(10, 9);
    expect(years.dayMid(0)).toBeGreaterThanOrEqual(next.a);
    expect(years.dayMid(0)).toBeLessThanOrEqual(next.b);
  });

  test("centreOn keeps the width", () => {
    const c = centreOn({ a: 0, b: 4 }, 100, worldBounds(1));
    expect(c).toEqual({ a: 98, b: 102 });
  });
});

describe("a wheel zoom or ruler drag settles on whole years", () => {
  const bounds = worldBounds(1000); // years 900 .. 2100

  test("a window a year wide or wider rests with both edges on year starts", () => {
    expect(settleOnYears({ a: 1203.4, b: 1204.4 }, bounds)).toEqual({ a: 1203, b: 1204 });
    expect(settleOnYears({ a: 1203.6, b: 1204.6 }, bounds)).toEqual({ a: 1204, b: 1205 });
    expect(settleOnYears({ a: 1200.3, b: 1203.1 }, bounds)).toEqual({ a: 1200, b: 1203 });
    const wide = settleOnYears({ a: 1210.2, b: 1351.9 }, bounds);
    expect(Number.isInteger(wide.a) && Number.isInteger(wide.b)).toBe(true);
    expect(width(wide)).toBe(142);
  });

  test("the centre moves by at most half a year", () => {
    for (const w of [{ a: 1007.31, b: 1009.02 }, { a: 1050.5, b: 1051.5 }, { a: 1100.01, b: 1112.77 }]) {
      const s = settleOnYears(w, bounds);
      expect(Math.abs((s.a + s.b) / 2 - (w.a + w.b) / 2)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(width(s) - width(w))).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  test("a window narrower than a year stays where the gesture left it", () => {
    const month = { a: 1012.3, b: 1012.3 + 30 / 365 };
    expect(settleOnYears(month, bounds)).toBe(month);
    const season = { a: 1012.1, b: 1012.6 };
    expect(settleOnYears(season, bounds)).toBe(season);
  });

  test("an already settled window comes back as the same object (no store write)", () => {
    const w = { a: 1005, b: 1007 };
    expect(settleOnYears(w, bounds)).toBe(w);
  });

  test("the result is clamped into the world's bounds", () => {
    const s = settleOnYears({ a: bounds.min - 0.4, b: bounds.min + 1.2 }, bounds);
    expect(s.a).toBeGreaterThanOrEqual(bounds.min);
    expect(width(s)).toBe(2);
  });
});

describe("the day card names its day in the calendar's format", () => {
  test("a definition world: the definition's default format", () => {
    expect(dayTitle(DAY, (d) => gregorian.format(d))).toBe("2024-03-01");
  });

  test("the legacy calendar: its own words", () => {
    expect(dayTitle(400, (d) => internal.format(d))).toBe(internal.format(400));
    expect(dayTitle(400, (d) => internal.format(d))).toMatch(/^Year \d+, day \d+/);
  });

  test("no format, an empty one, or one that throws: the bare day number", () => {
    expect(dayTitle(12)).toBe("Day 12");
    expect(dayTitle(12, () => "  ")).toBe("Day 12");
    expect(
      dayTitle(12, () => {
        throw new Error("bad format");
      }),
    ).toBe("Day 12");
  });
});
