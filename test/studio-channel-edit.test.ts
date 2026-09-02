/**
 * The channel editor's pure half (`src/studio/model/channel-edit.ts`).
 *
 * Everything here is held against `compile.ts` and `core/profile.ts` rather
 * than against itself: a knob is only correct if the layer it writes resolves
 * to the number the knob promised, so most of these tests write through
 * `channel-edit` and read back through `effectiveBase` / `resolveProfile`.
 */
import { describe, expect, test } from "bun:test";
import { evalCurve, monthCentrePhase } from "../src/core/curve";
import { validateProfile } from "../src/core/profile";
import type { Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
import {
  addEnvelopePoint,
  addKeyframe,
  ALL_SCOPE,
  chartSeries,
  clearDirection,
  companionSeries,
  curvePoints,
  directionLayer,
  directionRose,
  layerGlob,
  primarySeries,
  ROSE_SECTORS,
  writesText,
  jitterParam,
  knobsFor,
  MIN_KEYFRAMES,
  moonScope,
  opText,
  parseScope,
  read,
  removeEnvelopePoint,
  removeKeyframe,
  scopeChips,
  seasonMarkers,
  seasonScope,
  setEnvelopePoint,
  setKeyframe,
  stageCaption,
  stationPoints,
  swungPoints,
  write,
  writers,
  type KnobId,
} from "../src/studio/model/channel-edit";
import { effectiveBase, getAllYear, getCycle, getSeasonOffset, getSwing, setSwing, type Channel } from "../src/studio/model/compile";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

const TEMP = "temperature.mean";
const TEMP_CHANNEL: Channel = "temperature";

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

const CALENDAR = {
  seasons: [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Autumn", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ],
  moons: [{ name: "Sable" }],
};

function errors(z: ZoneProfile): string[] {
  return validateProfile(z)
    .filter((i) => i.level === "error")
    .map((i) => `${i.path}: ${i.message}`);
}

// ---------------------------------------------------------------------------

describe("scopes", () => {
  test("parseScope decodes the three kinds and degrades to all year", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    expect(parseScope(seasonScope("Winter"))).toEqual({ kind: "season", name: "Winter" });
    expect(parseScope(moonScope("Sable"))).toEqual({ kind: "cycle", moon: "Sable" });
    expect(parseScope("season:")).toEqual({ kind: "all" });
    expect(parseScope("moon:")).toEqual({ kind: "all" });
    expect(parseScope("nonsense")).toEqual({ kind: "all" });
  });

  test("scopeChips is All year, the calendar's seasons, then its moons with the ☾ prefix", () => {
    expect(scopeChips(zone(), CALENDAR)).toEqual([
      { id: "all", label: "All year" },
      { id: "season:Spring", label: "Spring" },
      { id: "season:Summer", label: "Summer" },
      { id: "season:Autumn", label: "Autumn" },
      { id: "season:Winter", label: "Winter" },
      { id: "moon:Sable", label: "☾ Sable" },
    ]);
  });

  test("a scope the zone has a layer for but the calendar forgot still gets a chip", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, seasonScope("Monsoon"), "offset", -2);
    const ids = scopeChips(z, CALENDAR).map((c) => c.id);
    expect(ids).toContain("season:Monsoon");
    // and appended after the calendar's own, never in front of them
    expect(ids.indexOf("season:Monsoon")).toBeGreaterThan(ids.indexOf("moon:Sable"));
  });

  test("stageCaption names the stage and the predicate", () => {
    expect(stageCaption(ALL_SCOPE)).toBe("climate stage · applied once to the curves");
    expect(stageCaption(seasonScope("Winter"))).toBe("daily stage · when.tag season:Winter");
    expect(stageCaption(moonScope("Sable"))).toBe("daily stage · when.moon Sable · envelope");
  });

  test("knobsFor follows the scope (SPEC §3.4)", () => {
    expect(knobsFor(TEMP_CHANNEL, ALL_SCOPE)).toEqual(["offset", "swing", "jitter"]);
    expect(knobsFor(TEMP_CHANNEL, seasonScope("Winter"))).toEqual(["offset"]);
    expect(knobsFor(TEMP_CHANNEL, moonScope("Sable"))).toEqual(["depth"]);
  });

  test("jitterParam is the channel's sd curve, or null when it has none", () => {
    expect(jitterParam(TEMP)).toBe("temperature.sd");
    expect(jitterParam("wind.speed")).toBeNull();
    expect(jitterParam("precipitation.pww")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("knobs", () => {
  test("the all-year offset round-trips through layer:<param> and moves the effective base", () => {
    const z = zone();
    const before = evalCurve(effectiveBase(z, TEMP), 0.3);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 3);
    expect(getAllYear(z, TEMP, "offset")).toBe(3);
    expect(read(z, TEMP_CHANNEL, ALL_SCOPE).offset).toBe(3);
    expect(evalCurve(effectiveBase(z, TEMP), 0.3)).toBeCloseTo(before + 3, 9);
    expect(errors(z)).toEqual([]);
  });

  test("swing writes a climate-stage set with 12 keyframes and shrinks the amplitude", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, ALL_SCOPE, "swing", 0.5);
    const m = z.modifiers.find((x) => x.id === "layer:temperature.mean:swing");
    expect(m?.stage).toBe("climate");
    const op = m?.apply[0];
    expect(op?.op).toBe("set");
    expect(Array.isArray(op?.op === "set" ? op.value : null)).toBe(true);
    expect(read(z, TEMP_CHANNEL, ALL_SCOPE).swing).toBeCloseTo(0.5, 9);
    // the swung line is the base's deviation halved
    const base = curvePoints(z, TEMP, ALL_SCOPE);
    const swung = swungPoints(z, TEMP, ALL_SCOPE);
    const spread = (pts: Array<[number, number]>) => Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    expect(spread(swung)).toBeCloseTo(spread(base) * 0.5, 6);
    expect(errors(z)).toEqual([]);
  });

  test("jitter writes the sd offset, not the mean's", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, ALL_SCOPE, "jitter", 1.5);
    expect(getAllYear(z, "temperature.sd", "offset")).toBe(1.5);
    expect(getAllYear(z, TEMP, "offset")).toBe(0);
    expect(read(z, TEMP_CHANNEL, ALL_SCOPE).jitter).toBe(1.5);
  });

  test("a season scope writes a daily-stage when.tag layer and nothing else", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, seasonScope("Winter"), "offset", -2);
    const m = z.modifiers.find((x) => x.id === "layer:temperature.mean:season:Winter");
    expect(m?.when).toEqual({ tag: "season:Winter" });
    expect(m?.stage).toBeUndefined();
    expect(getSeasonOffset(z, TEMP, "Winter")).toBe(-2);
    expect(read(z, TEMP_CHANNEL, seasonScope("Winter")).offset).toBe(-2);
    // the all-year knob is untouched
    expect(getAllYear(z, TEMP, "offset")).toBe(0);
    expect(errors(z)).toEqual([]);
  });

  test("the cycle depth writes a when.moon layer with a neutral envelope, and reads back under both names", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, moonScope("Sable"), "depth", -4);
    const layer = getCycle(z, TEMP, "Sable");
    expect(layer?.depth).toBe(-4);
    expect(layer?.envelope.length).toBeGreaterThan(0);
    const values = read(z, TEMP_CHANNEL, moonScope("Sable"));
    expect(values.depth).toBe(-4);
    expect(values.offset).toBe(-4);
    expect(errors(z)).toEqual([]);
  });

  test("a knob the scope does not offer throws rather than writing the wrong layer", () => {
    const z = zone();
    expect(() => write(z, TEMP_CHANNEL, seasonScope("Winter"), "swing", 1.2)).toThrow(RangeError);
    expect(() => write(z, TEMP_CHANNEL, ALL_SCOPE, "depth", 3)).toThrow(RangeError);
    expect(z.modifiers).toEqual([]);
  });

  test("turning a knob back to neutral removes the layer", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 3);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "swing", 1.4);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 0);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "swing", 1);
    expect(z.modifiers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the drawn curve", () => {
  test("curvePoints is 12 monthly samples of the effective base", () => {
    const z = zone();
    const points = curvePoints(z, TEMP, ALL_SCOPE);
    expect(points.length).toBe(12);
    points.forEach((p, m) => {
      expect(p[0]).toBeCloseTo(monthCentrePhase(m), 12);
      expect(p[1]).toBeCloseTo(evalCurve(effectiveBase(z, TEMP), monthCentrePhase(m)), 9);
    });
  });

  test("setKeyframe writes layer:<param>:curve and the drawn value is what effectiveBase reports", () => {
    const z = zone();
    const target = 20;
    expect(setKeyframe(z, TEMP, 3, target)).toBe(true);
    const m = z.modifiers.find((x) => x.id === "layer:temperature.mean:curve");
    expect(m?.stage).toBe("climate");
    expect(m?.apply[0]?.op).toBe("set");
    expect(curvePoints(z, TEMP, ALL_SCOPE)[3]?.[1]).toBeCloseTo(target, 6);
    expect(errors(z)).toEqual([]);
  });

  test("an all-year offset is never counted twice: the drawn point stays where it was put", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 4);
    setKeyframe(z, TEMP, 5, 12);
    expect(curvePoints(z, TEMP, ALL_SCOPE)[5]?.[1]).toBeCloseTo(12, 6);
    // and the offset is still its own layer, still 4
    expect(getAllYear(z, TEMP, "offset")).toBe(4);
    // a second edit after the offset moved keeps both honest
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", -1);
    setKeyframe(z, TEMP, 5, 3);
    expect(curvePoints(z, TEMP, ALL_SCOPE)[5]?.[1]).toBeCloseTo(3, 6);
    expect(getAllYear(z, TEMP, "offset")).toBe(-1);
  });

  test("an existing swing is re-derived from the new base after a keyframe moves", () => {
    const z = zone();
    setSwing(z, TEMP, 0.6);
    setKeyframe(z, TEMP, 0, 30);
    expect(getSwing(z, TEMP)).toBeCloseTo(0.6, 6);
    // the swing layer is the last climate-stage writer for the parameter
    const ids = z.modifiers.map((m) => m.id);
    expect(ids.indexOf("layer:temperature.mean:swing")).toBeGreaterThan(ids.indexOf("layer:temperature.mean:curve"));
  });

  test("add and remove change the keyframe count, and removal stops at MIN_KEYFRAMES", () => {
    const z = zone();
    expect(addKeyframe(z, TEMP, 0.5, 9)).toBe(true);
    expect(curvePoints(z, TEMP, ALL_SCOPE).length).toBe(13);
    // the added point is where it was put
    const added = curvePoints(z, TEMP, ALL_SCOPE).find((p) => Math.abs(p[0] - 0.5) < 1e-9);
    expect(added?.[1]).toBeCloseTo(9, 6);
    expect(addKeyframe(z, TEMP, 0.5, 4)).toBe(false);

    for (let i = curvePoints(z, TEMP, ALL_SCOPE).length; i > MIN_KEYFRAMES; i--) expect(removeKeyframe(z, TEMP, 0)).toBe(true);
    expect(curvePoints(z, TEMP, ALL_SCOPE).length).toBe(MIN_KEYFRAMES);
    expect(removeKeyframe(z, TEMP, 0)).toBe(false);
    expect(errors(z)).toEqual([]);
  });

  test("stationPoints is the untouched preset curve, whatever the layers say", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 6);
    const station = stationPoints(z, TEMP, ALL_SCOPE);
    expect(station.length).toBe(12);
    station.forEach((p, m) => expect(p[1]).toBeCloseTo(evalCurve(fjord.climate.temperature.mean, monthCentrePhase(m)), 9));
  });

  test("seasonMarkers labels the year domain and is empty on the cycle", () => {
    expect(seasonMarkers(ALL_SCOPE, CALENDAR)).toEqual([
      { x: 0, label: "Spring" },
      { x: 0.25, label: "Summer" },
      { x: 0.5, label: "Autumn" },
      { x: 0.75, label: "Winter" },
    ]);
    expect(seasonMarkers(moonScope("Sable"), CALENDAR)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the cycle envelope", () => {
  test("the cycle scope draws the envelope, and a drag keeps every strength in [0,1]", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, moonScope("Sable"), "depth", -3);
    expect(setEnvelopePoint(z, TEMP, "Sable", 0, 0.2, 4)).toBe(true);
    expect(setEnvelopePoint(z, TEMP, "Sable", 1, 0.7, -2)).toBe(true);
    const points = curvePoints(z, TEMP, moonScope("Sable"));
    expect(points).toEqual([
      [0.2, 1],
      [0.7, 0],
    ]);
    for (const [, s] of getCycle(z, TEMP, "Sable")?.envelope ?? []) expect(s >= 0 && s <= 1).toBe(true);
    // the depth survives the drag
    expect(getCycle(z, TEMP, "Sable")?.depth).toBe(-3);
    expect(errors(z)).toEqual([]);
  });

  test("add and remove on the envelope, keeping at least one point", () => {
    const z = zone();
    write(z, TEMP_CHANNEL, moonScope("Sable"), "depth", 2);
    expect(addEnvelopePoint(z, TEMP, "Sable", 0.9, 0.25)).toBe(true);
    expect(curvePoints(z, TEMP, moonScope("Sable")).length).toBe(3);
    expect(removeEnvelopePoint(z, TEMP, "Sable", 0)).toBe(true);
    expect(removeEnvelopePoint(z, TEMP, "Sable", 0)).toBe(true);
    expect(removeEnvelopePoint(z, TEMP, "Sable", 0)).toBe(false);
    expect(errors(z)).toEqual([]);
  });

  test("a cycle scope with no layer yet still draws a neutral envelope", () => {
    const points = curvePoints(zone(), TEMP, moonScope("Sable"));
    expect(points.length).toBeGreaterThan(0);
    for (const [, s] of points) expect(s).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the writers stack", () => {
  const eras: Era[] = [{ name: "Ice Age", from: 1, to: 50, apply: [{ param: TEMP, op: "offset", value: -4 }] }];

  function stacked(): { z: ZoneProfile; rows: ReturnType<typeof writers> } {
    const z = zone([{ id: "Gale", when: { tag: "storm" }, apply: [{ param: TEMP, op: "offset", value: -1 }] }]);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 2);
    write(z, TEMP_CHANNEL, seasonScope("Winter"), "offset", -2);
    return { z, rows: writers(z, eras, "temperature") };
  }

  test("signal order, one row per source (SPEC §1)", () => {
    const { rows } = stacked();
    expect(rows.map((r) => r.kind)).toEqual(["station", "layer", "layer", "regime", "device", "era"]);
    expect(rows[0]?.label).toBe(fjord.id);
    expect(rows[1]?.label).toBe("all year offset");
    expect(rows[2]?.label).toBe("season · Winter");
  });

  test("every row is a click-through to the window that owns it", () => {
    const { rows } = stacked();
    const byKind = new Map(rows.map((r) => [r.kind, r.target]));
    expect(byKind.get("station")).toEqual({ win: "atlas", id: "atlas" });
    expect(byKind.get("regime")).toEqual({ win: "regimes", id: "regimes" });
    expect(byKind.get("device")).toEqual({ win: "device", id: "device:Gale" });
    expect(byKind.get("era")).toEqual({ win: "era", id: "era:Ice Age" });
    expect(rows[1]?.target).toEqual({ win: "channel", id: "channel:temperature", scope: "all" });
    expect(rows[2]?.target).toEqual({ win: "channel", id: "channel:temperature", scope: "season:Winter" });
  });

  test("forcings and automation both land on the Forcings panel", () => {
    const z = zone();
    z.modifiers.push({ id: "forcings:temperature.mean", stage: "climate", apply: [{ param: TEMP, op: "offset", value: 1 }] });
    z.automation = [{ id: "frc.warmth", param: TEMP, op: "offset", points: [[1, 2]] }];
    const rows = writers(z, [], "temperature");
    expect(rows.find((r) => r.kind === "forcings")?.target).toEqual({ win: "forcings", id: "forcings" });
    expect(rows.find((r) => r.kind === "automation")?.target).toEqual({ win: "forcings", id: "forcings" });
  });

  test("the station row says it is the baseline; the rest quote their ops", () => {
    const { rows } = stacked();
    expect(rows[0]?.opsText).toBe("the baseline the stack edits");
    expect(rows[1]?.opsText).toBe("temperature.mean offset 2");
    expect(rows[2]?.opsText).toBe("temperature.mean offset −2");
  });

  test("opText renders every op shape a channel can carry", () => {
    expect(opText({ param: TEMP, op: "offset", value: -1.5 })).toBe("temperature.mean offset −1.5");
    expect(opText({ param: TEMP, op: "scale", value: 1.25 })).toBe("temperature.mean scale 1.25");
    expect(opText({ param: TEMP, op: "set", value: 4 })).toBe("temperature.mean set 4");
    expect(opText({ param: TEMP, op: "set", value: [{ at: 0, value: 1 }] })).toBe("temperature.mean set curve · 1 kf");
    expect(opText({ param: TEMP, op: "set", value: { mean: 5, amplitude: 1, phase: 0 } })).toBe("temperature.mean set curve · harmonic");
    expect(opText({ param: TEMP, op: "clamp", min: -2 })).toBe("temperature.mean clamp min −2");
    expect(opText({ param: TEMP, op: "offset", value: 1, envelope: [[0, 1]] })).toBe("temperature.mean offset 1 · envelope 1");
    expect(opText({ param: TEMP, op: "offset", value: 1, enabled: false })).toBe("temperature.mean offset 1 · off");
  });
});

// ---------------------------------------------------------------------------
// Channel parity — PRECIP, WIND, SKY (SPEC §8, PLAN §5.2; bead wadjet-9f9.32)
// ---------------------------------------------------------------------------

const WINTER = seasonScope("Winter");
const SABLE = moonScope("Sable");

/** One knob turn: the channel, the scope, the value it is turned to, and the layer ids that must appear. */
interface Turn {
  channel: Channel;
  scope: string;
  knob: KnobId;
  value: number;
  ids: string[];
}

/**
 * Every knob of every channel, once, at a value away from its neutral. The
 * `ids` column is the whole point: it is the id grammar (PLAN §2.3) spelled
 * out per knob, so a binding aimed at the wrong parameter fails here rather
 * than in the audition.
 */
const TURNS: Turn[] = [
  { channel: "temperature", scope: ALL_SCOPE, knob: "offset", value: 3, ids: ["layer:temperature.mean"] },
  { channel: "temperature", scope: ALL_SCOPE, knob: "jitter", value: 1.5, ids: ["layer:temperature.sd"] },
  { channel: "temperature", scope: WINTER, knob: "offset", value: -2, ids: ["layer:temperature.mean:season:Winter"] },
  { channel: "temperature", scope: SABLE, knob: "depth", value: -4, ids: ["layer:temperature.mean:moon:Sable"] },

  { channel: "precipitation", scope: ALL_SCOPE, knob: "stick", value: 1.2, ids: ["layer:precipitation.pww:scale"] },
  { channel: "precipitation", scope: ALL_SCOPE, knob: "chance", value: 1.6, ids: ["layer:precipitation.pwd:scale"] },
  { channel: "precipitation", scope: ALL_SCOPE, knob: "amount", value: 0.8, ids: ["layer:precipitation.scale:scale"] },
  { channel: "precipitation", scope: WINTER, knob: "wetShift", value: 0.15, ids: ["layer:precipitation.pwd:season:Winter"] },
  { channel: "precipitation", scope: SABLE, knob: "depth", value: -0.2, ids: ["layer:precipitation.pwd:moon:Sable"] },

  { channel: "wind", scope: ALL_SCOPE, knob: "wind", value: 8, ids: ["layer:wind.speed"] },
  { channel: "wind", scope: ALL_SCOPE, knob: "gust", value: 1.3, ids: ["layer:wind.speedSd:scale"] },
  { channel: "wind", scope: ALL_SCOPE, knob: "calm", value: 0.12, ids: ["layer:wind.calmFraction"] },
  { channel: "wind", scope: WINTER, knob: "wind", value: -3, ids: ["layer:wind.speed:season:Winter"] },
  { channel: "wind", scope: WINTER, knob: "direction", value: 270, ids: ["layer:wind.direction:season:Winter:set"] },
  { channel: "wind", scope: SABLE, knob: "depth", value: -6, ids: ["layer:wind.speed:moon:Sable"] },

  { channel: "sky", scope: ALL_SCOPE, knob: "cloud", value: 0.2, ids: ["layer:cloud.dry", "layer:cloud.wet"] },
  { channel: "sky", scope: ALL_SCOPE, knob: "humidity", value: -0.15, ids: ["layer:humidity.dry", "layer:humidity.wet"] },
  { channel: "sky", scope: WINTER, knob: "cloud", value: 0.25, ids: ["layer:cloud.dry:season:Winter", "layer:cloud.wet:season:Winter"] },
  { channel: "sky", scope: WINTER, knob: "humidity", value: 0.1, ids: ["layer:humidity.dry:season:Winter", "layer:humidity.wet:season:Winter"] },
  { channel: "sky", scope: SABLE, knob: "depth", value: 0.3, ids: ["layer:cloud.dry:moon:Sable"] },
];

describe("channel parity", () => {
  test("knobsFor is per channel as well as per scope (SPEC §8)", () => {
    expect(knobsFor("temperature", ALL_SCOPE)).toEqual(["offset", "swing", "jitter"]);
    expect(knobsFor("temperature", WINTER)).toEqual(["offset"]);
    expect(knobsFor("temperature", SABLE)).toEqual(["depth"]);

    expect(knobsFor("precipitation", ALL_SCOPE)).toEqual(["stick", "chance", "amount"]);
    expect(knobsFor("precipitation", WINTER)).toEqual(["wetShift"]);
    expect(knobsFor("precipitation", SABLE)).toEqual(["depth"]);

    expect(knobsFor("wind", ALL_SCOPE)).toEqual(["wind", "gust", "calm"]);
    expect(knobsFor("wind", WINTER)).toEqual(["wind", "direction"]);
    expect(knobsFor("wind", SABLE)).toEqual(["depth"]);

    expect(knobsFor("sky", ALL_SCOPE)).toEqual(["cloud", "humidity"]);
    expect(knobsFor("sky", WINTER)).toEqual(["cloud", "humidity"]);
    expect(knobsFor("sky", SABLE)).toEqual(["depth"]);
  });

  test("swing and jitter exist on temperature only — the other three have no sd curve to jitter", () => {
    for (const channel of ["precipitation", "wind", "sky"] as Channel[]) {
      const ids = [ALL_SCOPE, WINTER, SABLE].flatMap((s) => knobsFor(channel, s));
      expect(ids, channel).not.toContain("swing");
      expect(ids, channel).not.toContain("jitter");
    }
    expect(jitterParam("precipitation.pwd")).toBeNull();
    expect(jitterParam("wind.speed")).toBeNull();
    // `cloud.sd` and `humidity.sd` are scalars, not curves, so they are not jitterable either.
    expect(jitterParam("cloud.dry")).toBeNull();
    expect(jitterParam("humidity.wet")).toBeNull();
  });

  for (const turn of TURNS) {
    const where = `${turn.channel} · ${turn.scope} · ${turn.knob}`;
    test(`${where} round-trips through ${turn.ids.join(" + ")}`, () => {
      const z = zone();
      write(z, turn.channel, turn.scope, turn.knob, turn.value);
      expect(read(z, turn.channel, turn.scope)[turn.knob], where).toBeCloseTo(turn.value, 9);
      expect([...z.modifiers.map((m) => m.id)].sort(), where).toEqual([...turn.ids].sort());
      expect(errors(z), where).toEqual([]);
    });
  }

  test("every knob turned at once still resolves without an error-level issue", () => {
    const z = zone();
    for (const turn of TURNS) write(z, turn.channel, turn.scope, turn.knob, turn.value);
    write(z, "temperature", ALL_SCOPE, "swing", 0.8);
    expect(errors(z)).toEqual([]);
    // …and each one still reads back what it was turned to, on top of all the others.
    for (const turn of TURNS) expect(read(z, turn.channel, turn.scope)[turn.knob], `${turn.channel} · ${turn.knob}`).toBeCloseTo(turn.value, 9);
    expect(read(z, "temperature", ALL_SCOPE).swing).toBeCloseTo(0.8, 9);
  });

  test("a knob turned back to neutral removes its layers, both halves of a pair included", () => {
    const z = zone();
    write(z, "sky", ALL_SCOPE, "cloud", 0.2);
    expect(z.modifiers.length).toBe(2);
    write(z, "sky", ALL_SCOPE, "cloud", 0);
    expect(z.modifiers).toEqual([]);
  });

  test("a knob the channel's scope does not offer throws rather than writing another channel's layer", () => {
    const z = zone();
    expect(() => write(z, "wind", ALL_SCOPE, "direction", 90)).toThrow(RangeError);
    expect(() => write(z, "precipitation", ALL_SCOPE, "wetShift", 0.1)).toThrow(RangeError);
    expect(() => write(z, "sky", ALL_SCOPE, "offset", 1)).toThrow(RangeError);
    expect(() => write(z, "precipitation", WINTER, "chance", 1.4)).toThrow(RangeError);
    expect(z.modifiers).toEqual([]);
  });

  test("a scope-less knob falls back to the all-year reading, so a caller may read past knobsFor", () => {
    const z = zone();
    write(z, "precipitation", ALL_SCOPE, "chance", 1.6);
    // `chance` is not a season knob, but its all-year value is still what it is.
    expect(read(z, "precipitation", WINTER).chance).toBeCloseTo(1.6, 9);
    // A knob the channel has no binding for at all reads 0.
    expect(read(z, "precipitation", ALL_SCOPE).gust).toBe(0);
  });
});

describe("wind direction", () => {
  test("a season bearing is set and reset through the layer, never through a neutral", () => {
    const z = zone();
    expect(directionLayer(z, "Winter")).toBeNull();

    write(z, "wind", WINTER, "direction", 270);
    expect(directionLayer(z, "Winter")).toBe(270);
    expect(z.modifiers[0]?.when).toEqual({ tag: "season:Winter" });
    expect(z.modifiers[0]?.apply[0]).toEqual({ param: "wind.direction", op: "set", value: 270 });

    // 0° is a real bearing, so it writes rather than clearing.
    write(z, "wind", WINTER, "direction", 0);
    expect(directionLayer(z, "Winter")).toBe(0);
    expect(z.modifiers.length).toBe(1);

    clearDirection(z, "Winter");
    expect(directionLayer(z, "Winter")).toBeNull();
    expect(z.modifiers).toEqual([]);
    expect(errors(z)).toEqual([]);
  });

  test("the rose carries one petal per season and follows a bearing that is set", () => {
    const z = zone();
    const rose = directionRose(z, CALENDAR);
    expect(rose.length).toBe(ROSE_SECTORS);
    expect(rose.map((p) => p[0])).toEqual([...Array(ROSE_SECTORS).keys()]);
    expect(rose.reduce((a, p) => a + p[1], 0)).toBe(CALENDAR.seasons.length);

    write(z, "wind", WINTER, "direction", 270);
    const west = directionRose(z, CALENDAR);
    // 270° / 22.5° = sector 12.
    expect(west[12]![1]).toBeGreaterThanOrEqual(1);
    expect(west.reduce((a, p) => a + p[1], 0)).toBe(CALENDAR.seasons.length);

    write(z, "wind", WINTER, "direction", 90);
    const east = directionRose(z, CALENDAR);
    expect(east[4]![1]).toBeGreaterThanOrEqual(1);
    expect(east).not.toEqual(west);
  });

  test("a calendar with no seasons still draws a rose, off the station's own curve", () => {
    const rose = directionRose(zone(), { seasons: [] });
    expect(rose.length).toBe(ROSE_SECTORS);
    expect(rose.reduce((a, p) => a + p[1], 0)).toBe(12);
  });
});

describe("the drawn series", () => {
  test("a paired channel offers both lines and names the one the moon scope rides", () => {
    expect(chartSeries("temperature")).toEqual(["temperature.mean"]);
    expect(chartSeries("precipitation")).toEqual(["precipitation.pww", "precipitation.pwd"]);
    expect(chartSeries("wind")).toEqual(["wind.speed"]);
    expect(chartSeries("sky")).toEqual(["cloud.dry", "cloud.wet", "humidity.dry", "humidity.wet"]);

    expect(primarySeries("precipitation")).toBe("precipitation.pwd");
    expect(primarySeries("sky")).toBe("cloud.dry");
    expect(primarySeries("wind")).toBe("wind.speed");
  });

  test("a companion is the other half of the same section, and nothing else", () => {
    expect(companionSeries("precipitation", "precipitation.pwd")).toEqual(["precipitation.pww"]);
    expect(companionSeries("sky", "cloud.dry")).toEqual(["cloud.wet"]);
    expect(companionSeries("sky", "humidity.wet")).toEqual(["humidity.dry"]);
    expect(companionSeries("temperature", "temperature.mean")).toEqual([]);
  });

  test("both halves of a pair draw and edit independently", () => {
    const z = zone();
    for (const param of ["precipitation.pww", "precipitation.pwd"]) {
      const points = curvePoints(z, param, ALL_SCOPE);
      expect(points.length, param).toBe(12);
      for (const [, v] of points) expect(v >= 0 && v <= 1, param).toBe(true);
    }
    expect(setKeyframe(z, "precipitation.pwd", 0, 0.9)).toBe(true);
    expect(z.modifiers.map((m) => m.id)).toEqual(["layer:precipitation.pwd:curve"]);
    expect(curvePoints(z, "precipitation.pwd", ALL_SCOPE)[0]![1]).toBeCloseTo(0.9, 9);
    // …and the companion is untouched.
    expect(z.modifiers.some((m) => m.id.includes("pww"))).toBe(false);
    expect(errors(z)).toEqual([]);
  });
});

describe("the WRITES footer", () => {
  test("layerGlob names every section the channel owns — SKY owns two", () => {
    expect(layerGlob("temperature")).toBe("layer:temperature.*");
    expect(layerGlob("precipitation")).toBe("layer:precipitation.*");
    expect(layerGlob("wind")).toBe("layer:wind.*");
    expect(layerGlob("sky")).toBe("layer:cloud.* · layer:humidity.*");
  });

  test("writesText lists only the channel's own layers, and says so when there are none", () => {
    const z = zone();
    write(z, "sky", ALL_SCOPE, "cloud", 0.2);
    write(z, "temperature", ALL_SCOPE, "offset", 3);

    const sky = writesText(z, "sky");
    expect(sky).toContain("layer:cloud.dry");
    expect(sky).toContain("layer:cloud.wet");
    expect(sky).not.toContain("temperature");

    expect(writesText(z, "temperature")).toContain("layer:temperature.mean");
    expect(writesText(z, "wind")).toBe("modifiers[layer:wind.*] — neutral, nothing written");
  });

  test("a stray layer is still listed under its channel — the footer states the file, not the intent", () => {
    const z = zone([{ id: "layer:wind.speed:nonsense", apply: [{ param: "wind.speed", op: "offset", value: 2 }] }]);
    expect(writesText(z, "wind")).toContain("layer:wind.speed:nonsense");
  });
});
