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
import { tabular } from "../model/format";
import { playlistHint } from "../model/hints-playlist";
import { spanToPx } from "../model/lanes";
import { cycleColour, ERA_CYCLE, SEASON_CYCLE } from "../model/palette";
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

/** The ruler's own band, under the season name and behind the tick labels. */
const RULER_BAND_ALPHA = "18%";

/** The tint the same band takes when it is painted the full height of a chart. */
const CHART_BAND_ALPHA = "5%";

/** A band narrower than this has no room for its name (SPEC §3.2: no collisions). */
const NAME_MIN_PX = 44;

/** Lane width to assume before the leaf has been laid out (clientWidth 0). */
const FALLBACK_WIDTH = 800;

/**
 * `index` into `cycle`, at `alpha`.
 *
 * Seasons and eras walk DIFFERENT six-hue lists. An era band leads on precip
 * blue (`ERA_CYCLE`, `model/palette.ts`) — the same per-era tint the eras
 * row's Era-zoom clip and the mixer's era chip use — because an era band is a
 * *specific era* being tinted, not the calendar itself; a season band leads
 * on `SEASON_CYCLE`, because the world's four shipped seasons read Thaw green
 * · High Sun gold · Harvest orange · Deepcold blue and the Seasons window
 * already paints them that way. The two can never be on screen together
 * (bands are Year and tighter, the era tint is Era), so nothing collides.
 */
function tint(index: number, alpha: string, cycle?: readonly string[]): string {
  return `color-mix(in srgb, ${cycleColour(index, cycle)} ${alpha}, transparent)`;
}

/** One calendar band on screen: where it is, what it is called and its hue. */
export interface CalendarBand {
  left: number;
  width: number;
  /** the centre of the band CLIPPED to the window — where a centred name belongs */
  mid: number;
  name: string;
  /** the band's own palette colour, as a `var()` */
  colour: string;
  /** the same colour at chart-tint alpha */
  tint: string;
}

/**
 * The season bands at Year zoom and tighter, the era bands at Era zoom — the
 * one derivation the ruler and every channel row share, so a tint behind a
 * curve lands on exactly the pixels the ruler's own band does.
 */
export function calendarBands(ctx: SurfaceContext, state: StudioState, geo: RowGeometry): CalendarBand[] {
  const cal = spanCalendarFor(ctx, state);
  if (cal === null) return [];
  const out: CalendarBand[] = [];
  const push = (tag: string, fallback: string, index: number, cycle?: readonly string[]): void => {
    for (const s of spansFor({ tag }, undefined, cal, { window: geo.window })) {
      if (s.id === "many") continue; // the overflow bar is not a tint
      const { left, width } = spanToPx(s, geo.lane);
      out.push({
        left,
        width: Math.max(1, width),
        mid: (Math.max(0, left) + Math.min(geo.widthPx, left + width)) / 2,
        name: s.label ?? fallback,
        colour: cycleColour(index, cycle),
        tint: tint(index, CHART_BAND_ALPHA, cycle),
      });
    }
  };
  if (zoomLabel(geo.window) === "era") {
    cal.eras.forEach((era, i) => {
      if (era.enabled === false) return;
      push(`era:${era.name}`, era.name, state.view.colours.eras[i] ?? i, ERA_CYCLE);
    });
    return out;
  }
  if (!geo.morph.showBands) return [];
  cal.seasons.forEach((season, i) => {
    push(`season:${season.name}`, season.name, state.view.colours.seasons[i] ?? i, SEASON_CYCLE);
  });
  return out;
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

/**
 * A day tick's label: `d0`, 0-based within its year, as the prototype's ruler
 * writes it. Deliberately NOT `format.ts`'s `dayLabel` — that one is the
 * 1-based `d 130` the header readout and the day card speak, and a tick has
 * 24 px to fit a number into.
 */
function tickDay(dayIndex: number, yearLength: number): string {
  const n = Math.max(1, Math.round(yearLength));
  return `d${((dayIndex % n) + n) % n}`;
}

/** A year tick's label: the bare year, no `Y` prefix (SPEC §3.2's `1100 1200 …`). */
function tickYear(year: number): string {
  return tabular(year, 0);
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
  label.createSpan({ cls: "wadjet-studio-ruler-label-text", text: "Calendar ⚑" });
  label.addClass("wadjet-studio-ruler-label-btn");
  label.setAttrs({ role: "button", tabindex: "0", "aria-label": "Open the seasons window", "data-hint": playlistHint("ruler.calendar") });

  ticksEl.empty();
  ticksEl.setAttr("data-hint", playlistHint("ruler.ticks"));
  markDragTarget(ticksEl);
  const bandsEl = ticksEl.createDiv({ cls: "wadjet-studio-ruler-bands" });
  const namesEl = ticksEl.createDiv({ cls: "wadjet-studio-ruler-names" });
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

  /**
   * The band strip along the bottom of the ruler, with each band's name
   * centred over its own span on the row ABOVE the tick labels (SPEC §3.2) —
   * the two rows are what keeps `Thaw` from landing on top of `d0`. A band
   * too narrow to hold its name gets the tint and no text.
   */
  function paintBands(state: StudioState, geo: RowGeometry): void {
    bandsEl.empty();
    namesEl.empty();
    for (const band of calendarBands(props.ctx, state, geo)) {
      const el = bandsEl.createDiv({ cls: "wadjet-studio-ruler-band" });
      el.setCssProps({
        "--wadjet-studio-ruler-band-left": `${band.left}px`,
        "--wadjet-studio-ruler-band-width": `${band.width}px`,
        "--wadjet-studio-ruler-band-color": `color-mix(in srgb, ${band.colour} ${RULER_BAND_ALPHA}, transparent)`,
      });
      if (band.width < NAME_MIN_PX) continue;
      const name = namesEl.createDiv({ cls: "wadjet-studio-ruler-band-label", text: band.name });
      name.setCssProps({ "--wadjet-studio-ruler-band-left": `${band.mid}px`, "--wadjet-studio-ruler-name-color": band.colour });
    }
  }

  /**
   * The tick row. The prototype labels and nothing else — no cell dividers, so
   * the ruler reads as a scale rather than as a table. Labels are the
   * prototype's own compact forms (`d0`, `1200`), not the header's readout
   * grammar, because a tick has 24 px to say a number in.
   */
  function paintTicks(state: StudioState, geo: RowGeometry): void {
    stripEl.empty();
    const yearLength = spanCalendarFor(props.ctx, state)?.yearLength ?? DEFAULT_YEAR_LENGTH;
    const plan = ticks(geo.window, geo.widthPx, { year: tickYear, day: (_year, dayIndex) => tickDay(dayIndex, yearLength) });
    for (const t of plan) {
      const el = stripEl.createDiv({ cls: "wadjet-studio-tick wadjet-studio-ruler-tick" });
      el.toggleClass("is-major", t.major);
      el.setCssProps({ "--wadjet-studio-ruler-tick-left": `${yearToPx(t.year, geo.window, geo.widthPx)}px` });
      if (t.label !== "") el.createSpan({ cls: "wadjet-studio-ruler-tick-label wadjet-studio-num", text: t.label });
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
