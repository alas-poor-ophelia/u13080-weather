/**
 * The Orrery's stage inspector edits (docs/SESHAT-v0.md §18.3; handoff README
 * "Stage"; bead wadjet-b6x, slice 5d). Pure: no DOM, no store.
 *
 * A stage (C4) moves a year's start by the first of its rules that matches,
 * reading the stage below only: a LENGTH rule tests how long the last, this
 * or next year runs there, a RESIDUE rule which day of a cycle the start
 * falls on (with a seven-label day cycle, a weekday). Stages exist on a year
 * that starts by a crossing: a fixed-day year has no postponements to make.
 *
 * Every edit writes the unit's `stages:<unit>` slice through `setStages`
 * (ast-edit.ts), which refuses a shape the validator would not take and runs
 * the validator's own start-rule checks (V2 windows, V3 shortest year); the
 * window runs `problems()` after. A new rule or stage moves nothing (`add`
 * 0, last in its stage), so the draft still runs as it did until a knob
 * turns it up. A refusal comes back with its reason and the draft as it was.
 */
import type { CalendarAst, CycleUnitAst, StageAst, StageRule } from "../../seshat";
import { setStages, weekdayCycle } from "./ast-edit";
import { applyAstEdit, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";

/** The length rule's `runs` knob (the handoff's 340–400 d). */
export const RUNS = { min: 340, max: 400 } as const;
/** The `add` knob (the handoff's 0–3). */
export const STAGE_ADD = { min: 0, max: 3 } as const;
/** The residue rule's `mod` knob (the handoff's 2–14). */
export const STAGE_MOD = { min: 2, max: 14 } as const;
/** Which year a length rule reads: the last, this or the next (window −1, 0, +1). */
export const WINDOWS = [
  { at: -1, word: "last" },
  { at: 0, word: "this" },
  { at: 1, word: "next" },
] as const;
/** A new length rule's `runs` when this year's length is not known. */
export const NEW_RUNS = 354;

type LengthRule = Extract<StageRule, { length: unknown }>;
type ResidueRule = Extract<StageRule, { residue: unknown }>;

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const mod = (a: number, m: number): number => {
  const r = a % m;
  return r < 0 ? r + m : r + 0;
};
const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${-n}`);

export const isLength = (r: StageRule): r is LengthRule => "length" in r;
export const isResidue = (r: StageRule): r is ResidueRule => "residue" in r;

/** The draft as one AST, or why it does not compile. */
function current(calendar: CalendarDraft): CalendarAst | string {
  const d = draftAst(calendar);
  return "error" in d ? d.error : d.ast;
}

const cycleIn = (ast: CalendarAst, id: string): CycleUnitAst | undefined => ast.units.find((u): u is CycleUnitAst => u.kind === "cycle" && u.id === id);

/** Whether `unitId` can carry stages here: a cycle unit that starts by a crossing (or one that already has stages). */
export function stagesApply(ast: CalendarAst, unitId: string): boolean {
  const u = cycleIn(ast, unitId);
  return !!u && (!!u.crossing || !!u.stages?.length);
}

/** Apply `op` to the draft's stages of `unitId`, then write them (`setStages`). */
function editStages(calendar: CalendarDraft, unitId: string, op: (stages: readonly StageAst[]) => readonly StageAst[] | string): CalendarEdit {
  const ast = current(calendar);
  if (typeof ast === "string") return refuse(ast);
  const u = cycleIn(ast, unitId);
  if (!u) return refuse(`there is no cycle unit "${unitId}"`);
  if (!stagesApply(ast, unitId)) return refuse(`the ${unitId} starts on fixed days; stages move a start that a crossing sets`);
  const next = op(u.stages ?? []);
  if (typeof next === "string") return refuse(next);
  return applyAstEdit(calendar, (a) => setStages(a, unitId, next));
}

/** Apply `op` to rule `j` of stage `i`. */
function editRule(calendar: CalendarDraft, unitId: string, i: number, j: number, op: (rule: StageRule) => StageRule | string): CalendarEdit {
  return editStages(calendar, unitId, (stages) => {
    const s = stages[i];
    if (!s) return `the ${unitId} has no stage ${i + 1}`;
    const r = s.rules[j];
    if (!r) return `stage ${i + 1} has no rule ${j + 1}`;
    const next = op(r);
    if (typeof next === "string") return next;
    return stages.map((x, k) => (k === i ? { rules: x.rules.map((y, l) => (l === j ? next : y)) } : x));
  });
}

/** A length rule's window (`at`: −1 last, 0 this, +1 next year), `runs` (`is`, days) and `add`. */
export function setLengthRule(calendar: CalendarDraft, unitId: string, i: number, j: number, patch: { at?: number; is?: number; add?: number }): CalendarEdit {
  return editRule(calendar, unitId, i, j, (r) => {
    if (!isLength(r)) return `rule ${j + 1} of stage ${i + 1} tests a weekday, not a length`;
    return { add: patch.add ?? r.add, length: { at: patch.at ?? r.length.at, is: patch.is ?? r.length.is } };
  });
}

/**
 * A residue rule's `add`, or its `mod`: the days it names keep those below the
 * new mod, read from `days` (the rule's days as the editor was built, so a
 * drag through a smaller mod and back keeps them all), else the draft's. A
 * mod that would leave no day named is refused.
 */
export function setResidueRule(calendar: CalendarDraft, unitId: string, i: number, j: number, patch: { mod?: number; add?: number }, days?: readonly number[]): CalendarEdit {
  return editRule(calendar, unitId, i, j, (r) => {
    if (!isResidue(r)) return `rule ${j + 1} of stage ${i + 1} tests a length, not a weekday`;
    const m = patch.mod ?? r.residue.mod;
    if (!isInt(m) || m < 1) return `a weekday test counts in ${String(m)}s; write a whole number of at least 1`;
    const hits = (patch.mod === undefined ? r.residue.in : (days ?? r.residue.in)).filter((h) => h < m);
    if (!hits.length) return `counting in ${m}s, the test would name no day; mark a day below ${m} first`;
    const { offset } = r.residue;
    return { add: patch.add ?? r.add, residue: { mod: m, ...(offset !== undefined ? { offset } : {}), in: [...new Set(hits)].sort((a, b) => a - b) } };
  });
}

/** Mark or unmark residue `cell` (0 to mod − 1) of a residue rule; the last marked day is kept (remove the rule instead). */
export function toggleResidue(calendar: CalendarDraft, unitId: string, i: number, j: number, cell: number): CalendarEdit {
  return editRule(calendar, unitId, i, j, (r) => {
    if (!isResidue(r)) return `rule ${j + 1} of stage ${i + 1} tests a length, not a weekday`;
    const { mod: m, offset, in: hits } = r.residue;
    if (!isInt(cell) || cell < 0 || cell >= m) return `day ${cell} is outside 0 to ${m - 1}`;
    const on = hits.includes(cell);
    if (on && hits.length === 1) return "a weekday test names at least one day; remove the rule instead";
    const next = on ? hits.filter((h) => h !== cell) : [...hits, cell].sort((a, b) => a - b);
    return { add: r.add, residue: { mod: m, ...(offset !== undefined ? { offset } : {}), in: next } };
  });
}

/**
 * A new rule for stage `i`, last in its list so it is read only when no other
 * matches, moving nothing yet (`add` 0): a length rule on this year at `runs`
 * days, or a weekday test on the first day of the cycle (with a seven-label
 * day cycle, its first label).
 */
export function newRule(ast: CalendarAst, kind: "length" | "residue", runs = NEW_RUNS): StageRule {
  if (kind === "length") return { add: 0, length: { at: 0, is: runs } };
  const w = weekdayCycle(ast);
  return { add: 0, residue: { mod: 7, ...(w && w.anchor !== 0 ? { offset: w.anchor } : {}), in: [0] } };
}

/** ＋ length rule / ＋ residue rule on stage `i` (`runs`: this year's length, for a length rule). */
export function addRule(calendar: CalendarDraft, unitId: string, i: number, kind: "length" | "residue", runs?: number): CalendarEdit {
  const ast = current(calendar);
  if (typeof ast === "string") return refuse(ast);
  const rule = newRule(ast, kind, runs);
  return editStages(calendar, unitId, (stages) => {
    if (!stages[i]) return `the ${unitId} has no stage ${i + 1}`;
    return stages.map((s, k) => (k === i ? { rules: [...s.rules, rule] } : s));
  });
}

/** Move rule `j` of stage `i` up (−1) or down (+1): the first rule that matches wins, so order is meaning. */
export function moveRule(calendar: CalendarDraft, unitId: string, i: number, j: number, dir: -1 | 1): CalendarEdit {
  return editStages(calendar, unitId, (stages) => {
    const s = stages[i];
    if (!s?.rules[j]) return `stage ${i + 1} has no rule ${j + 1}`;
    const to = j + dir;
    if (to < 0 || to >= s.rules.length) return dir < 0 ? "this rule is already read first" : "this rule is already read last";
    const rules = [...s.rules];
    [rules[j], rules[to]] = [rules[to]!, rules[j]!];
    return stages.map((x, k) => (k === i ? { rules } : x));
  });
}

/** Remove rule `j` of stage `i` (a stage keeps at least one rule). */
export function removeRule(calendar: CalendarDraft, unitId: string, i: number, j: number): CalendarEdit {
  return editStages(calendar, unitId, (stages) => {
    const s = stages[i];
    if (!s?.rules[j]) return `stage ${i + 1} has no rule ${j + 1}`;
    if (s.rules.length === 1) return "a stage needs at least one rule; remove the stage instead";
    return stages.map((x, k) => (k === i ? { rules: x.rules.filter((_, l) => l !== j) } : x));
  });
}

/** ＋ stage: a stage after the others, reading the last one, with one weekday test that moves nothing yet. `index` is the new stage's. */
export function addStage(calendar: CalendarDraft, unitId: string): CalendarEdit & { readonly index?: number } {
  const ast = current(calendar);
  if (typeof ast === "string") return refuse(ast);
  const rule = newRule(ast, "residue");
  const index = cycleIn(ast, unitId)?.stages?.length ?? 0;
  const r = editStages(calendar, unitId, (stages) => [...stages, { rules: [rule] }]);
  return "refused" in r ? r : { ...r, index };
}

/** Remove stage `i`; the stages after it read the one before it. */
export function removeStage(calendar: CalendarDraft, unitId: string, i: number): CalendarEdit {
  return editStages(calendar, unitId, (stages) => (stages[i] ? stages.filter((_, k) => k !== i) : `the ${unitId} has no stage ${i + 1}`));
}

// ---- readouts

/** One cell of a residue rule's grid: its residue, the weekday it is (or null), and whether the rule names it. */
export interface ResidueCell {
  readonly residue: number;
  readonly label: string | null;
  readonly on: boolean;
}

/**
 * A residue rule's cells: in weekday order, each titled by its day, when a day
 * cycle with `mod` labels exists (`weekdayCycle`; residue r of offset o is
 * label (r + o − anchor) mod m); else 0 to mod − 1, untitled.
 */
export function residueCells(ast: CalendarAst, r: ResidueRule): ResidueCell[] {
  const { mod: m, offset = 0, in: hits } = r.residue;
  const on = new Set(hits);
  const w = weekdayCycle(ast, m);
  if (!w) return Array.from({ length: m }, (_, k) => ({ residue: k, label: null, on: on.has(k) }));
  return w.labels.map((l, k) => {
    const residue = mod(k - offset + w.anchor, m);
    return { residue, label: l.name ?? `day ${k + 1}`, on: on.has(residue) };
  });
}

/** The residue a start on day `day` has under rule `r` (the cell lit as "this year"). */
export const residueOf = (r: ResidueRule, day: number): number => mod(day - (r.residue.offset ?? 0), r.residue.mod);

/** A rule as a sentence: "starts on Rishon · Revi'i · Shishi → +1", "starts on 2 · 4 · 6 of 7 → +1", "this year runs 356 d → +2". */
export function ruleSentence(ast: CalendarAst, r: StageRule): string {
  if (isLength(r)) {
    const w = WINDOWS.find((x) => x.at === r.length.at);
    const which = w ? `${w.word} year` : `year ${signed(r.length.at)}`;
    return `${which} runs ${r.length.is} d → ${signed(r.add)}`;
  }
  const cells = residueCells(ast, r).filter((c) => c.on);
  const named = cells.every((c) => c.label !== null);
  return named ? `starts on ${cells.map((c) => c.label).join(" · ")} → ${signed(r.add)}` : `starts on ${cells.map((c) => c.residue).join(" · ")} of ${r.residue.mod} → ${signed(r.add)}`;
}
