/**
 * `＋ save "<name>" as preset` — the one prompt every panel with a preset `▾`
 * uses to name what it is about to write (SPEC §3.4, PLAN D12).
 *
 * Shared rather than per-window: the device panel and the Regimes panel ask
 * the same question, and a second copy would be a second place for the button
 * label and the trim-and-refuse-blank rule to drift.
 */
import { Modal, Setting, type App } from "obsidian";

export class PresetNameModal extends Modal {
  constructor(
    app: App,
    private readonly initial: string,
    private readonly onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Save as preset");
    let name = this.initial;
    new Setting(contentEl).setName("Name").addText((t) =>
      t
        .setValue(name)
        .setPlaceholder(this.initial)
        .onChange((v) => (name = v)),
    );
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          const trimmed = name.trim();
          this.close();
          if (trimmed) this.onSubmit(trimmed);
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
