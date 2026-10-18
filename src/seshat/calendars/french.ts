/**
 * The French Republican calendar, arithmetic (Romme) form, as a Seshat AST
 * (docs/SESHAT-v0.md §12; ruled 2026-10-18): twelve 30-day months of three
 * décades, then the sansculottides, filler days outside every month and
 * décade, 5 or 6 in a leap year. Year y is leap when y mod 4 = 0, except
 * y mod 400 in {100, 200, 300}, and except y mod 4000 = 0 (Dershowitz &
 * Reingold's arithmetic French Revolutionary calendar).
 *
 * The Romme rule differs from the calendar as used in 1792–1805, whose leap
 * years (III, VII, XI) followed the autumn equinox; that variant would come
 * from the ledger.
 *
 * Day 0 is 1970-01-01, as for GREGORIAN. Year index i is year i + 1, so each
 * leap interval carries offset −1.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 1 Vendémiaire I: 22 September 1792. */
const EPOCH = -64_748;

const MONTHS = ["Vendémiaire", "Brumaire", "Frimaire", "Nivôse", "Pluviôse", "Ventôse", "Germinal", "Floréal", "Prairial", "Messidor", "Thermidor", "Fructidor"];

export const FRENCH_REPUBLICAN: CalendarAst = {
  name: "French Republican (Romme)",
  gears: [
    {
      id: "leap",
      on: "year",
      kind: "intervals",
      terms: [
        { every: 4, offset: -1, sign: 1 },
        { every: 100, offset: -1, sign: -1 },
        { every: 400, offset: -1, sign: 1 },
        { every: 4000, offset: -1, sign: -1 },
      ],
    },
  ],
  units: [
    { id: "year", kind: "cycle", anchor: EPOCH, length: 365, gears: [{ gear: "leap", add: 1 }] },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [...MONTHS.map((name) => ({ name, length: 30 })), { name: "Sansculottides", length: "slack" as const, filler: true }],
    },
    { id: "decade", kind: "slots", in: "month", slots: [{ length: 10 }, { length: 10 }, { length: 10 }] },
  ],
};
