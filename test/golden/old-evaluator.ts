/**
 * The pre-Seshat predicate evaluator, copied verbatim from src/core/modifiers.ts
 * at a0dad9e (Seshat P2 step 2 deleted it from src). It is the live oracle for
 * cases the frozen predicates.json cannot hold (evaluation order around a
 * throwing child); do not edit it to match new code.
 */
import { wrap } from "../../src/seshat/phase";
import { DrawStream, bernoulli, drawKey } from "../../src/core/rng";
import type { DayTime, Era, Predicate } from "../../src/core/types";

export interface PredicateContext extends DayTime {
  dayOrdinal: number;
  regime: string;
  seed: string;
  zoneId: string;
  modifierId: string;
}

/** Is x inside [lo, hi) on the unit circle (wraps if lo > hi)? */
export function inPhaseRange(x: number, lo: number, hi: number): boolean {
  const t = wrap(x);
  if (lo === hi) return false;
  if (lo < hi) return t >= lo && t < hi;
  return t >= lo || t < hi;
}

export function evaluatePredicate(p: Predicate, ctx: PredicateContext): boolean {
  if ("all" in p) return p.all.every((q) => evaluatePredicate(q, ctx));
  if ("any" in p) return p.any.some((q) => evaluatePredicate(q, ctx));
  if ("not" in p) return !evaluatePredicate(p.not, ctx);
  if ("moon" in p) {
    const m = ctx.moons?.find((x) => x.name === p.moon.name);
    if (!m) return false;
    return inPhaseRange(m.phase, p.moon.phase[0], p.moon.phase[1]);
  }
  if ("yearPhase" in p) return inPhaseRange(ctx.yearPhase, p.yearPhase[0], p.yearPhase[1]);
  if ("dayOfYear" in p) {
    if (ctx.dayOfYear === undefined) return false;
    return ctx.dayOfYear >= p.dayOfYear[0] && ctx.dayOfYear <= p.dayOfYear[1];
  }
  if ("tag" in p) return ctx.tags?.includes(p.tag) ?? false;
  if ("regime" in p) return ctx.regime === p.regime;
  if ("chance" in p) {
    const s = new DrawStream(drawKey(ctx.seed, ctx.zoneId, ctx.dayOrdinal, `mod:${ctx.modifierId}:chance`));
    return bernoulli(s, p.chance);
  }
  return false;
}

/**
 * A predicate evaluated before generation, three-valued: `undefined` means
 * unknown. Regime and era terms are unknown (see estimateWindowDays); `all`,
 * `any` and `not` follow Kleene logic, so an unknown never turns into a
 * definite answer by negation. Every other leaf is evaluated as usual.
 */
export function evaluateStatic(p: Predicate, ctx: PredicateContext): boolean | undefined {
  if ("all" in p) {
    const r = p.all.map((q) => evaluateStatic(q, ctx));
    return r.includes(false) ? false : r.includes(undefined) ? undefined : true;
  }
  if ("any" in p) {
    const r = p.any.map((q) => evaluateStatic(q, ctx));
    return r.includes(true) ? true : r.includes(undefined) ? undefined : false;
  }
  if ("not" in p) {
    const r = evaluateStatic(p.not, ctx);
    return r === undefined ? undefined : !r;
  }
  if ("regime" in p) return undefined;
  if ("tag" in p && p.tag.startsWith("era:")) return undefined;
  return evaluatePredicate(p, ctx);
}

/** eras.ts eraActive at a0dad9e, verbatim. */
export function eraActive(e: Era, year: number): boolean {
  if (e.enabled === false) return false;
  return year >= e.from && (e.to === undefined || year <= e.to);
}
