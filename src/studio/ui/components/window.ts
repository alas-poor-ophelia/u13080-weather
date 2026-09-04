/**
 * Window — the shared chrome every floating panel wears (SPEC §3.4):
 * draggable title bar (LED · name · KIND badge · preset ▾ · ×), a body the
 * caller owns, the `WRITES` footer (law 5), and an optional issue line.
 * Dragging clamps the panel inside its parent box; z-index comes from the
 * caller, which raises it on focus.
 */
import { Menu } from "obsidian";
import { clampRect } from "../../model/clamp";
import { kindColor } from "../../model/copy";
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
  /**
   * The names the `▾` offers. A function is re-read on every repaint, which is
   * what a panel that can SAVE a preset needs: the one it just wrote has to be
   * offered back without rebuilding the whole window.
   */
  options: string[] | (() => string[]);
  onPick(name: string): void;
  onSave(): void;
}

export interface WindowProps {
  title: string;
  led?: LedProps;
  /** Short kind badge — DEVICE, ERA, STATES … */
  badge?: string;
  /**
   * The kind pill's colour. Defaults to `kindColor(badge)`, which gives the
   * prototype's DEV_KINDS hues (CURSE red, SPELL orange, MOON moon, TAG gold,
   * TRIM sky, DICE wind) and neutral text for everything else.
   */
  badgeColor?: string;
  /**
   * The dim caption between the kind pill and the preset control — the
   * unit's place in the signal path (`slot 00 · every chain`). The `…` slot
   * in SPEC §3.4's `LED · name · KIND badge · … · preset ▾ · ×`.
   */
  caption?: string;
  /**
   * The bar's free slot, between the caption and the spacer — SPEC §3.4's `…`
   * in `LED · name · KIND badge · … · preset ▾ · ×`. The prototype hangs a
   * Köppen readout there (`1230-vst-macro.html`), a calendar-source pill
   * (`0811-vst-sablemoon.html`, `0853-vst-seasons.html`) or, on an era, the
   * whole title row (`0973-vst-era.html`). Called ONCE, with the slot: the
   * caller owns what it puts in and repaints it itself, which is what a live
   * lamp or an editable name needs and a plain `caption` string cannot give.
   * A child marked `is-tail` takes the spacer's growth and hangs at the right
   * end of the bar, the way the prototype's source pill does.
   */
  head?: (slot: HTMLElement) => void;
  /**
   * The panel's width in px, from the prototype (372 device, 380 seasons,
   * 420 regimes, 452 cycle, 720 atlas, 1078 channel). A window MUST set this:
   * without it the widest child — always the WRITES footer — dictates the
   * size, which is how a raw JSON dump blew the panels out to 1500 px.
   * Capped by the studio box in CSS, so a narrow leaf still fits.
   */
  width?: number;
  preset?: WindowPreset;
  /**
   * Makes the title inline-editable: clicking it swaps the label for a text
   * field, Enter or blur commits, Escape reverts. A device's name IS its id
   * (SPEC §7), so it is the title bar's business and not a boxed input in the
   * body — the prototype shows plain bold text until you click it.
   */
  onRename?: (name: string) => void;
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
  /** True while the inline rename field owns the title slot. */
  let editing = false;

  const el = parent.createDiv({ cls: "wadjet-studio-window", attr: { tabindex: "-1", role: "dialog" } });
  const bar = el.createDiv({ cls: "wadjet-studio-window-bar" });
  const ledSlot = bar.createDiv({ cls: "wadjet-studio-window-led" });
  const titleEl = bar.createSpan({ cls: "wadjet-studio-window-title" });
  const badgeEl = bar.createSpan({ cls: "wadjet-studio-window-badge" });
  const captionEl = bar.createSpan({ cls: "wadjet-studio-window-caption" });
  const headEl = bar.createDiv({ cls: "wadjet-studio-window-head" });
  // The title no longer grows (styles.css): an explicit spacer is what keeps
  // the kind pill beside the name and the preset ▾ / × pair at the right end.
  bar.createDiv({ cls: "wadjet-studio-window-spacer" });
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
      "--wadjet-studio-win-w": props.width === undefined ? "auto" : `${props.width}px`,
    });
  }

  /**
   * Keep the panel inside the studio box (SPEC §3.4). Only the title bar's
   * height has to stay onscreen vertically, so a panel taller than the box
   * can still be dragged back up by it; the full width matters horizontally.
   *
   * The margin is measured from the PANEL's own top edge down to the bar's
   * bottom, not from the bar's height alone: the panel draws a 1 px border
   * above the bar, and `top` places the border box, so `bar.offsetHeight` on
   * its own left the bar hanging past the bottom of the box on a full-bottom
   * drag. Rects rather than `offsetHeight` so a fractional bar height counts.
   */
  function clamp(x: number, y: number): { x: number; y: number } {
    const box = el.parentElement;
    if (!box) return { x, y };
    const margin = Math.ceil(bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
    // The stylesheet caps the panel's height from its CURRENT top (wadjet-6rw.14),
    // so a panel already sitting at the bottom edge measures shorter than its
    // own title bar; clamping against that collapsed height would let the next
    // pointermove push the bar past the box. The bar's height is the floor.
    return clampRect(x, y, el.offsetWidth, Math.max(el.offsetHeight, margin), box.clientWidth, box.clientHeight, margin);
  }

  function onBarDown(ev: PointerEvent): void {
    if (!props.draggable || ev.button !== 0) return;
    if (closeEl.contains(ev.target as Node) || presetSlot.contains(ev.target as Node) || ledSlot.contains(ev.target as Node)) return;
    // The head slot's own CONTROLS are controls, not grab handles: the drag's
    // preventDefault would swallow the click on an era's lamp and the focus on
    // its name field. Inert content there — a pill, a Köppen readout — stays a
    // grab handle, so the bar can still be dragged across it (and keeps its
    // `data-hint` reach, which a `pointer-events: none` overlay does not).
    if (headEl.contains(ev.target as Node) && (ev.target as HTMLElement).closest("input, [role='button'], [role='slider']") !== null) return;
    // A renameable title is a control, not a grab handle: the drag's
    // preventDefault would swallow the click that opens the field.
    if (props.onRename !== undefined && titleEl.contains(ev.target as Node)) return;
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

  /** The preset control's option names, whether they were given as a list or as a reader. */
  function presetOptions(p: WindowPreset): string[] {
    return typeof p.options === "function" ? p.options() : p.options;
  }

  /**
   * The name the chip wears once the user has picked one, until the control is
   * rebuilt. A `<select>` used to hold that reading for free; the chip has to
   * keep it, because a panel whose `preset.name` is a constant placeholder
   * (`no preset`, the device path) would otherwise forget what was loaded.
   */
  let pickedLabel: string | null = null;
  let presetLabelEl: HTMLElement | null = null;

  function paintPresetLabel(): void {
    if (props.preset && presetLabelEl) presetLabelEl.setText(pickedLabel ?? props.preset.name);
  }

  /**
   * The prototype's `▾` is a MENU, not a form field (`1095-vst-device.html`
   * l.8, l.12): the options it carried plus the save the `＋` used to own.
   */
  function openPresetMenu(chip: HTMLElement, p: WindowPreset): void {
    const menu = new Menu();
    const current = pickedLabel ?? p.name;
    for (const name of presetOptions(p)) {
      menu.addItem((item) =>
        item
          .setTitle(name)
          .setChecked(name === current)
          .onClick(() => {
            pickedLabel = name;
            paintPresetLabel();
            p.onPick(name);
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Save as preset…").onClick(() => p.onSave()));
    const box = chip.getBoundingClientRect();
    menu.showAtPosition({ x: box.left, y: box.bottom });
  }

  function paintPreset(): void {
    presetSlot.empty();
    presetLabelEl = null;
    pickedLabel = null;
    const p = props.preset;
    if (!p) return;
    const chip = presetSlot.createSpan({
      cls: "wadjet-studio-window-preset-pick",
      attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "aria-label": "Preset" },
    });
    presetLabelEl = chip.createSpan({ cls: "wadjet-studio-window-preset-label" });
    chip.createSpan({ cls: "wadjet-studio-window-preset-caret", text: "▾" });
    chip.addEventListener("click", () => openPresetMenu(chip, p));
    chip.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      openPresetMenu(chip, p);
    });
    paintPresetLabel();
  }

  /**
   * Click-to-rename. The field replaces the label in place, so the bar never
   * changes height; `editing` holds `paint()` off the title while it is open,
   * because a `writes` tick would otherwise overwrite the caret.
   */
  function openRename(): void {
    if (!props.onRename || editing) return;
    editing = true;
    const was = props.title;
    titleEl.setText("");
    const input = titleEl.createEl("input", { cls: "wadjet-studio-window-title-input", type: "text", value: was, attr: { "aria-label": "Rename" } });
    input.focus();
    input.select();
    const close = (apply: boolean): void => {
      if (!editing) return;
      editing = false;
      const next = input.value.trim();
      input.remove();
      titleEl.setText(props.title);
      if (apply && next && next !== was) props.onRename?.(next);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        close(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close(false);
      }
      // Escape reaches the panel otherwise, and closes the window mid-edit.
      ev.stopPropagation();
    });
    input.addEventListener("blur", () => close(true));
    input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  function onTitleClick(ev: Event): void {
    if (!props.onRename) return;
    ev.stopPropagation();
    openRename();
  }

  function onTitleKey(ev: KeyboardEvent): void {
    if (!props.onRename || (ev.key !== "Enter" && ev.key !== " ")) return;
    ev.preventDefault();
    ev.stopPropagation();
    openRename();
  }

  function paintIssues(): void {
    issuesEl.empty();
    const issues = props.issues ?? [];
    issuesEl.toggleClass("is-hidden", issues.length === 0);
    for (const i of issues) issuesEl.createDiv({ cls: "wadjet-studio-window-issue", text: i.msg, attr: { "data-level": i.level } });
  }

  function paint(): void {
    if (!editing) titleEl.setText(props.title);
    titleEl.toggleClass("is-editable", props.onRename !== undefined);
    if (props.onRename) titleEl.setAttrs({ role: "button", tabindex: "0", "aria-label": `Rename ${props.title}` });
    badgeEl.setText(props.badge ?? "");
    badgeEl.toggleClass("is-hidden", props.badge === undefined);
    badgeEl.setCssProps({ "--wadjet-studio-badge-color": props.badgeColor ?? kindColor(props.badge ?? "") });
    captionEl.setText(props.caption ?? "");
    captionEl.toggleClass("is-hidden", props.caption === undefined);
    paintPresetLabel();
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
  titleEl.addEventListener("click", onTitleClick);
  titleEl.addEventListener("keydown", onTitleKey);
  paintPreset();
  // Once, at construction: the slot's content is the caller's to repaint.
  props.head?.(headEl);
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
      titleEl.removeEventListener("click", onTitleClick);
      titleEl.removeEventListener("keydown", onTitleKey);
      led?.destroy();
      writes?.destroy();
      el.remove();
    },
  };
}
