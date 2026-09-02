/**
 * The studio's one world-edit confirm (SPEC §2, §3.4; PLAN §7 "one
 * Notice-with-buttons (Modal) — one per session").
 *
 * World-scoped state — the era timeline, the calendar's seasons, its moons —
 * belongs to every zone at once, so the first edit of a session says so before
 * it lands. `model/world-confirm.ts` holds the session flag; this file holds
 * the one Modal that asks, so the eras lane, the era window, the mixer's era
 * LED, the seasons window and the moon CYCLE window all say the same sentence
 * in the same shape instead of keeping five copies of it.
 *
 * The wording is load-bearing: `test/e2e/studio.e2e.ts` finds the modal by the
 * title sentence ("Eras are world-level", "Seasons are world-level", "Moons
 * are world-level") and presses `button:has-text('Continue')`.
 */
import { Modal, Setting, type App } from "obsidian";
import { markWorldConfirmed, needsWorldConfirm } from "../model/world-confirm";
import type { SurfaceContext } from "./surfaces";

/** What the edit is about to change. The title and the sentence are built from it. */
export type WorldSubject = "eras" | "seasons" | "moons";

/** Sentence-leading noun per subject — "Eras are world-level: …". */
const SUBJECT_LABEL: Record<WorldSubject, string> = { eras: "Eras", seasons: "Seasons", moons: "Moons" };

/**
 * Who the edit reaches: a surface context (the zone names are read off its
 * store, which is what every caller did by hand) or an explicit list, for a
 * caller that has the names already.
 */
export type WorldConfirmTarget = SurfaceContext | readonly string[];

function isNameList(target: WorldConfirmTarget): target is readonly string[] {
  return Array.isArray(target);
}

function zoneNamesOf(target: WorldConfirmTarget): string[] {
  if (isNameList(target)) return [...target];
  return Object.values(target.store.get().zones).map((z) => z.name);
}

/** The modal itself. Private: `confirmWorldEdit` is the only way in. */
class WorldConfirmModal extends Modal {
  private dontAskAgain = true;
  /** Continue and Cancel both settle; anything else (Escape, click-outside) is a cancel. */
  private settled = false;

  constructor(
    app: App,
    private readonly zoneNames: readonly string[],
    private readonly subject: WorldSubject,
    private readonly onContinue: () => void,
    private readonly onCancel: (() => void) | undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    const label = SUBJECT_LABEL[this.subject];
    this.titleEl.setText(`${label} are world-level`);
    const names = this.zoneNames.length > 0 ? this.zoneNames.join(", ") : "every zone in the world";
    this.contentEl.createEl("p", { cls: "wadjet-studio-world-confirm", text: `${label} are world-level: this changes ${names} too.` });
    new Setting(this.contentEl).setName("Don't ask again this session").addToggle((t) => t.setValue(this.dontAskAgain).onChange((v) => (this.dontAskAgain = v)));
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.settled = true;
      this.close();
      this.onCancel?.();
    });
    buttons.createEl("button", { cls: "mod-cta", text: "Continue" }).addEventListener("click", () => {
      this.settled = true;
      if (this.dontAskAgain) markWorldConfirmed();
      this.close();
      this.onContinue();
    });
    // Escape / click-outside is a cancel, so the control that asked resyncs.
    this.scope.register([], "Escape", () => {
      this.close();
      return false;
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.onCancel?.();
  }
}

/**
 * Run `then` behind the session's one world-edit confirm.
 *
 * Once the Guildmaster has confirmed (or asked not to be asked again) this
 * session, `then` fires straight away and no modal is built. `onCancel` is for
 * the callers whose control has already moved — a knob, a lane clip, a name
 * field — and has to be put back when the edit is refused.
 */
export function confirmWorldEdit(app: App, target: WorldConfirmTarget, subject: WorldSubject, then: () => void, onCancel?: () => void): void {
  if (!needsWorldConfirm()) {
    then();
    return;
  }
  new WorldConfirmModal(app, zoneNamesOf(target), subject, then, onCancel).open();
}
