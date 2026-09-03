/**
 * The Forcings · ZONE window (SPEC §3.4 "Forcings · ZONE", PLAN §5.3).
 *
 * The zone master: everything the whole zone's temperature and precipitation
 * pass through after the devices and before the eras (SPEC §1). It is one
 * panel with two **offset stacks**, each laid out knob-left / rows-right the
 * way the prototype's `vst-macro` is —
 *
 *   TEMPERATURE   trim knob   ∿ lane · FRC · warmth   the drawn offset here
 *                             ＋ trim · constant       a constant on top of it
 *                             = into TEMP chain        what the chain receives
 *   PRECIPITATION wetness     × scale · constant       both wet-day odds, scaled
 *
 * — and nothing else. SPEC §3.4 is explicit: "No placeholder controls."
 *
 * Three things worth knowing before editing this file:
 *
 *  - **The knob and its row are the same value seen twice.** The knob is the
 *    control; the row beneath the lane is that control's line in the stack,
 *    so the sum reads as arithmetic (`∿` then `＋` then `=`) rather than as a
 *    knob with a caption. Both repaint from the same `getTrim`.
 *  - **The lane row is a *link*, not an editor.** SPEC §3.2 draws the warmth
 *    lane on the playlist, where years are the axis; this panel only reads it
 *    (`laneValue` at the window's centre year — the `at playhead` readout)
 *    and, when clicked, zooms the playlist to Era so the lane is worth
 *    looking at — creating the lane first if the zone has none. That is SPEC
 *    law 2 in one gesture: the row stands for the lane, so it opens the lane.
 *  - **The chrome LED and the mixer's Forcings LED read the same bucket.**
 *    Both call `ledLevel(byUnit.get(unitKey({ kind: "forcings" })))` — this
 *    panel's `level` getter re-reads it every tick (`windows.ts`, wadjet-9f9.35),
 *    the mixer re-reads it in its own render pass.
 */
import { laneValue } from "../../../core/automation";
import type { ZoneProfile } from "../../../core/types";
import type { Units } from "../../../core/units";
import { ensureLane } from "../../model/automation-edit";
import { getTrim, getWarmthLane, getWetness, setTrim, setWetness, TRIM_ID, WARMTH_LANE_ID, WETNESS_ID } from "../../model/compile";
import { factorText, grammar } from "../../model/copy";
import { format } from "../../model/format";
import { forcingsHint } from "../../model/hints-forcings";
import { parseDisplay } from "../../model/knob-units";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { presetWindow, worldBounds, type Window, type ZoomBounds } from "../../model/zoom";
import { createKnob, type KnobComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";

/** The id the Forcings panel is opened under. */
export const FORCINGS_WINDOW = "forcings";

/** SPEC §3.4 / PLAN §5.3: the trim is a ± 8 °C constant on `temperature.mean`. */
const TRIM_SPEC = { min: -8, max: 8, step: 0.1, neutral: 0 } as const;
/** Wetness scales both wet-day probabilities; ×1 is "no forcing". */
const WETNESS_SPEC = { min: 0.5, max: 1.5, step: 0.01, neutral: 1 } as const;

/** `+2.0 °C` / `−1.5 °C` — a temperature *delta*, so no +32 offset in imperial. */
function warmthText(v: number, units: Units): string {
  const f = format(v, "temperatureDelta", units, { signed: true });
  return `${f.text} ${f.unit}`;
}

/** One line of an offset stack: `<op> <label> …… <note> <value>`. */
interface StackRow {
  el: HTMLElement;
  value: HTMLElement;
}

function stackRow(
  parent: HTMLElement,
  o: { op: string; label: string; note?: string; noteBefore?: boolean; glyph?: string; kind?: string; attr?: Record<string, string> },
): StackRow {
  const el = parent.createDiv({ cls: `wadjet-studio-forcings-row${o.kind === undefined ? "" : ` is-${o.kind}`}`, attr: o.attr ?? {} });
  el.createSpan({ cls: "wadjet-studio-forcings-op", text: o.op, attr: { "aria-hidden": "true" } });
  el.createSpan({ cls: "wadjet-studio-forcings-label", text: o.label });
  const note = (): void => {
    if (o.note !== undefined) el.createSpan({ cls: "wadjet-studio-forcings-note", text: o.note });
  };
  // `at playhead` qualifies the number it follows; `into PRECIP chain` names
  // the destination the number is heading for, so it leads. Prototype order.
  if (o.noteBefore === true) note();
  const value = el.createSpan({ cls: "wadjet-studio-forcings-value wadjet-studio-num" });
  if (o.noteBefore !== true) note();
  if (o.glyph !== undefined) el.createSpan({ cls: "wadjet-studio-forcings-glyph", text: o.glyph, attr: { "aria-hidden": "true" } });
  return { el, value };
}

/** The dim small-caps caption over a stack: a channel swatch, then what the stack writes. */
function sectionHead(parent: HTMLElement, text: string): void {
  const head = parent.createDiv({ cls: "wadjet-studio-forcings-head" });
  head.createSpan({ cls: "wadjet-studio-forcings-swatch", attr: { "aria-hidden": "true" } });
  head.createSpan({ cls: "wadjet-studio-forcings-headtext", text });
}

export const buildForcingsWindow: WindowBuilder = (ctx: SurfaceContext): WindowBuild => {
  let unsubscribe: (() => void) | null = null;
  let signature = "";

  function zone(state: StudioState = ctx.store.get()): ZoneProfile | null {
    const id = state.view.zoneId;
    return id !== null ? (state.zones[id] ?? null) : null;
  }

  /** The year both readouts are quoted at: the middle of what the playlist shows. */
  function centreYear(state: StudioState = ctx.store.get()): number {
    const w = state.view.window;
    return (w.a + w.b) / 2;
  }

  function epochYear(): number {
    return ctx.calendar()?.epochYear ?? ctx.plugin.settings.calendar.epochYear ?? 1;
  }

  /** Write into the pointed-at zone draft. `history` marks a discrete action. */
  function editZone(apply: (z: ZoneProfile) => void, history = false): void {
    ctx.store.update(
      (s) => {
        const z = zone(s);
        if (z !== null) apply(z);
      },
      history ? { history: true } : undefined,
    );
  }

  // --- the body ------------------------------------------------------------

  const root = createDiv({ cls: "wadjet-studio-forcings" });

  // TEMPERATURE — the offset stack: a drawn lane, a constant, and their sum.
  const tempSection = root.createDiv({ cls: "wadjet-studio-forcings-section", attr: { "data-channel": "temperature" } });
  sectionHead(tempSection, "TEMPERATURE · offset stack → temperature.mean");
  const tempBody = tempSection.createDiv({ cls: "wadjet-studio-forcings-body" });

  const trim: KnobComponent = createKnob(tempBody, {
    spec: TRIM_SPEC,
    value: 0,
    label: "trim",
    size: "lg",
    color: "var(--wadjet-studio-temp)",
    hint: forcingsHint("forcings.trim"),
    fmt: (v) => warmthText(v, ctx.units()),
    parse: (text) => parseDisplay(TRIM_SPEC, "temperatureDelta", ctx.units())(text),
    onChange: (value, phase) => {
      editZone((z) => setTrim(z, value));
      if (phase !== "drag") ctx.store.snapshot();
    },
  });
  trim.el.setAttr("data-part", "forcings-trim");

  const tempStack = tempBody.createDiv({ cls: "wadjet-studio-forcings-stack" });
  const laneRow = stackRow(tempStack, {
    op: "∿",
    label: "lane · FRC · warmth",
    note: "at playhead",
    glyph: "⤢",
    kind: "boxed",
    attr: { role: "button", tabindex: "0", "aria-label": "Zoom the playlist to the warmth lane", "data-hint": forcingsHint("forcings.lane"), "data-part": "forcings-lane" },
  });
  laneRow.el.addClass("wadjet-studio-forcings-lane");
  laneRow.value.setAttr("data-part", "forcings-lane-value");

  const trimRow = stackRow(tempStack, { op: "＋", label: "trim · constant", kind: "boxed", attr: { "data-hint": forcingsHint("forcings.trim") } });
  const totalRow = stackRow(tempStack, { op: "=", label: "into TEMP chain", kind: "total", attr: { "data-hint": forcingsHint("forcings.total") } });
  totalRow.value.setAttr("data-part", "forcings-total");

  // PRECIPITATION — one scale, on both wet-day probabilities.
  const precipSection = root.createDiv({ cls: "wadjet-studio-forcings-section", attr: { "data-channel": "precipitation" } });
  sectionHead(precipSection, "PRECIPITATION · scale → precipitation.pww / pwd");
  const precipBody = precipSection.createDiv({ cls: "wadjet-studio-forcings-body" });

  const wetness: KnobComponent = createKnob(precipBody, {
    spec: WETNESS_SPEC,
    value: 1,
    label: "wetness",
    size: "lg",
    color: "var(--wadjet-studio-precip)",
    hint: forcingsHint("forcings.wetness"),
    fmt: (k) => factorText(k),
    onChange: (value, phase) => {
      editZone((z) => setWetness(z, value));
      if (phase !== "drag") ctx.store.snapshot();
    },
  });
  wetness.el.setAttr("data-part", "forcings-wetness");

  const precipStack = precipBody.createDiv({ cls: "wadjet-studio-forcings-stack" });
  const wetRow = stackRow(precipStack, { op: "×", label: "scale · constant", note: "into PRECIP chain", noteBefore: true, kind: "boxed", attr: { "data-hint": forcingsHint("forcings.wetness") } });

  // --- the lane row's one gesture -------------------------------------------

  /**
   * SPEC §3.4: the lane row "zooms to Era". The lane itself is drawn on the
   * playlist, so a zone with no lane gets one here first — otherwise the click
   * would zoom to a row with nothing on it.
   */
  function openLane(): void {
    const epoch = epochYear();
    editZone((z) => {
      ensureLane(z, epoch);
    }, true);
    const bounds: ZoomBounds = worldBounds(epoch, ctx.store.get().world.eras);
    const seasons = ctx.calendar()?.seasons ?? ctx.store.get().world.calendar.seasons;
    const next: Window = presetWindow("era", ctx.store.get().view.window, bounds, seasons, ctx.store.get().world.eras);
    ctx.store.update((s) => {
      s.view.window = next;
    });
    ctx.view.app.workspace.requestSaveLayout();
  }

  laneRow.el.addEventListener("click", openLane);
  laneRow.el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openLane();
  });

  // --- paint ---------------------------------------------------------------

  function repaint(force: boolean): void {
    const state = ctx.store.get();
    const z = zone(state);
    const u = ctx.units();
    const year = centreYear(state);
    const t = z === null ? 0 : getTrim(z);
    const lane = z === null ? 0 : laneValue(getWarmthLane(z), year);
    const wet = z === null ? 1 : getWetness(z);
    const key = `${z?.id ?? ""}|${t}|${lane}|${wet}|${u}`;
    if (!force && key === signature) return;
    signature = key;

    laneRow.value.setText(warmthText(lane, u));
    trimRow.value.setText(warmthText(t, u));
    totalRow.value.setText(warmthText(t + lane, u));
    wetRow.value.setText(factorText(wet));
    trim.update({ value: t });
    wetness.update({ value: wet });
  }

  // --- pull-based readouts ---------------------------------------------------

  function issues(): StudioIssue[] {
    const state = ctx.store.get();
    const z = zone(state);
    if (z === null) return [];
    const description = ctx.calendar();
    const readOnlyCalendar = description?.readOnly ?? false;
    const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
    const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
    const mine = unitKey({ kind: "forcings" });
    return issuesFor({ zone: z, eras: state.world.eras, seasons, moons, readOnlyCalendar }).filter((i) => unitKey(i.unit) === mine);
  }

  /**
   * The grammar this panel produces (SPEC law 5): one automation lane and two
   * modifiers. The shape shows even at neutral — a stack that currently sums
   * to zero still says what it would write.
   */
  function writes(): string {
    const z = zone();
    const u = ctx.units();
    const t = z === null ? 0 : getTrim(z);
    const wet = z === null ? 1 : getWetness(z);
    const points = z === null ? 0 : getWarmthLane(z).points.length;
    return grammar(
      `automation[${WARMTH_LANE_ID} · ${points} pts → temperature.mean]`,
      `modifiers[${TRIM_ID} offset ${warmthText(t, u)} · ${WETNESS_ID} scale ${factorText(wet)}]`,
      "climate stage",
    );
  }

  unsubscribe = ctx.store.subscribe(() => repaint(false));
  repaint(true);

  return {
    title: "Forcings",
    // Prototype width (`proto-markup/`): a design constant, not a function of the content.
    width: 390,
    badge: "ZONE",
    body: root,
    led: { on: true, scope: "chain" },
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "forcings" }))),
    writes,
    issues,
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
      trim.destroy();
      wetness.destroy();
      root.remove();
    },
  };
};
