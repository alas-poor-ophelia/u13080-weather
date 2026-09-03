/**
 * The MOD section — the prototype's mod matrix. A carrier row
 * (`moon:Sable` × `∿ curve / ▦ phases` × season gate chips) writes
 * `Modifier.mods[]`; the onset envelope editor under it writes
 * `ModifierOp.envelope` (SPEC §7, §7a).
 */
import { Menu } from "obsidian";
import type { ModifierOp } from "../../../../core/types";
import { opGloss, paramName } from "../../../model/copy";
import { addGate, removeGate, setEnvelope, setGateAmount, setGateSource } from "../../../model/device-edit";
import { type Device, ENVELOPE_SHAPES, envelopeShape, envelopeShapeName, gatePercent } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChart, createChip } from "../../components";
import { openCycleFor } from "../cycle";
import { ENVELOPE_H, ENVELOPE_MIN_GAP, ENVELOPE_W, LAST_PHASE } from "./constants";
import type { DeviceWindowContext } from "./context";
import { colourOf, shapeable, tagColour, tagSources } from "./geometry";
import { iconButton } from "./icon-button";

// --- MOD ----------------------------------------------------------------

export function buildMod(c: DeviceWindowContext, d: Device): void {
  const envelopes = d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.envelope !== undefined);
  // A moon-bound device always has a carrier, so its matrix is always on
  // show; every other kind earns the section by having a gate, an envelope,
  // or a click on `＋ mod`.
  const always = d.when.kind === "moon";
  if (!always && d.mods.length === 0 && envelopes.length === 0 && !c.modOpen()) {
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

  const sec = c.section("MOD", "device.mod", { qualifier: always ? "every cycle" : "gates" });
  iconButton(sec.head, {
    text: "＋ gate",
    label: "Add a gate",
    hint: deviceHint("device.gate.add"),
    cls: "wadjet-studio-device-add",
    onClick: (ev) => openGateMenu(c, ev, d),
  });

  const row = sec.content.createDiv({ cls: "wadjet-studio-device-mod-row" });
  row.createSpan({ cls: "wadjet-studio-device-mod-label", text: "MOD" });
  if (d.when.kind === "moon") buildCarrier(c, row, d, envelopes.length > 0);
  buildGates(c, row, d);

  for (const { op, i } of envelopes) buildEnvelope(c, sec.content, op, i);
}

/** `moon:Sable × ∿ curve / ▦ phases` — the carrier and how it reads the cycle. */
function buildCarrier(c: DeviceWindowContext, row: HTMLElement, d: Device, curve: boolean): void {
  const moon = d.when.kind === "moon" ? d.when.moon : "";
  const chip = createChip(row, {
    label: `moon:${moon}`,
    color: "var(--wadjet-studio-moon)",
    hint: deviceHint("device.mod.carrier"),
    onClick: () => openCycleFor(c.ctx, moon),
  });
  chip.el.addClass("is-carrier");
  c.addPart(chip);
  const mode = iconButton(row, {
    text: curve ? "∿ curve" : "▦ phases",
    label: curve ? "Cycle mode: curve" : "Cycle mode: phases",
    hint: deviceHint("device.mod.mode"),
    cls: "wadjet-studio-device-toggle",
    onClick: () =>
      c.mutate((x) => {
        if (curve) {
          // Back to phases: the gate is the phase chips again.
          x.apply.forEach((_, i) => setEnvelope(x, i, undefined));
          return;
        }
        const first = shapeable(x)[0];
        if (first !== undefined) setEnvelope(x, first.i, envelopeShape("Ease in"));
      }, true),
  });
  mode.setAttrs({ "data-part": "mod-mode", "aria-pressed": curve ? "true" : "false" });
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

  /** Keep a dragged point between its neighbours: `setEnvelope` sorts, and a reorder mid-drag would swap the handle. */
  const move = (at: number, phase: number, strength: number): ((d: Device) => void) => {
    const lo = at === 0 ? 0 : (points[at - 1]?.[0] ?? 0) + ENVELOPE_MIN_GAP;
    const hi = at === points.length - 1 ? LAST_PHASE : (points[at + 1]?.[0] ?? LAST_PHASE) - ENVELOPE_MIN_GAP;
    const x = Math.min(Math.max(phase, lo), Math.max(lo, hi));
    return (d) => {
      const current_ = d.apply[index]?.envelope;
      if (current_ === undefined) return;
      setEnvelope(
        d,
        index,
        current_.map((p, k): [number, number] => (k === at ? [x, strength] : p)),
      );
    };
  };

  const chart = createChart(box, {
    kind: "automation",
    domain: "cycle",
    width: ENVELOPE_W,
    height: ENVELOPE_H,
    yRange: [0, 1],
    editable: true,
    series: [{ points: points.map((p): [number, number] => [p[0], p[1]]), color: "var(--wadjet-studio-accent)" }],
    onPoint: (at, x, y, phase) => c.gesture(phase, move(at, x, y)),
    onAdd: (x, y) =>
      c.mutate((d) => {
        const current_ = d.apply[index]?.envelope;
        if (current_ === undefined) return;
        setEnvelope(d, index, [...current_, [x, y]]);
      }, true),
    onRemove: (at) =>
      c.mutate((d) => {
        const current_ = d.apply[index]?.envelope;
        // One point is a flat envelope; zero is the shape the validator rejects.
        if (current_ === undefined || current_.length <= 1) return;
        setEnvelope(
          d,
          index,
          current_.filter((_, k) => k !== at),
        );
      }, true),
  });
  chart.el.setAttr("data-part", `envelope-${index}`);
  c.addPart(chart);
}
