/**
 * Persisted plugin state (data.json). Pure: no Obsidian imports.
 *
 * History policy (DESIGN-v1.md §6): `generatorVersion` is the generator this
 * world last accepted. Only the current generator ships; a mismatch is shown
 * to the user (Notice + settings) until they acknowledge it.
 */
import type { Override } from "../core/report";
import type { DescriptorBands } from "../core/report";
import type { Era, ModifierOp, Predicate, Regime, SpellSpec, ZoneProfile } from "../core/types";
import { GENERATOR_VERSION } from "../core/version";

export interface MoonConfig {
  name: string;
  cycleDays: number;
  /** phase at day 0 of the world, [0,1) */
  phaseAtEpoch: number;
  /** named phase boundaries for display/UI (PLAN §2.2): ascending `at`, unique names, at ∈ [0,1). Not part of configHash — display metadata only. */
  phases?: Array<{ name: string; at: number }>;
}

/** A studio device preset: a modifier shape a rack row can be seeded from. */
export interface DevicePreset {
  name: string;
  kind: "trim" | "moon" | "spell" | "tag" | "chance";
  when?: Predicate;
  spell?: SpellSpec;
  apply: ModifierOp[];
  /** mirrors core ModGate (bead wadjet-9f9.2) */
  mods?: Array<{ source: string; amount: number }>;
  /** display flag, mirrors `Modifier.badge` — a preset saved from a curse stays one (PLAN D17) */
  badge?: "curse";
}

/**
 * A studio regime preset: a whole set of the zone's weather states, saved from
 * the Regimes window's `preset ▾` and loadable over any zone (SPEC §3.4).
 * Unlike a `DevicePreset` this is not a shape with instance fields stripped —
 * `regimes[]` has no instance identity, so the set travels verbatim.
 */
export interface RegimePreset {
  name: string;
  regimes: Regime[];
}

export interface InternalCalendarConfig {
  /** days in a year */
  yearLength: number;
  /** dayOrdinal 0 is day 1 of this year */
  epochYear: number;
  moons: MoonConfig[];
  /** optional season labels: yearPhase start → name (becomes a tag) */
  seasons: Array<{ name: string; from: number }>;
}

export interface WadjetSettings {
  settingsVersion: 1;
  worldSeed: string;
  generatorVersion: string;
  /** which time adapter supplies `now()`; "internal" or a registered adapter id */
  activeTimeAdapter: string;
  /** the internal calendar's current day */
  currentDayOrdinal: number;
  calendar: InternalCalendarConfig;
  /** the era timeline (world-level; applies under any calendar) */
  eras: Era[];
  zones: ZoneProfile[];
  overrides: Override[];
  bands?: DescriptorBands;
  units: "metric" | "imperial";
  /** studio device presets (rack row seeds), PLAN §2 */
  devicePresets?: DevicePreset[];
  /** studio regime presets (saved state sets), SPEC §3.4 */
  regimePresets?: RegimePreset[];
}

export const DEFAULT_SETTINGS: WadjetSettings = {
  settingsVersion: 1,
  worldSeed: "",
  generatorVersion: GENERATOR_VERSION,
  activeTimeAdapter: "internal",
  currentDayOrdinal: 0,
  calendar: {
    yearLength: 365,
    epochYear: 1,
    moons: [{ name: "Moon", cycleDays: 29.53, phaseAtEpoch: 0 }],
    seasons: [],
  },
  eras: [],
  zones: [],
  overrides: [],
  units: "metric",
  devicePresets: [],
  regimePresets: [],
};

/** A seed that is random once and then fixed forever for this world. */
export function freshSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const DEFAULT_MOON = DEFAULT_SETTINGS.calendar.moons[0]!;

/** A stored value as a person would read it in a repair message: strings quoted, NaN as NaN, long values cut short. */
function shown(v: unknown): string {
  if (v === undefined) return "nothing";
  if (typeof v === "number") return String(v);
  const text = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? `a ${typeof v}`);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * The internal calendar's moons, repaired so the plugin always loads: a
 * `moons` that is not a list becomes the default list; a moon whose cycle is
 * not a positive finite number gets the default cycle, a non-finite epoch
 * phase becomes 0, and a `phases` that is not a list is dropped. Each repair
 * is reported through `warn`. A cycle stored as a numeric string ("30") is
 * read as that number without a warning: the old arithmetic coerced it, so
 * that moon always worked. Valid moons are returned as they were (an epoch
 * phase outside [0, 1) is valid: the calendar reduces it exactly).
 */
function sanitizeMoons(moons: unknown, warn: (msg: string) => void): MoonConfig[] {
  if (!Array.isArray(moons)) {
    warn(`The calendar's moons were ${shown(moons)}, not a list, so the default moon was used.`);
    return DEFAULT_SETTINGS.calendar.moons.map((m) => ({ ...m }));
  }
  return moons.map((raw: unknown, i) => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Partial<MoonConfig>;
    const name = typeof m.name === "string" && m.name ? m.name : `Moon ${i + 1}`;
    const stored: unknown = m.cycleDays;
    const cycle: unknown = typeof stored === "string" && stored.trim() !== "" ? Number(stored) : stored;
    const fixed: MoonConfig = { ...m, name, cycleDays: cycle as number, phaseAtEpoch: m.phaseAtEpoch as number };
    if (typeof cycle !== "number" || !Number.isFinite(cycle) || cycle <= 0) {
      warn(`Moon "${name}" had a cycle of ${shown(stored)} days, which is not usable, so it was set to ${DEFAULT_MOON.cycleDays}.`);
      fixed.cycleDays = DEFAULT_MOON.cycleDays;
    }
    if (typeof m.phaseAtEpoch !== "number" || !Number.isFinite(m.phaseAtEpoch)) {
      warn(`Moon "${name}" had a phase at day 0 of ${shown(m.phaseAtEpoch)}, which is not usable, so it was set to 0.`);
      fixed.phaseAtEpoch = 0;
    }
    if (m.phases !== undefined && !Array.isArray(m.phases)) {
      warn(`Moon "${name}" had named phases of ${shown(m.phases)}, which are not readable, so they were removed.`);
      delete fixed.phases;
    }
    return fixed;
  });
}

/**
 * The year length, repaired only where the calendar could not use it: 0, a
 * negative number, NaN, or something that is not a number gives NaN phases,
 * so it becomes 365 (reported). A numeric string ("400") is read as its
 * number. Anything else the calendar already handled (a fractional year, a
 * year longer than the settings row allows) is left alone: those worlds work.
 */
function sanitizeYearLength(v: unknown, warn: (msg: string) => void): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  warn(`The calendar's days-in-a-year was ${shown(v)}, which is not usable, so it was set to ${DEFAULT_SETTINGS.calendar.yearLength}.`);
  return DEFAULT_SETTINGS.calendar.yearLength;
}

/**
 * The epoch year. A string (even "1") made every year a string ("1" gave year
 * "21"), and NaN gave no year at all: both are repaired and reported, a numeric
 * string to its number, anything else to 1. `null` already behaved as 0, so
 * it becomes 0 without a report.
 */
function sanitizeEpochYear(v: unknown, warn: (msg: string) => void): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v === null) return 0;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  const fixed = Number.isFinite(n) ? n : DEFAULT_SETTINGS.calendar.epochYear;
  warn(`The calendar's first year was ${shown(v)}, not a number, so it was set to ${fixed}.`);
  return fixed;
}

/** Merge loaded data over defaults; fill a seed if missing; repair a broken calendar (reported through `warn`). Returns a new object. */
export function migrateSettings(raw: unknown, warn: (msg: string) => void = () => {}): WadjetSettings {
  const r = (raw ?? {}) as Partial<WadjetSettings>;
  const calendar: InternalCalendarConfig = { ...DEFAULT_SETTINGS.calendar, ...(r.calendar ?? {}) };
  // each message names the value it replaced: the plugin saves on load, so the message is where the old value survives
  const moons = sanitizeMoons(calendar.moons, warn);
  const yearLength = sanitizeYearLength(calendar.yearLength, warn);
  const epochYear = sanitizeEpochYear(calendar.epochYear, warn);
  const s: WadjetSettings = {
    ...DEFAULT_SETTINGS,
    ...r,
    calendar: { ...calendar, yearLength, epochYear, moons },
    eras: Array.isArray(r.eras) ? r.eras : [],
    zones: Array.isArray(r.zones) ? r.zones : [],
    overrides: Array.isArray(r.overrides) ? r.overrides : [],
    devicePresets: Array.isArray(r.devicePresets) ? r.devicePresets : [],
    regimePresets: Array.isArray(r.regimePresets) ? r.regimePresets : [],
  };
  if (!s.worldSeed) s.worldSeed = freshSeed();
  if (!s.generatorVersion) s.generatorVersion = GENERATOR_VERSION;
  return s;
}

/** The world last accepted a different generator: shown to the user until they acknowledge it. */
export function generatorMismatch(s: WadjetSettings): boolean {
  return s.generatorVersion !== GENERATOR_VERSION;
}
