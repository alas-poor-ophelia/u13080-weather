/**
 * Which days' weather a calendar change can reach (docs/SESHAT-v0.md §15.5,
 * §15.9 B1 B2): not a formula, a comparison of the two calendars day by day.
 *
 * - The window is today ± N years (N = BLAST_YEARS, named in the sentence),
 *   plus the year holding day 0 of both calendars.
 * - Each day compares the year fields first (cheap), and the whole day context
 *   (tags, moons, seasons, phases) only where those agree.
 * - The generator reads earlier days only, except one global read: spell
 *   modifiers are tuned on the year holding day 0 (core/modifiers.ts
 *   estimateWindowDays). A difference there, on a world with spells, may
 *   change every day.
 * - Weather settles again after the last differing day plus the generator's
 *   carry: a block's warm-up, the block itself, and the longest spell
 *   look-back (WARMUP + BLOCK + SPELL_LOOKBACK_MAX).
 *
 * "May": a tag no modifier reads changes nothing, so this is an upper bound.
 * Pure: no Obsidian imports.
 */
import { canonicalJson } from "../../core/profile";
import { BLOCK, WARMUP } from "../../core/generator";
import { SPELL_LOOKBACK_MAX } from "../../core/modifiers";
import type { TimeContext } from "./adapter";

/** Years either side of today the comparison covers; the sentence names it. */
export const BLAST_YEARS = 100;
/** Days after the last differing day that weather can still differ. */
export const BLAST_CARRY = WARMUP + BLOCK + SPELL_LOOKBACK_MAX;

/** What the comparison reads of a calendar: SeshatCalendar satisfies it. */
export interface BlastCalendar {
  toContext(day: number): TimeContext;
  yearOfDay(day: number): { year: number; start: number; length: number } | null;
}

export interface BlastRadius {
  /** the days compared, both ends included */
  readonly from: number;
  readonly to: number;
  /** the first day that reads differently; null: none in the window */
  readonly first: number | null;
  /** the last day that reads differently; null: none */
  readonly last: number | null;
  /** the year holding day 0 reads differently and the world has spell modifiers: every day may change */
  readonly everyDay: boolean;
  /** some day in the window falls in a different year, or at a different place in its year: year starts moved */
  readonly yearsMoved: boolean;
}

/** How a day reads in the two calendars: the year fields first, then the whole context. */
function compareDay(a: BlastCalendar, b: BlastCalendar, d: number): "same" | "year" | "context" {
  const ya = a.yearOfDay(d);
  const yb = b.yearOfDay(d);
  if (ya?.year !== yb?.year || ya?.start !== yb?.start || ya?.length !== yb?.length) return "year";
  return canonicalJson(a.toContext(d)) === canonicalJson(b.toContext(d)) ? "same" : "context";
}

/**
 * Compare `before` and `after` over today ± `years` years and the year
 * holding day 0. `tick` is awaited every `chunk` days, so a caller can yield
 * to the UI between chunks.
 */
export async function blastRadius(
  before: BlastCalendar,
  after: BlastCalendar,
  today: number,
  opts: { spells: boolean; years?: number; chunk?: number; tick?: () => Promise<void> },
): Promise<BlastRadius> {
  const years = opts.years ?? BLAST_YEARS;
  const chunk = opts.chunk ?? 4096;
  const tick = opts.tick ?? (() => Promise.resolve());
  // the window in days: today's year length (before the change) times N, each side
  const L = before.yearOfDay(today)?.length ?? 365;
  const from = today - years * L;
  const to = today + years * L;
  let first: number | null = null;
  let last: number | null = null;
  let yearsMoved = false;
  let n = 0;
  for (let d = from; d <= to; d++) {
    const c = compareDay(before, after, d);
    if (c !== "same") {
      first ??= d;
      last = d;
      if (c === "year") yearsMoved = true;
    }
    if (++n % chunk === 0) await tick();
  }
  // spells are tuned on the year holding day 0, in whichever calendar is longer there
  let everyDay = false;
  if (opts.spells) {
    const y0 = Math.max(before.yearOfDay(0)?.length ?? 0, after.yearOfDay(0)?.length ?? 0);
    const start = Math.min(before.yearOfDay(0)?.start ?? 0, after.yearOfDay(0)?.start ?? 0);
    for (let d = start; d < start + y0 && !everyDay; d++) {
      if (compareDay(before, after, d) !== "same") everyDay = true;
      if (++n % chunk === 0) await tick();
    }
  }
  return { from, to, first, last, everyDay, yearsMoved };
}

/**
 * The sentence the Save dialog shows. `date` writes a day in the calendar
 * after the change.
 */
export function describeBlast(r: BlastRadius, date: (day: number) => string, years = BLAST_YEARS): string {
  const span = `within ${years} years of today`;
  if (r.everyDay) return "Weather may change in every zone on every day: the year holding the calendar's first day changed, and spell modifiers are tuned on that year.";
  if (r.first === null || r.last === null) return `No day ${span} reads differently, so the weather there is unchanged.`;
  const openStart = r.first === r.from;
  const openEnd = r.last === r.to || r.last + BLAST_CARRY >= r.to;
  if (openStart && openEnd) return `Weather may change in every zone on every day ${span}.`;
  if (openStart) return `Weather may change in every zone ${span} up to ${date(r.last + BLAST_CARRY)}.`;
  if (openEnd) return `Weather may change in every zone from ${date(r.first)} onward.`;
  return `Weather may change in every zone from ${date(r.first)} through ${date(r.last + BLAST_CARRY)}.`;
}
