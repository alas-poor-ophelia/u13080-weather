import { describe, expect, test } from "bun:test";
import { baseIndexAt, baseLengths, baseStart, DAY_LIMIT, Engine, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, linearBase, validate, type CalendarAst, type CrossingCycleAst } from "../src/seshat";

const DAY_MS = 86_400_000;

function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

const crossing = (n: number, d: number, an: number, ad: number): CrossingCycleAst => ({ id: "year", kind: "cycle", crossing: { period: { n, d }, at: { n: an, d: ad } } });

/** The reference: crossing k at exactly (at + k·period), floored with BigInt, so no float or rounding is involved. */
function bigStart(u: CrossingCycleAst, k: number): number {
  const { period: p, at } = u.crossing;
  const num = BigInt(at.n) * BigInt(p.d) + BigInt(k) * BigInt(p.n) * BigInt(at.d);
  const den = BigInt(at.d) * BigInt(p.d);
  const q = num / den;
  return Number(num % den !== 0n && num < 0n ? q - 1n : q);
}

describe("seshat: crossing base (§2.3.2)", () => {
  const cases = [crossing(18_262_101, 50_000, -186_473_123, 2880), crossing(765_433, 25_920, 5_263, 25_920), crossing(7, 1, 3, 1), crossing(10, 3, -1, 3), crossing(3, 2, 0, 1)];

  test("starts match an exact BigInt floor, and the inverse is exact on a start, the day before it, and the last day of the occurrence", () => {
    for (const u of cases) {
      const b = linearBase(u);
      for (const k of [-30_000, -1234, -1, 0, 1, 2, 999, 27_000]) {
        const s = baseStart(b, k);
        expect(s).toBe(bigStart(u, k));
        expect(baseIndexAt(b, s)).toBe(k);
        expect(baseIndexAt(b, s - 1)).toBe(k - 1);
        expect(baseIndexAt(b, baseStart(b, k + 1) - 1)).toBe(k);
      }
    }
  });

  test("a crossing exactly on a day boundary starts that day", () => {
    // period 3/2 from instant 0: crossings at 0, 1.5, 3, 4.5 → days 0, 1, 3, 4
    const b = linearBase(crossing(3, 2, 0, 1));
    expect([0, 1, 2, 3].map((k) => baseStart(b, k))).toEqual([0, 1, 3, 4]);
    expect([0, 1, 2, 3, 4].map((d) => baseIndexAt(b, d))).toEqual([0, 1, 1, 2, 3]);
  });

  test("occurrences are floor(P) or ceil(P) long, one length when P is whole", () => {
    expect(baseLengths(linearBase(crossing(18_262_101, 50_000, 0, 1)))).toEqual([365, 366]);
    expect(baseLengths(linearBase(crossing(7, 1, 3, 1)))).toEqual([7]);
    const e = new Engine({ name: "t", gears: [], units: [crossing(18_262_101, 50_000, -186_473_123, 2880)] });
    for (let k = -27_000; k < 27_000; k += 37) expect([365, 366]).toContain(e.length("year", k));
  });

  test("an engine year on a crossing base agrees with a brute-force scan of starts over ±DAY_LIMIT", () => {
    const u = cases[0]!;
    const e = new Engine({ name: "t", gears: [], units: [u] });
    for (let d = -DAY_LIMIT; d <= DAY_LIMIT; d += 4_999) {
      const i = e.indexAt("year", d);
      expect(bigStart(u, i)).toBeLessThanOrEqual(d);
      expect(bigStart(u, i + 1)).toBeGreaterThan(d);
    }
  });
});

describe("seshat: validator, one base (V8) and crossing magnitudes (V5)", () => {
  const months: CalendarAst["units"][number] = { id: "month", kind: "slots", in: "year", slots: [...Array.from({ length: 12 }, () => ({ length: 30 })), { length: "slack" as const, filler: true }] };

  test("a valid crossing year with slots under it", () => {
    expect(validate({ name: "t", gears: [], units: [crossing(18_262_101, 50_000, 0, 1), months] })).toEqual([]);
  });

  test("slots must fit both lengths a crossing year can have", () => {
    const fixed = { ...months, slots: [...Array.from({ length: 12 }, () => ({ length: 30 })), { length: 5 }] } as CalendarAst["units"][number];
    expect(validate({ name: "t", gears: [], units: [crossing(18_262_101, 50_000, 0, 1), fixed] }).join()).toContain("its parent occurrence is 366");
  });

  test("no base, two bases, a sub-day period, a non-reduced or too-fine rational are refused", () => {
    const v = (u: unknown) => validate({ name: "t", gears: [], units: [u as CrossingCycleAst] }).join();
    expect(v({ id: "year", kind: "cycle" })).toContain("needs a base");
    expect(v({ id: "year", kind: "cycle", anchor: 0, length: 365, crossing: { period: { n: 365, d: 1 }, at: { n: 0, d: 1 } } })).toContain("one base");
    expect(v(crossing(1, 2, 0, 1))).toContain("shorter than one day");
    expect(v(crossing(730, 2, 0, 1))).toContain("lowest terms");
    expect(v(crossing(29_530_588_853, 1_000_000_000, 1, 7))).toContain("too fine");
    expect(v(crossing(365, 1, DAY_LIMIT * 2, 1))).toContain("outside");
  });

  test("malformed crossings are reported, not thrown", () => {
    const v = (crossing: unknown) => validate({ name: "t", gears: [], units: [{ id: "year", kind: "cycle", crossing } as unknown as CrossingCycleAst] }).join();
    expect(v(null)).toContain("needs a base");
    expect(v({ period: { n: 365, d: 1 } })).toContain("a period and an instant");
    expect(v({ period: 365, at: { n: 0, d: 1 } })).toContain("a period and an instant");
  });

  test("V5 counts the indices gear terms make reachable: a fine crossing that shrinks to one day is too fine", () => {
    // 365.24219001 days over 10^8; a gear takes 364 days off every year, so years can be 1 day and k reaches ~3·10^7
    const fine = { id: "year", kind: "cycle" as const, crossing: { period: { n: 36_524_219_001, d: 100_000_000 }, at: { n: 0, d: 1 } } };
    const every: CalendarAst["gears"][number] = { id: "g", on: "year", kind: "intervals", terms: [{ every: 1, sign: 1 }] };
    expect(validate({ name: "t", gears: [], units: [fine] })).toEqual([]);
    expect(validate({ name: "t", gears: [every], units: [{ ...fine, gears: [{ gear: "g", add: -364 }] }] }).join()).toContain("too fine");
  });
});

describe("seshat: French Republican, equinox rule", () => {
  const eq = new Engine(FRENCH_REPUBLICAN_EQUINOX);
  const romme = new Engine(FRENCH_REPUBLICAN);

  // What this table can and cannot show (scanned 2026-10-18): any crossing-0 time from 08:07 to 12:22
  // reproduces I–XIV, for any period from 365.2420 to a Julian 365.25. It checks the crossing base, the
  // months and the decree's instant; it says nothing about the sun model. That gate is wadjet-01k.9.
  test("the AST is valid, and 1 Vendémiaire of every year as used (I–XIV) falls on its recorded day", () => {
    expect(validate(FRENCH_REPUBLICAN_EQUINOX)).toEqual([]);
    const used: Array<[number, number, number]> = [
      [1792, 9, 22], [1793, 9, 22], [1794, 9, 22], [1795, 9, 23], [1796, 9, 22], [1797, 9, 22], [1798, 9, 22],
      [1799, 9, 23], [1800, 9, 23], [1801, 9, 23], [1802, 9, 23], [1803, 9, 24], [1804, 9, 23], [1805, 9, 23],
    ];
    used.forEach(([y, m, d], i) => expect(eq.start("year", i)).toBe(gregorianDay(y, m, d)));
  });

  test("its leap years among I–XIV are III, VII and XI, where Romme has IV, VIII and XII", () => {
    const leaps = (e: Engine) => Array.from({ length: 14 }, (_, i) => i + 1).filter((y) => e.length("year", y - 1) === 366);
    expect(leaps(eq)).toEqual([3, 7, 11]);
    expect(leaps(romme)).toEqual([4, 8, 12]);
  });

  test("a pure crossing base needs no correction steps, and months and décades sit on it unchanged", () => {
    const d = gregorianDay(1799, 11, 9); // 18 Brumaire VIII, as used
    expect(eq.positionOf("year", d)!.index + 1).toBe(8);
    expect(eq.positionOf("month", d)).toEqual({ index: 1, offset: 17 });
    expect(eq.positionOf("decade", d)).toEqual({ index: 1, offset: 7 });
    expect(eq.positionOf("decade", gregorianDay(1795, 9, 22))).toBeNull(); // the 6th sansculottide of III
  });
});
