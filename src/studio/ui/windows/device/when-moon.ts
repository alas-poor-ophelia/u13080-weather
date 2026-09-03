/**
 * WHEN · moon — the carrier chip, the phase chips, the moon picker, and the
 * gate disc whose two handles drag `when.moon.range` (SPEC §5). The chips and
 * the disc are two views of one `[a, b)`: dragging a handle rewrites the
 * phases, and toggling a phase rewrites the range.
 */
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { setWhen } from "../../../model/device-edit";
import { moonRange, phasesFor } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChip, createSegmented } from "../../components";
import { beginDrag } from "../../pointer";
import { openCycleFor } from "../cycle";
import { DISC, DISC_C, DISC_FACE_R, DISC_R, HANDLE_R } from "./constants";
import type { DeviceWindowContext } from "./context";
import { moonPath, ringArc, ringPoint, ringSpan } from "./geometry";

export function buildMoon(c: DeviceWindowContext, parent: HTMLElement, name: string, selected: string[], range: [number, number], description: CalendarDescription | null): void {
  const moons = description?.moons ?? [];
  const named = moons.find((m) => m.name === name)?.phases ?? [];
  const row = parent.createDiv({ cls: "wadjet-studio-device-chips" });
  c.addPart(
    createChip(row, {
      label: `moon:${name}`,
      color: "var(--wadjet-studio-moon)",
      hint: deviceHint("device.when.moon"),
      onClick: () => openCycleFor(c.ctx, name),
    }),
  );
  row.createSpan({ cls: "wadjet-studio-device-times", text: "×" });

  for (const phase of named) {
    const on = selected.includes(phase.name);
    const chip = createChip(row, {
      label: phase.name,
      ...(on ? { color: "var(--wadjet-studio-moon)" } : {}),
      dot: false,
      hint: deviceHint("device.when.phase"),
      onClick: () => togglePhase(c, named, phase.name),
    });
    chip.el.toggleClass("is-selected", on);
    chip.el.setAttrs({ "data-phase": phase.name, "aria-pressed": on ? "true" : "false" });
    c.addPart(chip);
  }
  // The ends do not sit on boundaries (or the moon has no named phases):
  // the window is a hand-written arc, and says so rather than lying.
  if (selected.length === 0) c.addPart(createChip(row, { label: "custom range", dot: false, hint: deviceHint("device.when.phase") }));

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

  buildGateDisc(c, parent, range, name);
}

/**
 * The signature control of a moon-bound device (`proto-win-stormtide.png`):
 * the lit face at the middle of the gate, the gate arc round the rim, and a
 * handle on each end. Dragging a handle writes `when.moon.phase` — which is
 * the compiled `[a, b)` the engine reads, so the phase chips follow it back.
 */
function buildGateDisc(c: DeviceWindowContext, parent: HTMLElement, range: [number, number], moonName: string): void {
  const box = parent.createDiv({ cls: "wadjet-studio-device-gate-disc", attr: { "data-hint": deviceHint("device.when.gate") } });
  const svg = box.createSvg("svg", { attr: { viewBox: `0 0 ${DISC} ${DISC}`, role: "img", "aria-label": `Moon gate ${range[0].toFixed(2)} to ${range[1].toFixed(2)}` } });
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

  box.createSpan({ cls: "wadjet-studio-device-disc-readout", text: `gate ${range[0].toFixed(2)}–${range[1].toFixed(2)}` });
}

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

function togglePhase(c: DeviceWindowContext, named: ReadonlyArray<{ name: string; at: number }>, name: string): void {
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
