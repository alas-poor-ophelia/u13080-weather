import { describe, expect, test } from "bun:test";
import { hitTest, moveSpan, pxToYear, resizeSpan, spanToPx, stackRows, type LaneGeometry, type Span } from "../src/studio/model/lanes";

const g: LaneGeometry = { x0: 0, pxPerYear: 100, windowFrom: 0, edgePx: 4 };
const gTouch: LaneGeometry = { x0: 0, pxPerYear: 100, windowFrom: 0, edgePx: 10 };

const span = (over: Partial<Span> & { id: string; from: number; to: number }): Span => ({
  kind: "clip",
  editable: true,
  ...over,
});

describe("lanes: spanToPx / pxToYear", () => {
  test("spanToPx places a span by its years", () => {
    const s = span({ id: "a", from: 1, to: 3 });
    expect(spanToPx(s, g)).toEqual({ left: 100, width: 200 });
  });

  test("pxToYear inverts spanToPx's left edge", () => {
    const s = span({ id: "a", from: 1.5, to: 4 });
    const { left } = spanToPx(s, g);
    expect(pxToYear(left, g)).toBeCloseTo(1.5, 10);
  });

  test("windowFrom and x0 shift the mapping", () => {
    const g2: LaneGeometry = { x0: 20, pxPerYear: 50, windowFrom: 2, edgePx: 4 };
    const s = span({ id: "a", from: 3, to: 5 });
    expect(spanToPx(s, g2)).toEqual({ left: 70, width: 100 });
    expect(pxToYear(70, g2)).toBe(3);
  });
});

describe("lanes: hitTest", () => {
  const s = span({ id: "a", from: 1, to: 3 }); // px: left 100, right 300

  test("start edge, body and end edge (mouse edgePx)", () => {
    expect(hitTest([s], 101, g)).toEqual({ span: s, zone: "start" });
    expect(hitTest([s], 200, g)).toEqual({ span: s, zone: "body" });
    expect(hitTest([s], 299, g)).toEqual({ span: s, zone: "end" });
  });

  test("start and end edges widen on touch edgePx", () => {
    expect(hitTest([s], 108, gTouch)).toEqual({ span: s, zone: "start" });
    expect(hitTest([s], 112, gTouch)).toEqual({ span: s, zone: "body" });
    expect(hitTest([s], 292, gTouch)).toEqual({ span: s, zone: "end" });
  });

  test("outside the span is no hit", () => {
    expect(hitTest([s], 50, g)).toBeNull();
    expect(hitTest([s], 350, g)).toBeNull();
  });

  test("non-editable spans only ever report body, never an edge", () => {
    const locked = span({ id: "b", from: 1, to: 3, editable: false });
    expect(hitTest([locked], 101, g)).toEqual({ span: locked, zone: "body" });
    expect(hitTest([locked], 299, g)).toEqual({ span: locked, zone: "body" });
    expect(hitTest([locked], 200, g)).toEqual({ span: locked, zone: "body" });
  });

  test("last span wins on overlap (topmost = last in array)", () => {
    const under = span({ id: "under", from: 0, to: 5 });
    const over = span({ id: "over", from: 1, to: 3 });
    expect(hitTest([under, over], 200, g)).toEqual({ span: over, zone: "body" });
    expect(hitTest([over, under], 200, g)).toEqual({ span: under, zone: "body" });
  });
});

describe("lanes: moveSpan", () => {
  const bounds = { min: 0, max: 10 };

  test("moves by dYears, keeping length", () => {
    const s = span({ id: "a", from: 2, to: 4 });
    expect(moveSpan(s, 1, bounds)).toEqual(span({ id: "a", from: 3, to: 5 }));
  });

  test("clamps at the lower bound", () => {
    const s = span({ id: "a", from: 1, to: 3 });
    expect(moveSpan(s, -5, bounds)).toEqual(span({ id: "a", from: 0, to: 2 }));
  });

  test("clamps at the upper bound", () => {
    const s = span({ id: "a", from: 1, to: 5 });
    expect(moveSpan(s, 20, bounds)).toEqual(span({ id: "a", from: 6, to: 10 }));
  });
});

describe("lanes: resizeSpan", () => {
  const bounds = { min: 0, max: 10 };

  test("dragging the start edge changes `from`", () => {
    const s = span({ id: "a", from: 1, to: 5 });
    expect(resizeSpan(s, "start", 2, 1, bounds).from).toBe(2);
  });

  test("dragging the end edge changes `to`", () => {
    const s = span({ id: "a", from: 1, to: 5 });
    expect(resizeSpan(s, "end", 8, 1, bounds).to).toBe(8);
  });

  test("cannot cross the other edge closer than minLength", () => {
    const s = span({ id: "a", from: 1, to: 5 });
    expect(resizeSpan(s, "start", 10, 1, bounds).from).toBe(4); // clamped to to - minLength
    expect(resizeSpan(s, "end", -10, 1, bounds).to).toBe(2); // clamped to from + minLength
  });

  test("honours the outer bounds", () => {
    const s = span({ id: "a", from: 1, to: 5 });
    expect(resizeSpan(s, "start", -20, 1, bounds).from).toBe(0);
    expect(resizeSpan(s, "end", 20, 1, bounds).to).toBe(10);
  });
});

describe("lanes: stackRows", () => {
  test("no spans", () => {
    expect(stackRows([], 3)).toEqual([]);
  });

  test("a single span goes in row 0", () => {
    const s = span({ id: "a", from: 0, to: 5 });
    expect(stackRows([s], 3)).toEqual([{ ...s, row: 0 }]);
  });

  test("nested spans go in separate rows", () => {
    const outer = span({ id: "outer", from: 0, to: 10 });
    const inner = span({ id: "inner", from: 2, to: 5 });
    const rows = stackRows([outer, inner], 3);
    expect(rows.find((r) => r.id === "outer")!.row).toBe(0);
    expect(rows.find((r) => r.id === "inner")!.row).toBe(1);
  });

  test("chained (non-overlapping) spans share row 0", () => {
    const a = span({ id: "a", from: 0, to: 2 });
    const b = span({ id: "b", from: 2, to: 4 });
    const rows = stackRows([a, b], 3);
    expect(rows.every((r) => r.row === 0)).toBe(true);
  });

  test("overlaps beyond maxRows collapse into the last row", () => {
    const spans = [
      span({ id: "a", from: 0, to: 10 }),
      span({ id: "b", from: 0, to: 9 }),
      span({ id: "c", from: 0, to: 8 }),
      span({ id: "d", from: 0, to: 7 }),
    ];
    const rows = stackRows(spans, 2);
    expect(rows.find((r) => r.id === "a")!.row).toBe(0);
    expect(rows.find((r) => r.id === "b")!.row).toBe(1);
    expect(rows.find((r) => r.id === "c")!.row).toBe(1);
    expect(rows.find((r) => r.id === "d")!.row).toBe(1);
    expect(rows.every((r) => r.row! < 2)).toBe(true);
  });
});
