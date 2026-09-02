/**
 * The channel editor windows (SPEC §3.4 "Channel editors", PLAN §5.2).
 *
 * One panel per signal chain, opened by its row label on the playlist
 * (SPEC law 2 — the row *is* the channel, so the row opens it). The body is
 * four parts, top to bottom:
 *
 *   Series picker  which of a paired chart's lines is the editable one —
 *                  PRECIP's `pww`/`pwd`, SKY's cloud and humidity halves.
 *                  Absent on a channel with a single line
 *   Chart          the drawn curve, 12 keyframes that drag; the station's own
 *                  curve dim underneath, the companion line dimmer still, and
 *                  the swung result when the swing knob is off neutral
 *   Rose           WIND only: which way each season blows from, read-only
 *   Scope chips    `All year · <seasons> · ☾ <moons>` — a Segmented, plus a
 *                  `moon:<X>` chip that opens the CYCLE window
 *   Knobs          whatever `knobsFor(scope)` says, with the stage caption
 *   Writers        every source that writes this channel in signal order,
 *                  each row a click-through to the window that owns it
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
import { addEnvelopePoint, addKeyframe, ALL_SCOPE, chartSeries, clearDirection, companionSeries, curvePoints, directionLayer, directionRose, knobsFor, layerGlob, MOON_GLYPH, parseScope, primarySeries, read, removeEnvelopePoint, removeKeyframe, scopeChips, seasonMarkers, setEnvelopePoint, setKeyframe, stageCaption, stationPoints, swungPoints, write, writers, writesText, type KnobId, type WriterRow } from "../../model/channel-edit";
import type { Channel } from "../../model/compile";
import { format, type Quantity } from "../../model/format";
import { channelEditorHint } from "../../model/hints-channel";
import type { KnobSpec } from "../../model/knob";
import { needsUnitParse, parseDisplay } from "../../model/knob-units";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createChart, createChip, createKnob, createSegmented, type ChartComponent, type ChartSeries, type ChipComponent, type KnobComponent, type SegmentedComponent } from "../components";
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

/** The chart, in CSS pixels. Wide enough for 12 handles at 4 px radius without them touching. */
const CHART_W = 380;
const CHART_H = 150;
/** Headroom above and below the drawn extent, so a keyframe can be dragged past it. */
const CHART_PAD_FRACTION = 0.12;
/** …and at least this much, in the channel's own unit, when the curve is nearly flat. */
const CHART_MIN_PAD = 1;

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
}

interface ChannelWindowSpec {
  title: string;
  /** the palette colour for the drawn curve and the knobs (SPEC §9) */
  color: string;
  /** every knob the channel offers in any scope; `knobsFor` picks the scope's own */
  knobs: Partial<Record<KnobId, ChannelKnobSpec>>;
  /** the label each drawn series wears in the picker; the parameters are `chartSeries`'s */
  seriesLabels?: Record<string, string>;
  /** a fixed y axis, for the channels whose parameters are fractions; omitted means "pad the drawn extent" */
  yRange?: [number, number];
  /** draw the compass rose of `wind.direction` under the chart */
  rose?: boolean;
}

/** PLAN §5.2: offset ±10 °C, swing ×0.4–1.6, jitter ±5 °C on `temperature.sd`, ☾ depth ±10 °C. */
const TEMPERATURE: ChannelWindowSpec = {
  title: "Temperature",
  color: "var(--wadjet-studio-temp)",
  knobs: {
    offset: { label: "offset", quantity: "temperatureDelta", spec: { min: -10, max: 10, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.offset"), seasonHint: channelEditorHint("channel.season.offset") },
    swing: { label: "swing", quantity: "factor", spec: { min: 0.4, max: 1.6, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.swing") },
    jitter: { label: "jitter", quantity: "temperatureDelta", spec: { min: -5, max: 5, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.jitter") },
    depth: { label: "depth", quantity: "temperatureDelta", spec: { min: -10, max: 10, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.depth") },
  },
};

/**
 * PLAN §5.2 "Precip: … scale ops". The chart is the wet-day odds pair, one of
 * them editable at a time; `amount` scales the mm the row plots, which has no
 * line on this chart because it is not on the 0–1 axis the odds live on.
 */
const PRECIPITATION: ChannelWindowSpec = {
  title: "Precipitation",
  color: "var(--wadjet-studio-precip)",
  yRange: [0, 1],
  seriesLabels: { "precipitation.pww": "pww", "precipitation.pwd": "pwd" },
  knobs: {
    stick: { label: "stick", quantity: "factor", spec: { min: 0.6, max: 1.3, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.stick") },
    chance: { label: "chance", quantity: "factor", spec: { min: 0.4, max: 2.5, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.chance") },
    amount: { label: "amount", quantity: "factor", spec: { min: 0.4, max: 2.5, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.amount") },
    wetShift: { label: "chance", quantity: "probability", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.season.chance") },
    depth: { label: "depth", quantity: "probability", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.depth") },
  },
};

/** PLAN §5.2 "Wind: `wind.speed` offset, `wind.direction` set per season". */
const WIND: ChannelWindowSpec = {
  title: "Wind",
  color: "var(--wadjet-studio-wind)",
  rose: true,
  knobs: {
    wind: { label: "wind", quantity: "speed", spec: { min: -10, max: 24, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.wind"), seasonHint: channelEditorHint("channel.season.wind") },
    gust: { label: "gust", quantity: "factor", spec: { min: 1, max: 1.6, step: 0.01, neutral: 1 }, hint: channelEditorHint("channel.gust") },
    calm: { label: "calm", quantity: "fraction", spec: { min: -0.3, max: 0.3, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.calm") },
    direction: { label: "direction", quantity: "direction", spec: { min: 0, max: 360, step: 1, neutral: 0 }, hint: channelEditorHint("channel.direction") },
    depth: { label: "depth", quantity: "speed", spec: { min: -20, max: 20, step: 0.1, neutral: 0 }, hint: channelEditorHint("channel.depth") },
  },
};

/** PLAN §5.2 "Sky: `cloud.dry/wet` offset". Humidity is the same shape, and the same channel (SPEC §1). */
const SKY: ChannelWindowSpec = {
  title: "Sky",
  color: "var(--wadjet-studio-sky)",
  yRange: [0, 1],
  seriesLabels: { "cloud.dry": "cloud dry", "cloud.wet": "cloud wet", "humidity.dry": "hum dry", "humidity.wet": "hum wet" },
  knobs: {
    cloud: { label: "cloud", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.cloud"), seasonHint: channelEditorHint("channel.season.cloud") },
    humidity: { label: "humidity", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.humidity"), seasonHint: channelEditorHint("channel.season.humidity") },
    depth: { label: "depth", quantity: "fraction", spec: { min: -0.5, max: 0.5, step: 0.01, neutral: 0 }, hint: channelEditorHint("channel.depth") },
  },
};

/**
 * The table the four channel editors are built from. All four are real
 * editors — the row label is never a dead click (SPEC law 2). The parameters
 * each knob and each drawn line stands for are `model/channel-edit.ts`'s
 * (`CHANNEL_KNOBS` / `CHANNEL_CHART`); this table is presentation only.
 */
export const CHANNEL_SPECS: Record<Channel, ChannelWindowSpec> = {
  temperature: TEMPERATURE,
  precipitation: PRECIPITATION,
  wind: WIND,
  sky: SKY,
};

/** The compass rose, in CSS pixels — square, so the sectors are circular. */
const ROSE_SIZE = 132;

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

/** `+2.0 °C` / `×1.25` / `0.62` — the knob's own readout, in the user's units. */
function knobText(v: number, quantity: Quantity, units: Units): string {
  const f = format(v, quantity, units, quantity === "factor" ? undefined : { signed: true });
  if (quantity === "factor") return `${f.unit}${f.text}`;
  return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildChannelWindow(channel: Channel): WindowBuilder {
  return (ctx: SurfaceContext): WindowBuild => {
    const spec = CHANNEL_SPECS[channel];
    const { title, color, knobs: knobSpecs } = spec;
    /** The parameters the picker offers. One means there is no picker. */
    const seriesOptions = chartSeries(channel);

    let unsubscribe: (() => void) | null = null;
    let signature = "";
    /** The selected scope chip. View-local: a scope is a lens, not a draft edit. */
    let scope = ALL_SCOPE;
    /** The editable line of a paired chart. View-local for the same reason. */
    let series = primarySeries(channel);

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

    /** Seasons and moons come from the adapter when it owns the calendar, from the world draft otherwise (`ui/mixer.ts`). */
    function calendar(state: StudioState = ctx.store.get()): { seasons: Array<{ name: string; from: number }>; moons: Array<{ name: string }> } {
      const described = ctx.calendar();
      const readOnly = described?.readOnly ?? false;
      return {
        seasons: readOnly ? (described?.seasons ?? []) : state.world.calendar.seasons,
        moons: readOnly ? (described?.moons ?? []) : state.world.calendar.moons,
      };
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

    const seriesRow = root.createDiv({ cls: "wadjet-studio-channel-win-series", attr: { "data-hint": channelEditorHint("channel.series") } });
    const chartHost = root.createDiv({ cls: "wadjet-studio-channel-win-chart", attr: { "data-part": "channel-chart", "data-hint": channelEditorHint("channel.chart") } });
    const roseHost = root.createDiv({ cls: "wadjet-studio-channel-win-rose", attr: { "data-part": "channel-rose", "data-hint": channelEditorHint("channel.rose") } });
    const scopeRow = root.createDiv({ cls: "wadjet-studio-channel-win-scopes", attr: { "data-hint": channelEditorHint("channel.scope") } });
    const stageEl = root.createDiv({ cls: "wadjet-studio-channel-win-stage", attr: { "data-part": "channel-stage", "data-hint": channelEditorHint("channel.stage") } });
    const knobRow = root.createDiv({ cls: "wadjet-studio-channel-win-knobs", attr: { "data-part": "channel-knobs" } });
    const extraRow = root.createDiv({ cls: "wadjet-studio-channel-win-extras" });

    const writersBox = root.createDiv({ cls: "wadjet-studio-channel-win-writers", attr: { "data-hint": channelEditorHint("channel.writers") } });
    writersBox.createDiv({ cls: "wadjet-studio-channel-win-writers-head", text: "Writers → channel" });
    const writerList = writersBox.createDiv({ cls: "wadjet-studio-channel-win-writer-list", attr: { "data-part": "channel-writers" } });

    let chart: ChartComponent | null = null;
    let rose: ChartComponent | null = null;
    let segmented: SegmentedComponent | null = null;
    let seriesPicker: SegmentedComponent | null = null;
    let moonChip: ChipComponent | null = null;
    let resetChip: ChipComponent | null = null;
    const knobs = new Map<KnobId, KnobComponent>();

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
     * The drawn lines, editable one first — `components/chart.ts`'s
     * `automation` kind gives handles to `series[0]` only, which is what makes
     * the picker a real choice rather than a filter.
     */
    function seriesFor(z: ZoneProfile): ChartSeries[] {
      const s = parseScope(scope);
      const param = chartParam();
      const drawn = curvePoints(z, param, scope);
      if (s.kind === "cycle") return [{ points: drawn, color: "var(--wadjet-studio-moon)" }];
      const out: ChartSeries[] = [{ points: drawn, color }];
      const swung = swungPoints(z, param, scope);
      if (swung.some((p, i) => Math.abs(p[1] - (drawn[i]?.[1] ?? p[1])) > 1e-6)) out.push({ points: swung, color: "var(--wadjet-studio-accent)" });
      for (const other of companionSeries(channel, param)) out.push({ points: curvePoints(z, other, scope), color: "var(--wadjet-studio-text-dim)" });
      const station = stationPoints(z, param, scope);
      if (station.length > 0) out.push({ points: station, color: "var(--wadjet-studio-text-mute)" });
      return out;
    }

    /**
     * The cycle domain is the envelope's own 0–1 dimmer axis, and a channel
     * whose parameters are fractions has the same fixed axis (`spec.yRange`).
     * An open-ended channel's year domain is padded past the drawn extent so a
     * keyframe can be dragged *out* of the range it currently defines, rather
     * than pinning itself to the edge.
     */
    function yRangeOf(lines: readonly ChartSeries[], isCycle: boolean): [number, number] {
      if (isCycle) return [0, 1];
      if (spec.yRange !== undefined) return [spec.yRange[0], spec.yRange[1]];
      const ys = lines.flatMap((s) => s.points.map((p) => p[1]));
      if (ys.length === 0) return [0, 1];
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      const pad = Math.max(CHART_MIN_PAD, (hi - lo) * CHART_PAD_FRACTION);
      return [lo - pad, hi + pad];
    }

    function paintChart(z: ZoneProfile | null, state: StudioState): void {
      const isCycle = parseScope(scope).kind === "cycle";
      const lines = z === null ? [] : seriesFor(z);
      const next = {
        kind: "automation" as const,
        domain: isCycle ? ("cycle" as const) : ("year" as const),
        width: CHART_W,
        height: CHART_H,
        series: lines,
        editable: z !== null,
        markers: seasonMarkers(scope, calendar(state)),
        yRange: yRangeOf(lines, isCycle),
      };
      if (chart === null) chart = createChart(chartHost, { ...next, onPoint, onAdd, onRemove });
      else chart.update(next);
      chartHost.setAttr("data-hint", isCycle ? channelEditorHint("channel.envelope") : channelEditorHint("channel.chart"));
    }

    /** The series picker — hidden when there is one line, and inside a ☾ scope, where the envelope is the only curve. */
    function paintSeriesPicker(): void {
      const show = seriesOptions.length > 1 && parseScope(scope).kind !== "cycle";
      seriesRow.toggleClass("is-hidden", !show);
      if (!show) {
        seriesPicker?.destroy();
        seriesPicker = null;
        return;
      }
      const options = seriesOptions.map((p) => ({ value: p, label: spec.seriesLabels?.[p] ?? p }));
      if (seriesPicker === null) seriesPicker = createSegmented(seriesRow, { options, value: series, onChange: selectSeries });
      else seriesPicker.update({ options, value: series });
      seriesPicker.el.setAttr("data-part", "channel-series");
    }

    /**
     * WIND's compass rose: one petal per season, at the bearing that season
     * blows from. Read-only — the bearing is set by the `direction` knob
     * inside a season scope, because a rose sector is 22.5° wide and a bearing
     * is not.
     */
    function paintRose(z: ZoneProfile | null, state: StudioState): void {
      const show = spec.rose === true && parseScope(scope).kind !== "cycle";
      roseHost.toggleClass("is-hidden", !show);
      if (!show) {
        rose?.destroy();
        rose = null;
        roseHost.removeAttribute("data-rose");
        return;
      }
      const points = z === null ? [] : directionRose(z, { seasons: calendar(state).seasons });
      const next = { kind: "rose" as const, domain: "year" as const, width: ROSE_SIZE, height: ROSE_SIZE, series: [{ points, color }] };
      if (rose === null) rose = createChart(roseHost, next);
      else rose.update(next);
      // The drawn sectors carry no identity of their own, so the host states
      // what they stand for: `<sector>:<seasons>`, occupied sectors only.
      roseHost.setAttr(
        "data-rose",
        points
          .filter((p) => p[1] > 0)
          .map((p) => `${p[0]}:${p[1]}`)
          .join(","),
      );
    }

    // --- scopes ------------------------------------------------------------

    function paintScopes(z: ZoneProfile | null, state: StudioState): void {
      const chips = z === null ? [{ id: ALL_SCOPE, label: "All year" }] : scopeChips(z, calendar(state));
      if (!chips.some((c) => c.id === scope)) scope = ALL_SCOPE;
      const options = chips.map((c) => ({ value: c.id, label: c.label }));
      if (segmented === null) segmented = createSegmented(scopeRow, { options, value: scope, onChange: selectScope });
      else segmented.update({ options, value: scope });
      segmented.el.setAttr("data-part", "channel-scopes");

      const s = parseScope(scope);
      if (s.kind === "cycle") {
        const props = { label: `moon:${s.moon}`, icon: MOON_GLYPH, color: "var(--wadjet-studio-moon)", hint: channelEditorHint("channel.moon"), onClick: () => openCycleFor(ctx, s.moon) };
        if (moonChip === null) moonChip = createChip(scopeRow, props);
        else moonChip.update(props);
        moonChip.el.setAttr("data-part", "channel-moon");
      } else if (moonChip !== null) {
        moonChip.destroy();
        moonChip = null;
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
          existing.update({ value, hint: hintFor(id), disabled: z === null });
          continue;
        }
        const knob = createKnob(knobRow, {
          spec: k.spec,
          value,
          label: k.label,
          color,
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

    function paintWriters(z: ZoneProfile | null, state: StudioState): void {
      writerList.empty();
      const rows = z === null ? [] : writers(z, state.world.eras, channel);
      for (const row of rows) {
        const el = writerList.createDiv({
          cls: "wadjet-studio-channel-win-writer",
          attr: { role: "button", tabindex: "0", "data-part": "channel-writer", "data-kind": row.kind, "data-hint": channelEditorHint("channel.writer", `${row.label} — ${row.opsText}`) },
        });
        el.createSpan({ cls: "wadjet-studio-channel-win-writer-kind", text: row.kind });
        el.createSpan({ cls: "wadjet-studio-channel-win-writer-label", text: row.label });
        el.createSpan({ cls: "wadjet-studio-channel-win-writer-ops", text: row.opsText });
        el.addEventListener("click", () => openWriter(row));
        el.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          openWriter(row);
        });
      }
    }

    // --- paint -------------------------------------------------------------

    function repaint(force: boolean): void {
      const state = ctx.store.get();
      const z = zone(state);
      const cal = calendar(state);
      const draftKey = z === null ? "" : JSON.stringify([z.modifiers, z.regimes, z.automation ?? null, z.preset ?? null]);
      const key = [z?.id ?? "", scope, series, ctx.units(), draftKey, JSON.stringify(cal), JSON.stringify(state.world.eras)].join("~");
      if (!force && key === signature) return;
      signature = key;

      paintScopes(z, state);
      stageEl.setText(stageCaption(scope));
      paintSeriesPicker();
      paintChart(z, state);
      paintRose(z, state);
      paintKnobs(z);
      paintExtras(z);
      paintWriters(z, state);
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

    /** SPEC law 5: the exact grammar this panel produces — the channel's own `layer:` modifiers as they stand. */
    function writes(): string {
      const z = zone();
      return z === null ? `modifiers[${layerGlob(channel)}]` : writesText(z, channel);
    }

    unsubscribe = ctx.store.subscribe(() => repaint(false));
    repaint(true);

    return {
      title,
      badge: BADGE,
      body: root,
      led: { on: true, scope: "chain" },
      level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "channel", channel }))),
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        chart?.destroy();
        rose?.destroy();
        segmented?.destroy();
        seriesPicker?.destroy();
        moonChip?.destroy();
        resetChip?.destroy();
        for (const knob of knobs.values()) knob.destroy();
        knobs.clear();
        chart = null;
        rose = null;
        segmented = null;
        seriesPicker = null;
        moonChip = null;
        resetChip = null;
        root.remove();
      },
    };
  };
}
