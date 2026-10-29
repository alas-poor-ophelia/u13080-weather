/**
 * The Studio's one question when a Save would write its calendar over a
 * stored calendar that changed since the Studio last loaded or saved it (in
 * Settings, on another device through Sync, in another Studio tab, through
 * the API; ruling 2026-10-30, definition.ts `planCalendarSave`). Overwrite
 * writes the Studio's calendar; Reload discards its calendar edits and shows
 * the stored calendar (the other pending edits are saved); Cancel saves
 * nothing. Escape and click-outside are a cancel.
 *
 * The title is load-bearing: `test/e2e/studio.e2e.ts` finds the modal by it.
 */
import { Modal, type App } from "obsidian";
import type { ConflictChoice } from "../model/definition";

export const CONFLICT_TITLE = "The calendar changed outside the studio";

class CalendarConflictModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    /** why Overwrite cannot write the Studio's calendar (the button is disabled), or null */
    private readonly blocked: string | null,
    private readonly done: (choice: ConflictChoice) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(CONFLICT_TITLE);
    this.contentEl.createEl("p", {
      text: "The calendar was changed outside the studio (in settings or on another device) since you opened it. Overwrite it with the studio's version, or reload the studio from the stored calendar?",
    });
    this.contentEl.createEl("p", { text: "Reload discards the studio's calendar edits only; its other edits are saved." });
    if (this.blocked !== null) this.contentEl.createEl("p", { cls: "mod-warning", text: `Overwrite is not available: ${this.blocked}` });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.settle("cancel"));
    buttons.createEl("button", { text: "Reload" }).addEventListener("click", () => this.settle("reload"));
    const overwrite = buttons.createEl("button", { cls: "mod-warning", text: "Overwrite" });
    if (this.blocked !== null) overwrite.disabled = true;
    else overwrite.addEventListener("click", () => this.settle("overwrite"));
  }

  private settle(choice: ConflictChoice): void {
    this.settled = true;
    this.close();
    this.done(choice);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.done("cancel");
  }
}

/**
 * Ask Overwrite, Reload or Cancel; Escape and click-outside resolve "cancel".
 * @param blocked why the Studio's calendar cannot be written (Overwrite is shown disabled), or null
 */
export function askCalendarConflict(app: App, blocked: string | null): Promise<ConflictChoice> {
  return new Promise((resolve) => new CalendarConflictModal(app, blocked, resolve).open());
}
