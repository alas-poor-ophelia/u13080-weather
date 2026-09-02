/**
 * The JSON drawer (SPEC §3.7, bead wadjet-9f9.37) — the live derived file.
 *
 * Two columns, one per scope: the zone's own keys (`id` … `overrides`, the
 * overrides filtered to this zone) and the world's (`eras`,
 * `calendar.seasons`, `calendar.moons`, `devicePresets`). `model/json-view.ts`
 * owns the derivation — this file only draws it. Visible iff `view.jsonOpen`
 * (the header's `{ } JSON` button writes that).
 *
 * Every section is a native `<details>` so "climate is folded, click to open"
 * is free — no listener, no state to track, the browser does it. Text is
 * read-only, written with `setText` (never innerHTML, SPEC law / ESLint
 * obsidianmd), and re-rendered only when the section's own text changed: a
 * knob drag ticks the store every frame, but a `<pre>` the text did not touch
 * costs nothing.
 */
import { Notice } from "obsidian";
import type { ZoneProfile } from "../../core/types";
import { jsonHint } from "../model/hints-json";
import { sections, zoneFileText, type JsonSection } from "../model/json-view";
import type { StudioState } from "../model/state";
import type { Surface, SurfaceContext } from "./surfaces";

/** Sentence-case label for each key `json-view.ts:sections` can emit. `climate` is special-cased. */
const LABEL: Record<string, string> = {
  id: "Id",
  name: "Name",
  preset: "Preset",
  geography: "Geography",
  flipSeasons: "Flip seasons",
  climate: "Climate",
  regimes: "Regimes",
  modifiers: "Modifiers",
  automation: "Automation",
  overrides: "Overrides",
  eras: "Eras",
  "calendar.seasons": "Calendar seasons",
  "calendar.moons": "Calendar moons",
  devicePresets: "Device presets",
};

/** `ClimateParams` has five channels (SPEC §1): temperature, precipitation, humidity, cloud, wind. */
const CLIMATE_SUMMARY = "Climate · 5 sections";

interface SectionEls {
  details: HTMLDetailsElement;
  pre: HTMLElement;
}

/** One scope column: its head (title + Copy) and its list of `<details>` sections. */
interface Column {
  root: HTMLElement;
  title: HTMLElement;
  list: HTMLElement;
  els: Map<string, SectionEls>;
  keys: string[];
  textCache: Map<string, string>;
}

function buildColumn(parent: HTMLElement, scope: "zone" | "world", onCopy: () => void): Column {
  const root = parent.createDiv({ cls: "wadjet-studio-json-col", attr: { "data-scope": scope } });
  const head = root.createDiv({ cls: "wadjet-studio-json-head" });
  const title = head.createSpan({ cls: "wadjet-studio-json-title" });
  const copy = head.createDiv({
    cls: "wadjet-studio-json-copy",
    text: "Copy",
    attr: { role: "button", tabindex: "0", "aria-label": `Copy ${scope} JSON`, "data-hint": jsonHint(scope === "zone" ? "json.copy.zone" : "json.copy.world") },
  });
  copy.addEventListener("click", onCopy);
  copy.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    onCopy();
  });
  const list = root.createDiv({ cls: "wadjet-studio-json-list" });
  return { root, title, list, els: new Map(), keys: [], textCache: new Map() };
}

/** Rebuild `col`'s `<details>` elements only when the set/order of keys changed; otherwise patch text. */
function paintColumn(col: Column, entries: readonly JsonSection[]): void {
  const keys = entries.map((e) => e.key);
  const structureChanged = keys.length !== col.keys.length || keys.some((k, i) => k !== col.keys[i]);
  if (structureChanged) {
    col.list.empty();
    col.els.clear();
    col.textCache.clear();
    for (const entry of entries) {
      const details = col.list.createEl("details", { cls: "wadjet-studio-json-section", attr: { "data-key": entry.key } });
      details.open = entry.key !== "climate";
      const summary = details.createEl("summary", { text: entry.key === "climate" ? CLIMATE_SUMMARY : (LABEL[entry.key] ?? entry.key) });
      if (entry.key === "climate") summary.setAttr("data-hint", jsonHint("json.climate.fold"));
      const pre = details.createEl("pre", { cls: "wadjet-json" });
      col.els.set(entry.key, { details, pre });
    }
    col.keys = keys;
  }
  for (const entry of entries) {
    if (col.textCache.get(entry.key) === entry.text) continue;
    col.els.get(entry.key)?.pre.setText(entry.text);
    col.textCache.set(entry.key, entry.text);
  }
}

function clearColumn(col: Column): void {
  if (col.keys.length === 0) return;
  col.list.empty();
  col.els.clear();
  col.textCache.clear();
  col.keys = [];
}

function copyToClipboard(text: string): void {
  try {
    navigator.clipboard?.writeText(text)?.catch(() => undefined);
  } catch {
    // Clipboard unavailable (headless, no permission, …) — the Notice below
    // still confirms the click landed; there is nothing further to recover.
  }
  new Notice("Copied");
}

export function createJsonDrawerSurface(): Surface {
  let ctx: SurfaceContext | null = null;
  let zoneCol: Column | null = null;
  let worldCol: Column | null = null;
  let currentZoneText = "";
  let currentWorldText = "";

  return {
    mount(next: SurfaceContext) {
      ctx = next;
      next.shell.json.empty();
      zoneCol = buildColumn(next.shell.json, "zone", () => copyToClipboard(currentZoneText));
      worldCol = buildColumn(next.shell.json, "world", () => copyToClipboard(currentWorldText));
    },

    render(state: StudioState) {
      const c = ctx;
      if (c === null || zoneCol === null || worldCol === null) return;
      c.shell.json.toggleClass("is-hidden", !state.view.jsonOpen);

      const zoneId = state.view.zoneId;
      const zone: ZoneProfile | undefined = zoneId === null ? undefined : state.zones[zoneId];

      zoneCol.title.setText(zone === undefined ? "Zone file" : `Zone file · ${zone.name}`);
      worldCol.title.setText("World");

      if (zone === undefined) {
        clearColumn(zoneCol);
        clearColumn(worldCol);
        currentZoneText = "";
        currentWorldText = "";
        return;
      }

      const all = sections(zone, state.world);
      paintColumn(
        zoneCol,
        all.filter((s) => s.scope === "zone"),
      );
      paintColumn(
        worldCol,
        all.filter((s) => s.scope === "world"),
      );
      currentZoneText = zoneFileText(zone, state.world.overrides);
      currentWorldText = JSON.stringify({ eras: state.world.eras, calendar: { seasons: state.world.calendar.seasons, moons: state.world.calendar.moons }, devicePresets: state.world.devicePresets }, null, 2);
    },

    destroy() {
      ctx?.shell.json.empty();
      zoneCol = null;
      worldCol = null;
      currentZoneText = "";
      currentWorldText = "";
      ctx = null;
    },
  };
}
