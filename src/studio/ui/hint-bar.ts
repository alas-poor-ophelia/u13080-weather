/**
 * The hint bar (SPEC §3.1): `● name  detail`, 22 px, under the header.
 *
 * One delegated `mouseover` / `focusin` listener on the studio root finds the
 * nearest `[data-hint]` ancestor of whatever the pointer or the keyboard just
 * reached. That is the whole mechanism: a surface makes a control hintable by
 * setting one attribute, and never talks to this file.
 *
 * `mouseover` (not `mouseenter`) is the right event because it bubbles and
 * fires for *every* element under the pointer — so moving from a hinted control
 * onto bare chrome reports the bare chrome, and the bar falls back to the
 * studio's default. Leaving the studio entirely is the `mouseleave` case.
 */
import { DEFAULT_HINT, parseHint } from "../model/hints";
import { setHint } from "./layout";
import type { Surface, SurfaceContext } from "./surfaces";

export function createHintBarSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  function show(target: EventTarget | null): void {
    const c = ctx;
    if (c === null) return;
    const el = target instanceof Element ? target.closest("[data-hint]") : null;
    const attr = el?.getAttribute("data-hint");
    const [name, detail] = attr === null || attr === undefined || attr === "" ? DEFAULT_HINT : parseHint(attr);
    setHint(c.shell, name, detail);
  }

  const onOver = (ev: Event): void => show(ev.target);
  const onLeave = (): void => show(null);

  return {
    mount(next) {
      ctx = next;
      next.shell.root.addEventListener("mouseover", onOver);
      next.shell.root.addEventListener("focusin", onOver);
      next.shell.root.addEventListener("mouseleave", onLeave);
      show(null);
    },

    render() {
      // The bar is driven by pointer and focus, not by state: a re-render must
      // never overwrite the hint the user is reading mid-hover.
    },

    destroy() {
      ctx?.shell.root.removeEventListener("mouseover", onOver);
      ctx?.shell.root.removeEventListener("focusin", onOver);
      ctx?.shell.root.removeEventListener("mouseleave", onLeave);
      ctx = null;
    },
  };
}
