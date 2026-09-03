/**
 * The device window's two chrome primitives: the button that is not in the
 * component bin, and the handle the window keeps on everything it must
 * destroy on a rebuild.
 */

/** A chrome button that is not in the component bin — the same status as the window's × (SPEC law 3). */
export function iconButton(parent: HTMLElement, o: { text: string; label: string; hint: string; cls: string; onClick: (ev: MouseEvent) => void }): HTMLElement {
  const el = parent.createDiv({ cls: o.cls, text: o.text, attr: { role: "button", tabindex: "0", "aria-label": o.label, "data-hint": o.hint } });
  el.addEventListener("click", (ev) => o.onClick(ev));
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    o.onClick(new MouseEvent("click", { clientX: el.getBoundingClientRect().left, clientY: el.getBoundingClientRect().bottom }));
  });
  return el;
}

export interface Part {
  destroy(): void;
}
