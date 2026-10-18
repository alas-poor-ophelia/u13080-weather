import { describe, expect, test } from "bun:test";
import { BALINESE, DAY_LIMIT, Engine, validate } from "../src/seshat";

const DAY_MS = 86_400_000;

function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

const mod = (a: number, m: number) => ((a % m) + m) % m;
const amod = (a: number, m: number) => mod(a - 1, m) + 1;

/**
 * The oracle: Reingold's bali-*-from-fixed functions (calendar-code2,
 * calendar.l), transcribed one by one from the fixed date, in their own
 * 1-based numbering. The AST builds its label table per pawukon day instead.
 */
function oracle(date: number) {
  const day = mod(date - -2_440_442, 210);
  const pancawara = amod(day + 2, 5);
  const saptawara = 1 + mod(day, 7);
  const dasawara = mod(1 + [5, 9, 7, 4, 8][pancawara - 1]! + [5, 4, 3, 7, 8, 6, 9][saptawara - 1]!, 10);
  const asatawara = 1 + mod(Math.max(6, 4 + mod(day - 70, 210)), 8);
  return {
    wuku: 1 + Math.floor(day / 7),
    triwara: 1 + mod(day, 3),
    pancawara,
    sadwara: 1 + mod(day, 6),
    saptawara,
    luang: dasawara % 2 === 0,
    dwiwara: amod(dasawara, 2),
    caturwara: amod(asatawara, 4),
    asatawara,
    sangawara: 1 + mod(Math.max(0, day - 3), 9),
    dasawara,
  };
}

const NAMES = {
  pancawara: ["Umanis", "Paing", "Pon", "Wage", "Kliwon"],
  dwiwara: ["Menga", "Pepet"],
  caturwara: ["Sri", "Laba", "Jaya", "Menala"],
  asatawara: ["Sri", "Indra", "Guru", "Yama", "Ludra", "Brahma", "Kala", "Uma"],
  sangawara: ["Dangu", "Jangur", "Gigis", "Nohan", "Ogan", "Erangan", "Urungan", "Tulus", "Dadi"],
};

describe("seshat: Balinese pawukon", () => {
  const bali = new Engine(BALINESE);
  const name = (id: string, d: number) => bali.labelAt(id, d)!.name;
  const tag = (d: number, week: string) => bali.labelAt("pawukon-day", d)!.tags!.find((t) => t.startsWith(`${week}:`))!.slice(week.length + 1);

  test("the AST is valid; every Galungan and Kuningan of 2024 and 2025 falls on its published day", () => {
    expect(validate(BALINESE)).toEqual([]);
    // Galungan: Buda Kliwon Dungulan; Kuningan ten days later: Saniscara Kliwon Kuningan
    for (const [y, m, d] of [[2024, 2, 28], [2024, 9, 25], [2025, 4, 23], [2025, 11, 19]] as const) {
      const g = gregorianDay(y, m, d);
      expect([name("saptawara", g), name("pancawara", g), name("wuku", g)]).toEqual(["Buda", "Kliwon", "Dungulan"]);
      expect([name("saptawara", g + 10), name("pancawara", g + 10), name("wuku", g + 10)]).toEqual(["Saniscara", "Kliwon", "Kuningan"]);
    }
  });

  test("agrees with Reingold's functions on every day over ±1,000,000 days, and strided to ±DAY_LIMIT", () => {
    let bad = 0;
    const read = (d: number) => {
      const tags = bali.labelAt("pawukon-day", d)!.tags!;
      const index = (id: string, list: readonly string[]) => list.indexOf(name(id, d)!) + 1;
      return {
        wuku: bali.positionOf("wuku", d)!.index + 1,
        triwara: index("triwara", ["Pasah", "Beteng", "Kajeng"]),
        pancawara: index("pancawara", NAMES.pancawara),
        sadwara: index("sadwara", ["Tungleh", "Aryang", "Urukung", "Paniron", "Was", "Maulu"]),
        saptawara: index("saptawara", ["Redite", "Coma", "Anggara", "Buda", "Wraspati", "Sukra", "Saniscara"]),
        luang: tags.includes("luang"),
        dwiwara: NAMES.dwiwara.indexOf(tag(d, "dwiwara")) + 1,
        caturwara: NAMES.caturwara.indexOf(tag(d, "caturwara")) + 1,
        asatawara: NAMES.asatawara.indexOf(tag(d, "asatawara")) + 1,
        sangawara: NAMES.sangawara.indexOf(tag(d, "sangawara")) + 1,
        dasawara: Number(tag(d, "dasawara")),
      };
    };
    const check = (d: number) => {
      const [a, b] = [read(d), oracle(d)];
      if (JSON.stringify(a) !== JSON.stringify(b)) if (bad++ < 5) expect({ d, a }).toEqual({ d, a: b });
    };
    for (let d = -1_000_000; d <= 1_000_000; d++) check(d);
    for (let d = -DAY_LIMIT; d <= DAY_LIMIT; d += 9_973) check(d);
    expect(bad).toBe(0);
  }, 120_000);

  test("the documented irregularities: Dangu pat, Kala tiga with Jaya tiga in Dungulan", () => {
    const start = gregorianDay(2024, 2, 28) - 73; // a Sinta 1
    expect([0, 1, 2, 3, 4].map((d) => tag(start + d, "sangawara"))).toEqual(["Dangu", "Dangu", "Dangu", "Dangu", "Jangur"]);
    expect([69, 70, 71, 72, 73].map((d) => tag(start + d, "asatawara"))).toEqual(["Brahma", "Kala", "Kala", "Kala", "Uma"]); // day 69: 4 + 209 = 213, mod 8 is Brahma
    expect([70, 71, 72].map((d) => tag(start + d, "caturwara"))).toEqual(["Jaya", "Jaya", "Jaya"]);
    expect(name("wuku", start + 70)).toBe("Dungulan");
  });

  test("dwiwara and luang follow the parity of the urip sum (Menga when even; luang when odd)", () => {
    const urip5 = { Umanis: 5, Paing: 9, Pon: 7, Wage: 4, Kliwon: 8 } as Record<string, number>;
    const urip7 = { Redite: 5, Coma: 4, Anggara: 3, Buda: 7, Wraspati: 8, Sukra: 6, Saniscara: 9 } as Record<string, number>;
    const start = gregorianDay(2024, 2, 28) - 73;
    for (let d = start; d < start + 210; d++) {
      const sum = urip5[name("pancawara", d)!]! + urip7[name("saptawara", d)!]!;
      expect(tag(d, "dwiwara")).toBe(sum % 2 === 0 ? "Menga" : "Pepet");
      expect(bali.tagsAt(d).includes("luang")).toBe(sum % 2 === 1);
    }
  });
});
