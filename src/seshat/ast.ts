/**
 * The typed calendar AST (docs/SESHAT-v0.md §4): the source of truth that
 * text syntax (P2) and the Studio form model (P3) compile to. Everything here
 * is integer days; the internal calendar's decimal year stays on FixedUnit.
 *
 * This is the subset the first calendars need: cycle units (never reset; a
 * constant or crossing base plus gear terms) and slot units (tile a parent
 * cycle or slot unit; constant, gear-adjusted or slack slots, any of them
 * filler). Tables, stages, labels with tags and the ledger arrive with the
 * calendars that need them.
 */
import type { GearAst } from "./gear";
import type { Rational } from "./rational";

/** Add `add` days to a length when `gear` matches. */
export interface GearTerm {
  readonly gear: string;
  readonly add: number;
}

/**
 * A crossing base (§2.3.1–2.3.2) in its normalized form: crossing 0 falls at
 * instant `at` on this unit's civil day line (meridian and day start folded in
 * once), and one more every `period` days. This is what is hashed; authoring
 * forms (a body, a mark, a day offset) compile to it.
 */
export interface CrossingAst {
  readonly period: Rational;
  readonly at: Rational;
  /**
   * Read the crossing at a derived index instead of k (§2.3.1): crossing
   * number floor((k·a + c) / L). Hebrew reads the molad at the months elapsed
   * before year k, floor((235k + 1) / 19).
   */
  readonly index?: { readonly a: number; readonly c: number; readonly L: number };
}

/**
 * One stage (C4, §2.5): a shift of each start, chosen by the first rule that
 * matches, read off the stage below only (the base plus gear terms, or the
 * previous stage). No rule matching shifts by 0. A stage never reads its own
 * output, so it is never a fixpoint.
 */
export interface StageAst {
  readonly rules: readonly StageRule[];
}

export type StageRule =
  /** shift by `add` when the start below, minus `offset`, is in `in` mod `mod` (a weekday test); window [0, 0] */
  | { readonly add: number; readonly residue: { readonly mod: number; readonly offset?: number; readonly in: readonly number[] } }
  /** shift by `add` when occurrence k + `at` below is `is` days long; window [at, at + 1] */
  | { readonly add: number; readonly length: { readonly at: number; readonly is: number } };

interface CycleCommon {
  readonly id: string;
  readonly kind: "cycle";
  readonly gears?: readonly GearTerm[];
  /** layers over the base and its gear terms, applied in order (§2.3.1) */
  readonly stages?: readonly StageAst[];
  /** display names by position (index mod labels.length); not hashed */
  readonly labels?: readonly string[];
}

/** A unit that never resets, with a constant base: occurrence i starts on anchor + length·i, plus its gear terms. */
export interface ConstantCycleAst extends CycleCommon {
  /** the day on which occurrence 0 starts (V1) */
  readonly anchor: number;
  /** base length in days; each gear term (on this unit) adds to it */
  readonly length: number;
  readonly crossing?: never;
}

/** A unit that never resets, with a crossing base: occurrence k starts on the civil day holding crossing k, plus its gear terms. */
export interface CrossingCycleAst extends CycleCommon {
  readonly crossing: CrossingAst;
  readonly anchor?: never;
  readonly length?: never;
}

/** A unit that never resets: one base and any gear terms on top (§2.3.1). */
export type CycleUnitAst = ConstantCycleAst | CrossingCycleAst;

export interface SlotAst {
  /** display name; not hashed */
  readonly name?: string;
  /**
   * days, or "slack": a share of whatever the parent occurrence leaves over.
   * 0 means the slot is absent this time. Several slack slots each get their
   * `min`, then the rest is handed out in `fill` order, each up to its `max`.
   */
  readonly length: number | "slack";
  /** slack only: the fewest days this slot takes (default 0) */
  readonly min?: number;
  /** slack only: the most days this slot takes (default unbounded) */
  readonly max?: number;
  /** slack only: the order extra days are handed out in, lowest first; slots without one come after, ties in slot order */
  readonly fill?: number;
  /** gear terms read the index of the cycle the slot unit sits under */
  readonly gears?: readonly GearTerm[];
  /** belongs to the parent but to no child sequence: a festival day has no décade (§2.3, Q1: it may still be named) */
  readonly filler?: boolean;
}

/** A unit that resets with its parent and tiles each occurrence of the parent, except filler slots, with an ordered list of slots. */
export interface SlotsUnitAst {
  readonly id: string;
  readonly kind: "slots";
  /** the parent: a cycle unit, or a slot unit (a décade in a month) */
  readonly in: string;
  readonly slots: readonly SlotAst[];
}

export type UnitAst = CycleUnitAst | SlotsUnitAst;

export interface CalendarAst {
  readonly name: string;
  readonly gears: readonly GearAst[];
  readonly units: readonly UnitAst[];
}
