/**
 * Automation lanes (PLAN.md §2, D6): interpolation, op emission, ordering
 * against the zone's daily modifiers, the hash rule, and the validator.
 */
import { describe, expect, test } from "bun:test";
import { automationOps, laneValue, validateAutomation } from "../src/core/automation";
import { gregorianTime } from "../src/core/generator";
import { createGenerator, profileHash, resolveProfile, validateProfile, type ValidationIssue } from "../src/core/profile";
import type { AutomationLane, DayTime, Preset, ZoneProfile } from "../src/core/types";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [], ...over };
}

/** A zone whose daily temperature is a pure function of the ops: flat mean, no spread, no diurnal range. */
function flatZone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return zone({
    climate: {
      ...fjord.climate,
      temperature: { ...fjord.climate.temperature, mean: 10, diurnalRange: 0, sd: 0, sdHigh: 0, sdLow: 0, wetDayOffset: 0, wetDayRangeOffset: 0 },
    },
    ...over,
  });
}

const lane = (over: Partial<AutomationLane> = {}): AutomationLane => ({ id: "warmth", param: "temperature.mean", op: "offset", points: [[1, 0]], ...over });

/** A time context in the shape automationOps wants. */
const at = (year: number, yearPhase = 0): DayTime & { dayOrdinal: number; yearLength: number } => ({ year, yearPhase, dayOrdinal: 0, yearLength: 365 });

describe("laneValue", () => {
  test("linear between points", () => {
    const l = lane({ points: [[2, 0], [4, 10]] });
    expect(laneValue(l, 2)).toBe(0);
    expect(laneValue(l, 3)).toBeCloseTo(5, 12);
    expect(laneValue(l, 2.5)).toBeCloseTo(2.5, 12);
    expect(laneValue(l, 4)).toBe(10);
  });

  test("clamped to the first value before the span and the last value after", () => {
    const l = lane({ points: [[2, -3], [4, 10]] });
    expect(laneValue(l, 1)).toBe(-3);
    expect(laneValue(l, -500)).toBe(-3);
    expect(laneValue(l, 4.0001)).toBe(10);
    expect(laneValue(l, 9999)).toBe(10);
  });

  test("a single point is a constant everywhere", () => {
    const l = lane({ points: [[7, 4.5]] });
    for (const y of [-100, 0, 6.99, 7, 7.01, 1e6]) expect(laneValue(l, y)).toBe(4.5);
  });

  test("multi-segment lanes pick the right segment", () => {
    const l = lane({ points: [[0, 0], [1, 10], [3, 10], [4, 0]] });
    expect(laneValue(l, 0.5)).toBeCloseTo(5, 12);
    expect(laneValue(l, 2)).toBe(10);
    expect(laneValue(l, 3.5)).toBeCloseTo(5, 12);
  });
});

describe("automationOps", () => {
  test("emits one op per lane, in lane order, at year + yearPhase", () => {
    const lanes = [lane({ id: "a", points: [[1, 0], [2, 12]] }), lane({ id: "b", param: "wind.speed", op: "scale", points: [[1, 2]] })];
    expect(automationOps(lanes, at(1, 0.5))).toEqual([
      { param: "temperature.mean", op: "offset", value: 6 },
      { param: "wind.speed", op: "scale", value: 2 },
    ]);
  });

  test("no lanes (undefined or empty) emits nothing", () => {
    expect(automationOps(undefined, at(3))).toEqual([]);
    expect(automationOps([], at(3))).toEqual([]);
  });

  test("enabled === false is skipped; enabled === true and absent are kept", () => {
    const lanes = [lane({ id: "off", enabled: false }), lane({ id: "on", enabled: true }), lane({ id: "default" })];
    expect(automationOps(lanes, at(1)).length).toBe(2);
  });

  test("falls back to counted years when the adapter supplies no year", () => {
    const t = { yearPhase: 0.25, dayOrdinal: 730, yearLength: 365 };
    // floor(730 / 365) + 1 = 3, plus yearPhase → 3.25
    expect(automationOps([lane({ points: [[3, 0], [4, 4]] })], t)).toEqual([{ param: "temperature.mean", op: "offset", value: 1 }]);
  });
});

describe("createGenerator with automation", () => {
  test("automation runs BEFORE the zone's daily modifiers: (mean + a) * s", () => {
    const a = 3;
    const s = 2;
    const z = flatZone({
      automation: [lane({ points: [[1, a]] })],
      modifiers: [{ id: "double", apply: [{ param: "temperature.mean", op: "scale", value: s }] }],
    });
    const recs = createGenerator(z, "w", gregorianTime).generator.range(0, 40);
    for (const r of recs) {
      expect(r.tempMean).toBeCloseTo((10 + a) * s, 6);
      // the other order would be 10 * s + a = 23
      expect(r.tempMean).not.toBeCloseTo(10 * s + a, 3);
    }
  });

  test("a disabled lane is a no-op through the generator", () => {
    const base = createGenerator(zone(), "w", gregorianTime).generator.range(0, 400);
    const off = createGenerator(zone({ automation: [lane({ points: [[1, 20]], enabled: false })] }), "w", gregorianTime).generator.range(0, 400);
    expect(off).toEqual(base);
  });

  test("an absent automation field leaves the roll bit-identical", () => {
    const base = createGenerator(zone(), "w", gregorianTime).generator.range(0, 400);
    expect(createGenerator(zone({ automation: [] }), "w", gregorianTime).generator.range(0, 400)).toEqual(base);
  });

  test("+8 °C across year 3 lifts that year's mean by 8 with the same seed", () => {
    const z = zone({ automation: [lane({ points: [[2, 0], [3, 8], [4, 8]] })] });
    const from = 365 * 2;
    const withLane = createGenerator(z, "w", gregorianTime).generator.range(from, from + 364);
    const without = createGenerator(zone(), "w", gregorianTime).generator.range(from, from + 364);
    const mean = (rs: typeof withLane) => rs.reduce((t, r) => t + r.tempMean, 0) / rs.length;
    expect(mean(withLane) - mean(without)).toBeCloseTo(8, 1); // tolerance 0.5 in the contract
    // and year 1, before the ramp, is untouched
    const y1a = createGenerator(z, "w", gregorianTime).generator.range(0, 364);
    const y1b = createGenerator(zone(), "w", gregorianTime).generator.range(0, 364);
    expect(mean(y1a) - mean(y1b)).toBeCloseTo(0, 6);
  });

  test("resolveProfile exposes automation (empty when absent)", () => {
    expect(resolveProfile(zone()).automation).toEqual([]);
    const l = lane();
    expect(resolveProfile(zone({ automation: [l] })).automation).toEqual([l]);
  });
});

describe("profileHash", () => {
  test("an empty or absent automation array does not move the hash", () => {
    const h = profileHash(zone());
    expect(profileHash(zone({ automation: [] }))).toBe(h);
    const absent = zone();
    expect("automation" in absent).toBe(false); // the field really is absent, not undefined
    expect(profileHash(absent)).toBe(h);
  });

  test("a lane moves the hash, and a disabled lane is still hashed", () => {
    const h = profileHash(zone());
    const l = lane({ points: [[1, 2]] });
    expect(profileHash(zone({ automation: [l] }))).not.toBe(h);
    expect(profileHash(zone({ automation: [{ ...l, enabled: false }] }))).not.toBe(h);
    expect(profileHash(zone({ automation: [{ ...l, enabled: false }] }))).not.toBe(profileHash(zone({ automation: [l] })));
  });
});

describe("validateAutomation", () => {
  const paths = (automation: unknown): string[] => validateProfile(zone({ automation } as Partial<ZoneProfile>)).filter((i) => i.level === "error").map((i) => i.path);

  test("a well-formed lane validates clean", () => {
    expect(paths([lane({ points: [[1, 0], [2, 3]], enabled: true })])).toEqual([]);
    expect(paths(undefined)).toEqual([]);
  });

  test("automation must be an array", () => {
    expect(paths({ warmth: 1 })).toEqual(["automation"]);
    expect(paths("nope")).toEqual(["automation"]);
  });

  test("a lane must be an object", () => {
    expect(paths([null])).toEqual(["automation[0]"]);
    expect(paths([7])).toEqual(["automation[0]"]);
  });

  test("id is required and unique", () => {
    expect(paths([lane({ id: "" })])).toEqual(["automation[0].id"]);
    expect(paths([lane({ id: undefined as unknown as string })])).toEqual(["automation[0].id"]);
    expect(paths([lane({ id: "dup" }), lane({ id: "dup" })])).toEqual(["automation[1].id"]);
  });

  test("param must be a curve path", () => {
    expect(paths([lane({ param: "temperature.phase" })])).toEqual(["automation[0].param"]); // scalar path: not a curve
    expect(paths([lane({ param: "temperature.bogus" })])).toEqual(["automation[0].param"]);
  });

  test("op must be offset or scale", () => {
    expect(paths([lane({ op: "set" as AutomationLane["op"] })])).toEqual(["automation[0].op"]);
    expect(paths([lane({ op: "clamp" as AutomationLane["op"] })])).toEqual(["automation[0].op"]);
    expect(paths([lane({ op: "scale" })])).toEqual([]);
  });

  test("enabled must be boolean when present", () => {
    expect(paths([lane({ enabled: "yes" as unknown as boolean })])).toEqual(["automation[0].enabled"]);
  });

  test("points must be a non-empty array", () => {
    expect(paths([lane({ points: [] })])).toEqual(["automation[0].points"]);
    expect(paths([lane({ points: undefined as unknown as AutomationLane["points"] })])).toEqual(["automation[0].points"]);
    expect(paths([lane({ points: "1,2" as unknown as AutomationLane["points"] })])).toEqual(["automation[0].points"]);
  });

  test("each point must be a [year, value] pair", () => {
    expect(paths([lane({ points: [[1] as unknown as [number, number]] })])).toEqual(["automation[0].points[0]"]);
    expect(paths([lane({ points: [{ year: 1, value: 2 } as unknown as [number, number]] })])).toEqual(["automation[0].points[0]"]);
    expect(paths([lane({ points: [["1", 2] as unknown as [number, number]] })])).toEqual(["automation[0].points[0]"]);
  });

  test("years must be finite and strictly ascending; values must be finite", () => {
    expect(paths([lane({ points: [[NaN, 1]] })])).toEqual(["automation[0].points[0][0]"]);
    expect(paths([lane({ points: [[Infinity, 1]] })])).toEqual(["automation[0].points[0][0]"]);
    expect(paths([lane({ points: [[2, 1], [1, 1]] })])).toEqual(["automation[0].points[1][0]"]);
    expect(paths([lane({ points: [[2, 1], [2, 1]] })])).toEqual(["automation[0].points[1][0]"]); // equal is not ascending
    expect(paths([lane({ points: [[1, NaN]] })])).toEqual(["automation[0].points[0][1]"]);
    expect(paths([lane({ points: [[1, -Infinity]] })])).toEqual(["automation[0].points[0][1]"]);
  });

  test("an unknown field on a lane warns and is ignored, as on an era", () => {
    const issues = (automation: unknown) => validateProfile(zone({ automation } as Partial<ZoneProfile>)).map((i) => `${i.level} ${i.path}: ${i.message}`);
    expect(issues([{ ...lane({}), amunt: 2 }])).toEqual(["warning automation[0].amunt: unknown field (ignored)"]);
    // the warning still lands on a lane whose points are broken enough to stop the rest of the checks
    expect(issues([{ ...lane({ points: [] }), amunt: 2 }])).toEqual([
      "warning automation[0].amunt: unknown field (ignored)",
      "error automation[0].points: at least one [year, value] point is required",
    ]);
  });

  test("validateAutomation appends to a caller's issue list and leaves undefined alone", () => {
    const issues: ValidationIssue[] = [];
    validateAutomation(undefined, issues);
    expect(issues).toEqual([]);
    validateAutomation([lane({ id: "" })], issues);
    expect(issues.map((i) => i.path)).toEqual(["automation[0].id"]);
  });
});
