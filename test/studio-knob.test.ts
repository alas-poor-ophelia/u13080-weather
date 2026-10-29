import { describe, expect, test } from "bun:test";
import { arcAngles, dragToValue, knobSpecError, nudge, nudgeBy, normalise, parseTyped, valueToAngle, type KnobSpec } from "../src/studio/model/knob";
import pin from "./fixtures/knob-linear-pin.json";

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

/** Every output of the knob before the log scale (knob.ts at e39ce77) over a sweep, in the order the generator walked it. */
function linearSweep(specs: readonly KnobSpec[]): unknown[] {
  const out: unknown[] = [];
  for (const s of specs) {
    for (const v of [s.min - 1, s.min, (s.min + s.max) / 3, s.max * 0.77, s.max, s.max + 1]) {
      for (const dy of [-200, -37, -1, 0, 3, 61]) for (const f of [false, true]) out.push(dragToValue(v, dy, s, f));
      for (const st of [-10, -1, 1, 10]) for (const f of [false, true]) out.push(nudgeBy(v, s, st, f));
      out.push(normalise(v, s), valueToAngle(v, s), arcAngles(v, s));
    }
  }
  return out;
}

describe("knob: linear scale is unchanged by the log scale", () => {
  test("every output matches the pinned pre-log values exactly", () => {
    expect(linearSweep(pin.specs)).toEqual(pin.out);
  });

  test('an explicit scale: "linear" is the default', () => {
    expect(linearSweep(pin.specs.map((s) => ({ ...s, scale: "linear" as const })))).toEqual(pin.out);
  });

  test("a linear spec is never refused, even with min ≤ 0", () => {
    expect(knobSpecError({ min: -5, max: 5 })).toBeNull();
    expect(knobSpecError({ min: 0, max: 1, scale: "linear" })).toBeNull();
  });
});

describe("knob: log scale", () => {
  const spec: KnobSpec = { min: 1, max: 10000, scale: "log" };

  test("min must be above 0 and max above min", () => {
    expect(knobSpecError({ min: 0, max: 10, scale: "log" })).toContain("minimum above 0");
    expect(knobSpecError({ min: -1, max: 10, scale: "log" })).toContain("minimum above 0");
    expect(knobSpecError({ min: 5, max: 5, scale: "log" })).toContain("maximum above its minimum");
    expect(knobSpecError(spec)).toBeNull();
    expect(() => normalise(1, { min: 0, max: 10, scale: "log" })).toThrow(RangeError);
    expect(() => dragToValue(1, 0, { min: 0, max: 10, scale: "log" })).toThrow(RangeError);
  });

  test("endpoints: min and max sit at −135° and +135°, and each decade gets a quarter of the sweep", () => {
    expect(normalise(1, spec)).toBe(0);
    expect(normalise(10000, spec)).toBe(1);
    expect(valueToAngle(1, spec)).toBe(-135);
    expect(valueToAngle(10000, spec)).toBe(135);
    expect(normalise(10, spec)).toBeCloseTo(0.25, 12);
    expect(normalise(100, spec)).toBeCloseTo(0.5, 12);
    expect(valueToAngle(100, spec)).toBeCloseTo(0, 9);
    expect(normalise(0.5, spec)).toBe(0); // clamped
    expect(normalise(1e6, spec)).toBe(1);
  });

  test("150 px spans the full range, and the ends are exact", () => {
    expect(dragToValue(1, -150, spec)).toBe(10000);
    expect(dragToValue(10000, 150, spec)).toBe(1);
    expect(dragToValue(50, -1000, spec)).toBe(10000);
    expect(dragToValue(50, 1000, spec)).toBe(1);
  });

  test("a drag moves by ratio: 37.5 px is one decade anywhere on the dial", () => {
    expect(dragToValue(1, -37.5, spec)).toBeCloseTo(10, 9);
    expect(dragToValue(100, -37.5, spec)).toBeCloseTo(1000, 6);
    expect(dragToValue(1000, 37.5, spec)).toBeCloseTo(100, 7);
    expect(dragToValue(1, -37.5, spec, true)).toBeCloseTo(10 ** 0.1, 12); // fine: ×0.1 of the travel
  });

  test("round trips: drag up then down by the same pixels comes back", () => {
    for (const v of [1.5, 29.530594, 365.2425, 4321]) {
      const up = dragToValue(v, -10, spec); // under the top, so nothing clamps
      expect(dragToValue(up, 10, spec)).toBeCloseTo(v, 9);
    }
  });

  test("normalise and the drag agree: a drag of t·150 px lands where normalise reads t", () => {
    for (const t of [0.1, 0.33, 0.8]) expect(normalise(dragToValue(1, -t * 150, spec), spec)).toBeCloseTo(t, 12);
  });

  test("the power arc follows the log angle", () => {
    expect(arcAngles(10000, spec)).toEqual({ from: -135, to: 135 });
    const a = arcAngles(100, spec)!;
    expect(a.from).toBe(-135);
    expect(a.to).toBeCloseTo(0, 9);
    expect(arcAngles(1, spec)).toBeNull();
  });

  test("steps are a grid in value space: a drag snaps to it and never leaves the range", () => {
    const stepped: KnobSpec = { min: 1, max: 1000, step: 0.01, scale: "log" };
    const v = dragToValue(29.53, -1, stepped);
    expect(Math.round(v * 100)).toBe(v * 100);
    expect(v.toString()).toMatch(/^\d+(\.\d{1,2})?$/);
    expect(v).toBeGreaterThan(29.53);
    expect(dragToValue(29.53, 0, stepped)).toBe(29.53);
    const whole: KnobSpec = { min: 2, max: 500, step: 1, scale: "log" };
    expect(dragToValue(2, -37.5, whole)).toBe(8); // 2·250^(1/4) = 7.95…, snapped to the whole-number grid
    expect(dragToValue(400, -1000, whole)).toBe(500);
  });

  test("a stepped nudge adds the step in value space; an un-stepped one moves 1% of the log travel", () => {
    const stepped: KnobSpec = { min: 1, max: 1000, step: 0.01, scale: "log" };
    expect(nudge(29.53, stepped, 1)).toBe(29.54);
    expect(nudge(29.53, stepped, -1)).toBe(29.52);
    expect(nudgeBy(29.53, stepped, 10)).toBe(29.63);
    expect(nudge(29.53, stepped, 1, true)).toBe(29.531);
    expect(nudge(1000, stepped, 1)).toBe(1000);
    expect(nudge(1, stepped, -1)).toBe(1);
    expect(normalise(nudge(10, spec, 1), spec) - normalise(10, spec)).toBeCloseTo(0.01, 12);
    expect(nudgeBy(1, spec, 100)).toBe(10000);
    expect(nudgeBy(10000, spec, -100)).toBe(1);
  });
});
