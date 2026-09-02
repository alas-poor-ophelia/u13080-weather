/**
 * The Era window (SPEC §3.4 "Era", §2 "world · N zones").
 *
 * One panel per era, id `era:<name>`. Everything it writes lands in
 * `world.eras[i]` (`model/era-edit.ts`), which is world scope: the panel
 * carries a `world · N zones` badge and every edit here goes through the
 * session's one world-edit confirm (`model/world-confirm.ts`) — the same
 * gate the CYCLE window uses for moons.
 *
 * Two things worth knowing before editing this file:
 *
 *  - **The window's id is name-derived.** Renaming an era changes its id
 *    (`era:<old>` → `era:<new>`), which the generic `Window` chrome cannot do
 *    in place (`WindowBuild.title` is set once, at open). `commitName`
 *    therefore closes this panel and opens a fresh one under the new id,
 *    carrying its remembered position across — the same reason
 *    `registerEraWindows` re-registers every open tick, so a lane clip or a
 *    mixer unit can always `ctx.windows.open("era:" + currentName)`.
 *  - **The power switch lives in the body, not the chrome.** The chrome LED
 *    (`WindowBuild.level`, wadjet-9f9.35) is a passive validation lamp with no
 *    `onToggle` — it cannot be the era's enable switch, which needs a click
 *    handler and the world-confirm gate. That switch, the inline name, the
 *    `world · N zones` chip and delete therefore live in the body instead — the
 *    row SPEC §3.4 describes as the window's "title" — where this file's own
 *    subscription keeps it live; the chrome LED repaints alongside it from the
 *    same `issues()`.
 */
import { Menu } from "obsidian";
import { ERA_TAG_PREFIX } from "../../../core/eras";
import type { Era, ModifierOp, ZoneProfile } from "../../../core/types";
import type { Channel } from "../../model/compile";
import { knobSpecFor } from "../../model/devices";
import { addOp, removeEra, removeOp, renameEra, setEnabled, setOpEnabled, setOpValue, setSpan } from "../../model/era-edit";
import { eraHint } from "../../model/hints-era";
import { opFmt, opQuantity, parseDisplay } from "../../model/knob-units";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { needsWorldConfirm } from "../../model/world-confirm";
import { clampWindow, type Window, type ZoomBounds } from "../../model/zoom";
import { createChip, createKnob, createLed, type ChipComponent, type KnobComponent, type LedComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";

/** Window ids are `era:<name>` — one panel per era, opened by name. */
export const ERA_WINDOW_PREFIX = "era:";

export function eraWindowId(name: string): string {
  return `${ERA_WINDOW_PREFIX}${name}`;
}

/** Mirrors `header.ts`'s own pan/zoom bounds (SPEC §3.1): 100 years before the epoch, 1100 after. */
const PLAYLIST_BOUNDS_BEFORE = 100;
const PLAYLIST_BOUNDS_AFTER = 1100;
/** `⤢ playlist`'s open-ended span: a century past `from` when `to` is unset. */
const OPEN_ENDED_SPAN_YEARS = 100;

interface OpChoice {
  channel: Channel;
  label: string;
  make(): ModifierOp;
}

/** One offset/scale param per row of the "＋" menu, grouped by channel (SPEC §3.4 "Menu of curve params by channel"). */
const OP_CHOICES: readonly OpChoice[] = [
  { channel: "temperature", label: "Temperature · mean", make: () => ({ param: "temperature.mean", op: "offset", value: 0 }) },
  { channel: "temperature", label: "Temperature · diurnal range", make: () => ({ param: "temperature.diurnalRange", op: "offset", value: 0 }) },
  { channel: "temperature", label: "Temperature · day-to-day SD", make: () => ({ param: "temperature.sd", op: "offset", value: 0 }) },
  { channel: "precipitation", label: "Precipitation · wet after dry", make: () => ({ param: "precipitation.pwd", op: "scale", value: 1 }) },
  { channel: "precipitation", label: "Precipitation · wet after wet", make: () => ({ param: "precipitation.pww", op: "scale", value: 1 }) },
  { channel: "precipitation", label: "Precipitation · amount", make: () => ({ param: "precipitation.scale", op: "scale", value: 1 }) },
  { channel: "wind", label: "Wind · speed", make: () => ({ param: "wind.speed", op: "scale", value: 1 }) },
  { channel: "wind", label: "Wind · direction", make: () => ({ param: "wind.direction", op: "offset", value: 0 }) },
  { channel: "sky", label: "Sky · cloud (dry days)", make: () => ({ param: "cloud.dry", op: "offset", value: 0 }) },
  { channel: "sky", label: "Sky · cloud (wet days)", make: () => ({ param: "cloud.wet", op: "offset", value: 0 }) },
];

const CHANNEL_LABEL: Record<Channel, string> = { temperature: "TEMP", precipitation: "PRECIP", wind: "WIND", sky: "SKY" };

/** `set`/`offset`/`scale` carry a plain numeric `value`; a `clamp` op has none and reads as 0. */
function opValue(op: ModifierOp): number {
  return "value" in op && typeof op.value === "number" ? op.value : 0;
}

/**
 * The builder for one era's panel. Registered per era by `registerEraWindows`;
 * opened by an eras-lane clip or a mixer era unit through `ctx.windows.open`.
 */
export function buildEraWindow(name: string): WindowBuilder {
  return (ctx: SurfaceContext): WindowBuild => {
    let unsubscribe: (() => void) | null = null;
    /** One pending confirm at a time — a knob drag fires `onChange` every frame. */
    let confirmPending = false;
    let signature = "";
    let opRows: Array<{ led: LedComponent; knob: KnobComponent }> = [];

    const root = createDiv({ cls: "wadjet-studio-era" });

    // --- the "title" row SPEC §3.4 describes: LED · name · world · N zones · delete ---
    const head = root.createDiv({ cls: "wadjet-studio-era-head" });
    const enabledLed: LedComponent = createLed(head, {
      on: true,
      level: "ok",
      scope: "device",
      hint: eraHint("era.enabled"),
      onToggle: (on) => guarded(() => ctx.store.update((s) => setEnabled(s.world, name, on), { history: true })),
    });
    const nameInput = head.createEl("input", { cls: "wadjet-studio-era-name", type: "text", attr: { "data-hint": eraHint("era.name"), "data-part": "era-name" } });
    const worldChip: ChipComponent = createChip(head, { label: "world · 0 zones", color: "var(--wadjet-studio-gold)", hint: eraHint("era.world") });
    const deleteButton = head.createDiv({
      cls: "wadjet-studio-era-btn",
      text: "Delete",
      attr: { role: "button", tabindex: "0", "aria-label": "Delete era", "data-hint": eraHint("era.delete"), "data-part": "era-delete" },
    });
    enabledLed.el.setAttr("data-part", "era-led");
    worldChip.el.setAttr("data-part", "era-world");

    // --- SPAN row ---
    const spanRow = root.createDiv({ cls: "wadjet-studio-era-span" });
    spanRow.createSpan({ cls: "wadjet-studio-era-span-label", text: "SPAN" });
    const fromInput = spanRow.createEl("input", { cls: "wadjet-studio-era-span-from", type: "number", attr: { "data-hint": eraHint("era.from"), "data-part": "era-from" } });
    spanRow.createSpan({ cls: "wadjet-studio-era-span-dash", text: "–" });
    const toInput = spanRow.createEl("input", { cls: "wadjet-studio-era-span-to", type: "number", attr: { placeholder: "∞", "data-hint": eraHint("era.to"), "data-part": "era-to" } });
    const playlistButton = spanRow.createDiv({
      cls: "wadjet-studio-era-btn",
      text: "⤢ playlist",
      attr: { role: "button", tabindex: "0", "aria-label": "Zoom the playlist to this era", "data-hint": eraHint("era.playlist"), "data-part": "era-playlist" },
    });

    // --- APPLY section ---
    const applyHead = root.createDiv({ cls: "wadjet-studio-era-apply-head" });
    applyHead.createSpan({ cls: "wadjet-studio-era-apply-label", text: "APPLY" });
    const addOpButton = applyHead.createDiv({
      cls: "wadjet-studio-era-btn",
      text: "＋",
      attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "aria-label": "Add an op", "data-hint": eraHint("era.opAdd"), "data-part": "era-op-add" },
    });
    const opsList = root.createDiv({ cls: "wadjet-studio-era-ops", attr: { "data-part": "era-ops" } });
    const note = root.createDiv({ cls: "wadjet-studio-era-note", attr: { "data-part": "era-note" } });

    // --- state readers -------------------------------------------------------

    function currentEra(state: StudioState = ctx.store.get()): Era | undefined {
      return state.world.eras.find((e) => e.name === name);
    }

    function zoneForIssues(state: StudioState): ZoneProfile | null {
      const id = state.view.zoneId;
      if (id !== null && state.zones[id] !== undefined) return state.zones[id];
      return Object.values(state.zones)[0] ?? null;
    }

    // --- confirm ---------------------------------------------------------------

    /** Run `apply`, behind the session's one world-edit confirm (SPEC §2). */
    function guarded(apply: () => void): void {
      if (!needsWorldConfirm()) {
        apply();
        return;
      }
      if (confirmPending) return;
      confirmPending = true;
      confirmWorldEdit(
        ctx.plugin.app,
        ctx,
        "eras",
        () => {
          confirmPending = false;
          apply();
        },
        // A cancelled edit leaves a control showing a value nobody committed.
        () => {
          confirmPending = false;
          repaint(true);
        },
      );
    }

    // --- writes ------------------------------------------------------------

    function commitName(raw: string): void {
      const era = currentEra();
      const trimmed = raw.trim();
      if (era === undefined || trimmed === "" || trimmed === era.name) {
        nameInput.value = era?.name ?? name;
        return;
      }
      guarded(() => {
        const before = era.name;
        let after = before;
        ctx.store.update(
          (s) => {
            after = renameEra(s.world, s.zones, name, trimmed);
          },
          { history: true },
        );
        if (after === before) return;
        const oldId = eraWindowId(before);
        const newId = eraWindowId(after);
        const pos = ctx.store.get().view.windowPos[oldId];
        ctx.windows.close(oldId);
        if (pos !== undefined) ctx.store.update((s) => (s.view.windowPos[newId] = pos));
        ctx.windows.open(newId, buildEraWindow(after));
      });
    }

    function commitSpan(): void {
      const era = currentEra();
      if (era === undefined) return;
      const fromRaw = fromInput.value.trim();
      const toRaw = toInput.value.trim();
      const from = fromRaw === "" ? era.from : Number(fromRaw);
      const to = toRaw === "" ? undefined : Number(toRaw);
      if (!Number.isFinite(from) || (to !== undefined && !Number.isFinite(to))) {
        paintSpan(era);
        return;
      }
      if (from === era.from && to === era.to) return;
      guarded(() => ctx.store.update((s) => setSpan(s.world, name, from, to), { history: true }));
    }

    function onDelete(): void {
      guarded(() => {
        ctx.store.update((s) => removeEra(s.world, name), { history: true });
        ctx.windows.close(eraWindowId(name));
      });
    }

    function openPlaylist(): void {
      const era = currentEra();
      if (era === undefined) return;
      const epoch = ctx.calendar()?.epochYear ?? ctx.plugin.settings.calendar.epochYear ?? 1;
      const bounds: ZoomBounds = { min: epoch - PLAYLIST_BOUNDS_BEFORE, max: epoch + PLAYLIST_BOUNDS_AFTER };
      const b = (era.to ?? era.from + OPEN_ENDED_SPAN_YEARS) + 1;
      const w: Window = clampWindow({ a: era.from, b }, bounds);
      ctx.store.update((s) => {
        s.view.window = w;
      });
      ctx.view.app.workspace.requestSaveLayout();
    }

    function openAddOpMenu(ev: MouseEvent): void {
      const menu = new Menu();
      let lastChannel: Channel | null = null;
      for (const choice of OP_CHOICES) {
        if (lastChannel !== null && choice.channel !== lastChannel) menu.addSeparator();
        lastChannel = choice.channel;
        menu.addItem((item) =>
          item.setTitle(`${CHANNEL_LABEL[choice.channel]} · ${choice.label}`).onClick(() => {
            const op = choice.make();
            guarded(() => ctx.store.update((s) => addOp(s.world, name, op), { history: true }));
          }),
        );
      }
      menu.showAtMouseEvent(ev);
    }

    // --- ops list ------------------------------------------------------------

    function drawOps(era: Era | undefined): void {
      for (const row of opRows) {
        row.led.destroy();
        row.knob.destroy();
      }
      opRows = [];
      opsList.empty();
      const apply = era?.apply ?? [];
      apply.forEach((op, i) => {
        const row = opsList.createDiv({ cls: "wadjet-studio-era-op", attr: { "data-index": String(i), "data-part": "era-op" } });
        const led = createLed(row, {
          on: op.enabled !== false,
          level: "ok",
          scope: "op",
          hint: eraHint("era.opLed"),
          onToggle: (on) => guarded(() => ctx.store.update((s) => setOpEnabled(s.world, name, i, on), { history: true })),
        });
        const spec = knobSpecFor(op);
        const opSpec = { min: spec.min, max: spec.max, neutral: spec.neutral, step: spec.step };
        const isOffset = op.op === "offset";
        const q = opQuantity(op.param, isOffset);
        const knob = createKnob(row, {
          spec: opSpec,
          value: opValue(op),
          label: op.param,
          fmt: opFmt(op.param, isOffset, ctx.units(), spec.fmt),
          hint: eraHint("era.op"),
          ...(q !== null ? { parse: (text: string) => parseDisplay(opSpec, q, ctx.units())(text) } : {}),
          onChange: (value, phase) =>
            guarded(() => {
              ctx.store.update((s) => setOpValue(s.world, name, i, value));
              if (phase !== "drag") ctx.store.snapshot();
            }),
        });
        const remove = row.createDiv({
          cls: "wadjet-studio-era-op-x",
          text: "×",
          attr: { role: "button", tabindex: "0", "aria-label": `Remove ${op.param}`, "data-hint": eraHint("era.opRemove"), "data-part": "era-op-remove" },
        });
        const fireRemove = (): void => guarded(() => ctx.store.update((s) => removeOp(s.world, name, i), { history: true }));
        remove.addEventListener("click", fireRemove);
        remove.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          fireRemove();
        });
        led.el.setAttr("data-part", "era-op-led");
        knob.el.setAttr("data-part", "era-op-knob");
        opRows.push({ led, knob });
      });
      note.setText(apply.length === 0 ? `tag only — this era adds ${ERA_TAG_PREFIX}${name} to every day and changes nothing else` : "");
      note.toggleClass("is-hidden", apply.length > 0);
    }

    // --- paint -------------------------------------------------------------

    function paintSpan(era: Era | undefined): void {
      if (era === undefined) return;
      if (document.activeElement !== fromInput) fromInput.value = String(era.from);
      if (document.activeElement !== toInput) toInput.value = era.to === undefined ? "" : String(era.to);
    }

    function issues(): StudioIssue[] {
      const state = ctx.store.get();
      const zone = zoneForIssues(state);
      if (zone === null) return [];
      const description = ctx.calendar();
      const readOnlyCalendar = description?.readOnly ?? false;
      const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
      const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
      const all = issuesFor({ zone, eras: state.world.eras, seasons, moons, readOnlyCalendar });
      const mine = unitKey({ kind: "era", name });
      return all.filter((i) => unitKey(i.unit) === mine);
    }

    function repaint(force: boolean): void {
      const state = ctx.store.get();
      const era = currentEra(state);
      const zones = Object.keys(state.zones).length;
      const key = `${JSON.stringify(era)}|${zones}|${ctx.units()}`;
      if (!force && key === signature) return;
      signature = key;

      if (document.activeElement !== nameInput) nameInput.value = era?.name ?? name;
      enabledLed.update({ on: era?.enabled !== false, level: ledLevel(issues()) });
      worldChip.update({ label: `world · ${zones} ${zones === 1 ? "zone" : "zones"}` });
      paintSpan(era);
      drawOps(era);
    }

    // --- controls built once -------------------------------------------------

    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        nameInput.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        repaint(true);
        nameInput.blur();
      }
    });
    nameInput.addEventListener("blur", () => commitName(nameInput.value));

    for (const input of [fromInput, toInput]) {
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          input.blur();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          repaint(true);
          input.blur();
        }
      });
      input.addEventListener("blur", () => commitSpan());
    }

    const firePlaylist = (): void => openPlaylist();
    playlistButton.addEventListener("click", firePlaylist);
    playlistButton.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      firePlaylist();
    });

    addOpButton.addEventListener("click", (ev) => openAddOpMenu(ev));
    addOpButton.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      const rect = addOpButton.getBoundingClientRect();
      openAddOpMenu(new MouseEvent("click", { clientX: rect.left, clientY: rect.bottom }));
    });

    const fireDelete = (): void => onDelete();
    deleteButton.addEventListener("click", fireDelete);
    deleteButton.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      fireDelete();
    });

    unsubscribe = ctx.store.subscribe(() => repaint(false));
    repaint(true);

    // --- pull-based readouts ----------------------------------------------

    function writes(): string {
      const state = ctx.store.get();
      const at = state.world.eras.findIndex((e) => e.name === name);
      if (at < 0) return `world.eras — no era named "${name}"`;
      return `world.eras[${at}] · ${JSON.stringify(state.world.eras[at])}`;
    }

    return {
      title: name,
      badge: "ERA",
      body: root,
      led: { on: true, scope: "device" },
      level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "era", name }))),
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        enabledLed.destroy();
        worldChip.destroy();
        for (const row of opRows) {
          row.led.destroy();
          row.knob.destroy();
        }
        root.remove();
      },
    };
  };
}

/**
 * Register one panel per era the world draft knows about. Called on every
 * tick by `eras-surface.ts`, so an era added, renamed or removed elsewhere
 * becomes openable without a rebuild, and `windows.restore()` finds a builder
 * for every `era:*` id the leaf remembered.
 */
export function registerEraWindows(ctx: SurfaceContext): void {
  for (const era of ctx.store.get().world.eras) ctx.windows.register(eraWindowId(era.name), buildEraWindow(era.name));
}
