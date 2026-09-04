/**
 * The Era window (SPEC §3.4 "Era", §2 "world · N zones").
 *
 * One panel per era, id `era:<name>`. Everything it writes lands in
 * `world.eras[i]` (`model/era-edit.ts`), which is world scope: the panel
 * carries a `world · N zones` chip and every edit here goes through the
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
 *  - **The one title row is drawn here and handed to the chrome's head slot.**
 *    The prototype's row (LED · name · ERA · world · N zones · delete · ×) is
 *    fully interactive — a live power LED and a click-to-edit name — and the
 *    chrome's own LED/title/badge (`components/window.ts`) are static: `led`
 *    is captured once at open and never re-reads `on`, and `title`/`badge`
 *    are plain text. So this file paints the whole row itself, and still hands
 *    the chrome `title`/`badge` the same strings (`name`/`"ERA"`) so the e2e's
 *    chrome probes and a screen reader's dialog label stay correct. The era
 *    section of `styles.css` hides those two chrome nodes and the head goes
 *    into the chrome's own head slot (`components/window.ts`'s `head`), so the
 *    panel wears ONE 37 px bar rather than a dead strip above a second one.
 *    It is REAL bar content now rather than a `pointer-events: none` overlay,
 *    which is what gives the `world` chip its hint reach back; the bar's drag
 *    skips the head's own controls instead, which is what keeps the bar
 *    draggable and its close × clickable underneath.
 */
import { Menu } from "obsidian";
import { ERA_TAG_PREFIX } from "../../../core/eras";
import type { Era, ModifierOp, ZoneProfile } from "../../../core/types";
import { channelOf, type Channel } from "../../model/compile";
import { paramName, opGloss } from "../../model/copy";
import { knobRangeOf, knobSpecFor } from "../../model/devices";
import { addOp, removeEra, removeOp, renameEra, setEnabled, setOpEnabled, setOpValue, setSpan } from "../../model/era-edit";
import { eraHint } from "../../model/hints-era";
import { opFmt, opQuantity, parseDisplay } from "../../model/knob-units";
import type { StudioState } from "../../model/state";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { needsWorldConfirm } from "../../model/world-confirm";
import { clampWindow, worldBounds, type Window, type ZoomBounds } from "../../model/zoom";
import { createChip, createKnob, createLed, type ChipComponent, type KnobComponent, type LedComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";

/** Window ids are `era:<name>` — one panel per era, opened by name. */
export const ERA_WINDOW_PREFIX = "era:";

export function eraWindowId(name: string): string {
  return `${ERA_WINDOW_PREFIX}${name}`;
}

/** `⤢ playlist`'s open-ended span: a century past `from` when `to` is unset. */
const OPEN_ENDED_SPAN_YEARS = 100;

/** The channel colour an apply knob's arc/value takes on (SPEC §9 "colour reserved for data"). */
const CHANNEL_COLOR: Record<Channel, string> = {
  temperature: "var(--wadjet-studio-temp)",
  precipitation: "var(--wadjet-studio-precip)",
  wind: "var(--wadjet-studio-wind)",
  sky: "var(--wadjet-studio-sky)",
};

interface EraApplyChoice {
  param: string;
  make(): ModifierOp;
}

/**
 * The curated "＋" menu (prototype `Component.ERA_TARGETS`): one param per
 * channel, not the whole `paramsByChannel` picker a device gets — an era's
 * apply list is meant to stay short. Defaults match the prototype's own.
 */
const ERA_APPLY_CHOICES: readonly EraApplyChoice[] = [
  { param: "temperature.mean", make: () => ({ param: "temperature.mean", op: "offset", value: -4 }) },
  { param: "precipitation.pwd", make: () => ({ param: "precipitation.pwd", op: "scale", value: 0.7 }) },
  { param: "wind.speed", make: () => ({ param: "wind.speed", op: "scale", value: 1.3 }) },
  { param: "cloud.dry", make: () => ({ param: "cloud.dry", op: "offset", value: 0.1 }) },
];

/** `set`/`offset`/`scale` carry a plain numeric `value`; a `clamp` op has none and reads as 0. */
function opValue(op: ModifierOp): number {
  return "value" in op && typeof op.value === "number" ? op.value : 0;
}

/** `701 yr`, or `open-ended · since 1200` when `to` is unset (prototype `eraSelYears`). */
function spanYears(era: Era): string {
  if (era.to === undefined) return `open-ended · since ${era.from}`;
  return `${era.to - era.from + 1} yr`;
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

    // --- the ONE title row (SPEC §3.4): LED · name · ERA · world · N zones · delete ---
    // Built detached and handed to the chrome's head slot by `head` below, so
    // it IS the bar's content rather than an overlay floated across it.
    const head = createDiv({ cls: "wadjet-studio-era-head is-tail" });
    const enabledLed: LedComponent = createLed(head, {
      on: true,
      level: "ok",
      scope: "device",
      hint: eraHint("era.enabled"),
      onToggle: (on) => guarded(() => ctx.store.update((s) => setEnabled(s.world, name, on), { history: true })),
    });
    const nameInput = head.createEl("input", { cls: "wadjet-studio-era-name", type: "text", attr: { spellcheck: "false", "data-hint": eraHint("era.name"), "data-part": "era-name" } });
    head.createSpan({ cls: "wadjet-studio-era-badge", text: "ERA" });
    const worldChip: ChipComponent = createChip(head, { label: "world · 0 zones", hint: eraHint("era.world") });
    const deleteButton = head.createDiv({
      cls: "wadjet-studio-era-btn",
      text: "delete",
      attr: { role: "button", tabindex: "0", "aria-label": "Delete era", "data-hint": eraHint("era.delete"), "data-part": "era-delete" },
    });
    enabledLed.el.setAttr("data-part", "era-led");
    worldChip.el.setAttr("data-part", "era-world");

    // --- SPAN section ---
    root.createDiv({ cls: "wadjet-studio-era-span-caption", text: "SPAN · calendar years, inclusive" });
    const spanRow = root.createDiv({ cls: "wadjet-studio-era-span" });
    const fromInput = spanRow.createEl("input", { cls: "wadjet-studio-era-span-from wadjet-studio-num", type: "number", attr: { "data-hint": eraHint("era.from"), "data-part": "era-from" } });
    spanRow.createSpan({ cls: "wadjet-studio-era-span-dash", text: "–" });
    const toInput = spanRow.createEl("input", { cls: "wadjet-studio-era-span-to wadjet-studio-num", type: "number", attr: { placeholder: "∞", "data-hint": eraHint("era.to"), "data-part": "era-to" } });
    const yearsReadout = spanRow.createSpan({ cls: "wadjet-studio-era-span-years" });
    spanRow.createDiv({ cls: "wadjet-studio-era-span-spacer" });
    const playlistButton = spanRow.createDiv({
      cls: "wadjet-studio-era-btn",
      text: "⤢ playlist",
      attr: { role: "button", tabindex: "0", "aria-label": "Zoom the playlist to this era", "data-hint": eraHint("era.playlist"), "data-part": "era-playlist" },
    });

    // --- the always-on "every day carries era:<name>" readout ---
    const carries = root.createDiv({ cls: "wadjet-studio-era-carries" });
    carries.createSpan({ text: "every day carries " });
    const carriesTag = carries.createSpan({ cls: "wadjet-studio-era-carries-tag" });

    // --- APPLY section ---
    root.createDiv({ cls: "wadjet-studio-era-apply-caption", text: "APPLY · every zone, after its own devices" });
    const opsList = root.createDiv({ cls: "wadjet-studio-era-ops", attr: { "data-part": "era-ops" } });
    const addOpButton = opsList.createDiv({
      cls: "wadjet-studio-era-op-add",
      attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "aria-label": "Add an apply target", "data-hint": eraHint("era.opAdd") },
    });
    addOpButton.createSpan({ cls: "wadjet-studio-era-op-add-glyph", text: "＋" });
    addOpButton.createSpan({ cls: "wadjet-studio-era-op-add-label", text: "apply" });
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
      const bounds: ZoomBounds = worldBounds(epoch, ctx.store.get().world.eras);
      const b = (era.to ?? era.from + OPEN_ENDED_SPAN_YEARS) + 1;
      const w: Window = clampWindow({ a: era.from, b }, bounds);
      ctx.store.update((s) => {
        s.view.window = w;
      });
      ctx.view.app.workspace.requestSaveLayout();
    }

    function openAddOpMenu(ev: MouseEvent): void {
      const era = currentEra();
      const applied = new Set((era?.apply ?? []).map((op) => op.param));
      const choices = ERA_APPLY_CHOICES.filter((c) => !applied.has(c.param));
      if (choices.length === 0) return;
      const menu = new Menu();
      for (const choice of choices) {
        menu.addItem((item) =>
          item.setTitle(paramName(choice.param)).onClick(() => {
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
      opsList.querySelectorAll(".wadjet-studio-era-op").forEach((el) => el.remove());
      const apply = era?.apply ?? [];
      apply.forEach((op, i) => {
        // `offset · temperature.mean` is the column's HINT, not a fourth line
        // of gloss under the value (prototype `data-hint="{{ ap.field }}"`).
        const col = createDiv({ cls: "wadjet-studio-era-op", attr: { "data-index": String(i), "data-part": "era-op", "data-hint": opGloss(op) } });
        opsList.insertBefore(col, addOpButton);
        const remove = col.createDiv({
          cls: "wadjet-studio-era-op-x",
          text: "×",
          attr: { role: "button", tabindex: "0", "aria-label": `Remove ${paramName(op.param)}`, "data-hint": eraHint("era.opRemove"), "data-part": "era-op-remove" },
        });
        const spec = knobSpecFor(op, "era");
        const opSpec = knobRangeOf(spec);
        const isOffset = op.op === "offset";
        const q = opQuantity(op.param, isOffset);
        const color = CHANNEL_COLOR[channelOf(op.param)];
        const knob = createKnob(col, {
          spec: opSpec,
          value: opValue(op),
          label: paramName(op.param),
          fmt: opFmt(op.param, isOffset, ctx.units(), spec.fmt),
          color,
          size: "lg",
          hint: eraHint("era.op"),
          ...(q !== null ? { parse: (text: string) => parseDisplay(opSpec, q, ctx.units())(text) } : {}),
          onChange: (value, phase) =>
            guarded(() => {
              ctx.store.update((s) => setOpValue(s.world, name, i, value));
              if (phase !== "drag") ctx.store.snapshot();
            }),
        });
        // The mute lamp rides ON the knob's own label line, ahead of the label
        // (prototype: knob · LED + label · value), not on a line of its own.
        const labelEl = knob.el.querySelector<HTMLElement>(".wadjet-studio-knob-label")!;
        const led = createLed(labelEl, {
          on: op.enabled !== false,
          level: "ok",
          scope: "op",
          hint: eraHint("era.opLed"),
          onToggle: (on) => guarded(() => ctx.store.update((s) => setOpEnabled(s.world, name, i, on), { history: true })),
        });
        labelEl.insertBefore(led.el, labelEl.firstChild);
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
      note.setText(apply.length === 0 ? `tag only · zone devices gate on ${ERA_TAG_PREFIX}${name}` : "");
      note.toggleClass("is-hidden", apply.length > 0);
    }

    // --- paint -------------------------------------------------------------

    function paintSpan(era: Era | undefined): void {
      if (era === undefined) return;
      if (document.activeElement !== fromInput) fromInput.value = String(era.from);
      if (document.activeElement !== toInput) toInput.value = era.to === undefined ? "" : String(era.to);
      yearsReadout.setText(spanYears(era));
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
      carriesTag.setText(`${ERA_TAG_PREFIX}${era?.name ?? name}`);
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

    /** One op as the prototype's authored WRITES clause: `offset[temperature.mean −8.0 °C]`. */
    function eraOpToken(op: ModifierOp): string {
      const spec = knobSpecFor(op, "era");
      const isOffset = op.op === "offset";
      const fmt = opFmt(op.param, isOffset, ctx.units(), spec.fmt);
      return `${op.op}[${op.param} ${fmt(opValue(op))}]`;
    }

    function writes(): string {
      const state = ctx.store.get();
      const at = state.world.eras.findIndex((e) => e.name === name);
      if (at < 0) return `world.eras — no era named "${name}"`;
      const era = state.world.eras[at]!;
      const apply = era.apply ?? [];
      const fields = [`"name": "${era.name}"`, `"from": ${era.from}`];
      if (era.to !== undefined) fields.push(`"to": ${era.to}`);
      if (apply.length > 0) fields.push(`"apply": [ ${apply.map(eraOpToken).join(", ")} ]`);
      return `world.eras[${at}] { ${fields.join(", ")} }`;
    }

    return {
      title: name,
      // Prototype width (`proto-markup/`): a design constant, not a function of the content.
      width: 352,
      badge: "ERA",
      head: (slot) => slot.appendChild(head),
      body: root,
      writes,
      issues,
      onClose: () => {
        unsubscribe?.();
        unsubscribe = null;
        enabledLed.destroy();
        worldChip.destroy();
        head.remove();
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
