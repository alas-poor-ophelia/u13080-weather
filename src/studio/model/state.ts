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
import type { DevicePreset, InternalCalendarConfig, RegimePreset } from "../../plugin/settings";
import type { LedgerForm, MonthForm, YearForm } from "../../plugin/time/form";
import type { OrreryTheme } from "./orrery-transport";

/** The world-scoped slice of settings: everything a world edit touches (`world · N zones`). */
export interface WorldDraft {
  eras: Era[];
  calendar: CalendarDraftShape;
  devicePresets: DevicePreset[];
  /** saved state sets, offered by the Regimes window's `preset ▾` (SPEC §3.4) */
  regimePresets: RegimePreset[];
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
  /** the Orrery's scope look, per Studio view (docs/SESHAT-v0.md §18.4 Q2); absent: phosphor with scanlines */
  orrery?: { theme: OrreryTheme; scanlines: boolean };
}

export interface StudioState {
  /** drafts by zone id — each one a `ZoneProfile`, edited in place */
  zones: Record<string, ZoneProfile>;
  /** the last-saved copy every dirty check compares against */
  saved: { zones: Record<string, ZoneProfile>; world: WorldDraft };
  world: WorldDraft;
  view: ViewState;
  /**
   * The calendar the world draft was seeded from or last saved as. Not part
   * of undo or the dirty check: a Save on a Seshat world compares it with the
   * stored definition to refuse overwriting an edit made outside the studio
   * (docs/SESHAT-v0.md §13.11 B3). Absent in hand-built states: `saved` stands in.
   */
  calendarBase?: WorldDraft["calendar"];
  /** where the world draft's calendar came from (absent: "legacy"); travels with `calendarBase` */
  calendarSource?: CalendarSource;
}

/**
 * Which calendar the world draft's `{ seasons, moons }` came from: the internal
 * calendar's fields, a running Seshat definition, or a definition that cannot
 * run (nothing to edit). A draft from one source is never saved into another.
 */
export type CalendarSource = "legacy" | "seshat" | "fault";

/**
 * A moon in the draft. On a world that runs a definition, `id` is its body's
 * id, so a rename keeps the body (its exact period, the rules that read it);
 * absent on the legacy calendar and on a moon the draft adds (wadjet-dea).
 */
export type DraftMoon = InternalCalendarConfig["moons"][number] & { id?: string };

/**
 * The parts of a definition the form model reads as fields (docs/SESHAT-v0.md
 * §15.3), as the draft holds them. A part that is text on the stored
 * definition is absent, so it is never an edit; absent on the legacy calendar.
 */
export interface FormDraft {
  name?: string;
  year?: YearForm;
  months?: readonly MonthForm[] | null;
  week?: readonly string[] | null;
  /** the ledger: one-off corrections, marked days and skipped days (§15.5) */
  ledger?: LedgerForm;
}

/** The world draft's calendar: seasons and moons as every window reads them, and the definition's other fields. */
export interface CalendarDraftShape {
  seasons: InternalCalendarConfig["seasons"];
  moons: DraftMoon[];
  form?: FormDraft;
}

/** The slice of `WadjetSettings` the studio opens on. `WadjetSettings` satisfies it. */
export interface StudioSettingsLike {
  zones: ZoneProfile[];
  eras: Era[];
  calendar: CalendarDraftShape;
  /** absent: "legacy" */
  calendarSource?: CalendarSource;
  devicePresets?: DevicePreset[];
  regimePresets?: RegimePreset[];
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
    calendar: { seasons: settingsLike.calendar.seasons, moons: settingsLike.calendar.moons, ...(settingsLike.calendar.form ? { form: settingsLike.calendar.form } : {}) },
    devicePresets: settingsLike.devicePresets ?? [],
    regimePresets: settingsLike.regimePresets ?? [],
    overrides: settingsLike.overrides,
  });
  const saved = structuredClone({ zones, world });
  return { zones, saved, world, view: defaultView(zoneId !== null && zoneId in zones ? zoneId : null), calendarBase: structuredClone(world.calendar), calendarSource: settingsLike.calendarSource ?? "legacy" };
}
