/**
 * The studio's state shape: the drafts every editing surface mutates, the saved
 * copy they are compared against, and the view state.
 *
 * The per-zone / world split is the contract in SPEC §2: switching zones swaps
 * every *zone* row, world rows stay. Two consequences the whole studio leans on:
 *
 *  - **The zone draft IS a `ZoneProfile`** (PLAN §0.1, L2). A deep copy of the
 *    saved profile, edited in place by the windows. "Layers" (`layer:*` /
 *    `forcings:*` modifiers) and `automation[]` are *views* over that profile,
 *    read and written by `compile.ts`; there is no second representation to keep
 *    in sync.
 *  - **View state is not part of the document.** It is never persisted in the
 *    schema (D14), never compared for dirtiness, and never restored by undo.
 *
 * Pure: no Obsidian imports (PLAN D3). `structuredClone` is available in
 * Obsidian's Electron renderer and in Bun.
 */
import type { Override } from "../../core/report";
import type { Era, ZoneProfile } from "../../core/types";
import type { DevicePreset, InternalCalendarConfig } from "../../plugin/settings";

/** The world-scoped slice of settings: everything a world edit touches (`world · N zones`). */
export interface WorldDraft {
  eras: Era[];
  calendar: { seasons: InternalCalendarConfig["seasons"]; moons: InternalCalendarConfig["moons"] };
  devicePresets: DevicePreset[];
  overrides: Override[];
}

/** Not persisted in the schema; lives in the leaf's `getState()/setState()` (D14). */
export interface ViewState {
  /** the zone the surfaces are pointed at; `null` when the world has no zones */
  zoneId: string | null;
  /** the playlist window in fractional years */
  window: { a: number; b: number };
  /** ids of the open floating windows, oldest first (z-order = array order) */
  openWindows: string[];
  windowPos: Record<string, { x: number; y: number; z: number }>;
  /** palette indices, by list position, for seasons / eras / regimes */
  colours: { seasons: number[]; eras: number[]; regimes: number[] };
  jsonOpen: boolean;
  /** per-chain expansion of the mixer's fixed strip (Regimes / Forcings) */
  fixedOpen: Record<string, boolean>;
  /** bumped by the audition's re-roll; never touches the world seed (PLAN §5.1) */
  rerollSalt: number;
}

export interface StudioState {
  /** drafts by zone id — each one a `ZoneProfile`, edited in place */
  zones: Record<string, ZoneProfile>;
  /** the last-saved copy every dirty check compares against */
  saved: { zones: Record<string, ZoneProfile>; world: WorldDraft };
  world: WorldDraft;
  view: ViewState;
}

/** The slice of `WadjetSettings` the studio opens on. `WadjetSettings` satisfies it. */
export interface StudioSettingsLike {
  zones: ZoneProfile[];
  eras: Era[];
  calendar: { seasons: InternalCalendarConfig["seasons"]; moons: InternalCalendarConfig["moons"] };
  devicePresets?: DevicePreset[];
  overrides: Override[];
}

/** One year, starting at the world's year 1 — the "Year" zoom preset. */
export const DEFAULT_WINDOW = { a: 0, b: 1 } as const;

export function defaultView(zoneId: string | null): ViewState {
  return {
    zoneId,
    window: { ...DEFAULT_WINDOW },
    openWindows: [],
    windowPos: {},
    colours: { seasons: [], eras: [], regimes: [] },
    jsonOpen: false,
    fixedOpen: {},
    rerollSalt: 0,
  };
}

/**
 * Open the studio on a copy of the settings. Everything is deep-copied twice —
 * once into the drafts, once into `saved` — so no surface can write through to
 * the plugin's settings object, and `saved` never moves under an edit.
 *
 * `zoneId` is honoured only when a zone with that id exists; otherwise the view
 * opens with no zone selected, so a surface can never point at a missing draft.
 * Duplicate zone ids collapse (last one wins), matching `settings.zones` lookup.
 */
export function initialState(settingsLike: StudioSettingsLike, zoneId: string | null): StudioState {
  const zones: Record<string, ZoneProfile> = {};
  for (const z of structuredClone(settingsLike.zones)) zones[z.id] = z;
  const world = structuredClone<WorldDraft>({
    eras: settingsLike.eras,
    calendar: { seasons: settingsLike.calendar.seasons, moons: settingsLike.calendar.moons },
    devicePresets: settingsLike.devicePresets ?? [],
    overrides: settingsLike.overrides,
  });
  const saved = structuredClone({ zones, world });
  return { zones, saved, world, view: defaultView(zoneId !== null && zoneId in zones ? zoneId : null) };
}
