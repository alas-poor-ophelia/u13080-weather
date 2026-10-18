/**
 * The typed calendar AST (docs/SESHAT-v0.md §4): the source of truth that
 * text syntax (P2) and the Studio form model (P3) compile to. Everything here
 * is integer days; the internal calendar's decimal year stays on FixedUnit.
 *
 * This is the subset the first calendars need: cycle units (never reset,
 * anchored; constant length plus gear terms) and slot units (tile a parent
 * cycle or slot unit; constant, gear-adjusted or slack slots, any of them
 * filler). Tables, stages, labels with tags and the ledger arrive with the
 * calendars that need them.
 */
import type { GearAst } from "./gear";

/** Add `add` days to a length when `gear` matches. */
export interface GearTerm {
  readonly gear: string;
  readonly add: number;
}

/** A unit that never resets: occurrence i starts on anchor + Σ lengths of occurrences [0, i). */
export interface CycleUnitAst {
  readonly id: string;
  readonly kind: "cycle";
  /** the day on which occurrence 0 starts (V1) */
  readonly anchor: number;
  /** base length in days; each gear term (on this unit) adds to it */
  readonly length: number;
  readonly gears?: readonly GearTerm[];
  /** display names by position (index mod labels.length); not hashed */
  readonly labels?: readonly string[];
}

export interface SlotAst {
  /** display name; not hashed */
  readonly name?: string;
  /** days, or "slack": whatever the parent occurrence leaves over. 0 means the slot is absent this time */
  readonly length: number | "slack";
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
