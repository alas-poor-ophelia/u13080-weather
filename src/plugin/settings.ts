/**
 * Persisted plugin state (data.json). Pure: no Obsidian imports.
 *
 * History policy (DESIGN-v1.md §6): the world pins `generatorVersion`; the
 * plugin refuses to silently run a newer generator on an older world.
 */
import type { Override } from "../core/report";
import type { DescriptorBands } from "../core/report";
import type { ZoneProfile } from "../core/types";
import { GENERATOR_VERSION } from "../core/version";

export interface MoonConfig {
  name: string;
  cycleDays: number;
  /** phase at day 0 of the world, [0,1) */
  phaseAtEpoch: number;
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
  zones: ZoneProfile[];
  overrides: Override[];
  bands?: DescriptorBands;
  units: "metric" | "imperial";
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
  zones: [],
  overrides: [],
  units: "metric",
};

/** A seed that is random once and then fixed forever for this world. */
export function freshSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Merge loaded data over defaults; fill a seed if missing. Returns a new object. */
export function migrateSettings(raw: unknown): WadjetSettings {
  const r = (raw ?? {}) as Partial<WadjetSettings>;
  const s: WadjetSettings = {
    ...DEFAULT_SETTINGS,
    ...r,
    calendar: { ...DEFAULT_SETTINGS.calendar, ...(r.calendar ?? {}) },
    zones: Array.isArray(r.zones) ? r.zones : [],
    overrides: Array.isArray(r.overrides) ? r.overrides : [],
  };
  if (!s.worldSeed) s.worldSeed = freshSeed();
  if (!s.generatorVersion) s.generatorVersion = GENERATOR_VERSION;
  return s;
}

/** The world was created under a different generator: only an explicit upgrade may change this. */
export function generatorMismatch(s: WadjetSettings): boolean {
  return s.generatorVersion !== GENERATOR_VERSION;
}
