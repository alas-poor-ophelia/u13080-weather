import { MarkdownRenderChild, MarkdownView, Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import type { StudioStash } from "../studio/model/stash";
import { openStudioFromCommand } from "../studio/ui/open";
import { StudioView, VIEW_TYPE as STUDIO_VIEW_TYPE } from "../studio/ui/view";
import type { WeatherReport } from "../core/report";
import { GENERATOR_VERSION } from "../core/version";
import { ApiController, type WadjetAPI } from "./api";
import { parseCodeblock, pickCodeblockZone, resolveDate, type CodeblockSpec } from "./codeblock-parse";
import { frontmatterResolver } from "./frontmatter-resolver";
import { formatInterpretation } from "./interpreters";
import { SaveQueue, setAndSave } from "./persist";
import { renderCard, renderError, renderLine, renderProse, renderTable, renderValue } from "./render";
import { convertReport, reportField } from "../core/units";
import { DEFAULT_SETTINGS, generatorMismatch, migrateSettings, type WadjetSettings } from "./settings";
import { WadjetSettingTab } from "./settings-tab";
import { TimeRegistry } from "./time/adapter";
import { InternalCalendar } from "./time/internal";
import { World } from "./world";

export type { WadjetAPI } from "./api";

type WindowWithWadjet = Window & { Wadjet?: WadjetAPI };

export default class WadjetPlugin extends Plugin {
  override settings: WadjetSettings = DEFAULT_SETTINGS;
  time!: TimeRegistry;
  internalCalendar!: InternalCalendar;
  world!: World;
  api!: WadjetAPI;
  controller!: ApiController;
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
  /** the internal calendar's configHash at the last rebuild, to tell a calendar edit from any other save */
  private internalHash = "";
  /** Every saveData goes through here: one write at a time, each writing the settings as they are when it starts. */
  private readonly saves = new SaveQueue(
    (data) => this.saveData(data),
    () => this.settings,
    () => !this.dead,
  );

  override async onload(): Promise<void> {
    const loaded: unknown = await this.loadData();
    if (this.dead) return;
    this.settings = migrateSettings(loaded);
    this.time = new TimeRegistry(this.settings.activeTimeAdapter);
    this.internalCalendar = new InternalCalendar(
      this.settings.calendar,
      () => this.settings.currentDayOrdinal,
      (d) => this.writeCurrentDay(d),
    );
    this.internalHash = this.internalCalendar.configHash();
    this.time.register(this.internalCalendar);
    this.world = new World(this.worldState(), this.time);
    this.controller = new ApiController({ version: this.manifest.version, world: this.world, time: this.time, units: () => this.settings.units });
    this.api = this.controller.api;
    this.time.onChange((change) => {
      if (this.dead) return;
      this.controller.syncActiveSubscription();
      if (change.id === this.settings.activeTimeAdapter) this.controller.emitTimeChanged();
      this.world.emit("adapters-changed");
      this.refreshSettingsTab(); // the "Calendar source" row lists registered adapters
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

    if (generatorMismatch(this.settings)) {
      new Notice(`The weather generator was updated (${this.settings.generatorVersion} → ${GENERATOR_VERSION}). Only the current generator ships, so past weather may differ from what you saw before. Pinned days are kept. You can acknowledge the change in settings.`, 10000);
    }

    await this.saveSettings(); // persist a freshly generated seed
    if (this.dead) return;
    this.controller.markReady();
    this.app.workspace.trigger("wadjet:ready");
  }

  override onunload(): void {
    this.dead = true;
    this.controller?.unload(() => this.app.workspace.trigger("wadjet:unload"));
    delete (window as WindowWithWadjet).Wadjet;
  }

  private worldState() {
    const s = this.settings;
    return { seed: s.worldSeed, zones: s.zones, eras: s.eras, overrides: s.overrides, ...(s.bands ? { bands: s.bands } : {}) };
  }

  /** Save settings to data.json (serialised with every other save); does nothing once the plugin is unloaded. */
  async saveSettings(): Promise<void> {
    if (this.dead) return;
    await this.saves.save();
  }

  /** Save and push the new state into the world (rebuilds generators lazily). */
  async saveAndRebuild(): Promise<void> {
    await this.saveSettings();
    if (this.dead) return;
    this.internalCalendar.update(this.settings.calendar);
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
   */
  private async writeCurrentDay(d: number): Promise<void> {
    if (this.dead) throw new Error("U+13080 Weather is unloaded.");
    await setAndSave(
      () => this.settings.currentDayOrdinal,
      (v) => (this.settings.currentDayOrdinal = v),
      d,
      () => this.saveSettings(),
    );
    if (this.dead) return;
    this.refreshSettingsTab();
  }

  /** The settings tab's "Current day" edit: the internal calendar's day, whichever calendar is active, through the same queue as `api.setNow`. */
  setInternalDay(d: number): Promise<void> {
    return this.controller.enqueue(async () => {
      if (this.dead) return;
      await this.internalCalendar.setNow(d);
    });
  }

  /** The settings tab's "Calendar source" choice. Fires time-changed and adapters-changed when the effective calendar changes. */
  async setActiveTimeAdapter(id: string): Promise<void> {
    const before = this.time.active;
    this.settings.activeTimeAdapter = id;
    this.time.setActive(id);
    this.controller.syncActiveSubscription();
    if (this.time.active !== before) {
      this.controller.emitTimeChanged();
      this.world.emit("adapters-changed");
    }
    await this.saveSettings();
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
    // Re-render when the answer can change under the block: a zone from the
    // note's frontmatter, or interpreters registered after the note rendered.
    if (spec.zone === undefined || spec.interpret) ctx.addChild(new BlockWatcher(el, this, spec, ctx.sourcePath, shown));
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
    const label = (d: number) => adapter?.format?.(d) ?? `day ${d}`;
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
      const moved = await this.api.advance(n);
      if (!moved) return void new Notice("The active calendar can't be changed from here.");
      const now = this.world.now();
      if (now) new Notice(this.api.format(now.dayOrdinal));
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
        editor.replaceSelection(`${this.internalCalendar.format(now.dayOrdinal)} — ${this.world.describe(r, "short")}\n`);
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
        new Notice(`Pinned ${zone.name} on ${this.internalCalendar.format(now.dayOrdinal)}.`);
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
