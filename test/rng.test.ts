import { describe, expect, test } from "bun:test";
import {
  DrawStream,
  RNG_VERSION,
  bernoulli,
  drawKey,
  gamma,
  geometricDuration,
  hash32,
  hash53,
  normal,
  uniform,
  weightedIndex,
} from "../src/core/rng";

const N = 20_000;

function stats(xs: number[]): { mean: number; variance: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return { mean, variance };
}

describe("frozen substrate: hash", () => {
  test("is a pure function of the key", () => {
    expect(hash32("abc")).toBe(hash32("abc"));
    expect(hash53("abc")).toBe(hash53("abc"));
    expect(hash32("abc", 7)).not.toBe(hash32("abc", 8));
  });

  test("distinguishes keys that differ by one code unit, including trailing", () => {
    expect(hash32("day-1")).not.toBe(hash32("day-2"));
    expect(hash32("x")).not.toBe(hash32("x "));
    expect(hash32("")).not.toBe(hash32(" "));
  });

  test("hash53 is an integer below 2^53, uniform is in [0,1)", () => {
    for (let i = 0; i < 1000; i++) {
      const h = hash53(`k${i}`);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeLessThan(2 ** 53);
      const u = uniform(`k${i}`);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  test("drawKey is unambiguous across field boundaries", () => {
    expect(drawKey("s", "z", 1, "n")).not.toBe(drawKey("s", "z1", 1, "n"));
    expect(drawKey("sz", "", 1, "n")).not.toBe(drawKey("s", "z", 1, "n"));
    expect(() => drawKey("s", "z", 1.5, "n")).toThrow(RangeError);
  });
});

describe("frozen substrate: DrawStream", () => {
  test("two streams with the same key produce identical sequences", () => {
    const a = new DrawStream("k");
    const b = new DrawStream("k");
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
  });

  test("index i does not depend on draws elsewhere", () => {
    const a = new DrawStream("k");
    a.next();
    a.next();
    const third = a.next();
    const b = new DrawStream("k");
    b.next();
    b.next();
    expect(b.next()).toBe(third);
  });

  test("uniform mean ≈ 0.5, variance ≈ 1/12", () => {
    const s = new DrawStream("uniform-stats");
    const { mean, variance } = stats(Array.from({ length: N }, () => s.next()));
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.005);
  });
});

describe("frozen substrate: samplers", () => {
  test("normal: mean ≈ 0, variance ≈ 1", () => {
    const s = new DrawStream("normal-stats");
    const { mean, variance } = stats(Array.from({ length: N }, () => normal(s)));
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });

  test.each([
    [0.5, 2],
    [0.792, 6],
    [1, 1],
    [2.5, 3],
    [9, 0.5],
  ])("gamma(shape=%p, scale=%p): mean = shape*scale, var = shape*scale^2", (shape, scale) => {
    const s = new DrawStream(`gamma-${shape}-${scale}`);
    const xs = Array.from({ length: N }, () => gamma(s, shape, scale));
    const { mean, variance } = stats(xs);
    expect(xs.every((x) => x > 0)).toBe(true);
    expect(Math.abs(mean - shape * scale) / (shape * scale)).toBeLessThan(0.04);
    expect(Math.abs(variance - shape * scale * scale) / (shape * scale * scale)).toBeLessThan(0.12);
  });

  test("gamma rejects invalid parameters", () => {
    const s = new DrawStream("g");
    expect(() => gamma(s, 0, 1)).toThrow(RangeError);
    expect(() => gamma(s, 1, -1)).toThrow(RangeError);
  });

  test("bernoulli frequency ≈ p, clamps outside [0,1]", () => {
    const s = new DrawStream("bern");
    let hits = 0;
    for (let i = 0; i < N; i++) if (bernoulli(s, 0.3)) hits++;
    expect(Math.abs(hits / N - 0.3)).toBeLessThan(0.01);
    expect(bernoulli(s, -1)).toBe(false);
    expect(bernoulli(s, 2)).toBe(true);
  });

  test("geometricDuration: >= 1, mean ≈ target", () => {
    const s = new DrawStream("geo");
    const xs = Array.from({ length: N }, () => geometricDuration(s, 12));
    expect(xs.every((x) => Number.isInteger(x) && x >= 1)).toBe(true);
    expect(Math.abs(stats(xs).mean - 12) / 12).toBeLessThan(0.05);
    expect(geometricDuration(new DrawStream("one"), 1)).toBe(1);
    expect(() => geometricDuration(s, 0.5)).toThrow(RangeError);
  });

  test("weightedIndex respects weights and ignores non-positive ones", () => {
    const s = new DrawStream("w");
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) counts[weightedIndex(s, [0.7, 0, 0.15, 0.15])]!++;
    expect(counts[1]).toBe(0);
    expect(Math.abs(counts[0]! / N - 0.7)).toBeLessThan(0.015);
    expect(Math.abs(counts[2]! / N - 0.15)).toBeLessThan(0.015);
    expect(() => weightedIndex(s, [0, -1])).toThrow(RangeError);
  });
});

describe("version", () => {
  test("RNG_VERSION is the frozen v1 string", () => {
    expect(RNG_VERSION).toBe("wadjet-rng/1");
  });
});
