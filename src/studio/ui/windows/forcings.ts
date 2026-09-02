/**
 * The Forcings · ZONE window (SPEC §3.4 "Forcings · ZONE", PLAN §5.3).
 *
 * The zone master: everything the whole zone's temperature and precipitation
 * pass through after the devices and before the eras (SPEC §1). It is one
 * panel with two stacks —
 *
 *   TEMPERATURE   ∿ lane · FRC · warmth   the drawn offset at the centre year
 *                 ＋ trim                  a constant on top of it
 *                 = total into TEMP        what the chain actually receives
 *   PRECIPITATION wetness ×                both wet-day probabilities, scaled
 *
 * — and nothing else. SPEC §3.4 is explicit: "No placeholder controls."
 *
 * Two things worth knowing before editing this file:
 *
 *  - **The lane row is a *link*, not an editor.** SPEC §3.2 draws the warmth
 *    lane on the playlist, where years are the axis; this panel only reads it
 *    (`laneValue` at the window's centre year) and, when clicked, zooms the
 *    playlist to Era so the lane is worth looking at — creating the lane
 *    first if the zone has none. That is SPEC law 2 in one gesture: the row
 *    stands for the lane, so it opens the lane.
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
import { format } from "../../model/format";
import { forcingsHint } from "../../model/hints-forcings";
import { parseDisplay } from "../../model/knob-units";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { presetWindow, type Window, type ZoomBounds } from "../../model/zoom";
import { createKnob, type KnobComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";

/** The id the Forcings panel is opened under. */
export const FORCINGS_WINDOW = "forcings";

/** SPEC §3.4 / PLAN §5.3: the trim is a ± 8 °C constant on `temperature.mean`. */
const TRIM_SPEC = { min: -8, max: 8, step: 0.1, neutral: 0 } as const;
/** Wetness scales both wet-day probabilities; ×1 is "no forcing". */
const WETNESS_SPEC = { min: 0.5, max: 1.5, step: 0.01, neutral: 1 } as const;

/** Mirrors `header.ts` / `windows/era.ts`: 100 years before the epoch, 1100 after. */
const PLAYLIST_BOUNDS_BEFORE = 100;
const PLAYLIST_BOUNDS_AFTER = 1100;

/** `+2.0 °C` / `−1.5 °C` — a temperature *delta*, so no +32 offset in imperial. */
function warmthText(v: number, units: Units): string {
  const f = format(v, "temperatureDelta", units, { signed: true });
  return `${f.text} ${f.unit}`;
}

/** `×1.25` — the unit *is* the multiplication sign (the mixer's own readout). */
function wetnessText(k: number, units: Units): string {
  const f = format(k, "factor", units);
  return `${f.unit}${f.text}`;
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

  const tempSection = root.createDiv({ cls: "wadjet-studio-forcings-section" });
  tempSection.createDiv({ cls: "wadjet-studio-forcings-head", text: "Temperature" });
  const stack = tempSection.createDiv({ cls: "wadjet-studio-forcings-stack" });

  const laneRow = stack.createDiv({
    cls: "wadjet-studio-forcings-row wadjet-studio-forcings-lane",
    attr: { role: "button", tabindex: "0", "aria-label": "Zoom the playlist to the warmth lane", "data-hint": forcingsHint("forcings.lane"), "data-part": "forcings-lane" },
  });
  laneRow.createSpan({ cls: "wadjet-studio-forcings-label", text: "∿ lane · FRC · warmth" });
  const laneValueEl = laneRow.createSpan({ cls: "wadjet-studio-forcings-value", attr: { "data-part": "forcings-lane-value" } });

  const trimRow = stack.createDiv({ cls: "wadjet-studio-forcings-row wadjet-studio-forcings-knobrow" });
  const trim: KnobComponent = createKnob(trimRow, {
    spec: TRIM_SPEC,
    value: 0,
    label: "＋ trim",
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

  const totalRow = stack.createDiv({ cls: "wadjet-studio-forcings-row wadjet-studio-forcings-total", attr: { "data-hint": forcingsHint("forcings.total") } });
  totalRow.createSpan({ cls: "wadjet-studio-forcings-label", text: "= total into TEMP" });
  const totalValueEl = totalRow.createSpan({ cls: "wadjet-studio-forcings-value", attr: { "data-part": "forcings-total" } });

  const precipSection = root.createDiv({ cls: "wadjet-studio-forcings-section" });
  precipSection.createDiv({ cls: "wadjet-studio-forcings-head", text: "Precipitation" });
  const wetRow = precipSection.createDiv({ cls: "wadjet-studio-forcings-row wadjet-studio-forcings-knobrow" });
  const wetness: KnobComponent = createKnob(wetRow, {
    spec: WETNESS_SPEC,
    value: 1,
    label: "wetness ×",
    color: "var(--wadjet-studio-precip)",
    hint: forcingsHint("forcings.wetness"),
    fmt: (k) => wetnessText(k, ctx.units()),
    onChange: (value, phase) => {
      editZone((z) => setWetness(z, value));
      if (phase !== "drag") ctx.store.snapshot();
    },
  });
  wetness.el.setAttr("data-part", "forcings-wetness");

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
    const bounds: ZoomBounds = { min: epoch - PLAYLIST_BOUNDS_BEFORE, max: epoch + PLAYLIST_BOUNDS_AFTER };
    const seasons = ctx.calendar()?.seasons ?? ctx.store.get().world.calendar.seasons;
    const next: Window = presetWindow("era", ctx.store.get().view.window, bounds, seasons);
    ctx.store.update((s) => {
      s.view.window = next;
    });
    ctx.view.app.workspace.requestSaveLayout();
  }

  laneRow.addEventListener("click", openLane);
  laneRow.addEventListener("keydown", (ev) => {
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

    laneValueEl.setText(warmthText(lane, u));
    totalValueEl.setText(warmthText(t + lane, u));
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

  /** The exact grammar this panel produces (SPEC law 5): two modifiers and one lane. */
  function writes(): string {
    const z = zone();
    if (z === null) return "modifiers[forcings:*] · automation[frc.warmth]";
    const parts: string[] = [];
    for (const id of [TRIM_ID, WETNESS_ID]) {
      const at = z.modifiers.findIndex((m) => m.id === id);
      if (at >= 0) parts.push(`modifiers[${at}] · ${JSON.stringify(z.modifiers[at])}`);
    }
    const lane = z.automation?.findIndex((l) => l.id === WARMTH_LANE_ID) ?? -1;
    if (lane >= 0) parts.push(`automation[${lane}] · ${JSON.stringify(z.automation?.[lane])}`);
    return parts.length === 0 ? "modifiers[forcings:*] · automation[frc.warmth] — neutral, nothing written" : parts.join("  ");
  }

  unsubscribe = ctx.store.subscribe(() => repaint(false));
  repaint(true);

  return {
    title: "Forcings",
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
