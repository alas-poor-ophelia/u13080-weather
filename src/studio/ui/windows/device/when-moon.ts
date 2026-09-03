/**
 * WHEN · moon — the carrier chip, the moon picker, and the gate disc whose two
 * handles drag `when.moon.range` (SPEC §5). The phase chips are the same
 * `[a, b)` seen the other way round — dragging a handle rewrites the phases,
 * toggling a phase rewrites the range — and they live on the binding cards
 * now (`mod-moon.ts`, gap2 B6), so `togglePhase` is exported to them. The disc
 * is built from `apply.ts`, which owns the row it shares with the op knobs.
 */
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { setWhen } from "../../../model/device-edit";
import { moonRange, moonRangeEnd, phasesFor } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChip, createSegmented } from "../../components";
import { beginDrag } from "../../pointer";
import { openCycleFor } from "../cycle";
import { DISC, DISC_C, DISC_FACE_R, DISC_R, HANDLE_R } from "./constants";
import type { DeviceWindowContext } from "./context";
import { moonPath, ringArc, ringPoint, ringSpan } from "./geometry";

export function buildMoon(c: DeviceWindowContext, parent: HTMLElement, name: string, description: CalendarDescription | null): void {
  const moons = description?.moons ?? [];
  const row = parent.createDiv({ cls: "wadjet-studio-device-chips" });
  const carrier = createChip(row, {
    label: `moon:${name}`,
    color: "var(--wadjet-studio-moon)",
    hint: deviceHint("device.when.moon"),
    onClick: () => openCycleFor(c.ctx, name),
  });
  // The carrier wears the moon's own hue on its label and a 7 px dot, where a
  // tag chip is dim text and a 5 px one (`1095` l.37 against l.47).
  carrier.el.addClass("is-carrier");
  c.addPart(carrier);
  // No phase chips here: on the moon path they live on the binding cards
  // (`mod-moon.ts`, gap2 B6). What stays in the WHEN row is the carrier and,
  // where the world has more than one moon, the picker.

  if (moons.length > 1) {
    const picker = createSegmented(parent, {
      options: moons.map((m) => ({ value: m.name, label: m.name, hint: deviceHint("device.when.moonPick") })),
      value: name,
      onChange: (next) =>
        c.mutate((x) => {
          if (x.when.kind !== "moon") return;
          const target = moons.find((m) => m.name === next)?.phases ?? [];
          const keep = x.when.phases.filter((p) => target.some((q) => q.name === p));
          const to = keep.length > 0 ? moonRange(target, keep) : ([x.when.range[0], x.when.range[1]] as [number, number]);
          setWhen(x, { kind: "moon", moon: next, phases: phasesFor(target, to), range: to });
        }, true),
    });
    picker.el.setAttr("data-part", "when-moon");
    c.addPart(picker);
  }
}

/**
 * The signature control of a moon-bound device (`proto-win-stormtide.png`):
 * the lit face at the middle of the gate, the gate arc round the rim, and a
 * handle on each end. Dragging a handle writes `when.moon.phase` — which is
 * the compiled `[a, b)` the engine reads, so the phase chips follow it back.
 *
 * It is not built here: on the moon path the disc shares one flex row with the
 * op knobs (`0699` l.21-40), so `apply.ts` places it (gap2 B1).
 */
export function buildGateDisc(c: DeviceWindowContext, parent: HTMLElement, range: [number, number], moonName: string): void {
  const box = parent.createDiv({ cls: "wadjet-studio-device-gate-disc", attr: { "data-hint": deviceHint("device.when.gate") } });
  const svg = box.createSvg("svg", { attr: { viewBox: `0 0 ${DISC} ${DISC}`, role: "img", "aria-label": `Moon gate ${range[0].toFixed(2)} to ${endLabel(range)}` } });
  // The face is the prototype's door to the moon's CYCLE editor
  // (`data-vst="sablemoon"` on the circle and the lit path); the handles
  // keep their drag and never open anything.
  svg.addEventListener("click", (ev: MouseEvent) => {
    if ((ev.target as Element | null)?.closest("[data-gate]") !== null) return;
    openCycleFor(c.ctx, moonName);
  });
  svg.createSvg("circle", { cls: "wadjet-studio-device-disc-face", attr: { cx: DISC_C, cy: DISC_C, r: DISC_R } });
  const mid = range[0] + ringSpan(range[0], range[1]) / 2;
  svg.createSvg("path", { cls: "wadjet-studio-device-disc-moon", attr: { d: moonPath(((mid % 1) + 1) % 1, DISC_C, DISC_C, DISC_FACE_R) } });
  svg.createSvg("path", { cls: "wadjet-studio-device-disc-arc", attr: { d: ringArc(range[0], range[1]) } });

  ([0, 1] as const).forEach((end) => {
    const at = ringPoint(range[end]);
    const handle = svg.createSvg("circle", {
      cls: "wadjet-studio-device-disc-handle",
      attr: { cx: at.x.toFixed(2), cy: at.y.toFixed(2), r: HANDLE_R, "data-gate": String(end), tabindex: "0", role: "slider", "aria-label": end === 0 ? "Gate start" : "Gate end", "aria-valuenow": range[end].toFixed(2) },
    });
    handle.addEventListener("pointerdown", (ev: PointerEvent) => startGateDrag(c, ev, svg, handle, end));
  });

  // The readout is the prototype's `gateTextEl` (`Component.js` l.1278): a
  // `<text>` INSIDE the disc's own svg, not a line hung under it. Its size is
  // 10 units of the 88-unit viewBox, so it scales with the box and cannot
  // climb into the face under a wider interface font — which is exactly what
  // an absolutely-placed HTML span did. The baseline sits two units past the
  // box foot (the prototype's own is at 84 and grazes the rim); `overflow:
  // visible` on the svg draws it, and the moon row has the room.
  svg
    .createSvg("text", { cls: "wadjet-studio-device-disc-readout", attr: { x: DISC_C, y: DISC + 2, "text-anchor": "middle" } })
    .setText(`gate ${range[0].toFixed(2)}–${endLabel(range)}`);
}

/**
 * The window's END as a reader sees it. `[a, b)` is stored wrapped, so a gate
 * that runs to the top of the cycle stores `b = 0` — and `gate 0.86–0.00`
 * reads as a window that closes before it opens. The last phase of a cycle is
 * 1.00, which is the same instant and the only one that scans (the prototype's
 * own `gate 0.78-1.00`).
 */
const endLabel = (range: [number, number]): string => moonRangeEnd(range).toFixed(2);

function startGateDrag(c: DeviceWindowContext, ev: PointerEvent, svg: SVGElement, node: SVGElement, end: 0 | 1): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  c.beginLive();
  const phaseAt = (move: MouseEvent): number => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return 0;
    const x = ((move.clientX - rect.left) / rect.width) * DISC - DISC_C;
    const y = ((move.clientY - rect.top) / rect.height) * DISC - DISC_C;
    const deg = (Math.atan2(x, -y) * 180) / Math.PI;
    return ((deg / 360) % 1 + 1) % 1;
  };
  const cancel = beginDrag(ev, {
    capture: node,
    onMove: (move) => setGate(c, end, phaseAt(move), false),
    onEnd: (_end, _dx, _dy, moved) => {
      c.setCancelDrag(null);
      if (moved) c.endGesture();
    },
  });
  c.setCancelDrag(cancel);
}

function setGate(c: DeviceWindowContext, end: 0 | 1, phase: number, history: boolean): void {
  const moons = c.calendar()?.moons ?? [];
  c.mutate((x) => {
    if (x.when.kind !== "moon") return;
    const named = moons.find((m) => m.name === (x.when as { moon: string }).moon)?.phases ?? [];
    const next: [number, number] = end === 0 ? [phase, x.when.range[1]] : [x.when.range[0], phase];
    setWhen(x, { kind: "moon", moon: x.when.moon, phases: phasesFor(named, next), range: next });
  }, history);
}

/** Toggle one phase in the device-wide window; the cards call it, so it is exported (`mod-moon.ts`). */
export function togglePhase(c: DeviceWindowContext, named: ReadonlyArray<{ name: string; at: number }>, name: string): void {
  c.mutate((x) => {
    if (x.when.kind !== "moon") return;
    const chosen = new Set(x.when.phases);
    if (chosen.has(name)) chosen.delete(name);
    else chosen.add(name);
    const range = moonRange(
      named,
      named.filter((p) => chosen.has(p.name)).map((p) => p.name),
    );
    setWhen(x, { kind: "moon", moon: x.when.moon, phases: phasesFor(named, range), range });
  }, true);
}
