/**
 * The Orrery's Seasons inspector edits (docs/SESHAT-v0.md §18.3 D8, §18.6
 * items 2 and 11; handoff README "Seasons"; bead wadjet-b6x, slice 5f).
 * Pure: no DOM, no store.
 *
 * MARKS · FROM: each mark starts its season at a fraction of the year, on a
 * day of the year (`DAY:N`), or on a day of a month (`month:M.D`, a slot of a
 * slot unit directly in the year). Two paths, as §18.6 items 2 and 11 ask:
 *
 * - THROUGH THE FORM (the draft's `seasons` field, the Seasons window's own
 *   draft) while every mark is a fraction of the year: the field is compiled
 *   (`draftAst`, form.ts `writeSeasons`). The field is kept in ascending
 *   order, as the Seasons window keeps it (its rows and its ribbon share
 *   indices), so a fraction knob builds its list from the marks as its
 *   editor saw them: a drag past a neighbour reorders, never edits another.
 * - THROUGH THE AST layer once a mark is dated (or the marks divide another
 *   unit): `setSeasonMark`, `addSeasonMark` and `removeSeasonMark`
 *   (ast-edit.ts, slice `marks`), with `problems()` after. An unsaved
 *   fraction edit in the field is folded into the layer first, so the two
 *   never disagree; the field then reads the layer's projection, which the
 *   Seasons window shows read-only.
 *
 * Switching a mark's kind converts it so it starts on the same day this year
 * where it can (`convertMark` says whether it could). A slot a season starts
 * in cannot be removed (setSlotUnit, form.ts `remapSeasonSlots`), and a Save
 * replays the marks only while those slots are as the edit saw them
 * (`replayProblem`).
 */
import { fractionBoundary, isDateMark, seasonsUseDates, type CalendarAst, type SeasonMarkAst, type SeasonsAst, type SlotsUnitAst } from "../../seshat";
import { addSeasonMark, markProblem, removeSeasonMark, setSeasonMark, withSlice, type AstEdit } from "./ast-edit";
import { applyAstEdit, calendarOfDefinition, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";
import { freshName, phaseInsertAt } from "./orrery-body";

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);

/** The fraction knob: 0 to 0.995 in steps of 0.005 (the handoff's `from` 0–.995). */
export const FROM = { max: 0.995, step: { n: 1, d: 200 } } as const;
/** How a mark says where its season starts: the inspector's `from` switch. */
export type MarkKind = "fraction" | "day" | "slot";
export const MARK_KINDS: ReadonlyArray<{ value: MarkKind; label: string }> = [
  { value: "fraction", label: "fraction" },
  { value: "day", label: "day of year" },
  { value: "slot", label: "month · day" },
];

export const kindOf = (m: SeasonMarkAst): MarkKind => (!isDateMark(m) ? "fraction" : "day" in m ? "day" : "slot");

/** The draft as one AST, or why it does not compile. */
function current(calendar: CalendarDraft, base: CalendarDraft): CalendarAst | string {
  const d = draftAst(calendar, base);
  return "error" in d ? d.error : d.ast;
}

function withDraft(next: CalendarDraft, base: CalendarDraft): CalendarEdit {
  const d = draftAst(next, base);
  return "error" in d ? refuse(d.error) : { calendar: next, ast: d.ast };
}

/** The unit the marks divide (the year when there are none yet). */
const seasonsUnit = (ast: CalendarAst): string => ast.seasons?.unit ?? "year";

/**
 * Why the Seasons window (fractions of the year, written through the form's year) cannot edit these seasons, or
 * null: a mark starts on a date ("dated"), or the marks divide another unit than the year ("unit": the form would
 * write them over the year). Both are edited in the Orrery or as text.
 */
export function seasonsWindowLock(seasons: SeasonsAst | undefined): "dated" | "unit" | null {
  if (!seasons) return null;
  if (seasonsUseDates(seasons)) return "dated";
  return seasons.unit !== "year" ? "unit" : null;
}

/** Whether the marks are edited through the AST layer: the layer's marks are dated, they divide another unit than the year, or the result is dated. */
function throughAst(calendar: CalendarDraft, ast: CalendarAst, next: readonly SeasonMarkAst[]): boolean {
  const layer = calendar.ast?.seasons;
  return (!!layer && seasonsUseDates(layer)) || seasonsUnit(ast) !== "year" || next.some(isDateMark);
}

/** The field the form writes: fractions of the year, ascending (stable), as the Seasons window keeps it. */
function asField(marks: readonly SeasonMarkAst[]): Array<{ name: string; from: number }> {
  return marks
    .map((m, i) => ({ name: m.name, from: "from" in m ? m.from : 0, i }))
    .sort((a, b) => a.from - b.from || a.i - b.i)
    .map(({ name, from }) => ({ name, from }));
}

/**
 * Write `next` (the whole list) through the form, or make `ast` (the AST edit) over the layer with the draft's
 * marks folded in. `ast` receives the layer with the draft's current marks in place.
 */
function write(calendar: CalendarDraft, base: CalendarDraft, cur: CalendarAst, next: readonly SeasonMarkAst[], ast: (folded: CalendarAst) => AstEdit): CalendarEdit {
  for (const m of next) {
    const why = markProblem(cur, seasonsUnit(cur), m);
    if (why) return refuse(why);
  }
  if (!throughAst(calendar, cur, next)) return withDraft({ ...calendar, seasons: asField(next) }, base);
  const layer = calendar.ast;
  if (!layer) return refuse("this calendar is not a definition the Studio edits");
  // the draft's marks (an unsaved fraction edit in the field included) are the ones edited: they go into the layer,
  // and the field takes the layer's own reading, so applyAstEdit sees no second source for the seasons
  const field: CalendarDraft = { ...calendar, seasons: calendarOfDefinition(layer).seasons };
  return applyAstEdit(field, base, (a) => {
    const folded = withSlice(a, "marks", cur.seasons);
    return folded ? ast(folded) : { refused: true, reason: "the seasons cannot be read" };
  });
}

/** The draft's marks, or why there are none to edit. */
function marksOf(calendar: CalendarDraft, base: CalendarDraft): { cur: CalendarAst; marks: readonly SeasonMarkAst[] } | string {
  const cur = current(calendar, base);
  if (typeof cur === "string") return cur;
  return { cur, marks: cur.seasons?.marks ?? [] };
}

/** Replace mark `i` with `f(mark)`. */
function editMark(calendar: CalendarDraft, base: CalendarDraft, i: number, f: (m: SeasonMarkAst) => SeasonMarkAst | string): CalendarEdit {
  const r = marksOf(calendar, base);
  if (typeof r === "string") return refuse(r);
  const m = r.marks[i];
  if (!m) return refuse(`there is no season ${i + 1}`);
  const next = f(m);
  if (typeof next === "string") return refuse(next);
  return write(calendar, base, r.cur, r.marks.map((x, j) => (j === i ? next : x)), (a) => setSeasonMark(a, i, next));
}

/** Rename mark `i` (a season needs a name). */
export function renameMark(calendar: CalendarDraft, base: CalendarDraft, i: number, name: string): CalendarEdit {
  const n = name.trim().normalize("NFC");
  if (n === "") return refuse("a season needs a name");
  return editMark(calendar, base, i, (m) => (m.name === n ? m : { ...m, name: n }));
}

/**
 * The fraction knob of mark `i`: it starts at `from` of the year. `origin` is the list as the editor was built
 * (the start of the gesture): the new list is built from it, so a drag that carries the mark past a neighbour
 * (which reorders the field) keeps editing this mark.
 */
export function setMarkFrom(calendar: CalendarDraft, base: CalendarDraft, i: number, from: number, origin: readonly SeasonMarkAst[]): CalendarEdit {
  if (!Number.isFinite(from) || from < 0 || from >= 1) return refuse("a season starts at a fraction of the year from 0 up to (not including) 1");
  const r = marksOf(calendar, base);
  if (typeof r === "string") return refuse(r);
  const m = origin[i];
  if (!m || !("from" in m)) return refuse(`season ${i + 1} does not start at a fraction of the year`);
  const next = origin.map((x, j) => (j === i ? { name: x.name, from } : x));
  return write(calendar, base, r.cur, next, (a) => setSeasonMark(a, i, { name: m.name, from }));
}

/** Mark `i` starts on day `day` of the year (`DAY:N`, 1-based). */
export function setMarkDay(calendar: CalendarDraft, base: CalendarDraft, i: number, day: number): CalendarEdit {
  if (!isInt(day) || day < 1) return refuse("a season starts on day 1 or later of the year");
  return editMark(calendar, base, i, (m) => ({ name: m.name, day }));
}

/** Mark `i` starts on day `day` of slot `index` of slot unit `unit` (a month directly in the year). */
export function setMarkSlot(calendar: CalendarDraft, base: CalendarDraft, i: number, slot: { readonly unit: string; readonly index: number; readonly day: number }): CalendarEdit {
  return editMark(calendar, base, i, (m) => ({ name: m.name, slot: { unit: slot.unit, index: slot.index, day: slot.day } }));
}

/** This year, as the editor reads it: the year's length and the day each mark falls on (by declaration index; null: skipped this year). */
export interface SeasonYear {
  readonly length: number;
  /** mark index → 0-based day of the year it falls on, null when it falls on none this year */
  readonly at: ReadonlyArray<number | null>;
  /** the slot lengths this year of each slot unit directly in the year */
  readonly slots: ReadonlyMap<string, readonly number[]>;
}

/** The slot units a dated mark can name: those directly in the unit the marks divide. */
export function markUnits(ast: CalendarAst): SlotsUnitAst[] {
  const unit = seasonsUnit(ast);
  return ast.units.filter((u): u is SlotsUnitAst => u.kind === "slots" && u.in === unit);
}

/** The fraction a mark on day `at` of a year of `length` days is written as: a knob step when one lands on that day, else at / length. */
export function fractionFor(at: number, length: number): number {
  const step = FROM.step.n / FROM.step.d;
  const near = Math.min(FROM.max, Math.round(at / length / step) * step);
  const r = Math.round(near * 1000) / 1000;
  return fractionBoundary(r, length) === at ? r : at / length;
}

/**
 * Mark `m` written as `kind`, starting on the same day this year (`at`) where it can: `kept` false when it could
 * not (the mark falls on no day this year, or the day lies in no slot), and the mark starts where the hint says
 * (the year's first day, or the slot's first). `unit` is the slot unit a month-and-day mark names.
 *
 * A fraction past the start of the year's last day falls on no day inside the year (a virtual day just past its
 * end, seasons.ts `markDay`): as a date it lands on the last day (`kept` false: one day earlier), or is refused,
 * with the reason, when the last day lies in no slot, rather than moving the season to the year's start.
 */
export function convertMark(m: SeasonMarkAst, kind: MarkKind, at: number | null, length: number, unit: { readonly id: string; readonly lengths: readonly number[] | null } | null): { mark: SeasonMarkAst; kept: boolean } | string {
  const name = m.name;
  if (kind === kindOf(m)) return { mark: m, kept: true };
  if (kind !== "fraction" && "from" in m && length > 0 && (at === null || at >= length) && fractionBoundary(m.from, length) === null) {
    const last = convertMark(m, kind, length - 1, length, unit);
    if (typeof last === "string") return last;
    if (!last.kept) return `${name} starts after the year's last day begins, and that day is in no slot of the ${unit?.id ?? "year"} this year; move it earlier in the year first`;
    return { mark: last.mark, kept: false };
  }
  if (kind === "fraction") return at === null || !(length > 0) ? { mark: { name, from: 0 }, kept: false } : { mark: { name, from: fractionFor(at, length) }, kept: true };
  if (kind === "day") return at === null ? { mark: { name, day: 1 }, kept: false } : { mark: { name, day: at + 1 }, kept: true };
  if (!unit) return "the year has no months directly in it for a season to start in";
  if (at !== null && unit.lengths) {
    let from = 0;
    for (let index = 0; index < unit.lengths.length; index++) {
      const len = unit.lengths[index]!;
      if (at < from + len) return { mark: { name, slot: { unit: unit.id, index, day: at - from + 1 } }, kept: true };
      from += len;
    }
  }
  return { mark: { name, slot: { unit: unit.id, index: 0, day: 1 } }, kept: false };
}

/**
 * Switch mark `i` to `kind` (the `from` switch), so it starts on the same day this year where it can (`year`: this
 * year's facts). `kept` says whether it could. A fraction becomes a date through the AST (the form holds
 * fractions only); a date becomes a fraction there too while another mark is dated.
 */
export function setMarkKind(calendar: CalendarDraft, base: CalendarDraft, i: number, kind: MarkKind, year: SeasonYear | null): CalendarEdit & { readonly kept?: boolean } {
  const r = marksOf(calendar, base);
  if (typeof r === "string") return refuse(r);
  const m = r.marks[i];
  if (!m) return refuse(`there is no season ${i + 1}`);
  const units = markUnits(r.cur);
  const named = "slot" in m ? units.find((u) => u.id === m.slot.unit) : undefined;
  const u = named ?? units[0];
  const c = convertMark(m, kind, year?.at[i] ?? null, year?.length ?? 0, u ? { id: u.id, lengths: year?.slots.get(u.id) ?? null } : null);
  if (typeof c === "string") return refuse(c);
  const out = write(calendar, base, r.cur, r.marks.map((x, j) => (j === i ? c.mark : x)), (a) => setSeasonMark(a, i, c.mark));
  return "refused" in out ? out : { ...out, kept: c.kept };
}

/**
 * ＋ mark: a season named afresh, starting at the middle of the largest gap between this year's marks (`phases`:
 * where each mark sits, as a fraction of the year), as a fraction. `index` is the new mark's place in the list
 * (the field is kept ascending; the AST keeps it last).
 */
export function addMark(calendar: CalendarDraft, base: CalendarDraft, phases: readonly number[]): CalendarEdit & { readonly index?: number } {
  const r = marksOf(calendar, base);
  if (typeof r === "string") return refuse(r);
  if (!r.cur.seasons && !r.cur.units.some((u) => u.kind === "cycle" && u.id === "year")) return refuse("this calendar has no year for seasons to divide");
  const mark: SeasonMarkAst = { name: freshName("Season", r.marks.map((m) => m.name)), from: Math.min(FROM.max, phaseInsertAt(phases)) };
  const next = [...r.marks, mark];
  const ast = throughAst(calendar, r.cur, next);
  const out = write(calendar, base, r.cur, next, (a) => addSeasonMark(a, mark));
  if ("refused" in out) return out;
  const index = ast ? next.length - 1 : asField(next).findIndex((m) => m.name === mark.name);
  return { ...out, index };
}

/** Remove mark `i`; the last one takes the seasons with it. */
export function removeMark(calendar: CalendarDraft, base: CalendarDraft, i: number): CalendarEdit {
  const r = marksOf(calendar, base);
  if (typeof r === "string") return refuse(r);
  if (!r.marks[i]) return refuse(`there is no season ${i + 1}`);
  return write(calendar, base, r.cur, r.marks.filter((_, j) => j !== i), (a) => removeSeasonMark(a, i));
}

/** A dated mark's day knob range: day of the year 1 to the year's length, or day of the slot 1 to the slot's length (60 at most when unknown). */
export function dayRange(m: SeasonMarkAst, year: SeasonYear | null): { min: number; max: number } {
  if ("day" in m) return { min: 1, max: Math.max(m.day, year?.length ?? 366) };
  if ("slot" in m) return { min: 1, max: Math.max(m.slot.day, year?.slots.get(m.slot.unit)?.[m.slot.index] ?? 60) };
  return { min: 1, max: 1 };
}
