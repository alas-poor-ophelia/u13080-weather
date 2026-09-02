/**
 * Core data contracts (DESIGN-v1.md §2). No Obsidian imports here.
 */

/** A point on the annual cycle. `at` is yearPhase in [0, 1). */
export interface Keyframe {
  at: number;
  value: number;
}

/** Single-harmonic seasonal curve: mean + amplitude * cos(2π (t - phase)). `phase` is REQUIRED. */
export interface Harmonic {
  mean: number;
  amplitude: number;
  phase: number;
}

/** Every numeric climate parameter is a Curve. */
export type Curve = number | Harmonic | Keyframe[];

export interface TemperatureParams {
  /** °C daily mean */
  mean: Curve;
  /** °C, Tmax − Tmin */
  diurnalRange: Curve;
  /** yearPhase of the coldest day (hemisphere lives here) */
  phase: number;
  /** °C added to the mean on wet days (usually negative in summer) */
  wetDayOffset: Curve;
  /** AR(1) coefficient on the standardized residual, validated ≤ 0.9 */
  persistence: number;
  /** °C residual SD of the daily mean (used when sdHigh/sdLow are absent) */
  sd: Curve;
  /** °C residual SD of the daily high (optional; station data has it) */
  sdHigh?: Curve;
  /** °C residual SD of the daily low (optional) */
  sdLow?: Curve;
  /** °C added to the diurnal range on wet days (usually negative: wet days are less extreme) */
  wetDayRangeOffset?: Curve;
}

export interface PrecipitationParams {
  /** P(wet | yesterday wet) */
  pww: Curve;
  /** P(wet | yesterday dry) */
  pwd: Curve;
  /** gamma shape (alpha) of wet-day amount */
  shape: Curve;
  /** gamma scale (beta), mm */
  scale: Curve;
  /** °C; below this rain becomes snow */
  freezingPoint: number;
}

export interface WetDrySplit {
  dry: Curve;
  wet: Curve;
  sd: number;
}

export interface WindParams {
  /** km/h mean */
  speed: Curve;
  /** km/h SD */
  speedSd: Curve;
  /** prevailing direction, degrees from north, clockwise */
  direction: Curve;
  /** degrees, circular SD around prevailing */
  directionSpread: Curve;
  /** multiplier on speed for wet days */
  wetDayScale: number;
  /** fraction of time calm, 0..1 */
  calmFraction: Curve;
}

export interface ClimateParams {
  temperature: TemperatureParams;
  precipitation: PrecipitationParams;
  humidity: WetDrySplit;
  cloud: WetDrySplit;
  wind: WindParams;
}

export type ModifierOp = (
  /** `value` may be a whole Curve, but ONLY at the climate stage — the daily stage has already evaluated curves to scalars. */
  | { param: string; op: "set"; value: number | Curve }
  | { param: string; op: "offset"; value: number }
  | { param: string; op: "scale"; value: number }
  | { param: string; op: "clamp"; min?: number; max?: number }
) & {
  /** per-op power switch. Absent = enabled; a disabled op is dropped before it reaches the curves. */
  enabled?: boolean;
  /**
   * Onset envelope: `[phase, strength]` points sampled at the carrier moon's phase
   * (linear, wrapping across 1→0). Strength scales the op's magnitude
   * (`offset v → v·s`, `scale v → 1 + (v−1)·s`); `set`/`clamp` ignore it.
   * Daily stage only; the engine strips it before the op reaches the curves.
   */
  envelope?: Array<[number, number]>;
};

// ---------------------------------------------------------------------------
// Modifier vocabulary (DESIGN-v1.md §3) — a CLOSED set of predicates and ops.
// ---------------------------------------------------------------------------

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { moon: { name: string; phase: [number, number] } }
  | { yearPhase: [number, number] }
  | { dayOfYear: [number, number] }
  | { tag: string }
  | { regime: string }
  | { chance: number };

export interface SpellSpec {
  /** expected number of spell starts per year within the `when` window */
  meanStartsPerYear: number;
  /** geometric duration */
  meanDurationDays: number;
}

/**
 * A mod-matrix gate (PLAN §0 D7, §2.4). `source` is always a TAG — never a moon —
 * and when that tag is on the day, every op's magnitude in the modifier is
 * multiplied by `amount`. An inactive gate contributes ×1; gates multiply;
 * `amount: 0` mutes the modifier without silencing its tag.
 *
 * A gate is a dimmer: `amount` is in [0, 1] (validation rejects the rest), so a
 * gate can only take a device down from the magnitude its author wrote.
 */
export interface ModGate {
  source: string;
  /** dimmer in [0, 1]: 1 is full strength, 0 mutes */
  amount: number;
}

export interface Modifier {
  id: string;
  /** climate: unconditional edit of the resolved curves; daily: conditional per-day ops (default) */
  stage?: "climate" | "daily";
  when?: Predicate;
  spell?: SpellSpec;
  apply: ModifierOp[];
  tag?: string;
  /** power switch. Absent = enabled; a disabled modifier is skipped at both stages. */
  enabled?: boolean;
  /** mod-matrix gates (daily stage only). Absent or empty = factor 1. */
  mods?: ModGate[];
}

/** What a time adapter provides per day; the generator and predicates read only this. */
/**
 * A span of the world's history (era timeline, world-level). Years are the
 * calendar's own year numbers; `from` and `to` are both inclusive, `to`
 * omitted means "until the end of time". Every day inside the span carries the
 * tag `era:<name>`; `apply` (daily-stage ops) is applied to every zone on
 * those days.
 */
export interface Era {
  name: string;
  from: number;
  to?: number;
  apply?: ModifierOp[];
  /** power switch. Absent = enabled; a disabled era tags nothing and applies nothing. */
  enabled?: boolean;
}

export interface DayTime {
  yearPhase: number;
  dayOfYear?: number;
  /** calendar year number, used by the era timeline; adapters that omit it get year = floor(dayOrdinal / yearLength) + 1 */
  year?: number;
  moons?: Array<{ name: string; phase: number }>;
  tags?: string[];
}

export interface Regime {
  id: string;
  weight: number;
  meanDurationDays: number;
  apply?: ModifierOp[];
}

export type Orographic = "none" | "windward" | "leeward";

/** Metadata used by Tier A nearest-preset matching. */
export interface MatchProfile {
  latitude: number;
  altitude: number;
  continentality: number;
  orographic: Orographic;
  /** computed from the climate curves (src/core/koppen.ts) */
  koppen: string;
}

export interface PresetSource {
  dataset: string;
  doi: string;
  license: string;
  ghcnId: string;
  stationName: string;
  country: string;
  latitude: number;
  longitude: number;
  elevationM: number;
  yearsOfRecord: number;
  /** Wind sectors in the international CLIGEN files are interpolated from US analogue stations. */
  windSource: { interpolated: boolean; stations: Array<{ name: string; weight: number }> };
}

export interface Geography {
  latitude: number;
  altitude: number;
  /** 0 coast … 1 deep interior. Omit to ignore the axis when matching and keep the matched preset's own seasonal swing. */
  continentality?: number;
  orographic: Orographic;
}

/** A value that moves over the world's years, applied as a daily-stage op on a curve parameter (PLAN.md §2, D6). */
export interface AutomationLane {
  id: string;
  /** a curve path, e.g. "temperature.mean" */
  param: string;
  op: "offset" | "scale";
  /** [[year, value]…], years strictly ascending; value(y) is linear between points and clamped outside */
  points: Array<[number, number]>;
  /** lane power. Absent = enabled. */
  enabled?: boolean;
}

/** What a worldbuilder authors (DESIGN-v1.md §2). Tier C (`climate`) is the stored state. */
export interface ZoneProfile {
  id: string;
  name: string;
  schemaVersion: 1;
  geography?: Geography;
  preset?: { id: string; contentHash: string; matched: "auto" | "manual" };
  climate: ClimateParams;
  regimes: Regime[];
  modifiers: Modifier[];
  coordinate?: { x: number; y: number };
  automation?: AutomationLane[];
  /** southern hemisphere: `season:*` tags are read half a year away. Calendar-side, so it is NOT part of `profileHash` (PLAN §0 D9). */
  flipSeasons?: boolean;
}

/** A shipped preset. Copied into a zone on selection (never referenced at runtime). */
export interface Preset {
  schemaVersion: 0;
  id: string;
  name: string;
  character: string;
  match: MatchProfile;
  /** Köppen class the curator assigned by hand; match.koppen is the COMPUTED class and is authoritative. */
  koppenAssigned: string;
  climate: ClimateParams;
  regimes: Regime[];
  source: PresetSource;
  /** sha256 over the canonical JSON of { climate, regimes } */
  contentHash: string;
}
