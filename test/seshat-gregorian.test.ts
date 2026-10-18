import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, Engine, gearBelow, gearDensity, gearDeviation, gearMatches, GREGORIAN, validate, type CalendarAst, type GearAst } from "../src/seshat";
import { MAX_DAY_ORDINAL } from "../src/plugin/world";

const DAY_MS = 86_400_000;
const greg = new Engine(GREGORIAN);

describe("seshat: gears", () => {
  const leap = GREGORIAN.gears[0]!;
  const islamic: GearAst = { id: "i", on: "year", kind: "positions", period: 30, positions: [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29] };

  test("the Gregorian leap gear matches the 4/100/400 rule", () => {
    for (const [y, l] of [[2000, true], [1900, false], [2024, true], [2023, false], [0, true], [-4, true], [-100, false], [-400, true]] as const) expect(gearMatches(leap, y)).toBe(l);
  });

  test("gearBelow(b) − gearBelow(a) counts matches in [a, b), negatives included", () => {
    for (const g of [leap, islamic]) {
      for (const [a, b] of [[0, 0], [0, 401], [-801, 3], [-30, -1], [-1, 0], [17, 1234]] as const) {
        let n = 0;
        for (let i = a; i < b; i++) if (gearMatches(g, i)) n++;
        expect(gearBelow(g, b) - gearBelow(g, a)).toBe(n);
      }
    }
  });

  test("gearDeviation bounds how far a count strays from its mean, offsets included", () => {
    const offset: GearAst = { id: "o", on: "year", kind: "intervals", terms: [{ every: 7, offset: -3, sign: 1 }, { every: 21, offset: 4, sign: -1 }] };
    for (const g of [leap, islamic, offset]) {
      for (let n = -5000; n <= 5000; n++) expect(Math.abs(gearBelow(g, n) - gearDensity(g) * n)).toBeLessThanOrEqual(gearDeviation(g));
    }
  });
});

describe("seshat: Gregorian against Date", () => {
  test("year, month, day of month and weekday agree over ±1,000,000 days", () => {
    let bad = 0;
    for (let d = -1_000_000; d <= 1_000_000; d++) {
      const t = new Date(d * DAY_MS);
      const y = greg.positionOf("year", d)!;
      const m = greg.positionOf("month", d)!;
      const w = greg.positionOf("week", d)!;
      if (y.index !== t.getUTCFullYear() || m.index !== t.getUTCMonth() || m.offset + 1 !== t.getUTCDate() || ((w.offset % 7) + 7) % 7 !== t.getUTCDay()) {
        if (bad++ < 5) expect({ d, year: y.index, month: m.index, dom: m.offset + 1, wd: w.offset }).toEqual({ d, year: t.getUTCFullYear(), month: t.getUTCMonth(), dom: t.getUTCDate(), wd: t.getUTCDay() });
      }
    }
    expect(bad).toBe(0);
  });

  test("dayOf inverts positionOf, and Date still agrees, out to ±10,000,000 days", () => {
    for (let d = -10_000_000; d <= 10_000_000; d += 9_973) {
      const y = greg.positionOf("year", d)!;
      const m = greg.positionOf("month", d)!;
      const t = new Date(d * DAY_MS);
      expect([y.index, m.index, m.offset + 1]).toEqual([t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()]);
      expect(greg.dayOf("month", [y.index], m.index, m.offset)).toBe(d);
      expect(greg.start("year", y.index + 1) - greg.start("year", y.index)).toBe(greg.length("year", y.index));
    }
  });

  test("February is the slack: 29 days in a leap year, 28 otherwise", () => {
    expect(greg.slotLengths("month", [2024])[1]).toBe(29);
    expect(greg.slotLengths("month", [1900])[1]).toBe(28);
    expect(greg.length("year", 2000)).toBe(366);
  });

  test("days and slot addresses outside the calendar are refused, not wrapped", () => {
    expect(() => greg.positionOf("year", 0.5)).toThrow(RangeError);
    expect(() => greg.positionOf("year", Number.NaN)).toThrow(RangeError);
    expect(() => greg.positionOf("year", DAY_LIMIT + 1)).toThrow(RangeError);
    expect(() => greg.dayOf("month", [2023], 1, 28)).toThrow(RangeError); // 29 February 2023
    expect(() => greg.dayOf("month", [2023], 12, 0)).toThrow(RangeError);
    expect(greg.dayOf("month", [2024], 1, 28)).toBe(Date.UTC(2024, 1, 29) / DAY_MS);
  });

  test("DAY_LIMIT is Wadjet's MAX_DAY_ORDINAL", () => {
    expect(DAY_LIMIT).toBe(MAX_DAY_ORDINAL);
  });
});

describe("seshat: validator", () => {
  const base = GREGORIAN;
  const withUnits = (units: CalendarAst["units"], gears: CalendarAst["gears"] = base.gears): CalendarAst => ({ name: "t", gears, units });

  test("the Gregorian AST is valid", () => {
    expect(validate(GREGORIAN)).toEqual([]);
  });

  test("an occurrence that can be shorter than one day is refused (V3)", () => {
    const errs = validate(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 1, gears: [{ gear: "leap", add: -1 }] }]));
    expect(errs.join()).toContain("at least one day");
    expect(() => new Engine(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 0 }], []))).toThrow(RangeError);
  });

  test("slots that do not fill the parent are refused, per gear state", () => {
    const months = base.units[1]!;
    if (months.kind !== "slots") throw new Error("fixture");
    const noSlack = { ...months, slots: months.slots.map((s) => (s.length === "slack" ? { ...s, length: 28 } : s)) };
    expect(validate(withUnits([base.units[0]!, noSlack])).join()).toContain("leap=1");
    const tooLong = { ...months, slots: [...months.slots, { name: "Extra", length: 30 }] };
    expect(validate(withUnits([base.units[0]!, tooLong])).join()).toContain("slots total");
  });

  test("references, anchors and gear nesting are checked", () => {
    expect(validate(withUnits([{ id: "m", kind: "slots", in: "nope", slots: [{ length: "slack" }] }])).join()).toContain('no parent unit "nope"');
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: 0.5, length: 365 }], [])).join()).toContain("anchor");
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 365, gears: [{ gear: "ghost", add: 1 }] }], [])).join()).toContain('no gear "ghost"');
    const bad: GearAst = { id: "g", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }, { every: 6, sign: 1 }] };
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 365, gears: [{ gear: "g", add: 1 }] }], [bad])).join()).toContain("must nest");
    expect(validate(withUnits([base.units[0]!, base.units[0]!])).join()).toContain("more than once");
  });

  test("magnitudes that could overflow safe integers are refused (V5)", () => {
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: DAY_LIMIT + 1, length: 365 }], [])).join()).toContain("anchor");
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 1e15 }], [])).join()).toContain("length");
    expect(validate(withUnits([{ id: "year", kind: "cycle", anchor: 0, length: 365, gears: [{ gear: "leap", add: 1e15 }] }])).join()).toContain("adds");
  });

  test("a slack slot with gear terms, and a gear on a slot unit, are refused", () => {
    const months = base.units[1]!;
    if (months.kind !== "slots") throw new Error("fixture");
    const slackGear = { ...months, slots: months.slots.map((s) => (s.length === "slack" ? { ...s, gears: [{ gear: "leap", add: 1 }] } : s)) };
    expect(validate(withUnits([base.units[0]!, slackGear])).join()).toContain("slack slot");
    const onMonth: GearAst = { id: "g", on: "month", kind: "positions", period: 12, positions: [1] };
    expect(validate(withUnits([base.units[0]!, months], [...base.gears, onMonth])).join()).toContain("not a cycle unit");
  });

  test("an error in one unit does not hide another unit's slot sums, whatever the order", () => {
    const months = base.units[1]!;
    if (months.kind !== "slots") throw new Error("fixture");
    const short = { ...months, id: "m2", slots: [{ length: 10 }] };
    const broken = { id: "other", kind: "cycle" as const, anchor: 0.5, length: 7 };
    for (const units of [[broken, base.units[0]!, short], [base.units[0]!, short, broken]]) {
      const errs = validate(withUnits(units)).join();
      expect(errs).toContain("anchor");
      expect(errs).toContain('unit "m2": slots total 10');
    }
  });

  test("a positions gear drives a calendar end to end: starts, lengths and indices agree", () => {
    const tabular: CalendarAst = {
      name: "30-year cycle",
      gears: [{ id: "leap", on: "year", kind: "positions", period: 30, positions: [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29] }],
      units: [{ id: "year", kind: "cycle", anchor: -500_000, length: 354, gears: [{ gear: "leap", add: 1 }] }],
    };
    const e = new Engine(tabular);
    expect(e.start("year", 30) - e.start("year", 0)).toBe(30 * 354 + 11);
    for (let d = -DAY_LIMIT; d <= DAY_LIMIT; d += 7_919) {
      const i = e.indexAt("year", d);
      expect(e.start("year", i)).toBeLessThanOrEqual(d);
      expect(e.start("year", i) + e.length("year", i)).toBeGreaterThan(d);
      expect(e.length("year", i)).toBe(gearMatches(tabular.gears[0]!, i) ? 355 : 354);
    }
  });
});
