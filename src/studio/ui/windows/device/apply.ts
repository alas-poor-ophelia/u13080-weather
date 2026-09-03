/**
 * The APPLY section: one cell per op, a knob where the op has a number to
 * turn, and the `＋` menu that offers the rest of the stage's params
 * (SPEC §5) — or, on the moon path, the one flex row that carries the gate
 * disc and those same knobs together (`0699-vst-stormtide.html` l.21-40).
 */
import { Menu } from "obsidian";
import type { ModifierOp } from "../../../../core/types";
import { opGloss, paramName } from "../../../model/copy";
import { addOp, newOpFor, paramsByChannel, removeOp, setOpEnabled, setOpValue } from "../../../model/device-edit";
import { COMPOSED_FIELD, type Device, composedPairs, knobRangeOf, knobSpecFor, opValueText } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { opQuantity, parseDisplay } from "../../../model/knob-units";
import { createLed } from "../../components";
import { CHANNEL_LABEL } from "./constants";
import type { DeviceWindowContext } from "./context";
import { colourOf } from "./geometry";
import { iconButton } from "./icon-button";
import { buildGateDisc } from "./when-moon";

// --- APPLY --------------------------------------------------------------

export function buildApply(c: DeviceWindowContext, d: Device): void {
  const w = d.when;
  if (w.kind === "moon") {
    buildMoonRow(c, d, w.moon, w.range);
    return;
  }
  const qualifier = d.spell === undefined ? "while active" : "while running";
  // The spell path writes APPLY as a subhead over the grid (`0905` l.39), the
  // same weight as `WINDOWS · repeat yearly` above it, not as a captioned
  // section. `data-section="apply"` moves onto that wrapper so every selector
  // that counts the apply knobs still lands.
  const host = w.kind === "yearWindow" ? applySubhead(c, qualifier) : c.section("APPLY", "device.op", { qualifier }).content;
  const grid = host.createDiv({ cls: "wadjet-studio-device-apply" });

  for (const { op, i, partner } of columns(d.apply)) {
    const cell = opCell(grid, op, partner);
    iconButton(cell, {
      text: "×",
      label: `Remove ${partner === undefined ? op.param : COMPOSED_FIELD}`,
      hint: deviceHint("device.op.remove"),
      cls: "wadjet-studio-device-remove",
      // Higher index first: `removeOp` splices, so dropping the lower one
      // would shift the partner out from under the second call.
      onClick: () =>
        c.mutate((x) => {
          if (partner !== undefined) removeOp(x, partner);
          removeOp(x, i);
        }, true),
    });
    // No `op · field` line under the value: the prototype carries that string
    // as the column's `data-hint` only (`1095` l.87), and a fourth line both
    // truncates and pushes every row 16 px taller.
    buildOpControl(c, cell, op, i, partner === undefined ? undefined : { partner });
  }

  const add = grid.createDiv({ cls: "wadjet-studio-device-apply-cell" });
  // The spell path's `＋ apply` opens the moon path's INLINE list rather than
  // an Obsidian `Menu` (`0905` l.49-59: the dashed circle, then `ashAddOpts`
  // hanging under it). Every other kind keeps `openOpMenu`.
  if (w.kind === "yearWindow") {
    buildAddTarget(c, add, d, { plus: true, listHost: host });
    return;
  }
  iconButton(add, {
    text: "＋",
    label: "Add an op",
    hint: deviceHint("device.op.add"),
    cls: "wadjet-studio-device-add-apply",
    onClick: (ev) => openOpMenu(c, ev, d),
  });
  add.createSpan({ cls: "wadjet-studio-device-apply-addlabel", text: "apply" });
}

/** The spell path's APPLY head: a subhead in the body, not a section caption. */
function applySubhead(c: DeviceWindowContext, qualifier: string): HTMLElement {
  const root = c.body.createDiv({ cls: "wadjet-studio-device-section", attr: { "data-section": "apply" } });
  root.createDiv({ cls: "wadjet-studio-device-subhead", text: `APPLY · ${qualifier}`, attr: { "data-hint": deviceHint("device.op") } });
  return root;
}

/**
 * The moon path's signature row (`0699` l.21-40; gap2 B1): the 84 px gate disc
 * left-aligned — the window body's own 13 px padding is the prototype's, so
 * the disc centre lands where the capture has it — and the op knobs beside it,
 * where every other kind wears the disc under WHEN and an APPLY grid 200 px
 * further down. No `×` and no `＋ apply` cell: the prototype removes a target
 * from its own binding card and adds one with `＋ Add target`.
 */
function buildMoonRow(c: DeviceWindowContext, d: Device, moon: string, range: [number, number]): void {
  const row = c.body.createDiv({ cls: "wadjet-studio-device-moon", attr: { "data-section": "moon" } });
  buildGateDisc(c, row, range, moon);
  const knobs = row.createDiv({ cls: "wadjet-studio-device-moon-knobs" });
  // The same columns the grid draws: the pair is a property of the ops, not of
  // the kind, so a moon device that writes both rain odds alike reads as one
  // knob here too. (The binding cards under it still list every op.)
  for (const { op, i, partner } of columns(d.apply)) buildOpControl(c, opCell(knobs, op, partner), op, i, partner === undefined ? { bare: true } : { bare: true, partner });
}

/**
 * The columns an APPLY draws: one per op, except where `composedPairs` says two
 * writes are one edit — then the LOWER index owns the column and carries the
 * higher one as its `partner`, and the higher index draws nothing of its own.
 */
function columns(apply: readonly ModifierOp[]): Array<{ op: ModifierOp; i: number; partner?: number }> {
  const pairs = composedPairs(apply);
  const partnerOf = new Map(pairs);
  const hidden = new Set(pairs.map(([, hi]) => hi));
  return apply.flatMap((op, i) => {
    if (hidden.has(i)) return [];
    const partner = partnerOf.get(i);
    return [partner === undefined ? { op, i } : { op, i, partner }];
  });
}

/** One column's cell, the same on both paths: the op's param and its gloss, hung on the knob. */
function opCell(parent: HTMLElement, op: ModifierOp, partner?: number): HTMLElement {
  const gloss = opGloss(op, partner === undefined ? op.param : COMPOSED_FIELD);
  const cell = parent.createDiv({ cls: "wadjet-studio-device-apply-cell", attr: { "data-param": op.param, "data-hint": deviceHint("device.op", gloss) } });
  // `op-N` / `op-power-N` stay the lower op's, so every existing selector keeps
  // pointing at a real op; `data-composed` names the index riding with it.
  if (partner !== undefined) cell.setAttr("data-composed", String(partner));
  return cell;
}

/**
 * A knob per op, except the two shapes a knob cannot express: `clamp`, and a
 * `set` that installs a whole curve.
 *
 * `bare` is the prototype's Stormtide column (`0699` l.36) against the generic
 * one (`1095` l.85). It carries the two differences between them: the label is
 * the `macro` name the binding card under it also uses — one vocabulary in one
 * window, so the knob and its card cannot disagree about what a target is
 * called — and it is bare text, with no mute dot before it.
 *
 * `partner` is the composed column (`columns` above): one knob, one mute and
 * one `×` driving two ops. Each write is one `mutate`/`gesture`, so the pair
 * moves together and undoes in one step.
 */
function buildOpControl(c: DeviceWindowContext, cell: HTMLElement, op: ModifierOp, i: number, o?: { bare?: boolean; partner?: number }): void {
  if (op.op === "clamp" || typeof op.value !== "number") {
    cell.createSpan({ cls: "wadjet-studio-device-raw", text: `${paramName(op.param)} ${op.op}` });
    return;
  }
  const spec = knobSpecFor(op, "device");
  const range = knobRangeOf(spec);
  const isOffset = op.op === "offset";
  const q = opQuantity(op.param, isOffset);
  const el = c.knob(cell, {
    part: `op-${i}`,
    // A composed column takes the `target` name on both paths: no macro name
    // covers both writes (`storm odds` is only half of it), and the prototype's
    // own composed column reads `precip`.
    label: paramName(op.param, o?.bare === true && o?.partner === undefined ? "macro" : "target"),
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
    fmt: (v) => opValueText({ ...op, value: v }, c.ctx.units()),
    color: colourOf(op.param),
    hint: deviceHint("device.op", opGloss(op, o?.partner === undefined ? op.param : COMPOSED_FIELD)),
    disabled: op.enabled === false,
    ...(q !== null ? { parse: (text: string) => parseDisplay(range, q, c.ctx.units())(text) } : {}),
    onChange: (v, phase) =>
      c.gesture(phase, (x) => {
        setOpValue(x, i, v);
        if (o?.partner !== undefined) setOpValue(x, o.partner, v);
      }),
  });

  // The per-op mute sits *inside* the knob's own label, so the cell reads
  // `● precip` on one line the way the prototype's does.
  if (o?.bare === true) return;
  const label = el.querySelector<HTMLElement>(".wadjet-studio-knob-label");
  if (label === null) return;
  const led = createLed(label, {
    on: op.enabled !== false,
    scope: "op",
    hint: deviceHint("device.op.power"),
    onToggle: (on) =>
      c.mutate((x) => {
        setOpEnabled(x, i, on);
        if (o?.partner !== undefined) setOpEnabled(x, o.partner, on);
      }, true),
  });
  led.el.setAttr("data-part", `op-power-${i}`);
  label.prepend(led.el);
  c.addPart(led);
}

/**
 * `＋ Add target` and the inline list it opens (`0699` l.95-104) — the moon
 * path's replacement for the `＋ apply` cell and its Obsidian `Menu` (D16).
 * The prototype's control is bespoke: a full-width block *under* the binding
 * cards, opening a scrolling list in the panel rather than a floating menu,
 * so a target is picked without the cards leaving the eye. Every other kind
 * keeps `openOpMenu` below untouched.
 *
 * `plus` is the spell path's shape of the same control (`0905` l.49-59): the
 * dashed 44 px `＋ apply` circle stays the trigger, and `listHost` puts the
 * list one level up, under the APPLY row rather than inside the 74 px cell.
 * The prototype floats it (`position:absolute; top:50px`), which this panel
 * cannot: `.wadjet-studio-window-body` scrolls, so a floated list would be
 * clipped by it — and APPLY is the last thing above the WRITES footer, so
 * there is nothing under the row for an in-flow list to cover anyway.
 * One cursor, one list.
 *
 * `paramsByChannel` already drops what the device is bound to, so the list is
 * exactly the unbound params, in signal order; the op each row would add is
 * the plugin's own default (`newOpFor`), shown so the row says what it writes.
 * That filter is also what makes the composed precip pair read right: a pair
 * exists only when BOTH `precipitation.pwd` and `.pww` are ops, so both are
 * already dropped. There is no `precip` pseudo-target — the prototype's fixed
 * table has one, the plugin writes real params, so an unbound `pwd` or `pww`
 * is offered as its own row and composes back into one column once its
 * partner is added with a matching op and value (`composedPairs`).
 */
export function buildAddTarget(c: DeviceWindowContext, parent: HTMLElement, d: Device, o?: { plus?: boolean; listHost?: HTMLElement }): void {
  const open = c.targetPick();
  const plus = o?.plus === true;
  const add = iconButton(parent, {
    text: plus ? "＋" : "＋ Add target",
    label: plus ? "Add an op" : "Add a target",
    hint: deviceHint("device.op.add"),
    cls: plus ? "wadjet-studio-device-add-apply" : "wadjet-studio-device-addtarget",
    onClick: () => {
      c.setTargetPick(!open);
      c.invalidate();
    },
  });
  add.setAttrs({ "data-part": "add-target", "aria-pressed": open ? "true" : "false" });
  if (plus) parent.createSpan({ cls: "wadjet-studio-device-apply-addlabel", text: "apply" });
  if (!open) return;

  const list = (o?.listHost ?? parent).createDiv({ cls: "wadjet-studio-device-srclist is-targets", attr: { "data-part": "target-list" } });
  const offered = paramsByChannel(
    d.stage,
    d.apply.map((o) => o.param),
  ).flatMap((g) => g.params);
  if (offered.length === 0) {
    list.createDiv({ cls: "wadjet-studio-device-srcrow is-empty", text: "Every parameter is bound" });
    return;
  }
  for (const param of offered) {
    const row = iconButton(list, {
      text: "●",
      label: `Bind ${param}`,
      hint: deviceHint("device.op.target"),
      cls: "wadjet-studio-device-srcrow",
      onClick: () => {
        c.setTargetPick(false);
        c.mutate((x) => addOp(x, newOpFor(param)), true);
      },
    });
    row.setCssProps({ "--wadjet-studio-chip-color": colourOf(param) });
    row.setAttr("data-target", param);
    row.createSpan({ cls: "wadjet-studio-device-srcrow-name", text: param });
    row.createSpan({ cls: "wadjet-studio-device-srcrow-note", text: newOpFor(param).op });
  }
}

function openOpMenu(c: DeviceWindowContext, ev: MouseEvent, d: Device): void {
  const menu = new Menu();
  const groups = paramsByChannel(
    d.stage,
    d.apply.map((o) => o.param),
  );
  groups.forEach((group, i) => {
    if (i > 0) menu.addSeparator();
    menu.addItem((item) => item.setTitle(CHANNEL_LABEL[group.channel]).setDisabled(true));
    for (const param of group.params) menu.addItem((item) => item.setTitle(`${paramName(param)} · ${param}`).onClick(() => c.mutate((x) => addOp(x, newOpFor(param)), true)));
  });
  menu.showAtMouseEvent(ev);
}
