import { describe, expect, test } from "bun:test";
import { BAHAI, Engine, validate, type CalendarAst, type CycleUnitAst } from "../src/seshat";

const DAY_MS = 86_400_000;
const greg = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS;

/**
 * "Badíʻ dates 172 to 221 BE", prepared at the Baháʼí World Centre with data
 * from HM Nautical Almanac Office (2014; bahai-library.com/4838): the March
 * day of Naw-Rúz for BE 172–221 (2015–2064) and the length of Ayyám-i-Há for
 * BE 172–221. Transcribed from the table; the two columns agree with each
 * other for every year (length = Naw-Rúz to Naw-Rúz = 361 + Ayyám-i-Há).
 */
const NAW_RUZ_MARCH = [21, 20, 20, 21, 21, 20, 20, 21, 21, 20, 20, 21, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 21, 20, 20, 20, 20, 20, 20, 20, 20, 20];
const AYYAM_I_HA = [4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 5, 4, 4, 4, 4, 5, 4, 4, 4, 5, 4];

describe("seshat: Baháʼí", () => {
  const bahai = new Engine(BAHAI);
  const nawRuz = (be: number) => bahai.start("year", be - 1);

  test("the AST is valid; 19 months of 19 days with Ayyám-i-Há between Mulk and ʻAláʼ", () => {
    expect(validate(BAHAI)).toEqual([]);
    const lens = bahai.slotLengths("month", [171]);
    expect(lens.length).toBe(20);
    expect(lens.filter((l) => l === 19).length).toBe(19);
    expect(lens[18]).toBe(4); // BE 172
  });

  test("every Naw-Rúz and every Ayyám-i-Há of BE 172–221 matches the published table", () => {
    NAW_RUZ_MARCH.forEach((day, i) => expect([172 + i, nawRuz(172 + i)]).toEqual([172 + i, greg(2015 + i, 3, day)]));
    AYYAM_I_HA.forEach((days, i) => expect([172 + i, bahai.slotLengths("month", [171 + i])[18]]).toEqual([172 + i, days]));
  });

  test("BE 1–171: Naw-Rúz on 21 March, Ayyám-i-Há 5 days when the Gregorian February holds a 29th", () => {
    for (let be = 1; be <= 171; be++) {
      expect(nawRuz(be)).toBe(greg(1843 + be, 3, 21));
      const y = 1844 + be;
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      expect(bahai.slotLengths("month", [be - 1])[18]).toBe(leap ? 5 : 4);
    }
  });

  test("without its one pin, the calibrated linear sun misses exactly BE 183 in BE 172–221", () => {
    const year = BAHAI.units[0] as CycleUnitAst;
    const unpinned: CalendarAst = { ...BAHAI, units: [{ ...year, ledger: year.ledger!.filter((e) => e.kind !== "starts") }, BAHAI.units[1]!] };
    const e = new Engine(unpinned);
    const misses = NAW_RUZ_MARCH.flatMap((day, i) => (e.start("year", 171 + i) === greg(2015 + i, 3, day) ? [] : [172 + i]));
    expect(misses).toEqual([183]);
  });

  test("every day of BE 172–221 reads the month the published Naw-Rúz dates put it in", () => {
    for (let i = 0; i < 49; i++) {
      const start = greg(2015 + i, 3, NAW_RUZ_MARCH[i]!);
      const end = greg(2016 + i, 3, NAW_RUZ_MARCH[i + 1]!);
      for (let d = start; d < end; d++) {
        const off = d - start;
        const slot = off < 342 ? Math.floor(off / 19) : off < 342 + AYYAM_I_HA[i]! ? 18 : 19;
        expect(bahai.positionOf("year", d)!.index).toBe(171 + i);
        expect(bahai.positionOf("month", d)!.index).toBe(slot);
      }
    }
  });
});
