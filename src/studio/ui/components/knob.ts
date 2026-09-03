/**
 * Knob — the studio's only value control (SPEC law 6): a bevelled dial that
 * drags ↕, sweeps −135°…+135°, and fills a power arc from its neutral.
 * All the arithmetic lives in `src/studio/model/knob.ts`; this file is the
 * dial, the pointer, the keyboard and the typed-entry input.
 *
 * Three sizes, from the prototype: `sm` 30 px (a list row's inline knob),
 * `md` 36 px (a window's WHEN / SPELL knobs, the default) and `lg` 44 px
 * (an APPLY knob). The body itself is a CSS bevel on `.…-knob-dial`; the SVG
 * carries only the track, the power arc and the pointer, and overhangs the
 * body by 6 px on every side so the arc sweeps *outside* the disc the way
 * the prototype's does.
 *
 * DOM order is dial → label → value, but the label paints *below* the dial
 * (CSS `order`), matching the prototype's knob · label · value stack while
 * leaving the e2e's element order alone.
 */
import { arcAngles, dragToValue, nudge, nudgeBy, parseTyped, valueToAngle, type KnobSpec } from "../../model/knob";
import { beginDrag, markDragTarget, noteTouchPointer } from "../pointer";

export type KnobPhase = "drag" | "end" | "key" | "type";

/** 30 px · 36 px · 44 px — the prototype's three knob sizes. */
export type KnobSize = "sm" | "md" | "lg";

export interface KnobProps {
  spec: KnobSpec;
  value: number;
  label: string;
  /** Renders the value under the dial — units included. */
  fmt: (v: number) => string;
  /**
   * Parses typed entry into a value in `spec`'s own domain. Defaults to
   * `parseTyped(text, spec)` — correct whenever `fmt` renders `spec`'s own
   * units unchanged. A caller whose `fmt` converts to display units (SPEC
   * §8) supplies this so a typed value converts back the same way (H-1384;
   * `model/knob-units.ts`'s `parseDisplay`) — the knob itself stays metric
   * either way, only the read/write edges differ.
   */
  parse?: (text: string) => number | null;
  /** Power arc and indicator colour; defaults to the studio accent. */
  color?: string;
  hint?: string;
  /** Dial diameter; defaults to `md` (36 px). */
  size?: KnobSize;
  onChange(value: number, phase: KnobPhase): void;
  disabled?: boolean;
}

/**
 * SVG user units: the face is a 100×100 viewBox mapped over the dial plus its
 * 6 px overhang, so `ARC_R` 47 puts the power arc just outside the body edge
 * at every size — the prototype's `M 16.8 83.2 A 47 47 …` track exactly.
 */
const CENTRE = 50;
const ARC_R = 47;

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CENTRE + r * Math.cos(rad), y: CENTRE + r * Math.sin(rad) };
}

/** An SVG arc path between two knob-face angles, both in −135…135. */
function arcPath(from: number, to: number, r: number): string {
  const a = polar(from, r);
  const b = polar(to, r);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  const sweep = to >= from ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export interface KnobComponent {
  el: HTMLElement;
  update(next: Partial<KnobProps>): void;
  destroy(): void;
}

export function createKnob(parent: HTMLElement, initial: KnobProps): KnobComponent {
  let props = initial;
  let cancelDrag: (() => void) | null = null;

  const el = parent.createDiv({ cls: "wadjet-studio-knob" });
  const dial = el.createDiv({ cls: "wadjet-studio-knob-dial" });
  markDragTarget(dial);
  const svg = dial.createSvg("svg", { attr: { viewBox: "0 0 100 100" } });
  svg.createSvg("path", { cls: "wadjet-studio-knob-track", attr: { d: arcPath(-135, 135, ARC_R) } });
  const arc = svg.createSvg("path", { cls: "wadjet-studio-knob-arc" });
  // The pointer is a short bar just inside the body's top edge, rotated about
  // the face centre — the prototype's 2.5 × 11 px tick.
  const ind = svg.createSvg("line", { cls: "wadjet-studio-knob-indicator", attr: { x1: CENTRE, y1: 17, x2: CENTRE, y2: 35 } });

  const label = el.createSpan({ cls: "wadjet-studio-knob-label", text: props.label });
  const readout = el.createSpan({ cls: "wadjet-studio-knob-value" });

  function commit(value: number, phase: KnobPhase): void {
    if (props.disabled) return;
    props = { ...props, value };
    paint();
    props.onChange(value, phase);
  }

  function paint(): void {
    const { spec, value, color } = props;
    el.toggleClass("is-disabled", props.disabled === true);
    el.setAttr("data-size", props.size ?? "md");
    el.setCssProps({ "--wadjet-studio-knob-color": color ?? "var(--wadjet-studio-accent)" });
    const a = arcAngles(value, spec);
    arc.setAttr("d", a ? arcPath(a.from, a.to, ARC_R) : "");
    ind.setAttr("transform", `rotate(${valueToAngle(value, spec).toFixed(2)} ${CENTRE} ${CENTRE})`);
    readout.setText(props.fmt(value));
    // Obsidian's setAttr drops an attribute when handed `false`, so booleans go in as strings.
    dial.setAttrs({
      "aria-valuemin": String(spec.min),
      "aria-valuemax": String(spec.max),
      "aria-valuenow": String(value),
      "aria-valuetext": props.fmt(value),
      "aria-label": props.label,
      "aria-disabled": props.disabled === true ? "true" : "false",
      tabindex: props.disabled ? "-1" : "0",
      role: "slider",
    });
    if (props.hint) dial.setAttr("data-hint", props.hint);
    else dial.removeAttribute("data-hint");
  }

  /** The typed-entry field: replaces the readout until Enter or blur. */
  function openInput(): void {
    if (props.disabled || el.find(".wadjet-studio-knob-input")) return;
    const input = el.createEl("input", { cls: "wadjet-studio-knob-input", type: "text", value: props.fmt(props.value) });
    input.focus();
    input.select();
    // Enter closes the field and moves focus back to the dial, which fires the
    // blur handler below — so `close` has to be idempotent or the value is
    // committed twice (two undo steps) and the second `input.remove()` throws
    // on a node that is no longer in the document.
    let closed = false;
    const close = (apply: boolean): void => {
      if (closed) return;
      closed = true;
      if (apply) {
        const parsed = props.parse ? props.parse(input.value) : parseTyped(input.value, props.spec);
        if (parsed !== null) commit(parsed, "type");
      }
      input.remove();
      dial.focus();
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
  }

  function onPointerDown(ev: PointerEvent): void {
    if (props.disabled || ev.button !== 0) return;
    noteTouchPointer(ev, dial);
    ev.preventDefault();
    dial.focus();
    const start = props.value;
    cancelDrag = beginDrag(ev, {
      capture: dial,
      onMove: (move, _dx, dy) => commit(dragToValue(start, dy, props.spec, move.shiftKey), "drag"),
      onEnd: (end, _dx, dy, moved) => {
        cancelDrag = null;
        if (moved) commit(dragToValue(start, dy, props.spec, end.shiftKey), "end");
      },
    });
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (props.disabled) return;
    if (ev.key === "ArrowUp" || ev.key === "ArrowRight") commit(nudge(props.value, props.spec, 1, ev.shiftKey), "key");
    else if (ev.key === "ArrowDown" || ev.key === "ArrowLeft") commit(nudge(props.value, props.spec, -1, ev.shiftKey), "key");
    // PageUp/PageDown jump ten steps at once — a coarse nudge for a long way to travel.
    else if (ev.key === "PageUp") commit(nudgeBy(props.value, props.spec, 10, ev.shiftKey), "key");
    else if (ev.key === "PageDown") commit(nudgeBy(props.value, props.spec, -10, ev.shiftKey), "key");
    // Home returns the knob to the angle-zero value — the neutral the power arc grows from.
    else if (ev.key === "Home") commit(props.spec.neutral ?? (props.spec.bipolar ? (props.spec.min + props.spec.max) / 2 : props.spec.min), "key");
    else if (ev.key === "End") commit(props.spec.max, "key");
    else if (ev.key === "Enter") openInput();
    else return;
    ev.preventDefault();
  }

  dial.addEventListener("pointerdown", onPointerDown);
  dial.addEventListener("keydown", onKeyDown);
  dial.addEventListener("dblclick", openInput);
  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      if (next.label !== undefined) label.setText(next.label);
      paint();
    },
    destroy() {
      cancelDrag?.();
      dial.removeEventListener("pointerdown", onPointerDown);
      dial.removeEventListener("keydown", onKeyDown);
      dial.removeEventListener("dblclick", openInput);
      el.remove();
    },
  };
}
