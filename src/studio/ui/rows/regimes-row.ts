/**
 * The **Regimes** row (SPEC §3.2, §6; PLAN D2, §5.1) — the zone's rolled
 * day-to-day states, drawn from the real roll and never drawn on.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **It is the roll, not a model of one.** The blocks come from
 *    `model/audition.ts`'s `rollYear` → `AuditionYear.regimeRuns`, the same
 *    call the audition strip makes with the same seed, salt, eras, pins and
 *    hemisphere flip. Nothing here re-implements `regSeq` (PLAN D2): a block
 *    edge is a day the generator actually changed state on.
 *  - **Two shapes, chosen by the morph.** At Year zoom and tighter
 *    (`geo.morph.showBands`) every year the window touches is rolled and each
 *    run becomes one tinted block. At Era zoom — and at any window wider than
 *    `MAX_ROLL_YEARS`, which is the loop guard, not a style — the row collapses
 *    to the share bar: one segment per state, `shareOfYear` wide, laid edge to
 *    edge across the window. A 1100-year window never rolls 1100 years.
 *  - **Never editable.** `editable: false` on every span and no `onCreate` /
 *    `onMove` / `onResize` / `onDelete` handler, so the Lane offers no grab
 *    edges and no create drag. The only gestures are click (open the Regimes
 *    window on that state) and hover (the dwell tip).
 *  - **One rebuild per change, and never a roll on the tick.** `renderKey`
 *    folds the roll's identity (`auditionKey` with the year factored out), the
 *    window, the measured width and the colour overrides into one string; an
 *    unchanged key returns before anything is painted. A change that needs no
 *    new roll (a pan, a zoom, a colour) repaints immediately; a change that
 *    does waits out `ROLL_DEBOUNCE_MS + ROLL_GAP_MS`, so a knob drag rolls
 *    once, after the audition strip, instead of once per store tick in front
 *    of it.
 *
 * The roll itself is `model/audition.ts`'s one bounded `rollCached` — the same
 * cache the audition strip and the channel rows read, so a year this row needs
 * is a year the strip has usually already paid for. This file only wraps it in
 * the `try` below, because a third-party calendar that cannot reach the year
 * throws and an empty row is a better answer than a dead leaf.
 */
import { validateProfile } from "../../../core/profile";
import { auditionKey, isRolled, rollCached, shareOfYear, type AuditionInput, type AuditionYear } from "../../model/audition";
import { regimeBlockTip, regimeShareTip, rowHint } from "../../model/hints-rows";
import { hitTest, pxToYear, type LaneGeometry, type Span } from "../../model/lanes";
import { colourOf, laneSub } from "../../model/regimes";
import type { StudioState } from "../../model/state";
import { ROLL_DEBOUNCE_MS } from "../audition";
import { createLane, type LaneComponent } from "../components";
import { ROW_ORDER, type PlaylistRow, type RowGeometry, type RowHost } from "../playlist";
import { spanCalendarFor } from "../ruler";
import { buildRegimesWindow, REGIMES_WINDOW, selectRegime } from "../windows/regimes";

/** Beyond this many years in the window the blocks are unreadable and the rolls unaffordable: the share bar takes over. */
export const MAX_ROLL_YEARS = 6;

/**
 * How much later than the audition strip this row re-rolls. The strip's own
 * debounce is the studio's budget for "a draft edit shows up" (SPEC §3.5), and
 * the two caches are separate, so a cold draft is two rolls: this one takes
 * the second turn rather than making the strip wait behind it.
 */
export const ROLL_GAP_MS = 30;

/**
 * A block narrower than this has no room for its state's id; the tip still
 * names it. The prototype's own threshold, and it is a *width* rather than a
 * zoom so a long run at Year zoom still reads.
 */
const LABEL_MIN_PX = 54;

/** Below this the run is a few pixels wide and a name inside it is noise, however long the run. */
const LABEL_MIN_PX_PER_DAY = 3;

/** The lane's drawn height — the thin arrangement lane the whole device stack shares. */
const ROW_HEIGHT = 20;

/** The row's three shapes, so the DOM says which one it is drawing. */
export type RowMode = "blocks" | "share" | "empty";

/** One drawn span and everything the tint, the tip and the click need. */
interface RegimeSpan {
  span: Span;
  /** the state's id — `record.regime`, the thing devices gate on */
  regime: string;
  colour: string;
  /** the run's length in days; 0 for a share-bar segment, which has no dwell to read */
  days: number;
  /** the state's share of the year; only meaningful on a share-bar segment */
  share: number;
  /**
   * How loudly the block reads (SPEC §9: "colour reserved for data"). A state
   * that writes nothing is the quiet background weather and sits at a fifth of
   * full; one that applies something is the event you are looking for.
   */
  alpha: number;
}

/** The prototype's three weights: a spell that writes, one that does not, and the selected one. */
const ALPHA_PLAIN = 0.22;
const ALPHA_APPLIES = 0.55;
const ALPHA_SHARE = 0.45;

/**
 * The studio's shared `rollCached`, or `null` when the adapter cannot reach the
 * year at all (`firstDayOfYear` throws for a third-party calendar that cannot
 * describe one). An empty row is a better answer than a dead leaf.
 */
function rollOrNull(input: AuditionInput): AuditionYear | null {
  try {
    return rollCached(input);
  } catch {
    return null;
  }
}

/**
 * The years calendar-year `[Y, Y + 1)` blocks must be rolled for to cover
 * `[a, b)`. `b` on an exact year boundary belongs to the year before it, so a
 * `[1005, 1006]` window is one year and not two.
 */
export function yearsIn(a: number, b: number): number[] {
  const first = Math.floor(a);
  const last = Math.max(first, Math.ceil(b) - 1);
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

/**
 * The share bar (SPEC §6): one segment per state, `weight × dwell` normalised
 * wide, laid edge to edge across the window so the bar always fills it. A
 * draft whose weights are all zero has no share to divide — it is also a draft
 * the validator rejects, so the row is empty by then; the equal split is only
 * the arithmetic's own answer, never a drawn one.
 */
export function shareSegments(regimes: ReadonlyArray<{ id: string }>, a: number, b: number, shares: ReadonlyArray<{ id: string; share: number }>): Array<{ id: string; from: number; to: number; share: number }> {
  const total = shares.reduce((sum, s) => sum + s.share, 0);
  const even = total <= 0;
  const width = b - a;
  const out: Array<{ id: string; from: number; to: number; share: number }> = [];
  let x = a;
  regimes.forEach((r, i) => {
    const share = even ? 1 / Math.max(1, regimes.length) : (shares[i]?.share ?? 0);
    // The last segment lands on `b` exactly: the widths are floats and the
    // e2e holds the bar to "sums to the window".
    const to = i === regimes.length - 1 ? b : x + share * width;
    out.push({ id: r.id, from: x, to, share });
    x = to;
  });
  return out;
}

/**
 * Which of the three shapes the row draws. Blocks need a rollable draft, the
 * `showBands` morph (Year zoom and tighter) *and* a window short enough to
 * roll; everything else that still has a draft collapses to the share bar.
 */
export function modeFor(o: { hasZone: boolean; showBands: boolean; years: number }): RowMode {
  if (!o.hasZone) return "empty";
  return o.showBands && o.years <= MAX_ROLL_YEARS ? "blocks" : "share";
}

export function createRegimesRow(): PlaylistRow {
  let host: RowHost | null = null;
  let lane: LaneComponent | null = null;
  /** every drawn span, in draw order, and the same list by id for the pointer */
  let items: RegimeSpan[] = [];
  let spans: Span[] = [];
  let byId = new Map<string, RegimeSpan>();
  /** the painted span elements, so a tip update never has to build a selector out of a state's id */
  let nodes = new Map<string, HTMLElement>();
  /** the geometry the last paint used, for the row's own hit testing */
  let geometry: LaneGeometry | null = null;
  /** the last `RowGeometry` the playlist measured, so the debounced roll can paint without one */
  let lastGeo: RowGeometry | null = null;
  let yearLength = 1;
  let memo = "";
  let timer: number | null = null;

  // --- the roll ------------------------------------------------------------

  function inputFor(state: StudioState, year: number): AuditionInput | null {
    const c = host?.ctx;
    if (c === undefined) return null;
    const time = c.plugin.time.active ?? null;
    if (time === null) return null;
    const id = state.view.zoneId;
    const zone = id === null ? undefined : state.zones[id];
    if (zone === undefined) return null;
    return { zone, eras: state.world.eras, seed: c.plugin.settings.worldSeed, adapter: time, year, salt: state.view.rerollSalt, overrides: state.world.overrides };
  }

  // --- what to draw --------------------------------------------------------

  /**
   * Everything that can change the row's pixels, in one string: the roll's
   * identity with the year factored out (`auditionKey` at a fixed year covers
   * the seed, the salt, the profile, the calendar, the eras, the flip and the
   * pins), the years on screen, the window, the measured density and the
   * per-state colour overrides.
   */
  function renderKey(state: StudioState, geo: RowGeometry, mode: RowMode): string {
    const input = inputFor(state, 0);
    const base = input === null ? "nozone" : auditionKey(input);
    const w = geo.window;
    return `${base}|${mode}|${w.a}|${w.b}|${Math.round(geo.widthPx)}|${state.view.colours.regimes.join(",")}`;
  }

  /** The rolled runs of every year the window touches, as tinted blocks. */
  function blocks(state: StudioState, geo: RowGeometry, index: Map<string, number>, writes: Set<string>): RegimeSpan[] {
    const out: RegimeSpan[] = [];
    for (const year of yearsIn(geo.window.a, geo.window.b)) {
      const input = inputFor(state, year);
      if (input === null) continue;
      const rolled = rollOrNull(input);
      if (rolled === null) continue;
      for (const run of rolled.regimeRuns) {
        // Fractional years the way `spans.ts` defines them: year Y's day k is
        // `Y + k / yearLength`, the same mapping the ruler's ticks use, so a
        // block edge lands on the tick of the day it changed state on.
        const from = year + run.from / yearLength;
        const to = year + (run.to + 1) / yearLength;
        const days = run.to - run.from + 1;
        const at = index.get(run.regime);
        const wide = (to - from) * geo.pxPerYear >= LABEL_MIN_PX && geo.morph.pxPerDay >= LABEL_MIN_PX_PER_DAY;
        const label = wide ? run.regime : null;
        out.push({
          span: {
            id: `regime:${year}:${run.from}:${run.regime}`,
            from,
            to,
            kind: "clip",
            editable: false,
            ...(at === undefined ? { dim: true } : {}),
            ...(label === null ? {} : { label }),
          },
          regime: run.regime,
          colour: colourOf(at ?? 0, state.view.colours.regimes),
          days,
          share: 0,
          alpha: writes.has(run.regime) ? ALPHA_APPLIES : ALPHA_PLAIN,
        });
      }
    }
    return out;
  }

  /** The Era-zoom collapse: one segment per state, share-of-the-year wide. */
  function shareBar(state: StudioState, geo: RowGeometry): RegimeSpan[] {
    const id = state.view.zoneId;
    const zone = id === null ? undefined : state.zones[id];
    if (zone === undefined) return [];
    const shares = shareOfYear(zone.regimes);
    // No labels: the collapse is a proportion bar, and the sub-label above it
    // already spells every share out (SPEC §3.2 "collapses to the share bar").
    return shareSegments(zone.regimes, geo.window.a, geo.window.b, shares).map((seg, i) => ({
      span: { id: `share:${seg.id}`, from: seg.from, to: seg.to, kind: "bar" as const, editable: false },
      regime: seg.id,
      colour: colourOf(i, state.view.colours.regimes),
      days: 0,
      share: seg.share,
      alpha: ALPHA_SHARE,
    }));
  }

  // --- painting ------------------------------------------------------------

  /** The tip a span carries: the dwell so far for a block, the share for a segment. */
  function tipFor(item: RegimeSpan, day: number): string {
    return item.days > 0 ? regimeBlockTip(item.regime, day, item.days) : regimeShareTip(item.regime, item.share);
  }

  /**
   * What the Lane component does not do for us: the per-span tint (it paints
   * one colour per lane), the `data-span-*` the walk reads, and each span's
   * own `data-hint`. The Lane repaints synchronously inside `update`, so the
   * elements are already there when this runs.
   */
  function decorate(): void {
    const el = lane?.el;
    nodes = new Map<string, HTMLElement>();
    if (el === undefined) return;
    for (const node of Array.from(el.querySelectorAll<HTMLElement>(".wadjet-studio-span"))) {
      const id = node.getAttribute("data-id");
      const item = id === null ? undefined : byId.get(id);
      if (id === null || item === undefined) continue;
      nodes.set(id, node);
      node.setCssProps({ "--wadjet-studio-span-color": item.colour, "--wadjet-studio-span-alpha": String(item.alpha) });
      node.setAttr("data-span-from", String(item.span.from));
      node.setAttr("data-span-to", String(item.span.to));
      node.setAttr("data-regime", item.regime);
      if (item.days > 0) node.setAttr("data-span-days", String(item.days));
      node.setAttr("data-hint", tipFor(item, 1));
    }
  }

  // --- the pointer ---------------------------------------------------------

  /**
   * The dwell reading moves with the pointer *inside* one block, and the hint
   * bar re-reads `data-hint` only on `mouseover` — which does not fire again
   * while the pointer stays on the same element. So when the day under the
   * pointer changes, the block re-announces itself with a synthetic bubbling
   * `mouseover`: the hint bar's one delegated listener picks it up exactly as
   * it would a real one, and nothing else in the studio listens for that event.
   */
  function onPointerMove(ev: PointerEvent): void {
    const g = geometry;
    const el = lane?.el;
    if (g === null || el === undefined || spans.length === 0) return;
    const x = ev.clientX - el.getBoundingClientRect().left;
    const hit = hitTest(spans, x, g);
    if (hit === null) return;
    const item = byId.get(hit.span.id);
    const node = nodes.get(hit.span.id);
    if (item === undefined || node === undefined) return;
    const into = Math.floor((pxToYear(x, g) - item.span.from) * yearLength) + 1;
    const day = Math.min(Math.max(1, item.days), Math.max(1, into));
    const attr = tipFor(item, day);
    if (node.getAttribute("data-hint") === attr) return;
    node.setAttr("data-hint", attr);
    node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  }

  function onOpen(span: Span): void {
    const item = byId.get(span.id);
    const c = host?.ctx;
    if (item === undefined || c === undefined) return;
    // `build` is passed so the row works whether or not the mixer (which also
    // registers this window) has mounted yet; `open` re-registers idempotently.
    c.windows.open(REGIMES_WINDOW, buildRegimesWindow);
    selectRegime(item.regime);
  }

  // --- when to draw --------------------------------------------------------

  /** What the row would draw for this state and geometry, without rolling anything. */
  function plan(state: StudioState, geo: RowGeometry): { mode: RowMode; broken: boolean; cal: ReturnType<typeof spanCalendarFor>; zone: StudioState["zones"][string] | undefined; key: string } {
    const c = host?.ctx;
    const cal = c === undefined ? null : spanCalendarFor(c, state);
    const id = state.view.zoneId;
    const zone = id === null ? undefined : state.zones[id];
    // The same predicate `rollYear` uses to refuse a draft: a zone the
    // validator rejects has no roll and no honest share, so the lane empties
    // and the label says why (SPEC §3.7).
    const broken = zone !== undefined && validateProfile(zone).some((i) => i.level === "error");
    const mode = modeFor({ hasZone: zone !== undefined && cal !== null && !broken, showBands: geo.morph.showBands, years: yearsIn(geo.window.a, geo.window.b).length });
    return { mode, broken, cal, zone, key: renderKey(state, geo, mode) };
  }

  /** True when every year the blocks need is already rolled — a repaint that costs nothing. */
  function warm(state: StudioState, geo: RowGeometry): boolean {
    for (const year of yearsIn(geo.window.a, geo.window.b)) {
      const input = inputFor(state, year);
      if (input === null) continue;
      if (!isRolled(input)) return false;
    }
    return true;
  }

  function win(): Window {
    return host?.ctx.shell.root.ownerDocument.defaultView ?? window;
  }

  /**
   * Roll when the edits stop, exactly as the audition strip does (PLAN D11) —
   * plus `ROLL_GAP_MS`, so this row's roll lands *after* the strip's. The two
   * share a key but not a cache (see the header), so a cold draft costs one
   * roll here and one there; taking the second turn keeps the strip's own
   * debounce budget its own.
   */
  function schedule(): void {
    const w = win();
    if (timer !== null) w.clearTimeout(timer);
    timer = w.setTimeout(flush, ROLL_DEBOUNCE_MS + ROLL_GAP_MS);
  }

  function flush(): void {
    timer = null;
    const c = host?.ctx;
    const geo = lastGeo;
    if (c === undefined || geo === null || lane === null) return;
    const state = c.store.get();
    paint(state, geo, plan(state, geo));
  }

  // --- the paint -----------------------------------------------------------

  function paint(state: StudioState, geo: RowGeometry, p: ReturnType<typeof plan>): void {
    const l = lane;
    const h = host;
    if (l === null || h === null) return;
    memo = p.key;

    yearLength = Math.max(1, p.cal?.yearLength ?? 1);
    const regimes = p.zone?.regimes ?? [];
    const index = new Map(regimes.map((r, i) => [r.id, i]));
    const writes = new Set(regimes.filter((r) => (r.apply ?? []).length > 0).map((r) => r.id));
    items = p.mode === "blocks" ? blocks(state, geo, index, writes) : p.mode === "share" ? shareBar(state, geo) : [];
    spans = items.map((i) => i.span);
    byId = new Map(items.map((i) => [i.span.id, i]));

    const hint = rowHint(p.broken ? "row.regimes.issues" : p.mode === "share" ? "row.regimes.share" : "row.regimes");
    h.name.setText(p.broken ? "regimes · fix issues" : "Regimes");
    h.sub.setText(p.broken || p.zone === undefined ? "the draft has errors" : laneSub(p.zone));
    h.label.setAttr("data-hint", hint);
    h.body.setAttr("data-hint", hint);

    geometry = geo.lane;
    l.el.setAttr("data-mode", p.mode);
    l.el.setAttr("data-year-length", String(yearLength));
    l.update({ geometry: geo.lane, spans });
    decorate();
  }

  // --- the row -------------------------------------------------------------

  return {
    id: "regimes",
    label: "Regimes",
    order: ROW_ORDER.regimes,

    mount(next) {
      host = next;
      next.label.setAttr("data-hint", rowHint("row.regimes"));
      next.body.setAttr("data-hint", rowHint("row.regimes"));
      next.dot.setCssProps({ "--wadjet-studio-row-dot-color": "var(--wadjet-studio-text-mute)" });
      lane = createLane(next.body, {
        geometry: { x0: 0, pxPerYear: 1, windowFrom: 0, edgePx: 4 },
        spans: [],
        height: ROW_HEIGHT,
        color: "var(--wadjet-studio-moon)",
        onOpen,
      });
      // Not `…-regimes-row`: the Regimes *window* already owns that class for
      // its state rows (`ui/windows/regimes.ts`), and a shared class would put
      // this lane's rules on those rows and this row's probes on that panel.
      lane.el.addClass("wadjet-studio-regimes-lane");
      lane.el.addEventListener("pointermove", onPointerMove);
    },

    render(state, geo) {
      const l = lane;
      if (l === null || host === null) return;
      lastGeo = geo;

      const p = plan(state, geo);
      if (p.key === memo) return;

      // A pan, a zoom or a colour change needs no new roll: those repaint now,
      // on the tick that asked for them. Anything that DOES need one waits for
      // the edits to stop — a knob drag is dozens of ticks and a year costs
      // ~20 ms even warm, so rolling inline would jank every drag and stand in
      // front of the audition's own debounce.
      if (p.mode === "blocks" && !warm(state, geo)) {
        l.update({ geometry: geo.lane });
        // `Lane.paint` rebuilds every span element from scratch, so the
        // per-span tint, `data-span-*` and tip this row adds on top are gone
        // the moment the geometry moves. Re-decorate: until the debounced roll
        // lands the blocks are the PREVIOUS roll's, and they should read as
        // themselves — a stripped, uncoloured, untipped lane is not a truer
        // picture of "still rolling", it is just a broken one.
        decorate();
        geometry = geo.lane;
        schedule();
        return;
      }
      paint(state, geo, p);
    },

    destroy() {
      if (timer !== null) win().clearTimeout(timer);
      timer = null;
      lane?.el.removeEventListener("pointermove", onPointerMove);
      lane?.destroy();
      lane = null;
      host = null;
      items = [];
      spans = [];
      byId = new Map();
      nodes = new Map();
      geometry = null;
      lastGeo = null;
      memo = "";
    },
  };
}
