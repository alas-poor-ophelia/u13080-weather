/**
 * The header and everything in it (SPEC §3.1).
 *
 * Left: the wordmark, then the zone the studio is pointed at — its name (a
 * dropdown over every zone, with dirty state and base station), its live
 * Köppen class, the station it was copied from, and the hemisphere flag when
 * it is offered. Right: the tools that move the playlist's window, the JSON
 * drawer and **Save**.
 *
 * There are no undo/redo buttons (bead wadjet-6rw.6): the prototype's header
 * has none, SPEC §3.1 does not list them, and the leaf's own Mod+Z scope
 * (`ui/view.ts`) already carries the feature.
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
 * Chrome buttons (transport, JSON, Save) are plain header controls, not
 * additions to the closed component bin (SPEC law 3) — the same status as
 * the window's × and the ruler's label. The four things that stand for an
 * *entity* (zone, Köppen class, station, hemisphere flag) are Chips.
 */
import { Menu, Notice } from "obsidian";
import { koppenOfClimate, type KoppenResult } from "../../core/koppen";
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
import { panBy, presetWindow, width, worldBounds, zoomAt, zoomLabel, type Window, type ZoomBounds, type ZoomPreset } from "../model/zoom";
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

/** Year length to label with when the active adapter does not describe itself. */
const DEFAULT_YEAR_LENGTH = 365;

const PRESET_OPTIONS: ReadonlyArray<{ value: ZoomPreset; label: string; hint: string }> = [
  { value: "day", label: "Day", hint: hintAttr("zoom.day") },
  { value: "month", label: "Month", hint: hintAttr("zoom.month") },
  { value: "season", label: "Season", hint: hintAttr("zoom.season") },
  { value: "year", label: "Year", hint: hintAttr("zoom.year") },
  { value: "era", label: "Era", hint: hintAttr("zoom.era") },
];

/** The studio's wordmark: EGYPTIAN HIEROGLYPH D010, the plugin's own glyph. */
const WORDMARK = "\u{13080}";

/**
 * The Köppen pill's hue, by climate group — the prototype's own pairing
 * (`1397-logic-class-Component.js:511-515`): green for the temperate and
 * tropical classes, moon-blue for continental, precip-blue for polar, gold
 * for the dry ones. The pill's fill and border derive from it in `styles.css`.
 */
function koppenColour(group: KoppenResult["group"]): string {
  switch (group) {
    case "E":
      return "var(--wadjet-studio-precip)";
    case "D":
      return "var(--wadjet-studio-moon)";
    case "B":
      return "var(--wadjet-studio-gold)";
    default:
      return "var(--wadjet-studio-wind)";
  }
}

/**
 * The window readout's range (SPEC §3.1) — `model/format.ts`'s `windowLabel`
 * with the active calendar's year length: `d0 – d365 · 1962` inside one year,
 * `1962 – 2962` once it spans 2.5 years or more.
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

/**
 * The SRC chip's body — `Bergen · 30 yr`, or `· by geography` when Tier A
 * matched it (SPEC §3.1). The `SRC` prefix is a separate span so it can wear
 * the prototype's dim letterspaced caps; `srcLabel` glues the two back
 * together for `title` and `aria-label`.
 */
function srcBody(zone: ZoneProfile): string {
  const preset = zone.preset === undefined ? undefined : PRESETS.find((p) => p.id === zone.preset?.id);
  const station = preset?.source.place ?? preset?.source.stationName ?? zone.preset?.id ?? "no station";
  const byGeography = zone.geography !== undefined && zone.preset?.matched === "auto";
  const tail = byGeography ? "by geography" : `${preset?.source.yearsOfRecord ?? 30} yr`;
  return `${station} · ${tail}`;
}

/** `SRC <station> · 30 yr` — the whole chip as one string. */
function srcLabel(zone: ZoneProfile): string {
  return `SRC ${srcBody(zone)}`;
}

/**
 * Split a chip label into the dim `SRC` tag and the rest. `createChip` writes
 * the label with `setText`, so this runs *after* every `update` and rebuilds
 * the two spans the tag needs.
 */
function paintSrcLabel(chip: ChipComponent, body: string): void {
  const labelEl = chip.el.querySelector<HTMLElement>(".wadjet-studio-chip-label");
  if (labelEl === null) return;
  labelEl.empty();
  labelEl.createSpan({ cls: "wadjet-studio-header-srctag", text: "SRC" });
  labelEl.appendText(` ${body}`);
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
  koppen: KoppenResult | null;
  issues: StudioIssue[];
}

export function createHeaderSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  let zoneButton: HTMLElement | null = null;
  let zoneName: HTMLElement | null = null;
  let koppenLed: LedComponent | null = null;
  let koppenChip: ChipComponent | null = null;
  let koppenDesc: HTMLElement | null = null;
  let srcChip: ChipComponent | null = null;
  let flipLed: LedComponent | null = null;
  let flipChip: ChipComponent | null = null;

  let readoutRange: HTMLElement | null = null;
  let presets: SegmentedComponent | null = null;
  let jsonButton: HTMLElement | null = null;
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
    return worldBounds(epoch, eras());
  }

  /** The world's eras — what widens `bounds()` and what the Era preset frames. */
  function eras(): ReadonlyArray<{ from: number; to?: number; enabled?: boolean }> {
    return ctx?.store.get().world.eras ?? [];
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
    let koppen: KoppenResult | null = null;
    if (!validateProfile(zone).some((i) => i.level === "error")) {
      try {
        koppen = koppenOfClimate(resolveProfile(zone).climate);
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
    menu.setNoIcon();
    // The prototype's dropdown opens with a dim `ZONES · N` caption over the
    // rows (`0025-header.html`); Obsidian's label item is the same affordance.
    menu.addItem((item) => item.setTitle(`ZONES · ${c.plugin.settings.zones.length}`).setIsLabel(true));
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

    zoneName?.setText(zone === null ? "No zone" : zone.name);

    // The prototype's header carries no LED (gap-shell §1): a green dot beside
    // a badge that is *already* the readout says nothing. It stays in the DOM,
    // carrying `data-level` for anything reading the class, and surfaces only
    // when the draft has no class to show.
    const koppenBad = zone !== null && koppen === null;
    koppenLed?.update({ on: true, level: koppenBad ? "error" : "ok" });
    koppenLed?.el.toggleClass("is-hidden", !koppenBad);
    koppenChip?.update({ label: koppen?.code ?? "—" });
    koppenChip?.el.setCssProps({ "--wadjet-studio-koppen-color": koppen === null ? "var(--wadjet-studio-text-dim)" : koppenColour(koppen.group) });
    koppenDesc?.setText(koppen === null ? "" : `· ${koppen.description}`);

    // The badges shrink and ellipsize when the header runs out of room
    // (styles.css, `.wadjet-studio-header-badges`), so the full station line
    // has to stay reachable without reading the pixels.
    const src = zone === null ? "SRC —" : srcLabel(zone);
    srcChip?.update({ label: src });
    if (srcChip !== null) paintSrcLabel(srcChip, zone === null ? "—" : srcBody(zone));
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
    // The prototype's two states (`1397-logic…:1384`): the chip always says
    // the record's seasons were flipped — what changes is whether the tag
    // gates were remapped with them. There is never a "not flipped" chip.
    const flipLabel = flip === "off" ? "seasons flipped · tags NOT remapped" : "seasons flipped · tags remapped";
    flipChip?.update({ label: flipLabel, color: flip === "off" ? "var(--wadjet-studio-temp)" : "var(--wadjet-studio-gold)", hint: hintAttr("zone.flip", flipHint(flip)) });
    // Below a 1300 px studio the chip collapses to its ⇅ glyph (styles.css),
    // so the words have to live somewhere a pointer and a screen reader can
    // still reach — the hint bar already carries the longer explanation.
    flipChip?.el.setAttrs({ title: flipLabel, "aria-label": flipLabel });
    // Same rule as the Köppen LED: shown only when it has something to warn
    // about (an opaque or season-less calendar), never as decoration.
    flipLed?.el.toggleClass("is-hidden", !flipped || flip === "on");
    flipLed?.update({ on: true, level: flip === "on" ? "ok" : "warn" });

    const w = state.view.window;
    readoutRange?.setText(formatWindow(w, description));
    presets?.update({ value: zoomLabel(w) });

    if (jsonButton) jsonButton.toggleClass("is-on", state.view.jsonOpen);

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

      // The wordmark (SPEC §9's own glyph): decorative, so `aria-hidden`, but
      // the `title` names the codepoint the way the prototype's does.
      shell.headerZone.createSpan({ cls: "wadjet-studio-header-mark", text: WORDMARK, attr: { title: "U+13080", "aria-hidden": "true" } });

      zoneButton = shell.headerZone.createDiv({
        cls: "wadjet-studio-header-zonebtn",
        attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "data-hint": hintAttr("zone.menu") },
      });
      zoneName = zoneButton.createSpan({ cls: "wadjet-studio-header-zonename" });
      zoneButton.createSpan({ cls: "wadjet-studio-header-caret", text: "▾", attr: { "aria-hidden": "true" } });
      zoneButton.addEventListener("click", openZoneMenu);
      zoneButton.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        openZoneMenu(new MouseEvent("click", { clientX: zoneButton?.getBoundingClientRect().left ?? 0, clientY: zoneButton?.getBoundingClientRect().bottom ?? 0 }));
      });

      const badges = shell.headerZone.createDiv({ cls: "wadjet-studio-header-badges" });
      koppenLed = createLed(badges, { on: true, level: "ok", scope: "device", hint: hintAttr("zone.koppen") });
      koppenChip = createChip(badges, { label: "—", hint: hintAttr("zone.koppen") });
      koppenChip.el.addClass("wadjet-studio-header-koppen");
      // The two-part pill: the code in its class colour, the human reading a
      // shade dimmer (`Cfb · temperate oceanic`). The description lives beside
      // the chip's own label, never inside it — the label is the code, and the
      // e2e walk reads exactly that.
      koppenDesc = koppenChip.el.createSpan({ cls: "wadjet-studio-header-koppen-desc" });
      srcChip = createChip(badges, { label: "SRC —", hint: hintAttr("zone.src"), onClick: () => next.windows.open(ATLAS_WINDOW) });
      srcChip.el.addClass("wadjet-studio-header-src");
      srcChip.el.createSpan({ cls: "wadjet-studio-header-caret", text: "▾", attr: { "aria-hidden": "true" } });
      flipLed = createLed(badges, { on: true, level: "warn", scope: "device", hint: hintAttr("zone.flip") });
      flipChip = createChip(badges, { label: "seasons flipped · tags remapped", icon: "⇅", color: "var(--wadjet-studio-gold)", hint: hintAttr("zone.flip"), onClick: toggleFlip });
      // Stable hooks for the e2e walk; the classes themselves are shared by
      // every chip and LED in the studio.
      koppenLed.el.setAttr("data-part", "koppen-led");
      koppenChip.el.setAttr("data-part", "koppen");
      srcChip.el.setAttr("data-part", "src");
      flipLed.el.setAttr("data-part", "flip-led");
      flipChip.el.setAttr("data-part", "flip");

      // One dark inset pill, no zoom-name prefix: the presets to its right
      // already say which scale this is (gap-shell §1).
      const readout = shell.headerTools.createDiv({ cls: "wadjet-studio-header-readout", attr: { "data-hint": hintAttr("transport.readout") } });
      readoutRange = readout.createSpan({ cls: "wadjet-studio-header-readout-range" });

      const transport = shell.headerTools.createDiv({ cls: "wadjet-studio-header-transport" });
      headerButton(transport, { text: "◀", label: "Pan back", hint: hintAttr("transport.back"), onClick: () => setWindow(panBy(currentWindow(), -width(currentWindow()) * PAN_FRACTION, bounds())) });
      headerButton(transport, { text: "▶", label: "Pan forward", hint: hintAttr("transport.forward"), onClick: () => setWindow(panBy(currentWindow(), width(currentWindow()) * PAN_FRACTION, bounds())) });
      headerButton(transport, { text: "−", label: "Zoom out", hint: hintAttr("transport.out"), onClick: () => setWindow(zoomAt(currentWindow(), 0.5, ZOOM_OUT, bounds())) });
      headerButton(transport, { text: "＋", label: "Zoom in", hint: hintAttr("transport.in"), onClick: () => setWindow(zoomAt(currentWindow(), 0.5, ZOOM_IN, bounds())) });

      presets = createSegmented(shell.headerTools, {
        options: PRESET_OPTIONS.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
        value: zoomLabel(currentWindow()),
        onChange: (value) => setWindow(presetWindow(value as ZoomPreset, currentWindow(), bounds(), seasons(), eras())),
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
      zoneButton = zoneName = koppenDesc = readoutRange = jsonButton = saveButton = null;
      memoKey = "";
      memo = { koppen: null, issues: [] };
      saving = false;
      ctx = null;
    },
  };
}
