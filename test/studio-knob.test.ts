import { describe, expect, test } from "bun:test";
import { arcAngles, dragToValue, nudge, nudgeBy, normalise, parseTyped, valueToAngle } from "../src/studio/model/knob";

describe("knob: dragToValue", () => {
  test("dragging up (negative dy) increases the value; dragging down decreases it", () => {
    expect(dragToValue(0, -75, { min: 0, max: 100 })).toBe(50);
    expect(dragToValue(50, 75, { min: 0, max: 100 })).toBe(0);
  });

  test("150 px spans exactly the full range", () => {
    const spec = { min: 0, max: 100 };
    expect(dragToValue(0, -150, spec)).toBe(100);
    expect(dragToValue(100, 150, spec)).toBe(0);
    expect(dragToValue(-20, -150, { min: -20, max: 80 })).toBe(80);
  });

  test("fine mode (shift) scales the drag by ×0.1", () => {
    const spec = { min: 0, max: 100 };
    expect(dragToValue(0, -150, spec, true)).toBe(10);
    expect(dragToValue(0, -75, spec, true)).toBe(5);
  });

  test("clamps at both ends", () => {
    const spec = { min: 0, max: 100 };
    expect(dragToValue(90, -1000, spec)).toBe(100);
    expect(dragToValue(10, 1000, spec)).toBe(0);
  });

  test("rounds to step with no float garbage (0.5 step)", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    const v = dragToValue(0, -15, spec); // delta = 15/150*10 = 1.0
    expect(v).toBe(1);
    const v2 = dragToValue(0.3, -4.5, spec); // delta = 4.5/150*10 = 0.3 -> raw 0.6 -> rounds to 0.5
    expect(v2).toBe(0.5);
    expect(Number.isInteger(v2 * 10)).toBe(true);
  });

  test("rounds to step with no float garbage (0.01 step)", () => {
    const spec = { min: 0, max: 1, step: 0.01 };
    const v = dragToValue(0, -15, spec); // delta = 15/150*1 = 0.1
    expect(v).toBe(0.1);
    expect(v.toString()).toBe("0.1");
    const v2 = dragToValue(0.29, -1.5, spec); // delta = 0.01 -> raw 0.3
    expect(v2).toBe(0.3);
    expect(v2.toString()).toBe("0.3");
  });
});

describe("knob: nudge", () => {
  test("one step in the given direction", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(nudge(1, spec, 1)).toBe(1.5);
    expect(nudge(1, spec, -1)).toBe(0.5);
  });

  test("1% of the range when no step is given", () => {
    const spec = { min: 0, max: 100 };
    expect(nudge(50, spec, 1)).toBe(51);
    expect(nudge(50, spec, -1)).toBe(49);
  });

  test("fine mode scales the nudge by ×0.1", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(nudge(1, spec, 1, true)).toBe(1.05);
  });

  test("clamps at both ends", () => {
    const spec = { min: 0, max: 1, step: 0.5 };
    expect(nudge(1, spec, 1)).toBe(1);
    expect(nudge(0, spec, -1)).toBe(0);
  });
});

describe("knob: nudgeBy", () => {
  test("PageUp/PageDown's 10 steps is nudge repeated ten times", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(nudgeBy(1, spec, 10)).toBe(6);
    expect(nudgeBy(6, spec, -10)).toBe(1);
  });

  test("nudge(dir) is nudgeBy(dir) — one step either way", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(nudge(1, spec, 1)).toBe(nudgeBy(1, spec, 1));
    expect(nudge(1, spec, -1)).toBe(nudgeBy(1, spec, -1));
  });

  test("fine mode scales every one of the ten steps by ×0.1", () => {
    const spec = { min: 0, max: 10, step: 0.5 };
    expect(nudgeBy(1, spec, 10, true)).toBe(1.5);
  });

  test("clamps at both ends even when the jump overshoots", () => {
    const spec = { min: 0, max: 1, step: 0.5 };
    expect(nudgeBy(0, spec, 10)).toBe(1);
    expect(nudgeBy(1, spec, -10)).toBe(0);
  });

  test("1% of the range per step when no step is given", () => {
    const spec = { min: 0, max: 100 };
    expect(nudgeBy(50, spec, 10)).toBe(60);
  });
});

describe("knob: normalise / valueToAngle", () => {
  test("normalise maps [min,max] to [0,1]", () => {
    const spec = { min: 0, max: 100 };
    expect(normalise(0, spec)).toBe(0);
    expect(normalise(100, spec)).toBe(1);
    expect(normalise(50, spec)).toBe(0.5);
  });

  test("normalise clamps out-of-range values", () => {
    const spec = { min: 0, max: 100 };
    expect(normalise(-50, spec)).toBe(0);
    expect(normalise(150, spec)).toBe(1);
  });

  test("angle at min, centre and max", () => {
    const spec = { min: 0, max: 100 };
    expect(valueToAngle(0, spec)).toBe(-135);
    expect(valueToAngle(50, spec)).toBe(0);
    expect(valueToAngle(100, spec)).toBe(135);
  });
});

describe("knob: arcAngles", () => {
  test("power arc runs from -135° (no neutral) to the value's angle", () => {
    const spec = { min: 0, max: 100 };
    const arc = arcAngles(100, spec);
    expect(arc).toEqual({ from: -135, to: 135 });
  });

  test("power arc runs from the explicit neutral's angle", () => {
    const spec = { min: 0, max: 100, neutral: 50 };
    const arc = arcAngles(100, spec);
    expect(arc).toEqual({ from: 0, to: 135 });
  });

  test("bipolar knobs default neutral to the range's centre and fill from there", () => {
    const spec = { min: 0, max: 100, bipolar: true };
    expect(arcAngles(80, spec)).toEqual({ from: 0, to: valueToAngle(80, spec) });
    expect(arcAngles(20, spec)).toEqual({ from: 0, to: valueToAngle(20, spec) });
  });

  test("null when the sweep from neutral is under 1°", () => {
    const spec = { min: 0, max: 1000 };
    expect(arcAngles(0, spec)).toBeNull();
    expect(arcAngles(1, spec)).toBeNull(); // 0.27° of sweep
    expect(arcAngles(5, spec)).not.toBeNull(); // 1.35° of sweep
  });
});

describe("knob: parseTyped", () => {
  const pct = { min: 0, max: 100 };

  test("plain integers and decimals", () => {
    expect(parseTyped("12", pct)).toBe(12);
    expect(parseTyped("-3.5", { min: -10, max: 10 })).toBe(-3.5);
  });

  test("comma decimal separator", () => {
    expect(parseTyped("1,5", { min: 0, max: 10 })).toBe(1.5);
  });

  test("trailing unit text is ignored", () => {
    expect(parseTyped("12 °C", pct)).toBe(12);
    expect(parseTyped("1.4×", { min: 0, max: 5 })).toBe(1.4);
  });

  test("clamps to the range", () => {
    expect(parseTyped("999", pct)).toBe(100);
    expect(parseTyped("-999", pct)).toBe(0);
  });

  test("null when the text doesn't start with a number", () => {
    expect(parseTyped("abc", pct)).toBeNull();
    expect(parseTyped("°C", pct)).toBeNull();
    expect(parseTyped("", pct)).toBeNull();
  });
});
