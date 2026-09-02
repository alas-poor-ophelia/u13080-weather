/**
 * Settings tab on the Obsidian 1.13 declarative API (getSettingDefinitions +
 * getControlValue / setControlValue). Structural changes (zones, pins) go
 * through modals that call `update()` on the tab when they save.
 */
import { Modal, Notice, PluginSettingTab, Setting, type App, type DropdownComponent, type SettingDefinitionItem, type SettingGroupItem, type TextComponent } from "obsidian";
import { validateEras } from "../core/eras";
import { koppenOfClimate } from "../core/koppen";
import { validateProfile } from "../core/profile";
import type { Override, OverridePatch } from "../core/report";
import { withMinus } from "../core/report";
import type { PrecipType } from "../core/generator";
import type { Era, Geography, Orographic, ZoneProfile } from "../core/types";
import { GENERATOR_VERSION } from "../core/version";
import { PRESETS } from "../generated/presets";
import { openStudio } from "../studio/ui/open";
import { calendarSummary } from "./calendar-summary";
import { badMoonsLine, parseMoonsText, serialiseMoonsText } from "./calendar-text";
import type WadjetPlugin from "./main";
import { generatedPatch } from "./pins";
import { parseJsonLenient } from "./json-lenient";
import { MODIFIER_EXAMPLES, MODIFIER_GRAMMAR } from "./modifier-examples";
import { generatorMismatch } from "./settings";
import { uniqueId, zoneFromGeography, zoneFromPreset } from "./zones";

const MAIN_PRESETS = PRESETS.filter((p) => !(p as { alternate?: boolean }).alternate);
const PRESET_OPTIONS = Object.fromEntries(MAIN_PRESETS.map((p) => [p.id, `${p.name} — ${p.match.koppen}, ${p.source.stationName}`]));
const PRECIP_OPTIONS: Record<PrecipType, string> = { none: "None", drizzle: "Drizzle", rain: "Rain", sleet: "Sleet", snow: "Snow" };
const OROGRAPHIC_OPTIONS: Record<Orographic, string> = { none: "Open ground", windward: "Windward slope", leeward: "Leeward (rain shadow)" };

function presetName(id: string): string {
  return PRESETS.find((p) => p.id === id)?.name ?? id;
}

export class WadjetSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: WadjetPlugin,
  ) {
    super(app, plugin);
  }

  private saveAndRefresh(rebuild: boolean): void {
    void (rebuild ? this.plugin.saveAndRebuild() : this.plugin.saveSettings()).then(() => this.update());
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const cal = this.plugin.internalCalendar;
    const adapters = this.plugin.time.list();
    // The resolved active adapter (not the raw `activeTimeAdapter` setting): TimeRegistry.active
    // falls back to "internal" once the setting names an adapter that has since unregistered, so
    // this is the source of truth for "is the internal calendar in charge right now".
    const activeAdapter = this.plugin.time.active;
    const activeIsInternal = activeAdapter === undefined || activeAdapter.id === "internal";
    const activeDescription = activeIsInternal ? undefined : activeAdapter?.describe?.();

    return [
      {
        type: "group",
        heading: "World",
        items: [
          {
            name: "World seed",
            desc: "Changing it changes every day's weather in every zone. Pinned days are kept.",
            control: { type: "text", key: "worldSeed", validate: (v) => (v.trim() ? undefined : "The seed can't be empty.") },
          },
          {
            name: "Generator",
            desc: `This world uses ${s.generatorVersion}. The plugin now ships ${GENERATOR_VERSION}; upgrading changes past weather. Pinned days are kept.`,
            visible: () => generatorMismatch(this.plugin.settings),
            render: (setting) => {
              setting.addButton((b) =>
                b
                  .setButtonText("Upgrade")
                  .setDestructive()
                  .onClick(() => {
                    this.plugin.settings.generatorVersion = GENERATOR_VERSION;
                    new Notice("Generator upgraded. Past weather has changed.");
                    this.saveAndRefresh(true);
                  }),
              );
            },
          },
          {
            name: "Units",
            control: { type: "dropdown", key: "units", options: { metric: "Metric (°C, mm, km/h)", imperial: "Imperial (°F, in, mph)" } },
          },
        ],
      },
      {
        type: "group",
        heading: "Calendar",
        items: [
          {
            name: "Calendar source",
            desc: "The internal calendar is always available. Other calendars appear here when their plugins register.",
            visible: () => adapters.length > 1,
            control: { type: "dropdown", key: "activeTimeAdapter", options: Object.fromEntries(adapters.map((a) => [a, a])) },
          },
          {
            name: "Current day",
            desc: `Day number, counted from the first day of year ${s.calendar.epochYear}. Now: ${cal.format(s.currentDayOrdinal)}.`,
            control: { type: "number", key: "currentDayOrdinal", step: 1, validate: (v) => (Number.isInteger(v) ? undefined : "Whole days only.") },
          },
          {
            name: "Days in a year",
            desc: "Changing it moves the seasons, so every day's weather changes.",
            control: { type: "number", key: "calendar.yearLength", min: 1, step: 1, validate: (v) => (Number.isInteger(v) && v >= 1 ? undefined : "At least one day.") },
          },
          {
            name: "Moons",
            desc: "One per line: name, cycle in days, phase at day 0 (0–1), then optionally named phases as name@fraction (e.g. Full@0.5), ascending and unique. Only modifiers that mention a moon use them.",
            visible: () => this.plugin.time.active?.id === "internal",
            control: { type: "textarea", key: "moons", rows: 3, placeholder: "Moon, 29.53, 0, New@0, Full@0.5", validate: badMoonsLine },
          },
          {
            name: "Seasons",
            desc: "One per line: name, start (0–1 through the year). Each becomes a season tag that modifiers can match.",
            visible: () => this.plugin.time.active?.id === "internal",
            control: { type: "textarea", key: "seasons", rows: 3, placeholder: "Spring, 0.2", validate: (t) => badLine(t, 1) },
          },
          {
            name: `${activeDescription?.label ?? activeAdapter?.id ?? ""} · read-only`,
            desc: activeDescription ? calendarSummary(activeDescription) : "",
            visible: () => !!this.plugin.time.active && this.plugin.time.active.id !== "internal" && !!this.plugin.time.active.describe,
          },
          {
            name: `Calendar from ${activeAdapter?.id ?? ""}`,
            desc: "This calendar does not describe its seasons or moons.",
            visible: () => !!this.plugin.time.active && this.plugin.time.active.id !== "internal" && !this.plugin.time.active.describe,
          },
          {
            name: "Eras",
            desc: "The world's long history as JSON: a list of { name, from, to, apply }. Years are inclusive; leave out \"to\" for open-ended. Every day in an era carries the tag era:<name>, and \"apply\" (optional, the same ops as a modifier) bends every zone for the era's span. Comments are fine. Changing eras changes past weather.",
            control: { type: "textarea", key: "eras", rows: 6, placeholder: ERAS_PLACEHOLDER, validate: badEras },
          },
        ],
      },
      {
        type: "list",
        heading: "Zones",
        emptyState: "No zones yet. A zone is a climate; notes and map locations point at a zone.",
        addItem: { name: "Add zone", action: () => new AddZoneModal(this.app, this.plugin, () => this.update()).open() },
        onDelete: (index) => {
          s.zones.splice(index, 1);
          this.saveAndRefresh(true);
        },
        items: s.zones.map((z) => this.zoneRow(z)),
      },
      {
        type: "list",
        heading: "Pinned days",
        emptyState: "No pinned days. Pin one here or with the “Pin today's weather” command. Pinned days always win over generated weather.",
        addItem: { name: "Pin a day", action: () => new PinModal(this.app, this.plugin, null, () => this.update()).open() },
        onDelete: (index) => {
          s.overrides.splice(index, 1);
          this.saveAndRefresh(true);
        },
        items: s.overrides.map((o) => this.pinRow(o)),
      },
    ];
  }

  private zoneRow(z: ZoneProfile): SettingGroupItem {
    const issues = validateProfile(z);
    const errs = issues.filter((i) => i.level === "error").length;
    const warns = issues.filter((i) => i.level === "warning").length;
    const parts = [z.id];
    if (!errs) {
      const k = koppenOfClimate(z.climate);
      parts.push(`${k.code} ${k.description}`);
    }
    parts.push(z.preset ? `from ${presetName(z.preset.id)}` : "custom profile");
    if (errs) parts.push(`${errs} error${errs === 1 ? "" : "s"}`);
    if (warns) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
    return {
      name: z.name,
      desc: parts.join(" · "),
      render: (setting) => {
        // The row is rebuilt on every update(), so nothing here may be cached
        // across renders — `z` is the profile this render was handed.
        setting.addButton((b) => b.setButtonText("Open in studio").onClick(() => void openStudio(this.plugin, z.id)));
        setting.addButton((b) =>
          b.setButtonText("Edit").onClick(() => {
            new ZoneJsonModal(this.app, z, async (updated) => {
              const zones = this.plugin.settings.zones;
              const i = zones.findIndex((x) => x.id === z.id);
              if (i >= 0) zones[i] = updated;
              await this.plugin.saveAndRebuild();
              this.update();
            }).open();
          }),
        );
      },
    };
  }

  private pinRow(o: Override): SettingGroupItem {
    const zone = this.plugin.settings.zones.find((z) => z.id === o.zoneId);
    return {
      name: `${zone?.name ?? o.zoneId} · ${this.plugin.internalCalendar.format(o.dayOrdinal)}`,
      desc: summarisePatch(o.patch, this.plugin.settings.units),
      render: (setting) => {
        setting.addButton((b) => b.setButtonText("Edit").onClick(() => new PinModal(this.app, this.plugin, o, () => this.update()).open()));
      },
    };
  }

  // --- control bindings ----------------------------------------------------
  override getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case "worldSeed":
      case "units":
      case "activeTimeAdapter":
      case "currentDayOrdinal":
        return s[key];
      case "calendar.yearLength":
        return s.calendar.yearLength;
      case "moons":
        return serialiseMoonsText(s.calendar.moons);
      case "seasons":
        return s.calendar.seasons.map((x) => `${x.name}, ${x.from}`).join("\n");
      case "eras":
        return s.eras.length ? JSON.stringify(s.eras, null, 2) : "";
      default:
        return undefined;
    }
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case "worldSeed":
        s.worldSeed = String(value).trim();
        return this.plugin.saveAndRebuild();
      case "units":
        s.units = value as "metric" | "imperial";
        await this.plugin.saveSettings();
        this.update(); // pin summaries are shown in the chosen units
        return;
      case "activeTimeAdapter":
        s.activeTimeAdapter = String(value);
        this.plugin.time.setActive(s.activeTimeAdapter);
        await this.plugin.saveAndRebuild();
        this.update(); // Moons/Seasons visibility and the read-only calendar row depend on the active adapter
        return;
      case "currentDayOrdinal":
        s.currentDayOrdinal = Number(value);
        await this.plugin.saveSettings();
        this.plugin.world.emit("time-changed");
        return;
      case "calendar.yearLength":
        s.calendar.yearLength = Number(value);
        return this.plugin.saveAndRebuild();
      case "moons":
        s.calendar.moons = parseMoonsText(String(value));
        return this.plugin.saveAndRebuild();
      case "seasons":
        s.calendar.seasons = lines(String(value))
          .filter((p) => p.length >= 2 && p[0])
          .map((p) => ({ name: p[0]!, from: Math.min(0.999, Math.max(0, Number(p[1]) || 0)) }));
        return this.plugin.saveAndRebuild();
      case "eras": {
        const text = String(value).trim();
        if (badEras(text)) return; // the row shows the error; the stored timeline stands
        s.eras = text ? parseJsonLenient<Era[]>(text) : [];
        return this.plugin.saveAndRebuild();
      }
      default:
        return;
    }
  }
}

const ERAS_PLACEHOLDER = '[ { "name": "Ice Age", "from": 1200, "to": 1900, "apply": [ { "param": "temperature.mean", "op": "offset", "value": -6 } ] } ]';

/** Validation for the Eras JSON textarea: the first error, or nothing. Empty is fine. */
function badEras(text: string): string | undefined {
  if (!text.trim()) return undefined;
  let eras: unknown;
  try {
    eras = parseJsonLenient(text);
  } catch (e) {
    return `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const err = validateEras(eras).find((i) => i.level === "error");
  return err ? `${err.path}: ${err.message}` : undefined;
}

function lines(text: string): string[][] {
  return text.split(/\r?\n/).map((l) => l.split(",").map((x) => x.trim()));
}

/** Validation for the "name, number[, number]" textareas: the first bad line, or nothing. */
function badLine(text: string, numbers: number): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const p = raw.split(",").map((x) => x.trim());
    if (!p[0] || p.length < 2 || p.slice(1, 1 + numbers).some((x) => !Number.isFinite(Number(x)) || x === "")) return `Can't read "${raw.trim()}" — expected a name and ${numbers === 1 ? "a number" : "numbers"}, separated by commas.`;
  }
  return undefined;
}

// --- display units ---------------------------------------------------------
// Pins are stored in metric; the editor and summaries speak the chosen units.
type Units = "metric" | "imperial";
const UNIT_LABEL: Record<Units, { temp: string; amount: string; speed: string }> = {
  metric: { temp: "°C", amount: "mm", speed: "km/h" },
  imperial: { temp: "°F", amount: "in", speed: "mph" },
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const cToUnit = (c: number, u: Units) => (u === "imperial" ? r1((c * 9) / 5 + 32) : c);
const unitToC = (x: number, u: Units) => (u === "imperial" ? r1(((x - 32) * 5) / 9) : x);
const mmToUnit = (mm: number, u: Units) => (u === "imperial" ? Math.round((mm / 25.4) * 100) / 100 : mm);
const unitToMm = (x: number, u: Units) => (u === "imperial" ? r1(x * 25.4) : x);
const kphToUnit = (k: number, u: Units) => (u === "imperial" ? Math.round(k / 1.609) : k);
const unitToKph = (x: number, u: Units) => (u === "imperial" ? Math.round(x * 1.609) : x);

function summarisePatch(p: OverridePatch, u: Units): string {
  const parts: string[] = [];
  const L = UNIT_LABEL[u];
  const t = p.temperature;
  if (t?.low !== undefined && t?.high !== undefined) parts.push(`${withMinus(cToUnit(t.low, u))} to ${withMinus(cToUnit(t.high, u))} ${L.temp}`);
  const pr = p.precipitation;
  if (pr?.type) parts.push(pr.type === "none" ? "dry" : `${pr.type}${pr.amountMm !== undefined ? ` ${mmToUnit(pr.amountMm, u)} ${L.amount}` : ""}`);
  const w = p.wind;
  if (w?.speedKph !== undefined) parts.push(w.speedKph === 0 ? "calm" : `${kphToUnit(w.speedKph, u)} ${L.speed}`);
  if (p.note) parts.push(p.note);
  return parts.join(" · ") || "no changes";
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export class AddZoneModal extends Modal {
  constructor(
    app: App,
    private plugin: WadjetPlugin,
    private onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Add zone");
    let name = "";
    let presetId = MAIN_PRESETS[0]?.id ?? "";
    let byGeography = false;
    let scaleSwing = false;
    let continentality = 0.5;
    const geo: Geography = { latitude: 45, altitude: 200, orographic: "none" };

    const nameRow = new Setting(contentEl).setName("Name").addText((t) => t.setPlaceholder("Greywold highlands").onChange((v) => (name = v)));
    new Setting(contentEl).setName("Choose by geography").setDesc("Describe the place and the nearest climate is picked and adjusted for you.").addToggle((t) =>
      t.setValue(byGeography).onChange((v) => {
        byGeography = v;
        show();
      }),
    );
    const presetRow = new Setting(contentEl).setName("Climate").addDropdown((d) => d.addOptions(PRESET_OPTIONS).setValue(presetId).onChange((v) => (presetId = v)));
    const latRow = new Setting(contentEl)
      .setName("Latitude")
      .setDesc("Degrees; negative for the southern hemisphere.")
      .addText((t) => t.setValue(String(geo.latitude)).onChange((v) => (geo.latitude = Number(v) || 0)));
    const altRow = new Setting(contentEl)
      .setName("Altitude")
      .setDesc("Metres above sea level.")
      .addText((t) => t.setValue(String(geo.altitude)).onChange((v) => (geo.altitude = Number(v) || 0)));
    const oroRow = new Setting(contentEl).setName("Terrain").addDropdown((d) => d.addOptions(OROGRAPHIC_OPTIONS).setValue(geo.orographic).onChange((v) => (geo.orographic = v as Orographic)));
    const swingRow = new Setting(contentEl)
      .setName("Adjust the seasonal swing")
      .setDesc("Off keeps the matched climate's own swing between summer and winter.")
      .addToggle((t) =>
        t.setValue(scaleSwing).onChange((v) => {
          scaleSwing = v;
          show();
        }),
      );
    const contRow = new Setting(contentEl)
      .setName("Continentality")
      .setDesc("Coastal is 0, deep interior is 1.")
      .addSlider((sl) => sl.setLimits(0, 1, 0.05).setValue(continentality).onChange((v) => (continentality = v)));

    const show = () => {
      presetRow.settingEl.toggle(!byGeography);
      for (const r of [latRow, altRow, oroRow, swingRow]) r.settingEl.toggle(byGeography);
      contRow.settingEl.toggle(byGeography && scaleSwing);
    };
    show();

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Add")
        .setCta()
        .onClick(async () => {
          const s = this.plugin.settings;
          if (!name.trim()) {
            nameRow.setErrorMessage("Give the zone a name.");
            return;
          }
          const ids = new Set(s.zones.map((z) => z.id));
          const geography: Geography = scaleSwing ? { ...geo, continentality } : geo;
          const result = byGeography ? zoneFromGeography(name.trim(), geography, PRESETS, ids) : zoneFromPreset({ name: name.trim(), preset: MAIN_PRESETS.find((p) => p.id === presetId)!, existingIds: ids });
          s.zones.push(result.zone);
          await this.plugin.saveAndRebuild();
          new Notice(result.provenance, 8000);
          this.close();
          this.onDone();
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class PinModal extends Modal {
  constructor(
    app: App,
    private plugin: WadjetPlugin,
    private existing: Override | null,
    private onDone: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const s = this.plugin.settings;
    const cal = this.plugin.internalCalendar;
    const isNew = this.existing === null;
    this.setTitle(isNew ? "Pin a day" : "Edit pinned day");

    if (!s.zones.length) {
      contentEl.createEl("p", { text: "Add a zone first." });
      return;
    }

    let zoneId = this.existing?.zoneId ?? s.zones[0]!.id;
    let dayOrdinal = this.existing?.dayOrdinal ?? this.plugin.world.now()?.dayOrdinal ?? s.currentDayOrdinal;

    // Start from the generated weather so the user edits real values rather than blanks.
    // For a new pin the fields follow the chosen zone/day until the user edits them.
    let seed: OverridePatch = this.existing?.patch ?? generatedPatchFor(this.plugin, zoneId, dayOrdinal);
    // `v` holds the fields in the chosen display units; the stored patch is always metric.
    const u = s.units;
    const L = UNIT_LABEL[u];
    const v = { low: 10, high: 20, type: "none" as PrecipType, amountMm: 0, speedKph: 0, directionDeg: 0, note: "" };
    // Fields the user actually typed in. Untouched fields keep the seed's exact metric value on
    // save, so a display rounding (4 mm → 0.16 in) never drifts the stored pin (→ 4.1 mm).
    const touched = new Set<keyof typeof v>();
    const fields: Array<{ text: TextComponent; get: () => string }> = [];
    const loadFromSeed = () => {
      touched.clear();
      v.low = cToUnit(seed.temperature?.low ?? 10, u);
      v.high = cToUnit(seed.temperature?.high ?? 20, u);
      v.type = seed.precipitation?.type ?? "none";
      v.amountMm = mmToUnit(seed.precipitation?.amountMm ?? 0, u);
      v.speedKph = kphToUnit(seed.wind?.speedKph ?? 0, u);
      v.directionDeg = seed.wind?.directionDeg ?? 0;
      v.note = seed.note ?? "";
      for (const f of fields) f.text.setValue(f.get());
      precip?.setValue(v.type);
    };
    let precip: DropdownComponent | undefined;
    let dayRow: Setting | undefined;
    const reseed = () => {
      seed = generatedPatchFor(this.plugin, zoneId, dayOrdinal);
      loadFromSeed();
    };

    if (isNew) {
      new Setting(contentEl).setName("Zone").addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(s.zones.map((z) => [z.id, z.name])))
          .setValue(zoneId)
          .onChange((x) => {
            zoneId = x;
            reseed();
          }),
      );
      dayRow = new Setting(contentEl)
        .setName("Day")
        .setDesc(`Day number. Today is ${dayOrdinal} (${cal.format(dayOrdinal)}).`)
        .addText((t) =>
          t.setValue(String(dayOrdinal)).onChange((x) => {
            const n = Number(x);
            if (!Number.isInteger(n)) return;
            dayOrdinal = n;
            reseed();
          }),
        );
    } else {
      contentEl.createEl("p", { cls: "setting-item-description", text: `${s.zones.find((z) => z.id === zoneId)?.name ?? zoneId} · ${cal.format(dayOrdinal)}` });
    }

    type NumKey = "low" | "high" | "amountMm" | "speedKph" | "directionDeg";
    const num = (name: string, desc: string, key: NumKey) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          fields.push({ text: t, get: () => String(v[key]) });
          t.onChange((x) => {
            v[key] = Number(x);
            touched.add(key);
          });
        });

    const tempRow = num("Low temperature", L.temp, "low");
    num("High temperature", L.temp, "high");
    new Setting(contentEl).setName("Precipitation").addDropdown((d) => {
      precip = d.addOptions(PRECIP_OPTIONS).onChange((x) => (v.type = x as PrecipType));
    });
    const amountRow = num("Amount", `${L.amount} over the day`, "amountMm");
    const windRow = num("Wind speed", `${L.speed}; 0 is calm`, "speedKph");
    const dirRow = num("Wind direction", "Degrees the wind blows from; 0 is north, 90 is east", "directionDeg");
    new Setting(contentEl).setName("Note").addText((t) => {
      fields.push({ text: t, get: () => v.note });
      t.onChange((x) => (v.note = x));
    });
    loadFromSeed();

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(isNew ? "Pin" : "Save")
        .setCta()
        .onClick(async () => {
          for (const r of [tempRow, amountRow, windRow, dirRow, dayRow]) r?.setErrorMessage(null);
          if (isNew && s.overrides.some((o) => o.zoneId === zoneId && o.dayOrdinal === dayOrdinal)) return void dayRow?.setErrorMessage("That day is already pinned for this zone — edit it from the list.");
          if (![v.low, v.high, v.amountMm, v.speedKph, v.directionDeg].every(Number.isFinite)) return void tempRow.setErrorMessage("Every field needs a number.");
          if (v.low > v.high) return void tempRow.setErrorMessage("The low can't be above the high.");
          if (v.type !== "none" && v.amountMm < 0) return void amountRow.setErrorMessage("Can't be negative.");
          if (v.speedKph < 0) return void windRow.setErrorMessage("Can't be negative.");
          if (v.directionDeg < 0 || v.directionDeg >= 360) return void dirRow.setErrorMessage("0–359.");
          // untouched fields keep the seed's exact metric value (see `touched`)
          const low = touched.has("low") ? unitToC(v.low, u) : (seed.temperature?.low ?? unitToC(v.low, u));
          const high = touched.has("high") ? unitToC(v.high, u) : (seed.temperature?.high ?? unitToC(v.high, u));
          const storedMm = touched.has("amountMm") ? unitToMm(v.amountMm, u) : (seed.precipitation?.amountMm ?? unitToMm(v.amountMm, u));
          const amountMm = v.type === "none" ? 0 : storedMm;
          const speedKph = touched.has("speedKph") ? unitToKph(v.speedKph, u) : (seed.wind?.speedKph ?? unitToKph(v.speedKph, u));
          const patch: OverridePatch = {
            ...seed,
            temperature: { ...seed.temperature, low, high, mean: r1((low + high) / 2) },
            precipitation: { ...seed.precipitation, type: v.type, amountMm },
            wind: { ...seed.wind, speedKph, directionDeg: v.directionDeg },
            ...(v.note.trim() ? { note: v.note.trim() } : {}),
          };
          if (!v.note.trim()) delete patch.note;
          s.overrides = s.overrides.filter((o) => !(o.zoneId === zoneId && o.dayOrdinal === dayOrdinal));
          s.overrides.push({ zoneId, dayOrdinal, patch });
          await this.plugin.saveAndRebuild();
          this.close();
          this.onDone();
        }),
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** `generatedPatch` for a day this world can roll; `{}` when it cannot (unknown zone, invalid profile). */
function generatedPatchFor(plugin: WadjetPlugin, zoneId: string, dayOrdinal: number): OverridePatch {
  try {
    return generatedPatch(plugin.world.getReport(zoneId, { dayOrdinal }));
  } catch {
    return {};
  }
}

class ZoneJsonModal extends Modal {
  constructor(
    app: App,
    private zone: ZoneProfile,
    private onSave: (z: ZoneProfile) => Promise<void>,
  ) {
    super(app);
  }
  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.zone.name);
    contentEl.createEl("p", { cls: "setting-item-description", text: "The zone's full profile as JSON (// comments and trailing commas are fine). Errors block saving; warnings are reported." });
    const ta = contentEl.createEl("textarea", { cls: "wadjet-json" });
    ta.rows = 24;
    ta.value = JSON.stringify(this.zone, null, 2);
    const msg = contentEl.createDiv({ cls: "wadjet-error" });
    this.renderGrammar(contentEl, ta, msg);
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          try {
            const parsed = parseJsonLenient<ZoneProfile>(ta.value);
            parsed.id = this.zone.id; // id is immutable (pins key on it)
            const issues = validateProfile(parsed);
            const errs = issues.filter((i) => i.level === "error");
            if (errs.length) {
              msg.setText(errs.map((e) => `${e.path}: ${e.message}`).join("\n"));
              return;
            }
            await this.onSave(parsed);
            const warns = issues.filter((i) => i.level === "warning");
            if (warns.length) new Notice(`Saved with ${warns.length} warning${warns.length === 1 ? "" : "s"}.`);
            this.close();
          } catch (e) {
            msg.setText(e instanceof Error ? e.message : String(e));
          }
        }),
    );
  }
  /** Folded card under the editor: the modifier grammar and two examples that press into the JSON. */
  private renderGrammar(contentEl: HTMLElement, ta: HTMLTextAreaElement, msg: HTMLElement): void {
    const card = contentEl.createEl("details", { cls: "wadjet-grammar" });
    card.createEl("summary", { text: "Modifiers: grammar and examples" });
    card.createEl("p", { text: "Modifiers live in the zone's \"modifiers\" array. Each one bends the climate while its predicate holds." });
    for (const g of MODIFIER_GRAMMAR) {
      card.createEl("h5", { text: g.heading });
      for (const line of g.lines) card.createEl(line.startsWith("{") || line.startsWith("curves") || line.startsWith("scalars") ? "pre" : "p", { text: line });
    }
    card.createEl("h5", { text: "Examples" });
    for (const ex of MODIFIER_EXAMPLES) {
      const box = card.createDiv({ cls: "wadjet-example" });
      new Setting(box)
        .setName(ex.title)
        .setDesc(ex.blurb)
        .addButton((b) =>
          b.setButtonText("Add to this zone").onClick(() => {
            try {
              const z = parseJsonLenient<ZoneProfile>(ta.value);
              const mods = Array.isArray(z.modifiers) ? z.modifiers : [];
              const taken = new Set(mods.map((m) => m.id));
              const id = uniqueId(ex.modifier.id, taken);
              mods.push({ ...structuredClone(ex.modifier), id });
              z.modifiers = mods;
              ta.value = JSON.stringify(z, null, 2);
              msg.setText("");
              ta.scrollTop = ta.scrollHeight;
            } catch (e) {
              msg.setText(`Fix the JSON first: ${e instanceof Error ? e.message : String(e)}`);
            }
          }),
        );
      box.createEl("pre", { text: JSON.stringify(ex.modifier, null, 2) });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
