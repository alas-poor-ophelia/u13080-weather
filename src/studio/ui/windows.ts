/**
 * The floating-window manager (SPEC §3.4).
 *
 * Windows are *relational* (SPEC law 2): a surface opens one because something
 * on screen was clicked, and it opens it by id. The manager owns the id → panel
 * mapping so no two surfaces can fight over the same panel, and so the set of
 * open windows survives a restart through the leaf's view state.
 *
 * Three things it guarantees for the surfaces that use it:
 *
 *  - **One panel per id.** `open("atlas", …)` twice focuses the existing panel.
 *  - **z is last touch.** Focusing a panel gives it the highest z and persists
 *    that into `view.windowPos[id].z`, so the stacking a user arranged comes
 *    back with the leaf.
 *  - **Content is pulled, not pushed.** A builder hands over `writes()`,
 *    `issues()`, `level()` and `badge()` *closures*; `renderAll(state)` calls
 *    them every tick, so a panel that is open while its subject changes
 *    repaints without its owner having to hold a reference to it. `issuesFor`
 *    is run once per tick here (not once per open window) and handed to every
 *    `level` getter as a `byUnit` map, so eight open windows never each
 *    re-validate the draft.
 *
 * A builder is registered per id and kept after the panel closes, which is what
 * makes `restore()` possible: `view.openWindows` holds ids, not panels.
 */
import { createWindow, type LedLevel, type LedProps, type WindowComponent, type WindowIssue, type WindowPreset } from "./components";
import { CASCADE_ORIGIN, cascadePosition, defaultPosition } from "../model/clamp";
import type { StudioState } from "../model/state";
import { issuesByUnit, issuesFor, type StudioIssue } from "../model/validation";
import type { ZoneProfile } from "../../core/types";
import type { SurfaceContext } from "./surfaces";

/** What a builder returns: the chrome, the body, and four pull-based readouts. */
export interface WindowBuild {
  title: string;
  /** the panel's content; the manager appends it and drops it on close */
  body: HTMLElement;
  /** the title-bar LED's static props (`on`, `scope`, `hint`) — `level` supplies its colour */
  led?: LedProps;
  /**
   * The title-bar LED's colour, re-read every render against the shared
   * `byUnit` map `renderAll` computes once per tick (SPEC §3.9) — a window
   * calls `ledLevel(byUnit.get(unitKey(...)))` with its own unit's key.
   */
  level?: (byUnit: ReadonlyMap<string, StudioIssue[]>) => LedLevel;
  /** short kind badge — DEVICE, ERA, STATES … a function re-reads it every render (e.g. Atlas's mode, a device's KIND) */
  badge?: string | (() => string);
  /** the kind pill's colour; defaults to the badge's own kind hue (`model/copy.ts`'s `kindColor`) */
  badgeColor?: string;
  /** the dim caption after the kind pill — the unit's place in the signal path (`slot 00 · every chain`) */
  caption?: string;
  /**
   * Fills the bar's free slot between the caption and the spacer, once, at
   * open — a Köppen readout, a calendar-source pill, an era's whole title row
   * (`components/window.ts`'s `head`). The panel owns what it puts there.
   */
  head?: (slot: HTMLElement) => void;
  /**
   * The panel's width in px, from the prototype. Set at open and never
   * re-read: a panel's width is a design constant, not a function of its
   * content. Omitting it lets the widest child size the panel, which is the
   * defect the F1 pass exists to close — every window should name one.
   */
  width?: number;
  preset?: WindowPreset;
  /** makes the title bar's name inline-editable (SPEC §3.4: one title row, no boxed input in the body) */
  onRename?: (name: string) => void;
  /** the `WRITES` footer, re-read every render (SPEC law 5) */
  writes?: () => string;
  /** the issue line under the footer, re-read every render (SPEC §3.9) */
  issues?: () => StudioIssue[];
  /** called after the panel is torn down, whether by × or by `close(id)` */
  onClose?: () => void;
}

export type WindowBuilder = (ctx: SurfaceContext) => WindowBuild;

export interface WindowManager {
  /** Called once by `view.ts`, before any surface mounts. */
  mount(ctx: SurfaceContext): void;
  /** Make `id` openable — and restorable — without opening it now. */
  register(id: string, build: WindowBuilder): void;
  /** Open `id`, or focus it when it is already open. `build` registers first. */
  open(id: string, build?: WindowBuilder): void;
  close(id: string): void;
  isOpen(id: string): boolean;
  /** Raise `id` to the top and persist the new z. */
  focus(id: string): void;
  /** Open every id in `view.openWindows` that has a registered builder. */
  restore(): void;
  /** Repaint the open panels' `writes` / issue lines / chrome LED / badge. Called once per tick. */
  renderAll(state: StudioState): void;
  /** Tear down every panel. View state is left alone, so `restore()` can undo it. */
  destroy(): void;
}

interface OpenWindow {
  build: WindowBuild;
  component: WindowComponent;
  /** last painted values, so a tick that changed nothing touches no DOM */
  writes: string;
  issues: string;
  level: LedLevel | undefined;
  badge: string;
  /** the preset control's option names, joined — a panel that SAVES one has to offer it back */
  presetKey: string;
}

const issueLevel = (level: StudioIssue["level"]): WindowIssue["level"] => (level === "error" ? "error" : "warn");

/**
 * Where a panel with no remembered position opens, in the prototype's own
 * 1560×960 coordinates (`Component.DEFPOS`, `1397-logic-class-Component.js`
 * l.155): forcings low and central under the playlist, atlas high and left,
 * the four channel editors stepped down the left margin. `defaultPosition`
 * scales the point into whatever box this leaf actually has.
 *
 * Ids with a `:` are matched on their PREFIX, because the prototype has one
 * entry for the one moon / era / channel it ships and this studio has many.
 * Anything with no entry — every device panel — keeps the cascade, which is
 * the right behaviour for a set whose size the prototype never fixed.
 */
const DEFAULT_POS: ReadonlyArray<readonly [string, { x: number; y: number }]> = [
  ["forcings", { x: 640, y: 330 }],
  ["regimes", { x: 720, y: 130 }],
  ["seasons", { x: 680, y: 120 }],
  ["atlas", { x: 390, y: 60 }],
  ["cycle:", { x: 500, y: 110 }],
  ["era:", { x: 540, y: 110 }],
  ["channel:temperature", { x: 36, y: 64 }],
  ["channel:precipitation", { x: 48, y: 58 }],
  ["channel:wind", { x: 60, y: 76 }],
  ["channel:sky", { x: 54, y: 70 }],
];

/** The prototype's start point for `id`, or `null` when it has none. */
export function defaultPosFor(id: string): { x: number; y: number } | null {
  for (const [key, at] of DEFAULT_POS) if (key.endsWith(":") ? id.startsWith(key) : id === key) return at;
  return null;
}

/** `state.view.zoneId`'s draft, or `null` off-zone — every window validates the same one the mixer and header do. */
function zoneOf(state: StudioState): ZoneProfile | null {
  const id = state.view.zoneId;
  return id === null ? null : (state.zones[id] ?? null);
}

export function createWindowManager(): WindowManager {
  let ctx: SurfaceContext | null = null;
  const builders = new Map<string, WindowBuilder>();
  const open = new Map<string, OpenWindow>();

  /** One above every z the view state remembers, so a new panel lands on top. */
  function topZ(): number {
    const pos = ctx?.store.get().view.windowPos ?? {};
    let z = 0;
    for (const p of Object.values(pos)) z = Math.max(z, p.z);
    return z + 1;
  }

  function persist(id: string, pos: { x: number; y: number; z: number }, opened: boolean): void {
    ctx?.store.update((s) => {
      s.view.windowPos[id] = pos;
      const at = s.view.openWindows.indexOf(id);
      if (opened && at < 0) s.view.openWindows.push(id);
      if (!opened && at >= 0) s.view.openWindows.splice(at, 1);
    });
  }

  /**
   * `issuesFor`, mapped by unit — computed once per tick (or once at open) and
   * handed to every window's `level` getter, so eight open windows do not each
   * re-run the validators (SPEC §3.9). Empty off-zone, same as the mixer and
   * the header treat it.
   */
  function deriveByUnit(state: StudioState): Map<string, StudioIssue[]> {
    const c = ctx;
    const zone = zoneOf(state);
    if (c === null || zone === null) return new Map();
    const description = c.calendar();
    const readOnlyCalendar = description?.readOnly ?? false;
    const seasons = readOnlyCalendar ? (description?.seasons ?? []) : state.world.calendar.seasons;
    const moons = readOnlyCalendar ? (description?.moons ?? []) : state.world.calendar.moons;
    return issuesByUnit(issuesFor({ zone, eras: state.world.eras, seasons, moons, readOnlyCalendar }));
  }

  function paint(id: string, entry: OpenWindow, byUnit: ReadonlyMap<string, StudioIssue[]>): void {
    if (entry.build.writes !== undefined) {
      const writes = entry.build.writes();
      if (writes !== entry.writes) {
        entry.writes = writes;
        entry.component.update({ writes });
      }
    }
    if (entry.build.issues !== undefined) {
      const issues = entry.build.issues();
      const key = issues.map((i) => `${i.level}:${i.message}`).join("|");
      if (key !== entry.issues) {
        entry.issues = key;
        entry.component.update({ issues: issues.map((i) => ({ level: issueLevel(i.level), msg: i.message })) });
      }
    }
    if (entry.build.level !== undefined) {
      const level = entry.build.level(byUnit);
      if (level !== entry.level) {
        entry.level = level;
        entry.component.update({ led: { ...(entry.build.led ?? { on: true }), level } });
      }
    }
    if (entry.build.badge !== undefined) {
      const badge = typeof entry.build.badge === "function" ? entry.build.badge() : entry.build.badge;
      if (badge !== entry.badge) {
        entry.badge = badge;
        entry.component.update({ badge });
      }
    }
    // The preset `▾` is built once, so a preset SAVED from the panel used to
    // stay out of its own picker until the window was closed and reopened. A
    // reader (`options: () => …`) plus this re-pull puts it back on the tick
    // the save lands, and the list is rebuilt only when it actually changed.
    if (entry.build.preset !== undefined) {
      const key = presetKeyOf(entry.build.preset);
      if (key !== entry.presetKey) {
        entry.presetKey = key;
        entry.component.update({ preset: entry.build.preset });
      }
    }
  }

  /** The preset control's offered names, joined, so a repaint is one string compare. */
  function presetKeyOf(preset: WindowPreset): string {
    return (typeof preset.options === "function" ? preset.options() : preset.options).join(" | ");
  }

  const manager: WindowManager = {
    mount(next) {
      ctx = next;
    },

    register(id, build) {
      builders.set(id, build);
    },

    open(id, build) {
      if (build !== undefined) builders.set(id, build);
      if (open.has(id)) {
        manager.focus(id);
        return;
      }
      const builder = builders.get(id);
      const context = ctx;
      if (builder === undefined || context === null) return;

      const built = builder(context);
      const remembered = context.store.get().view.windowPos[id];
      const boxW = context.shell.windows.clientWidth;
      const boxH = context.shell.windows.clientHeight;
      // A remembered position always wins; failing that, the prototype's own
      // start point for this panel; failing that, the cascade.
      const proto = defaultPosFor(id);
      const start = proto === null ? cascadePosition(open.size, boxW, boxH) : defaultPosition(proto.x, proto.y, boxW, boxH);
      const pos = {
        x: remembered?.x ?? start.x,
        y: remembered?.y ?? start.y,
        z: topZ(),
      };
      const byUnit = deriveByUnit(context.store.get());
      const level = built.level?.(byUnit);
      const led = level !== undefined ? { ...(built.led ?? { on: true }), level } : built.led;
      const badge = typeof built.badge === "function" ? built.badge() : built.badge;
      const component = createWindow(context.shell.windows, {
        title: built.title,
        ...(led !== undefined ? { led } : {}),
        ...(badge !== undefined ? { badge } : {}),
        ...(built.badgeColor !== undefined ? { badgeColor: built.badgeColor } : {}),
        ...(built.caption !== undefined ? { caption: built.caption } : {}),
        ...(built.head !== undefined ? { head: built.head } : {}),
        ...(built.width !== undefined ? { width: built.width } : {}),
        ...(built.preset !== undefined ? { preset: built.preset } : {}),
        ...(built.onRename !== undefined ? { onRename: built.onRename } : {}),
        x: pos.x,
        y: pos.y,
        z: pos.z,
        draggable: true,
        body: built.body,
        ...(built.writes !== undefined ? { writes: built.writes() } : {}),
        onClose: () => manager.close(id),
        onFocus: () => manager.focus(id),
        onMove: (x, y) => {
          const current = ctx?.store.get().view.windowPos[id];
          persist(id, { x, y, z: current?.z ?? pos.z }, true);
        },
      });

      const entry: OpenWindow = { build: built, component, writes: built.writes?.() ?? "", issues: "", level, badge: badge ?? "", presetKey: built.preset === undefined ? "" : presetKeyOf(built.preset) };
      open.set(id, entry);
      persist(id, pos, true);
      paint(id, entry, byUnit);
    },

    close(id) {
      const entry = open.get(id);
      if (entry === undefined) return;
      open.delete(id);
      entry.component.destroy();
      const pos = ctx?.store.get().view.windowPos[id];
      if (pos !== undefined) persist(id, pos, false);
      entry.build.onClose?.();
    },

    isOpen: (id) => open.has(id),

    focus(id) {
      const entry = open.get(id);
      if (entry === undefined) return;
      const current = ctx?.store.get().view.windowPos[id];
      // Already on top: raising it again would churn view state every pointerdown.
      if (current !== undefined && current.z === topZ() - 1) return;
      const pos = { x: current?.x ?? CASCADE_ORIGIN, y: current?.y ?? CASCADE_ORIGIN, z: topZ() };
      entry.component.update({ z: pos.z });
      persist(id, pos, true);
    },

    restore() {
      const ids = ctx?.store.get().view.openWindows ?? [];
      for (const id of [...ids]) if (builders.has(id) && !open.has(id)) manager.open(id);
    },

    renderAll(state) {
      if (open.size === 0) return;
      const byUnit = deriveByUnit(state);
      for (const [id, entry] of open) {
        paint(id, entry, byUnit);
        // The studio box may have just shrunk (view.ts's onResize re-renders): keep
        // every open panel's title bar reachable inside it (SPEC §3.4).
        const moved = entry.component.reclamp();
        if (moved !== null) {
          const current = ctx?.store.get().view.windowPos[id];
          persist(id, { x: moved.x, y: moved.y, z: current?.z ?? topZ() - 1 }, true);
        }
      }
    },

    destroy() {
      for (const [, entry] of open) entry.component.destroy();
      open.clear();
      builders.clear();
      ctx = null;
    },
  };

  return manager;
}
