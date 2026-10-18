import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, Engine, ROMAN, validate, type CalendarAst, type CycleUnitAst } from "../src/seshat";
import { BENNETT, ROMAN_MONTHS } from "./fixtures/seshat-roman-bennett";

describe("seshat: Roman (Bennett's reconstruction)", () => {
  const rome = new Engine(ROMAN);
  const year = (auc: number) => BENNETT.find(([a]) => a === auc)!;

  test("the AST is valid, and the slot names are Bennett's months", () => {
    expect(validate(ROMAN)).toEqual([]);
    const months = ROMAN.units[1]!;
    expect(months.kind === "slots" && months.slots.map((s) => s.name)).toEqual([...ROMAN_MONTHS]);
  });

  test("every month of every year Bennett gives (AUC 492–813) begins on his day", () => {
    let bad = 0;
    for (const [auc, , starts] of BENNETT) {
      starts.forEach((d, slot) => {
        if (d === null) return;
        const got = rome.dayOf("month", [auc], slot, 0);
        if (got !== d) if (bad++ < 5) expect({ auc, month: ROMAN_MONTHS[slot], got }).toEqual({ auc, month: ROMAN_MONTHS[slot], got: d });
      });
      // and a month he leaves out has no days that year
      starts.forEach((d, slot) => {
        if (d === null) expect(rome.slotLengths("month", [auc])[slot]).toBe(0);
      });
    }
    expect(bad).toBe(0);
  });

  test("every day from AUC 492 to 812 reads the month Bennett's starts put it in", () => {
    let bad = 0;
    for (let i = 0; i + 1 < BENNETT.length; i++) {
      const [auc, , starts] = BENNETT[i]!;
      const next = BENNETT[i + 1]![2][0]!;
      const present = starts.flatMap((d, slot) => (d === null ? [] : [{ d, slot }]));
      present.forEach(({ d, slot }, j) => {
        const end = present[j + 1]?.d ?? next;
        for (let day = d; day < end; day++) {
          const y = rome.positionOf("year", day)!.index;
          const m = rome.positionOf("month", day)!;
          if (y !== auc || m.index !== slot || m.offset !== day - d) if (bad++ < 5) expect({ day, y, m }).toEqual({ day, y: auc, m: { index: slot, offset: day - d } });
        }
      });
    }
    expect(bad).toBe(0);
  });

  test("46 BC is 445 days; the year before the Julian switch comes out 365, derived, not entered", () => {
    expect(rome.length("year", 708)).toBe(445);
    expect(rome.length("year", 753)).toBe(365);
    expect(rome.start("year", 754)).toBe(year(754)[2][0]!);
    expect(year(708)[2][12]).not.toBeNull(); // the two extra months of the year of confusion
  });

  test("the record joins the Republican ideal before it and proleptic Julian after it exactly", () => {
    expect(rome.start("year", 492)).toBe(year(492)[2][0]!);
    expect([488, 489, 490, 491].map((k) => rome.length("year", k))).toEqual([355, 377, 355, 378]);
    for (const k of [754, 755, 756, 757, 2000]) expect(rome.length("year", k)).toBe((k - 753) % 4 === 0 ? 366 : 365);
  });

  test("Bennett's uncertainty flags are kept: 44 years, none after 191 BC (AUC 563)", () => {
    const uncertain = BENNETT.filter(([, u]) => u).map(([auc]) => auc);
    expect(uncertain.length).toBe(44);
    expect(Math.max(...uncertain)).toBe(563);
  });
});

describe("seshat: ledger (C6)", () => {
  const year = (ledger: CycleUnitAst["ledger"], extra: Partial<CycleUnitAst> = {}): CycleUnitAst => ({ id: "y", kind: "cycle", anchor: 0, length: 10, ledger, ...extra }) as CycleUnitAst;
  const months: CalendarAst["units"][number] = { id: "m", kind: "slots", in: "y", slots: [{ length: 4 }, { length: "slack" }] };
  const cal = (y: CycleUnitAst, more: Partial<CalendarAst> = {}): CalendarAst => ({ name: "t", gears: [], units: [y, months], ...more });

  test("pins replace starts and nothing else; a switch's rule is absolute; the inverse agrees with a scan of starts", () => {
    const e = new Engine(cal(year([{ kind: "starts", from: 3, startsOn: 31, lengths: [12, 8] }, { kind: "switch", from: 7, rule: { anchor: 5, length: 11 } }])));
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => e.start("y", k))).toEqual([0, 10, 20, 31, 43, 51, 60, 82, 93]);
    for (let d = -50; d < 200; d++) {
      let k = -10;
      while (e.start("y", k + 1) <= d) k++;
      expect(e.indexAt("y", d)).toBe(k);
    }
  });

  test("pins right before and right after a switch, and days far before the first anchor, invert exactly", () => {
    const e = new Engine(cal(year([{ kind: "starts", from: 4, startsOn: 41 }, { kind: "switch", from: 5, rule: { anchor: 3, length: 11 } }, { kind: "starts", from: 6, startsOn: 70 }])));
    expect([3, 4, 5, 6, 7].map((k) => e.start("y", k))).toEqual([30, 41, 58, 70, 80]);
    for (let d = -5000; d < 300; d++) {
      let k = -600;
      while (e.start("y", k + 1) <= d) k++;
      expect(e.indexAt("y", d)).toBe(k);
    }
  });

  test("a slot gear whose period differs from the cycle's gears is checked over their combined period (keyed or ledgered cycles too)", () => {
    // the cycle grows to 11 on odd k; slot 1 shrinks by 2 when k = 2 mod 3; slack takes at most 8: k = 5 is 11 days with slot 1 at 2
    const gears: CalendarAst["gears"] = [
      { id: "A", on: "y", kind: "intervals", terms: [{ every: 2, offset: 1, sign: 1 }] },
      { id: "B", on: "y", kind: "intervals", terms: [{ every: 3, offset: 2, sign: 1 }] },
    ];
    const y: CycleUnitAst = { id: "y", kind: "cycle", anchor: 0, length: 10, gears: [{ gear: "A", add: 1 }] };
    const slots = (keyed: boolean): CalendarAst["units"][number] => ({
      id: "m",
      kind: "slots",
      in: "y",
      slots: [{ length: 4, gears: [{ gear: "B", add: -2 }] }, { length: "slack", max: 8 }, ...(keyed ? [{ length: { by: "parent" as const, table: [[10, 0], [11, 0]] as [number, number][] } }] : [])],
    });
    expect(validate({ name: "t", gears, units: [y, slots(false)] }).join()).toContain("parent occurrence is 11");
    expect(validate({ name: "t", gears, units: [y, slots(true)] }).join()).toContain("parent occurrence is 11");
    expect(validate({ name: "t", gears, units: [{ ...y, ledger: [{ kind: "starts", from: 100, startsOn: 1051 }] }, slots(false)] }).join()).toContain("parent occurrence is 11");
  });

  test("V7: a pin that runs backwards, overlapping pins, a pin on a switch, switches out of order", () => {
    expect(validate(cal(year([{ kind: "starts", from: 3, startsOn: 19 }]))).join()).toContain("occurrence 2 would be -1 days long");
    expect(validate(cal(year([{ kind: "starts", from: 3, startsOn: 31, lengths: [10] }, { kind: "starts", from: 4, startsOn: 41 }]))).join()).toContain("pinned twice");
    expect(validate(cal(year([{ kind: "switch", from: 5, rule: { anchor: 0, length: 10 } }, { kind: "starts", from: 5, startsOn: 50 }]))).join()).toContain("both pinned and a switch");
    expect(validate(cal(year([{ kind: "switch", from: 5, rule: { anchor: 0, length: 10 } }, { kind: "switch", from: 2, rule: { anchor: 0, length: 9 } }]))).join()).toContain("increasing order");
    expect(validate(cal(year([{ kind: "switch", from: 5, rule: { anchor: 0, length: 0 } }]))).join()).toContain("at least one day");
  });

  test("months must fit every pinned year: a 3-day year has no room for a 4-day month", () => {
    expect(validate(cal(year([{ kind: "starts", from: 2, startsOn: 20, lengths: [3] }]))).join()).toContain("slots take at least 4 days but its parent occurrence is 3");
  });

  test("a slot override replaces one occurrence's slots and must fill it", () => {
    const e = new Engine(cal(year([{ kind: "slots", from: 2, unit: "m", lengths: [7, 3] }])));
    expect(e.slotLengths("m", [2])).toEqual([7, 3]);
    expect(e.slotLengths("m", [3])).toEqual([4, 6]);
    expect(e.positionOf("m", 26)).toEqual({ index: 0, offset: 6 });
    expect(validate(cal(year([{ kind: "slots", from: 2, unit: "m", lengths: [7, 4] }]))).join()).toContain("total 11 days but its parent occurrence is 10");
    expect(validate(cal(year([{ kind: "slots", from: 2, unit: "m", lengths: [7] }]))).join()).toContain("2 whole numbers");
    expect(validate(cal(year([{ kind: "slots", from: 2, unit: "nope", lengths: [7, 3] }]))).join()).toContain("not a slot unit under");
    expect(validate(cal(year([{ kind: "slots", from: 2, unit: "m", path: [99], lengths: [7, 3] }]))).join()).toContain("path must name");
  });

  test("named days carry their tags; a ledgered cycle has no fixed round; a keyed slot needs a row for every length", () => {
    const e = new Engine(cal(year(undefined), { days: [{ day: 12, name: "Coronation", tags: ["feast"] }] }));
    expect(e.tagsAt(12)).toEqual(["feast"]);
    expect(e.tagsAt(13)).toEqual([]);
    expect(() => new Engine(cal(year([{ kind: "starts", from: 1, startsOn: 9 }]))).round(["y"])).toThrow(RangeError);
    const keyed: CalendarAst = { name: "t", gears: [], units: [year([{ kind: "starts", from: 1, startsOn: 10, lengths: [11] }]), { id: "m", kind: "slots", in: "y", slots: [{ length: { by: "parent", table: [[10, 10]] } }] }] };
    expect(validate(keyed).join()).toContain("no length for a parent occurrence of 11 days");
  });

  test("a malformed ledger is reported, not thrown", () => {
    const v = (ledger: unknown) => validate(cal(year(ledger as CycleUnitAst["ledger"]))).join();
    expect(v("x")).toContain("ledger must be a list");
    expect(v([null])).toContain("not an object");
    expect(v([{ kind: "starts", from: 1.5, startsOn: 3 }])).toContain("not a whole occurrence index");
    expect(v([{ kind: "starts", from: 1, startsOn: 3, lengths: [0] }])).toContain("≥ 1");
    expect(v([{ kind: "switch", from: 1 }])).toContain("needs a rule");
    expect(v([{ kind: "nope", from: 1 }])).toContain("is not switch, starts or slots");
    expect(v([{ kind: "starts", from: 4 * DAY_LIMIT, startsOn: 3 }])).toContain("within");
  });
});
