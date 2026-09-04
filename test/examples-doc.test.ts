/**
 * Every JSON block in docs/EXAMPLES.md must parse and validate against a real
 * preset zone (modifiers), the era validator (eras) or the zone validator
 * (automation lanes), and generate without throwing. Recipes that rot are worse
 * than none.
 *
 * Two recipes carry an *interaction* rather than a shape — a gate and an
 * envelope on a moon device, and an automation ramp across a century — and for
 * those, parsing and validating proves nothing. Each has a test below that
 * rolls the real generator and pins the number the recipe's prose promises,
 * against a fixture flattened (sd 0, no spread) so the arithmetic is exact.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { eraModifiers, validateEras, withEraTags } from "../src/core/eras";
import { sampleEnvelope } from "../src/core/modifiers";
import { createGenerator, validateProfile } from "../src/core/profile";
import type { AutomationLane, DayTime, Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
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
const isAutomationBlock = (v: unknown): v is { automation: AutomationLane[] } => typeof v === "object" && v !== null && Array.isArray((v as { automation?: unknown }).automation);

const eras: Era[] = [];
const mods: Modifier[] = [];
const lanes: AutomationLane[] = [];
for (const b of blocks) {
  const v = JSON.parse(b) as unknown; // strict: the doc itself must be clean JSON
  if (isEraList(v)) eras.push(...v);
  else if (isAutomationBlock(v)) lanes.push(...v.automation);
  else mods.push(...(Array.isArray(v) ? (v as Modifier[]) : [v as Modifier]));
}

const byId = (id: string): Modifier => {
  const m = mods.find((x) => x.id === id);
  if (!m) throw new Error(`docs/EXAMPLES.md no longer has a recipe with id "${id}"`);
  return m;
};

describe("docs/EXAMPLES.md", () => {
  test("has a healthy number of recipes", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(17);
  });

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

  test("every automation lane validates on a preset zone and generates", () => {
    expect(lanes.length).toBeGreaterThanOrEqual(1);
    for (const zoneId of ["prairie", "fjord-coast", "savanna"]) {
      const z: ZoneProfile = { ...zoneOf(zoneId), automation: lanes };
      expect(validateProfile(z).filter((i) => i.level === "error")).toEqual([]);
      const g = createGenerator(z, "recipes", (d: number) => cal.toContext(d)).generator;
      for (const d of [0, 365 * 50, 365 * 100, 365 * 400]) expect(Number.isFinite(g.day(d).tempMean)).toBe(true);
    }
  });

  test("the one-click examples in the editor are also in the recipe book", () => {
    for (const ex of MODIFIER_EXAMPLES) expect(doc).toContain(`"id": "${ex.modifier.id}"`);
  });
});

/**
 * "Spring tide": the recipe's promise is +14 km/h at full Sable inside
 * `season:Summer` — the gate's source — and +7 outside it, where the gate at
 * `amount: 0.5` takes half (D19), ramping to nothing at the edges of the
 * window. Wind is flattened (`speedSd: 0`, `calmFraction: 0`,
 * `wetDayScale: 1`) so the day's wind speed is exactly `10 + 14 · strength ·
 * gate` and the claim can be checked outright.
 */
describe("docs/EXAMPLES.md — spring tide (gate × envelope)", () => {
  const tide = byId("spring-tide");
  const ungated: Modifier = { ...tide };
  delete ungated.mods;

  // One regime with no ops of its own, so the only thing touching wind is the recipe.
  const flatWind = (m: Modifier | null): ZoneProfile => {
    const z = zoneOf("prairie");
    return { ...z, climate: { ...z.climate, wind: { ...z.climate.wind, speed: 10, speedSd: 0, calmFraction: 0, wetDayScale: 1 } }, regimes: [{ id: "settled", weight: 1, meanDurationDays: 5 }], modifiers: m ? [m] : [] };
  };
  const year = (m: Modifier | null) => createGenerator(flatWind(m), "spring-tide", (d: number) => cal.toContext(d)).generator.range(0, 364);

  const bare = year(null);
  const withGate = year(tide);
  const noGate = year(ungated);

  const days = [...Array(365).keys()].map((d) => {
    const ctx = cal.toContext(d);
    return { d, phase: ctx.moons!.find((x) => x.name === "Sable")!.phase, season: (ctx.tags ?? []).find((t) => t.startsWith("season:")) ?? "" };
  });
  const env = tide.apply[0]!.envelope!;
  const strength = (phase: number) => (phase >= 0.4 && phase < 0.6 ? sampleEnvelope(env, phase) : 0);

  test("the flattened zone really is flat: no modifier means a constant 10 km/h", () => {
    for (const r of bare) expect(r.windSpeedKph).toBeCloseTo(10, 7);
  });

  test("every day's wind is 10 + 14 × envelope strength × gate", () => {
    for (const { d, phase, season } of days) {
      // D19: a gate RESTRICTS the device to its source — ×1 inside season:Summer, ×(1 − 0.5) outside it
      const gate = season === "season:Summer" ? 1 : 0.5;
      expect(withGate[d]!.windSpeedKph, `day ${d}`).toBeCloseTo(10 + 14 * strength(phase) * gate, 7);
      expect(noGate[d]!.windSpeedKph, `day ${d}`).toBeCloseTo(10 + 14 * strength(phase), 7);
    }
  });

  test("the seasons OUTSIDE the gate's source differ when the gate is removed; the source does not", () => {
    const differing = (name: string) => days.filter((x) => x.season === name && Math.abs(withGate[x.d]!.windSpeedKph - noGate[x.d]!.windSpeedKph) > 1e-9).length;
    // Summer is the gate's source: inside it the device runs whole, so nothing moves.
    expect(differing("season:Summer")).toBe(0);
    expect(days.some((x) => x.season === "season:Summer" && strength(x.phase) > 0)).toBe(true);
    // Autumn is outside it: the gate halves the device, so every day the device fires moves.
    expect(differing("season:Autumn")).toBeGreaterThan(0);
    expect(differing("season:Autumn")).toBe(days.filter((x) => x.season === "season:Autumn" && strength(x.phase) > 0).length);
  });

  test("the envelope is a ramp, not a switch: peak at full moon, nothing at the edges", () => {
    const active = days.filter((x) => strength(x.phase) > 0);
    expect(active.length).toBeGreaterThan(10);
    const peak = active.reduce((a, b) => (Math.abs(b.phase - 0.5) < Math.abs(a.phase - 0.5) ? b : a));
    const edge = active.reduce((a, b) => (b.phase < a.phase ? b : a));
    expect(noGate[peak.d]!.windSpeedKph).toBeGreaterThan(noGate[edge.d]!.windSpeedKph);
    expect(noGate[peak.d]!.windSpeedKph).toBeLessThanOrEqual(10 + 14 + 1e-9);
    // outside the window the device contributes nothing at all
    for (const x of days.filter((y) => strength(y.phase) === 0)) expect(noGate[x.d]!.windSpeedKph).toBeCloseTo(10, 7);
  });
});

/**
 * "A century of warming": the recipe promises year 101 comes out ~3 °C warmer
 * than year 1. Temperature is flattened (sd 0, no diurnal range, no wet-day
 * offset) so each day's mean is exactly `10 + lane value`, and the lane's own
 * within-year slope is the only thing left to account for.
 */
describe("docs/EXAMPLES.md — a century of warming (automation ramp)", () => {
  const warmth = lanes.find((l) => l.id === "frc.warmth")!;

  const flatTemp = (automation: AutomationLane[]): ZoneProfile => {
    const z = zoneOf("prairie");
    return {
      ...z,
      climate: { ...z.climate, temperature: { ...z.climate.temperature, mean: 10, diurnalRange: 0, sd: 0, sdHigh: 0, sdLow: 0, wetDayOffset: 0, wetDayRangeOffset: 0 } },
      modifiers: [],
      automation,
    };
  };
  const yearMean = (automation: AutomationLane[], y: number) => {
    const from = 365 * (y - 1);
    const rs = createGenerator(flatTemp(automation), "warming", (d: number) => cal.toContext(d)).generator.range(from, from + 364);
    return rs.reduce((t, r) => t + r.tempMean, 0) / rs.length;
  };

  test("the recipe is the lane the prose describes", () => {
    expect(warmth).toEqual({ id: "frc.warmth", param: "temperature.mean", op: "offset", points: [[1, 0], [101, 3]] });
  });

  test("year 101 is 3 °C warmer than year 1, less the ramp already travelled inside year 1", () => {
    const y1 = yearMean([warmth], 1);
    const y101 = yearMean([warmth], 101);
    // Year 1 spans fractional years 1.000…1.997, so it has already climbed 3 × mean(yearPhase) / 100 ≈ 0.015.
    // Year 101 is past the last point and clamped flat at +3.
    expect(y1).toBeCloseTo(10 + (3 * 0.5) / 100, 2);
    expect(y101).toBeCloseTo(13, 9);
    expect(y101 - y1).toBeCloseTo(3 - (3 * 0.5) / 100, 2);
  });

  test("the ramp is monotone across the century and flat after it", () => {
    const means = [1, 26, 51, 76, 101].map((y) => yearMean([warmth], y));
    for (let i = 1; i < means.length; i++) expect(means[i]!).toBeGreaterThan(means[i - 1]! + 0.7);
    expect(yearMean([warmth], 400)).toBeCloseTo(yearMean([warmth], 101), 9);
  });

  test("no lane leaves the zone exactly where it was", () => {
    expect(yearMean([], 101)).toBeCloseTo(10, 9);
  });
});
