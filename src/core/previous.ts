/**
 * The previous generator's own formulas (wadjet-gen/0.0.3, docs/SESHAT-v0.md
 * §17.2): what a world in "previous" mode runs where 0.0.4 changed the math.
 * Each is restored verbatim from the minus side of c773f5d. Nothing in
 * "current" mode reads this module. At the next generator bump these are
 * deleted and the current formulas become the previous ones (§17.2).
 *
 * The compiled-rule phase wrap lives in seshat/rule.ts (EvalOptions.legacyWrap),
 * because src/seshat imports nothing outside itself.
 */
import { wrap } from "../seshat/phase";

/** 0.0.3's phase wrap for windows and envelopes: the `+ 1` rounds, so an exact edge lands an ulp low (0.45 → 0.44999999999999996). */
export function legacyWrap(x: number): number {
  return ((x % 1) + 1) % 1;
}

/**
 * 0.0.3's moon phase, as the internal calendar (and the Studio) computed it:
 * floats, `(d / cycle + epoch) % 1`, then the floor wrap. No finite guard, on
 * purpose: 0.0.3 had none, so a cycle the repair lets through that still
 * overflows (5e-324) gives NaN here as it did then (every phase predicate reads
 * false). Guarding it would change that world's weather; current mode guards.
 */
export function legacyMoonPhase(cycleDays: number, phaseAtEpoch: number, dayOrdinal: number): number {
  return wrap((dayOrdinal / cycleDays + phaseAtEpoch) % 1);
}
