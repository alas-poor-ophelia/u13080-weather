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
import { displayName } from "../../model/copy";
import { dragToWhen, hasLane, laneCaption, laneSpec, laneSub, spellRunsKey, type LaneKind, type LaneSpec } from "../../model/device-lanes";
import { toDevice, whenSummary } from "../../model/devices";
import { dayRangeLabel } from "../../model/format";
import { deviceLaneHint, deviceLaneTip, deviceSpanHintKey } from "../../model/hints-device-lanes";
import { spanToPx, type Span } from "../../model/lanes";
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

/** The lane's drawn height — the same thin arrangement lane the regimes and eras rows use. */
const ROW_HEIGHT = 20;

/** A clip narrower than this, or one that close to the right edge, has nowhere to put its caption. */
const CAPTION_MIN_PX = 70;
/** The gap between a clip's right edge and its caption. */
const CAPTION_GAP_PX = 6;
/**
 * The pixels-per-day band a moon lane's caption shows in — the prototype's
 * own `pxDay > 1.6 && pxDay < 20`. Wider and the pulses are far enough apart
 * to read on their own; tighter and the text runs over the next pulse.
 */
const MOON_CAPTION_PX_PER_DAY: readonly [number, number] = [1.6, 20];

/**
 * At or below this density a moon lane draws NOTHING. A pulse is a handful of
 * days; at Era zoom there are thousands of them and `spans.ts` answers with its
 * `many` overflow bar — a bar across the whole window, which reads as "this
 * device is always on" and is the opposite of true. The prototype's own floor
 * (`pxDay > 0.45`) simply leaves the lane empty, and an empty lane at a zoom
 * that cannot draw a pulse is the honest picture.
 */
const PULSE_MIN_PX_PER_DAY = 0.45;

/**
 * A spell over a per-year clip is a CLIP, not a marquee. `spans.ts` marks every
 * span of a spell device `window` so a COMPOSITE `when` reads as "somewhere in
 * here" (dashed, no caps), but a `yp:` / `doy:` span is the same solid,
 * capped, draggable clip it is without the spell — which is how the prototype
 * draws the Ashfall window, and the only reason its rolled runs have an edge to
 * sit inside. Only the drawn kind changes; `editable` and the drag are the
 * lane spec's, untouched.
 */
const YEAR_CLIP = /^(?:yp|doy):/;

function solidYearClips(spec: LaneSpec): LaneSpec {
  if (spec.kind !== "window") return spec;
  const spans = spec.spans.map((s) => (s.kind === "window" && YEAR_CLIP.test(s.id) ? { ...s, kind: "clip" as const } : s));
  const solid = spans.some((s) => s.kind === "clip");
  return solid ? { ...spec, spans, kind: "clip" } : spec;
}

/** The colour of the first chain the device writes into (SPEC §9) — its rack unit's own hue. */
function colourFor(m: { apply: ReadonlyArray<{ param: string }> }): string {
  for (const op of m.apply) {
    const channel = channelOrNull(op.param);
    if (channel !== null) return CHAIN_COLOR_VAR[channel];
  }
  return DEFAULT_COLOR;
}

/**
 * A lane is coloured by what its SHAPE is, not by what the device writes
 * (SPEC §9). A moon lane's pulses are where the moon is, so they wear the
 * moon's hue — painted precipitation blue, the Stormtide row read as a second
 * precipitation curve. A clip or a spell window is a span of calendar, so it
 * wears calendar gold. Everything else falls back to the chain it feeds.
 */
function laneColour(kind: LaneKind, m: { apply: ReadonlyArray<{ param: string }> }): string {
  if (kind === "pulse") return "var(--wadjet-studio-moon)";
  if (kind === "clip" || kind === "window") return DEFAULT_COLOR;
  return colourFor(m);
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
  let captionEl: HTMLElement | null = null;
  /** the calendar's year length, for the caption's day numbers */
  let yearLength = 365;
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

  /**
   * The caption the prototype prints inside the lane.
   *
   *  - a CLIP or a spell window puts it just to the RIGHT of the first span —
   *    `d223 – d263 · 40 d` — so a 40-day window says how long it is without
   *    having to be wide enough to hold the text;
   *  - a MOON lane puts it beside the FIRST pulse — `sable full ↻ 29.5 d ·
   *    gated by Harvest` — because a row of pulses cannot say which moon,
   *    which phase or which gate it is on its own. It shows only in the
   *    prototype's own density band (`MOON_CAPTION_PX_PER_DAY`): wider and the
   *    pulses are days apart with nothing to explain, tighter and the caption
   *    would run over the next one.
   *
   * Outside `.wadjet-studio-lane-spans`, so the Lane's own repaint never has
   * to know about it.
   */
  function caption(spec: { spans: readonly Span[] }, moon: string, geo: RowGeometry): void {
    const el = lane?.el;
    if (el === undefined) return;
    captionEl?.remove();
    captionEl = null;

    if (moon !== "") {
      const [lo, hi] = MOON_CAPTION_PX_PER_DAY;
      if (geo.morph.pxPerDay <= lo || geo.morph.pxPerDay >= hi) return;
      const pulse = spec.spans.find((s) => s.kind === "pulse");
      if (pulse === undefined) return;
      const { left, width } = spanToPx(pulse, geo.lane);
      captionEl = el.createSpan({ cls: "wadjet-studio-device-caption is-lead", text: moon });
      captionEl.setCssProps({ "--wadjet-studio-device-caption-left": `${Math.max(0, left + width) + CAPTION_GAP_PX}px` });
      return;
    }

    const clip = spec.spans.find((s) => s.kind === "clip" || s.kind === "window");
    if (clip === undefined) return;
    const { left, width } = spanToPx(clip, geo.lane);
    if (width < CAPTION_MIN_PX || left + width > geo.widthPx - CAPTION_MIN_PX) return;
    const days = Math.round((clip.to - clip.from) * yearLength);
    const range = dayRangeLabel(clip.from, clip.to - clip.from, yearLength);
    captionEl = el.createSpan({ cls: "wadjet-studio-device-caption", text: `${range} · ${days} d` });
    captionEl.setCssProps({ "--wadjet-studio-device-caption-left": `${left + width + CAPTION_GAP_PX}px` });
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
    label: displayName(modifierId),
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
        height: ROW_HEIGHT,
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
        captionEl?.remove();
        captionEl = null;
        lane?.update({ spans: [], geometry: geo.lane });
        return;
      }
      yearLength = Math.max(1, cal.yearLength);
      const drawn = solidYearClips(laneSpec(m, cal, geo.window, m.spell === undefined ? undefined : activeDays(state, geo.window)));
      const device = toDevice(m, ctx?.calendar() ?? null);
      const moon = laneCaption(device, cal);
      // A moon lane below the prototype's density floor draws nothing at all
      // (see `PULSE_MIN_PX_PER_DAY`); everything else keeps its own overflow.
      const hidden = moon !== "" && geo.morph.pxPerDay <= PULSE_MIN_PX_PER_DAY;
      const spec: LaneSpec = hidden ? { ...drawn, spans: [] } : drawn;
      const colour = laneColour(spec.kind, m);
      lane?.update({ geometry: geo.lane, spans: spec.spans, color: colour });
      caption(spec, moon, geo);
      lane?.el.setAttrs({ "data-kind": spec.kind, "data-editable": String(spec.editable) });
      decorate(spec.spans);
      // The lane's own hue leads the label, so a glance down the column tells
      // you which chain each device writes into before you read a word.
      host?.dot.setCssProps({ "--wadjet-studio-row-dot-color": colour });
      host?.name.setText(displayName(m.id));
      host?.sub.setText(laneSub(m, cal));
      host?.label.setAttr("data-hint", deviceLaneTip(spec.label, whenSummary(device, cal.yearLength)));
    },

    destroy() {
      captionEl?.remove();
      captionEl = null;
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
      // The eras decide whether an `era:`-gated device has a timeline at all,
      // so a world edit that adds or removes an era re-syncs the row stack.
      const wanted = zone === null ? [] : devices(zone).filter((m) => hasLane(m, state.world.eras)).map((m) => m.id);
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
