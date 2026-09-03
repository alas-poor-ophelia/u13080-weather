/**
 * The generic device window (SPEC §3.4 "Generic device", §5).
 *
 * One declaration, four projections: this is the *window* projection. Every
 * zone modifier that is not a compiled layer (`layer:*` / `forcings:*`) opens
 * here, under the id `device:<modifierId>`, and everything the panel does to
 * the draft goes through one of the pure helpers in `model/device-edit.ts` —
 * so what this file owns is the DOM and the gestures, never the grammar.
 *
 * This file is the panel's *spine* only — the store reads, the rebuild
 * scheduling, the section and knob factories, the chrome's LED and preset
 * control, and the `DeviceWindowContext` every body is built against. The
 * bodies live beside it, one module per section:
 *
 *  - `ids.ts` — the `device:<modifierId>` panel id (re-exported below).
 *  - `constants.ts`, `geometry.ts`, `icon-button.ts` — the folder's leaves.
 *  - `context.ts` — the handle a body is built against.
 *  - `when.ts` — the WHEN section and its kind dispatcher, over
 *    `when-moon.ts`, `when-tag.ts`, `when-year-window.ts`, `when-chance.ts`.
 *  - `spell.ts`, `apply.ts`, `mod.ts`, `footer.ts` — the sections under WHEN,
 *    in the order `build()` calls them.
 *
 * Three things worth knowing before editing it:
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
 */
import type { DevicePreset } from "../../../../plugin/settings";
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { devices } from "../../../model/compile";
import { displayName as prettyName } from "../../../model/copy";
import {
  deviceOf,
  loadPreset,
  renameDevice,
  saveAsPreset,
  updateDevice,
} from "../../../model/device-edit";
import {
  badgeFor,
  type Device,
  deviceGrammar,
} from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { SHIPPED_PRESETS } from "../../../model/presets";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../../model/validation";
import { createChip, createKnob } from "../../components";
import type { LedProps } from "../../components/led";
import { PresetNameModal } from "../../preset-name-modal";
import type { SurfaceContext } from "../../surfaces";
import type { WindowBuilder } from "../../windows";
import { buildApply } from "./apply";
import { KIND_BADGE, PANEL_W, PANEL_W_SPELL, PANEL_W_TAG } from "./constants";
import { type DeviceKnobOptions, type DeviceWindowContext, type Section, zoneOf } from "./context";
import { buildFoot } from "./footer";
import type { Part } from "./icon-button";
import { DEVICE_WINDOW_PREFIX, deviceWindowId } from "./ids";
import { buildMod } from "./mod";
import { buildSpell } from "./spell";
import { buildWhen } from "./when";
import { curseCollapsed } from "./when-tag";

export { DEVICE_WINDOW_PREFIX, deviceWindowId };

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
    /** Moon path only: which binding card has its `∿` shape chip open, and which its `＋` source list. */
    let envOpen: number | null = null;
    let srcPick: number | null = null;
    /** Moon path only: whether `＋ Add target`'s inline list is open under the cards. */
    let targetPick = false;
    /** Tag path only: whether the curse disclosure is open (`when-tag.ts`); the chips and APPLY hang behind it. */
    let applyOpen = false;
    let signature = "";
    let issuesKey = "";
    let issuesMemo: StudioIssue[] = [];

    // --- reading the draft --------------------------------------------------

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
        envOpen,
        srcPick,
        targetPick,
        applyOpen,
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

    /**
     * `APPLY · while active` — the caption and the qualifier that teaches what
     * it means (SPEC §9). The noun is caps and the qualifier is not, exactly as
     * written: the stylesheet no longer uppercases the label for us
     * (`1095` l.84).
     */
    function section(name: string, hintKey: string, o?: { qualifier?: string }): Section {
      const root = body.createDiv({ cls: "wadjet-studio-device-section", attr: { "data-section": name.toLowerCase() } });
      const head = root.createDiv({ cls: "wadjet-studio-device-head", attr: { "data-hint": deviceHint(hintKey) } });
      head.createSpan({ cls: "wadjet-studio-device-head-label", text: o?.qualifier === undefined ? name : `${name} · ${o.qualifier}` });
      return { head, content: root.createDiv({ cls: "wadjet-studio-device-body" }) };
    }

    function knob(parent: HTMLElement, o: DeviceKnobOptions): HTMLElement {
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

    /**
     * The one handle every body below is built against — the spine above, in
     * the shape `context.ts` describes. It is built once per panel: nothing in
     * it is recreated on a rebuild, which is why `addPart` pushes rather than
     * handing the (rebound) array out, and why the two cursors are pairs.
     */
    const c: DeviceWindowContext = {
      ctx,
      modifierId,
      body,
      calendar,
      mutate,
      gesture,
      beginLive,
      endGesture: () => {
        live = false;
        ctx.store.snapshot();
      },
      invalidate,
      addPart: (part) => void parts.push(part),
      section,
      knob,
      clipAt: () => clipAt,
      setClipAt: (at) => void (clipAt = at),
      modOpen: () => modOpen,
      setModOpen: (open) => void (modOpen = open),
      envOpen: () => envOpen,
      setEnvOpen: (at) => void (envOpen = at),
      srcPick: () => srcPick,
      setSrcPick: (at) => void (srcPick = at),
      targetPick: () => targetPick,
      setTargetPick: (open) => void (targetPick = open),
      applyOpen: () => applyOpen,
      setApplyOpen: (open) => void (applyOpen = open),
      setCancelDrag: (cancel) => void (cancelDrag = cancel),
    };

    // --- build --------------------------------------------------------------

    function build(): void {
      clearParts();
      body.empty();
      const d = current();
      if (d === null) {
        body.createDiv({ cls: "wadjet-studio-device-gone", text: "removed" });
        return;
      }
      // A bypassed device still shows every control, at full contrast: the
      // prototype signals power on the chrome LED alone and leaves the body
      // legible (gap2 D7), so the class is a hook, not a dimmer.
      body.toggleClass("is-off", !d.enabled);
      chromeLed.on = d.enabled;
      chromeLed.level = ledLevel(issues());
      if (d.custom === true) parts.push(createChip(body, { label: "custom", color: "var(--wadjet-studio-warn)" }));
      // The spell path (`0905-vst-ashfall.html`, gap2 C9) reorders the body:
      // WHEN row, the two spell dials uncaptioned, WINDOWS, APPLY. `buildWhen`
      // hands the WINDOWS body back rather than drawing it, so the dials can
      // go above it.
      const spellPath = d.when.kind === "yearWindow" && d.custom !== true;
      // A shut curse disclosure owns everything the Neverain showcase does not
      // draw (`1213` l.10): SPELL, APPLY and MOD alike. The WHEN row, the
      // footer and WRITES stay, the way the moon and spell paths keep what
      // their own showcases keep.
      const collapsed = curseCollapsed(c, d);
      const windows = buildWhen(c, d, spellPath);
      // No SPELL row on the moon path: the prototype's Stormtide draws none
      // (gap2 B9), and `buildApply` folds the gate disc and the op knobs into
      // one row there instead of a disc under WHEN and a grid below it.
      if (d.when.kind !== "moon" && !collapsed) buildSpell(c, d, spellPath);
      windows?.();
      if (!collapsed) {
        buildApply(c, d);
        buildMod(c, d);
      }
      buildFoot(c);
    }

    signature = stateKey();
    build();
    unsubscribe = ctx.store.subscribe(() => render());

    const opened = current();

    return {
      title: prettyName(opened?.name ?? modifierId),
      onRename: (name) => rename(name),
      // Per-kind widths are PLAN.md D16's: the chrome is shared, the box is
      // not. `windows.ts` reads this once, at `createWindow`, so it is the
      // width the panel OPENS at — a kind switch inside an open panel keeps
      // the width it was opened with until it is reopened.
      width: opened?.when.kind === "yearWindow" ? PANEL_W_SPELL : opened?.when.kind === "tag" ? PANEL_W_TAG : PANEL_W,
      // Stored, not derived: `badgeFor` reads the modifier's own `badge` flag,
      // so a tag device wears `CURSE` because its author picked that row in the
      // insert picker, whatever it writes. No `badgeColor` — the chrome's default
      // is `kindColor(badge)`, which is re-read on every paint and so follows
      // the badge; a fixed colour here would keep the hue the panel opened with.
      badge: () => {
        const d = current();
        return d === null ? KIND_BADGE.trim : badgeFor(d);
      },
      // No `caption`: the prototype's device bar is LED · name · KIND · preset ▾
      // · × and nothing else — the stage reads in the WHEN row (`when.ts`).
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
