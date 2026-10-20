/**
 * The Studio's one year seam (docs/SESHAT-v0.md §14.3, §14.8, Seshat P3b):
 * every conversion between days and positions on the Studio's axis goes
 * through a `YearSeam`. The axis gives every year one unit, [Y, Y + 1), as
 * the engine's own coordinate does (`year + yearPhase`, core/automation.ts),
 * so a leap year's days are narrower, not the year wider.
 *
 * Three seams, chosen per adapter by `yearsFor`:
 * - **constant**: the internal calendar's (and any adapter's without per-day
 *   years) constant year, with today's formulas kept operation for operation,
 *   so a legacy world's Studio output is byte-identical by construction
 *   (test/golden/studio-years.json pins it);
 * - **engine**: a world that runs a definition, through the adapter's own
 *   year model (seshat.ts yearAt / yearStartAt), read at every call so a
 *   definition edit (which swaps the engine under the same adapter) is seen;
 * - **probed**: a third-party adapter whose contexts carry `year`, checked by
 *   sampling and searched, never computed from a formula it did not state.
 *
 * Exact seams put day D of year Y at `Y + (D - start) / length`, the order
 * automation reads (`yearOf(t) + t.yearPhase`), and find days with a check
 * against the next day's position, so a day edge never reads as the day
 * before (§14.8 C2).
 *
 * Pure: no Obsidian imports.
 */
import { positionIn, startOf, type FixedUnit } from "../../seshat";
import type { CalendarDescription, TimeAdapter } from "../../plugin/time/adapter";
import { SeshatCalendar } from "../../plugin/time/seshat";

/** The constant seam's keyboard step: a 365th of a year, as the lane has always stepped (components/lane.ts). */
export const LEGACY_DAY_YEARS = 1 / 365;

export interface YearSeam {
  /** true for the exact seams; false for the constant one (legacy, opaque calendars) */
  readonly exact: boolean;
  /** the year number of the year that holds day 0 */
  readonly epochYear: number;
  /** a duration scale only ("about a year is this many days"): zoom widths, labels of year-independent fractions */
  readonly nominalLength: number;
  /** the axis position of `day` (a real number of days: a moon edge is a fractional day) */
  fractionalYear(day: number): number;
  /** the inverse of fractionalYear: the real day at axis position `x` */
  dayOf(x: number): number;
  /** the whole day whose [fractionalYear(d), fractionalYear(d + 1)) holds `x` */
  dayAt(x: number): number;
  /** the axis position of the middle of `day` (where a jump to it centres the window) */
  dayMid(day: number): number;
  /** the year holding `day`: its number, first day and length */
  yearOf(day: number): { year: number; start: number; length: number };
  /** the first day of year number `year` */
  yearStart(year: number): number;
  /** how many days year number `year` has */
  yearLength(year: number): number;
  /** the day index within year `year` that axis position `x` rounds to (a drag edge: may lie outside the year) */
  dayIndexAt(year: number, x: number): number;
  /** one day of year `year`, in years: a keyboard step on the lane */
  stepYears(year: number): number;
}

/**
 * The constant seam: years of `yearLength` days (any positive length, a
 * fractional one included), year `epochYear` starting on day 0. Each method
 * is the expression the Studio has always used at its sites, unchanged, so
 * moving a site onto the seam moves no float:
 *
 * - fractionalYear, dayOf: model/spans.ts fractionalYear / dayOrdinalAt;
 * - dayAt: ui/day-card.ts centreRoll (`floor((centre - epochYear) · L)`);
 * - dayMid: ui/playlist.ts jumpToDay (`epoch + (d + 0.5) / L`);
 * - yearOf, yearStart: the internal calendar's own (seshat positionIn / startOf, as InternalCalendar.toContext);
 * - dayIndexAt: model/device-lanes.ts dragToWhen (`round((x - year) · L)`, before its clamp, which stays there);
 * - stepYears: components/lane.ts `DAY_YEARS` (1/365, whatever the year length).
 */
export function constantYears(yearLength: number, epochYear: number): YearSeam {
  if (!(yearLength > 0) || !Number.isFinite(yearLength)) throw new RangeError(`a constant year needs a positive length (got ${yearLength})`);
  if (!Number.isFinite(epochYear)) throw new RangeError(`a constant year needs a finite epoch year (got ${epochYear})`);
  const L = yearLength;
  const unit: FixedUnit = { anchor: 0, length: L };
  return {
    exact: false,
    epochYear,
    nominalLength: L,
    fractionalYear: (day) => epochYear + day / L,
    dayOf: (x) => (x - epochYear) * L,
    dayAt: (x) => Math.floor((x - epochYear) * L),
    dayMid: (day) => epochYear + (day + 0.5) / L,
    yearOf: (day) => {
      const { index } = positionIn(unit, day);
      return { year: index + epochYear, start: startOf(unit, index), length: L };
    },
    yearStart: (year) => startOf(unit, year - epochYear),
    yearLength: () => L,
    dayIndexAt: (year, x) => Math.round((x - year) * L),
    stepYears: () => LEGACY_DAY_YEARS,
  };
}

/**
 * The constant seam for a calendar description, or null when there is none
 * (an opaque adapter) or its year length is not positive: the Studio's "no
 * calendar" case, which every site keeps (an empty lane, an early return).
 * The epoch falls back as the Studio's sites always have, once, here:
 * `description.epochYear ?? settings.calendar.epochYear ?? 1`.
 */
export function constantYearsFor(description: { yearLength: number; epochYear?: number } | null | undefined, settingsEpochYear?: number): YearSeam | null {
  if (!description || !(description.yearLength > 0) || !Number.isFinite(description.yearLength)) return null;
  return constantYears(description.yearLength, description.epochYear ?? settingsEpochYear ?? 1);
}

/** Exact positions from a year model; `fy` of a whole day is the seam's ground truth, the rest follows from it. */
function exactSeam(o: {
  yearOf: (day: number) => { year: number; start: number; length: number };
  yearStart: (year: number) => number;
  /** the axis position of whole day `day` */
  fy: (day: number) => number;
}): YearSeam {
  const yearLength = (year: number) => o.yearStart(year + 1) - o.yearStart(year);
  const fractionalYear = (day: number) => {
    const D = Math.floor(day);
    const a = o.fy(D);
    if (day === D) return a;
    // within one day the axis is linear, up to the next day's start (the next year's Y + 1 at a seam)
    return a + (day - D) * (o.fy(D + 1) - a);
  };
  const dayAt = (x: number) => {
    const Y = Math.floor(x);
    const start = o.yearStart(Y);
    const L = yearLength(Y);
    let k = Math.min(L - 1, Math.max(0, Math.floor((x - Y) * L)));
    // the arithmetic guess can sit a day off on an edge: settle it against the positions themselves
    while (k > 0 && o.fy(start + k) > x) k--;
    while (k < L - 1 && o.fy(start + k + 1) <= x) k++;
    return start + k;
  };
  const year0 = o.yearOf(0);
  return {
    exact: true,
    epochYear: year0.year,
    nominalLength: year0.length,
    fractionalYear,
    dayOf: (x) => {
      const d = dayAt(x);
      const a = o.fy(d);
      return d + (x - a) / (o.fy(d + 1) - a);
    },
    dayAt,
    dayMid: (day) => {
      const D = Math.floor(day);
      return o.fy(D) + 0.5 * (o.fy(D + 1) - o.fy(D));
    },
    yearOf: (day) => o.yearOf(Math.floor(day)),
    yearStart: o.yearStart,
    yearLength,
    dayIndexAt: (year, x) => Math.round((x - year) * yearLength(year)),
    stepYears: (year) => 1 / yearLength(year),
  };
}

/**
 * The engine seam for a world that runs a definition, or null in a fault.
 * Every call reads the adapter, so the seam never outlives a definition edit.
 */
export function engineYears(cal: SeshatCalendar): YearSeam | null {
  if (cal.fault || !cal.yearOfDay(0)) return null;
  const yearOf = (day: number) => {
    const y = cal.yearOfDay(day);
    if (!y) throw new Error("the Seshat calendar has no running definition");
    return y;
  };
  return exactSeam({
    yearOf,
    yearStart: (year) => {
      const s = cal.yearStart(year);
      if (s === null) throw new Error("the Seshat calendar has no running definition");
      return s;
    },
    // the same expression toContext's year + yearPhase gives, in the same order
    fy: (day) => {
      const y = yearOf(day);
      return y.year + (day - y.start) / y.length;
    },
  });
}

/** Where the probed seam samples an adapter: densely around day 0, then out to the day line in both directions. */
const PROBE_DAYS: readonly number[] = (() => {
  const out = new Set<number>();
  for (let d = -800; d <= 800; d++) out.add(d);
  for (let k = 3; k <= 7; k++) for (const sign of [1, -1]) for (const m of [1, 2, 5]) for (let j = 0; j <= 400; j += 40) out.add(sign * m * 10 ** k + j);
  return [...out].sort((a, b) => a - b);
})();

/** Why an adapter's contexts cannot place years exactly, or null when every sample holds. */
export function probeFault(adapter: TimeAdapter): string | null {
  let prev: { day: number; year: number; fy: number } | null = null;
  for (const day of PROBE_DAYS) {
    let c;
    try {
      c = adapter.toContext(day);
    } catch (e) {
      return `toContext(${day}) threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    const year = c.year;
    if (typeof year !== "number" || !Number.isSafeInteger(year)) return `day ${day} has no whole year number`;
    if (!(c.yearPhase >= 0 && c.yearPhase < 1)) return `day ${day} has a year phase outside [0, 1)`;
    const fy = year + c.yearPhase;
    if (prev) {
      if (year < prev.year) return `the year number falls from ${prev.year} to ${year} at day ${day}`;
      if (day === prev.day + 1 && year > prev.year + 1) return `the year number skips from ${prev.year} to ${year} at day ${day}`;
      if (!(fy > prev.fy)) return `the axis position does not increase at day ${day}`;
    }
    prev = { day, year, fy };
  }
  return null;
}

/**
 * The probed seam for a third-party adapter whose contexts carry `year`, or
 * null when sampling finds a reason it cannot place years exactly. Positions
 * are the adapter's own `year + yearPhase`; year starts and days are found by
 * binary search over whole days, never by arithmetic the adapter did not state.
 */
export function probedYears(adapter: TimeAdapter): YearSeam | null {
  if (probeFault(adapter) !== null) return null;
  const starts = new Map<number, number>();
  const yearNumber = (day: number) => adapter.toContext(day).year!;
  const yearStart = (year: number): number => {
    const known = starts.get(year);
    if (known !== undefined) return known;
    // bracket the first day whose year is at least `year`, then bisect
    let lo = 0;
    let hi = 0;
    let step = 1;
    if (yearNumber(0) >= year) {
      while (yearNumber(lo) >= year) {
        lo -= step;
        step *= 2;
      }
      hi = lo + step / 2;
    } else {
      while (yearNumber(hi) < year) {
        hi += step;
        step *= 2;
      }
      lo = hi - step / 2;
    }
    // invariant: yearNumber(lo) < year <= yearNumber(hi)
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (yearNumber(mid) >= year) hi = mid;
      else lo = mid;
    }
    starts.set(year, hi);
    return hi;
  };
  return exactSeam({
    yearOf: (day) => {
      const year = yearNumber(day);
      const start = yearStart(year);
      return { year, start, length: yearStart(year + 1) - start };
    },
    yearStart,
    fy: (day) => {
      const c = adapter.toContext(day);
      return c.year! + c.yearPhase;
    },
  });
}

const probed = new WeakMap<TimeAdapter, { hash: string; seam: YearSeam | null }>();
const noted = new WeakSet<TimeAdapter>();

/** A span calendar's seam: the one it carries, else the constant seam of its own numbers (legacy and hand-built calendars). */
const ownSeams = new WeakMap<object, YearSeam>();
export function seamOf(cal: { yearLength: number; epochYear: number; years?: YearSeam }): YearSeam {
  if (cal.years) return cal.years;
  let s = ownSeams.get(cal);
  if (!s) {
    s = constantYears(cal.yearLength, cal.epochYear);
    ownSeams.set(cal, s);
  }
  return s;
}

/**
 * The seam for the active adapter: the engine seam for a world that runs a
 * definition (null in a fault: the Studio's no-calendar case), the constant
 * seam for the internal calendar, and for any other adapter the probed seam
 * when its contexts allow it, else the constant seam from its description
 * (null without one). A probe is remembered per adapter object and
 * `configHash()`; a new registration is a new object, so it is probed again.
 */
export function yearsFor(adapter: TimeAdapter | undefined, description: CalendarDescription | null | undefined, internal?: { epochYear?: number }): YearSeam | null {
  const settingsEpochYear = internal?.epochYear;
  if (!adapter) return null;
  if (adapter instanceof SeshatCalendar) return engineYears(adapter);
  if (adapter.id === "internal") return constantYearsFor(description, settingsEpochYear);
  let hash: string;
  try {
    hash = adapter.configHash();
  } catch {
    hash = "";
  }
  const memo = probed.get(adapter);
  let seam = memo && memo.hash === hash ? memo.seam : undefined;
  if (seam === undefined) {
    const fault = probeFault(adapter);
    seam = fault === null ? probedYears(adapter) : null;
    probed.set(adapter, { hash, seam });
    if (fault !== null && !noted.has(adapter)) {
      noted.add(adapter);
      console.warn(`U+13080 Weather: the studio draws calendar "${adapter.id}" with a constant year: ${fault}.`);
    }
  }
  return seam ?? constantYearsFor(description, settingsEpochYear);
}
