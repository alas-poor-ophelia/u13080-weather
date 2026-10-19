/**
 * The Hebrew calendar as a Seshat AST (docs/SESHAT-v0.md §2.8, v0.4.1
 * decomposition), after Dershowitz & Reingold, Calendrical Calculations.
 *
 * - Base: the molad, a crossing with period 765433/25920 days (29 d 12 h
 *   793 p), read at the months elapsed before the year, floor((235y − 234)/19).
 *   Crossing 0 is the epoch plus 12084/25920 day: BaHaRaD (5 h 204 p) plus the
 *   six-hour "molad after noon" shift, applied here and nowhere else.
 * - Stage 1 (lo ADU rosh): one day later when the day count since the epoch,
 *   d, has 3(d + 1) mod 7 < 3, i.e. d mod 7 in {2, 4, 6}.
 * - Stage 2: two days later when next year's stage-1 length is 356; else one
 *   day later when last year's is 382.
 * - Months: Adar I is 30 days in a leap year (y mod 19 in {0, 3, 6, 8, 11, 14,
 *   17}) and absent otherwise; Heshvan and Kislev are slack, 29 or 30 each,
 *   Kislev filled first: 353/383 days leaves both at 29, 354/384 lengthens
 *   Kislev, 355/385 both. The allowed year lengths are a consequence of the
 *   stages, not a rule; the tests check every year over the whole range
 *   against the classic postponement rules (ICU's hebrew calendar is wrong in
 *   about 0.5% of years, so it is a cross-check only).
 *
 * Day 0 is 1970-01-01. Year index k is year k + 1 AM; 1 Tishri 1 AM is day
 * −2092590 (R.D. −1373427).
 */
import type { CalendarAst } from "../ast";
import { rational } from "../rational";

/** Days from 1970-01-01 to 1 Tishri AM 1 (7 October 3761 BCE, Julian). */
const EPOCH = -2_092_590;

export const HEBREW: CalendarAst = {
  name: "Hebrew",
  formats: [{ name: "default", pattern: "{month:day} {month:name} {year}" }],
  gears: [{ id: "leap", on: "year", kind: "positions", period: 19, positions: [0, 3, 6, 8, 11, 14, 17], offset: -1 }],
  units: [
    {
      id: "year",
      kind: "cycle",
      number: 1,
      crossing: {
        period: rational(765_433, 25_920),
        at: rational(EPOCH * 25_920 + 12_084, 25_920),
        // months elapsed before year k + 1: floor((235(k + 1) − 234) / 19)
        index: { a: 235, c: 1, L: 19 },
      },
      stages: [
        { rules: [{ add: 1, residue: { mod: 7, offset: EPOCH, in: [2, 4, 6] } }] },
        {
          rules: [
            { add: 2, length: { at: 0, is: 356 } },
            { add: 1, length: { at: -1, is: 382 } },
          ],
        },
      ],
    },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [
        { name: "Tishri", length: 30 },
        { name: "Heshvan", length: "slack", min: 29, max: 30, fill: 2 },
        { name: "Kislev", length: "slack", min: 29, max: 30, fill: 1 },
        { name: "Tevet", length: 29 },
        { name: "Shevat", length: 30 },
        { name: "Adar I", length: 0, gears: [{ gear: "leap", add: 30 }] },
        { name: "Adar", length: 29 },
        { name: "Nisan", length: 30 },
        { name: "Iyar", length: 29 },
        { name: "Sivan", length: 30 },
        { name: "Tamuz", length: 29 },
        { name: "Av", length: 30 },
        { name: "Elul", length: 29 },
      ],
    },
  ],
};
