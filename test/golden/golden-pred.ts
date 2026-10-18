/**
 * Frozen predicate oracle for Seshat P2 (docs/SESHAT-v0.md §9, step 0).
 *
 * P2 replaces `evaluatePredicate` / `evaluateStatic` with compiled Seshat
 * rules and deletes the old code. This file pins what the OLD evaluator
 * answered, so the new one is checked against fixed outputs rather than a
 * live copy that could drift with it. Two matrices:
 *
 *   - real days: every predicate below × the golden-cal worlds and zones ×
 *     days −1000..1000, through the same `dayTimeFn` the generator uses
 *     (era tags and the southern flip included);
 *   - edge contexts: hand-built DayTimes for what no adapter here produces
 *     (no moons, duplicate moon names, NaN / 1 / −0.1 phases, fractional or
 *     missing dayOfYear, missing tags).
 *
 * Each row is run-length encoded per mode: `t` true, `f` false, `u` unknown
 * (static mode only), `x` threw. `gen` is generation mode (regime "wet"),
 * `static` is the spell-window mode. It also pins each spell modifier's
 * `windowDays`, which turns meanStartsPerYear into every start probability.
 */
import type { DayTime, Modifier, Predicate } from "../../src/core/types";
import { evaluatePredicate, evaluateStatic, ModifierEngine, type PredicateContext } from "../../src/core/modifiers";
import { eraModifiers } from "../../src/core/eras";
import { resolveProfile } from "../../src/core/profile";
import { dayTimeFn } from "../../src/plugin/world";
import { WORLDS } from "./golden-cal";

const REGIME = "wet";
const SEED = "golden-pred-seed";
const DAYS = { from: -1000, to: 1000 };

/** Every stored predicate kind, its edges, and the shapes compile order and Kleene logic must keep. */
export const PREDICATES: ReadonlyArray<readonly [string, unknown]> = [
  ["moon half-open", { moon: { name: "Sable", phase: [0, 0.02] } }],
  ["moon wrap", { moon: { name: "Sable", phase: [0.95, 0.05] } }],
  ["moon lo===hi", { moon: { name: "Sable", phase: [0.5, 0.5] } }],
  ["moon full circle", { moon: { name: "Sable", phase: [0, 1] } }],
  ["moon ulp window", { moon: { name: "Sable", phase: [0.3, 0.30000000000000004] } }],
  ["moon unwrapped bounds", { moon: { name: "Sable", phase: [-0.1, 1.1] } }],
  ["moon second", { moon: { name: "Ash", phase: [0.25, 0.75] } }],
  ["moon third", { moon: { name: "Ember", phase: [0.4, 0.6] } }],
  ["moon missing", { moon: { name: "Nope", phase: [0, 1] } }],
  ["not moon missing", { not: { moon: { name: "Nope", phase: [0, 1] } } }],
  ["yearPhase", { yearPhase: [0.45, 0.72] }],
  ["yearPhase wrap", { yearPhase: [0.9, 0.1] }],
  ["yearPhase lo===hi", { yearPhase: [0.25, 0.25] }],
  ["yearPhase edge 0", { yearPhase: [0, 0.25] }],
  ["dayOfYear", { dayOfYear: [10, 20] }],
  ["dayOfYear single", { dayOfYear: [10, 10] }],
  ["dayOfYear reversed", { dayOfYear: [20, 10] }],
  ["dayOfYear negative lo", { dayOfYear: [-5, 3] }],
  ["dayOfYear past end", { dayOfYear: [364, 400] }],
  ["dayOfYear fractional", { dayOfYear: [9.5, 10.5] }],
  ["not dayOfYear", { not: { dayOfYear: [10, 20] } }],
  ["tag season", { tag: "season:Summer" }],
  ["tag era", { tag: "era:Thaw" }],
  ["tag era Ash", { tag: "era:Ash" }],
  ["not tag era", { not: { tag: "era:Thaw" } }],
  ["tag missing", { tag: "nope" }],
  ["regime match", { regime: "wet" }],
  ["regime other", { regime: "dry" }],
  ["not regime", { not: { regime: "wet" } }],
  ["chance", { chance: 0.3 }],
  ["chance 0", { chance: 0 }],
  ["chance 1", { chance: 1 }],
  ["all empty", { all: [] }],
  ["any empty", { any: [] }],
  ["all winter thaw", { all: [{ tag: "season:Winter" }, { tag: "era:Thaw" }] }],
  ["all not-missing regime", { all: [{ not: { moon: { name: "Nope", phase: [0, 1] } } }, { regime: "wet" }] }],
  ["any era or moon", { any: [{ tag: "era:Thaw" }, { moon: { name: "Sable", phase: [0, 0.5] } }] }],
  ["not all era regime", { not: { all: [{ tag: "era:Ash" }, { regime: "wet" }] } }],
  ["nested chance", { all: [{ chance: 0.5 }, { not: { chance: 0.5 } }] }],
  ["multi-key all+moon", { all: [{ tag: "season:Summer" }], moon: { name: "Sable", phase: [0, 0.5] } }],
  ["multi-key moon+yearPhase", { moon: { name: "Sable", phase: [0, 0.5] }, yearPhase: [0.5, 1] }],
  ["unknown kind", { solstice: true }],
  ["malformed all", { all: 5 }],
  ["malformed phase", { moon: { name: "Sable", phase: 5 } }],
  ["malformed tag", { tag: 5 }],
];

/** DayTimes no adapter in golden-cal produces. Days are fixed so chance draws are pinned too. */
export const EDGES: ReadonlyArray<readonly [string, DayTime & { dayOrdinal: number }]> = [
  ["no moons field", { dayOrdinal: 1, yearPhase: 0.5, dayOfYear: 15, year: 1, tags: ["season:Summer"] }],
  ["moons empty", { dayOrdinal: 2, yearPhase: 0.5, dayOfYear: 15, year: 1, moons: [], tags: [] }],
  ["duplicate moon", { dayOrdinal: 3, yearPhase: 0.5, dayOfYear: 15, year: 1, moons: [{ name: "Sable", phase: 0.01 }, { name: "Sable", phase: 0.5 }] }],
  ["phase NaN", { dayOrdinal: 4, yearPhase: Number.NaN, dayOfYear: 15, moons: [{ name: "Sable", phase: Number.NaN }] }],
  ["phase 1", { dayOrdinal: 5, yearPhase: 1, dayOfYear: 15, moons: [{ name: "Sable", phase: 1 }] }],
  ["phase -0.1", { dayOrdinal: 6, yearPhase: -0.1, dayOfYear: 15, moons: [{ name: "Sable", phase: -0.1 }] }],
  ["phase just under 1", { dayOrdinal: 7, yearPhase: 0.9999999999999999, moons: [{ name: "Sable", phase: 0.9999999999999999 }] }],
  ["phase exact edges", { dayOrdinal: 8, yearPhase: 0.45, dayOfYear: 10, moons: [{ name: "Sable", phase: 0.02 }, { name: "Ash", phase: 0.25 }, { name: "Ember", phase: 0.6 }] }],
  ["phase -0", { dayOrdinal: 9, yearPhase: -0, dayOfYear: 0, moons: [{ name: "Sable", phase: -0 }] }],
  ["dayOfYear missing", { dayOrdinal: 10, yearPhase: 0.03 }],
  ["dayOfYear fractional", { dayOrdinal: 11, yearPhase: 0.03, dayOfYear: 10.25 }],
  ["dayOfYear just over", { dayOrdinal: 12, yearPhase: 0.03, dayOfYear: 20.000000000000004 }],
  ["tags missing", { dayOrdinal: 13, yearPhase: 0.5, dayOfYear: 15, year: 4 }],
  ["era tag only", { dayOrdinal: 14, yearPhase: 0.8, dayOfYear: 300, year: 4, tags: ["era:Thaw", "season:Winter"] }],
];

export interface GoldenPredZone {
  zoneId: string;
  /** predicate name → { gen, static } run-length strings over DAYS */
  rows: Record<string, { gen: string; static: string }>;
  /** modifier id → windowDays, for every spell modifier the zone's engine holds */
  windowDays: Record<string, number>;
}
export interface GoldenPred {
  seed: string;
  regime: string;
  days: typeof DAYS;
  worlds: Array<{ id: string; zones: GoldenPredZone[] }>;
  /** predicate name → edge name → { gen, static } single symbols */
  edges: Record<string, Record<string, { gen: string; static: string }>>;
}

type Sym = "t" | "f" | "u" | "x";

function run(f: () => boolean | undefined): Sym {
  try {
    const r = f();
    return r === true ? "t" : r === false ? "f" : "u";
  } catch {
    return "x";
  }
}

function ctxOf(t: DayTime, dayOrdinal: number, zoneId: string, regime: string): PredicateContext {
  return { ...t, dayOrdinal, regime, seed: SEED, zoneId, modifierId: "golden-pred" };
}

function symbols(p: Predicate, t: DayTime, d: number, zoneId: string): { gen: Sym; static: Sym } {
  return {
    gen: run(() => evaluatePredicate(p, ctxOf(t, d, zoneId, REGIME))),
    static: run(() => evaluateStatic(p, ctxOf(t, d, zoneId, ""))),
  };
}

/** "tttff" → "t3f2". */
export function rle(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && s[j] === s[i]) j++;
    out += `${s[i]}${j - i}`;
    i = j;
  }
  return out;
}

export function buildGoldenPred(): GoldenPred {
  const worlds = WORLDS.map((w) => {
    const adapter = w.adapter();
    return {
      id: w.id,
      zones: w.zones.map((z) => {
        const timeOf = dayTimeFn(adapter, w.eras, z.flipSeasons === true);
        const rows: GoldenPredZone["rows"] = {};
        for (const [name, p] of PREDICATES) {
          let gen = "";
          let stat = "";
          for (let d = DAYS.from; d <= DAYS.to; d++) {
            const s = symbols(p as Predicate, timeOf(d), d, z.id);
            gen += s.gen;
            stat += s.static;
          }
          rows[name] = { gen: rle(gen), static: rle(stat) };
        }
        // the engine World builds: zone daily modifiers, then the era modifiers
        const mods: Modifier[] = [...resolveProfile(z).dailyModifiers, ...eraModifiers(w.eras)];
        const engine = new ModifierEngine({ seed: SEED, zoneId: z.id, modifiers: mods, timeOf });
        const windowDays = Object.fromEntries((engine as unknown as { windowDays: Map<string, number> }).windowDays);
        return { zoneId: z.id, rows, windowDays };
      }),
    };
  });
  const edges: GoldenPred["edges"] = {};
  for (const [name, p] of PREDICATES) {
    const row: GoldenPred["edges"][string] = {};
    for (const [edge, t] of EDGES) row[edge] = symbols(p as Predicate, t, t.dayOrdinal, "edge");
    edges[name] = row;
  }
  return { seed: SEED, regime: REGIME, days: DAYS, worlds, edges };
}
