/**
 * The Studio's one question before a save rewrites a hand-edited calendar
 * definition (docs/SESHAT-v0.md §13.11 M4, ruled 2026-10-19): the stored text
 * is not canonical (comments, its own layout), and saving the Studio's
 * calendar edits stores it in canonical form. Continue or Cancel; Escape and
 * click-outside are a cancel.
 */
import { Modal, type App } from "obsidian";

class RewriteConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly done: (ok: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText("Rewrite the calendar definition?");
    this.contentEl.createEl("p", { text: "This rewrites your definition in canonical form; comments and your own layout are removed. The calendar itself is what the studio shows." });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.settle(false));
    buttons.createEl("button", { cls: "mod-cta", text: "Rewrite and save" }).addEventListener("click", () => this.settle(true));
  }

  private settle(ok: boolean): void {
    this.settled = true;
    this.close();
    this.done(ok);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.done(false);
  }
}

/** Resolves true when the Guildmaster agrees to the rewrite, false on Cancel, Escape or click-outside. */
export function confirmRewrite(app: App): Promise<boolean> {
  return new Promise((resolve) => new RewriteConfirmModal(app, resolve).open());
}
