/**
 * The Studio on a world that runs a stored Seshat definition (docs/SESHAT-v0.md
 * §13.8, §13.11 B3, M4, §15.3). Pure: no Obsidian imports.
 *
 * The draft keeps `{ seasons, moons }` as every window reads them, plus the
 * form model's other fields (`form`: name, year, months, week, where they are
 * fields on the stored definition). It is seeded from the definition, and
 * Save compiles it into a fresh parse of the stored text through the form
 * model (one merge: plugin/time/form.ts `compile`):
 *
 * - only the parts the draft edited are written; every other part of the
 *   stored definition passes through as it is now;
 * - a moon is its body: matched by the body id the draft carries, so a
 *   rename keeps the body and its id, and the draft's order is the order
 *   written (wadjet-dea); a draft without ids (a stash from before) matches
 *   by name;
 * - a moon keeps its body's exact period unless its `cycleDays` changed, and
 *   its exact epoch unless its `phaseAtEpoch` changed (compared as numbers), so
 *   a seasons-only or phases-only edit leaves the bodies, and the hash, alone;
 * - stale per part (§15.9 S5): Save is refused only when a part the draft
 *   edited is no longer what the draft was seeded from (an edit in settings to
 *   the same part); edits to other parts outside the studio pass through;
 * - a draft whose calendar was not edited writes nothing, so saving a zone
 *   never re-prints the definition;
 * - `rewrites` says the stored text was not canonical (a hand edit with
 *   comments), so the Studio asks before the save removes them;
 * - on a Seshat world the draft also carries its AST layer (`ast`, §18.6):
 *   the slices only the AST reaches (ast-edit.ts) are replayed onto the stored
 *   definition with the same per-part stale check, then the field parts are
 *   compiled as above (see "the AST layer" below).
 */
import { canonicalJson } from "../../core/profile";
import { Body, bodyFor, Engine, parse, print, rational, seasonsUseDates, toNumber, type BodyAst, type CalendarAst, type Rational, type SeasonMark } from "../../seshat";
import { prepareDefinition } from "../../plugin/time/seshat";
import { compile, FormError, recognise, type FormEdits, type MoonForm } from "../../plugin/time/form";
import { editedSlices, outsideSlices, replayProblem, sliceOf, slotReferences, withSlice, type AstEdit } from "./ast-edit";
import { moveBody } from "./rational-knob";
import type { CalendarSource, DraftMoon, FormDraft, WorldDraft } from "./state";

export type CalendarDraft = WorldDraft["calendar"];

const FORM_PARTS = ["name", "year", "months", "week", "ledger"] as const;

/** The draft calendar a definition opens as: its season marks as stored, its moons in declaration order with their body ids, and the parts the form reads as fields. */
export function calendarOfDefinition(ast: CalendarAst): CalendarDraft {
  const f = recognise(ast);
  const form: FormDraft = {};
  for (const k of FORM_PARTS) {
    const p = f[k];
    if (p.kind === "form") (form as Record<string, unknown>)[k] = p.value;
  }
  return {
    seasons: draftSeasons(ast),
    moons: (ast.bodies ?? []).flatMap((b) =>
      b.moon ? [{ id: b.id, name: b.moon.name, cycleDays: toNumber(b.period), phaseAtEpoch: toNumber(b.epoch), ...(b.moon.phases ? { phases: b.moon.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) }] : [],
    ),
    form,
  };
}

/**
 * The draft calendar a Seshat world opens as: `calendarOfDefinition`'s fields,
 * and the definition itself as the draft's AST layer (`ast`, §18.6 item 3).
 */
export function seshatDraft(ast: CalendarAst): CalendarDraft {
  return { ...calendarOfDefinition(ast), ast: structuredClone(ast) };
}

/**
 * The seasons as the Studio draft holds them: fractions as stored; with any
 * date mark, every mark projected into the year holding day 0 (§16.7 P6).
 * The ribbon draws those read-only and a Save never writes them back: the
 * form reads such seasons as text, so the stored date marks stay.
 */
function draftSeasons(ast: CalendarAst): Array<{ name: string; from: number }> {
  if (!ast.seasons) return [];
  if (!seasonsUseDates(ast.seasons)) return (ast.seasons.marks as readonly SeasonMark[]).map((m) => ({ name: m.name, from: m.from }));
  try {
    return new Engine(ast).seasonProjection();
  } catch {
    return []; // a definition that cannot run has nothing to draw
  }
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Whether a period and epoch make a body with safe-integer phases. */
function runs(p: { period: BodyAst["period"]; epoch: BodyAst["epoch"] }): boolean {
  try {
    new Body(p.period, p.epoch);
    return true;
  } catch {
    return false;
  }
}

export type MergeResult =
  | { kind: "unchanged" }
  /** `reason`: why, when it is more than "the part this draft edited changed in storage" */
  | { kind: "stale"; stored: CalendarDraft; reason?: string }
  | { kind: "error"; message: string }
  | { kind: "write"; text: string; rewrites: boolean };

type Part = "seasons" | "moons" | (typeof FORM_PARTS)[number];

/** The parts the draft edited: seasons and moons when they differ from the base; a form part only when the draft holds a value for it that differs. */
function editedParts(base: CalendarDraft, draft: CalendarDraft): Part[] {
  const out: Part[] = [];
  if (!same(draft.seasons, base.seasons)) out.push("seasons");
  if (!same(draft.moons, base.moons)) out.push("moons");
  for (const k of FORM_PARTS) if (draft.form?.[k] !== undefined && !same(draft.form[k], base.form?.[k])) out.push(k);
  return out;
}

const partOf = (c: CalendarDraft, k: Part): unknown => (k === "seasons" || k === "moons" ? c[k] : c.form?.[k]);

/** Whether part `k` of the stored calendar is still what the draft was seeded from. A base without moon ids (a stash from an older build) compares moons without them. */
function unchanged(now: CalendarDraft, base: CalendarDraft, k: Part): boolean {
  if (k === "moons" && base.moons.some((m) => m.id === undefined)) return same(now.moons.map(({ id: _id, ...m }) => m), base.moons.map(({ id: _id, ...m }) => m));
  return same(partOf(now, k), partOf(base, k));
}

/**
 * The draft's moons as form moons over the stored bodies: each keeps its body
 * (matched by id, else by name) and that body's exact numbers unless the draft
 * changed them; a moon without a body gets a fresh `moon-N` id.
 */
function moonsOf(ast: CalendarAst, base: readonly DraftMoon[], draft: readonly DraftMoon[]): MoonForm[] | string {
  // predicates match moons by name: two with one name would be one moon to every rule
  const seen = new Set<string>();
  for (const m of draft) {
    if (seen.has(m.name)) return `moon "${m.name}" is declared more than once`;
    seen.add(m.name);
  }
  const bodies = (ast.bodies ?? []).filter((b) => b.moon);
  // two passes, so a moon without an id can never take the body another moon names by id: first every
  // id claims its own body; then a moon without one (a stash from an older build) takes, by name, an
  // unclaimed body whose moon the base had under that name (a name the base lacks is a new moon)
  const owner = new Map<DraftMoon, BodyAst>();
  const claimed = new Set<string>();
  for (const d of draft) {
    if (d.id === undefined || claimed.has(d.id)) continue;
    const b = bodies.find((x) => x.id === d.id);
    if (!b) continue;
    owner.set(d, b);
    claimed.add(b.id);
  }
  for (const d of draft) {
    if (d.id !== undefined || !base.some((m) => m.id === undefined && m.name === d.name)) continue;
    const b = bodies.find((x) => x.moon!.name === d.name && !claimed.has(x.id));
    if (!b) continue;
    owner.set(d, b);
    claimed.add(b.id);
  }
  const baseOf = (d: DraftMoon): DraftMoon | undefined => (d.id !== undefined ? base.find((x) => x.id === d.id) : base.find((x) => x.name === d.name));
  const bodyIds = new Set((ast.bodies ?? []).map((b) => b.id));
  // ids in use: every body's, every id the draft names (so a fresh moon-N never takes one), and those given out
  const taken = new Set([...bodyIds, ...draft.flatMap((d) => (d.id === undefined ? [] : [d.id]))]);
  const given = new Set<string>();
  const out: MoonForm[] = [];
  for (const d of draft) {
    const phases = d.phases ? { phases: d.phases.map((p) => ({ name: p.name, at: p.at })) } : {};
    const b = owner.get(d);
    const was = b ? baseOf(d) : undefined;
    const keepPeriod = was !== undefined && was.cycleDays === d.cycleDays;
    const keepEpoch = was !== undefined && was.phaseAtEpoch === d.phaseAtEpoch;
    // an exact editor's rationals (§18.3 D2), each while its number is still the draft's
    const exactPeriod = d.exact?.period && toNumber(d.exact.period) === d.cycleDays ? d.exact.period : undefined;
    const exactEpoch = d.exact?.epoch && toNumber(d.exact.epoch) === d.phaseAtEpoch ? d.exact.epoch : undefined;
    const inexact = `moon "${d.name}": its exact period and epoch cannot run together`;
    if (b && (exactPeriod || keepPeriod) && (exactEpoch || keepEpoch)) {
      const pair = { period: exactPeriod ?? b.period, epoch: exactEpoch ?? b.epoch };
      if (exactPeriod || exactEpoch) {
        if (!runs(pair)) return inexact; // an exact half is never traded for a float-derived pair
      }
      out.push({ id: b.id, name: d.name, ...pair, ...phases });
      continue;
    }
    const r = bodyFor(d.cycleDays, d.phaseAtEpoch);
    if (!r) return `moon "${d.name}": a cycle of ${d.cycleDays} days cannot run`;
    // a body keeps its id; a draft id with no body (and not another body's) is kept as written; otherwise a fresh moon-N
    let id = b?.id ?? (d.id !== undefined && !bodyIds.has(d.id) && !given.has(d.id) ? d.id : undefined);
    if (id === undefined) {
      let n = 1;
      while (taken.has(`moon-${n}`)) n++;
      id = `moon-${n}`;
      taken.add(id);
    }
    given.add(id);
    // a kept rational beside a fresh one can be too fine for safe-integer phases; bodyFor's own pair always runs
    const mixed = { period: exactPeriod ?? (b && keepPeriod ? b.period : r.period), epoch: exactEpoch ?? (b && keepEpoch ? b.epoch : r.epoch) };
    if ((exactPeriod || exactEpoch) && !runs(mixed)) return inexact;
    const exact = runs(mixed) ? mixed : { period: r.period, epoch: r.epoch };
    out.push({ id, name: d.name, period: exact.period, epoch: exact.epoch, ...phases });
  }
  return out;
}

/** mergeCalendar's refusal of a seasons edit on date marks (planCalendarSave says it plainly). */
const DATED_SEASONS = "the seasons use dates; edit them as text";

type Edits = { -readonly [K in keyof FormEdits]: FormEdits[K] };

/** The form edits for `parts` of the draft, over `ast` (the definition they compile into), or why they cannot be made. */
function formEdits(ast: CalendarAst, base: CalendarDraft, draft: CalendarDraft, parts: readonly Part[]): Edits | string {
  const edits: Edits = {};
  for (const k of parts) {
    if (k === "seasons" && ast.seasons && seasonsUseDates(ast.seasons)) return DATED_SEASONS;
    if (k === "seasons") edits.seasons = draft.seasons.map((s) => ({ name: s.name, from: s.from }));
    else if (k === "moons") {
      const m = moonsOf(ast, base.moons, draft.moons);
      if (typeof m === "string") return m;
      edits.moons = m;
    } else (edits as Record<string, unknown>)[k] = draft.form![k];
  }
  return edits;
}

/** `compile`, with a refusal as its message. */
function compiled(ast: CalendarAst, edits: Edits): { ast: CalendarAst } | { error: string } {
  try {
    return { ast: compile(ast, edits) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- the AST layer (§18.6 items 1-4)
//
// On a Seshat world the draft is two layers over the definition it was seeded
// from (`base.ast`, which lives in `StudioState.calendarBase`, outside undo):
//  - `draft.ast`, the definition with the edits only the AST reaches (gears,
//    stages, crossings, dated season marks: ast-edit.ts slices);
//  - the fields (`seasons`, `moons`, `form`), the editing surface of every part
//    the form model reads, as every window edits them today.
// A field part is PENDING when it differs both from the base and from the AST
// layer's own reading of it (after an AST edit the fields it moved are re-read
// from the layer, so they are not edits of their own). `draftAst` compiles the
// pending parts over the layer: the one draft AST. A Save replays the edited
// slices and then compiles the pending parts onto the definition stored at
// Save time, each refused when it changed in storage since the seed.

/** Each AST layer's own reading, memoised by the layer object (an edit replaces the layer, never mutates it). */
const views = new WeakMap<CalendarAst, CalendarDraft>();
function viewOf(ast: CalendarAst): CalendarDraft {
  let v = views.get(ast);
  if (!v) views.set(ast, (v = calendarOfDefinition(ast)));
  return v;
}

/** The field parts the draft edited that are its own edits, not the AST layer's reading. */
function pendingParts(base: CalendarDraft, draft: CalendarDraft, layer: CalendarDraft): Part[] {
  return editedParts(base, draft).filter((k) => !same(partOf(draft, k), partOf(layer, k)));
}

type Layered = CalendarDraft & { ast: CalendarAst };

/** The form's months: the one slot unit directly in the year (form.ts `monthUnit`), or undefined. */
function monthsUnit(ast: CalendarAst): string | undefined {
  const ms = ast.units.filter((u) => u.kind === "slots" && u.in === "year");
  return ms.length === 1 ? ms[0]!.id : undefined;
}

function mergeLayers(stored: string, ast: CalendarAst, base: Layered, draft: Layered): MergeResult {
  const now = calendarOfDefinition(ast);
  // a part that moved in storage is stale, unless the draft holds what storage holds now (then there is nothing to write)
  const parts: Part[] = [];
  for (const k of pendingParts(base, draft, viewOf(draft.ast))) {
    if (unchanged(now, base, k)) parts.push(k);
    else if (!same(partOf(draft, k), partOf(now, k))) return { kind: "stale", stored: seshatDraft(ast) };
  }
  const slices = editedSlices(base.ast, draft.ast).filter((k) => !same(sliceOf(draft.ast, k), sliceOf(ast, k)));
  if (slices.some((k) => !same(sliceOf(ast, k), sliceOf(base.ast, k)))) return { kind: "stale", stored: seshatDraft(ast) };
  let out = ast;
  for (const k of slices) {
    const next = withSlice(out, k, sliceOf(draft.ast, k));
    if (!next) return { kind: "error", message: `the ${k} cannot be written into the stored definition` };
    out = next;
  }
  // each slice's edits were checked against parts of the draft they read but do not write: when storage moved one, the
  // replay would bind differently (a slot by number, a mark by index), so the Save is stale, never silently wrong
  for (const k of slices) {
    const why = replayProblem(k, base.ast, draft.ast, ast, out);
    if (why) return { kind: "stale", stored: seshatDraft(ast), reason: why };
  }
  // the form's months write over the stored months: the rules and exceptions that read them by number or name must be
  // as the edit saw them (their marks the compile itself moves by name)
  if (parts.includes("months")) {
    const m = monthsUnit(ast) ?? monthsUnit(base.ast);
    if (m !== undefined && !same(slotReferences(ast, m, false), slotReferences(base.ast, m, false))) {
      return { kind: "stale", stored: seshatDraft(ast), reason: `a rule or an exception that reads the ${m} changed outside the studio since this edit` };
    }
  }
  const edits = formEdits(out, base, draft, parts);
  if (typeof edits === "string") return { kind: "error", message: edits };
  const c = compiled(out, edits);
  if ("error" in c) return { kind: "error", message: c.error };
  const prepared = prepareDefinition(print(c.ast));
  if ("error" in prepared) return { kind: "error", message: prepared.line === undefined ? prepared.error : `line ${prepared.line}: ${prepared.error}` };
  return { kind: "write", text: prepared.text, rewrites: stored !== print(ast) };
}

/**
 * Merge the draft's calendar into the stored definition. A draft and base that
 * both carry the AST layer (a Seshat world, §18.6) replay their edited slices
 * and pending field parts; any other merges its field parts as before.
 * @param stored the stored definition text
 * @param base the calendar the draft was seeded from (or last saved as)
 * @param draft the draft calendar
 */
export function mergeCalendar(stored: string, base: CalendarDraft, draft: CalendarDraft): MergeResult {
  if (same(draft, base)) return { kind: "unchanged" };
  let ast: CalendarAst;
  try {
    ast = parse(stored);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  if (draft.ast && base.ast) return mergeLayers(stored, ast, base as Layered, draft as Layered);
  // one side without the layer (a stash or state from another build): its AST edits cannot be judged, so never dropped as "nothing to save"
  if (draft.ast || base.ast) return { kind: "stale", stored: seshatDraft(ast) };
  const now = calendarOfDefinition(ast);
  const parts = editedParts(base, draft);
  if (parts.some((k) => !unchanged(now, base, k))) return { kind: "stale", stored: now };

  const edits = formEdits(ast, base, draft, parts);
  if (typeof edits === "string") return { kind: "error", message: edits };
  let next: CalendarAst;
  let text: string;
  try {
    next = compile(ast, edits);
    text = print(next);
  } catch (e) {
    if (e instanceof FormError || e instanceof Error) return { kind: "error", message: e.message };
    return { kind: "error", message: String(e) };
  }
  const prepared = prepareDefinition(text);
  if ("error" in prepared) return { kind: "error", message: prepared.line === undefined ? prepared.error : `line ${prepared.line}: ${prepared.error}` };
  return { kind: "write", text: prepared.text, rewrites: stored !== print(ast) };
}

/**
 * The draft as one definition AST: the pending field parts compiled over the
 * AST layer (so through every guard in `compile`), or why they do not compile
 * (the message a Save would refuse with). `calendar.ast` itself when no field
 * part is pending. Pure; `problems()` is the caller's (§18.6 item 7).
 * @param calendar the world draft's calendar (with its `ast` layer)
 * @param base the calendar it was seeded from (`StudioState.calendarBase`)
 */
export function draftAst(calendar: CalendarDraft, base: CalendarDraft): { ast: CalendarAst } | { error: string } {
  if (!calendar.ast) return { error: "this calendar is not a definition the Studio edits" };
  const parts = pendingParts(base, calendar, viewOf(calendar.ast));
  if (parts.length === 0) return { ast: calendar.ast };
  const edits = formEdits(calendar.ast, base, calendar, parts);
  return typeof edits === "string" ? { error: edits } : compiled(calendar.ast, edits);
}

/** A draft calendar after an edit, with its one draft AST (for `problems()`), or a refusal with its reason; a refusal leaves the draft as it was. */
export type CalendarEdit = { readonly calendar: CalendarDraft; readonly ast: CalendarAst } | { readonly refused: true; readonly reason: string };

const FIELD_PARTS: readonly Part[] = ["seasons", "moons", ...FORM_PARTS];
const PART_WORDS: Record<Part, string> = { seasons: "seasons", moons: "moons", name: "name", year: "year", months: "months", week: "week", ledger: "exceptions" };

/** `calendar` with field part `k` set to `v` (undefined: the part is not a field, so it is never an edit). */
function setPart(calendar: CalendarDraft, k: Part, v: unknown): CalendarDraft {
  if (k === "seasons" || k === "moons") return { ...calendar, [k]: structuredClone(v) };
  const form: Record<string, unknown> = { ...calendar.form };
  if (v === undefined) delete form[k];
  else form[k] = structuredClone(v);
  return { ...calendar, form };
}

/**
 * Apply an AST edit (ast-edit.ts) to the draft's AST layer. The field parts it
 * moves (a gear edit moves the year's leap years; a mark edit the season
 * ribbon) are re-read from the new layer, so every window shows the edit. An
 * edit that moves a part the fields hold an unsaved edit of is refused (one
 * source per part: either would otherwise drop the other silently), and so is
 * one that changes the definition outside its slice (a Save replays slices
 * only). Undo: the caller writes the result in one `store.update`
 * (`history: true` for a click; a drag updates without history and calls
 * `snapshot()` when it ends, so it is one step).
 */
export function applyAstEdit(calendar: CalendarDraft, base: CalendarDraft, edit: (ast: CalendarAst) => AstEdit): CalendarEdit {
  const layer = calendar.ast;
  if (!layer) return { refused: true, reason: "this calendar is not a definition the Studio edits" };
  const r = edit(layer);
  if ("refused" in r) return r;
  if (r.ast === layer || same(r.ast, layer)) {
    const d = draftAst(calendar, base);
    return "error" in d ? { refused: true, reason: d.error } : { calendar, ast: d.ast };
  }
  if (!same(outsideSlices(r.ast), outsideSlices(layer))) return { refused: true, reason: "this edit reaches past the part it edits" };
  const before = viewOf(layer);
  const after = viewOf(r.ast);
  let next: CalendarDraft = { ...calendar, ast: r.ast };
  for (const k of FIELD_PARTS) {
    if (same(partOf(before, k), partOf(after, k))) continue;
    const mine = partOf(calendar, k);
    if (mine !== undefined && !same(mine, partOf(base, k)) && !same(mine, partOf(before, k))) {
      return { refused: true, reason: `the ${PART_WORDS[k]} have an unsaved edit this change would also move; save or undo that edit first` };
    }
    next = setPart(next, k, partOf(after, k));
  }
  const d = draftAst(next, base);
  if ("error" in d) return { refused: true, reason: d.error };
  return { calendar: next, ast: d.ast };
}

/**
 * Seat a draft on a newer definition `ast` (a stash from before the AST layer,
 * §18.6 item 4): both take `ast` as their layer, and every field part the
 * draft did not edit (equal to the base's) is re-read from it in both, so the
 * fields and the layer show one calendar. An edited part keeps the draft's
 * value and the base it was edited against, so a Save still judges it.
 */
export function seatOn(draft: CalendarDraft, base: CalendarDraft, ast: CalendarAst): { draft: CalendarDraft; base: CalendarDraft } {
  const view = viewOf(ast);
  let d: CalendarDraft = { ...draft, ast: structuredClone(ast) };
  let b: CalendarDraft = { ...base, ast: structuredClone(ast) };
  for (const k of FIELD_PARTS) {
    if (!same(partOf(draft, k), partOf(base, k))) continue;
    d = setPart(d, k, partOf(view, k));
    b = setPart(b, k, partOf(view, k));
  }
  return { draft: d, base: b };
}

const sameRational = (a: Rational, b: Rational): boolean => a.n === b.n && a.d === b.d;

/**
 * Move a moon's period, epoch or both to exact rationals (§18.3 D2): what is
 * not moved stays exactly as the draft holds it (moveBody), the Body limit is
 * checked first, and the move is a moons edit like any other, so `compile`'s
 * guards apply (an epoch move keeps the numbering of the units following the
 * moon). A pair equal to the stored body's writes the stored moon back, so a
 * move and its return leave the draft clean.
 */
export function moveMoon(calendar: CalendarDraft, base: CalendarDraft, id: string, to: { period?: Rational; epoch?: Rational }): CalendarEdit {
  const d = draftAst(calendar, base);
  if ("error" in d) return { refused: true, reason: d.error };
  const body = (d.ast.bodies ?? []).find((b) => b.id === id && b.moon);
  const at = calendar.moons.findIndex((m) => m.id === id);
  if (!body || at < 0) return { refused: true, reason: `there is no moon "${id}"` };
  // kept reduced, so equal values compare equal in the dirty check and the undo hash (§18.6 item 4)
  let moved: { period?: Rational; epoch?: Rational };
  try {
    moved = { ...(to.period ? { period: rational(to.period.n, to.period.d) } : {}), ...(to.epoch ? { epoch: rational(to.epoch.n, to.epoch.d) } : {}) };
  } catch {
    return { refused: true, reason: "a period and an epoch are fractions of whole numbers" };
  }
  const w = moveBody(body, moved);
  if (w.kind === "refused") return { refused: true, reason: w.reason };
  const stored = (base.ast?.bodies ?? []).find((b) => b.id === id);
  const storedMoon = stored ? base.moons.find((m) => m.id === id) : undefined;
  const { exact: _x, ...moon } = calendar.moons[at]!;
  // each half the stored body already holds is kept by moonsOf from the store; only a moved half is written exactly
  const exact = {
    ...(stored && storedMoon && sameRational(stored.period, w.period) ? {} : { period: w.period }),
    ...(stored && storedMoon && sameRational(stored.epoch, w.epoch) ? {} : { epoch: w.epoch }),
  };
  const moon2: DraftMoon = { ...moon, cycleDays: storedMoon && exact.period === undefined ? storedMoon.cycleDays : toNumber(w.period), phaseAtEpoch: storedMoon && exact.epoch === undefined ? storedMoon.phaseAtEpoch : toNumber(w.epoch), ...(exact.period || exact.epoch ? { exact } : {}) };
  const next: CalendarDraft = { ...calendar, moons: calendar.moons.map((m, i) => (i === at ? moon2 : m)) };
  const r = draftAst(next, base);
  if ("error" in r) return { refused: true, reason: r.error };
  const got = (r.ast.bodies ?? []).find((b) => b.id === id);
  if (!got || !sameRational(got.period, w.period) || !sameRational(got.epoch, w.epoch)) return { refused: true, reason: "that period and epoch cannot be kept exactly together" };
  return { calendar: next, ast: r.ast };
}

/** The draft shape of a calendar (the legacy settings calendar carries more fields: the year length, the format). */
export function draftOf(c: CalendarDraft): CalendarDraft {
  return { seasons: c.seasons, moons: c.moons, ...(c.form ? { form: c.form } : {}), ...(c.ast ? { ast: c.ast } : {}) };
}

/** Whether two calendars are the same as drafts (`draftOf`). */
export const sameCalendar = (a: CalendarDraft, b: CalendarDraft): boolean => same(draftOf(a), draftOf(b));

/** The way forward after a refusal that shows the stored calendar (undo brings the edits back to read, but they stay judged against the older definition). */
const AGAIN = "Undo shows your edits again, but they were made over the older calendar and cannot be saved over this one: make them again here, and Save.";

export type CalendarPlan =
  /** write nothing to the calendar; `reseed` is the calendar the draft takes afterwards */
  | { kind: "none"; reseed?: CalendarDraft }
  /** write the draft into the internal calendar's fields */
  | { kind: "legacy" }
  /** store this definition text (`rewrites`: ask first, the stored text was hand-edited) */
  | { kind: "definition"; text: string; rewrites: boolean }
  /** save nothing; say why, and show `reseed` (the calendar as stored) when there is one */
  | { kind: "refuse"; message: string; reseed?: CalendarDraft };

/**
 * What a Studio Save does with the world draft's calendar.
 * @param current the calendar the world runs now and its source (`plugin.studioSettings()`)
 * @param stored the stored definition (read when `current.source` is "seshat")
 * @param draft the draft calendar, the calendar it was seeded from (`base`), and that calendar's source
 */
export function planCalendarSave(current: { source: CalendarSource; calendar: CalendarDraft }, stored: unknown, draft: { calendar: CalendarDraft; base: CalendarDraft; source: CalendarSource }): CalendarPlan {
  const touched = !same(draft.calendar, draft.base);
  if (draft.source !== current.source) {
    if (!touched) return { kind: "none", reseed: current.calendar };
    return { kind: "refuse", message: `the world switched calendars since you edited its seasons or moons, so they were not saved. The studio now shows the calendar the world runs. ${AGAIN}`, reseed: current.calendar };
  }
  // an untouched draft from an older base (undo past a Save, or past a change in settings) writes nothing to the
  // calendar, and the rest of the Save goes ahead; the draft then takes the calendar as stored
  if (!touched) return sameCalendar(draft.base, current.calendar) ? { kind: "none" } : { kind: "none", reseed: structuredClone(draftOf(current.calendar)) };
  if (current.source === "fault") return { kind: "refuse", message: "the calendar definition cannot run, so its seasons and moons cannot be saved. Fix it in settings." };
  if (current.source === "legacy") return { kind: "legacy" };
  const m = mergeCalendar(typeof stored === "string" ? stored : "", draft.base, draft.calendar);
  switch (m.kind) {
    case "unchanged":
      return { kind: "none" };
    case "error":
      if (m.message === DATED_SEASONS) return { kind: "refuse", message: `${DATED_SEASONS} (Edit definition).` };
      return { kind: "refuse", message: `the calendar edits do not make a calendar that runs (${m.message}).` };
    case "stale":
      return { kind: "refuse", message: `the calendar definition changed outside the studio while you edited the same part of it${m.reason ? ` (${m.reason})` : ""}. The studio now shows the stored calendar. ${AGAIN}`, reseed: m.stored };
    case "write":
      return m.text === stored ? { kind: "none" } : { kind: "definition", text: m.text, rewrites: m.rewrites };
  }
}

/** The Studio state a Save reads (StudioState satisfies it). */
interface SaveState {
  world: { calendar: CalendarDraft };
  saved: { world: { calendar: CalendarDraft } };
  calendarBase?: CalendarDraft;
  calendarSource?: CalendarSource;
}

/**
 * A Studio Save's calendar decisions (header.ts `save`), as pure steps: the
 * plan, and once the rest is written, the calendar the draft is reseeded with
 * and the base `markSaved` rebases history from (§18.6; Parallax on step 3).
 * @param current `plugin.studioSettings()` as the Save starts
 * @param stored the stored definition as the Save starts
 */
export function studioSave(state: SaveState, current: { calendarSource?: CalendarSource; calendar: CalendarDraft }, stored: unknown) {
  const base = state.calendarBase ?? state.saved.world.calendar;
  const savedFrom = structuredClone(base);
  const plan = planCalendarSave({ source: current.calendarSource ?? "legacy", calendar: current.calendar }, stored, { calendar: state.world.calendar, base, source: state.calendarSource ?? "legacy" });
  return {
    plan,
    /**
     * After the write (`text`: the definition written, or null): the calendar the draft takes (null: it keeps its
     * own, as after a legacy write), and the base whose history `markSaved` rebases (null when the stored calendar
     * had moved outside the studio before this Save, so that history keeps its own base and a Save of it refuses).
     */
    after(text: string | null): { reseed: CalendarDraft | null; rebaseFrom: CalendarDraft | null } {
      // a written definition: the draft takes its own numbers (a new moon's exact rational reads back); nothing
      // written: the calendar as stored, so the next Save judges against exactly what is on disk
      const reseed = text !== null ? seshatDraft(parse(text)) : plan.kind === "none" ? (plan.reseed ?? draftOf(current.calendar)) : null;
      return { reseed, rebaseFrom: sameCalendar(current.calendar, savedFrom) ? savedFrom : null };
    },
  };
}
