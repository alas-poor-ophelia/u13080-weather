/**
 * Window-level pointer plumbing shared by every studio component.
 *
 * SPEC §3.8: all drag handlers listen on `window` (not the target), drag
 * targets carry `touch-action: none`, and `_justDragged` suppresses the
 * click the browser fires straight after a drag. This is the only shared
 * machinery the component bin has — everything else is per-component.
 */

/** Class carrying `touch-action: none`; see the studio block in styles.css. */
export const DRAG_TARGET_CLASS = "wadjet-studio-drag-target";

/** Lane clip edge handle width: 4 px for a mouse, 10 px for a finger (PLAN §7). */
export const EDGE_PX_MOUSE = 4;
export const EDGE_PX_TOUCH = 10;

/** Movement (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 3;

/** How long a finished drag keeps swallowing clicks, if nothing consumes it first. */
const JUST_DRAGGED_MS = 250;

let justDragged = false;

/** True when the pointer is a finger or pen — hit targets grow (SPEC §3.8, PLAN §7). */
export function isTouchPointer(ev: PointerEvent): boolean {
  return ev.pointerType === "touch" || ev.pointerType === "pen";
}

/** The edge-handle half-width appropriate to the pointer that started the gesture. */
export function edgePxFor(ev: PointerEvent): number {
  return isTouchPointer(ev) ? EDGE_PX_TOUCH : EDGE_PX_MOUSE;
}

/** Mark an element as a drag target: `touch-action: none` so the browser never pans instead. */
export function markDragTarget(el: HTMLElement | SVGElement): void {
  el.addClass(DRAG_TARGET_CLASS);
}

/** Class the studio root wears once a finger or pen pointer has been seen (SPEC §8): CSS grows hit areas under it. */
export const TOUCH_CLASS = "is-touch";
const STUDIO_ROOT_SELECTOR = ".wadjet-studio";

/**
 * Mark the nearest studio root touch-driven, the first time a finger or pen
 * pointer appears on one of its drag targets. Idempotent — `classList.add` on
 * an already-set class is a no-op — and mouse pointers never flip it back off,
 * since a tablet is touch *and* mouse in the same session (SPEC §8).
 */
export function noteTouchPointer(ev: PointerEvent, from: Element): void {
  if (!isTouchPointer(ev)) return;
  from.closest(STUDIO_ROOT_SELECTOR)?.addClass(TOUCH_CLASS);
}

/**
 * Raise the "a drag just ended" flag. Cleared by the first `consumeJustDragged()`,
 * by the next pointerdown anywhere, or after a quarter second — whichever is first.
 */
export function markJustDragged(): void {
  justDragged = true;
  window.addEventListener("pointerdown", clearJustDragged, { capture: true, once: true });
  window.setTimeout(clearJustDragged, JUST_DRAGGED_MS);
}

function clearJustDragged(): void {
  justDragged = false;
}

/** True once if a drag just ended: click handlers call this and bail out when it is set. */
export function consumeJustDragged(): boolean {
  const was = justDragged;
  justDragged = false;
  return was;
}

export interface DragOptions {
  /** Called for every move while the button is down. `moved` is true past the 3 px threshold. */
  onMove(ev: PointerEvent, dx: number, dy: number, moved: boolean): void;
  /** Called once on pointerup / pointercancel. */
  onEnd?(ev: PointerEvent, dx: number, dy: number, moved: boolean): void;
  /** Capture the pointer on this element so the gesture survives leaving it. */
  capture?: HTMLElement | SVGElement;
}

/**
 * Start a drag from `start` (a pointerdown). Listeners live on `window` so the
 * gesture keeps working outside the element, and are torn down on pointerup.
 * Returns a canceller for components that are destroyed mid-drag.
 */
export function beginDrag(start: PointerEvent, opts: DragOptions): () => void {
  const { pointerId, clientX: x0, clientY: y0 } = start;
  let moved = false;
  const capture = opts.capture;
  if (capture) {
    try {
      capture.setPointerCapture(pointerId);
    } catch {
      /* capture is a nicety; window listeners already carry the gesture */
    }
  }

  const stop = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (capture) {
      try {
        capture.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
  };

  function move(ev: PointerEvent): void {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) moved = true;
    opts.onMove(ev, dx, dy, moved);
  }

  function up(ev: PointerEvent): void {
    if (ev.pointerId !== pointerId) return;
    stop();
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (moved) markJustDragged();
    opts.onEnd?.(ev, dx, dy, moved);
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  return stop;
}
