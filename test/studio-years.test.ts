/**
 * The Studio's year seam, constant implementation (Seshat P3b step 0,
 * docs/SESHAT-v0.md §14.8): each method is, bit for bit (Object.is), the
 * expression the Studio uses today at the site it will replace, and the year
 * it names is the internal calendar's own year. The golden master
 * (golden-studio-years.test.ts) pins the sites themselves; this pins that
 * the seam reproduces them, so moving a site onto it moves no float.
 */
import { describe, expect, test } from "bun:test";
import { InternalCalendar } from "../src/plugin/time/internal";
import { dayOrdinalAt, fractionalYear, type SpanCalendar } from "../src/studio/model/spans";
import { constantYears, constantYearsFor, LEGACY_DAY_YEARS } from "../src/studio/model/years";

const LENGTHS = [1, 7, 360, 365, 365.25, 365.2422, 400, 1000.5];
const EPOCHS = [1, 0, -40, 1962];
const DAYS = [...Array.from({ length: 1201 }, (_, i) => i - 600), -10_000_000, -3_652_425, -1, 0, 1, 59.5, 0.25, 1e-9, 3_652_424, 9_999_999];
const same = (a: number, b: number) => Object.is(a, b);

describe("the constant seam reproduces today's formulas exactly", () => {
  for (const L of LENGTHS) {
    for (const E of EPOCHS) {
      test(`L = ${L}, epoch ${E}`, () => {
        const s = constantYears(L, E);
        const cal: SpanCalendar = { yearLength: L, epochYear: E, seasons: [], moons: [], eras: [] };
        expect([s.exact, s.epochYear, s.nominalLength]).toEqual([false, E, L]);
        for (const d of DAYS) {
          // model/spans.ts fractionalYear
          expect([d, same(s.fractionalYear(d), fractionalYear(d, cal))]).toEqual([d, true]);
          // ui/playlist.ts jumpToDay: epoch + (dayOrdinal + 0.5) / yearLength
          expect([d, same(s.dayMid(d), E + (d + 0.5) / L)]).toEqual([d, true]);
        }
        const xs = DAYS.map((d) => fractionalYear(d, cal)).concat([E, E + 0.5, E - 0.25, E + 1e-12, E + 2.999999]);
        for (const x of xs) {
          // model/spans.ts dayOrdinalAt
          expect([x, same(s.dayOf(x), dayOrdinalAt(x, cal))]).toEqual([x, true]);
          // ui/day-card.ts centreRoll: Math.floor((centre - grid.epochYear) * grid.yearLength)
          expect([x, same(s.dayAt(x), Math.floor((x - E) * L))]).toEqual([x, true]);
          // model/device-lanes.ts dragToWhen: Math.round((newFrom - year) * len), for the year of the span
          for (const year of [E - 1, E, E + 3]) expect([x, year, same(s.dayIndexAt(year, x), Math.round((x - year) * L))]).toEqual([x, year, true]);
        }
        // components/lane.ts DAY_YEARS = 1 / 365, whatever the year length
        expect(s.stepYears(E + 5)).toBe(1 / 365);
        expect(LEGACY_DAY_YEARS).toBe(1 / 365);
        expect(s.yearLength(E + 123)).toBe(L);
      });
    }
  }

  test("yearOf and yearStart name the internal calendar's own year", () => {
    for (const L of [360, 365, 365.25, 400, 7]) {
      for (const E of [1, -40]) {
        const s = constantYears(L, E);
        const legacy = new InternalCalendar({ yearLength: L, epochYear: E, moons: [], seasons: [] }, () => 0);
        for (const d of DAYS.filter(Number.isInteger)) {
          const c = legacy.toContext(d);
          const y = s.yearOf(d);
          expect([L, d, y.year, y.length]).toEqual([L, d, c.year!, L]);
          expect([L, d, same(d - y.start, c.dayOfYear!)]).toEqual([L, d, true]);
          expect([L, d, same(s.yearStart(y.year), y.start)]).toEqual([L, d, true]);
        }
      }
    }
  });
});

describe("constantYearsFor: the Studio's no-calendar case and its epoch fallback, in one place", () => {
  test("no description, or a year length that is not positive, is null", () => {
    expect(constantYearsFor(null)).toBeNull();
    expect(constantYearsFor(undefined, 5)).toBeNull();
    expect(constantYearsFor({ yearLength: 0 })).toBeNull();
    expect(constantYearsFor({ yearLength: -3 })).toBeNull();
    expect(constantYearsFor({ yearLength: Number.NaN })).toBeNull();
    expect(constantYearsFor({ yearLength: Infinity })).toBeNull();
  });

  test("the epoch is the description's, else the settings', else 1", () => {
    expect(constantYearsFor({ yearLength: 365, epochYear: 7 }, 3)!.epochYear).toBe(7);
    expect(constantYearsFor({ yearLength: 365 }, 3)!.epochYear).toBe(3);
    expect(constantYearsFor({ yearLength: 365 })!.epochYear).toBe(1);
    expect(constantYearsFor({ yearLength: 365, epochYear: 0 }, 3)!.epochYear).toBe(0);
  });

  test("constantYears refuses what is not a year", () => {
    expect(() => constantYears(0, 1)).toThrow(RangeError);
    expect(() => constantYears(365, Number.NaN)).toThrow(RangeError);
  });
});
