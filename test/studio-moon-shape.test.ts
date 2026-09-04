/**
 * The moon's lit shape and its two ramps (`src/studio/model/moon-shape.ts`) —
 * the CYCLE window's one new derivation. Pure model, so it imports directly.
 *
 * The path is checked structurally rather than as a string: what matters is
 * that the terminator's x-radius collapses at the quarters and that the sweep
 * flips there, because that is what turns a crescent into a gibbous.
 *
 * The colour ramp is checked against the two shades sampled off the prototype
 * capture, converted back through HSL here rather than trusted as a string:
 * the ring's whole point is that it lands on the prototype's blues.
 */
import { describe, expect, test } from "bun:test";
import { litShapePath, phaseColour, phaseLabelColour, phaseTint } from "../src/studio/model/moon-shape";

/** `hsl(222, 26%, L%)` → 0–255 RGB, so a ramp rung can be compared to a sampled pixel. */
function rgb(colour: string): [number, number, number] {
  const m = /^hsl\(222, 26%, ([\d.]+)%\)$/.exec(colour);
  if (m === null) throw new Error(`not a ring colour: ${colour}`);
  const l = Number(m[1]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * 0.26;
  // Hue 222 sits in the [180,240) sixth, where the channels are (0, X, C).
  const x = c * (1 - Math.abs(((222 / 60) % 2) - 1));
  const m0 = l - c / 2;
  return [Math.round((m0 + 0) * 255), Math.round((m0 + x) * 255), Math.round((m0 + c) * 255)];
}

/** The audit's two sampled shades, from `docs/handoff/climate-studio/audit/proto-win-sablemoon.png`. */
function expectNear(colour: string, hex: string, tolerance = 6): void {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  rgb(colour).forEach((got, i) => expect(Math.abs(got - want[i]!)).toBeLessThanOrEqual(tolerance));
}

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

  test("the opacity ramp rises from new to full and stays inside [0,1]", () => {
    expect(phaseTint(0)).toBeGreaterThan(0);
    expect(phaseTint(0.999)).toBeLessThanOrEqual(1);
    expect(phaseTint(0)).toBeLessThan(phaseTint(0.5));
    expect(phaseTint(0.5)).toBeLessThan(phaseTint(0.999));
  });
});

describe("moon ring ramp", () => {
  // The five default phases (`DEFAULT_MOON_PHASES`) are New@0, Crescent@0.16,
  // Half@0.42, Gibbous@0.68, Full@0.86, and the ring is coloured by each
  // segment's MIDPOINT — so the shipped ring's two ends are phase 0.08 and
  // phase 0.93, the two shades sampled off the prototype capture.
  test("the default ring runs from the prototype's #3c4967 to its #9fabc6", () => {
    expectNear(phaseColour(0.08), "#3c4967");
    expectNear(phaseColour(0.93), "#9fabc6");
  });

  test("the ramp is the prototype's lightness span, 28% at new to 73% at full", () => {
    expect(phaseColour(0)).toBe("hsl(222, 26%, 28.0%)");
    expect(phaseColour(1)).toBe("hsl(222, 26%, 73.0%)");
  });

  test("names ride brighter than their own arc, so the new-moon label stays readable", () => {
    expect(phaseLabelColour(0)).toBe("hsl(222, 26%, 48.0%)");
    expect(phaseLabelColour(1)).toBe("hsl(222, 26%, 78.0%)");
    for (const at of [0, 0.08, 0.5, 0.93, 1]) {
      expect(rgb(phaseLabelColour(at))[2]).toBeGreaterThan(rgb(phaseColour(at))[2]);
    }
  });

  test("both ramps rise across the cycle and saturate outside it", () => {
    for (const ramp of [phaseColour, phaseLabelColour]) {
      expect(rgb(ramp(0))[2]).toBeLessThan(rgb(ramp(0.5))[2]);
      expect(rgb(ramp(0.5))[2]).toBeLessThan(rgb(ramp(1))[2]);
      expect(ramp(1.25)).toBe(ramp(1));
      expect(ramp(-3)).toBe(ramp(0));
      expect(ramp(Number.NaN)).toBe(ramp(0));
    }
  });
});
