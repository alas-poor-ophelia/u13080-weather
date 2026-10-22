/**
 * P3c step 3 (docs/SESHAT-v0.md §15.4): the Calendar window. Its hint table
 * is a contract with the DOM (a source scan, as for the Seasons window: the
 * window imports Obsidian), and its words come from the calendar's own values.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { CALENDAR_HINTS, CALENDAR_HINT_KEYS, calendarHint } from "../src/studio/model/hints-calendar";
import { calendarGrammar, monthsWords, parseMonthLength, showMonthLength, weekWords, yearWords } from "../src/studio/model/calendar-window";
import { GREGORIAN, HEBREW } from "../src/seshat";
import { recognise } from "../src/plugin/time/form";
import { calendarOfDefinition } from "../src/studio/model/definition";

const SOURCE = readFileSync(new URL("../src/studio/ui/windows/calendar.ts", import.meta.url), "utf8");

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
