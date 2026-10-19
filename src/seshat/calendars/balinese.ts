/**
 * The Balinese pawukon as a Seshat AST (§12): a 210-day cycle of thirty
 * seven-day wuku, with its concurrent weeks.
 *
 * - The 3-, 5-, 6- and 7-day weeks (triwara, pancawara, sadwara, saptawara)
 *   divide 210, so each is a day-level cycle with modular labels (C5).
 * - The irregular weeks (dwiwara, caturwara, asatawara, sangawara, dasawara,
 *   and the luang day) cannot be modular: one 210-entry label table over the
 *   pawukon day carries them as tags. The table is built here from Dershowitz
 *   & Reingold's rules, checked against Reingold's published calendar code:
 *   the dasawara from the urip (day values) of the pancawara and saptawara,
 *   dwiwara and luang from the dasawara; asatawara and caturwara hold one
 *   value for three days in Dungulan (Kala tiga, Jaya tiga); sangawara holds
 *   Dangu for the first four days (Dangu pat).
 *
 * Day 0 is 1970-01-01. The pawukon epoch is day −2,440,442 (D&R's
 * bali-epoch, R.D. −1721279), so Galungan, Buda Kliwon Dungulan, is pawukon
 * day 73: 28 February 2024, 23 April 2025.
 */
import type { CalendarAst, LabelAst } from "../ast";

/** Days from 1970-01-01 to the start of a pawukon (R.D. −1721279 − R.D. 719163). */
const EPOCH = -2_440_442;

const WUKU = ["Sinta", "Landep", "Ukir", "Kulantir", "Tolu", "Gumbreg", "Wariga", "Warigadian", "Julungwangi", "Sungsangtaun", "Dungulan", "Kuningan", "Langkir", "Medangsia", "Pujut", "Pahang", "Krulut", "Merakih", "Tambir", "Medangkungan", "Matal", "Uye", "Menail", "Prangbakat", "Bala", "Ugu", "Wayang", "Kelawu", "Dukut", "Watugunung"];
const TRIWARA = ["Pasah", "Beteng", "Kajeng"];
const PANCAWARA = ["Umanis", "Paing", "Pon", "Wage", "Kliwon"];
const SADWARA = ["Tungleh", "Aryang", "Urukung", "Paniron", "Was", "Maulu"];
const SAPTAWARA = ["Redite", "Coma", "Anggara", "Buda", "Wraspati", "Sukra", "Saniscara"];
const DWIWARA = ["Menga", "Pepet"];
const CATURWARA = ["Sri", "Laba", "Jaya", "Menala"];
const ASATAWARA = ["Sri", "Indra", "Guru", "Yama", "Ludra", "Brahma", "Kala", "Uma"];
const SANGAWARA = ["Dangu", "Jangur", "Gigis", "Nohan", "Ogan", "Erangan", "Urungan", "Tulus", "Dadi"];
const URIP_5 = [5, 9, 7, 4, 8];
const URIP_7 = [5, 4, 3, 7, 8, 6, 9];

const mod = (a: number, m: number) => ((a % m) + m) % m;
const names = (list: readonly string[]): LabelAst[] => list.map((name) => ({ name }));

/**
 * Tags for pawukon day `d` (0..209): the irregular weeks, as in Reingold's
 * calendar code (calendar-code2, bali-*-from-fixed). The dasawara is tagged
 * by its D&R position 0..9: the order of its ten names is not yet pinned to a
 * source, so no name is guessed.
 */
function irregular(d: number): LabelAst {
  const dasawara = mod(1 + URIP_5[mod(d + 1, 5)]! + URIP_7[mod(d, 7)]!, 10);
  const asatawara = mod(Math.max(6, 4 + mod(d - 70, 210)), 8);
  return {
    tags: [
      // luang on an even dasawara; dwiwara amod(dasawara, 2): Menga on an odd one, Pepet on an even (urip sum even = Menga)
      ...(dasawara % 2 === 0 ? ["luang"] : []),
      `dwiwara:${DWIWARA[dasawara % 2 === 1 ? 0 : 1]}`,
      `caturwara:${CATURWARA[asatawara % 4]}`,
      `asatawara:${ASATAWARA[asatawara]}`,
      `sangawara:${SANGAWARA[mod(Math.max(0, d - 3), 9)]}`,
      `dasawara:${dasawara}`,
    ],
  };
}

export const BALINESE: CalendarAst = {
  name: "Balinese pawukon",
  // the pawukon has no year count: the conventional name of a day repeats every 210 days (format-only)
  formats: [{ name: "default", pattern: "{saptawara:name} {pancawara:name} {wuku:name}" }],
  gears: [],
  units: [
    { id: "pawukon", kind: "cycle", anchor: EPOCH, length: 210 },
    { id: "wuku", kind: "slots", in: "pawukon", slots: WUKU.map((name) => ({ name, length: 7 })) },
    { id: "triwara", kind: "cycle", anchor: EPOCH, length: 1, labels: names(TRIWARA) },
    // pawukon day 0 is Paing: the pancawara runs one ahead
    { id: "pancawara", kind: "cycle", anchor: EPOCH - 1, length: 1, labels: names(PANCAWARA) },
    { id: "sadwara", kind: "cycle", anchor: EPOCH, length: 1, labels: names(SADWARA) },
    { id: "saptawara", kind: "cycle", anchor: EPOCH, length: 1, labels: names(SAPTAWARA) },
    { id: "pawukon-day", kind: "cycle", anchor: EPOCH, length: 1, labels: Array.from({ length: 210 }, (_, d) => irregular(d)) },
  ],
};
