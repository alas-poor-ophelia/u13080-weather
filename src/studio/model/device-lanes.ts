/**
 * One device → one lane (SPEC §4, §5 "four projections"). This is the *binding*
 * between `spans.ts` (which turns a `Predicate` into spans) and the playlist row
 * that draws it: which devices earn a lane at all, what shape that lane is, and
 * what a drag on an editable clip writes back.
 *
 * Three questions, three functions:
 *
 *  - **`hasLane(m, eras)`** — does this modifier carry time? SPEC §4 gives no
 *    lane to `always`, `chance` or `regime`, and none to a tag another modifier
 *    sets (`spell:x`, a hand-written label): those are mixer chips, not
 *    timelines. Nor to an `era:` tag naming an era the world does not have —
 *    that device fires on no day, so it has no timeline to draw.
 *    A `custom` device is not exempt — the studio cannot *edit* its predicate,
 *    but `spans.ts` can still read `all`/`any`/`not` over timed leaves, so a
 *    custom device with time in it gets a read-only lane like any other.
 *  - **`laneSpec(m, cal, window, activeDays?)`** — the spans, plus the three
 *    facts the row needs about them: whether anything is draggable, which of
 *    SPEC §4's shapes the lane is, and the label (the device's name). The
 *    rolled half of a spell arrives as `activeDays` and is appended, because
 *    only the caller can afford a roll (`spans.ts` is roll-free by design).
 *  - **`dragToWhen(m, span, from, to, cal)`** — the inverse of a `yearPhase` /
 *    `dayOfYear` clip: the modifier the drop writes. Every other shape returns
 *    `null` (SPEC §4: a season band is edited in the Calendar, an era bar in
 *    the Eras lane, a moon pulse in CYCLE and the MOD gates).
 *
 * A spell keeps its `when` clip *editable* even though `spansFor` redraws it
 * dashed — that is `spans.ts`'s stated contract, and dragging it still writes
 * `when` exactly as SPEC §4 promises; the spell's own knobs live in the window.
 *
 * Pure: no DOM, no Obsidian, no roll (PLAN D3).
 */
import { ERA_TAG_PREFIX } from "../../core/eras";
import { canonicalJson } from "../../core/profile";
import type { Era, Modifier, Predicate } from "../../core/types";
import { displayName as tagName } from "./copy";
import { displayName, type Device } from "./devices";
import type { Span } from "./lanes";
import { spansFor, spellRuns, type SpanCalendar } from "./spans";
import type { Window } from "./zoom";

/** The SPEC §4 shapes a device lane can be; `none` is "this device has no lane". */
export type LaneKind = "clip" | "pulse" | "band" | "bar" | "window" | "none";

/** Everything the device row needs to draw one device, in one object. */
export interface LaneSpec {
  spans: Span[];
  /** true when at least one span can be dragged — i.e. `dragToWhen` would answer */
  editable: boolean;
  kind: LaneKind;
  /** the device's name, which is its modifier id minus a studio prefix */
  label: string;
}

/** Fractional years lose a few ULPs to cancellation; the same epsilon `spans.ts` uses. */
const EPS = 1e-9;

/**
 * Authored phases carry nowhere near ten decimals, so rounding a dragged one
 * there keeps `yearPhase` readable in the JSON drawer without moving any value
 * a pointer could actually mean. (`devices.ts` rounds its own round trip the
 * same way; the constant is duplicated rather than shared because that one is
 * private to the `Device` ⇄ `Modifier` translation.)
 */
const round10 = (x: number): number => Number(x.toFixed(10));

const wrap1 = (x: number): number => {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
};

/**
 * Does `p` place the device in time? Mirrors `spans.ts`'s `Derived.timed`
 * exactly: a composite is timed when *any* leaf is (an untimed leaf is ignored
 * inside `all`/`any`, so `all[season:Winter, chance 0.2]` is still a Winter
 * lane), and a bare `tag` only counts when it is one of the two the calendar
 * can place — `season:` or `era:`.
 */
function timedPredicate(p: Predicate | undefined, eras: readonly Era[]): boolean {
  if (!p) return false;
  if ("all" in p) return p.all.some((x) => timedPredicate(x, eras));
  if ("any" in p) return p.any.some((x) => timedPredicate(x, eras));
  if ("not" in p) return timedPredicate(p.not, eras);
  if ("moon" in p || "yearPhase" in p || "dayOfYear" in p) return true;
  if ("tag" in p) {
    if (p.tag.startsWith("season:")) return true;
    // An `era:` tag only places a device in time when the world HAS that era.
    // Neverain is gated on `era:Drought` in a world whose eras are Ice Age,
    // Thaw and Long Summer: it fires on no day, so it is a mixer unit and
    // nothing else — an always-empty lane is noise, not information.
    if (p.tag.startsWith("era:")) return eras.some((e) => e.enabled !== false && ERA_TAG_PREFIX + e.name === p.tag);
  }
  return false; // regime (roll time only) and chance (a mixer chip, SPEC §4)
}

/**
 * Does this modifier get a playlist row? Time in the `when`, or a spell —
 * a spell's rolled runs *are* a timeline even when the device may fire on any
 * day of the year, so "always + spell" draws its runs with no dashed window
 * around them rather than vanishing from the playlist.
 */
export function hasLane(m: Modifier, eras: readonly Era[]): boolean {
  return timedPredicate(m.when, eras) || m.spell !== undefined;
}

/** The SPEC §4 row `p` belongs to, before any window is known. */
function structuralKind(p: Predicate | undefined): LaneKind {
  if (!p) return "none";
  if ("all" in p || "any" in p || "not" in p) return "window";
  if ("moon" in p) return "pulse";
  if ("yearPhase" in p || "dayOfYear" in p) return "clip";
  if ("tag" in p) {
    if (p.tag.startsWith("season:")) return "band";
    if (p.tag.startsWith("era:")) return "bar";
  }
  return "none";
}

/**
 * The lane for one device. `activeDays` is the rolled half — one entry per day
 * in ascending `dayOrdinal`, `active` true where `AuditionDay.active` contains
 * this modifier's id — and is only worth gathering for a device with a spell;
 * omitted, the lane is the `when` alone.
 *
 * `kind` is read off the spans the window actually produced (an `era:` lane is
 * a clip at Era zoom and a bar at Year zoom, so it cannot be known before the
 * window is), falling back to the predicate's own shape when the window shows
 * none of them.
 */
export function laneSpec(m: Modifier, cal: SpanCalendar, window: Window, activeDays?: ReadonlyArray<{ dayOrdinal: number; active: boolean }>): LaneSpec {
  const label = displayName(m);
  if (!hasLane(m, cal.eras)) return { spans: [], editable: false, kind: "none", label };

  const gates = m.mods ?? [];
  const when = spansFor(m.when, m.spell, cal, { window, ...(gates.length > 0 ? { gates } : {}) });
  const runs = activeDays === undefined ? [] : spellRuns(activeDays, cal, window);
  const spans = [...when, ...runs];

  // A spell is always the dashed-window row, whatever its `when` was drawn as.
  const drawn = when.find((s) => s.kind !== "run")?.kind;
  const kind: LaneKind = m.spell !== undefined ? "window" : ((drawn as LaneKind | undefined) ?? structuralKind(m.when));

  return { spans, editable: spans.some((s) => s.editable), kind, label };
}

/**
 * The lane label's second line (SPEC §3.2's two-line lane label): what this
 * device's row is *showing*, in one short phrase, from the same predicate the
 * spans came from.
 *
 *  - a moon lane says which cycle its pulses follow (`active days · ↻ 29.53 d`)
 *  - a per-year clip or a spell window says the days it covers and that it
 *    repeats (`clip d223–d263 · yearly`)
 *  - a season or era lane simply names the tag it is gated on
 *
 * Days are day-of-year numbers, which are calendar-invariant, so nothing here
 * needs `format.ts`.
 */
export function laneSub(m: Modifier, cal: SpanCalendar): string {
  const leaf = firstTimed(m.when);
  if (leaf === null) return m.spell === undefined ? "active days" : `spell · ${round10(m.spell.meanDurationDays)} d runs`;
  if ("moon" in leaf) {
    const cycle = cal.moons.find((x) => x.name === leaf.moon.name)?.cycleDays;
    return cycle === undefined ? "active days" : `active days · ↻ ${round10(cycle)} d`;
  }
  if ("tag" in leaf) return leaf.tag;
  // The clip is the same every year, so it is read off the PREDICATE rather
  // than off the spans on screen: zoomed into a month the window shows no
  // clip at all, and the label still has to say which days it covers.
  const [from, to] = "yearPhase" in leaf ? [Math.round(leaf.yearPhase[0] * cal.yearLength), Math.round(leaf.yearPhase[1] * cal.yearLength)] : leaf.dayOfYear;
  // `d223–263`, not `d223–d263`: the label column is 136 px and the second
  // `d` is the character that pushes this line into an ellipsis.
  return `clip d${from}–${to} · yearly`;
}

/**
 * The caption a MOON lane prints inside itself, at its left edge (the
 * prototype's `sable full ↻ 29.5 d · gated by Harvest`) — three facts a row
 * of pulses cannot say on its own: which moon and which phase the pulses are,
 * how long its cycle is, and which tag dims it.
 *
 * `""` for every other lane shape: a clip already says its days in the caption
 * `ui/rows/device-rows.ts` prints beside it, and a band or a bar is named by
 * the calendar underneath it.
 */
export function laneCaption(d: Device, cal: SpanCalendar): string {
  const w = d.when;
  if (w.kind !== "moon") return "";
  // Lowercase throughout: this is a caption, in the same voice as the day
  // card's tag chips (`season:Harvest`, `sable 22 %`), not a heading.
  const phases = w.phases.join(", ").toLowerCase();
  const head = `${w.moon.toLowerCase()}${phases === "" ? "" : ` ${phases}`}`;
  const cycle = cal.moons.find((x) => x.name === w.moon)?.cycleDays;
  const gates = d.mods.filter((g) => g.amount > 0).map((g) => tagName(g.source));
  const left = cycle === undefined ? head : `${head} ↻ ${trim1(cycle)} d`;
  return gates.length === 0 ? left : `${left} · gated by ${gates.join(", ")}`;
}

/** `29.53 → 29.5`, `30 → 30`: the caption's own rounding, one decimal at most. */
function trim1(x: number): string {
  return String(Math.round(x * 10) / 10);
}

/** A predicate leaf that places the device in time. */
type TimedLeaf = { moon: { name: string; phase: [number, number] } } | { yearPhase: [number, number] } | { dayOfYear: [number, number] } | { tag: string };

/** The first leaf of `p` that places the device in time, or `null`. */
function firstTimed(p: Predicate | undefined): TimedLeaf | null {
  if (!p) return null;
  if ("all" in p) return p.all.map(firstTimed).find((x) => x !== null) ?? null;
  if ("any" in p) return p.any.map(firstTimed).find((x) => x !== null) ?? null;
  if ("not" in p) return firstTimed(p.not);
  if ("moon" in p || "yearPhase" in p || "dayOfYear" in p) return p;
  if ("tag" in p && (p.tag.startsWith("season:") || p.tag.startsWith("era:"))) return p;
  return null;
}

/**
 * The calendar year a per-year clip belongs to. `spans.ts` ids them `yp:<year>`
 * / `doy:<year>` precisely so a drop can be attributed to a year without
 * re-deriving one from a dragged edge that may have crossed a boundary.
 */
function spanYear(span: Span): number | null {
  const at = span.id.indexOf(":");
  if (at === -1) return null;
  const head = span.id.slice(0, at);
  if (head !== "yp" && head !== "doy") return null;
  const year = Number(span.id.slice(at + 1));
  return Number.isFinite(year) ? year : null;
}

function clampDay(day: number, yearLength: number): number {
  return Math.min(Math.max(day, 0), Math.max(0, Math.round(yearLength) - 1));
}

/**
 * The modifier a drag on `span` writes: `when` rewritten so the clip's new
 * edges `[newFrom, newTo)` (fractional years) are what the predicate says.
 * `null` when nothing may be written — a read-only shape (SPEC §4 sends the
 * user to the Calendar, the Eras lane or CYCLE instead), a span that is not one
 * of the per-year clips, or a degenerate drag.
 *
 * Two engine facts decide the arithmetic:
 *
 *  - `yearPhase [a, b]` with `a === b` is the engine's *never*, so a clip
 *    dragged out to a full year is written as the full circle `[0, 1]` rather
 *    than as `[a, a]` (the same rule `moonRange` keeps).
 *  - `dayOfYear [a, b]` is INCLUSIVE at both ends and never wraps, so the right
 *    edge writes `round(...) − 1` and a drag that would invert the range is
 *    refused rather than silently emptied.
 */
export function dragToWhen(m: Modifier, span: Span, newFrom: number, newTo: number, cal: SpanCalendar): Modifier | null {
  const w = m.when;
  if (!w) return null;
  if (!Number.isFinite(newFrom) || !Number.isFinite(newTo) || newTo - newFrom <= EPS) return null;
  const year = spanYear(span);
  if (year === null) return null;

  if ("yearPhase" in w) {
    const length = newTo - newFrom;
    if (length >= 1 - EPS) return { ...m, when: { yearPhase: [0, 1] } };
    const a = wrap1(newFrom - year);
    const b = wrap1(a + length);
    if (Math.abs(a - b) < EPS) return null;
    return { ...m, when: { yearPhase: [round10(a), round10(b)] } };
  }

  if ("dayOfYear" in w) {
    const len = cal.yearLength;
    const lo = clampDay(Math.round((newFrom - year) * len), len);
    const hi = clampDay(Math.round((newTo - year) * len) - 1, len);
    if (hi < lo) return null;
    return { ...m, when: { dayOfYear: [lo, hi] } };
  }

  return null;
}

/**
 * The cache key a spell lane's *rolled runs* are memoised under
 * (`ui/rows/device-rows.ts`).
 *
 * A run is what the roll actually did, so the key has to carry everything the
 * roll reads: the world seed, the audition salt, the years on screen — and,
 * because a device's own predicate and the world's eras both steer the roll,
 * the CONTENT of the modifier and of the era list, not just their ids and
 * lengths (H-1391). Keying on `modifier.id` and `eras.length` alone meant
 * editing a spell's `chance`, or an era's span, left the old runs on screen
 * until something else happened to move.
 *
 * `canonicalJson` sorts keys, so the key is stable across two structurally
 * equal objects — the same identity the store's dirty tracking and the
 * header's Köppen memo use.
 */
export function spellRunsKey(o: { modifier: Modifier; eras: readonly Era[]; seed: string; salt: number; firstYear: number; years: number }): string {
  return [o.modifier.id, o.seed, o.salt, o.firstYear, o.years, canonicalJson(o.modifier), canonicalJson(o.eras)].join("|");
}
