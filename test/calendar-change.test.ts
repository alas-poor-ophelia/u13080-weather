/**
 * P3c step 3 (docs/SESHAT-v0.md §15.1 R7): the Save dialog's choices as pure
 * functions. Keeping day numbers stores the change as made; anchoring moves
 * the calendar so today reads as the date asked for.
 */
import { describe, expect, test } from "bun:test";
import { GREGORIAN, print, type CalendarAst } from "../src/seshat";
import { planChange, worldHasSpells } from "../src/plugin/calendar-change";
import { compile, recognise } from "../src/plugin/time/form";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import type { Modifier, ZoneProfile } from "../src/core/types";

const BEFORE = print(GREGORIAN);
// the first year moved by one: every year's number, and its leap years, move
const year = recognise(GREGORIAN).year;
if (year.kind !== "form") throw new Error("Gregorian's year is a field");
const AFTER = print(compile(GREGORIAN, { year: { ...year.value, firstYear: 1 } }));
// 2024-03-01 in the calendar before the change
const TODAY = 19_783;

describe("planChange", () => {
  test("keep day numbers: the change as made, today reading as the new calendar reads it", () => {
    const p = planChange(AFTER, TODAY);
    if ("error" in p) throw new Error(p.error);
    expect(p.shift).toBe(0);
    expect(p.text).toBe(AFTER);
    expect(new SeshatCalendar(BEFORE, () => TODAY).format(TODAY)).toBe("2024-03-01");
    expect(p.today).toBe(new SeshatCalendar(AFTER, () => TODAY).format(TODAY));
    expect(p.today).not.toBe("2024-03-01");
  });

  test("anchor today: the calendar moves so today reads as asked, and the stored text says so", () => {
    const p = planChange(AFTER, TODAY, "2024-03-01");
    if ("error" in p) throw new Error(p.error);
    expect(p.today).toBe("2024-03-01");
    expect(p.shift).not.toBe(0);
    expect(new SeshatCalendar(p.text, () => TODAY).format(TODAY)).toBe("2024-03-01");
  });

  test("a bare day number anchors too", () => {
    const p = planChange(AFTER, TODAY, String(TODAY));
    if ("error" in p) throw new Error(p.error);
    expect(p.shift).toBe(0);
  });

  test("a date the calendar cannot read, or none, is refused with how today reads", () => {
    const bad = planChange(AFTER, TODAY, "the first of never");
    expect(bad).toMatchObject({ error: expect.stringContaining("is not a date in this calendar") as unknown as string });
    expect(planChange(AFTER, TODAY, "  ")).toEqual({ error: "Write the date today should read, or keep day numbers." });
  });

  test("a change that cannot run is refused with the definition's own message", () => {
    const broken: CalendarAst = { ...GREGORIAN, units: GREGORIAN.units.filter((u) => u.id !== "year") };
    expect("error" in planChange(print(broken), TODAY)).toBe(true);
  });
});

describe("worldHasSpells", () => {
  const z = (modifiers: Modifier[]): ZoneProfile => ({ id: "z", name: "z", schemaVersion: 1, modifiers } as unknown as ZoneProfile);
  const spell = { id: "s", when: { tag: "x" }, spell: { meanStartsPerYear: 1, meanDurationDays: 2 }, apply: [] } as unknown as Modifier;
  test("a zone with an enabled spell modifier; a disabled one does not count", () => {
    expect(worldHasSpells([z([])])).toBe(false);
    expect(worldHasSpells([z([]), z([spell])])).toBe(true);
    expect(worldHasSpells([z([{ ...spell, enabled: false }])])).toBe(false);
  });
});
