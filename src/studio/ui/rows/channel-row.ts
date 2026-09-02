/**
 * The four composed channel rows (SPEC §3.2, §9; PLAN §7).
 *
 * One `PlaylistRow` per signal chain, built from `playlist.ts`'s `CHANNELS`
 * list so the label, colour, order and hint key stay where the mixer can read
 * them. What this file adds is the row's *body*: a Chart, sized to the
 * measured lane width, drawn from `model/channel-series.ts`.
 *
 * Three things worth knowing before editing it:
 *
 *  - **The morph picks the data, not the drawing.** `geo.morph.fine` (and a
 *    window no wider than `FINE_MAX_YEARS`) means the row draws the *real
 *    roll* — `rollCached` per year in the window, one point per rolled day,
 *    never an average (SPEC law 4). Anything wider draws the resolved
 *    climate's yearly ribbon repeated per year, and wider than
 *    `RIBBON_FLAT_YEARS` draws one flat mean line, because at Era zoom a
 *    thousand repeats of a 13-point ring is a grey smear that costs 14 000
 *    points to produce.
 *  - **Nothing is redrawn unless something moved.** Every render computes
 *    `seriesKey` — mode, data identity (the `auditionKey`s at fine zoom, the
 *    profile hash at wide zoom), window and measured width — *before* it does
 *    any work, and returns on a hit. A knob drag that does not touch this
 *    channel never rebuilds this SVG (PLAN §7).
 *  - **Colour is the palette (SPEC §9).** The chain's own custom property for
 *    the headline series, `--wadjet-studio-moon` for the second one; the row
 *    never invents a hue and never takes one from a caller.
 *
 * Temperature is the one row with two charts stacked in the body: `Chart`'s
 * `band` kind fills between two series and strokes the upper one, which leaves
 * nowhere to put the mean line SPEC §3.2 asks for. Two instances of a part in
 * the bin is not a tenth part (SPEC law 3), and the band chart only exists at
 * fine zoom.
 */
import { auditionKey, rollCached, type AuditionDay, type AuditionInput } from "../../model/audition";
import { FINE_MAX_YEARS, fineSeries, flatMean, RIBBON_FLAT_YEARS, ribbonAcross, ribbonSeries, ribbonSourceKey, seriesKey, windowPoints, yRangeFor, type ChannelSeries, type SeriesRole, type YearGrid } from "../../model/channel-series";
import type { Channel } from "../../model/compile";
import { channelHint, channelRowDetail } from "../../model/hints-channels";
import { playlistHint } from "../../model/hints-playlist";
import type { StudioState } from "../../model/state";
import { createChart, type ChartComponent, type ChartSeries } from "../components";
import type { PlaylistRow, RowGeometry, RowHost } from "../playlist";
import type { SurfaceContext } from "../surfaces";
// The id is the CHANNEL WINDOW's to define (`ui/windows/channel.ts`), not this
// row's: the row is only one of the things that opens the panel.
import { channelWindowId } from "../windows/channel";

/** The channel row's body height in px. Must equal `--wadjet-studio-channel-h`. */
export const CHANNEL_ROW_HEIGHT = 48;

/** The shape `playlist.ts`'s `CHANNELS` entries have; taken structurally so the list stays the mixer's to read. */
export interface ChannelSpec {
  id: Channel;
  label: string;
  color: string;
  order: number;
  hint: string;
}

/**
 * The calendar grid the fractional-year x axis is measured on — the same
 * `epochYear`/`yearLength` the playlist's own bounds use, so a point lands on
 * the pixel the ruler puts that day at.
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
 * so at `salt: 0` the curve is byte-for-byte the weather the vault reports.
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

/** Precipitation's amount is the only filled series: the wet-day marks read as bars, not a line. */
function toChartSeries(series: readonly ChannelSeries[], channelColor: string): ChartSeries[] {
  return series.map((s) => (s.role === "amount" ? { points: s.points, color: colorFor(s.role, channelColor), fill: true } : { points: s.points, color: colorFor(s.role, channelColor) }));
}

type Mode = "fine" | "ribbon" | "flat" | "empty";

/** What the row would draw, decided before any of it is derived. */
interface Plan {
  mode: Mode;
  source: string;
  inputs: AuditionInput[];
}

/**
 * The mode and the data's identity, cheaply: a hash per year at fine zoom, one
 * profile hash otherwise. Everything expensive happens only after `seriesKey`
 * has said the row actually moved.
 */
function planFor(ctx: SurfaceContext, state: StudioState, geo: RowGeometry): Plan {
  const grid = yearGridFor(ctx);
  const id = state.view.zoneId;
  const zone = id === null ? undefined : state.zones[id];
  if (zone === undefined || grid === null) return { mode: "empty", source: "none", inputs: [] };

  const span = geo.window.b - geo.window.a;
  if (geo.morph.fine && span <= FINE_MAX_YEARS) {
    const inputs: AuditionInput[] = [];
    for (const year of yearsIn(geo.window.a, geo.window.b)) {
      const input = auditionInputFor(ctx, state, year);
      if (input !== null) inputs.push(input);
    }
    // `auditionKey` folds in the profile, calendar, eras, salt and pins, so
    // the joined keys are the whole identity of what the fine curve draws.
    if (inputs.length > 0) return { mode: "fine", source: inputs.map((i) => auditionKey(i)).join(","), inputs };
  }
  return { mode: span > RIBBON_FLAT_YEARS ? "flat" : "ribbon", source: ribbonSourceKey(zone), inputs: [] };
}

export function createChannelRow(channel: ChannelSpec): PlaylistRow {
  const id = channel.id;
  let context: SurfaceContext | null = null;
  let labelEl: HTMLElement | null = null;
  let plotEl: HTMLElement | null = null;
  let bandEl: HTMLElement | null = null;
  let lineEl: HTMLElement | null = null;
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
  function chartIn(parent: HTMLElement, existing: ChartComponent | null, kind: "curve" | "band", geo: RowGeometry, series: ChartSeries[], yRange: [number, number]): ChartComponent {
    if (existing !== null) {
      existing.update({ kind, width: geo.widthPx, height: CHANNEL_ROW_HEIGHT, series, yRange });
      return existing;
    }
    return createChart(parent, { kind, domain: "year", width: geo.widthPx, height: CHANNEL_ROW_HEIGHT, series, yRange });
  }

  function draw(state: StudioState, geo: RowGeometry, plan: Plan): void {
    const bandHost = bandEl;
    const lineHost = lineEl;
    if (bandHost === null || lineHost === null || context === null) return;

    let series: ChannelSeries[] = [];
    if (plan.mode === "fine") {
      const grid = yearGridFor(context);
      const days: AuditionDay[] = [];
      for (const input of plan.inputs) days.push(...rollCached(input).days);
      const fine = grid === null ? [] : fineSeries(days, id, grid);
      // Fine points arrive in fractional years; the Chart's `"year"` domain
      // plots [0,1], so the window itself becomes the x axis.
      series = fine.map((s) => ({ role: s.role, points: windowPoints(s.points, geo.window.a, geo.window.b) }));
    } else if (plan.mode === "ribbon" || plan.mode === "flat") {
      const zone = state.view.zoneId === null ? undefined : state.zones[state.view.zoneId];
      const ribbon = zone === undefined ? [] : ribbonSeries(zone, id);
      series = plan.mode === "flat" ? flatMean(ribbon) : ribbonAcross(ribbon, geo.window.a, geo.window.b);
    }

    const yRange = yRangeFor(id, series);
    // The band is temperature's low/high pair; every other channel draws lines only.
    const bandPair = id === "temperature" ? series.filter((s) => s.role === "low" || s.role === "high") : [];
    const lines = series.filter((s) => !bandPair.includes(s));

    const hasBand = bandPair.length >= 2;
    bandHost.toggleClass("is-hidden", !hasBand);
    if (hasBand) band = chartIn(bandHost, band, "band", geo, toChartSeries(bandPair, channel.color), yRange);
    else if (band !== null) band.update({ series: [] });

    line = chartIn(lineHost, line, "curve", geo, toChartSeries(lines, channel.color), yRange);
  }

  return {
    id: channel.id,
    label: channel.label,
    order: channel.order,

    mount(host: RowHost) {
      context = host.ctx;
      labelEl = host.label;
      host.label.setAttr("data-hint", playlistHint(channel.hint, channelRowDetail(id)));
      host.label.addClass("is-clickable");
      host.label.setAttrs({ role: "button", tabindex: "0" });
      host.label.addEventListener("click", open);
      host.label.addEventListener("keydown", onLabelKey);

      plotEl = host.body.createDiv({ cls: "wadjet-studio-channel", attr: { "data-channel": channel.id, "data-hint": channelHint("channel.plot", channelRowDetail(id)) } });
      plotEl.setCssProps({ "--wadjet-studio-channel-color": channel.color });
      plotEl.addEventListener("click", open);
      bandEl = plotEl.createDiv({ cls: "wadjet-studio-channel-layer is-band is-hidden" });
      lineEl = plotEl.createDiv({ cls: "wadjet-studio-channel-layer is-line" });
    },

    render(state: StudioState, geo: RowGeometry) {
      if (context === null) return;
      // Which zone THIS row is drawing. Cheap, and the one thing that makes a
      // second studio leaf's rows observable from outside (bead wadjet-9f9.45:
      // a row instance belongs to one leaf, so its plot must always carry that
      // leaf's zone — never the other leaf's).
      plotEl?.setAttr("data-zone", state.view.zoneId ?? "");
      // The playlist hides every row at Day zoom and shows the day card
      // instead; deriving a curve nothing can see is pure cost.
      if (geo.morph.isDay) return;
      const plan = planFor(context, state, geo);
      const key = seriesKey({ mode: plan.mode, source: plan.source, a: geo.window.a, b: geo.window.b, widthPx: geo.widthPx });
      if (key === painted) return;
      painted = key;
      draw(state, geo, plan);
    },

    destroy() {
      labelEl?.removeEventListener("click", open);
      labelEl?.removeEventListener("keydown", onLabelKey);
      labelEl = null;
      plotEl?.removeEventListener("click", open);
      band?.destroy();
      line?.destroy();
      band = null;
      line = null;
      plotEl?.remove();
      plotEl = null;
      bandEl = null;
      lineEl = null;
      painted = "";
      context = null;
    },
  };
}
