/**
 * The French Republican calendar, arithmetic (Romme) form, as a Seshat AST
 * (docs/SESHAT-v0.md §12; ruled 2026-10-18): twelve 30-day months of three
 * décades, then the sansculottides, filler days outside every month and
 * décade, 5 or 6 in a leap year. Year y is leap when y mod 4 = 0, except
 * y mod 400 in {100, 200, 300}, and except y mod 4000 = 0 (Dershowitz &
 * Reingold's arithmetic French Revolutionary calendar).
 *
 * The Romme rule differs from the calendar as used in 1792–1805, whose leap
 * years (III, VII, XI) followed the autumn equinox: FRENCH_REPUBLICAN_EQUINOX
 * below.
 *
 * Day 0 is 1970-01-01, as for GREGORIAN. Year index i is year i + 1, so each
 * leap interval carries offset −1.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 1 Vendémiaire I: 22 September 1792. */
const EPOCH = -64_748;

const MONTHS = ["Vendémiaire", "Brumaire", "Frimaire", "Nivôse", "Pluviôse", "Ventôse", "Germinal", "Floréal", "Prairial", "Messidor", "Thermidor", "Fructidor"];

/** Months of three décades, then the sansculottides: slack (5 or 6 days) and filler, so they hold no décade. */
const UNITS_BELOW_YEAR: CalendarAst["units"] = [
  {
    id: "month",
    kind: "slots",
    in: "year",
    slots: [...MONTHS.map((name) => ({ name, length: 30 })), { name: "Sansculottides", length: "slack" as const, filler: true }],
  },
  { id: "decade", kind: "slots", in: "month", slots: [{ length: 10 }, { length: 10 }, { length: 10 }] },
];

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
  units: [{ id: "year", kind: "cycle", anchor: EPOCH, length: 365, gears: [{ gear: "leap", add: 1 }] }, ...UNITS_BELOW_YEAR],
};

/**
 * The calendar as legislated (decree of 4 Frimaire II): each year begins on
 * the day, in Paris, that holds the true autumn equinox, so its leap years are
 * derived, not declared (docs/SESHAT-v0.md §2.3.1). The sun here is a
 * mark-calibrated linear body: crossing 0 is the equinox the decree states,
 * 22 September 1792 at 9 h 18 min 30 s in the morning, Paris apparent time
 * (Q9, ruled 2026-10-18), and one more every 365.24202 days, the mean
 * September-equinox year. It reproduces the years I–XIV as used, but so does
 * any crossing-0 time from 08:07 to 12:22 with any period from 365.2420 to
 * 365.25: that table checks the mechanism, not the sun. Past XIV this is a
 * model, not the true equinox; the true-equinox gate is wadjet-01k.9.
 */
export const FRENCH_REPUBLICAN_EQUINOX: CalendarAst = {
  name: "French Republican (equinox rule)",
  gears: [],
  units: [
    // EPOCH + 9:18:30 = −64748 + 1117/2880; 365.24202 = 18262101/50000
    { id: "year", kind: "cycle", crossing: { period: { n: 18_262_101, d: 50_000 }, at: { n: -186_473_123, d: 2880 } } },
    ...UNITS_BELOW_YEAR,
  ],
};
