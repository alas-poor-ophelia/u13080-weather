/** The settings "Current day" field: a calendar date or a whole day number (bead wadjet-7ww). */
import { describe, expect, test } from "bun:test";
import { BAD_DAY_TEXT, dayFieldText, parseDayField, validateDayField } from "../src/plugin/current-day";
import { InternalCalendar } from "../src/plugin/time/internal";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { MAX_DAY_ORDINAL } from "../src/plugin/world";

const cal = new InternalCalendar(structuredClone(DEFAULT_SETTINGS.calendar), () => 0);

describe("current day field", () => {
  test("shows the calendar's date, counted from day 1, and it parses back", () => {
    const text = dayFieldText(cal, 3);
    expect(text).toContain("day 4");
    expect(parseDayField(cal, text)).toBe(3);
  });
  test("every day in a spread round-trips", () => {
    for (const d of [-400, -1, 0, 1, 364, 365, 100000]) expect(parseDayField(cal, dayFieldText(cal, d))).toBe(d);
  });
  test("a plain integer is a day number", () => {
    expect(parseDayField(cal, "12")).toBe(12);
    expect(parseDayField(cal, " -5 ")).toBe(-5);
    expect(parseDayField(cal, `${DEFAULT_SETTINGS.calendar.epochYear}-1`)).toBe(0);
  });
  test("a calendar that cannot parse still takes a whole day number and shows one", () => {
    const bare = { format: (d: number) => `Day ${d}` };
    expect(dayFieldText(bare, 7)).toBe("7");
    expect(parseDayField(bare, "7")).toBe(7);
    expect(parseDayField(bare, "Day 7")).toBeNull();
  });
  test("a calendar whose date does not read back shows the number", () => {
    expect(dayFieldText({ format: () => "soon", parse: () => null }, 9)).toBe("9");
  });
  test("invalid input gets the validation message", () => {
    expect(validateDayField(cal, "banana")).toBe(BAD_DAY_TEXT);
    expect(validateDayField(cal, "")).toBe(BAD_DAY_TEXT);
    expect(validateDayField(cal, "1.5")).toBe(BAD_DAY_TEXT);
    expect(validateDayField(cal, "3")).toBeUndefined();
    expect(validateDayField(cal, String(MAX_DAY_ORDINAL + 1))).toContain("only");
  });
});
