/**
 * Climate-stage `set` with a Curve value (PLAN §5.2). The Studio's swing knob and
 * keyframe edits write a whole curve through a climate-stage modifier so the zone's
 * stored `climate` — and therefore its preset provenance — is never mutated.
 */
import { describe, expect, test } from "bun:test";
import { evalCurve } from "../src/core/curve";
import { applyCurveOp, CURVE_PATHS } from "../src/core/curve-ops";
import { gregorianTime } from "../src/core/generator";
import { applyDayOps, type DayParams } from "../src/core/ops";
import { createGenerator, resolveProfile, validateProfile, type ValidationIssue } from "../src/core/profile";
import type { Curve, Harmonic, Keyframe, Modifier, Preset, ZoneProfile } from "../src/core/types";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [], ...over };
}

/** A zone whose daily temperature is a pure function of the curve: no spread, no diurnal range. */
function flatZone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return zone({
    climate: {
      ...fjord.climate,
      temperature: { ...fjord.climate.temperature, mean: 10, diurnalRange: 0, sd: 0, sdHigh: 0, sdLow: 0, wetDayOffset: 0, wetDayRangeOffset: 0 },
    },
    ...over,
  });
}

/** One climate-stage modifier that sets `param` to `value`. */
const setMod = (param: string, value: number | Curve, stage: Modifier["stage"] = "climate"): Modifier => ({ id: "studio", stage, apply: [{ param, op: "set", value }] });

const kfs: Keyframe[] = [
  { at: 0.04, value: -6 },
  { at: 0.29, value: 4 },
  { at: 0.54, value: 18 },
  { at: 0.79, value: 5 },
];
const harm: Harmonic = { mean: 9, amplitude: 11, phase: 0.55 };

const errors = (z: ZoneProfile): ValidationIssue[] => validateProfile(z).filter((i) => i.level === "error");
const paths = (z: ZoneProfile): string[] => errors(z).map((i) => i.path);

describe("applyCurveOp: set returns the value as-is", () => {
  test("a keyframe array replaces any curve variant, by identity", () => {
    for (const before of [3 as Curve, harm as Curve, [{ at: 0.5, value: 1 }] as Curve]) {
      expect(applyCurveOp(before, { param: "temperature.mean", op: "set", value: kfs })).toBe(kfs);
    }
  });

  test("a harmonic replaces a keyframe curve, and a number still replaces with a number", () => {
    expect(applyCurveOp(kfs, { param: "temperature.mean", op: "set", value: harm })).toBe(harm);
    expect(applyCurveOp(kfs, { param: "temperature.mean", op: "set", value: 4.5 })).toBe(4.5);
  });
});

describe("climate-stage set installs a Curve", () => {
  test("keyframes replace the curve and resolveProfile exposes them", () => {
    const z = zone({ modifiers: [setMod("temperature.mean", kfs)] });
    const resolved = resolveProfile(z);
    expect(resolved.climate.temperature.mean).toEqual(kfs);
    for (const t of [0.2, 0.65]) expect(evalCurve(resolved.climate.temperature.mean, t)).toBeCloseTo(evalCurve(kfs, t), 12);
  });

  test("a harmonic replaces the curve and resolveProfile exposes it", () => {
    const z = zone({ modifiers: [setMod("temperature.mean", harm)] });
    const resolved = resolveProfile(z);
    expect(resolved.climate.temperature.mean).toEqual(harm);
    for (const t of [harm.phase, harm.phase + 0.5]) expect(evalCurve(resolved.climate.temperature.mean, t)).toBeCloseTo(evalCurve(harm, t), 12);
  });

  test("the zone's stored climate is not mutated (preset provenance survives the edit)", () => {
    const z = zone({ modifiers: [setMod("temperature.mean", kfs)] });
    resolveProfile(z);
    expect(z.climate.temperature.mean).toEqual(fjord.climate.temperature.mean);
    expect(z.climate).toEqual(fjord.climate);
  });

  test("a set on one path leaves its siblings alone", () => {
    const resolved = resolveProfile(zone({ modifiers: [setMod("precipitation.pww", harm)] }));
    expect(resolved.climate.precipitation.pww).toEqual(harm);
    expect(resolved.climate.precipitation.pwd).toEqual(fjord.climate.precipitation.pwd);
    expect(resolved.climate.temperature.mean).toEqual(fjord.climate.temperature.mean);
  });

  test("a keyframe set on temperature.mean drives the generator's 365-day mean", () => {
    const z = flatZone({ modifiers: [setMod("temperature.mean", kfs)] });
    const recs = createGenerator(z, "w", gregorianTime).generator.range(0, 364);
    const actual = recs.reduce((t, r) => t + r.tempMean, 0) / recs.length;
    let curveMean = 0;
    for (let i = 0; i < 365; i++) curveMean += evalCurve(kfs, (i + 0.5) / 365);
    curveMean /= 365;
    expect(actual).toBeCloseTo(curveMean, 0); // within 0.5 °C
    // and it really moved off the flat base of 10 °C
    expect(Math.abs(actual - 10)).toBeGreaterThan(0.5);
  });
});

describe("validation of a Curve-valued set", () => {
  test("a daily-stage set with a curve is an error at apply[i].value", () => {
    const z = zone({ modifiers: [setMod("temperature.mean", kfs, "daily")] });
    expect(paths(z)).toEqual(["modifiers[0].apply[0].value"]);
    expect(errors(z)[0]!.message).toBe("set with a curve is climate stage only");
    // harmonics too, and the default stage (absent) is daily
    expect(paths(zone({ modifiers: [{ id: "m", apply: [{ param: "temperature.mean", op: "set", value: harm }] }] }))).toEqual(["modifiers[0].apply[0].value"]);
  });

  test("a regime's ops are daily-stage too", () => {
    const z = zone({ regimes: [{ ...fjord.regimes[0]!, apply: [{ param: "temperature.mean", op: "set", value: kfs }] }] });
    expect(paths(z)).toEqual(["regimes[0].apply[0].value"]);
  });

  test("a malformed curve reports the curve's own errors under apply[i].value…", () => {
    const noPhase = zone({ modifiers: [setMod("temperature.mean", { mean: 1, amplitude: 2 } as unknown as Harmonic)] });
    expect(paths(noPhase)).toEqual(["modifiers[0].apply[0].value.phase"]);

    const badKf = zone({ modifiers: [setMod("temperature.mean", [{ at: 1.5, value: 3 }, { at: 0.2, value: Number.NaN }])] });
    expect(paths(badKf)).toEqual(["modifiers[0].apply[0].value[0].at", "modifiers[0].apply[0].value[1].value"]);

    const empty = zone({ modifiers: [setMod("temperature.mean", [])] });
    expect(paths(empty)).toEqual(["modifiers[0].apply[0].value"]);

    const notACurve = zone({ modifiers: [setMod("temperature.mean", "warm" as unknown as Curve)] });
    expect(paths(notACurve)).toEqual(["modifiers[0].apply[0].value"]);
  });

  test("a curve cannot be set on a climate-stage scalar path", () => {
    const z = zone({ modifiers: [setMod("temperature.phase", kfs)] });
    expect(paths(z)).toEqual(["modifiers[0].apply[0].value"]);
    expect(errors(z)[0]!.message).toContain("scalar parameter");
  });

  test("a well-formed Curve-valued set validates clean at the climate stage", () => {
    expect(paths(zone({ modifiers: [setMod("temperature.mean", kfs)] }))).toEqual([]);
    expect(paths(zone({ modifiers: [setMod("temperature.mean", harm)] }))).toEqual([]);
    expect(paths(zone({ modifiers: [setMod("wind.direction", 180)] }))).toEqual([]);
  });

  test("the envelope warning on set survives the widened value type", () => {
    const z = zone({ modifiers: [{ id: "m", apply: [{ param: "temperature.mean", op: "set", value: 3, envelope: [[0, 1]] }] }] });
    const warnings = validateProfile(z).filter((i) => i.level === "warning" && i.path === "modifiers[0].apply[0].envelope");
    expect(warnings.map((w) => w.message)).toEqual(["envelope has no effect on set/clamp"]);
  });
});

describe("numeric set is untouched", () => {
  test("a number-valued climate-stage set validates and resolves exactly as before", () => {
    const z = zone({ modifiers: [setMod("temperature.mean", 12)] });
    expect(paths(z)).toEqual([]);
    const resolved = resolveProfile(z);
    expect(resolved.climate.temperature.mean).toBe(12);
    // identical to hand-writing the same climate with no modifier at all
    const direct = zone({ climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, mean: 12 } } });
    expect(resolved.climate).toEqual(resolveProfile(direct).climate);
  });

  test("a number-valued daily-stage set still lands, and the generator agrees", () => {
    const withSet = createGenerator(flatZone({ modifiers: [setMod("temperature.mean", 21, "daily")] }), "w", gregorianTime).generator.range(0, 40);
    for (const r of withSet) expect(r.tempMean).toBeCloseTo(21, 6);
  });

  test("applyDayOps skips a curve-valued set instead of writing a non-number", () => {
    const base = Object.fromEntries(CURVE_PATHS.map((p) => [p, 1])) as unknown as DayParams;
    const out = applyDayOps({ ...base, "temperature.mean": 5 }, [{ param: "temperature.mean", op: "set", value: kfs }]);
    expect(out["temperature.mean"]).toBe(5);
    expect(Number.isFinite(out["temperature.mean"])).toBe(true);
    // a numeric set on the same path still applies
    expect(applyDayOps({ ...base, "temperature.mean": 5 }, [{ param: "temperature.mean", op: "set", value: -2 }])["temperature.mean"]).toBe(-2);
  });
});
