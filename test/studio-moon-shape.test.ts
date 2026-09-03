/**
 * The moon's lit shape and its tint ramp (`src/studio/model/moon-shape.ts`) —
 * the CYCLE window's one new derivation. Pure model, so it imports directly.
 *
 * The path is checked structurally rather than as a string: what matters is
 * that the terminator's x-radius collapses at the quarters and that the sweep
 * flips there, because that is what turns a crescent into a gibbous.
 */
import { describe, expect, test } from "bun:test";
import { litShapePath, phaseLabelTint, phaseTint } from "../src/studio/model/moon-shape";

/** `M cx cy-r A r r 0 1 1 cx cy+r A rx r 0 1 sweep cx cy-r` */
function parse(d: string): { rx: number; sweep: number } {
  const m = /A ([\d.]+) \d+ 0 1 ([01]) /.exec(d.slice(d.indexOf(" A ") + 3));
  if (m === null) throw new Error(`unparsed: ${d}`);
  return { rx: Number(m[1]), sweep: Number(m[2]) };
}

describe("moon lit shape", () => {
  test("the terminator is widest at new and full, and vanishes at half", () => {
    expect(parse(litShapePath(0.02, 50, 50, 48)).rx).toBeCloseTo(48 * (1 - 0.04), 5);
    expect(parse(litShapePath(0.5, 50, 50, 48)).rx).toBeCloseTo(0, 5);
    expect(parse(litShapePath(1, 50, 50, 48)).rx).toBeCloseTo(48, 5);
  });

  test("the sweep flips at half — a waxing crescent, then a gibbous", () => {
    expect(parse(litShapePath(0.16, 50, 50, 48)).sweep).toBe(0);
    expect(parse(litShapePath(0.49, 50, 50, 48)).sweep).toBe(0);
    expect(parse(litShapePath(0.5, 50, 50, 48)).sweep).toBe(1);
    expect(parse(litShapePath(0.86, 50, 50, 48)).sweep).toBe(1);
  });

  test("a new moon keeps a 2% sliver, so the shape is never an empty path", () => {
    expect(litShapePath(0, 50, 50, 48)).toBe(litShapePath(0.02, 50, 50, 48));
    expect(litShapePath(0, 50, 50, 48)).toContain("M 50 2");
  });

  test("the path is centred on the point it is given, at the radius it is given", () => {
    expect(litShapePath(0.5, 106, 106, 48)).toBe("M 106 58 A 48 48 0 1 1 106 154 A 0.00 48 0 1 1 106 58");
  });

  test("a phase out of range saturates rather than jumping across the cycle", () => {
    expect(litShapePath(1.25, 50, 50, 48)).toBe(litShapePath(1, 50, 50, 48));
    expect(litShapePath(-3, 50, 50, 48)).toBe(litShapePath(0, 50, 50, 48));
    expect(phaseTint(1.25)).toBeCloseTo(phaseTint(1), 10);
  });

  test("a non-finite phase is drawn as new rather than as NaN", () => {
    expect(litShapePath(Number.NaN, 50, 50, 48)).toBe(litShapePath(0, 50, 50, 48));
  });

  test("both tint ramps rise from new to full and stay inside [0,1]", () => {
    for (const tint of [phaseTint, phaseLabelTint]) {
      expect(tint(0)).toBeGreaterThan(0);
      expect(tint(0.999)).toBeLessThanOrEqual(1);
      expect(tint(0)).toBeLessThan(tint(0.5));
      expect(tint(0.5)).toBeLessThan(tint(0.999));
    }
    // Names stay readable on the darkest arc: the label ramp never dips as low.
    expect(phaseLabelTint(0)).toBeGreaterThan(phaseTint(0));
  });
});
