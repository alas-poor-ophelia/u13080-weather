/**
 * The Ethiopian and Coptic calendars as Seshat ASTs (docs/SESHAT-v0.md §12):
 * twelve 30-day months and a short 13th month (Pagume, or the Coptic
 * epagomenal days) that is the slack, 5 days or 6 in a leap year. A year y is
 * leap when y mod 4 = 3, a Julian-style rule with no century exception.
 *
 * Day 0 is 1970-01-01, as for GREGORIAN. Year index i is year i + 1 of the
 * era, so the leap gear is every 4th index from index 2.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 1 Meskerem 1 (Amete Mihret): 27 August 8 (proleptic Gregorian). */
const ETHIOPIAN_EPOCH = -716_367;
/** Days from 1970-01-01 to 1 Thout 1 (Era of Martyrs): 29 August 284 (proleptic Gregorian). */
const COPTIC_EPOCH = -615_558;

function alexandrian(name: string, epoch: number, months: readonly string[], last: string): CalendarAst {
  return {
    name,
    // leap when year mod 4 = 3, i.e. index mod 4 = 2
    gears: [{ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, offset: 2, sign: 1 }] }],
    units: [
      { id: "year", kind: "cycle", anchor: epoch, length: 365, gears: [{ gear: "leap", add: 1 }] },
      { id: "month", kind: "slots", in: "year", slots: [...months.map((m) => ({ name: m, length: 30 })), { name: last, length: "slack" as const }] },
    ],
  };
}

export const ETHIOPIAN = alexandrian(
  "Ethiopian",
  ETHIOPIAN_EPOCH,
  ["Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit", "Megabit", "Miyazya", "Ginbot", "Sene", "Hamle", "Nehase"],
  "Pagume",
);

export const COPTIC = alexandrian(
  "Coptic",
  COPTIC_EPOCH,
  ["Thout", "Paopi", "Hathor", "Koiak", "Tobi", "Meshir", "Paremhat", "Parmouti", "Pashons", "Paoni", "Epip", "Mesori"],
  "Pi Kogi Enavot",
);
