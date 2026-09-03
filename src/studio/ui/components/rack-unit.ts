/**
 * Rack unit — one card in the mixer rail:
 * `⠿ slot ● Name KIND [⧉] [world · N zones]` over a row of chips.
 * SPEC law 2: the LED and the name are the relational handles — the LED
 * powers the device, the name opens its window. Nothing else is clickable.
 */
import { createChip, type ChipComponent, type ChipProps } from "./chip";
import { createLed, type LedComponent, type LedProps } from "./led";
import { beginDrag, markDragTarget } from "../pointer";

export type GripPhase = "start" | "drag" | "end";

export interface RackUnitProps {
  /** Two-digit slot number, in rack order. */
  slot: string;
  name: string;
  /** The kind pill's word — `moon`, `spell`, `era`, `states`, `master` … */
  kind: string;
  color: string;
  /** Powered off: the whole card recedes rather than disappearing. */
  dim?: boolean;
  /** Shows the ⧉ twin marker: this unit mirrors another surface. */
  linked?: boolean;
  /** Zone count for a world-scoped unit; renders the `world · N zones` badge. */
  world?: number;
  chips: ChipProps[];
  led: LedProps;
  grip?: boolean;
  onOpen(): void;
  onGrip?(phase: GripPhase, dy: number): void;
}

export interface RackUnitComponent {
  el: HTMLElement;
  update(next: Partial<RackUnitProps>): void;
  destroy(): void;
}

export function createRackUnit(parent: HTMLElement, initial: RackUnitProps): RackUnitComponent {
  let props = initial;
  let cancelDrag: (() => void) | null = null;
  let chips: ChipComponent[] = [];

  const el = parent.createDiv({ cls: "wadjet-studio-rack-unit" });
  const head = el.createDiv({ cls: "wadjet-studio-rack-head" });
  // Decorative and pointer-only today (no keyboard reorder path yet): hidden
  // from a screen reader rather than read aloud as a stray glyph.
  const grip = head.createDiv({ cls: "wadjet-studio-rack-grip", text: "⠿", attr: { "aria-hidden": "true" } });
  markDragTarget(grip);
  const slotEl = head.createSpan({ cls: "wadjet-studio-rack-slot" });
  const led: LedComponent = createLed(head, props.led);
  const nameEl = head.createSpan({ cls: "wadjet-studio-rack-name", attr: { role: "button", tabindex: "0" } });
  const kindEl = head.createSpan({ cls: "wadjet-studio-rack-kind" });
  const worldEl = head.createSpan({ cls: "wadjet-studio-rack-world" });
  // The twin glyph sits at the far right of the head row, clear of the pills
  // (the prototype's `<div style="flex:1">` before it).
  head.createDiv({ cls: "wadjet-studio-rack-gap" });
  const linkEl = head.createSpan({ cls: "wadjet-studio-rack-link", text: "⧉", attr: { role: "img", "aria-label": "Linked to another surface" } });
  const chipRow = el.createDiv({ cls: "wadjet-studio-rack-chips" });

  function open(ev: Event): void {
    ev.stopPropagation();
    props.onOpen();
  }

  function onNameKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    open(ev);
  }

  function onGripDown(ev: PointerEvent): void {
    if (!props.onGrip || ev.button !== 0) return;
    ev.preventDefault();
    props.onGrip("start", 0);
    cancelDrag = beginDrag(ev, {
      capture: grip,
      onMove: (_move, _dx, dy) => props.onGrip?.("drag", dy),
      onEnd: (_end, _dx, dy) => {
        cancelDrag = null;
        props.onGrip?.("end", dy);
      },
    });
  }

  function paintChips(): void {
    for (const c of chips) c.destroy();
    chipRow.empty();
    chips = props.chips.map((c) => createChip(chipRow, c));
  }

  function paint(): void {
    el.setCssProps({ "--wadjet-studio-unit-color": props.color });
    slotEl.setText(props.slot);
    nameEl.setText(props.name);
    kindEl.setText(props.kind);
    kindEl.toggleClass("is-hidden", props.kind === "");
    kindEl.setAttr("data-kind", props.kind);
    linkEl.toggleClass("is-hidden", props.linked !== true);
    worldEl.setText(props.world === undefined ? "" : `world · ${props.world} zones`);
    worldEl.toggleClass("is-hidden", props.world === undefined);
    grip.toggleClass("is-hidden", props.grip === false);
    el.toggleClass("is-off", props.dim === true);
    led.update(props.led);
  }

  grip.addEventListener("pointerdown", onGripDown);
  nameEl.addEventListener("click", open);
  nameEl.addEventListener("keydown", onNameKey);
  paintChips();
  paint();

  return {
    el,
    update(next) {
      const rebuildChips = next.chips !== undefined;
      props = { ...props, ...next };
      if (rebuildChips) paintChips();
      paint();
    },
    destroy() {
      cancelDrag?.();
      grip.removeEventListener("pointerdown", onGripDown);
      nameEl.removeEventListener("click", open);
      nameEl.removeEventListener("keydown", onNameKey);
      for (const c of chips) c.destroy();
      led.destroy();
      el.remove();
    },
  };
}
