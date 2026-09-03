/**
 * Chip — a small tag that stands for an entity or a value (a season, an era,
 * a moon, one device op). SPEC law 2: clicking a chip is how you reach the
 * thing it names, so a chip with `onClick` is a real button, keyboard
 * included.
 *
 * The chip itself is always neutral — dark fill, hairline border, dim text.
 * Colour arrives as a 5 px leading **dot**, never as a tinted background or
 * tinted label: SPEC §9 keeps colour on data, not on chrome. A chip carrying
 * a glyph (`☾`, `⚑`, `⧉`) shows that instead of the dot.
 *
 * A chip does NOT truncate by default — its label is usually a short readout
 * that must stay legible (`storm odds ×1.50`). A caller that really is short
 * of room opts in with `truncate`.
 */
export interface ChipProps {
  label: string;
  /** Palette colour for the dot and text; defaults to the dim text colour. */
  color?: string;
  onClick?: () => void;
  hint?: string;
  /** A single leading glyph (☾, ⚑, ⧉ …). Takes the dot's place when given. */
  icon?: string;
  /** Force the leading dot on or off; defaults to on whenever `color` is set and no `icon` is. */
  dot?: boolean;
  /** Ellipsise an over-long label instead of letting the chip grow. Off by default. */
  truncate?: boolean;
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
    const dot = props.dot ?? (props.icon === undefined && props.color !== undefined);
    iconEl.setText(props.icon ?? "");
    iconEl.toggleClass("is-dot", dot);
    iconEl.toggleClass("is-hidden", !props.icon && !dot);
    labelEl.setText(props.label);
    el.toggleClass("is-truncate", props.truncate === true);
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
