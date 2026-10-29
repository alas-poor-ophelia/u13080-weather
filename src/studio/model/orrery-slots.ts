/**
 * The Orrery's year, slot unit and slot inspector edits (docs/SESHAT-v0.md
 * §18.3, §18.6 item 2; bead wadjet-b6x, slice 5b). Pure: no DOM, no store.
 *
 * Two paths, one per part, as §18.6 item 2 asks:
 *
 * - THROUGH THE FORM wherever the form model reads the part as fields: the
 *   year's length is `FormDraft.year.length` and the months (the one slot
 *   unit directly in the year, every slot a name and a length, at most one
 *   taking the rest) are `FormDraft.months`. The draft is compiled
 *   (`draftAst`), so `compile`'s guards hold, among them a season mark on a
 *   month following its month.
 * - THROUGH THE AST layer where the form returns text (Harptos: filler slots,
 *   a gear on a slot, the tenday inside the months): `setCycleLength` and
 *   `setSlotUnit` (ast-edit.ts, slices `length:<unit>` and `slots:<unit>`)
 *   through `applyAstEdit`. A slot edit the form cannot write (a filler, a
 *   second slot that takes the rest) takes this path too, and is refused
 *   while the months hold an unsaved field edit (one source per part).
 *
 * A refusal comes back with its reason and the draft as it was. Whether the
 * slots still fill their parent every year is `problems()`'s to say: the
 * window runs it after the edit and lights the unit's LED and the issue strip.
 */
import type { MonthForm } from "../../plugin/time/form";
import type { CalendarAst, SlotAst, SlotsUnitAst } from "../../seshat";
import { setCycleLength, setSlotUnit, slotLabelProblem, slotOrderProblem } from "./ast-edit";
import { applyAstEdit, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";
import { freshName } from "./orrery-body";

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);

/** The days a slot knob runs over (the handoff's 0–60). */
export const SLOT_DAYS = { min: 0, max: 60 } as const;
/** The days a year knob runs over (the handoff's 300–420), widened to hold the year's own length. */
export function yearRange(length: number): { min: number; max: number } {
  return { min: Math.min(300, length), max: Math.max(420, length) };
}

/** The draft as one AST, or why it does not compile. */
function current(calendar: CalendarDraft, base: CalendarDraft): CalendarAst | string {
  const d = draftAst(calendar, base);
  return "error" in d ? d.error : d.ast;
}

// ---- the year

/**
 * Set cycle unit `unitId`'s base length (a leap gear still adds to it): the
 * form's year when it reads the year as fields, else the AST's `length:` slice.
 */
export function setYearLength(calendar: CalendarDraft, base: CalendarDraft, unitId: string, length: number): CalendarEdit {
  if (!isInt(length) || length < 1) return refuse(`a ${unitId} of ${length} days; write a whole number of at least 1`);
  const year = calendar.form?.year;
  if (unitId === "year" && year) {
    if (year.length === length) return withDraft(calendar, base);
    return withDraft({ ...calendar, form: { ...calendar.form, year: { ...year, length } } }, base);
  }
  return applyAstEdit(calendar, base, (a) => setCycleLength(a, unitId, length));
}

function withDraft(next: CalendarDraft, base: CalendarDraft): CalendarEdit {
  const d = draftAst(next, base);
  return "error" in d ? refuse(d.error) : { calendar: next, ast: d.ast };
}

// ---- slots

/** A slot list after an edit: `from[i]` is the index slot i had before (null: new). */
export interface SlotsChange {
  readonly slots: readonly SlotAst[];
  readonly from: ReadonlyArray<number | null>;
}
export type SlotsOp = (slots: readonly SlotAst[], unit: SlotsUnitAst) => SlotsChange | string;

/** The months as the form writes them, or null when a slot is more than a name and a length (or two take the rest). */
function asMonths(slots: readonly SlotAst[]): MonthForm[] | null {
  const out: MonthForm[] = [];
  for (const s of slots) {
    if (Object.keys(s).some((k) => k !== "name" && k !== "length")) return null;
    if (typeof s.name !== "string" || (typeof s.length !== "number" && s.length !== "slack")) return null;
    out.push({ name: s.name, length: s.length });
  }
  return out.filter((m) => m.length === "slack").length > 1 ? null : out;
}

/** Whether `unitId` is the months the form reads: the one slot unit directly in the year. */
function isMonths(ast: CalendarAst, unitId: string): boolean {
  const ms = ast.units.filter((u) => u.kind === "slots" && u.in === "year");
  return ms.length === 1 && ms[0]!.id === unitId;
}

/**
 * Edit slot unit `unitId`'s slots with `op` (reading the draft as it is): the
 * form's months when the form reads them and can write the result, else the
 * AST's `slots:` slice.
 */
export function editSlots(calendar: CalendarDraft, base: CalendarDraft, unitId: string, op: SlotsOp): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const u = ast.units.find((x): x is SlotsUnitAst => x.kind === "slots" && x.id === unitId);
  if (!u) return refuse(`there is no slot unit "${unitId}"`);
  const r = op(u.slots, u);
  if (typeof r === "string") return refuse(r);
  const reordered = r.from.length !== u.slots.length || r.from.some((f, i) => f !== i);
  if (reordered) {
    const why = slotOrderProblem(ast, unitId);
    if (why) return refuse(why);
  }
  const named = slotLabelProblem(ast, unitId, r.slots, r.from);
  if (named) return refuse(named);
  const months = calendar.form?.months !== undefined && calendar.form.months !== null && isMonths(ast, unitId) ? asMonths(r.slots) : null;
  if (months) {
    if (r.slots.length === 0) return refuse(`the ${unitId} needs at least one slot`);
    return withDraft({ ...calendar, form: { ...calendar.form, months } }, base);
  }
  return applyAstEdit(calendar, base, (a) => setSlotUnit(a, unitId, r.slots, r.from));
}

const same = (slots: readonly SlotAst[]): Array<number | null> => slots.map((_, i) => i);

function at(slots: readonly SlotAst[], i: number, unit: SlotsUnitAst): SlotAst | string {
  return slots[i] ?? `the ${unit.id} has no slot ${i + (unit.number ?? 1)}`;
}

function put(slots: readonly SlotAst[], i: number, s: SlotAst): SlotsChange {
  return { slots: slots.map((x, j) => (j === i ? s : x)), from: same(slots) };
}

/** A fixed length: the rest's limits and fill order go with it. */
function fixed(s: SlotAst, days: number): SlotAst {
  const { min: _min, max: _max, fill: _fill, ...rest } = s;
  return { ...rest, length: days };
}

/** Rename slot `i` (a slot that had a name keeps one; an unnamed slot, a tenday, may take one). */
export function renameSlot(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, name: string): CalendarEdit {
  const n = name.trim().normalize("NFC");
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    if (n === "") {
      if (s.name === undefined) return put(slots, i, s);
      return "a slot that has a name keeps one; type a new name";
    }
    return put(slots, i, s.name === n ? s : { ...s, name: n });
  });
}

/** Slot `i` takes `days` days (0: absent; a gear on it still adds). A slot that took the rest takes this many instead. */
export function setSlotDays(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, days: number): CalendarEdit {
  if (!isInt(days) || days < 0) return refuse(`a slot of ${days} days; write a whole number from 0 up`);
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    if (typeof s.length === "object") return "this slot's length follows the length of its year, row by row; edit it as text";
    return put(slots, i, s.length === days ? s : fixed(s, days));
  });
}

/** Slot `i` belongs to its parent but to no slot unit inside it (a festival day outside every tenday), or not. */
export function setSlotFiller(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, on: boolean): CalendarEdit {
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    const { filler: _f, ...rest } = s;
    return put(slots, i, on ? { ...rest, filler: true } : rest);
  });
}

/**
 * Slot `i` takes the rest of its parent (whatever the other slots leave), or
 * a fixed `days` (its length this year, so turning it off moves nothing now).
 */
export function setSlotRest(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, on: boolean, days: number): CalendarEdit {
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    if (on) return put(slots, i, s.length === "slack" ? s : { ...s, length: "slack" });
    if (s.length !== "slack") return put(slots, i, s);
    if (!isInt(days) || days < 0) return `a slot of ${days} days; write a whole number from 0 up`;
    return put(slots, i, fixed(s, days));
  });
}

/** Move slot `i` one place earlier (−1) or later (+1). */
export function moveSlot(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number, by: -1 | 1): CalendarEdit {
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    const j = i + by;
    if (j < 0 || j >= slots.length) return by < 0 ? "this is the first slot" : "this is the last slot";
    const from = same(slots);
    [from[i], from[j]] = [j, i];
    return { slots: from.map((f) => slots[f!]!), from };
  });
}

/**
 * Add a slot after slot `i` (−1 or past the end: after the last). It takes the
 * length of the slot before it (30 days when that one has no fixed length),
 * and a fresh name when the unit's slots are named.
 */
export function addSlot(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number): CalendarEdit & { readonly index?: number } {
  let index = -1;
  const r = editSlots(calendar, base, unitId, (slots) => {
    const after = i < 0 || i >= slots.length ? slots.length - 1 : i;
    const prev = slots[after];
    const named = slots.some((s) => s.name !== undefined);
    const slot: SlotAst = { ...(named ? { name: freshName("New slot", slots.flatMap((s) => (s.name === undefined ? [] : [s.name]))) } : {}), length: typeof prev?.length === "number" && prev.length > 0 ? prev.length : 30 };
    index = after + 1;
    const from: Array<number | null> = same(slots);
    from.splice(index, 0, null);
    return { slots: [...slots.slice(0, index), slot, ...slots.slice(index)], from };
  });
  return "refused" in r ? r : { ...r, index };
}

/** Remove slot `i` (a unit keeps at least one; a season that starts in it refuses, naming it). */
export function removeSlot(calendar: CalendarDraft, base: CalendarDraft, unitId: string, i: number): CalendarEdit {
  return editSlots(calendar, base, unitId, (slots, unit) => {
    const s = at(slots, i, unit);
    if (typeof s === "string") return s;
    if (slots.length === 1) return `the ${unitId} needs at least one slot`;
    const from = same(slots).filter((f) => f !== i);
    return { slots: slots.filter((_, j) => j !== i), from };
  });
}

/** What a slot's row shows beside its name: filler, rest, gear (any of them, joined), or "". */
export function slotFlag(s: SlotAst): string {
  return [s.filler ? "filler" : "", s.length === "slack" ? "rest" : "", s.gears?.length ? "gear" : ""].filter((x) => x !== "").join(" · ");
}
