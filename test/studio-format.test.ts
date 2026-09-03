import { describe, expect, test } from "bun:test";
import { cToF, kphToMph, mmToIn } from "../src/core/units";
import { dayLabel, displaySpec, format, fromDisplay, tabular, toDisplay, unitLabel, windowLabel, yearLabel, type Quantity } from "../src/studio/model/format";

const MINUS = "−"; // real minus, not hyphen-minus

describe("format: every quantity, metric and imperial", () => {
  test("temperature", () => {
    expect(format(20, "temperature", "metric")).toEqual({ text: "20.0", unit: "°C" });
    expect(format(20, "temperature", "imperial")).toEqual({ text: cToF(20).toFixed(1), unit: "°F" });
    expect(format(-5, "temperature", "imperial").text).toBe(cToF(-5).toFixed(1)); // -5 °C is 23 °F, still positive
  });

  test("temperatureDelta", () => {
    expect(format(2, "temperatureDelta", "metric")).toEqual({ text: "2.0", unit: "°C" });
    expect(format(2, "temperatureDelta", "imperial")).toEqual({ text: "3.6", unit: "°F" });
  });

  test("amount", () => {
    expect(format(12, "amount", "metric")).toEqual({ text: "12.0", unit: "mm" });
    expect(format(12, "amount", "imperial")).toEqual({ text: `${mmToIn(12)}`, unit: "in" });
  });

  test("speed", () => {
    expect(format(30, "speed", "metric")).toEqual({ text: "30.0", unit: "km/h" });
    expect(format(30, "speed", "imperial")).toEqual({ text: `${kphToMph(30)}`, unit: "mph" });
  });

  test("direction (metric/imperial are the same — degrees have no unit system)", () => {
    for (const units of ["metric", "imperial"] as const) {
      expect(format(225, "direction", units)).toEqual({ text: "SW 225°", unit: "" });
    }
  });

  test("fraction", () => {
    expect(format(0.4231, "fraction", "metric")).toEqual({ text: "0.42", unit: "" });
    expect(format(0.4231, "fraction", "imperial")).toEqual({ text: "0.42", unit: "" });
  });

  test("percent", () => {
    expect(format(0.5, "percent", "metric")).toEqual({ text: "50.00", unit: "%" });
  });

  test("factor", () => {
    expect(format(1.25, "factor", "metric")).toEqual({ text: "1.25", unit: "×" });
  });

  test("days / years", () => {
    expect(format(12, "days", "metric")).toEqual({ text: "12", unit: "d" });
    expect(format(1962, "years", "metric")).toEqual({ text: "1962", unit: "y" });
  });

  test("phase", () => {
    expect(format(0.42, "phase", "metric")).toEqual({ text: "0.42", unit: "" });
  });

  test("probability", () => {
    expect(format(0.5, "probability", "metric")).toEqual({ text: "0.50", unit: "" });
  });

  test("count", () => {
    expect(format(7, "count", "metric")).toEqual({ text: "7", unit: "" });
  });
});

describe("format: the temperatureDelta rule (ratio only, no +32)", () => {
  test("2 °C offset is 3.6 °F, not 35.6 °F", () => {
    expect(format(2, "temperatureDelta", "imperial").text).toBe("3.6");
  });
  test("−8 °C offset is −14.4 °F", () => {
    expect(format(-8, "temperatureDelta", "imperial").text).toBe(`${MINUS}14.4`);
  });
  test("contrasts with plain temperature, which does add +32", () => {
    expect(format(2, "temperature", "imperial").text).toBe(`${cToF(2)}`); // 35.6, not 3.6
  });
});

describe("format: direction compass points", () => {
  test.each([
    [0, "N 0°"],
    [45, "NE 45°"],
    [225, "SW 225°"],
    [359, "N 359°"],
  ])("%d° → %s", (deg, expected) => {
    expect(format(deg, "direction", "metric").text).toBe(expected);
  });
});

describe("format: signed", () => {
  test("positive values get a leading +", () => {
    expect(format(5, "temperature", "metric", { signed: true }).text).toBe("+5.0");
  });
  test("zero gets a leading + too (matches the knob fmt convention)", () => {
    expect(format(0, "temperature", "metric", { signed: true }).text).toBe("+0.0");
  });
  test("negative values keep the real minus and no +", () => {
    expect(format(-5, "temperature", "metric", { signed: true }).text).toBe(`${MINUS}5.0`);
  });
  test("digits opt overrides the per-quantity default", () => {
    expect(format(1 / 3, "fraction", "metric", { digits: 4 }).text).toBe("0.3333");
  });
});

describe("toDisplay / fromDisplay", () => {
  test("metric is always the identity, for every quantity", () => {
    const qs: Quantity[] = ["temperature", "temperatureDelta", "amount", "speed", "direction", "fraction", "percent", "factor", "days", "years", "phase", "probability", "count"];
    for (const q of qs) {
      expect(toDisplay(12.34, q, "metric")).toBe(12.34);
      expect(fromDisplay(12.34, q, "metric")).toBe(12.34);
    }
  });

  test("temperature/amount/speed round-trip within 1e-9 at values that land cleanly in both units", () => {
    // Round-tripping through a rounding conversion isn't exact for arbitrary
    // inputs (that's H-1384) — these are values that land on a clean tick in
    // *both* systems, so the double rounding doesn't move them.
    for (const v of [0, 20, -10, 100, -40, 37]) {
      expect(fromDisplay(toDisplay(v, "temperature", "imperial"), "temperature", "imperial")).toBeCloseTo(v, 9);
    }
    for (const v of [0, 25.4, 50.8, 127, 254]) {
      // whole inches
      expect(fromDisplay(toDisplay(v, "amount", "imperial"), "amount", "imperial")).toBeCloseTo(v, 9);
    }
    for (const v of [0, 16.1, 32.2, 48.3, 64.4]) {
      // whole-ish mph (10, 20, 30, 40 mph, rounded to 0.1 km/h)
      expect(fromDisplay(toDisplay(v, "speed", "imperial"), "speed", "imperial")).toBeCloseTo(v, 9);
    }
  });

  test("temperatureDelta converts by the 9/5 ratio in both directions", () => {
    expect(toDisplay(2, "temperatureDelta", "imperial")).toBe(3.6);
    expect(fromDisplay(3.6, "temperatureDelta", "imperial")).toBeCloseTo(2, 9);
  });

  test("identity for every non-metric-varying quantity, imperial included", () => {
    const qs: Quantity[] = ["direction", "fraction", "percent", "factor", "days", "years", "phase", "probability", "count"];
    for (const q of qs) {
      expect(toDisplay(42, q, "imperial")).toBe(42);
      expect(fromDisplay(42, q, "imperial")).toBe(42);
    }
  });
});

describe("H-1384 — untouched values never round-trip through display units", () => {
  test("fromDisplay(toDisplay(x)) is not guaranteed to reproduce x", () => {
    const stored = 12; // an arbitrary metric mm value — not a whole number of inches
    const roundTripped = fromDisplay(toDisplay(stored, "amount", "imperial"), "amount", "imperial");
    expect(roundTripped).not.toBe(stored); // 12 mm → 0.47 in → 11.9 mm: drift, by design (imperial rounds)
  });

  test("the caller contract: keep the original metric value for a field the user never touched", () => {
    // A knob storing 20 °C, shown under imperial settings. The UI computes a
    // display string with `format`, but the model keeps storing the original
    // metric number — it must NOT write `fromDisplay(toDisplay(...))` back
    // over a field just because it was rendered in another unit system.
    const storedMetric = 20;
    const shownText = format(storedMetric, "temperature", "imperial").text; // what the knob displays
    expect(shownText).toBe(cToF(storedMetric).toFixed(1)); // "68.0"

    // The right pattern: the stored value is simply never re-derived from
    // what was shown. Calling fromDisplay on a value the user did not
    // actually type/drag — even one that happens to round-trip today, like
    // this one — is the bug H-1384 guards against; some values (see the test
    // above) drift silently and corrupt the stored field.
    const rightPattern = storedMetric; // untouched
    expect(rightPattern).toBe(20);
  });
});

describe("unitLabel", () => {
  test("matches format()'s unit field for every quantity except direction", () => {
    const qs: Quantity[] = ["temperature", "temperatureDelta", "amount", "speed", "fraction", "percent", "factor", "days", "years", "phase", "probability", "count"];
    for (const units of ["metric", "imperial"] as const) {
      for (const q of qs) {
        expect(unitLabel(q, units)).toBe(format(1, q, units).unit);
      }
    }
  });
  test("direction has a generic ° label even though format() embeds it in text", () => {
    expect(unitLabel("direction", "metric")).toBe("°");
    expect(format(90, "direction", "metric").unit).toBe("");
  });
});

describe("displaySpec", () => {
  test("metric is the identity, including omission of absent optional keys", () => {
    expect(displaySpec({ min: -10, max: 10 }, "temperatureDelta", "metric")).toEqual({ min: -10, max: 10 });
    expect(displaySpec({ min: -10, max: 10, neutral: 0, step: 0.1 }, "temperatureDelta", "metric")).toEqual({ min: -10, max: 10, neutral: 0, step: 0.1 });
  });

  test("temperatureDelta: an offset range scales by ratio only, staying symmetric (no +32)", () => {
    expect(displaySpec({ min: -10, max: 10, neutral: 0, step: 0.1 }, "temperatureDelta", "imperial")).toEqual({ min: -18, max: 18, neutral: 0, step: 0.1 });
  });

  test("temperature: an absolute domain uses the full +32 conversion (asymmetric)", () => {
    const out = displaySpec({ min: -60, max: 60 }, "temperature", "imperial");
    expect(out).toEqual({ min: cToF(-60), max: cToF(60) });
  });

  test("amount: step scales by 1/25.4, rounded to 0.01", () => {
    const out = displaySpec({ min: 0, max: 100, neutral: 50, step: 0.5 }, "amount", "imperial");
    expect(out.step).toBeCloseTo(0.02, 9);
    expect(out.min).toBe(mmToIn(0));
    expect(out.max).toBe(mmToIn(100));
    expect(out.neutral).toBe(mmToIn(50));
  });

  test("speed: step scales by 1/1.609344, rounded to 0.1", () => {
    const out = displaySpec({ min: 0, max: 200, neutral: 50, step: 0.5 }, "speed", "imperial");
    expect(out.step).toBeCloseTo(0.3, 9);
    expect(out.min).toBe(kphToMph(0));
    expect(out.max).toBe(kphToMph(200));
  });

  test("a spec with no step/neutral produces output with no step/neutral keys", () => {
    const out = displaySpec({ min: 0, max: 10 }, "amount", "imperial");
    expect("step" in out).toBe(false);
    expect("neutral" in out).toBe(false);
  });
});

describe("dayLabel / yearLabel", () => {
  test("dayLabel is 1-based", () => {
    expect(dayLabel(130, 365)).toBe("d 130");
    expect(dayLabel(1, 365)).toBe("d 1");
  });
  test("dayLabel wraps out-of-range days into the year", () => {
    expect(dayLabel(366, 365)).toBe("d 1");
    expect(dayLabel(0, 365)).toBe("d 365");
  });
  test("yearLabel uses a real minus for negative years", () => {
    expect(yearLabel(1962)).toBe("Y 1962");
    expect(yearLabel(-40)).toBe(`Y ${MINUS}40`);
  });
});

describe("windowLabel", () => {
  test("a single whole year counts days from the year boundary", () => {
    expect(windowLabel(1962, 1963, 365)).toBe("d0 – d365 · 1962");
  });
  test("2.5 years and wider drops to bare years, with no Y prefix", () => {
    expect(windowLabel(1962, 2962, 365)).toBe("1962 – 2962");
    expect(windowLabel(-40, 1000, 365)).toBe(`${MINUS}40 – 1000`);
  });
  test("a sub-year window within one year leads with the day range", () => {
    expect(windowLabel(1962 + 129 / 365, 1962 + 159 / 365, 365)).toBe("d129 – d159 · 1962");
  });
  test("eight days or fewer names the day under the centre", () => {
    expect(windowLabel(1962 + 35 / 365, 1962 + 38 / 365, 365)).toBe("day 36 · 1962");
  });
});

describe("tabular", () => {
  test("fixed digits, no exponent", () => {
    expect(tabular(0.0000001, 2)).toBe("0.00");
    expect(tabular(123456, 2)).toBe("123456.00");
  });
  test("never yields -0", () => {
    expect(tabular(-0, 2)).toBe("0.00");
    expect(tabular(-0.001, 2)).toBe("0.00");
  });
  test("uses the real minus sign, not a hyphen", () => {
    const s = tabular(-5.5, 1);
    expect(s).toBe(`${MINUS}5.5`);
    expect(s.includes("-")).toBe(false);
  });
});
