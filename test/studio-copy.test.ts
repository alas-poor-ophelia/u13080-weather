/**
 * Studio product copy (bead wadjet-6rw.1). Pins the vocabulary the prototype
 * uses on unit chips and apply knobs, and the two-vocabulary split between a
 * standalone macro name (`storm odds`) and a short apply-target name
 * (`precip`) for the same engine param.
 *
 * Numbers come from `model/format.ts`, so a negative reads with the studio's
 * real minus (U+2212), not an ASCII hyphen — the prototype's `toFixed` output
 * differs there on purpose.
 */
import { describe, expect, test } from "bun:test";
import { applyPhrase, type ConditionSource, conditionCode, conditionColour, conditionOf, describeOp, displayName, factorText, grammar, kindColor, opGloss, paramName } from "../src/studio/model/copy";

const MINUS = "−";

describe("describeOp: the prototype's chip vocabulary", () => {
  test("storm odds ×1.50 — precipitation.pwd scaled, macro vocabulary", () => {
    expect(describeOp({ param: "precipitation.pwd", op: "scale", value: 1.5 }, { vocabulary: "macro" })).toBe("storm odds ×1.50");
  });

  test("precip ×0.70 — the same param under the apply-target vocabulary", () => {
    expect(describeOp({ param: "precipitation.pwd", op: "scale", value: 0.7 })).toBe("precip ×0.70");
  });

  test("precip 0 — no rain", () => {
    expect(describeOp({ param: "precipitation.pwd", op: "set", value: 0 })).toBe("precip 0 — no rain");
    expect(describeOp({ param: "precipitation.pww", op: "set", value: 0 })).toBe("precip 0 — no rain");
  });

  test("sky 0.95 — ash-dark, and the other two glosses", () => {
    expect(describeOp({ param: "cloud.dry", op: "set", value: 0.95 })).toBe("sky 0.95 — ash-dark");
    expect(describeOp({ param: "cloud.dry", op: "set", value: 0.6 })).toBe("sky 0.6 — hazed");
    expect(describeOp({ param: "cloud.dry", op: "set", value: 0.2 })).toBe("sky 0.2 — clearish");
  });

  test("wind +12 km/h", () => {
    expect(describeOp({ param: "wind.speed", op: "offset", value: 12 })).toBe("wind +12 km/h");
  });

  test(`temp ${MINUS}8.0 °C — a real minus, one decimal, unit attached`, () => {
    expect(describeOp({ param: "temperature.mean", op: "offset", value: -8 })).toBe(`temp ${MINUS}8.0 °C`);
    expect(describeOp({ param: "temperature.mean", op: "offset", value: 2 })).toBe("temp +2.0 °C");
  });

  test("imperial follows settings.units", () => {
    expect(describeOp({ param: "wind.speed", op: "offset", value: 12 }, { units: "imperial" })).toBe("wind +8 mph");
  });

  test("a curve-valued set has no scalar to show", () => {
    expect(describeOp({ param: "temperature.mean", op: "set", value: [{ at: 0, value: 1 }] })).toBe("temp ∿ curve");
  });

  test("an unknown param falls back to its last path segment", () => {
    expect(describeOp({ param: "snow.depth", op: "scale", value: 2 })).toBe("depth ×2.00");
  });
});

describe("paramName: the two vocabularies", () => {
  test("target names are the short apply-knob labels", () => {
    expect(paramName("temperature.mean")).toBe("temp");
    expect(paramName("precipitation.pwd")).toBe("precip");
    expect(paramName("wind.speed")).toBe("wind");
    expect(paramName("cloud.dry")).toBe("sky");
  });

  test("macro names stand alone", () => {
    expect(paramName("temperature.mean", "macro")).toBe("warmth");
    expect(paramName("precipitation.pwd", "macro")).toBe("storm odds");
    expect(paramName("precipitation.pww", "macro")).toBe("stickiness");
    expect(paramName("cloud.dry", "macro")).toBe("cloud");
  });
});

describe("displayName: ids and tags read as product names", () => {
  test("the three devices the prototype ships", () => {
    expect(displayName("sable-stormtide")).toBe("Sable Stormtide");
    expect(displayName("neverain")).toBe("Neverain");
    expect(displayName("ashfall")).toBe("Ashfall");
  });

  test("a kind prefix is dropped and an authored name is left alone", () => {
    expect(displayName("era:Ice Age")).toBe("Ice Age");
    expect(displayName("season:Harvest")).toBe("Harvest");
  });

  test("a general slug title-cases, small words stay lower after the first", () => {
    expect(displayName("curse_of_neverain")).toBe("Curse of Neverain");
    expect(displayName("fjord-coast")).toBe("Fjord Coast");
  });
});

describe("grammar: the WRITES footer's engine clauses", () => {
  test("clauses join with the studio separator and empties drop out", () => {
    expect(grammar("modifiers[2]", "", null, "when.moon Sable", undefined)).toBe("modifiers[2] · when.moon Sable");
  });

  test("a whole footer line reads as authored grammar, not JSON", () => {
    const line = grammar("modifiers[2]", "when.moon Sable", applyPhrase({ param: "precipitation.pwd", op: "scale", value: 1.5 }));
    expect(line).toBe("modifiers[2] · when.moon Sable · apply precipitation.pwd ×1.50");
  });

  test("applyPhrase keeps the engine path and formats only the value", () => {
    expect(applyPhrase({ param: "temperature.mean", op: "offset", value: -8 })).toBe(`apply temperature.mean ${MINUS}8`);
    expect(applyPhrase({ param: "cloud.dry", op: "set", value: 0.95 })).toBe("apply cloud.dry = 0.95");
  });
});

describe("op gloss, factors and kind colours", () => {
  test("the dim annotation under an apply knob", () => {
    expect(opGloss({ param: "precipitation.pwd", op: "scale", value: 1.5 })).toBe("scale · precipitation.pwd");
    expect(opGloss({ param: "wind.speed", op: "offset", value: 12 })).toBe("offset · wind.speed");
  });

  test("a factor is always two decimals", () => {
    expect(factorText(1)).toBe("×1.00");
    expect(factorText(0.7)).toBe("×0.70");
  });

  test("every kind pill colour is a palette var, never a literal", () => {
    for (const kind of ["CURSE", "SPELL", "MOON", "TAG", "DICE", "TRIM", "ERA", "STATES"]) {
      expect(kindColor(kind)).toMatch(/^var\(--wadjet-studio-[a-z-]+\)$/);
    }
    // The prototype badges a curse #f0885c, the same hue SPELL wears.
    expect(kindColor("CURSE")).toBe("var(--wadjet-studio-temp)");
    expect(kindColor("MOON")).toBe("var(--wadjet-studio-moon)");
    expect(kindColor("TAG")).toBe("var(--wadjet-studio-gold)");
    expect(kindColor("SPELL")).toBe("var(--wadjet-studio-temp)");
    expect(kindColor("ERA")).toBe("var(--wadjet-studio-text)");
  });
});

/**
 * The day card's condition line (bead wadjet-6rw.3). The prototype's own
 * vocabulary: a phrase, a code pill and a hue, all off one report.
 */
describe("studio copy · one day's condition", () => {
  const report = (over: Partial<ConditionSource> = {}): ConditionSource => ({
    precipitation: { type: "none", amountMm: 0 },
    cloudCover: 0.6,
    conditions: [],
    descriptors: { precipitation: "dry", sky: "cloudy" },
    ...over,
  });

  test("a dry day reads as its sky, a wet one as its intensity plus its type", () => {
    expect(conditionOf(report())).toBe("cloudy");
    expect(conditionOf(report({ precipitation: { type: "rain", amountMm: 6 }, descriptors: { precipitation: "steady", sky: "overcast" } }))).toBe("steady rain");
    expect(conditionOf(report({ precipitation: { type: "snow", amountMm: 2 }, descriptors: { precipitation: "light", sky: "overcast" } }))).toBe("light snow");
  });

  test("the intensity band never repeats the type — `drizzle`, not `drizzle drizzle`", () => {
    expect(conditionOf(report({ precipitation: { type: "drizzle", amountMm: 0.3 }, descriptors: { precipitation: "drizzle", sky: "cloudy" } }))).toBe("drizzle");
  });

  test("ashfall wins over everything, and fog beats a clear sky", () => {
    expect(conditionOf(report({ conditions: ["ashfall"], precipitation: { type: "rain", amountMm: 3 } }))).toBe("ashfall");
    expect(conditionOf(report({ conditions: ["fog"] }))).toBe("fog");
  });

  test("the code pill is the aviation code for what the day is", () => {
    expect(conditionCode(report({ cloudCover: 0.9 }))).toBe("OVC");
    expect(conditionCode(report({ cloudCover: 0.6 }))).toBe("BKN");
    expect(conditionCode(report({ cloudCover: 0.3 }))).toBe("SCT");
    expect(conditionCode(report({ cloudCover: 0.05 }))).toBe("SKC");
    expect(conditionCode(report({ precipitation: { type: "snow", amountMm: 4 } }))).toBe("SN");
    expect(conditionCode(report({ precipitation: { type: "rain", amountMm: 4 } }))).toBe("RA");
    expect(conditionCode(report({ precipitation: { type: "rain", amountMm: 24 } }))).toBe("+RA");
    expect(conditionCode(report({ precipitation: { type: "drizzle", amountMm: 0.3 } }))).toBe("DZ");
    expect(conditionCode(report({ conditions: ["ashfall"] }))).toBe("VA");
    expect(conditionCode(report({ conditions: ["fog"] }))).toBe("FG");
  });

  test("the condition's hue is a palette var, never a literal", () => {
    for (const type of ["none", "drizzle", "rain", "sleet", "snow"]) {
      expect(conditionColour(report({ precipitation: { type, amountMm: 1 } }))).toMatch(/^var\(--wadjet-studio-[a-z-]+\)$/);
    }
    expect(conditionColour(report({ precipitation: { type: "snow", amountMm: 1 } }))).toBe("var(--wadjet-studio-moon)");
    expect(conditionColour(report({ precipitation: { type: "rain", amountMm: 1 } }))).toBe("var(--wadjet-studio-precip)");
    expect(conditionColour(report({ conditions: ["ashfall"] }))).toBe("var(--wadjet-studio-gold)");
    expect(conditionColour(report())).toBe("var(--wadjet-studio-text-dim)");
  });
});
