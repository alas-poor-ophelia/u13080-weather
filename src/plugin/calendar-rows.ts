/**
 * The settings Calendar group's Days in a year, Moons and Seasons rows on a
 * world that runs a calendar definition (docs/SESHAT-v0.md §15.2, §15.1 R2).
 * Pure: no Obsidian imports. Each row reads its part of the stored definition
 * through the form model; an edit goes through the Studio's merge
 * (studio/model/definition.ts mergeCalendar), so it writes only that part and
 * every other part of the stored definition passes through untouched. The
 * settings tab then asks the Save dialog before storing the text.
 */
import { YEAR_LENGTH_MAX } from "../core/modifiers";
import { parse, type CalendarAst } from "../seshat";
import { calendarOfDefinition, mergeCalendar, type CalendarDraft } from "../studio/model/definition";
import type { MoonRenames } from "../studio/model/moon-rename";
import { badMoonsLine, badSeasonsLine, moonRowRenames, parseMoonsText, parseSeasonsText, serialiseMoonsText, serialiseSeasonsText } from "./calendar-text";
import { recognise, type YearForm } from "./time/form";

export type DefinitionRowKey = "year" | "moons" | "seasons";

/** A row with a control (`value` is what it shows) or a read-only row that says why. */
export type DefinitionRow<V> = { readonly kind: "edit"; readonly value: V; readonly desc: string } | { readonly kind: "read"; readonly desc: string };

export interface DefinitionRows {
  readonly year: DefinitionRow<number>;
  readonly moons: DefinitionRow<string>;
  readonly seasons: DefinitionRow<string>;
}

export const YEAR_EDIT_DESC = "Changing it moves the seasons. Saving shows which days' weather changes.";
export const MOONS_DESC = "One per line: name, cycle in days, phase at day 0 (0–1), then optionally named phases as name@fraction (e.g. Full@0.5), ascending and unique. Only modifiers that mention a moon use them.";
export const SEASONS_DESC = "One per line: name, start (0–1 through the year). Each becomes a season tag that modifiers can match.";

const n = (x: number) => x.toLocaleString("en");

/** The read-only words for a year with a leap rule: its common and leap lengths. */
function leapYearDesc(y: YearForm & { leap: NonNullable<YearForm["leap"]> }): string {
  return `${n(y.length)} or ${n(y.length + y.leap.add)} days (a leap rule). Edit it in the Studio's calendar window or with Edit definition.`;
}

/** What the three rows show for a definition. */
export function definitionRows(ast: CalendarAst): DefinitionRows {
  const f = recognise(ast);
  const draft = calendarOfDefinition(ast);
  let year: DefinitionRow<number>;
  if (f.year.kind === "text") year = { kind: "read", desc: `Not a number of days this row can edit: ${f.year.why}. Edit it with Edit definition.` };
  else if (f.year.value.leap) year = { kind: "read", desc: leapYearDesc(f.year.value as YearForm & { leap: NonNullable<YearForm["leap"]> }) };
  else year = { kind: "edit", value: f.year.value.length, desc: YEAR_EDIT_DESC };
  const moons: DefinitionRow<string> = f.moons.kind === "form" ? { kind: "edit", value: serialiseMoonsText(draft.moons), desc: MOONS_DESC } : { kind: "read", desc: `Kept as the definition writes them: ${f.moons.why}. Edit them with Edit definition.` };
  const seasons: DefinitionRow<string> = f.seasons.kind === "form" ? { kind: "edit", value: serialiseSeasonsText(draft.seasons), desc: SEASONS_DESC } : { kind: "read", desc: `Kept as the definition writes them: ${f.seasons.why}. Edit them with Edit definition.` };
  return { year, moons, seasons };
}

/** Validation for the Days in a year number: the legacy row's bounds. */
export function badYearLength(v: number): string | undefined {
  return Number.isInteger(v) && v >= 1 && v <= YEAR_LENGTH_MAX ? undefined : `Between 1 and ${YEAR_LENGTH_MAX.toLocaleString("en")} days.`;
}

/** `renames`: the moons the edit renamed (old name → new name), whose references the save renames with it (bead wadjet-zoy). */
export type DefinitionRowEdit = { readonly text: string; readonly renames: MoonRenames } | { readonly error: string } | { readonly unchanged: true };

/**
 * The definition text one row's edit makes, merged into the stored text.
 * Moons read from the text carry no body ids. A line that renames its moon by
 * the legacy row's rule (moonRowRenames: the row keeps its count and order and
 * the line differs from the stored moon in its name alone) keeps that body's
 * id, so a unit following it and a rule naming its phases keep working, and
 * the edit reports the rename so the save renames the moon's references with
 * it (bead wadjet-zoy). Every other line takes the id of the stored moon with
 * the same name, so an unchanged moon keeps its body and exact rational (and
 * the calendar its hash); a line matching neither is a new body (bodyFor's
 * rational, a fresh id) and a stored moon no line keeps goes.
 * An empty Seasons text removes the seasons field.
 * @param stored the stored definition text (it runs)
 * @param row the row edited
 * @param value the row's new value: a number of days, or the textarea's text
 */
export function definitionRowEdit(stored: string, row: DefinitionRowKey, value: number | string): DefinitionRowEdit {
  let ast: CalendarAst;
  try {
    ast = parse(stored);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const base = calendarOfDefinition(ast);
  let draft: CalendarDraft;
  let renames: MoonRenames = new Map();
  if (row === "year") {
    const len = Number(value);
    const bad = badYearLength(len);
    if (bad) return { error: bad };
    const y = recognise(ast).year;
    if (y.kind === "text") return { error: `The year cannot be edited here: ${y.why}.` };
    if (y.value.leap) return { error: "The year has a leap rule; edit it in the Studio's calendar window or with Edit definition." };
    draft = { ...base, form: { ...base.form, year: { ...y.value, length: len } } };
  } else if (row === "moons") {
    const text = String(value);
    const bad = badMoonsLine(text);
    if (bad) return { error: bad };
    const parsed = parseMoonsText(text);
    renames = moonRowRenames(base.moons, parsed);
    const renamedAt = (i: number) => renames.get(base.moons[i]?.name ?? "") === parsed[i]!.name;
    // a renamed body's id is its own line's; no other line may take it by name
    const taken = new Set(parsed.flatMap((_, i) => (renamedAt(i) ? [base.moons[i]!.id] : [])));
    const moons = parsed.map((m, i) => {
      const id = renamedAt(i) ? base.moons[i]!.id : base.moons.find((b) => b.name === m.name && !taken.has(b.id))?.id;
      return id === undefined ? m : { id, ...m };
    });
    draft = { ...base, moons };
  } else {
    const text = String(value);
    const bad = badSeasonsLine(text);
    if (bad) return { error: bad };
    draft = { ...base, seasons: parseSeasonsText(text) };
  }
  const m = mergeCalendar(stored, base, draft);
  switch (m.kind) {
    case "unchanged":
      return { unchanged: true };
    case "error":
      // a refused edit (a FormError) is already a sentence that says what to do; anything else is the checker's words
      return { error: /[.!?]$/.test(m.message) ? m.message : `Not a calendar that runs: ${m.message}.` };
    case "stale":
      return { error: "The calendar definition changed while you edited it. Close and reopen settings to see it." };
    case "write":
      return m.text === stored ? { unchanged: true } : { text: m.text, renames };
  }
}
