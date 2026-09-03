/**
 * The channel editor's pure half (SPEC §3.4 "Channel editors", PLAN §5.2).
 *
 * The window is a chart, a row of scope chips, a knob set that follows the
 * scope, and the Writers → channel stack. Everything in that sentence that is
 * *derivation* lives here; `src/studio/ui/windows/channel.ts` only draws it
 * (PLAN D3 — no Obsidian, no DOM in `src/studio/model`).
 *
 * Every write goes through `compile.ts`. Nothing here builds a `Modifier`
 * itself, so the id grammar, the rank sort and the swing re-derivation stay in
 * one place (PLAN §0.1 "Compiler").
 *
 * ## Scopes
 *
 * A scope is a string id, because it is also a Segmented value and a chip id:
 *
 * | id | stage | temperature's knobs |
 * |---|---|---|
 * | `all`          | climate — applied once to the curves | offset · swing · jitter |
 * | `season:<X>`   | daily, `when.tag = season:<X>`       | offset |
 * | `moon:<X>`     | daily, `when.moon = { <X>, [0,1] }`  | depth (+ the drawn envelope) |
 *
 * The knobs themselves are per channel, not per scope alone: `CHANNEL_KNOBS`
 * maps `(channel, scope) → [KnobId, KnobBinding][]`, and every binding names
 * the parameter(s) and the `compile.ts` setter it reaches (SPEC §8 "Channel
 * parity"). `CHANNEL_CHART` says the same for the drawn lines.
 *
 * SPEC §3.4 lists the ☾ scope as "offset · depth". The compiled moon layer
 * (`compile.ts` `CycleLayer`) carries exactly one scalar — the `offset` op's
 * `value` — so those two names are one control here, labelled *depth*, with
 * the second half of the pair being the drawn envelope rather than a knob.
 * `read()` reports it under both names so a caller can ask either way.
 *
 * ## What the chart draws
 *
 * `effectiveBase` (base climate + drawn curve + all-year offset + all-year
 * scale, PLAN §0.1) at 12 calendar-month centres — or, once the drawn curve
 * has its own keyframes, at *those* phases, so a keyframe added by a
 * double-click survives the next repaint. Swing is deliberately not in it:
 * swing is *derived from* the effective base, so drawing it would make the
 * curve chase its own tail as the knob turns. `swungPoints` gives the window
 * the resulting curve as a second, read-only line.
 *
 * Editing a keyframe therefore writes the drawn value back through the
 * all-year ops it was drawn through (`v → v / scale − offset`), so the curve
 * the user placed is the curve `effectiveBase` reports — an offset layer is
 * never counted twice.
 */
import { evalCurve, monthCentrePhase, wrapPhase } from "../../core/curve";
import { getPath, isCurvePath } from "../../core/curve-ops";
import { compassPoint } from "../../core/report";
import type { Curve, Era, Keyframe, ModifierOp, ZoneProfile } from "../../core/types";
import { presetOf } from "./atlas";
import { wetFraction } from "./channel-series";
import {
  channelOf,
  channelOrNull,
  effectiveBase,
  getAllYear,
  getCurveLayer,
  getCycle,
  getSeasonOffset,
  getSeasonSet,
  getSwing,
  LAYER,
  parseLayerId,
  setAllYear,
  setCurveLayer,
  setCycle,
  setSeasonOffset,
  setSeasonSet,
  setSwing,
  writersFor,
  type Channel,
  type Writer,
} from "./compile";
import type { WindowRef } from "./validation";

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** The all-year scope's id — the one scope every channel always has. */
export const ALL_SCOPE = "all";
export const SEASON_SCOPE_PREFIX = "season:";
export const MOON_SCOPE_PREFIX = "moon:";

/** The ☾ glyph the moon chips wear (SPEC §3.4 `All year · <seasons> · ☾ Sable`). */
export const MOON_GLYPH = "☾";

export type Scope = { kind: "all" } | { kind: "season"; name: string } | { kind: "cycle"; moon: string };

/** Decode a scope id. An unknown id is the all-year scope, so a stale chip can never strand the window. */
export function parseScope(scope: string): Scope {
  if (scope.startsWith(SEASON_SCOPE_PREFIX)) {
    const name = scope.slice(SEASON_SCOPE_PREFIX.length);
    return name ? { kind: "season", name } : { kind: "all" };
  }
  if (scope.startsWith(MOON_SCOPE_PREFIX)) {
    const moon = scope.slice(MOON_SCOPE_PREFIX.length);
    return moon ? { kind: "cycle", moon } : { kind: "all" };
  }
  return { kind: "all" };
}

export const seasonScope = (name: string): string => `${SEASON_SCOPE_PREFIX}${name}`;
export const moonScope = (name: string): string => `${MOON_SCOPE_PREFIX}${name}`;

export interface ScopeChip {
  id: string;
  label: string;
}

/** The world calendar the chips are built from — the shape both `CalendarDescription` and the world draft satisfy. */
export interface ScopeCalendar {
  seasons: ReadonlyArray<{ name: string }>;
  moons: ReadonlyArray<{ name: string }>;
}

/**
 * `All year · <seasons> · ☾ <moons>` (SPEC §3.4).
 *
 * The calendar's own seasons and moons lead, in calendar order. A scope the
 * *zone* already carries a layer for but the calendar no longer describes (a
 * renamed season, a deleted moon) is appended after them, so an orphaned layer
 * still has a chip to be reached and cleared from — SPEC law 2: nothing the
 * file contains may be unreachable.
 */
export function scopeChips(z: ZoneProfile, calendar: ScopeCalendar): ScopeChip[] {
  const chips: ScopeChip[] = [{ id: ALL_SCOPE, label: "All year" }];
  const seen = new Set<string>([ALL_SCOPE]);

  const push = (id: string, label: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    chips.push({ id, label });
  };

  for (const s of calendar.seasons) if (s.name) push(seasonScope(s.name), s.name);
  for (const m of calendar.moons) if (m.name) push(moonScope(m.name), `${MOON_GLYPH} ${m.name}`);

  for (const m of z.modifiers) {
    const p = parseLayerId(m.id);
    if (!p?.scope) continue;
    if (p.kind === "season" || p.kind === "seasonSet") push(seasonScope(p.scope), p.scope);
    else if (p.kind === "moon") push(moonScope(p.scope), `${MOON_GLYPH} ${p.scope}`);
  }

  return chips;
}

/**
 * The stage line under the knob set (SPEC §3.4 "Caption states the stage").
 *
 * It names the modifier id the scope writes, not just the stage, because that
 * id is the one thing on the panel that maps a chip back onto the file — the
 * prototype's `writes modifiers[layer:temperature.mean] · stage climate · …`.
 * `param` is the drawn series, so a paired channel's caption follows the
 * picker; `periodDays` is the moon's real cycle length, omitted when the
 * calendar does not describe one.
 */
export function stageCaption(param: string, scope: string, periodDays?: number): string {
  const s = parseScope(scope);
  if (s.kind === "season") return `writes modifiers[${LAYER}${param}:season:${s.name}] · when.tag season:${s.name}`;
  if (s.kind === "cycle") {
    const repeats = periodDays !== undefined && Number.isFinite(periodDays) ? ` · repeats every ${round1(periodDays)} d` : "";
    return `writes modifiers[${LAYER}${param}:moon:${s.moon}] · when.moon ${s.moon} · the drawn curve is its envelope${repeats}`;
  }
  return `writes modifiers[${LAYER}${param}] · stage climate · unconditional, reshapes the baseline once`;
}

/** One decimal, trailing zero dropped — `29.53` stays, `30.0` prints as `30`. */
function round1(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

/**
 * Every knob any channel offers (SPEC §8 "Channel parity", PLAN §5.2).
 *
 * An id names a *role*, not a parameter. Two channels may share one — `depth`
 * is the ☾ knob everywhere — and one channel may show the same id in two
 * scopes with two different writes: temperature's `offset` is an all-year
 * climate-stage layer at the top of the chain and a `when.tag` layer inside a
 * season. Where the *range* differs between scopes the id differs too, because
 * `windows/channel.ts` holds one `KnobSpec` per id: precipitation's all-year
 * `chance` is a ×scale on `pwd`, and its season knob is the additive
 * `wetShift`, so the two cannot share a spec.
 */
export type KnobId = "offset" | "swing" | "jitter" | "depth" | "stick" | "chance" | "amount" | "wetShift" | "wind" | "gust" | "calm" | "direction" | "cloud" | "humidity";

/** Every id, in the order `read` fills its record. Not a draw order — that is the per-scope list's. */
const KNOB_IDS: readonly KnobId[] = ["offset", "swing", "jitter", "depth", "stick", "chance", "amount", "wetShift", "wind", "gust", "calm", "direction", "cloud", "humidity"];

/**
 * How one knob reaches `compile.ts`. `params` is a list because SKY's pair
 * knobs write the dry *and* wet halves of one section as two layers with the
 * same value (SPEC §3.4 "knobs offset per pair"); the first is the one `read`
 * reports back.
 */
type KnobBinding =
  | { write: "allYear"; params: readonly string[]; op: "offset" | "scale" }
  | { write: "swing"; param: string }
  | { write: "jitter"; param: string }
  | { write: "season"; params: readonly string[] }
  | { write: "seasonSet"; param: string }
  | { write: "cycle" };

/** One scope's knobs, in the order they are drawn. */
type ScopeKnobs = ReadonlyArray<readonly [KnobId, KnobBinding]>;

interface ChannelKnobTable {
  all: ScopeKnobs;
  season: ScopeKnobs;
  cycle: ScopeKnobs;
}

const TEMP_MEAN = "temperature.mean";
const WIND_SPEED = "wind.speed";
const WIND_DIRECTION = "wind.direction";
const PRECIP_PWD = "precipitation.pwd";

/**
 * The per-channel knob table (PLAN §5.2's last bullet, spelled out).
 *
 * | channel | all year | season | ☾ |
 * |---|---|---|---|
 * | temperature | offset · swing · jitter | offset | depth |
 * | precipitation | stick (×`pww`) · chance (×`pwd`) · amount (×`scale`) | chance (± `pwd`) | depth (± `pwd`) |
 * | wind | wind (± `speed`) · gust (×`speedSd`) · calm (± `calmFraction`) | wind · direction | depth (± `speed`) |
 * | sky | cloud (± `cloud.dry`+`cloud.wet`) · humidity (± `humidity.*`) | the same two | depth (± `cloud.dry`) |
 *
 * **Deviation, stated.** PLAN §5.2 asks for precipitation's season scope to be
 * the same ×scale ops the all-year scope writes. The id grammar has no
 * season-scoped `scale` — `layer:<param>:season:<X>` is an `offset` and
 * `…:season:<X>:set` is a whole value (`compile.ts`) — and compile.ts is not
 * this bead's to extend. The season knob is therefore an additive shift of the
 * wet-day probability on `pwd`, ±0.3, which is the same control in a different
 * unit; the caption and the hint say so.
 */
const CHANNEL_KNOBS: Record<Channel, ChannelKnobTable> = {
  temperature: {
    all: [
      ["offset", { write: "allYear", params: [TEMP_MEAN], op: "offset" }],
      ["swing", { write: "swing", param: TEMP_MEAN }],
      ["jitter", { write: "jitter", param: TEMP_MEAN }],
    ],
    season: [["offset", { write: "season", params: [TEMP_MEAN] }]],
    cycle: [["depth", { write: "cycle" }]],
  },
  precipitation: {
    all: [
      ["stick", { write: "allYear", params: ["precipitation.pww"], op: "scale" }],
      ["chance", { write: "allYear", params: [PRECIP_PWD], op: "scale" }],
      ["amount", { write: "allYear", params: ["precipitation.scale"], op: "scale" }],
    ],
    season: [["wetShift", { write: "season", params: [PRECIP_PWD] }]],
    cycle: [["depth", { write: "cycle" }]],
  },
  wind: {
    all: [
      ["wind", { write: "allYear", params: [WIND_SPEED], op: "offset" }],
      ["gust", { write: "allYear", params: ["wind.speedSd"], op: "scale" }],
      ["calm", { write: "allYear", params: ["wind.calmFraction"], op: "offset" }],
    ],
    season: [
      ["wind", { write: "season", params: [WIND_SPEED] }],
      ["direction", { write: "seasonSet", param: WIND_DIRECTION }],
    ],
    cycle: [["depth", { write: "cycle" }]],
  },
  sky: {
    all: [
      ["cloud", { write: "allYear", params: ["cloud.dry", "cloud.wet"], op: "offset" }],
      ["humidity", { write: "allYear", params: ["humidity.dry", "humidity.wet"], op: "offset" }],
    ],
    season: [
      ["cloud", { write: "season", params: ["cloud.dry", "cloud.wet"] }],
      ["humidity", { write: "season", params: ["humidity.dry", "humidity.wet"] }],
    ],
    cycle: [["depth", { write: "cycle" }]],
  },
};

/**
 * What a channel's chart draws. `primary` is the series the panel opens on and
 * the one the ☾ envelope and depth ride; `plots` is the stack of plots the
 * panel draws, each carrying the series that share one y axis.
 *
 * A plot is the unit here, not a series, because a pair belongs *together* on
 * one axis: PRECIP's `pww`/`pwd` are the Markov pair and are only readable
 * against each other, SKY's `dry`/`wet` halves are the point of the window.
 * Both lines of a pair are always drawn; the panel picks which one carries the
 * handles, because the `automation` chart kind makes only its *first* series
 * draggable (`components/chart.ts`). A parameter on its own axis — the wet-day
 * amount in mm, the calm-day fraction — is its own plot rather than a line
 * squeezed onto someone else's scale.
 */
interface ChannelChart {
  primary: string;
  plots: ReadonlyArray<readonly string[]>;
}

/**
 * The wet-day share — `wetFraction(pwd, pww)`, the fraction of days the Markov
 * pair settles at. A *derived* series: no `precipitation.*` curve carries it,
 * so it is drawn and never edited, and `plotPoints` computes it rather than
 * reading it off a curve.
 */
export const PRECIP_WET_SHARE = "precipitation.wetFraction";

/** Series the chart computes rather than reads off a curve — drawn, never edited. */
export function isDerivedSeries(param: string): boolean {
  return param === PRECIP_WET_SHARE;
}

const CHANNEL_CHART: Record<Channel, ChannelChart> = {
  temperature: { primary: TEMP_MEAN, plots: [[TEMP_MEAN]] },
  // `proto-markup/0345-precip-editor.html`: the share of wet days on top — the
  // one number the channel is read for — then the pair it is derived from, then
  // the millimetres, which are on neither probability axis.
  precipitation: { primary: PRECIP_PWD, plots: [[PRECIP_WET_SHARE], ["precipitation.pww", PRECIP_PWD], ["precipitation.scale"]] },
  wind: { primary: WIND_SPEED, plots: [[WIND_SPEED], ["wind.calmFraction"]] },
  sky: {
    primary: "cloud.dry",
    plots: [
      ["cloud.dry", "cloud.wet"],
      ["humidity.dry", "humidity.wet"],
    ],
  },
};

/** The series the panel opens on — and, in a ☾ scope, the parameter the envelope and its depth are written on. */
export function primarySeries(channel: Channel): string {
  return CHANNEL_CHART[channel].primary;
}

/** The stack of plots the panel draws, each a list of series sharing one y axis. */
export function chartPlots(channel: Channel): string[][] {
  return CHANNEL_CHART[channel].plots.map((p) => [...p]);
}

/** Every series the channel draws, plot by plot, in draw order. */
export function chartSeries(channel: Channel): string[] {
  return CHANNEL_CHART[channel].plots.flatMap((p) => [...p]);
}

/**
 * The points a drawn line is made of: a curve's own (`curvePoints`), or — for a
 * derived series — the value computed from the curves it is a function of.
 *
 * The wet-day share is `wetFraction(pwd, pww)` read at the *pwd* keyframes, so
 * the two curves are sampled at one set of phases even when only one of them
 * has been drawn on.
 */
export function plotPoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  if (param !== PRECIP_WET_SHARE) return curvePoints(z, param, scope);
  const wet = effectiveBase(z, "precipitation.pww");
  return curvePoints(z, PRECIP_PWD, scope).map(([at, pwd]) => [at, wetFraction(pwd, evalCurve(wet, at))] as [number, number]);
}

/**
 * The other series drawn on the same plot as `param` — its pair.
 * `precipitation.pww`/`pwd` are the wet-day odds, `cloud.dry`/`wet` the two
 * cloud fractions. A parameter alone on its own axis has no companion, and a
 * parameter on another plot is never one: they do not share a scale.
 */
export function companionSeries(channel: Channel, param: string): string[] {
  const plot = CHANNEL_CHART[channel].plots.find((p) => p.includes(param));
  return plot === undefined ? [] : plot.filter((p) => p !== param);
}

function scopeKnobs(channel: Channel, scope: string): ScopeKnobs {
  const table = CHANNEL_KNOBS[channel];
  const s = parseScope(scope);
  if (s.kind === "season") return table.season;
  if (s.kind === "cycle") return table.cycle;
  return table.all;
}

/** Which knobs this channel shows in this scope, in the order they are drawn (SPEC §3.4). */
export function knobsFor(channel: Channel, scope: string): KnobId[] {
  return scopeKnobs(channel, scope).map(([id]) => id);
}

/**
 * The jitter knob's parameter: the channel's day-to-day spread, `<section>.sd`
 * (PLAN §5.2 "jitter → `layer:temperature.sd` offset"). Returns `null` when the
 * channel has no `sd` *curve* — `cloud.sd` and `humidity.sd` are scalars, and
 * the other three channels have no jitter knob at all — so the write is
 * dropped rather than aimed at a path `applyClimateOps` would throw on.
 */
export function jitterParam(param: string): string | null {
  const section = param.split(".")[0] ?? "";
  const sd = `${section}.sd`;
  return isCurvePath(sd) ? sd : null;
}

/**
 * Every knob's current value, by id.
 *
 * Lenient in two directions, so a caller may read past `knobsFor`: an id this
 * scope does not offer falls back to the channel's all-year binding (which is
 * why `swing` reads the same inside a season as outside it), and an id the
 * channel has no binding for at all reads 0.
 */
export type ScopeValues = Record<KnobId, number>;

function readBinding(z: ZoneProfile, b: KnobBinding, s: Scope, channel: Channel): number {
  switch (b.write) {
    case "allYear":
      return getAllYear(z, b.params[0]!, b.op);
    case "swing":
      return getSwing(z, b.param);
    case "jitter": {
      const sd = jitterParam(b.param);
      return sd === null ? 0 : getAllYear(z, sd, "offset");
    }
    case "season":
      return s.kind === "season" ? getSeasonOffset(z, b.params[0]!, s.name) : 0;
    case "seasonSet":
      // No neutral: an unset bearing reads 0° until the knob is turned, and the
      // reset chip (not a value) is what puts the station's own back.
      return s.kind === "season" ? (getSeasonSet(z, b.param, s.name) ?? 0) : 0;
    case "cycle":
      return s.kind === "cycle" ? (getCycle(z, primarySeries(channel), s.moon)?.depth ?? 0) : 0;
  }
}

export function read(z: ZoneProfile, channel: Channel, scope: string): ScopeValues {
  const s = parseScope(scope);
  const scoped = new Map<KnobId, KnobBinding>(scopeKnobs(channel, scope));
  const allYear = new Map<KnobId, KnobBinding>(CHANNEL_KNOBS[channel].all);
  const out = {} as ScopeValues;
  for (const id of KNOB_IDS) {
    const b = scoped.get(id) ?? allYear.get(id);
    out[id] = b === undefined ? 0 : readBinding(z, b, s, channel);
  }
  // SPEC §3.4 lists the ☾ scope as "offset · depth"; the compiled layer carries
  // one scalar, so both names report it (see the module header).
  if (s.kind === "cycle") out.offset = out.depth;
  return out;
}

/** The envelope a moon layer is born with: full strength all the way round, two handles so it is draggable at once. */
const NEUTRAL_ENVELOPE: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.5, 1],
];

/**
 * Turn one knob. `knob` must be one `knobsFor(channel, scope)` offers —
 * anything else is a caller bug, not a user action, so it throws rather than
 * writing a layer the scope's caption does not describe.
 */
export function write(z: ZoneProfile, channel: Channel, scope: string, knob: KnobId, value: number): void {
  const b = new Map<KnobId, KnobBinding>(scopeKnobs(channel, scope)).get(knob);
  if (b === undefined) throw new RangeError(`the ${channel} channel's "${scope}" scope has no "${knob}" knob`);
  const s = parseScope(scope);

  switch (b.write) {
    case "allYear":
      for (const p of b.params) setAllYear(z, p, b.op, value);
      return;
    case "swing":
      setSwing(z, b.param, value);
      return;
    case "jitter": {
      const sd = jitterParam(b.param);
      if (sd !== null) setAllYear(z, sd, "offset", value);
      return;
    }
    case "season":
      if (s.kind !== "season") return;
      for (const p of b.params) setSeasonOffset(z, p, s.name, value);
      return;
    case "seasonSet":
      if (s.kind !== "season") return;
      setSeasonSet(z, b.param, s.name, value);
      return;
    case "cycle": {
      if (s.kind !== "cycle") return;
      const param = primarySeries(channel);
      const current = getCycle(z, param, s.moon);
      setCycle(z, param, { moon: s.moon, depth: value, envelope: current?.envelope.length ? current.envelope : NEUTRAL_ENVELOPE.map((p) => [p[0], p[1]] as [number, number]) });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Wind direction (the one knob with no neutral)
// ---------------------------------------------------------------------------

/** Compass sectors in the rose `components/chart.ts` draws — its own `ROSE_SECTORS`. */
export const ROSE_SECTORS = 16;

const SECTOR_DEGREES = 360 / ROSE_SECTORS;

function sectorOf(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return Math.round(d / SECTOR_DEGREES) % ROSE_SECTORS;
}

/** The season's own bearing layer, or `null` when the station's direction still stands. */
export function directionLayer(z: ZoneProfile, season: string): number | null {
  return getSeasonSet(z, WIND_DIRECTION, season);
}

/**
 * Drop the season's bearing layer — the panel's "station's own" reset. A
 * bearing has no neutral (0° is due north, a real answer), so `compile.ts`
 * removes a `:set` layer only by `null` and this is the one way to send it.
 */
export function clearDirection(z: ZoneProfile, season: string): void {
  setSeasonSet(z, WIND_DIRECTION, season, null);
}

/** The calendar shape `directionRose` needs — the seasons and where each begins. */
export interface RoseCalendar {
  seasons: ReadonlyArray<{ name: string; from: number }>;
}

/**
 * `wind.direction` as the compass rose plots it: `ROSE_SECTORS` buckets, each
 * carrying how many seasons blow from it. A season with its own `:set` layer
 * counts at that bearing; one without counts at the station's own direction,
 * sampled at the season's midpoint. A calendar with no seasons falls back to
 * the twelve month centres, so the rose is never empty.
 */
/** One wedge of the compass rose: which season it is, and the bearing it blows from. */
export interface SeasonDirection {
  name: string;
  /** the season's own list position, so the caller picks its palette entry */
  index: number;
  /** degrees from north, clockwise */
  degrees: number;
  /** the same bearing as a compass point — `E`, `ESE` */
  compass: string;
  /** true when the season carries its own `:set` bearing layer rather than the station's */
  own: boolean;
}

/**
 * The rose as the prototype draws it: one wedge per season, at the bearing
 * that season blows from. A season with its own `:set` layer sits at that
 * bearing; one without is sampled off the station's own curve at the season's
 * midpoint — the same rule `directionRose` buckets by, told per season instead
 * of per sector, because a wedge carries the season's name and colour and a
 * histogram bucket cannot.
 */
export function seasonDirections(z: ZoneProfile, calendar: RoseCalendar): SeasonDirection[] {
  const base = effectiveBase(z, WIND_DIRECTION);
  const seasons = calendar.seasons
    .map((s, index) => ({ name: s.name, index, from: wrapPhase(s.from) }))
    .filter((s) => s.name !== "" && Number.isFinite(s.from))
    .sort((a, b) => a.from - b.from);
  if (seasons.length === 0) return [];
  return seasons.map((s, i) => {
    const span = seasons.length === 1 ? 1 : wrapPhase(seasons[(i + 1) % seasons.length]!.from - s.from) || 1;
    const set = directionLayer(z, s.name);
    const raw = set ?? evalCurve(base, wrapPhase(s.from + span / 2));
    const degrees = ((raw % 360) + 360) % 360;
    return { name: s.name, index: s.index, degrees, compass: compassPoint(degrees), own: set !== null };
  });
}

export function directionRose(z: ZoneProfile, calendar: RoseCalendar): Array<[number, number]> {
  const weights = new Array<number>(ROSE_SECTORS).fill(0);
  const base = effectiveBase(z, WIND_DIRECTION);
  const seasons = calendar.seasons
    .filter((s) => s.name !== "" && Number.isFinite(s.from))
    .map((s) => ({ name: s.name, from: wrapPhase(s.from) }))
    .sort((a, b) => a.from - b.from);

  if (seasons.length === 0) {
    for (let m = 0; m < MONTHS; m++) weights[sectorOf(evalCurve(base, monthCentrePhase(m)))]! += 1;
    return weights.map((w, i) => [i, w] as [number, number]);
  }

  seasons.forEach((s, i) => {
    const span = seasons.length === 1 ? 1 : wrapPhase(seasons[(i + 1) % seasons.length]!.from - s.from) || 1;
    const set = directionLayer(z, s.name);
    weights[sectorOf(set ?? evalCurve(base, wrapPhase(s.from + span / 2)))]! += 1;
  });
  return weights.map((w, i) => [i, w] as [number, number]);
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

/** Below this a scale layer is treated as absent rather than divided by. */
const EPS = 1e-9;

/** The drawn curve keeps at least this many keyframes; right-click refuses to go below it. */
export const MIN_KEYFRAMES = 3;

/** Calendar months, the phases the drawn curve starts life on. */
const MONTHS = 12;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function sortedKeyframes(c: Curve | null): Keyframe[] | null {
  return Array.isArray(c) ? [...c].sort((a, b) => a.at - b.at) : null;
}

/**
 * What the chart plots for `scope`.
 *
 * All-year and season: `effectiveBase` at the drawn curve's own keyframe
 * phases, or at the 12 calendar-month centres when there is no drawn curve yet
 * (`monthCentrePhase`, so the points sit where the preset's own keyframes do).
 *
 * Cycle: the moon layer's envelope, `[phase, strength]` with strength in
 * [0, 1] — the same axis `windows/device.ts` draws an onset envelope on. The
 * °C the envelope is worth is `depth × strength`, and `depth` is the knob.
 */
export function curvePoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  const s = parseScope(scope);
  if (s.kind === "cycle") {
    const layer = getCycle(z, param, s.moon);
    const env = layer?.envelope ?? [];
    const points = env.length > 0 ? env : NEUTRAL_ENVELOPE;
    return points.map((p) => [wrapPhase(p[0]), clamp01(p[1])] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  const base = effectiveBase(z, param);
  const drawn = sortedKeyframes(getCurveLayer(z, param));
  const phases = drawn !== null ? drawn.map((k) => k.at) : Array.from({ length: MONTHS }, (_, m) => monthCentrePhase(m));
  return phases.map((at) => [at, evalCurve(base, at)] as [number, number]);
}

/**
 * The curve the swing knob produces from those points: `mean + (v − mean)·k`
 * around the effective base's annual mean. Equal to `curvePoints` at k = 1, so
 * the window can skip the second line when the knob is neutral.
 */
export function swungPoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  const points = curvePoints(z, param, scope);
  if (parseScope(scope).kind === "cycle") return points;
  const k = getSwing(z, param);
  const mean = points.reduce((a, p) => a + p[1], 0) / (points.length || 1);
  return points.map((p) => [p[0], mean + (p[1] - mean) * k] as [number, number]);
}

/** The station's own curve, undimmed by any layer — the dim reference line under the drawn one. */
export function stationPoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  if (parseScope(scope).kind === "cycle") return [];
  if (!isCurvePath(param)) return [];
  // `getPath` is typed non-optional, but the optional curves (sdHigh/sdLow/…) really can be absent.
  const curve: Curve | undefined = getPath(z.climate, param);
  if (curve === undefined) return [];
  return curvePoints(z, param, scope).map((p) => [p[0], evalCurve(curve, p[0])] as [number, number]);
}

/**
 * Season boundaries as chart markers, so the year domain reads as a calendar
 * rather than as [0, 1]. The cycle domain has no seasons in it.
 */
export function seasonMarkers(scope: string, calendar: { seasons: ReadonlyArray<{ name: string; from: number }> }): Array<{ x: number; label: string }> {
  if (parseScope(scope).kind === "cycle") return [];
  return calendar.seasons.filter((s) => s.name && Number.isFinite(s.from)).map((s) => ({ x: wrapPhase(s.from), label: s.name }));
}

/** One tint band behind the plot: `[from, to)` of the domain, and which list position it is. */
export interface ChannelBand {
  from: number;
  to: number;
  /** the season's / phase's own list position, so the caller picks the palette entry */
  index: number;
  name: string;
}

/**
 * The tint bands behind a channel chart — seasons on the year domain, the
 * moon's named phases on a cycle one. A band *is* the season label (SPEC §9:
 * the studio never prints a name inside a plot), which is why this returns the
 * span rather than the boundary `seasonMarkers` gives.
 *
 * Bands are returned in list order and always cover the whole domain: the last
 * one wraps back to the first, so a year whose first season does not start at
 * phase 0 still has no bare gap at its left edge.
 */
export function seasonBands(scope: string, calendar: { seasons: ReadonlyArray<{ name: string; from: number }>; moons?: ReadonlyArray<{ name: string; phases?: ReadonlyArray<{ name: string; at: number }> }> }): ChannelBand[] {
  const s = parseScope(scope);
  const spans =
    s.kind === "cycle"
      ? (calendar.moons?.find((m) => m.name === s.moon)?.phases ?? []).map((p) => ({ name: p.name, from: p.at }))
      : calendar.seasons.map((x) => ({ name: x.name, from: x.from }));
  const usable = spans.filter((x) => x.name && Number.isFinite(x.from)).map((x) => ({ name: x.name, from: wrapPhase(x.from) }));
  if (usable.length === 0) return [];
  const order = usable.map((x, index) => ({ ...x, index })).sort((a, b) => a.from - b.from);
  return order.map((x, i) => ({ from: x.from, to: i + 1 < order.length ? order[i + 1]!.from : 1 + order[0]!.from, index: x.index, name: x.name }));
}

/**
 * The half-width of the translucent ribbon drawn around `param`, at the same
 * phases the drawn curve uses — temperature's own day/night spread, wind's
 * speed deviation. `[]` when the parameter has no companion spread curve,
 * which is every fraction-valued one.
 */
const SPREAD_OF: Record<string, { param: string; halve: boolean }> = {
  "temperature.mean": { param: "temperature.diurnalRange", halve: true },
  "wind.speed": { param: "wind.speedSd", halve: false },
};

export function spreadPoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  const spread = SPREAD_OF[param];
  if (spread === undefined || parseScope(scope).kind === "cycle") return [];
  const curve: Curve | undefined = isCurvePath(spread.param) ? getPath(z.climate, spread.param) : undefined;
  if (curve === undefined) return [];
  return curvePoints(z, param, scope).map((p) => [p[0], Math.abs(evalCurve(curve, p[0])) / (spread.halve ? 2 : 1)] as [number, number]);
}

/**
 * The dashed comparison curve: the same parameter as it reads on a *wet* day.
 * Temperature is the one channel that carries the offset as a curve
 * (`temperature.wetDayOffset`), so the other three return `[]` until they
 * grow one.
 *
 * The prototype draws this ghost as `mean(t) + 0.35`, one constant. The engine
 * has no such number: `wetDayOffset` is a `Curve` (`core/types.ts`), evaluated
 * per day by `core/generator.ts` and signed — every shipped station carries
 * twelve keyframes of it, positive on wet winter days and negative on wet
 * summer ones, so a real ghost crosses the mean. Drawing a flat +0.35 would be
 * a picture of a parameter the generator never reads (SPEC law 4), so the
 * ghost stays seasonal and the note card states the span instead.
 */
const WET_DAY_OFFSET_OF: Record<string, string> = { "temperature.mean": "temperature.wetDayOffset" };

export function wetDayPoints(z: ZoneProfile, param: string, scope: string): Array<[number, number]> {
  const path = WET_DAY_OFFSET_OF[param];
  if (path === undefined || parseScope(scope).kind === "cycle") return [];
  const curve: Curve | undefined = isCurvePath(path) ? getPath(z.climate, path) : undefined;
  if (curve === undefined) return [];
  const drawn = curvePoints(z, param, scope);
  if (drawn.every((p) => Math.abs(evalCurve(curve, p[0])) < EPS)) return [];
  return drawn.map((p) => [p[0], p[1] + evalCurve(curve, p[0])] as [number, number]);
}

/**
 * Where the selected keyframe sits, in the reader's calendar rather than in
 * phase space: `day 196 · 54% of year`, or `cycle d16.3 · phase 0.55` inside a
 * ☾ scope. `at` is the point's own x; the caller formats its *value*, because
 * only the caller knows the unit (SPEC §8).
 */
export function pointWhen(scope: string, at: number, calendar: { yearLength: number; cycleDays?: number }): string {
  const s = parseScope(scope);
  if (s.kind === "cycle") {
    const days = calendar.cycleDays;
    const cycle = days !== undefined && Number.isFinite(days) ? `cycle d${(at * days).toFixed(1)} · ` : "";
    return `${cycle}phase ${at.toFixed(2)}`;
  }
  return `day ${Math.round(at * calendar.yearLength)} · ${(at * 100).toFixed(0)}% of year`;
}

/**
 * The per-channel fact card under the writers stack — the numbers that shape
 * the drawn curve but are not on it (SPEC §8 parity: every channel gets one,
 * not just temperature).
 *
 * Every field is real zone data or `null`. A channel reports only the fields
 * its own schema carries, so the panel draws a line per non-null field and
 * drops the card when they are all null — nothing here is invented to keep a
 * card the same height on four windows.
 */
export interface ChannelStat {
  /** min and max of the drawn curve, in the parameter's own unit */
  range: [number, number] | null;
  /**
   * How far a wet day shifts the value across the year, `[min, max]` — the
   * spread the dashed ghost is drawn at. Not a mean: on a real record the
   * offset is positive in winter and negative in summer, so its average is
   * near zero and would read as "no effect" while the ghost visibly moves.
   * `null` where the channel has no such curve.
   */
  wetDayOffset: [number, number] | null;
  /** `temperature.persistence` — how much of yesterday carries into today */
  persistence: number | null;
  /**
   * PRECIP — the share of days that come out wet, as the Markov pair settles:
   * `pwd / (1 + pwd − pww)` at each drawn phase, averaged over the year. The
   * one number the pair is *for*, and it is on neither line.
   */
  wetShare: number | null;
  /** PRECIP — the peak of `pww`, the prototype's `p(wet | wet) peak`. */
  wetRunPeak: number | null;
  /** PRECIP — the mean wet-day fall in mm: gamma `shape × scale`, averaged. */
  amountMm: number | null;
  /** PRECIP — °C below which the day's rain falls as snow. */
  freezingPoint: number | null;
  /** PRECIP — the gamma shape κ the amount is drawn from, averaged. */
  gammaShape: number | null;
  /** WIND — the mean share of days that come out calm. */
  calmShare: number | null;
  /** WIND — `wind.wetDayScale`, the multiplier a wet day puts on the speed. */
  wetDayScale: number | null;
  /** SKY — the dry-day mean of the drawn section over the year. */
  mean: number | null;
  /** SKY — the same section's wet-day mean, so the pair reads as a pair. */
  companionMean: number | null;
  /** SKY — `<section>.sd`, the day-to-day scatter around the drawn curve. */
  daySigma: number | null;
}

/** The mean of a parameter's effective curve over the phases the panel draws it at. */
function meanOf(z: ZoneProfile, param: string): number | null {
  if (!isCurvePath(param)) return null;
  const pts = curvePoints(z, param, ALL_SCOPE);
  if (pts.length === 0) return null;
  return pts.reduce((a, p) => a + p[1], 0) / pts.length;
}

/** Two effective curves multiplied phase by phase, then averaged — the gamma mean `κ·θ`. */
function meanProduct(z: ZoneProfile, a: string, b: string): number | null {
  const pa = curvePoints(z, a, ALL_SCOPE);
  const pb = curvePoints(z, b, ALL_SCOPE);
  if (pa.length === 0 || pa.length !== pb.length) return null;
  return pa.reduce((sum, p, i) => sum + p[1] * (pb[i]?.[1] ?? 0), 0) / pa.length;
}

/**
 * `pwd / (1 + pwd − pww)` — the stationary wet-day share of a two-state Markov
 * chain, at each drawn phase and averaged. A degenerate pair (`pww` at 1, so
 * wet weather never ends) has no stationary share; it reports the odds
 * themselves rather than dividing by nothing.
 */
function wetShareOf(z: ZoneProfile): number | null {
  const pwd = curvePoints(z, PRECIP_PWD, ALL_SCOPE);
  const pww = curvePoints(z, "precipitation.pww", ALL_SCOPE);
  if (pwd.length === 0) return null;
  const total = pwd.reduce((sum, p, i) => {
    const d = p[1];
    const denom = 1 + d - (pww[i]?.[1] ?? d);
    return sum + (Math.abs(denom) < EPS ? d : d / denom);
  }, 0);
  return clamp01(total / pwd.length);
}

/** The scalar day-to-day spread of a paired fraction section (`cloud.sd`, `humidity.sd`). */
function daySigmaOf(z: ZoneProfile, param: string): number | null {
  const section = param.split(".")[0] ?? "";
  if (section !== "cloud" && section !== "humidity") return null;
  return z.climate[section].sd;
}

export function channelStat(z: ZoneProfile, param: string, scope: string): ChannelStat {
  const drawn = curvePoints(z, param, scope);
  const ys = drawn.map((p) => p[1]);
  const wet = WET_DAY_OFFSET_OF[param];
  const wetCurve: Curve | undefined = wet !== undefined && isCurvePath(wet) ? getPath(z.climate, wet) : undefined;
  const wetVals = wetCurve === undefined ? [] : drawn.map((p) => evalCurve(wetCurve, p[0]));
  const section = param.split(".")[0] ?? "";
  const isPrecip = section === "precipitation";
  const isWind = section === "wind";
  const isSky = section === "cloud" || section === "humidity";
  const pwwPoints = isPrecip ? curvePoints(z, "precipitation.pww", ALL_SCOPE) : [];
  // Always dry then wet, whichever half the handles are on: a pair that swaps
  // its own order as the legend is clicked reads as a change in the data.
  return {
    range: ys.length === 0 ? null : [Math.min(...ys), Math.max(...ys)],
    wetDayOffset: wetVals.length === 0 ? null : [Math.min(...wetVals), Math.max(...wetVals)],
    persistence: section === "temperature" ? (z.climate.temperature.persistence ?? null) : null,
    wetShare: isPrecip ? wetShareOf(z) : null,
    wetRunPeak: pwwPoints.length === 0 ? null : Math.max(...pwwPoints.map((p) => p[1])),
    amountMm: isPrecip ? meanProduct(z, "precipitation.shape", "precipitation.scale") : null,
    freezingPoint: isPrecip ? z.climate.precipitation.freezingPoint : null,
    gammaShape: isPrecip ? meanOf(z, "precipitation.shape") : null,
    calmShare: isWind ? meanOf(z, "wind.calmFraction") : null,
    wetDayScale: isWind ? z.climate.wind.wetDayScale : null,
    mean: isSky ? meanOf(z, `${section}.dry`) : null,
    companionMean: isSky ? meanOf(z, `${section}.wet`) : null,
    daySigma: daySigmaOf(z, param),
  };
}

/**
 * Write drawn (screen-space) values back as the `layer:<param>:curve` layer.
 * `effectiveBase` reads `((curve + offset) × scale)`, so the inverse is applied
 * here — otherwise an all-year offset would be baked into the curve *and* still
 * applied on top of it.
 */
function writeDrawn(z: ZoneProfile, param: string, drawn: ReadonlyArray<readonly [number, number]>): void {
  const offset = getAllYear(z, param, "offset");
  const scale = getAllYear(z, param, "scale");
  const kfs: Keyframe[] = drawn.map(([at, value]) => ({ at: wrapPhase(at), value: (Math.abs(scale) < EPS ? value : value / scale) - offset })).sort((a, b) => a.at - b.at);
  setCurveLayer(z, param, kfs);
}

/** Move one keyframe to `value` (the drawn °C, not the stored one). Out-of-range indices are ignored. */
export function setKeyframe(z: ZoneProfile, param: string, index: number, value: number): boolean {
  const points = curvePoints(z, param, ALL_SCOPE);
  if (index < 0 || index >= points.length || !Number.isFinite(value)) return false;
  writeDrawn(
    z,
    param,
    points.map((p, i) => (i === index ? ([p[0], value] as const) : ([p[0], p[1]] as const))),
  );
  return true;
}

/** Double-click on the chart: a new keyframe at `at`. A phase already carrying one is left alone. */
export function addKeyframe(z: ZoneProfile, param: string, at: number, value: number): boolean {
  if (!Number.isFinite(at) || !Number.isFinite(value)) return false;
  const phase = wrapPhase(at);
  const points = curvePoints(z, param, ALL_SCOPE);
  if (points.some((p) => Math.abs(p[0] - phase) < EPS)) return false;
  writeDrawn(z, param, [...points, [phase, value] as const]);
  return true;
}

/** Right-click on a keyframe. Refuses below `MIN_KEYFRAMES` — a curve needs a shape to interpolate. */
export function removeKeyframe(z: ZoneProfile, param: string, index: number): boolean {
  const points = curvePoints(z, param, ALL_SCOPE);
  if (index < 0 || index >= points.length || points.length <= MIN_KEYFRAMES) return false;
  writeDrawn(
    z,
    param,
    points.filter((_, i) => i !== index),
  );
  return true;
}

/** Rewrite the ☾ layer's envelope, keeping its depth. Creates the layer when the scope has none yet. */
function writeEnvelope(z: ZoneProfile, param: string, moon: string, envelope: ReadonlyArray<readonly [number, number]>): void {
  const current = getCycle(z, param, moon);
  const points = envelope.map((p) => [wrapPhase(p[0]), clamp01(p[1])] as [number, number]).sort((a, b) => a[0] - b[0]);
  setCycle(z, param, { moon, depth: current?.depth ?? 0, envelope: points });
}

/** Drag one envelope point. Strength is clamped to [0, 1] — an envelope dims, it never amplifies (PLAN §0.1). */
export function setEnvelopePoint(z: ZoneProfile, param: string, moon: string, index: number, phase: number, strength: number): boolean {
  const points = curvePoints(z, param, moonScope(moon));
  if (index < 0 || index >= points.length || !Number.isFinite(phase) || !Number.isFinite(strength)) return false;
  writeEnvelope(
    z,
    param,
    moon,
    points.map((p, i) => (i === index ? ([phase, strength] as const) : ([p[0], p[1]] as const))),
  );
  return true;
}

export function addEnvelopePoint(z: ZoneProfile, param: string, moon: string, phase: number, strength: number): boolean {
  if (!Number.isFinite(phase) || !Number.isFinite(strength)) return false;
  writeEnvelope(z, param, moon, [...curvePoints(z, param, moonScope(moon)), [phase, strength] as const]);
  return true;
}

/** One point is a flat envelope; zero is the shape the validator rejects, so the last one stays. */
export function removeEnvelopePoint(z: ZoneProfile, param: string, moon: string, index: number): boolean {
  const points = curvePoints(z, param, moonScope(moon));
  if (index < 0 || index >= points.length || points.length <= 1) return false;
  writeEnvelope(
    z,
    param,
    moon,
    points.filter((_, i) => i !== index),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Writers → channel
// ---------------------------------------------------------------------------

/** Where a writer row's click lands: the window id `windows.open` takes, plus the scope a layer row selects on arrival. */
export interface WriterTarget {
  win: WindowRef;
  /** the id `WindowManager.open` is called with */
  id: string;
  /** for a `layer:` writer, the scope chip that row belongs to */
  scope?: string;
}

export interface WriterRow {
  kind: Writer["kind"];
  label: string;
  /** the ops this source contributes to the channel, one line */
  opsText: string;
  target: WriterTarget;
}

const ATLAS_WINDOW_ID = "atlas";
const REGIMES_WINDOW_ID = "regimes";
const FORCINGS_WINDOW_ID = "forcings";
const DEVICE_WINDOW_PREFIX = "device:";
/** `channel:` — kept here rather than imported, so this module stays free of the UI layer (PLAN D3). */
const CHANNEL_WINDOW_PREFIX = "channel:";

function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const text = Math.abs(v) >= 100 || Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  return text.replace("-", "−");
}

function curveText(c: Curve): string {
  if (typeof c === "number") return num(c);
  if (Array.isArray(c)) return `curve · ${c.length} kf`;
  return "curve · harmonic";
}

/** One op as the stack shows it: `temperature.mean offset +2` — enough to tell two writers apart at a glance. */
export function opText(o: ModifierOp): string {
  const head = `${o.param} ${o.op}`;
  if (o.op === "clamp") {
    const parts = [o.min === undefined ? null : `min ${num(o.min)}`, o.max === undefined ? null : `max ${num(o.max)}`].filter((p) => p !== null);
    return parts.length === 0 ? head : `${head} ${parts.join(" ")}`;
  }
  const value = o.op === "set" ? curveText(o.value) : num(o.value);
  const envelope = o.envelope === undefined ? "" : ` · envelope ${o.envelope.length}`;
  const off = o.enabled === false ? " · off" : "";
  return `${head} ${value}${envelope}${off}`;
}

/** The scope chip a `layer:` id belongs to, or `null` when the id is not one the editor owns. */
function scopeOfLayer(id: string): string | null {
  const p = parseLayerId(id);
  if (p === null) return null;
  if (p.kind === "season" || p.kind === "seasonSet") return p.scope ? seasonScope(p.scope) : null;
  if (p.kind === "moon") return p.scope ? moonScope(p.scope) : null;
  return ALL_SCOPE;
}

function targetFor(w: Writer, channel: Channel): WriterTarget {
  switch (w.kind) {
    case "station":
      return { win: "atlas", id: ATLAS_WINDOW_ID };
    case "layer": {
      const scope = scopeOfLayer(w.id);
      const base: WriterTarget = { win: "channel", id: `${CHANNEL_WINDOW_PREFIX}${channel}` };
      return scope === null ? base : { ...base, scope };
    }
    case "regime":
      return { win: "regimes", id: REGIMES_WINDOW_ID };
    case "device":
      return { win: "device", id: `${DEVICE_WINDOW_PREFIX}${w.id}` };
    case "forcings":
    case "automation":
      return { win: "forcings", id: FORCINGS_WINDOW_ID };
    case "era":
      // `Writer.id` for an era is already `era:<name>` — the window id the era surface registers.
      return { win: "era", id: w.id };
  }
}

/** How a curve is shaped, in the two words the station row has room for. */
function curveShape(curve: Curve | undefined): string {
  if (Array.isArray(curve)) return `${curve.length} kf`;
  if (typeof curve === "number") return "flat";
  return curve === undefined ? "no curve" : "harmonic";
}

/**
 * The BASE row's value, the prototype's `12 kf · 30 yr` / `edited`
 * (`1397-logic-class-Component.js` `tWriters`): how the station's own record
 * draws this channel, and how long a record it is. `edited` replaces both once
 * the drawn curve has left the shipped one — the row is then no longer quoting
 * the station, and saying how many keyframes the station had would be a lie
 * about what is on screen.
 */
/** `Bergen record` — the place the record was kept, as the SRC chip names it (`ui/header.ts`), not the preset's file id. */
function stationLabel(z: ZoneProfile, fallback: string): string {
  const preset = z.preset === undefined ? null : presetOf(z.preset.id);
  return `${preset?.source.place ?? preset?.source.stationName ?? fallback} record`;
}

function stationText(z: ZoneProfile, channel: Channel): string {
  const param = primarySeries(channel);
  const own = isCurvePath(param) ? getPath(z.climate, param) : undefined;
  // A dragged keyframe is stored as a `layer:` set-op, not written back over
  // `climate` (`compile.ts setCurveLayer`), so the drawn curve can have left
  // the record while the record itself is untouched — both count as edited.
  if (getCurveLayer(z, param) !== null) return "edited";
  const preset = z.preset === undefined ? null : presetOf(z.preset.id);
  if (preset === null) return curveShape(own);
  const base = isCurvePath(param) ? getPath(preset.climate, param) : undefined;
  if (JSON.stringify(own) !== JSON.stringify(base)) return "edited";
  return `${curveShape(base)} · ${preset.source.yearsOfRecord} yr`;
}

/** One forcings number, as the mixer's own chips read it: a signed offset, a `×` scale. */
function forcingsValue(o: ModifierOp): string {
  if (o.op === "scale") return `×${num(o.value)}`;
  if (o.op === "offset") return o.value >= 0 ? `+${num(o.value)}` : num(o.value);
  return opText(o);
}

/**
 * The MST row's value in the prototype's shape (`tWriters`):
 * `∿ <lane> · trim <warmth>` — the automation lane's terminal value and the
 * forcings knob's, from the zone's own numbers. Unit-free, like every other
 * row in this stack; the Forcings panel the row opens carries the units.
 */
function forcingsText(lane: readonly ModifierOp[], w: Writer): string {
  // `wetness` turns `pww` and `pwd` by the same factor, so its two ops are one
  // number to the reader — distinct values only.
  const knob = [...new Set(w.ops.map(forcingsValue))];
  const parts = [
    ...new Set(lane.map((o) => `∿ ${forcingsValue(o)}`)),
    // `w.label` is `forcingsLabel`'s — `trim` or `wetness`; the synthetic row
    // is labelled `Forcings` and has no ops to name.
    ...knob.map((v) => `${w.label} ${v}`),
  ];
  return parts.length === 0 ? "neutral" : parts.join(" · ");
}

/**
 * Every source that writes to `channel`, in signal order (SPEC §1), each row
 * carrying the window its click opens. The order and the membership are
 * `writersFor`'s; this only adds the label, the ops line and the target.
 *
 * Two rows carry no ops and so say something else instead: the station quotes
 * its own record, and the always-present Forcings row (`writersFor`) says it
 * is turned to nothing on this channel.
 */
export function writers(z: ZoneProfile, eras: readonly Era[], channel: Channel): WriterRow[] {
  const source = writersFor(z, eras, channel);
  // The lane and the trim are one panel and one signal path, so they are one
  // row — the prototype's MST. Left apart, the lane row had nothing to call
  // itself but its own id (`frc.warmth`), which is a key, not a name.
  const lane = source.filter((w) => w.kind === "automation").flatMap((w) => w.ops);
  return source.flatMap((w) => {
    if (w.kind === "automation") return [];
    const forcings = w.kind === "forcings";
    return [
      {
        kind: w.kind,
        label: w.kind === "station" ? stationLabel(z, w.label) : forcings ? "Forcings" : w.label,
        opsText: forcings ? forcingsText(lane, w) : w.ops.length > 0 ? w.ops.map(opText).join(" · ") : w.kind === "station" ? stationText(z, channel) : "neutral",
        target: targetFor(w, channel),
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// The WRITES footer
// ---------------------------------------------------------------------------

/**
 * The `layer:` ids a channel's panel can write, as the footer names them when
 * nothing is written yet. SKY spans two sections, so it names both — there is
 * no `layer:sky.*`, and printing one would be a lie about the grammar
 * (SPEC law 5).
 */
export function layerGlob(channel: Channel): string {
  const sections = [...new Set(chartSeries(channel).map((p) => p.split(".")[0] ?? ""))];
  return sections.map((s) => `${LAYER}${s}.*`).join(" · ");
}

/**
 * SPEC law 5: the exact grammar the panel produces — every `layer:` modifier
 * on the zone whose parameter belongs to `channel`, in `modifiers[]` order.
 * A stray (an id `parseLayerId` cannot decode) is still listed under its
 * channel: the footer states what the file holds, not what the editor meant.
 */
/**
 * The `layer:` ids this channel actually carries right now, in `modifiers[]`
 * order — the keys the WRITES footer names once something has been written.
 */
export function writtenLayers(z: ZoneProfile, channel: Channel): string[] {
  return z.modifiers
    .filter((m) => {
      if (!m.id.startsWith(LAYER)) return false;
      const param = parseLayerId(m.id)?.param ?? m.id.slice(LAYER.length);
      return channelOrNull(param) === channel;
    })
    .map((m) => m.id);
}

export function writesText(z: ZoneProfile, channel: Channel): string {
  const mine: string[] = [];
  z.modifiers.forEach((m, i) => {
    if (!m.id.startsWith(LAYER)) return;
    const param = parseLayerId(m.id)?.param ?? m.id.slice(LAYER.length);
    if (channelOrNull(param) === channel) mine.push(`modifiers[${i}] · ${JSON.stringify(m)}`);
  });
  return mine.length === 0 ? `modifiers[${layerGlob(channel)}] — neutral, nothing written` : mine.join("  ");
}

/** The channel a parameter path belongs to — re-exported so the window needs one import for both halves. */
export { channelOf };
