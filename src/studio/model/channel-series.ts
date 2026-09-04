/**
 * The four channel rows' plotted series (SPEC §3.2, §9; PLAN D2/D3/§7).
 *
 * Two shapes, one per zoom morph:
 *
 *  - **the ribbon** (`ribbonSeries`) — the yearly shape of the *resolved*
 *    climate: `resolveProfile(zone).climate`, so every climate-stage layer the
 *    mixer wrote is already in it, sampled at `RIBBON_SAMPLES` points with
 *    `core/curve.ts`'s own `sampleCurve`. Nothing here re-implements a curve
 *    (PLAN D2); the values ARE `sampleCurve`'s, which is what the unit gate
 *    asserts. `ribbonAcross` repeats that one year across every year the
 *    window touches, and `flatMean` collapses it to a single line once the
 *    window is too wide for a repeat to read as anything but noise.
 *  - **the fine curve** (`fineSeries`) — the real roll: one point per rolled
 *    day off `rollYear`, never an average of days (SPEC law 4). x is a
 *    fractional year, the same axis `spans.ts` puts a lane on.
 *  - **the composed curve** (`composedAcross`, and `steppedAcross` for a
 *    window too wide to draw a year into) — what the channel ROWS actually
 *    draw. Same resolved climate, read at the year phase each sample falls
 *    on, with the world's eras folded in per sample: an era is a step on the
 *    absolute timeline, so a year inside the Ice Age plots eight degrees
 *    colder, exactly as a rolled day inside it does. The op semantics are
 *    `core/ops.ts`'s `applyDayOps` and the choice of live ops is
 *    `core/eras.ts`'s `eraOpsAt`; neither is restated here.
 *
 * All of them come back as `ChannelSeries[]` in *plot* units — what the row's y axis
 * is in — and `yRangeFor` gives that axis its extent. The one projection this
 * module makes is precipitation's ribbon `scale` (mm) onto the 0–1
 * probability axis `pwd`/`pww` live on: a 48 px row has one y axis, and
 * `PRECIP_SCALE_MAX_MM` is the mm that reaches its top. `mmToUnit`/`unitToMm`
 * are exported so nothing has to guess the factor back.
 *
 * Pure: no DOM, no Obsidian (PLAN D3). Memo keys are `seriesKey`'s job — the
 * row never rebuilds an SVG for a window it has already drawn (PLAN §7).
 */
import { sampleCurve } from "../../core/curve";
import { eraOpsAt } from "../../core/eras";
import { evaluateDayParams } from "../../core/generator";
import { applyDayOps, type DayParams } from "../../core/ops";
import { profileHash, resolveProfile } from "../../core/profile";
import type { ClimateParams, Curve, Era, ZoneProfile } from "../../core/types";
import type { AuditionDay } from "./audition";
import type { Channel } from "./compile";
import { fractionalYear, type SpanCalendar } from "./spans";

/** Samples per year in a ribbon. `sampleCurve`'s own default, and SPEC §3.2's "12-sample". */
export const RIBBON_SAMPLES = 12;

/**
 * Wider than this many years and the repeated ribbon is a comb of 13 points
 * per year that reads as noise (and costs 14 000 points at Era zoom), so the
 * row draws `flatMean` instead — SPEC §3.2's "wide → yearly ribbon" has a
 * floor.
 */
export const RIBBON_FLAT_YEARS = 60;

/** Beyond this many years the fine curve would be a roll per year; the row falls back to the ribbon. */
export const FINE_MAX_YEARS = 6;

/** The mm/day that reaches the top of precipitation's 0–1 ribbon axis. */
export const PRECIP_SCALE_MAX_MM = 20;

/** Smallest y span a temperature row is ever drawn with, in °C. */
export const MIN_TEMP_SPAN_C = 8;
/** Smallest y span a wind row is ever drawn with, in km/h. */
export const MIN_WIND_SPAN_KPH = 20;

/** What one plotted line is: the channel parameter it stands for. */
export type SeriesRole = "mean" | "high" | "low" | "pwd" | "pww" | "amount" | "speed" | "cloudDry" | "cloudWet" | "cloud";

export interface ChannelSeries {
  role: SeriesRole;
  /** `[x, y]`. Ribbon x is a yearPhase in [0,1]; fine x is a fractional year; after `ribbonAcross`/`windowPoints`, x is [0,1] across the window. */
  points: Array<[number, number]>;
}

/** The two calendar facts an x axis in fractional years needs (`spans.ts`'s `SpanCalendar`, narrowed). */
export type YearGrid = Pick<SpanCalendar, "yearLength" | "epochYear">;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Precipitation's ribbon `scale` in mm, projected onto the 0–1 axis its probabilities live on. */
export function mmToUnit(mm: number): number {
  return clamp01(mm / PRECIP_SCALE_MAX_MM);
}

/** The inverse of `mmToUnit`, for a readout that has only the plotted value. */
export function unitToMm(unit: number): number {
  return unit * PRECIP_SCALE_MAX_MM;
}

/**
 * `sampleCurve(curve)` as a closed ring: `RIBBON_SAMPLES + 1` points at
 * `i / RIBBON_SAMPLES`, the last repeating the first, so tiling the year
 * end-to-end joins without a step at the year boundary.
 */
function ring(role: SeriesRole, curve: Curve, map?: (v: number) => number): ChannelSeries {
  const samples = sampleCurve(curve, RIBBON_SAMPLES);
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const v = samples[i % RIBBON_SAMPLES] ?? 0;
    points.push([i / RIBBON_SAMPLES, map ? map(v) : v]);
  }
  return { role, points };
}

/**
 * The resolved climate, or `null` when the draft cannot resolve. A zone
 * mid-edit is expected to be transiently invalid (`resolveProfile` throws on
 * an error-level issue); a row draws nothing rather than blowing up a render.
 */
export function resolvedClimate(zone: ZoneProfile): ClimateParams | null {
  try {
    return resolveProfile(zone).climate;
  } catch {
    return null;
  }
}

/**
 * One year of the resolved climate, per channel (SPEC §3.2 "yearly ribbon"):
 * temperature → the mean; precipitation → `pwd` and `pww` on the 0–1 axis
 * plus `scale` as the amount (projected by `mmToUnit`); wind → the mean
 * speed; sky → the dry and wet cloud fractions.
 */
export function ribbonSeries(zone: ZoneProfile, channel: Channel): ChannelSeries[] {
  const climate = resolvedClimate(zone);
  if (climate === null) return [];
  switch (channel) {
    case "temperature":
      return [ring("mean", climate.temperature.mean)];
    case "precipitation":
      return [ring("amount", climate.precipitation.scale, mmToUnit), ring("pwd", climate.precipitation.pwd), ring("pww", climate.precipitation.pww)];
    case "wind":
      return [ring("speed", climate.wind.speed)];
    case "sky":
      return [ring("cloudDry", climate.cloud.dry), ring("cloudWet", climate.cloud.wet)];
  }
}

/**
 * The rolled days, per channel (SPEC §3.2 "composed curves"): temperature →
 * the low/high band and the mean line; precipitation → the wet-day marks,
 * one point per day carrying that day's mm (0 on a dry day, so the filled
 * shape is the marks themselves); wind → the day's speed; sky → the day's
 * cloud cover. Every point is a day the generator actually rolled.
 */
export function fineSeries(days: readonly AuditionDay[], channel: Channel, cal: YearGrid): ChannelSeries[] {
  const grid: SpanCalendar = { yearLength: cal.yearLength, epochYear: cal.epochYear, seasons: [], moons: [], eras: [] };
  const at = (day: AuditionDay): number => fractionalYear(day.dayOrdinal, grid);
  const of = (role: SeriesRole, y: (day: AuditionDay) => number): ChannelSeries => ({ role, points: days.map((d) => [at(d), y(d)] as [number, number]) });

  switch (channel) {
    case "temperature":
      return [of("low", (d) => d.record.tempLow), of("high", (d) => d.record.tempHigh), of("mean", (d) => d.record.tempMean)];
    case "precipitation":
      return [of("amount", (d) => (d.record.wet ? d.record.precipMm : 0))];
    case "wind":
      return [of("speed", (d) => d.record.windSpeedKph)];
    case "sky":
      return [of("cloud", (d) => d.record.cloudCover)];
  }
}

function extent(series: readonly ChannelSeries[]): { lo: number; hi: number; any: boolean } {
  let lo = Infinity;
  let hi = -Infinity;
  let any = false;
  // A loop, not `Math.max(...ys)`: a six-year fine curve is ~2 200 points per
  // series and spreading that many arguments is a stack risk.
  for (const s of series) {
    for (const [, y] of s.points) {
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      any = true;
    }
  }
  return { lo, hi, any };
}

/**
 * The row's y axis: a sane fixed range per channel with padding, never a
 * range so tight that a flat year looks like a mountain. Fractions are
 * always the whole 0–1; the open-ended channels pad and hold a floor span.
 */
export function yRangeFor(channel: Channel, series: readonly ChannelSeries[]): [number, number] {
  const { lo, hi, any } = extent(series);
  switch (channel) {
    case "sky":
      return [0, 1];
    case "precipitation":
      return [0, any ? Math.max(1, hi * 1.1) : 1];
    case "wind":
      return [0, any ? Math.max(MIN_WIND_SPAN_KPH, hi * 1.15) : MIN_WIND_SPAN_KPH];
    case "temperature": {
      if (!any) return [-MIN_TEMP_SPAN_C / 2, MIN_TEMP_SPAN_C / 2];
      const pad = Math.max(1, (hi - lo) * 0.08);
      let a = lo - pad;
      let b = hi + pad;
      if (b - a < MIN_TEMP_SPAN_C) {
        const mid = (a + b) / 2;
        a = mid - MIN_TEMP_SPAN_C / 2;
        b = mid + MIN_TEMP_SPAN_C / 2;
      }
      return [a, b];
    }
  }
}

/**
 * Points clipped to `[a, b]` and rescaled so the window itself is x ∈ [0,1] —
 * the Chart's `"year"` domain. One point either side of the window is kept so
 * the line runs to the edge instead of stopping short of it; a point sitting
 * exactly ON an edge already reaches it, so it takes no bridge and the result
 * never carries two points at the same x.
 */
export function windowPoints(points: ReadonlyArray<readonly [number, number]>, a: number, b: number): Array<[number, number]> {
  const span = b - a;
  if (span <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const inside = p[0] >= a && p[0] <= b;
    const bridgesIn = p[0] < a && (points[i + 1]?.[0] ?? -Infinity) > a;
    const bridgesOut = p[0] > b && (points[i - 1]?.[0] ?? Infinity) < b;
    if (!inside && !bridgesIn && !bridgesOut) continue;
    out.push([clamp01((p[0] - a) / span), p[1]]);
  }
  return out;
}

/**
 * The one-year ribbon repeated across every year `[a, b)` touches, with x
 * rescaled to the window. `a`/`b` are fractional years, so year `y` occupies
 * `[y, y + 1)` and the ring's phase is the fraction.
 */
export function ribbonAcross(series: readonly ChannelSeries[], a: number, b: number): ChannelSeries[] {
  const first = Math.floor(a);
  const last = Math.floor(b);
  return series.map((s) => {
    const tiled: Array<[number, number]> = [];
    for (let y = first; y <= last; y++) {
      for (const [phase, value] of s.points) {
        // The ring closes at phase 1, which is the next year's phase 0: skip it
        // on every year but the last, so no year contributes a duplicate x.
        if (phase === 1 && y !== last) continue;
        tiled.push([y + phase, value]);
      }
    }
    return { role: s.role, points: windowPoints(tiled, a, b) };
  });
}

/**
 * One flat line at the ribbon's own mean, for a window too wide to repeat a
 * year into (`RIBBON_FLAT_YEARS`). The first series is the channel's headline
 * parameter, so that is the one the line stands for.
 */
export function flatMean(series: readonly ChannelSeries[]): ChannelSeries[] {
  const head = series[0];
  if (head === undefined || head.points.length === 0) return [];
  // The ring repeats its first sample at phase 1; drop that duplicate so the
  // mean is the mean of the twelve samples, not of eleven plus one counted twice.
  const closed = head.points.length > 1 && head.points[0]![0] === 0 && head.points[head.points.length - 1]![0] === 1;
  const points = closed ? head.points.slice(0, -1) : head.points;
  const mean = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return [
    {
      role: head.role,
      points: [
        [0, mean],
        [1, mean],
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// The composed curve (SPEC §3.2 "fine zoom → composed curves")
// ---------------------------------------------------------------------------

/**
 * Samples a composed curve is drawn with across the whole window. The shape
 * is the resolved climate's, so the cost is `evalCurve` per sample per role —
 * a few hundred evaluations, not a roll.
 */
export const COMPOSED_SAMPLES = 240;

/** The wet-day fraction a two-state chain settles at: `pwd / (1 + pwd − pww)`. */
export function wetFraction(pwd: number, pww: number): number {
  const denom = 1 + pwd - pww;
  return denom <= 0 ? clamp01(pww) : clamp01(pwd / denom);
}

/**
 * One plotted role and how to read it off ONE day's evaluated parameters.
 *
 * Readers take `DayParams` rather than a curve and a phase so the era layer
 * can sit between the two: `evaluateDayParams` gives the climate at a phase,
 * `applyDayOps` folds the active eras' ops into it (the engine's own op
 * semantics, `core/ops.ts`), and the reader reads whatever came out. A step
 * through the Ice Age is therefore the same −8 °C a rolled day inside it gets.
 */
type Reader = { role: SeriesRole; at: (p: DayParams) => number };

function readersFor(channel: Channel): Reader[] {
  switch (channel) {
    case "temperature":
      // SPEC §3.2's spread band: the day's low and high around the mean, which
      // is what `diurnalRange` (Tmax − Tmin) is defined as.
      return [
        { role: "low", at: (p) => p["temperature.mean"] - p["temperature.diurnalRange"] / 2 },
        { role: "high", at: (p) => p["temperature.mean"] + p["temperature.diurnalRange"] / 2 },
        { role: "mean", at: (p) => p["temperature.mean"] },
      ];
    case "precipitation":
      // The headline is the wet-day fraction, not a probability: it is the one
      // number the row's readout says out loud (`wet 61 % of days`).
      return [
        { role: "amount", at: (p) => wetFraction(p["precipitation.pwd"], p["precipitation.pww"]) },
        { role: "pww", at: (p) => p["precipitation.pww"] },
      ];
    case "wind":
      return [
        { role: "low", at: (p) => Math.max(0, p["wind.speed"] - p["wind.speedSd"]) },
        { role: "high", at: (p) => p["wind.speed"] + p["wind.speedSd"] },
        { role: "speed", at: (p) => p["wind.speed"] },
      ];
    case "sky":
      // Cloud is the wet/dry pair mixed by how often it is actually wet — the
      // single "what the sky looks like" number the Sky strip shades with.
      return [
        {
          role: "cloud",
          at: (p) => {
            const f = wetFraction(p["precipitation.pwd"], p["precipitation.pww"]);
            return p["cloud.dry"] * (1 - f) + p["cloud.wet"] * f;
          },
        },
      ];
  }
}

/**
 * The climate at year phase `phase` of calendar year `year`, with every era
 * covering that year applied. `eras` empty is the plain resolved climate, so
 * the era layer costs nothing in a world that has none.
 */
function paramsAt(climate: ClimateParams, phase: number, year: number, eras: readonly Era[]): DayParams {
  const base = evaluateDayParams(climate, phase);
  if (eras.length === 0) return base;
  const ops = eraOpsAt(eras, year);
  return ops.length === 0 ? base : applyDayOps(base, ops);
}

/** `t`'s position within its calendar year, in [0,1). */
function yearPhase(t: number): number {
  const p = t - Math.floor(t);
  return p < 0 ? p + 1 : p;
}

/**
 * The composed climate sampled evenly across `[a, b]`, x already rescaled to
 * the window's own [0,1] — the Chart's `"year"` domain.
 *
 * This is the shape SPEC §3.2 calls a composed curve: the *resolved* climate
 * (every climate-stage layer the mixer wrote is already in it) read at the
 * year phase each sample falls on, so a window that spans a year boundary
 * simply wraps and a window a month wide is drawn at the same resolution as
 * one a year wide. Nothing here rolls a day.
 */
export function composedAcross(zone: ZoneProfile, channel: Channel, a: number, b: number, samples: number = COMPOSED_SAMPLES, eras: readonly Era[] = []): ChannelSeries[] {
  const climate = resolvedClimate(zone);
  if (climate === null || b <= a) return [];
  const n = Math.max(2, Math.floor(samples));
  const readers = readersFor(channel);
  const at: DayParams[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a + (b - a) * (i / n);
    at.push(paramsAt(climate, yearPhase(t), Math.floor(t), eras));
  }
  return readers.map((r) => ({ role: r.role, points: at.map((p, i) => [i / n, r.at(p)] as [number, number]) }));
}

/**
 * The composed climate for a window too wide to draw a year into
 * (`RIBBON_FLAT_YEARS`): one flat level per era segment, so the curve is the
 * prototype's Era-zoom STEP rather than a single mean line that hides the
 * −8 °C an Ice Age is.
 *
 * A segment is a run of years over which the active era set does not change,
 * clipped to `[a, b]`; its level is the year's twelve `RIBBON_SAMPLES` phases
 * averaged, which is what the yearly shape collapses to once a year is a few
 * pixels wide. Two points per segment, so the joins draw as vertical steps.
 * x comes back rescaled to the window's own [0,1], like `composedAcross`.
 */
export function steppedAcross(zone: ZoneProfile, channel: Channel, a: number, b: number, eras: readonly Era[] = []): ChannelSeries[] {
  const climate = resolvedClimate(zone);
  if (climate === null || b <= a) return [];
  const readers = readersFor(channel);

  // Era edges inside the window: a span starts at `from` and ends after `to`.
  const cuts = new Set<number>([a, b]);
  for (const e of eras) {
    if (e.enabled === false) continue;
    for (const y of [e.from, e.to === undefined ? null : e.to + 1]) {
      if (y !== null && y > a && y < b) cuts.add(y);
    }
  }
  const edges = [...cuts].sort((x, y) => x - y);

  const out = readers.map((r) => ({ role: r.role, points: [] as Array<[number, number]> }));
  const span = b - a;
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    // The era set is constant across the segment, so any year inside it reads
    // the same; the segment's own start is the cheapest one to ask about.
    const year = Math.floor(from);
    const sums = readers.map(() => 0);
    for (let k = 0; k < RIBBON_SAMPLES; k++) {
      const p = paramsAt(climate, k / RIBBON_SAMPLES, year, eras);
      readers.forEach((r, ri) => {
        sums[ri]! += r.at(p);
      });
    }
    readers.forEach((_, ri) => {
      const level = sums[ri]! / RIBBON_SAMPLES;
      out[ri]!.points.push([(from - a) / span, level], [(to - a) / span, level]);
    });
  }
  return out;
}

/** min / max / mean of one role's plotted values, or `null` when it is not drawn. */
export function statsOf(series: readonly ChannelSeries[], role: SeriesRole): { min: number; max: number; mean: number } | null {
  const s = series.find((x) => x.role === role);
  if (s === undefined || s.points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const [, y] of s.points) {
    if (y < min) min = y;
    if (y > max) max = y;
    sum += y;
  }
  return { min, max, mean: sum / s.points.length };
}

/** The role whose numbers a channel's row readout speaks for. */
export const HEADLINE_ROLE: Record<Channel, SeriesRole> = {
  temperature: "mean",
  precipitation: "amount",
  wind: "speed",
  sky: "cloud",
};

/**
 * The values a channel's y axis is labelled at, inside `[lo, hi]`.
 * Temperature steps 2 / 5 / 10 °C by how much range there is (the
 * prototype's own ladder); precipitation always marks the half; wind marks
 * every 5 km/h. Fractions never exceed the axis, so a flat row still gets a
 * line to read against.
 */
export function axisTicks(channel: Channel, lo: number, hi: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [];
  const every = (step: number, cap: number): number[] => {
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 && out.length < cap; v += step) out.push(Math.round(v / step) * step);
    return out;
  };
  switch (channel) {
    case "temperature":
      return every(span > 24 ? 10 : span > 12 ? 5 : 2, 5);
    case "precipitation":
      return [0.25, 0.5, 0.75].filter((v) => v > lo && v < hi);
    case "wind":
      // The prototype's speed ladder is 5 / 10 / 15 / 20 km/h — four rungs on
      // its 0–24 axis (`proto-markup/1397-logic-class-Component.js`
      // `weGridEls`), and never the zero, which is the plot's own floor.
      return every(5, 5).filter((v) => v > Math.max(lo, 0) && v < hi);
    case "sky":
      return [];
  }
}

/**
 * Which of `axisTicks`' values are worth *printing*. Every tick gets a grid
 * line; only temperature gets a printed value at each, because °C is the one
 * axis a reader converts in their head. The open-ended fractions and speeds
 * label their middle tick and let the grid carry the rest — a column of four
 * numbers beside a 100 px row is noise, not information.
 */
export function axisLabelled(channel: Channel, ticks: readonly number[]): number[] {
  if (ticks.length === 0) return [];
  if (channel === "temperature") return [...ticks];
  return [ticks[Math.floor((ticks.length - 1) / 2)]!];
}

// ---------------------------------------------------------------------------
// The rolled years the fine curve reads
// ---------------------------------------------------------------------------

/** The identity of a zone's ribbon: its profile hash, which every climate-stage layer moves. */
export function ribbonSourceKey(zone: ZoneProfile): string {
  return profileHash(zone);
}

/** Windows are `epochYear + fraction`, so a raw `a`/`b` in a memo key carries float noise. */
function roundKey(x: number): string {
  return x.toFixed(6);
}

/**
 * The memo key a row holds its drawn SVG against (PLAN §7): the mode, the
 * data's own identity (the roll keys at fine zoom, the profile hash at wide
 * zoom), the window and the measured width. Nothing else can change a pixel.
 */
export function seriesKey(parts: { mode: "composed" | "fine" | "ribbon" | "flat" | "empty"; source: string; a: number; b: number; widthPx: number }): string {
  return `${parts.mode}|${parts.source}|${roundKey(parts.a)}|${roundKey(parts.b)}|${Math.round(parts.widthPx)}`;
}
