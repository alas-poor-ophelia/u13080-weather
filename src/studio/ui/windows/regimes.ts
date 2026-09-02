/**
 * The `Regimes · STATES` window (SPEC §3.4, §6; PLAN D13, D14).
 *
 * The zone's sticky day-to-day weather states, in the vocabulary SPEC §6 fixes:
 * a row per state (swatch · name · **how often** · **how long** · ×), the
 * SHARE OF THE YEAR bar (`weight × dwell`, normalised), and WHAT CHANGES —
 * the selected state's `apply` ops, one knob each, with a per-op power LED.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **All the arithmetic is in `model/regimes.ts`.** This file is DOM,
 *    pointers and the store; it derives nothing (PLAN D3).
 *  - **The id is the name.** Renaming a state rewrites every `{ regime }`
 *    predicate in the zone's modifiers, so a device gated on it follows
 *    (PLAN D13) — that is `renameState`'s job, not this file's.
 *  - **The body repaints itself.** `WindowManager.renderAll` only re-reads
 *    `writes`/`issues`/`level`/`badge`, so the builder subscribes to the store
 *    and drops the subscription in `onClose`. The repaint *reconciles*: rows
 *    and op rows are rebuilt only when the id list changes, so a knob drag and
 *    an open rename input survive the ticks they cause.
 *  - **Selection is module state.** The regimes lane (bead wadjet-9f9.18)
 *    selects a state by calling `selectRegime(id)` — SPEC §3.2, "click →
 *    selects that state in the STATES window" — so it must outlive any one
 *    panel and repaint every open one.
 *
 * Knob convention (PLAN D11): a drag writes without history and takes one
 * `snapshot()` at pointer-up, so a whole gesture is one undo step; keyboard
 * and typed entry are their own `history: true` action.
 */
import { Menu } from "obsidian";
import { CURVE_PATHS } from "../../../core/curve-ops";
import type { ModifierOp, ZoneProfile } from "../../../core/types";
import { channelOrNull, type Channel } from "../../model/compile";
import { defaultApplyFor, knobSpecFor } from "../../model/devices";
import { regimeHint } from "../../model/hints-regimes";
import { opFmt, opQuantity, parseDisplay } from "../../model/knob-units";
import { CHAIN_COLOR_VAR, CHAIN_LABEL, CHAINS } from "../../model/mixer";
import { addApply, addState, applyFor, colourOf, removeApply, removeState, renameState, setApplyValue, setDwell, setWeight, shareBar } from "../../model/regimes";
import type { StudioState } from "../../model/state";
import { issuesByUnit, issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createKnob, createLed, type KnobComponent, type KnobPhase, type LedComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild } from "../windows";

/** The id the panel is opened under. The mixer's fixed strip opens it (SPEC §3.3). */
export const REGIMES_WINDOW = "regimes";

/** HOW OFTEN — a relative weight, so the knob is the plain 0…1 dial; the share bar turns it into a percentage. */
const WEIGHT_SPEC = { min: 0, max: 1, step: 0.01 };
/** HOW LONG — the geometric run length in days. */
const DWELL_SPEC = { min: 1, max: 60, step: 1 };
/** Above this the row's LED goes amber, matching `RECOMMENDED_REGIME_DURATION` in `core/profile.ts`. */
const LONG_DWELL_DAYS = 30;

/**
 * The state the WHAT CHANGES section is showing, shared by every open panel and
 * by the regimes lane. Not view state: it is a pointer at a row, not something
 * the leaf should restore (PLAN D14 persists colours, not cursors).
 */
let selectedId: string | null = null;

/** Every open panel's repaint, so a lane click reaches all of them. */
const panels = new Set<() => void>();

/**
 * Select a state (SPEC §3.2: clicking a block in the regimes lane selects it
 * here). Safe to call with a state that does not exist — the window falls back
 * to the zone's first.
 */
export function selectRegime(id: string): void {
  if (selectedId === id) return;
  selectedId = id;
  for (const repaint of [...panels]) repaint();
}

/** The op a freshly picked parameter starts on: the same neutral choice `defaultApplyFor` makes for that channel. */
function defaultOpFor(param: string): ModifierOp {
  const base = defaultApplyFor(channelOrNull(param) ?? "sky");
  return base.op === "scale" ? { param, op: "scale", value: 1 } : { param, op: "offset", value: 0 };
}

function chainOf(param: string): Channel | null {
  return channelOrNull(param);
}

/** A small chrome button — the same status as the window's × (SPEC law 3: not a new component). */
function regimeButton(parent: HTMLElement, o: { text: string; label: string; hint: string; cls: string; onClick: (ev: MouseEvent) => void }): HTMLElement {
  const el = parent.createDiv({ cls: o.cls, text: o.text, attr: { role: "button", tabindex: "0", "aria-label": o.label, "data-hint": o.hint } });
  el.addEventListener("click", (ev) => {
    if (el.hasClass("is-disabled")) return;
    o.onClick(ev);
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (el.hasClass("is-disabled")) return;
    o.onClick(new MouseEvent("click"));
  });
  return el;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  el.toggleClass("is-disabled", disabled);
  el.setAttrs({ "aria-disabled": disabled ? "true" : "false", tabindex: disabled ? "-1" : "0" });
}

/** One state's row. Rebuilt only when the zone's id list changes. */
interface RowUI {
  id: string;
  el: HTMLElement;
  swatch: HTMLElement;
  text: HTMLElement;
  name: HTMLElement;
  weight: KnobComponent;
  dwell: KnobComponent;
  led: LedComponent;
  remove: HTMLElement;
}

/** One `apply` op. Rebuilt only when the selected state's op shapes change. */
interface OpUI {
  index: number;
  el: HTMLElement;
  led: LedComponent;
  knob: KnobComponent | null;
  remove: HTMLElement;
}

export function buildRegimesWindow(ctx: SurfaceContext): WindowBuild {
  const body = createDiv({ cls: "wadjet-studio-regimes" });

  const rowsEl = body.createDiv({ cls: "wadjet-studio-regimes-rows" });
  const addRow = body.createDiv({ cls: "wadjet-studio-regimes-addrow" });
  regimeButton(addRow, {
    text: "＋ state",
    label: "Add state",
    hint: regimeHint("regimes.add"),
    cls: "wadjet-studio-regimes-add",
    onClick: () => addNewState(),
  });

  body.createDiv({ cls: "wadjet-studio-regimes-label", text: "Share of the year" });
  const shareEl = body.createDiv({ cls: "wadjet-studio-regimes-share", attr: { "data-hint": regimeHint("regimes.share") } });

  const applyHead = body.createDiv({ cls: "wadjet-studio-regimes-label" });
  applyHead.createSpan({ cls: "wadjet-studio-regimes-label-text", text: "What changes" });
  const applyWho = applyHead.createSpan({ cls: "wadjet-studio-regimes-label-who" });
  const opsEl = body.createDiv({ cls: "wadjet-studio-regimes-ops" });
  const opsAddRow = body.createDiv({ cls: "wadjet-studio-regimes-addrow" });
  const opsAdd = regimeButton(opsAddRow, {
    text: "＋",
    label: "Add a change",
    hint: regimeHint("regimes.applyAdd"),
    cls: "wadjet-studio-regimes-op-add",
    onClick: (ev) => openParamMenu(ev),
  });
  const empty = body.createDiv({ cls: "wadjet-studio-regimes-empty", text: "no zone selected" });

  let rows: RowUI[] = [];
  let rowsKey = "\u0000none";
  let segments: HTMLElement[] = [];
  let ops: OpUI[] = [];
  let opsKey = "\u0000none";
  /** The id whose name is being typed, so a repaint never tears the input out from under the caret. */
  let renaming: string | null = null;

  // --- state helpers -------------------------------------------------------

  function zoneOf(state: StudioState): ZoneProfile | null {
    const id = state.view.zoneId;
    return id === null ? null : (state.zones[id] ?? null);
  }

  function zone(): ZoneProfile | null {
    return zoneOf(ctx.store.get());
  }

  /** The selected state, or the zone's first when nothing (or something stale) is selected. */
  function selection(z: ZoneProfile): string | null {
    if (selectedId !== null && z.regimes.some((r) => r.id === selectedId)) return selectedId;
    return z.regimes[0]?.id ?? null;
  }

  /** Mutate the draft zone. `history` marks the call one undoable action. */
  function write(fn: (z: ZoneProfile) => void, opts?: { history?: boolean }): void {
    ctx.store.update((s) => {
      const z = zoneOf(s);
      if (z !== null) fn(z);
    }, opts);
  }

  // --- actions -------------------------------------------------------------

  function addNewState(): void {
    let added = "";
    write((z) => {
      added = addState(z);
    }, { history: true });
    if (added !== "") selectedId = added;
    render();
  }

  function dropState(id: string): void {
    write((z) => {
      removeState(z, id);
    }, { history: true });
    if (selectedId === id) selectedId = null;
    render();
  }

  function onKnob(id: string, which: "weight" | "dwell", value: number, phase: KnobPhase): void {
    const apply = (z: ZoneProfile): void => {
      if (which === "weight") setWeight(z, id, value);
      else setDwell(z, id, value);
    };
    // A drag is one gesture and one undo step: write freely, commit at pointer-up.
    if (phase === "drag") write(apply);
    else if (phase === "end") {
      write(apply);
      ctx.store.snapshot();
    } else write(apply, { history: true });
  }

  function onOpKnob(id: string, index: number, value: number, phase: KnobPhase): void {
    const apply = (z: ZoneProfile): void => setApplyValue(z, id, index, value);
    if (phase === "drag") write(apply);
    else if (phase === "end") {
      write(apply);
      ctx.store.snapshot();
    } else write(apply, { history: true });
  }

  function beginRename(row: RowUI): void {
    if (renaming !== null) return;
    const from = row.id;
    renaming = from;
    row.name.addClass("is-editing");
    const input = row.name.createEl("input", { cls: "wadjet-studio-regimes-name-input", type: "text", value: from });
    let closed = false;
    const close = (commit: boolean): void => {
      if (closed) return;
      closed = true;
      const text = input.value;
      input.remove();
      row.name.removeClass("is-editing");
      renaming = null;
      if (commit) commitRename(from, text);
      else render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        close(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close(false);
      }
      ev.stopPropagation();
    });
    input.addEventListener("blur", () => close(true));
    input.focus();
    input.select();
  }

  function commitRename(from: string, text: string): void {
    let to = from;
    write((z) => {
      to = renameState(z, from, text);
    }, { history: true });
    if (selectedId === from) selectedId = to;
    render();
  }

  function openParamMenu(ev: MouseEvent): void {
    const z = zone();
    if (z === null) return;
    const id = selection(z);
    if (id === null) return;
    const present = new Set(applyFor(z, id).map((op) => op.param));
    const menu = new Menu();
    let first = true;
    for (const chain of CHAINS) {
      const paths = CURVE_PATHS.filter((p) => chainOf(p) === chain);
      if (paths.length === 0) continue;
      if (!first) menu.addSeparator();
      first = false;
      menu.addItem((item) => item.setTitle(CHAIN_LABEL[chain]).setIsLabel(true));
      for (const param of paths) {
        menu.addItem((item) =>
          item
            .setTitle(param)
            .setDisabled(present.has(param))
            .onClick(() => {
              write((draft) => addApply(draft, id, defaultOpFor(param)), { history: true });
              render();
            }),
        );
      }
    }
    menu.showAtMouseEvent(ev);
  }

  // --- rows ----------------------------------------------------------------

  function destroyRows(): void {
    for (const row of rows) {
      row.weight.destroy();
      row.dwell.destroy();
      row.led.destroy();
      row.el.remove();
    }
    rows = [];
  }

  function buildRows(z: ZoneProfile): void {
    destroyRows();
    z.regimes.forEach((regime, index) => {
      const id = regime.id;
      const el = rowsEl.createDiv({ cls: "wadjet-studio-regimes-row", attr: { "data-id": id } });
      const swatch = el.createDiv({ cls: "wadjet-studio-regimes-swatch", attr: { "data-hint": regimeHint("regimes.swatch"), role: "img", "aria-label": `${id} colour` } });
      const name = el.createDiv({ cls: "wadjet-studio-regimes-name", attr: { role: "button", tabindex: "0", "data-hint": regimeHint("regimes.name"), "aria-label": `State ${id}` } });
      const text = name.createSpan({ cls: "wadjet-studio-regimes-name-text", text: id });
      const knobs = el.createDiv({ cls: "wadjet-studio-regimes-knobs" });
      const weight = createKnob(knobs, {
        spec: WEIGHT_SPEC,
        value: regime.weight,
        label: "how often",
        fmt: (v) => v.toFixed(2),
        hint: regimeHint("regimes.weight"),
        onChange: (v, phase) => onKnob(rows[index]?.id ?? id, "weight", v, phase),
      });
      const dwell = createKnob(knobs, {
        spec: DWELL_SPEC,
        value: regime.meanDurationDays,
        label: "how long",
        fmt: (v) => `${v.toFixed(0)} d`,
        hint: regimeHint("regimes.dwell"),
        onChange: (v, phase) => onKnob(rows[index]?.id ?? id, "dwell", v, phase),
      });
      const led = createLed(el, { on: true, level: "ok", scope: "op", hint: regimeHint("regimes.dwell") });
      const remove = regimeButton(el, {
        text: "×",
        label: `Remove state ${id}`,
        hint: regimeHint("regimes.remove"),
        cls: "wadjet-studio-regimes-remove",
        onClick: () => dropState(rows[index]?.id ?? id),
      });

      const row: RowUI = { id, el, swatch, text, name, weight, dwell, led, remove };
      name.addEventListener("click", () => selectRegime(row.id));
      name.addEventListener("dblclick", () => beginRename(row));
      name.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          beginRename(row);
        } else if (ev.key === " ") {
          ev.preventDefault();
          selectRegime(row.id);
        }
      });
      rows.push(row);
    });
  }

  function paintRows(z: ZoneProfile, selected: string | null): void {
    const colours = ctx.store.get().view.colours.regimes;
    z.regimes.forEach((regime, index) => {
      const row = rows[index];
      if (row === undefined) return;
      row.id = regime.id;
      row.el.setAttr("data-id", regime.id);
      row.el.toggleClass("is-selected", regime.id === selected);
      row.swatch.setCssProps({ "--wadjet-studio-regimes-colour": colourOf(index, colours) });
      row.text.setText(regime.id);
      row.weight.update({ value: regime.weight });
      row.dwell.update({ value: regime.meanDurationDays });
      const long = regime.meanDurationDays > LONG_DWELL_DAYS;
      row.led.update({
        level: long ? "warn" : "ok",
        hint: long ? regimeHint("regimes.dwell", `over ${LONG_DWELL_DAYS} d; a long-lived state belongs in a spell device`) : regimeHint("regimes.dwell"),
      });
      setDisabled(row.remove, z.regimes.length <= 1);
    });
  }

  // --- share bar -----------------------------------------------------------

  function paintShare(z: ZoneProfile): void {
    const bars = shareBar(z, ctx.store.get().view.colours.regimes);
    while (segments.length > bars.length) segments.pop()?.remove();
    while (segments.length < bars.length) segments.push(shareEl.createDiv({ cls: "wadjet-studio-regimes-share-seg" }));
    bars.forEach((bar, i) => {
      const seg = segments[i];
      if (seg === undefined) return;
      seg.setCssProps({ "--wadjet-studio-regimes-colour": bar.colour, "--wadjet-studio-regimes-share": `${(bar.share * 100).toFixed(3)}%` });
      seg.setAttrs({ "data-id": bar.id, title: `${bar.id} · ${(bar.share * 100).toFixed(0)}%` });
    });
  }

  // --- what changes --------------------------------------------------------

  function destroyOps(): void {
    for (const op of ops) {
      op.led.destroy();
      op.knob?.destroy();
      op.el.remove();
    }
    ops = [];
  }

  function buildOps(z: ZoneProfile, id: string): void {
    destroyOps();
    applyFor(z, id).forEach((op, index) => {
      const chain = chainOf(op.param);
      const colour = chain === null ? "var(--wadjet-studio-accent)" : CHAIN_COLOR_VAR[chain];
      const el = opsEl.createDiv({ cls: "wadjet-studio-regimes-op", attr: { "data-param": op.param } });
      const led = createLed(el, {
        on: op.enabled !== false,
        level: "ok",
        scope: "op",
        hint: regimeHint("regimes.applyMute"),
        onToggle: (on) => {
          write((draft) => {
            const target = applyFor(draft, id)[index];
            if (target === undefined) return;
            if (on) delete target.enabled;
            else target.enabled = false;
          }, { history: true });
          render();
        },
      });
      let knob: KnobComponent | null = null;
      if (op.op !== "clamp" && typeof op.value === "number") {
        const spec = knobSpecFor(op);
        const opSpec = { min: spec.min, max: spec.max, neutral: spec.neutral, step: spec.step };
        const isOffset = op.op === "offset";
        const q = opQuantity(op.param, isOffset);
        knob = createKnob(el, {
          spec: opSpec,
          value: op.value,
          label: op.param,
          fmt: opFmt(op.param, isOffset, ctx.units(), spec.fmt),
          color: colour,
          hint: regimeHint("regimes.apply"),
          ...(q !== null ? { parse: (text: string) => parseDisplay(opSpec, q, ctx.units())(text) } : {}),
          onChange: (v, phase) => onOpKnob(id, index, v, phase),
        });
      } else {
        // No placeholder controls (SPEC §3.4): a clamp or a curve-valued set is
        // read-only here and edited in the JSON drawer.
        el.createSpan({ cls: "wadjet-studio-regimes-op-static", text: `${op.param} · ${op.op}`, attr: { "data-hint": regimeHint("regimes.apply") } });
      }
      const remove = regimeButton(el, {
        text: "×",
        label: `Remove ${op.param}`,
        hint: regimeHint("regimes.applyRemove"),
        cls: "wadjet-studio-regimes-op-remove",
        onClick: () => {
          write((draft) => removeApply(draft, id, index), { history: true });
          render();
        },
      });
      ops.push({ index, el, led, knob, remove });
    });
  }

  function paintOps(z: ZoneProfile, id: string): void {
    const list = applyFor(z, id);
    ops.forEach((ui, i) => {
      const op = list[i];
      if (op === undefined) return;
      ui.led.update({ on: op.enabled !== false });
      if (ui.knob !== null && op.op !== "clamp" && typeof op.value === "number") ui.knob.update({ value: op.value });
    });
  }

  // --- render --------------------------------------------------------------

  function render(): void {
    const z = zone();
    empty.toggleClass("is-hidden", z !== null);
    rowsEl.toggleClass("is-hidden", z === null);
    addRow.toggleClass("is-hidden", z === null);
    opsAddRow.toggleClass("is-hidden", z === null);
    if (z === null) {
      if (rows.length > 0) destroyRows();
      if (ops.length > 0) destroyOps();
      rowsKey = "\u0000none";
      opsKey = "\u0000none";
      return;
    }

    const key = z.regimes.map((r) => r.id).join("\u0000");
    // A rename is typed into a live input; rebuilding rows mid-edit would eat it.
    if (key !== rowsKey && renaming === null) {
      buildRows(z);
      rowsKey = key;
    }
    const selected = selection(z);
    paintRows(z, selected);
    paintShare(z);

    applyWho.setText(selected === null ? "" : ` · ${selected}`);
    setDisabled(opsAdd, selected === null);

    const opKey = selected === null ? "\u0000none" : `${selected}\u0000${applyFor(z, selected).map((op) => `${op.param}:${op.op}`).join(",")}\u0000${ctx.units()}`;
    if (opKey !== opsKey) {
      if (selected === null) destroyOps();
      else buildOps(z, selected);
      opsKey = opKey;
    }
    if (selected !== null) paintOps(z, selected);
    opsEl.toggleClass("is-empty", ops.length === 0);
  }

  // --- pull-based readouts -------------------------------------------------

  /** SPEC law 5: the exact grammar this window produces — the draft's `regimes[]`. */
  function writes(): string {
    const z = zone();
    return z === null ? "[]" : JSON.stringify(z.regimes, null, 2);
  }

  /** Everything `issuesFor` routed to the fixed Regimes slot (SPEC §3.9). */
  function issues(): StudioIssue[] {
    const state = ctx.store.get();
    const z = zoneOf(state);
    if (z === null) return [];
    const description = ctx.calendar();
    const readOnlyCalendar = description?.readOnly ?? false;
    const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
    const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
    const all = issuesFor({ zone: z, eras: state.world.eras, seasons, moons, readOnlyCalendar });
    return issuesByUnit(all).get(unitKey({ kind: "regimes" })) ?? [];
  }

  const unsubscribe = ctx.store.subscribe(() => render());
  panels.add(render);
  render();

  return {
    title: "Regimes",
    badge: "STATES",
    body,
    led: { on: true, scope: "device" },
    // Re-read every tick against the `byUnit` map `renderAll` computes once (SPEC §3.9).
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "regimes" }))),
    writes,
    issues,
    onClose: () => {
      unsubscribe();
      panels.delete(render);
      destroyRows();
      destroyOps();
      for (const seg of segments) seg.remove();
      segments = [];
      body.remove();
    },
  };
}
