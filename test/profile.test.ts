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

  test("hash of a fixture without optional fields is pinned (schema additions must not move it)", () => {
    // the preset-derived zone carries no `enabled` anywhere, so its canonical JSON — and this hash — is frozen
    expect(profileHash(zone())).toBe("wh1:5806b0fe11328ba9");
  });

  test("enabled: false switches a climate-stage modifier, and an op inside one, off", () => {
    const colder = { param: "temperature.mean", op: "offset" as const, value: -5 };
    const base = evalCurve(fjord.climate.temperature.mean, 0.5);
    const off = resolveProfile(zone({ modifiers: [{ id: "colder", stage: "climate", enabled: false, apply: [colder] }] }));
    expect(evalCurve(off.climate.temperature.mean, 0.5)).toBe(base);
    expect(off.climate).toBe(fjord.climate); // no ops at all: the stored curves are passed through untouched
    const partial = resolveProfile(
      zone({ modifiers: [{ id: "colder", stage: "climate", apply: [{ ...colder, enabled: false }, { param: "wind.speed", op: "offset", value: 3 }] }] }),
    );
    expect(evalCurve(partial.climate.temperature.mean, 0.5)).toBe(base);
    expect(evalCurve(partial.climate.wind.speed, 0.5)).toBeCloseTo(evalCurve(fjord.climate.wind.speed, 0.5) + 3, 9);
    // absent is enabled, and an explicit true is the same thing
    const on = resolveProfile(zone({ modifiers: [{ id: "colder", stage: "climate", enabled: true, apply: [colder] }] }));
    expect(evalCurve(on.climate.temperature.mean, 0.5)).toBeCloseTo(base - 5, 9);
  });

  test("enabled must be a boolean on a modifier and on an op", () => {
    const errs = (z: ZoneProfile) => validateProfile(z).filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);
    expect(errs(zone({ modifiers: [{ id: "m", enabled: "yes" as unknown as boolean, apply: [] }] }))).toEqual(["modifiers[0].enabled: enabled must be true or false"]);
    expect(errs(zone({ modifiers: [{ id: "m", apply: [{ param: "wind.speed", op: "offset", value: 1, enabled: "yes" as unknown as boolean }] }] }))).toEqual([
      "modifiers[0].apply[0].enabled: enabled must be true or false",
    ]);
    expect(errs(zone({ modifiers: [{ id: "m", enabled: false, apply: [{ param: "wind.speed", op: "offset", value: 1, enabled: true }] }] }))).toEqual([]);
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

describe("validateProfile: mod-matrix gates and onset envelopes", () => {
  const errs = (z: ZoneProfile) =>
    validateProfile(z)
      .filter((i) => i.level === "error")
      .map((i) => `${i.path}: ${i.message}`);
  const warns = (z: ZoneProfile) =>
    validateProfile(z)
      .filter((i) => i.level === "warning")
      .map((i) => `${i.path}: ${i.message}`);

  test("well-formed gates and envelopes validate clean", () => {
    const z = zone({
      modifiers: [
        {
          id: "stormtide",
          when: { moon: { name: "Sable", phase: [0.88, 1] } },
          mods: [{ source: "season:Harvest", amount: 0.5 }],
          apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5, envelope: [[0, 0], [0.5, 1]] }],
        },
        { id: "empty-gates", mods: [], apply: [] },
      ],
    });
    expect(validateProfile(z)).toEqual([]);
  });

  test("gates: climate stage, non-array, bad source and bad amount each report once", () => {
    expect(errs(zone({ modifiers: [{ id: "m", stage: "climate", mods: [{ source: "season:Harvest", amount: 1 }], apply: [] }] }))).toEqual([
      "modifiers[0].mods: gates (mods) are daily-stage only; a climate-stage modifier is unconditional",
    ]);
    expect(errs(zone({ modifiers: [{ id: "m", mods: { source: "x", amount: 1 } as never, apply: [] }] }))).toEqual(["modifiers[0].mods: mods must be an array"]);
    expect(
      errs(
        zone({
          modifiers: [
            {
              id: "m",
              mods: [
                { source: "", amount: 1 },
                { source: "season:Harvest", amount: -1 },
                { source: 3 as never, amount: Number.POSITIVE_INFINITY },
                null as never,
              ],
              apply: [],
            },
          ],
        }),
      ),
    ).toEqual([
      "modifiers[0].mods[0].source: must be a non-empty string (a tag, never a moon)",
      "modifiers[0].mods[1].amount: amount must be between 0 and 1 (a gate dims, it never amplifies)",
      "modifiers[0].mods[2].source: must be a non-empty string (a tag, never a moon)",
      "modifiers[0].mods[2].amount: amount must be between 0 and 1 (a gate dims, it never amplifies)",
      "modifiers[0].mods[3]: gate must be an object",
    ]);
  });

  test("a gate is a dimmer: amount above 1 is an error, and both ends of [0, 1] are legal", () => {
    const gates = (mods: Array<Record<string, unknown>>) => zone({ modifiers: [{ id: "m", mods: mods as never, apply: [{ param: "wind.speed", op: "offset", value: 1 }] }] });
    expect(errs(gates([{ source: "season:Harvest", amount: 1.5 }]))).toEqual(["modifiers[0].mods[0].amount: amount must be between 0 and 1 (a gate dims, it never amplifies)"]);
    // exactly 0 and exactly 1 are the two ends of the dimmer, not off-by-one rejections
    expect(validateProfile(gates([{ source: "a", amount: 0 }, { source: "b", amount: 1 }]))).toEqual([]);
  });

  test("a moon: gate source is an error — a moon is a carrier, not a gate", () => {
    const z = zone({ modifiers: [{ id: "m", mods: [{ source: "moon:Sable", amount: 0.5 }], apply: [] }] });
    expect(errs(z)).toEqual(["modifiers[0].mods[0].source: a gate is a tag; a moon is the carrier (use when.moon)"]);
    // the non-empty check still fires first, and only once
    expect(errs(zone({ modifiers: [{ id: "m", mods: [{ source: "", amount: 0.5 }], apply: [] }] }))).toEqual(["modifiers[0].mods[0].source: must be a non-empty string (a tag, never a moon)"]);
  });

  test("an unknown field on a gate warns and is ignored, as on an era", () => {
    const z = zone({ modifiers: [{ id: "m", mods: [{ source: "season:Harvest", amount: 0.5, amont: 0.25 } as never], apply: [] }] });
    expect(errs(z)).toEqual([]);
    expect(warns(z)).toEqual(["modifiers[0].mods[0].amont: unknown field (ignored)"]);
  });

  test("envelopes: empty, malformed points and climate stage are errors; set/clamp is a warning", async () => {
    const withEnvelope = (op: Record<string, unknown>, over: Partial<ZoneProfile> = {}) => zone({ modifiers: [{ id: "m", apply: [op as never] }], ...over });
    expect(errs(withEnvelope({ param: "precipitation.pwd", op: "offset", value: 1, envelope: [] }))).toEqual([
      "modifiers[0].apply[0].envelope: envelope must be a non-empty array of [phase, strength] points",
    ]);
    expect(errs(withEnvelope({ param: "precipitation.pwd", op: "offset", value: 1, envelope: [[1, 1], [-0.1, 1], [0.5, -1], [0.5, Number.NaN], [0.5] as never, "x" as never] }))).toEqual([
      "modifiers[0].apply[0].envelope[0]: envelope point must be [phase in [0,1), strength in [0,1]]",
      "modifiers[0].apply[0].envelope[1]: envelope point must be [phase in [0,1), strength in [0,1]]",
      "modifiers[0].apply[0].envelope[2]: envelope point must be [phase in [0,1), strength in [0,1]]",
      "modifiers[0].apply[0].envelope[3]: envelope point must be [phase in [0,1), strength in [0,1]]",
      "modifiers[0].apply[0].envelope[4]: envelope point must be [phase in [0,1), strength in [0,1]]",
      "modifiers[0].apply[0].envelope[5]: envelope point must be [phase in [0,1), strength in [0,1]]",
    ]);
    // a climate-stage op cannot carry one at all
    expect(errs(zone({ modifiers: [{ id: "m", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1, envelope: [[0, 1]] }] }] }))).toEqual([
      "modifiers[0].apply[0].envelope: envelope is a daily-stage onset shape; climate-stage ops cannot carry one",
    ]);
    // set/clamp: warning only, and the profile still generates
    const setZone = withEnvelope({ param: "cloud.dry", op: "set", value: 0.9, envelope: [[0, 1]] });
    expect(errs(setZone)).toEqual([]);
    expect(warns(setZone)).toEqual(["modifiers[0].apply[0].envelope: envelope has no effect on set/clamp"]);
    expect(warns(withEnvelope({ param: "wind.speed", op: "clamp", min: 0, envelope: [[0, 1]] }))).toEqual(["modifiers[0].apply[0].envelope: envelope has no effect on set/clamp"]);
    // era-timeline ops go through the same daily-stage rules
    const { validateDailyOps } = await import("../src/core/profile");
    const issues: Parameters<typeof validateDailyOps>[2] = [];
    validateDailyOps([{ param: "wind.speed", op: "offset", value: 1, envelope: [[2, 1]] }], "eras[0].apply", issues);
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual(["eras[0].apply[0].envelope[0]: envelope point must be [phase in [0,1), strength in [0,1]]"]);
  });

  test("an envelope is a dimmer too: strength above 1 is an error, and both ends of [0, 1] are legal", () => {
    const withEnvelope = (envelope: Array<[number, number]>) => zone({ modifiers: [{ id: "m", apply: [{ param: "wind.speed", op: "offset", value: 1, envelope }] }] });
    expect(errs(withEnvelope([[0.5, 2]]))).toEqual(["modifiers[0].apply[0].envelope[0]: envelope point must be [phase in [0,1), strength in [0,1]]"]);
    expect(validateProfile(withEnvelope([[0, 0], [0.5, 1]]))).toEqual([]);
  });
});

describe("gates and envelopes (end to end)", () => {
  test("a gate at amount 0 gives a day byte-equal to switching the modifier off", () => {
    const timeOf = (d: number) => ({ ...gregorianTime(d), tags: ["season:Harvest"] });
    // the anchor guarantees a non-empty op list on both sides, so day-param normalisation runs identically
    const anchor = { id: "anchor", apply: [{ param: "wind.speed", op: "offset" as const, value: 0 }] };
    const gated = {
      id: "gated",
      mods: [{ source: "season:Harvest", amount: 0 }],
      apply: [
        { param: "temperature.mean", op: "offset" as const, value: -8 },
        { param: "precipitation.pwd", op: "scale" as const, value: 2 },
      ],
    };
    const days = (mods: ZoneProfile["modifiers"]) => createGenerator(zone({ modifiers: mods }), "world", timeOf).generator.range(0, 800);
    const muted = days([anchor, gated]);
    const off = days([anchor, { ...gated, enabled: true, mods: [], apply: [] }]);
    expect(JSON.stringify(muted)).toBe(JSON.stringify(days([anchor, { ...gated, enabled: false }])));
    expect(JSON.stringify(muted)).toBe(JSON.stringify(off));
    // sanity: at full strength the same modifier does change the world
    expect(JSON.stringify(days([anchor, { ...gated, mods: [{ source: "season:Harvest", amount: 1 }] }]))).not.toBe(JSON.stringify(off));
  });

  test("an envelope shapes a moon-carried modifier over the lunar cycle", () => {
    const period = 29.5;
    const timeOf = (d: number) => ({ ...gregorianTime(d), moons: [{ name: "Sable", phase: (((d % period) + period) % period) / period }] });
    const z = (envelope?: Array<[number, number]>) =>
      zone({
        modifiers: [{ id: "moontide", when: { moon: { name: "Sable", phase: [0.5, 1] } }, apply: [{ param: "temperature.mean", op: "offset", value: -10, ...(envelope ? { envelope } : {}) }], tag: "moontide" }],
      });
    const flat = createGenerator(z(), "world", timeOf).generator.range(0, 365 * 2);
    // a ramp that is 0 at phase 0.5 and 1 at phase 0.99: the onset is gradual, the peak is the full -10
    const shaped = createGenerator(z([[0.5, 0], [0.99, 1]]), "world", timeOf).generator.range(0, 365 * 2);
    const tagged = flat.filter((r) => r.tags.includes("moontide")).map((r) => r.dayOrdinal);
    expect(tagged.length).toBeGreaterThan(300);
    expect(shaped.filter((r) => r.tags.includes("moontide")).map((r) => r.dayOrdinal)).toEqual(tagged); // shaping never changes WHO is active
    const phaseOf = (d: number) => timeOf(d).moons[0]!.phase;
    const onset = tagged.find((d) => Math.abs(phaseOf(d) - 0.5) < 0.02)!;
    const peak = tagged.find((d) => phaseOf(d) > 0.97)!;
    expect(shaped[onset]!.tempMean).toBeGreaterThan(flat[onset]!.tempMean + 8); // barely cooled at the onset
    expect(Math.abs(shaped[peak]!.tempMean - flat[peak]!.tempMean)).toBeLessThan(1); // effectively full strength at the peak
    // an untagged day is untouched by either run
    const quiet = flat.find((r) => !r.tags.length)!.dayOrdinal;
    expect(shaped[quiet]!.tempMean).toBe(flat[quiet]!.tempMean);
  });
});

describe("validateProfile: whitespace ids", () => {
  test("a whitespace-only modifier or regime id is required, not accepted", () => {
    const z = zone();
    z.modifiers = [{ id: "   ", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }];
    z.regimes = [{ id: " ", weight: 1, meanDurationDays: 5 }];
    const paths = validateProfile(z).filter((i) => i.message === "required").map((i) => i.path);
    expect(paths).toContain("modifiers[0].id");
    expect(paths).toContain("regimes[0].id");
  });
});
