/**
 * The calendar ruler (SPEC §3.2) — the sticky strip at the top of the playlist.
 *
 * Three jobs, and nothing else:
 *
 *  - **The label column** reads `Calendar ⚑` and opens the Seasons window. The
 *    window id is registered by bead wadjet-9f9.27; until it lands,
 *    `windows.open` finds no builder and no-ops, which is why the click is
 *    safe to ship before the panel exists (SPEC law 2: a window is reached
 *    from the thing it describes).
 *  - **The tick strip** draws `model/zoom.ts`'s `ticks()` plan — days → 5-day
 *    → 15-day → years → decades → centuries, chosen by pixel density, labelled
 *    with `model/format.ts`'s `yearLabel` / `dayLabel`. The ruler never picks a
 *    spacing of its own.
 *  - **The bands** are the calendar showing through: season bands at Year zoom
 *    and tighter (`morph().showBands`), an era tint at Era zoom. Both come
 *    from `model/spans.ts`'s `spansFor` over a `SpanCalendar` built from the
 *    active adapter's description plus the world draft's eras — an *opaque*
 *    calendar (no `describe()`) simply draws no bands (SPEC §8: degrade, never
 *    invent).
 *
 * Dragging the strip pans, through `panByDrag`. The wheel is the playlist's
 * (it covers the whole lane stack, not just this strip), so it lives in
 * `playlist.ts`.
 *
 * The ruler is not a component-bin part (SPEC law 3) — it is chrome, the same
 * status as the header's transport buttons and a floating window's ×.
 */
import type { CalendarDescription } from "../../plugin/time/adapter";
import { dayLabel, yearLabel } from "../model/format";
import { playlistHint } from "../model/hints-playlist";
import { spanToPx } from "../model/lanes";
import { cycleColour } from "../model/palette";
import type { StudioState } from "../model/state";
import { spansFor, type SpanCalendar } from "../model/spans";
import { panByDrag, ticks, yearToPx, zoomLabel, type Window, type ZoomBounds } from "../model/zoom";
import type { RowGeometry } from "./playlist";
import { beginDrag, DRAG_TARGET_CLASS, markDragTarget } from "./pointer";
import type { SurfaceContext } from "./surfaces";

/**
 * The id the Seasons window opens under (SPEC §3.4). Declared here rather than
 * imported so the ruler never depends on a panel bead landing first: bead
 * wadjet-9f9.27's `ui/windows/seasons.ts` registers the builder under the same
 * string, and until it does `windows.open` finds none and no-ops.
 */
export const SEASONS_WINDOW = "seasons";

/** Year length to label with when the active adapter does not describe itself. */
const DEFAULT_YEAR_LENGTH = 365;

/** A band is a tint behind the ticks, never a fill: 8 % of the palette hue. */
const BAND_ALPHA = "8%";

/** Lane width to assume before the leaf has been laid out (clientWidth 0). */
const FALLBACK_WIDTH = 800;

/**
 * `index` into `model/palette.ts`'s band cycle, at band alpha. Seasons and eras
 * walk the same six hues — they can never be on screen together (bands are Year
 * and tighter, the era tint is Era), and the cycle starting on calendar gold is
 * what makes both read as *calendar*, not as data.
 */
function tint(index: number): string {
  return `color-mix(in srgb, ${cycleColour(index)} ${BAND_ALPHA}, transparent)`;
}

/**
 * The calendar facts the bands need, or `null` for an opaque calendar.
 *
 * Seasons follow the header's rule: an *editable* calendar is edited in the
 * studio, so the world draft is the truth and a season the user just added
 * bands immediately; a read-only adapter's description is the truth instead.
 * Eras are always the world draft — the studio is the only place that edits
 * them.
 */
export function spanCalendarFor(ctx: SurfaceContext, state: StudioState): SpanCalendar | null {
  const description: CalendarDescription | null = ctx.calendar();
  if (description === null) return null;
  const zoneId = state.view.zoneId;
  const zone = zoneId === null ? undefined : state.zones[zoneId];
  const seasons = description.readOnly ? description.seasons : state.world.calendar.seasons;
  return {
    yearLength: description.yearLength,
    epochYear: description.epochYear ?? ctx.plugin.settings.calendar.epochYear,
    seasons,
    moons: description.readOnly ? description.moons : state.world.calendar.moons,
    eras: state.world.eras,
    ...(zone?.flipSeasons === true ? { flipSeasons: true } : {}),
  };
}

export interface RulerProps {
  ctx: SurfaceContext;
  /** the world's pannable extent; the playlist owns the one definition */
  bounds(): ZoomBounds;
  /** persist a pan through the store, exactly as the header does */
  setWindow(next: Window): void;
}

export interface RulerComponent {
  render(state: StudioState, geo: RowGeometry): void;
  destroy(): void;
}

/** Mount the ruler into `shell.rulerLabel` / `shell.rulerTicks`. */
export function createRuler(props: RulerProps): RulerComponent {
  const { shell } = props.ctx;
  const label = shell.rulerLabel;
  const ticksEl = shell.rulerTicks;
  let cancelDrag: (() => void) | null = null;

  label.empty();
  label.setText("Calendar ⚑");
  label.addClass("wadjet-studio-ruler-label-btn");
  label.setAttrs({ role: "button", tabindex: "0", "aria-label": "Open the seasons window", "data-hint": playlistHint("ruler.calendar") });

  ticksEl.empty();
  ticksEl.setAttr("data-hint", playlistHint("ruler.ticks"));
  markDragTarget(ticksEl);
  const bandsEl = ticksEl.createDiv({ cls: "wadjet-studio-ruler-bands" });
  const stripEl = ticksEl.createDiv({ cls: "wadjet-studio-ruler-strip" });

  function openSeasons(): void {
    // Not yet registered (bead wadjet-9f9.27): the manager finds no builder
    // and returns — a click on the label is inert, never an error.
    props.ctx.windows.open(SEASONS_WINDOW);
  }

  function onLabelClick(): void {
    openSeasons();
  }

  function onLabelKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openSeasons();
  }

  /** Ruler drag = pan. The window at pointerdown is the origin, so the gesture never drifts. */
  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const start = props.ctx.store.get().view.window;
    const widthPx = ticksEl.clientWidth > 0 ? ticksEl.clientWidth : FALLBACK_WIDTH;
    ev.preventDefault();
    cancelDrag = beginDrag(ev, {
      capture: ticksEl,
      onMove: (_move, dx) => props.setWindow(panByDrag(start, dx, widthPx, props.bounds())),
      onEnd: (_end, dx, _dy, moved) => {
        cancelDrag = null;
        if (moved) props.setWindow(panByDrag(start, dx, widthPx, props.bounds()));
      },
    });
  }

  label.addEventListener("click", onLabelClick);
  label.addEventListener("keydown", onLabelKey);
  ticksEl.addEventListener("pointerdown", onPointerDown);

  function paintBands(state: StudioState, geo: RowGeometry): void {
    bandsEl.empty();
    const cal = spanCalendarFor(props.ctx, state);
    if (cal === null) return;
    const w = geo.window;

    const draw = (name: string, tag: string, index: number): void => {
      const spans = spansFor({ tag }, undefined, cal, { window: w });
      for (const s of spans) {
        if (s.id === "many") continue; // the overflow bar is not a tint
        const { left, width } = spanToPx(s, geo.lane);
        const el = bandsEl.createDiv({ cls: "wadjet-studio-ruler-band" });
        el.setCssProps({
          "--wadjet-studio-ruler-band-left": `${left}px`,
          "--wadjet-studio-ruler-band-width": `${Math.max(1, width)}px`,
          "--wadjet-studio-ruler-band-color": tint(index),
        });
        el.createSpan({ cls: "wadjet-studio-ruler-band-label", text: s.label ?? name });
      }
    };

    if (zoomLabel(w) === "era") {
      cal.eras.forEach((era, i) => {
        if (era.enabled === false) return;
        draw(era.name, `era:${era.name}`, state.view.colours.eras[i] ?? i);
      });
      return;
    }
    if (!geo.morph.showBands) return;
    cal.seasons.forEach((season, i) => {
      draw(season.name, `season:${season.name}`, state.view.colours.seasons[i] ?? i);
    });
  }

  function paintTicks(state: StudioState, geo: RowGeometry): void {
    stripEl.empty();
    const yearLength = spanCalendarFor(props.ctx, state)?.yearLength ?? DEFAULT_YEAR_LENGTH;
    // `ticks()` hands the day tick a 0-based index within its year; `dayLabel`
    // wants the 1-based day the readout and the day card use.
    const plan = ticks(geo.window, geo.widthPx, { year: yearLabel, day: (_year, dayIndex) => dayLabel(dayIndex + 1, yearLength) });
    for (const t of plan) {
      const el = stripEl.createDiv({ cls: "wadjet-studio-tick wadjet-studio-ruler-tick" });
      el.toggleClass("is-major", t.major);
      el.setCssProps({ "--wadjet-studio-ruler-tick-left": `${yearToPx(t.year, geo.window, geo.widthPx)}px` });
      if (t.label !== "") el.createSpan({ cls: "wadjet-studio-ruler-tick-label", text: t.label });
    }
  }

  return {
    render(state, geo) {
      paintBands(state, geo);
      paintTicks(state, geo);
    },

    destroy() {
      cancelDrag?.();
      cancelDrag = null;
      label.removeEventListener("click", onLabelClick);
      label.removeEventListener("keydown", onLabelKey);
      ticksEl.removeEventListener("pointerdown", onPointerDown);
      label.removeClass("wadjet-studio-ruler-label-btn");
      label.removeAttribute("role");
      label.removeAttribute("tabindex");
      label.removeAttribute("aria-label");
      label.removeAttribute("data-hint");
      label.empty();
      ticksEl.removeAttribute("data-hint");
      ticksEl.removeClass(DRAG_TARGET_CLASS);
      ticksEl.empty();
    },
  };
}
