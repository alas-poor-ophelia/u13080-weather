/** Year length assumed when a time source reports none (e.g. `gregorianTime`, which returns only yearPhase/dayOfYear). */
export const DEFAULT_YEAR_LENGTH = 365;

/**
 * The calendar year of a day: what the calendar says, else counted from year 1
 * at day 0 (the documented fallback for adapters that omit `year`, API.md:1312).
 */
export function yearOf(t: { year?: number | undefined; dayOrdinal: number; yearLength: number }): number {
  return t.year ?? Math.floor(t.dayOrdinal / t.yearLength) + 1;
}
