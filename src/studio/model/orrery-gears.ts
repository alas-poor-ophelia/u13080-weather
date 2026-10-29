/**
 * The Orrery's gear inspector edits (docs/SESHAT-v0.md §18.3, §18.6 item 2;
 * handoff README "Gear"; bead wadjet-b6x, slice 5c). Pure: no DOM, no store.
 *
 * Two paths, as in slice 5b (model/orrery-slots.ts), one per part:
 *
 * - THROUGH THE FORM where the form reads the gear as fields: a year whose one
 *   leap rule is a sum of intervals that only the year reads (Gregorian) is
 *   `FormDraft.year.leap`, so its terms and the days it adds to the year are
 *   written there and compiled (`draftAst`), and a year-length edit pending in
 *   the same form part is never refused by a leap edit, or the other way round.
 * - THROUGH THE AST layer everywhere else: the gear's own slice (`gear:<id>`)
 *   for its terms, table and kind; `feeds:<unit>` for the days it adds to a
 *   cycle unit's length; `slots:<unit>` (via `editSlots`) for a slot it
 *   lengthens. A rename, an added gear and a removed one reach every slice
 *   that names the gear (ast-edit.ts `renameGear`, `addGear`, `removeGear`).
 *   An AST edit that would move the year or the months while the form holds
 *   an unsaved edit of them is refused (`applyAstEdit`, one source per part).
 *
 * A refusal comes back with its reason and the draft as it was. Whether the
 * terms still count every year 0 or 1 times (the sum over the lcm) is
 * `problems()`'s to say: the window runs it after the edit and lights the
 * gear's LED and the issue strip.
 */
import type { LeapTerm } from "../../plugin/time/form";
import type { CalendarAst, CycleUnitAst, GearAst, GearTerm, SlotAst, SlotsUnitAst } from "../../seshat";
import { addGear, removeGear, renameGear, setGearFeed, setGearIntervals, setGearKind, setGearPositions } from "./ast-edit";
import { applyAstEdit, draftAst, type CalendarDraft, type CalendarEdit } from "./definition";
import { editSlots } from "./orrery-slots";

export type Term = { readonly every: number; readonly offset?: number; readonly sign: 1 | -1 };

/** The `every` knob's travel (the handoff's log 1–500). */
export const EVERY = { min: 1, max: 500 } as const;
/** The `add` knob's travel (the handoff's −30…+30 d). */
export const FEED_DAYS = { min: -30, max: 30 } as const;
/** A new gear: every 4th year, from year 0 of its count, feeding nothing. */
export const NEW_GEAR_EVERY = 4;

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
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

function gearIn(ast: CalendarAst, id: string): GearAst | string {
  return ast.gears.find((g) => g.id === id) ?? `there is no gear "${id}"`;
}

const yearOf = (ast: CalendarAst): CycleUnitAst | undefined => ast.units.find((u): u is CycleUnitAst => u.kind === "cycle" && u.id === "year");

/**
 * Whether the form's year reads gear `id` as its leap rule (Gregorian): the
 * form holds the year as fields with a leap rule, and that rule is this gear.
 */
export function formReadsGear(calendar: CalendarDraft, ast: CalendarAst, id: string): boolean {
  if (!calendar.form?.year?.leap) return false;
  const terms = yearOf(ast)?.gears ?? [];
  return terms.length === 1 && terms[0]!.gear === id;
}

/** Why a list of interval terms cannot be written, or null (the checks `setGearIntervals` makes). */
function termsProblem(terms: readonly Term[]): string | null {
  if (terms.length === 0) return "a gear needs at least one term";
  for (const t of terms) {
    if (!isInt(t.every) || t.every < 1) return `a term repeats every ${t.every}; write a whole number of at least 1`;
    if (t.offset !== undefined && !isInt(t.offset)) return `a term's offset is ${String(t.offset)}; write a whole number`;
    if (t.sign !== 1 && t.sign !== -1) return "a term adds (+1) or takes away (−1)";
  }
  return null;
}

/** The form's year with its leap rule's terms (and the days it adds) replaced. */
function viaForm(calendar: CalendarDraft, base: CalendarDraft, terms: readonly Term[] | null, add?: number): CalendarEdit {
  const y = calendar.form!.year!;
  const leap = y.leap!;
  const written: LeapTerm[] = terms ? terms.map((t) => ({ every: t.every, at: mod((t.offset ?? 0) + y.firstYear, t.every), sign: t.sign })) : [...leap.terms];
  return withDraft({ ...calendar, form: { ...calendar.form, year: { ...y, leap: { add: add ?? leap.add, terms: written } } } }, base);
}

// ---- terms (intervals) and the table (positions)

/** Set an interval gear's terms: through the form's leap rule where it reads the gear, else the gear's slice. */
export function setTerms(calendar: CalendarDraft, base: CalendarDraft, id: string, terms: readonly Term[]): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const g = gearIn(ast, id);
  if (typeof g === "string") return refuse(g);
  if (g.kind !== "intervals") return refuse(`the gear "${id}" is a table of positions, not intervals`);
  const why = termsProblem(terms);
  if (why) return refuse(why);
  if (formReadsGear(calendar, ast, id)) return viaForm(calendar, base, terms);
  return applyAstEdit(calendar, base, (a) => setGearIntervals(a, id, terms));
}

/** Apply `op` to the draft's terms of gear `id`, then write them (`setTerms`). */
function editTerms(calendar: CalendarDraft, base: CalendarDraft, id: string, op: (terms: readonly Term[]) => readonly Term[] | string): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const g = gearIn(ast, id);
  if (typeof g === "string") return refuse(g);
  if (g.kind !== "intervals") return refuse(`the gear "${id}" is a table of positions, not intervals`);
  const next = op(g.terms);
  return typeof next === "string" ? refuse(next) : setTerms(calendar, base, id, next);
}

/** Term `i` with `patch` over it (`every`, `offset`, `sign`); an offset is kept within ±(every − 1). */
export function setTerm(calendar: CalendarDraft, base: CalendarDraft, id: string, i: number, patch: Partial<Term>): CalendarEdit {
  return editTerms(calendar, base, id, (terms) => {
    const t = terms[i];
    if (!t) return `the gear "${id}" has no term ${i + 1}`;
    const every = patch.every ?? t.every;
    let offset = patch.offset !== undefined ? patch.offset : t.offset;
    if (offset !== undefined && isInt(every) && every >= 1 && Math.abs(offset) >= every) offset = offset % every;
    const next: Term = { every, ...(offset ? { offset } : {}), sign: patch.sign ?? t.sign };
    return terms.map((x, j) => (j === i ? next : x));
  });
}

/**
 * Add a term after the last: it undoes the last one every 4 of its periods
 * (an EXRULE after an RRULE, as Gregorian's −100 follows its +4), so the sum
 * stays 0 or 1 as long as the last term did.
 */
export function addTerm(calendar: CalendarDraft, base: CalendarDraft, id: string): CalendarEdit {
  return editTerms(calendar, base, id, (terms) => {
    const last = terms[terms.length - 1];
    const term: Term = last ? { every: last.every * 4, ...(last.offset ? { offset: last.offset } : {}), sign: last.sign === 1 ? -1 : 1 } : { every: NEW_GEAR_EVERY, sign: 1 };
    return [...terms, term];
  });
}

/** Remove term `i` (a gear keeps at least one). */
export function removeTerm(calendar: CalendarDraft, base: CalendarDraft, id: string, i: number): CalendarEdit {
  return editTerms(calendar, base, id, (terms) => {
    if (!terms[i]) return `the gear "${id}" has no term ${i + 1}`;
    if (terms.length === 1) return "a gear needs at least one term; remove the gear instead";
    return terms.filter((_, j) => j !== i);
  });
}

/** Mark or unmark cycle position `cell` (0 to period − 1) of a table gear. */
export function togglePosition(calendar: CalendarDraft, base: CalendarDraft, id: string, cell: number): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const g = gearIn(ast, id);
  if (typeof g === "string") return refuse(g);
  if (g.kind !== "positions") return refuse(`the gear "${id}" is a sum of intervals, not a table of positions`);
  if (!isInt(cell) || cell < 0 || cell >= g.period) return refuse(`position ${cell} is outside 0 to ${g.period - 1}`);
  const positions = g.positions.includes(cell) ? g.positions.filter((p) => p !== cell) : [...g.positions, cell];
  return applyAstEdit(calendar, base, (a) => setGearPositions(a, id, { period: g.period, positions, ...(g.offset ? { offset: g.offset } : {}) }));
}

/** Switch gear `id` between intervals and a table of positions in a cycle (the same years match). */
export function setKind(calendar: CalendarDraft, base: CalendarDraft, id: string, kind: GearAst["kind"]): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => setGearKind(a, id, kind));
}

// ---- name, add, remove

/** Rename gear `id`; every term that names it follows (ast-edit.ts `renameGear`). */
export function renameGearIn(calendar: CalendarDraft, base: CalendarDraft, id: string, to: string): CalendarEdit {
  return applyAstEdit(calendar, base, (a) => renameGear(a, id, to));
}

/** A fresh id from `stem` (stem, stem-2, …) among every declared id. */
export function freshId(stem: string, ast: CalendarAst): string {
  const taken = new Set([...ast.units.map((u) => u.id), ...ast.gears.map((g) => g.id), ...(ast.rules ?? []).map((r) => r.id), ...(ast.bodies ?? []).map((b) => b.id)]);
  let id = stem;
  for (let i = 2; taken.has(id); i++) id = `${stem}-${i}`;
  return id;
}

/**
 * ＋ gear: every NEW_GEAR_EVERY of the year (or of the first cycle unit, on a
 * calendar without one), feeding nothing until a feed is added. `id` is the
 * new gear's, for the window to select.
 */
export function addGearPart(calendar: CalendarDraft, base: CalendarDraft): CalendarEdit & { readonly id?: string } {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const on = yearOf(ast)?.id ?? ast.units.find((u) => u.kind === "cycle")?.id;
  if (on === undefined) return refuse("this calendar has no cycle unit for a gear to count");
  const id = freshId("gear", ast);
  const r = applyAstEdit(calendar, base, (a) => addGear(a, { id, on, kind: "intervals", terms: [{ every: NEW_GEAR_EVERY, sign: 1 }] }));
  return "refused" in r ? r : { ...r, id };
}

/** Remove gear `id` and what it adds: through the form's leap rule where it reads the gear, else every slice that names it. */
export function removeGearPart(calendar: CalendarDraft, base: CalendarDraft, id: string): CalendarEdit {
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  if (formReadsGear(calendar, ast, id)) return withDraft({ ...calendar, form: { ...calendar.form, year: { ...calendar.form!.year!, leap: null } } }, base);
  return applyAstEdit(calendar, base, (a) => removeGear(a, id));
}

// ---- feeds: the lengths a gear adds to when it engages

/** A length a gear adds to: a cycle unit's, or slot `slot` of slot unit `unit`. */
export interface FeedTarget {
  readonly unit: string;
  readonly slot?: number;
}
export interface Feed {
  readonly target: FeedTarget;
  readonly label: string;
  readonly add: number;
}

const slotLabel = (u: SlotsUnitAst, i: number): string => u.slots[i]?.name ?? `${u.id} ${i + (u.number ?? 1)}`;

/** The cycle unit at the top of slot unit `u`'s parents, or undefined (a loop, a missing parent). */
function rootOf(ast: CalendarAst, u: SlotsUnitAst): string | undefined {
  let at: string = u.in;
  for (let n = 0; n <= ast.units.length; n++) {
    const p = ast.units.find((x) => x.id === at);
    if (!p) return undefined;
    if (p.kind === "cycle") return p.id;
    at = p.in;
  }
  return undefined;
}

/** What gear `id` adds to: each cycle unit's length and each slot that carries a term naming it, in unit order. */
export function feedsOf(ast: CalendarAst, id: string): Feed[] {
  const out: Feed[] = [];
  for (const u of ast.units) {
    if (u.kind === "cycle") {
      for (const t of u.gears ?? []) if (t.gear === id) out.push({ target: { unit: u.id }, label: `${u.id} length`, add: t.add });
    } else
      u.slots.forEach((s, i) => {
        for (const t of s.gears ?? []) if (t.gear === id) out.push({ target: { unit: u.id, slot: i }, label: slotLabel(u, i), add: t.add });
      });
  }
  return out;
}

/**
 * The ＋ feed… menu: the counted unit's length and every slot under it that
 * the gear does not feed yet; a slot that takes the rest, or whose length
 * follows its parent's row by row, comes with why it cannot carry a gear.
 */
export function feedTargets(ast: CalendarAst, id: string): Array<{ target: FeedTarget; label: string; why: string | null }> {
  const g = ast.gears.find((x) => x.id === id);
  if (!g) return [];
  const fed = feedsOf(ast, id).map((f) => `${f.target.unit}:${f.target.slot ?? ""}`);
  const out: Array<{ target: FeedTarget; label: string; why: string | null }> = [];
  if (!fed.includes(`${g.on}:`) && ast.units.some((u) => u.kind === "cycle" && u.id === g.on)) out.push({ target: { unit: g.on }, label: `${g.on} length`, why: null });
  for (const u of ast.units) {
    if (u.kind !== "slots" || rootOf(ast, u) !== g.on) continue;
    u.slots.forEach((s, i) => {
      if (fed.includes(`${u.id}:${i}`)) return;
      out.push({ target: { unit: u.id, slot: i }, label: `${u.id} · ${slotLabel(u, i)}`, why: slotGearProblem(s) });
    });
  }
  return out;
}

/** Why a slot cannot carry a gear term, or null (the validator's rule: only a slot of a fixed number of days). */
function slotGearProblem(s: SlotAst): string | null {
  if (s.length === "slack") return "takes the rest, so it cannot carry a gear";
  if (typeof s.length === "object") return "follows its year's length row by row, so it cannot carry a gear";
  return null;
}

/** `terms` with gear `id`'s term set to `add` (added at the end when there is none), or without it (null). */
function setTermIn(terms: readonly GearTerm[] | undefined, id: string, add: number | null): GearTerm[] {
  const was = terms ?? [];
  if (add === null) return was.filter((t) => t.gear !== id);
  const at = was.findIndex((t) => t.gear === id);
  return at < 0 ? [...was, { gear: id, add }] : was.map((t, i) => (i === at ? { ...t, add } : t));
}

/**
 * Gear `id` adds `add` days to `target` when it engages (a new feed, or a new
 * `add`), or (null) no longer feeds it. The year's leap days go through the
 * form where it reads the gear; removing that feed, or feeding anything else,
 * is an AST edit (the gear then stops being the form's simple leap rule).
 */
export function setFeed(calendar: CalendarDraft, base: CalendarDraft, id: string, target: FeedTarget, add: number | null): CalendarEdit {
  if (add !== null && !isInt(add)) return refuse(`a gear adds ${String(add)} days; write a whole number`);
  const ast = current(calendar, base);
  if (typeof ast === "string") return refuse(ast);
  const g = gearIn(ast, id);
  if (typeof g === "string") return refuse(g);
  if (target.slot === undefined) {
    if (add !== null && target.unit === "year" && formReadsGear(calendar, ast, id)) {
      if (calendar.form!.year!.leap!.add === add) return withDraft(calendar, base);
      return viaForm(calendar, base, null, add);
    }
    return applyAstEdit(calendar, base, (a) => setGearFeed(a, id, target.unit, add));
  }
  const i = target.slot;
  return editSlots(calendar, base, target.unit, (slots, unit) => {
    const s = slots[i];
    if (!s) return `the ${unit.id} has no slot ${i + (unit.number ?? 1)}`;
    if (add !== null) {
      if (rootOf(ast, unit) !== g.on) return `the gear "${id}" counts the ${g.on}, and the ${unit.id} is not inside it`;
      const why = slotGearProblem(s);
      if (why) return `${slotLabel(unit, i)} ${why}`;
    }
    const terms = setTermIn(s.gears, id, add);
    const { gears: _g, ...rest } = s;
    const next: SlotAst = terms.length ? { ...rest, gears: terms } : rest;
    return { slots: slots.map((x, j) => (j === i ? next : x)), from: slots.map((_, j) => j) };
  });
}

// ---- readouts

/** Whether interval term `t` holds at index `n` (its pin at the pointer). */
export function termEngaged(t: Term, n: number): boolean {
  return mod(n - (t.offset ?? 0), t.every) === 0;
}

/** The cycle cell index `n` falls in, for a table gear. */
export function cellOf(g: GearAst & { kind: "positions" }, n: number): number {
  return mod(n - (g.offset ?? 0), g.period);
}

/** The offset knob's travel for a term repeating every `every`: ±(every − 1). */
export function offsetRange(every: number): { min: number; max: number } {
  const r = Math.max(1, Math.round(every) - 1);
  return { min: -r, max: r };
}
