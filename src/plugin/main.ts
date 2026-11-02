import { MarkdownRenderChild, MarkdownView, Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import type { StudioStash } from "../studio/model/stash";
import { openCalendarEditor, openStudioFromCommand } from "../studio/ui/open";
import { StudioView, VIEW_TYPE as STUDIO_VIEW_TYPE } from "../studio/ui/view";
import type { WeatherReport } from "../core/report";
import { GENERATOR_VERSION, type GeneratorMode } from "../core/version";
import { ApiController, type WadjetAPI } from "./api";
import { Calendars } from "./calendars";
import { seshatDraft } from "../studio/model/definition";
import type { StudioSettingsLike } from "../studio/model/state";
import { blockRepaintOn, parseCodeblock, pickCodeblockZone, resolveDate, type CodeblockSpec } from "./codeblock-parse";
import { displayFormat, displayWith } from "./date-display";
import { frontmatterResolver } from "./frontmatter-resolver";
import { formatInterpretation } from "./interpreters";
import { CONFLICT_NOTICE, FirstSave, readExternal, SaveQueue, setAndSave, YIELD_NOTICE } from "./persist";
import { renderCard, renderError, renderLine, renderProse, renderTable, renderValue } from "./render";
import { convertReport, reportField } from "../core/units";
import { DEFAULT_SETTINGS, generatorMismatch, migrateSettings, type WadjetSettings } from "./settings";
import { WadjetSettingTab } from "./settings-tab";
import { TimeRegistry } from "./time/adapter";
import { InternalCalendar } from "./time/internal";
import { World, type WorldState } from "./world";
import { worldStateOf } from "./keep";
import { startNewWorld } from "./new-world";
import { PREVIOUS_LOAD_NOTICE, syncRevertNotice, worldMode } from "./upgrade";

export type { WadjetAPI } from "./api";

/** `__wadjetPreviousNotice`: the previous-generator load Notice has shown in this window's session (§17.5 item 11). */
type WindowWithWadjet = Window & { Wadjet?: WadjetAPI; __wadjetPreviousNotice?: boolean };

export default class WadjetPlugin extends Plugin {
  override settings: WadjetSettings = DEFAULT_SETTINGS;
  time!: TimeRegistry;
  internalCalendar!: InternalCalendar;
  world!: World;
  api!: WadjetAPI;
  controller!: ApiController;
  /** the stored Seshat definition and every calendar switch */
  calendars!: Calendars;
  settingTab?: WadjetSettingTab;
  /**
   * Dirty studio drafts kept across a leaf close within this session (bead
   * wadjet-9f9.36). Plain in-memory state — never read or written by
   * `loadData`/`saveData` — taken by `StudioView.onClose` via
   * `studio/model/stash.ts:takeStash` and consumed by the next
   * `StudioView` constructor via `applyStash`.
   */
  studioStash?: StudioStash;
  /**
   * Set first thing in onunload. Every continuation after an await checks it:
   * a disabled-then-re-enabled plugin has a NEW instance reading data.json,
   * and a late save from this one would overwrite it.
   */
  private dead = false;
  /** what follows the Date display setting (rendered codeblocks); plugin-internal, not an API event */
  private readonly displayListeners = new Set<() => void>();
  /** the internal calendar's configHash at the last rebuild, to tell a calendar edit from any other save */
  private internalHash = "";
  /**
   * A new world (no data.json) is not saved at startup; its first save re-reads the disk and steps aside
   * if synced settings have arrived (bead wadjet-1ou). Its Notice shows once and stays until dismissed.
   */
  private readonly firstSave = new FirstSave(
    () => this.loadData(),
    (reason) => {
      const text = reason === "conflict" ? CONFLICT_NOTICE : YIELD_NOTICE;
      console.warn(`U+13080 Weather: ${text}`);
      new Notice(text, 0);
    },
  );
  /**
   * True while a time change the user asked for (the settings tab's day, the advance commands) runs inside
   * the API's time queue, so its save is the user's; any other day write (another plugin or a script calling
   * setNow/advance) is automatic, and a new world does not write it until the user saves (bead wadjet-1ou).
   */
  private userTime = false;
  /** Every saveData goes through here: one write at a time, each writing the settings as they are when it starts. */
  private readonly saves = new SaveQueue(
    this.firstSave.guard((data) => this.saveData(data)),
    () => this.settings,
    () => !this.dead,
  );

  override async onload(): Promise<void> {
    const loaded: unknown = await this.loadData();
    if (this.dead) return;
    const repairs: string[] = [];
    this.settings = migrateSettings(loaded, (msg) => repairs.push(msg));
    // no data.json at all: a new world, on a plain calendar definition (§15.6); a data.json missing a field never is.
    // It is not saved here: on a fresh device Sync may not have delivered data.json yet (bead wadjet-1ou).
    const fresh = loaded === null || loaded === undefined;
    if (fresh) {
      startNewWorld(this.settings, this.app.vault.getName());
      this.firstSave.startNew();
    } else this.firstSave.noteDisk(loaded);
    if (repairs.length) {
      // the repaired settings are saved below, so these messages are where the old values survive: show them and log them
      for (const msg of repairs) console.warn(`U+13080 Weather: ${msg}`);
      new Notice(`Wadjet repaired its calendar settings: ${repairs.join(" ")}`, 15000);
    }
    this.time = new TimeRegistry(this.settings.activeTimeAdapter);
    this.internalCalendar = new InternalCalendar(
      this.settings.calendar,
      () => this.settings.currentDayOrdinal,
      (d) => this.writeCurrentDay(d),
      this.generatorMode(),
    );
    this.internalHash = this.internalCalendar.configHash();
    this.time.register(this.internalCalendar);
    this.world = new World(this.worldState(), this.time);
    this.controller = new ApiController({ version: this.manifest.version, world: this.world, time: this.time, units: () => this.settings.units, openCalendarEditor: () => openCalendarEditor(this) });
    this.api = this.controller.api;
    this.calendars = new Calendars({
      settings: () => this.settings,
      time: this.time,
      world: this.world,
      save: () => this.saveSettings(),
      writeDay: (d) => this.writeCurrentDay(d),
      rebuild: () => {
        if (this.dead) return;
        // leaving a definition can move the mode (a 0.0.3 world back on the built-in calendar, SESHAT-v0 §17.5 item 9)
        this.internalCalendar.update(this.settings.calendar, this.generatorMode());
        this.world.setState(this.worldState());
      },
      emitTimeChanged: () => this.controller.emitTimeChanged(),
      emitAdaptersChanged: () => {
        if (this.dead) return;
        this.world.emit("adapters-changed");
        this.refreshSettingsTab();
      },
      syncActiveSubscription: () => this.controller.syncActiveSubscription(),
      moonsRenamed: (renames) => {
        for (const leaf of this.app.workspace.getLeavesOfType(STUDIO_VIEW_TYPE)) if (leaf.view instanceof StudioView) leaf.view.followExternalMoonRenames(renames);
      },
    });
    const fault = this.calendars.fault();
    // a stored definition the world has left changes no weather: it is shown in settings, not announced
    if (fault !== null && this.time.active === this.calendars.seshat) {
      console.error(`U+13080 Weather: the stored calendar definition cannot run (${fault}). It is kept as it is; fix it in settings.`);
      new Notice(`Wadjet: the stored calendar definition cannot run (${fault}). It is kept as it is; fix it in settings.`, 15000);
    }
    this.time.onChange((change) => {
      if (this.dead || this.calendars.quiet) return;
      this.controller.syncActiveSubscription();
      if (change.id === this.settings.activeTimeAdapter) this.controller.emitTimeChanged();
      this.world.emit("adapters-changed");
      this.refreshSettingsTab(); // the Calendar row and the Calendar plugin chooser list registered adapters
    });
    this.controller.syncActiveSubscription();
    // First in the chain, registered through the public API like any other plugin's resolver.
    this.api.registerZoneResolver(
      frontmatterResolver(
        (path) => {
          const file = this.app.vault.getFileByPath(path);
          return file ? (this.app.metadataCache.getFileCache(file)?.frontmatter ?? null) : null;
        },
        () => this.settings.zones,
      ),
    );

    (window as WindowWithWadjet).Wadjet = this.api;

    this.settingTab = new WadjetSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerMarkdownCodeBlockProcessor("wadjet", (src, el, ctx) => this.renderCodeblock(src, el, ctx));
    // The plugin registers the factory and never keeps the instance (eslint
    // `noViewReferencesInPlugin`); the leaf owns its own store and view state.
    this.registerView(STUDIO_VIEW_TYPE, (leaf) => new StudioView(leaf, this));
    this.registerCommands();

    if (this.generatorMode() === "previous") {
      // once per session: turning the plugin off and on again does not repeat it (SESHAT-v0 §17.5 item 11)
      const w = window as WindowWithWadjet;
      if (!w.__wadjetPreviousNotice) {
        w.__wadjetPreviousNotice = true;
        new Notice(PREVIOUS_LOAD_NOTICE, 15000);
      }
    } else if (generatorMismatch(this.settings)) {
      new Notice(`The weather generator was updated (${this.settings.generatorVersion} → ${GENERATOR_VERSION}). Only the current generator ships, so past weather may differ from what you saw before. Pinned days are kept. You can acknowledge the change in settings.`, 10000);
    }

    // persist repairs and migrations; a new world waits for its first change (bead wadjet-1ou)
    if (!fresh) await this.saveSettings();
    if (this.dead) return;
    this.controller.markReady();
    this.app.workspace.trigger("wadjet:ready");
  }

  /**
   * data.json changed on disk from outside (Sync). A new world that has not saved steps aside for it
   * (bead wadjet-1ou); a saved world reloads it in place (bead wadjet-7md), writing nothing.
   */
  override async onExternalSettingsChange(): Promise<void> {
    if (this.dead) return;
    this.firstSave.external();
    // still loading (onload reads data.json itself and saves it), or a new world that has stepped aside
    if (!this.controller || this.firstSave.current === "yielded") return;
    // Obsidian awaits this, then updates the settings tab itself
    try {
      await this.followExternal();
    } catch (e) {
      console.error("U+13080 Weather: following a changed data.json failed.", e);
    }
  }

  /**
   * Adopt an outside data.json on a saved world (bead wadjet-7md): after any queued or running write has
   * settled, re-read it; an echo of Wadjet's own write, a failed read or a non-object is ignored. Otherwise
   * it is migrated (repairs are shown, not saved: nothing is written in response to an outside change) and
   * replaces the settings, and everything that follows settings is told as after a local save. Open Studios
   * follow through profiles-changed / adapters-changed: clean drafts take the new file, dirty ones keep
   * their edits and their Save's stale check catches a conflict.
   */
  private async followExternal(): Promise<void> {
    const found = await readExternal({ read: () => this.loadData(), queue: this.saves, first: this.firstSave, alive: () => !this.dead });
    // a new world that has not finished its first write is not following anything yet
    if (found === null || this.dead || this.firstSave.current !== "saved") return;
    const repairs: string[] = [];
    const next = migrateSettings(found, (msg) => repairs.push(msg));
    this.firstSave.noteDisk(found);
    if (repairs.length) {
      for (const msg of repairs) console.warn(`U+13080 Weather: ${msg}`);
      new Notice(`Wadjet repaired its calendar settings: ${repairs.join(" ")}`, 15000);
    }
    const display = this.settings.calendar.display;
    const before = { generatorVersion: this.settings.generatorVersion, activeTimeAdapter: this.settings.activeTimeAdapter, calendar: { definition: this.settings.calendar.definition } };
    this.calendars.follow(() => {
      this.settings = next;
      // the mode, the internal calendar and the world move together (SESHAT-v0 §17.5 item 7); rebuild() follows
      this.internalCalendar.update(next.calendar, this.generatorMode());
    });
    this.internalHash = this.internalCalendar.configHash();
    // an older device pressed Acknowledge on this world (§17.5 item 7): its kept weather stays, Upgrade is offered again;
    // on a calendar definition it keeps the current generator (§17.5 item 9), and the Notice says so
    const reverted = syncRevertNotice(before, this.settings);
    if (reverted !== null) new Notice(reverted, 15000);
    if (next.calendar.display !== display) this.emitDisplayChanged();
    this.refreshSettingsTab();
  }

  override onunload(): void {
    this.dead = true;
    this.controller?.unload(() => this.app.workspace.trigger("wadjet:unload"));
    delete (window as WindowWithWadjet).Wadjet;
  }

  /**
   * The generator this world runs, from the version it last accepted (SESHAT-v0 §17.2), and never the previous one
   * over a calendar definition (§17.5 item 9): see worldMode.
   */
  generatorMode(): GeneratorMode {
    return worldMode(this.settings);
  }

  private worldState(): WorldState {
    return worldStateOf(this.settings, this.generatorMode());
  }

  /**
   * Save settings to data.json (serialised with every other save); does nothing once the plugin is unloaded.
   * Rejects, writing nothing, once a new world has yielded to synced settings (bead wadjet-1ou).
   * `automatic`: the change did not come from the user (another plugin or a script through the API); while
   * the world is new such a save resolves without writing, and the change is written by the user's first save.
   */
  async saveSettings(opts: { automatic?: boolean } = {}): Promise<void> {
    if (this.dead) return;
    await this.saves.save(opts);
  }

  /** Run a time step (already inside the API's time queue) as the user's own, so its day write is user-initiated. */
  private async asUser<T>(f: () => Promise<T>): Promise<T> {
    this.userTime = true;
    try {
      return await f();
    } finally {
      this.userTime = false;
    }
  }

  /** Save and push the new state into the world (rebuilds generators lazily). */
  async saveAndRebuild(): Promise<void> {
    await this.saveSettings();
    if (this.dead) return;
    this.internalCalendar.update(this.settings.calendar, this.generatorMode());
    this.world.setState(this.worldState());
    const hash = this.internalCalendar.configHash();
    if (hash !== this.internalHash) {
      this.internalHash = hash;
      // A year-length/season/moon/epoch edit moves what "today" means. Its weather side is profiles-changed
      // with all: true, which world.setState above has already fired (the shared key carries calendarHash()).
      if (this.time.active === this.internalCalendar) this.controller.emitTimeChanged();
    }
  }

  /**
   * The internal calendar's writer: store the day and save. Runs inside the API's time queue.
   * A failed save puts the previous day back and rethrows, so the calendar tells no subscriber,
   * `setNow`/`advance` resolve false, and no time-changed fires.
   * Automatic unless the user's own time step is running (`userTime`): a new world keeps an API caller's
   * day in memory and writes it with the user's first save (bead wadjet-1ou).
   */
  private async writeCurrentDay(d: number): Promise<void> {
    if (this.dead) throw new Error("U+13080 Weather is unloaded.");
    const automatic = !this.userTime;
    await setAndSave(
      () => this.settings.currentDayOrdinal,
      (v) => (this.settings.currentDayOrdinal = v),
      d,
      () => this.saveSettings({ automatic }),
    );
    if (this.dead) return;
    this.refreshSettingsTab();
  }

  /**
   * The settings tab's "Current day" edit: the stored day, whichever calendar is active, through the same
   * queue as `api.setNow`. The seshat adapter shares the day; when it is active it moves it, so its
   * subscribers (the active subscription) hear of it.
   */
  setInternalDay(d: number): Promise<void> {
    return this.controller.enqueue(async () => {
      if (this.dead) return;
      const seshat = this.calendars.seshat;
      const adapter = seshat && this.time.active === seshat ? seshat : this.internalCalendar;
      await this.asUser(() => adapter.setNow(d));
    });
  }

  /** The settings tab's calendar choice (the Calendar plugin chooser, Change calendar…'s way back to the legacy calendar). Fires time-changed and adapters-changed when the effective calendar changes. */
  setActiveTimeAdapter(id: string): Promise<void> {
    return this.calendars.setActive(id);
  }

  /**
   * What the Studio opens on: the settings, with the calendar a Seshat world runs (its definition's
   * seasons and moons) in place of the legacy fields it never edits there.
   */
  studioSettings(): StudioSettingsLike {
    const seshat = this.calendars.seshat;
    if (!seshat || this.time.active !== seshat) return { ...this.settings, calendarSource: "legacy" };
    const ast = seshat.definition();
    // a definition that cannot run has no calendar to edit; the legacy fields are shown, never saved (source "fault")
    return ast ? { ...this.settings, calendar: seshatDraft(ast), calendarSource: "seshat" } : { ...this.settings, calendarSource: "fault" };
  }

  /**
   * A day as the world's own calendar writes it: the definition's format on a seshat world, else the
   * internal calendar's. A faulted definition writes the bare day number, never another calendar's date.
   */
  formatDay(d: number): string {
    const seshat = this.calendars.seshat;
    return seshat && this.time.active === seshat ? seshat.format(d) : this.internalCalendar.format(d);
  }

  /** Whether the world runs its stored calendar definition (the Date display setting applies only there). */
  onDefinition(): boolean {
    const seshat = this.calendars.seshat;
    return !!seshat && this.time.active === seshat;
  }

  /**
   * A day for a READ-only readout (bead wadjet-01k.18): the Date display setting's format on a definition
   * world, or `override` (a codeblock's `format:`) when the definition declares it; formatDay everywhere
   * else (legacy worlds, other plugins' calendars), and for a named format that is gone or throws.
   * Never for a date that is typed or parsed, stored, or returned by the API: those use formatDay.
   */
  displayDay(d: number, override?: string): string {
    const seshat = this.calendars.seshat;
    const ast = seshat && this.time.active === seshat ? seshat.definition() : null;
    if (!seshat || !ast) return this.formatDay(d);
    return displayWith(
      displayFormat(ast, this.settings.calendar.display, override),
      (name) => seshat.formatNamed(d, name),
      () => seshat.format(d),
    );
  }

  /** Listen for a Date display change (a settings save, or a synced data.json); returns the unsubscribe. */
  onDisplayChanged(fn: () => void): () => void {
    this.displayListeners.add(fn);
    return () => void this.displayListeners.delete(fn);
  }

  /** Tell rendered readouts the Date display changed. */
  emitDisplayChanged(): void {
    for (const fn of [...this.displayListeners]) {
      try {
        fn();
      } catch (e) {
        console.error("U+13080 Weather: a date display listener threw.", e);
      }
    }
  }

  /**
   * Re-read the settings tab's definitions — commands, and the studio's Save,
   * change state it displays.
   *
   * This must run whether or not the tab is on screen. `SettingTab.update()`
   * stores the result of `getSettingDefinitions()` and only re-renders when
   * the tab is showing; Obsidian itself calls it from `addSettingTab()`, long
   * before any settings window exists, so calling it on a hidden tab is both
   * safe and necessary. The declarative tab keeps the rows it built, so a pin
   * saved from the studio while Settings was shut used to still be missing
   * from "Pinned days" the next time it opened.
   */
  refreshSettingsTab(): void {
    // `onload` subscribes to `time.onChange` before it builds the tab, so an
    // adapter registered in that window can reach this one tick early.
    this.settingTab?.update();
  }

  // --- codeblock -----------------------------------------------------------
  private renderCodeblock(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const spec = parseCodeblock(src);
    if (spec.errors.length) return renderError(el, spec.errors.join("; "));
    const shown = this.renderBlock(spec, el, ctx.sourcePath);
    // Re-render when the answer can change under the block: the current day or the calendar (every
    // block: its day and its date label move with them, bead wadjet-6tu), a weather edit to its zone,
    // a zone from the note's frontmatter, or interpreters registered after the note rendered.
    ctx.addChild(new BlockWatcher(el, this, spec, ctx.sourcePath, shown));
  }

  /** Which zone a block without `zone:` shows right now. */
  codeblockZone(spec: CodeblockSpec, sourcePath: string): string | undefined {
    return pickCodeblockZone(spec, sourcePath, (path) => this.world.resolveZone({ kind: "note", path }), this.settings.zones[0]?.id).zoneId;
  }

  /** Render one block into `el`; returns the zone it showed (undefined on an error before a zone was picked). */
  renderBlock(spec: CodeblockSpec, el: HTMLElement, sourcePath: string): string | undefined {
    const zones = this.settings.zones;
    const zoneId = this.codeblockZone(spec, sourcePath);
    if (!zoneId) return void renderError(el, "No zones yet — add one in settings.");
    if (!zones.some((z) => z.id === zoneId)) {
      renderError(el, `Unknown zone "${zoneId}" (have: ${zones.map((z) => z.id).join(", ") || "none"}).`);
      return zoneId;
    }
    const adapter = this.time.active;
    const today = adapter?.now()?.dayOrdinal ?? null;
    const { day, error } = resolveDate(spec.date, today, adapter?.parse?.bind(adapter));
    if (day === null) {
      renderError(el, error ?? "bad date");
      return zoneId;
    }
    // a definition world labels days in the Date display format (or the block's format:); other calendars as they write them
    const label = (d: number) => (this.onDefinition() ? this.displayDay(d, spec.format) : (adapter?.format?.(d) ?? `day ${d}`));
    try {
      const u = spec.units ?? this.settings.units;
      if (spec.style === "table") {
        const reports = this.world.getRange(zoneId, day, day + spec.range - 1);
        renderTable(
          el,
          reports.map((r) => ({ label: label(r.dayOrdinal), r })),
          u,
        );
        return zoneId;
      }
      const r = this.world.getReport(zoneId, spec.hour !== undefined ? { dayOrdinal: day, hour: spec.hour } : { dayOrdinal: day });
      if (spec.style === "value") renderValue(el, reportField(convertReport(r, u), spec.field!));
      else if (spec.style === "line") renderLine(el, r, label(day));
      else if (spec.style === "prose") renderProse(el, r, label(day));
      else renderCard(el, r, label(day), u);
      if (spec.interpret) this.renderInterpretations(el, r, spec.interpret);
    } catch (e) {
      renderError(el, e instanceof Error ? e.message : String(e));
    }
    return zoneId;
  }

  /** One line per interpreter under the card/line/prose: its label and its format(result), or compact JSON. */
  private renderInterpretations(el: HTMLElement, r: WeatherReport, ids: readonly string[]): void {
    const box = el.createDiv({ cls: "wadjet-interpret" });
    for (const id of ids) {
      const interpreter = this.controller.interpreters.get(id);
      if (!interpreter) {
        box.createDiv({ cls: "wadjet-error", text: `Unknown interpreter "${id}".` });
        continue;
      }
      try {
        const text = formatInterpretation(interpreter, this.api.interpret(id, r));
        const row = box.createDiv({ cls: "wadjet-interpret-row" });
        row.createSpan({ cls: "wadjet-interpret-label", text: `${interpreter.label}: ` });
        row.appendText(text);
      } catch (e) {
        box.createDiv({ cls: "wadjet-error", text: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // --- commands --------------------------------------------------------------
  private registerCommands(): void {
    const step = async (n: number) => {
      // the user's command: the same step as api.advance, but its day write is the user's (bead wadjet-1ou)
      const moved = await this.controller.moveTo(
        () => {
          const now = this.world.now();
          return now ? now.dayOrdinal + n : null;
        },
        (f) => this.asUser(f),
      );
      if (!moved) return void new Notice("The active calendar can't be changed from here.");
      const now = this.world.now();
      if (now) new Notice(this.onDefinition() ? this.displayDay(now.dayOrdinal) : this.api.format(now.dayOrdinal));
    };
    this.addCommand({ id: "next-day", name: "Advance the calendar one day", callback: () => void step(1) });
    this.addCommand({ id: "prev-day", name: "Rewind the calendar one day", callback: () => void step(-1) });

    this.addCommand({
      id: "insert-today",
      name: "Insert today's weather",
      editorCallback: (editor) => {
        const zone = this.settings.zones[0];
        const now = this.world.now();
        if (!zone || !now) return void new Notice("Add a zone and set the current day first.");
        const r = this.world.getReport(zone.id, { dayOrdinal: now.dayOrdinal });
        editor.replaceSelection(`${this.displayDay(now.dayOrdinal)} — ${this.world.describe(r, "short")}\n`);
      },
    });

    this.addCommand({
      id: "insert-codeblock",
      name: "Insert a weather codeblock",
      editorCallback: (editor) => {
        const zone = this.settings.zones[0]?.id ?? "zone-id";
        editor.replaceSelection("```wadjet\nzone: " + zone + "\ndate: today\nstyle: card\n```\n");
      },
    });

    this.addCommand({
      id: "pin-today",
      name: "Pin today's weather",
      callback: async () => {
        const zone = this.settings.zones[0];
        const now = this.world.now();
        if (!zone || !now) return void new Notice("Add a zone and set the current day first.");
        const r = this.world.getReport(zone.id, { dayOrdinal: now.dayOrdinal });
        this.settings.overrides = this.settings.overrides.filter((o) => !(o.zoneId === zone.id && o.dayOrdinal === now.dayOrdinal));
        this.settings.overrides.push({ zoneId: zone.id, dayOrdinal: now.dayOrdinal, patch: { temperature: { ...r.temperature }, precipitation: { type: r.precipitation.type, amountMm: r.precipitation.amountMm }, wind: { ...r.wind }, note: "pinned" } });
        await this.saveAndRebuild();
        this.refreshSettingsTab();
        new Notice(`Pinned ${zone.name} on ${this.displayDay(now.dayOrdinal)}.`);
      },
    });

    this.addCommand({ id: "open-studio", name: "Open climate studio", callback: () => openStudioFromCommand(this) });

    this.addCommand({
      id: "refresh",
      name: "Refresh weather blocks in this note",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        view?.previewMode?.rerender(true);
      },
    });
  }
}

/**
 * Keeps one code block current. A block without `zone:` re-renders when the
 * zone it resolves to changes (the note's metadata, a zone edit, a resolver
 * registered or removed) or the zone it shows is deleted; a block with
 * `interpret:` re-renders when interpreters come and go. Cleaned up with the
 * block.
 */
class BlockWatcher extends MarkdownRenderChild {
  constructor(
    el: HTMLElement,
    private readonly plugin: WadjetPlugin,
    private readonly spec: CodeblockSpec,
    private readonly sourcePath: string,
    private shown: string | undefined,
  ) {
    super(el);
  }

  /** whether `shown` named an existing zone at the last render (a vanished zone re-renders once, not on every save) */
  private shownExisted = false;

  private zoneExists(id: string | undefined): boolean {
    return id !== undefined && this.plugin.settings.zones.some((z) => z.id === id);
  }

  override onload(): void {
    this.shownExisted = this.zoneExists(this.shown);
    if (!this.plugin.controller.unloaded) {
      this.register(this.plugin.api.on("time-changed", () => this.rerender()));
      this.register(this.plugin.api.on("adapters-changed", () => this.rerender()));
      // its date label follows the Date display setting (bead wadjet-01k.18)
      this.register(this.plugin.onDisplayChanged(() => this.rerender()));
      this.register(
        this.plugin.api.on("profiles-changed", (p) => {
          if (blockRepaintOn("profiles-changed", p, this.shown)) this.rerender();
        }),
      );
    }
    if (this.spec.zone === undefined) {
      this.registerEvent(
        this.plugin.app.metadataCache.on("changed", (file) => {
          if (file.path === this.sourcePath) this.rerenderIfZoneMoved();
        }),
      );
      if (!this.plugin.controller.unloaded) {
        this.register(this.plugin.api.on("profiles-changed", () => this.rerenderIfZoneMoved()));
        this.register(this.plugin.api.on("resolvers-changed", () => this.rerenderIfZoneMoved()));
      }
    }
    if (this.spec.interpret && !this.plugin.controller.unloaded) this.register(this.plugin.api.on("interpreters-changed", () => this.rerender()));
  }

  /** Re-render when the block would now show another zone, or the zone it shows no longer exists. */
  private rerenderIfZoneMoved(): void {
    if (this.plugin.controller.unloaded) return;
    const shownGone = this.shownExisted && !this.zoneExists(this.shown);
    if (shownGone || this.plugin.codeblockZone(this.spec, this.sourcePath) !== this.shown) this.rerender();
  }

  private rerender(): void {
    if (this.plugin.controller.unloaded) return;
    this.containerEl.empty();
    this.shown = this.plugin.renderBlock(this.spec, this.containerEl, this.sourcePath);
    this.shownExisted = this.zoneExists(this.shown);
  }
}
