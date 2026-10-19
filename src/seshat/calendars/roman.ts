/**
 * The Roman civil calendar as a Seshat AST (docs/SESHAT-v0.md §2.7.1, Q10).
 *
 * The year is the Varronian year (occurrence k is AUC k). The ledger pins the
 * starts Bennett reconstructs for AUC 492–753 (263–1 BC): pontifical
 * intercalation before Caesar (years of 355, 377 and 378 days, and 445 for
 * 46 BC), then the leap years as actually kept, and switches to the proleptic
 * Julian calendar at AUC 754, where Bennett's 1 January AD 1 is Julian's.
 * Before AUC 492 the unit's own rule is the Republican ideal (355, 377,
 * 355, 378 days in turn, 366¼ on average), anchored on Bennett's first start:
 * a fiction, kept so the day line stays tiled with years the months fit.
 *
 * Months are slots keyed on the year's length (Q11): February to the
 * Terminalia and a 27-day Intercalaris in an intercalary year, two extra
 * months in 46 BC, Julian lengths in a Julian year. The year is January-first
 * throughout (Q10a), though before 153 BC the consular year began in March.
 *
 * Source: C. J. Bennett, Roman-to-Julian conversion tables (© Chris Bennett
 * 2003-2012), "The Early Augustan Calendars in Rome and Egypt", ZPE 142
 * (2003) 221-240, addenda ZPE 147 (2004) 165-168; his 45 BC join (1 Ianuarius
 * 45 BC = 31 December 46 BC, Julian). Day 0 is 1970-01-01.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 1 January of AUC 0 (proleptic Julian, astronomical year −753). */
const AUC_0 = -994563;
/** The Republican ideal's start of AUC 0, chosen so its start of AUC 492 is Bennett's (day -814890). */
const REPUBLICAN_0 = -995085;

export const ROMAN: CalendarAst = {
  name: "Roman (Varronian years, Bennett's reconstruction)",
  // occurrence k is AUC k; days are counted forward in the month, not back from the Kalends
  formats: [{ name: "default", pattern: "{month:day} {month:name} AUC {year}" }],
  gears: [
    // the Republican ideal: an Intercalaris of 22 or 23 days every other year
    { id: "intercalary", on: "year", kind: "intervals", terms: [{ every: 2, offset: 1, sign: 1 }] },
    { id: "long-intercalary", on: "year", kind: "intervals", terms: [{ every: 4, offset: 3, sign: 1 }] },
    // proleptic Julian leap years: astronomical year y ≡ 0 mod 4, i.e. AUC k ≡ 1 mod 4
    { id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, offset: 1, sign: 1 }] },
  ],
  units: [
    {
      id: "year",
      kind: "cycle",
      anchor: REPUBLICAN_0,
      length: 355,
      gears: [
        { gear: "intercalary", add: 22 },
        { gear: "long-intercalary", add: 1 },
      ],
      ledger: [
        {
          kind: "starts",
          from: 492,
          startsOn: -814890,
          lengths: [355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 378, 355, 377, 355, 355, 378, 377, 355, 355, 355, 355, 378, 355, 355, 355, 377, 355, 378, 355, 355, 377, 355, 355, 355, 355, 355, 355, 355, 355, 355, 355, 378, 355, 378, 355, 377, 378, 355, 378, 355, 377, 378, 355, 378, 355, 378, 355, 377, 378, 355, 378, 355, 378, 355, 355, 377, 378, 355, 377, 378, 355, 377, 378, 355, 377, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 355, 378, 355, 355, 378, 355, 355, 378, 355, 355, 378, 355, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 378, 355, 355, 378, 355, 355, 378, 355, 355, 378, 355, 355, 377, 355, 355, 378, 355, 355, 355, 355, 355, 445, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 366, 365, 365, 365, 365, 365, 365],
        },
        { kind: "switch", from: 754, rule: { anchor: AUC_0, length: 365, gears: [{ gear: "leap", add: 1 }] } },
      ],
    },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [
        { name: "Ianuarius", length: { by: "parent", table: [[355, 29], [365, 31], [366, 31], [377, 29], [378, 29], [445, 29]] } },
        { name: "Februarius", length: { by: "parent", table: [[355, 28], [365, 28], [366, 29], [377, 23], [378, 24], [445, 24]] } },
        { name: "Intercalaris", length: { by: "parent", table: [[355, 0], [365, 0], [366, 0], [377, 27], [378, 27], [445, 27]] } },
        { name: "Martius", length: { by: "parent", table: [[355, 31], [365, 31], [366, 31], [377, 31], [378, 31], [445, 31]] } },
        { name: "Aprilis", length: { by: "parent", table: [[355, 29], [365, 30], [366, 30], [377, 29], [378, 29], [445, 29]] } },
        { name: "Maius", length: { by: "parent", table: [[355, 31], [365, 31], [366, 31], [377, 31], [378, 31], [445, 31]] } },
        { name: "Iunius", length: { by: "parent", table: [[355, 29], [365, 30], [366, 30], [377, 29], [378, 29], [445, 29]] } },
        { name: "Quintilis", length: { by: "parent", table: [[355, 31], [365, 31], [366, 31], [377, 31], [378, 31], [445, 31]] } },
        { name: "Sextilis", length: { by: "parent", table: [[355, 29], [365, 31], [366, 31], [377, 29], [378, 29], [445, 29]] } },
        { name: "September", length: { by: "parent", table: [[355, 29], [365, 30], [366, 30], [377, 29], [378, 29], [445, 29]] } },
        { name: "October", length: { by: "parent", table: [[355, 31], [365, 31], [366, 31], [377, 31], [378, 31], [445, 31]] } },
        { name: "November", length: { by: "parent", table: [[355, 29], [365, 30], [366, 30], [377, 29], [378, 29], [445, 34]] } },
        { name: "Intercalaris prior", length: { by: "parent", table: [[355, 0], [365, 0], [366, 0], [377, 0], [378, 0], [445, 31]] } },
        { name: "Intercalaris posterior", length: { by: "parent", table: [[355, 0], [365, 0], [366, 0], [377, 0], [378, 0], [445, 31]] } },
        { name: "December", length: { by: "parent", table: [[355, 29], [365, 31], [366, 31], [377, 29], [378, 29], [445, 29]] } },
      ],
    },
  ],
};
