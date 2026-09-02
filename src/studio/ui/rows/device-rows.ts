/**
 * The **device lanes** (SPEC §4, §5) — one playlist row per zone device with a
 * time predicate, in rack order, under the Eras lane. Nothing here is
 * hand-built: the rows *are* the zone's `modifiers[]`, so adding a device adds
 * a row, reordering the rack reorders the rows, and removing the device takes
 * its row with it.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **The rows are data, so one row manages the rest.** `playlist.ts` mounts
 *    one `Row` per registered `PlaylistRow` and its registry is the leaf's,
 *    filled at mount time — it has no notion of a row that comes and goes.
 *    So this file registers ONE row, `devices`, which draws nothing (it is
 *    `display: none`) and whose `render` is `syncDeviceRows`: it registers a
 *    `device:<id>` row for every device that `hasLane`, retires the ones whose
 *    device is gone, and keeps each row's `order` at `ROW_ORDER.devices +
 *    rackIndex`. `registerRow`/`unregisterRow` re-enter `render` through the
 *    playlist's own `sync`, so the manager holds its child rows by identity and
 *    guards the re-entry — a fresh `PlaylistRow` object per tick would make the
 *    playlist destroy and remount every lane forever.
 *  - **Order has a ceiling.** `ROW_ORDER.devices` is 30 and `automation` is 40,
 *    so the tenth device is the last one that can sort above the automation
 *    lane; past that the rows share order 39 and fall back to sorting by id.
 *    Widening the gap is a `ROW_ORDER` change, and `ROW_ORDER` is not ours.
 *  - **The spans are pure, the roll is not.** `model/device-lanes.ts` answers
 *    "what shape is this lane" without a roll; a *spell* also needs the days it
 *    actually ran, which only a roll knows, so this file gathers
 *    `AuditionDay.active` for the years on screen and hands them in. That is
 *    bounded by `MAX_SPELL_ROLL_YEARS` and memoised on the roll's own key, so a
 *    pan or a zoom never re-rolls.
 *  - **Read-only shapes are read-only here.** SPEC §4 sends a season band to
 *    the Calendar, an era bar to the Eras lane and a moon pulse to CYCLE and
 *    the MOD gates; `dragToWhen` returns `null` for all three, so a drag on one
 *    writes nothing even if the Lane were ever to offer it.
 */
import { rollCached, type AuditionInput } from "../../model/audition";
import { channelOrNull, devices } from "../../model/compile";
import { dragToWhen, hasLane, laneSpec, spellRunsKey } from "../../model/device-lanes";
import { toDevice, whenSummary } from "../../model/devices";
import { deviceLaneHint, deviceLaneTip, deviceSpanHintKey } from "../../model/hints-device-lanes";
import type { Span } from "../../model/lanes";
import { CHAIN_COLOR_VAR } from "../../model/mixer";
import type { StudioState } from "../../model/state";
import type { Window } from "../../model/zoom";
import { createLane, type LaneComponent } from "../components";
import { registerRow, ROW_ORDER, unregisterRow, type PlaylistRow, type RowGeometry, type RowHost } from "../playlist";
import { spanCalendarFor } from "../ruler";
import { openCycleFor } from "../windows/cycle";
import { deviceWindowId } from "../windows/device";

/** The manager row's id (SPEC §3.2's `devices` slot). It draws nothing. */
export const DEVICE_ROWS_ID = "devices";

/** Row ids are `device:<modifierId>` — the same key `deviceWindowId` opens the panel under. */
export const DEVICE_ROW_PREFIX = "device:";

export function deviceRowId(modifierId: string): string {
  return `${DEVICE_ROW_PREFIX}${modifierId}`;
}

/**
 * The widest window a spell's rolled runs are gathered for. A run is a handful
 * of days; past a few years the solid marks are thinner than a pixel and the
 * rolls are not worth their milliseconds. The dashed `when` window still draws
 * at every zoom — only the runs stop.
 */
export const MAX_SPELL_ROLL_YEARS = 4;

/** The last order a device row may take before it would sort past the automation lane. */
const MAX_DEVICE_ORDER_OFFSET = ROW_ORDER.automation - ROW_ORDER.devices - 1;

/** A lane with no colour of its own falls back to the calendar's gold, as the Lane component does. */
const DEFAULT_COLOR = "var(--wadjet-studio-gold)";

/** The colour of the first chain the device writes into (SPEC §9) — its rack unit's own hue. */
function colourFor(m: { apply: ReadonlyArray<{ param: string }> }): string {
  for (const op of m.apply) {
    const channel = channelOrNull(op.param);
    if (channel !== null) return CHAIN_COLOR_VAR[channel];
  }
  return DEFAULT_COLOR;
}

/** The zone the surfaces are pointed at, or `null`. */
function zoneOf(state: StudioState) {
  const id = state.view.zoneId;
  return id === null ? null : (state.zones[id] ?? null);
}

/** `moon:<name>:<cycle>` → `<name>`; the cycle index is the LAST segment, and a moon may be named anything. */
function moonOfSpan(span: Span): string | null {
  const head = "moon:";
  if (!span.id.startsWith(head)) return null;
  const tail = span.id.lastIndexOf(":");
  return tail > head.length - 1 ? span.id.slice(head.length, tail) : null;
}

/** The calendar years `[a, b)` touches; `b` on an exact boundary belongs to the year before it. */
function yearsIn(w: Window): number[] {
  const first = Math.floor(w.a);
  const last = Math.max(first, Math.ceil(w.b) - 1);
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

// ---------------------------------------------------------------------------
// One device's row
// ---------------------------------------------------------------------------

/**
 * The row for one device. Built by the manager, which owns its `order` and its
 * lifetime; the factory takes only the modifier id, so the row survives every
 * edit to the device except a rename (which changes the id, and therefore the
 * row).
 */
export function createDeviceRow(modifierId: string): PlaylistRow {
  let host: RowHost | null = null;
  let lane: LaneComponent | null = null;
  /** the last gathered runs, and the roll key they were gathered under */
  let runsMemo: { key: string; days: Array<{ dayOrdinal: number; active: boolean }> } | null = null;

  function modifier(state: StudioState) {
    const zone = zoneOf(state);
    return zone === null ? null : (zone.modifiers.find((m) => m.id === modifierId) ?? null);
  }

  function auditionInput(state: StudioState, year: number): AuditionInput | null {
    const ctx = host?.ctx;
    if (ctx === undefined) return null;
    const time = ctx.plugin.time.active ?? null;
    const zone = zoneOf(state);
    if (time === null || zone === null) return null;
    return { zone, eras: state.world.eras, seed: ctx.plugin.settings.worldSeed, adapter: time, year, salt: state.view.rerollSalt, overrides: state.world.overrides };
  }

  /**
   * The days on screen with "did this modifier fire" against each, from the
   * studio's one rolled-year cache (`model/audition.ts rollCached`), so a year
   * the audition strip or a channel row has already rolled costs nothing here.
   * `undefined` when there is nothing to roll, the window is too wide, or the
   * adapter cannot reach the year at all — an empty lane is a better answer
   * than a dead leaf (SPEC §8).
   */
  function activeDays(state: StudioState, w: Window): Array<{ dayOrdinal: number; active: boolean }> | undefined {
    const years = yearsIn(w);
    if (years.length > MAX_SPELL_ROLL_YEARS) return undefined;
    const probe = auditionInput(state, years[0] ?? 0);
    const m = modifier(state);
    if (probe === null || m === null) return undefined;
    // The whole identity of what the runs are, not a sketch of it: the
    // modifier's and the eras' CONTENT are in the key, so editing a spell's
    // chance or an era's span invalidates the memo (`model/device-lanes.ts`).
    const key = spellRunsKey({ modifier: m, eras: state.world.eras, seed: probe.seed, salt: probe.salt, firstYear: years[0] ?? 0, years: years.length });
    const memo = runsMemo;
    if (memo !== null && memo.key === key) return memo.days;

    const days: Array<{ dayOrdinal: number; active: boolean }> = [];
    for (const year of years) {
      const input = auditionInput(state, year);
      if (input === null) continue;
      try {
        for (const day of rollCached(input).days) days.push({ dayOrdinal: day.dayOrdinal, active: day.active.includes(modifierId) });
      } catch {
        return undefined;
      }
    }
    runsMemo = { key, days };
    return days;
  }

  /** Per-span hint, applied after every `lane.update` repaint (the eras lane's pattern). */
  function decorate(spans: readonly Span[]): void {
    const el = lane?.el;
    if (el === undefined) return;
    const byId = new Map(spans.map((s) => [s.id, s]));
    for (const node of Array.from(el.querySelectorAll(".wadjet-studio-span"))) {
      const span = node as HTMLElement;
      const id = span.getAttribute("data-id") ?? "";
      const model = byId.get(id);
      if (model === undefined) continue;
      span.setAttrs({
        "data-span-from": String(model.from),
        "data-span-to": String(model.to),
        "data-hint": deviceLaneHint(deviceSpanHintKey(id === "many" ? "many" : model.kind)),
      });
    }
  }

  /** A drop on an editable clip: the new modifier, written as one undoable action (SPEC §3.8). */
  function write(span: Span, from: number, to: number): void {
    const ctx = host?.ctx;
    if (ctx === undefined) return;
    const state = ctx.store.get();
    const m = modifier(state);
    const cal = spanCalendarFor(ctx, state);
    if (m === null || cal === null) return;
    const next = dragToWhen(m, span, from, to, cal);
    if (next === null) return;
    ctx.store.update(
      (s) => {
        const zone = zoneOf(s);
        if (zone === null) return;
        const at = zone.modifiers.findIndex((x) => x.id === modifierId);
        if (at >= 0) zone.modifiers[at] = next;
      },
      { history: true },
    );
  }

  function onMove(span: Span, from: number): void {
    write(span, from, from + (span.to - span.from));
  }

  function onResize(span: Span, zone: "start" | "end", to: number): void {
    if (zone === "start") write(span, to, span.to);
    else write(span, span.from, to);
  }

  /** SPEC law 2: a moon pulse reaches the moon, everything else reaches the device. */
  function onOpen(span: Span): void {
    const ctx = host?.ctx;
    if (ctx === undefined) return;
    const moon = span.kind === "pulse" ? moonOfSpan(span) : null;
    if (moon !== null) {
      openCycleFor(ctx, moon);
      return;
    }
    ctx.windows.open(deviceWindowId(modifierId));
  }

  function openDevice(): void {
    host?.ctx.windows.open(deviceWindowId(modifierId));
  }

  function onLabelKey(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openDevice();
  }

  return {
    id: deviceRowId(modifierId),
    label: modifierId,
    order: ROW_ORDER.devices,

    mount(next) {
      host = next;
      next.row.el.addClass("wadjet-studio-device-row");
      next.row.el.setAttr("data-device", modifierId);
      next.label.addClass("wadjet-studio-device-row-label");
      next.label.setAttrs({ role: "button", tabindex: "0", "data-hint": deviceLaneHint("lane.device") });
      next.label.addEventListener("click", openDevice);
      next.label.addEventListener("keydown", onLabelKey);

      lane = createLane(next.body, {
        geometry: { x0: 0, pxPerYear: 1, windowFrom: 0, edgePx: 4 },
        spans: [],
        color: DEFAULT_COLOR,
        onMove,
        onResize,
        onOpen,
      });
      lane.el.addClass("wadjet-studio-device-lane");
      lane.el.setAttr("data-hint", deviceLaneHint("lane.device.lane"));
    },

    render(state, geo: RowGeometry) {
      const ctx = host?.ctx;
      const m = modifier(state);
      const cal = ctx === undefined ? null : spanCalendarFor(ctx, state);
      if (m === null || cal === null) {
        lane?.update({ spans: [], geometry: geo.lane });
        return;
      }
      const spec = laneSpec(m, cal, geo.window, m.spell === undefined ? undefined : activeDays(state, geo.window));
      lane?.update({ geometry: geo.lane, spans: spec.spans, color: colourFor(m) });
      lane?.el.setAttrs({ "data-kind": spec.kind, "data-editable": String(spec.editable) });
      decorate(spec.spans);
      host?.label.setAttr("data-hint", deviceLaneTip(spec.label, whenSummary(toDevice(m, ctx?.calendar() ?? null), cal.yearLength)));
    },

    destroy() {
      lane?.destroy();
      lane = null;
      host?.label.removeEventListener("click", openDevice);
      host?.label.removeEventListener("keydown", onLabelKey);
      host?.label.removeClass("wadjet-studio-device-row-label");
      host?.row.el.removeClass("wadjet-studio-device-row");
      host = null;
      runsMemo = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

/**
 * The one row `ui/rows-surface.ts` registers. It has no lane and no pixels; its
 * `render` is the sync that keeps a `device:<id>` row alive for every device
 * with a time predicate (SPEC §4 "every zone device with a time predicate gets
 * a lane automatically, in rack order").
 */
export function createDeviceRowsManager(): PlaylistRow {
  let host: RowHost | null = null;
  /** the child rows by modifier id, held by IDENTITY: `registerRow` replaces a row whose object differs */
  const rows = new Map<string, PlaylistRow>();
  /** `registerRow`/`unregisterRow` re-enter this row's `render` through the playlist's own `sync` */
  let syncing = false;

  function syncDeviceRows(state: StudioState): void {
    const ctx = host?.ctx;
    if (ctx === undefined || syncing) return;
    syncing = true;
    try {
      const zone = zoneOf(state);
      const wanted = zone === null ? [] : devices(zone).filter(hasLane).map((m) => m.id);
      const keep = new Set(wanted);

      for (const id of [...rows.keys()]) {
        if (keep.has(id)) continue;
        rows.delete(id);
        unregisterRow(ctx, deviceRowId(id));
      }

      wanted.forEach((id, index) => {
        const order = ROW_ORDER.devices + Math.min(index, MAX_DEVICE_ORDER_OFFSET);
        const existing = rows.get(id);
        if (existing !== undefined) {
          // Same object, new `order`: the playlist re-sorts the stack without
          // destroying the lane (its `sync` only tears a row down when the
          // registry no longer holds the object it mounted).
          if (existing.order === order) return;
          existing.order = order;
          registerRow(ctx, existing);
          return;
        }
        const row = createDeviceRow(id);
        row.order = order;
        rows.set(id, row);
        registerRow(ctx, row);
      });
    } finally {
      syncing = false;
    }
  }

  return {
    id: DEVICE_ROWS_ID,
    label: "",
    order: ROW_ORDER.devices,

    mount(next) {
      host = next;
      next.row.el.addClass("wadjet-studio-device-rows-manager");
    },

    render(state) {
      syncDeviceRows(state);
    },

    destroy() {
      // The child rows are the playlist's to unmount — it destroys everything in
      // its `mounted` map with the leaf. Only the registry entries are ours.
      const ctx = host?.ctx;
      for (const id of [...rows.keys()]) {
        rows.delete(id);
        if (ctx !== undefined) unregisterRow(ctx, deviceRowId(id));
      }
      host?.row.el.removeClass("wadjet-studio-device-rows-manager");
      host = null;
    },
  };
}
