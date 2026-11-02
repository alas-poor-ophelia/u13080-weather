/**
 * U+13080 Weather (plugin id `wadjet`) — public API types.
 *
 * Standalone and dependency-free: copy this file into your plugin and
 * `import type { WadjetAPI } from "./wadjet"`. It describes the object at
 * `app.plugins.plugins.wadjet.api` (also `window.Wadjet`), API version 2.
 * The plugin's own test suite fails if the shipped object stops matching it.
 *
 * Reference: docs/API.md in the plugin repository.
 */

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type PrecipType = "none" | "drizzle" | "rain" | "sleet" | "snow";
export type Units = "metric" | "imperial";

export interface Provenance {
  worldSeed: string;
  generatorVersion: string;
  rngVersion: string;
  profileHash: string;
  calendarHash: string;
}

/** One zone, one day (optionally one hour). Always metric. */
export interface WeatherReport {
  schemaVersion: 0;
  zoneId: string;
  dayOrdinal: number;
  hour?: number;

  temperature: { high: number; low: number; mean: number; current?: number };
  precipitation: { type: PrecipType; amountMm: number; intensity: number; active?: boolean };
  humidity: number;
  cloudCover: number;
  wind: { speedKph: number; directionDeg: number };
  visibilityKm: number;

  regime: string;
  conditions: string[];
  /** user-editable words: never switch on them */
  descriptors: { temperature: string; precipitation: string; wind: string; sky: string };

  overridden: boolean;
  provenance: Provenance;
}

/** `convert(report, units)`: unit suffixes dropped from key names. */
export interface ConvertedReport {
  schemaVersion: 0;
  zoneId: string;
  dayOrdinal: number;
  hour?: number;
  temperature: { high: number; low: number; mean: number; current?: number };
  humidity: number;
  cloudCover: number;
  regime: string;
  conditions: string[];
  descriptors: { temperature: string; precipitation: string; wind: string; sky: string };
  overridden: boolean;
  provenance: Provenance;
  units: Units;
  labels: { temperature: string; amount: string; speed: string; distance: string };
  precipitation: { type: PrecipType; amount: number; intensity: number; active?: boolean };
  wind: { speed: number; directionDeg: number };
  visibility: number;
}

// ---------------------------------------------------------------------------
// Classification and glyphs
// ---------------------------------------------------------------------------

/** India Meteorological Department 24-hour rainfall categories, on water-equivalent amountMm. */
export type PrecipitationClass = "none" | "very-light" | "light" | "moderate" | "heavy" | "very-heavy" | "extremely-heavy";
/** Met Office general-public visibility scale. */
export type VisibilityClass = "very-poor" | "poor" | "moderate" | "good" | "very-good" | "excellent";

export interface Classification {
  /** 0..12, WMO Beaufort force from wind.speedKph */
  beaufort: number;
  /** WMO name for the force ("Calm" ... "Hurricane force") */
  beaufortLabel: string;
  /** 16-point compass direction the wind blows from ("WSW") */
  compass: string;
  /** 0..8 WMO oktas from cloudCover */
  oktas: number;
  visibility: VisibilityClass;
  precipitation: PrecipitationClass;
  /** sleet or snow */
  frozenPrecipitation: boolean;
  /** apparent temperature, °C rounded to 0.1 */
  feelsLike: { mean: number; current?: number };
}

export type GlyphKey = "clear" | "partly-cloudy" | "cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "heavy-rain" | "sleet" | "snow" | "heavy-snow" | "windy";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export interface TimeContext {
  /** integer; days since the world epoch, may be negative */
  dayOrdinal: number;
  /** [0, 1) */
  yearPhase: number;
  yearLength: number;
  /** [0, 24) */
  hour?: number;
  dayOfYear?: number;
  year?: number;
  moons?: Array<{ name: string; phase: number }>;
  tags?: string[];
  /** a filler day the calendar's seasons skip: it reads as having no season, and its `season:` tag is the season around it, for weather */
  seasonless?: true;
  /** the adapter id */
  source: string;
}

export interface CalendarDescription {
  label: string;
  /** governs Wadjet's own editing UIs only; `canSetNow()` is separate */
  readOnly: boolean;
  yearLength: number;
  epochYear?: number;
  seasons: Array<{ name: string; from: number }>;
  moons: Array<{ name: string; cycleDays: number; phaseAtEpoch?: number; phases?: Array<{ name: string; at: number }> }>;
  editHint?: string;
}

/** A calendar plugin implements this and calls `registerTimeAdapter`. */
export interface TimeAdapter {
  id: string;
  now: () => TimeContext | null;
  /** MUST be O(1)/O(log n); MUST extrapolate (not throw) outside the calendar's defined range */
  toContext: (dayOrdinal: number) => TimeContext;
  configHash: () => string;
  parse?: (text: string) => number | null;
  format?: (dayOrdinal: number) => string;
  describe?: () => CalendarDescription;
  /** present = other plugins may move this calendar's current day through `setNow`/`advance` */
  setNow?: (dayOrdinal: number) => void | Promise<void>;
  /** call `cb` when the calendar's own current day changes; return an unsubscribe function */
  subscribe?: (cb: () => void) => () => void;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * `hex`: axial q, r in the map's own axial system. Map regions use
 * `{ kind: "custom", namespace: "<plugin>.region", data: { mapId, regionId } }`.
 */
export type ZoneLocator = { kind: "note"; path: string } | { kind: "hex"; mapId: string; q: number; r: number } | { kind: "point"; mapId: string; x: number; y: number } | { kind: "custom"; namespace: string; data: unknown };

/** At least one of `resolve` / `resolveAsync` is required. */
export interface ZoneResolver {
  id: string;
  kinds: ZoneLocator["kind"][];
  resolve?: (locator: ZoneLocator) => string | null;
  /** used by `resolveZoneAsync` only; 2000 ms budget */
  resolveAsync?: (locator: ZoneLocator) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Interpreters
// ---------------------------------------------------------------------------

export interface InterpretContext {
  zoneId: string;
  classification: Classification;
  /** `timeAt(report.dayOrdinal, report.zoneId)`, carrying `report.hour` */
  time: TimeContext;
  options?: Record<string, unknown>;
}

export interface WeatherInterpreter<T = unknown> {
  /** namespaced ("my-system.mood"); unique among live registrations */
  id: string;
  label: string;
  /** free-form grouping key */
  facet: string;
  description?: string;
  /** synchronous */
  interpret: (report: WeatherReport, ctx: InterpretContext) => T;
  /** one line of text for the code block's `interpret:` option */
  format?: (result: T) => string;
}

export interface InterpreterInfo {
  id: string;
  label: string;
  facet: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type WadjetEvent = "ready" | "profiles-changed" | "time-changed" | "adapters-changed" | "resolvers-changed" | "interpreters-changed" | "unload";

export interface ReadyPayload {
  readonly type: "ready";
}
export interface ProfilesChangedPayload {
  readonly type: "profiles-changed";
  /** every zone's weather may have moved (seed, eras, descriptor bands, or the active calendar's configuration changed) */
  readonly all: boolean;
  readonly zoneIds: readonly string[];
}
export interface TimeChangedPayload {
  readonly type: "time-changed";
  readonly current: number | null;
  readonly adapterId: string;
}
export interface AdaptersChangedPayload {
  readonly type: "adapters-changed";
}
export interface ResolversChangedPayload {
  readonly type: "resolvers-changed";
}
export interface InterpretersChangedPayload {
  readonly type: "interpreters-changed";
  readonly facet: string;
}
export interface UnloadPayload {
  readonly type: "unload";
}

export interface WadjetEventPayloads {
  ready: ReadyPayload;
  "profiles-changed": ProfilesChangedPayload;
  "time-changed": TimeChangedPayload;
  "adapters-changed": AdaptersChangedPayload;
  "resolvers-changed": ResolversChangedPayload;
  "interpreters-changed": InterpretersChangedPayload;
  unload: UnloadPayload;
}

// ---------------------------------------------------------------------------
// Seshat: calendar definitions (api.seshat, docs/API.md §1b, docs/CALENDARS.md)
// ---------------------------------------------------------------------------

export interface Rational {
  /** numerator, a safe integer */
  readonly n: number;
  /** denominator, a positive safe integer; n/d is in lowest terms */
  readonly d: number;
}

export type GearAst =
  | {
      readonly id: string;
      /** the unit whose occurrence index this gear reads */
      readonly on: string;
      readonly kind: "intervals";
      /** index n matches when Σ sign·[n ≡ offset mod every] is 1; the validator checks it is always 0 or 1 */
      readonly terms: ReadonlyArray<{ readonly every: number; readonly offset?: number; readonly sign: 1 | -1 }>;
    }
  | {
      readonly id: string;
      readonly on: string;
      readonly kind: "positions";
      readonly period: number;
      /** index n matches when (n − offset) mod period is listed */
      readonly positions: readonly number[];
      /** shifts the table, as an interval's offset does: a calendar whose years count from 1 has index n = year − 1, so offset −1 */
      readonly offset?: number;
    };

export interface SeasonMark {
  readonly name: string;
  readonly from: number;
}

/** A season that starts on day `day` of the year, 1-based (`MARK:Spring=DAY:80`). */
export interface DaySeasonMark {
  readonly name: string;
  readonly day: number;
}

/**
 * A season that starts on day `day` (1-based) of slot `index` (0-based, as
 * stored; the text prints index + the unit's NUMBER) of slot unit `unit`,
 * which sits directly in the seasons unit (`MARK:Spring=month:3.21`).
 */
export interface SlotSeasonMark {
  readonly name: string;
  readonly slot: { readonly unit: string; readonly index: number; readonly day: number };
}

export type DateSeasonMark = DaySeasonMark | SlotSeasonMark;
/** A stored season mark: a fraction of the year, or a date mark. */
export type SeasonMarkAst = SeasonMark | DateSeasonMark;

export type HostKey = "regime" | "chance";

export type RuleAst =
  | { readonly kind: "all"; readonly of: readonly RuleAst[] }
  | { readonly kind: "any"; readonly of: readonly RuleAst[] }
  | { readonly kind: "not"; readonly of: RuleAst }
  /** exactly one of unit / body */
  | { readonly kind: "phase"; readonly unit?: string; readonly body?: string; readonly from: number; readonly to: number; readonly name?: undefined }
  /** a body's named phase: stored form, resolved to the FROM/TO form above before evaluation and hashing */
  | { readonly kind: "phase"; readonly unit?: string; readonly body?: string; readonly name: string; readonly from?: undefined; readonly to?: undefined }
  | { readonly kind: "dayIn"; readonly unit: string; readonly from: number; readonly to: number }
  | { readonly kind: "index"; readonly unit: string; readonly from?: number; readonly to?: number }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "dates"; readonly days: readonly number[] }
  | ({ readonly kind: "recur" } & Recur)
  /** holds on day d when `of` holds on d − days; read off the day line, false */
  | { readonly kind: "shift"; readonly days: number; readonly of: RuleAst }
  /**
   * the first day matching `of` on or after an anchor day (`after`), within `within` days:
   * d holds when `of` holds on d and, scanning back j = 0 … within, an anchor comes before any earlier match
   */
  | { readonly kind: "first"; readonly within: number; readonly after: RuleAst; readonly of: RuleAst }
  /** answered by the caller (Wadjet's regime and chance), never by Seshat */
  | { readonly kind: "host"; readonly key: HostKey; readonly arg: string | number }
  /** a stored shape that could not be compiled: evaluating it rethrows the error */
  | { readonly kind: "throw"; readonly error: unknown };

/**
 * A recurrence: RRULE's vocabulary, not its
 * semantics. Day d matches when it lies in an occurrence k ≥ k0 of `freq` with
 * (k − k0) mod interval = 0 (k0 holds `anchor`; whole periods count, so the
 * anchor's own period matches from its first day), every `by` holds, d is one of
 * the `setpos` positions among its period's matching days, d ≤ `until`, and
 * at most `count` matching days precede it from the start of period k0.
 * `freq` "day" is every day (DAILY); any other id is a declared unit.
 */
export interface Recur {
  readonly freq: string;
  readonly interval?: number;
  readonly anchor?: number;
  readonly by?: readonly By[];
  readonly setpos?: readonly number[];
  readonly count?: number;
  readonly until?: number;
}

/**
 * - nth: d's occurrence of `unit` is the n-th (1-based; negative from the end)
 *   of those whose start day lies in d's period. A slot unit whose parent is
 *   the period's unit counts its declared slots, so a length-0 slot keeps its
 *   number (Adar I, absent in a common year, is still month 6).
 * - label: the label name of d's occurrence of `unit`, or "#tag" for a tag on it.
 * - day: d's 1-based day within its occurrence of `unit` (negative from the end).
 */
export type By =
  | { readonly unit: string; readonly nth: readonly number[] }
  | { readonly unit: string; readonly label: readonly string[] }
  | { readonly unit: string; readonly day: readonly number[] };

/** Add `add` days to a length when `gear` matches. */
export interface GearTerm {
  readonly gear: string;
  readonly add: number;
}

/**
 * A crossing base in its normalized form: crossing 0 falls at
 * instant `at` on this unit's civil day line (meridian and day start folded in
 * once), and one more every `period` days. Authoring forms compile to it: a
 * body reference resolves to `period` and `at` before validation,
 * compilation and hashing (resolve.ts).
 */
export type CrossingAst = LiteralCrossingAst | BodyCrossingAst;

interface CrossingCommon {
  /**
   * Read the crossing at a derived index instead of k: crossing
   * number floor((k·a + c) / L). Hebrew reads the molad at the months elapsed
   * before year k, floor((235k + 1) / 19).
   */
  readonly index?: { readonly a: number; readonly c: number; readonly L: number };
  /**
   * R1: the occurrence starts on the first day that begins at or after
   * the crossing instant (ceil), not the day holding it (floor, the default
   * `contains`, stored as absent). Resolves to `at + (L − 1)/L`.
   */
  readonly start?: "after";
}

/** A crossing written as numbers: `CROSSING:<period>@<at>`. */
export interface LiteralCrossingAst extends CrossingCommon {
  readonly period: Rational;
  readonly at: Rational;
  readonly body?: never;
}

/** A crossing that follows a body: `CROSSING:BODY=<id>;MARK=…`. Resolved once, at load. */
export interface BodyCrossingAst extends CrossingCommon {
  readonly body: BodyRef;
  readonly period?: never;
  readonly at?: never;
}

/**
 * A reference to a body: crossing k falls when the body's
 * phase passes `mark`, at `(mark − E)·P + offset + k·P` with the body's period
 * P and epoch E, renumbered by `k`. Defaults (offset 0, k 0) are absent.
 */
export interface BodyRef {
  readonly id: string;
  /** the body's phase at the crossing, in [0, 1) */
  readonly mark: Rational;
  /** a day shift of every crossing (a sunset day start); absent is 0 */
  readonly offset?: Rational;
  /** the crossing numbering shift, so moving the body's epoch keeps occurrence numbers (P1); absent is 0 */
  readonly k?: number;
}

/**
 * One stage (C4, §2.5): a shift of each start, chosen by the first rule that
 * matches, read off the stage below only (the base plus gear terms, or the
 * previous stage). No rule matching shifts by 0. A stage never reads its own
 * output, so it is never a fixpoint.
 */
export interface StageAst {
  readonly rules: readonly StageRule[];
}

export type StageRule =
  /** shift by `add` when the start below, minus `offset`, is in `in` mod `mod` (a weekday test); window [0, 0] */
  | { readonly add: number; readonly residue: { readonly mod: number; readonly offset?: number; readonly in: readonly number[] } }
  /** shift by `add` when occurrence k + `at` below is `is` days long; window [at, at + 1] */
  | { readonly add: number; readonly length: { readonly at: number; readonly is: number } };

interface RuleCommon {
  readonly gears?: readonly GearTerm[];
  /** layers over the base and its gear terms, applied in order */
  readonly stages?: readonly StageAst[];
}

/** A constant base: occurrence i starts on anchor + length·i, plus the gear terms. */
export interface ConstantRule extends RuleCommon {
  /** the day on which occurrence 0 starts (V1) */
  readonly anchor: number;
  /** base length in days; each gear term (on the unit) adds to it */
  readonly length: number;
  readonly crossing?: never;
}

/** A crossing base: occurrence k starts on the civil day holding crossing k, plus the gear terms. */
export interface CrossingRule extends RuleCommon {
  readonly crossing: CrossingAst;
  readonly anchor?: never;
  readonly length?: never;
}

/** A start rule: one base, its gear terms and stages. A ledger `switch` carries one. */
export type CycleRule = ConstantRule | CrossingRule;

interface CycleCommon {
  readonly id: string;
  readonly kind: "cycle";
  /** display number of occurrence 0 (default 0); display data, not part of the calendar's meaning */
  readonly number?: number;
  /** occurrence k carries labels[k mod labels.length] (C5, §2.6): modular weekday names, or one table over a cycle */
  readonly labels?: readonly LabelAst[];
  /** C6: rule switches, pinned starts and slot overrides, ordered by `from` (V7) */
  readonly ledger?: readonly LedgerEntry[];
  /** a slot unit directly under a cycle whose filler slots this unit does not count: a week that skips a festival. A ledger switch's anchor is then the day its `from` occurrence starts */
  readonly skips?: string;
}

export type ConstantCycleAst = ConstantRule & CycleCommon;
export type CrossingCycleAst = CrossingRule & CycleCommon;

/** A unit that never resets: its own start rule, and a ledger over it. */
export type CycleUnitAst = ConstantCycleAst | CrossingCycleAst;

/**
 * A ledger entry (C6, §2.7.1). Every entry is absolute: a switch's rule is
 * the same rule it would be alone, and pins name days, not offsets, so one
 * edit never moves the dates around it. Stages never read ledger data.
 */
export type LedgerEntry =
  /** from occurrence `from` on (until the next switch), this rule governs */
  | { readonly kind: "switch"; readonly from: number; readonly rule: CycleRule }
  /** occurrence `from` starts on `startsOn`; each length pins one more start after it (n lengths pin n + 1 starts) */
  | { readonly kind: "starts"; readonly from: number; readonly startsOn: number; readonly lengths?: readonly number[] }
  /**
   * in occurrence `from`, slot unit `unit` has exactly these lengths; `path` names the slot of each slot
   * unit between the cycle and `unit` (empty for a unit directly under the cycle). They must fill the parent.
   */
  | { readonly kind: "slots"; readonly from: number; readonly unit: string; readonly path?: readonly number[]; readonly lengths: readonly number[] };

/**
 * C5 Label: a display name, not hashed (as moon phase names are not),
 * and tags, which are hashed because they reach predicates and weather.
 */
export interface LabelAst {
  readonly name?: string;
  readonly tags?: readonly string[];
}

export interface SlotAst {
  /** display name; not hashed */
  readonly name?: string;
  /** hashed, like a label's tags */
  readonly tags?: readonly string[];
  /**
   * days, or "slack": a share of whatever the parent occurrence leaves over.
   * 0 means the slot is absent this time. Several slack slots each get their
   * `min`, then the rest is handed out in `fill` order, each up to its `max`.
   */
  readonly length: number | "slack" | KeyedLength;
  /** slack only: the fewest days this slot takes (default 0) */
  readonly min?: number;
  /** slack only: the most days this slot takes (default unbounded) */
  readonly max?: number;
  /** slack only: the order extra days are handed out in, lowest first; slots without one come after, ties in slot order */
  readonly fill?: number;
  /** gear terms read the index of the cycle the slot unit sits under */
  readonly gears?: readonly GearTerm[];
  /** belongs to the parent but to no child sequence: a festival day has no décade */
  readonly filler?: boolean;
}

/**
 * A slot length keyed on the length of the parent occurrence (C2): the Roman
 * February is 23 days in a 377-day year, 24 in a 378-day one. Ordered pairs,
 * so the hashed form is canonical; a parent length with no row is invalid.
 */
export interface KeyedLength {
  readonly by: "parent";
  readonly table: ReadonlyArray<readonly [parentLength: number, length: number]>;
}

/** A unit that resets with its parent and tiles each occurrence of the parent, except filler slots, with an ordered list of slots. */
export interface SlotsUnitAst {
  readonly id: string;
  readonly kind: "slots";
  /** display number of slot 0 (default 1); display data */
  readonly number?: number;
  /** the parent: a cycle unit, or a slot unit (a décade in a month) */
  readonly in: string;
  readonly slots: readonly SlotAst[];
}

export type UnitAst = CycleUnitAst | SlotsUnitAst;

/** A named or tagged day (C6 RDATE, §2.7.1): a one-off, such as a coronation. Its tags reach tagsAt. */
export interface DayLabelAst extends LabelAst {
  readonly day: number;
}

/**
 * A named rule (VRULE, docs/SESHAT-v0.md §3): every day it matches carries its
 * tags (a holiday). A rule may read a tag only named rules set (docs/SESHAT-v0.md
 * §16 D8): those reads must not form a cycle, which the validator refuses; a tag a
 * unit, slot, day label or season also sets is read from those alone. A BYSETPOS over a variable-length period past
 * 400 days, or a COUNT walk past 10⁶ days, passes validation and throws when
 * the rule runs, and then tagsAt throws for that day.
 */
export interface RuleDefAst {
  readonly id: string;
  readonly rule: RuleAst;
  readonly tags?: readonly string[];
  /** display name: what a format's `{@name}` prints on a day the rule holds; not hashed */
  readonly name?: string;
}

/**
 * A body (C1, §2.2): a clock with an exact rational period and its phase at
 * day 0 (`epoch`, a fraction of a turn). Rules read its phase (`phase body=`);
 * a crossing base keeps its own normalized period and offset and does not
 * reference a body.
 */
export interface BodyAst {
  readonly id: string;
  readonly period: Rational;
  readonly epoch: Rational;
  /** a body with a moon facet is one of the calendar's moons: its name is what predicates match (hashed); phases are display */
  readonly moon?: MoonAst;
}

/** A moon: `name` reaches predicates; `phases` name points of the cycle for display only (the Studio's { name, at }). */
export interface MoonAst {
  readonly name: string;
  readonly phases?: ReadonlyArray<{ readonly name: string; readonly at: number }>;
}

/** Seasons: marks over the phase of one cycle unit, with the legacy calendar's rule (seasonAtPhase); a mark may be a date. */
export interface SeasonsAst {
  readonly unit: string;
  readonly marks: readonly SeasonMarkAst[];
  /** a slot unit in `unit` whose filler slots have no season; weather still reads the season around them */
  readonly skips?: string;
}

/** A named format pattern: "default" formats a day, "filler" a day in a filler slot. Display data. */
export interface FormatAst {
  readonly name: string;
  readonly pattern: string;
}

export interface CalendarAst {
  readonly name: string;
  readonly formats?: readonly FormatAst[];
  readonly seasons?: SeasonsAst;
  readonly bodies?: readonly BodyAst[];
  readonly gears: readonly GearAst[];
  readonly units: readonly UnitAst[];
  readonly days?: readonly DayLabelAst[];
  readonly rules?: readonly RuleDefAst[];
}

export interface Problem {
  readonly message: string;
  /** the unit it is about; with `entry`, the cycle unit whose ledger holds the entry */
  readonly unit?: string;
  /** 0-based index into that unit's ledger */
  readonly entry?: number;
  readonly gear?: string;
  readonly body?: string;
  readonly rule?: string;
  /** 0-based index into the calendar's day labels */
  readonly day?: number;
  /** the rule it breaks in docs/SESHAT-v0.md §5 ("V3", "V7" …), when it names one; never part of `message` */
  readonly code?: string;
}

/** Where a day falls in one unit: the occurrence (a cycle's index, or a slot's index in its parent) and the days into it. */
export interface Position {
  readonly index: number;
  readonly offset: number;
}

export interface SeshatCalendarView {
  readonly name: string;
  /** the definition as canonical Seshat text */
  readonly text: string;
  /** the definition as stored: every unit, slot, gear, moon, season, format and rule. Frozen */
  readonly definition: CalendarAst;
  /** changes when anything that reaches a day, a tag, a year number, a moon or a match changes */
  readonly hash: string;

  /** the day on which occurrence `index` of cycle unit `unit` starts */
  start: (unit: string, index: number) => number;
  length: (unit: string, index: number) => number;
  /** the occurrence of cycle unit `unit` whose span holds `day`, also a filler day it skips */
  indexAt: (unit: string, day: number) => number;
  /** the occurrence of `unit` holding `day`; null when the day has no place in it (a filler day has no tenday). `start + length` is where the next one starts */
  occurrenceAt: (unit: string, day: number) => { readonly index: number; readonly start: number; readonly length: number } | null;
  /** like occurrenceAt, with the days into it: on a unit that skips filler days, only the days it counts */
  positionOf: (unit: string, day: number) => Position | null;
  /** the lengths of slot unit `unit` inside one parent occurrence; `path` names it from the cycle down: [year], or [year, month] */
  slotLengths: (unit: string, path: readonly number[]) => number[];
  /** the day `offset` days into slot `slot` of `unit`, inside the parent occurrence at `path` */
  dayOf: (unit: string, path: readonly number[], slot: number, offset: number) => number;
  labelAt: (unit: string, day: number) => LabelAst | null;
  /** every tag the day carries, from its units, day labels and named rules; a rule that throws loses only its own tags */
  tagsAt: (day: number) => string[];
  seasonAt: (day: number) => string | null;
  moonsAt: (day: number) => Array<{ name: string; phase: number }>;
  /** a body's phase in [0, 1), or undefined when there is no such body */
  bodyPhase: (body: string, day: number) => number | undefined;
  /** does `rule` hold on `day`? Throws RangeError for a rule that does not fit the calendar, including one that reads weather (a host leaf) */
  holds: (rule: RuleAst, day: number) => boolean;
  /** the day in the default format, or the named one (throws when the definition does not declare it) */
  format: (day: number, name?: string) => string;
  /** a bare day number, or a day in the definition's parseable formats; null when it is neither */
  parse: (text: string) => number | null;
}

export interface SeshatAPI {
  /** the definition the world runs; null when it runs another calendar or its stored definition cannot run */
  calendar: () => SeshatCalendarView | null;
  /** run any definition without touching the world, under the checks a world's calendar must pass */
  compile: (input: string | CalendarAst) => { calendar: SeshatCalendarView } | { problems: Problem[] };
  /** open the Studio with the calendar editor up, as the ruler's Calendar button does */
  openEditor: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// The API object
// ---------------------------------------------------------------------------

export interface WadjetAPI {
  version: string;
  apiVersion: 2;
  ready: boolean;
  schemaVersion: 0;
  generatorVersion: string;
  rngVersion: string;

  getReport: (zoneId: string, time?: TimeContext | { dayOrdinal: number; hour?: number }) => WeatherReport;
  getRange: (zoneId: string, fromDay: number, toDay: number) => WeatherReport[];
  now: () => TimeContext | null;
  listZones: () => Array<{ id: string; name: string }>;
  timeAt: (dayOrdinal: number, zoneId?: string) => TimeContext;
  format: (dayOrdinal: number) => string;
  parse: (text: string) => number | null;

  canSetNow: () => boolean;
  setNow: (dayOrdinal: number) => Promise<boolean>;
  advance: (days: number) => Promise<boolean>;

  registerTimeAdapter: (adapter: TimeAdapter) => () => void;
  registerZoneResolver: (resolver: ZoneResolver) => () => void;
  resolveZone: (locator: ZoneLocator) => string | null;
  resolveZoneAsync: (locator: ZoneLocator) => Promise<string | null>;

  calendar: () => CalendarDescription | null;
  listTimeAdapters: () => Array<{ id: string; label: string; active: boolean }>;

  describe: (report: WeatherReport, style?: "short" | "prose") => string;
  units: () => Units;
  convert: (report: WeatherReport, units?: Units) => ConvertedReport;

  classify: (report: WeatherReport) => Classification;
  glyphKey: (report: WeatherReport) => GlyphKey;
  glyph: (keyOrReport: GlyphKey | WeatherReport, opts?: { size?: number; title?: string }) => string;

  registerInterpreter: (interpreter: WeatherInterpreter) => () => void;
  listInterpreters: (facet?: string) => InterpreterInfo[];
  getInterpreter: (id: string) => WeatherInterpreter | null;
  interpret: <T = unknown>(id: string, report: WeatherReport, options?: Record<string, unknown>) => T;

  seshat: SeshatAPI;

  on: <E extends WadjetEvent>(event: E, cb: (payload: WadjetEventPayloads[E]) => void) => () => void;
}
