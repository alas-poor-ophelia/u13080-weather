import { describe, expect, test } from "bun:test";
import { argminPhase, evalCurve, fitHarmonic, monthlyKeyframes, monthlyKeyframesBinMatched, sampleCurve, wrapPhase } from "../src/core/curve";
import type { Keyframe } from "../src/core/types";

describe("Curve", () => {
  test("constant", () => {
    expect(evalCurve(3.5, 0.1)).toBe(3.5);
  });

  test("harmonic: mean + amplitude at phase, mean − amplitude half a year later", () => {
    const h = { mean: 10, amplitude: 5, phase: 0.2 };
    expect(evalCurve(h, 0.2)).toBeCloseTo(15, 12);
    expect(evalCurve(h, 0.7)).toBeCloseTo(5, 12);
  });

  test("keyframes hit their own values and wrap across the year boundary", () => {
    const kf: Keyframe[] = [
      { at: 0.1, value: 1 },
      { at: 0.5, value: 3 },
      { at: 0.9, value: 2 },
    ];
    expect(evalCurve(kf, 0.1)).toBeCloseTo(1, 12);
    expect(evalCurve(kf, 0.5)).toBeCloseTo(3, 12);
    expect(evalCurve(kf, 0.9)).toBeCloseTo(2, 12);
    // between 0.9 and 0.1 (wrapping), values stay between 1 and 2
    for (const t of [0.95, 0.0, 0.05]) {
      const v = evalCurve(kf, t);
      expect(v).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(v).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(evalCurve(kf, 1.1)).toBeCloseTo(evalCurve(kf, 0.1), 12);
    expect(evalCurve(kf, -0.1)).toBeCloseTo(evalCurve(kf, 0.9), 12);
  });

  test("monotone: a probability curve never leaves [min, max] of its keyframes", () => {
    const probs = [0.82, 0.82, 0.8, 0.74, 0.71, 0.71, 0.74, 0.74, 0.8, 0.82, 0.81, 0.84];
    const kf = monthlyKeyframes(probs);
    for (let d = 0; d < 365; d++) {
      const v = evalCurve(kf, d / 365);
      expect(v).toBeGreaterThanOrEqual(0.71 - 1e-9);
      expect(v).toBeLessThanOrEqual(0.84 + 1e-9);
    }
  });

  test("single keyframe is a constant; empty throws", () => {
    expect(evalCurve([{ at: 0.3, value: 7 }], 0.9)).toBe(7);
    expect(() => evalCurve([], 0.5)).toThrow(RangeError);
  });

  test("argminPhase finds the coldest point", () => {
    const h = { mean: 8, amplitude: 7, phase: 0.08 }; // max at 0.08 → min at 0.58
    expect(Math.abs(argminPhase(h) - 0.58)).toBeLessThan(0.01);
  });

  test("fitHarmonic recovers a harmonic", () => {
    const f = fitHarmonic({ mean: 8, amplitude: 7, phase: 0.08 });
    expect(f.mean).toBeCloseTo(8, 9);
    expect(f.amplitude).toBeCloseTo(7, 9);
    expect(f.phase).toBeCloseTo(0.08, 9);
  });

  test("monthlyKeyframesBinMatched: the interpolant's calendar-month averages equal the targets", () => {
    const targets = [-37, -31, -19, -5, 6, 15, 18, 14, 5, -8, -27, -35];
    const kf = monthlyKeyframesBinMatched(targets);
    const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let start = 0;
    for (let m = 0; m < 12; m++) {
      let a = 0;
      for (let d = 0; d < DAYS[m]!; d++) a += evalCurve(kf, (start + d + 0.5) / 365);
      expect(a / DAYS[m]!).toBeCloseTo(targets[m]!, 3);
      start += DAYS[m]!;
    }
  });

  test("sampleCurve returns n samples; wrapPhase normalises", () => {
    expect(sampleCurve(2, 12)).toHaveLength(12);
    expect(wrapPhase(1.25)).toBeCloseTo(0.25, 12);
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapPhase(1)).toBe(0);
  });
});
