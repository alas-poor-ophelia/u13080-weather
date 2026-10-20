/**
 * Seshat P3b step 2 (docs/SESHAT-v0.md §14.8 C3, C6): the ruler's day ticks
 * and the header readout on exact years, and their legacy identity.
 *
 *   - with the constant seam, ticks and windowLabel equal today's output exactly
 *     (the golden master pins today's output itself);
 *   - on exact years every day tick sits on its day's own position, counted
 *     from each year's d0, labelled with its day of that year, never within
 *     half a step of the next d0, and thinned by its place in its year;
 *   - the readout counts a 366-day year in 366 days.
 */
import { describe, expect, test } from "bun:test";
import { GREGORIAN, HEBREW, print } from "../src/seshat";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { dayLabel, windowLabel } from "../src/studio/model/format";
import { constantYears, engineYears, openingWindow } from "../src/studio/model/years";
import { ticks, type Window } from "../src/studio/model/zoom";

const fmt = (L: number) => ({ year: (y: number) => String(y), day: (y: number, i: number) => `${y}:${i}:${dayLabel(i, L)}` });
const WINDOWS: Window[] = [
  { a: 2023.97, b: 2024.03 },
  { a: 2024.1, b: 2024.15 },
  { a: 2023.5, b: 2024.5 },
  { a: 2024.9, b: 2025.1 },
  { a: 2024.15, b: 2024.17 },
];
const WIDTHS = [400, 800, 1600];

describe("with the constant seam the ruler and the readout are today's, exactly", () => {
  for (const L of [360, 365, 365.25, 400]) {
    test(`L = ${L}`, () => {
      const seam = constantYears(L, 1);
      for (const w of WINDOWS.map((x) => ({ a: x.a - 2023, b: x.b - 2023 }))) {
        for (const px of WIDTHS) expect(ticks(w, px, fmt(L), seam)).toEqual(ticks(w, px, fmt(L)));
        expect(windowLabel(w.a, w.b, L, seam)).toBe(windowLabel(w.a, w.b, L));
      }
    });
  }
});

describe("day ticks on exact years", () => {
  const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
  const years = engineYears(cal)!;
  const label = { year: (y: number) => String(y), day: (y: number, i: number) => `${y}:${i}` };

  test("every tick sits on its day's own position, restarts at each d0, and keeps clear of the next d0", () => {
    for (const w of WINDOWS) {
      for (const px of WIDTHS) {
        const plan = ticks(w, px, label, years);
        expect(plan.length).toBeGreaterThan(0);
        // a year-step plan is the integer years either way: exact years change nothing there
        const legacy = ticks(w, px, label);
        if (legacy.every((t) => !t.label.includes(":"))) {
          expect(plan).toEqual(legacy);
          continue;
        }
        const step = plan.length > 1 ? Math.min(...plan.slice(1).map((t, i) => t.year - plan[i]!.year)) : 0;
        for (const t of plan) {
          const Y = Math.floor(t.year + 1e-9);
          const L = years.yearLength(Y);
          const k = years.dayAt(t.year) - years.yearStart(Y);
          // on a day edge: the position of whole day k of its year, bit for bit
          expect([t.year, Object.is(t.year, years.fractionalYear(years.yearStart(Y) + k))]).toEqual([t.year, true]);
          if (t.label !== "") expect(t.label).toBe(`${Y}:${k}`);
          // never within half a step of the next year's d0 (unless it is d0 itself)
          if (k > 0 && step > 0) expect(Y + 1 - t.year).toBeGreaterThanOrEqual((step * L) / L / 2 - 1e-12);
          expect(t.year >= w.a - 1e-9 && t.year <= w.b + 1e-9).toBe(true);
        }
        // a year whose d0 is in the window has a tick on it, labelled
        for (let Y = Math.ceil(w.a); Y <= Math.floor(w.b); Y++) {
          const d0 = plan.find((t) => t.year === Y);
          expect([Y, d0 !== undefined]).toEqual([Y, true]);
          expect([Y, d0!.major, d0!.label]).toEqual([Y, true, `${Y}:0`]);
        }
      }
    }
  });

  test("29 February 2024 has its own tick, labelled d59, at 2024 + 59/366", () => {
    const plan = ticks({ a: 2024.155, b: 2024.17 }, 1600, label, years);
    const feb29 = plan.find((t) => t.label === "2024:59");
    expect(feb29).toBeDefined();
    expect(feb29!.year).toBe(2024 + 59 / 366);
    expect(cal.format(years.dayAt(feb29!.year))).toBe("2024-02-29");
  });

  test("the last tick of a 366-day year at a 5-day step: d365 is too close to d0 of 2025 and is dropped", () => {
    // 5-day step needs 4.5 < px per day <= 26: a 0.2-year window at 800 px is about 11 px per day
    const plan = ticks({ a: 2024.9, b: 2025.1 }, 800, label, years);
    const late2024 = plan.filter((t) => Math.floor(t.year + 1e-9) === 2024).map((t) => years.dayAt(t.year) - years.yearStart(2024));
    expect(late2024.every((k) => k % 5 === 0)).toBe(true);
    expect(late2024.at(-1)).toBe(360);
    expect(plan.some((t) => t.year === 2025)).toBe(true);
  });

  test("labels thin by place in the year, so panning does not move them", () => {
    const a = ticks({ a: 2024.0, b: 2024.25 }, 300, label, years).filter((t) => t.major).map((t) => t.label);
    const b = ticks({ a: 2024.01, b: 2024.26 }, 300, label, years).filter((t) => t.major).map((t) => t.label);
    const common = a.filter((x) => b.includes(x));
    expect(common.length).toBeGreaterThan(2);
    // every label present in both windows is labelled in both
    for (const x of a) if (b.some((y) => y === x)) expect(b).toContain(x);
  });

  test("when labels thin (a 15-day step below 1.6 px per day), panning by one tick keeps every label where it was", () => {
    // 800 px over 1.7 years is about 1.29 px per day: a 15-day step, about 40 ticks for 33 label slots
    const w1 = { a: 2023.4, b: 2023.4 + 1.7 };
    const p1 = ticks(w1, 800, label, years);
    const p2 = ticks({ a: w1.a + 15 / 365, b: w1.b + 15 / 365 }, 800, label, years);
    expect(p1.some((t) => !t.major)).toBe(true); // it really thins
    const major1 = new Map(p1.map((t) => [t.year, t.major]));
    let shared = 0;
    for (const t of p2) {
      if (!major1.has(t.year)) continue;
      shared++;
      expect([t.year, t.major]).toEqual([t.year, major1.get(t.year)!]);
    }
    expect(shared).toBeGreaterThan(20);
  });

  test("Hebrew: a 385-day year and a 354-day year each get their own count", () => {
    const h = new SeshatCalendar(print(HEBREW), () => 0);
    const hy = engineYears(h)!;
    const lengths = new Map<number, number>();
    for (let Y = hy.epochYear - 5; Y <= hy.epochYear + 5; Y++) lengths.set(Y, hy.yearLength(Y));
    const [long] = [...lengths].find(([, L]) => L >= 383)!;
    const plan = ticks({ a: long + 0.95, b: long + 1.02 }, 1600, label, hy);
    const lastOfLong = plan.filter((t) => Math.floor(t.year + 1e-9) === long).at(-1)!;
    expect(hy.dayAt(lastOfLong.year) - hy.yearStart(long)).toBe(lengths.get(long)! - 1);
  });
});

describe("the header readout on exact years", () => {
  const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
  const years = engineYears(cal)!;

  test("a whole leap year reads d0 – d366; a whole common year d0 – d365", () => {
    expect(windowLabel(2024, 2025, 365, years)).toBe("d0 – d366 · 2024");
    expect(windowLabel(2023, 2024, 365, years)).toBe("d0 – d365 · 2023");
    // the constant reading, for contrast: 365 days whatever the year
    expect(windowLabel(2024, 2025, 365)).toBe("d0 – d365 · 2024");
  });

  test("the day under the centre counts in the centre year's own length", () => {
    const feb29 = years.fractionalYear(years.yearStart(2024) + 59.5);
    expect(windowLabel(feb29 - 2 / 366, feb29 + 2 / 366, 365, years)).toBe("day 60 · 2024");
  });
});

describe("the readout writes the calendar's own dates on exact years (bead wadjet-qfk)", () => {
  const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
  const years = engineYears(cal)!;
  const fmt = (d: number) => cal.format(d);

  test("a whole year, two years, and the day view", () => {
    expect(windowLabel(2024, 2025, 365, years, fmt)).toBe("2024-01-01 – 2024-12-31");
    // the Guildmaster's live-check window: was "d0 – d722 · 2024"; 2025.97 lies inside day 354 of 2025
    // (21 December, starting at 354/365 = 0.9699), which is on screen, so it is the last day shown
    expect(windowLabel(2024, 2025.97, 365, years, fmt)).toBe("2024-01-01 – 2025-12-21");
    const feb27 = years.fractionalYear(years.yearStart(2024) + 57.5);
    expect(windowLabel(feb27 - 1 / 366, feb27 + 1 / 366, 365, years, fmt)).toBe("2024-02-27");
  });

  test("a window that ends exactly on a day edge does not show that day; wide windows keep bare years", () => {
    const s = years.yearStart(2024);
    expect(windowLabel(years.fractionalYear(s), years.fractionalYear(s + 31), 365, years, fmt)).toBe("2024-01-01 – 2024-01-31");
    expect(windowLabel(2020, 2030, 365, years, fmt)).toBe("2020 – 2030");
  });

  test("the constant seam ignores the formatter: a legacy readout is unchanged", () => {
    const seam = constantYears(365, 1);
    for (const [a, b] of [[1, 2], [1.5, 1.51], [2, 4]] as const) expect(windowLabel(a, b, 365, seam, () => "SHOULD NOT APPEAR")).toBe(windowLabel(a, b, 365));
  });
});

describe("a fresh Studio opens on the year that holds today (bead wadjet-xou)", () => {
  test("a legacy world opens on today's year, not the year before day 0", () => {
    expect(openingWindow(constantYears(365, 1), 3, { a: 0, b: 1 })).toEqual({ a: 1, b: 2 });
    expect(openingWindow(constantYears(365, 1), 800, { a: 0, b: 1 })).toEqual({ a: 3, b: 4 });
  });

  test("a definition world opens on its own year (the live check opened in 1924)", () => {
    const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
    const years = engineYears(cal)!;
    const today = years.yearStart(2024) + 57;
    expect(openingWindow(years, today, { a: 0, b: 1 })).toEqual({ a: 2024, b: 2025 });
  });

  test("no calendar or no current day keeps the fixed window", () => {
    expect(openingWindow(null, 3, { a: 0, b: 1 })).toEqual({ a: 0, b: 1 });
    expect(openingWindow(constantYears(365, 1), null, { a: 0, b: 1 })).toEqual({ a: 0, b: 1 });
    expect(openingWindow(constantYears(365, 1), undefined, { a: 0, b: 1 })).toEqual({ a: 0, b: 1 });
  });
});
