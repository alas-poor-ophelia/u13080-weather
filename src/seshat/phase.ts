/** Wrap any number into [0, 1). The form InternalCalendar and curve.ts have always used: 1 − ε rounding up to 1 maps to 0. */
export function wrap(x: number): number {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}
