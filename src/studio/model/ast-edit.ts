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
 *   unit's crossing, one cycle unit's constant length, its own gear terms
 *   (`feeds:`, slice 5c) or its ledger (`ledger:`), one slot unit's slots, or
 *   the season marks (a slot edit that moves slots also moves the marks that
 *   name them, so it touches two; a gear's rename or removal touches every
 *   slice that names it). Slices are how a Save replays the
 *   draft's edits onto the definition stored at Save time (definition.ts
 *   `mergeCalendar`): a slice the draft did not edit passes through as stored
 *   now, and a slice it did edit is refused when it changed in storage since,
 *   or when a part its edits read without writing did (`replayProblem`).
 * - A crossing that follows a body keeps its occurrence numbers: a moved mark
 *   or offset, or a different body, moves its K by the smallest shift (the
 *   rule `epochEditK` applies to an epoch edit, §16.7 P1). START changes the
 *   start day by less than one day, so K stays.
 */
import { canonicalJson } from "../../core/profile";
import { childrenOf, epochEditK, gearMatches, gearPeriod, ID, rational, type BodyRef, type By, type CalendarAst, type CrossingAst, type CycleUnitAst, type GearAst, type GearTerm, type LedgerEntry, type Rational, type RuleAst, type RuleDefAst, type SeasonMarkAst, type SeasonsAst, type SlotAst, type SlotsUnitAst, type StageAst, type UnitAst } from "../../seshat";

export type AstEdit = { readonly ast: CalendarAst } | { readonly refused: true; readonly reason: string };

const refuse = (reason: string): AstEdit => ({ refused: true, reason });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isReduced = (r: Rational): boolean => isInt(r.n) && isInt(r.d) && r.d > 0 && same(rational(r.n, r.d), { n: r.n, d: r.d });

// ---- slices

/**
 * One editable slice of a definition: a gear by id; a cycle unit's stages, crossing, constant length (`length:`),
 * own gear terms (`feeds:`) or ledger (`ledger:`) by unit id; a slot unit's slots (`slots:`) by unit id; or the
 * season marks.
 */
export type SliceKey = `gear:${string}` | `stages:${string}` | `crossing:${string}` | `length:${string}` | `feeds:${string}` | `ledger:${string}` | `slots:${string}` | "marks";

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
  if (kind === "feeds") return u.gears;
  if (kind === "ledger") return u.ledger;
  return kind === "stages" ? u.stages : u.crossing;
}

/** Every slice key either definition has, in a stable order: gears, then each cycle unit's stages, crossing, length, gear terms and ledger, each slot unit's slots, then the marks. */
function sliceKeys(a: CalendarAst, b: CalendarAst): SliceKey[] {
  const gears = [...new Set([...a.gears, ...b.gears].map((g) => g.id))];
  const units = [...new Set([...a.units, ...b.units].filter((u) => u.kind === "cycle").map((u) => u.id))];
  const slotted = [...new Set([...a.units, ...b.units].filter((u) => u.kind === "slots").map((u) => u.id))];
  return [...gears.map((id): SliceKey => `gear:${id}`), ...units.flatMap((id): SliceKey[] => [`stages:${id}`, `crossing:${id}`, `length:${id}`, `feeds:${id}`, `ledger:${id}`]), ...slotted.map((id): SliceKey => `slots:${id}`), "marks"];
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
  const field = kind === "stages" ? "stages" : kind === "feeds" ? "gears" : kind === "ledger" ? "ledger" : "crossing";
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
    units: units.map((u) => (u.kind === "cycle" ? (({ stages: _st, crossing: _c, length: _l, gears: _gt, ledger: _lg, ...x }) => ({ ...x, base: u.crossing ? "crossing" : "constant" }))(u) : (({ slots: _sl, ...x }) => x)(u))),
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

// ---- a gear's name, kind, feeds, and the gear itself (slice 5c)

/** The widest cycle a table of positions is switched to (the inspector's cycle-year grid). */
export const GEAR_TABLE_MAX = 400;

const mod = (a: number, m: number): number => {
  const r = a % m;
  return r < 0 ? r + m : r + 0;
};

/** What declares `id` (every id is one namespace: units, gears, rules, bodies), or null. */
function declaredAs(ast: CalendarAst, id: string): string | null {
  if (ast.units.some((u) => u.id === id)) return "unit";
  if (ast.gears.some((g) => g.id === id)) return "gear";
  if ((ast.rules ?? []).some((r) => r.id === id)) return "rule";
  if ((ast.bodies ?? []).some((b) => b.id === id)) return "body";
  return null;
}

/** `o` with `f` applied to each of its gear terms (null drops one); `o` itself when nothing changes. */
function withTerms<T extends { readonly gears?: readonly GearTerm[] }>(o: T, f: (t: GearTerm) => GearTerm | null): T {
  const was = o.gears;
  if (!was) return o;
  const next = was.flatMap((t) => {
    const r = f(t);
    return r ? [r] : [];
  });
  if (next.length === was.length && next.every((t, i) => t === was[i])) return o;
  const { gears: _g, ...rest } = o;
  return (next.length ? { ...rest, gears: next } : rest) as unknown as T;
}

/**
 * `ast` with `f` applied to every gear term it holds: a cycle unit's own, a
 * ledger switch's rule's, and each slot's. These are every place a definition
 * names a gear (rules, seasons and day labels never do).
 */
function mapTerms(ast: CalendarAst, f: (t: GearTerm) => GearTerm | null): CalendarAst {
  const units = ast.units.map((u): UnitAst => {
    if (u.kind === "slots") {
      const slots = u.slots.map((s) => withTerms(s, f));
      return slots.every((s, i) => s === u.slots[i]) ? u : { ...u, slots };
    }
    let next: CycleUnitAst = withTerms(u, f);
    const ledger = u.ledger;
    if (ledger) {
      const entries = ledger.map((e): LedgerEntry => {
        if (e.kind !== "switch") return e;
        const rule = withTerms(e.rule, f);
        return rule === e.rule ? e : { ...e, rule };
      });
      if (entries.some((e, i) => e !== ledger[i])) next = { ...next, ledger: entries };
    }
    return next;
  });
  return units.every((u, i) => u === ast.units[i]) ? ast : { ...ast, units };
}

/** The ledger switches whose rule reads gear `id`, each as "<unit> <displayed number>". */
export function switchesReading(ast: CalendarAst, id: string): string[] {
  return ast.units.flatMap((u) => (u.kind === "cycle" ? (u.ledger ?? []).flatMap((e) => (e.kind === "switch" && (e.rule.gears ?? []).some((t) => t.gear === id) ? [`${u.id} ${e.from + (u.number ?? 0)}`] : [])) : []));
}

const ID_WORDS = "lower-case letters, digits and hyphens, starting with a letter";

/**
 * Rename gear `from` to `to`, and every term that names it with it: the
 * cycle units' own terms, the ledger switches' rules and the slots (so the
 * rename reaches every slice that names the gear, and nothing else). An id
 * another part already declares is refused, naming that part's kind.
 */
export function renameGear(ast: CalendarAst, from: string, to: string): AstEdit {
  const g = gearOf(ast, from);
  if (typeof g === "string") return refuse(g);
  const id = to.trim();
  if (id === from) return { ast };
  if (!ID.test(id)) return refuse(`a gear's id is ${ID_WORDS}; "${id}" is not one`);
  const taken = declaredAs(ast, id);
  if (taken) return refuse(`the id "${id}" is already taken by a ${taken}; units, gears, rules and bodies share one list of ids`);
  const renamed: CalendarAst = { ...ast, gears: ast.gears.map((x) => (x.id === from ? { ...x, id } : x)) };
  return { ast: mapTerms(renamed, (t) => (t.gear === from ? { ...t, gear: id } : t)) };
}

/** Add `gear` after the others, its shape checked as the set edits check it. It feeds nothing yet. */
export function addGear(ast: CalendarAst, gear: GearAst): AstEdit {
  if (!ID.test(gear.id)) return refuse(`a gear's id is ${ID_WORDS}; "${gear.id}" is not one`);
  const taken = declaredAs(ast, gear.id);
  if (taken) return refuse(`the id "${gear.id}" is already taken by a ${taken}`);
  if (!cycleUnit(ast, gear.on)) return refuse(`a gear counts a cycle unit; "${gear.on}" is not one`);
  const placed: CalendarAst = { ...ast, gears: [...ast.gears, gear] };
  return gear.kind === "intervals" ? setGearIntervals(placed, gear.id, gear.terms) : setGearPositions(placed, gear.id, gear);
}

/**
 * Remove gear `id` and every term that names it (the lengths it fed lose what
 * it added). Refused while a ledger switch's rule reads it: that rule governs
 * years already counted, so it is changed in Exceptions first.
 */
export function removeGear(ast: CalendarAst, id: string): AstEdit {
  const g = gearOf(ast, id);
  if (typeof g === "string") return refuse(g);
  const reads = switchesReading(ast, id);
  if (reads.length) return refuse(`the rule change from ${reads[0]} reads the gear "${id}"; change it first (Exceptions)`);
  return { ast: mapTerms({ ...ast, gears: ast.gears.filter((x) => x.id !== id) }, (t) => (t.gear === id ? null : t)) };
}

/**
 * Switch gear `id` between a sum of intervals and a table of positions in a
 * cycle, matching the same indices: intervals become the table over their lcm
 * (at most GEAR_TABLE_MAX), and a table becomes one interval per position.
 */
export function setGearKind(ast: CalendarAst, id: string, kind: GearAst["kind"]): AstEdit {
  const g = gearOf(ast, id);
  if (typeof g === "string") return refuse(g);
  if (g.kind === kind) return { ast };
  if (g.kind === "intervals") {
    const period = gearPeriod(g);
    if (!isInt(period) || period > GEAR_TABLE_MAX) return refuse(`the gear repeats every ${period}; a table of positions holds a cycle of at most ${GEAR_TABLE_MAX}`);
    const positions: number[] = [];
    for (let n = 0; n < period; n++) {
      let sum = 0;
      for (const t of g.terms) if (mod(n - (t.offset ?? 0), t.every) === 0) sum += t.sign;
      if (sum !== 0 && sum !== 1) return refuse(`the terms count index ${n} ${sum} times; make them nest first`);
      if (gearMatches(g, n)) positions.push(n);
    }
    return { ast: putGear(ast, { id: g.id, on: g.on, kind: "positions", period, positions }) };
  }
  if (g.positions.length === 0) return refuse("the table marks no position; mark one first");
  const off = g.offset ?? 0;
  const terms = [...g.positions]
    .sort((a, b) => a - b)
    .map((p) => {
      const offset = mod(p + off, g.period);
      return { every: g.period, ...(offset ? { offset } : {}), sign: 1 as const };
    });
  return { ast: putGear(ast, { id: g.id, on: g.on, kind: "intervals", terms }) };
}

/**
 * Gear `gearId` adds `add` days to cycle unit `unitId`'s length when it
 * engages, or (null) no longer does. A gear lengthens only the unit it counts
 * (or a slot inside it, which is a slot edit). 0 days is kept as written.
 */
export function setGearFeed(ast: CalendarAst, gearId: string, unitId: string, add: number | null): AstEdit {
  const g = gearOf(ast, gearId);
  if (typeof g === "string") return refuse(g);
  const u = cycleUnit(ast, unitId);
  if (!u) return refuse(`there is no cycle unit "${unitId}"`);
  const was = u.gears ?? [];
  let terms: GearTerm[];
  if (add === null) terms = was.filter((t) => t.gear !== gearId);
  else {
    if (g.on !== unitId) return refuse(`the gear "${gearId}" counts the ${g.on}, so it lengthens the ${g.on} or a slot inside it, not the ${unitId}`);
    if (!isInt(add)) return refuse(`a gear adds ${String(add)} days; write a whole number`);
    const at = was.findIndex((t) => t.gear === gearId);
    terms = at < 0 ? [...was, { gear: gearId, add }] : was.map((t, i) => (i === at ? { ...t, add } : t));
  }
  const next = withSlice(ast, `feeds:${unitId}`, terms.length ? terms : undefined);
  return next ? { ast: next } : refuse(`there is no cycle unit "${unitId}"`);
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
 * Every `recur` filter in the named rules, with its rule. Named rules are the
 * only place a definition holds a RuleAst (stages and ledger switches carry
 * start rules, which read no slot), and `recur` is the only kind that reads a
 * slot unit by number, by day or by name (`index` reads a cycle unit only:
 * validate.ts checkRule).
 */
function filtersIn(ast: CalendarAst): Array<{ rule: RuleDefAst; by: By }> {
  const out: Array<{ rule: RuleDefAst; by: By }> = [];
  const walk = (rule: RuleDefAst, r: RuleAst, depth: number): void => {
    if (depth > 256 || typeof r !== "object" || r === null) return;
    if (r.kind === "recur" && Array.isArray(r.by)) for (const by of r.by as readonly By[]) if (typeof by === "object" && by !== null) out.push({ rule, by });
    for (const c of childrenOf(r)) walk(rule, c, depth + 1);
  };
  for (const rule of ast.rules ?? []) walk(rule, rule.rule, 0);
  return out;
}

const ruleName = (r: RuleDefAst): string => r.name ?? r.id;

/** Whether a filter or an exception on `unit` counts the slots of `unitId` (the unit itself, or one inside it, whose numbering an order change moves). */
const countsIn = (ast: CalendarAst, unit: string, unitId: string): boolean => unit === unitId || inside(ast, unit, unitId);

/**
 * Why the slots of `unitId` cannot be added to, removed from or reordered, or
 * null: a rule reads the unit (or one inside it) by number or by day (BYNTH,
 * BYDAY: it would then match other slots), or an exception sets the lengths of
 * this unit, or of one inside it, slot by slot. A length, name or flag change
 * keeps every slot's number and is never refused here (a name a rule matches
 * is `slotLabelProblem`'s).
 */
export function slotOrderProblem(ast: CalendarAst, unitId: string): string | null {
  const f = filtersIn(ast).find(({ by }) => !("label" in by) && typeof by.unit === "string" && countsIn(ast, by.unit, unitId));
  if (f) return `the rule "${ruleName(f.rule)}" reads the ${f.by.unit} ${"nth" in f.by ? "by number" : "by its days"}; change it first (Edit definition)`;
  for (const u of ast.units) {
    if (u.kind !== "cycle") continue;
    const e = (u.ledger ?? []).find((x) => x.kind === "slots" && countsIn(ast, x.unit, unitId));
    if (e) return `an exception sets the ${e.kind === "slots" ? e.unit : unitId} lengths slot by slot; change it first (Exceptions)`;
  }
  return null;
}

/** Whether slot `s` carries label `x` as a rule's label filter reads it (a name, or "#tag"). */
const labelled = (s: SlotAst, x: string): boolean => (x.startsWith("#") ? (s.tags?.includes(x.slice(1)) ?? false) : s.name === x);

/**
 * Why `unitId`'s slots cannot become `slots` (`from[i]`: the index slot i had, null for a new one), or null: a
 * rule's label filter (BYLABEL) names a slot of the unit, and the edit would change which slots carry that name
 * or tag (a rename away from it or onto it, a removal, a new slot carrying it). A move keeps the matches (the
 * filter follows the name). Refused rather than renaming the filter with it: the rules are no slice a Save
 * replays, and one filter may list several names.
 */
export function slotLabelProblem(ast: CalendarAst, unitId: string, slots: readonly SlotAst[], from: ReadonlyArray<number | null>): string | null {
  const u = slotUnit(ast, unitId);
  if (!u) return null;
  for (const { rule, by } of filtersIn(ast)) {
    if (!("label" in by) || by.unit !== unitId || !Array.isArray(by.label)) continue;
    for (const x of by.label) {
      if (typeof x !== "string") continue;
      const before = u.slots.flatMap((s, j) => (labelled(s, x) ? [j] : []));
      const after = slots.flatMap((s, i) => (labelled(s, x) ? [from[i] ?? -1] : [])).sort((a, b) => a - b);
      if (!same(after, before)) return `the rule "${ruleName(rule)}" reads the ${unitId} named "${x}"; change it first (Edit definition)`;
    }
  }
  return null;
}

/**
 * What outside `unitId`'s own slots depends on their numbers or names: the rules' filters on the unit (or one
 * inside it), the exceptions that set its lengths (or those of one inside it) slot by slot, and (`marks`) the
 * season marks on its days. A Save replays a slot edit only while these are as the edit saw them.
 */
export function slotReferences(ast: CalendarAst, unitId: string, marks = true): unknown {
  return {
    filters: filtersIn(ast)
      .filter(({ by }) => typeof by.unit === "string" && countsIn(ast, by.unit, unitId))
      .map(({ rule, by }) => [rule.id, by]),
    ledger: ast.units.flatMap((u) => (u.kind === "cycle" ? (u.ledger ?? []).filter((e) => e.kind === "slots" && countsIn(ast, e.unit, unitId)).map((e) => [u.id, e]) : [])),
    marks: marks ? (ast.seasons?.marks ?? []).filter((m) => "slot" in m && m.slot.unit === unitId) : [],
  };
}

/** Whether any gear term in `ast` names gear `id`. */
function termsNaming(ast: CalendarAst, id: string): boolean {
  let found = false;
  mapTerms(ast, (t) => {
    if (t.gear === id) found = true;
    return t;
  });
  return found;
}

/**
 * Why slice `key`, edited in `draft` from `base`, cannot be replayed onto the definition stored at Save time
 * (`stored`; `out` is it with the draft's slices replayed, this one included), or null. Each slice's edits were
 * checked against what the draft held of parts they read but do not write; when storage moved one of those since
 * the seed, the replay would bind differently (a slot by number, a mark by index, a K by a body's period), so the
 * Save is stale rather than silently wrong. A term naming a missing gear, which `problems()` refuses anyway, is
 * answered here too, so the Save says why.
 *
 * - `slots:u`: the rules, exceptions and season marks that read u's slots (`slotReferences`);
 * - `marks`: the slots of each unit a dated mark names;
 * - `crossing:u`: the bodies its K was chosen against;
 * - `gear:g`: the terms naming g (after a rename or a removal), the other ids (an added gear);
 * - `feeds:u`, `ledger:u`: each term's gear still counting u;
 * - `stages:u`, `length:u`: nothing outside the slice.
 */
export function replayProblem(key: SliceKey, base: CalendarAst, draft: CalendarAst, stored: CalendarAst, out: CalendarAst): string | null {
  const moved = "changed outside the studio since this edit";
  if (key === "marks") {
    const units = new Set([...(draft.seasons?.marks ?? []), ...(base.seasons?.marks ?? [])].flatMap((m) => ("slot" in m ? [m.slot.unit] : [])));
    for (const u of units) if (!same(sliceOf(stored, `slots:${u}`), sliceOf(base, `slots:${u}`))) return `a season starts on a day of the ${u}, whose slots ${moved}`;
    return null;
  }
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if (kind === "slots") return same(slotReferences(stored, id), slotReferences(base, id)) ? null : `a rule, an exception or a season that reads the ${id} ${moved}`;
  if (kind === "crossing") {
    const followed = new Set([base, draft].flatMap((a) => {
      const b = cycleUnit(a, id)?.crossing?.body;
      return b ? [b.id] : [];
    }));
    const body = (a: CalendarAst, b: string) => (a.bodies ?? []).find((x) => x.id === b);
    for (const b of followed) if (!same(body(stored, b), body(base, b))) return `the ${id} follows the body "${b}", which ${moved}`;
    return null;
  }
  if (kind === "gear") {
    const mine = draft.gears.some((g) => g.id === id);
    if (!mine && termsNaming(out, id)) return `the gear "${id}" is renamed or removed here, and a term naming it was added outside the studio since this edit`;
    if (mine && !base.gears.some((g) => g.id === id)) {
      const taken = declaredAs({ ...stored, gears: [] }, id);
      if (taken) return `the id "${id}" was taken by a ${taken} outside the studio since this edit`;
    }
    return null;
  }
  if (kind === "feeds" || kind === "ledger") {
    const u = cycleUnit(out, id);
    const terms = kind === "feeds" ? (u?.gears ?? []) : (u?.ledger ?? []).flatMap((e) => (e.kind === "switch" ? (e.rule.gears ?? []) : []));
    const off = terms.find((t) => {
      const g = out.gears.find((x) => x.id === t.gear);
      return g !== undefined && g.on !== id;
    });
    if (off) return `the gear "${off.gear}" no longer counts the ${id}; it ${moved}`;
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
  const named = slotLabelProblem(ast, unitId, slots, was);
  if (named) return refuse(named);
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
