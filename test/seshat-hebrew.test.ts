import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, Engine, HEBREW, validate, type CalendarAst } from "../src/seshat";

const DAY_MS = 86_400_000;

function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

const months = HEBREW.units[1]!.kind === "slots" ? HEBREW.units[1]!.slots.map((s) => s.name!) : [];

/** ICU's reading of a day as [year AM, month name, day of month]; in a non-leap year ICU names the one Adar "Adar", in a leap year "Adar II". */
const icu = (() => {
  const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  expect(f.resolvedOptions().calendar).toBe("hebrew");
  return (d: number): [number, string, number] => {
    const parts = f.formatToParts(new Date(d * DAY_MS));
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return [Number(get("year")), get("month"), Number(get("day"))];
  };
})();

/**
 * The oracle: the classic postponement rules (molad zaken, lo ADU, GaTaRaD,
 * BeTUTaKPaT), in the explicit form of Dershowitz & Reingold's 1990 paper,
 * which shares no code or formulation with the AST's stages. Returns days from
 * the creation epoch to 1 Tishri of year y.
 */
function classicElapsed(y: number): number {
  const div = (a: number, b: number) => Math.floor(a / b);
  const md = (a: number, b: number) => ((a % b) + b) % b;
  const leap = (x: number) => md(7 * x + 1, 19) < 7;
  const months = 235 * div(y - 1, 19) + 12 * md(y - 1, 19) + div(7 * md(y - 1, 19) + 1, 19);
  const partsElapsed = 204 + 793 * md(months, 1080);
  const hours = 5 + 12 * months + 793 * div(months, 1080) + div(partsElapsed, 1080);
  const day = 1 + 29 * months + div(hours, 24);
  const parts = 1080 * md(hours, 24) + md(partsElapsed, 1080);
  const alt = parts >= 19440 || (md(day, 7) === 2 && parts >= 9924 && !leap(y)) || (md(day, 7) === 1 && parts >= 16789 && leap(y - 1)) ? day + 1 : day;
  return [0, 3, 5].includes(md(alt, 7)) ? alt + 1 : alt;
}

/** Month lengths of a year of `len` days, by the textbook rules (not the AST's slack): Heshvan 30 in a complete year, Kislev 29 in a deficient one, Adar I only in a leap year. */
function classicMonths(len: number): number[] {
  const leap = len > 360;
  const heshvan = len % 10 === 5 ? 30 : 29;
  const kislev = len % 10 === 3 ? 29 : 30;
  return [30, heshvan, kislev, 29, 30, leap ? 30 : 0, 29, 30, 29, 30, 29, 30, 29];
}

describe("seshat: Hebrew", () => {
  const heb = new Engine(HEBREW);
  const name = (k: number, slot: number) => (slot === 6 && heb.slotLengths("month", [k])[5]! > 0 ? "Adar II" : months[slot]!);
  const read = (d: number): [number, string, number] => {
    const y = heb.positionOf("year", d)!.index;
    const m = heb.positionOf("month", d)!;
    return [y + 1, name(y, m.index), m.offset + 1];
  };
  const [lo, hi] = [heb.indexAt("year", -DAY_LIMIT), heb.indexAt("year", DAY_LIMIT)];

  test("the AST is valid; 1 Tishri 1 AM and recent new years fall on the documented days", () => {
    expect(validate(HEBREW)).toEqual([]);
    expect(heb.start("year", 0)).toBe(-2_092_590);
    expect(heb.start("year", 5783)).toBe(gregorianDay(2023, 9, 16)); // 1 Tishri 5784
    expect(heb.start("year", 5784)).toBe(gregorianDay(2024, 10, 3)); // 1 Tishri 5785
    expect(read(gregorianDay(2024, 2, 10))).toEqual([5784, "Adar I", 1]);
    expect(read(gregorianDay(2024, 3, 11))).toEqual([5784, "Adar II", 1]);
    expect(read(gregorianDay(2025, 3, 1))).toEqual([5785, "Adar", 1]);
  });

  test("every year start and every month length over ±DAY_LIMIT agree with the classic postponement rules", () => {
    let bad = 0;
    const e0 = classicElapsed(lo + 1) - heb.start("year", lo);
    for (let k = lo; k <= hi; k++) {
      const len = classicElapsed(k + 2) - classicElapsed(k + 1);
      const got = { start: heb.start("year", k) + e0, months: heb.slotLengths("month", [k]) };
      const want = { start: classicElapsed(k + 1), months: classicMonths(len) };
      if (got.start !== want.start || got.months.join() !== want.months.join()) if (bad++ < 5) expect({ k, got }).toEqual({ k, got: want });
    }
    expect(bad).toBe(0);
    expect(e0).toBe(classicElapsed(1) - -2_092_590); // one fixed offset between the two epochs, over the whole range
  });

  test("year lengths over the whole range are exactly {353, 354, 355, 383, 384, 385}: a derived theorem, checked, not a rule", () => {
    const seen = new Set<number>();
    for (let k = lo; k <= hi; k++) seen.add(heb.length("year", k));
    expect([...seen].sort((a, b) => a - b)).toEqual([353, 354, 355, 383, 384, 385]);
  });

  // ICU up to 76 (Bun 1.3's 73.2, Node's 76.1) puts some new years a day late: in AM 5343–5999 exactly 5462, 5560 and
  // 5807, where .NET's HebrewCalendar, the classic rules and Hebcal (Rosh Hashana 5807 begins the evening of Sunday
  // 30 September 2046) all give Monday. ICU 78.3 (Bun 1.4.3) agrees with them: it was fixed between the two. ICU 77
  // was not measured, so either answer passes there. Its disagreements are listed here, not hidden.
  const icuMajor = Number(process.versions.icu!.split(".")[0]);
  const icuFixed = icuMajor >= 78 ? true : icuMajor <= 76 ? false : undefined;
  test("ICU's new years disagree only in the years we know (none since ICU 78); .NET and Hebcal side with Seshat", () => {
    const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
    const disputed: number[] = [];
    for (let y = 5343; y <= 5999; y++) if (!f.format(new Date(heb.start("year", y - 1) * DAY_MS)).startsWith(`1 Tishri ${y}`)) disputed.push(y);
    const known = [5462, 5560, 5807];
    if (icuFixed === true) expect(disputed).toEqual([]);
    else if (icuFixed === false) expect(disputed).toEqual(known);
    else expect([[], known]).toContainEqual(disputed);
    expect(heb.start("year", 5461)).toBe(gregorianDay(1701, 10, 3));
    expect(heb.start("year", 5559)).toBe(gregorianDay(1799, 9, 30));
    expect(heb.start("year", 5806)).toBe(gregorianDay(2046, 10, 1));
  });

  test("agrees with ICU on every day over ±1,000,000 days, outside the years ICU starts on another day", () => {
    let bad = 0;
    const icuYearOk = new Map<number, boolean>();
    const yearOk = (y: number) => {
      let ok = icuYearOk.get(y);
      if (ok === undefined) {
        const [a, b] = [heb.start("year", y - 1), heb.start("year", y)];
        ok = icu(a)[1] === "Tishri" && icu(a)[2] === 1 && icu(b)[1] === "Tishri" && icu(b)[2] === 1;
        icuYearOk.set(y, ok);
      }
      return ok;
    };
    for (let d = -1_000_000; d <= 1_000_000; d++) {
      const a = read(d);
      if (!yearOk(a[0])) continue;
      const b = icu(d);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) if (bad++ < 5) expect({ d, seshat: a }).toEqual({ d, seshat: b });
    }
    expect(bad).toBe(0);
    // pinned, not capped: before ICU 78, 31 new years put a day late in AM 2992–8468, each touching the year on either
    // side; since ICU 78 none, so this is agreement on every day of the ±1M span with nothing set aside
    const excluded = [...icuYearOk.values()].filter((ok) => !ok).length;
    if (icuFixed === true) expect(excluded).toBe(0);
    else if (icuFixed === false) expect(excluded).toBe(62);
    else expect([0, 62]).toContain(excluded);
  }, 120_000);
});

describe("seshat: validator, stages and bounded slack", () => {
  test("Hebrew's months fit every real year: the scan accepts what independent leap states would wrongly refuse", () => {
    // the mask check would pair leap=0 with a 385-day year; only real years are checked now
    expect(validate(HEBREW)).toEqual([]);
  });

  test("a month layout that real years cannot fit is refused, naming the year", () => {
    const bad: CalendarAst = { ...HEBREW, units: [HEBREW.units[0]!, { ...(HEBREW.units[1] as Extract<CalendarAst["units"][number], { kind: "slots" }>), slots: (HEBREW.units[1] as Extract<CalendarAst["units"][number], { kind: "slots" }>).slots.map((s) => (s.name === "Kislev" ? { ...s, max: 29 } : s)) }] };
    expect(validate(bad).join()).toMatch(/slots take at most \d+ days but its parent occurrence is (355|385) \("year" -?\d+: \d+ days\)/);
  });

  test("stage rules are checked: empty stages, wide windows, bad residues", () => {
    const year = HEBREW.units[0]!;
    if (year.kind !== "cycle") throw new Error("fixture");
    const v = (stages: unknown) => validate({ name: "t", gears: HEBREW.gears, units: [{ ...year, stages } as typeof year] }).join();
    expect(v([{ rules: [] }])).toContain("no rules");
    expect(v([{ rules: [{ add: 1, length: { at: 9, is: 356 } }] }])).toContain("V2");
    expect(v([{ rules: [{ add: 1, residue: { mod: 7, in: [7] } }] }])).toContain("residues");
    expect(v([{ rules: [{ add: 1, residue: { mod: 7, in: [1] } }] }])).toEqual("");
  });

  test("slack bounds belong to slack slots, and min may not exceed max", () => {
    const v = (slots: unknown) => validate({ name: "t", gears: [], units: [{ id: "y", kind: "cycle", anchor: 0, length: 10 }, { id: "m", kind: "slots", in: "y", slots } as never] }).join();
    expect(v([{ length: 5, min: 1 }, { length: "slack" }])).toContain("slack slots only");
    expect(v([{ length: "slack", min: 6, max: 5 }, { length: "slack" }])).toContain("max 5");
    expect(v([{ length: "slack", min: 4, max: 6, fill: 2 }, { length: "slack", min: 4, max: 6, fill: 1 }])).toEqual("");
    expect(v([{ length: "slack", max: 4 }, { length: "slack", max: 4 }])).toContain("at most 8 days");
  });

  test("slack slots without a fill come after those with one, in slot order", () => {
    const e = new Engine({ name: "t", gears: [], units: [{ id: "y", kind: "cycle", anchor: 0, length: 13 }, { id: "m", kind: "slots", in: "y", slots: [{ length: "slack", min: 4, max: 6 }, { length: "slack", min: 4, max: 6, fill: 1 }, { length: "slack", min: 0 }] }] });
    expect(e.slotLengths("m", [0])).toEqual([6, 6, 1]);
  });

  test("malformed stages are reported, not thrown", () => {
    const year = HEBREW.units[0]!;
    if (year.kind !== "cycle") throw new Error("fixture");
    const v = (stages: unknown) => validate({ name: "t", gears: HEBREW.gears, units: [{ ...year, stages } as typeof year] }).join();
    expect(v("x")).toContain("stages must be a list");
    expect(v([null])).toContain("no rules");
    expect(v([{ rules: [null] }])).toContain("a rule is an object");
    expect(v([{ rules: [{ add: 1, residue: { mod: 7, in: "246" } }] }])).toContain("at least one residue");
    expect(v([{ rules: [{ add: 1 }] }])).toContain("a residue or a length");
  });

  test("a staged cycle too fine to scan is refused with a reason, not scanned for minutes", () => {
    const stagedDays: CalendarAst = {
      name: "t",
      gears: [],
      units: [
        { id: "d", kind: "cycle", anchor: 0, length: 3, stages: [{ rules: [{ add: 1, residue: { mod: 7, in: [0] } }] }] },
        { id: "s", kind: "slots", in: "d", slots: [{ length: "slack" }] },
      ],
    };
    expect(validate(stagedDays).join()).toContain("at most 1000000");
  });

  test("slack is handed out in fill order up to each max", () => {
    const e = new Engine({ name: "t", gears: [], units: [{ id: "y", kind: "cycle", anchor: 0, length: 11 }, { id: "m", kind: "slots", in: "y", slots: [{ length: "slack", min: 4, max: 6, fill: 2 }, { length: "slack", min: 4, max: 6, fill: 1 }] }] });
    expect(e.slotLengths("m", [0])).toEqual([5, 6]);
  });
});
