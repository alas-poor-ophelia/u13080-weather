/**
 * The generic device window (SPEC §3.4 "Generic device", §5).
 *
 * One declaration, four projections: this is the *window* projection. Every
 * zone modifier that is not a compiled layer (`layer:*` / `forcings:*`) opens
 * here, under the id `device:<modifierId>`, and everything the panel does to
 * the draft goes through one of the pure helpers in `model/device-edit.ts` —
 * so what this file owns is the DOM and the gestures, never the grammar.
 *
 * Four things worth knowing before editing it:
 *
 *  - **There is exactly one title row, and it is the chrome's** (SPEC §3.4).
 *    The panel hands `createWindow` its power LED (a live object it keeps
 *    mutating), the KIND badge in the kind's own hue, the `climate stage`
 *    caption, the preset control and an `onRename` that makes the name
 *    inline-editable. The body starts at WHEN. The LED trick is deliberate:
 *    `windows.ts` passes `built.led` straight through when no `level` getter is
 *    given, so the object this file holds *is* the one the chrome paints from,
 *    and every `writes` tick flushes a power change onto the lamp.
 *  - **The body is rebuilt, not patched.** A device is small; a signature of
 *    the compiled modifier plus the world state it draws from decides whether
 *    anything changed, so a tick that moved nothing touches no DOM. Rebuilds
 *    are suspended while a pointer gesture or a text input owns the panel,
 *    which is what lets a knob drag update the store every frame (`snapshot()`
 *    lands at pointer-up) without the knob being pulled out from under it.
 *  - **A rename is a new window.** The panel id carries the modifier id, so
 *    renaming closes this panel and opens the new one at the same position.
 *  - **The MOD section is the prototype's mod matrix.** A carrier row
 *    (`moon:Sable` × `∿ curve / ▦ phases` × season gate chips) writes
 *    `Modifier.mods[]`; the onset envelope editor under it writes
 *    `ModifierOp.envelope` (SPEC §7, §7a).
 */
import { Menu } from "obsidian";
import type { Era, ModifierOp } from "../../../core/types";
import type { DevicePreset } from "../../../plugin/settings";
import type { CalendarDescription } from "../../../plugin/time/adapter";
import { seasonAtPhase } from "../../../plugin/time/seasons";
import { type Channel, devices } from "../../model/compile";
import { displayName as prettyName, kindColor, opGloss, paramName } from "../../model/copy";
import {
  WHEN_KINDS,
  addGate,
  addOp,
  addYearWindow,
  defaultSpell,
  defaultWhenFor,
  deviceOf,
  loadPreset,
  newOpFor,
  paramsByChannel,
  removeDevice,
  removeGate,
  removeOp,
  removeYearWindow,
  renameDevice,
  saveAsPreset,
  setEnvelope,
  setGateAmount,
  setGateSource,
  setOpEnabled,
  setOpValue,
  setSpell,
  setWhen,
  setYearWindow,
  updateDevice,
} from "../../model/device-edit";
import {
  type Device,
  type DeviceKind,
  type WhenKind,
  ENVELOPE_SHAPES,
  SPELL_DURATION_RANGE,
  SPELL_STARTS_RANGE,
  deviceGrammar,
  envelopeShape,
  envelopeShapeName,
  gatePercent,
  knobRangeOf,
  knobSpecFor,
  moonRange,
  opValueText,
  phasesFor,
  whenSummary,
  yearWindowsOf,
} from "../../model/devices";
import { dayRangeLabel } from "../../model/format";
import { deviceHint } from "../../model/hints-device";
import { opQuantity, parseDisplay } from "../../model/knob-units";
import { BAND_TINT_ALPHA, SEASON_CYCLE, cycleColour, tintColour } from "../../model/palette";
import { SHIPPED_PRESETS } from "../../model/presets";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createChart, createChip, createKnob, createLed, createSegmented } from "../components";
import type { LedProps } from "../components/led";
import { beginDrag } from "../pointer";
import { PresetNameModal } from "../preset-name-modal";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuilder } from "../windows";
import { openCycleFor } from "./cycle";

/** Panel ids are `device:<modifierId>`; the mixer opens one from a unit's name (SPEC law 2). */
export const DEVICE_WINDOW_PREFIX = "device:";

export function deviceWindowId(modifierId: string): string {
  return `${DEVICE_WINDOW_PREFIX}${modifierId}`;
}

/** Year length to draw with when the active adapter does not describe itself (SPEC §8). */
const DEFAULT_YEAR_LENGTH = 365;

/** Prototype width (`proto-markup/1095-vst-device.html`): a design constant, not a function of the content. */
const PANEL_W = 372;

/** The year-window mini-lane, in SVG user units; the element is stretched to the panel by CSS. */
const LANE_W = 240;
const LANE_H = 10;

/** The moon gate disc (`proto-markup/0699-vst-stormtide.html`): an 88-unit box, a 34-unit face. */
const DISC = 88;
const DISC_C = 44;
const DISC_R = 34;
const DISC_FACE_R = 30;
const HANDLE_R = 6;

/** The envelope chart, in CSS pixels. */
const ENVELOPE_W = 316;
const ENVELOPE_H = 84;

/** A spell longer than this earns an amber readout (SPEC §3.9). */
const LONG_SPELL_DAYS = 50;

/** Envelope points keep this much phase between them, so a drag can never reorder them under itself. */
const ENVELOPE_MIN_GAP = 0.005;
/** Phases are in [0, 1): the last drawable phase sits just short of the wrap. */
const LAST_PHASE = 1 - ENVELOPE_MIN_GAP;

/** The KIND pill's text, per kind (the prototype's `DEV_KINDS.badge`). */
const KIND_BADGE: Record<DeviceKind, string> = {
  trim: "TRIM",
  moon: "MOON",
  spell: "SPELL",
  tag: "TAG",
  chance: "DICE",
};

const CHANNEL_COLOUR: Record<Channel, string> = {
  temperature: "var(--wadjet-studio-temp)",
  precipitation: "var(--wadjet-studio-precip)",
  wind: "var(--wadjet-studio-wind)",
  sky: "var(--wadjet-studio-sky)",
};

const CHANNEL_LABEL: Record<Channel, string> = {
  temperature: "Temperature",
  precipitation: "Precipitation",
  wind: "Wind",
  sky: "Sky",
};

function colourOf(param: string): string {
  const root = param.split(".")[0] ?? "";
  if (root === "temperature") return CHANNEL_COLOUR.temperature;
  if (root === "precipitation") return CHANNEL_COLOUR.precipitation;
  if (root === "wind") return CHANNEL_COLOUR.wind;
  return CHANNEL_COLOUR.sky;
}

/** The `season:*` / `era:*` tags this world offers, in calendar then timeline order. */
function tagSources(seasons: ReadonlyArray<{ name: string }>, eras: readonly Era[]): string[] {
  return [...seasons.map((s) => `season:${s.name}`), ...eras.map((e) => `era:${e.name}`)];
}

/**
 * A tag's own hue: a season takes its band colour, an era takes calendar gold.
 * A season walks `SEASON_CYCLE`, not `DATA_CYCLE` — the same list the Seasons
 * window and the calendar ruler use, so Thaw is green in all three.
 */
function tagColour(tag: string, seasons: ReadonlyArray<{ name: string }>): string {
  const at = seasons.findIndex((s) => `season:${s.name}` === tag);
  return at >= 0 ? cycleColour(at, SEASON_CYCLE) : "var(--wadjet-studio-gold)";
}

/** `[a, b)` in year phase, split at the wrap so a window across new year draws as two clips. */
function windowSpans(start: number, length: number): Array<[number, number]> {
  const a = ((start % 1) + 1) % 1;
  const span = Math.min(1, Math.max(0, length));
  if (span === 0) return [];
  if (a + span <= 1) return [[a, a + span]];
  return [
    [a, 1],
    [0, a + span - 1],
  ];
}

/** Season bands as `[from, to)` in year phase; an empty calendar draws one neutral band. */
function seasonBands(seasons: ReadonlyArray<{ name: string; from: number }>): Array<{ from: number; to: number; name: string; index: number }> {
  if (seasons.length === 0) return [{ from: 0, to: 1, name: "", index: 0 }];
  const sorted = [...seasons].map((s, i) => ({ ...s, index: i })).sort((a, b) => a.from - b.from);
  return sorted.map((s, i) => ({ from: s.from, to: sorted[(i + 1) % sorted.length]!.from + (i === sorted.length - 1 ? 1 : 0), name: s.name, index: s.index }));
}

/**
 * The lit face of a moon at `phase` (0 new, 0.5 full) — the prototype's
 * `moonPath`: a half-disc plus a terminator ellipse whose x-radius is how far
 * from full the phase sits.
 */
function moonPath(phase: number, cx: number, cy: number, r: number): string {
  const f = Math.max(0.02, Math.min(1, phase));
  const rx = Math.abs(r * (1 - 2 * f));
  const sweep = f < 0.5 ? 0 : 1;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 1 ${sweep} ${cx} ${cy - r}`;
}

/** A point on the gate ring: phase 0 at the top, running clockwise. */
function ringPoint(phase: number): { x: number; y: number } {
  const a = phase * 2 * Math.PI;
  return { x: DISC_C + DISC_R * Math.sin(a), y: DISC_C - DISC_R * Math.cos(a) };
}

/** How much of the cycle `[a, b)` covers — a full circle when the ends meet. */
function ringSpan(a: number, b: number): number {
  const d = (((b - a) % 1) + 1) % 1;
  return d === 0 ? 1 : d;
}

/** The gate arc from `a` clockwise to `b`; a full circle stops a hair short so it still draws. */
function ringArc(a: number, b: number): string {
  const span = Math.min(0.999, ringSpan(a, b));
  const from = ringPoint(a);
  const to = ringPoint(a + span);
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${DISC_R} ${DISC_R} 0 ${span > 0.5 ? 1 : 0} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

/** A chrome button that is not in the component bin — the same status as the window's × (SPEC law 3). */
function iconButton(parent: HTMLElement, o: { text: string; label: string; hint: string; cls: string; onClick: (ev: MouseEvent) => void }): HTMLElement {
  const el = parent.createDiv({ cls: o.cls, text: o.text, attr: { role: "button", tabindex: "0", "aria-label": o.label, "data-hint": o.hint } });
  el.addEventListener("click", (ev) => o.onClick(ev));
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    o.onClick(new MouseEvent("click", { clientX: el.getBoundingClientRect().left, clientY: el.getBoundingClientRect().bottom }));
  });
  return el;
}

interface Part {
  destroy(): void;
}

/**
 * The builder for one device panel. Each call returns a fresh `WindowBuild`
 * with its own store subscription, dropped in `onClose`.
 */
export function buildDeviceWindow(modifierId: string): WindowBuilder {
  return (ctx: SurfaceContext) => {
    const body = createDiv({ cls: "wadjet-studio-device" });
    let parts: Part[] = [];
    let unsubscribe: (() => void) | null = null;
    /** Set while a pointer gesture owns the DOM; a rebuild now would drop the knob mid-drag. */
    let live = false;
    let endLive: (() => void) | null = null;
    let cancelDrag: (() => void) | null = null;
    /** `＋ mod` opens the MOD section on a device that has neither a gate nor an envelope yet. */
    let modOpen = false;
    /** Which year-window clip the start/length knobs edit (`＋ add window` can make several). */
    let clipAt = 0;
    let signature = "";
    let issuesKey = "";
    let issuesMemo: StudioIssue[] = [];

    // --- reading the draft --------------------------------------------------

    const zoneOf = (s: StudioState) => (s.view.zoneId === null ? null : (s.zones[s.view.zoneId] ?? null));
    /**
     * The calendar the window edits against. An editable calendar's seasons and
     * moons are *draft* state (the Seasons and CYCLE windows write them), so the
     * adapter's description — built from what is on disk — would leave this
     * panel a save behind: a season renamed a moment ago would still offer its
     * old tag. A read-only calendar is not the studio's to edit, so there the
     * adapter's own description is the subject (SPEC §3.4 source badge).
     */
    function calendar(): CalendarDescription | null {
      const description = ctx.calendar();
      if (description === null || description.readOnly) return description;
      const world = ctx.store.get().world.calendar;
      return { ...description, seasons: world.seasons, moons: world.moons };
    }

    function current(): Device | null {
      const zone = zoneOf(ctx.store.get());
      return zone === null ? null : deviceOf(zone, modifierId, calendar());
    }

    /** The device's slot in the chain — the signal-path position the WRITES grammar names. */
    function slot(): number {
      const zone = zoneOf(ctx.store.get());
      return zone === null ? 0 : Math.max(0, zone.modifiers.findIndex((m) => m.id === modifierId));
    }

    function otherIds(): string[] {
      const zone = zoneOf(ctx.store.get());
      return zone === null ? [] : zone.modifiers.filter((m) => m.id !== modifierId).map((m) => m.id);
    }

    function writes(): string {
      const d = current();
      return d === null ? "—" : deviceGrammar(d, slot());
    }

    function issues(): StudioIssue[] {
      const state = ctx.store.get();
      const zone = zoneOf(state);
      if (zone === null) return [];
      const description = calendar();
      const readOnlyCalendar = description?.readOnly ?? false;
      const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
      const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
      const key = `${JSON.stringify(zone.modifiers)}|${JSON.stringify(state.world.eras)}|${JSON.stringify(seasons)}|${JSON.stringify(moons)}`;
      if (key === issuesKey) return issuesMemo;
      const mine = unitKey({ kind: "device", id: modifierId });
      issuesKey = key;
      issuesMemo = issuesFor({ zone, eras: state.world.eras, seasons, moons, readOnlyCalendar }).filter((i) => unitKey(i.unit) === mine);
      return issuesMemo;
    }

    // --- writing the draft --------------------------------------------------

    /** One device edit. Discrete actions are undoable; knob frames are not (they `snapshot()` at the end). */
    function mutate(fn: (d: Device) => void, history: boolean): void {
      ctx.store.update(
        (s) => {
          const zone = zoneOf(s);
          if (zone !== null) updateDevice(zone, modifierId, fn, calendar());
        },
        { history },
      );
    }

    /**
     * Hold rebuilds for the length of a gesture. The knob only reports `"end"`
     * when the pointer actually moved past the drag threshold, so the release
     * is watched at the window level too — otherwise a 1 px nudge would leave
     * the panel frozen.
     */
    function beginLive(): void {
      if (live) return;
      live = true;
      const done = (): void => {
        window.removeEventListener("pointerup", done);
        window.removeEventListener("pointercancel", done);
        endLive = null;
        live = false;
        render();
      };
      endLive = done;
      window.addEventListener("pointerup", done);
      window.addEventListener("pointercancel", done);
    }

    /** A knob or chart handle moved: update every frame, commit one undo step at the end (SPEC §3.8). */
    function gesture(phase: "drag" | "end" | "key" | "type", fn: (d: Device) => void): void {
      if (phase === "drag") {
        beginLive();
        mutate(fn, false);
        return;
      }
      live = false;
      mutate(fn, false);
      ctx.store.snapshot();
    }

    // --- rebuild scheduling -------------------------------------------------

    function clearParts(): void {
      for (const p of parts) p.destroy();
      parts = [];
    }

    /** True while a text field inside the panel has focus — rebuilding would steal the caret. */
    function typing(): boolean {
      const active = body.ownerDocument.activeElement;
      return active instanceof HTMLInputElement && body.contains(active);
    }

    /** Everything the body draws from. Unchanged signature, untouched DOM. */
    function stateKey(): string {
      const state = ctx.store.get();
      const zone = zoneOf(state);
      const description = calendar();
      return JSON.stringify([
        zone?.modifiers.find((m) => m.id === modifierId) ?? null,
        state.world.calendar.seasons,
        state.world.calendar.moons,
        state.world.eras.map((e) => e.name),
        state.world.devicePresets.map((p) => [p.name, p.kind]),
        description?.readOnly === true ? description.moons : null,
        description?.yearLength ?? null,
        modOpen,
        clipAt,
        ctx.units(),
      ]);
    }

    function render(): void {
      if (live || typing()) return;
      const key = stateKey();
      if (key === signature) return;
      signature = key;
      build();
    }

    /** Force the next `render()` to rebuild, whatever the signature says. */
    function invalidate(): void {
      signature = "";
      render();
    }

    // --- sections -----------------------------------------------------------

    interface Section {
      head: HTMLElement;
      content: HTMLElement;
    }

    /** `APPLY · while active` — the caption and the qualifier that teaches what it means (SPEC §9). */
    function section(name: string, hintKey: string, o?: { qualifier?: string; summary?: string }): Section {
      const root = body.createDiv({ cls: "wadjet-studio-device-section", attr: { "data-section": name.toLowerCase() } });
      const head = root.createDiv({ cls: "wadjet-studio-device-head", attr: { "data-hint": deviceHint(hintKey) } });
      head.createSpan({ cls: "wadjet-studio-device-head-label", text: o?.qualifier === undefined ? name : `${name} · ${o.qualifier}` });
      if (o?.summary !== undefined) head.createSpan({ cls: "wadjet-studio-device-head-summary", text: o.summary });
      return { head, content: root.createDiv({ cls: "wadjet-studio-device-body" }) };
    }

    function knob(parent: HTMLElement, o: { part: string; label: string; min: number; max: number; step: number; neutral?: number; value: number; fmt: (v: number) => string; parse?: (text: string) => number | null; hint: string; color?: string; size?: "sm" | "md" | "lg"; disabled?: boolean; onChange: (v: number, phase: "drag" | "end" | "key" | "type") => void }): HTMLElement {
      const component = createKnob(parent, {
        spec: { min: o.min, max: o.max, step: o.step, ...(o.neutral !== undefined ? { neutral: o.neutral } : {}) },
        value: o.value,
        label: o.label,
        fmt: o.fmt,
        ...(o.parse !== undefined ? { parse: o.parse } : {}),
        hint: o.hint,
        ...(o.color !== undefined ? { color: o.color } : {}),
        ...(o.size !== undefined ? { size: o.size } : {}),
        ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
        onChange: o.onChange,
      });
      component.el.setAttr("data-part", o.part);
      parts.push(component);
      return component.el;
    }

    // --- title row (the chrome's; SPEC §3.4) --------------------------------

    /**
     * The chrome's power lamp. `windows.ts` hands this very object to
     * `createWindow` (no `level` getter is returned, so nothing copies it), and
     * the chrome repaints it whenever `writes` or the issue line changes — so
     * mutating it here is what keeps the lamp honest.
     */
    const chromeLed: LedProps = {
      on: current()?.enabled !== false,
      scope: "device",
      hint: deviceHint("device.power"),
      onToggle: (on) => {
        chromeLed.on = on;
        mutate((x) => void (x.enabled = on), true);
      },
    };

    /**
     * A rename is an id change, and the panel is keyed on the id: carry the
     * remembered position across, then swap the panel for the new one.
     */
    function rename(next: string): void {
      const name = next.trim();
      if (!name) return;
      let renamed = modifierId;
      ctx.store.update(
        (s) => {
          const zone = zoneOf(s);
          if (zone !== null) renamed = renameDevice(zone, modifierId, name);
        },
        { history: true },
      );
      if (renamed === modifierId) {
        invalidate();
        return;
      }
      ctx.store.update((s) => {
        const pos = s.view.windowPos[deviceWindowId(modifierId)];
        if (pos !== undefined) s.view.windowPos[deviceWindowId(renamed)] = { ...pos };
      });
      ctx.windows.close(deviceWindowId(modifierId));
      ctx.windows.open(deviceWindowId(renamed), buildDeviceWindow(renamed));
    }

    /** Every preset the world offers, shipped first, the user's marked as theirs. */
    function presetsOffered(): Array<{ preset: DevicePreset; yours: boolean }> {
      const mine = ctx.store.get().world.devicePresets;
      return [...SHIPPED_PRESETS.map((preset) => ({ preset, yours: false })), ...mine.map((preset) => ({ preset, yours: true }))];
    }

    /** The label the preset control shows for a preset — `Volcanic · yours`. */
    const presetLabel = (p: { preset: DevicePreset; yours: boolean }): string => (p.yours ? `${p.preset.name} · yours` : p.preset.name);

    /** The placeholder the `preset ▾` control wears until one is loaded (the prototype's `no preset`). */
    const NO_PRESET = "no preset";

    // --- WHEN ---------------------------------------------------------------

    function buildWhen(d: Device): void {
      const description = calendar();
      const yearLength = description?.yearLength ?? DEFAULT_YEAR_LENGTH;
      const sec = section("WHEN", "device.when", { summary: whenSummary(d, yearLength) });

      if (d.custom === true) {
        parts.push(createChip(sec.content, { label: "custom", color: "var(--wadjet-studio-warn)", hint: deviceHint("device.when") }));
        sec.content.createSpan({ cls: "wadjet-studio-device-raw", text: JSON.stringify(d.raw?.when ?? null) });
        return;
      }

      const segmented = createSegmented(sec.head, {
        options: WHEN_KINDS.map((k) => ({ value: k.when, label: k.label, hint: deviceHint("device.when") })),
        value: d.when.kind,
        onChange: (value) => mutate((x) => setWhen(x, defaultWhenFor(value as WhenKind, calendar())), true),
      });
      segmented.el.setAttr("data-part", "when-kind");
      parts.push(segmented);

      const kindBody = sec.content.createDiv({ cls: "wadjet-studio-device-when" });
      const w = d.when;
      if (w.kind === "always") kindBody.createDiv({ cls: "wadjet-studio-device-note", text: "no predicate → applied once to the curves, not per day" });
      else if (w.kind === "moon") buildMoon(kindBody, w.moon, w.phases, w.range, description);
      else if (w.kind === "tag") buildTag(kindBody, w.tags, description);
      else if (w.kind === "yearWindow") buildYearWindow(kindBody, d, description, yearLength);
      else if (w.kind === "chance") buildChance(kindBody, w.p);
    }

    function buildMoon(parent: HTMLElement, name: string, selected: string[], range: [number, number], description: CalendarDescription | null): void {
      const moons = description?.moons ?? [];
      const named = moons.find((m) => m.name === name)?.phases ?? [];
      const row = parent.createDiv({ cls: "wadjet-studio-device-chips" });
      parts.push(
        createChip(row, {
          label: `moon:${name}`,
          color: "var(--wadjet-studio-moon)",
          hint: deviceHint("device.when.moon"),
          onClick: () => openCycleFor(ctx, name),
        }),
      );
      row.createSpan({ cls: "wadjet-studio-device-times", text: "×" });

      for (const phase of named) {
        const on = selected.includes(phase.name);
        const chip = createChip(row, {
          label: phase.name,
          ...(on ? { color: "var(--wadjet-studio-moon)" } : {}),
          dot: false,
          hint: deviceHint("device.when.phase"),
          onClick: () => togglePhase(named, phase.name),
        });
        chip.el.toggleClass("is-selected", on);
        chip.el.setAttrs({ "data-phase": phase.name, "aria-pressed": on ? "true" : "false" });
        parts.push(chip);
      }
      // The ends do not sit on boundaries (or the moon has no named phases):
      // the window is a hand-written arc, and says so rather than lying.
      if (selected.length === 0) parts.push(createChip(row, { label: "custom range", dot: false, hint: deviceHint("device.when.phase") }));

      if (moons.length > 1) {
        const picker = createSegmented(parent, {
          options: moons.map((m) => ({ value: m.name, label: m.name, hint: deviceHint("device.when.moonPick") })),
          value: name,
          onChange: (next) =>
            mutate((x) => {
              if (x.when.kind !== "moon") return;
              const target = moons.find((m) => m.name === next)?.phases ?? [];
              const keep = x.when.phases.filter((p) => target.some((q) => q.name === p));
              const to = keep.length > 0 ? moonRange(target, keep) : ([x.when.range[0], x.when.range[1]] as [number, number]);
              setWhen(x, { kind: "moon", moon: next, phases: phasesFor(target, to), range: to });
            }, true),
        });
        picker.el.setAttr("data-part", "when-moon");
        parts.push(picker);
      }

      buildGateDisc(parent, range, name);
    }

    /**
     * The signature control of a moon-bound device (`proto-win-stormtide.png`):
     * the lit face at the middle of the gate, the gate arc round the rim, and a
     * handle on each end. Dragging a handle writes `when.moon.phase` — which is
     * the compiled `[a, b)` the engine reads, so the phase chips follow it back.
     */
    function buildGateDisc(parent: HTMLElement, range: [number, number], moonName: string): void {
      const box = parent.createDiv({ cls: "wadjet-studio-device-gate-disc", attr: { "data-hint": deviceHint("device.when.gate") } });
      const svg = box.createSvg("svg", { attr: { viewBox: `0 0 ${DISC} ${DISC}`, role: "img", "aria-label": `Moon gate ${range[0].toFixed(2)} to ${range[1].toFixed(2)}` } });
      // The face is the prototype's door to the moon's CYCLE editor
      // (`data-vst="sablemoon"` on the circle and the lit path); the handles
      // keep their drag and never open anything.
      svg.addEventListener("click", (ev: MouseEvent) => {
        if ((ev.target as Element | null)?.closest("[data-gate]") !== null) return;
        openCycleFor(ctx, moonName);
      });
      svg.createSvg("circle", { cls: "wadjet-studio-device-disc-face", attr: { cx: DISC_C, cy: DISC_C, r: DISC_R } });
      const mid = range[0] + ringSpan(range[0], range[1]) / 2;
      svg.createSvg("path", { cls: "wadjet-studio-device-disc-moon", attr: { d: moonPath(((mid % 1) + 1) % 1, DISC_C, DISC_C, DISC_FACE_R) } });
      svg.createSvg("path", { cls: "wadjet-studio-device-disc-arc", attr: { d: ringArc(range[0], range[1]) } });

      ([0, 1] as const).forEach((end) => {
        const at = ringPoint(range[end]);
        const handle = svg.createSvg("circle", {
          cls: "wadjet-studio-device-disc-handle",
          attr: { cx: at.x.toFixed(2), cy: at.y.toFixed(2), r: HANDLE_R, "data-gate": String(end), tabindex: "0", role: "slider", "aria-label": end === 0 ? "Gate start" : "Gate end", "aria-valuenow": range[end].toFixed(2) },
        });
        handle.addEventListener("pointerdown", (ev: PointerEvent) => startGateDrag(ev, svg, handle, end));
      });

      box.createSpan({ cls: "wadjet-studio-device-disc-readout", text: `gate ${range[0].toFixed(2)}–${range[1].toFixed(2)}` });
    }

    function startGateDrag(ev: PointerEvent, svg: SVGElement, node: SVGElement, end: 0 | 1): void {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginLive();
      const phaseAt = (move: MouseEvent): number => {
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0) return 0;
        const x = ((move.clientX - rect.left) / rect.width) * DISC - DISC_C;
        const y = ((move.clientY - rect.top) / rect.height) * DISC - DISC_C;
        const deg = (Math.atan2(x, -y) * 180) / Math.PI;
        return ((deg / 360) % 1 + 1) % 1;
      };
      cancelDrag = beginDrag(ev, {
        capture: node,
        onMove: (move) => setGate(end, phaseAt(move), false),
        onEnd: (_end, _dx, _dy, moved) => {
          cancelDrag = null;
          if (moved) {
            live = false;
            ctx.store.snapshot();
          }
        },
      });
    }

    function setGate(end: 0 | 1, phase: number, history: boolean): void {
      const moons = calendar()?.moons ?? [];
      mutate((x) => {
        if (x.when.kind !== "moon") return;
        const named = moons.find((m) => m.name === (x.when as { moon: string }).moon)?.phases ?? [];
        const next: [number, number] = end === 0 ? [phase, x.when.range[1]] : [x.when.range[0], phase];
        setWhen(x, { kind: "moon", moon: x.when.moon, phases: phasesFor(named, next), range: next });
      }, history);
    }

    function togglePhase(named: ReadonlyArray<{ name: string; at: number }>, name: string): void {
      mutate((x) => {
        if (x.when.kind !== "moon") return;
        const chosen = new Set(x.when.phases);
        if (chosen.has(name)) chosen.delete(name);
        else chosen.add(name);
        const range = moonRange(
          named,
          named.filter((p) => chosen.has(p.name)).map((p) => p.name),
        );
        setWhen(x, { kind: "moon", moon: x.when.moon, phases: phasesFor(named, range), range });
      }, true);
    }

    /**
     * The selected tags only, each removable, plus a `＋` that offers the rest
     * in a menu — the prototype's compact picker, not an inline list of every
     * tag the world has ever heard of.
     */
    function buildTag(parent: HTMLElement, tags: string[], description: CalendarDescription | null): void {
      const seasons = description?.seasons ?? [];
      const chips = parent.createDiv({ cls: "wadjet-studio-device-chips" });
      for (const tag of tags) {
        const chip = createChip(chips, {
          label: tag,
          color: tagColour(tag, seasons),
          icon: "⚑",
          hint: deviceHint("device.when.tag"),
          ...(tags.length > 1 ? { onClick: () => toggleTag(tag) } : {}),
        });
        chip.el.addClass("is-selected");
        chip.el.setAttrs({ "data-tag": tag, "aria-pressed": "true" });
        parts.push(chip);
      }
      iconButton(chips, {
        text: "＋",
        label: "Add a tag",
        hint: deviceHint("device.when.tagAdd"),
        cls: "wadjet-studio-device-add",
        onClick: (ev) => {
          const menu = new Menu();
          const offered = tagSources(seasons, ctx.store.get().world.eras).filter((t) => !tags.includes(t));
          for (const tag of offered) menu.addItem((item) => item.setTitle(tag).onClick(() => toggleTag(tag, true)));
          if (offered.length === 0) menu.addItem((item) => item.setTitle("No other seasons or eras").setDisabled(true));
          menu.showAtMouseEvent(ev);
        },
      });
    }

    /** Toggling the *last* tag off is refused: `{ any: [] }` matches nothing and the validator rejects it. */
    function toggleTag(tag: string, addOnly = false): void {
      mutate((x) => {
        if (x.when.kind !== "tag") return;
        const has = x.when.tags.includes(tag);
        if (has && addOnly) return;
        const next = has ? x.when.tags.filter((t) => t !== tag) : [...x.when.tags, tag];
        if (next.length === 0) return;
        setWhen(x, { kind: "tag", tags: next });
      }, true);
    }

    // --- WHEN · year window -------------------------------------------------

    function buildYearWindow(parent: HTMLElement, d: Device, description: CalendarDescription | null, yearLength: number): void {
      const seasons = description?.seasons ?? [];
      const clips = yearWindowsOf(d.when);
      const at = Math.min(clipAt, clips.length - 1);
      const chosen = clips[at] ?? { start: 0, length: 0 };

      parent.createDiv({ cls: "wadjet-studio-device-subhead", text: "WINDOWS · repeat yearly" });

      const top = parent.createDiv({ cls: "wadjet-studio-device-lane-row" });
      const lane = top.createDiv({ cls: "wadjet-studio-device-lane", attr: { "data-hint": deviceHint("device.when.lane") } });
      const stripe = lane.createDiv({ cls: "wadjet-studio-device-lane-stripe" });
      for (const band of seasonBands(seasons)) {
        const seg = stripe.createDiv({ cls: "wadjet-studio-device-band", attr: { "data-name": band.name } });
        seg.setCssProps({
          "--wadjet-studio-device-band-w": `${((band.to - band.from) * 100).toFixed(2)}%`,
          // The season's OWN hue (`SEASON_CYCLE`, so Thaw is green), composited
          // at the prototype's `tc + "55"` third rather than laid on at full
          // strength; the tint carries the whole alpha, the stylesheet adds none.
          "--wadjet-studio-device-band-color": tintColour(band.index, BAND_TINT_ALPHA, SEASON_CYCLE),
        });
      }
      const track = lane.createDiv({ cls: "wadjet-studio-device-track" });
      const svg = track.createSvg("svg", { cls: "wadjet-studio-device-lane-svg", attr: { viewBox: `0 0 ${LANE_W} ${LANE_H}`, preserveAspectRatio: "none" } });
      clips.forEach((clip, i) => {
        for (const [a, b] of windowSpans(clip.start, clip.length)) {
          svg.createSvg("rect", { cls: "wadjet-studio-device-clip", attr: { x: (a * LANE_W).toFixed(2), y: 0, width: ((b - a) * LANE_W).toFixed(2), height: LANE_H, "data-clip": String(i), "data-selected": i === at ? "true" : "false" } });
        }
      });

      const knobs = top.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(knobs, {
        part: "when-start",
        label: "start",
        min: 0,
        max: 1,
        step: 1 / yearLength,
        value: chosen.start,
        fmt: (v) => `d${Math.round(v * yearLength)} · ${seasonAtPhase(seasons, ((v % 1) + 1) % 1) ?? "—"}`,
        color: "var(--wadjet-studio-gold)",
        hint: deviceHint("device.when.start"),
        onChange: (v, phase) => gesture(phase, (x) => setYearWindow(x, at, { start: v, length: yearWindowsOf(x.when)[at]?.length ?? chosen.length })),
      });
      knob(knobs, {
        part: "when-length",
        label: "length",
        min: 1 / yearLength,
        max: 0.6,
        step: 1 / yearLength,
        value: chosen.length,
        fmt: (v) => `${Math.round(v * yearLength)} d`,
        color: "var(--wadjet-studio-gold)",
        hint: deviceHint("device.when.length"),
        onChange: (v, phase) => gesture(phase, (x) => setYearWindow(x, at, { start: yearWindowsOf(x.when)[at]?.start ?? chosen.start, length: v })),
      });

      const rows = parent.createDiv({ cls: "wadjet-studio-device-clips" });
      clips.forEach((clip, i) => {
        const season = seasonAtPhase(seasons, (((clip.start + clip.length / 2) % 1) + 1) % 1);
        const row = rows.createDiv({ cls: "wadjet-studio-device-clip-row", attr: { "data-clip": String(i), "data-selected": i === at ? "true" : "false", "data-hint": deviceHint("device.when.lane") } });
        row.createDiv({ cls: "wadjet-studio-device-clip-swatch" });
        row.createSpan({ cls: "wadjet-studio-device-clip-label", text: dayRangeLabel(clip.start, clip.length, yearLength) });
        row.createSpan({ cls: "wadjet-studio-device-clip-dur", text: `${Math.round(clip.length * yearLength)} d${season === null ? "" : ` · ${season}`}` });
        row.createDiv({ cls: "wadjet-studio-device-spacer" });
        row.addEventListener("click", () => {
          if (clipAt === i) return;
          clipAt = i;
          invalidate();
        });
        if (clips.length > 1) {
          iconButton(row, {
            text: "×",
            label: `Remove window ${i + 1}`,
            hint: deviceHint("device.when.window.remove"),
            cls: "wadjet-studio-device-remove",
            onClick: () => {
              clipAt = 0;
              mutate((x) => void removeYearWindow(x, i), true);
            },
          });
        }
      });
      iconButton(rows, {
        text: "＋ add window",
        label: "Add a window",
        hint: deviceHint("device.when.window.add"),
        cls: "wadjet-studio-device-wide",
        onClick: () => mutate((x) => void addYearWindow(x), true),
      });
    }

    function buildChance(parent: HTMLElement, p: number): void {
      const row = parent.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(row, {
        part: "when-chance",
        label: "chance",
        min: 0,
        max: 1,
        step: 0.01,
        value: p,
        fmt: (v) => `${(v * 100).toFixed(0)} %`,
        color: "var(--wadjet-studio-wind)",
        hint: deviceHint("device.when.chance"),
        onChange: (v, phase) =>
          gesture(phase, (x) => {
            if (x.when.kind === "chance") setWhen(x, { kind: "chance", p: v });
          }),
      });
      row.createSpan({ cls: "wadjet-studio-device-note", text: "seeded · the same days every roll" });
    }

    // --- SPELL --------------------------------------------------------------

    function buildSpell(d: Device): void {
      const spell = d.spell;
      const sec = section("SPELL", "device.spell");
      const toggle = iconButton(sec.head, {
        text: spell === undefined ? "off · every matching day" : "on · random runs",
        label: "Spell",
        hint: deviceHint("device.spell"),
        cls: "wadjet-studio-device-toggle",
        onClick: () => mutate((x) => setSpell(x, spell === undefined ? defaultSpell(calendar()) : undefined), true),
      });
      toggle.setAttrs({ "data-part": "spell-power", "aria-pressed": spell === undefined ? "false" : "true" });
      if (spell === undefined) {
        sec.content.remove();
        return;
      }

      const knobs = sec.content.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(knobs, {
        part: "spell-starts",
        label: "starts / yr",
        ...SPELL_STARTS_RANGE,
        value: spell.meanStartsPerYear,
        fmt: (v) => String(Number(v.toFixed(2))),
        color: "var(--wadjet-studio-gold)",
        hint: deviceHint("device.spell.starts"),
        onChange: (v, phase) => gesture(phase, (x) => setSpell(x, { meanStartsPerYear: v, meanDurationDays: x.spell?.meanDurationDays ?? spell.meanDurationDays })),
      });
      knob(knobs, {
        part: "spell-duration",
        label: "duration",
        ...SPELL_DURATION_RANGE,
        value: spell.meanDurationDays,
        fmt: (v) => `${v.toFixed(0)} d`,
        color: spell.meanDurationDays > LONG_SPELL_DAYS ? "var(--wadjet-studio-warn)" : "var(--wadjet-studio-temp)",
        hint: deviceHint("device.spell.duration", spell.meanDurationDays > LONG_SPELL_DAYS ? `${spell.meanDurationDays.toFixed(0)} days is longer than a season` : undefined),
        onChange: (v, phase) => gesture(phase, (x) => setSpell(x, { meanStartsPerYear: x.spell?.meanStartsPerYear ?? spell.meanStartsPerYear, meanDurationDays: v })),
      });
    }

    // --- APPLY --------------------------------------------------------------

    function buildApply(d: Device): void {
      const sec = section("APPLY", "device.op", { qualifier: d.spell === undefined ? "while active" : "while running" });
      const grid = sec.content.createDiv({ cls: "wadjet-studio-device-apply" });

      d.apply.forEach((op, i) => {
        const cell = grid.createDiv({ cls: "wadjet-studio-device-apply-cell", attr: { "data-param": op.param, "data-hint": deviceHint("device.op", opGloss(op)) } });
        iconButton(cell, {
          text: "×",
          label: `Remove ${op.param}`,
          hint: deviceHint("device.op.remove"),
          cls: "wadjet-studio-device-remove",
          onClick: () => mutate((x) => removeOp(x, i), true),
        });
        buildOpControl(cell, op, i);
        cell.createSpan({ cls: "wadjet-studio-device-apply-field", text: opGloss(op) });
      });

      const add = grid.createDiv({ cls: "wadjet-studio-device-apply-cell" });
      iconButton(add, {
        text: "＋",
        label: "Add an op",
        hint: deviceHint("device.op.add"),
        cls: "wadjet-studio-device-add-apply",
        onClick: (ev) => openOpMenu(ev, d),
      });
      add.createSpan({ cls: "wadjet-studio-device-apply-addlabel", text: "apply" });
    }

    /** A knob per op, except the two shapes a knob cannot express: `clamp`, and a `set` that installs a whole curve. */
    function buildOpControl(cell: HTMLElement, op: ModifierOp, i: number): void {
      if (op.op === "clamp" || typeof op.value !== "number") {
        cell.createSpan({ cls: "wadjet-studio-device-raw", text: `${paramName(op.param)} ${op.op}` });
        return;
      }
      const spec = knobSpecFor(op, "device");
      const range = knobRangeOf(spec);
      const isOffset = op.op === "offset";
      const q = opQuantity(op.param, isOffset);
      const el = knob(cell, {
        part: `op-${i}`,
        label: paramName(op.param),
        min: spec.min,
        max: spec.max,
        step: spec.step,
        // Omitted, not zero, where the prototype suppresses the detent — the
        // arc then runs from the track minimum (`neutralFor` in `devices.ts`).
        ...(spec.neutral !== undefined ? { neutral: spec.neutral } : {}),
        value: op.value,
        size: "lg",
        // The knob's own readout is the prototype's `0 — no rain`: the value in
        // the channel's colour, with the consequence spelled out after it.
        fmt: (v) => opValueText({ ...op, value: v }, ctx.units()),
        color: colourOf(op.param),
        hint: deviceHint("device.op", opGloss(op)),
        disabled: op.enabled === false,
        ...(q !== null ? { parse: (text: string) => parseDisplay(range, q, ctx.units())(text) } : {}),
        onChange: (v, phase) => gesture(phase, (x) => setOpValue(x, i, v)),
      });

      // The per-op mute sits *inside* the knob's own label, so the cell reads
      // `● precip` on one line the way the prototype's does.
      const label = el.querySelector<HTMLElement>(".wadjet-studio-knob-label");
      if (label === null) return;
      const led = createLed(label, {
        on: op.enabled !== false,
        scope: "op",
        hint: deviceHint("device.op.power"),
        onToggle: (on) => mutate((x) => setOpEnabled(x, i, on), true),
      });
      led.el.setAttr("data-part", `op-power-${i}`);
      label.prepend(led.el);
      parts.push(led);
    }

    function openOpMenu(ev: MouseEvent, d: Device): void {
      const menu = new Menu();
      const groups = paramsByChannel(
        d.stage,
        d.apply.map((o) => o.param),
      );
      groups.forEach((group, i) => {
        if (i > 0) menu.addSeparator();
        menu.addItem((item) => item.setTitle(CHANNEL_LABEL[group.channel]).setDisabled(true));
        for (const param of group.params) menu.addItem((item) => item.setTitle(`${paramName(param)} · ${param}`).onClick(() => mutate((x) => addOp(x, newOpFor(param)), true)));
      });
      menu.showAtMouseEvent(ev);
    }

    // --- MOD ----------------------------------------------------------------

    /** The ops an envelope may be drawn on — `set` installs a value, it has no onset to shape. */
    const shapeable = (d: Device): Array<{ op: ModifierOp; i: number }> => d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.op === "offset" || o.op.op === "scale");

    function buildMod(d: Device): void {
      const envelopes = d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.envelope !== undefined);
      // A moon-bound device always has a carrier, so its matrix is always on
      // show; every other kind earns the section by having a gate, an envelope,
      // or a click on `＋ mod`.
      const always = d.when.kind === "moon";
      if (!always && d.mods.length === 0 && envelopes.length === 0 && !modOpen) {
        iconButton(body, {
          text: "＋ mod",
          label: "Add a gate or an envelope",
          hint: deviceHint("device.mod"),
          cls: "wadjet-studio-device-add-mod",
          onClick: () => {
            modOpen = true;
            invalidate();
          },
        });
        return;
      }

      const sec = section("MOD", "device.mod", { qualifier: always ? "every cycle" : "gates" });
      iconButton(sec.head, {
        text: "＋ gate",
        label: "Add a gate",
        hint: deviceHint("device.gate.add"),
        cls: "wadjet-studio-device-add",
        onClick: (ev) => openGateMenu(ev, d),
      });

      const row = sec.content.createDiv({ cls: "wadjet-studio-device-mod-row" });
      row.createSpan({ cls: "wadjet-studio-device-mod-label", text: "MOD" });
      if (d.when.kind === "moon") buildCarrier(row, d, envelopes.length > 0);
      buildGates(row, d);

      for (const { op, i } of envelopes) buildEnvelope(sec.content, op, i);
    }

    /** `moon:Sable × ∿ curve / ▦ phases` — the carrier and how it reads the cycle. */
    function buildCarrier(row: HTMLElement, d: Device, curve: boolean): void {
      const moon = d.when.kind === "moon" ? d.when.moon : "";
      parts.push(
        createChip(row, {
          label: `moon:${moon}`,
          color: "var(--wadjet-studio-moon)",
          hint: deviceHint("device.mod.carrier"),
          onClick: () => openCycleFor(ctx, moon),
        }),
      );
      const mode = iconButton(row, {
        text: curve ? "∿ curve" : "▦ phases",
        label: curve ? "Cycle mode: curve" : "Cycle mode: phases",
        hint: deviceHint("device.mod.mode"),
        cls: "wadjet-studio-device-toggle",
        onClick: () =>
          mutate((x) => {
            if (curve) {
              // Back to phases: the gate is the phase chips again.
              x.apply.forEach((_, i) => setEnvelope(x, i, undefined));
              return;
            }
            const first = shapeable(x)[0];
            if (first !== undefined) setEnvelope(x, first.i, envelopeShape("Ease in"));
          }, true),
      });
      mode.setAttrs({ "data-part": "mod-mode", "aria-pressed": curve ? "true" : "false" });
    }

    /** The season/era gate chips — `⚑ Harvest 72% ×`, with the dimmer on its own small knob. */
    function buildGates(row: HTMLElement, d: Device): void {
      const seasons = calendar()?.seasons ?? [];
      d.mods.forEach((gate, i) => {
        const cell = row.createDiv({ cls: "wadjet-studio-device-gate", attr: { "data-source": gate.source } });
        parts.push(
          createChip(cell, {
            label: `${gate.source} ${gatePercent(gate.amount)}`,
            color: tagColour(gate.source, seasons),
            icon: "⚑",
            hint: deviceHint("device.gate.source"),
            onClick: () => openGateSourceMenu(cell, i),
          }),
        );
        knob(cell, {
          part: `gate-${i}`,
          label: "amount",
          min: 0,
          max: 1,
          step: 0.01,
          neutral: 1,
          value: gate.amount,
          size: "sm",
          fmt: (v) => gatePercent(v),
          hint: deviceHint("device.gate.amount"),
          onChange: (v, phase) => gesture(phase, (x) => setGateAmount(x, i, v)),
        });
        iconButton(cell, {
          text: "×",
          label: `Remove gate ${gate.source}`,
          hint: deviceHint("device.gate.remove"),
          cls: "wadjet-studio-device-remove",
          onClick: () => mutate((x) => removeGate(x, i), true),
        });
      });
    }

    /** Every `season:*` / `era:*` the world offers that this device is not already gated on. */
    function gateSources(used: readonly string[]): string[] {
      const state = ctx.store.get();
      return tagSources(calendar()?.seasons ?? [], state.world.eras).filter((t) => !used.includes(t));
    }

    function openGateMenu(ev: MouseEvent, d: Device): void {
      const menu = new Menu();
      const sources = gateSources(d.mods.map((g) => g.source));
      for (const source of sources) menu.addItem((item) => item.setTitle(source).onClick(() => mutate((x) => void addGate(x, source, 1), true)));
      if (sources.length === 0) menu.addItem((item) => item.setTitle("No seasons or eras yet").setDisabled(true));
      menu.showAtMouseEvent(ev);
    }

    function openGateSourceMenu(anchor: HTMLElement, index: number): void {
      const menu = new Menu();
      for (const source of gateSources([])) menu.addItem((item) => item.setTitle(source).onClick(() => mutate((x) => setGateSource(x, index, source), true)));
      const box = anchor.getBoundingClientRect();
      menu.showAtPosition({ x: box.left, y: box.bottom });
    }

    /** The onset envelope on one op: a named shape, or points dragged over the cycle. */
    function buildEnvelope(parent: HTMLElement, op: ModifierOp, index: number): void {
      const points = op.envelope ?? [];
      const box = parent.createDiv({ cls: "wadjet-studio-device-envelope", attr: { "data-param": op.param } });
      const head = box.createDiv({ cls: "wadjet-studio-device-envelope-head", attr: { "data-hint": deviceHint("device.envelope") } });
      head.createDiv({ cls: "wadjet-studio-device-dot" }).setCssProps({ "--wadjet-studio-device-dot-color": colourOf(op.param) });
      head.createSpan({ cls: "wadjet-studio-device-envelope-label", text: paramName(op.param) });
      head.createSpan({ cls: "wadjet-studio-device-apply-field", text: opGloss(op) });
      head.createDiv({ cls: "wadjet-studio-device-spacer" });
      iconButton(head, {
        text: `∿ ${envelopeShapeName(points)}`,
        label: "Onset shape",
        hint: deviceHint("device.envelope.shape"),
        cls: "wadjet-studio-device-toggle",
        onClick: (ev) => {
          const menu = new Menu();
          for (const shape of ENVELOPE_SHAPES) menu.addItem((item) => item.setTitle(shape.name).onClick(() => mutate((x) => setEnvelope(x, index, envelopeShape(shape.name)), true)));
          menu.showAtMouseEvent(ev);
        },
      });
      iconButton(head, {
        text: "×",
        label: `Remove the envelope on ${op.param}`,
        hint: deviceHint("device.envelope.remove"),
        cls: "wadjet-studio-device-remove",
        onClick: () => mutate((x) => setEnvelope(x, index, undefined), true),
      });

      /** Keep a dragged point between its neighbours: `setEnvelope` sorts, and a reorder mid-drag would swap the handle. */
      const move = (at: number, phase: number, strength: number): ((d: Device) => void) => {
        const lo = at === 0 ? 0 : (points[at - 1]?.[0] ?? 0) + ENVELOPE_MIN_GAP;
        const hi = at === points.length - 1 ? LAST_PHASE : (points[at + 1]?.[0] ?? LAST_PHASE) - ENVELOPE_MIN_GAP;
        const x = Math.min(Math.max(phase, lo), Math.max(lo, hi));
        return (d) => {
          const current_ = d.apply[index]?.envelope;
          if (current_ === undefined) return;
          setEnvelope(
            d,
            index,
            current_.map((p, k): [number, number] => (k === at ? [x, strength] : p)),
          );
        };
      };

      const chart = createChart(box, {
        kind: "automation",
        domain: "cycle",
        width: ENVELOPE_W,
        height: ENVELOPE_H,
        yRange: [0, 1],
        editable: true,
        series: [{ points: points.map((p): [number, number] => [p[0], p[1]]), color: "var(--wadjet-studio-accent)" }],
        onPoint: (at, x, y, phase) => gesture(phase, move(at, x, y)),
        onAdd: (x, y) =>
          mutate((d) => {
            const current_ = d.apply[index]?.envelope;
            if (current_ === undefined) return;
            setEnvelope(d, index, [...current_, [x, y]]);
          }, true),
        onRemove: (at) =>
          mutate((d) => {
            const current_ = d.apply[index]?.envelope;
            // One point is a flat envelope; zero is the shape the validator rejects.
            if (current_ === undefined || current_.length <= 1) return;
            setEnvelope(
              d,
              index,
              current_.filter((_, k) => k !== at),
            );
          }, true),
      });
      chart.el.setAttr("data-part", `envelope-${index}`);
      parts.push(chart);
    }

    // --- footer -------------------------------------------------------------

    function buildFoot(): void {
      const foot = body.createDiv({ cls: "wadjet-studio-device-foot" });
      iconButton(foot, {
        text: "remove from chain",
        label: "Remove from chain",
        hint: deviceHint("device.remove"),
        cls: "wadjet-studio-device-drop",
        onClick: () => {
          ctx.store.update(
            (s) => {
              const zone = zoneOf(s);
              if (zone !== null) removeDevice(zone, modifierId);
            },
            { history: true },
          );
          ctx.windows.close(deviceWindowId(modifierId));
        },
      });
    }

    // --- build --------------------------------------------------------------

    function build(): void {
      clearParts();
      body.empty();
      const d = current();
      if (d === null) {
        body.createDiv({ cls: "wadjet-studio-device-gone", text: "removed" });
        return;
      }
      // A bypassed device still shows every control; it just stops claiming to
      // be doing anything (`proto-win-neverain.png`).
      body.toggleClass("is-off", !d.enabled);
      chromeLed.on = d.enabled;
      chromeLed.level = ledLevel(issues());
      if (d.custom === true) parts.push(createChip(body, { label: "custom", color: "var(--wadjet-studio-warn)" }));
      buildWhen(d);
      buildSpell(d);
      buildApply(d);
      buildMod(d);
      buildFoot();
    }

    signature = stateKey();
    build();
    unsubscribe = ctx.store.subscribe(() => render());

    const opened = current();

    return {
      title: prettyName(opened?.name ?? modifierId),
      onRename: (name) => rename(name),
      width: PANEL_W,
      badge: () => KIND_BADGE[current()?.kind ?? "trim"],
      badgeColor: kindColor(KIND_BADGE[opened?.kind ?? "trim"]),
      ...(opened?.stage === "climate" ? { caption: "climate stage" } : {}),
      preset: {
        name: NO_PRESET,
        // A reader, not a snapshot: `onSave` below writes a preset into the
        // world draft, and the picker has to offer it back on the next tick
        // rather than only after the panel is closed and rebuilt.
        options: () => [NO_PRESET, ...presetsOffered().map(presetLabel)],
        onPick: (label) => {
          const found = presetsOffered().find((p) => presetLabel(p) === label);
          if (found === undefined) return;
          // The menu offers every kind, so the device takes the preset's kind
          // first — `loadPreset` only writes over a device of its own kind.
          mutate((x) => {
            x.kind = found.preset.kind;
            loadPreset(x, found.preset, calendar(), otherIds());
          }, true);
        },
        onSave: () => {
          const d = current();
          if (d === null) return;
          new PresetNameModal(ctx.plugin.app, d.name, (name) => {
            ctx.store.update(
              (s) => {
                const zone = zoneOf(s);
                const fresh = zone === null ? null : deviceOf(zone, modifierId, calendar());
                if (fresh !== null) saveAsPreset(s.world, fresh, name);
              },
              { history: true },
            );
          }).open();
        },
      },
      body,
      // No `level` getter on purpose: that is what makes `windows.ts` hand
      // `chromeLed` straight to the chrome instead of a copy, so the power
      // state this panel writes onto it reaches the lamp.
      led: chromeLed,
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        endLive?.();
        cancelDrag?.();
        clearParts();
        body.empty();
      },
    };
  };
}

/**
 * Register (or re-register) a builder for every device in the zone the studio
 * is pointed at, and close any device panel whose modifier has gone — after a
 * removal, a rename, or a switch to a zone that does not have it.
 *
 * Called by `createDevicesSurface` on mount and whenever the device set moves.
 */
export function registerDeviceWindows(ctx: SurfaceContext): void {
  const state = ctx.store.get();
  const zone = state.view.zoneId === null ? null : (state.zones[state.view.zoneId] ?? null);
  const ids = zone === null ? [] : devices(zone).map((m) => m.id);
  for (const id of ids) ctx.windows.register(deviceWindowId(id), buildDeviceWindow(id));

  const live = new Set(ids);
  for (const windowId of [...state.view.openWindows]) {
    if (!windowId.startsWith(DEVICE_WINDOW_PREFIX)) continue;
    if (!live.has(windowId.slice(DEVICE_WINDOW_PREFIX.length))) ctx.windows.close(windowId);
  }
}
