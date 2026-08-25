/**
 * Every JSON block in docs/EXAMPLES.md must parse and validate against a real
 * preset zone (modifiers) or the era validator (eras), and generate without
 * throwing. Recipes that rot are worse than none.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { eraModifiers, validateEras, withEraTags } from "../src/core/eras";
import { createGenerator, validateProfile } from "../src/core/profile";
import type { DayTime, Era, Modifier, Preset } from "../src/core/types";
import { MODIFIER_EXAMPLES } from "../src/plugin/modifier-examples";
import { InternalCalendar } from "../src/plugin/time/internal";
import { zoneFromPreset } from "../src/plugin/zones";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const zoneOf = (id: string) => zoneFromPreset({ name: id, preset: presets.find((p) => p.id === id)!, existingIds: new Set() }).zone;

const doc = await Bun.file(new URL("../docs/EXAMPLES.md", import.meta.url)).text();
const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);

const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }, { name: "Ash", cycleDays: 41, phaseAtEpoch: 0.3 }], seasons: [{ name: "Winter", from: 0.9 }, { name: "Spring", from: 0.15 }, { name: "Summer", from: 0.4 }, { name: "Autumn", from: 0.65 }] }, () => 0);

const isEraList = (v: unknown): v is Era[] => Array.isArray(v) && v.length > 0 && typeof (v[0] as Era).from === "number";

describe("docs/EXAMPLES.md", () => {
  test("has a healthy number of recipes", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(15);
  });

  const eras: Era[] = [];
  const mods: Modifier[] = [];
  for (const b of blocks) {
    const v = JSON.parse(b) as unknown; // strict: the doc itself must be clean JSON
    if (isEraList(v)) eras.push(...v);
    else mods.push(...(Array.isArray(v) ? (v as Modifier[]) : [v as Modifier]));
  }

  test("every era list validates", () => {
    expect(eras.length).toBeGreaterThanOrEqual(4);
    expect(validateEras(eras).filter((i) => i.level === "error")).toEqual([]);
  });

  test("every modifier validates on a preset zone and generates", () => {
    expect(mods.length).toBeGreaterThanOrEqual(12);
    for (const zoneId of ["prairie", "fjord-coast", "savanna"]) {
      const z = { ...zoneOf(zoneId), modifiers: mods.map((m, i) => ({ ...m, id: `${m.id}-${i}` })) };
      const issues = validateProfile(z).filter((i) => i.level === "error");
      expect(issues).toEqual([]);
      const timeOf = (d: number): DayTime => withEraTags(eras, cal.toContext(d));
      const g = createGenerator(z, "recipes", timeOf, eraModifiers(eras)).generator;
      for (const d of [0, 100, 200, 300, 365 * 1250, 365 * 1920, 365 * 2000, 365 * 601]) {
        const r = g.day(d);
        expect(Number.isFinite(r.tempMean)).toBe(true);
        expect(r.precipMm).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the one-click examples in the editor are also in the recipe book", () => {
    for (const ex of MODIFIER_EXAMPLES) expect(doc).toContain(`"id": "${ex.modifier.id}"`);
  });
});
