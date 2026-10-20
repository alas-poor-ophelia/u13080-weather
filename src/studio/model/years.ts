/**
 * The Studio's one year seam (docs/SESHAT-v0.md §14.3, §14.8, Seshat P3b):
 * every conversion between days and positions on the Studio's axis goes
 * through a `YearSeam`. The axis gives every year one unit, [Y, Y + 1), as
 * the engine's own coordinate does (`year + yearPhase`, core/automation.ts),
 * so a leap year's days are narrower, not the year wider.
 *
 * This module holds the interface and the **constant** seam: the internal
 * calendar's (and any adapter's without per-day years) constant year, with
 * today's formulas kept operation for operation, so a legacy world's Studio
 * output is byte-identical by construction (test/golden/studio-years.json
 * pins it). The exact seams (a definition world's engine, a third-party
 * adapter's sampled contexts) arrive in P3b step 0.5.
 *
 * Pure: no Obsidian imports.
 */
import { positionIn, startOf, type FixedUnit } from "../../seshat";

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
