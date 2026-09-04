/**
 * The channel editor windows (SPEC §3.4 "Channel editors", PLAN §5.2).
 *
 * One panel per signal chain, opened by its row label on the playlist
 * (SPEC law 2 — the row *is* the channel, so the row opens it). It is
 * landscape and two-columned, at the prototype's 1078 px (1080 outer, once its
 * own 1 px rim is counted — see `WINDOW_W`):
 *
 * LEFT — the plots and nothing else. One block per plot, stacked:
 *
 *   Axis caption   what that plot draws and in what unit (`MEAN °C`,
 *                  `SPEED · KM/H`, `P(WET)`), so its ticks can be bare numbers
 *   Legend         a paired plot's two lines, each in its own colour and dash
 *                  — and the picker: clicking one moves the handles onto it,
 *                  so the pair is compared *and* edited without a control the
 *                  prototype has no counterpart for
 *   Chart          season tint bands, y-axis ticks, the value rule, the
 *                  ± spread ribbon, the station's own curve dashed
 *                  underneath, the wet-day ghost dashed above, and the drawn
 *                  curve in the channel's colour with 12 handles that drag
 *
 * Which parameters go on which plot is `chartPlots(channel)`; a pair shares an
 * axis (PRECIP's Markov odds, SKY's dry/wet halves) and anything measured in
 * something else gets its own plot (millimetres, calm days).
 *
 *   Rose           WIND only, beside the plots: which way each season blows
 *                  from, over rings and the four cardinals, read-only
 *
 * RIGHT — one card per readout *about* the plot:
 *
 *   Selected point the handle under the finger, as a calendar day and a value
 *   Channel macros the scope chips (`All year · <seasons> · ☾ <moons>`, an
 *                  outlined chip row, NOT a Segmented), the knob set
 *                  `knobsFor(scope)` names, and the stage caption naming the
 *                  modifier id that scope writes
 *   Writers        every source that writes this channel in signal order,
 *                  each row a click-through to the window that owns it
 *   Stats          the drawn range and the scalars behind the curve
 *
 * Three things worth knowing before editing this file:
 *
 *  - **Every write goes through `model/channel-edit.ts`, which goes through
 *    `model/compile.ts`.** Nothing here builds a `Modifier`. That is what
 *    keeps the layer block rank-sorted and the swing layer re-derived when
 *    the effective base moves under it (PLAN §0.1 "Compiler").
 *  - **The chart is the bin's `automation` kind, not `curve`.** `curve` draws
 *    a line and nothing else; `automation` is the one kind in the closed bin
 *    (SPEC law 3) whose first series has draggable handles, `onAdd` and
 *    `onRemove` — exactly the three gestures SPEC §3.4/§3.8 asks a channel
 *    chart for. Adding a sixth chart kind would be a new part, which this is
 *    not worth.
 *  - **The ☾ scope re-domains the chart** to `domain: "cycle"` and draws the
 *    layer's envelope on a 0–1 strength axis — the same axis
 *    `windows/device.ts` draws an onset envelope on, because it is the same
 *    object (PLAN §0.1: envelopes are dimmers, bounded to [0, 1]). The °C it
 *    is worth is `depth × strength`, and depth is the knob.
 *
 * `CHANNEL_SPECS` is the per-channel *presentation* table — titles, colours,
 * knob labels, ranges and hints. Which parameter each knob and each drawn line
 * stands for is `model/channel-edit.ts`'s, so the panel and the pure round-trip
 * tests read one table, not two (SPEC §8 "Channel parity").
 */
import { Notice } from "obsidian";
import type { ZoneProfile } from "../../../core/types";
import type { Units } from "../../../core/units";
import { addEnvelopePoint, addKeyframe, ALL_SCOPE, channelStat, chartPlots, clearDirection, curvePoints, curveSamples, directionLayer, directionRose, knobsFor, layerGlob, MOON_GLYPH, parseScope, plotPoints, plotSamples, pointWhen, PRECIP_WET_SHARE, primarySeries, read, removeEnvelopePoint, removeKeyframe, scopeChips, seasonBands, seasonDirections, seasonScope, setEnvelopePoint, setKeyframe, spreadSamples, stageCaption, stationPoints, stationSamples, swungPoints, swungSamples, wetDayPoints, wetDaySamples, write, writers, writtenLayers, type ChannelStat, type KnobId, type WriterRow } from "../../model/channel-edit";
import { axisTicks as seriesAxisTicks } from "../../model/channel-series";
import type { Channel } from "../../model/compile";
import { grammar } from "../../model/copy";
import { format, fromDisplay, toDisplay, unitLabel, type Quantity } from "../../model/format";
import { channelEditorHint } from "../../model/hints-channel";
import type { KnobSpec } from "../../model/knob";
import { needsUnitParse, parseDisplay } from "../../model/knob-units";
import { cycleColour, SEASON_CYCLE } from "../../model/palette";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createChart, createChip, createKnob, type ChartComponent, type ChartSeries, type ChartTick, type ChipComponent, type KnobComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { openCycleFor } from "./cycle";

/** Channel editors are opened as `channel:<channel>` — the id `rows/channel-row.ts` clicks. */
export const CHANNEL_WINDOW_PREFIX = "channel:";

export function channelWindowId(channel: Channel): string {
  return `${CHANNEL_WINDOW_PREFIX}${channel}`;
}

/** The kind badge every channel editor wears in its title bar. */
const BADGE = "CHANNEL";

/**
 * The panel's OUTER box, in CSS pixels — the prototype's landscape channel
 * editor (`0250-temperature-editor.html` l.3: `width:1078px` plus its own
 * `border:1px solid #565b61`). The prototype is content-box, the studio's
 * panel is border-box, so the outer size is 1080 (bead wadjet-9f9.48.11).
 */
const WINDOW_W = 1080;
/** The plot column, in CSS pixels (`proto-markup/0250-temperature-editor.html`: 770 wide). */
const CHART_W = 770;
/** WIND spends part of that column on the rose, so its plots are narrower (the prototype's 560). */
const ROSE_COL_W = 236;
const CHART_W_WITH_ROSE = CHART_W - ROSE_COL_W - 14;
/** The tick gutter and the right margin — the prototype's `eX0 = 38`, `770 − 762 = 8`. */
const CHART_PAD_X = { left: 38, right: 8 };
/** Headroom above and below the drawn extent, so a keyframe can be dragged past it. */
const CHART_PAD_FRACTION = 0.12;
/** …and at least this much, in the channel's own unit, when the curve is nearly flat. */
const CHART_MIN_PAD = 1;
/** Plot height per printed y-axis tick — the prototype's 6 on 330 px, 2 on 86 px. */
const TICK_EVERY_PX = 45;

/**
 * The headroom a plot keeps above and below its ink, as a share of its *own*
 * height. The prototype sizes it per plot rather than flat — 18/24 on the
 * 330 px mean but 8/6 on the 86 px wet-day amount (`proto-markup/0250`…`0480`)
 * — so a short plot is not half gutter. Clamped to the prototype's extremes.
 */
function chartPad(height: number): { left: number; right: number; top: number; bottom: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return { ...CHART_PAD_X, top: clamp(Math.round(height * 0.12), 8, 20), bottom: clamp(Math.round(height * 0.08), 6, 12) };
}
/** The keyframe the panel opens on — the prototype's `selKf: 6`, mid-year. */
const DEFAULT_POINT = 6;
/** Only when the adapter describes no calendar (`ui/header.ts`, `ui/ruler.ts` keep the same fallback). */
const DEFAULT_YEAR_LENGTH = 365;

// ---------------------------------------------------------------------------
// The per-channel spec table (bead wadjet-9f9.32 fills the other three in)
// ---------------------------------------------------------------------------

interface ChannelKnobSpec {
  label: string;
  /** how the readout is converted and suffixed (`format.ts`, `plugin.settings.units`) */
  quantity: Quantity;
  /** metric, always — `format` is the display edge (H-1384) */
  spec: KnobSpec;
  hint: string;
  /** the hint the same knob wears in a season scope, where it writes a different layer */
  seasonHint?: string;
  /**
   * The arc and readout colour, when it is not the channel's own. The
   * prototype colours a macro by what it *means*, not by which panel it is on:
   * a plain offset is the neutral accent, a seasonal multiplier is calendar
   * gold, and only the channel's own quantity wears the channel hue.
   */
  color?: string;
}

/** How one drawn series is painted on its plot, and what its legend entry reads. */
interface SeriesPaint {
  /** overrides the channel hue — the pair's second line, humidity's gold */
  color?: string;
  /** SVG `stroke-dasharray`. The prototype's convention: a wet-day series is dashed. */
  dash?: string;
  width?: number;
  /** fill the area under the line (the prototype's calm-day chart) */
  fill?: boolean;
  /** the inline legend entry — `wet-after-dry`, `on wet days` */
  label?: string;
}

/**
 * One plot in the channel's stack: the series that share a y axis, what that
 * axis is called, and how tall it is.
 *
 * Two lines belong on one plot when they are only readable *against each
 * other* — PRECIP's Markov pair, SKY's dry/wet halves. A parameter measured in
 * something else (mm, a calm-day fraction) gets its own plot rather than a
 * second scale on someone else's, because a chart carries one y axis.
 */
interface ChannelPlotSpec {
  /** the caption above the plot, lower case (the stylesheet sets the small caps). The unit is appended. */
  caption: string;
  /** the unit the ticks and the caption carry */
  quantity: Quantity;
  height: number;
  /** a fixed y axis, for parameters that are fractions; omitted means "pad the drawn extent" */
  yRange?: [number, number];
  /**
   * A dashed horizontal reference in the parameter's own unit — temperature's
   * freezing line, precipitation's even-odds mark. Drawn in the colour of
   * whatever the crossing *means*, which is why it carries one.
   */
  rule?: { value: number; dash?: string; color: string };
  /** draw the ± ribbon of this plot's first parameter (`SPREAD_OF` in `channel-edit.ts`) */
  spread?: boolean;
  /** per-series paint; a series with no entry is the channel hue, solid */
  series?: Record<string, SeriesPaint>;
}

interface ChannelWindowSpec {
  title: string;
  /** the palette colour for the drawn curve and the knobs (SPEC §9) */
  color: string;
  /**
   * The KIND pill's text, where the channel hue is too saturated to read as
   * a word on the pill's dark ground. Only the two hues the prototype softens
   * carry one; the rest wear `color` (`--wadjet-studio-*-soft` in styles.css).
   */
  badgeColor?: string;
  /** the caption over the knob group, where the prototype gives it one (WIND's `Scalars`) */
  knobHeading?: string;
  /** every knob the channel offers in any scope; `knobsFor` picks the scope's own */
  knobs: Partial<Record<KnobId, ChannelKnobSpec>>;
  /**
   * The stack of plots, top to bottom, one entry per `chartPlots(channel)`
   * entry and in the same order. *Which* parameters each plot draws is the
   * model's (`channel-edit.ts`); this says only how they look.
   */
  plots: readonly ChannelPlotSpec[];
  /** draw the compass rose of `wind.direction` beside the plots */
  rose?: boolean;
  /** the unit each drawn series is measured in — what a readout *about* it carries */
  axis: Record<string, Quantity>;
  /**
   * SPEC law 5: the schema this panel writes into, in engine grammar. Fixed
   * per channel; the live `layer:` ids are appended to it by `writes()`.
   */
  schema: string;
}

/** PLAN §5.2: offset ±10 °C, swing ×0.4–1.6, jitter ±5 °C on `temperature.sd`, ☾ depth ±10 °C. */
const TEMPERATURE: ChannelWindowSpec = {
  title: "Temperature",
  color: "var(--wadjet-studio-temp)",
  badgeColor: "var(--wadjet-studio-temp-soft)",
  axis: { "temperature.mean": "temperature" },
  plots: [
    {
      caption: "mean",
      quantity: "temperature",
      height: 330,
      spread: true,
      // Freezing is where rain becomes snow, so the rule wears the precip hue.
      rule: { value: 0, dash: "3 4", color: "var(--wadjet-studio-precip)" },
    },
  ],
  schema: "climate.temperature — mean keyframes · swing & jitter as layers",
  knobs: {
    offset: { label: "offset", quantity: "temperatureDelta", spec: { min: -10, max: 10, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.offset"), seasonHint: channelEditorHint("channel.season.offset"), color: "var(--wadjet-studio-accent)" },
    swing: { label: "seasonal swing", quantity: "factor", spec: { min: 0.4, max: 1.6, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.swing"), color: "var(--wadjet-studio-gold)" },
    jitter: { label: "day jitter σ", quantity: "temperatureDelta", spec: { min: -5, max: 5, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.jitter") },
    depth: { label: "curve depth", quantity: "temperatureDelta", spec: { min: -10, max: 10, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.depth"), color: "var(--wadjet-studio-moon)" },
  },
};

/**
 * PLAN §5.2 "Precip: … scale ops". Three plots, as the prototype stacks them
 * (`proto-markup/0345-precip-editor.html`):
 *
 * 1. the share of wet days, filled to the floor — the one number the channel
 *    is read for, and the thing the pair below it *is* once it settles;
 * 2. the Markov pair on one 0–1 axis — both lines always drawn, `pwd` solid in
 *    the channel hue and `pww` dashed green, because the pair only means
 *    anything read against each other;
 * 3. the wet-day amount in mm on its own, because millimetres do not live on a
 *    probability axis.
 *
 * The share is derived (`channel-edit.ts` `plotPoints`), so it carries no
 * handles and — being alone on its plot — no legend entry either.
 */
const PRECIPITATION: ChannelWindowSpec = {
  title: "Precipitation",
  color: "var(--wadjet-studio-precip)",
  badgeColor: "var(--wadjet-studio-precip-soft)",
  axis: {
    "precipitation.pww": "percent",
    "precipitation.pwd": "percent",
    "precipitation.scale": "amount",
  },
  plots: [
    {
      // `0345`'s "Share of wet days" plot: 170 px, the area under the line
      // filled in the channel hue (the stylesheet's 16 %, `0345` l.16).
      caption: "share of wet days",
      quantity: "fraction",
      height: 170,
      yRange: [0, 1],
      series: { [PRECIP_WET_SHARE]: { width: 1.8, fill: true } },
    },
    {
      // `0345`'s "Markov pair" plot: 140 px.
      caption: "markov pair",
      quantity: "probability",
      height: 140,
      yRange: [0, 1],
      // Even odds: above the rule the weather more often stays than turns.
      rule: { value: 0.5, color: "var(--wadjet-studio-text-mute)" },
      series: {
        "precipitation.pwd": { label: "wet-after-dry" },
        "precipitation.pww": { color: "var(--wadjet-studio-wind)", dash: "5 4", width: 1.6, label: "wet-after-wet" },
      },
    },
    // `proto-markup/0345-precip-editor.html`'s "Wet-day amount" plot: 86 px.
    { caption: "wet-day amount", quantity: "amount", height: 86 },
  ],
  schema: "climate.precipitation — pww/pwd keyframes · scoped macros as season-gated layers",
  knobs: {
    // Coloured by the line each one moves: `stick` is the green `pww` curve,
    // `chance` the blue `pwd` one, `amount` the mm plot below them.
    stick: { label: "stickiness", quantity: "factor", spec: { min: 0.6, max: 1.3, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.stick"), color: "var(--wadjet-studio-wind)" },
    chance: { label: "rain chance", quantity: "factor", spec: { min: 0.4, max: 2.5, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.chance") },
    amount: { label: "wet-day amount", quantity: "factor", spec: { min: 0.4, max: 2.5, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.amount") },
    wetShift: { label: "rain chance", quantity: "probability", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.season.chance"), color: "var(--wadjet-studio-accent)" },
    depth: { label: "depth", quantity: "probability", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.depth"), color: "var(--wadjet-studio-moon)" },
  },
};

/**
 * PLAN §5.2 "Wind: `wind.speed` offset, `wind.direction` set per season".
 * Speed over its ± spread ribbon, the calm-day share beneath it, and the
 * direction rose beside both — the bearing is the one thing on this channel
 * that is not a value over the year, so it is not drawn as one.
 */
const WIND: ChannelWindowSpec = {
  title: "Wind",
  color: "var(--wadjet-studio-wind)",
  // WIND is the one channel whose knobs get a caption of their own in the
  // prototype (`0415` l.49): its scalars sit in a column beside the plots
  // rather than under the scope chips, so they have to say what they are.
  knobHeading: "Scalars",
  rose: true,
  axis: { "wind.speed": "speed", "wind.calmFraction": "percent" },
  plots: [
    // `0415`'s speed plot: 180 px (its rose is the 216 px square beside it).
    { caption: "speed", quantity: "speed", height: 180, spread: true },
    {
      caption: "calm days",
      // A share of days is read aloud as a percentage — the card next to it
      // already says "wet 61% of days" — so the axis marks its half `50%`, the
      // prototype's one calm-day tick (`weCalmGridEls`). Stored as a fraction.
      // `0415`'s calm-days plot: 80 px.
      quantity: "percent",
      height: 80,
      yRange: [0, 0.7],
      series: { "wind.calmFraction": { color: "var(--wadjet-studio-moon)", width: 1.3, fill: true } },
    },
  ],
  schema: "climate.wind — speed/direction/spread/calm keyframes · wetDayScale",
  knobs: {
    wind: { label: "wind", quantity: "speed", spec: { min: -10, max: 24, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.wind"), seasonHint: channelEditorHint("channel.season.wind"), color: "var(--wadjet-studio-accent)" },
    gust: { label: "gust spread", quantity: "factor", spec: { min: 1, max: 1.6, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.gust") },
    calm: { label: "calm days", quantity: "fraction", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.calm"), color: "var(--wadjet-studio-moon)" },
    direction: { label: "direction", quantity: "direction", spec: { min: 0, max: 360, step: 1, neutral: 0 }, hint: channelEditorHint("channel.direction"), color: "var(--wadjet-studio-gold)" },
    depth: { label: "depth", quantity: "speed", spec: { min: -20, max: 20, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.depth"), color: "var(--wadjet-studio-moon)" },
  },
};

/**
 * PLAN §5.2 "Sky: `cloud.dry/wet` offset". Humidity is the same shape, and the
 * same channel (SPEC §1) — so the window is two plots of the same pairing, dry
 * solid and wet dashed on both, which is the point the prototype's own copy
 * makes ("same pairing").
 */
const SKY: ChannelWindowSpec = {
  title: "Sky",
  color: "var(--wadjet-studio-sky)",
  axis: { "cloud.dry": "percent", "cloud.wet": "percent", "humidity.dry": "percent", "humidity.wet": "percent" },
  plots: [
    {
      // `0480`'s cloud plot: 160 px.
      caption: "cloud cover · okta fraction",
      quantity: "fraction",
      height: 160,
      yRange: [0, 1],
      series: {
        "cloud.dry": { label: "on dry days" },
        "cloud.wet": { color: "var(--wadjet-studio-precip)", dash: "5 4", width: 1.4, label: "on wet days" },
      },
    },
    {
      // Humidity is gold in the prototype and nowhere else in the studio: on a
      // grey channel it is the only way to tell the second pairing from the first.
      // The caption is the prototype's `same pairing` (`0480` l.19) rather than
      // a second unit: the plot above already named the dry/wet split, and this
      // one is that split again.
      // `0480`'s humidity plot: 120 px.
      caption: "humidity · same pairing",
      quantity: "fraction",
      height: 120,
      yRange: [0, 1],
      series: {
        "humidity.dry": { color: "var(--wadjet-studio-gold)", width: 1.8, label: "on dry days" },
        "humidity.wet": { color: "var(--wadjet-studio-gold)", dash: "5 4", width: 1.2, label: "on wet days" },
      },
    },
  ],
  schema: "climate.humidity + climate.cloud — dry/wet paired keyframes",
  knobs: {
    cloud: { label: "cloud cover", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.cloud"), seasonHint: channelEditorHint("channel.season.cloud") },
    humidity: { label: "humidity", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.humidity"), seasonHint: channelEditorHint("channel.season.humidity"), color: "var(--wadjet-studio-gold)" },
    depth: { label: "depth", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.depth"), color: "var(--wadjet-studio-moon)" },
  },
};

/**
 * The table the four channel editors are built from. All four are real
 * editors — the row label is never a dead click (SPEC law 2). The parameters
 * each knob and each drawn line stands for are `model/channel-edit.ts`'s
 * (`CHANNEL_KNOBS` / `CHANNEL_CHART`); this table is presentation only, and
 * its `plots` array is index-for-index with `chartPlots(channel)`.
 */
export const CHANNEL_SPECS: Record<Channel, ChannelWindowSpec> = {
  temperature: TEMPERATURE,
  precipitation: PRECIPITATION,
  wind: WIND,
  sky: SKY,
};

/** The compass rose, in CSS pixels — square, so the sectors are circular (the prototype's 216). */
const ROSE_SIZE = 216;
/** How wide one season's wedge opens, in degrees — the prototype's spread, not a measured one. */
const WEDGE_SPREAD = 66;
/** The dash glyphs the inline legend uses for a solid and a dashed series. */
const LEGEND_GLYPH = { solid: "━", dashed: "┄" } as const;

/**
 * The writer stack's tag gutter, in the prototype's own vocabulary
 * (`1397-logic-class-Component.js` `tWriters`: BASE / TAG / CYC / INS / MST).
 * A row is one line, so the tag is a fixed 30 px column and the words have to
 * fit it — the full signal-path name is still on the row as `data-kind`, which
 * is what a probe and the stylesheet read.
 */
const WRITER_TAG: Record<WriterRow["kind"], string> = {
  station: "BASE",
  layer: "TAG",
  regime: "REG",
  device: "INS",
  forcings: "MST",
  automation: "AUT",
  era: "ERA",
};

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

/** `+2.0 °C` / `×1.25` / `0.62` — the knob's own readout, in the user's units. */
function knobText(v: number, quantity: Quantity, units: Units): string {
  const f = format(v, quantity, units, quantity === "factor" ? undefined : { signed: true });
  if (quantity === "factor") return `${f.unit}${f.text}`;
  return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
}

/**
 * `14.3 °C` / `59 %` — a plotted value, unsigned, with its unit.
 *
 * A share carries a `%` rather than reading as a bare `0.59`, which names no
 * unit at all: whole percent is exactly the two decimals of a fraction the
 * curve is dragged in, so nothing is rounded away by saying it out loud.
 */
function valueText(v: number, quantity: Quantity, units: Units): string {
  const f = format(v, quantity, units, quantity === "percent" ? { digits: 0 } : undefined);
  return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
}

/**
 * Which channel's ladder a plot's quantity counts on. The prototype's steps
 * are a property of the *unit*, not of the panel it is on — millimetres climb
 * the same 2 · 5 · 10 rungs degrees do, and every fraction on the panel (a
 * probability, an okta share) marks its quarters — so a two-plot editor is not
 * forced onto one ladder. `model/channel-series.ts` already tabulates them.
 */
const TICK_LADDER: Partial<Record<Quantity, Channel>> = {
  temperature: "temperature",
  temperatureDelta: "temperature",
  amount: "temperature",
  speed: "wind",
  fraction: "precipitation",
  probability: "precipitation",
};

/**
 * The tick label the prototype prints: the glyph rides the number (`20°`,
 * `50%`), a fraction drops its leading zero and its trailing ones (`.5`, `.95`,
 * `.25`), and anything the caption already names its unit for stays bare
 * (`10` mm, `12` km/h).
 */
function tickLabel(v: number, quantity: Quantity, units: Units): string {
  if (quantity === "fraction" || quantity === "probability") {
    return format(v, quantity, units, { digits: 2 })
      .text.replace(/^(-?)0\./, "$1.")
      .replace(/0+$/, "");
  }
  const text = format(v, quantity, units, { digits: 0 }).text;
  if (quantity === "temperature" || quantity === "temperatureDelta") return `${text}°`;
  return quantity === "percent" ? `${text}%` : text;
}

/**
 * The y-axis ticks *inside* a range — the prototype's own ladder, every rung
 * labelled, and never on the plot's own border: a tick sitting on the frame is
 * a number the reader has to guess the side of (`0250-temperature-editor`
 * marks −5°…20° well within a −6…22 axis).
 *
 * Ticks are *chosen* in display units, because that is the scale the reader is
 * counting in (5 °C steps are not round in °F), and handed back in the
 * channel's own metric units, because that is the space the chart plots and
 * drags in. Both conversions are affine, so nothing drifts.
 *
 * How many survive is the plot's own height: the prototype prints six on its
 * 330 px mean and two on its 86 px wet-day amount, roughly a rung per
 * `TICK_EVERY_PX`. A short plot thins its ladder rather than stacking numbers.
 */
function axisTicks(range: [number, number], quantity: Quantity, units: Units, height: number): ChartTick[] {
  const lo = toDisplay(range[0], quantity, units);
  const hi = toDisplay(range[1], quantity, units);
  const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
  if (!(b > a)) return [];
  const ladder = TICK_LADDER[quantity];
  // The calm-day share is the one axis the prototype speaks in percent, and it
  // marks the half and nothing else (`weCalmGridEls`).
  const inset = (b - a) * 1e-6;
  // Drop the rungs on the frame *before* thinning: a tick the axis only just
  // reaches is not one of the numbers the plot has room for.
  const all = (quantity === "percent" ? [0.5] : ladder === undefined ? [] : seriesAxisTicks(ladder, a, b)).filter((v) => v > a + inset && v < b - inset);
  const room = Math.max(1, Math.round(height / TICK_EVERY_PX));
  const every = Math.ceil(all.length / room);
  const rungs = all.length > room ? all.filter((_, i) => i % every === 0) : all;
  return rungs.map((v) => ({ value: fromDisplay(v, quantity, units), label: tickLabel(fromDisplay(v, quantity, units), quantity, units) }));
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildChannelWindow(channel: Channel): WindowBuilder {
  return (ctx: SurfaceContext): WindowBuild => {
    const spec = CHANNEL_SPECS[channel];
    const { title, color, knobs: knobSpecs } = spec;

    let unsubscribe: (() => void) | null = null;
    let signature = "";
    /** The selected scope chip. View-local: a scope is a lens, not a draft edit. */
    let scope = ALL_SCOPE;
    /** The editable line of a paired chart. View-local for the same reason. */
    let series = primarySeries(channel);
    /** The keyframe the SELECTED POINT card reads. View-local: a selection is not an edit. */
    let selected: number | null = DEFAULT_POINT;

    /**
     * The parameter the chart edits right now. A ☾ scope always rides the
     * channel's primary series — the envelope and its depth are one layer, and
     * the picker is hidden there.
     */
    function chartParam(): string {
      return parseScope(scope).kind === "cycle" ? primarySeries(channel) : series;
    }

    function zone(state: StudioState = ctx.store.get()): ZoneProfile | null {
      const id = state.view.zoneId;
      return id !== null ? (state.zones[id] ?? null) : null;
    }

    /**
     * Seasons and moons come from the adapter when it owns the calendar, from
     * the world draft otherwise (`ui/mixer.ts`). `yearLength` and a moon's
     * `cycleDays` only ever come from the adapter — the draft carries no year
     * length — so a panel that needs one degrades rather than inventing 365.
     */
    function calendar(state: StudioState = ctx.store.get()): { seasons: Array<{ name: string; from: number }>; moons: Array<{ name: string; cycleDays?: number; phases?: Array<{ name: string; at: number }> }>; yearLength: number } {
      const described = ctx.calendar();
      const readOnly = described?.readOnly ?? false;
      return {
        seasons: readOnly ? (described?.seasons ?? []) : state.world.calendar.seasons,
        moons: readOnly ? (described?.moons ?? []) : state.world.calendar.moons,
        yearLength: described?.yearLength ?? DEFAULT_YEAR_LENGTH,
      };
    }

    /** The moon the ☾ scope points at, for its cycle length. */
    function scopeMoon(state: StudioState = ctx.store.get()): { name: string; cycleDays?: number } | null {
      const s = parseScope(scope);
      if (s.kind !== "cycle") return null;
      return calendar(state).moons.find((m) => m.name === s.moon) ?? { name: s.moon };
    }

    /** Write into the pointed-at zone draft. `history` closes an undo step around a discrete action. */
    function editZone(apply: (z: ZoneProfile) => void, history = false): void {
      ctx.store.update(
        (s) => {
          const z = zone(s);
          if (z !== null) apply(z);
        },
        history ? { history: true } : undefined,
      );
    }

    // --- the body ----------------------------------------------------------

    const root = createDiv({ cls: "wadjet-studio-channel-win", attr: { "data-channel": channel } });
    root.setCssProps({ "--wadjet-studio-channel-win-color": spec.color });

    /** One card in the right-hand column: a small-caps heading over its content. */
    function card(parent: HTMLElement, head: string, hint?: string): { el: HTMLElement; head: HTMLElement; body: HTMLElement } {
      const el = parent.createDiv({ cls: "wadjet-studio-channel-win-card", ...(hint === undefined ? {} : { attr: { "data-hint": hint } }) });
      const headEl = el.createDiv({ cls: "wadjet-studio-channel-win-card-head", text: head });
      return { el, head: headEl, body: el.createDiv({ cls: "wadjet-studio-channel-win-card-body" }) };
    }

    // LEFT: the stack of plots (and, on WIND, the rose beside them).
    // RIGHT: the card stack.
    const cols = root.createDiv({ cls: "wadjet-studio-channel-win-cols" });
    const plotCol = cols.createDiv({ cls: "wadjet-studio-channel-win-plot" });
    plotCol.toggleClass("is-rose", spec.rose === true);
    /** WIND's rose column: its own heading, the rose, then the season legend. */
    const roseCol = plotCol.createDiv({ cls: "wadjet-studio-channel-win-rose-col" });
    roseCol.toggleClass("is-hidden", spec.rose !== true);
    if (spec.rose === true) roseCol.createDiv({ cls: "wadjet-studio-channel-win-axis", text: "direction · by season" });
    const roseHost = roseCol.createDiv({ cls: "wadjet-studio-channel-win-rose", attr: { "data-part": "channel-rose", "data-hint": channelEditorHint("channel.rose") } });
    const roseLegend = roseCol.createDiv({ cls: "wadjet-studio-channel-win-rose-legend", attr: { "data-part": "channel-rose-legend" } });

    const plotStack = plotCol.createDiv({ cls: "wadjet-studio-channel-win-plots" });

    /**
     * One plot's DOM: a caption carrying the unit and, where a pair is drawn,
     * the inline legend that also *picks* which of the pair the handles are on
     * — the prototype's own legend, doing one more job so the panel needs no
     * extra control for it (SPEC law 3).
     */
    interface PlotView {
      /** the parameters this plot draws, in the model's own draw order */
      params: readonly string[];
      spec: ChannelPlotSpec;
      el: HTMLElement;
      noun: HTMLElement;
      legend: HTMLElement;
      host: HTMLElement;
      chart: ChartComponent | null;
    }
    const plotWidth = spec.rose === true ? CHART_W_WITH_ROSE : CHART_W;
    const plots: PlotView[] = chartPlots(channel).flatMap((params, i) => {
      const plotSpec = spec.plots[i];
      if (plotSpec === undefined) return [];
      const el = plotStack.createDiv({ cls: "wadjet-studio-channel-win-plot-block" });
      const caption = el.createDiv({ cls: "wadjet-studio-channel-win-axis", ...(i === 0 ? { attr: { "data-part": "channel-axis" } } : {}) });
      const noun = caption.createSpan({ cls: "wadjet-studio-channel-win-axis-noun" });
      const legend = caption.createSpan({ cls: "wadjet-studio-channel-win-legend", attr: { "data-part": "channel-series", "data-hint": channelEditorHint("channel.series") } });
      // Only the plot the handles are on answers to `channel-chart`: it is the
      // one a drag, a double-click or a right-click can reach.
      const host = el.createDiv({ cls: "wadjet-studio-channel-win-chart", attr: { "data-hint": channelEditorHint("channel.chart") } });
      return [{ params, spec: plotSpec, el, noun, legend, host, chart: null }];
    });

    const sideCol = cols.createDiv({ cls: "wadjet-studio-channel-win-side" });

    const point = card(sideCol, "Selected point", channelEditorHint("channel.chart"));
    const pointWhenEl = point.body.createDiv({ cls: "wadjet-studio-channel-win-fact", attr: { "data-part": "channel-point-when" } });
    pointWhenEl.createSpan({ cls: "wadjet-studio-channel-win-fact-key", text: "when" });
    const pointWhenValue = pointWhenEl.createSpan({ cls: "wadjet-studio-channel-win-fact-value wadjet-studio-num" });
    const pointValueEl = point.body.createDiv({ cls: "wadjet-studio-channel-win-fact", attr: { "data-part": "channel-point-value" } });
    pointValueEl.createSpan({ cls: "wadjet-studio-channel-win-fact-key", text: "value" });
    const pointValue = pointValueEl.createSpan({ cls: "wadjet-studio-channel-win-fact-value wadjet-studio-num is-accent" });

    const macros = card(sideCol, "Channel macros · scope");
    const scopeRow = macros.body.createDiv({ cls: "wadjet-studio-channel-win-scopes", attr: { "data-part": "channel-scopes", "data-hint": channelEditorHint("channel.scope") } });
    // The caption over the knob group, where the channel has one. It wears the
    // card heading's own treatment because that is what the prototype's
    // `Scalars` is — the same 11 px small caps as `Selected point` above it.
    if (spec.knobHeading !== undefined) macros.body.createDiv({ cls: "wadjet-studio-channel-win-card-head", text: spec.knobHeading, attr: { "data-part": "channel-knobs-head" } });
    const knobRow = macros.body.createDiv({ cls: "wadjet-studio-channel-win-knobs", attr: { "data-part": "channel-knobs" } });
    const extraRow = macros.body.createDiv({ cls: "wadjet-studio-channel-win-extras" });
    const stageEl = macros.body.createDiv({ cls: "wadjet-studio-channel-win-stage", attr: { "data-part": "channel-stage", "data-hint": channelEditorHint("channel.stage") } });

    /**
     * The channel's one fact card, and the fourth card in the column — which is
     * all four prototype editors have (`0250` l.70, `0345` l.51 and l.61,
     * `0415`, `0480` l.24). It is unheaded on purpose: a card holding `range`,
     * `wet days / yr` and a sentence about the ghost has no one noun to head
     * it, and the head was a whole row of vertical space spent saying the word
     * already in the title bar.
     *
     * The facts come first as key/value rows (`0345` l.51) and the prose last
     * (`0250` l.70, `0345` l.61), which is the order the prototype reads them
     * in. Both parts stay on it: `channel-stats` is the rows, `channel-note`
     * the card that carries them.
     */
    const noteCard = sideCol.createDiv({ cls: "wadjet-studio-channel-win-card wadjet-studio-channel-win-note is-hidden", attr: { "data-part": "channel-note" } });
    const statList = noteCard.createDiv({ cls: "wadjet-studio-channel-win-stat-list", attr: { "data-part": "channel-stats" } });
    /** The prose half, under the rows — kept apart so a repaint can empty one without the other. */
    const noteProse = noteCard.createDiv({ cls: "wadjet-studio-channel-win-note-prose" });

    const writersBox = card(sideCol, `Writers → ${title}`, channelEditorHint("channel.writers"));
    const writerList = writersBox.body.createDiv({ cls: "wadjet-studio-channel-win-writer-list", attr: { "data-part": "channel-writers" } });

    let rose: ChartComponent | null = null;
    let resetChip: ChipComponent | null = null;
    const knobs = new Map<KnobId, KnobComponent>();
    /** One Chip per scope, by id — a chip row, not a Segmented (the prototype's outline-on-dark selection). */
    const scopeChipEls = new Map<string, ChipComponent>();

    // --- gestures ----------------------------------------------------------

    /** A drag reports every move and once more at pointer-up; only the last one closes an undo step. */
    function endOfGesture(phase: "drag" | "end"): void {
      if (phase !== "drag") ctx.store.snapshot();
    }

    function onPoint(index: number, x: number, y: number, phase: "drag" | "end"): void {
      const s = parseScope(scope);
      const param = chartParam();
      editZone((z) => {
        if (s.kind === "cycle") setEnvelopePoint(z, param, s.moon, index, x, y);
        else setKeyframe(z, param, index, y);
      });
      endOfGesture(phase);
    }

    function onAdd(x: number, y: number): void {
      const s = parseScope(scope);
      const param = chartParam();
      let added = false;
      editZone((z) => {
        added = s.kind === "cycle" ? addEnvelopePoint(z, param, s.moon, x, y) : addKeyframe(z, param, x, y);
      }, true);
      if (!added) new Notice("There is already a point at that phase");
    }

    function onRemove(index: number): void {
      const s = parseScope(scope);
      const param = chartParam();
      let removed = false;
      editZone((z) => {
        removed = s.kind === "cycle" ? removeEnvelopePoint(z, param, s.moon, index) : removeKeyframe(z, param, index);
      }, true);
      if (!removed) new Notice(s.kind === "cycle" ? "An envelope keeps at least one point" : "A drawn curve keeps at least three keyframes");
    }

    function selectScope(next: string): void {
      if (next === scope) return;
      scope = next;
      repaint(true);
    }

    function selectSeries(next: string): void {
      if (next === series) return;
      series = next;
      repaint(true);
    }

    /** The "station's own" reset — the only way to clear a bearing, which has no neutral (`compile.ts`). */
    function resetDirection(): void {
      const s = parseScope(scope);
      if (s.kind !== "season") return;
      editZone((z) => clearDirection(z, s.name), true);
      repaint(true);
    }

    // --- chart -------------------------------------------------------------

    /**
     * The lines one plot draws, its editable one first — `components/chart.ts`'s
     * `automation` kind gives handles to `series[0]` only, so exactly one line
     * on exactly one plot is editable at a time and the legend is what picks it.
     *
     * A pair's second line is a full citizen here, not a grey ghost: it is
     * drawn in its own colour and dash and named in the legend, because the
     * pair is the point of the window (gap audit §2, §4).
     */
    function seriesForPlot(z: ZoneProfile, view: PlotView): ChartSeries[] {
      const s = parseScope(scope);
      const param = chartParam();
      if (s.kind === "cycle") return [{ points: curvePoints(z, param, scope), color: "var(--wadjet-studio-moon)", width: 2.2 }];
      const owns = view.params.includes(param);
      const order = owns ? [param, ...view.params.filter((p) => p !== param)] : [...view.params];
      const out: ChartSeries[] = order.map((p) => {
        const paint = view.spec.series?.[p];
        return {
          // `plotPoints`, not `curvePoints`: a derived line (the wet-day share)
          // is computed from the curves it reads, and has none of its own.
          points: plotPoints(z, p, scope),
          // …and `line` is the same series sampled densely, because a channel
          // curve is a monotone cubic between its keys and a twelve-point
          // polyline draws that curve's chords instead (worst on WIND's V).
          // The handles stay on `points`, so the keyframe count does not move.
          line: plotSamples(z, p, scope),
          color: paint?.color ?? color,
          width: p === param ? 2.2 : (paint?.width ?? 1.6),
          ...(paint?.dash === undefined ? {} : { dash: paint.dash }),
          ...(paint?.fill === true ? { fill: true } : {}),
        };
      });
      if (!owns) return out;
      const drawn = out[0]?.points ?? [];
      const swung = swungPoints(z, param, scope);
      // Every reference line is sampled the same way as the one it is read
      // against: a smooth curve compared against a chorded ghost reads as two
      // different kinds of thing rather than as the same one, twice.
      if (swung.some((p, i) => Math.abs(p[1] - (drawn[i]?.[1] ?? p[1])) > 1e-6))
        out.push({ points: swung, line: swungSamples(z, param, scope), color: "var(--wadjet-studio-accent)" });
      // The same parameter as it reads on a wet day — dashed, in the precip hue,
      // because "wet" is what makes it differ.
      const wet = wetDayPoints(z, param, scope);
      if (wet.length > 0) out.push({ points: wet, line: wetDaySamples(z, param, scope), color: "var(--wadjet-studio-precip)", dash: "4 4", width: 1.1 });
      const station = stationPoints(z, param, scope);
      if (station.length > 0) out.push({ points: station, line: stationSamples(z, param, scope), color: "var(--wadjet-studio-text-mute)", dash: "5 3", width: 1.3 });
      return out;
    }

    /** The season / moon-phase tints behind the plot, in the ruler's own palette (`model/palette.ts`). */
    function bandsFor(state: StudioState): Array<{ from: number; to: number; color: string }> {
      return seasonBands(scope, calendar(state)).map((b) => ({ from: b.from, to: b.to, color: cycleColour(state.view.colours.seasons[b.index] ?? b.index, SEASON_CYCLE) }));
    }

    /** Which plot the handles, the ☾ envelope and the SELECTED POINT card are on. */
    function ownsHandles(view: PlotView): boolean {
      return view.params.includes(chartParam());
    }

    /**
     * The caption over one plot: what it draws, and in what unit.
     *
     * `MEAN °C` but `SPEED · KM/H` — a degree sign reads as part of the
     * number it follows, a word-shaped unit as a second clause. The prototype
     * sets both of them that way.
     */
    function captionFor(view: PlotView, isCycle: boolean, moon: string): string {
      if (isCycle) return `envelope · over the ${moon} cycle — phase bands behind`;
      const unit = unitLabel(view.spec.quantity, ctx.units());
      if (unit === "") return view.spec.caption;
      return unit.startsWith("°") ? `${view.spec.caption} ${unit}` : `${view.spec.caption} · ${unit}`;
    }

    /**
     * The cycle domain is the envelope's own 0–1 dimmer axis, and a plot whose
     * parameters are fractions has the same kind of fixed axis (`plot.yRange`).
     * An open-ended plot is padded past the drawn extent so a keyframe can be
     * dragged *out* of the range it currently defines, rather than pinning
     * itself to the edge.
     */
    function yRangeOf(lines: readonly ChartSeries[], isCycle: boolean, plot: ChannelPlotSpec, extra: readonly number[] = []): [number, number] {
      if (isCycle) return [0, 1];
      if (plot.yRange !== undefined) return [plot.yRange[0], plot.yRange[1]];
      // The ribbon counts: an envelope drawn past the axis would be clipped
      // flat, which reads as data rather than as a missing edge.
      const ys = [...lines.flatMap((s) => s.points.map((p) => p[1])), ...extra];
      if (ys.length === 0) return [0, 1];
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const pad = Math.max(CHART_MIN_PAD, (hi - lo) * CHART_PAD_FRACTION);
      // A magnitude reads against zero: the prototype's speed and millimetre
      // axes both start there (`we1Y`'s 0–24, `peAmt`'s 0–30) rather than at
      // whatever the lowest sample happened to be. Degrees do not — a winter
      // below freezing is not a smaller amount of anything.
      const floor = (plot.quantity === "speed" || plot.quantity === "amount") && lo >= 0;
      return [floor ? 0 : lo - pad, hi + pad];
    }

    function paintPlot(view: PlotView, z: ZoneProfile | null, state: StudioState): void {
      const s = parseScope(scope);
      const isCycle = s.kind === "cycle";
      const owns = ownsHandles(view);
      // A ☾ scope draws one curve — the envelope of the primary series — so
      // a plot that carries no envelope of its own is not drawn at all.
      view.el.toggleClass("is-hidden", isCycle && !owns);
      if (isCycle && !owns) {
        view.chart?.destroy();
        view.chart = null;
        view.host.removeAttribute("data-part");
        return;
      }
      const lines = z === null ? [] : seriesForPlot(z, view);
      // mean ± the plot's own spread, as a translucent ribbon behind the line.
      // Dense samples, not the twelve keys: the ribbon has no handles of its
      // own — it is pure area — so it takes the drawn form of both its edges
      // and stays parallel to the line it is wrapped around.
      const ribbonParam = view.params[0] ?? primarySeries(channel);
      const spread = z === null || view.spec.spread !== true || isCycle ? [] : spreadSamples(z, ribbonParam, scope);
      const mid = z === null || spread.length === 0 ? [] : curveSamples(z, ribbonParam, scope);
      const ribbon = spread.flatMap((sp, i) => {
        const m = mid[i]?.[1];
        return m === undefined ? [] : [m - sp[1], m + sp[1]];
      });
      // The domain is the plot's own; the ticks land inside it, never on it.
      const range = yRangeOf(lines, isCycle, view.spec, ribbon);
      const axis = axisTicks(range, isCycle ? "fraction" : view.spec.quantity, ctx.units(), view.spec.height);
      const next = {
        kind: owns ? ("automation" as const) : ("curve" as const),
        domain: isCycle ? ("cycle" as const) : ("year" as const),
        width: plotWidth,
        height: view.spec.height,
        pad: chartPad(view.spec.height),
        series: lines,
        editable: z !== null && owns,
        // The tint band IS the season label: nothing is printed inside the plot.
        markers: [],
        bands: bandsFor(state),
        ticks: axis,
        rules: isCycle || view.spec.rule === undefined ? [] : [view.spec.rule],
        envelope:
          spread.length === 0
            ? null
            : { lo: mid.map((p, i) => [p[0], p[1] - (spread[i]?.[1] ?? 0)] as [number, number]), hi: mid.map((p, i) => [p[0], p[1] + (spread[i]?.[1] ?? 0)] as [number, number]), color },
        selected: owns ? selected : null,
        onSelect: selectPoint,
        yRange: range,
      };
      if (view.chart === null) {
        // The gestures are guarded per plot rather than per chart: a plot can
        // stop being the editable one between two repaints, and a stale
        // double-click must not land a keyframe on someone else's curve.
        view.chart = createChart(view.host, {
          ...next,
          onPoint: (index, x, y, phase) => {
            if (ownsHandles(view)) onPoint(index, x, y, phase);
          },
          onAdd: (x, y) => {
            if (ownsHandles(view)) onAdd(x, y);
          },
          onRemove: (index) => {
            if (ownsHandles(view)) onRemove(index);
          },
        });
      } else view.chart.update(next);
      // `channel-chart` marks the one plot a gesture reaches — the one with handles.
      if (owns) view.host.setAttr("data-part", "channel-chart");
      else view.host.removeAttribute("data-part");
      view.host.setAttr("data-hint", isCycle ? channelEditorHint("channel.envelope") : channelEditorHint("channel.chart"));
      view.noun.setText(captionFor(view, isCycle, s.kind === "cycle" ? s.moon : ""));
      paintLegend(view, isCycle);
    }

    function paintPlots(z: ZoneProfile | null, state: StudioState): void {
      for (const view of plots) paintPlot(view, z, state);
    }

    /**
     * The inline legend — `━ wet-after-dry · ┄ wet-after-wet` — each entry in
     * its own series' colour and dash. It is
     * also the picker: clicking an entry moves the handles onto that line, so a
     * pair can be compared *and* edited without the Segmented the prototype has
     * no counterpart for (SPEC law 3).
     */
    function paintLegend(view: PlotView, isCycle: boolean): void {
      view.legend.empty();
      if (isCycle || view.params.length < 2) return;
      const param = chartParam();
      for (const p of view.params) {
        const paint = view.spec.series?.[p];
        const item = view.legend.createSpan({
          cls: "wadjet-studio-channel-win-legend-item",
          attr: { role: "button", tabindex: "0", "data-value": p, "data-hint": channelEditorHint("channel.series") },
        });
        item.toggleClass("is-selected", p === param);
        item.setCssProps({ "--wadjet-studio-legend-color": paint?.color ?? color });
        item.createSpan({ cls: "wadjet-studio-channel-win-legend-dash", text: paint?.dash === undefined ? LEGEND_GLYPH.solid : LEGEND_GLYPH.dashed });
        item.createSpan({ cls: "wadjet-studio-channel-win-legend-label", text: paint?.label ?? p });
        item.addEventListener("click", () => selectSeries(p));
        item.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          selectSeries(p);
        });
      }
    }

    /** The SELECTED POINT card — day and value of the handle under the finger. */
    function paintPoint(z: ZoneProfile | null, state: StudioState): void {
      const param = chartParam();
      const points = z === null ? [] : curvePoints(z, param, scope);
      if (selected !== null && selected >= points.length) selected = points.length === 0 ? null : points.length - 1;
      const p = selected === null ? undefined : points[selected];
      if (p === undefined) {
        pointWhenValue.setText("—");
        pointValue.setText("—");
        return;
      }
      const moon = scopeMoon(state);
      const cal = calendar(state);
      pointWhenValue.setText(pointWhen(scope, p[0], { yearLength: cal.yearLength, ...(moon?.cycleDays === undefined ? {} : { cycleDays: moon.cycleDays }) }));
      const isCycle = parseScope(scope).kind === "cycle";
      pointValue.setText(isCycle ? format(p[1], "fraction", ctx.units()).text : valueText(p[1], spec.axis[param] ?? "fraction", ctx.units()));
    }

    function selectPoint(index: number): void {
      if (selected === index) return;
      selected = index;
      repaint(true);
    }

    /**
     * WIND's direction rose: rings, the four cardinals, and one wedge per
     * season at the bearing that season blows from, in the season's own palette
     * colour — the prototype's `DIRECTION · BY SEASON`.
     *
     * Read-only: the bearing is set by the `direction` knob inside a season
     * scope, because a wedge is 66 degrees wide and a bearing is not. The
     * legend under it is the way in — each entry names the season and its
     * compass point, and selects that season's scope.
     */
    function paintRose(z: ZoneProfile | null, state: StudioState): void {
      const show = spec.rose === true && parseScope(scope).kind !== "cycle";
      roseCol.toggleClass("is-hidden", !show);
      if (!show) {
        rose?.destroy();
        rose = null;
        roseHost.removeAttribute("data-rose");
        roseLegend.empty();
        return;
      }
      const dirs = z === null ? [] : seasonDirections(z, { seasons: calendar(state).seasons });
      const colourOf = (index: number): string => cycleColour(state.view.colours.seasons[index] ?? index, SEASON_CYCLE);
      const next = {
        kind: "rose" as const,
        domain: "year" as const,
        width: ROSE_SIZE,
        height: ROSE_SIZE,
        series: [],
        // A season that carries its own bearing layer reaches the outer ring;
        // one still on the station's own stops short of it.
        wedges: dirs.map((d) => ({ angle: d.degrees, spread: WEDGE_SPREAD, radius: d.own ? 1 : 0.84, color: colourOf(d.index) })),
      };
      if (rose === null) rose = createChart(roseHost, next);
      else rose.update(next);
      roseLegend.empty();
      for (const d of dirs) {
        const item = roseLegend.createSpan({
          cls: "wadjet-studio-channel-win-legend-item",
          attr: { role: "button", tabindex: "0", "data-value": seasonScope(d.name), "data-hint": channelEditorHint("channel.direction") },
        });
        item.toggleClass("is-selected", scope === seasonScope(d.name));
        item.setCssProps({ "--wadjet-studio-legend-color": colourOf(d.index) });
        item.createSpan({ cls: "wadjet-studio-channel-win-legend-dash", text: "▮" });
        item.createSpan({ cls: "wadjet-studio-channel-win-legend-label", text: `${d.name} ${d.compass}` });
        item.addEventListener("click", () => selectScope(seasonScope(d.name)));
        item.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          selectScope(seasonScope(d.name));
        });
      }
      // The drawn wedges carry no identity of their own, so the host states
      // what they stand for: `<sector>:<seasons>`, occupied sectors only.
      const buckets = z === null ? [] : directionRose(z, { seasons: calendar(state).seasons });
      roseHost.setAttr(
        "data-rose",
        buckets
          .filter((p) => p[1] > 0)
          .map((p) => `${p[0]}:${p[1]}`)
          .join(","),
      );
    }

    // --- scopes ------------------------------------------------------------

    /**
     * A scope is picked from a row of *chips*, not from a Segmented: the
     * prototype's selection is a light outline on a dark fill, and a chip is
     * the part that already carries an entity's own colour (a season's palette
     * entry, the moon's pale blue). The selected chip is the one control in the
     * panel that names the layer the knobs write into.
     *
     * The ☾ chip doubles as the click-through to that moon's CYCLE window when
     * it is already the selected scope — SPEC law 2, and one fewer chip than
     * the separate `moon:<X>` link it replaces.
     */
    function paintScopes(z: ZoneProfile | null, state: StudioState): void {
      const chips = z === null ? [{ id: ALL_SCOPE, label: "All year" }] : scopeChips(z, calendar(state));
      if (!chips.some((c) => c.id === scope)) scope = ALL_SCOPE;
      const seasonIndex = new Map(calendar(state).seasons.map((s, i) => [s.name, i]));

      for (const [id, chip] of [...scopeChipEls]) {
        if (chips.some((c) => c.id === id)) continue;
        chip.destroy();
        scopeChipEls.delete(id);
      }
      for (const c of chips) {
        const parsed = parseScope(c.id);
        const isMoon = parsed.kind === "cycle";
        const isSelected = c.id === scope;
        const colour =
          parsed.kind === "season"
            ? cycleColour(state.view.colours.seasons[seasonIndex.get(parsed.name) ?? 0] ?? (seasonIndex.get(parsed.name) ?? 0), SEASON_CYCLE)
            : isMoon
              ? "var(--wadjet-studio-moon)"
              // `All year` is the one scope with no entity colour of its own, so
              // it wears the text tone the prototype gives it (`pScopes`,
              // `#f2f3f5`) — the accent is a shade dimmer and read as a hue.
              : "var(--wadjet-studio-text)";
        const props = {
          label: isMoon ? `${MOON_GLYPH} ${parsed.moon}` : c.label,
          color: colour,
          dot: false,
          hint: isMoon && isSelected ? channelEditorHint("channel.moon") : channelEditorHint("channel.scope"),
          onClick: isMoon && isSelected ? () => openCycleFor(ctx, parsed.moon) : () => selectScope(c.id),
        };
        let chip = scopeChipEls.get(c.id);
        if (chip === undefined) {
          chip = createChip(scopeRow, props);
          scopeChipEls.set(c.id, chip);
        } else chip.update(props);
        chip.el.setAttr("data-value", c.id);
        // `channel-moon` marks the chip that *opens* the cycle window, which is
        // only ever the selected ☾ one — the same reach the old moon link had.
        if (isMoon && isSelected) chip.el.setAttr("data-part", "channel-moon");
        else chip.el.removeAttribute("data-part");
        chip.el.toggleClass("is-selected", isSelected);
      }
      // Re-append in chip order: a season added later would otherwise sit last.
      for (const c of chips) {
        const chip = scopeChipEls.get(c.id);
        if (chip !== undefined) scopeRow.appendChild(chip.el);
      }
    }

    // --- knobs -------------------------------------------------------------

    /** A knob that writes a different layer inside a season says so (`seasonHint`). */
    function hintFor(id: KnobId): string {
      const k = knobSpecs[id];
      if (k === undefined) return "";
      return parseScope(scope).kind === "season" ? (k.seasonHint ?? k.hint) : k.hint;
    }

    function paintKnobs(z: ZoneProfile | null): void {
      const wanted = knobsFor(channel, scope).filter((id) => knobSpecs[id] !== undefined);
      for (const [id, knob] of [...knobs]) {
        if (wanted.includes(id)) continue;
        knob.destroy();
        knobs.delete(id);
      }
      const values = z === null ? null : read(z, channel, scope);
      for (const id of wanted) {
        const k = knobSpecs[id]!;
        const value = values === null ? (k.spec.neutral ?? 0) : values[id];
        const existing = knobs.get(id);
        if (existing !== undefined) {
          existing.update({ value, hint: hintFor(id), disabled: z === null, color: k.color ?? color });
          continue;
        }
        const knob = createKnob(knobRow, {
          spec: k.spec,
          value,
          label: k.label,
          color: k.color ?? color,
          size: "lg",
          hint: hintFor(id),
          disabled: z === null,
          fmt: (v) => knobText(v, k.quantity, ctx.units()),
          ...(needsUnitParse(k.quantity) ? { parse: (text: string) => parseDisplay(k.spec, k.quantity, ctx.units())(text) } : {}),
          onChange: (next, phase) => {
            editZone((draft) => write(draft, channel, scope, id, next));
            endOfGesture(phase === "drag" ? "drag" : "end");
          },
        });
        knob.el.setAttr("data-part", `channel-knob-${id}`);
        knobs.set(id, knob);
      }
      // Re-append in `knobsFor` order: a knob added later would otherwise sit last.
      for (const id of wanted) {
        const knob = knobs.get(id);
        if (knob !== undefined) knobRow.appendChild(knob.el);
      }
    }

    /**
     * The bearing reset. It is a chip and not a knob position because
     * `wind.direction` has no neutral: 0° is due north, so the only way back to
     * the station's own is to drop the layer (`compile.ts setSeasonSet`).
     */
    function paintExtras(z: ZoneProfile | null): void {
      const s = parseScope(scope);
      const show = z !== null && spec.rose === true && s.kind === "season" && directionLayer(z, s.name) !== null;
      if (!show) {
        resetChip?.destroy();
        resetChip = null;
        return;
      }
      const props = { label: "station's own", color: "var(--wadjet-studio-text-dim)", hint: channelEditorHint("channel.direction.reset"), onClick: resetDirection };
      if (resetChip === null) resetChip = createChip(extraRow, props);
      else resetChip.update(props);
      resetChip.el.setAttr("data-part", "channel-direction-reset");
    }

    // --- writers -----------------------------------------------------------

    function openWriter(row: WriterRow): void {
      if (row.target.id === channelWindowId(channel)) {
        if (row.target.scope !== undefined) selectScope(row.target.scope);
        return;
      }
      ctx.windows.open(row.target.id);
    }

    /**
     * Which palette hue a writer row's value wears — what the source *is*,
     * not what the channel is: an era is calendar gold, a moon-carried device
     * pale blue, the channel's own layers and Forcings the channel hue.
     */
    function writerColour(kind: WriterRow["kind"]): string {
      if (kind === "era") return "var(--wadjet-studio-gold)";
      if (kind === "device") return "var(--wadjet-studio-moon)";
      if (kind === "station") return "var(--wadjet-studio-text-mute)";
      if (kind === "regime") return "var(--wadjet-studio-text-dim)";
      return color;
    }

    function paintWriters(z: ZoneProfile | null, state: StudioState): void {
      writerList.empty();
      const rows = z === null ? [] : writers(z, state.world.eras, channel);
      for (const row of rows) {
        const el = writerList.createDiv({
          cls: "wadjet-studio-channel-win-writer",
          attr: { role: "button", tabindex: "0", "data-part": "channel-writer", "data-kind": row.kind, "data-hint": channelEditorHint("channel.writer", `${row.label} — ${row.opsText}`) },
        });
        el.createSpan({ cls: "wadjet-studio-channel-win-writer-kind", text: WRITER_TAG[row.kind] });
        el.createSpan({ cls: "wadjet-studio-channel-win-writer-label", text: row.label });
        const ops = el.createSpan({ cls: "wadjet-studio-channel-win-writer-ops", text: row.opsText });
        // Every row's value sits in the same right-hand column, the station's
        // record included: the prototype's BASE row quotes `12 kf · 30 yr`
        // there, which is a readout and not a caption about the stack.
        ops.setCssProps({ "--wadjet-studio-channel-win-writer-color": writerColour(row.kind) });
        el.addEventListener("click", () => openWriter(row));
        el.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          openWriter(row);
        });
      }
    }

    /**
     * The unheaded note card — the prototype's last card in the info column,
     * prose with its numbers picked out rather than rows in the fact list.
     *
     * TEMPERATURE (`0250` l.63): what the dashed ghost is, and how much of
     * yesterday carries into today. The prototype states one constant
     * (`mean(t) + 0.35`), but `climate.temperature.wetDayOffset` is a *Curve*
     * (`core/types.ts`) and every shipped station carries twelve signed
     * keyframes of it — warmer on wet winter days, cooler on wet summer ones —
     * so the ghost is drawn seasonal (`channel-edit.ts wetDayPoints`) and the
     * note says the span rather than inventing an average that reads as "no
     * effect".
     *
     * PRECIP (`0345` l.61): `snow when day peaks below 0 °C · amount
     * gamma(κ 0.85)` — the shape of what falls once it does.
     *
     * A channel with neither simply has no note.
     */
    function paintNote(stat: ChannelStat | null): boolean {
      noteProse.empty();
      const units = ctx.units();
      const wet = stat?.wetDayOffset;
      const warm = wet != null && (Math.abs(wet[0]) > 1e-9 || Math.abs(wet[1]) > 1e-9);
      const snow = stat?.freezingPoint != null && stat.gammaShape != null;
      const gust = stat?.wetDayScale != null;
      noteProse.toggleClass("is-hidden", !warm && !snow && !gust);
      const value = (text: string): void => {
        noteProse.createSpan({ cls: "wadjet-studio-channel-win-note-value wadjet-studio-num", text });
      };
      if (warm && wet != null) {
        // Two digits, unlike a knob's one: this is the size of a small effect,
        // and rounding 0.35 to 0.4 loses the point of stating it.
        const at = (v: number): string => format(v, "temperatureDelta", units, { signed: true, digits: 2 }).text;
        const flat = Math.abs(wet[1] - wet[0]) < 5e-3;
        noteProse.createSpan({ text: "Wet days run " });
        value(`${flat ? at(wet[1]) : `${at(wet[0])} … ${at(wet[1])}`} ${unitLabel("temperatureDelta", units)}`);
        noteProse.createSpan({ text: flat ? `${wet[1] >= 0 ? " warmer" : " cooler"} (dashed)` : " off the mean by season (dashed)" });
        if (stat?.persistence != null) {
          noteProse.createSpan({ text: " · persistence " });
          value(format(stat.persistence, "fraction", units, { digits: 3 }).text);
        }
      }
      // WIND — `wind.wetDayScale`, what a wet day does to the speed. A
      // multiplier on a card of shares reads as a share until it is said in
      // words, which is why it is the sentence and not a row.
      if (gust && stat?.wetDayScale != null) {
        noteProse.createSpan({ text: "Wet days blow " });
        value(`×${format(stat.wetDayScale, "factor", units).text}`);
        noteProse.createSpan({ text: " harder" });
      }
      if (!snow || stat?.freezingPoint == null || stat.gammaShape == null) return warm || gust;
      noteProse.createSpan({ text: "snow when day peaks below " });
      value(valueText(stat.freezingPoint, "temperature", units));
      noteProse.createSpan({ text: " · amount " });
      value(`gamma(κ ${format(stat.gammaShape, "fraction", units).text})`);
      return true;
    }

    /**
     * The rows half of the fact card: the drawn range, and the scalars that
     * shape the curve without being on it. Every line is real zone data — a
     * line whose number the channel has no curve for is simply not drawn
     * (SPEC §8) — and `paintNote` adds the prose under them.
     */
    function paintStats(z: ZoneProfile | null, state: StudioState): void {
      statList.empty();
      const isCycle = parseScope(scope).kind === "cycle";
      const param = chartParam();
      const stat = z === null || isCycle ? null : channelStat(z, param, scope);
      const quantity = spec.axis[param] ?? "fraction";
      const units = ctx.units();
      /** `[key, value, hueClass]` — a line per non-null fact, in reading order. */
      const lines: Array<[string, string, string]> = [];
      const pct = (v: number): string => `${format(v, "percent", units, { digits: 0 }).text}%`;
      /** The low end of a range: the same digits as `valueText`, with the unit held back to the high end. */
      const bare = (v: number): string => format(v, quantity, units, quantity === "percent" ? { digits: 0 } : undefined).text;

      if (stat?.range) lines.push(["range", `${bare(stat.range[0])} – ${valueText(stat.range[1], quantity, units)}`, ""]);

      // TEMPERATURE's ghost and persistence, and PRECIP's snow line, are the
      // prose half of the same card (`0250` l.70, `0345` l.61) — under the
      // rows, because a sentence after a column of numbers reads, and one
      // before them buries the numbers.
      const prose = paintNote(stat);

      // PRECIPITATION — the count of wet days the Markov pair settles at and
      // the peak of the run odds, as `0345` l.51 puts them: a count, not the
      // share it came from, and the peak in the `pww` line's own green.
      if (stat?.wetShare != null) lines.push(["wet days / yr", `≈ ${Math.round(stat.wetShare * calendar(state).yearLength)}`, "is-wet"]);
      if (stat?.wetRunPeak != null) lines.push(["p(wet | wet) peak", pct(stat.wetRunPeak), "is-run"]);
      if (stat?.amountMm != null) lines.push(["mean fall", valueText(stat.amountMm, "amount", units), "is-wet"]);

      // WIND — the still days, and what a wet day does to the speed.
      if (stat?.calmShare != null) lines.push(["calm", `${pct(stat.calmShare)} of days`, ""]);
      // …and the wet-day multiplier is the sentence this card closes on, the
      // way the other three do (`0415`'s own `gust on wet days`).

      // SKY — the pair's two means, then the day-to-day scatter around them.
      if (stat?.mean != null) {
        const section = param.split(".")[0] ?? param;
        lines.push([section, stat.companionMean == null ? pct(stat.mean) : `${pct(stat.mean)} · wet ${pct(stat.companionMean)}`, ""]);
      }
      // Both sections' σ, always in the prototype's order (`0480` l.24) — the
      // scatter is a property of the channel, not of the half the handles are
      // on, and naming only one made the card change under a legend click.
      if (stat?.daySigma != null && z !== null) {
        const sigma = (p: string): number | null => (p === param ? stat.daySigma : channelStat(z, p, scope).daySigma);
        const parts = ([["cloud", "cloud.dry"], ["humid", "humidity.dry"]] as const).flatMap(([name, p]) => {
          const v = sigma(p);
          return v === null ? [] : [`${name} ${format(v, "fraction", units).text}`];
        });
        if (parts.length > 0) lines.push(["day-to-day σ", parts.join(" · "), ""]);
      }

      // One card, so it is here that the whole thing goes: a channel with
      // neither a fact nor a sentence shows nothing rather than an empty box.
      noteCard.toggleClass("is-hidden", lines.length === 0 && !prose);
      statList.toggleClass("is-hidden", lines.length === 0);
      for (const [key, value, hue] of lines) {
        const el = statList.createDiv({ cls: "wadjet-studio-channel-win-fact" });
        el.createSpan({ cls: "wadjet-studio-channel-win-fact-key", text: key });
        const v = el.createSpan({ cls: "wadjet-studio-channel-win-fact-value wadjet-studio-num", text: value });
        if (hue !== "") v.addClass(hue);
      }
    }

    // --- paint -------------------------------------------------------------

    function repaint(force: boolean): void {
      const state = ctx.store.get();
      const z = zone(state);
      const cal = calendar(state);
      const draftKey = z === null ? "" : JSON.stringify([z.modifiers, z.regimes, z.automation ?? null, z.preset ?? null]);
      const key = [z?.id ?? "", scope, series, String(selected), ctx.units(), draftKey, JSON.stringify(cal), JSON.stringify(state.world.eras), JSON.stringify(state.view.colours.seasons)].join("~");
      if (!force && key === signature) return;
      signature = key;

      paintScopes(z, state);
      stageEl.setText(stageCaption(chartParam(), scope, scopeMoon(state)?.cycleDays));
      paintPlots(z, state);
      paintPoint(z, state);
      paintRose(z, state);
      paintKnobs(z);
      paintExtras(z);
      paintWriters(z, state);
      paintStats(z, state);
    }

    // --- pull-based readouts -------------------------------------------------

    function issues(): StudioIssue[] {
      const state = ctx.store.get();
      const z = zone(state);
      if (z === null) return [];
      const described = ctx.calendar();
      const readOnlyCalendar = described?.readOnly ?? false;
      const seasons = readOnlyCalendar ? (described?.seasons ?? []) : state.world.calendar.seasons;
      const moons = readOnlyCalendar ? (described?.moons ?? []) : state.world.calendar.moons;
      const mine = unitKey({ kind: "channel", channel });
      return issuesFor({ zone: z, eras: state.world.eras, seasons, moons, readOnlyCalendar }).filter((i) => unitKey(i.unit) === mine);
    }

    /**
     * SPEC law 5: the schema this panel writes into, then the `layer:` ids it
     * has actually put there — the grammar it produces, not a state readout.
     * `grammar()` drops the second clause while the channel is still neutral.
     */
    function writes(): string {
      const z = zone();
      const ids = z === null ? [] : writtenLayers(z, channel);
      return grammar(spec.schema, ids.length === 0 ? `modifiers[${layerGlob(channel)}] — neutral` : `modifiers[${ids.join(", ")}]`);
    }

    unsubscribe = ctx.store.subscribe(() => repaint(false));
    repaint(true);

    return {
      title,
      // Prototype width (`proto-markup/`): a design constant, not a function of the content.
      width: WINDOW_W,
      badge: BADGE,
      // The title lamp carries the channel's own identity, not a generic
      // ok-green — a validation level still wins over it (`components/led.ts`).
      // The pill beside it takes the softened form of that hue where the
      // channel has one: at 10 px on #202225 the raw orange and blue read as
      // a lit mark rather than as a word.
      badgeColor: spec.badgeColor ?? color,
      body: root,
      led: { on: true, scope: "chain", color },
      level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "channel", channel }))),
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        for (const view of plots) {
          view.chart?.destroy();
          view.chart = null;
        }
        rose?.destroy();
        resetChip?.destroy();
        for (const knob of knobs.values()) knob.destroy();
        knobs.clear();
        for (const chip of scopeChipEls.values()) chip.destroy();
        scopeChipEls.clear();
        rose = null;
        resetChip = null;
        root.remove();
      },
    };
  };
}
