/**
 * The APPLY section: one cell per op, a knob where the op has a number to
 * turn, and the `＋` menu that offers the rest of the stage's params
 * (SPEC §5).
 */
import { Menu } from "obsidian";
import type { ModifierOp } from "../../../../core/types";
import { opGloss, paramName } from "../../../model/copy";
import { addOp, newOpFor, paramsByChannel, removeOp, setOpEnabled, setOpValue } from "../../../model/device-edit";
import { type Device, knobRangeOf, knobSpecFor, opValueText } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { opQuantity, parseDisplay } from "../../../model/knob-units";
import { createLed } from "../../components";
import { CHANNEL_LABEL } from "./constants";
import type { DeviceWindowContext } from "./context";
import { colourOf } from "./geometry";
import { iconButton } from "./icon-button";

// --- APPLY --------------------------------------------------------------

export function buildApply(c: DeviceWindowContext, d: Device): void {
  const sec = c.section("APPLY", "device.op", { qualifier: d.spell === undefined ? "while active" : "while running" });
  const grid = sec.content.createDiv({ cls: "wadjet-studio-device-apply" });

  d.apply.forEach((op, i) => {
    const cell = grid.createDiv({ cls: "wadjet-studio-device-apply-cell", attr: { "data-param": op.param, "data-hint": deviceHint("device.op", opGloss(op)) } });
    iconButton(cell, {
      text: "×",
      label: `Remove ${op.param}`,
      hint: deviceHint("device.op.remove"),
      cls: "wadjet-studio-device-remove",
      onClick: () => c.mutate((x) => removeOp(x, i), true),
    });
    buildOpControl(c, cell, op, i);
    cell.createSpan({ cls: "wadjet-studio-device-apply-field", text: opGloss(op) });
  });

  const add = grid.createDiv({ cls: "wadjet-studio-device-apply-cell" });
  iconButton(add, {
    text: "＋",
    label: "Add an op",
    hint: deviceHint("device.op.add"),
    cls: "wadjet-studio-device-add-apply",
    onClick: (ev) => openOpMenu(c, ev, d),
  });
  add.createSpan({ cls: "wadjet-studio-device-apply-addlabel", text: "apply" });
}

/** A knob per op, except the two shapes a knob cannot express: `clamp`, and a `set` that installs a whole curve. */
function buildOpControl(c: DeviceWindowContext, cell: HTMLElement, op: ModifierOp, i: number): void {
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
    fmt: (v) => opValueText({ ...op, value: v }, c.ctx.units()),
    color: colourOf(op.param),
    hint: deviceHint("device.op", opGloss(op)),
    disabled: op.enabled === false,
    ...(q !== null ? { parse: (text: string) => parseDisplay(range, q, c.ctx.units())(text) } : {}),
    onChange: (v, phase) => c.gesture(phase, (x) => setOpValue(x, i, v)),
  });

  // The per-op mute sits *inside* the knob's own label, so the cell reads
  // `● precip` on one line the way the prototype's does.
  const label = el.querySelector<HTMLElement>(".wadjet-studio-knob-label");
  if (label === null) return;
  const led = createLed(label, {
    on: op.enabled !== false,
    scope: "op",
    hint: deviceHint("device.op.power"),
    onToggle: (on) => c.mutate((x) => setOpEnabled(x, i, on), true),
  });
  led.el.setAttr("data-part", `op-power-${i}`);
  label.prepend(led.el);
  c.addPart(led);
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
