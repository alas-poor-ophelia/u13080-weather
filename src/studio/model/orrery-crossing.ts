/**
 * The Orrery's crossing and train inspector edits (docs/SESHAT-v0.md §18.3 D8,
 * §18.6 items 2 and 11; handoff README "Year (crossing base)", "Molad
 * (crossing)" and "Train"; bead wadjet-b6x, slice 5d). Pure: no DOM, no store.
 *
 * Every edit goes through the AST layer's `crossing:<unit>` slice (ast-edit.ts),
 * which the form never reads as fields, and `applyAstEdit`:
 *
 * - a unit that follows a body: START (contains | after, K stays), the MARK
 *   (K by `epochEditK`), the OFFSET (K by the turns the shift crosses) and the
 *   body it follows (K to the nearest turn), so its occurrences keep their
 *   numbers (§16.7 P1);
 * - a crossing written as numbers: its PERIOD in days, hours and parts
 *   (1/1080 h, written n/25920 reduced) and CROSSING 0's hour and parts (the
 *   day it falls on is kept);
 * - the train, the crossing's INDEX a/c/L (crossings per years, and a phase),
 *   through `setCrossingIndex`.
 *
 * A knob's write snaps back: inside the cell its origin (the value as the
 * editor was built) shows in, it writes the origin itself, and inside the
 * stored value's cell the stored value, so a drag back to the start leaves the
 * draft clean. A refusal comes back with its reason and the draft as it was;
 * the crossing edits refuse with the validator's own message when the start
 * rule would not run (ast-edit.ts `putCrossing`). `problems()` is the
 * window's, after.
 */
import type { CalendarAst, CrossingAst, CycleUnitAst, Rational } from "../../seshat";
import { rational } from "../../seshat/rational";
import { setCrossingBody, setCrossingIndex, setCrossingMark, setCrossingOffset, setCrossingStart, setLiteralCrossing } from "./ast-edit";
import { applyAstEdit, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";
import { epochWrite } from "./orrery-body";
import { cellOf, cellOfValue, fromMolad, moladOf, type Molad } from "./rational-knob";

/** The train's knobs (the handoff's crossings log 1–800, years 1–60). */
export const TRAIN = { a: { min: 1, max: 800 }, L: { min: 1, max: 60 } } as const;
/** The offset knob's travel, in hours either way. */
export const OFFSET_HOURS = 24;
/** The mark knob: a fraction of a turn shown to 0.01, 0 to 0.99. */
export const MARK_STEP: Rational = { n: 1, d: 100 };
export const MARK_MAX = 0.99;

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const sameR = (a: Rational | null | undefined, b: Rational): a is Rational => !!a && a.n * b.d === b.n * a.d;

/** The draft as one AST, or why it does not compile. */
function current(calendar: CalendarDraft, base: CalendarDraft): CalendarAst | string {
  const d = draftAst(calendar, base);
  return "error" in d ? d.error : d.ast;
}

/** Cycle unit `unitId`'s crossing in `ast`, or why there is none. */
export function crossingIn(ast: CalendarAst, unitId: string): CrossingAst | string {
  const u = ast.units.find((x): x is CycleUnitAst => x.kind === "cycle" && x.id === unitId);
  if (!u) return `there is no cycle unit "${unitId}"`;
  return u.crossing ?? `the ${unitId} does not start by a crossing`;
}

// ---- a unit that follows a body

/** START: the day holding the crossing (`contains`) or the first day that begins at or after it (`after`). K stays. */
export function setStartMode(calendar: CalendarDraft, base: CalendarDraft, unitId: string, after: boolean): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setCrossingStart(a, unitId, after));
}

/**
 * The MARK knob's write: the phase of the followed body at the crossing, a
 * fraction 0 to 0.99 on a 1/100 grid, snapping back to `origin` (the mark as
 * the editor was built) or `stored` inside the cell each shows in.
 */
export function markWrite(value: number, origin: Rational, stored: Rational | null): Rational {
  return epochWrite(value, origin, stored, MARK_STEP, MARK_MAX);
}

/** Set the MARK; K moves so the crossings keep their numbers (ast-edit.ts `setCrossingMark`). */
export function setMark(calendar: CalendarDraft, base: CalendarDraft, unitId: string, mark: Rational): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setCrossingMark(a, unitId, mark));
}

/** A day shift as whole hours on the knob: `days` × 24, rounded half up. */
export const offsetHours = (days: Rational): number => cellOf(days, { n: 1, d: 24 });

/**
 * The OFFSET knob's write, in days, for its value in hours (a whole hour on
 * the grid, n/24 reduced): `origin` or `stored` while the knob is in the hour
 * each shows in, so a shift of 6 h 20 p survives a drag back to its hour.
 */
export function offsetWrite(hours: number, origin: Rational, stored: Rational | null): Rational {
  const cell = cellOfValue(hours, { n: 1, d: 1 });
  if (cell === offsetHours(origin)) return origin;
  if (stored !== null && cell === offsetHours(stored)) return stored;
  return rational(cell, 24);
}

/** Set the OFFSET (a sunset day start); K moves by the turns the shift crosses. */
export function setOffset(calendar: CalendarDraft, base: CalendarDraft, unitId: string, offset: Rational): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setCrossingOffset(a, unitId, offset));
}

/** Follow another body (the same mark and shift); K is chosen so crossing 0 falls nearest where it was. */
export function followBody(calendar: CalendarDraft, base: CalendarDraft, unitId: string, bodyId: string): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setCrossingBody(a, unitId, bodyId));
}

/** The bodies the ＋ follow… menu offers: every other body, each with why it cannot be followed (one turning in less than a day), or null. */
export function followable(ast: CalendarAst, unitId: string): Array<{ id: string; name: string; why: string | null }> {
  const c = crossingIn(ast, unitId);
  const now = typeof c === "string" ? undefined : c.body?.id;
  return (ast.bodies ?? []).filter((b) => b.id !== now).map((b) => ({ id: b.id, name: b.moon?.name ?? b.id, why: b.period.n < b.period.d ? "turns in less than a day" : null }));
}

// ---- a crossing written as numbers

/**
 * The PERIOD's d·h·parts knobs write: `origin` (the period as the editor was
 * built) while the knobs show its molad, even one that is no whole number of
 * parts; the `stored` period when they show its value; else n/25920 reduced.
 */
export function periodWrite(next: Molad, origin: Rational, stored: Rational | null): Rational | string {
  const o = moladOf(origin).molad;
  if (next.days === o.days && next.hours === o.hours && next.parts === o.parts) return origin;
  const w = fromMolad(next);
  if (w.kind === "refused") return w.reason;
  return sameR(stored, w.value) ? stored : w.value;
}

/**
 * Set a literal crossing's period (positive days, exact). `keep` is the occurrence holding the Orrery's day: the
 * crossing it reads stays at its instant (crossing 0 moves instead, ast-edit.ts `setLiteralCrossing`), so the
 * present keeps its days and the far past moves. Null (the draft does not run) keeps crossing 0 where it is.
 */
export function setLiteralPeriod(calendar: CalendarDraft, base: CalendarDraft, unitId: string, period: Rational, keep: number | null = null): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setLiteralCrossing(a, unitId, keep === null ? { period } : { period, keep }));
}

/** The day crossing 0 falls on and its hour and parts in that day (the knobs show the hour and parts; the day is kept). */
export function crossingZero(at: Rational): { day: number; hours: number; parts: number; exact: boolean } {
  const m = moladOf(at);
  return { day: m.molad.days, hours: m.molad.hours, parts: m.molad.parts, exact: m.exact };
}

/**
 * The CROSSING 0 knobs write: the instant on `origin`'s day at `hours` and
 * `parts`; `origin` itself while they show its hour and parts, and the
 * `stored` instant when they show its value.
 */
export function zeroWrite(hours: number, parts: number, origin: Rational, stored: Rational | null): Rational | string {
  const o = crossingZero(origin);
  if (hours === o.hours && parts === o.parts) return origin;
  const w = fromMolad({ days: o.day, hours, parts });
  if (w.kind === "refused") return w.reason;
  return sameR(stored, w.value) ? stored : w.value;
}

/** Set a literal crossing's crossing 0 (the instant it falls). */
export function setCrossingZero(calendar: CalendarDraft, base: CalendarDraft, unitId: string, at: Rational): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setLiteralCrossing(a, unitId, { at }));
}

// ---- the train

export interface Train {
  readonly a: number;
  readonly c: number;
  readonly L: number;
}

/** The train of `unitId` in the draft, or why it has none. */
export function trainIn(ast: CalendarAst, unitId: string): Train | string {
  const c = crossingIn(ast, unitId);
  if (typeof c === "string") return c;
  return c.index ?? `the ${unitId} reads crossing k in year k; it has no train`;
}

/** Set the train's crossings (`a`), years (`L`) or phase (`c`), each over the draft's; refused with the validator's reason when it would not run. */
export function setTrain(calendar: CalendarDraft, base: CalendarDraft, unitId: string, patch: Partial<Train>): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const t = trainIn(ast, unitId);
  if (typeof t === "string") return refuse(t);
  const next = { a: patch.a ?? t.a, c: patch.c ?? t.c, L: patch.L ?? t.L };
  return applyAstEdit(calendar, base, (a) => setCrossingIndex(a, unitId, next));
}

/** The phase knob's travel for a train of `L` years: 0 to L − 1, widened to hold `c`. */
export function phaseRange(t: Train): { min: number; max: number } {
  return { min: Math.min(0, t.c), max: Math.max(1, t.L - 1, t.c) };
}
