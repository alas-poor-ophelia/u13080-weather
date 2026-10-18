import { describe, expect, test } from "bun:test";
import { Engine, FRENCH_REPUBLICAN, HARPTOS, validate, type CalendarAst, type SlotAst } from "../src/seshat";

const DAY_MS = 86_400_000;

function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

interface Reading {
  year: number;
  month: number;
  day: number;
  /** the décade or tenday and the day in it; null on a filler day */
  sub: { index: number; day: number } | null;
}

/**
 * An oracle that knows nothing of gears or closed forms: it lays the years
 * out one after another from the epoch, each from its own leap test, and
 * reads every day off that layout.
 */
function walk(epoch: number, isLeap: (y: number) => boolean, layout: (leap: boolean) => Array<{ len: number; filler: boolean }>, from: number, to: number): Map<number, Reading> {
  const out = new Map<number, Reading>();
  const yearLen = (y: number) => layout(isLeap(y)).reduce((a, s) => a + s.len, 0);
  let y = 1;
  let start = epoch;
  while (start > from) start -= yearLen(--y);
  for (; start <= to; y++) {
    let d = start;
    layout(isLeap(y)).forEach((s, month) => {
      for (let k = 0; k < s.len; k++, d++) out.set(d, { year: y, month, day: k, sub: s.filler ? null : { index: Math.floor(k / 10), day: k % 10 } });
    });
    start = d;
  }
  return out;
}

function read(e: Engine, sub: string, d: number): Reading {
  const m = e.positionOf("month", d)!;
  const s = e.positionOf(sub, d);
  return { year: e.positionOf("year", d)!.index + 1, month: m.index, day: m.offset, sub: s && { index: s.index, day: s.offset } };
}

/** The month layout of a calendar, read straight off its AST (a slack slot is the 5/6-day sansculottides). */
function layoutOf(ast: CalendarAst): (leap: boolean) => Array<{ len: number; filler: boolean }> {
  const months = ast.units[1]!;
  if (months.kind !== "slots") throw new Error("fixture");
  return (leap) =>
    months.slots.map((s: SlotAst) => ({
      len: s.length === "slack" ? (leap ? 6 : 5) : s.length + (leap ? (s.gears ?? []).reduce((a, t) => a + t.add, 0) : 0),
      filler: !!s.filler,
    }));
}

function compareWalk(e: Engine, sub: string, want: Map<number, Reading>): void {
  let bad = 0;
  for (let d = -1_000_000; d <= 1_000_000; d++) {
    const got = read(e, sub, d);
    const w = want.get(d)!;
    if (got.year !== w.year || got.month !== w.month || got.day !== w.day || JSON.stringify(got.sub) !== JSON.stringify(w.sub)) if (bad++ < 5) expect({ d, got }).toEqual({ d, got: w });
  }
  expect(bad).toBe(0);
}

const mod = (a: number, m: number) => ((a % m) + m) % m;
const romme = (y: number) => mod(y, 4) === 0 && ![100, 200, 300].includes(mod(y, 400)) && mod(y, 4000) !== 0;
const shieldmeet = (y: number) => mod(y, 4) === 0;

describe("seshat: French Republican (Romme)", () => {
  const fr = new Engine(FRENCH_REPUBLICAN);

  test("the AST is valid; it shares early dates with the calendar as used, and parts from it after year III", () => {
    expect(validate(FRENCH_REPUBLICAN)).toEqual([]);
    expect(read(fr, "decade", gregorianDay(1792, 9, 22))).toEqual({ year: 1, month: 0, day: 0, sub: { index: 0, day: 0 } });
    // 9 Thermidor II (27 July 1794): no leap day before it under either rule
    expect(read(fr, "decade", gregorianDay(1794, 7, 27))).toEqual({ year: 2, month: 10, day: 8, sub: { index: 0, day: 8 } });
    // 18 Brumaire VIII was 9 November 1799 as used (leap days ending III and VII); Romme has one (IV), so it falls on the 8th
    expect(read(fr, "decade", gregorianDay(1799, 11, 8))).toEqual({ year: 8, month: 1, day: 17, sub: { index: 1, day: 7 } });
  });

  test("agrees with a day-by-day layout over ±1,000,000 days, décades and sansculottides included", () => {
    compareWalk(fr, "decade", walk(gregorianDay(1792, 9, 22), romme, layoutOf(FRENCH_REPUBLICAN), -1_000_000, 1_000_000));
  }, 60_000);

  test("the year ends with Fructidor and the sansculottides, in order (the walk reads the layout from the AST, so these pin it)", () => {
    const months = FRENCH_REPUBLICAN.units[1]!;
    if (months.kind !== "slots") throw new Error("fixture");
    expect(months.slots.map((s) => s.name)).toEqual(["Vendémiaire", "Brumaire", "Frimaire", "Nivôse", "Pluviôse", "Ventôse", "Germinal", "Floréal", "Prairial", "Messidor", "Thermidor", "Fructidor", "Sansculottides"]);
    expect(read(fr, "decade", gregorianDay(1793, 9, 16))).toEqual({ year: 1, month: 11, day: 29, sub: { index: 2, day: 9 } }); // 30 Fructidor I
    expect(read(fr, "decade", gregorianDay(1793, 9, 21))).toEqual({ year: 1, month: 12, day: 4, sub: null }); // 5th sansculottide I
    expect(read(fr, "decade", gregorianDay(1793, 9, 22))).toEqual({ year: 2, month: 0, day: 0, sub: { index: 0, day: 0 } }); // 1 Vendémiaire II
    expect(read(fr, "decade", gregorianDay(1796, 9, 21))).toEqual({ year: 4, month: 12, day: 5, sub: null }); // 6th sansculottide IV
    expect(read(fr, "decade", gregorianDay(1796, 9, 22))).toEqual({ year: 5, month: 0, day: 0, sub: { index: 0, day: 0 } }); // 1 Vendémiaire V
  });

  test("Romme leap years: IV and CD are, III, C and MMMM are not", () => {
    for (const [y, leap] of [[3, false], [4, true], [100, false], [400, true], [4000, false]] as const) expect(fr.length("year", y - 1)).toBe(leap ? 366 : 365);
  });

  test("a sansculottide has no décade, and nothing nests in it", () => {
    const d = fr.dayOf("month", [3], 12, 5); // the 6th sansculottide of IV
    expect(fr.positionOf("month", d)).toEqual({ index: 12, offset: 5 });
    expect(fr.positionOf("decade", d)).toBeNull();
    expect(() => fr.slotLengths("decade", [3, 12])).toThrow(RangeError);
    expect(fr.dayOf("decade", [3, 11], 2, 9)).toBe(d - 6); // 30 Fructidor IV
  });
});

describe("seshat: Harptos", () => {
  const h = new Engine(HARPTOS);

  test("the AST is valid; Shieldmeet follows Midsummer only in years divisible by 4", () => {
    expect(validate(HARPTOS)).toEqual([]);
    expect(h.slotLengths("month", [1371])[10]).toBe(1); // 1372 DR
    expect(h.slotLengths("month", [1372])[10]).toBe(0); // 1373 DR
    expect(h.positionOf("month", h.dayOf("month", [1371], 9, 0) + 1)).toEqual({ index: 10, offset: 0 }); // Shieldmeet 1372
    expect(h.positionOf("month", h.dayOf("month", [1372], 9, 0) + 1)).toEqual({ index: 11, offset: 0 }); // 1 Eleasis 1373
  });

  test("each festival falls on its day of the year (the walk reads the layout from the AST, so these pin it)", () => {
    const start = h.start("year", 1); // 2 DR, not a Shieldmeet year
    const names = HARPTOS.units[1]!.kind === "slots" ? HARPTOS.units[1]!.slots.map((s) => s.name) : [];
    const at = (doy: number) => {
      const m = h.positionOf("month", start + doy)!;
      return { name: names[m.index], offset: m.offset, tenday: h.positionOf("tenday", start + doy) };
    };
    expect(at(30)).toEqual({ name: "Midwinter", offset: 0, tenday: null });
    expect(at(121)).toEqual({ name: "Greengrass", offset: 0, tenday: null });
    expect(at(212)).toEqual({ name: "Midsummer", offset: 0, tenday: null });
    expect(at(273)).toEqual({ name: "Highharvestide", offset: 0, tenday: null });
    expect(at(334)).toEqual({ name: "Feast of the Moon", offset: 0, tenday: null });
    expect(at(335)).toEqual({ name: "Nightal", offset: 0, tenday: { index: 0, offset: 0 } });
    expect(at(364)).toEqual({ name: "Nightal", offset: 29, tenday: { index: 2, offset: 9 } });
    expect(at(31)).toEqual({ name: "Alturiak", offset: 0, tenday: { index: 0, offset: 0 } });
  });

  test("agrees with a day-by-day layout over ±1,000,000 days, tendays and festivals included", () => {
    compareWalk(h, "tenday", walk(0, shieldmeet, layoutOf(HARPTOS), -1_000_000, 1_000_000));
  }, 60_000);
});

describe("seshat: validator, nested slot units", () => {
  const year = { id: "year", kind: "cycle" as const, anchor: 0, length: 365 };
  const months = { id: "month", kind: "slots" as const, in: "year", slots: [...Array.from({ length: 12 }, () => ({ length: 30 })), { length: 5, filler: true }] };
  const decades = { id: "d", kind: "slots" as const, in: "month", slots: [{ length: 10 }, { length: 10 }, { length: 10 }] };

  test("a nested unit must fill every non-filler parent slot, and leaves filler slots alone", () => {
    expect(validate({ name: "t", gears: [], units: [year, months, decades] })).toEqual([]);
    expect(validate({ name: "t", gears: [], units: [year, months, { ...decades, slots: decades.slots.slice(0, 2) }] }).join()).toContain("slots total 20 days but its parent occurrence is 30");
    const unmarked = { ...months, slots: [...months.slots.slice(0, 12), { length: 5 }] };
    expect(validate({ name: "t", gears: [], units: [year, unmarked, decades] }).join()).toContain("its parent occurrence is 5");
  });

  test("a missing ancestor is reported once, by the unit that names it, not as a loop", () => {
    const errs = validate({ name: "t", gears: [], units: [{ ...months, in: "nope" }, decades] });
    expect(errs).toEqual(['unit "month": no parent unit "nope"']);
  });

  test("a parent whose slots fail does not drag its children into the same error", () => {
    const over = { ...months, slots: [...months.slots.slice(0, 12), { length: 6, filler: true }] };
    const errs = validate({ name: "t", gears: [], units: [year, over, decades] });
    expect(errs).toEqual(['unit "month": slots total 366 days but its parent occurrence is 365 (always)']);
  });

  test("a parent chain that loops back on itself is refused", () => {
    const errs = validate({ name: "t", gears: [], units: [{ id: "a", kind: "slots", in: "b", slots: [{ length: 1 }] }, { id: "b", kind: "slots", in: "a", slots: [{ length: 1 }] }] }).join();
    expect(errs).toContain("loop back");
  });

  test("gear terms in a nested unit read the cycle at the top, and a leap state is checked all the way down", () => {
    const leap = { id: "leap", on: "year", kind: "intervals" as const, terms: [{ every: 4, sign: 1 as const }] };
    const y = { ...year, gears: [{ gear: "leap", add: 1 }] };
    const m = { ...months, slots: [...months.slots.slice(0, 12), { length: "slack" as const, filler: true }] };
    expect(validate({ name: "t", gears: [leap], units: [y, m, decades] })).toEqual([]);
    // the last month takes the leap day: décades of 10 no longer fill it in a leap year
    const m31 = { ...months, slots: [...months.slots.slice(0, 11), { length: 30, gears: [{ gear: "leap", add: 1 }] }, { length: 5, filler: true }] };
    expect(validate({ name: "t", gears: [leap], units: [y, m31, decades] }).join()).toContain("its parent occurrence is 31 (leap=1)");
    const onMonth = { id: "g", on: "month", kind: "intervals" as const, terms: [{ every: 2, sign: 1 as const }] };
    expect(validate({ name: "t", gears: [leap, onMonth], units: [y, m, decades] }).join()).toContain("not a cycle unit");
  });
});
