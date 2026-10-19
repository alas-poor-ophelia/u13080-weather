/**
 * Seshat (U+132C7): Wadjet's internal recurrence library. Design brief:
 * docs/SESHAT-v0.md (local). Imports nothing outside src/seshat (lint-enforced).
 */
export { Body, bodyFor, bodyFromNumbers, moonPhase } from "./body";
export { dayIn, dayOf, type FixedYearCalendar, type MoonDef } from "./calendar";
export { positionIn, startOf, type FixedUnit } from "./unit";
export type { CalendarAst, ConstantCycleAst, CrossingAst, CrossingCycleAst, CycleUnitAst, GearTerm, KeyedLength, LabelAst, LedgerEntry, CycleRule, ConstantRule, CrossingRule, DayLabelAst, RuleDefAst, SlotAst, SlotsUnitAst, StageAst, StageRule, UnitAst } from "./ast";
export { baseIndexAt, baseLengths, baseStart, linearBase, type LinearBase } from "./base";
export { DAY_LIMIT } from "./day";
export { gearBelow, gearDensity, gearDeviation, gearMatches, gearPeriod, type GearAst } from "./gear";
export { Engine, type Position } from "./engine";
export { checkRule, validate } from "./validate";
export { GREGORIAN } from "./calendars/gregorian";
export { ISLAMIC_CIVIL, ISLAMIC_TBLA } from "./calendars/islamic";
export { COPTIC, ETHIOPIAN } from "./calendars/ethiopian";
export { FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX } from "./calendars/french";
export { HARPTOS } from "./calendars/harptos";
export { HEBREW } from "./calendars/hebrew";
export { MAYA } from "./calendars/maya";
export { BALINESE } from "./calendars/balinese";
export { ROMAN } from "./calendars/roman";
export { BAHAI } from "./calendars/bahai";
export { wrap } from "./phase";
export { evaluate, inPhase, TimeView, type By, type DayView, type EvalOptions, type HostKey, type Recur, type RuleAst, type TimeLike } from "./rule";
export { COUNT_WORK_MAX, EngineDays, SETPOS_PERIOD_MAX } from "./engine-view";
export { DEFAULT_YEAR_LENGTH, yearOf } from "./year";
export { approximate, frac, fromNumber, gcd, rational, toNumber, type Rational } from "./rational";

/** Folded into the internal calendar's configHash: bump when Seshat changes any computed value. */
export const SESHAT_VERSION = "seshat/1" as const;
