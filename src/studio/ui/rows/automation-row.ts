/**
 * The `FRC · warmth` playlist row (SPEC §3.2, §3.4 "Forcings · ZONE").
 *
 * One automation Chart drawn across the playlist's window: x is the world
 * year, y is °C, and the points are the zone's `automation[frc.warmth]` lane
 * (`model/automation-edit.ts` owns every edit; nothing is derived here).
 *
 * Three things worth knowing before editing this file:
 *
 *  - **The chart's x range is the window because the data says so.** The
 *    Chart component's `history` domain takes its x extent from the points it
 *    is handed, and there is no prop to override it. So the row hands it two
 *    series: series 0 is the *visible* points (the draggable ones, filtered
 *    to the window, with `visible` mapping each chart index back to its lane
 *    index), and series 1 is the lane sampled at both window edges plus those
 *    same interior points — a line that spans exactly `[window.a, window.b]`
 *    and therefore pins the extent to the window. Points outside the window
 *    are in neither: the SVG would clip them anyway, and a dot nobody can see
 *    must not be draggable.
 *  - **Adding a point is this file's own gesture, not the Chart's.** The
 *    component only offers `onAdd` on double-click; SPEC §3.2 wants
 *    click-drag on the empty lane to add a point *and keep dragging it*. The
 *    row therefore listens for `pointerdown` on the chart element — the
 *    component's own point handles `stopPropagation`, so only the empty lane
 *    reaches here — and maps the pixel back to (year, °C) itself. That is the
 *    one place `CHART_PAD` is needed; `test/studio-automation-edit.test.ts`
 *    holds it against the component's own `PAD` so the two cannot drift.
 *  - **One undo step per gesture** (PLAN D11). Add and drag both write
 *    without `history`, and the pointerup takes the single `snapshot()`, so a
 *    drag-create is one step and not two. Right-click removal is a discrete
 *    action and takes `history: true` directly.
 *
 * Trim is deliberately *not* drawn here: it is a constant offset with no
 * shape over time, and the Forcings window shows it as a knob (PLAN §5.3).
 */
import { Notice } from "obsidian";
import { laneValue } from "../../../core/automation";
import type { ZoneProfile } from "../../../core/types";
import { addPoint, ensureLane, hasLane, lanePoints, laneYRange, movePoint, removePoint, type LaneBounds, type LanePoint } from "../../model/automation-edit";
import { getWarmthLane } from "../../model/compile";
import { format } from "../../model/format";
import { forcingsHint } from "../../model/hints-forcings";
import type { StudioState } from "../../model/state";
import { worldBounds, type Window } from "../../model/zoom";
import { createChart, type ChartComponent, type ChartPhase, type ChartSeries } from "../components";
import { ROW_ORDER, type PlaylistRow, type RowGeometry, type RowHost } from "../playlist";
import { beginDrag } from "../pointer";
import { FORCINGS_WINDOW } from "../windows/forcings";

/** The row's id, in `ROW_ORDER` and in the playlist registry. */
export const AUTOMATION_ROW_ID = "automation";

/** Must equal `PAD` in `ui/components/chart.ts` — see the header note and its test. */
const CHART_PAD = 6;

/** The lane's drawn height. Must equal `--wadjet-studio-automation-h` in styles.css. */
const ROW_HEIGHT = 34;

/** Chart width to assume before the leaf has been laid out (`clientWidth` 0). */
const FALLBACK_WIDTH = 800;

/** What the lane was last painted with — the pixel → (year, °C) map a drag-create needs. */
interface Painted {
  window: Window;
  yRange: [number, number];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function zoneOf(state: StudioState): ZoneProfile | null {
  const id = state.view.zoneId;
  return id !== null ? (state.zones[id] ?? null) : null;
}

export function createAutomationRow(): PlaylistRow {
  let host: RowHost | null = null;
  let chart: ChartComponent | null = null;
  let cancelDrag: (() => void) | null = null;
  /** chart point index → lane point index, rebuilt on every paint */
  let visible: number[] = [];
  let painted: Painted = { window: { a: 0, b: 1 }, yRange: [-4, 4] };
  let signature = "";

  function openWindow(): void {
    host?.ctx.windows.open(FORCINGS_WINDOW);
  }

  function onLabelKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openWindow();
  }

  function epochYear(): number {
    const ctx = host?.ctx;
    return ctx?.calendar()?.epochYear ?? ctx?.plugin.settings.calendar.epochYear ?? 1;
  }

  function bounds(): LaneBounds {
    const world = worldBounds(epochYear(), host?.ctx.store.get().world.eras ?? []);
    const [minValue, maxValue] = painted.yRange;
    return { minYear: world.min, maxYear: world.max, minValue, maxValue };
  }

  /**
   * The pointer's (year, °C) on the lane, from the geometry the chart was last
   * painted with. Clamped to the plotted rectangle: the 6 px the chart pads
   * its plot with are still inside the element, so a press on the very top row
   * of pixels must read as the top of the range rather than past it.
   */
  function atPointer(ev: MouseEvent): { year: number; value: number } | null {
    const svg = chart?.el.querySelector("svg");
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const plotW = r.width - 2 * CHART_PAD;
    const plotH = r.height - 2 * CHART_PAD;
    if (plotW <= 0 || plotH <= 0) return null;
    const { window: w, yRange } = painted;
    const fx = (ev.clientX - r.left - CHART_PAD) / plotW;
    const fy = (ev.clientY - r.top - CHART_PAD) / plotH;
    const year = clamp(w.a + fx * (w.b - w.a), w.a, w.b);
    const value = clamp(yRange[0] + (1 - fy) * (yRange[1] - yRange[0]), yRange[0], yRange[1]);
    return { year, value };
  }

  /** Drag an existing point: the Chart hands (year, °C) back in the units it was drawn in. */
  function onPoint(index: number, x: number, y: number, phase: ChartPhase): void {
    const ctx = host?.ctx;
    const lane = visible[index];
    if (ctx === undefined || lane === undefined) return;
    const b = bounds();
    ctx.store.update((s) => {
      const z = zoneOf(s);
      if (z !== null) movePoint(z, lane, x, y, b);
    });
    if (phase === "end") ctx.store.snapshot();
  }

  function onRemove(index: number): void {
    const ctx = host?.ctx;
    const lane = visible[index];
    if (ctx === undefined || lane === undefined) return;
    let removed = false;
    ctx.store.update(
      (s) => {
        const z = zoneOf(s);
        if (z !== null) removed = removePoint(z, lane);
      },
      { history: true },
    );
    if (!removed) new Notice("The warmth lane keeps at least two points");
  }

  /** Click-drag on the empty lane: add a point under the cursor and keep dragging it. */
  function onLaneDown(ev: PointerEvent): void {
    const ctx = host?.ctx;
    const target = chart?.el;
    if (ctx === undefined || target === undefined || ev.button !== 0) return;
    const at = atPointer(ev);
    if (at === null) return;
    ev.preventDefault();

    const epoch = epochYear();
    let index = -1;
    ctx.store.update((s) => {
      const z = zoneOf(s);
      if (z === null) return;
      // A zone with no lane yet gets its two neutral points first, so the
      // gesture can never leave a one-point lane behind (SPEC §3.2).
      if (!hasLane(z)) ensureLane(z, epoch);
      index = addPoint(z, at.year, at.value);
    });
    if (index < 0) return;

    const b = bounds();
    const drag = (move: MouseEvent): void => {
      const to = atPointer(move);
      if (to === null) return;
      ctx.store.update((s) => {
        const z = zoneOf(s);
        if (z !== null) movePoint(z, index, to.year, to.value, b);
      });
    };
    cancelDrag = beginDrag(ev, {
      capture: target,
      onMove: (move) => drag(move),
      onEnd: (end, _dx, _dy, moved) => {
        cancelDrag = null;
        if (moved) drag(end);
        // One step for the whole gesture, the add included (PLAN D11).
        ctx.store.snapshot();
      },
    });
  }

  function paint(state: StudioState, geo: RowGeometry): void {
    if (chart === null) return;
    const zone = zoneOf(state);
    const w = geo.window;
    const width = geo.widthPx > 0 ? geo.widthPx : FALLBACK_WIDTH;
    const all: LanePoint[] = zone === null ? [] : lanePoints(zone);
    const drawn = all.length > 0;

    // Series 0: the draggable points, and only the ones the window shows.
    const inside: LanePoint[] = [];
    visible = [];
    all.forEach((p, i) => {
      if (p[0] >= w.a && p[0] <= w.b) {
        inside.push(p);
        visible.push(i);
      }
    });

    // Series 1: the lane across exactly this window — what pins the chart's x
    // extent, and what draws the flat run either side of the authored points.
    const at = (year: number): number => (zone === null ? 0 : laneValue(getWarmthLane(zone), year));
    const line: LanePoint[] = [[w.a, at(w.a)], ...inside, [w.b, at(w.b)]];
    const yRange = laneYRange(all);
    // Warmth feeds TEMP, so the lane wears TEMP's hue whether or not the zone
    // has authored a point yet (SPEC §9: the lane IS the data). An empty lane
    // says so by being flat at neutral, not by going grey.
    const color = "var(--wadjet-studio-temp)";
    const series: ChartSeries[] = [
      { points: inside, color },
      { points: line, color },
    ];

    painted = { window: w, yRange };
    // The value under the window's centre — what the lane is worth right here.
    const units = host?.ctx.plugin.settings.units ?? "metric";
    const now = format(at((w.a + w.b) / 2), "temperatureDelta", units, { digits: 1 });
    host?.sub.setText(`${now.text} ${now.unit}`);

    const key = `${width}|${w.a}|${w.b}|${yRange[0]}|${yRange[1]}|${drawn}|${JSON.stringify(all)}`;
    if (key === signature) return;
    signature = key;
    // Neutral is the reading the lane is *about*: without a line at 0 a flat
    // run at +2 °C looks exactly like a flat run at 0.
    chart.update({ width, height: ROW_HEIGHT, series, yRange, rules: [{ value: 0, dash: "2 4", color: "var(--wadjet-studio-precip)" }] });
  }

  return {
    id: AUTOMATION_ROW_ID,
    label: "FRC · warmth",
    order: ROW_ORDER.automation,

    mount(next) {
      host = next;
      next.row.el.addClass("wadjet-studio-automation-row");
      next.label.setAttrs({ "data-hint": forcingsHint("forcings.row"), "data-part": "automation-label", role: "button", tabindex: "0" });
      next.dot.setCssProps({ "--wadjet-studio-row-dot-color": "var(--wadjet-studio-temp)" });
      next.label.addEventListener("click", openWindow);
      next.label.addEventListener("keydown", onLabelKey);

      chart = createChart(next.body, {
        kind: "automation",
        domain: "history",
        width: FALLBACK_WIDTH,
        height: ROW_HEIGHT,
        series: [],
        yRange: [-4, 4],
        editable: true,
        onPoint,
        onRemove,
      });
      chart.el.addClass("wadjet-studio-automation-lane");
      chart.el.setAttrs({ "data-hint": forcingsHint("forcings.points"), "data-part": "automation-lane" });
      chart.el.addEventListener("pointerdown", onLaneDown);
    },

    render(state, geo) {
      paint(state, geo);
    },

    destroy() {
      cancelDrag?.();
      cancelDrag = null;
      chart?.el.removeEventListener("pointerdown", onLaneDown);
      chart?.destroy();
      chart = null;
      host?.label.removeEventListener("click", openWindow);
      host?.label.removeEventListener("keydown", onLabelKey);
      host = null;
      visible = [];
      signature = "";
    },
  };
}
