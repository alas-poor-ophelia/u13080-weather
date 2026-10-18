/**
 * The tabular Islamic calendar as a Seshat AST (docs/SESHAT-v0.md §2.4): a
 * 354-day year with a leap day in 11 years of every 30, months alternating
 * 30 and 29 days, and Dhu al-Hijjah the slack (29, or 30 in a leap year).
 *
 * Leap years are those with (14 + 11y) mod 30 < 11, i.e. y mod 30 in
 * {2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29}: ICU's islamic-civil and
 * islamic-tbla. The two differ by epoch only: civil puts 1 Muharram 1 AH on
 * 19 July 622 (proleptic Gregorian), tbla a day earlier. Day 0 is
 * 1970-01-01, as for GREGORIAN. Year index i is AH year i + 1 (ICU counts on
 * through 0 and negatives before 1 AH).
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 1 Muharram 1 AH, civil epoch (Friday 19 July 622). */
const CIVIL_EPOCH = -492_148;

const MONTHS = ["Muharram", "Safar", "Rabi al-Awwal", "Rabi al-Thani", "Jumada al-Ula", "Jumada al-Akhirah", "Rajab", "Shaban", "Ramadan", "Shawwal", "Dhu al-Qadah"];

function tabularIslamic(name: string, epoch: number): CalendarAst {
  return {
    name,
    // positions are AH year numbers mod 30; index i is year i + 1, hence offset −1
    gears: [{ id: "leap", on: "year", kind: "positions", period: 30, positions: [2, 5, 7, 10, 13, 16, 18, 21, 24, 26, 29], offset: -1 }],
    units: [
      { id: "year", kind: "cycle", anchor: epoch, length: 354, gears: [{ gear: "leap", add: 1 }] },
      {
        id: "month",
        kind: "slots",
        in: "year",
        slots: [...MONTHS.map((m, i) => ({ name: m, length: i % 2 ? 29 : 30 })), { name: "Dhu al-Hijjah", length: "slack" as const }],
      },
    ],
  };
}

export const ISLAMIC_CIVIL = tabularIslamic("Tabular Islamic (civil epoch)", CIVIL_EPOCH);
export const ISLAMIC_TBLA = tabularIslamic("Tabular Islamic (astronomical epoch)", CIVIL_EPOCH - 1);
