/**
 * The typed calendar AST (docs/SESHAT-v0.md §4): the source of truth that
 * text syntax (P2) and the Studio form model (P3) compile to. Everything here
 * is integer days; the internal calendar's decimal year stays on FixedUnit.
 *
 * This is the subset the first calendars need: cycle units (never reset; a
 * constant or crossing base plus gear terms) and slot units (tile a parent
 * cycle or slot unit; constant, gear-adjusted or slack slots, any of them
 * filler, or keyed on the parent's length), stages, labels with tags, and
 * the ledger (C6).
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

interface RuleCommon {
  readonly gears?: readonly GearTerm[];
  /** layers over the base and its gear terms, applied in order (§2.3.1) */
  readonly stages?: readonly StageAst[];
}

/** A constant base: occurrence i starts on anchor + length·i, plus the gear terms. */
export interface ConstantRule extends RuleCommon {
  /** the day on which occurrence 0 starts (V1) */
  readonly anchor: number;
  /** base length in days; each gear term (on the unit) adds to it */
  readonly length: number;
  readonly crossing?: never;
}

/** A crossing base: occurrence k starts on the civil day holding crossing k, plus the gear terms. */
export interface CrossingRule extends RuleCommon {
  readonly crossing: CrossingAst;
  readonly anchor?: never;
  readonly length?: never;
}

/** A start rule (§2.3.1): one base, its gear terms and stages. A ledger `switch` carries one. */
export type CycleRule = ConstantRule | CrossingRule;

interface CycleCommon {
  readonly id: string;
  readonly kind: "cycle";
  /** occurrence k carries labels[k mod labels.length] (C5, §2.6): modular weekday names, or one table over a cycle */
  readonly labels?: readonly LabelAst[];
  /** C6 (§2.7.1): rule switches, pinned starts and slot overrides, ordered by `from` (V7) */
  readonly ledger?: readonly LedgerEntry[];
}

export type ConstantCycleAst = ConstantRule & CycleCommon;
export type CrossingCycleAst = CrossingRule & CycleCommon;

/** A unit that never resets: its own start rule, and a ledger over it (§2.3.1, §2.7.1). */
export type CycleUnitAst = ConstantCycleAst | CrossingCycleAst;

/**
 * A ledger entry (C6, §2.7.1). Every entry is absolute: a switch's rule is
 * the same rule it would be alone, and pins name days, not offsets, so one
 * edit never moves the dates around it. Stages never read ledger data.
 */
export type LedgerEntry =
  /** from occurrence `from` on (until the next switch), this rule governs */
  | { readonly kind: "switch"; readonly from: number; readonly rule: CycleRule }
  /** occurrence `from` starts on `startsOn`; each length pins one more start after it (n lengths pin n + 1 starts) */
  | { readonly kind: "starts"; readonly from: number; readonly startsOn: number; readonly lengths?: readonly number[] }
  /**
   * in occurrence `from`, slot unit `unit` has exactly these lengths; `path` names the slot of each slot
   * unit between the cycle and `unit` (empty for a unit directly under the cycle). They must fill the parent.
   */
  | { readonly kind: "slots"; readonly from: number; readonly unit: string; readonly path?: readonly number[]; readonly lengths: readonly number[] };

/**
 * C5 Label (§2.6): a display name, not hashed (as moon phase names are not),
 * and tags, which are hashed because they reach predicates and weather.
 */
export interface LabelAst {
  readonly name?: string;
  readonly tags?: readonly string[];
}

export interface SlotAst {
  /** display name; not hashed */
  readonly name?: string;
  /** hashed, like a label's tags (Q1: filler slots may carry them too) */
  readonly tags?: readonly string[];
  /**
   * days, or "slack": a share of whatever the parent occurrence leaves over.
   * 0 means the slot is absent this time. Several slack slots each get their
   * `min`, then the rest is handed out in `fill` order, each up to its `max`.
   */
  readonly length: number | "slack" | KeyedLength;
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

/**
 * A slot length keyed on the length of the parent occurrence (C2): the Roman
 * February is 23 days in a 377-day year, 24 in a 378-day one. Ordered pairs,
 * so the hashed form is canonical; a parent length with no row is invalid.
 */
export interface KeyedLength {
  readonly by: "parent";
  readonly table: ReadonlyArray<readonly [parentLength: number, length: number]>;
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

/** A named or tagged day (C6 RDATE, §2.7.1): a one-off, such as a coronation. Its tags reach tagsAt. */
export interface DayLabelAst extends LabelAst {
  readonly day: number;
}

export interface CalendarAst {
  readonly name: string;
  readonly gears: readonly GearAst[];
  readonly units: readonly UnitAst[];
  readonly days?: readonly DayLabelAst[];
}
