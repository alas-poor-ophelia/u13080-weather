/**
 * Window — the shared chrome every floating panel wears (SPEC §3.4):
 * draggable title bar (LED · name · KIND badge · preset ▾ · ×), a body the
 * caller owns, the `WRITES` footer (law 5), and an optional issue line.
 * Dragging clamps the panel inside its parent box; z-index comes from the
 * caller, which raises it on focus.
 */
import { clampRect } from "../../model/clamp";
import { createLed, type LedComponent, type LedProps } from "./led";
import { createWrites, type WritesComponent } from "./writes";
import { beginDrag, markDragTarget, noteTouchPointer } from "../pointer";

export type IssueLevel = "error" | "warn";

export interface WindowIssue {
  level: IssueLevel;
  msg: string;
}

export interface WindowPreset {
  name: string;
  options: string[];
  onPick(name: string): void;
  onSave(): void;
}

export interface WindowProps {
  title: string;
  led?: LedProps;
  /** Short kind badge — DEVICE, ERA, STATES … */
  badge?: string;
  preset?: WindowPreset;
  z: number;
  x: number;
  y: number;
  onClose(): void;
  onFocus(): void;
  /** Reported once on drop, with the clamped position (SPEC §3.4). */
  onMove?(x: number, y: number): void;
  draggable: boolean;
  body: HTMLElement;
  writes?: string;
  issues?: WindowIssue[];
}

export interface WindowComponent {
  el: HTMLElement;
  update(next: Partial<WindowProps>): void;
  /**
   * Re-clamp against the parent's *current* size (SPEC §3.4) — the caller's
   * hook for a studio box that just shrank. Repositions and repaints if the
   * panel is now out of bounds; returns the new `{x, y}` so the caller can
   * persist it, or `null` when nothing moved.
   */
  reclamp(): { x: number; y: number } | null;
  destroy(): void;
}

export function createWindow(parent: HTMLElement, initial: WindowProps): WindowComponent {
  let props = initial;
  let cancelDrag: (() => void) | null = null;
  let led: LedComponent | null = null;
  let writes: WritesComponent | null = null;

  const el = parent.createDiv({ cls: "wadjet-studio-window", attr: { tabindex: "-1", role: "dialog" } });
  const bar = el.createDiv({ cls: "wadjet-studio-window-bar" });
  const ledSlot = bar.createDiv({ cls: "wadjet-studio-window-led" });
  const titleEl = bar.createSpan({ cls: "wadjet-studio-window-title" });
  const badgeEl = bar.createSpan({ cls: "wadjet-studio-window-badge" });
  const presetSlot = bar.createDiv({ cls: "wadjet-studio-window-preset" });
  const closeEl = bar.createDiv({ cls: "wadjet-studio-window-close", text: "×", attr: { role: "button", tabindex: "0", "aria-label": "Close" } });
  const bodyEl = el.createDiv({ cls: "wadjet-studio-window-body" });
  const footEl = el.createDiv({ cls: "wadjet-studio-window-foot" });
  const issuesEl = el.createDiv({ cls: "wadjet-studio-window-issues" });
  bodyEl.appendChild(props.body);
  markDragTarget(bar);

  function place(x: number, y: number): void {
    el.setCssProps({
      "--wadjet-studio-win-x": `${x}px`,
      "--wadjet-studio-win-y": `${y}px`,
      "--wadjet-studio-win-z": String(props.z),
    });
  }

  /**
   * Keep the panel inside the studio box (SPEC §3.4). Only the title bar's
   * height has to stay onscreen vertically, so a panel taller than the box
   * can still be dragged back up by it; the full width matters horizontally.
   */
  function clamp(x: number, y: number): { x: number; y: number } {
    const box = el.parentElement;
    if (!box) return { x, y };
    return clampRect(x, y, el.offsetWidth, el.offsetHeight, box.clientWidth, box.clientHeight, bar.offsetHeight);
  }

  function onBarDown(ev: PointerEvent): void {
    if (!props.draggable || ev.button !== 0) return;
    if (closeEl.contains(ev.target as Node) || presetSlot.contains(ev.target as Node) || ledSlot.contains(ev.target as Node)) return;
    noteTouchPointer(ev, bar);
    ev.preventDefault();
    props.onFocus();
    const x0 = props.x;
    const y0 = props.y;
    cancelDrag = beginDrag(ev, {
      capture: bar,
      onMove: (_move, dx, dy) => {
        const p = clamp(x0 + dx, y0 + dy);
        place(p.x, p.y);
      },
      onEnd: (_end, dx, dy, moved) => {
        cancelDrag = null;
        const p = clamp(x0 + dx, y0 + dy);
        props = { ...props, x: p.x, y: p.y };
        place(p.x, p.y);
        if (moved) props.onMove?.(p.x, p.y);
      },
    });
  }

  function onFocusDown(): void {
    props.onFocus();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    props.onClose();
  }

  function onCloseClick(ev: Event): void {
    ev.stopPropagation();
    props.onClose();
  }

  function onCloseKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    props.onClose();
  }

  function paintPreset(): void {
    presetSlot.empty();
    const p = props.preset;
    if (!p) return;
    const select = presetSlot.createEl("select", { cls: "wadjet-studio-window-preset-pick" });
    for (const name of p.options) select.createEl("option", { value: name, text: name });
    select.value = p.name;
    select.addEventListener("change", () => p.onPick(select.value));
    const save = presetSlot.createDiv({ cls: "wadjet-studio-window-preset-save", text: "＋", attr: { role: "button", tabindex: "0", "aria-label": "Save as preset" } });
    save.addEventListener("click", () => p.onSave());
  }

  function paintIssues(): void {
    issuesEl.empty();
    const issues = props.issues ?? [];
    issuesEl.toggleClass("is-hidden", issues.length === 0);
    for (const i of issues) issuesEl.createDiv({ cls: "wadjet-studio-window-issue", text: i.msg, attr: { "data-level": i.level } });
  }

  function paint(): void {
    titleEl.setText(props.title);
    badgeEl.setText(props.badge ?? "");
    badgeEl.toggleClass("is-hidden", props.badge === undefined);
    place(props.x, props.y);

    if (props.led && !led) led = createLed(ledSlot, props.led);
    else if (props.led && led) led.update(props.led);
    else if (!props.led && led) {
      led.destroy();
      led = null;
    }

    if (props.writes !== undefined && !writes) writes = createWrites(footEl, { grammar: props.writes });
    else if (props.writes !== undefined && writes) writes.update({ grammar: props.writes });
    else if (props.writes === undefined && writes) {
      writes.destroy();
      writes = null;
    }

    paintIssues();
  }

  bar.addEventListener("pointerdown", onBarDown);
  el.addEventListener("pointerdown", onFocusDown);
  el.addEventListener("keydown", onKeyDown);
  closeEl.addEventListener("click", onCloseClick);
  closeEl.addEventListener("keydown", onCloseKey);
  paintPreset();
  paint();

  return {
    el,
    update(next) {
      const rebuildPreset = next.preset !== undefined;
      const newBody = next.body !== undefined && next.body !== props.body;
      props = { ...props, ...next };
      if (newBody) {
        bodyEl.empty();
        bodyEl.appendChild(props.body);
      }
      if (rebuildPreset) paintPreset();
      paint();
    },
    reclamp() {
      // Mid-drag, the drag's own onMove/onEnd own the position; a resize tick
      // that lands mid-gesture must not fight it.
      if (cancelDrag) return null;
      const p = clamp(props.x, props.y);
      if (p.x === props.x && p.y === props.y) return null;
      props = { ...props, x: p.x, y: p.y };
      place(p.x, p.y);
      return p;
    },
    destroy() {
      cancelDrag?.();
      bar.removeEventListener("pointerdown", onBarDown);
      el.removeEventListener("pointerdown", onFocusDown);
      el.removeEventListener("keydown", onKeyDown);
      closeEl.removeEventListener("click", onCloseClick);
      closeEl.removeEventListener("keydown", onCloseKey);
      led?.destroy();
      writes?.destroy();
      el.remove();
    },
  };
}
