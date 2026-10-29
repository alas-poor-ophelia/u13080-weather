/**
 * The leaf-close stash (bead wadjet-9f9.36).
 *
 * Obsidian cannot cancel `ItemView.onClose` — there is no "are you sure"
 * hook — so a dirty draft would silently vanish the moment a leaf closes
 * (tab drag to another split, `leaf.detach()`, `Ctrl+W`, …). Instead the
 * *dirty* drafts are lifted onto the plugin instance as plain in-memory state
 * (`plugin.studioStash`, never persisted to `data.json`) and reapplied the
 * next time a `StudioView` is constructed in the same session. A restart
 * loses the stash exactly like any other in-memory state — the drafts were
 * never saved, so that is correct, not a bug.
 *
 * Both halves are pure (PLAN D3: no Obsidian imports) so the merge is
 * unit-tested without a leaf, a store scheduler or a plugin instance.
 */
import type { ZoneProfile } from "../../core/types";
import { canonicalJson } from "../../core/profile";
import type { CalendarSource, StudioState, WorldDraft } from "./state";
import type { Store } from "./store";
import { seatOn } from "./definition";

/** What survives a leaf close: dirty zone drafts, and the world draft iff it is dirty. */
export interface StudioStash {
  zones: Record<string, ZoneProfile>;
  world?: WorldDraft;
  /** the stored calendar the stashed world draft was last loaded or saved from, and its source */
  calendarBase?: WorldDraft["calendar"];
  calendarSource?: CalendarSource;
}

/**
 * Read the stash off a store's current state, or `null` when nothing is
 * dirty (the common case — most closes have nothing to keep). Only the
 * `dirtyZones()` / `worldDirty()` subset of `Store` is used, so a caller can
 * pass anything that shape-matches.
 */
export function takeStash(state: StudioState, store: Pick<Store, "dirtyZones" | "worldDirty">): StudioStash | null {
  const dirty = store.dirtyZones();
  const worldDirty = store.worldDirty();
  if (dirty.size === 0 && !worldDirty) return null;

  const zones: Record<string, ZoneProfile> = {};
  for (const id of dirty) {
    const draft = state.zones[id];
    if (draft !== undefined) zones[id] = structuredClone(draft);
  }
  const stash: StudioStash = { zones };
  if (worldDirty) {
    stash.world = structuredClone(state.world);
    if (state.calendarBase) stash.calendarBase = structuredClone(state.calendarBase);
    stash.calendarSource = state.calendarSource ?? "legacy";
  }
  return stash;
}

/**
 * Apply a stash over a freshly built state (`initialState`'s output):
 * stashed zone drafts replace their entries, the stashed world draft — if
 * present — replaces the whole world draft. `state.saved` is left alone, so
 * the reapplied drafts still read as dirty against the file on disk.
 *
 * **A stashed zone whose id is no longer in `state.zones` is dropped**
 * (bead wadjet-9f9.45). `state.zones` is what `initialState` built from
 * `plugin.settings`, so an id missing from it is a zone deleted from settings
 * between the close and the reopen — Settings → Zones → remove, another
 * vault window, a hand-edited `data.json`. Re-adding it would resurrect a
 * phantom: a draft in the zone menu and the JSON drawer with no settings row
 * behind it, which `commit()` then silently refuses to write (it looks the id
 * up in `settings.zones` and skips what it cannot find), so the user would be
 * editing a zone that can never be saved.
 */
export function applyStash(state: StudioState, stash: StudioStash): StudioState {
  const zones = { ...state.zones };
  for (const [id, draft] of Object.entries(stash.zones)) {
    if (!(id in zones)) continue;
    zones[id] = structuredClone(draft);
  }
  if (stash.world === undefined) return { ...state, zones };
  const world = structuredClone(stash.world);
  // An untouched stashed calendar takes the calendar stored now (the draft's "last loaded" is reset to it). An
  // edited one stays, with the stored calendar it was edited over as its base: when storage differs from that now,
  // a Save asks whether to overwrite it or reload (definition.ts planCalendarSave).
  const untouched = stash.calendarBase !== undefined && canonicalJson(stash.world.calendar) === canonicalJson(stash.calendarBase);
  if (untouched) return { ...state, zones, world: { ...world, calendar: structuredClone(state.world.calendar) } };
  let calendarBase = stash.calendarBase ? structuredClone(stash.calendarBase) : undefined;
  // A Seshat draft stashed by a build before the AST layer (docs/SESHAT-v0.md §18.6 item 4) is seated on the
  // definition stored now (seatOn): a part it never touched is re-read from that definition, in the draft and its
  // base, so the fields and the layer show one calendar.
  const seed = state.world.calendar.ast;
  const sameSource = (stash.calendarSource ?? "legacy") === (state.calendarSource ?? "legacy");
  if ((stash.calendarSource ?? "legacy") === "seshat" && sameSource && seed && world.calendar.ast === undefined && calendarBase?.ast === undefined) {
    const seated = seatOn(world.calendar, calendarBase ?? state.calendarBase ?? state.saved.world.calendar, seed);
    world.calendar = seated.draft;
    calendarBase = seated.base;
  }
  return { ...state, zones, world, ...(calendarBase ? { calendarBase } : {}), calendarSource: stash.calendarSource ?? "legacy" };
}
