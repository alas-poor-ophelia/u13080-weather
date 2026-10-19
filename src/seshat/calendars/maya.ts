/**
 * The Maya Long Count, Tzolk'in and Haab' as one Seshat AST (§12).
 *
 * - Long Count: the baktun is a 144,000-day cycle; katun (20 in a baktun),
 *   tun (20 in a katun), uinal (18 in a tun) and kin (20 in a uinal) are
 *   nested slot units, so a day's position in each is its digit.
 * - Tzolk'in: two day-level cycles, 13 numbers and 20 day names, labelled
 *   by occurrence (C5).
 * - Haab': a 365-day cycle of 18 twenty-day months and the 5-day Wayeb.
 *
 * The Tzolk'in and Haab' together repeat every 18,980 days (the Calendar
 * Round; Engine.round, V6).
 *
 * GMT correlation (JDN 584283): 0.0.0.0.0 4 Ajaw 8 Kumk'u is 11 August 3114
 * BCE (proleptic Gregorian), day −1,856,305 from 1970-01-01. Haab' days are
 * counted from 0, the "seating" of the month.
 */
import type { CalendarAst } from "../ast";

/** Days from 1970-01-01 to 0.0.0.0.0 (JDN 584283 − JDN 2440588). */
const EPOCH = -1_856_305;

const DAY_NAMES = ["Imix", "Ik'", "Ak'b'al", "K'an", "Chikchan", "Kimi", "Manik'", "Lamat", "Muluk", "Ok", "Chuwen", "Eb'", "B'en", "Ix", "Men", "Kib'", "Kab'an", "Etz'nab'", "Kawak", "Ajaw"];
const HAAB_MONTHS = ["Pop", "Wo'", "Sip", "Sotz'", "Sek", "Xul", "Yaxk'in", "Mol", "Ch'en", "Yax", "Sak'", "Keh", "Mak", "K'ank'in", "Muwan", "Pax", "K'ayab", "Kumk'u"];

const times = (n: number, length: number) => Array.from({ length: n }, () => ({ length }));

export const MAYA: CalendarAst = {
  name: "Maya (GMT correlation)",
  // the Long Count names one day; the Calendar Round repeats every 18,980 days, so it is format-only
  formats: [
    { name: "default", pattern: "{baktun}.{katun}.{tun}.{uinal}.{kin}" },
    { name: "round", pattern: "{tzolkin-number:name} {tzolkin-name:name} {haab-month:day0} {haab-month:name}" },
  ],
  gears: [],
  units: [
    { id: "baktun", kind: "cycle", anchor: EPOCH, length: 144_000 },
    { id: "katun", kind: "slots", number: 0, in: "baktun", slots: times(20, 7_200) },
    { id: "tun", kind: "slots", number: 0, in: "katun", slots: times(20, 360) },
    { id: "uinal", kind: "slots", number: 0, in: "tun", slots: times(18, 20) },
    { id: "kin", kind: "slots", number: 0, in: "uinal", slots: times(20, 1) },
    // the epoch is 4 Ajaw: number label 4 (index 3), day name Ajaw (index 19)
    { id: "tzolkin-number", kind: "cycle", anchor: EPOCH - 3, length: 1, labels: Array.from({ length: 13 }, (_, i) => ({ name: String(i + 1) })) },
    { id: "tzolkin-name", kind: "cycle", anchor: EPOCH - 19, length: 1, labels: DAY_NAMES.map((name) => ({ name })) },
    // the epoch is 8 Kumk'u: day 348 of the Haab' (17 months of 20, then 8)
    { id: "haab", kind: "cycle", anchor: EPOCH - 348, length: 365 },
    { id: "haab-month", kind: "slots", in: "haab", slots: [...HAAB_MONTHS.map((name) => ({ name, length: 20 })), { name: "Wayeb", length: 5 }] },
  ],
};
