/**
 * The studio's store (PLAN D11): one owned `StudioState`, mutated in place,
 * with batched notification, per-zone dirty tracking and a bounded undo stack.
 *
 * Three rules the surfaces depend on:
 *
 *  - **The store owns the state.** `update(fn)` hands the live object to `fn`,
 *    which mutates it — no copy per keystroke, so a knob drag is free. Nobody
 *    outside holds a reference across a tick; `get()` is for reading now.
 *  - **One notification per tick.** Subscribers re-render their own subtree, so
 *    a drag that fires twenty updates in a frame must wake them once. The
 *    scheduler is injected (`queueMicrotask` in production, a collector in the
 *    tests) so batching is assertable.
 *  - **Undo covers the drafts, never the view** (PLAN §0.1, L2). Undoing a knob
 *    must not close a window or move the playlist.
 *
 * Snapshots are commits, not pre-images: callers `snapshot()` at pointer-up and
 * the store pushes the state as it stood at the *previous* commit, so one drag
 * costs one undo step. A snapshot with nothing changed since the last one is
 * dropped, so a click that only opens a window never eats an undo step.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { canonicalJson } from "../../core/profile";
import { hash32 } from "../../core/rng";
import type { ZoneProfile } from "../../core/types";
import type { StudioState, WorldDraft } from "./state";

/** How many undo steps are kept. Older steps fall off the bottom. */
export const MAX_HISTORY = 100;

export interface Store {
  /** The live state. Read it now; do not hold it across a tick. */
  get(): StudioState;
  /**
   * Mutate the state in place. `history: true` marks the call an undoable
   * action: the drafts as they stood before `fn` ran become an undo step
   * (skipped when `fn` leaves the drafts unchanged). Default `false` — drag
   * handlers update freely and call `snapshot()` at pointer-up.
   */
  update(fn: (draft: StudioState) => void, opts?: { history?: boolean }): void;
  /** Close the current undo step. Cheap and idempotent when nothing changed. */
  snapshot(): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Batched: at most one call per scheduler tick. Returns the unsubscribe. */
  subscribe(cb: (s: StudioState) => void): () => void;
  /** Zone ids whose draft differs from the saved copy (added and removed zones count). */
  dirtyZones(): Set<string>;
  worldDirty(): boolean;
  /** The drafts became the saved copy. Undo history survives a save. */
  markSaved(): void;
  /** Point the view at another zone. Every zone keeps its own draft. */
  setZone(zoneId: string): void;
}

/** The undoable half of the state: drafts only, never `saved`, never `view`. */
interface Drafts {
  zones: Record<string, ZoneProfile>;
  world: WorldDraft;
}

interface HistoryEntry {
  drafts: Drafts;
  /** identity of `drafts`, so undo/redo never re-canonicalises */
  hash: string;
}

/**
 * A cheap identity for the drafts: canonical JSON hashed with the two frozen
 * seeds `profileHash` uses, plus the length, so a collision needs three
 * coincidences at once. Only ever compared against another draft hash.
 */
function draftsHash(s: StudioState): string {
  const j = canonicalJson({ zones: s.zones, world: s.world });
  return `${hash32(j, 0x57414a45).toString(16)}${hash32(j, 0x54454a49).toString(16)}:${j.length.toString(16)}`;
}

function cloneDrafts(s: StudioState): Drafts {
  return structuredClone({ zones: s.zones, world: s.world });
}

export function createStore(initial: StudioState, schedule: (flush: () => void) => void = (f) => queueMicrotask(f)): Store {
  const state = initial;
  const subs = new Set<(s: StudioState) => void>();
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  /** the drafts as of the last commit, and their hash */
  let baseline: Drafts = cloneDrafts(state);
  let baselineHash = draftsHash(state);
  let pending = false;

  function flush(): void {
    if (!pending) return;
    pending = false;
    for (const cb of [...subs]) cb(state);
  }

  function notify(): void {
    if (pending) return;
    pending = true;
    schedule(flush);
  }

  function pushUndo(entry: HistoryEntry): void {
    undoStack.push(entry);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function currentEntry(): HistoryEntry {
    return { drafts: cloneDrafts(state), hash: draftsHash(state) };
  }

  /** The entry's drafts become the live drafts and the new baseline. */
  function restore(entry: HistoryEntry): void {
    state.zones = structuredClone(entry.drafts.zones);
    state.world = structuredClone(entry.drafts.world);
    baseline = entry.drafts;
    baselineHash = entry.hash;
  }

  function snapshot(): void {
    const h = draftsHash(state);
    if (h === baselineHash) return;
    pushUndo({ drafts: baseline, hash: baselineHash });
    baseline = cloneDrafts(state);
    baselineHash = h;
  }

  return {
    get: () => state,

    update(fn, opts) {
      if (opts?.history === true) {
        snapshot(); // close anything left open by a drag, so this action is its own step
        const before = baseline;
        const beforeHash = baselineHash;
        fn(state);
        const h = draftsHash(state);
        if (h !== beforeHash) {
          pushUndo({ drafts: before, hash: beforeHash });
          baseline = cloneDrafts(state);
          baselineHash = h;
        }
      } else {
        fn(state);
      }
      notify();
    },

    snapshot,

    undo() {
      const prev = undoStack.pop();
      if (prev === undefined) return false;
      redoStack.push(currentEntry());
      restore(prev);
      notify();
      return true;
    },

    redo() {
      const next = redoStack.pop();
      if (next === undefined) return false;
      undoStack.push(currentEntry());
      restore(next);
      notify();
      return true;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },

    /** Canonical-JSON comparison, so key order and a value put back never register. */
    dirtyZones() {
      const out = new Set<string>();
      for (const id of new Set([...Object.keys(state.zones), ...Object.keys(state.saved.zones)])) {
        const draft = state.zones[id];
        const saved = state.saved.zones[id];
        if (draft === undefined || saved === undefined) out.add(id);
        else if (canonicalJson(draft) !== canonicalJson(saved)) out.add(id);
      }
      return out;
    },

    worldDirty: () => canonicalJson(state.world) !== canonicalJson(state.saved.world),

    markSaved() {
      state.saved = structuredClone({ zones: state.zones, world: state.world });
      notify();
    },

    setZone(zoneId) {
      if (state.view.zoneId === zoneId) return;
      state.view.zoneId = zoneId;
      notify();
    },
  };
}
