import { describe, expect, test } from "bun:test";
import { COPTIC, Engine, ETHIOPIAN, validate } from "../src/seshat";

const DAY_MS = 86_400_000;

/** A proleptic Gregorian date as a day (Date.UTC would read years 0–99 as 1900–1999). */
function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

/** ICU's reading of a day as [year, month 0-based, day of month], with the era folded into one year line by `year`. */
function icu(calendar: string, year: (era: string, y: number) => number): (d: number) => [number, number, number] {
  const f = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric", era: "short" });
  expect(f.resolvedOptions().calendar).toBe(calendar);
  return (d) => {
    const parts = f.formatToParts(new Date(d * DAY_MS));
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return [year(get("era"), Number(get("year"))), Number(get("month")) - 1, Number(get("day"))];
  };
}

function compare(e: Engine, want: (d: number) => [number, number, number], from: number, to: number, stride: number): void {
  let bad = 0;
  for (let d = from; d <= to; d += stride) {
    const m = e.positionOf("month", d)!;
    const got = [e.positionOf("year", d)!.index + 1, m.index, m.offset + 1];
    const w = want(d);
    if (got[0] !== w[0] || got[1] !== w[1] || got[2] !== w[2]) if (bad++ < 5) expect({ d, got }).toEqual({ d, got: w });
  }
  expect(bad).toBe(0);
}

describe("seshat: Ethiopian and Coptic against ICU", () => {
  const eth = new Engine(ETHIOPIAN);
  const cop = new Engine(COPTIC);
  // ethioaa is one unbroken era, Amete Alem = Amete Mihret + 5500; coptic's era before year 1 counts back (year 0 is
  // its year 1). ICU 73 names that era ERA0, ICU 78 something else: a day whose era is not day 0's is before the epoch.
  const amete = icu("ethioaa", (_era, y) => y - 5500);
  const anno = new Intl.DateTimeFormat("en-u-ca-coptic", { timeZone: "UTC", year: "numeric", era: "short" }).formatToParts(new Date(0)).find((p) => p.type === "era")!.value;
  const coptic = icu("coptic", (era, y) => (era === anno ? y : 1 - y));

  test("both ASTs are valid, and year 1 starts on the documented days", () => {
    expect(validate(ETHIOPIAN)).toEqual([]);
    expect(validate(COPTIC)).toEqual([]);
    expect(eth.start("year", 0)).toBe(gregorianDay(8, 8, 27));
    expect(cop.start("year", 0)).toBe(gregorianDay(284, 8, 29));
  });

  test("Ethiopian agrees with ICU ethioaa on every day over ±1,000,000 days", () => {
    compare(eth, amete, -1_000_000, 1_000_000, 1);
  }, 60_000); // two million ICU calls

  test("Coptic agrees with ICU coptic over ±1,000,000 days (every 7th day: same rule, another epoch)", () => {
    compare(cop, coptic, -1_000_000, 1_000_000, 7);
  });

  test("both agree out to ±10,000,000 days, strided", () => {
    compare(eth, amete, -10_000_000, 10_000_000, 997);
    compare(cop, coptic, -10_000_000, 10_000_000, 997);
  });

  test("Pagume has 6 days in a year before a Gregorian leap year, 5 otherwise", () => {
    // Ethiopian 2015 (index 2014) ran 11 Sep 2022 to 11 Sep 2023, with Pagume 6 on 11 Sep 2023
    expect(eth.slotLengths("month", [2014])[12]).toBe(6);
    expect(eth.slotLengths("month", [2015])[12]).toBe(5);
    expect(eth.dayOf("month", [2014], 12, 5)).toBe(gregorianDay(2023, 9, 11));
  });
});
