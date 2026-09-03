/**
 * The MOD section — the prototype's mod matrix. A carrier row
 * (season gate chips) writes `Modifier.mods[]`; the onset envelope editor
 * under it writes `ModifierOp.envelope` (SPEC §7, §7a).
 *
 * The moon path does not come through here: a moon-bound device is edited per
 * *binding*, one card per apply target, and those live in `mod-moon.ts`
 * (gap2 B4) — with their own envelope overlay in `env-moon.ts`. What the two
 * editors share is the point-editing itself (`envelopeEdits`), not the card.
 */
import { Menu } from "obsidian";
import type { ModifierOp } from "../../../../core/types";
import { opGloss, paramName } from "../../../model/copy";
import { addGate, removeGate, setEnvelope, setGateAmount, setGateSource } from "../../../model/device-edit";
import { type Device, ENVELOPE_SHAPES, envelopeShape, envelopeShapeName, gatePercent } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChart, createChip } from "../../components";
import { ENVELOPE_H, ENVELOPE_W } from "./constants";
import type { DeviceWindowContext } from "./context";
import { envelopeEdits } from "./env-moon";
import { colourOf, tagColour, tagSources } from "./geometry";
import { iconButton } from "./icon-button";
import { buildBindCards } from "./mod-moon";

// --- MOD ----------------------------------------------------------------

export function buildMod(c: DeviceWindowContext, d: Device): void {
  // A moon-bound device is edited per binding, not per device (gap2 B4): one
  // card per apply target, and no MOD caption above them (`0699` l.42-64).
  if (d.when.kind === "moon") {
    buildBindCards(c, d, d.when.moon);
    return;
  }

  const envelopes = d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.envelope !== undefined);
  // Every other kind earns the section by having a gate, an envelope, or a
  // click on `＋ mod`.
  if (d.mods.length === 0 && envelopes.length === 0 && !c.modOpen()) {
    // …except the spell path, which ends at the apply row: `0905` has no `＋
    // mod` and neither does `1095` (gap2 C10).
    if (d.when.kind === "yearWindow") return;
    iconButton(c.body, {
      text: "＋ mod",
      label: "Add a gate or an envelope",
      hint: deviceHint("device.mod"),
      cls: "wadjet-studio-device-add-mod",
      onClick: () => {
        c.setModOpen(true);
        c.invalidate();
      },
    });
    return;
  }

  const sec = c.section("MOD", "device.mod", { qualifier: "gates" });
  iconButton(sec.head, {
    text: "＋ gate",
    label: "Add a gate",
    hint: deviceHint("device.gate.add"),
    cls: "wadjet-studio-device-add",
    onClick: (ev) => openGateMenu(c, ev, d),
  });

  const row = sec.content.createDiv({ cls: "wadjet-studio-device-mod-row" });
  row.createSpan({ cls: "wadjet-studio-device-mod-label", text: "MOD" });
  buildGates(c, row, d);

  for (const { op, i } of envelopes) buildEnvelope(c, sec.content, op, i);
}

/** The season/era gate chips — `⚑ Harvest 72% ×`, with the dimmer on its own small knob. */
function buildGates(c: DeviceWindowContext, row: HTMLElement, d: Device): void {
  const seasons = c.calendar()?.seasons ?? [];
  d.mods.forEach((gate, i) => {
    const cell = row.createDiv({ cls: "wadjet-studio-device-gate", attr: { "data-source": gate.source } });
    c.addPart(
      createChip(cell, {
        label: `${gate.source} ${gatePercent(gate.amount)}`,
        color: tagColour(gate.source, seasons),
        icon: "⚑",
        hint: deviceHint("device.gate.source"),
        onClick: () => openGateSourceMenu(c, cell, i),
      }),
    );
    c.knob(cell, {
      part: `gate-${i}`,
      label: "amount",
      min: 0,
      max: 1,
      step: 0.01,
      neutral: 1,
      value: gate.amount,
      size: "sm",
      fmt: (v) => gatePercent(v),
      hint: deviceHint("device.gate.amount"),
      onChange: (v, phase) => c.gesture(phase, (x) => setGateAmount(x, i, v)),
    });
    iconButton(cell, {
      text: "×",
      label: `Remove gate ${gate.source}`,
      hint: deviceHint("device.gate.remove"),
      cls: "wadjet-studio-device-remove",
      onClick: () => c.mutate((x) => removeGate(x, i), true),
    });
  });
}

/** Every `season:*` / `era:*` the world offers that this device is not already gated on. */
function gateSources(c: DeviceWindowContext, used: readonly string[]): string[] {
  const state = c.ctx.store.get();
  return tagSources(c.calendar()?.seasons ?? [], state.world.eras).filter((t) => !used.includes(t));
}

function openGateMenu(c: DeviceWindowContext, ev: MouseEvent, d: Device): void {
  const menu = new Menu();
  const sources = gateSources(c, d.mods.map((g) => g.source));
  for (const source of sources) menu.addItem((item) => item.setTitle(source).onClick(() => c.mutate((x) => void addGate(x, source, 1), true)));
  if (sources.length === 0) menu.addItem((item) => item.setTitle("No seasons or eras yet").setDisabled(true));
  menu.showAtMouseEvent(ev);
}

function openGateSourceMenu(c: DeviceWindowContext, anchor: HTMLElement, index: number): void {
  const menu = new Menu();
  for (const source of gateSources(c, [])) menu.addItem((item) => item.setTitle(source).onClick(() => c.mutate((x) => setGateSource(x, index, source), true)));
  const box = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: box.left, y: box.bottom });
}

/** The onset envelope on one op: a named shape, or points dragged over the cycle. */
function buildEnvelope(c: DeviceWindowContext, parent: HTMLElement, op: ModifierOp, index: number): void {
  const points = op.envelope ?? [];
  const box = parent.createDiv({ cls: "wadjet-studio-device-envelope", attr: { "data-param": op.param } });
  const head = box.createDiv({ cls: "wadjet-studio-device-envelope-head", attr: { "data-hint": deviceHint("device.envelope") } });
  head.createDiv({ cls: "wadjet-studio-device-dot" }).setCssProps({ "--wadjet-studio-device-dot-color": colourOf(op.param) });
  head.createSpan({ cls: "wadjet-studio-device-envelope-label", text: paramName(op.param) });
  head.createSpan({ cls: "wadjet-studio-device-apply-field", text: opGloss(op) });
  head.createDiv({ cls: "wadjet-studio-device-spacer" });
  iconButton(head, {
    text: `∿ ${envelopeShapeName(points)}`,
    label: "Onset shape",
    hint: deviceHint("device.envelope.shape"),
    cls: "wadjet-studio-device-toggle",
    onClick: (ev) => {
      const menu = new Menu();
      for (const shape of ENVELOPE_SHAPES) menu.addItem((item) => item.setTitle(shape.name).onClick(() => c.mutate((x) => setEnvelope(x, index, envelopeShape(shape.name)), true)));
      menu.showAtMouseEvent(ev);
    },
  });
  iconButton(head, {
    text: "×",
    label: `Remove the envelope on ${op.param}`,
    hint: deviceHint("device.envelope.remove"),
    cls: "wadjet-studio-device-remove",
    onClick: () => c.mutate((x) => setEnvelope(x, index, undefined), true),
  });

  // The point edits are the moon overlay's too (`env-moon.ts`): same field,
  // same `setEnvelope`, and only the first handle's floor differs.
  const edits = envelopeEdits(c, index, points);

  const chart = createChart(box, {
    kind: "automation",
    domain: "cycle",
    width: ENVELOPE_W,
    height: ENVELOPE_H,
    yRange: [0, 1],
    editable: true,
    series: [{ points: points.map((p): [number, number] => [p[0], p[1]]), color: "var(--wadjet-studio-accent)" }],
    onPoint: (at, x, y, phase) => c.gesture(phase, edits.move(at, x, y)),
    onAdd: (x, y) => edits.add(x, y),
    onRemove: (at) => edits.remove(at),
  });
  chart.el.setAttr("data-part", `envelope-${index}`);
  c.addPart(chart);
}
