import { MarkdownView, Notice, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import type { WeatherReport } from "../core/report";
import { GENERATOR_VERSION, RNG_VERSION, SCHEMA_VERSION } from "../core/version";
import { parseCodeblock, resolveDate } from "./codeblock-parse";
import { renderCard, renderError, renderLine, renderProse, renderTable } from "./render";
import { DEFAULT_SETTINGS, generatorMismatch, migrateSettings, type WadjetSettings } from "./settings";
import { WadjetSettingTab } from "./settings-tab";
import { TimeRegistry, type TimeAdapter, type TimeContext } from "./time/adapter";
import { InternalCalendar } from "./time/internal";
import { World, type WorldEvent, type ZoneLocator, type ZoneResolver } from "./world";

/**
 * Public API (DESIGN-v1.md §9). Reachable as `app.plugins.plugins.wadjet.api`
 * and `window.Wadjet`. All returned values are plain serialisable objects.
 *
 * Load order: check `api.ready`; if false, wait for the `wadjet:ready`
 * workspace event (fired once after settings and zones are loaded).
 */
export interface WadjetAPI {
  version: string;
  ready: boolean;
  schemaVersion: typeof SCHEMA_VERSION;
  generatorVersion: typeof GENERATOR_VERSION;
  rngVersion: typeof RNG_VERSION;

  getReport(zoneId: string, time: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport;
  getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[];
  now(): TimeContext | null;
  listZones(): Array<{ id: string; name: string }>;

  registerTimeAdapter(adapter: TimeAdapter): () => void;
  registerZoneResolver(resolver: ZoneResolver): () => void;
  resolveZone(locator: ZoneLocator): string | null;

  describe(report: WeatherReport, style?: "short" | "prose"): string;
  on(event: WorldEvent, cb: () => void): () => void;
}

type WindowWithWadjet = Window & { Wadjet?: WadjetAPI };

export default class WadjetPlugin extends Plugin {
  override settings: WadjetSettings = DEFAULT_SETTINGS;
  time!: TimeRegistry;
  internalCalendar!: InternalCalendar;
  world!: World;
  api!: WadjetAPI;
  settingTab!: WadjetSettingTab;

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.time = new TimeRegistry(this.settings.activeTimeAdapter);
    this.internalCalendar = new InternalCalendar(this.settings.calendar, () => this.settings.currentDayOrdinal);
    this.time.register(this.internalCalendar);
    this.world = new World(this.worldState(), this.time);

    this.api = this.buildApi();
    (window as WindowWithWadjet).Wadjet = this.api;

    this.settingTab = new WadjetSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerMarkdownCodeBlockProcessor("wadjet", (src, el, ctx) => this.renderCodeblock(src, el, ctx));
    this.registerCommands();

    if (generatorMismatch(this.settings)) {
      new Notice(`The weather generator was updated (${this.settings.generatorVersion} → ${GENERATOR_VERSION}). Past weather stays as it was until you upgrade the world in settings.`, 10000);
    }

    await this.saveData(this.settings); // persist a freshly generated seed
    this.api.ready = true;
    this.world.emit("ready");
    this.app.workspace.trigger("wadjet:ready");
  }

  override onunload(): void {
    delete (window as WindowWithWadjet).Wadjet;
  }

  private worldState() {
    const s = this.settings;
    return { seed: s.worldSeed, zones: s.zones, eras: s.eras, overrides: s.overrides, ...(s.bands ? { bands: s.bands } : {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Save and push the new state into the world (rebuilds generators lazily). */
  async saveAndRebuild(): Promise<void> {
    await this.saveSettings();
    this.internalCalendar.update(this.settings.calendar);
    this.world.setState(this.worldState());
  }

  /** Re-render the settings tab if it is showing — commands change state it displays. */
  refreshSettingsTab(): void {
    const setting = (this.app as unknown as { setting?: { activeTab?: unknown } }).setting;
    if (setting?.activeTab === this.settingTab) this.settingTab.update();
  }

  private buildApi(): WadjetAPI {
    const w = this.world;
    return {
      version: this.manifest.version,
      ready: false,
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      rngVersion: RNG_VERSION,
      getReport: (zoneId, time) => w.getReport(zoneId, time),
      getRange: (zoneId, from, to) => w.getRange(zoneId, from, to),
      now: () => w.now(),
      listZones: () => w.listZones().map(({ id, name }) => ({ id, name })),
      registerTimeAdapter: (a) => {
        const off = this.time.register(a);
        if (this.settings.activeTimeAdapter === a.id) w.emit("time-changed");
        this.refreshSettingsTab(); // the "Calendar source" row lists registered adapters
        return off;
      },
      registerZoneResolver: (r) => w.registerZoneResolver(r),
      resolveZone: (l) => w.resolveZone(l),
      describe: (r, style) => w.describe(r, style),
      on: (event, cb) => w.on(event, cb),
    };
  }

  // --- codeblock -----------------------------------------------------------
  private renderCodeblock(src: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    const spec = parseCodeblock(src);
    if (spec.errors.length) return renderError(el, spec.errors.join("; "));
    const zones = this.settings.zones;
    const zoneId = spec.zone ?? zones[0]?.id;
    if (!zoneId) return renderError(el, "No zones yet — add one in settings.");
    if (!zones.some((z) => z.id === zoneId)) return renderError(el, `Unknown zone "${zoneId}" (have: ${zones.map((z) => z.id).join(", ") || "none"}).`);
    const adapter = this.time.active;
    const today = adapter?.now()?.dayOrdinal ?? null;
    const { day, error } = resolveDate(spec.date, today, adapter?.parse?.bind(adapter));
    if (day === null) return renderError(el, error ?? "bad date");
    const label = (d: number) => adapter?.format?.(d) ?? `day ${d}`;
    try {
      const u = this.settings.units;
      if (spec.style === "table") {
        const reports = this.world.getRange(zoneId, day, day + spec.range - 1);
        return renderTable(
          el,
          reports.map((r) => ({ label: label(r.dayOrdinal), r })),
          u,
        );
      }
      const r = this.world.getReport(zoneId, spec.hour !== undefined ? { dayOrdinal: day, hour: spec.hour } : { dayOrdinal: day });
      if (spec.style === "line") return renderLine(el, r, label(day));
      if (spec.style === "prose") return renderProse(el, r, label(day));
      return renderCard(el, r, label(day), u);
    } catch (e) {
      return renderError(el, e instanceof Error ? e.message : String(e));
    }
  }

  // --- commands --------------------------------------------------------------
  private registerCommands(): void {
    const bump = async (n: number) => {
      this.settings.currentDayOrdinal += n;
      await this.saveSettings();
      this.world.emit("time-changed");
      this.refreshSettingsTab();
      new Notice(this.internalCalendar.format(this.settings.currentDayOrdinal));
    };
    this.addCommand({ id: "next-day", name: "Advance the calendar one day", callback: () => void bump(1) });
    this.addCommand({ id: "prev-day", name: "Rewind the calendar one day", callback: () => void bump(-1) });

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
