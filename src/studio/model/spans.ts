/**
 * Data-driven lane spans: `spansFor(when, spell, cal, opts)` turns a device's
 * `when` predicate into the spans one Lane component draws (SPEC §4, §3.2).
 * Pure — no DOM, no Obsidian, no roll: the calendar arrives as a plain
 * description (`CalendarDescription`-shaped) and a spell's rolled runs arrive
 * separately as an `active` array from the audition (`spellRuns`).
 *
 * Coordinates are fractional years throughout, the units `zoom.ts` uses:
 * `epochYear + dayOrdinal / yearLength`, so calendar year Y occupies
 * `[Y, Y + 1)` and yearPhase `p` of year Y is `Y + p`. That is the internal
 * calendar's own model (`InternalCalendar.toContext`); a third-party adapter
 * with variable-length years is APPROXIMATED by it. The DOM half can pass an
 * adapter-derived mapping later without changing this contract.
 *
 * Two conventions the SPEC table leaves unsaid:
 *
 * - Spans are **not clipped** to the window, only filtered to those that
 *   overlap it. An editable clip keeps its true edges at every zoom — a
 *   clipped edge would give `hitTest` a resize handle at the window border and
 *   a drag there would write a wrong `when`. The lane clips visually. The
 *   exceptions are the rows whose definition is itself window-shaped: the era
 *   bar, `not`'s complement, and the overflow bar.
 * - `[]` means "this predicate has no lane" (SPEC: `chance`, `regime`,
 *   always, an unrecognised tag). Inside `all`/`any` such a leaf is IGNORED
 *   rather than treated as empty — `all[season:Winter, chance 0.2]` is still a
 *   Winter lane. A `season:`/`era:` tag the calendar does not have (or a
 *   disabled era) is timed-and-empty instead: it does mute a composite,
 *   because that tag can never be on a day.
 */
import type { ModGate, Predicate, SpellSpec } from "../../core/types";
import { seasonAtPhase } from "../../plugin/time/seasons";
import type { Span } from "./lanes";
import { zoomLabel, type Window } from "./zoom";

/**
 * The calendar facts the lanes need, a subset of `CalendarDescription` plus
 * the world's eras and the zone's hemisphere flip. Years are the calendar's
 * own year numbers; `from` on a season is a yearPhase in [0, 1).
 */
export interface SpanCalendar {
  yearLength: number;
  epochYear: number;
  seasons: ReadonlyArray<{ name: string; from: number }>;
  moons: ReadonlyArray<{ name: string; cycleDays: number; phaseAtEpoch?: number }>;
  eras: ReadonlyArray<{ name: string; from: number; to?: number; enabled?: boolean }>;
  flipSeasons?: boolean;
}

export interface SpanOptions {
  window: Window;
  /**
   * Beyond this many spans the lane is unreadable anyway: `spansFor` returns a
   * single `bar` covering the window, labelled `…`. Also the loop guard —
   * counts are estimated before any per-year or per-cycle loop runs, so a
   * 1100-year window never iterates 13 000 moon cycles.
   */
  maxSpans?: number;
  /** the device's mod-matrix gates; they dim the pulses they hold OUTSIDE the source (D19) */
  gates?: ReadonlyArray<ModGate>;
}

/** Default `SpanOptions.maxSpans` (SPEC §4 has no lane worth drawing past this). */
export const DEFAULT_MAX_SPANS = 400;

/**
 * A pulse reads as gated once the gates have taken it to half strength or less
 * (the prototype's rule: dim when 1 − amount ≤ 0.5, i.e. a single gate at
 * `amount` ≥ 0.5). A threshold, not a per-pulse opacity, so the DOM a lane
 * builds is the same whatever the amount is.
 */
export const GATE_DIM_AT = 0.5;

/** Fractional years are `epochYear + fraction`, so widths lose a few ULPs to cancellation. */
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

/**
 * `dayOrdinal` as a fractional year: `epochYear + dayOrdinal / yearLength`,
 * the internal calendar's model (`InternalCalendar.toContext`, where
 * `year = floor(d / yearLength) + epochYear` and `yearPhase = dayOfYear / yearLength`).
 * Adapters with variable-length years are approximated by it.
 */
export function fractionalYear(dayOrdinal: number, cal: SpanCalendar): number {
  return cal.epochYear + dayOrdinal / cal.yearLength;
}

/** The inverse of `fractionalYear`. */
export function dayOrdinalAt(year: number, cal: SpanCalendar): number {
  return (year - cal.epochYear) * cal.yearLength;
}

/**
 * A moon's phase on `dayOrdinal`, `((d / cycleDays) + phaseAtEpoch) mod 1` —
 * the same formula `InternalCalendar.toContext` hands the predicate, so a
 * pulse's edge lands exactly where `inPhaseRange` flips.
 */
export function moonPhaseAt(moon: SpanCalendar["moons"][number], dayOrdinal: number): number {
  return wrap1((dayOrdinal / moon.cycleDays + (moon.phaseAtEpoch ?? 0)) % 1);
}

function wrap1(x: number): number {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}

// ---------------------------------------------------------------------------
// Intervals (the composite rows work on these, not on spans)
// ---------------------------------------------------------------------------

interface Interval {
  from: number;
  to: number;
}

/** Sorted, with overlapping and touching intervals merged and empties dropped. */
function normalize(iv: readonly Interval[]): Interval[] {
  const sorted = [...iv].filter((x) => x.to - x.from > EPS).sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.from <= last.to + EPS) last.to = Math.max(last.to, x.to);
    else out.push({ from: x.from, to: x.to });
  }
  return out;
}

/** Both inputs normalized; a linear sweep of the pairwise overlaps. */
function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    const from = Math.max(x.from, y.from);
    const to = Math.min(x.to, y.to);
    if (to - from > EPS) out.push({ from, to });
    if (x.to < y.to) i++;
    else j++;
  }
  return out;
}

/** The gaps in `a` (normalized) within `w`. */
function complement(a: readonly Interval[], w: Window): Interval[] {
  const out: Interval[] = [];
  let cursor = w.a;
  for (const x of a) {
    if (x.from > cursor + EPS) out.push({ from: cursor, to: Math.min(x.from, w.b) });
    cursor = Math.max(cursor, x.to);
    if (cursor >= w.b) break;
  }
  if (w.b > cursor + EPS) out.push({ from: cursor, to: w.b });
  return out.filter((x) => x.to - x.from > EPS);
}

function clampTo(x: Interval, w: Window): Interval {
  return { from: Math.max(x.from, w.a), to: Math.min(x.to, w.b) };
}

/** Does `[from, to)` show at all in `w`? Touching an edge is not overlapping. */
function overlaps(from: number, to: number, w: Window): boolean {
  return to > w.a + EPS && from < w.b - EPS;
}

// ---------------------------------------------------------------------------
// The derivation (SPEC §4, one branch per row)
// ---------------------------------------------------------------------------

/**
 * A predicate's contribution. `timed` is false for the shapes that carry no
 * time at all (always, `chance`, `regime`, an unrecognised tag) — a composite
 * ignores those instead of intersecting them away. `overflow` propagates
 * `maxSpans` out of a nested leaf.
 */
interface Derived {
  spans: Span[];
  timed: boolean;
  overflow: boolean;
}

const UNTIMED: Derived = { spans: [], timed: false, overflow: false };
const OVERFLOW: Derived = { spans: [], timed: true, overflow: true };

function timed(spans: Span[]): Derived {
  return { spans, timed: true, overflow: false };
}

function overflowBar(w: Window): Span[] {
  return [{ id: "many", from: w.a, to: w.b, kind: "bar", editable: false, label: "…" }];
}

/** The calendar years that can touch `w`, one either side for spans that cross a boundary. */
function yearsIn(w: Window): { y0: number; y1: number; count: number } {
  const y0 = Math.floor(w.a) - 1;
  const y1 = Math.floor(w.b) + 1;
  return { y0, y1, count: y1 - y0 + 1 };
}

/** One span per calendar year for the segment `[startPhase, startPhase + lengthYears)`. */
function perYear(startPhase: number, lengthYears: number, w: Window, max: number, mk: (year: number, from: number, to: number) => Span): Derived {
  if (!(lengthYears > 0)) return timed([]);
  const { y0, y1, count } = yearsIn(w);
  if (count > max) return OVERFLOW;
  const spans: Span[] = [];
  for (let y = y0; y <= y1; y++) {
    const from = y + startPhase;
    const to = from + lengthYears;
    if (overlaps(from, to, w)) spans.push(mk(y, from, to));
  }
  return timed(spans);
}

/**
 * `yearPhase [a, b]` — one editable clip per year. A wrapping range (`a > b`)
 * is ONE span from `year + a` to `year + 1 + b`, not two halves: fractional
 * years are continuous, so the clip that crosses new year is one clip and one
 * drag. `a === b` is the engine's "never" (`inPhaseRange`), so no spans.
 */
function yearPhaseSpans(range: readonly [number, number], w: Window, max: number): Derived {
  if (range[0] === range[1]) return timed([]);
  const a = wrap1(range[0]);
  const b = wrap1(range[1]);
  const length = b > a ? b - a : 1 - a + b;
  return perYear(a, length, w, max, (year, from, to) => ({ id: `yp:${year}`, from, to, kind: "clip", editable: true }));
}

/**
 * `dayOfYear [a, b]` — the same clip after dividing by `yearLength`. The
 * engine compares `d >= a && d <= b` on the day index, so both ends are
 * INCLUSIVE (day `b` occupies `[b/L, (b+1)/L)`) and the range never wraps:
 * `a > b` matches nothing.
 */
function dayOfYearSpans(range: readonly [number, number], cal: SpanCalendar, w: Window, max: number): Derived {
  const len = cal.yearLength;
  const lo = Math.max(0, Math.min(range[0], len - 1));
  const hi = Math.max(0, Math.min(range[1], len - 1));
  if (range[0] > range[1]) return timed([]);
  return perYear(lo / len, (hi + 1 - lo) / len, w, max, (year, from, to) => ({ id: `doy:${year}`, from, to, kind: "clip", editable: true }));
}

/**
 * `moon {name, phase: [a, b]}` — one pulse per cycle: `from` is the fractional
 * year the moon enters phase `a`, `to` where it leaves `b` (wrapping when
 * `a > b`). Cycle index `k` is absolute (`phase a` recurs at
 * `(k + a − phaseAtEpoch)·cycleDays`), so ids survive panning. A pulse is
 * dimmed where the device's gates hold it at `GATE_DIM_AT` or below at the
 * pulse's midpoint — that is, outside the source (D19). Not editable — the CYCLE editor and the MOD gates own it.
 */
function moonSpans(m: { name: string; phase: readonly [number, number] }, cal: SpanCalendar, opts: SpanOptions, max: number): Derived {
  const moon = cal.moons.find((x) => x.name === m.name);
  if (!moon || !(moon.cycleDays > 0)) return timed([]);
  if (m.phase[0] === m.phase[1]) return timed([]);
  const a = wrap1(m.phase[0]);
  const b = wrap1(m.phase[1]);
  const arc = b > a ? b - a : 1 - a + b;
  const lengthDays = arc * moon.cycleDays;

  const w = opts.window;
  const dayA = dayOrdinalAt(w.a, cal);
  const dayB = dayOrdinalAt(w.b, cal);
  const offset = a - (moon.phaseAtEpoch ?? 0);
  const kLo = Math.floor((dayA - lengthDays) / moon.cycleDays - offset);
  const kHi = Math.ceil(dayB / moon.cycleDays - offset);
  if (kHi - kLo + 1 > max) return OVERFLOW;

  const spans: Span[] = [];
  for (let k = kLo; k <= kHi; k++) {
    const startDay = (k + offset) * moon.cycleDays;
    const from = fractionalYear(startDay, cal);
    const to = fractionalYear(startDay + lengthDays, cal);
    if (!overlaps(from, to, w)) continue;
    const dim = gateFactorAt((from + to) / 2, cal, opts.gates) <= GATE_DIM_AT;
    spans.push({ id: `moon:${m.name}:${k}`, from, to, kind: "pulse", editable: false, ...(dim ? { dim: true } : {}) });
  }
  return timed(spans);
}

/**
 * `tag season:X` — the season's band, one per year, read-only (the Calendar
 * window edits it). The last season wraps the year boundary, exactly as
 * `seasonAtPhase` reads it: phases before the first mark belong to the last
 * one. `flipSeasons` shifts every band half a year, the mirror of
 * `flipSeasonTags` querying `yearPhase + 0.5`.
 */
function seasonSpans(name: string, cal: SpanCalendar, w: Window, max: number): Derived {
  const sorted = [...cal.seasons].sort((x, y) => x.from - y.from);
  const i = sorted.findIndex((s) => s.name === name);
  if (i === -1) return timed([]);
  const from = sorted[i]!.from;
  const next = i + 1 < sorted.length ? sorted[i + 1]!.from : sorted[0]!.from + 1;
  const length = next - from;
  const start = cal.flipSeasons === true ? wrap1(from - 0.5) : from;
  return perYear(start, length, w, max, (year, a, b) => ({ id: `season:${name}:${year}`, from: a, to: b, kind: "band", editable: false, label: name }));
}

/**
 * `tag era:X` — read-only either way (the Eras lane edits it). At Era zoom
 * (window wider than 4 years) a clip over the era's own years, `to` inclusive
 * so it runs to the end of that year and an open era runs to the window's
 * end. At Year zoom and tighter a full-window bar, but only when the era
 * covers the window's centre year. A disabled era tags nothing, so no spans.
 */
function eraSpans(name: string, cal: SpanCalendar, w: Window): Derived {
  const era = cal.eras.find((e) => e.name === name);
  if (!era || era.enabled === false) return timed([]);
  if (zoomLabel(w) === "era") {
    const from = era.from;
    const to = era.to === undefined ? w.b : era.to + 1;
    if (!(to > from) || !overlaps(from, to, w)) return timed([]);
    return timed([{ id: `era:${name}`, from, to, kind: "clip", editable: false, label: name }]);
  }
  const centreYear = Math.floor((w.a + w.b) / 2);
  const covers = era.from <= centreYear && (era.to === undefined || era.to >= centreYear);
  if (!covers) return timed([]);
  return timed([{ id: `era:${name}`, from: w.a, to: w.b, kind: "bar", editable: false, label: name }]);
}

/**
 * The engine's `gateFactor` read off the calendar at fractional year `t`
 * (PLAN §0 D19): a gate is ×1 on a day carrying its source tag and
 * ×(1 − amount) on every other day, and gates multiply. Sources the lane
 * cannot resolve from the calendar (a tag written by another device) are
 * treated as absent, the same way the engine sees them on a day without them.
 */
function gateFactorAt(t: number, cal: SpanCalendar, gates: SpanOptions["gates"]): number {
  if (!gates) return 1;
  let f = 1;
  for (const g of gates) if (!gateSourceOnDay(g.source, t, cal)) f *= 1 - g.amount;
  return f;
}

/** Is a gate's `season:`/`era:` tag on the day at fractional year `t`? */
function gateSourceOnDay(source: string, t: number, cal: SpanCalendar): boolean {
  if (source.startsWith("season:")) return seasonNameAt(t, cal) === source.slice("season:".length);
  if (source.startsWith("era:")) {
    const era = cal.eras.find((e) => e.name === source.slice("era:".length));
    const year = Math.floor(t);
    return era !== undefined && era.enabled !== false && era.from <= year && (era.to === undefined || era.to >= year);
  }
  return false;
}

/** The season tagged on the day at fractional year `t`, honouring `flipSeasons`. */
function seasonNameAt(t: number, cal: SpanCalendar): string | null {
  if (cal.seasons.length === 0) return null;
  const phase = wrap1(cal.flipSeasons === true ? t + 0.5 : t);
  return seasonAtPhase(cal.seasons, phase);
}

/** `all` / `any` — the intersection / union of the timed leaves. Composites are never editable. */
function compositeSpans(leaves: readonly Predicate[], mode: "all" | "any", cal: SpanCalendar, opts: SpanOptions, max: number): Derived {
  const sets: Interval[][] = [];
  for (const leaf of leaves) {
    const r = derive(leaf, cal, opts, max);
    if (r.overflow) return OVERFLOW;
    if (!r.timed) continue;
    sets.push(normalize(r.spans));
  }
  if (sets.length === 0) return UNTIMED;
  let acc = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    acc = mode === "all" ? intersect(acc, sets[i]!) : normalize([...acc, ...sets[i]!]);
  }
  return timed(compositeOut(acc, mode, opts.window));
}

function compositeOut(iv: readonly Interval[], prefix: string, w: Window): Span[] {
  const visible = iv.filter((x) => overlaps(x.from, x.to, w));
  return visible.map((x, i) => ({ id: `${prefix}:${i}`, from: x.from, to: x.to, kind: "window", editable: false }));
}

function derive(p: Predicate | undefined, cal: SpanCalendar, opts: SpanOptions, max: number): Derived {
  if (!p) return UNTIMED;
  const w = opts.window;
  if ("all" in p) return compositeSpans(p.all, "all", cal, opts, max);
  if ("any" in p) return compositeSpans(p.any, "any", cal, opts, max);
  if ("not" in p) {
    const inner = derive(p.not, cal, opts, max);
    if (inner.overflow) return OVERFLOW;
    if (!inner.timed) return UNTIMED;
    const covered = normalize(inner.spans.map((s) => clampTo(s, w)));
    return timed(compositeOut(complement(covered, w), "not", w));
  }
  if ("moon" in p) return moonSpans(p.moon, cal, opts, max);
  if ("yearPhase" in p) return yearPhaseSpans(p.yearPhase, w, max);
  if ("dayOfYear" in p) return dayOfYearSpans(p.dayOfYear, cal, w, max);
  if ("tag" in p) {
    if (p.tag.startsWith("season:")) return seasonSpans(p.tag.slice("season:".length), cal, w, max);
    if (p.tag.startsWith("era:")) return eraSpans(p.tag.slice("era:".length), cal, w);
    return UNTIMED; // a tag another modifier sets: no time to draw
  }
  return UNTIMED; // regime (roll time only) and chance (a mixer chip, SPEC §4)
}

/**
 * The lane for one device's `when` + `spell` (SPEC §4). Rows that carry no
 * time — always, `chance`, `regime`, an unrecognised tag — give `[]`: no lane.
 *
 * With a `spell` the `when` spans become `window` (the lane draws them
 * dashed): the device fires *somewhere inside* them, not across them. Only
 * the kind changes — a `yearPhase` clip stays `editable`, since dragging it
 * still writes `when` exactly as SPEC §4 promises; the spell's own knobs are
 * separate. The solid runs are `spellRuns(...)`, which needs the roll, so the
 * caller concatenates them:
 * `[...spansFor(when, spell, cal, opts), ...spellRuns(days, cal, window)]`.
 *
 * Past `maxSpans` the answer is one `bar` (id `many`, label `…`) across the
 * window — the lane says "too many to draw", it never guesses.
 */
export function spansFor(when: Predicate | undefined, spell: SpellSpec | undefined, cal: SpanCalendar, opts: SpanOptions): Span[] {
  const max = Math.max(1, opts.maxSpans ?? DEFAULT_MAX_SPANS);
  const r = derive(when, cal, opts, max);
  if (r.overflow || r.spans.length > max) return overflowBar(opts.window);
  if (!spell) return r.spans;
  return r.spans.map((s) => ({ ...s, kind: "window" }));
}

/**
 * The rolled half of a spell lane: consecutive active days grouped into solid
 * `run` spans, in fractional years (a day covers `[d, d + 1)`). `activeDays`
 * must be in ascending `dayOrdinal` order; a gap in the ordinals breaks a run,
 * as in `regimeRuns`.
 *
 * Sourcing `active` is the caller's job, and the honest options are unequal:
 * when the device declares a `tag`, `AuditionDay.record.tags.includes(tag)` is
 * exact — that is the field to read. Without a tag there is no exact source
 * today: `ModifierEngine.forDay` builds `DailyModifierResult.active` (the ids
 * of the modifiers that fired) but `DailyRecord` does not carry it, and
 * differencing rolled against unrolled records would confuse a spell that
 * happened to change nothing with one that did not fire. Surfacing `active`
 * on `DailyRecord` (or on the audition) is the fix.
 */
export function spellRuns(activeDays: ReadonlyArray<{ dayOrdinal: number; active: boolean }>, cal: SpanCalendar, window: Window): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  let last = 0;
  const flush = (): void => {
    if (start === null) return;
    const from = fractionalYear(start, cal);
    const to = fractionalYear(last + 1, cal);
    if (overlaps(from, to, window)) out.push({ id: `run:${start}`, from, to, kind: "run", editable: false });
    start = null;
  };
  for (const day of activeDays) {
    if (!day.active) {
      flush();
      continue;
    }
    if (start !== null && day.dayOrdinal === last + 1) {
      last = day.dayOrdinal;
      continue;
    }
    flush();
    start = day.dayOrdinal;
    last = day.dayOrdinal;
  }
  flush();
  return out;
}
