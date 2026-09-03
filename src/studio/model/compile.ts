/**
 * The layer compiler: `layer:*` / `forcings:*` modifiers and `automation[]`
 * read and written as *views* over a zone draft.
 *
 * The zone draft IS a `ZoneProfile` (PLAN §0.1 "Store"), so there is no second
 * representation to keep in sync — a knob reads its layer out of
 * `modifiers[]` by id and writes it back by id. Nothing here ever touches the
 * base `climate`: that stays exactly as the preset copied it, which is what
 * keeps `preset.contentHash` an honest description of the stored curves
 * (SPEC §7a, PLAN §5.2 "Alternative (rejected)").
 *
 * Pure: no Obsidian imports (PLAN D3).
 *
 * ## Id grammar (PLAN §2.3, SPEC §7a)
 *
 * | id | stage | shape |
 * |---|---|---|
 * | `layer:<param>`                    | climate | `offset` |
 * | `layer:<param>:scale`              | climate | `scale` |
 * | `layer:<param>:curve`              | climate | `set` with a whole Curve |
 * | `layer:<param>:swing`              | climate | `set` with the amplitude-rescaled base |
 * | `layer:<param>:season:<X>`         | daily   | `when.tag = season:<X>`, `offset` |
 * | `layer:<param>:season:<X>:set`     | daily   | `when.tag = season:<X>`, `set` |
 * | `layer:<param>:moon:<X>`           | daily   | `when.moon = { <X>, [0,1] }`, `offset` + `envelope` |
 * | `forcings:temperature.mean`        | climate | trim (`offset`) |
 * | `forcings:precipitation`           | climate | wetness (`scale` on pww **and** pwd) |
 * | automation `frc.warmth`            | —       | `AutomationLane` on `temperature.mean` |
 *
 * `<param>` always contains a `.` and never a `:`, so splitting the suffix on
 * `:` is unambiguous. A season or moon whose name contains `:` still
 * round-trips (the scope is the joined tail); the one genuinely ambiguous name
 * is a season literally called `set`, and even that resolves because the
 * offset form has two tail segments and the set form three.
 *
 * ## Order inside the layer block
 *
 * Climate-stage ops are applied in `modifiers[]` order (`profile.ts`
 * `resolveProfile`), so the layer block is kept sorted by rank:
 * `curve` → `offset` → `scale` → `swing` → daily-stage scopes. `swing` is a
 * whole-curve `set`, so it must be the last climate-stage writer for its
 * parameter; `setAllYear` / `setCurveLayer` therefore re-derive an existing
 * swing from the new effective base (`refreshSwing`) instead of leaving a
 * stale curve behind.
 */
import { laneValue } from "../../core/automation";
import { evalCurve, monthCentrePhase, monthlyKeyframes, wrapPhase } from "../../core/curve";
import { applyClimateOps, getPath, isCurvePath, type ClimatePath } from "../../core/curve-ops";
import type { AutomationLane, Curve, Era, Modifier, ModifierOp, Predicate, ZoneProfile } from "../../core/types";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type Channel = "temperature" | "precipitation" | "wind" | "sky";

/** First path segment → channel. `humidity` and `cloud` are both the SKY channel (SPEC §1). */
const CHANNEL_BY_ROOT: Record<string, Channel> = {
  temperature: "temperature",
  precipitation: "precipitation",
  wind: "wind",
  humidity: "sky",
  cloud: "sky",
};

/**
 * The channel a climate parameter path belongs to. Throws on a path with no
 * channel, the same way `applyClimateOps` throws on an unknown path — a
 * caller with a real `CurvePath`/`ScalarPath` can never trip it. Code that
 * walks *authored* ops (which may be hand-written nonsense) uses the internal
 * null-returning form instead.
 */
export function channelOf(param: string): Channel {
  const c = channelOrNull(param);
  if (c === null) throw new RangeError(`no channel for parameter path "${param}"`);
  return c;
}

export function channelOrNull(param: string): Channel | null {
  return CHANNEL_BY_ROOT[param.split(".")[0] ?? ""] ?? null;
}

// ---------------------------------------------------------------------------
// Id prefixes
// ---------------------------------------------------------------------------

export const LAYER = "layer:";
export const FORCINGS = "forcings:";
/** `era:` ids are the era timeline's (`eras.ts`); a zone modifier may not use them. */
const ERA = "era:";

export function isLayerId(id: string): boolean {
  return id.startsWith(LAYER);
}

export function isForcingsId(id: string): boolean {
  return id.startsWith(FORCINGS);
}

/** A device is anything the studio did not compile: neither prefix, and not an era modifier. */
export function isDeviceId(id: string): boolean {
  return !isLayerId(id) && !isForcingsId(id) && !id.startsWith(ERA);
}

export const TRIM_ID = `${FORCINGS}temperature.mean`;
export const WETNESS_ID = `${FORCINGS}precipitation`;
export const WARMTH_LANE_ID = "frc.warmth";

const TRIM_PARAM = "temperature.mean";
const WETNESS_PARAMS = ["precipitation.pww", "precipitation.pwd"] as const;

/** Below this a knob is at its neutral and the modifier is deleted rather than written as a no-op. */
const EPS = 1e-9;

const idAllYear = (param: string, op: "offset" | "scale"): string => (op === "offset" ? `${LAYER}${param}` : `${LAYER}${param}:scale`);
const idCurve = (param: string): string => `${LAYER}${param}:curve`;
const idSwing = (param: string): string => `${LAYER}${param}:swing`;
const idSeason = (param: string, season: string): string => `${LAYER}${param}:season:${season}`;
const idSeasonSet = (param: string, season: string): string => `${LAYER}${param}:season:${season}:set`;
const idMoon = (param: string, moon: string): string => `${LAYER}${param}:moon:${moon}`;

// ---------------------------------------------------------------------------
// Id parsing
// ---------------------------------------------------------------------------

export type LayerKind = "offset" | "scale" | "curve" | "swing" | "season" | "seasonSet" | "moon";

export interface ParsedLayerId {
  param: string;
  kind: LayerKind;
  /** season or moon name; absent for the all-year kinds */
  scope?: string;
}

/** Decompile a `layer:` id, or `null` when it is not one the studio writes. */
export function parseLayerId(id: string): ParsedLayerId | null {
  if (!isLayerId(id)) return null;
  const seg = id.slice(LAYER.length).split(":");
  const param = seg[0] ?? "";
  if (!isCurvePath(param)) return null;
  const tail = seg.slice(1);
  if (tail.length === 0) return { param, kind: "offset" };
  if (tail.length === 1 && tail[0] === "scale") return { param, kind: "scale" };
  if (tail.length === 1 && tail[0] === "curve") return { param, kind: "curve" };
  if (tail.length === 1 && tail[0] === "swing") return { param, kind: "swing" };
  if (tail[0] === "season" && tail.length >= 2) {
    if (tail.length >= 3 && tail[tail.length - 1] === "set") {
      const scope = tail.slice(1, -1).join(":");
      return scope ? { param, kind: "seasonSet", scope } : null;
    }
    const scope = tail.slice(1).join(":");
    return scope ? { param, kind: "season", scope } : null;
  }
  if (tail[0] === "moon" && tail.length >= 2) {
    const scope = tail.slice(1).join(":");
    return scope ? { param, kind: "moon", scope } : null;
  }
  return null;
}

const LAYER_RANK: Record<LayerKind, number> = { curve: 0, offset: 1, scale: 2, swing: 3, season: 4, seasonSet: 4, moon: 4 };
/** Unparseable `layer:` ids sort after every compiled one, so a stray never lands between two climate ops. */
const STRAY_RANK = 5;

function layerRank(id: string): number {
  const p = parseLayerId(id);
  return p ? LAYER_RANK[p.kind] : STRAY_RANK;
}

/** Trim is "last among the zone's own modifiers" (PLAN §2.3), whichever order the knobs were turned in. */
function forcingsRank(id: string): number {
  return id === TRIM_ID ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Modifier array plumbing
// ---------------------------------------------------------------------------

function find(z: ZoneProfile, id: string): Modifier | undefined {
  return z.modifiers.find((m) => m.id === id);
}

function opOf(m: Modifier | undefined, param: string, op: ModifierOp["op"]): ModifierOp | undefined {
  return m?.apply.find((o) => o.param === param && o.op === op);
}

function removeModifier(z: ZoneProfile, id: string): void {
  const i = z.modifiers.findIndex((m) => m.id === id);
  if (i >= 0) z.modifiers.splice(i, 1);
}

/**
 * Stable-sort one prefix block by rank, writing each modifier back into a slot
 * the block already occupied — nothing outside the block ever moves. Stable and
 * rank-based, so re-running it is a no-op: setters stay idempotent.
 */
function sortBlock(z: ZoneProfile, inBlock: (id: string) => boolean, rank: (id: string) => number): void {
  const slots: number[] = [];
  const block: Modifier[] = [];
  z.modifiers.forEach((m, i) => {
    if (inBlock(m.id)) {
      slots.push(i);
      block.push(m);
    }
  });
  const sorted = block
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i)
    .map((x) => x.m);
  slots.forEach((s, i) => {
    z.modifiers[s] = sorted[i]!;
  });
}

/**
 * Write `m` by id: replace in place when the id already exists, otherwise
 * insert at the boundary of its partition (`layer:*` … devices … `forcings:*`)
 * so an unrelated knob never reshuffles a hand-authored rack.
 */
function putModifier(z: ZoneProfile, m: Modifier): void {
  const mods = z.modifiers;
  const at = mods.findIndex((x) => x.id === m.id);
  if (at >= 0) mods[at] = m;
  else if (isLayerId(m.id)) {
    let insert = 0;
    for (let k = mods.length - 1; k >= 0; k--) {
      if (isLayerId(mods[k]!.id)) {
        insert = k + 1;
        break;
      }
    }
    mods.splice(insert, 0, m);
  } else if (isForcingsId(m.id)) mods.push(m);
  else {
    const first = mods.findIndex((x) => isForcingsId(x.id));
    mods.splice(first === -1 ? mods.length : first, 0, m);
  }
  if (isLayerId(m.id)) sortBlock(z, isLayerId, layerRank);
  else if (isForcingsId(m.id)) sortBlock(z, isForcingsId, forcingsRank);
}

function requireCurvePath(param: string): void {
  if (!isCurvePath(param)) throw new RangeError(`"${param}" is not a curve parameter path`);
}

// ---------------------------------------------------------------------------
// All-year scope (climate stage)
// ---------------------------------------------------------------------------

export interface AllYearLayer {
  param: string;
  op: "offset" | "scale";
  value: number;
}

/** The all-year knob's value, neutral (0 for offset, 1 for scale) when the layer is absent. */
export function getAllYear(z: ZoneProfile, param: string, op: "offset" | "scale"): number {
  const neutral = op === "scale" ? 1 : 0;
  const o = opOf(find(z, idAllYear(param, op)), param, op);
  if (!o) return neutral;
  return o.op === "offset" || o.op === "scale" ? o.value : neutral;
}

/** Write (or, at neutral, delete) the all-year layer. A non-finite value deletes too. */
export function setAllYear(z: ZoneProfile, param: string, op: "offset" | "scale", value: number): void {
  requireCurvePath(param);
  const neutral = op === "scale" ? 1 : 0;
  const id = idAllYear(param, op);
  if (!Number.isFinite(value) || Math.abs(value - neutral) < EPS) removeModifier(z, id);
  else putModifier(z, { id, stage: "climate", apply: [{ param, op, value }] });
  refreshSwing(z, param);
}

/** Every all-year layer on the zone, in `modifiers[]` order. */
export function allYearLayers(z: ZoneProfile): AllYearLayer[] {
  const out: AllYearLayer[] = [];
  for (const m of z.modifiers) {
    const p = parseLayerId(m.id);
    if (!p || (p.kind !== "offset" && p.kind !== "scale")) continue;
    const o = opOf(m, p.param, p.kind);
    if (o && (o.op === "offset" || o.op === "scale")) out.push({ param: p.param, op: p.kind, value: o.value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curve replacement (climate-stage `set` with a whole Curve)
// ---------------------------------------------------------------------------

/**
 * The drawn curve that replaces the base one, or `null`. The returned Curve is
 * the stored object: treat it as immutable (`curve.ts` caches keyframe sorts by
 * array identity).
 */
export function getCurveLayer(z: ZoneProfile, param: string): Curve | null {
  const o = opOf(find(z, idCurve(param)), param, "set");
  return o && o.op === "set" ? o.value : null;
}

export function setCurveLayer(z: ZoneProfile, param: string, curve: Curve | null): void {
  requireCurvePath(param);
  const id = idCurve(param);
  if (curve === null) removeModifier(z, id);
  else putModifier(z, { id, stage: "climate", apply: [{ param, op: "set", value: structuredClone(curve) }] });
  refreshSwing(z, param);
}

// ---------------------------------------------------------------------------
// Effective base and swing
// ---------------------------------------------------------------------------

/** Samples per year used for the annual mean and the peak-to-peak amplitude. */
const YEAR_SAMPLES = 365;

function annualMean(c: Curve): number {
  if (typeof c === "number") return c;
  let s = 0;
  for (let d = 0; d < YEAR_SAMPLES; d++) s += evalCurve(c, (d + 0.5) / YEAR_SAMPLES);
  return s / YEAR_SAMPLES;
}

/** Peak-to-peak / 2. Exactly proportional to k under `v → mean + (v − mean)·k`, so it inverts the swing. */
function annualAmplitude(c: Curve): number {
  if (typeof c === "number") return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let d = 0; d < YEAR_SAMPLES; d++) {
    const v = evalCurve(c, (d + 0.5) / YEAR_SAMPLES);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (hi - lo) / 2;
}

/**
 * The curve the swing knob rescales and the channel editor draws: the base
 * `climate` value with this parameter's *other* climate-stage layers applied
 * (curve replacement, then all-year offset, then all-year scale) — everything
 * except the swing itself, which is derived from this.
 *
 * Disabled modifiers and disabled ops are skipped, mirroring `resolveProfile`.
 */
export function effectiveBase(z: ZoneProfile, param: string): Curve {
  requireCurvePath(param);
  const ops: ModifierOp[] = [];
  for (const m of z.modifiers) {
    if (m.enabled === false || m.stage !== "climate") continue;
    const p = parseLayerId(m.id);
    if (!p || p.param !== param) continue;
    if (p.kind !== "curve" && p.kind !== "offset" && p.kind !== "scale") continue;
    for (const o of m.apply) if (o.param === param && o.enabled !== false) ops.push(o);
  }
  const climate = ops.length ? applyClimateOps(z.climate, ops) : z.climate;
  // `getPath` is typed non-optional, but the optional curves (sdHigh/sdLow/wetDayRangeOffset)
  // really can be absent — `applyClimateOps` defaults them the same way.
  const curve: Curve | undefined = getPath(climate, param as ClimatePath);
  return curve ?? 0;
}

const SWING_TAG = "swing:";

/**
 * The seasonal-amplitude multiplier, 1 when absent.
 *
 * `k` rides on the modifier's `tag` because ids must stay stable (the UI
 * round-trips a layer by id, so the value can never live in the id) and a
 * climate-stage tag is inert: `ModifierEngine` keeps only daily-stage
 * modifiers (`src/core/modifiers.ts:158`), `resolveProfile` hands the engine
 * only the daily ones (`src/core/profile.ts:321`) and reads nothing but
 * `.apply` from the climate ones (`src/core/profile.ts:315`). Nothing else in
 * the engine looks at `Modifier.tag`, and `validateProfile` places no
 * constraint on it.
 *
 * If the tag is missing or unparseable (hand-edited JSON), `k` is recovered
 * from the ratio of peak-to-peak amplitudes against `effectiveBase`.
 */
export function getSwing(z: ZoneProfile, param: string): number {
  const m = find(z, idSwing(param));
  if (!m) return 1;
  if (m.tag?.startsWith(SWING_TAG)) {
    const k = Number.parseFloat(m.tag.slice(SWING_TAG.length));
    if (Number.isFinite(k)) return k;
  }
  const o = opOf(m, param, "set");
  if (!o || o.op !== "set") return 1;
  const base = annualAmplitude(effectiveBase(z, param));
  return base < EPS ? 1 : annualAmplitude(o.value) / base;
}

/**
 * `v' = mean + (v − mean)·k` around the annual mean of the effective base.
 * Keyframe bases keep their own `at`s; constants and harmonics are sampled to
 * 12 keyframes at the real calendar month centres (`monthCentrePhase`, so the
 * rewrite introduces no phase error — evenly spaced `sampleCurve` phases would
 * be off by up to a day and a half).
 */
function rescaleSwing(base: Curve, k: number): Curve {
  const mean = annualMean(base);
  if (Array.isArray(base)) return base.map((p) => ({ at: p.at, value: mean + (p.value - mean) * k }));
  return monthlyKeyframes(Array.from({ length: 12 }, (_, m) => mean + (evalCurve(base, monthCentrePhase(m)) - mean) * k));
}

/** Write (or, at k = 1, delete) the swing layer. */
export function setSwing(z: ZoneProfile, param: string, k: number): void {
  requireCurvePath(param);
  const id = idSwing(param);
  if (!Number.isFinite(k) || Math.abs(k - 1) < EPS) {
    removeModifier(z, id);
    return;
  }
  putModifier(z, { id, stage: "climate", tag: `${SWING_TAG}${k}`, apply: [{ param, op: "set", value: rescaleSwing(effectiveBase(z, param), k) }] });
}

/** Re-derive an existing swing after the effective base moved under it. No-op when there is none. */
function refreshSwing(z: ZoneProfile, param: string): void {
  if (!find(z, idSwing(param))) return;
  setSwing(z, param, getSwing(z, param));
}

// ---------------------------------------------------------------------------
// Season scope (daily stage)
// ---------------------------------------------------------------------------

function seasonWhen(season: string): Predicate {
  return { tag: `season:${season}` };
}

export function getSeasonOffset(z: ZoneProfile, param: string, season: string): number {
  const o = opOf(find(z, idSeason(param, season)), param, "offset");
  return o && o.op === "offset" ? o.value : 0;
}

export function setSeasonOffset(z: ZoneProfile, param: string, season: string, value: number): void {
  requireCurvePath(param);
  const id = idSeason(param, season);
  if (!Number.isFinite(value) || Math.abs(value) < EPS) removeModifier(z, id);
  else putModifier(z, { id, when: seasonWhen(season), apply: [{ param, op: "offset", value }] });
}

/**
 * A season-scoped absolute value (wind direction per season), `null` when
 * absent. There is no neutral: 0° is a real bearing, so the layer is removed
 * by passing `null`, never by a value.
 */
export function getSeasonSet(z: ZoneProfile, param: string, season: string): number | null {
  const o = opOf(find(z, idSeasonSet(param, season)), param, "set");
  return o && o.op === "set" && typeof o.value === "number" ? o.value : null;
}

export function setSeasonSet(z: ZoneProfile, param: string, season: string, value: number | null): void {
  requireCurvePath(param);
  const id = idSeasonSet(param, season);
  if (value === null || !Number.isFinite(value)) removeModifier(z, id);
  else putModifier(z, { id, when: seasonWhen(season), apply: [{ param, op: "set", value }] });
}

// ---------------------------------------------------------------------------
// Moon cycle scope (daily stage; the drawn curve is the op's envelope)
// ---------------------------------------------------------------------------

export interface CycleLayer {
  moon: string;
  depth: number;
  envelope: Array<[number, number]>;
}

/** Envelope points as the validator demands them: phase wrapped into [0,1), strength clamped to [0,1]. */
function cleanEnvelope(env: readonly (readonly [number, number])[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const pt of env) {
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    out.push([wrapPhase(pt[0]), Math.min(1, Math.max(0, pt[1]))]);
  }
  return out;
}

export function getCycle(z: ZoneProfile, param: string, moon: string): CycleLayer | null {
  const m = find(z, idMoon(param, moon));
  const o = opOf(m, param, "offset");
  if (!o || o.op !== "offset") return null;
  return { moon, depth: o.value, envelope: (o.envelope ?? []).map((p) => [p[0], p[1]] as [number, number]) };
}

/**
 * Write the ☾ layer. `null` clears **every** moon layer on the parameter (the
 * channel editor's cycle scope carries one moon at a time). A depth of 0 is
 * kept: the drawn envelope is authored data, and the op is inert anyway.
 */
export function setCycle(z: ZoneProfile, param: string, layer: CycleLayer | null): void {
  requireCurvePath(param);
  if (layer === null) {
    for (const m of [...z.modifiers]) {
      const p = parseLayerId(m.id);
      if (p && p.kind === "moon" && p.param === param) removeModifier(z, m.id);
    }
    return;
  }
  const envelope = cleanEnvelope(layer.envelope);
  const op: ModifierOp = envelope.length ? { param, op: "offset", value: layer.depth, envelope } : { param, op: "offset", value: layer.depth };
  putModifier(z, { id: idMoon(param, layer.moon), when: { moon: { name: layer.moon, phase: [0, 1] } }, apply: [op] });
}

/** Every moon layer on the parameter, in `modifiers[]` order. */
export function cycleLayers(z: ZoneProfile, param: string): CycleLayer[] {
  const out: CycleLayer[] = [];
  for (const m of z.modifiers) {
    const p = parseLayerId(m.id);
    if (!p || p.kind !== "moon" || p.param !== param) continue;
    const c = getCycle(z, param, p.scope!);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forcings (zone master)
// ---------------------------------------------------------------------------

/** `forcings:temperature.mean` offset — the zone's temperature trim. 0 when absent. */
export function getTrim(z: ZoneProfile): number {
  const o = opOf(find(z, TRIM_ID), TRIM_PARAM, "offset");
  return o && o.op === "offset" ? o.value : 0;
}

/** Trim sorts last inside the forcings block, which itself sits last in `modifiers[]` (PLAN §2.3). */
export function setTrim(z: ZoneProfile, v: number): void {
  if (!Number.isFinite(v) || Math.abs(v) < EPS) removeModifier(z, TRIM_ID);
  else putModifier(z, { id: TRIM_ID, stage: "climate", apply: [{ param: TRIM_PARAM, op: "offset", value: v }] });
}

/** `forcings:precipitation` — one modifier scaling both wet-day probabilities. 1 when absent. */
export function getWetness(z: ZoneProfile): number {
  const o = opOf(find(z, WETNESS_ID), WETNESS_PARAMS[0], "scale");
  return o && o.op === "scale" ? o.value : 1;
}

export function setWetness(z: ZoneProfile, k: number): void {
  if (!Number.isFinite(k) || Math.abs(k - 1) < EPS) {
    removeModifier(z, WETNESS_ID);
    return;
  }
  putModifier(z, { id: WETNESS_ID, stage: "climate", apply: WETNESS_PARAMS.map((param) => ({ param, op: "scale" as const, value: k })) });
}

/**
 * The FRC · warmth lane. When the zone has none, a neutral lane with no points
 * is synthesised for the UI to draw into — it is not stored (an empty
 * `points` is a validation error), so nothing is written until `setWarmthLane`.
 */
export function getWarmthLane(z: ZoneProfile): AutomationLane {
  return z.automation?.find((l) => l.id === WARMTH_LANE_ID) ?? { id: WARMTH_LANE_ID, param: TRIM_PARAM, op: "offset", points: [] };
}

/**
 * Write the warmth lane. Removed only when `points` is empty — a lane whose
 * points are all 0 is a deliberate flat lane and stays. Point count and
 * ordering are the UI's business (the validator wants strictly ascending
 * years); nothing is sorted here.
 */
export function setWarmthLane(z: ZoneProfile, points: Array<[number, number]>): void {
  const lanes = z.automation ?? [];
  const at = lanes.findIndex((l) => l.id === WARMTH_LANE_ID);
  if (points.length === 0) {
    if (at >= 0) lanes.splice(at, 1);
  } else {
    const lane: AutomationLane = { id: WARMTH_LANE_ID, param: TRIM_PARAM, op: "offset", points: points.map((p) => [p[0], p[1]] as [number, number]) };
    if (at >= 0) lanes[at] = lane;
    else lanes.push(lane);
  }
  if (lanes.length === 0) delete z.automation;
  else z.automation = lanes;
}

/** Trim + the warmth lane's value — the Forcings window's "= total into TEMP" readout (PLAN §5.3). */
export function totalWarmthAt(z: ZoneProfile, fractionalYear: number): number {
  return getTrim(z) + laneValue(getWarmthLane(z), fractionalYear);
}

// ---------------------------------------------------------------------------
// Ordering and devices
// ---------------------------------------------------------------------------

/**
 * Stable partition into `layer:*` → devices → `forcings:*` (PLAN §2.3, "order
 * in `modifiers[]` on save"), with the layer block sorted by rank. Devices keep
 * their relative order, which is the rack order. Mutates in place, keeping the
 * array identity the draft is edited through.
 */
export function normaliseOrder(z: ZoneProfile): void {
  const layers = z.modifiers.filter((m) => isLayerId(m.id));
  const forcings = z.modifiers.filter((m) => isForcingsId(m.id));
  const rest = z.modifiers.filter((m) => !isLayerId(m.id) && !isForcingsId(m.id));
  layers.sort((a, b) => layerRank(a.id) - layerRank(b.id));
  forcings.sort((a, b) => forcingsRank(a.id) - forcingsRank(b.id));
  z.modifiers.splice(0, z.modifiers.length, ...layers, ...rest, ...forcings);
}

/** The device modifiers in rack order (everything the studio did not compile). */
export function devices(z: ZoneProfile): Modifier[] {
  return z.modifiers.filter((m) => isDeviceId(m.id));
}

/**
 * Move a device to `toIndex` *among the devices*. The devices are written back
 * into the slots they already occupied, so `layer:*` and `forcings:*` keep
 * their absolute positions. Unknown id or an unchanged index: no-op.
 */
export function reorderDevice(z: ZoneProfile, id: string, toIndex: number): void {
  const slots: number[] = [];
  const rack: Modifier[] = [];
  z.modifiers.forEach((m, i) => {
    if (isDeviceId(m.id)) {
      slots.push(i);
      rack.push(m);
    }
  });
  const from = rack.findIndex((m) => m.id === id);
  if (from === -1) return;
  const to = Math.min(Math.max(Math.trunc(toIndex), 0), rack.length - 1);
  if (to === from) return;
  const [moved] = rack.splice(from, 1);
  rack.splice(to, 0, moved!);
  slots.forEach((s, i) => {
    z.modifiers[s] = rack[i]!;
  });
}

// ---------------------------------------------------------------------------
// Stray layers
// ---------------------------------------------------------------------------

function isSeasonWhen(when: Modifier["when"], season: string): boolean {
  return !!when && "tag" in when && when.tag === `season:${season}`;
}

function isMoonWhen(when: Modifier["when"], moon: string): boolean {
  return !!when && "moon" in when && when.moon.name === moon && when.moon.phase[0] === 0 && when.moon.phase[1] === 1;
}

/** Does this `layer:` modifier have exactly the shape its id promises? */
function decompiles(m: Modifier): boolean {
  const p = parseLayerId(m.id);
  if (!p) return false;
  if (m.spell || m.mods?.length) return false;
  if (!Array.isArray(m.apply) || m.apply.length !== 1) return false;
  const o = m.apply[0]!;
  if (o.param !== p.param) return false;
  const stage = m.stage ?? "daily";
  switch (p.kind) {
    case "offset":
      return stage === "climate" && !m.when && o.op === "offset";
    case "scale":
      return stage === "climate" && !m.when && o.op === "scale";
    case "curve":
    case "swing":
      return stage === "climate" && !m.when && o.op === "set";
    case "season":
      return stage === "daily" && isSeasonWhen(m.when, p.scope!) && o.op === "offset";
    case "seasonSet":
      return stage === "daily" && isSeasonWhen(m.when, p.scope!) && o.op === "set" && typeof o.value === "number";
    case "moon":
      return stage === "daily" && isMoonWhen(m.when, p.scope!) && o.op === "offset";
  }
}

/**
 * Ids of modifiers that carry the `layer:` prefix but do not decompile into a
 * knob — an unknown suffix, a non-curve parameter, or a shape the compiler
 * never writes (an extra op, a `when.chance`, a spell, a gate). They are left
 * exactly as authored; the mixer shows them as devices with a "custom" chip
 * (PLAN §2.3).
 */
export function strayLayers(z: ZoneProfile): string[] {
  return z.modifiers.filter((m) => isLayerId(m.id) && !decompiles(m)).map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Writers stack
// ---------------------------------------------------------------------------

export interface Writer {
  kind: "station" | "layer" | "regime" | "device" | "forcings" | "automation" | "era";
  id: string;
  label: string;
  ops: ModifierOp[];
}

function layerLabel(id: string): string {
  const p = parseLayerId(id);
  if (!p) return id;
  switch (p.kind) {
    case "offset":
      return "all year offset";
    case "scale":
      return "all year scale";
    case "curve":
      return "drawn curve";
    case "swing":
      return "swing";
    case "season":
    case "seasonSet":
      return `season · ${p.scope!}`;
    case "moon":
      return `cycle · ${p.scope!}`;
  }
}

function forcingsLabel(id: string): string {
  if (id === TRIM_ID) return "trim";
  if (id === WETNESS_ID) return "wetness";
  return id.slice(FORCINGS.length);
}

/** A lane's op at its last authored point — the shape and the terminal value the stack shows. */
function laneOp(l: AutomationLane): ModifierOp {
  const last = l.points[l.points.length - 1];
  const value = laneValue(l, last ? last[0] : 0);
  return l.op === "scale" ? { param: l.param, op: "scale", value } : { param: l.param, op: "offset", value };
}

/**
 * Every source that writes to any parameter of `channel`, in signal order
 * (SPEC §1): station → layers → regimes → devices → forcings → automation →
 * eras. `layer:*` scopes stay in the layer slot even when they are daily-stage
 * (they are the channel editor's own scope chips, not devices).
 *
 * Disabled modifiers, ops, lanes and eras are still listed — a UI greys them
 * rather than losing them (PLAN §0.1, "`ResolvedProfile.dailyModifiers` is not
 * filtered by `enabled`"). The station row is always present and carries no
 * ops: it is the baseline the rest of the stack edits.
 */
export function writersFor(z: ZoneProfile, eras: readonly Era[], channel: Channel): Writer[] {
  const pick = (ops: readonly ModifierOp[] | undefined): ModifierOp[] => (ops ?? []).filter((o) => channelOrNull(o.param) === channel);
  const out: Writer[] = [{ kind: "station", id: z.preset?.id ?? "climate", label: z.preset?.id ?? "base climate", ops: [] }];
  const mods = z.modifiers;
  for (const m of mods) {
    if (!isLayerId(m.id)) continue;
    const ops = pick(m.apply);
    if (ops.length) out.push({ kind: "layer", id: m.id, label: layerLabel(m.id), ops });
  }
  for (const r of z.regimes) {
    const ops = pick(r.apply);
    if (ops.length) out.push({ kind: "regime", id: r.id, label: r.id, ops });
  }
  for (const m of mods) {
    if (!isDeviceId(m.id)) continue;
    const ops = pick(m.apply);
    if (ops.length) out.push({ kind: "device", id: m.id, label: m.id, ops });
  }
  let master = false;
  for (const m of mods) {
    if (!isForcingsId(m.id)) continue;
    const ops = pick(m.apply);
    if (ops.length) {
      out.push({ kind: "forcings", id: m.id, label: forcingsLabel(m.id), ops });
      master = true;
    }
  }
  const lanes = (z.automation ?? []).filter((l) => channelOrNull(l.param) === channel);
  // The prototype's MST row (`1397-logic-class-Component.js` `tWriters`) is the
  // one row that is always there: Forcings is a panel every channel is wired
  // to, so a channel it is turned to nothing on still says so rather than
  // dropping out of the stack. Its ops are empty and the reader is told.
  if (!master) out.push({ kind: "forcings", id: FORCINGS, label: "Forcings", ops: [] });
  for (const l of lanes) out.push({ kind: "automation", id: l.id, label: l.id, ops: [laneOp(l)] });
  for (const e of eras) {
    const ops = pick(e.apply);
    if (ops.length) out.push({ kind: "era", id: ERA + e.name, label: e.name, ops });
  }
  return out;
}
