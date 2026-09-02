/**
 * Writes — the mono footer every window carries (SPEC law 5). It shows the
 * exact grammar the window produces. Derived text, never editable; clicking
 * copies it so it can be pasted into a zone file or a bug report.
 */
export interface WritesProps {
  grammar: string;
}

export interface WritesComponent {
  el: HTMLElement;
  update(next: Partial<WritesProps>): void;
  destroy(): void;
}

export function createWrites(parent: HTMLElement, initial: WritesProps): WritesComponent {
  let props = initial;
  const el = parent.createDiv({ cls: "wadjet-studio-writes" });
  el.createSpan({ cls: "wadjet-studio-writes-label", text: "Writes →" });
  // `wadjet-studio-num`: the grammar is mostly numbers (`Y 1962 · seed 8e2c…
  // · salt 0`, day ordinals, op values) and it repaints per frame, so the
  // digits must not jitter — the shared tabular-numerals utility, since the
  // footer has no value class of its own.
  const body = el.createSpan({ cls: "wadjet-studio-writes-body wadjet-studio-num" });

  function onClick(): void {
    void navigator.clipboard?.writeText(props.grammar);
  }

  function paint(): void {
    body.setText(props.grammar);
    el.setAttr("title", props.grammar);
  }

  el.addEventListener("click", onClick);
  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    destroy() {
      el.removeEventListener("click", onClick);
      el.remove();
    },
  };
}
