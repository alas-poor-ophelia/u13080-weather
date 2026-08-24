import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { gregorianTime } from "../src/core/generator";
import { createGenerator, validateProfile } from "../src/core/profile";
import type { DayTime, Preset, ZoneProfile } from "../src/core/types";
import { MODIFIER_EXAMPLES, MODIFIER_GRAMMAR } from "../src/plugin/modifier-examples";
import { zoneFromPreset } from "../src/plugin/zones";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const fjord = presets.find((p) => p.id === "fjord-coast")!;

function zoneWith(mods: ZoneProfile["modifiers"]): ZoneProfile {
  return { ...zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone, modifiers: mods };
}

/** Gregorian time plus a moon named Sable (29.53-day cycle, new at day 0). */
const timeWithSable = (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name: "Sable", phase: ((d % 29.53) + 29.53) % 29.53 / 29.53 }] });

describe("modifier examples shown in the zone editor", () => {
  test("both examples validate without errors on a preset zone", () => {
    const issues = validateProfile(zoneWith(MODIFIER_EXAMPLES.map((e) => e.modifier)));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("the stormtide example fires on the Sable full moon and tags the day", () => {
    const { generator } = createGenerator(zoneWith([MODIFIER_EXAMPLES[0]!.modifier]), "example-seed", timeWithSable);
    const tagged = generator.range(0, 365).filter((r) => r.tags.includes("stormtide"));
    expect(tagged.length).toBeGreaterThan(20); // ~12% of days sit in the [0.88, 1.0] phase window
    expect(tagged.length).toBeLessThan(60);
    for (const r of tagged) expect(timeWithSable(r.dayOrdinal).moons![0]!.phase).toBeGreaterThanOrEqual(0.88);
  });

  test("the ashfall example produces multi-day dry spells within its window", () => {
    const { generator } = createGenerator(zoneWith([MODIFIER_EXAMPLES[1]!.modifier]), "example-seed", gregorianTime);
    const days = generator.range(0, 365 * 6);
    const ash = days.filter((r) => r.tags.includes("ashfall"));
    expect(ash.length).toBeGreaterThan(0);
    // spells are runs, not scattered days, and every ashfall day is dry and inside late summer
    let runs = 0;
    for (let i = 0; i < ash.length; i++) if (i === 0 || ash[i]!.dayOrdinal !== ash[i - 1]!.dayOrdinal + 1) runs++;
    expect(ash.length / runs).toBeGreaterThan(3);
    for (const r of ash) {
      expect(r.precipMm).toBe(0);
      const t = gregorianTime(r.dayOrdinal).yearPhase;
      expect(t).toBeGreaterThanOrEqual(0.61);
      expect(t).toBeLessThanOrEqual(0.72 + 18 / 365 + 0.01); // a spell may run past the window's end
    }
  });

  test("the grammar card lists every real param path", () => {
    const text = MODIFIER_GRAMMAR.flatMap((g) => g.lines).join("\n");
    for (const p of ["precipitation.pwd", "wind.speed", "cloud.dry", "temperature.mean", "temperature.phase"]) expect(text).toContain(p);
  });
});
