/**
 * The `Regimes · STATES` window (SPEC §3.4, §6; PLAN D13, D14).
 *
 * The zone's sticky day-to-day weather states, in the vocabulary SPEC §6
 * fixes. The prototype's shape, top to bottom: a `STATE …… HOW OFTEN  HOW
 * LONG` column header, a row per state (swatch · name over its apply summary ·
 * two knobs with their values beneath · ×), `＋ state`, the SHARE OF THE YEAR
 * bar with its percentage legend, and WHAT CHANGES — the selected state's
 * `apply` ops, one 44 px knob each with a per-channel mute LED, and a dashed
 * `＋ apply` cell.
 *
 * Five things worth knowing before editing this file:
 *
 *  - **All the arithmetic is in `model/regimes.ts`.** This file is DOM,
 *    pointers and the store; it derives nothing (PLAN D3) — including the
 *    per-row apply summary (`applySummary`), the apply knob's own short name
 *    (`regimeTargetName`) and the WRITES grammar (`regimesWrites`).
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
 *  - **A state row carries no LED.** SPEC §3.4 puts the mute lamps on the
 *    *apply* knobs; the over-long run the row has to warn about is carried by
 *    the HOW LONG readout going from calendar gold to temp orange, which is
 *    what the prototype does.
 *
 * Knob convention (PLAN D11): a drag writes without history and takes one
 * `snapshot()` at pointer-up, so a whole gesture is one undo step; keyboard
 * and typed entry are their own `history: true` action.
 */
import { Menu } from "obsidian";
import { CURVE_PATHS } from "../../../core/curve-ops";
import type { ModifierOp, ZoneProfile } from "../../../core/types";
import { channelOrNull, type Channel } from "../../model/compile";
import { paramName } from "../../model/copy";
import { defaultApplyFor, knobRangeOf, knobSpecFor } from "../../model/devices";
import { tabular } from "../../model/format";
import { regimeHint } from "../../model/hints-regimes";
import { opFmt, opQuantity, parseDisplay } from "../../model/knob-units";
import { CHAIN_COLOR_VAR, CHAIN_LABEL, CHAINS } from "../../model/mixer";
import { CUSTOM_SET, currentSetName, loadRegimeSet, regimeSetSub, regimeSetsOffered, saveRegimeSet, type RegimeSet } from "../../model/regime-presets";
import { addApply, addState, applyFor, applySummary, colourOf, regimesWrites, regimeTargetName, removeApply, removeState, renameState, setApplyValue, setDwell, setWeight, shareBar } from "../../model/regimes";
import type { StudioState } from "../../model/state";
import { issuesByUnit, issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { createKnob, createLed, type KnobComponent, type KnobPhase, type LedComponent } from "../components";
import type { WindowPreset } from "../components/window";
import { PresetNameModal } from "../preset-name-modal";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild } from "../windows";

/** The id the panel is opened under. The mixer's fixed strip opens it (SPEC §3.3). */
export const REGIMES_WINDOW = "regimes";

/**
 * HOW OFTEN — a relative weight, so the knob is the plain 0…1 dial; the share
 * bar turns it into a percentage. The prototype drags it the same way:
 * `drag(r.id, "weight", 0, 1, 0.01)` (Component.js l.988).
 */
const WEIGHT_SPEC = { min: 0, max: 1, step: 0.01 };
/**
 * HOW LONG — the geometric run length in days, `drag(r.id, "dwell", 1, 40, 1)`
 * in the same call. 40, not 60: the ceiling is what a drag can *reach* as much
 * as what the pointer shows, and at 1…60 the shipped `12 d` sat at 18% of the
 * sweep instead of the prototype's 30%. A stored dwell above 40 still reads and
 * still runs — the knob clamps the dial, it never rewrites the state.
 */
const DWELL_SPEC = { min: 1, max: 40, step: 1 };
/** Above this the HOW LONG readout goes temp-orange, matching `RECOMMENDED_REGIME_DURATION` in `core/profile.ts`. */
const LONG_DWELL_DAYS = 30;

/** The two row knobs' hues, from the prototype: a neutral weight, calendar-gold days. */
const WEIGHT_COLOUR = "var(--wadjet-studio-sky)";
const DWELL_COLOUR = "var(--wadjet-studio-gold)";
const DWELL_LONG_COLOUR = "var(--wadjet-studio-temp)";

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
    ev.stopPropagation();
    if (el.hasClass("is-disabled")) return;
    o.onClick(ev);
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
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
  summary: HTMLElement;
  weight: KnobComponent;
  dwell: KnobComponent;
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

  // The column header the prototype puts above the first row — so the two
  // knob columns are named once, not once per state.
  const head = body.createDiv({ cls: "wadjet-studio-regimes-head" });
  head.createSpan({ cls: "wadjet-studio-regimes-head-state", text: "State" });
  head.createSpan({ cls: "wadjet-studio-regimes-head-knob", text: "How often", attr: { "data-hint": regimeHint("regimes.weight") } });
  head.createSpan({ cls: "wadjet-studio-regimes-head-knob", text: "How long", attr: { "data-hint": regimeHint("regimes.dwell") } });
  head.createSpan({ cls: "wadjet-studio-regimes-head-gutter" });

  const rowsEl = body.createDiv({ cls: "wadjet-studio-regimes-rows" });
  const addRow = body.createDiv({ cls: "wadjet-studio-regimes-addrow" });
  regimeButton(addRow, {
    text: "＋ state",
    label: "Add state",
    hint: regimeHint("regimes.add"),
    cls: "wadjet-studio-regimes-add",
    onClick: () => addNewState(),
  });

  // Small-caps head, lower-case tail: the tail is the §6 vocabulary lesson
  // (`how often × how long` is literally what the bar computes) and reads as
  // prose, not as another label. Two spans, ONE run of text — the prototype
  // types the whole line into a single div, so both wear the same tracking and
  // the flex gap between them is only as wide as the space it replaces.
  const shareHead = body.createDiv({ cls: "wadjet-studio-regimes-label", attr: { "data-hint": regimeHint("regimes.share") } });
  shareHead.createSpan({ cls: "wadjet-studio-regimes-label-text", text: "Share of the year" });
  shareHead.createSpan({ cls: "wadjet-studio-regimes-label-tail", text: "· how often × how long" });
  const shareEl = body.createDiv({ cls: "wadjet-studio-regimes-share", attr: { "data-hint": regimeHint("regimes.share") } });
  const legendEl = body.createDiv({ cls: "wadjet-studio-regimes-legend" });

  const applyHead = body.createDiv({ cls: "wadjet-studio-regimes-label" });
  applyHead.createSpan({ cls: "wadjet-studio-regimes-label-text", text: "What changes", attr: { "data-hint": regimeHint("regimes.apply") } });
  applyHead.createSpan({ cls: "wadjet-studio-regimes-label-tail", text: "· while in" });
  const applyWho = applyHead.createSpan({ cls: "wadjet-studio-regimes-label-who" });
  const applyWhoDot = applyWho.createSpan({ cls: "wadjet-studio-regimes-label-dot" });
  const applyWhoName = applyWho.createSpan({ cls: "wadjet-studio-regimes-label-name" });

  const opsEl = body.createDiv({ cls: "wadjet-studio-regimes-ops" });
  // The ＋ sits INSIDE the wrapping knob row as its last cell, the size of a
  // knob with the caption `apply` beneath it — not as a separate button row.
  const opsAddCell = opsEl.createDiv({ cls: "wadjet-studio-regimes-op-addcell" });
  const opsAdd = regimeButton(opsAddCell, {
    text: "＋",
    label: "Add a change",
    hint: regimeHint("regimes.applyAdd"),
    cls: "wadjet-studio-regimes-op-add",
    onClick: (ev) => openParamMenu(ev),
  });
  opsAddCell.createSpan({ cls: "wadjet-studio-regimes-op-addcaption", text: "apply" });

  const empty = body.createDiv({ cls: "wadjet-studio-regimes-empty", text: "no zone selected" });

  let rows: RowUI[] = [];
  let rowsKey: string | null = null;
  let segments: HTMLElement[] = [];
  let ops: OpUI[] = [];
  let opsKey: string | null = null;
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
    input.addEventListener("click", (ev) => ev.stopPropagation());
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
            // Product copy, never the engine path (SPEC §9): `wet→wet`, not
            // `precipitation.pww` — with the path as the dim tail so the
            // user can still see what it writes.
            .setTitle(`${regimeTargetName(param)}  ·  ${param}`)
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
      const stack = el.createDiv({ cls: "wadjet-studio-regimes-text" });
      const name = stack.createDiv({ cls: "wadjet-studio-regimes-name", attr: { role: "button", tabindex: "0", "data-hint": regimeHint("regimes.name"), "aria-label": `State ${id}` } });
      const text = name.createSpan({ cls: "wadjet-studio-regimes-name-text", text: id });
      const summary = stack.createDiv({ cls: "wadjet-studio-regimes-summary" });
      const weight = createKnob(el, {
        spec: WEIGHT_SPEC,
        value: regime.weight,
        label: "how often",
        size: "sm",
        color: WEIGHT_COLOUR,
        fmt: (v) => tabular(v, 2),
        hint: regimeHint("regimes.weight"),
        onChange: (v, phase) => onKnob(rows[index]?.id ?? id, "weight", v, phase),
      });
      const dwell = createKnob(el, {
        spec: DWELL_SPEC,
        value: regime.meanDurationDays,
        label: "how long",
        size: "sm",
        color: DWELL_COLOUR,
        fmt: (v) => `${tabular(v, 0)} d`,
        hint: regimeHint("regimes.dwell"),
        onChange: (v, phase) => onKnob(rows[index]?.id ?? id, "dwell", v, phase),
      });
      const remove = regimeButton(el, {
        text: "×",
        label: `Remove state ${id}`,
        hint: regimeHint("regimes.remove"),
        cls: "wadjet-studio-regimes-remove",
        onClick: () => dropState(rows[index]?.id ?? id),
      });

      const row: RowUI = { id, el, swatch, text, name, summary, weight, dwell, remove };
      // The whole row is the pick target (the prototype's `regPick`), so the
      // swatch, the summary and the knobs all select the state they belong to.
      el.addEventListener("click", () => selectRegime(row.id));
      name.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        beginRename(row);
      });
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
      row.summary.setText(applySummary(z, regime.id, ctx.units()));
      row.summary.toggleClass("is-bare", (regime.apply ?? []).length === 0);
      row.weight.update({ value: regime.weight });
      const long = regime.meanDurationDays > LONG_DWELL_DAYS;
      row.dwell.update({
        value: regime.meanDurationDays,
        color: long ? DWELL_LONG_COLOUR : DWELL_COLOUR,
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
    legendEl.empty();
    bars.forEach((bar, i) => {
      const seg = segments[i];
      if (seg === undefined) return;
      const pct = `${tabular(Math.round(bar.share * 100), 0)}%`;
      seg.setCssProps({ "--wadjet-studio-regimes-colour": bar.colour, "--wadjet-studio-regimes-share": `${(bar.share * 100).toFixed(3)}%` });
      seg.setAttrs({ "data-id": bar.id, title: `${bar.id} · ${pct}` });
      // The legend is the only place the share percentages are readable —
      // the bar alone reads as proportions with no numbers on them.
      const item = legendEl.createSpan({ cls: "wadjet-studio-regimes-legend-item" });
      const dot = item.createSpan({ cls: "wadjet-studio-regimes-legend-dot" });
      dot.setCssProps({ "--wadjet-studio-regimes-colour": bar.colour });
      item.createSpan({ cls: "wadjet-studio-regimes-legend-text", text: `${bar.id} ${pct}` });
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
      const remove = regimeButton(el, {
        text: "×",
        label: `Remove ${paramName(op.param)}`,
        hint: regimeHint("regimes.applyRemove"),
        cls: "wadjet-studio-regimes-op-remove",
        onClick: () => {
          write((draft) => removeApply(draft, id, index), { history: true });
          render();
        },
      });
      let knob: KnobComponent | null = null;
      if (op.op !== "clamp" && typeof op.value === "number") {
        const spec = knobSpecFor(op, "regime");
        const opSpec = knobRangeOf(spec);
        const isOffset = op.op === "offset";
        const q = opQuantity(op.param, isOffset);
        knob = createKnob(el, {
          spec: opSpec,
          value: op.value,
          label: regimeTargetName(op.param),
          size: "lg",
          fmt: opFmt(op.param, isOffset, ctx.units(), spec.fmt),
          color: colour,
          hint: regimeHint("regimes.apply"),
          ...(q !== null ? { parse: (text: string) => parseDisplay(opSpec, q, ctx.units())(text) } : {}),
          onChange: (v, phase) => onOpKnob(id, index, v, phase),
        });
      } else {
        // No placeholder controls (SPEC §3.4): a clamp or a curve-valued set is
        // read-only here and edited in the JSON drawer.
        el.createSpan({ cls: "wadjet-studio-regimes-op-static", text: `${paramName(op.param)} · ${op.op}`, attr: { "data-hint": regimeHint("regimes.apply") } });
      }
      // The label line is the LED plus the op's own short name — the
      // prototype's `▪ wet→wet`. It replaces the knob's built-in label (hidden
      // in CSS) so the per-channel mute lamp can sit inside it.
      const labelLine = el.createDiv({ cls: "wadjet-studio-regimes-op-label" });
      // The lamp stays the palette's power green: it says whether the op is
      // running, not which channel it belongs to — the arc and the readout
      // already carry the channel's hue (SPEC §9, `led.ts`'s `color` doc).
      const led = createLed(labelLine, {
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
      labelLine.createSpan({ cls: "wadjet-studio-regimes-op-name", text: regimeTargetName(op.param) });
      ops.push({ index, el, led, knob, remove });
    });
    // The ＋ cell is always the row's last item, whatever was just rebuilt.
    opsEl.appendChild(opsAddCell);
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
    head.toggleClass("is-hidden", z === null);
    rowsEl.toggleClass("is-hidden", z === null);
    addRow.toggleClass("is-hidden", z === null);
    opsAddCell.toggleClass("is-hidden", z === null);
    if (z === null) {
      if (rows.length > 0) destroyRows();
      if (ops.length > 0) destroyOps();
      rowsKey = null;
      opsKey = null;
      return;
    }

    const key = z.regimes.map((r) => r.id).join("\n");
    // A rename is typed into a live input; rebuilding rows mid-edit would eat it.
    if (key !== rowsKey && renaming === null) {
      buildRows(z);
      rowsKey = key;
    }
    const selected = selection(z);
    paintRows(z, selected);
    paintShare(z);

    const colours = ctx.store.get().view.colours.regimes;
    const at = z.regimes.findIndex((r) => r.id === selected);
    const selColour = at < 0 ? "var(--wadjet-studio-text-dim)" : colourOf(at, colours);
    applyWho.setCssProps({ "--wadjet-studio-regimes-colour": selColour });
    applyWho.toggleClass("is-hidden", selected === null);
    applyWhoDot.setCssProps({ "--wadjet-studio-regimes-colour": selColour });
    applyWhoName.setText(selected ?? "");
    setDisabled(opsAdd, selected === null);

    const opKey = selected === null ? null : `${selected}\n${applyFor(z, selected).map((op) => `${op.param}:${op.op}`).join(",")}\n${ctx.units()}`;
    if (opKey !== opsKey) {
      if (selected === null) destroyOps();
      else buildOps(z, selected);
      opsKey = opKey;
    }
    if (selected !== null) paintOps(z, selected);
    opsEl.toggleClass("is-empty", ops.length === 0);
  }

  // --- the title bar's preset pill (SPEC §3.4) -----------------------------

  /**
   * The name the pill wears. The zone's states are a *set*, and a set has a
   * name even though nothing stores one: while they still equal the zone's
   * base station record it reads that record's name (`Fjord Coast`), and it
   * reads `custom` the moment a knob moves (`model/regime-presets.ts`).
   */
  function currentSet(): string {
    const state = ctx.store.get();
    const z = zoneOf(state);
    return z === null ? CUSTOM_SET : currentSetName(z, state.world);
  }

  /**
   * One `▾` entry. Every set carries its `N states` sub — and `yours` when the
   * user wrote it — EXCEPT the one the zone is on: a `<select>` shows the
   * selected option's own text, and the prototype's pill reads the bare name
   * (`Fjord Coast ▾`), not the name with its sub trailing after it.
   */
  function optionLabel(set: RegimeSet, current: string): string {
    if (set.name === current) return set.name;
    return `${set.name} · ${regimeSetSub(set)}${set.yours ? " · yours" : ""}`;
  }

  /** Every set, plus `custom` when that is what the zone is on — the pill has to have an option to sit on. */
  function presetOptions(): string[] {
    const state = ctx.store.get();
    const current = currentSet();
    const labels = regimeSetsOffered(state.world, zoneOf(state)).map((set) => optionLabel(set, current));
    return labels.includes(current) ? labels : [current, ...labels];
  }

  /**
   * Load a set over the zone's `regimes[]`. One undoable action like every
   * other edit here; the first-world-edit confirm does NOT apply, because
   * states are zone-level (SPEC §2) — nothing outside this zone moves.
   */
  function pickSet(label: string): void {
    const state = ctx.store.get();
    const current = currentSet();
    // `custom` is a reading, not a set: picking it is a no-op by construction.
    const found = regimeSetsOffered(state.world, zoneOf(state)).find((set) => optionLabel(set, current) === label);
    if (found === undefined) return;
    write((z) => void loadRegimeSet(z, found.regimes), { history: true });
    // The incoming set names its own states; the old cursor is meaningless.
    selectedId = null;
    render();
  }

  /** `＋ save "name" as preset` — the world keeps the set, so every zone can load it back. */
  function saveSet(): void {
    const z = zone();
    if (z === null) return;
    const current = currentSet();
    new PresetNameModal(ctx.plugin.app, current === CUSTOM_SET ? `${z.name} states` : current, (name) => {
      ctx.store.update(
        (s) => {
          const draft = zoneOf(s);
          if (draft !== null) saveRegimeSet(s.world, draft, name);
        },
        { history: true },
      );
    }).open();
  }

  /**
   * A live object, not a snapshot: `windows.ts` re-reads `options()` every tick
   * and rebuilds the control when the list changes, and the getter is what
   * makes the pill follow the zone rather than the tick the panel opened on.
   */
  const presetControl: WindowPreset = {
    get name(): string {
      return currentSet();
    },
    options: () => presetOptions(),
    onPick: (label) => pickSet(label),
    onSave: () => saveSet(),
  };

  // --- pull-based readouts -------------------------------------------------

  /** SPEC law 5: the exact grammar this window produces — the draft's `regimes[]`. */
  function writes(): string {
    const z = zone();
    return z === null ? "regimes [ ]" : regimesWrites(z);
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
    // Prototype width (`proto-markup/1028-vst-regimes.html` l.2: `width:420px`
    // + its 1 px rim = 422 outer — the prototype is content-box, this panel is
    // border-box; bead wadjet-9f9.48.11): a design constant, not a function of
    // the content.
    width: 422,
    badge: "STATES",
    // SPEC §6's one statement of where states sit in the signal path, and the
    // only place the user meets it.
    caption: "slot 00 · every chain",
    preset: presetControl,
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
