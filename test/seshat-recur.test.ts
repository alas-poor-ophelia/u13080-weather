/**
 * Seshat P2 step 3 (docs/SESHAT-v0.md §3.5): `recur` over calendar units,
 * each case held to an implementation that shares nothing with it.
 *
 *   - Gregorian: the `rrule` package (RFC 5545), through an explicit
 *     translation table: `recur` is a day filter, not RFC, so every case
 *     states its RFC rule and its Seshat rule side by side.
 *   - Hebrew holidays: ICU (Intl, calendar "hebrew") over 1900–2040, which
 *     is AM 5660–5801: none of ICU's disputed years (5462, 5560, 5807 in
 *     AM 5343–5999, seshat-hebrew.test.ts) falls inside.
 *   - Maya and Balinese named days: the Dershowitz–Reingold and Reingold
 *     formulas the P1 tests already use, transcribed again here.
 *
 * RFC cases NOT covered, by design (§3.5): BYWEEKNO; WKST other than SU (the
 * Gregorian week starts on Sunday); BYDAY with a numeric prefix (1MO, -1FR:
 * express as setpos); a DTSTART inside its period (recur counts from the
 * period's first day); BYHOUR and finer.
 */
import { describe, expect, test } from "bun:test";
import { RRule, type Options } from "rrule";
import { BALINESE, checkRule, COUNT_WORK_MAX, Engine, GREGORIAN, HEBREW, MAYA, validate, type CalendarAst, type RuleAst } from "../src/seshat";

const DAY_MS = 86_400_000;
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const dayOf = (t: Date) => Math.floor(t.getTime() / DAY_MS);
const mod = (a: number, m: number) => ((a % m) + m) % m;
const amod = (a: number, m: number) => mod(a - 1, m) + 1;

/** Every day in [a, b] the rule holds on. */
function days(engine: Engine, rule: RuleAst, a: number, b: number): number[] {
  const bound = engine.days.bind(rule);
  const out: number[] = [];
  for (let d = a; d <= b; d++) if (engine.days.holds(bound, d)) out.push(d);
  return out;
}

describe("recur vs rrule (Gregorian, 1960–2040)", () => {
  const greg = new Engine(GREGORIAN);
  const [A, B] = [utc(1960, 1, 1), utc(2040, 12, 31)];
  const a = dayOf(A);
  const b = dayOf(B);
  const month = (n: number) => ({ unit: "month", nth: [n] });
  const weekday = (...names: string[]) => ({ unit: "weekday", label: names });
  const monthDay = (...n: number[]) => ({ unit: "month", day: n });

  const CASES: Array<[string, Partial<Options>, RuleAst]> = [
    ["4th Thursday of November", { freq: RRule.YEARLY, bymonth: 11, byweekday: RRule.TH, bysetpos: 4 }, { kind: "recur", freq: "year", anchor: a, by: [month(11), weekday("Thursday")], setpos: [4] }],
    ["Friday the 13th", { freq: RRule.MONTHLY, byweekday: RRule.FR, bymonthday: 13 }, { kind: "recur", freq: "month", anchor: a, by: [weekday("Friday"), monthDay(13)] }],
    ["last day of every month", { freq: RRule.MONTHLY, bymonthday: -1 }, { kind: "recur", freq: "month", anchor: a, by: [monthDay(-1)] }],
    ["29 February", { freq: RRule.YEARLY, bymonth: 2, bymonthday: 29 }, { kind: "recur", freq: "year", anchor: a, by: [month(2), monthDay(29)] }],
    ["every other week, Monday and Wednesday (WKST=SU)", { freq: RRule.WEEKLY, interval: 2, byweekday: [RRule.MO, RRule.WE], wkst: RRule.SU, dtstart: utc(1960, 1, 3) }, { kind: "recur", freq: "week", interval: 2, anchor: dayOf(utc(1960, 1, 3)), by: [weekday("Monday", "Wednesday")] }],
    ["every third day", { freq: RRule.DAILY, interval: 3 }, { kind: "recur", freq: "day", interval: 3, anchor: a }],
    ["1 January and 1 July", { freq: RRule.YEARLY, bymonth: [1, 7], bymonthday: 1 }, { kind: "recur", freq: "year", anchor: a, by: [{ unit: "month", nth: [1, 7] }, monthDay(1)] }],
    ["last weekday of every month", { freq: RRule.MONTHLY, byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR], bysetpos: -1 }, { kind: "recur", freq: "month", anchor: a, by: [weekday("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")], setpos: [-1] }],
    ["the 31st, ten times", { freq: RRule.MONTHLY, bymonthday: 31, count: 10 }, { kind: "recur", freq: "month", anchor: a, by: [monthDay(31)], count: 10 }],
    ["1 March until 2000", { freq: RRule.YEARLY, bymonth: 3, bymonthday: 1, until: utc(2000, 12, 31) }, { kind: "recur", freq: "year", anchor: a, by: [month(3), monthDay(1)], until: dayOf(utc(2000, 12, 31)) }],
    ["US election day, every 4 years from 1960", { freq: RRule.YEARLY, interval: 4, bymonth: 11, byweekday: RRule.TU, bymonthday: [2, 3, 4, 5, 6, 7, 8] }, { kind: "recur", freq: "year", interval: 4, anchor: a, by: [month(11), weekday("Tuesday"), monthDay(2, 3, 4, 5, 6, 7, 8)] }],
    ["days 100 and -1 of the year", { freq: RRule.YEARLY, byyearday: [100, -1] }, { kind: "recur", freq: "year", anchor: a, by: [{ unit: "day", nth: [100, -1] }] }],
    ["second-to-last Sunday of each month", { freq: RRule.MONTHLY, byweekday: RRule.SU, bysetpos: -2 }, { kind: "recur", freq: "month", anchor: a, by: [weekday("Sunday")], setpos: [-2] }],
    ["weekends of every 3rd month from January", { freq: RRule.MONTHLY, interval: 3, byweekday: [RRule.SA, RRule.SU] }, { kind: "any", of: [1, 4, 7, 10].map((m) => ({ kind: "recur", freq: "year", anchor: a, by: [month(m), weekday("Saturday", "Sunday")] })) }],
  ];

  for (const [name, rfc, rule] of CASES) {
    test(name, () => {
      const want = new RRule({ dtstart: A, ...rfc }).between(A, B, true).map(dayOf);
      expect(want.length).toBeGreaterThan(0);
      expect(days(greg, rule, a, b)).toEqual(want);
    });
  }
  test("nothing matches before the anchor (RFC: no instance before DTSTART)", () => {
    const [from, to, start] = [utc(1990, 1, 1), utc(2010, 12, 31), utc(2000, 1, 1)];
    const want = new RRule({ freq: RRule.YEARLY, bymonth: 11, byweekday: RRule.TH, bysetpos: 4, dtstart: start }).between(from, to, true).map(dayOf);
    expect(want[0]).toBeGreaterThan(dayOf(start));
    expect(days(greg, { kind: "recur", freq: "year", anchor: dayOf(start), by: [month(11), weekday("Thursday")], setpos: [4] }, dayOf(from), dayOf(to))).toEqual(want);
  });

  // nth over a unit that is not nested in the period: an occurrence counts in the period its first day
  // lies in. Not RFC (BYWEEKNO is excluded); the oracle is Date.
  test("the first week that begins in each month (a week that began in the previous month is not counted)", () => {
    const want: number[] = [];
    for (let d = a; d <= b; d++) {
      const t = new Date(d * DAY_MS);
      const weekStart = d - t.getUTCDay();
      const monthStart = dayOf(utc(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
      // the week's first day is in d's month and is that month's first Sunday
      if (weekStart >= monthStart && weekStart < monthStart + 7) want.push(d);
    }
    expect(days(greg, { kind: "recur", freq: "month", anchor: a, by: [{ unit: "week", nth: [1] }] }, a, b)).toEqual(want);
  });
});

describe("recur on Hebrew holidays vs ICU (1900–2040)", () => {
  const heb = new Engine(HEBREW);
  const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", month: "long", day: "numeric" });
  const icu = (d: number): [string, number] => {
    const parts = f.formatToParts(new Date(d * DAY_MS));
    return [parts.find((p) => p.type === "month")!.value, Number(parts.find((p) => p.type === "day")!.value)];
  };
  const [a, b] = [dayOf(utc(1900, 1, 1)), dayOf(utc(2040, 12, 31))];
  const month = (name: string) => ({ unit: "month", label: [name] });

  /** each case's oracle reads ICU's month name and day of month for day d */
  const CASES: Array<[string, RuleAst, (d: number) => boolean]> = [
    ["Yom Kippur, 10 Tishri", { kind: "recur", freq: "year", by: [month("Tishri"), { unit: "month", day: [10] }] }, (d) => icu(d)[0] === "Tishri" && icu(d)[1] === 10],
    ["first day of Hanukkah, 25 Kislev (Kislev's length varies)", { kind: "recur", freq: "year", by: [month("Kislev"), { unit: "month", day: [25] }] }, (d) => icu(d)[0] === "Kislev" && icu(d)[1] === 25],
    ["Purim, 14 Adar (Adar II in a leap year)", { kind: "recur", freq: "year", by: [month("Adar"), { unit: "month", day: [14] }] }, (d) => ["Adar", "Adar II"].includes(icu(d)[0]) && icu(d)[1] === 14],
    ["Passover, 15 Nisan", { kind: "recur", freq: "year", by: [month("Nisan"), { unit: "month", day: [15] }] }, (d) => icu(d)[0] === "Nisan" && icu(d)[1] === 15],
    ["the last day of Heshvan (29 or 30)", { kind: "recur", freq: "year", by: [month("Heshvan"), { unit: "month", day: [-1] }] }, (d) => icu(d)[0] === "Heshvan" && icu(d + 1)[0] !== "Heshvan"],
    ["month 6 by declared number: Adar I, absent in common years", { kind: "recur", freq: "year", by: [{ unit: "month", nth: [6] }] }, (d) => icu(d)[0] === "Adar I"],
    ["the last declared month: Elul", { kind: "recur", freq: "year", by: [{ unit: "month", nth: [-1] }] }, (d) => icu(d)[0] === "Elul"],
  ];

  for (const [name, rule, isIt] of CASES) {
    test(name, () => {
      const want: number[] = [];
      for (let d = a; d <= b; d++) if (isIt(d)) want.push(d);
      expect(want.length).toBeGreaterThan(30);
      expect(days(heb, rule, a, b)).toEqual(want);
    });
  }
});

describe("recur on named days vs the Reingold formulas", () => {
  test("every 4 Ajaw (Maya Tzolk'in) over ±20,000 days, against D&R's tzolkin-from-fixed", () => {
    const maya = new Engine(MAYA);
    const want: number[] = [];
    for (let d = -20_000; d <= 20_000; d++) {
      const n = d - -1_856_305;
      if (amod(n + 4, 13) === 4 && amod(n + 20, 20) === 20) want.push(d);
    }
    expect(want.length).toBeGreaterThan(150); // one every 260 days
    expect(days(maya, { kind: "recur", freq: "day", anchor: -20_000, by: [{ unit: "tzolkin-number", label: ["4"] }, { unit: "tzolkin-name", label: ["Ajaw"] }] }, -20_000, 20_000)).toEqual(want);
  });

  test("every Galungan (Buda Kliwon Dungulan) over ±20,000 days, against Reingold's bali-*-from-fixed", () => {
    const bali = new Engine(BALINESE);
    const want: number[] = [];
    for (let d = -20_000; d <= 20_000; d++) {
      const day = mod(d - -2_440_442, 210);
      if (1 + Math.floor(day / 7) === 11 && amod(day + 2, 5) === 5 && 1 + mod(day, 7) === 4) want.push(d);
    }
    expect(want.length).toBeGreaterThan(185); // one every 210 days
    const rule: RuleAst = { kind: "recur", freq: "pawukon", by: [{ unit: "wuku", label: ["Dungulan"] }, { unit: "saptawara", label: ["Buda"] }, { unit: "pancawara", label: ["Kliwon"] }] };
    expect(days(bali, rule, -20_000, 20_000)).toEqual(want);
  });
});

describe("named rules (VRULE) and binding", () => {
  const thanksgiving: RuleAst = { kind: "recur", freq: "year", by: [{ unit: "month", nth: [11] }, { unit: "weekday", label: ["Thursday"] }], setpos: [4] };
  const WITH_RULES: CalendarAst = { ...GREGORIAN, rules: [{ id: "thanksgiving", rule: thanksgiving, tags: ["holiday:thanksgiving"] }, { id: "no-tags", rule: { kind: "dates", days: [0] } }] };

  test("a named rule's tags reach tagsAt on exactly its days; rules read only unit and day tags", () => {
    expect(validate(WITH_RULES)).toEqual([]);
    const greg = new Engine(WITH_RULES);
    const plain = new Engine(GREGORIAN);
    const a = dayOf(utc(2000, 1, 1));
    const want = days(plain, thanksgiving, a, a + 3_652);
    for (let d = a; d <= a + 3_652; d++) {
      expect(greg.tagsAt(d)).toEqual(want.includes(d) ? ["holiday:thanksgiving"] : []);
      expect(greg.baseTagsAt(d)).toEqual([]);
    }
    // independently: the fourth Thursday of November by Date, for each year
    const fourthThursday = (y: number) => {
      const first = utc(y, 11, 1).getUTCDay();
      return dayOf(utc(y, 11, 1 + mod(4 - first, 7) + 21));
    };
    expect(want).toEqual(Array.from({ length: 10 }, (_, i) => fourthThursday(2000 + i)));
  });

  test("the validator and bind reject what a calendar rule cannot mean", () => {
    const bad = (rule: RuleAst) => checkRule(rule, GREGORIAN);
    expect(bad({ kind: "recur", freq: "fortnight" })).toEqual(['rule freq: no unit "fortnight"']);
    expect(bad({ kind: "recur", freq: "month", interval: 2 })[0]).toContain("interval > 1 needs a cycle unit");
    expect(bad({ kind: "recur", freq: "month", count: 3 })[0]).toContain("needs an anchor");
    expect(bad({ kind: "host", key: "regime", arg: "wet" })[0]).toContain("cannot read");
    expect(bad({ kind: "phase", body: "moon", from: 0, to: 0.5 })[0]).toContain("no body");
    expect(bad({ kind: "index", unit: "month" })[0]).toContain("slot unit");
    expect(bad({ kind: "recur", freq: "year", by: [{ unit: "month", nth: [0] }] })[0]).toContain("non-zero");
    expect(bad({ kind: "recur", freq: "year", setpos: [] })[0]).toContain("non-empty");
    expect(bad({ kind: "recur", freq: "year", by: "month" } as unknown as RuleAst)[0]).toContain("by must be a list");
    const tagged: CalendarAst = { ...GREGORIAN, rules: [{ id: "x", rule: { kind: "dates", days: [0] }, tags: ["holiday:x"] }] };
    expect(checkRule({ kind: "tag", tag: "holiday:x" }, tagged)[0]).toContain("set only by a named rule");
    expect(validate({ ...GREGORIAN, rules: [{ id: "year", rule: { kind: "dates", days: [1] } }] })).toContain('id "year" is declared more than once');
    expect(() => new Engine(GREGORIAN).days.bind({ kind: "recur", freq: "fortnight" })).toThrow(RangeError);
  });

  test("setpos past the period limit: a validation error on a constant cycle, a throw on a variable one; count past the work cap throws on every call", () => {
    const maya = new Engine(MAYA);
    expect(() => maya.days.bind({ kind: "recur", freq: "baktun", setpos: [1] })).toThrow(/144000-day period is past the 400-day limit/);
    // 401 and 402 days alternately: the validator cannot know the length, the run does
    const VARIABLE: CalendarAst = { name: "variable", gears: [{ id: "g", on: "big", kind: "intervals", terms: [{ every: 2, sign: 1 }] }], units: [{ id: "big", kind: "cycle", anchor: 0, length: 401, gears: [{ gear: "g", add: 1 }] }] };
    const v = new Engine(VARIABLE);
    const setpos = v.days.bind({ kind: "recur", freq: "big", setpos: [1] });
    expect(() => v.days.holds(setpos, 0)).toThrow(/BYSETPOS over a 40[12]-day period/);
    const greg = new Engine(GREGORIAN);
    const far = maya.days.bind({ kind: "recur", freq: "day", anchor: 0, count: 5 });
    expect(maya.days.holds(far, 4)).toBe(true);
    expect(maya.days.holds(far, 5)).toBe(false);
    const walk = greg.days.bind({ kind: "recur", freq: "day", anchor: 0, count: 1 });
    expect(() => greg.days.holds(walk, COUNT_WORK_MAX + 10)).toThrow(/COUNT walks more than/);
    // the budget is the rule's, not the call's: a nearer day after the cap is hit does not get a fresh one
    expect(() => greg.days.holds(walk, COUNT_WORK_MAX + 20)).toThrow(/COUNT walks more than/);
  });

  // review 2026-10-18: the occurrence-start cache was keyed by unit and period start only, so a year rule
  // reused a month rule's January entry on the same engine
  test("two rules with different periods over the same nth unit share an engine without colliding", () => {
    const lastWeekOf = (freq: string): RuleAst => ({ kind: "recur", freq, by: [{ unit: "week", nth: [-1] }] });
    const [a, b] = [dayOf(utc(2000, 1, 1)), dayOf(utc(2000, 12, 31))];
    const fresh = (freq: string) => days(new Engine(GREGORIAN), lastWeekOf(freq), a, b);
    const shared = new Engine(GREGORIAN);
    const month = days(shared, lastWeekOf("month"), a, b);
    const year = days(shared, lastWeekOf("year"), a, b);
    expect(month).toEqual(fresh("month"));
    expect(year).toEqual(fresh("year"));
    expect(year).toEqual([dayOf(utc(2000, 12, 31))]); // the last week to begin in 2000 begins Sunday 31 December
  });

  test("nothing in src outside src/seshat reads tagsAt yet, so VRULE tags change no weather", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const readers: string[] = [];
    for await (const f of glob.scan(".")) {
      if (f.replaceAll("\\", "/").startsWith("src/seshat/")) continue;
      if ((await Bun.file(f).text()).includes("tagsAt(")) readers.push(f);
    }
    expect(readers).toEqual([]);
  });

  test("rrule is a test oracle only: nothing under src imports it", async () => {
    const importers: string[] = [];
    for await (const f of new Bun.Glob("src/**/*.ts").scan(".")) if (/from\s+["']rrule["']/.test(await Bun.file(f).text())) importers.push(f);
    expect(importers).toEqual([]);
  });
});
