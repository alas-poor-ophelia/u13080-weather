/**
 * The surface contract (PLAN D11, §4).
 *
 * `view.ts` is a coordinator: it builds the shell, builds one `SurfaceContext`,
 * mounts every surface into it and, on each store notification, hands the state
 * to each surface's `render`. A surface owns exactly one region of the shell and
 * one file, so the six remaining studio beads (playlist, mixer, audition, JSON
 * drawer, windows, insert picker) can be written in parallel without touching
 * each other.
 *
 * The rules that make that safe:
 *
 *  - **A surface reads state, it never re-derives it.** `render(state)` is
 *    called with the live `StudioState`; every derivation lives in
 *    `src/studio/model/*` (PLAN D3), never in a surface.
 *  - **A surface writes only through `ctx.store.update`.** Nothing mutates
 *    `plugin.settings` except the header's Save.
 *  - **A surface never touches another surface's DOM.** Cross-surface work goes
 *    through the store (view state) or `ctx.windows`.
 *  - **`mount` runs once, `render` runs per frame, `destroy` undoes `mount`.**
 *    `render` must be idempotent and cheap: it is called on every store tick and
 *    on every resize.
 *
 * This file is types only — no runtime code, so importing it can never create a
 * module cycle.
 */
import type { Units } from "../../core/units";
import type { CalendarDescription } from "../../plugin/time/adapter";
import type WadjetPlugin from "../../plugin/main";
import type { RowRegistry } from "../model/row-registry";
import type { StudioState } from "../model/state";
import type { Store } from "../model/store";
import type { Shell } from "./layout";
import type { PlaylistRow } from "./playlist";
import type { StudioView } from "./view";
import type { WindowManager } from "./windows";

/** Everything a surface is allowed to reach. Built once by `StudioView.build()`. */
export interface SurfaceContext {
  /** for settings, the public API, `app`, modals and `saveAndRebuild` */
  plugin: WadjetPlugin;
  /** the one store; `update(fn, { history: true })` for undoable actions */
  store: Store;
  /** the shell's boxes — a surface only writes into the ones it owns */
  shell: Shell;
  /** the leaf, for `app`, `registerDomEvent`, `requestSaveLayout` and `refreshFromSettings` */
  view: StudioView;
  /**
   * The active time adapter's calendar (year length, epoch, seasons, moons) or
   * `null` when the adapter does not describe itself — an *opaque* calendar, in
   * which case a surface must degrade rather than invent one (SPEC §8).
   */
  calendar(): CalendarDescription | null;
  /**
   * The reader's units (SPEC §8). Every readout in the studio converts through
   * `model/format.ts` on the way to the screen, and this is the one place the
   * preference is read from — seven surfaces used to keep a private
   * `units()` closure over `plugin.settings.units` (bead wadjet-9f9.45).
   */
  units(): Units;
  /** floating windows: open / close / focus / restore (SPEC §3.4) */
  windows: WindowManager;
  /**
   * THIS leaf's playlist rows (`ui/playlist.ts`, bead wadjet-9f9.45). Row
   * factories are module-level; row instances are per leaf, so two studio
   * leaves never share one row object and never render into each other's DOM.
   * Reached through `registerRow(ctx, row)` / `unregisterRow(ctx, id)`.
   */
  rows: RowRegistry<PlaylistRow>;
}

/**
 * One region of the shell. Factories are named `create<X>Surface()` and take no
 * arguments — the context arrives at `mount`, so a surface can be constructed
 * before the leaf exists.
 */
export interface Surface {
  /** Build the DOM and attach listeners. Called once, in `view.ts`'s mount order. */
  mount(ctx: SurfaceContext): void;
  /** Repaint from the live state. Called once per store tick and on resize. */
  render(state: StudioState): void;
  /** Remove every element and listener `mount` created. Must be idempotent. */
  destroy(): void;
}
