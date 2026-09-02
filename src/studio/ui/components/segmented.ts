/**
 * Segmented — a row of mutually exclusive options (the WHEN kinds, chart
 * scopes, terrain). A real radiogroup: arrow keys move the selection, and
 * only the selected option is in the tab order.
 */
export interface SegmentedOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SegmentedProps {
  options: SegmentedOption[];
  value: string;
  onChange(value: string): void;
}

export interface SegmentedComponent {
  el: HTMLElement;
  update(next: Partial<SegmentedProps>): void;
  destroy(): void;
}

export function createSegmented(parent: HTMLElement, initial: SegmentedProps): SegmentedComponent {
  let props = initial;
  const el = parent.createDiv({ cls: "wadjet-studio-segmented", attr: { role: "radiogroup" } });
  let buttons: HTMLElement[] = [];

  function select(value: string): void {
    if (value === props.value) return;
    props = { ...props, value };
    paint();
    props.onChange(value);
  }

  function move(step: number): void {
    const i = props.options.findIndex((o) => o.value === props.value);
    const next = props.options[(((i < 0 ? 0 : i) + step) % props.options.length + props.options.length) % props.options.length];
    if (!next) return;
    select(next.value);
    buttons[props.options.indexOf(next)]?.focus();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "ArrowRight" || ev.key === "ArrowDown") move(1);
    else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") move(-1);
    else return;
    ev.preventDefault();
  }

  function build(): void {
    el.empty();
    buttons = props.options.map((o) => {
      const b = el.createDiv({ cls: "wadjet-studio-segment", text: o.label, attr: { role: "radio", "data-value": o.value } });
      if (o.hint) b.setAttr("data-hint", o.hint);
      b.addEventListener("click", () => select(o.value));
      return b;
    });
  }

  function paint(): void {
    props.options.forEach((o, i) => {
      const b = buttons[i];
      if (!b) return;
      const on = o.value === props.value;
      b.toggleClass("is-selected", on);
      b.setAttrs({ "aria-checked": on ? "true" : "false", tabindex: on ? "0" : "-1" });
    });
  }

  el.addEventListener("keydown", onKeyDown);
  build();
  paint();

  return {
    el,
    update(next) {
      const rebuild = next.options !== undefined;
      props = { ...props, ...next };
      if (rebuild) build();
      paint();
    },
    destroy() {
      el.removeEventListener("keydown", onKeyDown);
      el.remove();
    },
  };
}
