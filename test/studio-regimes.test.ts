/**
 * The pure half of the `Regimes · STATES` window (`src/studio/model/regimes.ts`).
 *
 * Two things carry most of the weight here:
 *
 *  - **Rename is an id change** (PLAN D13). The id *is* the display name, so
 *    every `{ regime: "<old>" }` predicate in the zone's modifiers has to move
 *    with it — deeply, through `all` / `any` / `not` — and a collision has to
 *    be resolved rather than written as a duplicate id.
 *  - **Every operation leaves a valid draft.** Each edit below is followed by
 *    `validateProfile` on a real preset zone (Bergen, `fjord-coast.json`), so
 *    a helper can never write a shape the studio would immediately have to
 *    complain about — the "keep at least one state" refusal is exactly that
 *    rule, enforced one layer earlier.
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Modifier, Preset, ZoneProfile } from "../src/core/types";
import { shareOfYear } from "../src/studio/model/audition";
import { addApply, addState, applyFor, applySummary, colourOf, laneSub, REGIME_COLOURS, regimeApplyText, regimesWrites, regimeTargetName, removeApply, removeState, renameState, setApplyChainMute, setApplyValue, setDwell, setWeight, shareBar } from "../src/studio/model/regimes";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(modifiers: Modifier[] = []): ZoneProfile {
  return {
    id: "bergen",
    name: "Bergen",
    schemaVersion: 1,
    preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers,
  };
}

/** Every helper's post-condition: the draft it leaves behind still validates. */
function expectClean(z: ZoneProfile): void {
  const errors = validateProfile(z).filter((i) => i.level === "error");
  expect(errors).toEqual([]);
}

const ids = (z: ZoneProfile): string[] => z.regimes.map((r) => r.id);

describe("studio regimes · the preset this is written against", () => {
  test("fjord-coast ships three states and validates as a zone", () => {
    const z = zone();
    expect(ids(z)).toEqual(["normal", "wet-spell", "dry-spell"]);
    expectClean(z);
  });
});

describe("studio regimes · colours", () => {
  test("the cycle is the six SPEC 9 data colours and wraps", () => {
    expect(REGIME_COLOURS).toEqual(["#9298a1", "#5cb8f0", "#e8c15a", "#7fd6a8", "#f0885c", "#cdd9ee"]);
    expect(colourOf(0, undefined)).toBe("#9298a1");
    expect(colourOf(5, undefined)).toBe("#cdd9ee");
    expect(colourOf(6, undefined)).toBe("#9298a1");
    expect(colourOf(13, undefined)).toBe("#5cb8f0");
  });

  test("the leaf's persisted palette indices override the cycle, position by position", () => {
    // view.colours.regimes = [4, …]: state 0 is drawn in the fifth colour.
    expect(colourOf(0, [4])).toBe("#f0885c");
    // A position the view has no entry for falls back to the cycle.
    expect(colourOf(1, [4])).toBe("#5cb8f0");
    // Garbage in workspace.json must not produce `undefined`.
    expect(colourOf(0, [Number.NaN])).toBe("#9298a1");
    expect(colourOf(0, [-1])).toBe("#cdd9ee");
  });
});

describe("studio regimes · add and remove", () => {
  test("＋ state appends a rare, short state and returns its id", () => {
    const z = zone();
    const id = addState(z);
    expect(id).toBe("state");
    expect(z.regimes).toHaveLength(4);
    expect(z.regimes[3]).toEqual({ id: "state", weight: 0.1, meanDurationDays: 7 });
    expectClean(z);
  });

  test("a second ＋ state does not collide, and `taken` reserves ids beyond the zone's own", () => {
    const z = zone();
    expect(addState(z)).toBe("state");
    expect(addState(z)).toBe("state-2");
    expect(addState(z, ["state-3", "state-4"])).toBe("state-5");
    expect(ids(z)).toEqual(["normal", "wet-spell", "dry-spell", "state", "state-2", "state-5"]);
    expectClean(z);
  });

  test("× removes the state it names", () => {
    const z = zone();
    expect(removeState(z, "wet-spell")).toBe(true);
    expect(ids(z)).toEqual(["normal", "dry-spell"]);
    expectClean(z);
  });

  test("an unknown id is refused rather than silently dropping something else", () => {
    const z = zone();
    expect(removeState(z, "nope")).toBe(false);
    expect(ids(z)).toHaveLength(3);
  });

  test("the last state is kept — SPEC 6, the slot cannot be emptied", () => {
    const z = zone();
    expect(removeState(z, "wet-spell")).toBe(true);
    expect(removeState(z, "dry-spell")).toBe(true);
    expect(z.regimes).toHaveLength(1);
    expect(removeState(z, "normal")).toBe(false);
    expect(ids(z)).toEqual(["normal"]);
    // The refusal is what keeps `validateProfile`'s "at least one regime" clean.
    expectClean(z);
  });
});

describe("studio regimes · rename (PLAN D13)", () => {
  test("the name is trimmed and becomes the id", () => {
    const z = zone();
    expect(renameState(z, "wet-spell", "  storm  ")).toBe("storm");
    expect(ids(z)).toEqual(["normal", "storm", "dry-spell"]);
    expectClean(z);
  });

  test("a blank name, an unknown id and a no-op rename all leave the draft alone", () => {
    const z = zone();
    expect(renameState(z, "normal", "   ")).toBe("normal");
    expect(renameState(z, "nope", "storm")).toBe("nope");
    expect(renameState(z, "normal", "normal")).toBe("normal");
    expect(ids(z)).toEqual(["normal", "wet-spell", "dry-spell"]);
    expectClean(z);
  });

  test("a collision with another state is resolved by uniqueId, never written as a duplicate", () => {
    const z = zone();
    expect(renameState(z, "wet-spell", "dry-spell")).toBe("dry-spell-2");
    expect(ids(z)).toEqual(["normal", "dry-spell-2", "dry-spell"]);
    // `validateProfile` rejects duplicate regime ids; the resolution is why it does not fire.
    expectClean(z);
  });

  test("a device gated on the state follows it", () => {
    const z = zone([{ id: "g", when: { regime: "wet-spell" }, apply: [{ param: "wind.speed", op: "scale", value: 1.4 }] }]);
    renameState(z, "wet-spell", "storm");
    expect(z.modifiers[0]!.when).toEqual({ regime: "storm" });
    expectClean(z);
  });

  test("the rewrite reaches every leaf of a nested all / any / not", () => {
    const nested: Modifier = {
      id: "deep",
      when: {
        all: [{ tag: "season:Winter" }, { any: [{ regime: "wet-spell" }, { not: { regime: "wet-spell" } }, { all: [{ regime: "dry-spell" }, { not: { any: [{ regime: "wet-spell" }] } }] }] }],
      },
      apply: [{ param: "precipitation.pwd", op: "scale", value: 1.1 }],
    };
    const z = zone([nested]);
    renameState(z, "wet-spell", "storm");
    expect(z.modifiers[0]!.when).toEqual({
      all: [{ tag: "season:Winter" }, { any: [{ regime: "storm" }, { not: { regime: "storm" } }, { all: [{ regime: "dry-spell" }, { not: { any: [{ regime: "storm" }] } }] }] }],
    });
    expectClean(z);
  });

  test("a collided rename rewrites predicates to the id the state actually got", () => {
    const z = zone([{ id: "g", when: { regime: "wet-spell" }, apply: [{ param: "wind.speed", op: "scale", value: 1.4 }] }]);
    const got = renameState(z, "wet-spell", "dry-spell");
    expect(got).toBe("dry-spell-2");
    expect(z.modifiers[0]!.when).toEqual({ regime: "dry-spell-2" });
    expectClean(z);
  });

  test("predicates naming a different state are left alone", () => {
    const z = zone([{ id: "g", when: { regime: "dry-spell" }, apply: [{ param: "wind.speed", op: "scale", value: 1.4 }] }]);
    renameState(z, "wet-spell", "storm");
    expect(z.modifiers[0]!.when).toEqual({ regime: "dry-spell" });
  });

  test("a hand-written predicate with a malformed branch does not throw", () => {
    const z = zone([{ id: "g", when: { all: [null as never, { regime: "wet-spell" }] }, apply: [{ param: "wind.speed", op: "scale", value: 1.4 }] }]);
    expect(() => renameState(z, "wet-spell", "storm")).not.toThrow();
    expect(z.modifiers[0]!.when).toEqual({ all: [null as never, { regime: "storm" }] });
  });
});

describe("studio regimes · how often and how long", () => {
  test("weight is clamped to >= 0 and dwell to >= 1 — validateProfile's own bounds", () => {
    const z = zone();
    setWeight(z, "normal", 0.42);
    setDwell(z, "normal", 21);
    expect(z.regimes[0]).toMatchObject({ weight: 0.42, meanDurationDays: 21 });

    setWeight(z, "wet-spell", -3);
    setDwell(z, "wet-spell", 0);
    expect(z.regimes[1]).toMatchObject({ weight: 0, meanDurationDays: 1 });
    expectClean(z);
  });

  test("a non-finite value lands on the bound rather than poisoning the draft", () => {
    const z = zone();
    setWeight(z, "normal", Number.NaN);
    setDwell(z, "normal", Number.POSITIVE_INFINITY);
    expect(z.regimes[0]).toMatchObject({ weight: 0, meanDurationDays: 1 });
    // Weight 0 on one state is legal as long as another still has weight.
    expectClean(z);
  });

  test("an unknown state is a no-op", () => {
    const z = zone();
    setWeight(z, "nope", 0.5);
    setDwell(z, "nope", 5);
    expect(z.regimes).toEqual(structuredClone(fjord.regimes));
  });

  test("a dwell over 30 days is a warning, not an error — the row's amber LED", () => {
    const z = zone();
    setDwell(z, "normal", 45);
    const issues = validateProfile(z);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.some((i) => i.level === "warning" && i.path === "regimes[0].meanDurationDays")).toBe(true);
  });
});

describe("studio regimes · what changes", () => {
  test("applyFor reads the state's ops and [] when it has none", () => {
    const z = zone();
    expect(applyFor(z, "normal")).toEqual([]);
    expect(applyFor(z, "wet-spell")).toHaveLength(2);
    expect(applyFor(z, "nope")).toEqual([]);
  });

  test("＋ creates `apply` on a state that had none", () => {
    const z = zone();
    addApply(z, "normal", { param: "temperature.mean", op: "offset", value: 0 });
    expect(z.regimes[0]!.apply).toEqual([{ param: "temperature.mean", op: "offset", value: 0 }]);
    expectClean(z);
  });

  test("a knob writes one op's value and leaves its neighbours alone", () => {
    const z = zone();
    setApplyValue(z, "wet-spell", 1, 2.2);
    expect(applyFor(z, "wet-spell")).toEqual([
      { param: "precipitation.pww", op: "scale", value: 1.25 },
      { param: "precipitation.pwd", op: "scale", value: 2.2 },
    ]);
    expectClean(z);
  });

  test("a value write is refused where there is nothing to write", () => {
    const z = zone();
    addApply(z, "normal", { param: "temperature.mean", op: "clamp", min: -5 });
    setApplyValue(z, "normal", 0, 3); // clamp has no single value
    setApplyValue(z, "normal", 9, 3); // out of range
    setApplyValue(z, "wet-spell", 0, Number.NaN); // never write a non-finite number
    expect(z.regimes[0]!.apply).toEqual([{ param: "temperature.mean", op: "clamp", min: -5 }]);
    expect(applyFor(z, "wet-spell")[0]).toEqual({ param: "precipitation.pww", op: "scale", value: 1.25 });
    expectClean(z);
  });

  test("× drops the op, and an emptied apply is dropped rather than written as []", () => {
    const z = zone();
    removeApply(z, "wet-spell", 0);
    expect(applyFor(z, "wet-spell")).toEqual([{ param: "precipitation.pwd", op: "scale", value: 1.6 }]);
    removeApply(z, "wet-spell", 0);
    expect(z.regimes[1]!.apply).toBeUndefined();
    expect("apply" in z.regimes[1]!).toBe(false);
    expectClean(z);
  });

  test("removing an op that is not there changes nothing", () => {
    const z = zone();
    removeApply(z, "wet-spell", 7);
    removeApply(z, "normal", 0);
    removeApply(z, "nope", 0);
    expect(applyFor(z, "wet-spell")).toHaveLength(2);
    expectClean(z);
  });
});

describe("studio regimes · per-chain mute", () => {
  test("muting a chain disables that chain's ops and leaves the others enabled", () => {
    const z = zone();
    addApply(z, "dry-spell", { param: "wind.speed", op: "scale", value: 0.8 });
    setApplyChainMute(z, "dry-spell", "precipitation", true);
    expect(applyFor(z, "dry-spell")).toEqual([
      { param: "precipitation.pwd", op: "scale", value: 0.4, enabled: false },
      { param: "temperature.diurnalRange", op: "scale", value: 1.3 },
      { param: "wind.speed", op: "scale", value: 0.8 },
    ]);
    expectClean(z);
  });

  test("un-muting deletes the flag rather than writing enabled: true", () => {
    const z = zone();
    setApplyChainMute(z, "dry-spell", "temperature", true);
    expect(applyFor(z, "dry-spell")[1]).toEqual({ param: "temperature.diurnalRange", op: "scale", value: 1.3, enabled: false });
    setApplyChainMute(z, "dry-spell", "temperature", false);
    // Byte-identical to the preset again — a never-muted state must not drift.
    expect(z.regimes[2]).toEqual(structuredClone(fjord.regimes[2]!));
    expectClean(z);
  });

  test("a chain the state does not write to is a no-op", () => {
    const z = zone();
    const before = structuredClone(z.regimes);
    setApplyChainMute(z, "wet-spell", "wind", true);
    setApplyChainMute(z, "normal", "temperature", true);
    expect(z.regimes).toEqual(before);
  });

  test("cloud and humidity both mute as SKY (SPEC 1)", () => {
    const z = zone();
    addApply(z, "normal", { param: "cloud.dry", op: "offset", value: 0.2 });
    addApply(z, "normal", { param: "humidity.wet", op: "offset", value: 0.1 });
    setApplyChainMute(z, "normal", "sky", true);
    expect(applyFor(z, "normal").every((op) => op.enabled === false)).toBe(true);
    expectClean(z);
  });
});

describe("studio regimes · share of the year", () => {
  test("the bar is shareOfYear with the swatch colours, and the shares sum to 1", () => {
    const z = zone();
    const bars = shareBar(z);
    expect(bars.map((b) => b.id)).toEqual(["normal", "wet-spell", "dry-spell"]);
    expect(bars.map((b) => b.colour)).toEqual(["#9298a1", "#5cb8f0", "#e8c15a"]);
    expect(bars.reduce((sum, b) => sum + b.share, 0)).toBeCloseTo(1, 12);
    // It is the audition's own arithmetic, not a second implementation of it.
    expect(bars.map((b) => b.share)).toEqual(shareOfYear(z.regimes).map((s) => s.share));
  });

  test("the bar follows the knobs: weight x dwell, normalised", () => {
    const z = zone();
    // Two states, equal weights, one twice as long: 1/3 and 2/3.
    removeState(z, "dry-spell");
    setWeight(z, "normal", 0.5);
    setDwell(z, "normal", 5);
    setWeight(z, "wet-spell", 0.5);
    setDwell(z, "wet-spell", 10);
    const bars = shareBar(z);
    expect(bars[0]!.share).toBeCloseTo(1 / 3, 12);
    expect(bars[1]!.share).toBeCloseTo(2 / 3, 12);
    expect(bars.reduce((sum, b) => sum + b.share, 0)).toBeCloseTo(1, 12);
    expectClean(z);
  });

  test("the persisted palette reaches the bar", () => {
    const z = zone();
    expect(shareBar(z, [2, 0, 1]).map((b) => b.colour)).toEqual(["#e8c15a", "#9298a1", "#5cb8f0"]);
  });

  test("a zone whose every weight is 0 shares out as zeroes rather than NaN", () => {
    const z = zone();
    for (const r of z.regimes) setWeight(z, r.id, 0);
    expect(shareBar(z).map((b) => b.share)).toEqual([0, 0, 0]);
    // …and that draft is exactly what `validateProfile` calls an error.
    expect(validateProfile(z).some((i) => i.level === "error" && i.path === "regimes")).toBe(true);
  });
});

describe("studio regimes · a whole editing session stays valid", () => {
  test("add, rename, retune, re-apply, mute and remove in sequence", () => {
    const z = zone([{ id: "gale", when: { any: [{ regime: "wet-spell" }, { tag: "season:Winter" }] }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] }]);

    const added = addState(z);
    expectClean(z);

    const renamed = renameState(z, added, "storm");
    expect(renamed).toBe("storm");
    expectClean(z);

    setWeight(z, "storm", 0.25);
    setDwell(z, "storm", 4);
    expectClean(z);

    addApply(z, "storm", { param: "wind.speed", op: "scale", value: 1.8 });
    setApplyValue(z, "storm", 0, 2);
    expectClean(z);

    setApplyChainMute(z, "storm", "wind", true);
    expectClean(z);

    // The gate still points at the state it always did.
    expect(z.modifiers[0]!.when).toEqual({ any: [{ regime: "wet-spell" }, { tag: "season:Winter" }] });
    renameState(z, "wet-spell", "storm");
    expect(ids(z)).toEqual(["normal", "storm-2", "dry-spell", "storm"]);
    expect(z.modifiers[0]!.when).toEqual({ any: [{ regime: "storm-2" }, { tag: "season:Winter" }] });
    expectClean(z);

    expect(removeState(z, "storm")).toBe(true);
    expect(ids(z)).toEqual(["normal", "storm-2", "dry-spell"]);
    expectClean(z);
  });
});

/**
 * The copy and grammar half: the apply knobs' own short names, the line under
 * each state's name, and the WRITES footer's one-line grammar. The footer is
 * the reason these exist — it used to print `JSON.stringify`, and a footer
 * that wraps is a footer that decides the panel's width.
 */
describe("studio regimes · copy and the WRITES grammar", () => {
  test("the two precipitation transitions are told apart, unlike the shared vocabulary", () => {
    // `paramName` calls both of these "precip" — correct on a device, useless
    // on a state whose two knobs ARE the two transition probabilities.
    expect(regimeTargetName("precipitation.pww")).toBe("wet→wet");
    expect(regimeTargetName("precipitation.pwd")).toBe("dry→wet");
    expect(regimeTargetName("temperature.diurnalRange")).toBe("day swing");
    expect(regimeTargetName("cloud.dry")).toBe("sky");
    // Anything unlisted falls back to the shared name rather than throwing.
    expect(regimeTargetName("humidity.wet")).toBe("humidity");
  });

  test("one op reads as its own name plus the formatted value", () => {
    expect(regimeApplyText({ param: "precipitation.pww", op: "scale", value: 1.25 })).toBe("wet→wet ×1.25");
    expect(regimeApplyText({ param: "temperature.mean", op: "offset", value: 2 })).toBe("temp +2.0 °C");
  });

  test("a state with no apply says so rather than showing an empty line", () => {
    const z = zone();
    expect(applySummary(z, "normal")).toBe("— no apply · baseline as-is");
    expect(applySummary(z, "wet-spell")).toBe("wet→wet ×1.25 · dry→wet ×1.60");
  });

  test("the WRITES footer is one line of engine grammar, never JSON", () => {
    const z = zone();
    const line = regimesWrites(z);
    expect(line.startsWith("regimes [ { normal w 0.70 · 12 d }")).toBe(true);
    expect(line).toContain("scale[precipitation.pww ×1.25]");
    // Param paths stay intact (SPEC law 5), and nothing wraps or quotes.
    expect(line.includes("\n")).toBe(false);
    expect(line.includes('"')).toBe(false);
  });

  test("an added state appears in the grammar with its own weight and dwell", () => {
    const z = zone();
    const id = addState(z);
    expect(regimesWrites(z)).toContain(`{ ${id} w 0.10 · 7 d }`);
  });
});

describe("regimes · the playlist lane's sub-label (bead wadjet-6rw.2)", () => {
  test("it counts the states and reads every share out, in list order", () => {
    const z = zone();
    const shares = shareOfYear(z.regimes);
    const expected = `${z.regimes.length} states · ${shares.map((s) => `${s.id} ${Math.round(s.share * 100)}%`).join(" · ")}`;
    expect(laneSub(z)).toBe(expected);
    expect(laneSub(z).startsWith(`${z.regimes.length} states · `)).toBe(true);
  });

  test("the shares it prints are `shareOfYear`'s, so a weight change moves it", () => {
    const z = zone();
    const before = laneSub(z);
    setWeight(z, z.regimes[1]!.id, z.regimes[1]!.weight * 4);
    expect(laneSub(z)).not.toBe(before);
  });

  test("a stateless draft says so rather than printing `0 states · `", () => {
    expect(laneSub({ regimes: [] })).toBe("no states");
  });
});
