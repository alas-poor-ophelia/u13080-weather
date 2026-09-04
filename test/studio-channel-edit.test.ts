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
import { isCurvePath } from "../src/core/curve-ops";
import { validateProfile } from "../src/core/profile";
import type { Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
import {
  addEnvelopePoint,
  addKeyframe,
  ALL_SCOPE,
  channelStat,
  chartPlots,
  chartSeries,
  clearDirection,
  companionSeries,
  curvePoints,
  directionLayer,
  directionRose,
  isDerivedSeries,
  layerGlob,
  mirrorsStation,
  stationDisplay,
  plotPoints,
  PRECIP_WET_SHARE,
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
  pointWhen,
  scopeChips,
  seasonBands,
  seasonDirections,
  seasonMarkers,
  seasonScope,
  spreadPoints,
  spreadSamples,
  setEnvelopePoint,
  setKeyframe,
  stageCaption,
  stationPoints,
  stationSamples,
  swungPoints,
  swungSamples,
  wetDayPoints,
  wetDaySamples,
  curveSamples,
  plotSamples,
  LINE_SAMPLES,
  write,
  writers,
  writtenLayers,
  type KnobId,
} from "../src/studio/model/channel-edit";
import { wetFraction } from "../src/studio/model/channel-series";
import { effectiveBase, getAllYear, getCycle, getSeasonOffset, getSwing, setSwing, type Channel } from "../src/studio/model/compile";
import { arcAngles, valueToAngle } from "../src/studio/model/knob";
import { rollYear } from "../src/studio/model/audition";
import { InternalCalendar } from "../src/plugin/time/internal";

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

  test("stageCaption names the modifier it writes, the stage and the predicate", () => {
    expect(stageCaption("temperature.mean", ALL_SCOPE)).toBe("writes modifiers[layer:temperature.mean] · stage climate · unconditional, reshapes the baseline once");
    expect(stageCaption("temperature.mean", seasonScope("Winter"))).toBe("writes modifiers[layer:temperature.mean:season:Winter] · when.tag season:Winter");
    expect(stageCaption("temperature.mean", moonScope("Sable"))).toBe("writes modifiers[layer:temperature.mean:moon:Sable] · when.moon Sable · the drawn curve is its envelope");
    // the cycle length is real calendar data, so it is only named when known
    expect(stageCaption("temperature.mean", moonScope("Sable"), 29.53)).toBe("writes modifiers[layer:temperature.mean:moon:Sable] · when.moon Sable · the drawn curve is its envelope · repeats every 29.53 d");
    // a paired channel's caption follows the picker, not the channel
    expect(stageCaption("precipitation.pww", ALL_SCOPE)).toContain("modifiers[layer:precipitation.pww]");
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

/**
 * PLAN D18 — day jitter σ and gust show the station's own figure and store the
 * delta. The lens is the whole of the change: nothing below asserts a new
 * modifier shape, because there is none.
 */
describe("station-absolute knobs (D18)", () => {
  /** The station σ the jitter knob rests on: `temperature.sd` at the twelve month centres. */
  function stationSigma(z: ZoneProfile): number {
    const sd = z.climate.temperature.sd;
    let sum = 0;
    for (let m = 0; m < 12; m++) sum += evalCurve(sd, monthCentrePhase(m));
    return sum / 12;
  }

  test("only jitter and gust mirror a station quantity", () => {
    expect(mirrorsStation(TEMP_CHANNEL, "jitter")).toBe(true);
    expect(mirrorsStation("wind", "gust")).toBe(true);
    for (const id of ["offset", "swing", "depth", "wind", "calm", "chance"] as KnobId[]) {
      expect(mirrorsStation(TEMP_CHANNEL, id)).toBe(false);
    }
    // The pairing is per channel, not per id: `gust` is WIND's alone.
    expect(mirrorsStation(TEMP_CHANNEL, "gust")).toBe(false);
    expect(mirrorsStation("wind", "jitter")).toBe(false);
  });

  test("jitter rests on the station's own σ, and a stored offset rides on it", () => {
    const z = zone();
    const lens = stationDisplay(z, TEMP_CHANNEL, "jitter");
    expect(lens).not.toBeNull();
    expect(lens!.neutral).toBe(0);
    expect(lens!.station).toBeCloseTo(stationSigma(z), 12);
    // At rest the face is the station's σ, not a bare 0.
    expect(lens!.toDisplay(read(z, TEMP_CHANNEL, ALL_SCOPE).jitter)).toBeCloseTo(lens!.station, 12);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "jitter", 1.5);
    expect(lens!.toDisplay(read(z, TEMP_CHANNEL, ALL_SCOPE).jitter)).toBeCloseTo(lens!.station + 1.5, 12);
  });

  test("gust rests on wind.wetDayScale — the ×1.30 the card prints — and its layer's no-op is ×1", () => {
    const z = zone();
    const lens = stationDisplay(z, "wind", "gust");
    expect(lens).not.toBeNull();
    expect(lens!.neutral).toBe(1);
    expect(lens!.station).toBe(z.climate.wind.wetDayScale);
    expect(lens!.toDisplay(read(z, "wind", ALL_SCOPE).gust)).toBeCloseTo(lens!.station, 12);
  });

  test("toDisplay and fromDisplay round-trip, both ways, on both knobs", () => {
    const z = zone();
    for (const [channel, knob, stored] of [
      [TEMP_CHANNEL, "jitter", [-2, -0.4, 0, 0.7, 2.1]],
      ["wind", "gust", [0.7, 1, 1.15, 1.4]],
    ] as Array<[Channel, KnobId, number[]]>) {
      const lens = stationDisplay(z, channel, knob)!;
      for (const v of stored) expect(lens.fromDisplay(lens.toDisplay(v))).toBeCloseTo(v, 12);
      for (const shown of [0, 1, 2.5, 4.9]) expect(lens.toDisplay(lens.fromDisplay(shown))).toBeCloseTo(shown, 12);
    }
  });

  test("what a drag writes is the delta, and the station never moves", () => {
    const z = zone();
    const lens = stationDisplay(z, TEMP_CHANNEL, "jitter")!;
    const before = structuredClone(z.climate);
    // The face is dragged to a whole absolute σ; the layer stores the difference.
    write(z, TEMP_CHANNEL, ALL_SCOPE, "jitter", lens.fromDisplay(4));
    expect(read(z, TEMP_CHANNEL, ALL_SCOPE).jitter).toBeCloseTo(4 - lens.station, 12);
    expect(z.modifiers.map((m) => m.id)).toEqual(["layer:temperature.sd"]);
    // The record is untouched, so the lens still reads the same station.
    expect(z.climate).toEqual(before);
    expect(stationDisplay(z, TEMP_CHANNEL, "jitter")!.station).toBe(lens.station);
    expect(errors(z)).toEqual([]);
  });

  test("a knob with no station lens is unchanged, and an absent station degrades to the plain delta", () => {
    const z = zone();
    expect(stationDisplay(z, TEMP_CHANNEL, "offset")).toBeNull();
    expect(stationDisplay(z, "precipitation", "chance")).toBeNull();
    // A record whose σ curve is missing has no station figure to show.
    const broken = zone();
    (broken.climate.temperature as { sd?: unknown }).sd = undefined;
    expect(stationDisplay(broken, TEMP_CHANNEL, "jitter")).toBeNull();
  });

  test("the arc grows from the track minimum: no neutral on either spec (SPEC law 6)", () => {
    // The two specs `windows/channel.ts` carries, restated — a station knob is
    // unipolar, so `arcAngles` sweeps from −135° (the minimum) and the knob is
    // lit at rest rather than dark at a mid-track neutral.
    const jitter = { min: 0, max: 5, step: 0.1 };
    const gust = { min: 1, max: 1.6, step: 0.01 };
    expect(arcAngles(2.9, jitter)).toEqual({ from: -135, to: valueToAngle(2.9, jitter) });
    expect(arcAngles(1.3, gust)).toEqual({ from: -135, to: valueToAngle(1.3, gust) });
    // …and a bipolar delta knob still sweeps from its own neutral.
    expect(arcAngles(3, { min: -10, max: 10, neutral: 0 })).toEqual({ from: 0, to: valueToAngle(3, { min: -10, max: 10, neutral: 0 }) });
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

  test("seasonBands cover the whole year, in list order, wrapping past the end", () => {
    const bands = seasonBands(ALL_SCOPE, CALENDAR);
    expect(bands.map((b) => b.name)).toEqual(["Spring", "Summer", "Autumn", "Winter"]);
    expect(bands.map((b) => [b.from, b.to])).toEqual([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1],
    ]);
    // the index is the season's own list position, so the caller can look up its palette entry
    expect(bands.map((b) => b.index)).toEqual([0, 1, 2, 3]);
  });

  test("a year that does not start on a season boundary still has no bare gap", () => {
    const bands = seasonBands(ALL_SCOPE, { seasons: [{ name: "Wet", from: 0.2 }, { name: "Dry", from: 0.6 }], moons: [] });
    expect(bands.map((b) => [b.from, b.to])).toEqual([
      [0.2, 0.6],
      [0.6, 1.2],
    ]);
  });

  test("a cycle scope bands the moon's own named phases, and nothing when it has none", () => {
    const moons = [{ name: "Sable", phases: [{ name: "New", at: 0 }, { name: "Full", at: 0.5 }] }];
    expect(seasonBands(moonScope("Sable"), { seasons: CALENDAR.seasons, moons }).map((b) => b.name)).toEqual(["New", "Full"]);
    expect(seasonBands(moonScope("Umber"), { seasons: CALENDAR.seasons, moons })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the drawn line is dense, the handles are not", () => {
  test("curveSamples is the SAME evalCurve the generator reads, at every sampled x", () => {
    const z = zone();
    const samples = curveSamples(z, TEMP, ALL_SCOPE);
    const base = effectiveBase(z, TEMP);
    expect(samples.length).toBe(LINE_SAMPLES);
    // no second smoothing: every point is on the engine's own interpolant
    for (const [at, v] of samples) expect(Math.abs(v - evalCurve(base, at))).toBeLessThan(1e-9);
  });

  test("the samples span the whole year and close the loop, so no seam is left at either edge", () => {
    const z = zone();
    const samples = curveSamples(z, TEMP, ALL_SCOPE);
    expect(samples[0]?.[0]).toBe(0);
    expect(samples[samples.length - 1]?.[0]).toBe(1);
    // a year is periodic: the last sample IS the first one, so the ink meets itself
    expect(samples[samples.length - 1]?.[1]).toBeCloseTo(samples[0]![1], 12);
    // evenly spaced, so the density is the same at the edges as in the middle
    samples.forEach((p, i) => expect(p[0]).toBeCloseTo(i / (LINE_SAMPLES - 1), 12));
  });

  test("the handles stay on the keyframes, whatever the line is drawn from", () => {
    const z = zone();
    expect(curvePoints(z, TEMP, ALL_SCOPE).length).toBe(12);
    curvePoints(z, TEMP, ALL_SCOPE).forEach((p, m) => expect(p[0]).toBeCloseTo(monthCentrePhase(m), 12));
    // an edit still lands on the handle it was aimed at, and the dense line follows
    expect(setKeyframe(z, TEMP, 3, 20)).toBe(true);
    expect(curvePoints(z, TEMP, ALL_SCOPE).length).toBe(12);
    expect(curvePoints(z, TEMP, ALL_SCOPE)[3]?.[1]).toBeCloseTo(20, 6);
    const base = effectiveBase(z, TEMP);
    for (const [at, v] of curveSamples(z, TEMP, ALL_SCOPE)) expect(Math.abs(v - evalCurve(base, at))).toBeLessThan(1e-9);
    // a keyframe added or removed moves the handle count, never the sample count
    expect(addKeyframe(z, TEMP, 0.5, 9)).toBe(true);
    expect(curvePoints(z, TEMP, ALL_SCOPE).length).toBe(13);
    expect(curveSamples(z, TEMP, ALL_SCOPE).length).toBe(LINE_SAMPLES);
  });

  test("a monotone run of keyframes is still monotone between them", () => {
    const z = zone();
    for (let m = 0; m < 12; m++) expect(setKeyframe(z, TEMP, m, m * 2)).toBe(true);
    const [lo, hi] = [monthCentrePhase(0), monthCentrePhase(11)];
    const run = curveSamples(z, TEMP, ALL_SCOPE).filter((p) => p[0] >= lo && p[0] <= hi);
    expect(run.length).toBeGreaterThan(50);
    // Fritsch–Carlson never overshoots, so a rising run of keys rises all the way
    run.forEach((p, i) => {
      if (i > 0) expect(p[1]).toBeGreaterThanOrEqual(run[i - 1]![1] - 1e-12);
    });
  });

  test("every reference line has a dense twin, and the twins agree with the handles", () => {
    const z = zone();
    setSwing(z, TEMP, 0.6);
    const swung = swungSamples(z, TEMP, ALL_SCOPE);
    const handleMean = curvePoints(z, TEMP, ALL_SCOPE).reduce((a, p) => a + p[1], 0) / 12;
    expect(swung.length).toBe(LINE_SAMPLES);
    // the drawn swing pivots about the handles' own mean, not a second one
    curveSamples(z, TEMP, ALL_SCOPE).forEach((p, i) => expect(swung[i]?.[1]).toBeCloseTo(handleMean + (p[1] - handleMean) * 0.6, 9));

    const station = stationSamples(z, TEMP, ALL_SCOPE);
    expect(station.length).toBe(LINE_SAMPLES);
    for (const [at, v] of station) expect(v).toBeCloseTo(evalCurve(z.climate.temperature.mean, at), 9);

    const spread = spreadSamples(z, TEMP, ALL_SCOPE);
    expect(spread.length).toBe(LINE_SAMPLES);
    for (const [at, v] of spread) expect(v).toBeCloseTo(Math.abs(evalCurve(z.climate.temperature.diurnalRange, at)) / 2, 9);
    // and a twin is absent exactly where its handle list is
    expect(spreadPoints(z, "precipitation.pwd", ALL_SCOPE)).toEqual([]);
    expect(spreadSamples(z, "precipitation.pwd", ALL_SCOPE)).toEqual([]);
    expect(stationSamples(z, TEMP, moonScope("Sable"))).toEqual([]);

    const ghost = wetDaySamples(z, TEMP, ALL_SCOPE);
    expect(ghost.length).toBe(wetDayPoints(z, TEMP, ALL_SCOPE).length === 0 ? 0 : LINE_SAMPLES);
    const flat = zone();
    flat.climate.temperature.wetDayOffset = 0;
    expect(wetDaySamples(flat, TEMP, ALL_SCOPE)).toEqual([]);
  });

  test("the derived wet share is dense too, and is still wetFraction of the same pair", () => {
    const z = zone();
    const share = plotSamples(z, PRECIP_WET_SHARE, ALL_SCOPE);
    expect(share.length).toBe(LINE_SAMPLES);
    const pwd = effectiveBase(z, "precipitation.pwd");
    const pww = effectiveBase(z, "precipitation.pww");
    for (const [at, v] of share) expect(v).toBeCloseTo(wetFraction(evalCurve(pwd, at), evalCurve(pww, at)), 9);
    // an ordinary series is just its own curve, densely
    expect(plotSamples(z, TEMP, ALL_SCOPE)).toEqual(curveSamples(z, TEMP, ALL_SCOPE));
    // …and the handle list is untouched by any of it
    expect(plotPoints(z, PRECIP_WET_SHARE, ALL_SCOPE).length).toBe(12);
  });

  test("a ☾ envelope is never densified: each of its points is a handle", () => {
    const z = zone();
    const scope = moonScope("Sable");
    expect(curveSamples(z, TEMP, scope)).toEqual(curvePoints(z, TEMP, scope));
    expect(plotSamples(z, TEMP, scope)).toEqual(curvePoints(z, TEMP, scope));
    expect(swungSamples(z, TEMP, scope)).toEqual(curvePoints(z, TEMP, scope));
  });
});

// ---------------------------------------------------------------------------

describe("the chart's reference marks", () => {
  test("the spread ribbon is the channel's own companion curve, halved where it is a full range", () => {
    const z = zone();
    const drawn = curvePoints(z, TEMP, ALL_SCOPE);
    const spread = spreadPoints(z, TEMP, ALL_SCOPE);
    expect(spread).toHaveLength(drawn.length);
    expect(spread.every((p) => p[1] >= 0)).toBe(true);
    // half of temperature.diurnalRange, at the same phase
    expect(spread[0]?.[1]).toBeCloseTo(evalCurve(z.climate.temperature.diurnalRange, drawn[0]![0]) / 2, 10);
    // a fraction-valued parameter has no spread curve, and a cycle scope draws no ribbon
    expect(spreadPoints(z, "precipitation.pwd", ALL_SCOPE)).toEqual([]);
    expect(spreadPoints(z, TEMP, moonScope("Sable"))).toEqual([]);
  });

  test("the wet-day ghost is the drawn curve plus temperature.wetDayOffset, and absent when that is flat zero", () => {
    const z = zone();
    const drawn = curvePoints(z, TEMP, ALL_SCOPE);
    const ghost = wetDayPoints(z, TEMP, ALL_SCOPE);
    if (ghost.length > 0) {
      expect(ghost[0]?.[1]).toBeCloseTo(drawn[0]![1] + evalCurve(z.climate.temperature.wetDayOffset, drawn[0]![0]), 10);
    }
    const flat = zone();
    flat.climate.temperature.wetDayOffset = 0;
    expect(wetDayPoints(flat, TEMP, ALL_SCOPE)).toEqual([]);
    expect(wetDayPoints(z, "precipitation.pwd", ALL_SCOPE)).toEqual([]);
  });

  test("pointWhen reads a phase as a calendar day, or as a place in the cycle", () => {
    expect(pointWhen(ALL_SCOPE, 0.5375, { yearLength: 365 })).toBe("day 196 · 54% of year");
    expect(pointWhen(seasonScope("Winter"), 0, { yearLength: 400 })).toBe("day 0 · 0% of year");
    expect(pointWhen(moonScope("Sable"), 0.55, { yearLength: 365, cycleDays: 29.53 })).toBe("cycle d16.2 · phase 0.55");
    // an opaque calendar describes no cycle length, so the readout drops that half
    expect(pointWhen(moonScope("Sable"), 0.55, { yearLength: 365 })).toBe("phase 0.55");
  });

  test("channelStat reports the drawn range and the two scalars behind the curve", () => {
    const z = zone();
    const stat = channelStat(z, TEMP, ALL_SCOPE);
    const ys = curvePoints(z, TEMP, ALL_SCOPE).map((p) => p[1]);
    expect(stat.range).toEqual([Math.min(...ys), Math.max(...ys)]);
    expect(stat.persistence).toBe(z.climate.temperature.persistence);
    // a channel with no wet-day curve of its own reports null rather than inventing one
    expect(channelStat(z, "precipitation.pwd", ALL_SCOPE).wetDayOffset).toBeNull();
    expect(channelStat(z, "precipitation.pwd", ALL_SCOPE).persistence).toBeNull();
  });

  test("writtenLayers names only this channel's layer ids, in modifiers[] order", () => {
    const z = zone();
    expect(writtenLayers(z, TEMP_CHANNEL)).toEqual([]);
    write(z, TEMP_CHANNEL, ALL_SCOPE, "offset", 2);
    write(z, "precipitation", ALL_SCOPE, "chance", 1.5);
    expect(writtenLayers(z, TEMP_CHANNEL)).toEqual(["layer:temperature.mean"]);
    expect(writtenLayers(z, "precipitation").every((id) => id.startsWith("layer:precipitation."))).toBe(true);
  });

  test("every layer the SKY footer names has a writer row of its own", () => {
    // SKY spans two sections, so `layer:humidity.*` is a different writer from
    // `layer:cloud.*` — the footer and the stack have to agree about that.
    const z = zone();
    write(z, "sky", ALL_SCOPE, "humidity", 0.2);
    const named = writtenLayers(z, "sky");
    expect(named.filter((id) => id.startsWith("layer:humidity.")).length).toBeGreaterThan(0);
    const quoted = writers(z, [], "sky")
      .filter((r) => r.kind === "layer")
      .map((r) => r.opsText);
    for (const id of named) {
      const param = id.slice("layer:".length).split(":")[0]!;
      expect(quoted.some((t) => t.startsWith(param)), id).toBe(true);
    }
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

  test("signal order, one row per source (SPEC §1), Forcings always among them", () => {
    const { rows } = stacked();
    expect(rows.map((r) => r.kind)).toEqual(["station", "layer", "layer", "regime", "device", "forcings", "era"]);
    // The BASE row names the STATION, as the SRC chip does — not the preset's file id.
    expect(rows[0]?.label).toBe("Bergen record");
    expect(rows[1]?.label).toBe("all year offset");
    expect(rows[2]?.label).toBe("season · Winter");
    expect(rows[5]?.label).toBe("Forcings");
    expect(rows[5]?.opsText).toBe("neutral");
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
    // One panel, one signal path, one row — the prototype's MST. The lane is
    // folded in rather than standing alone under its own id (`frc.warmth`).
    expect(rows.filter((r) => r.kind === "automation")).toEqual([]);
    const mst = rows.filter((r) => r.kind === "forcings");
    expect(mst).toHaveLength(1);
    expect(mst[0]?.target).toEqual({ win: "forcings", id: "forcings" });
    expect(mst[0]?.label).toBe("Forcings");
    expect(mst[0]?.opsText).toBe("∿ +2 · trim +1");
  });

  test("the Forcings row names itself on every channel, whatever is turned", () => {
    const bare = zone();
    for (const c of ["temperature", "precipitation", "wind", "sky"] as const) {
      const mst = writers(bare, [], c).filter((r) => r.kind === "forcings");
      expect(mst.map((r) => [r.label, r.opsText]), c).toEqual([["Forcings", "neutral"]]);
    }
    // A lane alone still reads as Forcings, never as its own key.
    const laned = zone();
    laned.automation = [{ id: "frc.warmth", param: TEMP, op: "offset", points: [[1, 3]] }];
    const rows = writers(laned, [], "temperature").filter((r) => r.kind === "forcings");
    expect(rows.map((r) => [r.label, r.opsText])).toEqual([["Forcings", "∿ +3"]]);
    for (const r of writers(laned, [], "temperature")) expect(r.label).not.toBe("frc.warmth");
  });

  test("the station row quotes its own record; the rest quote their ops", () => {
    const { z, rows } = stacked();
    // `12 kf · 30 yr` — the prototype's BASE value, off the shipped station:
    // the record's own keyframes and how many years were kept.
    expect(rows[0]?.opsText).toBe("12 kf · 30 yr");
    expect(rows[1]?.opsText).toBe("temperature.mean offset 2");
    expect(rows[2]?.opsText).toBe("temperature.mean offset −2");
    // A layer left the record alone; dragging the curve itself does not.
    setKeyframe(z, TEMP, 0, 9);
    expect(writers(z, [], "temperature")[0]?.opsText).toBe("edited");
  });

  test("the station row reads every channel off its own primary curve", () => {
    const z = zone();
    for (const c of ["temperature", "precipitation", "wind", "sky"] as const) {
      expect(writers(z, [], c)[0], c).toMatchObject({ kind: "station", label: "Bergen record", opsText: "12 kf · 30 yr" });
    }
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
  test("every channel stacks its plots, a pair to an axis, and names the line the moon scope rides", () => {
    expect(chartPlots("temperature")).toEqual([["temperature.mean"]]);
    // `0345` stacks PRECIP three deep: the derived wet-day share on top, then
    // the Markov pair sharing one 0-1 axis, then millimetres on an axis of
    // their own. The pair reads wet-after-wet first, as the prototype's legend
    // does.
    expect(chartPlots("precipitation")).toEqual([["precipitation.wetFraction"], ["precipitation.pww", "precipitation.pwd"], ["precipitation.scale"]]);
    expect(chartPlots("wind")).toEqual([["wind.speed"], ["wind.calmFraction"]]);
    expect(chartPlots("sky")).toEqual([
      ["cloud.dry", "cloud.wet"],
      ["humidity.dry", "humidity.wet"],
    ]);

    // `chartSeries` is the same list, flattened — every line the panel draws.
    for (const channel of ["temperature", "precipitation", "wind", "sky"] as const) {
      expect(chartSeries(channel), channel).toEqual(chartPlots(channel).flat());
      // Nothing is drawn twice, and every line is a real curve path — or a
      // derived one, which has no curve behind it by definition.
      expect(new Set(chartSeries(channel)).size, channel).toBe(chartSeries(channel).length);
      for (const param of chartSeries(channel)) expect(isCurvePath(param) || isDerivedSeries(param), param).toBe(true);
      // The moon scope's series is always one of the drawn ones.
      expect(chartSeries(channel), channel).toContain(primarySeries(channel));
    }

    expect(primarySeries("precipitation")).toBe("precipitation.pwd");
    expect(primarySeries("sky")).toBe("cloud.dry");
    expect(primarySeries("wind")).toBe("wind.speed");
  });

  test("a companion is the other line on the same plot, and nothing else", () => {
    expect(companionSeries("precipitation", "precipitation.pwd")).toEqual(["precipitation.pww"]);
    // The mm curve is on its own axis, so it is nobody's companion.
    expect(companionSeries("precipitation", "precipitation.scale")).toEqual([]);
    expect(companionSeries("sky", "cloud.dry")).toEqual(["cloud.wet"]);
    expect(companionSeries("sky", "humidity.wet")).toEqual(["humidity.dry"]);
    expect(companionSeries("wind", "wind.speed")).toEqual([]);
    expect(companionSeries("temperature", "temperature.mean")).toEqual([]);
  });

  test("the wet-day share is derived from the pair, and a plain series is not", () => {
    const z = zone();
    const share = plotPoints(z, PRECIP_WET_SHARE, ALL_SCOPE);
    const pwd = curvePoints(z, "precipitation.pwd", ALL_SCOPE);
    const pww = curvePoints(z, "precipitation.pww", ALL_SCOPE);
    expect(isDerivedSeries(PRECIP_WET_SHARE)).toBe(true);
    expect(isDerivedSeries("precipitation.pwd")).toBe(false);
    // Sampled at the pwd phases, so the two curves meet on one set of points.
    expect(share.map((p) => p[0])).toEqual(pwd.map((p) => p[0]));
    expect(share.map((p) => p[1])).toEqual(pwd.map((p, i) => wetFraction(p[1], pww[i]![1])));
    // It is a share of days, so it never leaves the plot's 0-1 axis.
    for (const [, v] of share) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Every other series still comes straight off its own curve.
    expect(plotPoints(z, "precipitation.pwd", ALL_SCOPE)).toEqual(pwd);
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

describe("the rose, by season", () => {
  test("one wedge per season, at the bearing it blows from, with its compass point", () => {
    const z = zone();
    const dirs = seasonDirections(z, CALENDAR);
    expect(dirs.map((d) => d.name)).toEqual(["Spring", "Summer", "Autumn", "Winter"]);
    expect(dirs.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    // Nothing is set yet, so every wedge is the station's own bearing.
    expect(dirs.every((d) => !d.own)).toBe(true);
    for (const d of dirs) {
      expect(d.degrees >= 0 && d.degrees < 360, d.name).toBe(true);
      // The compass point is the bearing, not a separate opinion about it.
      expect(d.compass, d.name).toBe(["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(d.degrees / 22.5) % 16]!);
    }
  });

  test("a season with its own bearing sits on it and says so; the reset puts it back", () => {
    const z = zone();
    write(z, "wind", seasonScope("Summer"), "direction", 100);
    const set = seasonDirections(z, CALENDAR).find((d) => d.name === "Summer")!;
    expect(set.degrees).toBeCloseTo(100, 9);
    expect(set.compass).toBe("E");
    expect(set.own).toBe(true);
    // The others are untouched and still read off the station's curve.
    expect(seasonDirections(z, CALENDAR).filter((d) => d.own).map((d) => d.name)).toEqual(["Summer"]);

    clearDirection(z, "Summer");
    expect(seasonDirections(z, CALENDAR).some((d) => d.own)).toBe(false);
  });

  test("a calendar with no seasons has no wedges — the histogram is what degrades, not this", () => {
    expect(seasonDirections(zone(), { seasons: [] })).toEqual([]);
    expect(directionRose(zone(), { seasons: [] }).length).toBe(ROSE_SECTORS);
  });
});

describe("the per-channel stat card (SPEC §8)", () => {
  test("PRECIP reports the share the Markov pair settles at, plus the amount and its scalars", () => {
    const z = zone();
    const stat = channelStat(z, "precipitation.pwd", ALL_SCOPE);
    // The stationary share sits between the two odds it is derived from.
    const pwd = curvePoints(z, "precipitation.pwd", ALL_SCOPE).map((p) => p[1]);
    const pww = curvePoints(z, "precipitation.pww", ALL_SCOPE).map((p) => p[1]);
    expect(stat.wetShare).not.toBeNull();
    expect(stat.wetShare!).toBeGreaterThan(Math.min(...pwd));
    expect(stat.wetShare!).toBeLessThan(Math.max(...pww));
    expect(stat.wetRunPeak).toBeCloseTo(Math.max(...pww), 9);
    // The mean fall is the gamma mean, k x theta, at every phase.
    const shape = curvePoints(z, "precipitation.shape", ALL_SCOPE).map((p) => p[1]);
    const scale = curvePoints(z, "precipitation.scale", ALL_SCOPE).map((p) => p[1]);
    expect(stat.amountMm).toBeCloseTo(shape.reduce((a, k, i) => a + k * scale[i]!, 0) / shape.length, 9);
    expect(stat.freezingPoint).toBe(z.climate.precipitation.freezingPoint);
    expect(stat.gammaShape).toBeCloseTo(shape.reduce((a, v) => a + v, 0) / shape.length, 9);
    // …and none of temperature's or sky's lines leak onto it.
    expect(stat.persistence).toBeNull();
    expect(stat.daySigma).toBeNull();
    expect(stat.mean).toBeNull();
  });

  test("the wet share follows the knobs: more chance is wetter, more stickiness is wetter", () => {
    const base = channelStat(zone(), "precipitation.pwd", ALL_SCOPE).wetShare!;
    const wetter = zone();
    write(wetter, "precipitation", ALL_SCOPE, "chance", 1.5);
    expect(channelStat(wetter, "precipitation.pwd", ALL_SCOPE).wetShare!).toBeGreaterThan(base);
    const stickier = zone();
    write(stickier, "precipitation", ALL_SCOPE, "stick", 1.2);
    expect(channelStat(stickier, "precipitation.pwd", ALL_SCOPE).wetShare!).toBeGreaterThan(base);
  });

  test("WIND reports the calm share and the wet-day multiplier, and follows the calm knob", () => {
    const z = zone();
    const stat = channelStat(z, "wind.speed", ALL_SCOPE);
    const calm = curvePoints(z, "wind.calmFraction", ALL_SCOPE).map((p) => p[1]);
    expect(stat.calmShare).toBeCloseTo(calm.reduce((a, v) => a + v, 0) / calm.length, 9);
    expect(stat.wetDayScale).toBe(z.climate.wind.wetDayScale);
    expect(stat.wetShare).toBeNull();

    write(z, "wind", ALL_SCOPE, "calm", 0.1);
    expect(channelStat(z, "wind.speed", ALL_SCOPE).calmShare!).toBeCloseTo(stat.calmShare! + 0.1, 6);
  });

  test("SKY reports the pair dry-then-wet whichever half the handles are on, and the day-to-day sigma", () => {
    const z = zone();
    const onDry = channelStat(z, "cloud.dry", ALL_SCOPE);
    const onWet = channelStat(z, "cloud.wet", ALL_SCOPE);
    expect(onDry.mean).not.toBeNull();
    expect(onDry.mean).toBeCloseTo(onWet.mean!, 12);
    expect(onDry.companionMean).toBeCloseTo(onWet.companionMean!, 12);
    // A wet day is cloudier than a dry one, and the pair is reported in that order.
    expect(onDry.companionMean!).toBeGreaterThan(onDry.mean!);
    expect(onDry.daySigma).toBe(z.climate.cloud.sd);
    expect(channelStat(z, "humidity.dry", ALL_SCOPE).daySigma).toBe(z.climate.humidity.sd);
    // The cloud knob moves both halves, so both means move with it.
    write(z, "sky", ALL_SCOPE, "cloud", 0.05);
    const after = channelStat(z, "cloud.dry", ALL_SCOPE);
    expect(after.mean!).toBeCloseTo(onDry.mean! + 0.05, 6);
    expect(after.companionMean!).toBeCloseTo(onDry.companionMean! + 0.05, 6);
  });

  test("TEMPERATURE keeps its own two lines and grows none of the others", () => {
    const stat = channelStat(zone(), TEMP, ALL_SCOPE);
    expect(stat.persistence).toBe(fjord.climate.temperature.persistence);
    expect(stat.wetDayOffset).not.toBeNull();
    expect([stat.wetShare, stat.amountMm, stat.calmShare, stat.mean, stat.daySigma]).toEqual([null, null, null, null, null]);
  });

  /**
   * The prototype states the wet-day ghost as one constant (`mean(t) + 0.35`).
   * The engine's is not a constant: `climate.temperature.wetDayOffset` is a
   * `Curve` (`core/types.ts`), read per day by `evaluateDayParams`, and every
   * shipped station carries a signed seasonal one. The ghost is therefore
   * drawn seasonal and the note card says the span — the number the prototype
   * prints does not exist here and must not be faked.
   */
  test("the wet-day ghost is the engine's seasonal offset, not a constant", () => {
    const curve = fjord.climate.temperature.wetDayOffset;
    expect(Array.isArray(curve)).toBe(true);
    const z = zone();
    const mean = curvePoints(z, TEMP, ALL_SCOPE);
    const ghost = wetDayPoints(z, TEMP, ALL_SCOPE);
    expect(ghost.length).toBe(mean.length);
    // Point for point, the ghost is the mean plus that day's own offset…
    const gaps = ghost.map((p, i) => p[1] - mean[i]![1]);
    for (const [i, g] of gaps.entries()) expect(g).toBeCloseTo(evalCurve(curve, mean[i]![0]), 12);
    // …and those offsets are not all the same number, which is the whole point.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.05);
    // The card's span is that same spread, reported as [min, max] rather than
    // as a mean — a signed seasonal offset averages out to nearly nothing.
    const span = channelStat(z, TEMP, ALL_SCOPE).wetDayOffset!;
    expect(span[0]).toBeCloseTo(Math.min(...gaps), 12);
    expect(span[1]).toBeCloseTo(Math.max(...gaps), 12);
  });

  test("SKY's card can name both sections' sigma from whichever half is selected", () => {
    // What `paintStats` joins into `cloud 0.15 · humid 0.10` (`0480` l.24):
    // the scatter is a channel fact, so it does not change under a legend click.
    const z = zone();
    for (const selected of ["cloud.dry", "cloud.wet", "humidity.dry", "humidity.wet"]) {
      expect(channelStat(z, "cloud.dry", ALL_SCOPE).daySigma, selected).toBe(z.climate.cloud.sd);
      expect(channelStat(z, "humidity.dry", ALL_SCOPE).daySigma, selected).toBe(z.climate.humidity.sd);
    }
  });
});

describe("a wind edit reaches the audition (SPEC §8)", () => {
  const cal = new InternalCalendar({ yearLength: 360, epochYear: 1, moons: [], seasons: [] }, () => 0);
  const roll = (z: ZoneProfile) => rollYear({ zone: z, eras: [] as Era[], seed: "world-seed", adapter: cal, year: 1, salt: 0 });

  test("the speed knob moves the rolled wind, not just the drawn curve", () => {
    const before = roll(zone());
    const z = zone();
    write(z, "wind", ALL_SCOPE, "wind", 8);
    const after = roll(z);
    expect(after.days.length).toBe(before.days.length);
    expect(after.issues.filter((i) => i.level === "error")).toEqual([]);
    // Every non-calm day is faster by the offset the knob wrote.
    const moved = after.days.filter((d, i) => !d.record.calm && !before.days[i]!.record.calm);
    expect(moved.length).toBeGreaterThan(0);
    for (const d of moved) {
      const was = before.days.find((b) => b.dayOrdinal === d.dayOrdinal)!;
      expect(d.record.windSpeedKph).toBeGreaterThan(was.record.windSpeedKph);
    }
  });

  test("a season bearing and the calm knob both reach the roll too", () => {
    const before = roll(zone());
    const z = zone();
    write(z, "wind", ALL_SCOPE, "calm", 0.3);
    const calmer = roll(z);
    expect(calmer.days.filter((d) => d.record.calm).length).toBeGreaterThan(before.days.filter((d) => d.record.calm).length);

    // The bearing is season-gated, so it needs a calendar that has seasons.
    const seasonal = new InternalCalendar({ yearLength: 360, epochYear: 1, moons: [], seasons: [{ name: "Thaw", from: 0 }, { name: "Deepcold", from: 0.5 }] }, () => 0);
    const b = zone();
    write(b, "wind", seasonScope("Thaw"), "direction", 270);
    const turned = rollYear({ zone: b, eras: [] as Era[], seed: "world-seed", adapter: seasonal, year: 1, salt: 0 });
    const thawDays = turned.days.filter((d) => (d.time.tags ?? []).includes("season:Thaw"));
    expect(thawDays.length).toBeGreaterThan(0);
    // A `set` bearing is the prevailing direction; the roll scatters around it,
    // so the mean sits on it rather than every day landing exactly on it. The
    // mean has to be circular — a bearing wraps, and 359 deg and 1 deg do not
    // average to 180.
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    const sin = thawDays.reduce((a, d) => a + Math.sin(rad(d.record.windDirectionDeg)), 0);
    const cos = thawDays.reduce((a, d) => a + Math.cos(rad(d.record.windDirectionDeg)), 0);
    const mean = (((Math.atan2(sin, cos) * 180) / Math.PI) % 360 + 360) % 360;
    expect(Math.abs(mean - 270)).toBeLessThan(20);
  });
});
