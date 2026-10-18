import { describe, expect, test } from "bun:test";
import { Engine, gearBelow, gearDensity, gearDeviation, gearMatches, ISLAMIC_CIVIL, ISLAMIC_TBLA, validate, type GearAst } from "../src/seshat";

const DAY_MS = 86_400_000;

/** ICU's reading of a day: [AH year, month 0-based, day of month]. */
function icu(calendar: string): (d: number) => [number, number, number] {
  const f = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  expect(f.resolvedOptions().calendar).toBe(calendar); // never compare against a silent fallback to gregory
  return (d) => {
    const parts = f.formatToParts(new Date(d * DAY_MS));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return [get("year"), get("month") - 1, get("day")];
  };
}

function seshat(e: Engine): (d: number) => [number, number, number] {
  return (d) => {
    const m = e.positionOf("month", d);
    return [e.positionOf("year", d).index + 1, m.index, m.offset + 1];
  };
}

function compare(calendar: string, e: Engine, from: number, to: number, stride: number): void {
  const want = icu(calendar);
  const got = seshat(e);
  let bad = 0;
  for (let d = from; d <= to; d += stride) {
    const [a, b] = [got(d), want(d)];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) if (bad++ < 5) expect({ d, seshat: a }).toEqual({ d, seshat: b });
  }
  expect(bad).toBe(0);
}

describe("seshat: tabular Islamic against ICU", () => {
  const civil = new Engine(ISLAMIC_CIVIL);
  const tbla = new Engine(ISLAMIC_TBLA);

  test("both ASTs are valid, and 1 Muharram 1 AH falls on the documented days", () => {
    expect(validate(ISLAMIC_CIVIL)).toEqual([]);
    expect(validate(ISLAMIC_TBLA)).toEqual([]);
    expect(civil.start("year", 0)).toBe(Date.UTC(622, 6, 19) / DAY_MS);
    expect(tbla.start("year", 0)).toBe(Date.UTC(622, 6, 18) / DAY_MS);
  });

  test("islamic-civil agrees on every day over ±1,000,000 days", () => {
    compare("islamic-civil", civil, -1_000_000, 1_000_000, 1);
  }, 60_000); // two million ICU calls

  test("islamic-tbla agrees over ±1,000,000 days (every 7th day: it differs from civil by epoch only)", () => {
    compare("islamic-tbla", tbla, -1_000_000, 1_000_000, 7);
  });

  test("both agree out to ±10,000,000 days, strided", () => {
    compare("islamic-civil", civil, -10_000_000, 10_000_000, 997);
    compare("islamic-tbla", tbla, -10_000_000, 10_000_000, 997);
  });

  test("leap years get 355 days and a 30-day Dhu al-Hijjah", () => {
    // AH 2 is the first leap year, i.e. year index 1
    expect(civil.length("year", 0)).toBe(354);
    expect(civil.length("year", 1)).toBe(355);
    expect(civil.slotLengths("month", 1)[11]).toBe(30);
    expect(civil.start("year", 30) - civil.start("year", 0)).toBe(10_631);
  });
});

describe("seshat: a positions gear with an offset", () => {
  const g: GearAst = { id: "g", on: "year", kind: "positions", period: 30, positions: [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29], offset: -1 };

  test("matches (n − offset) mod period, and gearBelow still counts [a, b)", () => {
    expect(gearMatches(g, 1)).toBe(true); // year 2
    expect(gearMatches(g, 2)).toBe(false);
    for (const [a, b] of [[0, 31], [-61, 0], [-7, 45], [13, 14]] as const) {
      let n = 0;
      for (let i = a; i < b; i++) if (gearMatches(g, i)) n++;
      expect(gearBelow(g, b) - gearBelow(g, a)).toBe(n);
    }
  });

  test("gearDeviation still bounds the count's distance from its mean", () => {
    for (const offset of [-1, 7, -45]) {
      const h = { ...g, offset };
      for (let n = -3000; n <= 3000; n++) expect(Math.abs(gearBelow(h, n) - gearDensity(h) * n)).toBeLessThanOrEqual(gearDeviation(h));
    }
  });

  test("a fractional offset is refused", () => {
    const errs = validate({ name: "t", gears: [{ ...g, offset: 0.5 }], units: [{ id: "year", kind: "cycle", anchor: 0, length: 354, gears: [{ gear: "g", add: 1 }] }] });
    expect(errs.join()).toContain("offset");
  });
});
