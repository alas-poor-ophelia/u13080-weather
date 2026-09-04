/**
 * The Climate Studio leaf (PLAN D1, D11, §4).
 *
 * `StudioView` is a **coordinator**, not a surface. It owns four things and
 * delegates everything else:
 *
 *  - **The store.** Built from `initialState(plugin.settings, zoneId)` — two
 *    deep copies — so no surface can write through to `plugin.settings`. The
 *    header's Save is the one place that writes back.
 *  - **The shell and the context.** `buildShell` makes the boxes; the
 *    `SurfaceContext` is what every surface is allowed to reach (`surfaces.ts`),
 *    including this leaf's own playlist-row registry — row instances belong to
 *    a leaf, never to the module (bead wadjet-9f9.45).
 *  - **One render per animation frame.** The store batches; this file subscribes
 *    once and hands the state to each surface's `render`, in mount order.
 *  - **View state is not the document** (PLAN D14). `getState()/setState()`
 *    persist the leaf's own slice (zone, window, open windows, colours, drawer
 *    flags) into `workspace.json`, so the leaf comes back pointed at the same
 *    zone after a restart. `rerollSalt` is deliberately *not* persisted: it is
 *    a preview nonce, and restoring it would resurrect a stale audition.
 *
 * Surfaces are mounted in a fixed order and each owns exactly one region and
 * one file, so the remaining studio beads can be written in parallel. Adding a
 * surface is one import and one line in `SURFACES`.
 */
import { ItemView, Notice, Scope, type IconName, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { ZoneProfile } from "../../core/types";
import type WadjetPlugin from "../../plugin/main";
import { applyStash, takeStash } from "../model/stash";
import { initialState } from "../model/state";
import { createStore, type Store } from "../model/store";
import { createAtlasSurface } from "./atlas-surface";
import { createAuditionSurface } from "./audition";
import { createCalendarSurface } from "./calendar-surface";
import { createChannelsSurface } from "./channels-surface";
import { createDevicesSurface } from "./devices-surface";
import { createErasSurface } from "./eras-surface";
import { createHeaderSurface } from "./header";
import { createHintBarSurface } from "./hint-bar";
import { createJsonDrawerSurface } from "./json-drawer";
import { buildShell, type Shell } from "./layout";
import { createMixerSurface } from "./mixer";
import { createMoonsSurface } from "./moons-surface";
import { createPlaylistRegistry, createPlaylistSurface } from "./playlist";
import { createRowsSurface } from "./rows-surface";
import type { Surface, SurfaceContext } from "./surfaces";
import { createWindowManager, type WindowManager } from "./windows";

export const VIEW_TYPE = "wadjet-studio";

/** A Lucide icon Obsidian ships; the studio is weather, one zone at a time. */
const STUDIO_ICON: IconName = "cloud-sun";

/**
 * Mount order. The header goes first because it is the only surface that can
 * change the zone; the hint bar goes second because its delegated listener must
 * be attached before any surface can be hovered.
 */
const SURFACES: ReadonlyArray<() => Surface> = [
  createHeaderSurface,
  createHintBarSurface,
  createPlaylistSurface,
  createMixerSurface,
  createAuditionSurface,
  createJsonDrawerSurface,
  createMoonsSurface,
  createCalendarSurface,
  createDevicesSurface,
  createErasSurface,
  createRowsSurface,
  createAtlasSurface,
  createChannelsSurface,
];

/** The slice of `ViewState` that survives a restart. */
export interface PersistedViewState {
  zoneId: string | null;
  window: { a: number; b: number };
  openWindows: string[];
  windowPos: Record<string, { x: number; y: number; z: number }>;
  colours: { seasons: number[]; eras: number[]; regimes: number[] };
  jsonOpen: boolean;
  fixedOpen: Record<string, boolean>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `workspace.json` is on disk and hand-editable: read it defensively. */
function readPersisted(raw: unknown): Partial<PersistedViewState> {
  if (!isRecord(raw)) return {};
  const out: Partial<PersistedViewState> = {};
  if (typeof raw["zoneId"] === "string" || raw["zoneId"] === null) out.zoneId = raw["zoneId"];
  const w = raw["window"];
  if (isRecord(w) && finite(w["a"]) && finite(w["b"]) && w["b"] > w["a"]) out.window = { a: w["a"], b: w["b"] };
  const open = raw["openWindows"];
  if (Array.isArray(open)) out.openWindows = open.filter((x): x is string => typeof x === "string");
  const pos = raw["windowPos"];
  if (isRecord(pos)) {
    const clean: Record<string, { x: number; y: number; z: number }> = {};
    for (const [id, p] of Object.entries(pos)) {
      if (isRecord(p) && finite(p["x"]) && finite(p["y"]) && finite(p["z"])) clean[id] = { x: p["x"], y: p["y"], z: p["z"] };
    }
    out.windowPos = clean;
  }
  const c = raw["colours"];
  if (isRecord(c)) {
    const ints = (v: unknown): number[] => (Array.isArray(v) ? v.filter(finite) : []);
    out.colours = { seasons: ints(c["seasons"]), eras: ints(c["eras"]), regimes: ints(c["regimes"]) };
  }
  if (typeof raw["jsonOpen"] === "boolean") out.jsonOpen = raw["jsonOpen"];
  const fixed = raw["fixedOpen"];
  if (isRecord(fixed)) {
    const clean: Record<string, boolean> = {};
    for (const [id, v] of Object.entries(fixed)) if (typeof v === "boolean") clean[id] = v;
    out.fixedOpen = clean;
  }
  return out;
}

export class StudioView extends ItemView {
  /**
   * The leaf's store. Public and readonly: the surfaces reach it through their
   * `SurfaceContext`, and the e2e walk reads it off the leaf to drive an edit
   * the way a knob would. Nothing may replace it.
   */
  readonly store: Store;

  private shell: Shell | null = null;
  private surfaces: Surface[] = [];
  /**
   * The floating-window manager. Public and readonly for the same reason
   * `store` is: the e2e walk opens a panel by id off the leaf, the way a chip
   * would. Nothing may replace it.
   */
  readonly windows: WindowManager = createWindowManager();
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: WadjetPlugin,
  ) {
    super(leaf);
    // Obsidian's popout-aware window when it exists (the leaf may live in a
    // second Electron window); plain `window` under a test harness.
    const win: Window = typeof activeWindow === "undefined" ? window : activeWindow;
    const start = plugin.settings.zones[0]?.id ?? null;
    let state = initialState(plugin.settings, start);
    // A leaf closed dirty earlier this session (`onClose` below): reapply the
    // stashed drafts over the fresh copy before anything renders, then clear
    // it — a stash is consumed once, never reused across two reopens.
    if (plugin.studioStash !== undefined) {
      state = applyStash(state, plugin.studioStash);
      delete plugin.studioStash;
    }
    this.store = createStore(state, (flush) => void win.requestAnimationFrame(() => flush()));
    this.navigation = false;
    // Undo/redo belong to the leaf, not to a surface: Obsidian pushes this
    // scope while the studio is the focused view and pops it when it is not,
    // so Ctrl/Cmd+Z here never reaches an editor in another tab.
    const scope = new Scope();
    scope.register(["Mod"], "z", (ev) => {
      ev.preventDefault();
      this.store.undo();
      return false;
    });
    scope.register(["Mod", "Shift"], "z", (ev) => {
      ev.preventDefault();
      this.store.redo();
      return false;
    });
    this.scope = scope;
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getIcon(): IconName {
    return STUDIO_ICON;
  }

  override getDisplayText(): string {
    const zone = this.zone();
    return zone === null ? "Climate studio" : `Climate studio · ${zone.name}`;
  }

  override getState(): Record<string, unknown> {
    const v = this.store.get().view;
    const state: PersistedViewState = {
      zoneId: v.zoneId,
      window: { a: v.window.a, b: v.window.b },
      openWindows: [...v.openWindows],
      windowPos: structuredClone(v.windowPos),
      colours: structuredClone(v.colours),
      jsonOpen: v.jsonOpen,
      fixedOpen: { ...v.fixedOpen },
    };
    return { ...state };
  }

  override setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = readPersisted(state);
    this.store.update((s) => {
      const v = s.view;
      // A zone id that no longer exists opens with no zone selected, never a
      // surface pointed at a missing draft (`initialState`'s rule).
      if (next.zoneId !== undefined) v.zoneId = next.zoneId !== null && next.zoneId in s.zones ? next.zoneId : null;
      if (next.window !== undefined) v.window = next.window;
      if (next.openWindows !== undefined) v.openWindows = next.openWindows;
      if (next.windowPos !== undefined) v.windowPos = next.windowPos;
      if (next.colours !== undefined) v.colours = next.colours;
      if (next.jsonOpen !== undefined) v.jsonOpen = next.jsonOpen;
      if (next.fixedOpen !== undefined) v.fixedOpen = next.fixedOpen;
    });
    // The store's notification is a frame away; the tab title and the header
    // are read straight after setViewState, so repaint now as well.
    this.windows.restore();
    this.render();
    return super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.build();
  }

  override async onClose(): Promise<void> {
    // Obsidian gives `onClose` no way to refuse the close, so a dirty draft
    // is stashed on the plugin instance rather than lost — see
    // `studio/model/stash.ts`. `takeStash` returns `null` for the common
    // case (nothing dirty), so a clean close stashes nothing and says nothing.
    const stash = takeStash(this.store.get(), this.store);
    if (stash !== null) {
      this.plugin.studioStash = stash;
      new Notice("Unsaved studio changes kept until you reopen the studio");
    }
    this.teardown();
    await super.onClose();
  }

  override onResize(): void {
    this.insetStatusBar();
    this.render();
  }

  /**
   * Obsidian's status bar is `position: fixed` at the bottom of the window,
   * over whatever leaf is there, and it exposes no height token. Measure how
   * far it reaches into the studio and pad the root by that much, so the
   * audition strip never ends behind it. Zero when the bar is hidden, when the
   * studio is in a popout window, or when another leaf sits below this one.
   */
  private insetStatusBar(): void {
    const root = this.shell?.root;
    if (root === undefined) return;
    root.style.setProperty("--wadjet-studio-status-h", "0px");
    const bar = root.ownerDocument.querySelector(".status-bar");
    const b = bar?.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const overlaps = b !== undefined && b.height > 0 && b.left < r.right && b.right > r.left;
    const reach = overlaps ? Math.max(0, r.bottom - b.top) : 0;
    root.style.setProperty("--wadjet-studio-status-h", `${Math.ceil(reach)}px`);
  }

  // --- shell ---------------------------------------------------------------

  private build(): void {
    this.contentEl.empty();
    const shell = buildShell(this.contentEl);
    this.shell = shell;

    const ctx: SurfaceContext = {
      plugin: this.plugin,
      store: this.store,
      shell,
      view: this,
      calendar: () => this.plugin.api.calendar(),
      units: () => this.plugin.settings.units,
      windows: this.windows,
      // One registry per BUILD, so a leaf that is torn down and rebuilt starts
      // from an empty row stack and two leaves never share a row instance
      // (bead wadjet-9f9.45).
      rows: createPlaylistRegistry(),
    };

    this.windows.mount(ctx);
    this.surfaces = SURFACES.map((make) => {
      const surface = make();
      surface.mount(ctx);
      return surface;
    });
    // Builders are registered by the surfaces that own their panels, so the
    // restore has to wait until every surface has mounted.
    this.windows.restore();

    this.unsubscribeStore = this.store.subscribe(() => this.render());
    // An edit outside the studio (settings, a pin, a command) rebuilds the world.
    this.unsubscribeSettings = this.plugin.api.on("profiles-changed", () => this.refreshFromSettings());

    this.insetStatusBar();
    this.render();
  }

  private teardown(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    for (const surface of this.surfaces) surface.destroy();
    this.surfaces = [];
    this.windows.destroy();
    this.shell = null;
    this.contentEl.empty();
  }

  private render(): void {
    if (this.shell === null) return;
    const state = this.store.get();
    for (const surface of this.surfaces) surface.render(state);
    this.windows.renderAll(state);
  }

  // --- state ---------------------------------------------------------------

  private zone(): ZoneProfile | null {
    const state = this.store.get();
    const id = state.view.zoneId;
    return id === null ? null : (state.zones[id] ?? null);
  }

  /**
   * The plugin's settings changed outside the studio. Clean drafts adopt the
   * new file; **dirty drafts are left exactly as the user left them** — an
   * external edit must never silently discard unsaved studio work. `saved`
   * always tracks the plugin, so a dirty draft stays dirty against the *new*
   * baseline and the diff the user eventually saves is against what is on disk.
   *
   * Public because the header's `＋ add zone` calls it after `AddZoneModal`
   * closes: the modal writes settings and the studio has to pick the zone up.
   */
  refreshFromSettings(): void {
    const dirty = this.store.dirtyZones();
    const worldDirty = this.store.worldDirty();
    const fresh = initialState(this.plugin.settings, this.store.get().view.zoneId);
    this.store.update((s) => {
      s.saved = fresh.saved;
      for (const id of Object.keys(s.zones)) if (!dirty.has(id) && !(id in fresh.zones)) delete s.zones[id];
      for (const [id, zone] of Object.entries(fresh.zones)) if (!dirty.has(id)) s.zones[id] = zone;
      if (!worldDirty) s.world = fresh.world;
      if (s.view.zoneId !== null && !(s.view.zoneId in s.zones)) s.view.zoneId = null;
    });
  }
}
