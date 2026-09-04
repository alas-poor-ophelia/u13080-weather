import { describe, expect, test } from "bun:test";
import { CASCADE_ORIGIN, CASCADE_STEP, cascadePosition, clampRect, defaultPosition, PROTO_BOX_H, PROTO_BOX_W } from "../src/studio/model/clamp";

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

describe("clamp: defaultPosition", () => {
  test("a prototype point in the prototype's own box is unchanged", () => {
    // Forcings' DEFPOS (`Component.DEFPOS` l.155) at 1560x960 is itself.
    expect(defaultPosition(640, 330, PROTO_BOX_W, PROTO_BOX_H)).toEqual({ x: 640, y: 330 });
  });

  test("the point scales with the box, so the arrangement survives a smaller leaf", () => {
    // Half the prototype's width and height: every start point halves too.
    expect(defaultPosition(640, 330, PROTO_BOX_W / 2, PROTO_BOX_H / 2)).toEqual({ x: 320, y: 165 });
    expect(defaultPosition(390, 60, 780, 480)).toEqual({ x: 195, y: 30 });
  });

  test("scaling rounds to whole pixels rather than leaving a fractional left/top", () => {
    // 720/1560 x 1000 = 461.53…
    expect(defaultPosition(720, 130, 1000, 500)).toEqual({ x: 462, y: 68 });
  });

  test("a point that scales past a tiny box is still clamped inside it", () => {
    const p = defaultPosition(1500, 900, 200, 150);
    expect(p.x).toBeLessThanOrEqual(200);
    expect(p.y).toBeLessThanOrEqual(150);
    expect(p).toEqual({ x: 192, y: 141 });
  });
});
