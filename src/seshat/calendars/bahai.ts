/**
 * The Baháʼí (Badíʻ) calendar as a Seshat AST (docs/SESHAT-v0.md §2.7.1).
 *
 * Nineteen months of nineteen days, with Ayyám-i-Há (4 or 5 days, the slack)
 * between Mulk and ʻAláʼ. The year begins at Naw-Rúz:
 * - BE 1–171 (to 2014): 21 March, a Gregorian-keyed rule; the year holds the
 *   29 February of the next Gregorian year, so it is 366 days long when that
 *   year is a Gregorian leap year.
 * - BE 172 on (2015): the day, in Tehran, holding the March equinox (a
 *   ledger switch to a crossing base). The sun is a mark-calibrated linear
 *   body: crossing for BE 172 at the 2015 equinox, 20 March 22:45 UT, which
 *   is 02:15 on 21 March in Tehran (UT+3:30); the Baháʼí day begins at sunset,
 *   taken as 18:15, so the instant is 5 h 45 min before the day's end. One
 *   more crossing every 365.24237 days, the mean March-equinox year.
 * - BE 183 (21 March 2026) is pinned: the linear sun puts it on 20 March. The
 *   published table is the authority; this is the one year in BE 172–221
 *   where the two disagree (checked in the tests, with the calibration window).
 *
 * Day numbers name the Gregorian date on which a Baháʼí day ends (it begins
 * at sunset the evening before), as the published table does. Year index k is
 * BE k + 1. Source for BE 172–221: "Badíʻ dates 172 to 221 BE", prepared at
 * the Baháʼí World Centre with data from HM Nautical Almanac Office (2014).
 * Day 0 is 1970-01-01.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 21 March 1844, Naw-Rúz of BE 1. */
const BE_1 = -45_941;

const MONTHS = ["Bahá", "Jalál", "Jamál", "ʻAẓamat", "Núr", "Raḥmat", "Kalimát", "Kamál", "Asmáʼ", "ʻIzzat", "Mashíyyat", "ʻIlm", "Qudrat", "Qawl", "Masáʼil", "Sharaf", "Sulṭán", "Mulk"];

export const BAHAI: CalendarAst = {
  name: "Baháʼí (Badíʻ)",
  gears: [
    // Gregorian leap years of the year after BE k + 1 begins: year 1845 + k divisible by 4, except by 100 unless by 400
    {
      id: "leap",
      on: "year",
      kind: "intervals",
      terms: [
        { every: 4, offset: 3, sign: 1 },
        { every: 100, offset: 55, sign: -1 },
        { every: 400, offset: 155, sign: 1 },
      ],
    },
  ],
  units: [
    {
      id: "year",
      kind: "cycle",
      anchor: BE_1,
      length: 365,
      gears: [{ gear: "leap", add: 1 }],
      ledger: [
        // BE 172: the Tehran equinox; crossing 0 placed so that crossing 171 is the 2015 equinox
        { kind: "switch", from: 171, rule: { crossing: { period: { n: 36_524_237, d: 100_000 }, at: { n: -13_782_333_581, d: 300_000 } } } },
        // BE 183: the published Naw-Rúz, 21 March 2026, where the linear sun says 20 March
        { kind: "starts", from: 182, startsOn: 20_533 },
      ],
    },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [...MONTHS.map((name) => ({ name, length: 19 })), { name: "Ayyám-i-Há", length: "slack" as const, min: 4, max: 5 }, { name: "ʻAláʼ", length: 19 }],
    },
  ],
};
