/**
 * The settings tab's Calendar group (bead wadjet-44d, from the Guildmaster's
 * live check 2026-10-21): one row says what the world runs on, in words,
 * with today's date, and offers what can be done from there; a calendar
 * plugin is chosen by name, in a row that appears only when one is installed.
 * calendarRow is pure; settings-tab.ts (Obsidian-bound) is pinned by a source
 * scan, as test/codeblock-repaint does for main.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { calendarRow, definitionSummary, type CalendarRowInput } from "../src/plugin/calendar-row";
import { WORLD_PRESETS } from "../src/plugin/opt-in";
import { GREGORIAN, ROMAN, type CalendarAst } from "../src/seshat";

const base: CalendarRowInput = { activeId: "internal", internal: { yearLength: 365, epochYear: 1 }, definition: null, fault: null, stored: null, today: "Year 1, day 4", plugins: [] };

describe("calendarRow says what the world runs on, and offers what can be done from there", () => {
  test("the internal calendar: its years and today; Change calendar… is the way to a definition", () => {
    const r = calendarRow(base);
    expect(r.name).toBe("Internal calendar");
    expect(r.desc).toContain("years of 365 days from year 1");
    expect(r.desc).toContain("Today is Year 1, day 4.");
    expect(r.actions).toEqual(["change"]);
    expect(r.choices).toBeNull(); // no plugin installed: no chooser at all
  });

  test("the internal calendar with a definition stored from an earlier switch says it is there", () => {
    const r = calendarRow({ ...base, stored: "Gregorian" });
    expect(r.desc).toContain("A calendar definition (Gregorian) is also stored");
    expect(r.actions).toEqual(["change"]);
  });

  test("a fractional year length reads as a number, not as float noise", () => {
    expect(calendarRow({ ...base, internal: { yearLength: 365.2422, epochYear: 1 } }).desc).toContain("years of 365.2422 days");
  });

  test("a world on a definition: its name, today in its calendar; edit, change, or back to the internal calendar", () => {
    const r = calendarRow({ ...base, activeId: "seshat", definition: "Gregorian", stored: "Gregorian", today: "2024-02-27" });
    expect(r.name).toBe("Gregorian (calendar definition)");
    expect(r.desc).toContain("Today is 2024-02-27.");
    expect(r.actions).toEqual(["edit", "change", "internal"]);
  });

  test("a definition that cannot run says so, says no weather is made, and still offers the repair", () => {
    const r = calendarRow({ ...base, activeId: "seshat", fault: "line 9: no gear \"nogear\"", stored: null, today: "not set" });
    expect(r.name).toBe("Calendar definition (cannot run)");
    expect(r.desc).toContain("cannot run: line 9: no gear");
    expect(r.desc).toContain("No weather is made until it is fixed");
    expect(r.desc).not.toContain("Today is");
    expect(r.actions).toEqual(["edit", "change", "internal"]);
  });

  test("a calendar plugin: its own name; edited there; the only way out is back to the internal calendar", () => {
    const r = calendarRow({ ...base, activeId: "foo", plugins: [{ id: "foo", label: "Almanac of Foo" }], today: "Wet 12, year 3" });
    expect(r.name).toBe("Almanac of Foo (calendar plugin)");
    expect(r.desc).toContain("edit it there");
    expect(r.actions).toEqual(["internal"]);
  });

  test("the chooser appears only with a plugin installed, and lists every calendar by name", () => {
    const r = calendarRow({ ...base, stored: "Gregorian", plugins: [{ id: "foo", label: "Almanac of Foo" }] });
    expect(r.choices).toEqual({ internal: "Internal calendar", seshat: "Gregorian (calendar definition)", foo: "Almanac of Foo (calendar plugin)" });
    // no stored definition: it is not offered
    expect(calendarRow({ ...base, plugins: [{ id: "foo", label: "Almanac of Foo" }] }).choices).toEqual({ internal: "Internal calendar", foo: "Almanac of Foo (calendar plugin)" });
  });
});

describe("settings-tab.ts renders the row, and the raw-id dropdown is gone", () => {
  const src = readFileSync("src/plugin/settings-tab.ts", "utf8");

  test("the old rows are gone: no adapter ids as labels, no 'Calendar source', no 'Use a calendar definition'", () => {
    expect(src).not.toContain('name: "Calendar source"');
    expect(src).not.toContain('name: "Use a calendar definition"');
    expect(src).not.toMatch(/options: Object\.fromEntries\(adapters\.map\(\(a\) => \[a, a\]\)\)/);
  });

  test("the row's three actions each have their button, and the chooser shows only with plugins", () => {
    expect(src).toContain('setButtonText("Edit definition")');
    expect(src).toContain('setButtonText("Change calendar…")');
    expect(src).toContain('setButtonText("Use the internal calendar")');
    expect(src).toMatch(/name: "Calendar plugin",[\s\S]{0,200}visible: \(\) => row\.choices !== null/);
  });
});

describe("definitionSummary describes a definition by its own structure (not a fixed sentence)", () => {
  test("every preset, read off its own units, around day 0", () => {
    const want: Record<string, string> = {
      Gregorian: "years of 365 or 366 days · 12 months · 7-day weeks · 7 weekday names",
      "Tabular Islamic (civil epoch)": "years of 354 or 355 days · 12 months",
      Hebrew: "years of 353 to 385 days · 12 or 13 months",
      Coptic: "years of 365 or 366 days · 13 months",
      "French Republican (Romme)": "years of 365 or 366 days · 12 months + 5 or 6 days outside them · 3 decades per month",
      Harptos: "years of 365 or 366 days · 12 months + 5 or 6 days outside them · 3 tendays per month",
    };
    for (const p of WORLD_PRESETS) if (p.ast.name in want) expect([p.ast.name, definitionSummary(p.ast)]).toEqual([p.ast.name, want[p.ast.name]!]);
  });

  test("years are sampled around the world's current day: the Roman calendar reads differently by era", () => {
    expect(definitionSummary(ROMAN, 0)).toBe("years of 365 or 366 days · 12 months");
    // about 2050 years before 1970: the Republic, its intercalary months, and Caesar's 445-day year of confusion within 200 years
    expect(definitionSummary(ROMAN, -Math.round(2050 * 365.25))).toBe("years of 355 to 445 days · 12 to 15 months");
  });

  test("seasons, moons, named rules and marked days are counted", () => {
    const ast: CalendarAst = {
      ...GREGORIAN,
      seasons: { unit: "year", marks: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] },
      bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna" } }],
      rules: [{ id: "fair", tags: ["fair"], rule: { kind: "dates", days: [5] } }],
      days: [{ day: 10, tags: ["coronation"] }],
    };
    expect(definitionSummary(ast)).toBe("years of 365 or 366 days · 12 months · 7-day weeks · 7 weekday names · 2 seasons · 1 moon · 1 named rule · 1 marked day");
  });

  test("a part the engine cannot answer is left out; the rest still reads", () => {
    const broken = { ...GREGORIAN, units: [{ id: "year", kind: "cycle", anchor: 0, length: 0 }], seasons: { unit: "year", marks: [{ name: "Wet", from: 0 }] } } as unknown as CalendarAst;
    expect(definitionSummary(broken)).toBe("1 season");
  });

  test("the row puts the summary, capitalised, before today", () => {
    const r = calendarRow({ ...base, activeId: "seshat", definition: "Gregorian", stored: "Gregorian", structure: "years of 365 or 366 days · 12 months", today: "2024-02-27" });
    expect(r.desc).toBe("Years of 365 or 366 days · 12 months. Today is 2024-02-27.");
    expect(calendarRow({ ...base, activeId: "seshat", definition: "X", stored: "X", structure: "", today: "d" }).desc).toBe("Today is d.");
  });
});
