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
import type { StudioState, WorldDraft } from "./state";
import type { Store } from "./store";

/** What survives a leaf close: dirty zone drafts, and the world draft iff it is dirty. */
export interface StudioStash {
  zones: Record<string, ZoneProfile>;
  world?: WorldDraft;
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
  if (worldDirty) stash.world = structuredClone(state.world);
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
  const world = stash.world === undefined ? state.world : structuredClone(stash.world);
  return { ...state, zones, world };
}
