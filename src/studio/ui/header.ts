/**
 * The header and everything in it (SPEC §3.1).
 *
 * Left: the zone the studio is pointed at — its name (a dropdown over every
 * zone, with dirty state and base station), its live Köppen class, the station
 * it was copied from, and the hemisphere flag when it is set. Right: the tools
 * that move the playlist's window, the JSON drawer, undo/redo and **Save**.
 *
 * Three things worth knowing before editing this file:
 *
 *  - **The Köppen badge is the compiled draft, not the file.** It reads
 *    `koppenOfClimate(resolveProfile(draft).climate)`, so a climate-stage layer
 *    the user is dragging right now is in it. A draft with validation errors
 *    cannot be resolved, so the badge shows `—` behind a red LED rather than a
 *    stale class (SPEC law 4: never invent a number).
 *  - **Every window move goes through `model/zoom.ts`.** Transport, presets and
 *    (later) the ruler share one clamp, so the studio can never show a window
 *    the playlist cannot draw.
 *  - **Save is the only thing in the studio that writes `plugin.settings`.**
 *    Every other edit lands in a draft. Errors block it; warnings do not.
 *
 * Chrome buttons (transport, JSON, undo/redo, Save) are plain header controls,
 * not additions to the closed component bin (SPEC law 3) — the same status as
 * the window's × and the ruler's label. The four things that stand for an
 * *entity* (zone, Köppen class, station, hemisphere flag) are Chips.
 */
import { Menu, Notice } from "obsidian";
import { koppenOfClimate } from "../../core/koppen";
import { canonicalJson, resolveProfile, validateProfile } from "../../core/profile";
import type { ZoneProfile } from "../../core/types";
import { PRESETS } from "../../generated/presets";
import { AddZoneModal } from "../../plugin/settings-tab";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { windowLabel } from "../model/format";
import { flipHint, flipState, straddlesEquator } from "../model/hemisphere";
import { hintAttr } from "../model/hints";
import { zoneForSave } from "../model/json-view";
import type { StudioState } from "../model/state";
import { issuesFor, saveLabel, type StudioIssue } from "../model/validation";
import { panBy, presetWindow, width, zoomAt, zoomLabel, type Window, type ZoomBounds, type ZoomPreset } from "../model/zoom";
import { createChip, createLed, createSegmented, type ChipComponent, type LedComponent, type SegmentedComponent } from "./components";
import type { Surface, SurfaceContext } from "./surfaces";
// The SRC chip's destination (SPEC law 2: reached from the thing it
// describes). The id is the Atlas window's own — `ui/atlas-surface.ts`
// registers the builder under it — so the header only opens it.
import { ATLAS_WINDOW } from "./windows/atlas";

/** Transport zoom steps: one click in, one click out, about the window centre. */
const ZOOM_IN = 0.8;
const ZOOM_OUT = 1.25;
/** Transport pan step, as a fraction of the visible window. */
const PAN_FRACTION = 0.25;

/** How far either side of the world's epoch the timeline may be panned, in years. */
const BOUNDS_BEFORE = 100;
const BOUNDS_AFTER = 1100;

/** Year length to label with when the active adapter does not describe itself. */
const DEFAULT_YEAR_LENGTH = 365;

const PRESET_OPTIONS: ReadonlyArray<{ value: ZoomPreset; label: string; hint: string }> = [
  { value: "day", label: "Day", hint: hintAttr("zoom.day") },
  { value: "month", label: "Month", hint: hintAttr("zoom.month") },
  { value: "season", label: "Season", hint: hintAttr("zoom.season") },
  { value: "year", label: "Year", hint: hintAttr("zoom.year") },
  { value: "era", label: "Era", hint: hintAttr("zoom.era") },
];

const PRESET_LABEL: Record<ZoomPreset, string> = { day: "Day", month: "Month", season: "Season", year: "Year", era: "Era" };

/**
 * The window readout's range (SPEC §3.1) — `model/format.ts`'s `windowLabel`
 * with the active calendar's year length: `Y 1962 · d 1–365` inside one year,
 * `Y 1962 – 2961` once it spans more.
 */
export function formatWindow(w: Window, calendar: CalendarDescription | null): string {
  return windowLabel(w.a, w.b, calendar?.yearLength ?? DEFAULT_YEAR_LENGTH);
}

/** The zone's base station, as the dropdown and the SRC chip name it. */
export function baseLabel(zone: ZoneProfile): string {
  if (zone.geography !== undefined && zone.preset?.matched === "auto") return "by geography";
  const id = zone.preset?.id;
  if (id === undefined) return "custom";
  return PRESETS.find((p) => p.id === id)?.name ?? id;
}

/** `SRC <station> · 30 yr` — or `· by geography` when Tier A matched it (SPEC §3.1). */
function srcLabel(zone: ZoneProfile): string {
  const preset = zone.preset === undefined ? undefined : PRESETS.find((p) => p.id === zone.preset?.id);
  const station = preset?.source.stationName ?? zone.preset?.id ?? "no station";
  const byGeography = zone.geography !== undefined && zone.preset?.matched === "auto";
  const tail = byGeography ? "by geography" : `${preset?.source.yearsOfRecord ?? 30} yr`;
  return `SRC ${station} · ${tail}`;
}

/** A header chrome button: a real button for the keyboard, hinted like everything else. */
function headerButton(parent: HTMLElement, o: { text: string; label: string; hint: string; cls?: string; onClick: (ev: MouseEvent) => void }): HTMLElement {
  const el = parent.createDiv({
    cls: o.cls === undefined ? "wadjet-studio-header-btn" : `wadjet-studio-header-btn ${o.cls}`,
    text: o.text,
    attr: { role: "button", tabindex: "0", "aria-label": o.label, "data-hint": o.hint },
  });
  el.addEventListener("click", (ev) => {
    if (el.hasClass("is-disabled")) return;
    o.onClick(ev);
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (el.hasClass("is-disabled")) return;
    o.onClick(new MouseEvent("click"));
  });
  return el;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  el.toggleClass("is-disabled", disabled);
  el.setAttrs({ "aria-disabled": disabled ? "true" : "false", tabindex: disabled ? "-1" : "0" });
}

/** What the header derives per render; memoised because a knob drag repaints every frame. */
interface Derived {
  koppen: string | null;
  issues: StudioIssue[];
}

export function createHeaderSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  let zoneButton: HTMLElement | null = null;
  let koppenLed: LedComponent | null = null;
  let koppenChip: ChipComponent | null = null;
  let srcChip: ChipComponent | null = null;
  let flipLed: LedComponent | null = null;
  let flipChip: ChipComponent | null = null;

  let readoutLabel: HTMLElement | null = null;
  let readoutRange: HTMLElement | null = null;
  let presets: SegmentedComponent | null = null;
  let jsonButton: HTMLElement | null = null;
  let undoButton: HTMLElement | null = null;
  let redoButton: HTMLElement | null = null;
  let saveButton: HTMLElement | null = null;

  let memoKey = "";
  let memo: Derived = { koppen: null, issues: [] };
  /** True between the click and the end of `saveAndRebuild` — the button says `Saving…` and refuses a second click. */
  let saving = false;

  // --- state helpers -------------------------------------------------------

  function zoneOf(state: StudioState): ZoneProfile | null {
    const id = state.view.zoneId;
    return id === null ? null : (state.zones[id] ?? null);
  }

  function bounds(): ZoomBounds {
    const c = ctx;
    const epoch = c?.calendar()?.epochYear ?? c?.plugin.settings.calendar.epochYear ?? 1;
    return { min: epoch - BOUNDS_BEFORE, max: epoch + BOUNDS_AFTER };
  }

  function seasons(): ReadonlyArray<{ name: string; from: number }> {
    const c = ctx;
    if (c === null) return [];
    return c.calendar()?.seasons ?? c.store.get().world.calendar.seasons;
  }

  function setWindow(next: Window): void {
    const c = ctx;
    if (c === null) return;
    c.store.update((s) => {
      s.view.window = next;
    });
    c.view.app.workspace.requestSaveLayout();
  }

  function currentWindow(): Window {
    return ctx?.store.get().view.window ?? { a: 0, b: 1 };
  }

  /**
   * The Köppen class and the validation surface, recomputed only when the
   * inputs actually changed. `canonicalJson` is the same identity the store's
   * dirty tracking uses, so a value put back never re-derives either.
   */
  function derive(state: StudioState): Derived {
    const c = ctx;
    const zone = zoneOf(state);
    if (c === null || zone === null) return { koppen: null, issues: [] };
    const description = c.calendar();
    const readOnlyCalendar = description?.readOnly ?? false;
    // Validate what **Save writes**, not what the adapter currently reports: a
    // read-only calendar is not the studio's to write (or to validate — see
    // `studioRules`), so under one the description is the subject instead.
    const seasonList = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
    const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
    const key = `${canonicalJson(zone)}|${canonicalJson(state.world.eras)}|${canonicalJson(seasonList)}|${canonicalJson(moons)}|${String(readOnlyCalendar)}`;
    if (key === memoKey) return memo;

    const issues = issuesFor({ zone, eras: state.world.eras, seasons: seasonList, moons, readOnlyCalendar });
    let koppen: string | null = null;
    if (!validateProfile(zone).some((i) => i.level === "error")) {
      try {
        koppen = koppenOfClimate(resolveProfile(zone).climate).code;
      } catch {
        // A draft the resolver rejects has no class to show; the red LED says so.
        koppen = null;
      }
    }
    memoKey = key;
    memo = { koppen, issues };
    return memo;
  }

  // --- actions -------------------------------------------------------------

  function openZoneMenu(ev: MouseEvent): void {
    const c = ctx;
    if (c === null) return;
    const state = c.store.get();
    const dirty = c.store.dirtyZones();
    const menu = new Menu();
    for (const zone of c.plugin.settings.zones) {
      const draft = state.zones[zone.id] ?? zone;
      const mark = dirty.has(zone.id) ? "●" : "✓";
      menu.addItem((item) =>
        item
          .setTitle(`${mark} ${draft.name} · ${baseLabel(draft)}`)
          .setChecked(zone.id === state.view.zoneId)
          .onClick(() => {
            c.store.setZone(zone.id);
            c.view.app.workspace.requestSaveLayout();
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("＋ add zone").onClick(() => new AddZoneModal(c.plugin.app, c.plugin, () => c.view.refreshFromSettings()).open()));
    menu.showAtMouseEvent(ev);
  }

  function toggleFlip(): void {
    const c = ctx;
    if (c === null) return;
    c.store.update((s) => {
      const id = s.view.zoneId;
      const zone = id === null ? undefined : s.zones[id];
      if (zone === undefined) return;
      if (zone.flipSeasons === true) delete zone.flipSeasons;
      else zone.flipSeasons = true;
    }, { history: true });
  }

  /** `Saved <N zones|zone name> · world`, whichever halves actually moved — sentence case. */
  function saveSummary(zoneNames: readonly string[], world: boolean): string {
    const zonePart = zoneNames.length === 0 ? null : zoneNames.length === 1 ? zoneNames[0] : `${zoneNames.length} zones`;
    const parts = [zonePart, world ? "world" : null].filter((p): p is string => p !== null);
    return parts.length === 0 ? "Saved" : `Saved ${parts.join(" · ")}`;
  }

  /**
   * The one write-through in the studio. Every *dirty* zone draft goes back
   * into its settings row — normalised through `model/json-view.ts`'s
   * `zoneForSave`, the same helper the JSON drawer shows, so "as it would be
   * saved" is literally what is saved (the id is immutable and never created
   * here — the studio edits zones, `AddZoneModal` adds them), then one
   * `saveAndRebuild`. Bead wadjet-9f9.36 puts a per-zone confirm in front of
   * this; the write itself is what it will confirm.
   *
   * If `saveAndRebuild` throws (disk write failed, a rebuild threw), the
   * drafts are left exactly as dirty as they were — `markSaved()` only runs
   * once the write is confirmed — and the error reaches the Guildmaster as a
   * Notice rather than an unhandled rejection.
   */
  async function commit(): Promise<void> {
    const c = ctx;
    // The button is disabled while a save is in flight, but Enter on a focused
    // button and a second click can still race the frame that disables it.
    if (c === null || saving) return;
    const state = c.store.get();
    const settings = c.plugin.settings;
    const dirtyIds = c.store.dirtyZones();
    const worldWasDirty = c.store.worldDirty();
    const dirtyNames = [...dirtyIds].map((id) => state.zones[id]?.name ?? id);
    // `saveAndRebuild` is a disk write and a world rebuild; on a large vault
    // that is long enough to look like nothing happened. Say so, and refuse a
    // second click until it lands.
    saving = true;
    paint(c.store.get());
    try {
      for (const id of dirtyIds) {
        const draft = state.zones[id];
        if (draft === undefined) continue;
        const at = settings.zones.findIndex((z) => z.id === id);
        const existing = settings.zones[at];
        if (existing === undefined) continue;
        // `zoneForSave` is the drawer's own "as it would be saved" clone
        // (`model/json-view.ts`), so a zone that arrived out of order through
        // the JSON escape hatch is written in the order the drawer showed.
        settings.zones[at] = { ...zoneForSave(draft), id: existing.id };
      }
      settings.eras = structuredClone(state.world.eras);
      settings.calendar.seasons = structuredClone(state.world.calendar.seasons);
      settings.calendar.moons = structuredClone(state.world.calendar.moons);
      settings.devicePresets = structuredClone(state.world.devicePresets);
      settings.overrides = structuredClone(state.world.overrides);
      await c.plugin.saveAndRebuild();
    } catch (e) {
      // The drafts are exactly as dirty as they were, so the button goes back
      // to `Save ●` rather than sitting on `Saving…` forever.
      saving = false;
      paint(c.store.get());
      new Notice(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // `markSaved` first, so the repaint below lands on `Saved ✓` directly
    // instead of flashing `Save ●` on its way there.
    c.store.markSaved();
    saving = false;
    c.plugin.refreshSettingsTab();
    paint(c.store.get());
    new Notice(saveSummary(dirtyNames, worldWasDirty));
  }

  // --- painting ------------------------------------------------------------

  /**
   * The whole header, from the live state. Named rather than inlined into the
   * surface's `render` because `commit()` has to repaint outside a store tick:
   * `Saving…` goes up the moment the click lands, and comes down on the far
   * side of `saveAndRebuild` whether it resolved or threw.
   */
  function paint(state: StudioState): void {
    const c = ctx;
    if (c === null) return;
    const zone = zoneOf(state);
    const { koppen, issues } = derive(state);

    zoneButton?.setText(zone === null ? "No zone ▾" : `${zone.name} ▾`);

    koppenLed?.update({ on: true, level: zone !== null && koppen === null ? "error" : "ok" });
    koppenChip?.update({ label: koppen ?? "—" });
    // The badges shrink and ellipsize when the header runs out of room
    // (styles.css, `.wadjet-studio-header-badges`), so the full station line
    // has to stay reachable without reading the pixels.
    const src = zone === null ? "SRC —" : srcLabel(zone);
    srcChip?.update({ label: src });
    srcChip?.el.setAttrs({ title: src, "aria-label": src });

    // The flag is set in the Atlas; the header shows it, clears it, and — as
    // long as the geography and the matched station still disagree on
    // hemisphere — offers turning it back on (SPEC §3.1, PLAN §0.1).
    // `flipState` needs what Save would actually write, not the adapter's
    // last-saved describe(): an editable calendar's season edits are true in
    // the draft before they are ever saved (the same substitution `derive`
    // makes for the Köppen badge and `spanCalendarFor` makes for the bands).
    const description = c.calendar();
    const seasonList = description === null ? [] : description.readOnly ? description.seasons : state.world.calendar.seasons;
    const effectiveCalendar = description === null ? null : { ...description, seasons: seasonList };
    const flipped = zone?.flipSeasons === true;
    const offered = zone !== null && (flipped || straddlesEquator(zone, PRESETS));
    const flip = zone === null ? "off" : flipState(zone, effectiveCalendar);
    flipChip?.el.toggleClass("is-hidden", !offered);
    const flipLabel = flip === "off" ? "seasons not flipped" : "seasons flipped";
    flipChip?.update({ label: flipLabel, hint: hintAttr("zone.flip", flipHint(flip)) });
    // Below a 1300 px studio the chip collapses to its ⇅ glyph (styles.css),
    // so the words have to live somewhere a pointer and a screen reader can
    // still reach — the hint bar already carries the longer explanation.
    flipChip?.el.setAttrs({ title: flipLabel, "aria-label": flipLabel });
    flipLed?.el.toggleClass("is-hidden", !flipped);
    flipLed?.update({ on: true, level: flip === "on" ? "ok" : "warn" });

    const w = state.view.window;
    readoutLabel?.setText(PRESET_LABEL[zoomLabel(w)]);
    readoutRange?.setText(formatWindow(w, description));
    presets?.update({ value: zoomLabel(w) });

    if (jsonButton) jsonButton.toggleClass("is-on", state.view.jsonOpen);
    if (undoButton) setDisabled(undoButton, !c.store.canUndo());
    if (redoButton) setDisabled(redoButton, !c.store.canRedo());

    if (saveButton) {
      if (saving) {
        // In flight: the drafts are still dirty and `markSaved` has not run,
        // so without this the button would read `Save ●` and invite a second
        // click through a disk write it cannot cancel.
        saveButton.setText("Saving…");
        saveButton.setAttr("data-state", "saving");
        setDisabled(saveButton, true);
        saveButton.setAttr("data-hint", hintAttr("header.save", "writing to disk"));
      } else {
        const dirty = c.store.dirtyZones().size > 0 || c.store.worldDirty();
        const label = saveLabel(issues);
        const clean = !dirty;
        saveButton.setText(clean ? "Saved ✓" : label.text);
        saveButton.setAttr("data-state", clean ? "saved" : label.blocked ? "blocked" : issues.length > 0 ? "warn" : "dirty");
        setDisabled(saveButton, clean || label.blocked);
        const detail = issues.length === 0 ? undefined : issues.map((i) => i.message).join(" · ");
        saveButton.setAttr("data-hint", hintAttr("header.save", detail));
      }
    }
  }

  // --- surface -------------------------------------------------------------

  return {
    mount(next) {
      ctx = next;
      const { shell } = next;

      zoneButton = shell.headerZone.createDiv({
        cls: "wadjet-studio-header-zonebtn",
        attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "data-hint": hintAttr("zone.menu") },
      });
      zoneButton.addEventListener("click", openZoneMenu);
      zoneButton.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        openZoneMenu(new MouseEvent("click", { clientX: zoneButton?.getBoundingClientRect().left ?? 0, clientY: zoneButton?.getBoundingClientRect().bottom ?? 0 }));
      });

      const badges = shell.headerZone.createDiv({ cls: "wadjet-studio-header-badges" });
      koppenLed = createLed(badges, { on: true, level: "ok", scope: "device", hint: hintAttr("zone.koppen") });
      koppenChip = createChip(badges, { label: "—", hint: hintAttr("zone.koppen") });
      srcChip = createChip(badges, { label: "SRC —", hint: hintAttr("zone.src"), onClick: () => next.windows.open(ATLAS_WINDOW) });
      flipLed = createLed(badges, { on: true, level: "warn", scope: "device", hint: hintAttr("zone.flip") });
      flipChip = createChip(badges, { label: "seasons flipped", icon: "⇅", color: "var(--wadjet-studio-gold)", hint: hintAttr("zone.flip"), onClick: toggleFlip });
      // Stable hooks for the e2e walk; the classes themselves are shared by
      // every chip and LED in the studio.
      koppenLed.el.setAttr("data-part", "koppen-led");
      koppenChip.el.setAttr("data-part", "koppen");
      srcChip.el.setAttr("data-part", "src");
      flipLed.el.setAttr("data-part", "flip-led");
      flipChip.el.setAttr("data-part", "flip");

      const readout = shell.headerTools.createDiv({ cls: "wadjet-studio-header-readout", attr: { "data-hint": hintAttr("transport.readout") } });
      readoutLabel = readout.createSpan({ cls: "wadjet-studio-header-readout-label" });
      readoutRange = readout.createSpan({ cls: "wadjet-studio-header-readout-range" });

      const transport = shell.headerTools.createDiv({ cls: "wadjet-studio-header-transport" });
      headerButton(transport, { text: "◀", label: "Pan back", hint: hintAttr("transport.back"), onClick: () => setWindow(panBy(currentWindow(), -width(currentWindow()) * PAN_FRACTION, bounds())) });
      headerButton(transport, { text: "▶", label: "Pan forward", hint: hintAttr("transport.forward"), onClick: () => setWindow(panBy(currentWindow(), width(currentWindow()) * PAN_FRACTION, bounds())) });
      headerButton(transport, { text: "−", label: "Zoom out", hint: hintAttr("transport.out"), onClick: () => setWindow(zoomAt(currentWindow(), 0.5, ZOOM_OUT, bounds())) });
      headerButton(transport, { text: "＋", label: "Zoom in", hint: hintAttr("transport.in"), onClick: () => setWindow(zoomAt(currentWindow(), 0.5, ZOOM_IN, bounds())) });

      presets = createSegmented(shell.headerTools, {
        options: PRESET_OPTIONS.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
        value: zoomLabel(currentWindow()),
        onChange: (value) => setWindow(presetWindow(value as ZoomPreset, currentWindow(), bounds(), seasons())),
      });

      jsonButton = headerButton(shell.headerTools, {
        text: "{ } JSON",
        label: "Toggle the JSON drawer",
        hint: hintAttr("header.json"),
        onClick: () => {
          next.store.update((s) => {
            s.view.jsonOpen = !s.view.jsonOpen;
          });
          next.view.app.workspace.requestSaveLayout();
        },
      });

      undoButton = headerButton(shell.headerTools, { text: "↶", label: "Undo", hint: hintAttr("header.undo"), onClick: () => next.store.undo() });
      redoButton = headerButton(shell.headerTools, { text: "↷", label: "Redo", hint: hintAttr("header.redo"), onClick: () => next.store.redo() });
      saveButton = headerButton(shell.headerTools, { text: "Save ●", label: "Save", hint: hintAttr("header.save"), cls: "wadjet-studio-header-save", onClick: () => void commit() });
    },

    render(state) {
      paint(state);
    },

    destroy() {
      koppenLed?.destroy();
      koppenChip?.destroy();
      srcChip?.destroy();
      flipLed?.destroy();
      flipChip?.destroy();
      presets?.destroy();
      koppenLed = koppenChip = srcChip = flipLed = flipChip = null;
      presets = null;
      zoneButton = readoutLabel = readoutRange = jsonButton = undoButton = redoButton = saveButton = null;
      memoKey = "";
      memo = { koppen: null, issues: [] };
      saving = false;
      ctx = null;
    },
  };
}
