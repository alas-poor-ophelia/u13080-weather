import { describe, expect, test } from "bun:test";
import { evalCurve } from "../src/core/curve";
import { applyClimateOps, applyCurveOp, scaleAmplitude, shiftPhase } from "../src/core/curve-ops";
import { gregorianTime } from "../src/core/generator";
import { createGenerator, profileHash, resolveProfile, validateProfile } from "../src/core/profile";
import type { Preset, ZoneProfile } from "../src/core/types";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [], ...over };
}

describe("curve ops (climate stage)", () => {
  test("offset / scale / clamp per Curve variant", () => {
    expect(applyCurveOp(5, { param: "temperature.mean", op: "offset", value: 2 })).toBe(7);
    expect(applyCurveOp({ mean: 5, amplitude: 3, phase: 0.1 }, { param: "temperature.mean", op: "offset", value: 2 })).toEqual({ mean: 7, amplitude: 3, phase: 0.1 });
    expect(applyCurveOp({ mean: 5, amplitude: 3, phase: 0.1 }, { param: "temperature.mean", op: "scale", value: 2 })).toEqual({ mean: 10, amplitude: 6, phase: 0.1 });
    const kf = [{ at: 0.2, value: 1 }, { at: 0.7, value: 3 }];
    expect(applyCurveOp(kf, { param: "temperature.mean", op: "scale", value: 2 })).toEqual([{ at: 0.2, value: 2 }, { at: 0.7, value: 6 }]);
    expect(applyCurveOp(kf, { param: "temperature.mean", op: "clamp", max: 2 })).toEqual([{ at: 0.2, value: 1 }, { at: 0.7, value: 2 }]);
    const clampedH = applyCurveOp({ mean: 0, amplitude: 10, phase: 0 }, { param: "temperature.mean", op: "clamp", min: -2, max: 2 });
    for (let t = 0; t < 1; t += 0.05) {
      const v = evalCurve(clampedH, t);
      expect(v).toBeGreaterThanOrEqual(-2 - 1e-9);
      expect(v).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(applyCurveOp(kf, { param: "temperature.mean", op: "set", value: 4 })).toBe(4);
  });

  test("applyClimateOps touches only the named path and rejects unknown paths", () => {
    const out = applyClimateOps(fjord.climate, [
      { param: "temperature.mean", op: "offset", value: -3 },
      { param: "precipitation.freezingPoint", op: "set", value: 1.5 },
    ]);
    expect(evalCurve(out.temperature.mean, 0.5)).toBeCloseTo(evalCurve(fjord.climate.temperature.mean, 0.5) - 3, 9);
    expect(out.precipitation.freezingPoint).toBe(1.5);
    expect(out.precipitation.pww).toBe(fjord.climate.precipitation.pww);
    expect(() => applyClimateOps(fjord.climate, [{ param: "temperature.bogus", op: "set", value: 1 }])).toThrow(RangeError);
  });

  test("scaleAmplitude keeps the annual mean; shiftPhase moves the curve", () => {
    const c = fjord.climate.temperature.mean;
    const s = scaleAmplitude(c, 1.5);
    const mean = (x: typeof c) => Array.from({ length: 48 }, (_, i) => evalCurve(x, (i + 0.5) / 48)).reduce((a, b) => a + b, 0) / 48;
    expect(mean(s)).toBeCloseTo(mean(c), 1);
    const jan = evalCurve(c, 0.04);
    const jul = evalCurve(c, 0.54);
    expect(evalCurve(s, 0.54) - evalCurve(s, 0.04)).toBeGreaterThan(jul - jan);
    const flipped = shiftPhase(c, 0.5);
    expect(evalCurve(flipped, 0.04)).toBeCloseTo(jul, 6);
  });
});

describe("validateProfile", () => {
  test("a preset-derived zone validates clean (warnings allowed, no errors)", () => {
    const issues = validateProfile(zone());
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });

  test("catches: missing harmonic phase, bad persistence, unknown predicate, unknown op path, climate-stage with when", () => {
    const z = zone({
      climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, mean: { mean: 8, amplitude: 7 } as never, persistence: 0.97 } },
      modifiers: [
        { id: "a", when: { moonphase: [0, 1] } as never, apply: [] },
        { id: "b", apply: [{ param: "precipitation.chance", op: "set", value: 1 }] },
        { id: "c", stage: "climate", when: { tag: "x" }, apply: [] },
        { id: "c", apply: [{ param: "wind.speed", op: "clamp" }] },
      ],
    });
    const msgs = validateProfile(z).filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);
    expect(msgs.some((m) => m.includes("temperature.mean.phase"))).toBe(true);
    expect(msgs.some((m) => m.includes("persistence"))).toBe(true);
    expect(msgs.some((m) => m.includes('unknown predicate "moonphase"'))).toBe(true);
    expect(msgs.some((m) => m.includes("precipitation.chance"))).toBe(true);
    expect(msgs.some((m) => m.includes("unconditional"))).toBe(true);
    expect(msgs.some((m) => m.includes("duplicate modifier id"))).toBe(true);
    expect(msgs.some((m) => m.includes("clamp needs min and/or max"))).toBe(true);
    expect(() => resolveProfile(z)).toThrow(RangeError);
  });

  test("warnings for high persistence and long regimes do not block", () => {
    const z = zone({
      climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, persistence: 0.93 } },
      regimes: [{ id: "slow", weight: 1, meanDurationDays: 45 }],
    });
    const issues = validateProfile(z);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.filter((i) => i.level === "warning").length).toBe(2);
    expect(() => resolveProfile(z)).not.toThrow();
  });
});

describe("resolveProfile / profileHash", () => {
  test("climate-stage modifiers are applied to the curves; daily ones are passed through", () => {
    const z = zone({
      modifiers: [
        { id: "colder", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: -5 }] },
        { id: "d", apply: [{ param: "wind.speed", op: "scale", value: 2 }] },
      ],
    });
    const r = resolveProfile(z);
    expect(evalCurve(r.climate.temperature.mean, 0.5)).toBeCloseTo(evalCurve(fjord.climate.temperature.mean, 0.5) - 5, 9);
    expect(r.dailyModifiers.map((m) => m.id)).toEqual(["d"]);
  });

  test("hash is stable under key order and changes with any relevant edit", () => {
    const a = profileHash(zone());
    const reordered = JSON.parse(JSON.stringify(zone())) as ZoneProfile;
    expect(profileHash(reordered)).toBe(a);
    expect(profileHash(zone({ name: "Renamed" }))).toBe(a); // name is not part of generation
    expect(profileHash(zone({ modifiers: [{ id: "x", apply: [] }] }))).not.toBe(a);
    expect(profileHash(zone({ climate: { ...fjord.climate, precipitation: { ...fjord.climate.precipitation, freezingPoint: 1 } } }))).not.toBe(a);
    expect(a).toMatch(/^wh1:[0-9a-f]{16}$/);
  });
});

describe("createGenerator (end to end)", () => {
  test("an ashfall spell dries the zone while active and tags the records", () => {
    const z = zone({
      modifiers: [
        {
          id: "ashfall",
          when: { yearPhase: [0.61, 0.72] },
          spell: { meanStartsPerYear: 1.5, meanDurationDays: 12 },
          apply: [
            { param: "precipitation.pwd", op: "set", value: 0 },
            { param: "precipitation.pww", op: "set", value: 0 },
            { param: "cloud.dry", op: "set", value: 0.95 },
          ],
          tag: "ashfall",
        },
      ],
    });
    const { generator } = createGenerator(z, "world", gregorianTime);
    const recs = generator.range(0, 365 * 20);
    const ash = recs.filter((r) => r.tags.includes("ashfall"));
    expect(ash.length).toBeGreaterThan(100);
    expect(ash.every((r) => !r.wet)).toBe(true);
    expect(ash.reduce((a, r) => a + r.cloudCover, 0) / ash.length).toBeGreaterThan(0.8);
    // determinism across a fresh instance and single-day queries
    const again = createGenerator(z, "world", gregorianTime).generator;
    for (const d of [100, 2000, 4321]) expect(again.day(d)).toEqual(recs[d]!);
  });

  test("a witch-month tag from the calendar shifts temperature, and regime-gated modifiers see the regime", () => {
    const timeOf = (d: number) => ({ ...gregorianTime(d), tags: gregorianTime(d).yearPhase < 0.1 ? ["witch-month"] : [] });
    const z = zone({
      modifiers: [
        { id: "chill", when: { all: [{ tag: "witch-month" }, { not: { regime: "wet-spell" } }] }, apply: [{ param: "temperature.mean", op: "offset", value: -15 }], tag: "witch-chill" },
      ],
    });
    const a = createGenerator(z, "w", timeOf).generator.range(0, 365 * 10);
    const b = createGenerator(zone(), "w", timeOf).generator.range(0, 365 * 10);
    const chilled = a.filter((r) => r.tags.includes("witch-chill"));
    expect(chilled.length).toBeGreaterThan(200);
    expect(chilled.every((r) => r.regime !== "wet-spell")).toBe(true);
    // outside the witch-month the two worlds agree exactly on temperature (same seed, same draws)
    for (let d = 0; d < a.length; d++) {
      if (a[d]!.yearPhase >= 0.1) expect(a[d]!.tempMean).toBe(b[d]!.tempMean);
    }
    const meanA = chilled.reduce((s, r) => s + r.tempMean, 0) / chilled.length;
    const meanB = chilled.reduce((s, r) => s + b[r.dayOrdinal]!.tempMean, 0) / chilled.length;
    expect(meanA - meanB).toBeCloseTo(-15, 0);
  });
});
