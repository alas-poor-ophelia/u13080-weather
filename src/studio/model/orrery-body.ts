/**
 * The Orrery's body inspector edits (docs/SESHAT-v0.md §18.3 D2, §18.6 items
 * 2, 6 and 11; bead wadjet-b6x, slice 5a). Pure: no DOM, no store.
 *
 * A body the inspector edits is a MOON (a `VBODY` with a `MOON` line): the
 * draft's `moons` field is its editing surface, and every edit here writes
 * that field and then compiles the draft (`draftAst`, so through `compile`'s
 * guards: removing a moon a unit follows is refused, so is renaming or
 * removing a phase a rule names, and an epoch move shifts K). A refusal
 * comes back with the guard's own reason and the draft as it was. A body
 * without a MOON line is not in the moons field, so it is shown, not edited.
 *
 * Exact numbers: a period or epoch knob writes through `knobWrite`, which
 * keeps the draft's current rational while the knob stays in its displayed
 * step cell, else the stored rational while it is in that one's cell, else
 * the step grid's rational (rational-knob.ts `knobRational`).
 */
import { namedPhasesOf } from "../../plugin/time/form";
import { frac, fromNumber, rational, toNumber, type CalendarAst, type Rational } from "../../seshat";
import { draftAst, sameCalendar, type CalendarDraft, type CalendarEdit } from "./definition";
import { DEFAULT_MOON_PHASES } from "./devices";
import { cellOf, cellOfValue, cellValue, knobRational, type KnobStep } from "./rational-knob";
import type { DraftMoon } from "./state";

export type Phase = { readonly name: string; readonly at: number };

const refuse = (reason: string): CalendarEdit => ({ refused: true, reason });

/** The draft with `moons` in place of its moons, compiled; a compile refusal is the edit's refusal. */
function withMoons(calendar: CalendarDraft, base: CalendarDraft, moons: DraftMoon[]): CalendarEdit {
  const next: CalendarDraft = { ...calendar, moons };
  const d = draftAst(next, base);
  return "error" in d ? refuse(d.error) : { calendar: next, ast: d.ast };
}

/** The draft moon behind body `id`, or why the inspector cannot edit it. */
export function moonOf(calendar: CalendarDraft, ast: CalendarAst, id: string): DraftMoon | string {
  const b = (ast.bodies ?? []).find((x) => x.id === id);
  if (!b) return `there is no body "${id}"`;
  if (!b.moon) return `the body "${id}" is not a moon, so it is edited as text`;
  return calendar.moons.find((m) => m.id === id) ?? `the moon "${b.moon.name}" is not in the draft; reopen the Studio`;
}

function editMoon(calendar: CalendarDraft, base: CalendarDraft, id: string, fn: (m: DraftMoon) => DraftMoon | string): CalendarEdit {
  const at = calendar.moons.findIndex((m) => m.id === id);
  if (at < 0) return refuse(`there is no moon "${id}"`);
  const next = fn(calendar.moons[at]!);
  if (typeof next === "string") return refuse(next);
  return withMoons(
    calendar,
    base,
    calendar.moons.map((m, i) => (i === at ? next : m)),
  );
}

/** Rename moon `id` (zone conditions that name it follow on Save, header.ts). */
export function renameBody(calendar: CalendarDraft, base: CalendarDraft, id: string, name: string): CalendarEdit {
  const n = name.trim().normalize("NFC");
  if (n === "") return refuse("a moon needs a name");
  return editMoon(calendar, base, id, (m) => (m.name === n ? m : { ...m, name: n }));
}

/** Why a phase list cannot be written, or null: every phase named once, each at a fraction in [0, 1). */
export function phasesProblem(phases: readonly Phase[]): string | null {
  const seen = new Set<string>();
  for (const p of phases) {
    const n = p.name.trim();
    if (n === "") return "a phase needs a name";
    if (seen.has(n)) return `two phases are named "${n}"; a rule reads a phase by its name`;
    seen.add(n);
    if (!Number.isFinite(p.at) || p.at < 0 || p.at >= 1) return `the phase "${n}" must start at a fraction of the turn from 0 up to (not including) 1`;
  }
  return null;
}

/** Set moon `id`'s phases (none removes the list). */
export function setBodyPhases(calendar: CalendarDraft, base: CalendarDraft, id: string, phases: readonly Phase[]): CalendarEdit {
  const why = phasesProblem(phases);
  if (why) return refuse(why);
  const written = phases.map((p) => ({ name: p.name.trim().normalize("NFC"), at: p.at }));
  return editMoon(calendar, base, id, (m) => {
    const { phases: _p, ...rest } = m;
    return written.length ? { ...rest, phases: written } : rest;
  });
}

/**
 * Where `＋ phase` puts a new phase: the middle of the largest gap between the
 * phases going round the turn (the gap from the last back to the first
 * included), rounded to the knob's 0.01 and kept in [0, 1). The first phase
 * goes at 0; with one phase, opposite it.
 */
export function phaseInsertAt(ats: readonly number[]): number {
  const sorted = [...ats].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  let best = -1;
  let at = 0;
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i]!;
    const to = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + 1;
    if (to - from > best) {
      best = to - from;
      at = from + (to - from) / 2;
    }
  }
  const r = Math.round((at % 1) * 100) / 100;
  return r >= 1 ? 0 : r;
}

/** "Phase", then "Phase 2", "Phase 3"…: the first not already taken. */
export function freshName(stem: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(stem)) return stem;
  let n = 2;
  while (t.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

/** Add a phase to moon `id` at the middle of its largest gap. */
export function addPhase(calendar: CalendarDraft, base: CalendarDraft, id: string): CalendarEdit {
  const m = calendar.moons.find((x) => x.id === id);
  if (!m) return refuse(`there is no moon "${id}"`);
  const phases = m.phases ?? [];
  return setBodyPhases(calendar, base, id, [...phases, { name: freshName("Phase", phases.map((p) => p.name)), at: phaseInsertAt(phases.map((p) => p.at)) }]);
}

/** Remove moon `id`; refused (with compile's reason) while a unit follows it. */
export function removeBody(calendar: CalendarDraft, base: CalendarDraft, id: string): CalendarEdit {
  if (!calendar.moons.some((m) => m.id === id)) return refuse(`there is no moon "${id}"`);
  return withMoons(
    calendar,
    base,
    calendar.moons.filter((m) => m.id !== id),
  );
}

/** A moon id no definition part and no draft moon uses: moon-1, moon-2… */
function freshMoonId(calendar: CalendarDraft, ast: CalendarAst): string {
  const taken = new Set([...ast.units.map((u) => u.id), ...ast.gears.map((g) => g.id), ...(ast.rules ?? []).map((r) => r.id), ...(ast.bodies ?? []).map((b) => b.id), ...calendar.moons.flatMap((m) => (m.id ? [m.id] : []))]);
  let n = 1;
  while (taken.has(`moon-${n}`)) n++;
  return `moon-${n}`;
}

/** The period a new moon turns in, in days (59/2). */
export const NEW_MOON_DAYS = 29.5;

/**
 * Add a moon after the others: a fresh id (so the inspector can edit it
 * before it is saved), a name no moon has, a 29.5-day period at epoch 0 and
 * the Studio's default phases. `id` is the new body's id.
 */
export function addBody(calendar: CalendarDraft, base: CalendarDraft, ast: CalendarAst): CalendarEdit & { readonly id?: string } {
  const id = freshMoonId(calendar, ast);
  const moon: DraftMoon = { id, name: freshName("Moon", calendar.moons.map((m) => m.name)), cycleDays: NEW_MOON_DAYS, phaseAtEpoch: 0, phases: DEFAULT_MOON_PHASES.map((p) => ({ ...p })) };
  const r = withMoons(calendar, base, [...calendar.moons, moon]);
  return "refused" in r ? r : { ...r, id };
}

/**
 * The rational a period or epoch knob writes for its float `value`: the
 * draft's `current` rational while the knob is in its displayed step cell
 * (a drag back to where it began changes nothing), else the `stored`
 * rational while it is in that one's (a drag back to the stored value leaves
 * the draft clean), else the step grid's rational, reduced.
 */
export function knobWrite(value: number, current: Rational, stored: Rational | null, step: KnobStep): Rational {
  const kept = knobRational(value, current, step);
  if (kept === current || stored === null) return kept;
  return knobRational(value, stored, step);
}

/** The whole turns of `r` (floor), exactly. */
function wholeTurns(r: Rational): number {
  const m = ((r.n % r.d) + r.d) % r.d;
  return (r.n - m) / r.d;
}

/**
 * The epoch an epoch knob writes for its float `value`, the fraction of a turn
 * it shows (frac of the epoch, 0 to `max`): the draft's `current` epoch while
 * the knob is in the cell its fraction shows in, else the `stored` epoch in
 * that one's, else the grid's fraction plus the current epoch's whole turns
 * (so 3/2 moved by a step is 151/100, never 51/100). A fraction past the
 * knob's top (0.995 up to 1) shows in its top cell, so a drag back there
 * snaps back to it too.
 */
export function epochWrite(value: number, current: Rational, stored: Rational | null, step: KnobStep, max: number): Rational {
  const top = cellOfValue(max, step);
  const shown = (r: Rational): number => Math.min(cellOf(frac(r), step), top);
  const cell = Math.min(cellOfValue(value, step), top);
  if (cell === shown(current)) return current;
  if (stored !== null && cell === shown(stored)) return stored;
  const f = cellValue(cell, step);
  return rational(f.n + wholeTurns(current) * f.d, f.d);
}

/**
 * The fraction a 0-to-`max` fraction knob writes (a phase's `at`): `origin`
 * while the knob is in the cell it shows in (a drag back to the start keeps
 * it exactly, 0.995 included), else the cell's value on the step grid.
 */
export function fractionWrite(value: number, origin: number, step: KnobStep, max: number): number {
  const top = cellOfValue(max, step);
  const cell = Math.min(cellOfValue(value, step), top);
  if (Number.isFinite(origin) && cell === Math.min(cellOf(fromNumber(origin), step), top)) return origin;
  return toNumber(cellValue(cell, step));
}

/** The ids of the rules that read phase `name` of body `id` by name (their chips in the inspector). */
export function phaseRules(ast: CalendarAst, id: string, name: string): string[] {
  return namedPhasesOf(ast).find((r) => r.body === id && r.name === name)?.rules ?? [];
}

/** What the Orrery draws on a Seshat world: the one draft AST, why the pending field edits do not compile (then the AST layer is drawn), and whether the calendar draft is dirty. */
export interface DraftView {
  readonly ast: CalendarAst;
  readonly error: string | null;
  readonly dirty: boolean;
}

/**
 * A reader of the draft for one window, memoised on the draft's content (the
 * AST layer and the base's by identity: an edit replaces them, never mutates
 * them; the small field parts by their JSON), so the AST it hands back keeps
 * its identity while nothing changed and the geometry and `problems()` memos
 * hold. Null when the draft has no AST layer (a legacy or plugin calendar).
 */
export function draftReader(): (calendar: CalendarDraft, base: CalendarDraft) => DraftView | null {
  let key: { layer: CalendarAst; baseAst: CalendarAst | undefined; fields: string } | null = null;
  let view: DraftView | null = null;
  return (calendar, base) => {
    const layer = calendar.ast;
    if (!layer) return null;
    const fields = JSON.stringify([calendar.seasons, calendar.moons, calendar.form ?? null, base.seasons, base.moons, base.form ?? null]);
    if (key && view && key.layer === layer && key.baseAst === base.ast && key.fields === fields) return view;
    const d = draftAst(calendar, base);
    view = { ast: "error" in d ? layer : d.ast, error: "error" in d ? d.error : null, dirty: !sameCalendar(calendar, base) };
    key = { layer, baseAst: base.ast, fields };
    return view;
  };
}
