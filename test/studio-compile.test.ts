import { describe, expect, test } from "bun:test";
import { evalCurve } from "../src/core/curve";
import { canonicalJson, resolveProfile, validateProfile } from "../src/core/profile";
import type { Curve, Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
import {
  channelOf,
  cycleLayers,
  devices,
  effectiveBase,
  FORCINGS,
  getAllYear,
  getCurveLayer,
  getCycle,
  getSeasonOffset,
  getSeasonSet,
  getSwing,
  getTrim,
  getWarmthLane,
  getWetness,
  isDeviceId,
  isForcingsId,
  isLayerId,
  LAYER,
  normaliseOrder,
  parseLayerId,
  reorderDevice,
  setAllYear,
  setCurveLayer,
  setCycle,
  setSeasonOffset,
  setSeasonSet,
  setSwing,
  setTrim,
  setWarmthLane,
  setWetness,
  strayLayers,
  totalWarmthAt,
  TRIM_ID,
  WARMTH_LANE_ID,
  WETNESS_ID,
  writersFor,
  type Writer,
} from "../src/studio/model/compile";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

const TEMP = "temperature.mean";

function zone(modifiers: Modifier[] = []): ZoneProfile {
  return {
    id: "greywold",
    name: "Greywold",
    schemaVersion: 1,
    preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers,
  };
}

/** A device the studio did not compile. */
function device(id: string, param = TEMP): Modifier {
  return { id, when: { tag: "storm" }, apply: [{ param, op: "offset", value: -1 }] };
}

function errors(z: ZoneProfile): string[] {
  return validateProfile(z)
    .filter((i) => i.level === "error")
    .map((i) => `${i.path}: ${i.message}`);
}

const ids = (z: ZoneProfile): string[] => z.modifiers.map((m) => m.id);

/** Peak-to-peak / 2 of a curve over a year. */
function amplitude(c: Curve): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let d = 0; d < 365; d++) {
    const v = evalCurve(c, (d + 0.5) / 365);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (hi - lo) / 2;
}

function mean(c: Curve): number {
  let s = 0;
  for (let d = 0; d < 365; d++) s += evalCurve(c, (d + 0.5) / 365);
  return s / 365;
}

// ---------------------------------------------------------------------------

describe("channelOf", () => {
  test("maps the first path segment; humidity and cloud are both sky", () => {
    expect(channelOf("temperature.mean")).toBe("temperature");
    expect(channelOf("temperature.sd")).toBe("temperature");
    expect(channelOf("precipitation.pww")).toBe("precipitation");
    expect(channelOf("wind.direction")).toBe("wind");
    expect(channelOf("humidity.dry")).toBe("sky");
    expect(channelOf("cloud.wet")).toBe("sky");
  });

  test("throws on a path with no channel", () => {
    expect(() => channelOf("foo.bar")).toThrow(RangeError);
  });
});

describe("id predicates", () => {
  test("layer / forcings / device / era", () => {
    expect(isLayerId(`${LAYER}${TEMP}`)).toBe(true);
    expect(isForcingsId(`${FORCINGS}${TEMP}`)).toBe(true);
    expect(isDeviceId("stormtide")).toBe(true);
    expect(isDeviceId(`${LAYER}${TEMP}`)).toBe(false);
    expect(isDeviceId(`${FORCINGS}${TEMP}`)).toBe(false);
    expect(isDeviceId("era:Long Winter")).toBe(false);
  });

  test("parseLayerId round-trips every suffix, including scopes with a colon and a season called set", () => {
    expect(parseLayerId(`${LAYER}${TEMP}`)).toEqual({ param: TEMP, kind: "offset" });
    expect(parseLayerId(`${LAYER}${TEMP}:scale`)).toEqual({ param: TEMP, kind: "scale" });
    expect(parseLayerId(`${LAYER}${TEMP}:curve`)).toEqual({ param: TEMP, kind: "curve" });
    expect(parseLayerId(`${LAYER}${TEMP}:swing`)).toEqual({ param: TEMP, kind: "swing" });
    expect(parseLayerId(`${LAYER}${TEMP}:season:Harvest`)).toEqual({ param: TEMP, kind: "season", scope: "Harvest" });
    expect(parseLayerId(`${LAYER}wind.direction:season:Harvest:set`)).toEqual({ param: "wind.direction", kind: "seasonSet", scope: "Harvest" });
    expect(parseLayerId(`${LAYER}${TEMP}:season:set`)).toEqual({ param: TEMP, kind: "season", scope: "set" });
    expect(parseLayerId(`${LAYER}${TEMP}:season:set:set`)).toEqual({ param: TEMP, kind: "seasonSet", scope: "set" });
    expect(parseLayerId(`${LAYER}${TEMP}:moon:Sable`)).toEqual({ param: TEMP, kind: "moon", scope: "Sable" });
    expect(parseLayerId(`${LAYER}${TEMP}:moon:Old:Sable`)).toEqual({ param: TEMP, kind: "moon", scope: "Old:Sable" });
    expect(parseLayerId(`${LAYER}foo`)).toBeNull();
    expect(parseLayerId(`${LAYER}${TEMP}:bogus`)).toBeNull();
    expect(parseLayerId("stormtide")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("all-year layers", () => {
  test("neutral on an untouched profile", () => {
    const z = zone();
    expect(getAllYear(z, TEMP, "offset")).toBe(0);
    expect(getAllYear(z, TEMP, "scale")).toBe(1);
    expect(z.modifiers).toHaveLength(0);
  });

  test("round-trips offset and scale independently", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", 2.5);
    setAllYear(z, TEMP, "scale", 0.8);
    expect(getAllYear(z, TEMP, "offset")).toBe(2.5);
    expect(getAllYear(z, TEMP, "scale")).toBe(0.8);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, `${LAYER}${TEMP}:scale`]);
    expect(errors(z)).toEqual([]);
  });

  test("writes a climate-stage modifier in the documented shape", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", -3);
    expect(z.modifiers[0]).toEqual({ id: `${LAYER}${TEMP}`, stage: "climate", apply: [{ param: TEMP, op: "offset", value: -3 }] });
  });

  test("neutral removes the modifier", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", 2.5);
    setAllYear(z, TEMP, "scale", 0.8);
    setAllYear(z, TEMP, "offset", 0);
    setAllYear(z, TEMP, "scale", 1);
    expect(z.modifiers).toHaveLength(0);
    expect(getAllYear(z, TEMP, "offset")).toBe(0);
  });

  test("is idempotent", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", 2.5);
    const once = canonicalJson(z);
    setAllYear(z, TEMP, "offset", 2.5);
    expect(canonicalJson(z)).toBe(once);
  });

  test("rejects a non-curve parameter path", () => {
    expect(() => setAllYear(zone(), "temperature.phase", "offset", 0.5)).toThrow(RangeError);
  });
});

describe("curve replacement", () => {
  const drawn: Curve = [
    { at: 0.1, value: 1 },
    { at: 0.6, value: 9 },
  ];

  test("round-trips and is stored as a climate-stage set", () => {
    const z = zone();
    expect(getCurveLayer(z, TEMP)).toBeNull();
    setCurveLayer(z, TEMP, drawn);
    expect(getCurveLayer(z, TEMP)).toEqual(drawn);
    expect(z.modifiers[0]).toEqual({ id: `${LAYER}${TEMP}:curve`, stage: "climate", apply: [{ param: TEMP, op: "set", value: drawn }] });
    expect(errors(z)).toEqual([]);
  });

  test("stores a copy, so the caller's array cannot alias the draft", () => {
    const z = zone();
    const mine = structuredClone(drawn) as Array<{ at: number; value: number }>;
    setCurveLayer(z, TEMP, mine);
    mine[0]!.value = 99;
    expect((getCurveLayer(z, TEMP) as Array<{ at: number; value: number }>)[0]!.value).toBe(1);
  });

  test("a constant Curve is a clean decompile, not a stray", () => {
    const z = zone();
    setCurveLayer(z, TEMP, 7);
    expect(getCurveLayer(z, TEMP)).toBe(7);
    expect(strayLayers(z)).toEqual([]);
  });

  test("null removes it", () => {
    const z = zone();
    setCurveLayer(z, TEMP, drawn);
    setCurveLayer(z, TEMP, null);
    expect(z.modifiers).toHaveLength(0);
  });
});

describe("swing", () => {
  test("is 1 on an untouched profile", () => {
    expect(getSwing(zone(), TEMP)).toBe(1);
  });

  test.each([0.5, 1.3, 0.0, 2.75])("round-trips k = %p through the tag", (k) => {
    const z = zone();
    setSwing(z, TEMP, k);
    expect(getSwing(z, TEMP)).toBe(k);
    expect(errors(z)).toEqual([]);
  });

  test("carries k in a climate-stage tag and writes 12 keyframes for a keyframe base", () => {
    const z = zone();
    setSwing(z, TEMP, 0.5);
    const m = z.modifiers[0]!;
    expect(m.id).toBe(`${LAYER}${TEMP}:swing`);
    expect(m.stage).toBe("climate");
    expect(m.tag).toBe("swing:0.5");
    expect(m.apply).toHaveLength(1);
    expect(m.apply[0]!.op).toBe("set");
    const value = (m.apply[0] as { value: Curve }).value as Array<{ at: number; value: number }>;
    expect(value).toHaveLength(12);
    // the keyframe phases of the base preset curve are preserved exactly
    expect(value.map((p) => p.at)).toEqual((fjord.climate.temperature.mean as Array<{ at: number }>).map((p) => p.at));
  });

  test("k = 1 removes the modifier", () => {
    const z = zone();
    setSwing(z, TEMP, 0.5);
    setSwing(z, TEMP, 1);
    expect(z.modifiers).toHaveLength(0);
    expect(getSwing(z, TEMP)).toBe(1);
  });

  test("is idempotent", () => {
    const z = zone();
    setSwing(z, TEMP, 1.3);
    const once = canonicalJson(z);
    setSwing(z, TEMP, 1.3);
    expect(canonicalJson(z)).toBe(once);
  });

  test("k is recovered from the amplitude ratio when the tag is hand-stripped", () => {
    const z = zone();
    setSwing(z, TEMP, 0.5);
    delete z.modifiers[0]!.tag;
    expect(getSwing(z, TEMP)).toBeCloseTo(0.5, 6);
  });

  test("resolveProfile at k = 0.5 halves the amplitude around the same annual mean", () => {
    const base = zone().climate.temperature.mean;
    const z = zone();
    setSwing(z, TEMP, 0.5);
    const got = resolveProfile(z).climate.temperature.mean;
    expect(amplitude(got) / amplitude(base)).toBeCloseTo(0.5, 2);
    expect(Math.abs(mean(got) - mean(base))).toBeLessThan(Math.abs(mean(base)) * 0.02);
  });

  test("swing rescales the EFFECTIVE base: an all-year offset re-derives it and still shifts the mean", () => {
    const base = zone().climate.temperature.mean;
    const z = zone();
    setSwing(z, TEMP, 0.5);
    setAllYear(z, TEMP, "offset", 3);
    // the offset op must stay ahead of the swing set, or one of them is wiped
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, `${LAYER}${TEMP}:swing`]);
    expect(getSwing(z, TEMP)).toBe(0.5);
    const got = resolveProfile(z).climate.temperature.mean;
    expect(amplitude(got) / amplitude(base)).toBeCloseTo(0.5, 2);
    expect(mean(got) - mean(base)).toBeCloseTo(3, 2);
    expect(errors(z)).toEqual([]);
  });

  test("order of the two knobs does not matter", () => {
    const a = zone();
    setSwing(a, TEMP, 0.5);
    setAllYear(a, TEMP, "offset", 3);
    const b = zone();
    setAllYear(b, TEMP, "offset", 3);
    setSwing(b, TEMP, 0.5);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("effectiveBase", () => {
  test("is the base climate with the all-year offset applied, and excludes the swing", () => {
    const z = zone();
    const base = mean(z.climate.temperature.mean);
    setAllYear(z, TEMP, "offset", 4);
    setSwing(z, TEMP, 0.25);
    expect(mean(effectiveBase(z, TEMP))).toBeCloseTo(base + 4, 6);
    expect(amplitude(effectiveBase(z, TEMP))).toBeCloseTo(amplitude(z.climate.temperature.mean), 6);
  });

  test("a disabled layer is skipped, mirroring resolveProfile", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", 4);
    z.modifiers[0]!.enabled = false;
    expect(mean(effectiveBase(z, TEMP))).toBeCloseTo(mean(z.climate.temperature.mean), 6);
  });
});

describe("season scope", () => {
  test("offset round-trips and removes at 0", () => {
    const z = zone();
    expect(getSeasonOffset(z, TEMP, "Harvest")).toBe(0);
    setSeasonOffset(z, TEMP, "Harvest", -2.25);
    expect(getSeasonOffset(z, TEMP, "Harvest")).toBe(-2.25);
    expect(z.modifiers[0]).toEqual({ id: `${LAYER}${TEMP}:season:Harvest`, when: { tag: "season:Harvest" }, apply: [{ param: TEMP, op: "offset", value: -2.25 }] });
    expect(errors(z)).toEqual([]);
    setSeasonOffset(z, TEMP, "Harvest", 0);
    expect(z.modifiers).toHaveLength(0);
  });

  test("set round-trips per season and only null removes it", () => {
    const z = zone();
    expect(getSeasonSet(z, "wind.direction", "Harvest")).toBeNull();
    setSeasonSet(z, "wind.direction", "Harvest", 225);
    setSeasonSet(z, "wind.direction", "Thaw", 0);
    expect(getSeasonSet(z, "wind.direction", "Harvest")).toBe(225);
    expect(getSeasonSet(z, "wind.direction", "Thaw")).toBe(0);
    expect(errors(z)).toEqual([]);
    setSeasonSet(z, "wind.direction", "Thaw", null);
    expect(getSeasonSet(z, "wind.direction", "Thaw")).toBeNull();
    expect(z.modifiers).toHaveLength(1);
  });

  test("offset and set on the same param and season are separate layers", () => {
    const z = zone();
    setSeasonOffset(z, "wind.direction", "Harvest", 10);
    setSeasonSet(z, "wind.direction", "Harvest", 225);
    expect(ids(z)).toEqual([`${LAYER}wind.direction:season:Harvest`, `${LAYER}wind.direction:season:Harvest:set`]);
    expect(getSeasonOffset(z, "wind.direction", "Harvest")).toBe(10);
    expect(getSeasonSet(z, "wind.direction", "Harvest")).toBe(225);
    expect(strayLayers(z)).toEqual([]);
  });

  test("is idempotent", () => {
    const z = zone();
    setSeasonOffset(z, TEMP, "Harvest", -2.25);
    const once = canonicalJson(z);
    setSeasonOffset(z, TEMP, "Harvest", -2.25);
    expect(canonicalJson(z)).toBe(once);
  });
});

describe("moon cycle scope", () => {
  const layer = { moon: "Sable", depth: 1.5, envelope: [[0, 0.2] as [number, number], [0.5, 1] as [number, number]] };

  test("round-trips and writes the documented shape", () => {
    const z = zone();
    expect(getCycle(z, TEMP, "Sable")).toBeNull();
    setCycle(z, TEMP, layer);
    expect(getCycle(z, TEMP, "Sable")).toEqual(layer);
    expect(z.modifiers[0]).toEqual({
      id: `${LAYER}${TEMP}:moon:Sable`,
      when: { moon: { name: "Sable", phase: [0, 1] } },
      apply: [{ param: TEMP, op: "offset", value: 1.5, envelope: layer.envelope }],
    });
    expect(errors(z)).toEqual([]);
  });

  test("clamps envelope strengths to [0,1] on write and the clamped form round-trips", () => {
    const z = zone();
    setCycle(z, TEMP, { moon: "Sable", depth: -2, envelope: [[0, 1.4], [0.5, -0.2], [0.75, 0.6]] });
    const got = getCycle(z, TEMP, "Sable")!;
    expect(got.envelope).toEqual([[0, 1], [0.5, 0], [0.75, 0.6]]);
    expect(got.depth).toBe(-2);
    expect(errors(z)).toEqual([]);
    setCycle(z, TEMP, got);
    expect(getCycle(z, TEMP, "Sable")).toEqual(got);
  });

  test("an empty envelope writes no envelope field and still validates", () => {
    const z = zone();
    setCycle(z, TEMP, { moon: "Sable", depth: 1, envelope: [] });
    expect(z.modifiers[0]!.apply[0]).toEqual({ param: TEMP, op: "offset", value: 1 });
    expect(getCycle(z, TEMP, "Sable")).toEqual({ moon: "Sable", depth: 1, envelope: [] });
    expect(errors(z)).toEqual([]);
  });

  test("null clears every moon layer on the parameter; other params are untouched", () => {
    const z = zone();
    setCycle(z, TEMP, layer);
    setCycle(z, TEMP, { moon: "Rime", depth: -1, envelope: [] });
    setCycle(z, "wind.speed", { moon: "Sable", depth: 4, envelope: [] });
    expect(cycleLayers(z, TEMP).map((c) => c.moon)).toEqual(["Sable", "Rime"]);
    setCycle(z, TEMP, null);
    expect(cycleLayers(z, TEMP)).toEqual([]);
    expect(getCycle(z, "wind.speed", "Sable")).toEqual({ moon: "Sable", depth: 4, envelope: [] });
  });

  test("is idempotent", () => {
    const z = zone();
    setCycle(z, TEMP, layer);
    const once = canonicalJson(z);
    setCycle(z, TEMP, layer);
    expect(canonicalJson(z)).toBe(once);
  });
});

// ---------------------------------------------------------------------------

describe("forcings", () => {
  test("trim round-trips, removes at 0, and stays last in modifiers[]", () => {
    const z = zone([device("stormtide")]);
    expect(getTrim(z)).toBe(0);
    setTrim(z, -1.75);
    expect(getTrim(z)).toBe(-1.75);
    expect(ids(z)).toEqual(["stormtide", TRIM_ID]);
    expect(z.modifiers[1]).toEqual({ id: TRIM_ID, stage: "climate", apply: [{ param: TEMP, op: "offset", value: -1.75 }] });
    expect(errors(z)).toEqual([]);
    setTrim(z, 0);
    expect(ids(z)).toEqual(["stormtide"]);
  });

  test("wetness scales pww and pwd from one modifier and removes at 1", () => {
    const z = zone();
    expect(getWetness(z)).toBe(1);
    setWetness(z, 1.4);
    expect(getWetness(z)).toBe(1.4);
    expect(z.modifiers[0]).toEqual({
      id: WETNESS_ID,
      stage: "climate",
      apply: [
        { param: "precipitation.pww", op: "scale", value: 1.4 },
        { param: "precipitation.pwd", op: "scale", value: 1.4 },
      ],
    });
    expect(errors(z)).toEqual([]);
    setWetness(z, 1);
    expect(z.modifiers).toHaveLength(0);
  });

  test("trim stays after wetness whichever order they are written in", () => {
    const a = zone();
    setTrim(a, 2);
    setWetness(a, 1.4);
    expect(ids(a)).toEqual([WETNESS_ID, TRIM_ID]);
    const b = zone();
    setWetness(b, 1.4);
    setTrim(b, 2);
    expect(ids(b)).toEqual([WETNESS_ID, TRIM_ID]);
  });

  test("both are idempotent", () => {
    const z = zone();
    setTrim(z, 2);
    setWetness(z, 1.4);
    const once = canonicalJson(z);
    setTrim(z, 2);
    setWetness(z, 1.4);
    expect(canonicalJson(z)).toBe(once);
  });
});

describe("warmth lane", () => {
  test("a zone with no automation reports a neutral, unstored lane", () => {
    const z = zone();
    expect(getWarmthLane(z)).toEqual({ id: WARMTH_LANE_ID, param: TEMP, op: "offset", points: [] });
    expect(z.automation).toBeUndefined();
  });

  test("round-trips points and validates", () => {
    const z = zone();
    const points: Array<[number, number]> = [
      [100, 0],
      [400, 2.5],
      [900, -1],
    ];
    setWarmthLane(z, points);
    expect(getWarmthLane(z).points).toEqual(points);
    expect(z.automation).toHaveLength(1);
    expect(errors(z)).toEqual([]);
  });

  test("a flat all-zero lane is kept; only an empty point list removes it", () => {
    const z = zone();
    setWarmthLane(z, [
      [1, 0],
      [500, 0],
    ]);
    expect(z.automation).toHaveLength(1);
    setWarmthLane(z, []);
    expect(z.automation).toBeUndefined();
  });

  test("is idempotent and copies the caller's points", () => {
    const z = zone();
    const points: Array<[number, number]> = [
      [1, 0],
      [500, 3],
    ];
    setWarmthLane(z, points);
    const once = canonicalJson(z);
    setWarmthLane(z, points);
    expect(canonicalJson(z)).toBe(once);
    points[1]![1] = 99;
    expect(getWarmthLane(z).points[1]![1]).toBe(3);
  });

  test("totalWarmthAt is trim + the lane, clamped outside the authored span", () => {
    const z = zone();
    expect(totalWarmthAt(z, 500)).toBe(0);
    setTrim(z, 1);
    expect(totalWarmthAt(z, 500)).toBe(1);
    setWarmthLane(z, [
      [100, 0],
      [200, 4],
    ]);
    expect(totalWarmthAt(z, 50)).toBeCloseTo(1, 10);
    expect(totalWarmthAt(z, 150)).toBeCloseTo(3, 10);
    expect(totalWarmthAt(z, 900)).toBeCloseTo(5, 10);
  });
});

// ---------------------------------------------------------------------------

describe("ordering", () => {
  test("mixed writes land as layer:* … devices … forcings:*", () => {
    const z = zone([device("stormtide"), device("ashfall", "cloud.dry")]);
    setTrim(z, 1);
    setSeasonOffset(z, TEMP, "Harvest", -2);
    setWetness(z, 1.2);
    setAllYear(z, TEMP, "offset", 3);
    setSwing(z, TEMP, 0.5);
    setCurveLayer(z, "wind.speed", 12);
    setCycle(z, TEMP, { moon: "Sable", depth: 1, envelope: [[0, 1]] });
    setAllYear(z, "precipitation.scale", "scale", 1.1);

    const order = ids(z);
    const firstDevice = order.indexOf("stormtide");
    const lastLayer = order.reduce((acc, id, i) => (isLayerId(id) ? i : acc), -1);
    const firstForcings = order.findIndex(isForcingsId);
    expect(lastLayer).toBeLessThan(firstDevice);
    expect(firstDevice).toBeLessThan(firstForcings);
    expect(order.filter(isDeviceId)).toEqual(["stormtide", "ashfall"]);
    expect(errors(z)).toEqual([]);

    // inside the layer block: curve → offset → scale → swing → daily scopes
    expect(order.slice(0, lastLayer + 1)).toEqual([
      `${LAYER}wind.speed:curve`,
      `${LAYER}${TEMP}`,
      `${LAYER}precipitation.scale:scale`,
      `${LAYER}${TEMP}:swing`,
      `${LAYER}${TEMP}:season:Harvest`,
      `${LAYER}${TEMP}:moon:Sable`,
    ]);
  });

  test("normaliseOrder repartitions a hand-authored array and is stable and idempotent", () => {
    const z = zone([
      { id: TRIM_ID, stage: "climate", apply: [{ param: TEMP, op: "offset", value: 1 }] },
      device("stormtide"),
      { id: `${LAYER}${TEMP}:swing`, stage: "climate", tag: "swing:0.5", apply: [{ param: TEMP, op: "set", value: 4 }] },
      device("ashfall", "cloud.dry"),
      { id: `${LAYER}${TEMP}`, stage: "climate", apply: [{ param: TEMP, op: "offset", value: 2 }] },
    ]);
    normaliseOrder(z);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, `${LAYER}${TEMP}:swing`, "stormtide", "ashfall", TRIM_ID]);
    const once = canonicalJson(z);
    normaliseOrder(z);
    expect(canonicalJson(z)).toBe(once);
  });

  test("normaliseOrder keeps the same array identity (the draft is edited in place)", () => {
    const z = zone([device("a"), device("b")]);
    const before = z.modifiers;
    normaliseOrder(z);
    expect(z.modifiers).toBe(before);
  });
});

describe("devices and reorderDevice", () => {
  function racked(): ZoneProfile {
    const z = zone([device("a"), device("b"), device("c")]);
    setAllYear(z, TEMP, "offset", 1);
    setTrim(z, 1);
    return z;
  }

  test("devices() lists only the uncompiled modifiers, in rack order", () => {
    expect(devices(racked()).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("moving a device keeps the prefixed modifiers at their positions", () => {
    const z = racked();
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, "a", "b", "c", TRIM_ID]);
    reorderDevice(z, "c", 0);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, "c", "a", "b", TRIM_ID]);
    reorderDevice(z, "c", 2);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, "a", "b", "c", TRIM_ID]);
    expect(errors(z)).toEqual([]);
  });

  test("clamps the index and ignores unknown ids and no-op moves", () => {
    const z = racked();
    const before = canonicalJson(z);
    reorderDevice(z, "a", 0);
    reorderDevice(z, "nope", 2);
    expect(canonicalJson(z)).toBe(before);
    reorderDevice(z, "a", 99);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, "b", "c", "a", TRIM_ID]);
    reorderDevice(z, "a", -5);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, "a", "b", "c", TRIM_ID]);
  });

  test("a layer:* modifier is never a device, even a stray one", () => {
    const z = zone([{ id: `${LAYER}foo`, when: { chance: 0.1 }, apply: [{ param: TEMP, op: "offset", value: 1 }] }]);
    expect(devices(z)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("strayLayers", () => {
  const stray: Modifier = { id: `${LAYER}foo`, when: { chance: 0.1 }, apply: [{ param: TEMP, op: "offset", value: 1 }] };

  test("finds a hand-written layer:foo with a when.chance and leaves it untouched", () => {
    const z = zone([structuredClone(stray), device("stormtide")]);
    expect(strayLayers(z)).toEqual([`${LAYER}foo`]);
    setAllYear(z, TEMP, "offset", 2);
    setSwing(z, TEMP, 0.5);
    setTrim(z, 1);
    normaliseOrder(z);
    expect(z.modifiers.find((m) => m.id === `${LAYER}foo`)).toEqual(stray);
    expect(strayLayers(z)).toEqual([`${LAYER}foo`]);
    expect(errors(z)).toEqual([]);
  });

  test("a stray sorts after the compiled layers so it never splits the climate ops", () => {
    const z = zone([structuredClone(stray)]);
    setAllYear(z, TEMP, "offset", 2);
    setSwing(z, TEMP, 0.5);
    expect(ids(z)).toEqual([`${LAYER}${TEMP}`, `${LAYER}${TEMP}:swing`, `${LAYER}foo`]);
  });

  test("flags every way a layer id can fail to decompile", () => {
    const z = zone([
      { id: `${LAYER}${TEMP}:bogus`, stage: "climate", apply: [{ param: TEMP, op: "offset", value: 1 }] },
      { id: `${LAYER}${TEMP}`, stage: "climate", apply: [{ param: TEMP, op: "offset", value: 1 }, { param: "temperature.sd", op: "offset", value: 1 }] },
      { id: `${LAYER}temperature.sd`, apply: [{ param: "temperature.sd", op: "offset", value: 1 }] },
      { id: `${LAYER}temperature.diurnalRange:season:Harvest`, when: { tag: "season:Thaw" }, apply: [{ param: "temperature.diurnalRange", op: "offset", value: 1 }] },
      { id: `${LAYER}wind.speed:moon:Sable`, when: { moon: { name: "Sable", phase: [0.2, 0.6] } }, apply: [{ param: "wind.speed", op: "offset", value: 1 }] },
      { id: `${LAYER}cloud.dry:scale`, stage: "climate", apply: [{ param: "cloud.wet", op: "scale", value: 2 }] },
    ]);
    expect(strayLayers(z).sort()).toEqual(
      [
        `${LAYER}${TEMP}:bogus`,
        `${LAYER}${TEMP}`,
        `${LAYER}temperature.sd`,
        `${LAYER}temperature.diurnalRange:season:Harvest`,
        `${LAYER}wind.speed:moon:Sable`,
        `${LAYER}cloud.dry:scale`,
      ].sort(),
    );
  });

  test("everything the compiler writes decompiles cleanly", () => {
    const z = zone();
    setAllYear(z, TEMP, "offset", 2);
    setAllYear(z, TEMP, "scale", 1.2);
    setCurveLayer(z, "temperature.sd", 1.5);
    setSwing(z, TEMP, 0.6);
    setSeasonOffset(z, TEMP, "Harvest", -1);
    setSeasonSet(z, "wind.direction", "Harvest", 225);
    setCycle(z, "cloud.wet", { moon: "Sable", depth: 0.1, envelope: [[0.25, 1]] });
    expect(strayLayers(z)).toEqual([]);
    expect(errors(z)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("writersFor", () => {
  const eras: Era[] = [
    { name: "Long Winter", from: 100, to: 200, apply: [{ param: TEMP, op: "offset", value: -8 }] },
    { name: "Wet Age", from: 300, apply: [{ param: "precipitation.pww", op: "scale", value: 1.3 }] },
    { name: "Quiet Age", from: 500 },
  ];

  function loaded(): ZoneProfile {
    const z = zone([device("stormtide", TEMP), device("ashfall", "precipitation.scale")]);
    setAllYear(z, TEMP, "offset", 2);
    setSeasonOffset(z, TEMP, "Harvest", -1);
    setTrim(z, 1.5);
    setWetness(z, 1.2);
    setWarmthLane(z, [
      [1, 0],
      [500, 3],
    ]);
    return z;
  }

  const kinds = (ws: Writer[]): Writer["kind"][] => ws.map((w) => w.kind);

  test("temperature lists every source in signal order", () => {
    const ws = writersFor(loaded(), eras, "temperature");
    expect(kinds(ws)).toEqual(["station", "layer", "layer", "regime", "device", "forcings", "automation", "era"]);
    expect(ws.map((w) => w.id)).toEqual([
      "fjord-coast",
      `${LAYER}${TEMP}`,
      `${LAYER}${TEMP}:season:Harvest`,
      "dry-spell",
      "stormtide",
      TRIM_ID,
      WARMTH_LANE_ID,
      "era:Long Winter",
    ]);
    expect(ws[1]!.label).toBe("all year offset");
    expect(ws[2]!.label).toBe("season · Harvest");
    expect(ws[5]!.label).toBe("trim");
    expect(ws[6]!.ops).toEqual([{ param: TEMP, op: "offset", value: 3 }]);
    expect(ws[0]!.ops).toEqual([]);
  });

  test("precipitation lists only precipitation-writing sources", () => {
    const ws = writersFor(loaded(), eras, "precipitation");
    expect(kinds(ws)).toEqual(["station", "regime", "regime", "device", "forcings", "era"]);
    expect(ws.map((w) => w.id)).toEqual(["fjord-coast", "wet-spell", "dry-spell", "ashfall", WETNESS_ID, "era:Wet Age"]);
    for (const w of ws) for (const o of w.ops) expect(o.param.startsWith("precipitation.")).toBe(true);
  });

  test("humidity and cloud writers land on the sky channel", () => {
    const z = zone([{ id: "haar", when: { tag: "season:Thaw" }, apply: [{ param: "humidity.dry", op: "offset", value: 5 }, { param: "cloud.dry", op: "offset", value: 0.1 }] }]);
    const ws = writersFor(z, [], "sky");
    expect(kinds(ws)).toEqual(["station", "device", "forcings"]);
    expect(ws[1]!.ops).toHaveLength(2);
  });

  test("the Forcings row is present on every channel, turned to nothing or not", () => {
    // The prototype's MST row (`tWriters`) never leaves the stack: Forcings is
    // wired to every channel, so a channel it does nothing on says so.
    const bare = zone();
    for (const c of ["temperature", "precipitation", "wind", "sky"] as const) {
      const ws = writersFor(bare, [], c);
      expect(ws.filter((w) => w.kind === "forcings"), c).toEqual([{ kind: "forcings", id: FORCINGS, label: "Forcings", ops: [] }]);
    }
    // …and it is the real row, not a second one, once something IS turned.
    const trimmed = zone();
    setTrim(trimmed, 1.5);
    const rows = writersFor(trimmed, [], "temperature").filter((w) => w.kind === "forcings");
    expect(rows.map((w) => w.id)).toEqual([TRIM_ID]);
    // A lane rides in the forcings slot beside the row, never instead of it:
    // `channel-edit.ts writers()` folds the two into the prototype's one MST.
    const laned = zone();
    setWarmthLane(laned, [
      [1, 0],
      [500, 3],
    ]);
    expect(kinds(writersFor(laned, [], "temperature"))).toEqual(["station", "regime", "forcings", "automation"]);
  });

  test("a disabled device is still listed (the UI greys it)", () => {
    const z = zone([{ ...device("stormtide"), enabled: false }]);
    // "dry-spell" is the preset's own temperature-writing regime
    expect(writersFor(z, [], "temperature").map((w) => w.id)).toEqual(["fjord-coast", "dry-spell", "stormtide", FORCINGS]);
  });

  test("a zone without a preset still reports a station row", () => {
    const z = zone();
    delete z.preset;
    const ws = writersFor(z, [], "wind");
    expect(ws).toEqual([
      { kind: "station", id: "climate", label: "base climate", ops: [] },
      { kind: "forcings", id: FORCINGS, label: "Forcings", ops: [] },
    ]);
  });

  test("an op on a path with no channel never crashes the stack", () => {
    const z = zone([{ id: "odd", apply: [{ param: "nonsense.path", op: "offset", value: 1 }] }]);
    const ws = writersFor(z, [], "temperature");
    expect(ws.map((w) => w.id)).toEqual(["fjord-coast", "dry-spell", FORCINGS]);
    for (const c of ["temperature", "precipitation", "wind", "sky"] as const) {
      expect(writersFor(z, [], c).some((w) => w.id === "odd")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("validity", () => {
  test("every setter leaves validateProfile error-free, and the profile resolves", () => {
    const z = zone([device("stormtide")]);
    const steps: Array<[string, () => void]> = [
      ["allYear offset", () => setAllYear(z, TEMP, "offset", 2)],
      ["allYear scale", () => setAllYear(z, "temperature.diurnalRange", "scale", 1.4)],
      ["curve", () => setCurveLayer(z, "temperature.sd", [{ at: 0.2, value: 1 }, { at: 0.7, value: 3 }])],
      ["swing", () => setSwing(z, TEMP, 0.5)],
      ["season offset", () => setSeasonOffset(z, TEMP, "Harvest", -2)],
      ["season set", () => setSeasonSet(z, "wind.direction", "Harvest", 225)],
      ["cycle", () => setCycle(z, "cloud.wet", { moon: "Sable", depth: 0.2, envelope: [[0, 0], [0.5, 1]] })],
      ["trim", () => setTrim(z, -1)],
      ["wetness", () => setWetness(z, 1.3)],
      ["warmth lane", () => setWarmthLane(z, [[1, 0], [500, 2]])],
      ["normalise", () => normaliseOrder(z)],
      ["reorder", () => reorderDevice(z, "stormtide", 0)],
      ["clear cycle", () => setCycle(z, "cloud.wet", null)],
      ["neutral trim", () => setTrim(z, 0)],
      ["neutral swing", () => setSwing(z, TEMP, 1)],
    ];
    for (const [name, run] of steps) {
      run();
      expect([name, errors(z)]).toEqual([name, []]);
    }
    expect(() => resolveProfile(z)).not.toThrow();
  });

  test("running the whole sequence twice changes nothing", () => {
    const build = (): ZoneProfile => {
      const z = zone([device("stormtide")]);
      setAllYear(z, TEMP, "offset", 2);
      setSwing(z, TEMP, 0.5);
      setSeasonOffset(z, TEMP, "Harvest", -2);
      setCycle(z, TEMP, { moon: "Sable", depth: 1, envelope: [[0.5, 1]] });
      setTrim(z, -1);
      setWetness(z, 1.3);
      setWarmthLane(z, [[1, 0], [500, 2]]);
      return z;
    };
    const a = build();
    const b = build();
    setAllYear(b, TEMP, "offset", 2);
    setSwing(b, TEMP, 0.5);
    setSeasonOffset(b, TEMP, "Harvest", -2);
    setCycle(b, TEMP, { moon: "Sable", depth: 1, envelope: [[0.5, 1]] });
    setTrim(b, -1);
    setWetness(b, 1.3);
    setWarmthLane(b, [[1, 0], [500, 2]]);
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });

  test("the base climate is never touched", () => {
    const before = canonicalJson(fjord.climate);
    const z = zone();
    setAllYear(z, TEMP, "offset", 2);
    setSwing(z, TEMP, 0.5);
    setCurveLayer(z, TEMP, 4);
    setTrim(z, 9);
    expect(canonicalJson(z.climate)).toBe(before);
  });
});
