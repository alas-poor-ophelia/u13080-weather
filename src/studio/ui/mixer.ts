/**
 * The mixer rail (SPEC §3.3).
 *
 * Four chain blocks — TEMP · PRECIP · WIND · SKY — then MASTER. Each block is
 * a header (colour bar, name, `＋`), the **fixed strip** (Regimes / Forcings)
 * and the rack of unit cards for everything else that writes to that channel.
 *
 * What is worth knowing before editing this file:
 *
 *  - **It derives nothing.** Every card, chip, slot number and mute state
 *    comes from `model/mixer.ts`; this file paints it and routes clicks back
 *    through the same module's setters. `issuesFor` is run once per render
 *    (memoised on the canonical JSON of its inputs, as the header does) and
 *    every LED level is one `Map` lookup off it.
 *  - **The LED and the name are the only handles** (SPEC law 2), plus the grip
 *    on a reorderable device card. The LED is per-chain mute (device power for
 *    a single-chain unit, era power for an era unit); the name opens the
 *    thing's window; the grip drags the card within its own chain. `＋` opens
 *    the insert picker (`ui/insert-picker.ts`, SPEC §3.6) anchored under it.
 *  - **A drag must not depend on component identity surviving a store tick.**
 *    `drag` below freezes the dragged card's chain-local order and every
 *    card's viewport rect at grip-down, so a repaint mid-drag (another
 *    surface's tick, a window resize) can rebuild `b.units` under the drag
 *    without moving the goalposts — `unitElFor` re-resolves the live element
 *    by id on every phase instead of closing over a captured node.
 *  - **A window that has not been registered yet is a no-op, not a crash.**
 *    `windows.open("device:<id>")` returns quietly until bead wadjet-9f9.24
 *    registers the generic device panel, so this file can ship first.
 *  - **The fixed strip's expansion is view state**, persisted per chain in
 *    `view.fixedOpen` — `store.update` with no history, then
 *    `requestSaveLayout` (PLAN D14: view state is not the document).
 */
import { canonicalJson } from "../../core/profile";
import type { ZoneProfile } from "../../core/types";
import type { Units } from "../../core/units";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { getWetness, totalWarmthAt } from "../model/compile";
import { setEnabled } from "../model/era-edit";
import { format } from "../model/format";
import { mixerHint } from "../model/hints-mixer";
import { CHAIN_COLOR_VAR, CHAIN_LABEL, CHAINS, eraNameOf, fixedStripFor, isEraUnit, reorderInChain, setChainMute, setForcingsChainMute, setRegimesChainMute, unitsFor, type Chain, type FixedStrip, type UnitCard } from "../model/mixer";
import type { StudioState } from "../model/state";
import { issuesByUnit, issuesFor, ledLevel, unitKey, type StudioIssue } from "../model/validation";
import { createLed, createRackUnit, type GripPhase, type LedComponent, type LedLevel, type RackUnitComponent } from "./components";
import { openInsertPicker } from "./insert-picker";
import type { Surface, SurfaceContext } from "./surfaces";
import { buildForcingsWindow, FORCINGS_WINDOW } from "./windows/forcings";
import { buildRegimesWindow, REGIMES_WINDOW } from "./windows/regimes";
import { confirmWorldEdit } from "./world-confirm-modal";

/** The id prefix bead wadjet-9f9.24 registers the generic device panel under. */
export const DEVICE_WINDOW_PREFIX = "device:";

/** The fixed slots at the top of a chain, outside the numbered rack (SPEC §3.3). */
const REGIMES_SLOT = "00";
const FORCINGS_SLOT = "FRC";
const MASTER_SLOT = "M";

/** `+1.4 °C` / `−0.5 °C` — the warmth readout, in the reader's units. */
function warmthText(total: number, units: Units): string {
  const f = format(total, "temperatureDelta", units, { signed: true });
  return `${f.text} ${f.unit}`;
}

/** `×1.25` — the wetness readout. The unit *is* the multiplication sign. */
function wetnessText(k: number, units: Units): string {
  const f = format(k, "factor", units);
  return `${f.unit}${f.text}`;
}

/** `Regimes 3 states`, singular when there is one. */
function regimesText(count: number): string {
  return `Regimes ${count} ${count === 1 ? "state" : "states"}`;
}

/** `Forcings +0.0 °C` in TEMP, `Forcings ×1.00` in PRECIP. */
function forcingsText(strip: FixedStrip, chain: Chain, units: Units): string {
  const f = strip.forcings;
  if (f === null) return "Forcings";
  return `Forcings ${chain === "temperature" ? warmthText(f.total, units) : wetnessText(f.total, units)}`;
}

/** A span that behaves like a button for the pointer and the keyboard alike. */
function clickable(el: HTMLElement, hint: string, onClick: () => void): HTMLElement {
  el.setAttrs({ role: "button", tabindex: "0", "data-hint": hint });
  el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick();
  });
  el.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  return el;
}

/** Everything one chain block owns. The rack is rebuilt only when its model moves. */
interface ChainBlock {
  chain: Chain;
  el: HTMLElement;
  strip: HTMLElement;
  stripRow: HTMLElement;
  regimesLed: LedComponent;
  regimesName: HTMLElement;
  stripDot: HTMLElement;
  forcingsLed: LedComponent;
  forcingsName: HTMLElement;
  toggle: HTMLElement;
  fixedRack: HTMLElement;
  rack: HTMLElement;
  empty: HTMLElement;
  fixedUnits: RackUnitComponent[];
  units: RackUnitComponent[];
  /** the cards `units` was last built from, 1:1 by index — a drag reads this, never the model directly */
  cards: readonly UnitCard[];
  /** signature of the last painted rack, so an unchanged tick touches no DOM */
  key: string;
}

/**
 * One in-flight rack-unit drag. Frozen at grip-down (see the file docstring):
 * `order` and `rects` never move once a drag starts, even if a store tick
 * rebuilds the DOM under it.
 */
interface DragState {
  chain: Chain;
  id: string;
  /** this chain's reorderable ids, in on-drag-start order */
  order: string[];
  /** each of those ids' viewport rect, captured once at drag start */
  rects: Map<string, DOMRect>;
}

/** What the header memoises too: the validation surface, per unique draft. */
interface Derived {
  issues: StudioIssue[];
}

export function createMixerSurface(): Surface {
  let ctx: SurfaceContext | null = null;
  let blocks: ChainBlock[] = [];
  let master: { el: HTMLElement; unit: RackUnitComponent; key: string } | null = null;
  let memoKey = "";
  let memo: Derived = { issues: [] };
  /** the one in-flight rack-unit drag, if any (see the file docstring) */
  let drag: DragState | null = null;

  // --- state helpers -------------------------------------------------------

  function zoneOf(state: StudioState): ZoneProfile | null {
    const id = state.view.zoneId;
    return id === null ? null : (state.zones[id] ?? null);
  }

  /**
   * The same memo the header keeps: `issuesFor` walks the whole draft, and a
   * knob drag repaints every frame. Keyed on the canonical JSON of exactly the
   * inputs the validators read, so a value put back never re-derives.
   */
  function derive(state: StudioState): Derived {
    const c = ctx;
    const zone = zoneOf(state);
    if (c === null || zone === null) return { issues: [] };
    const description = c.calendar();
    const readOnlyCalendar = description?.readOnly ?? false;
    const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
    const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
    const key = `${canonicalJson(zone)}|${canonicalJson(state.world.eras)}|${canonicalJson(seasons)}|${canonicalJson(moons)}|${String(readOnlyCalendar)}`;
    if (key === memoKey) return memo;
    memo = { issues: issuesFor({ zone, eras: state.world.eras, seasons, moons, readOnlyCalendar }) };
    memoKey = key;
    return memo;
  }

  /** Edit the pointed-at zone draft as one undoable action. */
  function editZone(edit: (z: ZoneProfile) => void): void {
    ctx?.store.update(
      (s) => {
        const id = s.view.zoneId;
        const zone = id === null ? undefined : s.zones[id];
        if (zone === undefined) return;
        edit(zone);
      },
      { history: true },
    );
  }

  function toggleFixed(chain: Chain): void {
    const c = ctx;
    if (c === null) return;
    c.store.update((s) => {
      s.view.fixedOpen[chain] = !(s.view.fixedOpen[chain] === true);
    });
    c.view.app.workspace.requestSaveLayout();
  }

  function openWindow(id: string): void {
    ctx?.windows.open(id);
  }

  /** Gate a world-scoped write behind the session's one confirm (SPEC §2). */
  function withWorldConfirm(run: () => void): void {
    const c = ctx;
    if (c === null) return;
    confirmWorldEdit(c.plugin.app, c, "eras", run);
  }

  // --- drag-reorder ----------------------------------------------------------

  /**
   * The live element for `id` in `b`, resolved fresh every call — never a
   * captured reference. `b.units`/`b.cards` can be rebuilt mid-drag by an
   * unrelated store tick; looking the id up again each time is what keeps the
   * drag working across that (see the file docstring).
   */
  function unitElFor(b: ChainBlock, id: string): HTMLElement | null {
    const i = b.cards.findIndex((c) => c.id === id);
    return i === -1 ? null : (b.units[i]?.el ?? null);
  }

  /**
   * Standard array-move "to" index: how many of the drag's *other* cards now
   * sit above the dragged card's current centre. Dropping back where it
   * started yields the same index the drag began at.
   */
  function dropIndexFor(d: DragState, dy: number): number {
    const dragged = d.rects.get(d.id);
    if (dragged === undefined) return d.order.indexOf(d.id);
    const center = dragged.top + dragged.height / 2 + dy;
    let index = 0;
    for (const id of d.order) {
      if (id === d.id) continue;
      const rect = d.rects.get(id);
      if (rect !== undefined && center > rect.top + rect.height / 2) index++;
    }
    return index;
  }

  function endDrag(b: ChainBlock, id: string): void {
    const el = unitElFor(b, id);
    el?.toggleClass("is-dragging", false);
    el?.setCssProps({ "--wadjet-studio-drag-y": "0px" });
    window.removeEventListener("keydown", onDragKeyDown);
    drag = null;
  }

  /** ESC cancels the drag in progress without writing anything (SPEC §3.8). */
  function onDragKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape" || drag === null) return;
    ev.preventDefault();
    const b = blocks.find((x) => x.chain === drag!.chain);
    if (b) endDrag(b, drag.id);
    else {
      window.removeEventListener("keydown", onDragKeyDown);
      drag = null;
    }
  }

  /** `rack-unit.ts`'s grip callback: start snapshots, drag repaints the ghost, end commits. */
  function handleGrip(b: ChainBlock, card: UnitCard, phase: GripPhase, dy: number): void {
    if (phase === "start") {
      const order = b.cards.filter((c) => c.reorderable).map((c) => c.id);
      const rects = new Map<string, DOMRect>();
      for (const id of order) {
        const el = unitElFor(b, id);
        if (el) rects.set(id, el.getBoundingClientRect());
      }
      drag = { chain: b.chain, id: card.id, order, rects };
      unitElFor(b, card.id)?.toggleClass("is-dragging", true);
      window.addEventListener("keydown", onDragKeyDown);
      return;
    }
    // A card the drag no longer recognises (rebuilt under it, or a stray
    // event after ESC already cleared `drag`) never writes.
    if (drag === null || drag.id !== card.id) return;
    if (phase === "drag") {
      unitElFor(b, card.id)?.setCssProps({ "--wadjet-studio-drag-y": `${dy}px` });
      return;
    }
    const fromSlot = drag.order.indexOf(drag.id);
    const toSlot = dropIndexFor(drag, dy);
    const chain = drag.chain;
    endDrag(b, card.id);
    if (toSlot !== fromSlot) editZone((z) => reorderInChain(z, chain, fromSlot, toSlot));
  }

  // --- building ------------------------------------------------------------

  function buildChain(parent: HTMLElement, chain: Chain): ChainBlock {
    const el = parent.createDiv({ cls: "wadjet-studio-mixer-chain", attr: { "data-chain": chain } });
    el.setCssProps({ "--wadjet-studio-chain-color": CHAIN_COLOR_VAR[chain] });

    const head = el.createDiv({ cls: "wadjet-studio-mixer-head", attr: { "data-hint": mixerHint("mixer.chain") } });
    head.createDiv({ cls: "wadjet-studio-mixer-bar" });
    head.createSpan({ cls: "wadjet-studio-mixer-title", text: CHAIN_LABEL[chain] });
    const add = clickable(head.createDiv({ cls: "wadjet-studio-mixer-add", text: "＋" }), mixerHint("mixer.insert"), () => {
      if (ctx !== null) openInsertPicker(ctx, chain, add);
    });
    add.setAttrs({ "aria-label": "Insert a device", "data-part": "insert" });

    const strip = el.createDiv({ cls: "wadjet-studio-strip" });
    const stripRow = strip.createDiv({ cls: "wadjet-studio-strip-row" });
    const regimesLed = createLed(stripRow, { on: true, scope: "chain", hint: mixerHint("mixer.regimes.led"), onToggle: (on) => editZone((z) => setRegimesChainMute(z, chain, !on)) });
    const regimesName = clickable(stripRow.createSpan({ cls: "wadjet-studio-strip-name" }), mixerHint("mixer.regimes.name"), () => openWindow(REGIMES_WINDOW));
    const stripDot = stripRow.createSpan({ cls: "wadjet-studio-strip-dot", text: "·" });
    const forcingsLed = createLed(stripRow, { on: true, scope: "chain", hint: mixerHint("mixer.forcings.led"), onToggle: (on) => editZone((z) => setForcingsChainMute(z, chain, !on)) });
    const forcingsName = clickable(stripRow.createSpan({ cls: "wadjet-studio-strip-name" }), mixerHint("mixer.forcings.name"), () => openWindow(FORCINGS_WINDOW));
    const toggle = clickable(stripRow.createSpan({ cls: "wadjet-studio-strip-toggle", text: "▸" }), mixerHint("mixer.strip"), () => toggleFixed(chain));

    regimesLed.el.setAttr("data-part", "regimes-led");
    regimesName.setAttr("data-part", "regimes-name");
    forcingsLed.el.setAttr("data-part", "forcings-led");
    forcingsName.setAttr("data-part", "forcings-name");
    toggle.setAttr("data-part", "strip-toggle");

    const fixedRack = strip.createDiv({ cls: "wadjet-studio-strip-open" });
    const rack = el.createDiv({ cls: "wadjet-studio-mixer-rack" });
    const empty = el.createDiv({ cls: "wadjet-studio-mixer-empty", text: "no inserts · ＋ to add a device", attr: { "data-hint": mixerHint("mixer.empty") } });

    return { chain, el, strip, stripRow, regimesLed, regimesName, stripDot, forcingsLed, forcingsName, toggle, fixedRack, rack, empty, fixedUnits: [], units: [], cards: [], key: "" };
  }

  // --- painting ------------------------------------------------------------

  /** The fixed units as rack cards, shown when the strip is expanded. */
  function paintFixedRack(b: ChainBlock, zone: ZoneProfile, strip: FixedStrip, levels: { regimes: LedLevel; forcings: LedLevel }, u: Units): void {
    for (const unit of b.fixedUnits) unit.destroy();
    b.fixedUnits = [];
    const color = CHAIN_COLOR_VAR[b.chain];

    b.fixedUnits.push(
      createRackUnit(b.fixedRack, {
        slot: REGIMES_SLOT,
        name: "Regimes",
        kind: "STATES",
        color,
        grip: false,
        chips: zone.regimes.map((r) => ({ label: `${r.id} · ${r.meanDurationDays} d`, hint: mixerHint("mixer.regimes.name") })),
        led: { on: !strip.regimes.mutedInChain, level: levels.regimes, scope: "chain", hint: mixerHint("mixer.regimes.led"), onToggle: (on) => editZone((z) => setRegimesChainMute(z, b.chain, !on)) },
        onOpen: () => openWindow(REGIMES_WINDOW),
      }),
    );

    if (strip.forcings !== null) {
      const readout = b.chain === "temperature" ? warmthText(strip.forcings.total, u) : wetnessText(strip.forcings.total, u);
      b.fixedUnits.push(
        createRackUnit(b.fixedRack, {
          slot: FORCINGS_SLOT,
          name: "Forcings",
          kind: "ZONE",
          color,
          grip: false,
          chips: [{ label: `${b.chain === "temperature" ? "warmth" : "wetness"} ${readout}`, ...(strip.forcings.present ? { color } : {}), hint: mixerHint("mixer.forcings.name") }],
          led: { on: !strip.forcings.mutedInChain, level: levels.forcings, scope: "chain", hint: mixerHint("mixer.forcings.led"), onToggle: (on) => editZone((z) => setForcingsChainMute(z, b.chain, !on)) },
          onOpen: () => openWindow(FORCINGS_WINDOW),
        }),
      );
    }
  }

  /**
   * One card per unit. Eras carry the `world` badge and never drag, but their
   * LED is real power (`world.eras[i].enabled`, guarded behind the world
   * confirm) — not read-only.
   */
  function paintRack(b: ChainBlock, cards: readonly UnitCard[], byUnit: Map<string, StudioIssue[]>): void {
    for (const unit of b.units) unit.destroy();
    b.units = [];
    b.cards = cards;
    const color = CHAIN_COLOR_VAR[b.chain];

    for (const card of cards) {
      const era = isEraUnit(card);
      const level = ledLevel(byUnit.get(era ? card.id : `device:${card.id}`));
      const on = card.enabled && !card.mutedInChain;
      const grip = card.reorderable ? { onGrip: (phase: GripPhase, dy: number) => handleGrip(b, card, phase, dy) } : {};
      const unit = createRackUnit(b.rack, {
        slot: card.slot,
        name: card.name,
        kind: card.kind,
        color,
        linked: card.linked,
        ...(card.world === undefined ? {} : { world: card.world }),
        grip: card.reorderable,
        chips: card.chips,
        led: era
          ? { on, level, scope: "device", hint: mixerHint("mixer.era.led"), onToggle: (next) => withWorldConfirm(() => ctx?.store.update((s) => setEnabled(s.world, eraNameOf(card), next), { history: true })) }
          : { on, level, scope: card.linked ? "chain" : "device", hint: mixerHint("mixer.unit.led"), onToggle: (next) => editZone((z) => setChainMute(z, card.id, b.chain, !next)) },
        onOpen: () => openWindow(era ? card.id : DEVICE_WINDOW_PREFIX + card.id),
        ...grip,
      });
      unit.el.setAttrs({ "data-unit": card.id, "data-slot": card.slot });
      if (card.reorderable) unit.el.querySelector(".wadjet-studio-rack-grip")?.setAttr("data-hint", mixerHint("mixer.unit.grip"));
      unit.el.querySelector(".wadjet-studio-rack-name")?.setAttr("data-hint", era ? mixerHint("mixer.era.name") : mixerHint("mixer.unit.name"));
      b.units.push(unit);
    }
  }

  function paintChain(b: ChainBlock, zone: ZoneProfile | null, state: StudioState, byUnit: Map<string, StudioIssue[]>, calendar: CalendarDescription | null): void {
    if (zone === null) {
      b.strip.toggleClass("is-hidden", true);
      b.rack.toggleClass("is-hidden", true);
      b.empty.toggleClass("is-hidden", false);
      if (b.key !== "") {
        for (const unit of [...b.units, ...b.fixedUnits]) unit.destroy();
        b.units = [];
        b.fixedUnits = [];
        b.key = "";
      }
      return;
    }

    const u = ctx?.units() ?? "metric";
    const w = state.view.window;
    const strip = fixedStripFor(zone, b.chain, (w.a + w.b) / 2);
    const cards = unitsFor(zone, state.world.eras, b.chain, calendar, Object.keys(state.zones).length);
    const open = state.view.fixedOpen[b.chain] === true;
    const levels = { regimes: ledLevel(byUnit.get(unitKey({ kind: "regimes" }))), forcings: ledLevel(byUnit.get(unitKey({ kind: "forcings" }))) };

    b.strip.toggleClass("is-hidden", false);
    b.strip.toggleClass("is-open", open);
    b.stripRow.toggleClass("is-open", open);
    b.regimesLed.el.toggleClass("is-hidden", open);
    b.regimesName.toggleClass("is-hidden", open);
    b.stripDot.toggleClass("is-hidden", open || strip.forcings === null);
    b.forcingsLed.el.toggleClass("is-hidden", open || strip.forcings === null);
    b.forcingsName.toggleClass("is-hidden", open || strip.forcings === null);
    b.fixedRack.toggleClass("is-hidden", !open);
    b.toggle.setText(open ? "▾" : "▸");
    b.toggle.setAttr("aria-expanded", open ? "true" : "false");

    b.regimesLed.update({ on: !strip.regimes.mutedInChain, level: levels.regimes });
    b.regimesName.setText(regimesText(strip.regimes.count));
    b.forcingsLed.update({ on: strip.forcings === null || !strip.forcings.mutedInChain, level: levels.forcings });
    b.forcingsName.setText(forcingsText(strip, b.chain, u));

    b.rack.toggleClass("is-hidden", cards.length === 0);
    b.empty.toggleClass("is-hidden", cards.length > 0);

    // Rebuild the cards only when the model behind them actually moved.
    const key = JSON.stringify({ open, strip, cards, levels, u, unitLevels: cards.map((card) => ledLevel(byUnit.get(isEraUnit(card) ? card.id : `device:${card.id}`))) });
    if (key === b.key) return;
    b.key = key;
    if (open) paintFixedRack(b, zone, strip, levels, u);
    else {
      for (const unit of b.fixedUnits) unit.destroy();
      b.fixedUnits = [];
    }
    paintRack(b, cards, byUnit);
  }

  function paintMaster(zone: ZoneProfile | null, state: StudioState, byUnit: Map<string, StudioIssue[]>): void {
    const m = master;
    if (m === null) return;
    const u = ctx?.units() ?? "metric";
    const w = state.view.window;
    const level = ledLevel(byUnit.get(unitKey({ kind: "forcings" })));
    const warmth = zone === null ? 0 : totalWarmthAt(zone, (w.a + w.b) / 2);
    const wetness = zone === null ? 1 : getWetness(zone);
    const key = `${String(zone === null)}|${warmth}|${wetness}|${level}|${u}`;
    if (key === m.key) return;
    m.key = key;
    m.unit.update({
      led: { on: zone !== null, level, scope: "device", hint: mixerHint("mixer.master.led") },
      chips: [
        { label: `warmth ${warmthText(warmth, u)}`, color: "var(--wadjet-studio-gold)", hint: mixerHint("mixer.master.warmth") },
        { label: `wetness ${wetnessText(wetness, u)}`, color: "var(--wadjet-studio-gold)", hint: mixerHint("mixer.master.wetness") },
      ],
    });
  }

  // --- surface -------------------------------------------------------------

  return {
    mount(next) {
      ctx = next;
      // The fixed strip's two destinations. Both are placeholders owned by
      // later beads (wadjet-9f9.25, wadjet-9f9.29); registering them here is
      // what makes the strip's names live from this bead on.
      next.windows.register(REGIMES_WINDOW, buildRegimesWindow);
      next.windows.register(FORCINGS_WINDOW, buildForcingsWindow);

      for (const chain of CHAINS) blocks.push(buildChain(next.shell.mixer, chain));

      const el = next.shell.mixer.createDiv({ cls: "wadjet-studio-mixer-chain is-master", attr: { "data-chain": "master" } });
      el.setCssProps({ "--wadjet-studio-chain-color": "var(--wadjet-studio-gold)" });
      const head = el.createDiv({ cls: "wadjet-studio-mixer-head", attr: { "data-hint": mixerHint("mixer.master.led") } });
      head.createDiv({ cls: "wadjet-studio-mixer-bar" });
      head.createSpan({ cls: "wadjet-studio-mixer-title", text: "MASTER" });
      const unit = createRackUnit(el, {
        slot: MASTER_SLOT,
        name: "Forcings master",
        kind: "FRC",
        color: "var(--wadjet-studio-gold)",
        grip: false,
        chips: [],
        led: { on: true, level: "ok", scope: "device", hint: mixerHint("mixer.master.led") },
        onOpen: () => openWindow(FORCINGS_WINDOW),
      });
      unit.el.setAttr("data-unit", "master");
      unit.el.querySelector(".wadjet-studio-rack-name")?.setAttr("data-hint", mixerHint("mixer.forcings.name"));
      master = { el, unit, key: "" };
    },

    render(state) {
      const c = ctx;
      if (c === null) return;
      const zone = zoneOf(state);
      const byUnit = issuesByUnit(derive(state).issues);
      const calendar = c.calendar();
      for (const b of blocks) paintChain(b, zone, state, byUnit, calendar);
      paintMaster(zone, state, byUnit);
    },

    destroy() {
      if (drag !== null) window.removeEventListener("keydown", onDragKeyDown);
      drag = null;
      for (const b of blocks) {
        for (const unit of [...b.units, ...b.fixedUnits]) unit.destroy();
        b.regimesLed.destroy();
        b.forcingsLed.destroy();
        b.el.remove();
      }
      blocks = [];
      master?.unit.destroy();
      master?.el.remove();
      master = null;
      memoKey = "";
      memo = { issues: [] };
      ctx = null;
    },
  };
}
