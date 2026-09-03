/**
 * The four composed channel rows (SPEC §3.2, §9; PLAN §7).
 *
 * One `PlaylistRow` per signal chain, built from `playlist.ts`'s `CHANNELS`
 * list so the label, colour, order and hint key stay where the mixer can read
 * them. What this file adds is the row's *body*: the composed climate drawn
 * across the window, sized to the measured lane width.
 *
 * Four things worth knowing before editing it:
 *
 *  - **The row draws the COMPOSED curve, not the roll.** SPEC §3.2's "fine
 *    zoom → composed curves" is literal: at Year, Season and Month zoom the
 *    row samples the *resolved* climate (`model/channel-series.ts`'s
 *    `composedAcross` — every climate-stage layer the mixer wrote is already
 *    in it) at `COMPOSED_SAMPLES` points across the window. A per-day roll was
 *    drawn here until this bead; it made the seasonal shape — the single most
 *    important reading in the studio — invisible under day-to-day jitter, and
 *    a day's rolled weather is what the audition strip and the day card are
 *    for. Only Era zoom leaves the curve: past `RIBBON_FLAT_YEARS` the yearly
 *    shape cannot resolve at all, so the row draws the yearly ribbon's mean.
 *  - **The spread band is the second reading.** Temperature fills between the
 *    day's low and high (its `diurnalRange`), wind between speed ± its SD,
 *    precipitation from the wet-day fraction down to the floor. Each is a
 *    `Chart` layer stacked under the headline line.
 *  - **Sky is a cell strip, not a curve.** Cloud cover has no shape worth a
 *    line; the prototype shades one swatch per sampled slice, which is the
 *    same object the audition strip's day cells are.
 *  - **Nothing is redrawn unless something moved.** Every render computes
 *    `seriesKey` — mode, profile identity, window and measured width — before
 *    it does any work, and returns on a hit.
 */
import type { AuditionInput } from "../../model/audition";
import { erasHash } from "../../../core/eras";
import { axisLabelled, axisTicks, composedAcross, HEADLINE_ROLE, RIBBON_FLAT_YEARS, ribbonSourceKey, seriesKey, statsOf, steppedAcross, yRangeFor, type ChannelSeries, type SeriesRole, type YearGrid } from "../../model/channel-series";
import type { Channel } from "../../model/compile";
import { displayName } from "../../model/copy";
import { format } from "../../model/format";
import { channelHint, channelRowDetail } from "../../model/hints-channels";
import { playlistHint } from "../../model/hints-playlist";
import type { StudioState } from "../../model/state";
import { ticks, yearToPx } from "../../model/zoom";
import type { Units } from "../../../core/units";
import { createChart, type ChartComponent, type ChartRule, type ChartSeries } from "../components";
import type { PlaylistRow, RowGeometry, RowHost } from "../playlist";
import { calendarBands } from "../ruler";
import type { SurfaceContext } from "../surfaces";
// The id is the CHANNEL WINDOW's to define (`ui/windows/channel.ts`), not this
// row's: the row is only one of the things that opens the panel.
import { channelWindowId } from "../windows/channel";

/**
 * The row body's height per channel, in px. SPEC §3.2's proportions: the
 * temperature row is the studio's anchor and gets the most vertical
 * resolution, sky the least because a strip of swatches needs none.
 * Must equal `--wadjet-studio-channel-h` per `[data-channel]` in styles.css.
 */
export const CHANNEL_ROW_HEIGHT: Record<Channel, number> = {
  temperature: 150,
  precipitation: 104,
  wind: 84,
  sky: 28,
};

/** Kept for callers that only need "how tall is a channel row" without a channel. */
export const DEFAULT_CHANNEL_ROW_HEIGHT = CHANNEL_ROW_HEIGHT.temperature;

/** Swatches in the Sky strip. The prototype's own count, and independent of zoom. */
export const SKY_CELLS = 56;

/** Vertical padding the Chart component reserves; the axis column has to agree with it. */
const CHART_PAD = 6;

/** The grid only needs the ticks' POSITIONS; the ruler above already labels them. */
const TICK_POSITIONS_ONLY = { year: () => "", day: () => "" };

/** The shape `playlist.ts`'s `CHANNELS` entries have; taken structurally so the list stays the mixer's to read. */
export interface ChannelSpec {
  id: Channel;
  label: string;
  color: string;
  order: number;
  hint: string;
}

/**
 * The calendar grid a fractional-year x axis is measured on — the same
 * `epochYear`/`yearLength` the playlist's own bounds use. Kept here (rather
 * than moved) because `ui/day-card.ts` reads it from this module.
 */
export function yearGridFor(ctx: SurfaceContext): YearGrid | null {
  const described = ctx.calendar();
  const yearLength = described?.yearLength ?? 0;
  if (yearLength <= 0) return null;
  return { yearLength, epochYear: described?.epochYear ?? ctx.plugin.settings.calendar.epochYear ?? 1 };
}

/**
 * The audition input for one year of the selected zone's draft, or `null`
 * when there is no zone or the adapter cannot be reached. Identical in every
 * field to the one `ui/audition.ts` builds — same seed, same salt, same pins —
 * so at `salt: 0` the day it reports is byte-for-byte the weather the vault
 * reports. The channel rows no longer roll (they draw the composed curve);
 * `ui/day-card.ts` does, and reads this from here.
 */
export function auditionInputFor(ctx: SurfaceContext, state: StudioState, year: number): AuditionInput | null {
  const adapter = ctx.plugin.time.active;
  const id = state.view.zoneId;
  const zone = id === null ? undefined : state.zones[id];
  if (adapter === null || adapter === undefined || zone === undefined) return null;
  return {
    zone,
    eras: state.world.eras,
    seed: ctx.plugin.settings.worldSeed,
    adapter,
    year,
    salt: state.view.rerollSalt,
    overrides: state.world.overrides,
  };
}

/** Every whole year the window `[a, b]` touches. */
export function yearsIn(a: number, b: number): number[] {
  const years: number[] = [];
  for (let y = Math.floor(a); y <= Math.floor(b); y++) years.push(y);
  return years;
}

/** SPEC §9: the chain's own colour leads, the moon's neutral hue carries the second line. */
function colorFor(role: SeriesRole, channelColor: string): string {
  return role === "pww" || role === "cloudWet" ? "var(--wadjet-studio-moon)" : channelColor;
}

type Mode = "composed" | "flat" | "empty";

/** What the row would draw, decided before any of it is derived. */
interface Plan {
  mode: Mode;
  source: string;
}

/** The mode and the data's identity, cheaply — one profile hash, no roll. */
function planFor(state: StudioState, geo: RowGeometry): Plan {
  const id = state.view.zoneId;
  const zone = id === null ? undefined : state.zones[id];
  if (zone === undefined) return { mode: "empty", source: "none" };
  const span = geo.window.b - geo.window.a;
  // The eras are part of the plotted shape now (they step the curve), so they
  // are part of its identity: an era edit must invalidate the memoised SVG.
  return { mode: span > RIBBON_FLAT_YEARS ? "flat" : "composed", source: `${ribbonSourceKey(zone)}|${erasHash(state.world.eras)}` };
}

/**
 * The row's second label line (SPEC §3.2): what this channel is actually
 * doing in the window on screen. Every number goes through `format.ts`, so a
 * reader on imperial units gets °F and mph without this file knowing.
 */
export function channelSub(channel: Channel, series: readonly ChannelSeries[], units: Units): string {
  // The ribbon's sky role is `cloudDry`, the composed one's is `cloud`; either
  // way the row's headline is the first series it was handed.
  const stats = statsOf(series, HEADLINE_ROLE[channel]) ?? (series[0] === undefined ? null : statsOf(series, series[0].role));
  if (stats === null) return "";
  const range = (q: "temperature" | "speed", digits: number): string => {
    const lo = format(stats.min, q, units, { digits });
    const hi = format(stats.max, q, units, { digits });
    return `${lo.text} – ${hi.text} ${hi.unit}`;
  };
  switch (channel) {
    case "temperature":
      return range("temperature", 1);
    case "wind":
      return range("speed", 0);
    case "precipitation":
      return `wet ${Math.round(stats.mean * 100)}% of days`;
    case "sky":
      return `cloud ${Math.round(stats.mean * 100)}%`;
  }
}

/** An axis value's own text: bare degrees on temperature, a leading-dot fraction on precipitation. */
function axisText(channel: Channel, value: number, units: Units): string {
  switch (channel) {
    case "temperature":
      return `${format(value, "temperature", units, { digits: 0 }).text}°`;
    case "precipitation":
      return format(value, "fraction", units, { digits: 2 }).text.replace(/^0/, "").replace(/0$/, "");
    case "wind":
      return format(value, "speed", units, { digits: 0 }).text;
    case "sky":
      return "";
  }
}

export function createChannelRow(channel: ChannelSpec): PlaylistRow {
  const id = channel.id;
  const height = CHANNEL_ROW_HEIGHT[id];
  let context: SurfaceContext | null = null;
  let host: RowHost | null = null;
  let plotEl: HTMLElement | null = null;
  let bandsEl: HTMLElement | null = null;
  let bandEl: HTMLElement | null = null;
  let lineEl: HTMLElement | null = null;
  let cellsEl: HTMLElement | null = null;
  let band: ChartComponent | null = null;
  let line: ChartComponent | null = null;
  /** The last `seriesKey` drawn. Empty means "nothing drawn yet". */
  let painted = "";

  function open(): void {
    context?.windows.open(channelWindowId(id));
  }

  function onLabelKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    open();
  }

  /** The chart for one layer, created on first use so the row costs nothing until it draws. */
  function chartIn(parent: HTMLElement, existing: ChartComponent | null, kind: "curve" | "band", geo: RowGeometry, series: ChartSeries[], yRange: [number, number], rules: ChartRule[]): ChartComponent {
    const next = { kind, width: geo.widthPx, height, series, yRange, rules, padX: 0 };
    if (existing !== null) {
      existing.update(next);
      return existing;
    }
    return createChart(parent, { ...next, domain: "year" as const });
  }

  /**
   * The calendar showing through, behind the curve: the same season (or era)
   * bands the ruler draws, full height, plus a hairline at every ruler tick.
   * SPEC §3.2 — the seasonal shape has to be legible even before the curve is.
   */
  function paintBands(state: StudioState, geo: RowGeometry): void {
    const el = bandsEl;
    const ctx = context;
    if (el === null || ctx === null) return;
    el.empty();
    for (const b of calendarBands(ctx, state, geo)) {
      const node = el.createDiv({ cls: "wadjet-studio-channel-band" });
      node.setCssProps({
        "--wadjet-studio-ruler-band-left": `${b.left}px`,
        "--wadjet-studio-ruler-band-width": `${b.width}px`,
        "--wadjet-studio-ruler-band-color": b.tint,
      });
    }
    // A hairline under every labelled ruler tick: the chart's own x scale,
    // read off the same plan the ruler drew (`model/zoom.ts`'s `ticks`).
    for (const t of ticks(geo.window, geo.widthPx, TICK_POSITIONS_ONLY)) {
      if (!t.major) continue;
      const line = el.createDiv({ cls: "wadjet-studio-channel-grid" });
      line.setCssProps({ "--wadjet-studio-ruler-band-left": `${yearToPx(t.year, geo.window, geo.widthPx)}px` });
    }
  }

  /** The y-axis values, in the row's own 44 px gutter (SPEC §3.2's `15° 10° 5° 0°`). */
  function paintAxis(values: readonly number[], yRange: [number, number], units: Units): void {
    const el = host?.axis;
    if (el === undefined) return;
    el.empty();
    const [lo, hi] = yRange;
    if (!(hi > lo)) return;
    for (const v of values) {
      const text = axisText(id, v, units);
      if (text === "") continue;
      const y = CHART_PAD + (1 - (v - lo) / (hi - lo)) * (height - 2 * CHART_PAD);
      const node = el.createSpan({ cls: "wadjet-studio-axis-tick wadjet-studio-num", text });
      node.setCssProps({ "--wadjet-studio-axis-top": `${y}px` });
    }
  }

  /** Sky: one shaded swatch per sampled slice of the window, gutters and all. */
  function paintCells(series: readonly ChannelSeries[]): void {
    const el = cellsEl;
    if (el === null) return;
    el.empty();
    // At Era zoom the row falls back to the yearly ribbon, whose sky role is
    // `cloudDry` rather than the composed `cloud` — either way the first
    // series is the one the strip shades with.
    const cloud = series.find((s) => s.role === "cloud") ?? series[0];
    if (cloud === undefined || cloud.points.length === 0) return;
    for (let i = 0; i < SKY_CELLS; i++) {
      const at = Math.min(cloud.points.length - 1, Math.round(((i + 0.5) / SKY_CELLS) * (cloud.points.length - 1)));
      const g = Math.max(0, Math.min(1, cloud.points[at]![1]));
      const cell = el.createDiv({ cls: "wadjet-studio-channel-cell" });
      // The prototype's own ramp: a nearly black overcast-free sky up to a
      // pale grey overcast one, on the studio's neutral hue.
      cell.setCssProps({ "--wadjet-studio-cell-color": `hsl(220, 5%, ${(13 + g * 44).toFixed(1)}%)` });
    }
  }

  function draw(state: StudioState, geo: RowGeometry, plan: Plan): void {
    const bandHost = bandEl;
    const lineHost = lineEl;
    if (bandHost === null || lineHost === null || context === null) return;

    const zoneId = state.view.zoneId;
    const zone = zoneId === null ? undefined : state.zones[zoneId];
    let series: ChannelSeries[] = [];
    if (zone !== undefined) {
      const eras = state.world.eras;
      series = plan.mode === "flat" ? steppedAcross(zone, id, geo.window.a, geo.window.b, eras) : composedAcross(zone, id, geo.window.a, geo.window.b, undefined, eras);
    }

    const units = context.plugin.settings.units;
    host?.sub.setText(channelSub(id, series, units));

    if (id === "sky") {
      paintCells(series);
      paintAxis([], [0, 1], units);
      return;
    }

    const yRange = yRangeFor(id, series);
    const ticks = axisTicks(id, yRange[0], yRange[1]);
    paintAxis(axisLabelled(id, ticks), yRange, units);

    // A grid line is solid and the playlist's own hairline; the Chart never
    // declares its own paint, so the row names the hue it wants.
    const rules: ChartRule[] = ticks.map((y) => ({ value: y, color: "var(--wadjet-studio-hairline)" }));
    // Freezing is the one value on the temperature axis that means something
    // by itself, so it is a reference line rather than a grid line — and a
    // reference is what `dash` says.
    if (id === "temperature" && yRange[0] < 0 && yRange[1] > 0) rules.push({ value: 0, dash: "2 4", color: "var(--wadjet-studio-precip)" });

    // The spread band is a low/high pair; the headline line is everything else.
    const bandPair = series.filter((s) => s.role === "low" || s.role === "high");
    const lines = series.filter((s) => !bandPair.includes(s));
    const chartLines: ChartSeries[] = lines.map((s) => (s.role === "amount" ? { points: s.points, color: colorFor(s.role, channel.color), fill: true } : { points: s.points, color: colorFor(s.role, channel.color) }));

    const hasBand = bandPair.length >= 2;
    bandHost.toggleClass("is-hidden", !hasBand);
    // `Chart`'s band kind strokes its upper series as well as filling between
    // the pair. Here the band is a *background* — the headline line is the one
    // stroke the row draws — so the upper edge is handed a transparent stroke
    // rather than the channel's hue.
    if (hasBand) band = chartIn(bandHost, band, "band", geo, [{ points: bandPair[0]!.points, color: channel.color }, { points: bandPair[1]!.points, color: "transparent" }], yRange, []);
    else if (band !== null) band.update({ series: [] });

    line = chartIn(lineHost, line, "curve", geo, chartLines, yRange, rules);
  }

  return {
    id: channel.id,
    // Title case, not the mixer's `TEMP`: the caps short forms are the signal
    // path's vocabulary, and the arrangement view is a different reading.
    label: displayName(channel.id),
    order: channel.order,

    mount(next: RowHost) {
      context = next.ctx;
      host = next;
      next.row.el.addClass("wadjet-studio-channel-row");
      next.label.setAttr("data-hint", playlistHint(channel.hint, channelRowDetail(id)));
      next.label.addClass("is-clickable");
      next.label.setAttrs({ role: "button", tabindex: "0" });
      next.label.addEventListener("click", open);
      next.label.addEventListener("keydown", onLabelKey);
      // The label's accent stripe and its name both wear the chain's hue: the
      // one place in the playlist where colour names a thing rather than data.
      next.label.setCssProps({ "--wadjet-studio-channel-color": channel.color });
      next.dot.addClass("is-hidden");

      plotEl = next.body.createDiv({ cls: "wadjet-studio-channel", attr: { "data-channel": channel.id, "data-hint": channelHint("channel.plot", channelRowDetail(id)) } });
      plotEl.setCssProps({ "--wadjet-studio-channel-color": channel.color, "--wadjet-studio-channel-h": `${height}px` });
      plotEl.addEventListener("click", open);
      bandsEl = plotEl.createDiv({ cls: "wadjet-studio-channel-bands" });
      bandEl = plotEl.createDiv({ cls: "wadjet-studio-channel-layer is-band is-hidden" });
      lineEl = plotEl.createDiv({ cls: "wadjet-studio-channel-layer is-line" });
      if (id === "sky") cellsEl = plotEl.createDiv({ cls: "wadjet-studio-channel-cells" });
    },

    render(state: StudioState, geo: RowGeometry) {
      if (context === null) return;
      // Which zone THIS row is drawing. Cheap, and the one thing that makes a
      // second studio leaf's rows observable from outside (bead wadjet-9f9.45:
      // a row instance belongs to one leaf, so its plot must always carry that
      // leaf's zone — never the other leaf's).
      plotEl?.setAttr("data-zone", state.view.zoneId ?? "");
      const plan = planFor(state, geo);
      const key = seriesKey({ mode: plan.mode, source: plan.source, a: geo.window.a, b: geo.window.b, widthPx: geo.widthPx });
      // The bands follow the window, so they repaint whenever the key moves —
      // which is exactly when the curve under them does.
      if (key === painted) return;
      painted = key;
      paintBands(state, geo);
      draw(state, geo, plan);
    },

    destroy() {
      host?.label.removeEventListener("click", open);
      host?.label.removeEventListener("keydown", onLabelKey);
      host?.row.el.removeClass("wadjet-studio-channel-row");
      host?.axis.empty();
      host = null;
      plotEl?.removeEventListener("click", open);
      band?.destroy();
      line?.destroy();
      band = null;
      line = null;
      plotEl?.remove();
      plotEl = null;
      bandsEl = null;
      bandEl = null;
      lineEl = null;
      cellsEl = null;
      painted = "";
      context = null;
    },
  };
}
