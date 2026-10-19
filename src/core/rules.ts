/**
 * Stored predicates compiled to Seshat rules (docs/SESHAT-v0.md §3.4). The
 * stored JSON is never rewritten (profileHash hashes it), and nothing is
 * written onto it: callers keep compiled rules beside the stored object.
 *
 * Keys are tested in the evaluator's historical order (all, any, not, moon,
 * yearPhase, dayOfYear, tag, regime, chance), so an object with several keys
 * compiles to the first (the old spell-window evaluator tested `regime` and
 * `era:` tags first, so `{ moon, regime }` differs there; validateProfile
 * rejects multi-key nodes). A node whose fields cannot be read compiles to a
 * `throw` leaf, which raises only when evaluation reaches it. validateProfile
 * rejects such shapes before any engine sees them, so this only matters to
 * callers that build engines directly.
 */
import type { EvalOptions, RuleAst } from "../seshat/rule";
import { bernoulli, drawKey, DrawStream } from "./rng";
import { ERA_TAG_PREFIX, type Predicate } from "./types";

const NEVER: RuleAst = { kind: "any", of: [] };

export function compilePredicate(p: Predicate): RuleAst {
  try {
    return compileNode(p);
  } catch (error) {
    return { kind: "throw", error };
  }
}

function compileNode(p: Predicate): RuleAst {
  if ("all" in p) return { kind: "all", of: p.all.map(compilePredicate) };
  if ("any" in p) return { kind: "any", of: p.any.map(compilePredicate) };
  if ("not" in p) return { kind: "not", of: compilePredicate(p.not) };
  if ("moon" in p) return { kind: "phase", body: p.moon.name, from: p.moon.phase[0], to: p.moon.phase[1] };
  if ("yearPhase" in p) return { kind: "phase", unit: "year", from: p.yearPhase[0], to: p.yearPhase[1] };
  if ("dayOfYear" in p) return { kind: "dayIn", unit: "year", from: p.dayOfYear[0], to: p.dayOfYear[1] };
  if ("tag" in p) return { kind: "tag", tag: p.tag };
  if ("regime" in p) return { kind: "host", key: "regime", arg: p.regime };
  if ("chance" in p) return { kind: "host", key: "chance", arg: p.chance };
  return NEVER;
}

/** What a rule's host leaves need: the day's draw key and the regime the generator chose. */
export interface RuleHostContext {
  seed: string;
  zoneId: string;
  modifierId: string;
  dayOrdinal: number;
  regime: string;
}

function chance(h: RuleHostContext, p: number): boolean {
  return bernoulli(new DrawStream(drawKey(h.seed, h.zoneId, h.dayOrdinal, `mod:${h.modifierId}:chance`)), p);
}

/** Generation: every leaf answered, two-valued. */
export function generationOptions(h: RuleHostContext): EvalOptions {
  return { host: (key, arg) => (key === "regime" ? h.regime === arg : chance(h, arg as number)) };
}

/** The spell-window estimate: regime and era tags unknown (Kleene), every child evaluated. */
export function staticOptions(h: RuleHostContext): EvalOptions {
  return { host: (key, arg) => (key === "regime" ? undefined : chance(h, arg as number)), unknownTag: (t) => t.startsWith(ERA_TAG_PREFIX), exhaustive: true };
}

