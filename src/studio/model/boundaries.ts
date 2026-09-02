/**
 * Shared boundary maths for the Seasons · CALENDAR window (SPEC §3.4
 * "Seasons") and the Sable · CYCLE window (SPEC §3.4 "Sable · CYCLE"): an
 * ordered list of named marks on a unit circle (`at` ∈ [0,1)). The first
 * mark may sit anywhere — the last segment always wraps back to it.
 *
 * `dragMark`, `merge` and `rename` are positional: `index` is a position in
 * the `marks` array as given, and wrap semantics (index 0's previous
 * neighbour is the last mark) fall out of that array already being in
 * ascending `at` order — callers keep their state `normalise`d for this to
 * mean what the UI shows. `segments`, `markAt`, `split` and `splitLongest`
 * search by `at`/phase rather than index, so they `normalise` internally
 * and tolerate unsorted/unwrapped input (e.g. calendar data loaded from
 * disk — see `InternalCalendar.describe()`, which sorts for the same
 * reason).
 *
 * Pure: no Obsidian imports (PLAN D3).
 */

/** A named boundary on the unit circle. `at` ∈ [0,1). */
export interface Mark {
  name: string;
  at: number;
}

/** Per-window constraints (SPEC §3.4). */
export interface MarkLimits {
  min: number;
  max: number;
  minGap: number;
}

/** Seasons · CALENDAR: 1–6 seasons, at least a week apart. */
export const SEASON_LIMITS: MarkLimits = { min: 1, max: 6, minGap: 7 / 365 };
/** Sable · CYCLE: unlimited named phases, at least 2% of the cycle apart. */
export const PHASE_LIMITS: MarkLimits = { min: 1, max: Infinity, minGap: 0.02 };

/** A segment between one mark and the next (wrapping). `length` ∈ (0,1]. */
export interface Segment {
  name: string;
  from: number;
  to: number;
  length: number;
}

/** Wraps `x` into [0,1); mirrors `InternalCalendar`'s own `wrap` helper. */
function wrapPhase(x: number): number {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Sorted by `at`, ats wrapped into [0,1); always returns copies. */
export function normalise(marks: readonly Mark[]): Mark[] {
  return marks.map((m) => ({ name: m.name, at: wrapPhase(m.at) })).sort((a, b) => a.at - b.at);
}

/**
 * The segment starting at each mark, ending at the next mark's `at`
 * (wrapping past the last mark back to the first). A single mark covers the
 * whole circle: `from === to`, `length === 1`.
 */
export function segments(marks: readonly Mark[]): Segment[] {
  const s = normalise(marks);
  return s.map((m, i) => {
    const next = s[(i + 1) % s.length]!;
    const from = m.at;
    const to = next.at;
    let length = to - from;
    if (length <= 0) length += 1;
    return { name: m.name, from, to, length };
  });
}

/**
 * The mark covering `phase`: the last mark (by `at`) with `at <= phase`,
 * wrapping to the last mark when `phase` falls before the first one. Same
 * rule as `seasonAtPhase` (`src/plugin/time/seasons.ts`). `null` when
 * `marks` is empty.
 */
export function markAt(marks: readonly Mark[], phase: number): Mark | null {
  const s = normalise(marks);
  if (s.length === 0) return null;
  let cur = s[s.length - 1]!;
  for (const x of s) if (phase >= x.at) cur = x;
  return cur;
}

/**
 * Moves `marks[index]` to `toPhase`, clamped so neither the segment ending
 * at it nor the segment starting from it drops below `limits.minGap`. The
 * first mark (index 0) may move too — its neighbours wrap (previous = the
 * last mark). Never reorders: a mark cannot pass either neighbour.
 */
export function dragMark(marks: readonly Mark[], index: number, toPhase: number, limits: MarkLimits): Mark[] {
  const out = marks.map((m) => ({ ...m }));
  const n = out.length;
  if (n === 0 || index < 0 || index >= n) return out;
  if (n === 1) {
    out[0]!.at = wrapPhase(toPhase);
    return out;
  }

  const prevIdx = (index - 1 + n) % n;
  const nextIdx = (index + 1) % n;
  const prevAt = wrapPhase(out[prevIdx]!.at);
  const nextAt = wrapPhase(out[nextIdx]!.at);
  // Forward distance from prev to next, going the same direction marks are
  // ordered in; when prev and next are the same other mark (n === 2) that
  // distance is the whole circle, split by it on both sides.
  let total = wrapPhase(nextAt - prevAt);
  if (total === 0) total = 1;

  let lo = limits.minGap;
  let hi = total - limits.minGap;
  if (lo > hi) {
    // Existing gaps are already tighter than minGap (imported/legacy data) —
    // hold the midpoint rather than producing an inverted clamp range.
    lo = hi = total / 2;
  }
  const rawD = wrapPhase(toPhase - prevAt);
  const d = clampNumber(rawD, lo, hi);
  out[index]!.at = wrapPhase(prevAt + d);
  return out;
}

function inSegment(p: number, seg: Segment): boolean {
  if (seg.from === seg.to) return true; // whole circle (single-mark case)
  if (seg.from < seg.to) return p >= seg.from && p < seg.to;
  return p >= seg.from || p < seg.to; // wraps through 0
}

function uniqueDefaultName(base: string, existing: readonly string[]): string {
  let n = 2;
  let candidate = `${base} ${n}`;
  while (existing.includes(candidate)) {
    n++;
    candidate = `${base} ${n}`;
  }
  return candidate;
}

/**
 * Inserts a new mark at `phase`, inside whichever segment contains it.
 * Refuses (`null`) when the mark count is already at `limits.max`, or when
 * either resulting half would be shorter than `limits.minGap`. Default name
 * is `"<segment name> 2"`, bumped (`… 3`, `… 4`, …) until unique; an empty
 * or omitted `newName` falls back to that default.
 */
export function split(marks: readonly Mark[], phase: number, limits: MarkLimits, newName?: string): Mark[] | null {
  const s = normalise(marks);
  if (s.length === 0 || s.length >= limits.max) return null;

  const segs = segments(s);
  const p = wrapPhase(phase);
  const segIndex = segs.findIndex((seg) => inSegment(p, seg));
  if (segIndex < 0) return null;
  const seg = segs[segIndex]!;

  const lenA = wrapPhase(p - seg.from);
  const lenB = seg.length - lenA;
  if (lenA < limits.minGap || lenB < limits.minGap) return null;

  const trimmed = newName?.trim();
  const name = trimmed && trimmed.length > 0 ? trimmed : uniqueDefaultName(seg.name, s.map((m) => m.name));
  return normalise([...s, { name, at: p }]);
}

/** Halves the longest segment (ties keep the first found, in `at` order). */
export function splitLongest(marks: readonly Mark[], limits: MarkLimits, newName?: string): Mark[] | null {
  const segs = segments(marks);
  if (segs.length === 0) return null;
  let best = segs[0]!;
  for (const seg of segs) if (seg.length > best.length) best = seg;
  const phase = wrapPhase(best.from + best.length / 2);
  return split(marks, phase, limits, newName);
}

/**
 * Removes `marks[index]`; its segment joins the PREVIOUS one (SPEC: "×
 * merges into previous") — including index 0, whose previous segment is the
 * wrap segment ending at it, i.e. it merges into the last mark. Refuses
 * (`null`) at `limits.min`.
 */
export function merge(marks: readonly Mark[], index: number, limits: MarkLimits): Mark[] | null {
  const n = marks.length;
  if (n <= limits.min) return null;
  if (index < 0 || index >= n) return null;
  return marks.filter((_, i) => i !== index).map((m) => ({ ...m }));
}

/** Trims `name`; no uniqueness enforcement here (the validator does that). */
export function rename(marks: readonly Mark[], index: number, name: string): Mark[] {
  return marks.map((m, i) => (i === index ? { name: name.trim(), at: m.at } : { ...m }));
}

export interface MarkIssue {
  index: number | null;
  message: string;
}

/**
 * Count within `limits`; names non-empty and unique (case-sensitive); every
 * `at` in [0,1); strictly ascending after `normalise`; every segment gap ≥
 * `limits.minGap`.
 */
export function validateMarks(marks: readonly Mark[], limits: MarkLimits): MarkIssue[] {
  const issues: MarkIssue[] = [];
  const n = marks.length;

  if (n < limits.min || n > limits.max) {
    const range = limits.max === Infinity ? `at least ${limits.min}` : `${limits.min}-${limits.max}`;
    issues.push({ index: null, message: `expected ${range} marks (got ${n})` });
  }

  const seen = new Set<string>();
  marks.forEach((m, i) => {
    if (!m.name || !m.name.trim()) {
      issues.push({ index: i, message: "name is required" });
    } else if (seen.has(m.name)) {
      issues.push({ index: i, message: `duplicate name "${m.name}"` });
    } else {
      seen.add(m.name);
    }
    if (!(m.at >= 0 && m.at < 1)) {
      issues.push({ index: i, message: "at must be in [0,1)" });
    }
  });

  const sorted = normalise(marks);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i]!.at > sorted[i - 1]!.at)) {
      issues.push({ index: null, message: `marks must be strictly ascending after normalising (at ${sorted[i]!.at})` });
    }
  }

  for (const seg of segments(sorted)) {
    if (seg.length < limits.minGap) {
      issues.push({ index: null, message: `segment "${seg.name}" (${seg.length.toFixed(4)}) is shorter than the minimum gap (${limits.minGap})` });
    }
  }

  return issues;
}

export function toSeasons(marks: readonly Mark[]): Array<{ name: string; from: number }> {
  return marks.map((m) => ({ name: m.name, from: m.at }));
}

export function fromSeasons(seasons: readonly { name: string; from: number }[]): Mark[] {
  return seasons.map((s) => ({ name: s.name, at: s.from }));
}

export function toPhases(marks: readonly Mark[]): Array<{ name: string; at: number }> {
  return marks.map((m) => ({ name: m.name, at: m.at }));
}

export function fromPhases(phases: readonly { name: string; at: number }[]): Mark[] {
  return phases.map((p) => ({ name: p.name, at: p.at }));
}

/** Degrees clockwise from 12 o'clock for the disc: `at · 360`. */
export function angleOf(at: number): number {
  return at * 360;
}

/** Inverse of `angleOf`, wrapped into [0,1). */
export function phaseOfAngle(deg: number): number {
  return wrapPhase(deg / 360);
}

/** Evenly spaced marks starting at 0, e.g. the 4-season default: Spring 0, Summer .25, Autumn .5, Winter .75. */
export function evenMarks(names: readonly string[]): Mark[] {
  const n = names.length;
  return names.map((name, i) => ({ name, at: n === 0 ? 0 : i / n }));
}
