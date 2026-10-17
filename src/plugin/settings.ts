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

/**
 * The internal calendar's moons, repaired so the plugin always loads: a
 * `moons` that is not a list becomes the default list; a moon whose cycle is
 * not a positive finite number gets the default cycle, and a non-finite epoch
 * phase becomes 0. Each repair is reported through `warn`. Valid moons are
 * returned as they were (an epoch phase outside [0, 1) is valid: the calendar
 * reduces it exactly), so their config hash does not move.
 */
function sanitizeMoons(moons: unknown, warn: (msg: string) => void): MoonConfig[] {
  if (!Array.isArray(moons)) {
    warn("The calendar's moons were not a list, so the default moon was used.");
    return DEFAULT_SETTINGS.calendar.moons.map((m) => ({ ...m }));
  }
  return moons.map((raw: unknown, i) => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Partial<MoonConfig>;
    const name = typeof m.name === "string" && m.name ? m.name : `Moon ${i + 1}`;
    const fixed: MoonConfig = { ...m, name, cycleDays: m.cycleDays as number, phaseAtEpoch: m.phaseAtEpoch as number };
    if (typeof m.cycleDays !== "number" || !Number.isFinite(m.cycleDays) || m.cycleDays <= 0) {
      warn(`Moon "${name}" had no usable cycle length, so it was set to ${DEFAULT_MOON.cycleDays} days.`);
      fixed.cycleDays = DEFAULT_MOON.cycleDays;
    }
    if (typeof m.phaseAtEpoch !== "number" || !Number.isFinite(m.phaseAtEpoch)) {
      warn(`Moon "${name}" had no usable phase at day 0, so it was set to 0.`);
      fixed.phaseAtEpoch = 0;
    }
    return fixed;
  });
}

/** Merge loaded data over defaults; fill a seed if missing; repair broken moons (reported through `warn`). Returns a new object. */
export function migrateSettings(raw: unknown, warn: (msg: string) => void = () => {}): WadjetSettings {
  const r = (raw ?? {}) as Partial<WadjetSettings>;
  const calendar = { ...DEFAULT_SETTINGS.calendar, ...(r.calendar ?? {}) };
  const s: WadjetSettings = {
    ...DEFAULT_SETTINGS,
    ...r,
    calendar: { ...calendar, moons: sanitizeMoons(calendar.moons, warn) },
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
