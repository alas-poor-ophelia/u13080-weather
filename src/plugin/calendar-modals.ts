/**
 * The calendar's dialogs (docs/SESHAT-v0.md §13.11): Change calendar… and Edit
 * definition. They live here, not in the settings tab, so the Studio can open
 * them too.
 */
import { Modal, Notice, Setting, type App, type ButtonComponent } from "obsidian";
import type WadjetPlugin from "./main";
import { prepareDefinition } from "./time/seshat";
import { buildOptIn, WORLD_PRESETS, type OptInChoice } from "./opt-in";
import { yearKeyedNote } from "./calendar-change";
import { keptToggleRow, renderUpgradeFirst } from "./upgrade-modals";

/** Validation for the calendar definition: the first error (with its line when known), or nothing. */
export function badDefinition(text: string): string | undefined {
  const r = prepareDefinition(text);
  // a parse error's message already starts "line N: " (seshat ParseError); only capitalise it
  return "error" in r ? r.error.replace(/^line (\d+): /, "Line $1: ") : undefined;
}

/**
 * Opting the world into a calendar definition (docs/SESHAT-v0.md §13.11 "Day
 * 0"): where it starts from, whether the world's seasons and moons come
 * along, and whether day numbers are kept or today is anchored to a date.
 * The preview is `buildOptIn`'s, so what it shows is what is stored.
 */
export class OptInModal extends Modal {
  constructor(
    app: App,
    private plugin: WadjetPlugin,
    private onDone: () => void,
    /** a preset id to start from (the Orrery's preset menu, docs/SESHAT-v0.md §18.4 Q1); otherwise the usual default */
    private start?: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const s = this.plugin.settings;
    this.setTitle("Change calendar");
    // the previous generator never runs on a definition (SESHAT-v0 §17.5 item 9): upgrade first, then this dialog again
    if (this.plugin.generatorMode() === "previous") {
      renderUpgradeFirst(this, this.plugin, () => {
        this.onDone();
        new OptInModal(this.app, this.plugin, this.onDone, this.start).open();
      });
      return;
    }
    const stored = typeof s.calendar.definition === "string" ? s.calendar.definition : null;
    // a stored definition (kept from an earlier opt-out, or faulted and kept byte for byte) is where to start:
    // anything else replaces it, and that is asked for below
    // the legacy calendar is offered only on worlds that came from it (§15.1 R3): as a definition to start
    // from, and, from another calendar, as the way back
    const legacyOrigin = s.calendar.origin !== "definition";
    const canGoBack = legacyOrigin && this.plugin.time.active?.id !== "internal";
    let source = this.start !== undefined && WORLD_PRESETS.some((p) => p.id === this.start) ? this.start : stored !== null ? "text" : legacyOrigin ? "internal" : (WORLD_PRESETS[0]?.id ?? "text");
    // a stored definition usually has its own seasons and moons already
    let carry = stored === null;
    let replace = false;
    let anchor = false;
    let date = "";
    let pasted = stored ?? "";
    const choice = (): OptInChoice => ({
      source: source === "internal" ? { kind: "internal" } : source === "text" ? { kind: "text", text: pasted } : { kind: "preset", id: source },
      carry: source !== "internal" && carry,
      ...(anchor ? { anchor: date } : {}),
    });

    const options: Record<string, string> = {};
    if (canGoBack) options.back = "Go back to the legacy calendar";
    if (legacyOrigin) options.internal = "This world's legacy calendar, as a definition (the same days, seasons and moons)";
    for (const p of WORLD_PRESETS) options[p.id] = p.ast.name;
    options.text = stored !== null ? "The stored definition (edit it below)" : "Paste a definition (Seshat text)";
    new Setting(contentEl).setName("Start from").addDropdown((d) =>
      d
        .addOptions(options)
        .setValue(source)
        .onChange((v) => {
          source = v;
          refresh();
        }),
    );
    const area = contentEl.createEl("textarea", { cls: "wadjet-definition-text" });
    area.rows = 12;
    area.value = pasted;
    area.addEventListener("input", () => {
      pasted = area.value;
      refresh();
    });
    const carryRow = new Setting(contentEl)
      .setName("Bring this world's seasons and moons")
      .setDesc("Season tags and moon conditions in your zones keep working. The moons stay exactly where they are in the sky.")
      .addToggle((t) =>
        t.setValue(carry).onChange((v) => {
          carry = v;
          refresh();
        }),
      );
    const dayRow = new Setting(contentEl)
      .setName("Day numbers")
      .setDesc(
        [
          "Today, pinned days and overrides are stored as day numbers. Keep them, and they fall on new dates; or anchor today to a date, and the calendar moves so today reads as that date.",
          yearKeyedNote(this.plugin.settings.eras, this.plugin.settings.zones),
        ]
          .filter(Boolean)
          .join(" "),
      )
      .addDropdown((d) =>
        d
          .addOptions({ keep: "Keep day numbers", anchor: "Anchor today to a date" })
          .setValue("keep")
          .onChange((v) => {
            anchor = v === "anchor";
            refresh();
          }),
      );
    const dateRow = new Setting(contentEl).setName("Today is").addText((t) =>
      t.setPlaceholder("Written as the preview writes today").onChange((v) => {
        date = v;
        refresh();
      }),
    );
    const replaceRow = new Setting(contentEl)
      .setName("Replace the stored definition")
      .setDesc("This world already stores a calendar definition. Switching to another calendar replaces it; it is not kept anywhere else.")
      .addToggle((t) =>
        t.setValue(replace).onChange((v) => {
          replace = v;
          refresh();
        }),
      );
    // kept weather is bound to the old calendar's seasons and moons (§17.5 item 8)
    let removeKept = false;
    keptToggleRow(contentEl, this.plugin, (v) => (removeKept = v));
    const preview = contentEl.createEl("p");
    const problem = contentEl.createEl("p", { cls: "mod-warning" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "A world on a calendar definition needs this version of the plugin or a later one. An older version does not know definitions: it would run this world on the legacy calendar's settings again, without saying so, and the weather would change.",
    });
    let save: ButtonComponent | null = null;
    let busy = false;
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        save = b;
        b.setButtonText("Switch calendar")
          .setCta()
          .onClick(async () => {
            if (busy) return;
            if (source === "back") {
              busy = true;
              b.setDisabled(true);
              try {
                await this.plugin.calendars.setActive("internal", { removeKept });
              } catch (e) {
                busy = false;
                b.setDisabled(false);
                return void problem.setText(`Not switched: ${e instanceof Error ? e.message : String(e)}`);
              }
              new Notice("This world runs on the legacy calendar again. The calendar definition stays stored; Undo the last calendar change switches back to it.");
              this.close();
              this.onDone();
              return;
            }
            const r = buildOptIn(choice(), s.calendar, s.currentDayOrdinal);
            if ("error" in r) return void problem.setText(r.error);
            busy = true;
            b.setDisabled(true);
            try {
              await this.plugin.calendars.optIn(r.text, { replaceStored: replace, removeKept });
            } catch (e) {
              busy = false;
              b.setDisabled(false);
              return void problem.setText(`Not switched: ${e instanceof Error ? e.message : String(e)}`);
            }
            const named = source === "internal" ? "its legacy calendar, as a definition" : source === "text" ? "your calendar definition" : (WORLD_PRESETS.find((p) => p.id === source)?.ast.name ?? "a calendar definition");
            new Notice(`This world now runs on ${named}. Today is ${r.today}.`);
            this.close();
            this.onDone();
          });
      });

    const refresh = () => {
      const back = source === "back";
      area.toggle(source === "text");
      carryRow.settingEl.toggle(!back && source !== "internal");
      dayRow.settingEl.toggle(!back);
      dateRow.settingEl.toggle(!back && anchor);
      if (back) {
        replaceRow.settingEl.toggle(false);
        problem.setText("");
        preview.setText(
          `The world runs on the legacy calendar again, with its settings as they were before it moved to a definition: years of ${s.calendar.yearLength} days, its own seasons and moons. Changes made to the definition since do not carry back; the definition stays stored, and Undo the last calendar change switches back to it.`,
        );
        save?.setDisabled(false);
        return;
      }
      const r = buildOptIn(choice(), s.calendar, s.currentDayOrdinal);
      // replacing a stored definition with a different text is never the default
      const replaces = stored !== null && !("error" in r) && r.text !== stored;
      replaceRow.settingEl.toggle(replaces);
      if ("error" in r) {
        preview.setText("");
        problem.setText(r.error);
        save?.setDisabled(true);
        return;
      }
      const moved = r.shift === 0 ? "" : ` The calendar moves ${Math.abs(r.shift).toLocaleString("en")} days ${r.shift > 0 ? "later" : "earlier"} so that it does.`;
      const lossy = r.lossy.length ? ` The cycle of ${r.lossy.join(", ")} is held as the nearest exact fraction, as the legacy calendar already ran it.` : "";
      preview.setText(`Today (day ${s.currentDayOrdinal}) will read: ${r.today}.${moved}${lossy}`);
      problem.setText(
        r.renamed.length
          ? `The definition stores ${r.renamed.map((n) => `"${n}"`).join(", ")} in another Unicode form (NFC). A zone that names them in the old form no longer matches them; the studio flags such zones.`
          : "",
      );
      save?.setDisabled(replaces && !replace);
    };
    refresh();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * The stored calendar definition, edited as text. Opens on the stored value
 * exactly as it is (a faulted one included, never re-printed); Save checks
 * it, stores the canonical form, and closes; an error stays in the modal.
 */
export class DefinitionModal extends Modal {
  constructor(
    app: App,
    private plugin: WadjetPlugin,
    private onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Calendar definition");
    const stored = this.plugin.settings.calendar.definition;
    let text = typeof stored === "string" ? stored : stored === undefined ? "" : JSON.stringify(stored);
    contentEl.createEl("p", { cls: "setting-item-description", text: "Seshat text. Saving checks it and stores it in canonical form; comments are removed." });
    const area = contentEl.createEl("textarea", { cls: "wadjet-definition-text" });
    area.rows = 20;
    area.value = text;
    area.addEventListener("input", () => (text = area.value));
    const error = contentEl.createEl("p", { cls: "mod-warning" });
    const fault = this.plugin.calendars.fault();
    error.setText(fault ? `It cannot run: ${fault}.` : "");
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const bad = badDefinition(text);
            if (bad) return void error.setText(bad);
            try {
              // a VBODY that kept its UID and changed its MOON name is a rename: its references follow in this save (bead wadjet-zoy)
              await this.plugin.calendars.saveDefinition(text, { renames: "byUid" });
            } catch (e) {
              return void error.setText(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
            }
            this.close();
            this.onDone();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
