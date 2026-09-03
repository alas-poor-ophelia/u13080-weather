/**
 * ENV · moon — the envelope overlay that opens under a binding card
 * (`0699-vst-stormtide.html` l.75-93; `1397-logic-class-Component.js`'s
 * `envEditor` / `envDown`, PLAN D15/D16 bead 3).
 *
 * Two things separate it from the device-wide envelope card `mod.ts` still
 * draws on every other kind:
 *
 *  - **It plots the onset, not the cycle.** The prototype's `ex` maps 0.70 →
 *    x 20 and 1.00 → x 330, so the whole 310 px of plot is the last third of
 *    the cycle — which is the only part of it an onset ever occupies. That is
 *    the chart's new `xRange`, and the axis under it reads `0.70 / 0.80 / 0.90
 *    / full ●` rather than a bare [0,1].
 *  - **The presets are a chip row, not a menu.** Five chips, the matching one
 *    lit; clicking one rewrites the points, which is what turns a `custom`
 *    label back into a name. Nothing stores the name — `envelopeShapeName`
 *    recognises the points, so a dragged handle *is* what makes it `custom`.
 *
 * The point-editing closures are shared with `mod.ts` rather than copied: the
 * two editors write the same field through the same `setEnvelope`, and only
 * the floor a first point may be dragged to differs (the overlay's plot starts
 * at 0.70, the card's at 0).
 */
import type { ModifierOp } from "../../../../core/types";
import { paramName } from "../../../model/copy";
import { setEnvelope } from "../../../model/device-edit";
import { type Device, ENVELOPE_SHAPES, envelopeShape, envelopeShapeName, opValueText } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChart } from "../../components";
import { ENV_H, ENV_PAD, ENV_W, ENV_X0, ENVELOPE_MIN_GAP, LAST_PHASE } from "./constants";
import type { DeviceWindowContext } from "./context";
import { iconButton } from "./icon-button";

/** A drawn point this close to zero leaves the curve open at the right edge (the prototype's `> 0.01`). */
const OPEN_END = 0.01;

/** The three edits an envelope plot makes, over one op's current points. */
export interface EnvelopeEdits {
  /** A handle moved to `(phase, strength)`, kept between its neighbours. */
  move(at: number, phase: number, strength: number): (d: Device) => void;
  add(phase: number, strength: number): void;
  remove(at: number): void;
}

/**
 * The point edits both envelope editors make. `floor` is the lowest phase the
 * FIRST handle may be dragged to — 0 on the device-wide card, the plot's own
 * left edge on the moon overlay, exactly as the prototype's `envDown` clamps.
 *
 * Every closure re-reads the op out of the draft it is handed: the points this
 * was built over are a render-old copy, and a drag runs across many frames.
 */
export function envelopeEdits(c: DeviceWindowContext, index: number, points: ReadonlyArray<readonly [number, number]>, floor = 0): EnvelopeEdits {
  return {
    // `setEnvelope` sorts, and a reorder mid-drag would swap the handle out
    // from under the finger — so a point stays between its neighbours.
    move(at, phase, strength) {
      const lo = at === 0 ? floor : (points[at - 1]?.[0] ?? floor) + ENVELOPE_MIN_GAP;
      const hi = at === points.length - 1 ? LAST_PHASE : (points[at + 1]?.[0] ?? LAST_PHASE) - ENVELOPE_MIN_GAP;
      const x = Math.min(Math.max(phase, lo), Math.max(lo, hi));
      return (d) => {
        const current = d.apply[index]?.envelope;
        if (current === undefined) return;
        setEnvelope(
          d,
          index,
          current.map((p, k): [number, number] => (k === at ? [x, strength] : p)),
        );
      };
    },
    add(phase, strength) {
      c.mutate((d) => {
        const current = d.apply[index]?.envelope;
        if (current === undefined) return;
        setEnvelope(d, index, [...current, [phase, strength]]);
      }, true);
    },
    remove(at) {
      c.mutate((d) => {
        const current = d.apply[index]?.envelope;
        // One point is a flat envelope; zero is the shape the validator rejects.
        if (current === undefined || current.length <= 1) return;
        setEnvelope(
          d,
          index,
          current.filter((_, k) => k !== at),
        );
      }, true);
    },
  };
}

/**
 * The overlay itself. Drawn as the open card's next sibling rather than inside
 * it: the plot is the panel's full content width by design (the prototype's
 * 344 IS the device body's content box), and a card's own 9 px padding would
 * push it past the panel's edge.
 */
export function buildEnvelopeOverlay(c: DeviceWindowContext, parent: HTMLElement, op: ModifierOp, index: number): void {
  const points = op.envelope ?? [];
  const box = parent.createDiv({ cls: "wadjet-studio-device-env", attr: { "data-part": `env-overlay-${index}`, "data-param": op.param } });
  buildHead(c, box, op, index, points);
  buildPlot(c, box, index, points);
}

/** `envelope · storm odds (×1.50 at full strength)` and the five preset chips (`0699` l.77-83). */
function buildHead(c: DeviceWindowContext, box: HTMLElement, op: ModifierOp, index: number, points: ReadonlyArray<readonly [number, number]>): void {
  const head = box.createDiv({ cls: "wadjet-studio-device-env-head", attr: { "data-hint": deviceHint("device.envelope.overlay") } });
  // The `macro` name, as on the card above it: `storm odds`, not `precip`.
  head.createSpan({
    cls: "wadjet-studio-device-env-title",
    text: `envelope · ${paramName(op.param, "macro")} (${opValueText(op, c.ctx.units())} at full strength)`,
  });
  head.createDiv({ cls: "wadjet-studio-device-spacer" });

  const lit = envelopeShapeName(points);
  for (const shape of ENVELOPE_SHAPES) {
    const on = shape.name === lit;
    const chip = iconButton(head, {
      text: shape.name,
      label: `Onset shape ${shape.name}`,
      hint: deviceHint("device.envelope.preset"),
      cls: "wadjet-studio-device-env-preset",
      onClick: () => c.mutate((x) => setEnvelope(x, index, envelopeShape(shape.name)), true),
    });
    chip.setAttrs({ "data-env": shape.name, "aria-pressed": on ? "true" : "false" });
    chip.toggleClass("is-on", on);
  }
}

/**
 * The 344 × 98 plot. Two series, not one: `series[0]` is the op's own points,
 * so the handles land on them and their indices are the op's; `series[1]` is
 * the same curve with the prototype's two skirts — down to the plot's floor at
 * 0.70, and out to `full` when the last point is still lifted — carrying the
 * fill. `drawAutomation` paints the tail of the list first, so the skirted
 * copy sits under the editable one and the two lines coincide.
 */
function buildPlot(c: DeviceWindowContext, box: HTMLElement, index: number, points: ReadonlyArray<readonly [number, number]>): void {
  const line = points.map((p): [number, number] => [p[0], p[1]]);
  const last = line[line.length - 1];
  const skirted: Array<[number, number]> = line.length === 0 ? [] : [[ENV_X0, 0], ...line, ...(last !== undefined && last[1] > OPEN_END ? [[1, last[1]] as [number, number]] : [])];
  const edits = envelopeEdits(c, index, points, ENV_X0);
  const plot = box.createDiv({ cls: "wadjet-studio-device-env-plot" });

  const chart = createChart(plot, {
    kind: "automation",
    domain: "cycle",
    width: ENV_W,
    height: ENV_H,
    pad: { ...ENV_PAD },
    xRange: [ENV_X0, 1],
    yRange: [0, 1],
    editable: true,
    series: [
      { points: line, color: "var(--wadjet-studio-accent)", width: 1.8 },
      { points: skirted, color: "var(--wadjet-studio-accent)", width: 1.8, fill: true },
    ],
    ticks: [
      { value: 0, label: "0" },
      { value: 1, label: "1" },
    ],
    // `full ●` is a reading, not a scale mark: it takes the carrier's own hue.
    xTicks: [
      { value: 0.7, label: "0.70" },
      { value: 0.8, label: "0.80" },
      { value: 0.9, label: "0.90" },
      { value: 1, label: "full ●", color: "var(--wadjet-studio-moon)" },
    ],
    onPoint: (at, x, y, phase) => c.gesture(phase, edits.move(at, x, y)),
    onAdd: (x, y) => edits.add(x, y),
    onRemove: (at) => edits.remove(at),
  });
  chart.el.setAttr("data-part", `env-chart-${index}`);
  c.addPart(chart);
}
