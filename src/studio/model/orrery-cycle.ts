/**
 * The Orrery's labelled cycle inspector edits (docs/SESHAT-v0.md §18.3, §18.6
 * item 2; handoff README "Labelled cycle"; bead wadjet-b6x, slice 5e). Pure:
 * no DOM, no store.
 *
 * A labelled cycle is a cycle unit (not the year, not a crossing) whose
 * occurrences carry labels: the weekday, a market day, the Maya day names.
 * Two paths, one per part, as §18.6 item 2 asks:
 *
 * - THROUGH THE FORM where the form reads the part as fields: the week's day
 *   names are `FormDraft.week` (the one-day cycle naming the days and the
 *   week that runs with it, form.ts `findWeek`), so renaming, adding or
 *   removing a day name, and removing the week, go through `compile`.
 * - THROUGH THE AST layer elsewhere (unit-edit.ts, `applyAstEdit`): the
 *   labels of any other labelled cycle (`cycle:<unit>`), every unit's
 *   anchor (`today is`: the form holds no anchor; the weekday and its week
 *   move together), a rename (the formats' `{id…}` tokens and the rules
 *   that read the unit follow), and removing a cycle the form does not read.
 *
 * Refusals come back with their reason and the draft as it was: a rule that
 * reads a label by name (a rename onto or away from it, a removal, any count
 * change), a new id another part declares, a reader of a removed unit.
 */
import type { CalendarAst, CycleUnitAst, LabelAst } from "../../seshat";
import { applyAstEdit, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";
import { freshName } from "./orrery-body";
import { anchorFor, anchorProblem, cycleLabelProblem, cyclePartner, removeUnit, renameUnit, setCycleAnchor, setCycleLabels, unitReaders } from "./unit-edit";

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const mod = (a: number, m: number): number => {
  const r = a % m;
  return r < 0 ? r + m : r + 0;
};

/** The draft as one AST, or why it does not compile. */
function current(calendar: CalendarDraft, base: CalendarDraft): CalendarAst | string {
  const d = draftAst(calendar, base);
  return "error" in d ? d.error : d.ast;
}

function withDraft(next: CalendarDraft, base: CalendarDraft): CalendarEdit {
  const d = draftAst(next, base);
  return "error" in d ? refuse(d.error) : { calendar: next, ast: d.ast };
}

const cycleIn = (ast: CalendarAst, id: string): CycleUnitAst | undefined => ast.units.find((u): u is CycleUnitAst => u.kind === "cycle" && u.id === id);

/** Whether `unitId` is a cycle this inspector edits: a cycle unit that is not the year (`yearUnit`) and does not start by a crossing. */
export function cycleEditable(ast: CalendarAst, unitId: string, yearUnit: string): boolean {
  const u = cycleIn(ast, unitId);
  return !!u && u.id !== yearUnit && u.id !== "year" && !u.crossing;
}

/** The form's week, when the draft holds it as fields: its day-name unit and the week that runs with it. */
function formWeek(calendar: CalendarDraft, ast: CalendarAst): { days: CycleUnitAst; week: CycleUnitAst | undefined } | null {
  if (!Array.isArray(calendar.form?.week)) return null;
  const named = ast.units.filter((u): u is CycleUnitAst => u.kind === "cycle" && u.id !== "year" && u.length === 1 && u.labels !== undefined);
  if (named.length !== 1) return null;
  return { days: named[0]!, week: cyclePartner(ast, named[0]!.id) };
}

/** Whether the form reads `unitId` (the day names or their week), so its labels and removal go through the form. */
export function inFormWeek(calendar: CalendarDraft, ast: CalendarAst, unitId: string): boolean {
  const w = formWeek(calendar, ast);
  return !!w && (w.days.id === unitId || w.week?.id === unitId);
}

// ---- the id

/** Rename cycle `unitId` (an AST edit: the formats' tokens and the rules that read it follow). */
export function renameCycle(calendar: CalendarDraft, base: CalendarDraft, unitId: string, to: string): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => renameUnit(a, unitId, to));
}

// ---- labels

/** A label list after an edit: `from[i]` is the index label i had (null: new). */
export interface LabelsChange {
  readonly labels: readonly LabelAst[];
  readonly from: ReadonlyArray<number | null>;
}

/**
 * Edit cycle `unitId`'s labels with `op` (reading the draft as it is): the form's day names when the form reads
 * them and the result is names only, else the AST's `cycle:` slice. A rule that reads a label by name refuses
 * the edit either way (`cycleLabelProblem`).
 */
export function editLabels(calendar: CalendarDraft, base: CalendarDraft, unitId: string, op: (labels: readonly LabelAst[], unit: CycleUnitAst) => LabelsChange | string): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const u = cycleIn(ast, unitId);
  if (!u) return refuse(`there is no cycle unit "${unitId}"`);
  if (!u.labels?.length) return refuse(`the ${unitId} has no labels`);
  const r = op(u.labels, u);
  if (typeof r === "string") return refuse(r);
  if (r.labels.length === 0) return refuse(`the ${unitId} needs at least one label; remove the cycle instead`);
  const why = cycleLabelProblem(ast, unitId, r.labels, r.from);
  if (why) return refuse(why);
  const w = formWeek(calendar, ast);
  const names = r.labels.every((l) => typeof l.name === "string" && l.tags === undefined) ? r.labels.map((l) => l.name!) : null;
  if (w && w.days.id === unitId && names) return withDraft({ ...calendar, form: { ...calendar.form, week: names } }, base);
  return applyAstEdit(calendar, base, (a) => setCycleLabels(a, unitId, r.labels, r.from));
}

const ident = (labels: readonly LabelAst[]): Array<number | null> => labels.map((_, i) => i);

/** Rename label `i` (a name cannot be blank). */
export function renameLabel(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, name: string): CalendarEdit {
  const n = name.trim().normalize("NFC");
  if (n === "") return refuse("a label's name cannot be blank");
  return editLabels(calendar, base, unitId, (labels) => {
    const l = labels[i];
    if (!l) return `the ${unitId} has no label ${i + 1}`;
    return { labels: labels.map((x, j) => (j === i ? (x.name === n ? x : { ...x, name: n }) : x)), from: ident(labels) };
  });
}

/** ＋ label: a label after the others with a fresh name; the cycle (and the week that runs with it) is one longer. `index` is the new label's. */
export function addLabel(calendar: CalendarDraft, base: CalendarDraft, unitId: string): CalendarEdit & { readonly index?: number } {
  let index = -1;
  const r = editLabels(calendar, base, unitId, (labels) => {
    index = labels.length;
    return { labels: [...labels, { name: freshName("Label", labels.flatMap((l) => (l.name === undefined ? [] : [l.name]))) }], from: [...ident(labels), null] };
  });
  return "refused" in r ? r : { ...r, index };
}

/** × on label `i`: the cycle (and its week) is one shorter; the last label stays (remove the cycle instead). */
export function removeLabel(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number): CalendarEdit {
  return editLabels(calendar, base, unitId, (labels) => {
    if (!labels[i]) return `the ${unitId} has no label ${i + 1}`;
    if (labels.length === 1) return `the ${unitId} needs at least one label; remove the cycle instead`;
    return { labels: labels.filter((_, j) => j !== i), from: ident(labels).filter((f) => f !== i) };
  });
}

// ---- today is

/** The label cycle `u` gives day `day`: occurrence floor((day − anchor) / length), mod the labels. */
export function labelOn(u: CycleUnitAst & { readonly anchor: number }, day: number): number {
  const n = u.labels?.length ?? 0;
  return n ? mod(Math.floor((day - u.anchor) / u.length), n) : 0;
}

/**
 * `today is`: move cycle `unitId`'s anchor so label `label` falls on day `day` (the Orrery's own day), by the
 * smallest shift from `origin` (the anchor as the editor was built, so a knob back at its first label puts that
 * anchor back exactly). An AST edit (the form holds no anchor); the week that runs with the day names moves by
 * the same days. Refused while a rule reads the unit by number, or a gear counts it.
 */
export function setTodayIs(calendar: CalendarDraft, base: CalendarDraft, unitId: string, label: number, day: number, origin: number): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const u = cycleIn(ast, unitId);
  if (!u || u.crossing) return refuse(`there is no cycle unit "${unitId}" with an anchor`);
  const n = u.labels?.length ?? 0;
  if (!n) return refuse(`the ${unitId} has no labels`);
  if (!Number.isSafeInteger(label) || label < 0 || label >= n) return refuse(`the ${unitId} has no label ${label + 1}`);
  const anchor = anchorFor(origin, u.length, n, day, label);
  if (anchor === u.anchor) return withDraft(calendar, base);
  const why = anchorProblem(ast, unitId);
  if (why) return refuse(why);
  return applyAstEdit(calendar, base, (a) => setCycleAnchor(a, unitId, anchor));
}

// ---- remove

/**
 * Remove cycle `unitId`: through the form when it is the form's week (its day names and the week go together, as
 * the form writes them), else an AST edit. Refused while anything reads it (formats, rules, seasons, gears, a slot
 * unit inside it, a stage's weekday names), naming the first.
 */
export function removeCycle(calendar: CalendarDraft, base: CalendarDraft, unitId: string): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  if (!cycleIn(ast, unitId)) return refuse(`there is no cycle unit "${unitId}"`);
  const w = formWeek(calendar, ast);
  if (w && (w.days.id === unitId || w.week?.id === unitId)) {
    for (const u of [w.days, w.week]) {
      if (!u) continue;
      const readers = unitReaders(ast, u.id);
      if (readers.length) return refuse(`the ${u.id} goes with the week, and ${readers[0]}; change that first`);
    }
    return withDraft({ ...calendar, form: { ...calendar.form, week: null } }, base);
  }
  return applyAstEdit(calendar, base, (a) => removeUnit(a, unitId));
}

/** What `Remove cycle` takes with it: the week's other unit when the form writes the two together, else nothing. */
export function removedWith(calendar: CalendarDraft, ast: CalendarAst, unitId: string): string | null {
  const w = formWeek(calendar, ast);
  if (!w) return null;
  if (w.days.id === unitId) return w.week?.id ?? null;
  return w.week?.id === unitId ? w.days.id : null;
}
