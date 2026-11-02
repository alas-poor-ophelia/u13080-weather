/**
 * The generator upgrade's dialogs (docs/SESHAT-v0.md §17.2 "UX", §17.5 items 6-10; bead wadjet-9lc step 3):
 * Upgrade (keep the days already used, then move the world to the current generator), "Upgrade the generator
 * first" (a calendar definition on a world that runs the previous generator), Remove kept weather, and the kept
 * weather question a calendar change asks. Words and checks are upgrade.ts's; the scan and the merge keep.ts's.
 */
import { Modal, Notice, Setting, type App, type ButtonComponent, type TextComponent } from "obsidian";
import type WadjetPlugin from "./main";
import type { KeptChoice } from "./calendars";
import { dayFieldText, type DayText } from "./current-day";
import { keepSourceOf, keptSpan, removeKeptWeather, scanKeep, upgradeWorld, type FrozenDay, type KeepScan } from "./keep";
import type { WadjetSettings } from "./settings";
import { ALREADY_UPGRADED, countLine, defaultStart, keptCalendarNote, MOST_RECENT_LABEL, overCapLine, progressLine, readStart, UPGRADE_CHANGES, UPGRADE_FIRST, upgradedNotice } from "./upgrade";

/** How long the date box is left alone before the count starts again. */
const COUNT_DELAY_MS = 400;

type Done = Extract<KeepScan, { kind: "done" }>;

/** The calendar the date box reads (the Current day field's: the definition's on a definition world, else the internal one). */
function dayCalendarOf(plugin: WadjetPlugin): DayText {
  const seshat = plugin.calendars.seshat;
  return plugin.onDefinition() && seshat ? seshat : plugin.internalCalendar;
}

/**
 * Upgrade the weather generator: the range to keep (default one year before the current day, through it), a
 * count of the days that change, then Keep and upgrade, Upgrade without keeping, or Cancel. `onDone` runs after
 * an upgrade that saved.
 */
export class UpgradeModal extends Modal {
  private abort: AbortController | null = null;
  private timer: number | null = null;
  /** a count that finishes after a newer one started (or the dialog closed) is dropped */
  private version = 0;
  private closed = false;

  constructor(
    app: App,
    private readonly plugin: WadjetPlugin,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, plugin } = this;
    const s = plugin.settings;
    this.setTitle("Upgrade the weather generator");
    const cal = dayCalendarOf(plugin);
    const fmt = (d: number) => plugin.displayDay(d);
    const readToday = () => plugin.world.now()?.dayOrdinal ?? plugin.settings.currentDayOrdinal;
    let today = readToday();
    let yearLength = s.calendar.yearLength;
    try {
      yearLength = plugin.world.timeAt(today).yearLength;
    } catch {
      // a calendar that cannot place today: the legacy year length
    }
    let text = dayFieldText(cal, defaultStart(today, yearLength));
    let scan: Done | null = null;
    /** the settings object `scan` was made from: a synced data.json replaces it, and the scan with it */
    let scanOf: WadjetSettings | null = null;
    let mostRecent = false;
    let busy = false;
    let input: TextComponent | null = null;
    let keep: ButtonComponent | null = null;
    let without: ButtonComponent | null = null;

    contentEl.createEl("p", { text: UPGRADE_CHANGES });
    const todayDesc = () => `to today (Current day: ${fmt(today)}). A date as the calendar writes it, or a day number.`;
    const fromRow = new Setting(contentEl)
      .setName("Keep the weather from")
      .setDesc(todayDesc())
      .addText((t) => {
        input = t;
        t.setValue(text).onChange((v) => {
          text = v;
          schedule();
        });
      });
    const status = contentEl.createEl("p", { cls: "wadjet-upgrade-status" });
    const stopRow = new Setting(contentEl).addButton((b) => b.setButtonText("Stop counting").onClick(() => this.abort?.abort()));
    let fitFrom: number | null = null;
    let startThere: ButtonComponent | null = null;
    const capRow = new Setting(contentEl)
      .setName(MOST_RECENT_LABEL)
      .addToggle((t) => t.setValue(false).onChange((v) => (mostRecent = v)))
      .addButton((b) => {
        startThere = b;
        b.setButtonText("Start there").onClick(() => {
          if (fitFrom === null) return;
          text = dayFieldText(cal, fitFrom);
          input?.setValue(text);
          schedule(0);
        });
      });
    /** the cap line, and Start there only when some later start fits */
    const showCap = (c: { fitFromDay: number | null } & Parameters<typeof overCapLine>[0]) => {
      fitFrom = c.fitFromDay;
      startThere?.setDisabled(fitFrom === null);
      capRow.setDesc(overCapLine(c, fmt));
      capRow.settingEl.toggle(true);
    };
    const problem = contentEl.createEl("p", { cls: "mod-warning" });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => {
        without = b;
        b.setButtonText("Upgrade without keeping").onClick(() => void upgrade([], false));
      })
      .addButton((b) => {
        keep = b;
        b.setButtonText("Keep and upgrade")
          .setCta()
          .onClick(() => void keepAndUpgrade());
      });
    stopRow.settingEl.toggle(false);
    capRow.settingEl.toggle(false);

    const setBusy = (on: boolean) => {
      busy = on;
      keep?.setDisabled(on);
      without?.setDisabled(on);
    };

    /** The typed start, or null after showing why it is refused. */
    const start = (): number | null => {
      const r = readStart(cal, text, today, fmt);
      if ("problem" in r) {
        fromRow.setErrorMessage(r.problem);
        return null;
      }
      fromRow.setErrorMessage(null);
      return r.from;
    };

    /** Count the days that change from the typed start; null when refused, stopped, superseded or failed. */
    const count = async (): Promise<Done | null> => {
      const v = ++this.version;
      this.abort?.abort();
      scan = null;
      capRow.settingEl.toggle(false);
      problem.setText("");
      const from = start();
      if (from === null) {
        status.setText("");
        return null;
      }
      const ac = new AbortController();
      this.abort = ac;
      status.setText(progressLine(0, 1));
      stopRow.settingEl.toggle(true);
      const active = plugin.world.time.active ?? plugin.internalCalendar;
      const source = plugin.settings;
      const res = await scanKeep(
        keepSourceOf(source, active),
        source.zones.map((z) => z.id),
        from,
        today,
        {
          signal: ac.signal,
          onProgress: (done, total) => {
            if (v === this.version) status.setText(progressLine(done, total));
          },
        },
      );
      if (this.abort === ac) this.abort = null;
      if (v !== this.version || this.closed) return null;
      stopRow.settingEl.toggle(false);
      if (res.kind === "cancelled") {
        status.setText("Counting stopped. Keep and upgrade counts again.");
        return null;
      }
      if (res.kind !== "done") {
        status.setText("");
        problem.setText(res.message);
        return null;
      }
      // a synced data.json arrived while counting: the count is of a world that is gone
      if (plugin.settings !== source) {
        status.setText("The settings changed while counting. Keep and upgrade counts again.");
        return null;
      }
      scan = res;
      scanOf = source;
      status.setText(countLine(res));
      // past the cap (§17.5 item 6): say so, and offer the most recent days or a later start
      const preview = upgradeWorld(source, res.days);
      if (preview.kind === "over-cap") showCap(preview);
      return res;
    };

    /** A date edit: the range is checked at once, and counted once the box is left alone. */
    const schedule = (delay = COUNT_DELAY_MS) => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.version++;
      this.abort?.abort();
      scan = null;
      status.setText("");
      stopRow.settingEl.toggle(false);
      capRow.settingEl.toggle(false);
      if (start() === null) return;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        void count();
      }, delay);
    };

    const keepAndUpgrade = async () => {
      if (busy) return;
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      // a scan of settings that a synced data.json has since replaced is counted again, up to today as it is now
      if (scan !== null && scanOf !== plugin.settings) scan = null;
      if (scan === null) {
        today = readToday();
        fromRow.setDesc(todayDesc());
      }
      const done = scan ?? (await count());
      if (done === null || this.closed) return;
      await upgrade(done.days, true);
    };

    const upgrade = async (days: readonly FrozenDay[], kept: boolean) => {
      if (busy) return;
      // another device upgraded the world while the dialog was open (a synced data.json)
      if (plugin.generatorMode() !== "previous") {
        new Notice(ALREADY_UPGRADED);
        this.close();
        plugin.refreshSettingsTab();
        return;
      }
      const r = upgradeWorld(plugin.settings, days, mostRecent ? { mostRecent: true } : {});
      if (r.kind === "over-cap") {
        showCap(r);
        problem.setText(`Not upgraded: turn on "${MOST_RECENT_LABEL}", or choose a later start.`);
        return;
      }
      setBusy(true);
      this.version++;
      this.abort?.abort();
      // the world takes the upgraded fields in place (other code holds this settings object); a failed save puts them back
      const st = plugin.settings;
      const was = { generatorVersion: st.generatorVersion, frozen: st.frozen };
      st.generatorVersion = r.settings.generatorVersion;
      st.frozen = r.settings.frozen;
      try {
        await plugin.saveAndRebuild();
      } catch (e) {
        if (st.generatorVersion === r.settings.generatorVersion && st.frozen === r.settings.frozen) Object.assign(st, was);
        setBusy(false);
        problem.setText(`Not upgraded: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      new Notice(upgradedNotice(r, kept));
      this.close();
      plugin.refreshSettingsTab();
      this.onDone();
    };

    void count();
  }

  override onClose(): void {
    this.closed = true;
    this.version++;
    this.abort?.abort();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.contentEl.empty();
  }
}

/**
 * "Upgrade the generator first" inside `modal` (Change calendar…, Undo, the calendar chooser on a world that
 * runs the previous generator, §17.5 item 9): Upgrade… closes it and opens the Upgrade dialog; `then` runs after
 * an upgrade that saved.
 */
export function renderUpgradeFirst(modal: Modal, plugin: WadjetPlugin, then: () => void): void {
  modal.contentEl.createEl("p", { text: UPGRADE_FIRST });
  new Setting(modal.contentEl)
    .addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
    .addButton((b) =>
      b
        .setButtonText("Upgrade…")
        .setCta()
        .onClick(() => {
          modal.close();
          new UpgradeModal(plugin.app, plugin, then).open();
        }),
    );
}

class UpgradeFirstModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: WadjetPlugin,
    private readonly title: string,
    private readonly then: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    renderUpgradeFirst(this, this.plugin, this.then);
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Open "Upgrade the generator first" as its own dialog, titled for what was asked. */
export function openUpgradeFirst(app: App, plugin: WadjetPlugin, title: string, then: () => void = () => undefined): void {
  new UpgradeFirstModal(app, plugin, title, then).open();
}

/** A question with Cancel (and Escape, click-outside) resolving null. */
class ChoiceModal<T> extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly text: string,
    private readonly choices: ReadonlyArray<{ label: string; value: T; cta?: boolean; warning?: boolean }>,
    private readonly done: (v: T | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.text });
    const row = new Setting(this.contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.settle(null)));
    for (const c of this.choices) {
      row.addButton((b) => {
        b.setButtonText(c.label).onClick(() => this.settle(c.value));
        if (c.cta) b.setCta();
        if (c.warning) b.setDestructive();
      });
    }
  }

  private settle(v: T | null): void {
    this.settled = true;
    this.close();
    this.done(v);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.done(null);
  }
}

/** Remove kept weather? Resolves true on Remove. */
export function confirmRemoveKept(app: App, count: number): Promise<boolean> {
  const these = count === 1 ? "The kept day shows" : `The ${count.toLocaleString("en")} kept days show`;
  return new Promise((resolve) =>
    new ChoiceModal(app, "Remove the kept weather?", `${these} the generator's weather again. This cannot be undone.`, [{ label: "Remove", value: true, warning: true }], (v) => resolve(v === true)).open(),
  );
}

/** The world's readable kept days, or 0. */
export function keptCount(plugin: WadjetPlugin): number {
  return keptSpan(plugin.settings)?.count ?? 0;
}

/**
 * Before a calendar change that has no dialog of its own (the legacy calendar's rows, the Studio's legacy save,
 * the calendar chooser, Undo): on a world with kept weather, ask whether it stays (§17.5 item 8). Resolves the
 * choice, `{}` at once when there is none kept, or null on Cancel.
 */
export function askKeptOnCalendarChange(app: App, plugin: WadjetPlugin): Promise<KeptChoice | null> {
  const count = keptCount(plugin);
  if (count === 0) return Promise.resolve({});
  return new Promise((resolve) =>
    new ChoiceModal<KeptChoice>(
      app,
      "Change the calendar?",
      `${keptCalendarNote(count)} They were made under the old calendar's seasons and moons.`,
      [
        { label: "Remove kept weather", value: { removeKept: true }, warning: true },
        { label: "Keep them", value: { removeKept: false }, cta: true },
      ],
      resolve,
    ).open(),
  );
}

/**
 * The calendar dialog's kept weather row (Change calendar…): shown on a world with kept
 * weather, beside the pin warning; the toggle removes it in the change's own save. Returns the row, or null.
 */
export function keptToggleRow(el: HTMLElement, plugin: WadjetPlugin, onChange: (remove: boolean) => void): Setting | null {
  const count = keptCount(plugin);
  if (count === 0) return null;
  return new Setting(el)
    .setName("Remove the kept weather")
    .setDesc(`${keptCalendarNote(count)} Remove them to show this calendar's weather on those days too.`)
    .addToggle((t) => t.setValue(false).onChange(onChange));
}

/**
 * Empty the kept weather in place, readable or not (Remove, a calendar change that takes it along), before the save
 * that writes it; returns the undo for a save that failed (as Calendars' dropKept).
 */
export function dropKeptIn(s: WadjetSettings): () => void {
  const was = s.frozen;
  const none = removeKeptWeather(s).frozen;
  s.frozen = none;
  return () => {
    if (s.frozen === none) s.frozen = was;
  };
}
