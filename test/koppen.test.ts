import { describe, expect, test } from "bun:test";
import { classifyKoppen } from "../src/core/koppen";

/** Helper: sinusoidal annual temperature, arbitrary precipitation vector. */
const sinT = (mean: number, amp: number, northern = true) =>
  Array.from({ length: 12 }, (_, m) => mean - amp * Math.cos((2 * Math.PI * (m + 0.5 - (northern ? 0.5 : 6.5))) / 12));

describe("classifyKoppen (Peel 2007 thresholds)", () => {
  test("Af: hot, wet every month", () => {
    expect(classifyKoppen(sinT(27, 0.5), Array(12).fill(180), true).code).toBe("Af");
  });

  test("Aw: hot with a dry season", () => {
    const P = [10, 5, 20, 60, 150, 250, 300, 280, 200, 60, 20, 10];
    expect(classifyKoppen(sinT(27, 1), P, true).code).toBe("Aw");
  });

  test("BWh: hot desert", () => {
    expect(classifyKoppen(sinT(24, 8), Array(12).fill(5), true).code).toBe("BWh");
  });

  test("BSk: cold steppe", () => {
    expect(classifyKoppen(sinT(8, 14), Array(12).fill(20), true).code).toBe("BSk"); // 240 mm vs threshold 300
  });

  test("Csa: Mediterranean", () => {
    const P = [80, 70, 60, 40, 20, 5, 1, 2, 15, 50, 80, 90];
    expect(classifyKoppen(sinT(18, 9), P, true).code).toBe("Csa");
  });

  test("Cfb: oceanic", () => {
    expect(classifyKoppen(sinT(10, 6), Array(12).fill(80), true).code).toBe("Cfb");
  });

  test("Dfb / Dfa / Dfc by summer warmth", () => {
    expect(classifyKoppen(sinT(5, 14), Array(12).fill(50), true).code).toBe("Dfb");
    expect(classifyKoppen(sinT(10, 15), Array(12).fill(70), true).code).toBe("Dfa");
    expect(classifyKoppen(sinT(-3, 14), Array(12).fill(40), true).code).toBe("Dfc");
  });

  test("Dfd: extremely cold winter", () => {
    expect(classifyKoppen(sinT(-10, 30), Array(12).fill(30), true).code).toBe("Dfd");
  });

  test("Dwb: dry winter continental", () => {
    const P = [3, 3, 8, 20, 50, 90, 150, 130, 60, 20, 8, 3];
    expect(classifyKoppen(sinT(4, 16), P, true).code).toBe("Dwb");
  });

  test("ET / EF", () => {
    expect(classifyKoppen(sinT(-5, 8), Array(12).fill(30), true).code).toBe("ET");
    expect(classifyKoppen(sinT(-20, 10), Array(12).fill(30), true).code).toBe("EF");
  });

  test("southern hemisphere seasons flip for Cs detection", () => {
    // Mediterranean-type in the south: dry Dec–Feb, wet Jun–Aug
    const P = [5, 5, 15, 40, 80, 100, 110, 90, 60, 30, 10, 5];
    expect(classifyKoppen(sinT(17, 7, false), P, false).code).toBe("Csa");
  });

  test("rejects wrong lengths", () => {
    expect(() => classifyKoppen([1, 2], [1, 2], true)).toThrow(RangeError);
  });
});
