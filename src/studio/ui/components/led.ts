/**
 * LED — a lamp, sized by what it belongs to: 10 px on a rack unit
 * (`device`), 8 px on the mixer's fixed strip (`chain`), 7 px beside an op
 * (`op`), 9 px in a window title bar. Three levels (ok · warn · error);
 * colour comes from the palette, never from the caller. When `onToggle` is
 * given the lamp is the unit's power switch (SPEC §3.3).
 *
 * `muted` is the third state between on and off: the unit is enabled but
 * something upstream is holding it back (a chain mute, a disabled op), so the
 * lamp keeps its colour and loses its glow.
 */
export type LedLevel = "ok" | "warn" | "error";
export type LedScope = "device" | "chain" | "op";

export interface LedProps {
  on: boolean;
  level?: LedLevel;
  scope?: LedScope;
  onToggle?: (on: boolean) => void;
  hint?: string;
  /** Lit but held back upstream — colour without glow. */
  muted?: boolean;
  /**
   * Override the lamp's hue with a palette colour — the ONE case where a
   * caller picks it: a channel window's title lamp carries the channel's own
   * identity (temp orange, precip blue, wind green, sky pale), not the generic
   * ok-green. A `warn`/`error` level still wins, because a validation state
   * must never be hidden behind an identity colour.
   */
  color?: string;
}

export interface LedComponent {
  el: HTMLElement;
  update(next: Partial<LedProps>): void;
  destroy(): void;
}

export function createLed(parent: HTMLElement, initial: LedProps): LedComponent {
  let props = initial;
  const el = parent.createDiv({ cls: "wadjet-studio-led" });

  function toggle(): void {
    props.onToggle?.(!props.on);
  }

  function onClick(ev: MouseEvent): void {
    ev.stopPropagation();
    toggle();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    ev.stopPropagation();
    toggle();
  }

  /**
   * The colour alone carries ok/warn/error (SPEC §9); a screen reader needs
   * the same distinction in words, not just on/off (bead wadjet-9f9.43).
   */
  function accessibleLabel(): string {
    const scope = props.scope ?? "device";
    if (!props.on) return `${scope} power: off`;
    const level = props.level ?? "ok";
    const muted = props.muted === true ? ", muted" : "";
    return level === "ok" ? `${scope} power: on${muted}` : `${scope} power: on, ${level}${muted}`;
  }

  function paint(): void {
    const level = props.level ?? "ok";
    // An identity colour only applies to the healthy state; warn/error keep
    // the palette hue their level owns.
    el.setCssProps({ "--wadjet-studio-led-color": props.color !== undefined && level === "ok" ? props.color : "var(--wadjet-studio-wind)" });
    // Obsidian's setAttr drops an attribute when handed `false`, so booleans go in as strings.
    el.setAttrs({
      "data-level": props.level ?? "ok",
      "data-scope": props.scope ?? "device",
      "aria-pressed": props.on ? "true" : "false",
      "aria-label": accessibleLabel(),
    });
    el.toggleClass("is-on", props.on);
    el.toggleClass("is-muted", props.muted === true);
    if (props.onToggle) {
      el.setAttrs({ role: "button", tabindex: "0" });
    } else {
      el.setAttr("role", "img");
      el.removeAttribute("tabindex");
    }
    if (props.hint) el.setAttr("data-hint", props.hint);
    else el.removeAttribute("data-hint");
  }

  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onKeyDown);
  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    destroy() {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKeyDown);
      el.remove();
    },
  };
}
