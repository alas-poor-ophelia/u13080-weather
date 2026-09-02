/**
 * Chip — a pill that stands for an entity (a season, an era, a moon, a
 * station). SPEC law 2: clicking a chip is how you reach the thing it names,
 * so a chip with `onClick` is a real button, keyboard included.
 */
export interface ChipProps {
  label: string;
  /** Palette colour for the dot and text; defaults to the dim text colour. */
  color?: string;
  onClick?: () => void;
  hint?: string;
  /** A single leading glyph (☾, ⚑, ⧉ …). */
  icon?: string;
}

export interface ChipComponent {
  el: HTMLElement;
  update(next: Partial<ChipProps>): void;
  destroy(): void;
}

export function createChip(parent: HTMLElement, initial: ChipProps): ChipComponent {
  let props = initial;
  const el = parent.createDiv({ cls: "wadjet-studio-chip" });
  // Decorative: the label carries the chip's meaning, the glyph just echoes it visually.
  const iconEl = el.createSpan({ cls: "wadjet-studio-chip-icon", attr: { "aria-hidden": "true" } });
  const labelEl = el.createSpan({ cls: "wadjet-studio-chip-label" });

  function activate(ev: Event): void {
    if (!props.onClick) return;
    ev.stopPropagation();
    props.onClick();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    activate(ev);
  }

  function paint(): void {
    iconEl.setText(props.icon ?? "");
    iconEl.toggleClass("is-hidden", !props.icon);
    labelEl.setText(props.label);
    el.setCssProps({ "--wadjet-studio-chip-color": props.color ?? "var(--wadjet-studio-text-dim)" });
    el.toggleClass("is-clickable", props.onClick !== undefined);
    if (props.onClick) {
      el.setAttrs({ role: "button", tabindex: "0" });
    } else {
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
    }
    if (props.hint) el.setAttr("data-hint", props.hint);
    else el.removeAttribute("data-hint");
  }

  el.addEventListener("click", activate);
  el.addEventListener("keydown", onKeyDown);
  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    destroy() {
      el.removeEventListener("click", activate);
      el.removeEventListener("keydown", onKeyDown);
      el.remove();
    },
  };
}
