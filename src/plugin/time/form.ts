/**
 * The form model (docs/SESHAT-v0.md §15.2, §15.9): the simple fields a
 * definition can be edited through, read part by part (R1). Pure: no Obsidian
 * imports; the settings tab and the Studio both use it.
 *
 * - `recognise` reads each part (name, year, months, week, seasons, moons). A
 *   part is `form` only when writing its value back gives the same AST, field
 *   for field; anything else is `text`, with a reason in on-screen terms.
 * - `compile` merges edited parts into the stored AST and passes every other
 *   field through untouched. It never rebuilds: a definition richer than the
 *   form keeps all of what the form does not show. The result still has to
 *   pass prepareDefinition; a refusal is shown, never saved.
 *
 * Leap years are stated in displayed year numbers (B4): a term matches year Y
 * when Y ≡ at (mod every). The gear reads occurrence indices (index = Y −
 * firstYear), so the offset is derived, and changing the first year keeps the
 * same displayed years leap. The ledger is its own part (B3): it never makes
 * the year `text` and passes through every year edit.
 */
import { canonicalJson } from "../../core/profile";
import type { BodyAst, CalendarAst, CycleUnitAst, GearAst, GearTerm, Rational, SlotsUnitAst, UnitAst } from "../../seshat";

export type Part<T> = { readonly kind: "form"; readonly value: T } | { readonly kind: "text"; readonly why: string };

/** Year Y is matched by this term when Y ≡ at (mod every); terms add (+1) and subtract (−1) as the gear's do. */
export interface LeapTerm {
  readonly every: number;
  readonly at: number;
  readonly sign: 1 | -1;
}
export interface YearForm {
  /** days in a common year */
  readonly length: number;
  /** the displayed number of the year that starts on the anchor day */
  readonly firstYear: number;
  /** null: every year is `length` days */
  readonly leap: { readonly add: number; readonly terms: readonly LeapTerm[] } | null;
}
export interface MonthForm {
  readonly name: string;
  /** days, or "slack": whatever the year leaves (at most one month) */
  readonly length: number | "slack";
}
export interface SeasonForm {
  readonly name: string;
  readonly from: number;
}
export interface MoonForm {
  /** the body's id; absent on a moon the form adds (compile names it) */
  readonly id?: string;
  readonly name: string;
  readonly period: Rational;
  readonly epoch: Rational;
  readonly phases?: ReadonlyArray<{ readonly name: string; readonly at: number }>;
}
export interface CalendarForm {
  readonly name: Part<string>;
  readonly year: Part<YearForm>;
  /** null: the year has no months */
  readonly months: Part<readonly MonthForm[] | null>;
  /** the day names of the week, in order from the week's first day; null: no week */
  readonly week: Part<readonly string[] | null>;
  readonly seasons: Part<readonly SeasonForm[]>;
  readonly moons: Part<readonly MoonForm[]>;
  /** ids of units no part covers: they pass through every edit */
  readonly others: readonly string[];
}
export interface FormEdits {
  readonly name?: string;
  readonly year?: YearForm;
  readonly months?: readonly MonthForm[] | null;
  readonly week?: readonly string[] | null;
  readonly seasons?: readonly SeasonForm[];
  readonly moons?: readonly MoonForm[];
}
type PartName = keyof FormEdits;

/** An edit to a part the form cannot express: the caller offered a field it should have shown as text. */
export class FormError extends Error {}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const mod = (a: number, m: number): number => ((a % m) + m) % m;
const onlyKeys = (o: object, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

function ids(ast: CalendarAst): Set<string> {
  return new Set([...ast.units.map((u) => u.id), ...ast.gears.map((g) => g.id), ...(ast.rules ?? []).map((r) => r.id), ...(ast.bodies ?? []).map((b) => b.id)]);
}
function freshId(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}
/** every gear term in the calendar, with who holds it */
function gearUses(ast: CalendarAst): Array<{ gear: string; by: string }> {
  return ast.units.flatMap((u) =>
    u.kind === "cycle"
      ? [...(u.gears ?? []), ...(u.ledger ?? []).flatMap((e) => (e.kind === "switch" ? (e.rule.gears ?? []) : []))].map((t) => ({ gear: t.gear, by: u.id }))
      : u.slots.flatMap((s) => (s.gears ?? []).map((t) => ({ gear: t.gear, by: u.id }))),
  );
}

// ---- the year

function yearUnit(ast: CalendarAst): CycleUnitAst | undefined {
  const u = ast.units.find((x) => x.id === "year");
  return u?.kind === "cycle" ? u : undefined;
}

function readYear(ast: CalendarAst): YearForm | string {
  const u = yearUnit(ast);
  if (!u) return "this calendar has no year";
  if (u.crossing !== undefined) return "this year follows a sky crossing (the moon or the sun), not a count of days";
  if (u.stages?.length) return "this year's start is moved by rules";
  if (u.labels !== undefined) return "this calendar names its years";
  if (!onlyKeys(u, ["id", "kind", "number", "anchor", "length", "gears", "ledger"])) return "this year carries settings the simple fields do not show";
  const firstYear = u.number ?? 0;
  const terms = u.gears ?? [];
  if (terms.length === 0) return { length: u.length, firstYear, leap: null };
  if (terms.length > 1) return "this year's length follows more than one leap rule";
  const t = terms[0]!;
  const g = ast.gears.find((x) => x.id === t.gear);
  if (!g || g.on !== "year") return "this year's leap rule does not read the year";
  if (g.kind !== "intervals") return "this year's leap years follow a table";
  const users = gearUses(ast).filter((x) => x.gear === g.id);
  if (users.length !== 1) return "this year's leap rule is also read elsewhere in the calendar";
  return { length: u.length, firstYear, leap: { add: t.add, terms: g.terms.map((x) => ({ every: x.every, at: mod((x.offset ?? 0) + firstYear, x.every), sign: x.sign })) } };
}

function writeYear(ast: CalendarAst, v: YearForm): CalendarAst {
  const u = yearUnit(ast)!;
  const { number: _n, gears: _g, ...rest } = u;
  const old = u.gears?.[0]?.gear;
  const taken = ids(ast);
  let gears = ast.gears.filter((g) => g.id !== old || v.leap);
  let terms: GearTerm[] | undefined;
  if (v.leap) {
    const id = old ?? freshId("leap", taken);
    const before = ast.gears.find((g) => g.id === old);
    const was = before?.kind === "intervals" ? before.terms : [];
    const gear: GearAst = {
      id,
      on: "year",
      kind: "intervals",
      terms: v.leap.terms.map((t, i) => {
        // a stored term that still means the same years is kept as written (French Republican stores −1,
        // Bahá'í 3, for the same "years divisible by 4" at first year 1); compile always starts from the
        // stored definition, so this depends on the stored text and the draft, never on edit history
        const prev = was[i];
        if (prev && prev.every === t.every && prev.sign === t.sign && mod((prev.offset ?? 0) + v.firstYear, t.every) === mod(t.at, t.every)) return prev;
        const offset = (t.at - v.firstYear) % t.every;
        return { every: t.every, ...(offset ? { offset } : {}), sign: t.sign };
      }),
    };
    gears = old ? gears.map((g) => (g.id === id ? gear : g)) : [...gears, gear];
    terms = [{ gear: id, add: v.leap.add }];
  }
  const year = {
    ...rest,
    // 0 is the default: written only when it was already stored that way, so an edit and its revert print the same
    ...(v.firstYear !== 0 || u.number === 0 ? { number: v.firstYear } : {}),
    length: v.length,
    ...(terms ? { gears: terms } : {}),
  } as CycleUnitAst;
  return { ...ast, gears, units: ast.units.map((x) => (x === u ? year : x)) };
}

// ---- months: the one slot unit directly in the year

function monthUnit(ast: CalendarAst): SlotsUnitAst | null | string {
  const ms = ast.units.filter((u): u is SlotsUnitAst => u.kind === "slots" && u.in === "year");
  if (ms.length === 0) return null;
  if (ms.length > 1) return "the year is divided more than one way";
  return ms[0]!;
}

function readMonths(ast: CalendarAst): readonly MonthForm[] | null | string {
  const m = monthUnit(ast);
  if (m === null || typeof m === "string") return m;
  if (ast.units.some((u) => u.kind === "slots" && u.in === m.id)) return "the months are divided further";
  if (!onlyKeys(m, ["id", "kind", "number", "in", "slots"])) return "the months carry settings the simple fields do not show";
  const out: MonthForm[] = [];
  for (const s of m.slots) {
    if (!onlyKeys(s, ["name", "length"])) return "a month has extra days, tags, limits or a leap rule of its own";
    if (typeof s.name !== "string") return "a month has no name";
    if (typeof s.length !== "number" && s.length !== "slack") return "a month's length depends on the year's";
    out.push({ name: s.name, length: s.length });
  }
  if (out.filter((s) => s.length === "slack").length > 1) return "more than one month takes what the year leaves";
  return out;
}

function writeMonths(ast: CalendarAst, v: readonly MonthForm[] | null): CalendarAst {
  const m = monthUnit(ast) as SlotsUnitAst | null;
  if (v === null) return m ? { ...ast, units: ast.units.filter((u) => u !== m) } : ast;
  const slots = v.map((s) => ({ name: s.name, length: s.length }));
  if (m) return { ...ast, units: ast.units.map((u) => (u === m ? { ...m, slots } : u)) };
  const added: SlotsUnitAst = { id: freshId("month", ids(ast)), kind: "slots", in: "year", slots };
  const at = ast.units.findIndex((u) => u.id === "year") + 1;
  return { ...ast, units: [...ast.units.slice(0, at), added, ...ast.units.slice(at)] };
}

// ---- the week: a one-day cycle naming the days, and a cycle of that many days aligned with it

type Week = { days: CycleUnitAst; week: CycleUnitAst } | null;

function plainCycle(u: UnitAst, extra: readonly string[] = []): u is CycleUnitAst {
  return u.kind === "cycle" && u.crossing === undefined && onlyKeys(u, ["id", "kind", "number", "anchor", "length", ...extra]);
}

function findWeek(ast: CalendarAst): Week | string {
  const named = ast.units.filter((u) => u.id !== "year" && u.kind === "cycle" && u.length === 1 && u.labels !== undefined);
  if (named.length === 0) return null;
  if (named.length > 1) return "the days are named more than one way";
  const days = named[0] as CycleUnitAst;
  if (!plainCycle(days, ["labels"])) return "the day names move by rules";
  if (!(days.labels ?? []).every((l) => onlyKeys(l, ["name"]) && typeof l.name === "string")) return "a day name carries tags";
  const n = days.labels!.length;
  const weeks = ast.units.filter((u) => u !== days && u.id !== "year" && plainCycle(u) && u.length === n && mod((u.anchor) - (days.anchor as number), n) === 0);
  if (weeks.length !== 1) return weeks.length ? "more than one cycle runs with the day names" : "the day names have no week of the same length";
  return { days, week: weeks[0] as CycleUnitAst };
}

function readWeek(ast: CalendarAst): readonly string[] | null | string {
  const w = findWeek(ast);
  if (w === null || typeof w === "string") return w;
  return w.days.labels!.map((l) => l.name!);
}

function writeWeek(ast: CalendarAst, v: readonly string[] | null): CalendarAst {
  const w = findWeek(ast) as Week;
  if (v === null) return w ? { ...ast, units: ast.units.filter((u) => u !== w.days && u !== w.week) } : ast;
  const n = v.length;
  const labels = v.map((name) => ({ name }));
  if (w) {
    const anchor = w.days.anchor as number;
    // the week keeps its own anchor while it still lines up with the names; otherwise it starts with the first name
    const weekAnchor = mod((w.week.anchor as number) - anchor, n) === 0 ? w.week.anchor : anchor;
    const days = { ...w.days, labels } as CycleUnitAst;
    const week = { ...w.week, anchor: weekAnchor, length: n } as CycleUnitAst;
    return { ...ast, units: ast.units.map((u) => (u === w.days ? days : u === w.week ? week : u)) };
  }
  const taken = ids(ast);
  const added: UnitAst[] = [
    { id: freshId("week", taken), kind: "cycle", anchor: 0, length: n },
    { id: freshId("weekday", taken), kind: "cycle", anchor: 0, length: 1, labels },
  ];
  return { ...ast, units: [...ast.units, ...added] };
}

// ---- seasons and moons

function readSeasons(ast: CalendarAst): readonly SeasonForm[] | string {
  if (ast.seasons === undefined) return [];
  if (ast.seasons.unit !== "year") return "the seasons follow something other than the year";
  return ast.seasons.marks.map((m) => ({ name: m.name, from: m.from }));
}

/**
 * An empty seasons field is hashed (it is not the same calendar as none), so
 * an empty list keeps a stored empty field (a no-op) and otherwise removes the
 * field: adding seasons and taking them away again gives back the same hash.
 */
function writeSeasons(ast: CalendarAst, v: readonly SeasonForm[]): CalendarAst {
  if (v.length === 0) {
    if (!ast.seasons?.marks.length) return ast;
    const { seasons: _s, ...rest } = ast;
    return rest;
  }
  return { ...ast, seasons: { unit: "year", marks: v.map((s) => ({ name: s.name, from: s.from })) } };
}

function readMoons(ast: CalendarAst): readonly MoonForm[] {
  return (ast.bodies ?? []).flatMap((b) => (b.moon ? [{ id: b.id, name: b.moon.name, period: b.period, epoch: b.epoch, ...(b.moon.phases !== undefined ? { phases: b.moon.phases } : {}) }] : []));
}

/** Moons replace the moon bodies slot for slot, so bodies that are not moons keep their places (and a no-op keeps the order). */
function writeMoons(ast: CalendarAst, v: readonly MoonForm[]): CalendarAst {
  // ids the list itself names are reserved before a new moon is named
  const taken = new Set([...ids(ast), ...v.flatMap((m) => (m.id === undefined ? [] : [m.id]))]);
  const body = (m: MoonForm): BodyAst => ({
    id: m.id ?? freshId("moon", taken),
    period: m.period,
    epoch: m.epoch,
    moon: { name: m.name, ...(m.phases !== undefined ? { phases: m.phases } : {}) },
  });
  const queue = [...v];
  const bodies: BodyAst[] = [];
  for (const b of ast.bodies ?? []) {
    if (!b.moon) bodies.push(b);
    else if (queue.length) bodies.push(body(queue.shift()!));
  }
  bodies.push(...queue.map(body));
  // a stored empty list stays (a no-op keeps the text); no moons and no other bodies otherwise drops the field
  const { bodies: _b, ...rest } = ast;
  return bodies.length || ast.bodies?.length === 0 ? { ...rest, bodies } : rest;
}

// ---- recognise and compile

const PARTS: { [K in PartName]: { read: (ast: CalendarAst) => FormEdits[K] | string; write: (ast: CalendarAst, v: NonNullable<FormEdits[K]> | null) => CalendarAst } } = {
  name: { read: (ast) => ast.name, write: (ast, v) => ({ ...ast, name: v as string }) },
  year: { read: readYear, write: (ast, v) => writeYear(ast, v as YearForm) },
  months: { read: readMonths, write: (ast, v) => writeMonths(ast, v) },
  week: { read: readWeek, write: (ast, v) => writeWeek(ast, v) },
  seasons: { read: readSeasons, write: (ast, v) => writeSeasons(ast, v as readonly SeasonForm[]) },
  moons: { read: readMoons, write: (ast, v) => writeMoons(ast, v as readonly MoonForm[]) },
};

function part<K extends PartName>(ast: CalendarAst, k: K): Part<NonNullable<FormEdits[K]> | Extract<FormEdits[K], null>> {
  const p = PARTS[k];
  const v = p.read(ast);
  // the name is a string value, never a reason
  if (typeof v === "string" && k !== "name") return { kind: "text", why: v };
  if (!same(p.write(ast, v as never), ast)) return { kind: "text", why: "it is written in a way the simple fields cannot reproduce" };
  return { kind: "form", value: v as never };
}

export function recognise(ast: CalendarAst): CalendarForm {
  const covered = new Set(["year"]);
  const m = monthUnit(ast);
  if (m && typeof m !== "string") covered.add(m.id);
  const w = findWeek(ast);
  if (w && typeof w !== "string") for (const u of [w.days, w.week]) covered.add(u.id);
  return {
    name: part(ast, "name"),
    year: part(ast, "year"),
    months: part(ast, "months"),
    week: part(ast, "week"),
    seasons: part(ast, "seasons"),
    moons: part(ast, "moons"),
    others: ast.units.filter((u) => !covered.has(u.id)).map((u) => u.id),
  };
}

/** Leap terms the gear can hold: whole numbers, every at least 1. */
function checkLeap(y: YearForm): void {
  if (!y.leap) return;
  if (!Number.isSafeInteger(y.leap.add)) throw new FormError(`A leap year adds ${y.leap.add} days; write a whole number.`);
  for (const t of y.leap.terms) {
    if (!Number.isSafeInteger(t.every) || t.every < 1) throw new FormError(`A leap rule repeats every ${t.every} years; write a whole number of at least 1.`);
    if (!Number.isSafeInteger(t.at)) throw new FormError(`A leap rule counts from year ${t.at}; write a whole year.`);
  }
  if (!Number.isSafeInteger(y.firstYear)) throw new FormError(`The first year is ${y.firstYear}; write a whole year.`);
}

/**
 * Merge edited parts into `ast`, in the order name, year, months, week,
 * seasons, moons. An edit of `undefined` is no edit; `null` removes the months
 * or the week. Throws FormError when an edited part is `text` in `ast`, or
 * when the edit would leave the part no longer readable as fields (a new week
 * beside another cycle of the same length). No edits: `ast` itself.
 *
 * The Studio and the settings rows compile from the stored definition every
 * time (stored + the whole draft), never edit on edit: "revert" means the
 * draft's value equals the stored one again, which compiles to the stored AST
 * (an empty seasons list cannot tell "had none" from "had an empty field").
 */
export function compile(ast: CalendarAst, edits: FormEdits): CalendarAst {
  let out = ast;
  for (const k of Object.keys(PARTS) as PartName[]) {
    if (edits[k] === undefined) continue;
    const p = part(out, k);
    if (p.kind === "text") throw new FormError(`The ${k} cannot be edited here: ${p.why}.`);
    if (k === "year") checkLeap(edits.year!);
    out = PARTS[k].write(out, edits[k] as never);
    const after = part(out, k);
    if (after.kind === "text") throw new FormError(`This change would leave the ${k} unreadable as fields: ${after.why}.`);
  }
  return out;
}
