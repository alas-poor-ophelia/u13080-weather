/**
 * LED — a 10 px lamp. Three scopes (device · chain · op) and three levels
 * (ok · warn · error); colour comes from the palette, never from the caller.
 * When `onToggle` is given the lamp is the unit's power switch (SPEC §3.3).
 */
export type LedLevel = "ok" | "warn" | "error";
export type LedScope = "device" | "chain" | "op";

export interface LedProps {
  on: boolean;
  level?: LedLevel;
  scope?: LedScope;
  onToggle?: (on: boolean) => void;
  hint?: string;
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
    return level === "ok" ? `${scope} power: on` : `${scope} power: on, ${level}`;
  }

  function paint(): void {
    // Obsidian's setAttr drops an attribute when handed `false`, so booleans go in as strings.
    el.setAttrs({
      "data-level": props.level ?? "ok",
      "data-scope": props.scope ?? "device",
      "aria-pressed": props.on ? "true" : "false",
      "aria-label": accessibleLabel(),
    });
    el.toggleClass("is-on", props.on);
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
