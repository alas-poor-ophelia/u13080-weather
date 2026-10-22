/**
 * P3c step 5 (docs/SESHAT-v0.md §15.6, ruled 2026-10-21): a world with no
 * data.json starts on a plain calendar definition and is recorded as born on
 * one; a data.json missing a field is an existing world and stays where it
 * is. main.ts (Obsidian-bound) is pinned by a source scan.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "../src/seshat";
import { migrateSettings } from "../src/plugin/settings";
import { NEW_WORLD_CALENDAR, startNewWorld } from "../src/plugin/new-world";
import { recognise } from "../src/plugin/time/form";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { InternalCalendar } from "../src/plugin/time/internal";

describe("a new world", () => {
  test("starts on a plain definition: 365-day years from year 1, the default moon, no seasons; born on a definition", () => {
    const s = migrateSettings(null);
    startNewWorld(s);
    expect(s.activeTimeAdapter).toBe("seshat");
    expect(s.calendar.origin).toBe("definition");
    const ast = parse(s.calendar.definition as string);
    expect(ast.name).toBe(NEW_WORLD_CALENDAR);
    expect(ast).not.toHaveProperty("seasons");
    const f = recognise(ast);
    expect(f.year).toEqual({ kind: "form", value: { length: 365, firstYear: 1, leap: null } });
    expect(f.moons.kind === "form" && f.moons.value.map((m) => [m.name, m.period])).toEqual([["Moon", { n: 2953, d: 100 }]]);
  });

  test("its days and moon read as the legacy default's do (the same world, now editable as a definition)", () => {
    const s = migrateSettings(null);
    const legacy = new InternalCalendar(s.calendar, () => 0);
    startNewWorld(s);
    const def = new SeshatCalendar(s.calendar.definition, () => 0);
    for (const d of [-400, -1, 0, 1, 200, 364, 365, 3650]) {
      const a = legacy.toContext(d);
      const b = def.toContext(d);
      expect([b.year, b.dayOfYear, b.yearLength]).toEqual([a.year, a.dayOfYear, a.yearLength]);
      expect(b.moons).toEqual(a.moons);
    }
  });

  test("the legacy fields stay filled, so an older build opening a new world runs the legacy calendar (accepted in P3a)", () => {
    const s = migrateSettings(null);
    startNewWorld(s);
    expect(s.calendar.yearLength).toBe(365);
    expect(s.calendar.moons.length).toBe(1);
  });
});

describe("an existing world never changes calendar on load", () => {
  test("an empty or partial data.json is an existing world: main.ts starts a new world only when there is no data.json", () => {
    const main = readFileSync("src/plugin/main.ts", "utf8");
    expect(main).toContain("if (loaded === null || loaded === undefined) startNewWorld(this.settings);");
    expect(main.match(/startNewWorld\(/g)?.length).toBe(1);
    for (const raw of [{}, { calendar: {} }, { zones: [] }, { activeTimeAdapter: "internal" }]) {
      const s = migrateSettings(raw);
      expect(s.activeTimeAdapter).toBe("internal");
      expect(s.calendar).not.toHaveProperty("origin");
      expect(s.calendar).not.toHaveProperty("definition");
    }
  });
});
