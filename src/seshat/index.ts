/**
 * Seshat (U+132C7): Wadjet's internal recurrence library. Design brief:
 * docs/SESHAT-v0.md (local). Imports nothing outside src/seshat (lint-enforced).
 */
export { Body, bodyFor, bodyFromNumbers, moonPhase } from "./body";
export { dayIn, dayOf, type FixedYearCalendar, type MoonDef } from "./calendar";
export { positionIn, startOf, type FixedUnit } from "./unit";
export { wrap } from "./phase";
export { DEFAULT_YEAR_LENGTH, yearOf } from "./year";
export { approximate, frac, fromNumber, gcd, rational, toNumber, type Rational } from "./rational";

/** Folded into the internal calendar's configHash: bump when Seshat changes any computed value. */
export const SESHAT_VERSION = "seshat/1" as const;
