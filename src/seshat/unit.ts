/**
 * C2 Unit: a sequence of boundaries on the day line (docs/SESHAT-v0.md §2.3).
 *
 * This first step carries one kind: a unit that never resets and has a
 * constant length, anchored on the day its index 0 starts. It is the internal
 * calendar's year. The length is the stored decimal and may be fractional (a
 * 365.25-day year works today and is kept), so a boundary need not fall on a
 * whole day; exact variable-length years are P3. Child slots, staged starts
 * and resets come with the calendars that need them.
 */
export interface FixedUnit {
  /** the day on which index 0 starts (V1: a unit that never resets has an anchor) */
  readonly anchor: number;
  /** days per occurrence, > 0 */
  readonly length: number;
}

/** Which occurrence of `unit` holds `day`, and how far into it: the float steps InternalCalendar has always used. */
export function positionIn(unit: FixedUnit, day: number): { index: number; offset: number } {
  const d = day - unit.anchor;
  const index = Math.floor(d / unit.length);
  return { index, offset: d - index * unit.length };
}

/** The day on which occurrence `index` starts. */
export function startOf(unit: FixedUnit, index: number): number {
  return unit.anchor + index * unit.length;
}
