/**
 * A calendar definition and the date arithmetic over it (docs/SESHAT-v0.md §7).
 *
 * The first definition is the internal calendar's: a fixed-length year unit,
 * an epoch year and moons. Stored settings stay decimal and are converted on
 * read; definition storage waits for the first user-authored definition.
 */
import { moonPhase } from "./body";
import { positionIn, startOf, type FixedUnit } from "./unit";

export interface MoonDef {
  readonly name: string;
  readonly cycleDays: number;
  readonly phaseAtEpoch: number;
}

export interface FixedYearCalendar {
  readonly year: FixedUnit;
  /** the year number of year index 0 */
  readonly epochYear: number;
  readonly moons: readonly MoonDef[];
}

/** Where a day falls: year number, day of year (0-based), yearPhase in [0, 1), and each moon's phase. */
export function dayIn(cal: FixedYearCalendar, day: number): { year: number; dayOfYear: number; yearPhase: number; moons: Array<{ name: string; phase: number }> } {
  const { index, offset } = positionIn(cal.year, day);
  return {
    year: index + cal.epochYear,
    dayOfYear: offset,
    yearPhase: offset / cal.year.length,
    moons: cal.moons.map((m) => ({ name: m.name, phase: moonPhase(m.cycleDays, m.phaseAtEpoch, day) })),
  };
}

/** The day `dayOfYear` (0-based) days into year number `year`. */
export function dayOf(cal: FixedYearCalendar, year: number, dayOfYear: number): number {
  return startOf(cal.year, year - cal.epochYear) + dayOfYear;
}
