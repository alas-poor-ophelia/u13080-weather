/**
 * The playlist surface (SPEC §3.2): the calendar ruler, continuous zoom and
 * pan, and the row stack every later lane bead plugs into.
 *
 * ## The row API (the contract for beads P2/P3/P4/W6/D1)
 *
 * A lane bead does not edit this file. It builds a `PlaylistRow` and calls
 * `registerRow(ctx, row)` — from a surface's `mount`, with the leaf's own
 * context — and the playlist mounts it in `order` position, keeps it in sync
 * with the window, and tears it down with the leaf:
 *
 * ```ts
 * registerRow(ctx, {
 *   id: "regimes",
 *   label: "REGIMES",
 *   order: ROW_ORDER.regimes,
 *   mount(host) { lane = createLane(host.body, { … }); },
 *   render(state, geo) { lane.update({ geometry: geo.lane, spans: … }); },
 *   destroy() { lane.destroy(); },
 * });
 * ```
 *
 *  - **`mount(host)` runs once.** `host.row` is `layout.createRow`'s result,
 *    already appended in `order` position; `host.body` is the lane's parent
 *    and its measuring box (`position: relative`, and exactly as wide as the
 *    ruler's tick strip); `host.label` is the 136 px label column, where a row
 *    hangs its `data-hint` and its click target; `host.ctx` is the surface
 *    context (store, calendar, windows).
 *  - **`render(state, geo)` runs per tick and per resize**, after the ruler.
 *    `geo.lane` is the `LaneGeometry` to hand straight to a Lane component;
 *    `geo.widthPx` is the *measured* strip width; `geo.morph` is
 *    `zoom.morph()` — `fine`, `isDay`, `showBands`, `pxPerYear`. A row derives
 *    nothing about the window itself.
 *  - **`destroy()` undoes `mount`.** The row element is removed for you.
 *  - **Registration is order-independent.** A row registered after the surface
 *    mounted is mounted immediately and slotted into its `order` position; a
 *    row registered twice under one id replaces the earlier one.
 *  - **`unregisterRow(ctx, id)` retires one.** For rows that are data rather
 *    than code — one per zone device (SPEC §4) — so a device removed from the
 *    chain takes its row down with it.
 *  - **The registry is the LEAF's, not the module's** (bead wadjet-9f9.45).
 *    Row factories are module-level, row *instances* are not: two studio
 *    leaves hold two `RowRegistry` objects (`ctx.rows`, built in `view.ts`)
 *    and therefore two sets of rows, each drawing into its own DOM. A
 *    module-level registry made the second leaf re-`mount` the first leaf's
 *    row objects and left the first leaf rendering into orphaned nodes.
 *
 * `ROW_ORDER` is the fixed top-to-bottom order SPEC §3.2 lists. Device rows
 * take `ROW_ORDER.devices + index`.
 *
 * ## Zoom and pan
 *
 * The wheel listener covers the *whole* playlist, not just the ruler, because
 * SPEC §3.2 puts zoom on the timeline as a surface. Over the 136 px label
 * column the event is left alone, so the column scrolls natively; over the
 * lane body it zooms under the cursor (`zoomAt` at the fraction measured
 * against the lane BODY, never the whole playlist) or pans on shift / a
 * horizontal wheel. Every move goes through `model/zoom.ts` and is persisted
 * exactly as the header persists one: `store.update` with no history, then
 * `requestSaveLayout` (view state is not the document — PLAN D14).
 */
import { DAY_CARD_DETAIL } from "../model/hints-channels";
import { playlistHint } from "../model/hints-playlist";
import type { LaneGeometry } from "../model/lanes";
import type { StudioState } from "../model/state";
import { addRow, createRowRegistry, removeRow, sortedRows, type RowRegistry } from "../model/row-registry";
import { clampWindow, morph, panByWheel, wheelZoomFactor, worldBounds, zoomAt, type Window, type ZoomBounds } from "../model/zoom";
import { createDayCard, type DayCardComponent } from "./day-card";
import { AXIS_WIDTH, createRow, LABEL_WIDTH, type Row } from "./layout";
import { EDGE_PX_MOUSE } from "./pointer";
import { createChannelRow } from "./rows/channel-row";
import { createRuler, type RulerComponent } from "./ruler";
import type { Surface, SurfaceContext } from "./surfaces";

// ---------------------------------------------------------------------------
// The row API
// ---------------------------------------------------------------------------

/** Everything a row is handed at `mount`. */
export interface RowHost {
  /** the row element, its label column and its body, from `layout.createRow` */
  row: Row;
  /** the lane's parent and its measuring box */
  body: HTMLElement;
  /** the 136 px label column (the click target and the `data-hint` host) */
  label: HTMLElement;
  /** the label's colour swatch */
  dot: HTMLElement;
  /** the label's name line — `setText` this, never `label` */
  name: HTMLElement;
  /** the label's live second line */
  sub: HTMLElement;
  /** the 44 px y-axis gutter left of the lane */
  axis: HTMLElement;
  ctx: SurfaceContext;
}

/** The window, measured once per render and shared by the ruler and every row. */
export interface RowGeometry {
  window: Window;
  /** the measured lane width in px — `shell.rulerTicks.clientWidth` */
  widthPx: number;
  pxPerYear: number;
  morph: ReturnType<typeof morph>;
  /** ready to hand to a Lane component */
  lane: LaneGeometry;
}

/** One playlist row. One instance per leaf, registered by the surface that owns it. */
export interface PlaylistRow {
  id: string;
  label: string;
  order: number;
  mount(host: RowHost): void;
  render(state: StudioState, geo: RowGeometry): void;
  destroy(): void;
}

/** The fixed top-to-bottom order (SPEC §3.2). Device rows are `devices + index`. */
export const ROW_ORDER = {
  regimes: 10,
  eras: 20,
  devices: 30,
  automation: 40,
  temperature: 50,
  precipitation: 51,
  wind: 52,
  sky: 53,
} as const;

/** One leaf's row registry. Built by `StudioView` and reached as `ctx.rows`. */
export type PlaylistRegistry = RowRegistry<PlaylistRow>;

/** The registry `view.ts` puts on the `SurfaceContext`. One per leaf, never shared. */
export function createPlaylistRegistry(): PlaylistRegistry {
  return createRowRegistry<PlaylistRow>();
}

/** Register (or replace) a playlist row in THIS leaf's registry. Idempotent per `id`. */
export function registerRow(ctx: SurfaceContext, row: PlaylistRow): void {
  addRow(ctx.rows, row);
}

/**
 * Retire a row from this leaf. The playlist destroys it and detaches its
 * element on the next `sync`, which this triggers — the mirror of
 * `registerRow`, for the rows that are *data* rather than code: a device row
 * exists only while its device does (SPEC §4, bead wadjet-9f9.33). Unknown ids
 * are ignored.
 */
export function unregisterRow(ctx: SurfaceContext, id: string): void {
  removeRow(ctx.rows, id);
}

/** Every row registered in this leaf, in `order` then `id` order. */
export function registeredRows(ctx: SurfaceContext): PlaylistRow[] {
  return sortedRows(ctx.rows);
}

// ---------------------------------------------------------------------------
// The four composed channel rows
// ---------------------------------------------------------------------------

/** The four signal chains (SPEC §1). Colour comes from the palette, never a caller. */
export const CHANNELS = [
  { id: "temperature", label: "TEMP", color: "var(--wadjet-studio-temp)", order: ROW_ORDER.temperature, hint: "row.temperature" },
  { id: "precipitation", label: "PRECIP", color: "var(--wadjet-studio-precip)", order: ROW_ORDER.precipitation, hint: "row.precipitation" },
  { id: "wind", label: "WIND", color: "var(--wadjet-studio-wind)", order: ROW_ORDER.wind, hint: "row.wind" },
  { id: "sky", label: "SKY", color: "var(--wadjet-studio-sky)", order: ROW_ORDER.sky, hint: "row.sky" },
] as const;

/** Lane width to assume before the leaf has been laid out (clientWidth 0). */
const FALLBACK_LANE_WIDTH = 800;

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export function createPlaylistSurface(): Surface {
  let ctx: SurfaceContext | null = null;
  let ruler: RulerComponent | null = null;
  let dayCard: DayCardComponent | null = null;
  const mounted = new Map<string, { row: PlaylistRow; host: RowHost }>();

  /** The world's pannable extent — the same definition the header uses. */
  function bounds(): ZoomBounds {
    const c = ctx;
    const epoch = c?.calendar()?.epochYear ?? c?.plugin.settings.calendar.epochYear ?? 1;
    return worldBounds(epoch, c?.store.get().world.eras ?? []);
  }

  /**
   * Slide the window onto `dayOrdinal`, keeping its width — the day card's
   * NEIGHBOUR list, and the prototype's `jumpDay`. The centre lands on the
   * MIDDLE of the day so a 3-day window frames it the way the card assumes.
   */
  function jumpToDay(dayOrdinal: number): void {
    const c = ctx;
    if (c === null) return;
    const cal = c.calendar();
    const yearLength = cal?.yearLength ?? 0;
    if (yearLength <= 0) return;
    const epoch = cal?.epochYear ?? c.plugin.settings.calendar.epochYear ?? 1;
    const w = c.store.get().view.window;
    const half = (w.b - w.a) / 2;
    const centre = epoch + (dayOrdinal + 0.5) / yearLength;
    setWindow(clampWindow({ a: centre - half, b: centre + half }, bounds()));
  }

  /** Persist a window move: view state, no history, then the layout save. */
  function setWindow(next: Window): void {
    const c = ctx;
    if (c === null) return;
    c.store.update((s) => {
      s.view.window = next;
    });
    c.view.app.workspace.requestSaveLayout();
  }

  /**
   * The one measured width in the playlist. The ruler's tick strip and every
   * row body are the same flex box in the same column, so measuring the strip
   * once keeps the ticks and the lanes on the same pixel grid even before the
   * leaf has been laid out.
   */
  function laneWidth(): number {
    const c = ctx;
    if (c === null) return FALLBACK_LANE_WIDTH;
    const strip = c.shell.rulerTicks.clientWidth;
    if (strip > 0) return strip;
    for (const { host } of mounted.values()) {
      if (host.body.clientWidth > 0) return host.body.clientWidth;
    }
    return FALLBACK_LANE_WIDTH;
  }

  function geometry(state: StudioState): RowGeometry {
    const w = state.view.window;
    const widthPx = laneWidth();
    const m = morph(w, widthPx);
    return {
      window: w,
      widthPx,
      pxPerYear: m.pxPerYear,
      morph: m,
      lane: { x0: 0, pxPerYear: m.pxPerYear, windowFrom: w.a, edgePx: EDGE_PX_MOUSE },
    };
  }

  /**
   * The lane body's screen rectangle: the ruler's tick strip when it has been
   * laid out, otherwise the playlist minus the 136 px label column. The wheel
   * measures its cursor fraction against THIS, never against the playlist —
   * measuring against the whole column would put the zoom's fixed point 136 px
   * to the left of the pointer.
   */
  function laneRect(): { left: number; width: number } | null {
    const c = ctx;
    if (c === null) return null;
    const strip = c.shell.rulerTicks.getBoundingClientRect();
    if (strip.width > 0) return { left: strip.left, width: strip.width };
    const playlist = c.shell.playlist.getBoundingClientRect();
    const inset = LABEL_WIDTH + AXIS_WIDTH;
    const width = playlist.width - inset;
    if (width <= 0) return null;
    return { left: playlist.left + inset, width };
  }

  function onWheel(ev: WheelEvent): void {
    const c = ctx;
    if (c === null) return;
    const rect = laneRect();
    if (rect === null) return;
    // Over the label column the wheel belongs to the browser: no preventDefault,
    // so the playlist scrolls the way every other list in Obsidian does.
    if (ev.clientX < rect.left) return;
    ev.preventDefault();

    const w = c.store.get().view.window;
    // Shift+wheel is the platform's "scroll sideways"; a trackpad sends deltaX
    // directly. Either way it pans, and the width never changes.
    if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      const delta = ev.deltaX !== 0 ? ev.deltaX : ev.deltaY;
      setWindow(panByWheel(w, delta, bounds()));
      return;
    }
    const frac = (ev.clientX - rect.left) / rect.width;
    setWindow(zoomAt(w, frac, wheelZoomFactor(ev.deltaY), bounds()));
  }

  /** Mount every registered row that is not up yet, and put the stack in `order`. */
  function sync(): void {
    const c = ctx;
    if (c === null) return;
    const rows = registeredRows(c);
    const ids = new Set(rows.map((r) => r.id));

    // A row whose id was replaced by a later `registerRow` comes down first.
    for (const [id, entry] of [...mounted]) {
      if (ids.has(id) && c.rows.byId.get(id) === entry.row) continue;
      entry.row.destroy();
      entry.host.row.el.remove();
      mounted.delete(id);
    }

    for (const row of rows) {
      if (mounted.has(row.id)) continue;
      const created = createRow(c.shell.lanes, row.label);
      const host: RowHost = { row: created, body: created.body, label: created.label, dot: created.dot, name: created.name, sub: created.sub, axis: created.axis, ctx: c };
      mounted.set(row.id, { row, host });
      row.mount(host);
    }

    // `appendChild` moves an existing node, so this is a reorder, not a rebuild.
    for (const row of rows) {
      const entry = mounted.get(row.id);
      if (entry !== undefined) c.shell.lanes.appendChild(entry.host.row.el);
    }

    paint(c.store.get());
  }

  function paint(state: StudioState): void {
    const c = ctx;
    if (c === null) return;
    const geo = geometry(state);
    ruler?.render(state, geo);
    // Day view (≤ 7.5 days) ADDS the day card above the ruler; it takes
    // nothing away. The prototype keeps the whole stack — regimes, eras,
    // devices, automation, the four channels — running at day resolution
    // underneath it, which is where a day gets its context from.
    for (const { row } of mounted.values()) row.render(state, geo);
    dayCard?.render(state, geo);
  }

  return {
    mount(next) {
      ctx = next;
      next.shell.playlist.setAttr("data-hint", playlistHint("playlist.window"));
      ruler = createRuler({ ctx: next, bounds, setWindow });

      dayCard = createDayCard(next.shell.playlist, next, playlistHint("playlist.daycard", DAY_CARD_DETAIL), jumpToDay);
      // The prototype puts the card ABOVE the calendar ruler, at the top of
      // the column. `createDayCard` appends, so move it once at mount.
      next.shell.playlist.insertBefore(dayCard.el, next.shell.ruler);

      // `passive: false` because the wheel over the lane body is prevented; the
      // leaf owns the teardown, so the listener never outlives the view.
      next.view.registerDomEvent(next.shell.playlist, "wheel", onWheel, { passive: false });

      // The four composed channel rows are this surface's own, so they are
      // built HERE — one instance per leaf — rather than at import time.
      for (const chain of CHANNELS) registerRow(next, createChannelRow(chain));

      next.rows.live.add(sync);
      sync();
    },

    render(state) {
      paint(state);
    },

    destroy() {
      ctx?.rows.live.delete(sync);
      for (const { row, host } of mounted.values()) {
        row.destroy();
        host.row.el.remove();
      }
      mounted.clear();
      ruler?.destroy();
      ruler = null;
      dayCard?.destroy();
      dayCard = null;
      ctx?.shell.playlist.removeAttribute("data-hint");
      ctx = null;
    },
  };
}
