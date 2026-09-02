/**
 * Opening the studio (PLAN D1). One entry point, two doors: the command
 * `open-studio` and the "Open in studio" button on each settings zone row.
 *
 * The studio is a leaf, not a modal, and there is one of it: an existing
 * `wadjet-studio` leaf is re-pointed at the requested zone rather than a
 * second one being opened. `onunload` never detaches it (eslint `detachLeaves`
 * — a leaf the user arranged is theirs, not the plugin's, to close).
 */
import { Notice, SuggestModal, type App } from "obsidian";
import type { ZoneProfile } from "../../core/types";
import type WadjetPlugin from "../../plugin/main";
import { VIEW_TYPE } from "./view";

/**
 * The button that reaches this from settings lives in Obsidian 1.13's separate
 * settings window; leaving it open would hide the leaf that just opened.
 * `app.setting` is not in the public typings, so this is a guarded probe.
 */
function closeSettingsIfOpen(app: App): void {
  const setting = (app as unknown as { setting?: { activeTab?: unknown; close?: () => void } }).setting;
  try {
    if (setting?.activeTab) setting.close?.();
  } catch {
    /* the settings window is Obsidian's to manage; never block the leaf on it */
  }
}

/** Open (or re-point) the studio leaf on `zoneId` and focus it. */
export async function openStudio(plugin: WadjetPlugin, zoneId: string): Promise<void> {
  closeSettingsIfOpen(plugin.app);
  const workspace = plugin.app.workspace;
  const leaf = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE, state: { zoneId }, active: true });
  await workspace.revealLeaf(leaf);
}

/**
 * The command's behaviour: nothing to edit without a zone, no picker for one
 * zone, a picker for several.
 */
export function openStudioFromCommand(plugin: WadjetPlugin): void {
  const zones = plugin.settings.zones;
  const only = zones[0];
  if (only === undefined) {
    new Notice("Add a zone first");
    return;
  }
  if (zones.length === 1) {
    void openStudio(plugin, only.id);
    return;
  }
  new ZonePickerModal(plugin).open();
}

class ZonePickerModal extends SuggestModal<ZoneProfile> {
  constructor(private readonly plugin: WadjetPlugin) {
    super(plugin.app);
    this.setPlaceholder("Open a zone in the climate studio");
  }

  override getSuggestions(query: string): ZoneProfile[] {
    const q = query.trim().toLowerCase();
    if (q === "") return this.plugin.settings.zones;
    return this.plugin.settings.zones.filter((z) => z.name.toLowerCase().includes(q) || z.id.toLowerCase().includes(q));
  }

  override renderSuggestion(zone: ZoneProfile, el: HTMLElement): void {
    el.createDiv({ cls: "wadjet-studio-pick-name", text: zone.name });
    el.createDiv({ cls: "wadjet-studio-pick-id", text: zone.id });
  }

  override onChooseSuggestion(zone: ZoneProfile): void {
    void openStudio(this.plugin, zone.id);
  }
}
