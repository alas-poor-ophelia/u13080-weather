/**
 * Edits to the parts of a Seshat definition the form model does not reach
 * (docs/SESHAT-v0.md §18.6 items 2 and 11, bead wadjet-b6x): gears, stages,
 * crossings, dated season marks, and (slice 5b) a year's length and a slot
 * unit's slots where the form reads them as text (a filler or gear-carrying
 * slot, tags, limits, keyed lengths, nested units, a second slot unit).
 * Pure: AST in, AST out, no DOM, no store.
 *
 * - Every edit returns `{ ast }` or `{ refused, reason }`; a refusal names
 *   what is wrong in on-screen terms and the draft stays as it was. The checks
 *   here are local (shapes, whole numbers, ids that exist); the caller runs
 *   `problems()` on the result (it costs 70-216 ms on Hebrew, §18.6 item 7),
 *   so no edit here calls it.
 * - Each edit touches one SLICE of the AST: one gear, one unit's stages, one
 *   unit's crossing, one cycle unit's constant length, one slot unit's slots,
 *   or the season marks (a slot edit that moves slots also moves the marks
 *   that name them, so it touches two). Slices are how a Save replays the
 *   draft's edits onto the definition stored at Save time (definition.ts
 *   `mergeCalendar`): a slice the draft did not edit passes through as stored
 *   now, and a slice it did edit is refused when it changed in storage since.
 * - A crossing that follows a body keeps its occurrence numbers: a moved mark
 *   or offset, or a different body, moves its K by the smallest shift (the
 *   rule `epochEditK` applies to an epoch edit, §16.7 P1). START changes the
 *   start day by less than one day, so K stays.
 */
import { canonicalJson } from "../../core/profile";
import { childrenOf, epochEditK, rational, type BodyRef, type CalendarAst, type CrossingAst, type CycleUnitAst, type GearAst, type Rational, type RuleAst, type SeasonMarkAst, type SeasonsAst, type SlotAst, type SlotsUnitAst, type StageAst, type UnitAst } from "../../seshat";

export type AstEdit = { readonly ast: CalendarAst } | { readonly refused: true; readonly reason: string };

const refuse = (reason: string): AstEdit => ({ refused: true, reason });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isReduced = (r: Rational): boolean => isInt(r.n) && isInt(r.d) && r.d > 0 && same(rational(r.n, r.d), { n: r.n, d: r.d });

// ---- slices

/**
 * One editable slice of a definition: a gear by id; a cycle unit's stages, crossing or constant length (`length:`)
 * by unit id; a slot unit's slots (`slots:`) by unit id; or the season marks.
 */
export type SliceKey = `gear:${string}` | `stages:${string}` | `crossing:${string}` | `length:${string}` | `slots:${string}` | "marks";

/** What a slice reads on a definition without the unit it names (distinct from a unit without stages). */
export const NO_UNIT = "\u0000no unit";

function cycleUnit(ast: CalendarAst, id: string): CycleUnitAst | undefined {
  const u = ast.units.find((x) => x.id === id);
  return u?.kind === "cycle" ? u : undefined;
}

function slotUnit(ast: CalendarAst, id: string): SlotsUnitAst | undefined {
  const u = ast.units.find((x) => x.id === id);
  return u?.kind === "slots" ? u : undefined;
}

/** The value of slice `key` on `ast` (undefined: absent; NO_UNIT: the unit itself is missing or not of the slice's kind). */
export function sliceOf(ast: CalendarAst, key: SliceKey): unknown {
  if (key === "marks") return ast.seasons;
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === "gear") return ast.gears.find((g) => g.id === id);
  if (kind === "slots") return slotUnit(ast, id)?.slots ?? NO_UNIT;
  const u = cycleUnit(ast, id);
  if (!u) return NO_UNIT;
  if (kind === "length") return u.crossing ? undefined : u.length;
  return kind === "stages" ? u.stages : u.crossing;
}

/** Every slice key either definition has, in a stable order: gears, then each cycle unit's stages, crossing and length, each slot unit's slots, then the marks. */
function sliceKeys(a: CalendarAst, b: CalendarAst): SliceKey[] {
  const gears = [...new Set([...a.gears, ...b.gears].map((g) => g.id))];
  const units = [...new Set([...a.units, ...b.units].filter((u) => u.kind === "cycle").map((u) => u.id))];
  const slotted = [...new Set([...a.units, ...b.units].filter((u) => u.kind === "slots").map((u) => u.id))];
  return [...gears.map((id): SliceKey => `gear:${id}`), ...units.flatMap((id): SliceKey[] => [`stages:${id}`, `crossing:${id}`, `length:${id}`]), ...slotted.map((id): SliceKey => `slots:${id}`), "marks"];
}

/** The slices `draft` changed from `base`. */
export function editedSlices(base: CalendarAst, draft: CalendarAst): SliceKey[] {
  return sliceKeys(base, draft).filter((k) => !same(sliceOf(base, k), sliceOf(draft, k)));
}

/**
 * `ast` with slice `key` set to `value` (undefined removes it), or null when it
 * cannot be placed (the unit is missing, or a crossing would leave a unit with
 * no base). A new gear goes after the others.
 */
export function withSlice(ast: CalendarAst, key: SliceKey, value: unknown): CalendarAst | null {
  if (value === NO_UNIT) return null;
  if (key === "marks") {
    if (value === undefined) {
      const { seasons: _s, ...rest } = ast;
      return rest;
    }
    return { ...ast, seasons: value as SeasonsAst };
  }
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === "gear") {
    const has = ast.gears.some((g) => g.id === id);
    if (value === undefined) return { ...ast, gears: ast.gears.filter((g) => g.id !== id) };
    const g = value as GearAst;
    return { ...ast, gears: has ? ast.gears.map((x) => (x.id === id ? g : x)) : [...ast.gears, g] };
  }
  if (kind === "slots") {
    const s = slotUnit(ast, id);
    if (!s || !Array.isArray(value)) return null; // a slot unit always has its slots; adding or removing a unit is no slice
    const next: SlotsUnitAst = { ...s, slots: value as SlotAst[] };
    return { ...ast, units: ast.units.map((x) => (x === s ? next : x)) };
  }
  const u = cycleUnit(ast, id);
  if (!u) return null;
  if (kind === "length") {
    if (u.crossing) return value === undefined ? ast : null; // a crossing base has no length of its own
    if (typeof value !== "number") return null;
    const next = { ...u, length: value } as UnitAst;
    return { ...ast, units: ast.units.map((x) => (x === u ? next : x)) };
  }
  const field = kind === "stages" ? "stages" : "crossing";
  if (field === "crossing" && (value === undefined) !== (u.crossing === undefined)) return null; // a base kind changes with its anchor and length, which no slice holds
  const { [field]: _old, ...rest } = u as CycleUnitAst & Record<string, unknown>;
  const next = (value === undefined ? rest : { ...rest, [field]: value }) as UnitAst;
  return { ...ast, units: ast.units.map((x) => (x === u ? next : x)) };
}

/** `ast` with every slice taken out: two definitions that differ only in their slices are equal here. */
export function outsideSlices(ast: CalendarAst): unknown {
  const { gears: _g, seasons: _s, units, ...rest } = ast;
  return {
    ...rest,
    units: units.map((u) => (u.kind === "cycle" ? (({ stages: _st, crossing: _c, length: _l, ...x }) => ({ ...x, base: u.crossing ? "crossing" : "constant" }))(u) : (({ slots: _sl, ...x }) => x)(u))),
  };
}

// ---- gears

function gearOf(ast: CalendarAst, id: string): GearAst | string {
  const g = ast.gears.find((x) => x.id === id);
  return g ?? `there is no gear "${id}"`;
}

const putGear = (ast: CalendarAst, g: GearAst): CalendarAst => ({ ...ast, gears: ast.gears.map((x) => (x.id === g.id ? g : x)) });

/**
 * Set an interval gear's terms: year n matches when Σ sign·[n ≡ offset mod every]
 * is 1. Each `every` is a whole number of at least 1, each offset a whole number
 * (0 is written as absent), each sign +1 or −1.
 */
export function setGearIntervals(ast: CalendarAst, gearId: string, terms: ReadonlyArray<{ readonly every: number; readonly offset?: number; readonly sign: 1 | -1 }>): AstEdit {
  const g = gearOf(ast, gearId);
  if (typeof g === "string") return refuse(g);
  if (g.kind !== "intervals") return refuse(`the gear "${gearId}" is a table of positions, not intervals`);
  if (terms.length === 0) return refuse("a gear needs at least one term");
  for (const t of terms) {
    if (!isInt(t.every) || t.every < 1) return refuse(`a term repeats every ${t.every}; write a whole number of at least 1`);
    if (t.offset !== undefined && !isInt(t.offset)) return refuse(`a term's offset is ${String(t.offset)}; write a whole number`);
    if (t.sign !== 1 && t.sign !== -1) return refuse("a term adds (+1) or takes away (−1)");
  }
  const written = terms.map((t) => ({ every: t.every, ...(t.offset ? { offset: t.offset } : {}), sign: t.sign }));
  return { ast: putGear(ast, { ...g, terms: written }) };
}

/**
 * Set a position gear's table: index n matches when (n − offset) mod period is
 * listed. Positions are written sorted and once each, in [0, period).
 */
export function setGearPositions(ast: CalendarAst, gearId: string, table: { readonly period: number; readonly positions: readonly number[]; readonly offset?: number }): AstEdit {
  const g = gearOf(ast, gearId);
  if (typeof g === "string") return refuse(g);
  if (g.kind !== "positions") return refuse(`the gear "${gearId}" is a sum of intervals, not a table of positions`);
  if (!isInt(table.period) || table.period < 1) return refuse(`the table repeats every ${table.period}; write a whole number of at least 1`);
  if (table.offset !== undefined && !isInt(table.offset)) return refuse(`the table's offset is ${String(table.offset)}; write a whole number`);
  for (const p of table.positions) if (!isInt(p) || p < 0 || p >= table.period) return refuse(`position ${p} is outside 0 to ${table.period - 1}`);
  const positions = [...new Set(table.positions)].sort((a, b) => a - b);
  const { offset: _o, ...rest } = g;
  return { ast: putGear(ast, { ...rest, period: table.period, positions, ...(table.offset ? { offset: table.offset } : {}) }) };
}

// ---- stages

/**
 * Set a cycle unit's stages (C4): each stage's rules shift a start by a whole
 * number of days, on a weekday test (`residue`) or a length test (`length`).
 * No stages removes the field.
 */
export function setStages(ast: CalendarAst, unitId: string, stages: readonly StageAst[]): AstEdit {
  const u = cycleUnit(ast, unitId);
  if (!u) return refuse(`there is no cycle unit "${unitId}"`);
  for (const s of stages) {
    if (s.rules.length === 0) return refuse("a stage needs at least one rule");
    for (const r of s.rules) {
      if (!isInt(r.add)) return refuse(`a stage moves a start by ${String(r.add)} days; write a whole number`);
      if ("residue" in r) {
        const { mod, offset, in: hits } = r.residue;
        if (!isInt(mod) || mod < 1) return refuse(`a weekday test counts in ${mod}s; write a whole number of at least 1`);
        if (offset !== undefined && !isInt(offset)) return refuse(`a weekday test's offset is ${String(offset)}; write a whole number`);
        if (hits.length === 0 || hits.some((h) => !isInt(h) || h < 0 || h >= mod)) return refuse(`a weekday test names days from 0 to ${mod - 1}`);
      } else if ("length" in r) {
        if (!isInt(r.length.at) || !isInt(r.length.is) || r.length.is < 1) return refuse("a length test reads a whole occurrence and a length of at least 1 day");
      } else return refuse("a stage rule tests a weekday or a length");
    }
  }
  const next = withSlice(ast, `stages:${unitId}`, stages.length ? stages : undefined);
  return next ? { ast: next } : refuse(`there is no cycle unit "${unitId}"`);
}

// ---- crossings

function crossingOf(ast: CalendarAst, unitId: string): CrossingAst | string {
  const u = cycleUnit(ast, unitId);
  if (!u) return `there is no cycle unit "${unitId}"`;
  return u.crossing ?? `the ${unitId} does not start by a crossing`;
}

const putCrossing = (ast: CalendarAst, unitId: string, c: CrossingAst): AstEdit => {
  const next = withSlice(ast, `crossing:${unitId}`, c);
  return next ? { ast: next } : refuse(`the ${unitId} does not start by a crossing`);
};

/** A body reference with its K set (0 is written as absent). */
function withK(ref: BodyRef, k: number): BodyRef {
  const { k: _k, ...rest } = ref;
  return k === 0 ? rest : { ...rest, k };
}

/** A crossing's start: the day holding the crossing (`after` false), or the first day that begins at or after it. K stays. */
export function setCrossingStart(ast: CalendarAst, unitId: string, after: boolean): AstEdit {
  const c = crossingOf(ast, unitId);
  if (typeof c === "string") return refuse(c);
  const { start: _s, ...rest } = c;
  return putCrossing(ast, unitId, after ? { ...rest, start: "after" } : rest);
}

// exact rationals over BigInt, for the K arithmetic (the values multiply past safe integers)
interface Big {
  n: bigint;
  d: bigint;
}
const big = (r: Rational): Big => ({ n: BigInt(r.n), d: BigInt(r.d) });
const gcdBig = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
function reduce(n: bigint, d: bigint): Big {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcdBig(n, d) || 1n;
  return { n: n / g, d: d / g };
}
const addB = (a: Big, b: Big): Big => reduce(a.n * b.d + b.n * a.d, a.d * b.d);
const subB = (a: Big, b: Big): Big => reduce(a.n * b.d - b.n * a.d, a.d * b.d);
const mulB = (a: Big, b: Big): Big => reduce(a.n * b.n, a.d * b.d);
const divB = (a: Big, b: Big): Big => reduce(a.n * b.d, a.d * b.n);
const floorB = (x: Big): bigint => {
  const q = x.n / x.d;
  return x.n % x.d !== 0n && x.n < 0n ? q - 1n : q;
};
/** −floor(x + 1/2): the whole number of turns that brings a shift of x turns into [−1/2, 1/2). */
const nearestTurn = (x: Big): bigint => -floorB(addB(x, { n: 1n, d: 2n }));

function safeK(k: bigint): number | null {
  return k > BigInt(Number.MAX_SAFE_INTEGER) || k < -BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(k);
}

function bodyCrossing(ast: CalendarAst, unitId: string): { c: CrossingAst & { body: BodyRef }; period: Rational } | string {
  const c = crossingOf(ast, unitId);
  if (typeof c === "string") return c;
  if (!c.body) return `the ${unitId} starts by a crossing written as numbers, not one that follows a body`;
  const b = (ast.bodies ?? []).find((x) => x.id === c.body.id);
  if (!b) return `the ${unitId} follows the body "${c.body.id}", which is not declared`;
  return { c, period: b.period };
}

/** The phase a followed body is at when the crossing falls, in [0, 1); K moves so the crossings keep their numbers. */
export function setCrossingMark(ast: CalendarAst, unitId: string, mark: Rational): AstEdit {
  const f = bodyCrossing(ast, unitId);
  if (typeof f === "string") return refuse(f);
  if (!isReduced(mark) || mark.n < 0 || mark.n >= mark.d) return refuse("the mark is a phase from 0 up to (not including) 1, as a fraction in lowest terms");
  const ref = f.c.body;
  const k = (ref.k ?? 0) + epochEditK(mark, ref.mark); // a mark moved by μ turns moves the crossings as an epoch moved by −μ
  return putCrossing(ast, unitId, { ...f.c, body: withK({ ...ref, mark }, k) });
}

/** A day shift of every crossing (a sunset day start); K moves by the turns the shift crosses. 0 is written as absent. */
export function setCrossingOffset(ast: CalendarAst, unitId: string, offset: Rational): AstEdit {
  const f = bodyCrossing(ast, unitId);
  if (typeof f === "string") return refuse(f);
  if (!isReduced(offset)) return refuse("the shift is a fraction of a day in lowest terms");
  const ref = f.c.body;
  const was = ref.offset ?? { n: 0, d: 1 };
  const dk = safeK(nearestTurn(divB(subB(big(offset), big(was)), big(f.period))));
  const k = dk === null ? null : (ref.k ?? 0) + dk;
  if (k === null || !isInt(k)) return refuse("that shift needs numbers too large to count exactly");
  const { offset: _o, ...rest } = ref;
  return putCrossing(ast, unitId, { ...f.c, body: withK(offset.n === 0 ? rest : { ...rest, offset }, k) });
}

/**
 * Follow another body (same mark and shift): K is chosen so the new crossing 0
 * falls nearest the old one, so the occurrence numbers around it carry on.
 */
export function setCrossingBody(ast: CalendarAst, unitId: string, bodyId: string): AstEdit {
  const f = bodyCrossing(ast, unitId);
  if (typeof f === "string") return refuse(f);
  const ref = f.c.body;
  if (ref.id === bodyId) return { ast };
  const from = (ast.bodies ?? []).find((b) => b.id === ref.id)!;
  const to = (ast.bodies ?? []).find((b) => b.id === bodyId);
  if (!to) return refuse(`there is no body "${bodyId}"`);
  if (to.period.n < to.period.d) return refuse(`the body "${bodyId}" turns in less than a day, too fast for a unit to follow`);
  // crossing 0 was (φ − E + K)·P days after the shift; on the new body it is (φ − E' + K')·P': K' = round((φ − E + K)·P/P' − φ + E')
  const phi = big(ref.mark);
  const turns = addB(subB(phi, big(from.epoch)), { n: BigInt(ref.k ?? 0), d: 1n });
  const y = addB(subB(divB(mulB(turns, big(from.period)), big(to.period)), phi), big(to.epoch));
  const k = safeK(floorB(addB(y, { n: 1n, d: 2n }))); // round half up
  if (k === null) return refuse("following that body needs numbers too large to count exactly");
  return putCrossing(ast, unitId, { ...f.c, body: withK({ ...ref, id: bodyId }, k) });
}

/** A crossing written as numbers (`CROSSING:<period>@<at>`): its period (positive days) and the instant of crossing 0. */
export function setLiteralCrossing(ast: CalendarAst, unitId: string, next: { readonly period?: Rational; readonly at?: Rational }): AstEdit {
  const c = crossingOf(ast, unitId);
  if (typeof c === "string") return refuse(c);
  if (c.body) return refuse(`the ${unitId} follows the body "${c.body.id}"; change the body instead`);
  const period = next.period ?? c.period;
  const at = next.at ?? c.at;
  if (!isReduced(period) || !isReduced(at)) return refuse("a period and an instant are fractions in lowest terms");
  if (period.n <= 0) return refuse("a crossing period must be longer than 0 days");
  return putCrossing(ast, unitId, { ...c, period, at });
}

// ---- dated season marks

/** Why a season mark cannot be written into `seasons` of `ast`, or null. */
function markProblem(ast: CalendarAst, seasonsUnit: string, m: SeasonMarkAst): string | null {
  if (typeof m.name !== "string" || m.name.trim() === "") return "a season needs a name";
  if ("slot" in m) {
    const s = m.slot;
    const unit = ast.units.find((u) => u.id === s.unit);
    if (!unit || unit.kind !== "slots" || unit.in !== seasonsUnit) return `a season mark on a date names a unit directly in the ${seasonsUnit}; "${s.unit}" is not one`;
    if (!isInt(s.index) || s.index < 0 || s.index >= unit.slots.length) return `the ${s.unit} has no slot ${s.index + (unit.number ?? 1)}`;
    if (!isInt(s.day) || s.day < 1) return "a season starts on day 1 or later of its month";
    return null;
  }
  if ("day" in m) return isInt(m.day) && m.day >= 1 ? null : "a season starts on day 1 or later of the year";
  return typeof m.from === "number" && m.from >= 0 && m.from < 1 ? null : "a season starts at a fraction of the year from 0 up to (not including) 1";
}

/** A season mark written with only the fields of its kind. */
function cleanMark(m: SeasonMarkAst): SeasonMarkAst {
  if ("slot" in m) return { name: m.name, slot: { unit: m.slot.unit, index: m.slot.index, day: m.slot.day } };
  if ("day" in m) return { name: m.name, day: m.day };
  return { name: m.name, from: m.from };
}

/** Replace season mark `index`: a fraction of the year (`from`), a day of the year (`day`), or a day of a month (`slot`). */
export function setSeasonMark(ast: CalendarAst, index: number, mark: SeasonMarkAst): AstEdit {
  const s = ast.seasons;
  if (!s || !isInt(index) || index < 0 || index >= s.marks.length) return refuse(`there is no season ${index + 1}`);
  const why = markProblem(ast, s.unit, mark);
  if (why) return refuse(why);
  return { ast: { ...ast, seasons: { ...s, marks: s.marks.map((m, i) => (i === index ? cleanMark(mark) : m)) } } };
}

/** Add a season mark at the end (seasons over the year are created when there are none). */
export function addSeasonMark(ast: CalendarAst, mark: SeasonMarkAst): AstEdit {
  const unit = ast.seasons?.unit ?? "year";
  if (!ast.seasons && !cycleUnit(ast, unit)) return refuse("this calendar has no year for seasons to divide");
  const why = markProblem(ast, unit, mark);
  if (why) return refuse(why);
  return { ast: { ...ast, seasons: { unit, marks: [...(ast.seasons?.marks ?? []), cleanMark(mark)] } } };
}

/** Remove season mark `index`; removing the last one removes the seasons. */
export function removeSeasonMark(ast: CalendarAst, index: number): AstEdit {
  const s = ast.seasons;
  if (!s || !isInt(index) || index < 0 || index >= s.marks.length) return refuse(`there is no season ${index + 1}`);
  const marks = s.marks.filter((_, i) => i !== index);
  if (marks.length) return { ast: { ...ast, seasons: { ...s, marks } } };
  const { seasons: _s, ...rest } = ast;
  return { ast: rest };
}

// ---- a cycle unit's length and a slot unit's slots (slice 5b)

/**
 * A cycle unit's base length in days (its gear terms still add to it). A
 * crossing base has no length of its own: its occurrences run from one
 * crossing to the next.
 */
export function setCycleLength(ast: CalendarAst, unitId: string, length: number): AstEdit {
  const u = cycleUnit(ast, unitId);
  if (!u) return refuse(`there is no cycle unit "${unitId}"`);
  if (u.crossing) return refuse(`the ${unitId} starts by a crossing, so its length is the days from one crossing to the next`);
  if (!isInt(length) || length < 1) return refuse(`a ${unitId} of ${length} days; write a whole number of at least 1`);
  const next = withSlice(ast, `length:${unitId}`, length);
  return next ? { ast: next } : refuse(`there is no cycle unit "${unitId}"`);
}

/** Why a slot cannot be written, or null. */
function slotProblem(s: SlotAst): string | null {
  if (s.name !== undefined && (typeof s.name !== "string" || s.name.trim() === "")) return "a slot's name cannot be blank";
  if (typeof s.length === "number") {
    if (!isInt(s.length) || s.length < 0) return `a slot of ${s.length} days; write a whole number from 0 up`;
  } else if (s.length !== "slack" && !(typeof s.length === "object" && s.length.by === "parent")) return "a slot is a number of days, or takes the rest";
  if (s.length !== "slack" && (s.min !== undefined || s.max !== undefined || s.fill !== undefined)) return "only a slot that takes the rest has a fewest, a most or a fill order";
  for (const v of [s.min, s.max, s.fill]) if (v !== undefined && (!isInt(v) || v < 0)) return "a slot's fewest, most and fill order are whole numbers from 0 up";
  if (s.filler !== undefined && typeof s.filler !== "boolean") return "a slot is a filler or it is not";
  return null;
}

/** Whether slot unit `inner` sits (at any depth) inside slot unit `outer`. */
function inside(ast: CalendarAst, inner: string, outer: string): boolean {
  for (let u = slotUnit(ast, inner), n = 0; u && n < ast.units.length; u = slotUnit(ast, u.in), n++) if (u.in === outer) return true;
  return false;
}

/**
 * Why the slots of `unitId` cannot be added to, removed from or reordered, or
 * null: a rule reads the unit by number (it would then match other slots), or
 * an exception sets the lengths of this unit, or of one inside it, slot by
 * slot. A length, name or flag change keeps every slot's number and is never
 * refused here.
 */
export function slotOrderProblem(ast: CalendarAst, unitId: string): string | null {
  const reads = (r: RuleAst): boolean => (r.kind === "index" && r.unit === unitId) || childrenOf(r).some(reads);
  const rule = (ast.rules ?? []).find((r) => reads(r.rule));
  if (rule) return `the rule "${rule.name ?? rule.id}" reads the ${unitId} by number; change it first (Edit definition)`;
  for (const u of ast.units) {
    if (u.kind !== "cycle") continue;
    const e = (u.ledger ?? []).find((x) => x.kind === "slots" && (x.unit === unitId || inside(ast, x.unit, unitId)));
    if (e) return `an exception sets the ${e.kind === "slots" ? e.unit : unitId} lengths slot by slot; change it first (Exceptions)`;
  }
  return null;
}

/**
 * Set slot unit `unitId`'s slots. `from[i]` is the index in the current list
 * that slot i was, or null for a new slot (omitted: slot for slot). A season
 * mark on a slot of this unit follows its slot; a mark whose slot is gone
 * refuses the edit, naming the season. Adding, removing or reordering is
 * refused while `slotOrderProblem` names a reason. Whether the slots still
 * fill their parent is `problems()`'s to say (the caller runs it).
 */
export function setSlotUnit(ast: CalendarAst, unitId: string, slots: readonly SlotAst[], from?: ReadonlyArray<number | null>): AstEdit {
  const u = slotUnit(ast, unitId);
  if (!u) return refuse(`there is no slot unit "${unitId}"`);
  if (slots.length === 0) return refuse(`the ${unitId} needs at least one slot`);
  const was = from ?? slots.map((_, i) => i);
  if (was.length !== slots.length) return refuse("every slot needs to say where it came from");
  for (const s of slots) {
    const why = slotProblem(s);
    if (why) return refuse(why);
  }
  const reordered = was.length !== u.slots.length || was.some((f, i) => f !== i);
  if (reordered) {
    const why = slotOrderProblem(ast, unitId);
    if (why) return refuse(why);
  }
  let out: CalendarAst | null = withSlice(ast, `slots:${unitId}`, slots.map((s) => ({ ...s })));
  if (!out) return refuse(`there is no slot unit "${unitId}"`);
  const seasons = out.seasons;
  if (reordered && seasons?.marks.some((m) => "slot" in m && m.slot.unit === unitId)) {
    const marks: SeasonMarkAst[] = [];
    for (const m of seasons.marks) {
      if (!("slot" in m) || m.slot.unit !== unitId) {
        marks.push(m);
        continue;
      }
      const index = was.indexOf(m.slot.index);
      if (index < 0) {
        const name = u.slots[m.slot.index]?.name ?? `${unitId} ${m.slot.index + (u.number ?? 1)}`;
        return refuse(`the season ${m.name} starts in ${name}, so ${name} cannot be removed; change the season first`);
      }
      marks.push(index === m.slot.index ? m : { ...m, slot: { ...m.slot, index } });
    }
    out = withSlice(out, "marks", { ...seasons, marks });
    if (!out) return refuse("the season marks cannot follow their slots");
  }
  return { ast: out };
}
