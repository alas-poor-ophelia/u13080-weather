/**
 * The proleptic Gregorian calendar as a Seshat AST (docs/SESHAT-v0.md §4):
 * a leap gear (+4, −100, +400) on the year, months as slots with February
 * the slack, a seven-day week, and the day names on a one-day weekday cycle.
 *
 * Day 0 is 1970-01-01, so a day is a Unix day and the tests compare against
 * Date. Year indices are astronomical years (year 0 is 1 BC).
 */
import type { CalendarAst } from "../ast";

/** Days from 0000-01-01 to 1970-01-01. */
const YEAR_0 = -719_528;

export const GREGORIAN: CalendarAst = {
  name: "Gregorian",
  gears: [
    {
      id: "leap",
      on: "year",
      kind: "intervals",
      terms: [
        { every: 4, sign: 1 },
        { every: 100, sign: -1 },
        { every: 400, sign: 1 },
      ],
    },
  ],
  units: [
    { id: "year", kind: "cycle", anchor: YEAR_0, length: 365, gears: [{ gear: "leap", add: 1 }] },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [
        { name: "January", length: 31 },
        { name: "February", length: "slack" },
        { name: "March", length: 31 },
        { name: "April", length: 30 },
        { name: "May", length: 31 },
        { name: "June", length: 30 },
        { name: "July", length: 31 },
        { name: "August", length: 31 },
        { name: "September", length: 30 },
        { name: "October", length: 31 },
        { name: "November", length: 30 },
        { name: "December", length: 31 },
      ],
    },
    // 1970-01-04 was a Sunday. Labels name occurrences, so the day names sit on a one-day cycle:
    // seven labels on the seven-day week would name weeks.
    { id: "week", kind: "cycle", anchor: 3, length: 7 },
    { id: "weekday", kind: "cycle", anchor: 3, length: 1, labels: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((name) => ({ name })) },
  ],
};
