/**
 * MOD · moon — the prototype's per-binding cards (`0699-vst-stormtide.html`
 * l.43-94; gap2 B4-B7).
 *
 * Every other kind wears ONE device-wide MOD card (`mod.ts`), because on
 * every other kind the mod matrix *is* device-wide. A moon-bound device is
 * edited per **binding** instead: one card per `apply` entry, carrying that
 * op's value, its onset shape, its cycle mode, and the device's modulation
 * sources — the seam gap2 B4-B7 is five coats of.
 *
 * Custom components, not the bin (PLAN D15/D16): the prototype's control here
 * is bespoke twice over. A source chip is a `ns-resize` drag with an inline
 * `×` inside it — neither a `createChip` (which would swallow the drag into a
 * click) nor a `createKnob` (which has a dial and a label). And `＋` opens an
 * inline list under the card, not an Obsidian `Menu`.
 *
 * One thing to keep straight: the *model* is not per-binding. `Modifier.mods`
 * (the `ModGate[]`) hangs off the modifier, so every card draws the same
 * sources; and the phase chips edit the device-wide `when.moon.range`, so
 * every card shows the same phases selected. Only the envelope is genuinely
 * per-op. No schema field was added to pretend otherwise.
 */
import type { ModGate, ModifierOp } from "../../../../core/types";
import { displayName as prettyName, opGloss, paramName } from "../../../model/copy";
import { addGate, removeGate, removeOp, setEnvelope, setGateAmount, setOpEnabled } from "../../../model/device-edit";
import { type Device, envelopeShape, envelopeShapeName, gatePercent, opValueText } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { phaseTint } from "../../../model/moon-shape";
import { createChip, createLed } from "../../components";
import { beginDrag, markDragTarget } from "../../pointer";
import { openCycleFor } from "../cycle";
import { buildAddTarget } from "./apply";
import type { DeviceWindowContext } from "./context";
import { buildEnvelopeOverlay } from "./env-moon";
import { colourOf, shapeable, tagColour, tagSources } from "./geometry";
import { iconButton } from "./icon-button";
import { togglePhase } from "./when-moon";

/** The prototype's `srcAmtDown`: 120 px of upward drag is the whole [0, 1] gate strength. */
const AMOUNT_PX = 120;

/**
 * One card per binding, in `apply` order. `sources` and `phases` are the same
 * on every card by construction — see the header — so they are read once.
 */
export function buildBindCards(c: DeviceWindowContext, d: Device, moon: string): void {
  const box = c.body.createDiv({ cls: "wadjet-studio-device-binds", attr: { "data-section": "binds" } });
  const seasons = c.calendar()?.seasons ?? [];
  const named = c.calendar()?.moons.find((m) => m.name === moon)?.phases ?? [];
  const selected = d.when.kind === "moon" ? d.when.phases : [];

  d.apply.forEach((op, i) => {
    const card = box.createDiv({ cls: "wadjet-studio-device-bind", attr: { "data-part": `bind-${i}`, "data-param": op.param } });
    card.setCssProps({ "--wadjet-studio-device-bind-color": colourOf(op.param) });
    buildHead(c, card, op, i);
    buildModRow(c, card, d, op, i, { moon, seasons, named, selected });
    if (c.srcPick() === i) buildSourceList(c, card, d, seasons);
    // The overlay is the card's SIBLING, not its child (`0699` l.75): the plot
    // is the device body's full content width, and the card's own padding
    // would push it past the panel. It still reads as "under this card" —
    // it is drawn between the open card and the next one.
    if (c.envOpen() === i && op.envelope !== undefined) buildEnvelopeOverlay(c, box, op, i);
  });

  // `＋ Add target` closes the stack (`0699` l.95): full width, under the last
  // card and its overlay. It lives in `apply.ts` — adding a binding is an
  // APPLY edit — and is drawn here because that is where the prototype puts it.
  buildAddTarget(c, box, d);
}

/** Line 1 (`0699` l.45-53): `● storm odds ×1.50 · scale · precipitation.pwd · ∿ Ease in · ×`. */
function buildHead(c: DeviceWindowContext, card: HTMLElement, op: ModifierOp, i: number): void {
  const head = card.createDiv({ cls: "wadjet-studio-device-bind-head" });
  // The prototype's 7 px channel dot, and also the op's mute. The Stormtide
  // bindings carry no power switch, but `ModifierOp.enabled` exists and the
  // moon row's knobs are bare (`apply.ts`), so this is the ONLY place a moon
  // device can reach it — the dot doubles as the lamp rather than the panel
  // losing a control the moment WHEN is switched to moon.
  const on = op.enabled !== false;
  card.toggleClass("is-off", !on);
  const led = createLed(head, {
    on,
    scope: "op",
    color: colourOf(op.param),
    hint: deviceHint("device.op.power"),
    onToggle: (next) => c.mutate((x) => setOpEnabled(x, i, next), true),
  });
  led.el.setAttr("data-part", `op-power-${i}`);
  c.addPart(led);
  // `storm odds`, not `precip`: on a card the name stands alone with no knob
  // row over it to give it context, which is exactly what `copy.ts` keeps the
  // `macro` vocabulary for ("the Stormtide bindings").
  head.createSpan({ cls: "wadjet-studio-device-bind-name", text: paramName(op.param, "macro") });
  head.createSpan({ cls: "wadjet-studio-device-bind-value", text: opValueText(op, c.ctx.units()) });
  head.createSpan({ cls: "wadjet-studio-device-bind-path", text: opGloss(op) });

  const open = c.envOpen() === i;
  const shape = iconButton(head, {
    text: `∿ ${envelopeShapeName(op.envelope)}`,
    label: `Onset shape for ${op.param}`,
    hint: deviceHint("device.envelope.shape"),
    cls: "wadjet-studio-device-shape",
    onClick: () => {
      c.setEnvOpen(open ? null : i);
      c.invalidate();
    },
  });
  shape.setAttrs({ "data-part": `shape-${i}`, "aria-pressed": open ? "true" : "false" });
  shape.toggleClass("is-open", open);

  const drop = iconButton(head, {
    text: "×",
    label: `Remove ${op.param}`,
    hint: deviceHint("device.op.remove"),
    cls: "wadjet-studio-device-remove",
    onClick: () => {
      c.setEnvOpen(null);
      c.setSrcPick(null);
      c.mutate((x) => removeOp(x, i), true);
    },
  });
  drop.setAttr("data-part", `bind-remove-${i}`);
}

/** Line 2 (`0699` l.55-63): `MOD · moon:Sable · mode · phases or sources · ＋`. */
function buildModRow(
  c: DeviceWindowContext,
  card: HTMLElement,
  d: Device,
  op: ModifierOp,
  i: number,
  world: { moon: string; seasons: ReadonlyArray<{ name: string }>; named: ReadonlyArray<{ name: string; at: number }>; selected: readonly string[] },
): void {
  const row = card.createDiv({ cls: "wadjet-studio-device-bind-mod" });
  row.createSpan({ cls: "wadjet-studio-device-mod-label", text: "MOD" });

  const carrier = createChip(row, {
    label: `moon:${world.moon}`,
    color: "var(--wadjet-studio-moon)",
    hint: deviceHint("device.mod.carrier"),
    onClick: () => openCycleFor(c.ctx, world.moon),
  });
  carrier.el.addClass("is-carrier");
  c.addPart(carrier);

  // `curve` is not a stored mode: an op that carries an envelope rides it, and
  // an op that does not falls back to the device's own phase window. Only a
  // `shapeable` op has an onset to shape, so a `set` gets no toggle rather
  // than a toggle that does nothing.
  const curve = op.envelope !== undefined;
  if (shapeable(op)) {
    const mode = iconButton(row, {
      text: curve ? "∿ curve" : "▦ phases",
      label: curve ? "Cycle mode: curve" : "Cycle mode: phases",
      hint: deviceHint("device.mod.mode"),
      cls: "wadjet-studio-device-toggle",
      onClick: () =>
        c.mutate((x) => setEnvelope(x, i, curve ? undefined : envelopeShape("Ease in")), true),
    });
    mode.setAttrs({ "data-part": `mod-mode-${i}`, "aria-pressed": curve ? "true" : "false" });
  }

  if (!curve) buildPhaseChips(c, row, world.named, world.selected);
  d.mods.forEach((gate, gi) => buildSourceChip(c, row, gate, gi, world.seasons));

  const picking = c.srcPick() === i;
  const add = iconButton(row, {
    text: "＋",
    label: "Add a modulation source",
    hint: deviceHint("device.gate.add"),
    cls: "wadjet-studio-device-src-add",
    onClick: () => {
      c.setSrcPick(picking ? null : i);
      c.invalidate();
    },
  });
  add.setAttrs({ "data-part": `src-add-${i}`, "aria-pressed": picking ? "true" : "false" });
}

/**
 * The phase chips, in the card rather than the WHEN row (gap2 B6). They read
 * and write the device-wide `[a, b)`, so every card shows the same selection.
 * A selected chip's rim runs the cycle's own tint ramp — the number leaves
 * TypeScript, the colour never does (`model/moon-shape.ts`).
 */
function buildPhaseChips(c: DeviceWindowContext, row: HTMLElement, named: ReadonlyArray<{ name: string; at: number }>, selected: readonly string[]): void {
  named.forEach((phase, at) => {
    const on = selected.includes(phase.name);
    const chip = createChip(row, {
      label: phase.name,
      dot: false,
      hint: deviceHint("device.when.phase"),
      onClick: () => togglePhase(c, named, phase.name),
    });
    const mid = (phase.at + (named[at + 1]?.at ?? 1)) / 2;
    chip.el.setCssProps({ "--wadjet-studio-phase-tint": phaseTint(mid).toFixed(3) });
    chip.el.toggleClass("is-selected", on);
    chip.el.setAttrs({ "data-phase": phase.name, "aria-pressed": on ? "true" : "false" });
    c.addPart(chip);
  });
  // The ends do not sit on boundaries, or the moon has no named phases at all:
  // the window is a hand-written arc, and says so rather than showing nothing
  // (the line the WHEN row used to carry).
  if (!named.some((p) => selected.includes(p.name))) c.addPart(createChip(row, { label: "custom range", dot: false, hint: deviceHint("device.when.phase") }));
}

/** `⚑ Harvest 72% ×` — drag the chip to set the gate's strength, click the `×` to drop the source (`0699` l.60). */
function buildSourceChip(c: DeviceWindowContext, row: HTMLElement, gate: ModGate, gi: number, seasons: ReadonlyArray<{ name: string }>): void {
  const chip = row.createDiv({
    cls: "wadjet-studio-device-src",
    attr: {
      "data-part": `gate-chip-${gi}`,
      "data-source": gate.source,
      role: "slider",
      tabindex: "0",
      "aria-label": `Gate amount for ${gate.source}`,
      "aria-valuenow": gate.amount.toFixed(2),
      "data-hint": deviceHint("device.gate.drag"),
    },
  });
  chip.setCssProps({ "--wadjet-studio-chip-color": tagColour(gate.source, seasons) });
  markDragTarget(chip);
  chip.createSpan({ cls: "wadjet-studio-device-src-flag", text: "⚑", attr: { "aria-hidden": "true" } });
  chip.createSpan({ cls: "wadjet-studio-device-src-name", text: prettyName(gate.source) });
  const pct = chip.createSpan({ cls: "wadjet-studio-device-src-pct", text: gatePercent(gate.amount) });
  chip.addEventListener("pointerdown", (ev: PointerEvent) => startAmountDrag(c, ev, chip, pct, gi, gate.amount));

  const drop = iconButton(chip, {
    text: "×",
    label: `Remove gate ${gate.source}`,
    hint: deviceHint("device.gate.remove"),
    cls: "wadjet-studio-device-src-drop",
    onClick: () => c.mutate((x) => removeGate(x, gi), true),
  });
  drop.setAttr("data-part", `gate-drop-${gi}`);
  // The prototype's `removeSource` opens with `stopPropagation()` for exactly
  // this: without it the `×` is also the first pixel of a drag.
  drop.addEventListener("pointerdown", (ev) => ev.stopPropagation());
}

/**
 * The prototype's `srcAmtDown`: ±1/120 per pixel, upward is more. Rebuilds
 * are held for the gesture, so the chip repaints its own readout the way a
 * knob does rather than waiting for the panel to come back.
 */
function startAmountDrag(c: DeviceWindowContext, ev: PointerEvent, chip: HTMLElement, pct: HTMLElement, gi: number, from: number): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  c.beginLive();
  const cancel = beginDrag(ev, {
    capture: chip,
    onMove: (move) => {
      const amount = Math.max(0, Math.min(1, from + (ev.clientY - move.clientY) / AMOUNT_PX));
      c.mutate((x) => setGateAmount(x, gi, amount), false);
      pct.setText(gatePercent(amount));
      chip.setAttr("aria-valuenow", amount.toFixed(2));
    },
    onEnd: (_end, _dx, _dy, moved) => {
      c.setCancelDrag(null);
      if (moved) c.endGesture();
    },
  });
  c.setCancelDrag(cancel);
}

/** `⚑ season:Harvest   gate · sources multiply` — the inline list `＋` opens (`0699` l.66-74). */
function buildSourceList(c: DeviceWindowContext, card: HTMLElement, d: Device, seasons: ReadonlyArray<{ name: string }>): void {
  const list = card.createDiv({ cls: "wadjet-studio-device-srclist", attr: { "data-part": "src-list" } });
  const used = d.mods.map((g) => g.source);
  const offered = tagSources(seasons, c.ctx.store.get().world.eras).filter((t) => !used.includes(t));
  if (offered.length === 0) {
    list.createDiv({ cls: "wadjet-studio-device-srcrow is-empty", text: "No seasons or eras yet" });
    return;
  }
  for (const source of offered) {
    // `iconButton` for the click and the keyboard; the flag it is given as its
    // text is the row's leading glyph, and the two spans follow it.
    const row = iconButton(list, {
      text: "⚑",
      label: `Gate on ${source}`,
      hint: deviceHint("device.gate.add"),
      cls: "wadjet-studio-device-srcrow",
      onClick: () => {
        c.setSrcPick(null);
        c.mutate((x) => void addGate(x, source, 1), true);
      },
    });
    row.setCssProps({ "--wadjet-studio-chip-color": tagColour(source, seasons) });
    row.setAttr("data-source", source);
    row.createSpan({ cls: "wadjet-studio-device-srcrow-name", text: source });
    row.createSpan({ cls: "wadjet-studio-device-srcrow-note", text: "gate · sources multiply" });
  }
}
