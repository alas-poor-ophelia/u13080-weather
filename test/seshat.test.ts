import { describe, expect, test } from "bun:test";
import { approximate, Body, bodyFromNumbers, frac, fromNumber, rational, SESHAT_VERSION, wrap } from "../src/seshat";
import { SAFE } from "../src/seshat/rational";
import { MOONS_365, MOONS_400 } from "./golden/golden-cal";

describe("seshat: rationals", () => {
  test("rational() reduces and puts the sign on the numerator", () => {
    expect(rational(12, 10)).toEqual({ n: 6, d: 5 });
    expect(rational(3, -6)).toEqual({ n: -1, d: 2 });
    expect(rational(0, 7)).toEqual({ n: 0, d: 1 });
    expect(() => rational(1, 0)).toThrow(RangeError);
    expect(() => rational(0.5, 1)).toThrow(RangeError);
  });

  test("fromNumber takes the shortest decimal, not the binary double", () => {
    expect(fromNumber(29.53)).toEqual({ n: 2953, d: 100 });
    expect(fromNumber(7.3)).toEqual({ n: 73, d: 10 });
    expect(fromNumber(-0.25)).toEqual({ n: -1, d: 4 });
    expect(fromNumber(1.2)).toEqual({ n: 6, d: 5 });
    expect(fromNumber(33)).toEqual({ n: 33, d: 1 });
    expect(fromNumber(1e-7)).toEqual({ n: 1, d: 10_000_000 });
    expect(fromNumber(2e15)).toEqual({ n: 2e15, d: 1 });
    expect(() => fromNumber(2e21)).toThrow(RangeError);
    expect(() => fromNumber(Number.NaN)).toThrow(RangeError);
  });

  test("a decimal too fine for the cap becomes its best continued-fraction approximation", () => {
    const r = fromNumber(0.1234567890123, 1000);
    expect(r.d).toBeLessThanOrEqual(1000);
    expect(Math.abs(r.n / r.d - 0.1234567890123)).toBeLessThan(1e-5);
    expect(approximate(Math.PI, 1000)).toEqual({ n: 355, d: 113 });
    expect(approximate(4, 10)).toEqual({ n: 4, d: 1 });
  });

  test("frac() is the exact fractional part, negatives included", () => {
    expect(frac(rational(-1, 4))).toEqual({ n: 3, d: 4 });
    expect(frac(rational(6, 5))).toEqual({ n: 1, d: 5 });
    expect(frac(rational(2, 1))).toEqual({ n: 0, d: 1 });
  });
});

/** The scan's reference formula (scripts/moon-flip-scan.ts): unreduced decimals, BigInt, one division. */
function exactBig(d: number, cycleDays: number, phaseAtEpoch: number): number {
  const dec = (x: number): [bigint, bigint] => {
    const [i, f = ""] = String(Math.abs(x)).split(".");
    return [BigInt(i! + f) * (x < 0 ? -1n : 1n), 10n ** BigInt(f.length)];
  };
  const [pn, pd] = dec(cycleDays);
  const [en, ed] = dec(phaseAtEpoch);
  const den = pn * ed;
  let num = (BigInt(d) * pd * ed + en * pn) % den;
  if (num < 0n) num += den;
  return Number(num) / Number(den);
}

describe("seshat: Body", () => {
  const moons = [...MOONS_365, ...MOONS_400];
  const days = [0, 1, -1, 2953, -2953, 365, 1_000_003, -1_234_567, 9_999_999, -10_000_000, 10_000_000];

  test("phaseAt equals the exact reference formula on every fixture moon", () => {
    for (const m of moons) {
      const b = bodyFromNumbers(m.cycleDays, m.phaseAtEpoch);
      for (const d of days) expect(b.phaseAt(d)).toBe(exactBig(d, m.cycleDays, m.phaseAtEpoch));
      for (let d = -500; d <= 500; d++) expect(b.phaseAt(d)).toBe(exactBig(d, m.cycleDays, m.phaseAtEpoch));
    }
  });

  test("phase is always in [0, 1) and new moons are exactly 0", () => {
    const b = bodyFromNumbers(29.53, 0);
    for (let k = -3386; k <= 3386; k += 7) expect(b.phaseAt(2953 * k)).toBe(0);
    for (const d of days) {
      const p = b.phaseAt(d);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  test("an epoch phase outside [0, 1) is reduced exactly", () => {
    expect(bodyFromNumbers(33, 1.2).phaseAt(0)).toBe(0.2);
    expect(bodyFromNumbers(7.3, -0.25).phaseAt(0)).toBe(0.75);
  });

  test("a period too fine for safe integers is approximated, and stays within the safe range", () => {
    const b = bodyFromNumbers(29.530588853, 0.125);
    expect(b.period.n * b.period.d).toBeLessThanOrEqual(SAFE);
    expect(Math.abs(b.period.n / b.period.d - 29.530588853)).toBeLessThan(1e-9);
    const p = b.phaseAt(9_999_999);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  });

  test("a non-positive period is refused", () => {
    expect(() => new Body(rational(0), rational(0))).toThrow(RangeError);
    expect(() => new Body(rational(-5), rational(0))).toThrow(RangeError);
  });
});

describe("seshat: wrap and version", () => {
  test("wrap maps into [0, 1) and folds a rounded-up 1 to 0", () => {
    expect(wrap(1.25)).toBe(0.25);
    expect(wrap(-0.25)).toBe(0.75);
    expect(wrap(-1e-17)).toBe(0);
    expect(wrap(3)).toBe(0);
  });

  test("SESHAT_VERSION is a stable string", () => {
    expect(SESHAT_VERSION).toBe("seshat/1");
  });
});
