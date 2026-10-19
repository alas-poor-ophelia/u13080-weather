/**
 * Seshat P2 step 1 (docs/SESHAT-v0.md §3.2–3.4): stored predicates compiled
 * to rules and evaluated over a TimeView must answer exactly what the old
 * evaluator answered. The frozen oracle (predicates.json) is the main check;
 * the cases below cover what a fixture of top-level rows cannot: evaluation
 * order around a throwing child, tag overlays, the year index fallback, and
 * that compiling never writes onto the stored predicate.
 */
import { describe, expect, test } from "bun:test";
import { eraActive as oldEraActive, evaluatePredicate, evaluateStatic, type PredicateContext } from "./golden/old-evaluator";
import { eraActive } from "../src/core/eras";
import type { Era } from "../src/core/types";
import { compilePredicate, generationOptions, staticOptions } from "../src/core/rules";
import { ModifierEngine } from "../src/core/modifiers";
import type { Modifier } from "../src/core/types";
import { InternalCalendar } from "../src/plugin/time/internal";
import { validateProfile } from "../src/core/profile";
import type { Predicate, ZoneProfile } from "../src/core/types";
import { PRESETS } from "../src/generated/presets";
import { Engine, GREGORIAN } from "../src/seshat";
import { evaluate, TimeView } from "../src/seshat/rule";
import { yearOf } from "../src/seshat/year";
import { compareGoldenCal, type GoldenCal } from "./golden/golden-cal";
import { buildGoldenPred, COMPILED_EVALUATORS as NEW } from "./golden/golden-pred";
import storedPred from "./golden/predicates.json";

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

describe("Seshat rules: the engine's wiring", () => {
  // golden-cal has no regime or chance modifiers, so this is the gate for the host context: the
  // regime the generator chose, and chance draws keyed by each modifier's own id
  test("forDay activates exactly the modifiers the old evaluator would, day by day (regime, chance, chained tags, nesting)", () => {
    const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }], seasons: [{ name: "Spring", from: 0 }, { name: "Summer", from: 0.25 }, { name: "Autumn", from: 0.5 }, { name: "Winter", from: 0.75 }] }, () => 0);
    const timeOf = (d: number) => cal.toContext(d);
    const mods: Modifier[] = [
      { id: "c1", when: { chance: 0.3 }, apply: [], tag: "c1" },
      { id: "c2", when: { chance: 0.3 }, apply: [], tag: "c2" },
      { id: "wet", when: { regime: "wet" }, apply: [], tag: "wet" },
      { id: "chain", when: { all: [{ tag: "c1" }, { not: { tag: "c2" } }] }, apply: [], tag: "chain" },
      { id: "mixed", when: { any: [{ all: [{ chance: 0.5 }, { not: { regime: "wet" } }] }, { all: [{ tag: "season:Winter" }, { moon: { name: "Sable", phase: [0.9, 0.1] } }] }] }, apply: [] },
      { id: "always", apply: [], tag: "always" },
    ];
    const seed = "wiring-seed";
    const engine = new ModifierEngine({ seed, zoneId: "z", modifiers: mods, timeOf });
    let checked = 0;
    for (let d = -500; d <= 500; d++) {
      for (const regime of ["wet", "dry"]) {
        // the old forDay loop for non-spell modifiers: tags pushed so far are visible to later ones
        const base = timeOf(d);
        const tags: string[] = [];
        const want: string[] = [];
        for (const m of mods) {
          const time = tags.length ? { ...base, tags: [...(base.tags ?? []), ...tags] } : base;
          if (m.when && !evaluatePredicate(m.when, { ...time, dayOrdinal: d, regime, seed, zoneId: "z", modifierId: m.id })) continue;
          if (m.tag) tags.push(m.tag);
          want.push(m.id);
        }
        const got = engine.forDay(d, regime);
        if (JSON.stringify(got.active) !== JSON.stringify(want)) expect({ d, regime, active: got.active }).toEqual({ d, regime, active: want });
        expect(got.tags).toEqual(tags);
        checked++;
      }
    }
    expect(checked).toBe(2002);
  });
});

describe("Seshat rules: eras", () => {
  test("eraActive answers like the old range test, including bounds no validated era has", () => {
    const eras = [
      { name: "a", from: 3, to: 5 },
      { name: "b", from: -10 },
      { name: "c", from: 0, to: 0 },
      { name: "d", from: 4, to: 2 },
      { name: "e", from: 1, to: 9, enabled: false },
      { name: "f", from: undefined, to: 5 },
      { name: "g", from: null, to: null },
      { name: "h", from: 2.5, to: 7.5 },
    ] as unknown as Era[];
    for (const e of eras) for (let y = -12; y <= 12; y += 0.5) expect([e.name, y, eraActive(e, y)]).toEqual([e.name, y, oldEraActive(e, y)]);
    for (const y of [Number.NaN, Infinity, -Infinity]) for (const e of eras) expect(eraActive(e, y)).toBe(oldEraActive(e, y));
  });

  // the Studio's span edit assigns from/to on the live Era (era-edit.ts setSpan)
  test("an era edited in place answers from its new span at once", () => {
    const e: Era = { name: "Thaw", from: 3, to: 5 };
    expect(eraActive(e, 4)).toBe(true);
    e.from = 6;
    e.to = 8;
    expect(eraActive(e, 4)).toBe(false);
    expect(eraActive(e, 7)).toBe(true);
    delete e.to;
    expect(eraActive(e, 100)).toBe(true);
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
