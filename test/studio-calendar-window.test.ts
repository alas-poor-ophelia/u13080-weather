/**
 * P3c step 3 (docs/SESHAT-v0.md §15.4): the Calendar window. Its hint table
 * is a contract with the DOM (a source scan, as for the Seasons window: the
 * window imports Obsidian), and its words come from the calendar's own values.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { CALENDAR_HINTS, CALENDAR_HINT_KEYS, calendarHint } from "../src/studio/model/hints-calendar";
import { calendarGrammar, ledgerRows, monthsWords, parseLengths, parseMonthLength, showMonthLength, weekWords, yearWords } from "../src/studio/model/calendar-window";
import { GREGORIAN, HEBREW } from "../src/seshat";
import { recognise } from "../src/plugin/time/form";
import { calendarOfDefinition } from "../src/studio/model/definition";

// the window, and the Orrery | Form toggle that both calendar views carry (calendar-mode.ts)
const SOURCE = ["calendar.ts", "calendar-mode.ts"].map((f) => readFileSync(new URL(`../src/studio/ui/windows/${f}`, import.meta.url), "utf8")).join("\n");

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/calendarHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("calendar window hints", () => {
  test("every key the window uses exists, and the table holds exactly those", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((k) => CALENDAR_HINTS[k] === undefined)).toEqual([]);
    expect(used).toEqual([...CALENDAR_HINT_KEYS].sort());
  });

  test("house rules: a name and a detail, no trailing full stop, the attribute parses back", () => {
    for (const [key, [name, detail]] of Object.entries(CALENDAR_HINTS)) {
      expect(name.length).toBeGreaterThan(0);
      expect(detail.length).toBeGreaterThan(0);
      expect(detail.endsWith(".")).toBe(false);
      expect(name.includes(HINT_SEPARATOR)).toBe(false);
      expect(parseHint(calendarHint(key))).toEqual([name, detail]);
    }
  });
});

describe("calendar window words", () => {
  test("a year reads from its own values", () => {
    const g = recognise(GREGORIAN).year;
    if (g.kind !== "form") throw new Error("Gregorian's year is a field");
    expect(yearWords(g.value)).toBe("365 days; a leap year (366 days) every 4th year, except every 100th year, but every 400th year");
    expect(yearWords({ length: 360, firstYear: 1, leap: null })).toBe("360 days");
    expect(yearWords({ length: 1, firstYear: 1, leap: null })).toBe("1 day");
    expect(yearWords({ length: 365, firstYear: 1, leap: { add: 1, terms: [{ every: 4, at: 2, sign: 1 }] } })).toBe("365 days; a leap year (366 days) every 4th year counting from year 2");
    expect(yearWords({ length: 365, firstYear: 1, leap: { add: 1, terms: [{ every: 11, at: 0, sign: 1 }, { every: 12, at: 0, sign: 1 }, { every: 13, at: 0, sign: 1 }, { every: 21, at: 0, sign: 1 }] } })).toContain(
      "every 11th year, but every 12th year, but every 13th year, but every 21st year",
    );
  });

  test("months and weeks", () => {
    const f = calendarOfDefinition(GREGORIAN).form!;
    expect(monthsWords(f.months)).toBe("12 months (one takes the rest)");
    expect(monthsWords(null)).toBe("no months");
    expect(weekWords(f.week)).toBe("a 7-day week");
    expect(weekWords(null)).toBe("no week");
  });

  test("a month length is a whole number of days or rest", () => {
    expect(parseMonthLength(" 30 ")).toBe(30);
    expect(parseMonthLength("Rest")).toBe("slack");
    expect(parseMonthLength("30.5")).toBeNull();
    expect(parseMonthLength("-3")).toBeNull();
    expect(parseMonthLength("")).toBeNull();
    expect(showMonthLength("slack")).toBe("rest");
    expect(showMonthLength(28)).toBe("28");
  });

  test("the WRITES line says which parts are fields and which are text", () => {
    expect(calendarGrammar(calendarOfDefinition(GREGORIAN).form)).toBe(
      "calendar [year 365 days; a leap year (366 days) every 4th year, except every 100th year, but every 400th year · 12 months (one takes the rest) · a 7-day week] · the stored definition",
    );
    expect(calendarGrammar(calendarOfDefinition(HEBREW).form)).toContain("year as text");
    expect(calendarGrammar(undefined)).toBe("calendar · the legacy calendar's fields");
  });
});

describe("the ledger tab's words", () => {
  const view = { date: (d: number) => `D${d}`, yearStart: (y: number) => (y - 1) * 10, firstYear: 1 };

  test("every kind as a sentence, in the order of the first day each touches", () => {
    const rows = ledgerRows(
      {
        units: {
          year: [
            { kind: "starts", from: 4, startsOn: 41 },
            { kind: "slots", from: 1, unit: "month", lengths: [5, 5] },
            { kind: "switch", from: 9, rule: { anchor: 0, length: 12 } },
          ],
        },
        days: [{ day: 35, name: "Coronation", tags: ["coronation"] }],
        skips: { feast: [7] },
      },
      view,
    );
    expect(rows.map((r) => [r.key, r.first, r.text, r.asText])).toEqual([
      ["skip:feast:7", 7, "D7: rule feast cancelled this day", false],
      ["unit:year:1", 10, "Year 2: month lengths 5, 5", false],
      ["day:0", 35, "D35: Coronation (coronation)", false],
      ["unit:year:0", 41, "Year 5 starts on D41", false],
      ["unit:year:2", 90, "From Year 10 on: a different rule", true],
    ]);
  });

  test("an empty ledger has no rows; a start pinning more starts says so", () => {
    expect(ledgerRows({ units: {}, days: [], skips: {} }, view)).toEqual([]);
    expect(ledgerRows({ units: { year: [{ kind: "starts", from: 0, startsOn: 3, lengths: [9, 11] }] }, days: [], skips: {} }, view)[0]!.text).toBe("Year 1 starts on D3, then 2 more pinned (9, 11 days)");
  });

  test("month lengths as typed", () => {
    expect(parseLengths("31, 28 31")).toEqual([31, 28, 31]);
    expect(parseLengths("31, x")).toBeNull();
    expect(parseLengths("  ")).toBeNull();
    expect(parseLengths("30.5")).toBeNull();
  });
});
