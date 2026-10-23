/**
 * The Date display setting and the codeblock `format:` option (bead
 * wadjet-01k.18): which definition format READ-only readouts use, when the
 * settings row shows, the quiet fallbacks, and which call sites use
 * displayDay (read-only) versus formatDay / api.format (typed, parsed,
 * stored, public).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GREGORIAN, print, type CalendarAst } from "../src/seshat";
import { defaultFormatName, displayChoices, displayControlValue, displayFormat, displaySetting, displayWith, showDisplayRow } from "../src/plugin/date-display";
import { parseCodeblock } from "../src/plugin/codeblock-parse";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { InternalCalendar } from "../src/plugin/time/internal";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/plugin/settings";

const withFormats = (formats: CalendarAst["formats"] | undefined, extra: Partial<CalendarAst> = {}): CalendarAst => {
  const { formats: _gregorian, ...rest } = GREGORIAN;
  void _gregorian;
  return { ...rest, ...extra, ...(formats ? { formats } : {}) };
};
const SHORT = { name: "default", pattern: "{year}-{month:pad2}-{month:day:pad2}" };
const SEASONED: CalendarAst = withFormats([SHORT, { name: "long", pattern: "{month:day} {month:name} {year} ({@season})" }], {
  seasons: { unit: "year", marks: [{ name: "Winter", from: 0 }, { name: "Summer", from: 0.5 }] },
});

describe("the Date display row", () => {
  test("shows only on a definition whose formats give more than one choice", () => {
    expect(showDisplayRow(GREGORIAN)).toBe(true); // default + long
    expect(showDisplayRow(withFormats([SHORT]))).toBe(false);
    expect(showDisplayRow(withFormats([SHORT, { name: "filler", pattern: "{year}" }]))).toBe(false); // filler is part of the default
    expect(showDisplayRow(withFormats(undefined))).toBe(false);
    expect(showDisplayRow(null)).toBe(false); // legacy world, another plugin's calendar, a faulted definition
  });
  test("choices: the default first (valued by its own name), then the others in definition order", () => {
    expect(displayChoices(GREGORIAN)).toEqual([
      { value: "default", label: "default" },
      { value: "long", label: "long" },
    ]);
    // no format named default: the first is the default, labelled so
    const firstIsDefault = withFormats([{ name: "short", pattern: "{year}" }, { name: "long", pattern: "{year} {@season}" }]);
    expect(defaultFormatName(firstIsDefault)).toBe("short");
    expect(displayChoices(firstIsDefault).map((c) => c.label)).toEqual(["short (default)", "long"]);
  });
});

describe("which format a readout uses", () => {
  test("the setting, when the definition declares it; else the default, silently", () => {
    expect(displayFormat(GREGORIAN, "long")).toBe("long");
    expect(displayFormat(GREGORIAN, undefined)).toBeUndefined();
    expect(displayFormat(GREGORIAN, "gone")).toBeUndefined();
    expect(displayFormat(GREGORIAN, "filler")).toBeUndefined();
  });
  test("a block's format: wins when declared; default picks the default; an unknown name falls back to the setting", () => {
    expect(displayFormat(GREGORIAN, "long", "default")).toBeUndefined();
    expect(displayFormat(GREGORIAN, undefined, "long")).toBe("long");
    expect(displayFormat(GREGORIAN, "long", "nope")).toBe("long");
    expect(displayFormat(GREGORIAN, undefined, "nope")).toBeUndefined();
    const firstIsDefault = withFormats([{ name: "short", pattern: "{year}" }, { name: "long", pattern: "{year}!" }]);
    expect(displayFormat(firstIsDefault, "long", "short")).toBeUndefined();
    expect(displayFormat(firstIsDefault, "long", "default")).toBeUndefined();
  });
  test("a named format removed from the definition: readouts and the dropdown fall back to the default", () => {
    const day = 738000;
    const before = new SeshatCalendar(print(SEASONED), () => day);
    const name = displayFormat(before.definition()!, "long");
    expect(name).toBe("long");
    const shown = displayWith(name, (n) => before.formatNamed(day, n), () => before.format(day));
    expect(shown).toMatch(/\((Winter|Summer)\)$/);
    expect(shown).not.toBe(before.format(day));
    // the definition is edited and loses "long"; the stored setting still says long
    const after = new SeshatCalendar(print(withFormats([SHORT], { seasons: SEASONED.seasons! })), () => day);
    const gone = displayFormat(after.definition()!, "long");
    expect(gone).toBeUndefined();
    expect(displayWith(gone, (n) => after.formatNamed(day, n), () => after.format(day))).toBe(after.format(day));
    expect(displayControlValue(after.definition(), "long")).toBe("default");
    expect(displayControlValue(before.definition(), "long")).toBe("long");
    expect(displayControlValue(null, "long")).toBe("");
  });
  test("the dropdown's choice: the default stores no field, another format stores its name", () => {
    expect(displaySetting(GREGORIAN, "default")).toBeUndefined();
    expect(displaySetting(GREGORIAN, "")).toBeUndefined();
    expect(displaySetting(GREGORIAN, "long")).toBe("long");
    expect(displaySetting(GREGORIAN, "gone")).toBeUndefined();
    expect(displaySetting(null, "long")).toBeUndefined();
  });
  test("a format that throws falls back to the default", () => {
    const cal = new SeshatCalendar(print(GREGORIAN), () => 0);
    expect(() => cal.formatNamed(0, "nope")).toThrow();
    expect(displayWith("nope", (n) => cal.formatNamed(0, n), () => cal.format(0))).toBe(cal.format(0));
    expect(displayWith(undefined, () => "never", () => "default")).toBe("default");
  });
});

describe("codeblock format:", () => {
  test("parses a name, and stays quiet on an empty one", () => {
    const spec = parseCodeblock("zone: z\nformat: long\n");
    expect(spec.errors).toEqual([]);
    expect(spec.format).toBe("long");
    const empty = parseCodeblock("zone: z\nformat:\n");
    expect(empty.errors).toEqual([]);
    expect(empty.format).toBeUndefined();
    expect(parseCodeblock("zone: z\n").format).toBeUndefined();
  });
});

describe("the stored setting", () => {
  test("kept per world through migration; a non-string is dropped; not part of any hash", () => {
    const base = { ...DEFAULT_SETTINGS, worldSeed: "s", calendar: { ...DEFAULT_SETTINGS.calendar, display: "long" } };
    expect(migrateSettings(base).calendar.display).toBe("long");
    expect("display" in migrateSettings({ ...base, calendar: { ...base.calendar, display: 7 } }).calendar).toBe(false);
    expect("display" in migrateSettings({ ...base, calendar: { ...base.calendar, display: "" } }).calendar).toBe(false);
    const a = migrateSettings(base).calendar;
    const { display: _drop, ...b } = a;
    void _drop;
    expect(new InternalCalendar(a, () => 0).configHash()).toBe(new InternalCalendar(b, () => 0).configHash());
  });
});

describe("call sites: displayDay for read-only readouts, formatDay / api.format elsewhere", () => {
  const src = (f: string) => readFileSync(path.join(import.meta.dir, "..", "src", f), "utf8");
  const main = src("plugin/main.ts");
  const tab = src("plugin/settings-tab.ts");
  test("main.ts: codeblock labels, the step notice, insert-today and pin-today display", () => {
    expect(main).toContain("this.displayDay(d, spec.format)");
    expect(main).toContain("new Notice(this.onDefinition() ? this.displayDay(now.dayOrdinal) : this.api.format(now.dayOrdinal))");
    expect(main).toContain("replaceSelection(`${this.displayDay(now.dayOrdinal)} — ");
    expect(main).toContain("new Notice(`Pinned ${zone.name} on ${this.displayDay(now.dayOrdinal)}.`)");
    // formatDay is called only as displayDay's own fallback
    expect(main.match(/this\.formatDay\(/g)?.length).toBe(1);
  });
  test("settings tab: the Current day line, the Pinned days list and the pin dialog's readouts display", () => {
    expect(tab).toContain("Now: ${this.plugin.displayDay(s.currentDayOrdinal)}.");
    expect(tab).toContain("${zone?.name ?? o.zoneId} · ${this.plugin.displayDay(o.dayOrdinal)}");
    expect(tab).toContain("const fmt = (d: number) => this.plugin.displayDay(d);");
    expect(tab).not.toContain("plugin.formatDay(");
  });
  test("the API, the Studio and typed dates never use the display format", () => {
    expect(src("plugin/api.ts")).not.toContain("displayDay");
    for (const f of ["studio/ui/header.ts", "studio/ui/windows/calendar.ts", "plugin/calendar-modals.ts", "plugin/opt-in.ts"]) expect(src(f)).not.toContain("displayDay");
  });
});
