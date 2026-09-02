/**
 * The **Eras · world** playlist row (SPEC §3.2).
 *
 * One row, two shapes, decided by `zoomLabel(window)`:
 *
 *  - **Era zoom** — one editable `clip` per era, `[from, to + 1)` so the clip
 *    runs to the *end* of its last year (`Era.from`/`Era.to` are inclusive
 *    calendar years, SPEC §7). An open era (`to` omitted) runs to the window's
 *    right edge, exactly as `model/spans.ts`'s `era:` branch draws it. Drag
 *    empty lane to add, body to move, the white edges to resize, right-click
 *    to remove, click to open the Era window (SPEC §3.8). Overlapping eras
 *    stack in up to three sub-rows — the assignment is pure (`stackRows`).
 *  - **Year zoom and tighter** — a read-only full-width `bar` per era covering
 *    the window's centre year, labelled `era:<Name> · from – to` (`∞` when the
 *    era is open). The span *is* window-shaped here, so it is one of the three
 *    exceptions `spans.ts` names to "spans are never clipped to the window".
 *
 * Three things worth knowing before editing this file:
 *
 *  - **Eras are world scope.** Every write goes through the session's one
 *    world-edit confirm (`model/world-confirm.ts`), the same gate the Era,
 *    CYCLE and Seasons windows use — the first era edit of a session asks,
 *    later ones do not.
 *  - **Colour is per span, and the Lane component is per lane.** `LaneProps`
 *    carries one `color` for the whole lane, but SPEC §3.2 wants each era in
 *    its own hue from the band cycle. The row therefore sets
 *    `--wadjet-studio-span-color` on each span node *after* `lane.update`
 *    repaints — custom properties inherit, so the per-node value wins over the
 *    lane's. It only ever touches the lane instance it owns.
 *  - **`onCreate` is zoom-gated, the rest is `editable`-gated.** At Year zoom
 *    the bars are `editable: false`, so the Lane never offers move, resize or
 *    delete on them; only "click-drag empty lane" would still fire, so
 *    `onCreate` checks the live zoom itself rather than swapping handlers.
 */
import type { Era } from "../../../core/types";
import { addEra, removeEra, setSpan } from "../../model/era-edit";
import { tabular } from "../../model/format";
import { rowHint } from "../../model/hints-rows";
import { stackRows, type Span } from "../../model/lanes";
import { cycleColour } from "../../model/palette";
import type { StudioState } from "../../model/state";
import { needsWorldConfirm } from "../../model/world-confirm";
import { zoomLabel, type Window } from "../../model/zoom";
import { createLane, type LaneComponent } from "../components";
import { ROW_ORDER, type PlaylistRow, type RowGeometry, type RowHost } from "../playlist";
import { eraWindowId } from "../windows/era";
import { confirmWorldEdit } from "../world-confirm-modal";

/** SPEC §3.2: "Overlapping eras stack in up to 3 sub-rows". */
const MAX_SUB_ROWS = 3;

/** Taller than the 28 px default: three sub-rows of era clips have to stay readable. */
const ROW_HEIGHT = 36;

/** Span ids are `era:<name>` — the same key `eraWindowId` opens the panel under. */
const SPAN_PREFIX = "era:";

/** `era:Ice Age · 1200 – 1900`, with `∞` for an open era (SPEC §3.2). */
function barLabel(era: Era): string {
  const to = era.to === undefined ? "∞" : tabular(era.to, 0);
  return `${SPAN_PREFIX}${era.name} · ${tabular(era.from, 0)} – ${to}`;
}

/** `[from, to)` in fractional years for one era, `to` inclusive-year-corrected. */
function clipRange(era: Era, w: Window): { from: number; to: number } {
  const from = era.from;
  const to = era.to === undefined ? Math.max(w.b, from + 1) : era.to + 1;
  return { from, to };
}

/** Does `[from, to)` show at all in `w`? */
function overlaps(from: number, to: number, w: Window): boolean {
  return to > w.a && from < w.b;
}

/** The spans this row draws, plus the palette colour each one is tinted with. */
interface Drawing {
  spans: Span[];
  /** span id → CSS colour */
  colours: Map<string, string>;
}

/**
 * Era zoom → editable clips over each era's own years; Year and tighter → a
 * read-only full-width bar per era covering the window's centre year. Both
 * shapes go through `stackRows(…, 3)`: overlapping eras get their own sub-row,
 * and the bars all overlap by construction, so several bars stack too.
 */
export function drawEras(state: StudioState, w: Window): Drawing {
  const colours = new Map<string, string>();
  const out: Span[] = [];
  const era = zoomLabel(w) === "era";
  const centre = Math.floor((w.a + w.b) / 2);

  state.world.eras.forEach((e, i) => {
    const id = `${SPAN_PREFIX}${e.name}`;
    const dim = e.enabled === false ? { dim: true } : {};
    if (era) {
      const { from, to } = clipRange(e, w);
      if (!(to > from) || !overlaps(from, to, w)) return;
      out.push({ id, from, to, kind: "clip", editable: true, label: e.name, ...dim });
    } else {
      if (e.from > centre) return;
      if (e.to !== undefined && e.to < centre) return;
      out.push({ id, from: w.a, to: w.b, kind: "bar", editable: false, label: barLabel(e), ...dim });
    }
    colours.set(id, cycleColour(state.view.colours.eras[i] ?? i));
  });

  return { spans: stackRows(out, MAX_SUB_ROWS), colours };
}

/**
 * The Eras row (SPEC §3.2 "Eras · world"). One instance per playlist; the
 * factory takes nothing, so `ui/rows-surface.ts` can build it before a leaf
 * exists.
 */
export function createErasRow(): PlaylistRow {
  let host: RowHost | null = null;
  let lane: LaneComponent | null = null;
  let colours = new Map<string, string>();
  /** One pending confirm at a time — a second drag must not stack a modal. */
  let confirmPending = false;

  function currentWindow(): Window {
    return host?.ctx.store.get().view.window ?? { a: 0, b: 1 };
  }

  function eraNamed(name: string): Era | undefined {
    return host?.ctx.store.get().world.eras.find((e) => e.name === name);
  }

  /** Span ids are `era:<name>`; the name may contain anything, so slice, never split. */
  function nameOf(span: Span): string {
    return span.id.slice(SPAN_PREFIX.length);
  }

  /** Run `apply` behind the session's one world-edit confirm (SPEC §2). */
  function guarded(apply: () => void): void {
    const ctx = host?.ctx;
    if (ctx === undefined) return;
    if (!needsWorldConfirm()) {
      apply();
      return;
    }
    if (confirmPending) return;
    confirmPending = true;
    confirmWorldEdit(
      ctx.plugin.app,
      ctx,
      "eras",
      () => {
        confirmPending = false;
        apply();
      },
      // A cancelled edit leaves the lane showing the draft it never wrote.
      () => {
        confirmPending = false;
        repaint();
      },
    );
  }

  /**
   * The Lane fires `onMove`/`onResize`/`onCreate` once, at pointer-up (it
   * previews the drag itself), so every write here is a single undoable
   * action rather than an update-per-frame plus a closing `snapshot()`.
   */
  function write(mutate: (state: StudioState) => void): void {
    const ctx = host?.ctx;
    if (ctx === undefined) return;
    guarded(() => ctx.store.update(mutate, { history: true }));
  }

  function onCreate(from: number, to: number): void {
    // Year zoom draws window-shaped bars: an empty-lane drag there is a miss,
    // not a new era spanning whatever happens to be on screen.
    if (zoomLabel(currentWindow()) !== "era") return;
    const a = Math.floor(Math.min(from, to));
    const b = Math.floor(Math.max(from, to));
    write((s) => {
      addEra(s.world, a, b);
    });
  }

  function onMove(span: Span, from: number): void {
    const name = nameOf(span);
    const era = eraNamed(name);
    if (era === undefined) return;
    const a = Math.round(from);
    // Keeping the length means keeping "open" too: an open era stays open.
    const b = era.to === undefined ? undefined : a + (era.to - era.from);
    write((s) => setSpan(s.world, name, a, b));
  }

  function onResize(span: Span, zone: "start" | "end", to: number): void {
    const name = nameOf(span);
    const era = eraNamed(name);
    if (era === undefined) return;
    if (zone === "start") {
      write((s) => setSpan(s.world, name, Math.round(to), era.to));
      return;
    }
    // The clip's right edge is `Era.to + 1` (inclusive years). Dragging it past
    // the window's end CLOSES the era at that year rather than reopening it —
    // only the Era window's blank `to` field writes `∞`.
    write((s) => setSpan(s.world, name, era.from, Math.round(to) - 1));
  }

  function onDelete(span: Span): void {
    const name = nameOf(span);
    write((s) => removeEra(s.world, name));
  }

  function onOpen(span: Span): void {
    // `ui/eras-surface.ts` re-registers a builder per era every tick, so an
    // era added by this very lane is openable by the time it is clickable.
    host?.ctx.windows.open(eraWindowId(nameOf(span)));
  }

  /**
   * Per-span colour and per-span hint, applied after every `lane.update`
   * repaint. `--wadjet-studio-span-color` inherits, so the value set here on a
   * span node overrides the one the Lane put on itself.
   */
  function decorate(): void {
    const el = lane?.el;
    if (el === undefined) return;
    for (const node of Array.from(el.querySelectorAll(".wadjet-studio-span"))) {
      const span = node as HTMLElement;
      const id = span.getAttribute("data-id");
      const colour = id === null ? undefined : colours.get(id);
      if (colour !== undefined) span.setCssProps({ "--wadjet-studio-span-color": colour });
      span.setAttr("data-hint", rowHint(span.getAttribute("data-kind") === "bar" ? "row.eras.bar" : "row.eras.clip"));
    }
  }

  function repaint(): void {
    const ctx = host?.ctx;
    if (ctx === undefined) return;
    const state = ctx.store.get();
    const drawing = drawEras(state, state.view.window);
    colours = drawing.colours;
    lane?.update({ spans: drawing.spans });
    decorate();
  }

  return {
    id: "eras",
    label: "Eras · world",
    order: ROW_ORDER.eras,

    mount(next) {
      host = next;
      next.label.setAttr("data-hint", rowHint("row.eras"));
      next.body.addClass("wadjet-studio-eras-row");
      lane = createLane(next.body, {
        geometry: { x0: 0, pxPerYear: 1, windowFrom: 0, edgePx: 4 },
        spans: [],
        height: ROW_HEIGHT,
        onCreate,
        onMove,
        onResize,
        onDelete,
        onOpen,
      });
      lane.el.setAttr("data-hint", rowHint("row.eras.lane"));
    },

    render(state, geo: RowGeometry) {
      const drawing = drawEras(state, state.view.window);
      colours = drawing.colours;
      lane?.update({ geometry: geo.lane, spans: drawing.spans });
      decorate();
    },

    destroy() {
      lane?.destroy();
      lane = null;
      host?.body.removeClass("wadjet-studio-eras-row");
      host = null;
      colours = new Map();
    },
  };
}
