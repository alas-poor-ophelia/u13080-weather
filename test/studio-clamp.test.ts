import { describe, expect, test } from "bun:test";
import { CASCADE_ORIGIN, CASCADE_STEP, cascadePosition, clampRect } from "../src/studio/model/clamp";

describe("clamp: clampRect", () => {
  test("leaves a rect that already fits untouched", () => {
    expect(clampRect(10, 10, 200, 100, 800, 600, 24)).toEqual({ x: 10, y: 10 });
  });

  test("pulls a rect back from the left/top edges", () => {
    expect(clampRect(-50, -50, 200, 100, 800, 600, 24)).toEqual({ x: 0, y: 0 });
  });

  test("stops the right edge at the box: x caps at boxW - w", () => {
    expect(clampRect(1000, 10, 200, 100, 800, 600, 24)).toEqual({ x: 600, y: 10 });
  });

  test("y caps so only the title-bar margin stays onscreen, not the whole height", () => {
    // A 100 px-tall panel dragged far down: only 24 px (the bar) must stay in the 600 px box.
    expect(clampRect(10, 5000, 200, 100, 800, 600, 24)).toEqual({ x: 10, y: 576 });
  });

  test("a panel taller than the box can still hang off the bottom", () => {
    // h = 900 > boxH = 600; the cap is still boxH - margin, not boxH - h (which would be negative).
    expect(clampRect(10, 5000, 200, 900, 800, 600, 24)).toEqual({ x: 10, y: 576 });
  });

  test("a panel shorter than the margin fits fully rather than over-clamping", () => {
    // h = 10 < margin = 24: the cap uses h, so the whole short panel stays onscreen.
    expect(clampRect(10, 5000, 200, 10, 800, 600, 24)).toEqual({ x: 10, y: 590 });
  });

  test("a box smaller than the margin/width still clamps to zero, never negative", () => {
    expect(clampRect(10, 10, 200, 100, 50, 10, 24)).toEqual({ x: 0, y: 0 });
  });
});

describe("clamp: cascadePosition", () => {
  test("index 0 starts at the cascade origin", () => {
    expect(cascadePosition(0, 800, 600)).toEqual({ x: CASCADE_ORIGIN, y: CASCADE_ORIGIN });
  });

  test("each further index steps diagonally by the cascade step", () => {
    expect(cascadePosition(1, 800, 600)).toEqual({ x: CASCADE_ORIGIN + CASCADE_STEP, y: CASCADE_ORIGIN + CASCADE_STEP });
    expect(cascadePosition(3, 800, 600)).toEqual({ x: CASCADE_ORIGIN + 3 * CASCADE_STEP, y: CASCADE_ORIGIN + 3 * CASCADE_STEP });
  });

  test("a long cascade is clamped inside a small box rather than walking off it", () => {
    const p = cascadePosition(50, 200, 150);
    expect(p.x).toBeLessThanOrEqual(200);
    expect(p.y).toBeLessThanOrEqual(150);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});
