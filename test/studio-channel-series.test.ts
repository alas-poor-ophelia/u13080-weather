/**
 * The channel rows' series are the one derivation between the compiled zone
 * (or the roll) and an SVG, so the unit gate holds them to three things:
 *
 *  - **the ribbon IS `sampleCurve`** — PLAN D2 forbids a second sampler, so
 *    every ribbon value is asserted equal to `core/curve.ts`'s own output for
 *    the same resolved curve, and the resolution is `resolveProfile`'s (a
 *    climate-stage layer must move the ribbon);
 *  - **the fine curve is the roll, day by day** — no averaging, no gaps
 *    (SPEC law 4), with x on the fractional-year axis `spans.ts` defines;
 *  - **the memo key moves when, and only when, a pixel would** (PLAN §7).
 */
import { describe, expect, test } from "bun:test";
import { evalCurve, sampleCurve } from "../src/core/curve";
import { eraOpsAt } from "../src/core/eras";
import { resolveProfile } from "../src/core/profile";
import type { Curve, Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
import type { AuditionDay } from "../src/studio/model/audition";
import {
  FINE_MAX_YEARS,
  HEADLINE_ROLE,
  MIN_TEMP_SPAN_C,
  MIN_WIND_SPAN_KPH,
  PRECIP_SCALE_MAX_MM,
  RIBBON_FLAT_YEARS,
  RIBBON_SAMPLES,
  axisLabelled,
  axisTicks,
  composedAcross,
  fineSeries,
  flatMean,
  mmToUnit,
  ribbonAcross,
  ribbonSeries,
  ribbonSourceKey,
  resolvedClimate,
  seriesKey,
  statsOf,
  steppedAcross,
  unitToMm,
  wetFraction,
  windowPoints,
  yRangeFor,
  type ChannelSeries,
} from "../src/studio/model/channel-series";
import { fractionalYear } from "../src/studio/model/spans";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

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

const CAL = { yearLength: 365, epochYear: 1 };

/** The y values of the series with `role`, in order. */
function ys(series: readonly ChannelSeries[], role: string): number[] {
  return (series.find((s) => s.role === role)?.points ?? []).map((p) => p[1]);
}

/** What the ribbon's ring should be for `curve`: 12 samples, closed at phase 1. */
function ringOf(curve: Curve): number[] {
  const s = sampleCurve(curve, RIBBON_SAMPLES);
  return [...s, s[0]!];
}

/** A rolled day, with only the record fields the series read filled in. */
function day(dayOrdinal: number, over: Partial<AuditionDay["record"]>): AuditionDay {
  return {
    dayOrdinal,
    dayOfYear: dayOrdinal + 1,
    record: {
      dayOrdinal,
      yearPhase: 0,
      regime: "baseline",
      wet: false,
      precipMm: 0,
      precipType: "none",
      tempMean: 10,
      tempHigh: 14,
      tempLow: 6,
      tempResidual: 0,
      humidity: 0.7,
      cloudCover: 0.5,
      windSpeedKph: 12,
      windDirectionDeg: 200,
      calm: false,
      tags: [],
      ...over,
    },
    report: {} as AuditionDay["report"],
    active: [],
    pinned: false,
    time: {} as AuditionDay["time"],
  };
}

describe("channel series · the ribbon is sampleCurve", () => {
  test("temperature is the resolved mean, closed into a ring", () => {
    const z = zone();
    const series = ribbonSeries(z, "temperature");
    expect(series.map((s) => s.role)).toEqual(["mean"]);
    expect(ys(series, "mean")).toEqual(ringOf(resolveProfile(z).climate.temperature.mean));
    expect(series[0]!.points.length).toBe(RIBBON_SAMPLES + 1);
    expect(series[0]!.points.map((p) => p[0])).toEqual(Array.from({ length: RIBBON_SAMPLES + 1 }, (_, i) => i / RIBBON_SAMPLES));
  });

  test("precipitation is pwd and pww on the 0–1 axis with scale projected onto it", () => {
    const z = zone();
    const climate = resolveProfile(z).climate;
    const series = ribbonSeries(z, "precipitation");
    expect(series.map((s) => s.role)).toEqual(["amount", "pwd", "pww"]);
    expect(ys(series, "pwd")).toEqual(ringOf(climate.precipitation.pwd));
    expect(ys(series, "pww")).toEqual(ringOf(climate.precipitation.pww));
    expect(ys(series, "amount")).toEqual(ringOf(climate.precipitation.scale).map(mmToUnit));
    for (const y of ys(series, "amount")) expect(y).toBeGreaterThanOrEqual(0);
    for (const y of ys(series, "amount")) expect(y).toBeLessThanOrEqual(1);
  });

  test("wind is the mean speed and sky is the dry/wet cloud split", () => {
    const z = zone();
    const climate = resolveProfile(z).climate;
    expect(ys(ribbonSeries(z, "wind"), "speed")).toEqual(ringOf(climate.wind.speed));
    const sky = ribbonSeries(z, "sky");
    expect(sky.map((s) => s.role)).toEqual(["cloudDry", "cloudWet"]);
    expect(ys(sky, "cloudDry")).toEqual(ringOf(climate.cloud.dry));
    expect(ys(sky, "cloudWet")).toEqual(ringOf(climate.cloud.wet));
  });

  test("a climate-stage layer moves the ribbon, because the ribbon is the RESOLVED climate", () => {
    const base = ribbonSeries(zone(), "temperature");
    const warmed = ribbonSeries(zone([{ id: "layer:temperature.mean:offset", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 3 }] }]), "temperature");
    const before = ys(base, "mean");
    const after = ys(warmed, "mean");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]!).toBeCloseTo(before[i]! + 3, 10);
  });

  test("a zone that cannot resolve draws nothing rather than throwing", () => {
    const broken = zone();
    broken.regimes = [];
    expect(resolvedClimate(broken)).toBeNull();
    expect(ribbonSeries(broken, "temperature")).toEqual([]);
    expect(ribbonSeries(broken, "sky")).toEqual([]);
  });

  test("mmToUnit and unitToMm are inverses inside the axis, and the axis tops out", () => {
    expect(unitToMm(mmToUnit(7))).toBeCloseTo(7, 10);
    expect(mmToUnit(PRECIP_SCALE_MAX_MM * 3)).toBe(1);
    expect(mmToUnit(-4)).toBe(0);
  });

  test("the ribbon's identity is the profile hash, which a layer moves", () => {
    expect(ribbonSourceKey(zone())).toBe(ribbonSourceKey(zone()));
    expect(ribbonSourceKey(zone())).not.toBe(ribbonSourceKey(zone([{ id: "layer:temperature.mean:offset", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 3 }] }])));
  });
});

describe("channel series · the fine curve is the roll", () => {
  const days = [day(0, { tempMean: 2, tempHigh: 5, tempLow: -1 }), day(1, { tempMean: 4, tempHigh: 8, tempLow: 0, wet: true, precipMm: 6.5, windSpeedKph: 30, cloudCover: 0.9 }), day(2, { tempMean: 3, tempHigh: 6, tempLow: 1 })];

  test("temperature is the low/high band plus the mean, one point per rolled day", () => {
    const series = fineSeries(days, "temperature", CAL);
    expect(series.map((s) => s.role)).toEqual(["low", "high", "mean"]);
    expect(ys(series, "low")).toEqual([-1, 0, 1]);
    expect(ys(series, "high")).toEqual([5, 8, 6]);
    expect(ys(series, "mean")).toEqual([2, 4, 3]);
  });

  test("x is the fractional year `spans.ts` puts the same day at", () => {
    const cal = { yearLength: 365, epochYear: 1, seasons: [], moons: [], eras: [] };
    const xs = fineSeries(days, "wind", CAL)[0]!.points.map((p) => p[0]);
    expect(xs).toEqual(days.map((d) => fractionalYear(d.dayOrdinal, cal)));
  });

  test("precipitation carries the wet day's mm and leaves a dry day at zero", () => {
    expect(ys(fineSeries(days, "precipitation", CAL), "amount")).toEqual([0, 6.5, 0]);
  });

  test("wind is the day's speed and sky is the day's cloud cover", () => {
    expect(ys(fineSeries(days, "wind", CAL), "speed")).toEqual([12, 30, 12]);
    expect(ys(fineSeries(days, "sky", CAL), "cloud")).toEqual([0.5, 0.9, 0.5]);
  });

  test("no days is no points, not a throw", () => {
    for (const channel of ["temperature", "precipitation", "wind", "sky"] as const) {
      for (const s of fineSeries([], channel, CAL)) expect(s.points).toEqual([]);
    }
  });
});

describe("channel series · the window and the wide zooms", () => {
  test("windowPoints rescales the window to [0,1] and keeps one point either side", () => {
    const points: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ];
    // A window whose edges fall between points: the neighbours either side are
    // kept (clamped onto the edge) so the line runs the full width.
    const bridged = windowPoints(points, 1.5, 2.5);
    expect(bridged.map((p) => p[1])).toEqual([1, 2, 3]);
    expect(bridged.map((p) => p[0])).toEqual([0, 0.5, 1]);
    // A window whose edges land ON points needs no bridge, and never doubles an x.
    const exact = windowPoints(points, 1, 3);
    expect(exact.map((p) => p[1])).toEqual([1, 2, 3]);
    expect(exact.map((p) => p[0])).toEqual([0, 0.5, 1]);
    expect(windowPoints(points, 2, 2)).toEqual([]);
  });

  test("the ribbon repeats once per year with no duplicated x at the joins", () => {
    const ribbon = ribbonSeries(zone(), "temperature");
    const across = ribbonAcross(ribbon, 4, 7);
    const xs = across[0]!.points.map((p) => p[0]);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(1);
    // Three whole years, RIBBON_SAMPLES points each, plus the closing point.
    expect(xs.length).toBe(3 * RIBBON_SAMPLES + 1);
    expect(new Set(xs).size).toBe(xs.length);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  test("flatMean is one line at the ribbon's own mean, counting each sample once", () => {
    const ribbon = ribbonSeries(zone(), "temperature");
    const samples = sampleCurve(resolveProfile(zone()).climate.temperature.mean, RIBBON_SAMPLES);
    const expected = samples.reduce((a, b) => a + b, 0) / samples.length;
    const flat = flatMean(ribbon);
    expect(flat.length).toBe(1);
    expect(flat[0]!.points.map((p) => p[0])).toEqual([0, 1]);
    expect(flat[0]!.points[0]![1]).toBeCloseTo(expected, 10);
    expect(flat[0]!.points[1]![1]).toBe(flat[0]!.points[0]![1]);
    expect(flatMean([])).toEqual([]);
  });

  test("the morph thresholds are ordered the way the row reads them", () => {
    expect(FINE_MAX_YEARS).toBeLessThan(RIBBON_FLAT_YEARS);
  });
});

describe("channel series · y ranges", () => {
  test("fractions are the whole axis and amounts start at zero", () => {
    expect(yRangeFor("sky", fineSeries([day(0, { cloudCover: 0.4 })], "sky", CAL))).toEqual([0, 1]);
    expect(yRangeFor("precipitation", fineSeries([day(0, {})], "precipitation", CAL))).toEqual([0, 1]);
    const [lo, hi] = yRangeFor("precipitation", fineSeries([day(0, { wet: true, precipMm: 20 })], "precipitation", CAL));
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(20);
  });

  test("wind holds a floor span so a calm year is not drawn as a gale", () => {
    expect(yRangeFor("wind", fineSeries([day(0, { windSpeedKph: 2 })], "wind", CAL))).toEqual([0, MIN_WIND_SPAN_KPH]);
    const [, hi] = yRangeFor("wind", fineSeries([day(0, { windSpeedKph: 90 })], "wind", CAL));
    expect(hi).toBeGreaterThan(90);
  });

  test("temperature pads, and never draws a flat year across the whole row", () => {
    const [lo, hi] = yRangeFor("temperature", fineSeries([day(0, { tempMean: 10, tempHigh: 10, tempLow: 10 })], "temperature", CAL));
    expect(hi - lo).toBeCloseTo(MIN_TEMP_SPAN_C, 10);
    expect((lo + hi) / 2).toBeCloseTo(10, 10);
    const wide = yRangeFor("temperature", fineSeries([day(0, { tempLow: -20, tempHigh: 30, tempMean: 5 })], "temperature", CAL));
    expect(wide[0]).toBeLessThan(-20);
    expect(wide[1]).toBeGreaterThan(30);
  });

  test("an empty series still gives an axis", () => {
    for (const channel of ["temperature", "precipitation", "wind", "sky"] as const) {
      const [lo, hi] = yRangeFor(channel, []);
      expect(hi).toBeGreaterThan(lo);
    }
  });
});

describe("channel series · the memo key", () => {
  const base = { mode: "ribbon" as const, source: "hash", a: 4, b: 7, widthPx: 900 };

  test("the same window, width and source is the same key", () => {
    expect(seriesKey(base)).toBe(seriesKey({ ...base }));
    // Float noise below the key's precision must not bust the memo.
    expect(seriesKey({ ...base, a: 4 + 1e-12 })).toBe(seriesKey(base));
  });

  test("every input that can move a pixel moves the key", () => {
    expect(seriesKey({ ...base, mode: "fine" })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, source: "other" })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, a: 4.5 })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, b: 7.5 })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, widthPx: 901 })).not.toBe(seriesKey(base));
  });

  test("a sub-pixel resize is not a repaint", () => {
    expect(seriesKey({ ...base, widthPx: 900.4 })).toBe(seriesKey(base));
  });

  test("`composed` is a mode the key can tell apart from the ribbon's", () => {
    expect(seriesKey({ ...base, mode: "composed" })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, mode: "composed" })).not.toBe(seriesKey({ ...base, mode: "flat" }));
  });
});

// ---------------------------------------------------------------------------
// The composed curve (bead wadjet-6rw.2) — SPEC §3.2 "fine zoom → composed
// curves". The channel rows draw this at every zoom but Era; the roll they
// used to draw is now the audition strip's and the day card's alone.
// ---------------------------------------------------------------------------

describe("channel series · composedAcross", () => {
  test("it samples the RESOLVED climate, so a climate-stage layer moves it", () => {
    const plain = composedAcross(zone(), "temperature", 4, 5, 12);
    const warmed = composedAcross(zone([{ id: "warm", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 5 }] }]), "temperature", 4, 5, 12);
    const a = ys(plain, "mean");
    const b = ys(warmed, "mean");
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expect(b[i]!).toBeCloseTo(v + 5, 6));
  });

  test("the mean IS `evalCurve` at the year phase each sample falls on (PLAN D2: no second sampler)", () => {
    const climate = resolvedClimate(zone());
    expect(climate).not.toBeNull();
    const series = composedAcross(zone(), "temperature", 4, 5, 8);
    ys(series, "mean").forEach((v, i) => expect(v).toBeCloseTo(evalCurve(climate!.temperature.mean, i / 8), 9));
  });

  test("x is the WINDOW's own [0,1], whatever years the window spans", () => {
    for (const [a, b] of [[4, 5], [4.25, 4.35], [900, 902]] as const) {
      const points = composedAcross(zone(), "temperature", a, b, 10).find((s) => s.role === "mean")!.points;
      expect(points[0]![0]).toBe(0);
      expect(points[points.length - 1]![0]).toBe(1);
      expect(points.length).toBe(11);
    }
  });

  test("a window inside one season wraps to the same phase a full year visits there", () => {
    const full = composedAcross(zone(), "temperature", 4, 5, 100);
    const tenth = composedAcross(zone(), "temperature", 4.5, 4.6, 10);
    expect(ys(tenth, "mean")[0]!).toBeCloseTo(ys(full, "mean")[50]!, 9);
  });

  test("temperature's band is the diurnal range around the mean", () => {
    const climate = resolvedClimate(zone())!;
    const s = composedAcross(zone(), "temperature", 4, 5, 6);
    const mean = ys(s, "mean");
    const low = ys(s, "low");
    const high = ys(s, "high");
    mean.forEach((m, i) => {
      const range = evalCurve(climate.temperature.diurnalRange, i / 6);
      expect(low[i]!).toBeCloseTo(m - range / 2, 9);
      expect(high[i]!).toBeCloseTo(m + range / 2, 9);
    });
  });

  test("wind's band is speed ± its SD, and never dips below calm", () => {
    const s = composedAcross(zone(), "wind", 4, 5, 12);
    const speed = ys(s, "speed");
    ys(s, "low").forEach((lo, i) => {
      expect(lo).toBeLessThanOrEqual(speed[i]!);
      expect(lo).toBeGreaterThanOrEqual(0);
    });
    ys(s, "high").forEach((hi, i) => expect(hi).toBeGreaterThanOrEqual(speed[i]!));
  });

  test("precipitation's headline is the wet-day FRACTION, on the 0–1 axis", () => {
    const climate = resolvedClimate(zone())!;
    const s = composedAcross(zone(), "precipitation", 4, 5, 6);
    ys(s, "amount").forEach((v, i) => {
      const phase = i / 6;
      expect(v).toBeCloseTo(wetFraction(evalCurve(climate.precipitation.pwd, phase), evalCurve(climate.precipitation.pww, phase)), 9);
    });
  });

  test("sky mixes the dry and wet cloud curves, so it always sits between them", () => {
    const climate = resolvedClimate(zone())!;
    ys(composedAcross(zone(), "sky", 4, 5, 6), "cloud").forEach((v, i) => {
      const phase = i / 6;
      const dry = evalCurve(climate.cloud.dry, phase);
      const wet = evalCurve(climate.cloud.wet, phase);
      expect(v).toBeGreaterThanOrEqual(Math.min(dry, wet) - 1e-9);
      expect(v).toBeLessThanOrEqual(Math.max(dry, wet) + 1e-9);
    });
  });

  test("a zero-width window is empty, not an infinite loop", () => {
    expect(composedAcross(zone(), "temperature", 4, 4, 12)).toEqual([]);
  });
});

describe("channel series · wetFraction", () => {
  test("always wet is wet every day; always dry is never", () => {
    expect(wetFraction(1, 1)).toBeCloseTo(1, 9);
    expect(wetFraction(0, 0)).toBe(0);
  });

  test("it is the two-state chain's stationary probability", () => {
    // pwd .3, pww .7 → .3 / (1 + .3 − .7) = .5
    expect(wetFraction(0.3, 0.7)).toBeCloseTo(0.5, 9);
  });

  test("it never leaves [0,1], whatever the inputs", () => {
    for (const [d, w] of [[0.9, 0.1], [0.01, 0.99], [0, 1], [1, 0]] as const) {
      const f = wetFraction(d, w);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe("channel series · the row readout and its axis", () => {
  test("statsOf reads the min, max and mean of one role", () => {
    expect(statsOf([{ role: "mean", points: [[0, 2], [0.5, 6], [1, 4]] }], "mean")).toEqual({ min: 2, max: 6, mean: 4 });
  });

  test("statsOf answers null for a role that is not drawn", () => {
    expect(statsOf([{ role: "mean", points: [[0, 1]] }], "speed")).toBeNull();
    expect(statsOf([{ role: "mean", points: [] }], "mean")).toBeNull();
  });

  test("every channel names the role its readout speaks for", () => {
    expect(HEADLINE_ROLE.temperature).toBe("mean");
    expect(HEADLINE_ROLE.precipitation).toBe("amount");
    expect(HEADLINE_ROLE.wind).toBe("speed");
    expect(HEADLINE_ROLE.sky).toBe("cloud");
  });

  test("temperature's axis steps 2 / 5 / 10 °C by how much range there is", () => {
    expect(axisTicks("temperature", 0, 8)).toEqual([0, 2, 4, 6, 8]);
    expect(axisTicks("temperature", 0, 20)).toEqual([0, 5, 10, 15, 20]);
    expect(axisTicks("temperature", 0, 40)).toEqual([0, 10, 20, 30, 40]);
  });

  test("wind's speed ladder is the prototype's 5 / 10 / 15 / 20, never the zero", () => {
    // `proto-markup/1397-logic-class-Component.js` `weGridEls`: [5, 10, 15, 20]
    // over the wind editor's 0–24 km/h speed axis.
    expect(axisTicks("wind", 0, 24)).toEqual([5, 10, 15, 20]);
    // The plot's own padded domain overshoots the data on both sides; the
    // ladder is the same four rungs and still skips the floor.
    expect(axisTicks("wind", -1.2, 25.9)).toEqual([5, 10, 15, 20]);
  });

  test("every axis value lands inside the range it was asked for", () => {
    for (const channel of ["temperature", "precipitation", "wind"] as const) {
      for (const v of axisTicks(channel, -3.5, 17.5)) {
        expect(v).toBeGreaterThanOrEqual(-3.5);
        expect(v).toBeLessThanOrEqual(17.5);
      }
    }
  });

  test("an empty or inverted range has no axis at all", () => {
    expect(axisTicks("temperature", 5, 5)).toEqual([]);
    expect(axisTicks("wind", 10, 2)).toEqual([]);
  });

  test("only temperature prints every value; the others label their middle tick", () => {
    expect(axisLabelled("temperature", [0, 5, 10])).toEqual([0, 5, 10]);
    expect(axisLabelled("wind", [5, 10, 15, 20])).toEqual([10]);
    expect(axisLabelled("precipitation", [0.25, 0.5, 0.75])).toEqual([0.5]);
    expect(axisLabelled("sky", [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The era layer (bead wadjet-6rw.3) — eras are steps on the absolute timeline,
// so a plotted year INSIDE one carries its ops. `core/eras.ts` decides which
// ops are live, `core/ops.ts` decides what they mean; nothing here restates
// either.
// ---------------------------------------------------------------------------

describe("channel series · the era step", () => {
  const ICE: Era[] = [
    {
      name: "Ice Age",
      from: 1200,
      to: 1900,
      apply: [
        { param: "temperature.mean", op: "offset", value: -8 },
        { param: "precipitation.pwd", op: "scale", value: 0.7 },
      ],
    },
  ];

  test("eraOpsAt is the live ops of every era covering the year, and nothing else", () => {
    expect(eraOpsAt(ICE, 1600)).toEqual(ICE[0]!.apply!);
    expect(eraOpsAt(ICE, 1199)).toEqual([]);
    expect(eraOpsAt(ICE, 1901)).toEqual([]);
    // Inclusive at both ends, as `eraActive` has it.
    expect(eraOpsAt(ICE, 1200).length).toBe(2);
    expect(eraOpsAt(ICE, 1900).length).toBe(2);
    expect(eraOpsAt([{ ...ICE[0]!, enabled: false }], 1600)).toEqual([]);
    expect(eraOpsAt([{ ...ICE[0]!, apply: [{ param: "temperature.mean", op: "offset", value: -8, enabled: false }] }], 1600)).toEqual([]);
  });

  test("composedAcross inside the Ice Age is the plain curve minus 8 °C", () => {
    const plain = ys(composedAcross(zone(), "temperature", 1600, 1601, 12), "mean");
    const iced = ys(composedAcross(zone(), "temperature", 1600, 1601, 12, ICE), "mean");
    expect(iced.length).toBe(plain.length);
    plain.forEach((v, i) => expect(iced[i]!).toBeCloseTo(v - 8, 6));
  });

  test("a year outside the era is untouched, so the era really is a step", () => {
    const plain = ys(composedAcross(zone(), "temperature", 2000, 2001, 12), "mean");
    const withEra = ys(composedAcross(zone(), "temperature", 2000, 2001, 12, ICE), "mean");
    expect(withEra).toEqual(plain);
  });

  test("the band steps with the mean — low and high take the offset too", () => {
    const plain = composedAcross(zone(), "temperature", 1600, 1601, 6);
    const iced = composedAcross(zone(), "temperature", 1600, 1601, 6, ICE);
    for (const role of ["low", "high"] as const) {
      ys(plain, role).forEach((v, i) => expect(ys(iced, role)[i]!).toBeCloseTo(v - 8, 6));
    }
  });

  test("steppedAcross holds one flat level per era segment, and steps at the era's edges", () => {
    const mean = steppedAcross(zone(), "temperature", 1100, 2100, ICE).find((x) => x.role === "mean")!;
    // Three segments — before the era, inside it, after it — two points each.
    expect(mean.points.length).toBe(6);
    const xs = mean.points.map((p) => p[0]);
    expect(xs[0]!).toBeCloseTo(0, 9);
    expect(xs[1]!).toBeCloseTo((1200 - 1100) / 1000, 9);
    expect(xs[3]!).toBeCloseTo((1901 - 1100) / 1000, 9);
    expect(xs[5]!).toBeCloseTo(1, 9);
    const levels = mean.points.map((p) => p[1]);
    expect(levels[2]!).toBeCloseTo(levels[0]! - 8, 6);
    expect(levels[4]!).toBeCloseTo(levels[0]!, 9);
  });

  test("with no eras steppedAcross is one flat level at the yearly mean", () => {
    const mean = steppedAcross(zone(), "temperature", 1100, 2100).find((x) => x.role === "mean")!;
    expect(mean.points.length).toBe(2);
    expect(mean.points[0]![1]).toBeCloseTo(mean.points[1]![1], 12);
    // The same yearly mean `flatMean` reads off the ribbon, to within the
    // hundredth of a degree the two samplers differ by at 12 samples.
    expect(mean.points[0]![1]).toBeCloseTo(flatMean(ribbonSeries(zone(), "temperature"))[0]!.points[0]![1], 1);
  });

  test("a scale op lands on precipitation's wet fraction, not on temperature", () => {
    const plain = ys(composedAcross(zone(), "precipitation", 1600, 1601, 6), "amount");
    const iced = ys(composedAcross(zone(), "precipitation", 1600, 1601, 6, ICE), "amount");
    plain.forEach((v, i) => expect(iced[i]!).toBeLessThan(v));
  });

  test("an inverted or empty window still answers with nothing", () => {
    expect(steppedAcross(zone(), "temperature", 5, 5, ICE)).toEqual([]);
    expect(steppedAcross(zone(), "temperature", 6, 5, ICE)).toEqual([]);
  });
});
