/**
 * The generic device window (SPEC §3.4 "Generic device", §5).
 *
 * One declaration, four projections: this is the *window* projection. Every
 * zone modifier that is not a compiled layer (`layer:*` / `forcings:*`) opens
 * here, under the id `device:<modifierId>`, and everything the panel does to
 * the draft goes through one of the pure helpers in `model/device-edit.ts` —
 * so what this file owns is the DOM and the gestures, never the grammar.
 *
 * Three things worth knowing before editing it:
 *
 *  - **The body is rebuilt, not patched.** A device is small; a signature of
 *    the compiled modifier plus the world state it draws from decides whether
 *    anything changed, so a tick that moved nothing touches no DOM. Rebuilds
 *    are suspended while a pointer gesture or a text input owns the panel,
 *    which is what lets a knob drag update the store every frame (`snapshot()`
 *    lands at pointer-up) without the knob being pulled out from under it.
 *  - **A rename is a new window.** The panel id carries the modifier id, so
 *    renaming closes this panel and opens the new one at the same position.
 *    That is also how the title bar follows a rename: the chrome's `title` is
 *    still set once, at open — `windows.ts` re-pulls `writes`/`issues`/`level`
 *    (wadjet-9f9.35) but has no rename hook to give `title` the same treatment.
 *  - **The interactive title row lives in the body, not in the chrome.** The
 *    chrome's LED has no `onToggle` (it is a passive validation lamp, SPEC
 *    §3.9) and its badge is the fixed `DEVICE` kind-class, not this device's
 *    own kind — so the live power LED, the editable name, the per-instance
 *    KIND text that follows the WHEN segmented, and the preset menu that
 *    grows when you save one all still have to sit somewhere this file
 *    repaints. The chrome keeps the title, the `DEVICE` badge (now a live
 *    validation LED alongside it), the `WRITES` footer and the issue line.
 */
import { Menu, Modal, Setting, type App } from "obsidian";
import type { Era, ModifierOp } from "../../../core/types";
import type { DevicePreset } from "../../../plugin/settings";
import type { CalendarDescription } from "../../../plugin/time/adapter";
import { type Channel, devices } from "../../model/compile";
import {
  WHEN_KINDS,
  addGate,
  addOp,
  defaultSpell,
  defaultWhenFor,
  deviceOf,
  loadPreset,
  neutralEnvelope,
  newOpFor,
  paramsByChannel,
  removeDevice,
  removeGate,
  removeOp,
  renameDevice,
  saveAsPreset,
  setEnvelope,
  setGateAmount,
  setGateSource,
  setOpEnabled,
  setOpValue,
  setSpell,
  setWhen,
  updateDevice,
} from "../../model/device-edit";
import { type Device, type WhenKind, knobSpecFor, moonRange, phasesFor, toModifier, whenSummary } from "../../model/devices";
import { dayLabel } from "../../model/format";
import { deviceHint } from "../../model/hints-device";
import { opFmt, opQuantity, parseDisplay } from "../../model/knob-units";
import { SHIPPED_PRESETS } from "../../model/presets";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createChart, createChip, createKnob, createLed, createSegmented } from "../components";
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

/** The year-window mini-lane, in SVG user units; the element is stretched to the panel by CSS. */
const LANE_W = 240;
const LANE_H = 18;

/** The envelope chart, in CSS pixels. */
const ENVELOPE_W = 240;
const ENVELOPE_H = 84;

/** A spell longer than this earns an amber readout (SPEC §3.9). */
const LONG_SPELL_DAYS = 50;

/** Envelope points keep this much phase between them, so a drag can never reorder them under itself. */
const ENVELOPE_MIN_GAP = 0.005;
/** Phases are in [0, 1): the last drawable phase sits just short of the wrap. */
const LAST_PHASE = 1 - ENVELOPE_MIN_GAP;

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

/** `temperature.mean` → `mean`: the knob's label is the leaf, the hint carries the path. */
function leafOf(param: string): string {
  return param.split(".")[1] ?? param;
}

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
function seasonBands(seasons: ReadonlyArray<{ name: string; from: number }>): Array<{ from: number; to: number; name: string }> {
  if (seasons.length === 0) return [{ from: 0, to: 1, name: "" }];
  const sorted = [...seasons].sort((a, b) => a.from - b.from);
  return sorted.map((s, i) => ({ from: s.from, to: sorted[(i + 1) % sorted.length]!.from + (i === sorted.length - 1 ? 1 : 0), name: s.name }));
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

/** `＋ save "<name>" as preset` asks for the name before it writes one (PLAN D12). */
class PresetNameModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Save as preset");
    let name = this.initial;
    new Setting(contentEl).setName("Name").addText((t) =>
      t
        .setValue(name)
        .setPlaceholder(this.initial)
        .onChange((v) => (name = v)),
    );
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          const trimmed = name.trim();
          this.close();
          if (trimmed) this.onSubmit(trimmed);
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
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
    /** `＋ mod` opens the MOD section on a device that has neither a gate nor an envelope yet. */
    let modOpen = false;
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

    function otherIds(): string[] {
      const zone = zoneOf(ctx.store.get());
      return zone === null ? [] : zone.modifiers.filter((m) => m.id !== modifierId).map((m) => m.id);
    }

    function writes(): string {
      const d = current();
      return d === null ? "—" : JSON.stringify(toModifier(d));
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

    function section(name: string, hintKey: string, summary?: string): Section {
      const root = body.createDiv({ cls: "wadjet-studio-device-section", attr: { "data-section": name.toLowerCase() } });
      const head = root.createDiv({ cls: "wadjet-studio-device-head", attr: { "data-hint": deviceHint(hintKey) } });
      head.createSpan({ cls: "wadjet-studio-device-head-label", text: name });
      if (summary !== undefined) head.createSpan({ cls: "wadjet-studio-device-head-summary", text: summary });
      return { head, content: root.createDiv({ cls: "wadjet-studio-device-body" }) };
    }

    function knob(parent: HTMLElement, o: { part: string; label: string; min: number; max: number; step: number; neutral?: number; value: number; fmt: (v: number) => string; parse?: (text: string) => number | null; hint: string; color?: string; disabled?: boolean; onChange: (v: number, phase: "drag" | "end" | "key" | "type") => void }): void {
      const component = createKnob(parent, {
        spec: { min: o.min, max: o.max, step: o.step, ...(o.neutral !== undefined ? { neutral: o.neutral } : {}) },
        value: o.value,
        label: o.label,
        fmt: o.fmt,
        ...(o.parse !== undefined ? { parse: o.parse } : {}),
        hint: o.hint,
        ...(o.color !== undefined ? { color: o.color } : {}),
        ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
        onChange: o.onChange,
      });
      component.el.setAttr("data-part", o.part);
      parts.push(component);
    }

    // --- title row ----------------------------------------------------------

    function buildTitle(d: Device): void {
      const row = body.createDiv({ cls: "wadjet-studio-device-title" });
      const power = createLed(row, {
        on: d.enabled,
        level: ledLevel(issues()),
        scope: "device",
        hint: deviceHint("device.power"),
        onToggle: (on) => mutate((x) => void (x.enabled = on), true),
      });
      power.el.setAttr("data-part", "power");
      parts.push(power);

      const input = row.createEl("input", { cls: "wadjet-studio-device-name", type: "text", value: d.name, attr: { "aria-label": "Device name", "data-hint": deviceHint("device.name") } });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          input.blur();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          input.value = d.name;
          input.blur();
        }
        // Escape reaches the panel otherwise, and closes the window mid-edit.
        ev.stopPropagation();
      });
      input.addEventListener("blur", () => rename(input.value, d.name));

      row.createSpan({ cls: "wadjet-studio-device-kind", text: d.kind.toUpperCase() });
      if (d.stage === "climate") parts.push(createChip(row, { label: "climate stage", color: "var(--wadjet-studio-gold)" }));
      if (d.custom === true) parts.push(createChip(row, { label: "custom", color: "var(--wadjet-studio-warn)" }));

      iconButton(row, {
        text: "preset ▾",
        label: "Presets",
        hint: deviceHint("device.preset"),
        cls: "wadjet-studio-device-preset",
        onClick: (ev) => openPresetMenu(ev, d),
      });
    }

    /**
     * A rename is an id change, and the panel is keyed on the id: carry the
     * remembered position across, then swap the panel for the new one.
     */
    function rename(next: string, was: string): void {
      const name = next.trim();
      if (!name || name === was) {
        invalidate();
        return;
      }
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

    function openPresetMenu(ev: MouseEvent, d: Device): void {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle(`＋ save "${d.name}" as preset`).onClick(() =>
          new PresetNameModal(ctx.plugin.app, d.name, (name) => {
            ctx.store.update(
              (s) => {
                const zone = zoneOf(s);
                const fresh = zone === null ? null : deviceOf(zone, modifierId, calendar());
                if (fresh !== null) saveAsPreset(s.world, fresh, name);
              },
              { history: true },
            );
          }).open(),
        ),
      );
      const mine = ctx.store.get().world.devicePresets;
      const offered: Array<{ preset: DevicePreset; yours: boolean }> = [
        ...SHIPPED_PRESETS.filter((p) => p.kind === d.kind).map((preset) => ({ preset, yours: false })),
        ...mine.filter((p) => p.kind === d.kind).map((preset) => ({ preset, yours: true })),
      ];
      if (offered.length > 0) menu.addSeparator();
      for (const { preset, yours } of offered) {
        menu.addItem((item) => item.setTitle(yours ? `${preset.name} · yours` : preset.name).onClick(() => mutate((x) => void loadPreset(x, preset, calendar(), otherIds()), true)));
      }
      menu.showAtMouseEvent(ev);
    }

    // --- WHEN ---------------------------------------------------------------

    function buildWhen(d: Device): void {
      const description = calendar();
      const yearLength = description?.yearLength ?? DEFAULT_YEAR_LENGTH;
      const sec = section("WHEN", "device.when", whenSummary(d, yearLength));

      if (d.custom === true) {
        parts.push(createChip(sec.content, { label: "custom", color: "var(--wadjet-studio-warn)", hint: deviceHint("device.when") }));
        sec.content.createSpan({ cls: "wadjet-studio-device-raw", text: JSON.stringify(d.raw?.when ?? null) });
        return;
      }

      const segmented = createSegmented(sec.content, {
        options: WHEN_KINDS.map((k) => ({ value: k.when, label: k.label, hint: deviceHint("device.when") })),
        value: d.when.kind,
        onChange: (value) => mutate((x) => setWhen(x, defaultWhenFor(value as WhenKind, calendar())), true),
      });
      segmented.el.setAttr("data-part", "when-kind");
      parts.push(segmented);

      const kindBody = sec.content.createDiv({ cls: "wadjet-studio-device-when" });
      const w = d.when;
      if (w.kind === "moon") buildMoon(kindBody, w.moon, w.phases, description);
      else if (w.kind === "tag") buildTag(kindBody, w.tags, description);
      else if (w.kind === "yearWindow") buildYearWindow(kindBody, w.start, w.length, description, yearLength);
      else if (w.kind === "chance") buildChance(kindBody, w.p);
    }

    function buildMoon(parent: HTMLElement, name: string, selected: string[], description: CalendarDescription | null): void {
      const moons = description?.moons ?? [];
      const named = moons.find((m) => m.name === name)?.phases ?? [];
      const row = parent.createDiv({ cls: "wadjet-studio-device-chips" });
      parts.push(
        createChip(row, {
          label: `moon:${name}`,
          icon: "☾",
          color: "var(--wadjet-studio-moon)",
          hint: deviceHint("device.when.moon"),
          onClick: () => openCycleFor(ctx, name),
        }),
      );

      if (moons.length > 1) {
        const picker = createSegmented(parent, {
          options: moons.map((m) => ({ value: m.name, label: m.name, hint: deviceHint("device.when.moonPick") })),
          value: name,
          onChange: (next) =>
            mutate((x) => {
              if (x.when.kind !== "moon") return;
              const target = moons.find((m) => m.name === next)?.phases ?? [];
              const keep = x.when.phases.filter((p) => target.some((q) => q.name === p));
              const range = keep.length > 0 ? moonRange(target, keep) : ([x.when.range[0], x.when.range[1]] as [number, number]);
              setWhen(x, { kind: "moon", moon: next, phases: phasesFor(target, range), range });
            }, true),
        });
        picker.el.setAttr("data-part", "when-moon");
        parts.push(picker);
      }

      const chips = parent.createDiv({ cls: "wadjet-studio-device-chips" });
      for (const phase of named) {
        const on = selected.includes(phase.name);
        const chip = createChip(chips, {
          label: phase.name,
          ...(on ? { color: "var(--wadjet-studio-moon)" } : {}),
          hint: deviceHint("device.when.phase"),
          onClick: () => togglePhase(named, phase.name),
        });
        chip.el.toggleClass("is-selected", on);
        chip.el.setAttrs({ "data-phase": phase.name, "aria-pressed": on ? "true" : "false" });
        parts.push(chip);
      }
      // The ends do not sit on boundaries (or the moon has no named phases):
      // the window is a hand-written arc, and says so rather than lying.
      if (selected.length === 0) parts.push(createChip(chips, { label: "custom range", hint: deviceHint("device.when.phase") }));
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

    function buildTag(parent: HTMLElement, tags: string[], description: CalendarDescription | null): void {
      const state = ctx.store.get();
      const offered = tagSources(description?.seasons ?? [], state.world.eras);
      // A tag the world does not offer (typed by hand, or left by a plugin)
      // still gets a chip, so it can be switched off again.
      for (const t of tags) if (!offered.includes(t)) offered.push(t);

      const chips = parent.createDiv({ cls: "wadjet-studio-device-chips" });
      for (const tag of offered) {
        const on = tags.includes(tag);
        const chip = createChip(chips, {
          label: tag,
          ...(on ? { color: "var(--wadjet-studio-gold)" } : {}),
          hint: deviceHint("device.when.tag"),
          onClick: () => toggleTag(tag),
        });
        chip.el.toggleClass("is-selected", on);
        chip.el.setAttrs({ "data-tag": tag, "aria-pressed": on ? "true" : "false" });
        parts.push(chip);
      }

      const input = parent.createEl("input", { cls: "wadjet-studio-device-tag-input", type: "text", attr: { placeholder: "Tag", "aria-label": "Add a tag", "data-hint": deviceHint("device.when.tagAdd") } });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          const value = input.value.trim();
          input.value = "";
          input.blur();
          if (value) toggleTag(value, true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          input.value = "";
          input.blur();
        }
        ev.stopPropagation();
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

    function buildYearWindow(parent: HTMLElement, start: number, length: number, description: CalendarDescription | null, yearLength: number): void {
      const seasons = description?.seasons ?? [];
      const lane = parent.createDiv({ cls: "wadjet-studio-device-lane", attr: { "data-hint": deviceHint("device.when.lane") } });
      const svg = lane.createSvg("svg", { cls: "wadjet-studio-device-lane-svg", attr: { viewBox: `0 0 ${LANE_W} ${LANE_H}`, preserveAspectRatio: "none" } });
      seasonBands(seasons).forEach((band, i) => {
        svg.createSvg("rect", {
          cls: "wadjet-studio-device-band",
          attr: { x: (band.from * LANE_W).toFixed(2), y: 0, width: ((band.to - band.from) * LANE_W).toFixed(2), height: LANE_H, "data-band": String(i % 2) },
        });
      });
      for (const [a, b] of windowSpans(start, length)) {
        svg.createSvg("rect", { cls: "wadjet-studio-device-clip", attr: { x: (a * LANE_W).toFixed(2), y: 0, width: ((b - a) * LANE_W).toFixed(2), height: LANE_H } });
      }

      const knobs = parent.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(knobs, {
        part: "when-start",
        label: "start",
        min: 0,
        max: 1,
        step: 0.001,
        value: start,
        fmt: (v) => dayLabel(Math.floor(v * yearLength) + 1, yearLength),
        hint: deviceHint("device.when.start"),
        onChange: (v, phase) =>
          gesture(phase, (x) => {
            if (x.when.kind === "yearWindow") setWhen(x, { kind: "yearWindow", start: v, length: x.when.length });
          }),
      });
      knob(knobs, {
        part: "when-length",
        label: "length",
        min: 0,
        max: 1,
        step: 0.001,
        value: length,
        fmt: (v) => `${Math.round(v * yearLength)} d`,
        hint: deviceHint("device.when.length"),
        onChange: (v, phase) =>
          gesture(phase, (x) => {
            if (x.when.kind === "yearWindow") setWhen(x, { kind: "yearWindow", start: x.when.start, length: v });
          }),
      });
    }

    function buildChance(parent: HTMLElement, p: number): void {
      const knobs = parent.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(knobs, {
        part: "when-chance",
        label: "chance",
        min: 0,
        max: 1,
        step: 0.01,
        value: p,
        fmt: (v) => `${(v * 100).toFixed(0)} %`,
        hint: deviceHint("device.when.chance"),
        onChange: (v, phase) =>
          gesture(phase, (x) => {
            if (x.when.kind === "chance") setWhen(x, { kind: "chance", p: v });
          }),
      });
    }

    // --- SPELL --------------------------------------------------------------

    function buildSpell(d: Device): void {
      const sec = section("SPELL", "device.spell");
      const led = createLed(sec.head, {
        on: d.spell !== undefined,
        scope: "op",
        hint: deviceHint("device.spell"),
        onToggle: (on) => mutate((x) => setSpell(x, on ? defaultSpell(calendar()) : undefined), true),
      });
      led.el.setAttr("data-part", "spell-power");
      parts.push(led);
      const spell = d.spell;
      if (spell === undefined) return;

      const knobs = sec.content.createDiv({ cls: "wadjet-studio-device-knobs" });
      knob(knobs, {
        part: "spell-starts",
        label: "starts/yr",
        min: 0.05,
        max: 20,
        step: 0.05,
        value: spell.meanStartsPerYear,
        fmt: (v) => `${v.toFixed(2)}/yr`,
        hint: deviceHint("device.spell.starts"),
        onChange: (v, phase) => gesture(phase, (x) => setSpell(x, { meanStartsPerYear: v, meanDurationDays: x.spell?.meanDurationDays ?? spell.meanDurationDays })),
      });
      knob(knobs, {
        part: "spell-duration",
        label: "duration",
        min: 1,
        max: 120,
        step: 1,
        value: spell.meanDurationDays,
        fmt: (v) => `${v.toFixed(0)} d`,
        hint: deviceHint("device.spell.duration", spell.meanDurationDays > LONG_SPELL_DAYS ? `${spell.meanDurationDays.toFixed(0)} days is longer than a season` : undefined),
        ...(spell.meanDurationDays > LONG_SPELL_DAYS ? { color: "var(--wadjet-studio-warn)" } : {}),
        onChange: (v, phase) => gesture(phase, (x) => setSpell(x, { meanStartsPerYear: x.spell?.meanStartsPerYear ?? spell.meanStartsPerYear, meanDurationDays: v })),
      });
    }

    // --- APPLY --------------------------------------------------------------

    function buildApply(d: Device): void {
      const sec = section("APPLY", "device.op");
      iconButton(sec.head, {
        text: "＋",
        label: "Add an op",
        hint: deviceHint("device.op.add"),
        cls: "wadjet-studio-device-add",
        onClick: (ev) => openOpMenu(ev, d),
      });

      d.apply.forEach((op, i) => {
        const row = sec.content.createDiv({ cls: "wadjet-studio-device-op", attr: { "data-param": op.param } });
        const led = createLed(row, {
          on: op.enabled !== false,
          scope: "op",
          hint: deviceHint("device.op.power"),
          onToggle: (on) => mutate((x) => setOpEnabled(x, i, on), true),
        });
        led.el.setAttr("data-part", `op-power-${i}`);
        parts.push(led);
        buildOpControl(row, op, i);
        iconButton(row, {
          text: "×",
          label: `Remove ${op.param}`,
          hint: deviceHint("device.op.remove"),
          cls: "wadjet-studio-device-remove",
          onClick: () => mutate((x) => removeOp(x, i), true),
        });
      });
    }

    /** A knob per op, except the two shapes a knob cannot express: `clamp`, and a `set` that installs a whole curve. */
    function buildOpControl(row: HTMLElement, op: ModifierOp, i: number): void {
      if (op.op === "clamp" || typeof op.value !== "number") {
        row.createSpan({ cls: "wadjet-studio-device-op-raw", text: `${leafOf(op.param)} ${op.op}` });
        return;
      }
      const spec = knobSpecFor(op);
      const isOffset = op.op === "offset";
      const q = opQuantity(op.param, isOffset);
      knob(row, {
        part: `op-${i}`,
        label: leafOf(op.param),
        min: spec.min,
        max: spec.max,
        step: spec.step,
        neutral: spec.neutral,
        value: op.value,
        fmt: opFmt(op.param, isOffset, ctx.units(), spec.fmt),
        color: colourOf(op.param),
        hint: deviceHint("device.op", `${op.param} · ${op.op}`),
        disabled: op.enabled === false,
        ...(q !== null ? { parse: (text: string) => parseDisplay({ min: spec.min, max: spec.max, neutral: spec.neutral, step: spec.step }, q, ctx.units())(text) } : {}),
        onChange: (v, phase) => gesture(phase, (x) => setOpValue(x, i, v)),
      });
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
        for (const param of group.params) menu.addItem((item) => item.setTitle(leafOf(param)).onClick(() => mutate((x) => addOp(x, newOpFor(param)), true)));
      });
      menu.showAtMouseEvent(ev);
    }

    // --- MOD ----------------------------------------------------------------

    function buildMod(d: Device): void {
      const envelopes = d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.envelope !== undefined);
      if (d.mods.length === 0 && envelopes.length === 0 && !modOpen) {
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

      const sec = section("MOD", "device.mod");
      iconButton(sec.head, {
        text: "＋ gate",
        label: "Add a gate",
        hint: deviceHint("device.gate.add"),
        cls: "wadjet-studio-device-add",
        onClick: (ev) => openGateMenu(ev, d),
      });
      const spare = d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.envelope === undefined && (o.op.op === "offset" || o.op.op === "scale"));
      if (spare.length > 0) {
        iconButton(sec.head, {
          text: "＋ envelope",
          label: "Add an envelope",
          hint: deviceHint("device.envelope.add"),
          cls: "wadjet-studio-device-add",
          onClick: (ev) => {
            const menu = new Menu();
            for (const { op, i } of spare) menu.addItem((item) => item.setTitle(op.param).onClick(() => mutate((x) => setEnvelope(x, i, neutralEnvelope()), true)));
            menu.showAtMouseEvent(ev);
          },
        });
      }

      d.mods.forEach((gate, i) => {
        const row = sec.content.createDiv({ cls: "wadjet-studio-device-gate", attr: { "data-source": gate.source } });
        parts.push(
          createChip(row, {
            label: gate.source,
            color: "var(--wadjet-studio-gold)",
            hint: deviceHint("device.gate.source"),
            onClick: () => openGateSourceMenu(row, i),
          }),
        );
        knob(row, {
          part: `gate-${i}`,
          label: "amount",
          min: 0,
          max: 1,
          step: 0.01,
          neutral: 1,
          value: gate.amount,
          fmt: (v) => v.toFixed(2),
          hint: deviceHint("device.gate.amount"),
          onChange: (v, phase) => gesture(phase, (x) => setGateAmount(x, i, v)),
        });
        iconButton(row, {
          text: "×",
          label: `Remove gate ${gate.source}`,
          hint: deviceHint("device.gate.remove"),
          cls: "wadjet-studio-device-remove",
          onClick: () => mutate((x) => removeGate(x, i), true),
        });
      });

      for (const { op, i } of envelopes) buildEnvelope(sec.content, op, i);
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

    function buildEnvelope(parent: HTMLElement, op: ModifierOp, index: number): void {
      const points = op.envelope ?? [];
      const box = parent.createDiv({ cls: "wadjet-studio-device-envelope", attr: { "data-param": op.param } });
      const head = box.createDiv({ cls: "wadjet-studio-device-envelope-head", attr: { "data-hint": deviceHint("device.envelope") } });
      head.createSpan({ cls: "wadjet-studio-device-envelope-label", text: op.param });
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
          const current = d.apply[index]?.envelope;
          if (current === undefined) return;
          setEnvelope(
            d,
            index,
            current.map((p, k): [number, number] => (k === at ? [x, strength] : p)),
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
        series: [{ points: points.map((p): [number, number] => [p[0], p[1]]), color: "var(--wadjet-studio-moon)" }],
        onPoint: (at, x, y, phase) => gesture(phase, move(at, x, y)),
        onAdd: (x, y) =>
          mutate((d) => {
            const current = d.apply[index]?.envelope;
            if (current === undefined) return;
            setEnvelope(d, index, [...current, [x, y]]);
          }, true),
        onRemove: (at) =>
          mutate((d) => {
            const current = d.apply[index]?.envelope;
            // One point is a flat envelope; zero is the shape the validator rejects.
            if (current === undefined || current.length <= 1) return;
            setEnvelope(
              d,
              index,
              current.filter((_, k) => k !== at),
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
        text: "Remove from chain",
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
      buildTitle(d);
      buildWhen(d);
      buildSpell(d);
      buildApply(d);
      buildMod(d);
      buildFoot();
    }

    signature = stateKey();
    build();
    unsubscribe = ctx.store.subscribe(() => render());

    return {
      title: current()?.name ?? modifierId,
      badge: "DEVICE",
      body,
      led: { on: true, scope: "device" },
      level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "device", id: modifierId }))),
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        endLive?.();
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
