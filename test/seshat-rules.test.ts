/**
 * Seshat P2 step 1 (docs/SESHAT-v0.md §3.2–3.4): stored predicates compiled
 * to rules and evaluated over a TimeView must answer exactly what the old
 * evaluator answered. The frozen oracle (predicates.json) is the main check;
 * the cases below cover what a fixture of top-level rows cannot: evaluation
 * order around a throwing child, tag overlays, the year index fallback, and
 * that compiling never writes onto the stored predicate.
 */
import { describe, expect, test } from "bun:test";
import { evaluatePredicate, evaluateStatic, type PredicateContext } from "../src/core/modifiers";
import { compilePredicate, generationOptions, staticOptions } from "../src/core/rules";
import { validateProfile } from "../src/core/profile";
import type { Predicate, ZoneProfile } from "../src/core/types";
import { PRESETS } from "../src/generated/presets";
import { Engine, GREGORIAN } from "../src/seshat";
import { evaluate, TimeView, type RuleAst } from "../src/seshat/rule";
import { yearOf } from "../src/seshat/year";
import { compareGoldenCal, type GoldenCal } from "./golden/golden-cal";
import { buildGoldenPred, type Evaluators } from "./golden/golden-pred";
import storedPred from "./golden/predicates.json";

const compiled = new WeakMap<object, RuleAst>();
const ruleOf = (p: Predicate): RuleAst => {
  let r = compiled.get(p);
  if (!r) compiled.set(p, (r = compilePredicate(p)));
  return r;
};

const NEW: Evaluators = {
  gen: (p, ctx) => evaluate(ruleOf(p), new TimeView(ctx, ctx.dayOrdinal), generationOptions(ctx)),
  static: (p, ctx) => evaluate(ruleOf(p), new TimeView(ctx, ctx.dayOrdinal), staticOptions(ctx)),
};

// `over` may set fields to undefined on purpose (an adapter that omits them)
const ctx = (over: Record<string, unknown> = {}): PredicateContext =>
  ({
  yearPhase: 0.5,
  dayOfYear: 15,
  year: 4,
  moons: [{ name: "Sable", phase: 0.01 }],
  tags: ["season:Summer", "era:Thaw"],
  dayOrdinal: 7,
  regime: "wet",
  seed: "s",
  zoneId: "z",
  modifierId: "m",
  ...over,
  });

function outcome(f: () => boolean | undefined): string {
  try {
    return String(f());
  } catch (e) {
    return `throw ${(e as Error).constructor.name}`;
  }
}

function keyPaths(v: unknown, path = "", out: string[] = []): string[] {
  if (typeof v !== "object" || v === null) return out;
  for (const k of Reflect.ownKeys(v)) {
    out.push(`${path}/${String(k)}`);
    keyPaths((v as Record<PropertyKey, unknown>)[k], `${path}/${String(k)}`, out);
  }
  return out;
}

describe("Seshat rules: compiled predicates", () => {
  test("the compiled rules reproduce predicates.json exactly (both modes, every world, zone, day and edge)", () => {
    expect(compareGoldenCal(storedPred as unknown as GoldenCal, buildGoldenPred(NEW) as unknown as GoldenCal)).toEqual([]);
  });

  // a fixture row only sees top-level shapes; nested throws show whether evaluation order is kept
  const ORDER: Array<[string, unknown]> = [
    ["all: false then a throwing child", { all: [{ tag: "nope" }, { all: 5 }] }],
    ["all: a throwing child then false", { all: [{ all: 5 }, { tag: "nope" }] }],
    ["any: true then a throwing child", { any: [{ tag: "season:Summer" }, { all: 5 }] }],
    ["any: unknown then true", { any: [{ regime: "dry" }, { tag: "season:Summer" }] }],
    ["all: unknown then false", { all: [{ tag: "era:Thaw" }, { tag: "nope" }] }],
    ["all: unknown era then a throwing child", { all: [{ tag: "era:Thaw" }, { tag: 5 }] }],
    ["not over a throwing child", { not: { any: "x" } }],
    ["null predicate", null],
    ["string predicate", "moon"],
    ["nested chance pair", { any: [{ chance: 0.5 }, { all: [{ chance: 0.25 }, { regime: "wet" }] }] }],
  ];
  for (const [name, p] of ORDER) {
    test(`same answer as the old evaluator: ${name}`, () => {
      for (const c of [ctx(), ctx({ moons: undefined, tags: undefined }), ctx({ moons: [] })]) {
        expect(outcome(() => NEW.gen(p as Predicate, c))).toBe(outcome(() => evaluatePredicate(p as Predicate, c)));
        expect(outcome(() => NEW.static(p as Predicate, { ...c, regime: "" }))).toBe(outcome(() => evaluateStatic(p as Predicate, { ...c, regime: "" })));
      }
    });
  }

  // The old evaluator read these fields lazily, so it threw only on days that had a moon; a compiled
  // rule reads them once and throws on every day it reaches them. Both shapes are invalid profiles.
  test("unreadable moon fields throw on every day (louder than before), and validation rejects them", () => {
    for (const p of [{ moon: null }, { moon: { name: "Sable", phase: null } }] as unknown as Predicate[]) {
      for (const c of [ctx(), ctx({ moons: undefined }), ctx({ moons: [] })]) expect(outcome(() => NEW.gen(p, c))).toBe("throw TypeError");
      const zone = { id: "z", name: "z", schemaVersion: 1, climate: PRESETS[0]!.climate, regimes: PRESETS[0]!.regimes, modifiers: [{ id: "m", when: p, apply: [] }] } as unknown as ZoneProfile;
      expect(validateProfile(zone).some((i) => i.level === "error" && i.path.includes("when"))).toBe(true);
    }
  });

  test("a tag overlay answers like the spread array the engine builds today", () => {
    const base = { yearPhase: 0.3, tags: ["season:Winter"] };
    const view = new TimeView(base, 3).withTags(["monsoon"]).withTags(["fog"]);
    for (const t of ["season:Winter", "monsoon", "fog", "nope"]) expect(view.hasTag(t)).toBe([...base.tags, "monsoon", "fog"].includes(t));
    expect(new TimeView({ yearPhase: 0 }, 1).withTags([]).hasTag("x")).toBe(false);
    // an era tag pushed by an earlier modifier is still unknown to the spell-window estimate, and read in generation
    const p = compilePredicate({ tag: "era:Thaw" });
    const h = { seed: "s", zoneId: "z", modifierId: "m", dayOrdinal: 3, regime: "" };
    const pushed = new TimeView({ yearPhase: 0.3, tags: [] }, 3).withTags(["era:Thaw"]);
    expect(evaluate(p, pushed, staticOptions(h))).toBeUndefined();
    expect(evaluate(p, pushed, generationOptions(h))).toBe(true);
  });

  test("the year index is yearOf, with the generator's fallbacks", () => {
    const cases = [
      { year: 7, dayOrdinal: 10, yearLength: 365 },
      { year: undefined, dayOrdinal: 400, yearLength: 365 },
      { year: undefined, dayOrdinal: -1, yearLength: 365 },
      { year: undefined, dayOrdinal: 10, yearLength: 365.25 },
    ];
    for (const c of cases) expect(new TimeView({ yearPhase: 0, ...c }, c.dayOrdinal).index("year")).toBe(yearOf(c));
    // no dayOrdinal or yearLength on the time: the requested day and a 365-day year, as automation does
    expect(new TimeView({ yearPhase: 0 }, 800).index("year")).toBe(Math.floor(800 / 365) + 1);
    expect(new TimeView({ yearPhase: 0 }, 800).index("month")).toBeUndefined();
  });

  test("compiling never writes onto the stored predicate", () => {
    const p = { all: [{ moon: { name: "Sable", phase: [0, 0.5] } }, { not: { tag: "era:Thaw" } }] } as Predicate;
    const before = keyPaths(p);
    const json = JSON.stringify(p);
    compilePredicate(p);
    NEW.gen(p, ctx());
    NEW.static(p, ctx());
    expect(keyPaths(p)).toEqual(before);
    expect(JSON.stringify(p)).toBe(json);
  });
});

describe("Seshat GREGORIAN weekday", () => {
  test("the weekday cycle names each day as Date does over ±100,000 days; week labels are gone", () => {
    const greg = new Engine(GREGORIAN);
    const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let bad = 0;
    for (let d = -100_000; d <= 100_000; d += 7) {
      for (let k = 0; k < 7; k++) {
        const day = d + k;
        const want = NAMES[new Date(day * 86_400_000).getUTCDay()];
        if (greg.labelAt("weekday", day)?.name !== want && bad++ < 5) expect(greg.labelAt("weekday", day)?.name).toBe(want);
      }
    }
    expect(bad).toBe(0);
    expect(greg.labelAt("week", 0)).toBeNull();
  });
});
