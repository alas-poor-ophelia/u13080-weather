/**
 * The Orrery's pure model (docs/SESHAT-v0.md §18, bead wadjet-b6x; design
 * handoff design_handoff_seshat_orrery, mapping table and geometry v0): the
 * stored CalendarAst plus a day become the parts list, a 3D segment list with
 * states, label anchors, pick points and the inspector's NOW readout. The
 * canvas layer (ui/orrery-canvas.ts, a later slice) only projects and paints;
 * projection, picking and label layout are pure functions here too.
 *
 * - Every per-day fact comes from the real engine (Engine, EngineDays, the
 *   format and season resolvers), never a mirror. Geometry constants are the
 *   handoff's.
 * - Per-calendar state (the Engine, which validates on construction: about
 *   200 ms cold for Hebrew) and per-year facts are memoised by AST identity
 *   and year (§18.3 D7), so a frame rebuilds segments only.
 * - A missing or faulted definition is a typed "nothing to draw" result,
 *   never a throw (§18.6 item 3).
 * - LEDs: `problemsByPart` maps `problems(ast)` locations to part ids. The
 *   caller debounces `problems()` (§18.6 item 7: on drag end or a 200 ms
 *   trailing debounce, the last verdict shown as stale meanwhile); this module
 *   only memoises it by AST identity.
 */
import { DAY_LIMIT, Engine, formatDay, gearBelow, gearMatches, gearPeriod, isDateMark, printPart, problems, toNumber, type BodyAst, type CalendarAst, type CycleUnitAst, type GearAst, type PartId, type Problem, type Rational, type SlotsUnitAst, type StartTrace, type UnitAst } from "../../seshat";
import { followSentence, skipsOf } from "../../plugin/time/form";

const TAU = Math.PI * 2;
const mod = (a: number, m: number): number => ((a % m) + m) % m;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A segment's own state (the handoff's: grid .1, dim .42, ghost .6 dashed, line .85, err/hot 1.5 px). */
export type SegState = "grid" | "dim" | "ghost" | "line" | "err" | "hot";
/** What the canvas strokes: a segment's state, promoted to `sel` (1.8 px) when its part is selected or hovered. */
export type PaintState = SegState | "sel";
export type Vec3 = readonly [number, number, number];

export interface Segment {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly state: SegState;
  /** null for scenery (the floor grid, the plinth) */
  readonly part: PartId | null;
}

export interface LabelAnchor {
  readonly p: Vec3;
  readonly text: string;
  readonly state: Exclude<SegState, "grid" | "err">;
  readonly part: PartId | null;
  /** lower places first; absent means by state (sel 0, hot 1, line 2, ghost 3, dim 4); the index date is -1 */
  readonly priority?: number;
  /** shown only while its part is selected or hovered */
  readonly onlySelected?: boolean;
}

export interface PickPoint {
  readonly p: Vec3;
  readonly part: PartId;
}

export interface PartRow {
  readonly id: PartId;
  readonly name: string;
  readonly spec: string;
  /** active this year (white LED) */
  readonly lit: boolean;
  /** problems located on this part (red LED when > 0) */
  readonly issues: number;
}

export interface PartGroup {
  readonly label: string;
  readonly rows: readonly PartRow[];
  /** what the group's ＋ adds, when it has one */
  readonly add?: "body" | "cycle" | "gear" | "stage" | "season";
}

export interface NowRow {
  readonly key: string;
  readonly value: string;
  readonly tone?: "on" | "off" | "err";
}

/** The inspector's header and NOW readout for one part (or the whole calendar). */
export interface PartInfo {
  readonly code: string;
  readonly title: string;
  readonly sub: string;
  readonly now: readonly NowRow[];
}

/** One slot unit's lengths inside one occurrence of its parent, in the shown year. */
export interface SlotTable {
  readonly unit: string;
  /** the parent occurrence, from the year down: [year index] for a month, [year index, month] for a tenday */
  readonly path: readonly number[];
  readonly lengths: readonly number[];
}

export interface SeasonMarkFact {
  readonly name: string;
  /** declaration index in the stored marks */
  readonly order: number;
  readonly kind: "fraction" | "day" | "slot";
  /** 0-based day of the year the mark falls on (the engine's resolution) */
  readonly at: number;
  /** where it sits on the bezel, a fraction of the year: `from` for a fraction mark, at / length for a date */
  readonly phase: number;
}

/** A ledger set-screw (§18.3 D8, §18.6 item 11): one per entry that touches the shown year. */
export interface LedgerScrew {
  readonly part: PartId;
  readonly kind: "starts" | "switch" | "slots" | "day" | "skip";
  /** the day it names, for a day label or a skip; otherwise it sits on the year post */
  readonly day?: number;
  /** "rule changes from year N" for a switch; the label's name for a day */
  readonly tag: string;
}

/** Per-year facts (§18.3 D7), memoised by AST identity and year index. */
export interface YearFacts {
  readonly unit: string;
  readonly index: number;
  /** index + the unit's NUMBER */
  readonly number: number;
  readonly start: number;
  readonly length: number;
  readonly trace: StartTrace & { readonly start: number; readonly pinned: boolean; readonly switched: boolean };
  readonly slots: readonly SlotTable[];
  /** resolved marks sorted by day; empty without seasons over this unit */
  readonly seasons: readonly SeasonMarkFact[];
  readonly ledger: readonly LedgerScrew[];
  /** gear id → engaged in this year (the gear read at its own unit's occurrence holding the year's first day) */
  readonly gears: ReadonlyMap<string, boolean>;
}

/** Per-day facts, from the engine. */
export interface DayFacts {
  readonly day: number;
  readonly dayOfYear: number;
  /** unit id → occurrence index and days into it (a slot's index in its parent); null in an enclosing filler */
  readonly positions: ReadonlyMap<string, { readonly index: number; readonly offset: number; readonly start: number; readonly length: number } | null>;
  /** body id → phase in [0, 1) at the start of the day */
  readonly bodies: ReadonlyMap<string, number>;
  /** rule id → does it hold today ("error" when it throws) */
  readonly rules: ReadonlyMap<string, boolean | "error">;
  readonly season: string | null;
  /** the default format (or the adapter's "Year N, day d (Season)" without formats) */
  readonly date: string;
  readonly formats: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}

export interface OrreryModel {
  readonly kind: "orrery";
  readonly ast: CalendarAst;
  /** the fractional transport day, clamped to the day line */
  readonly day: number;
  readonly clamped: boolean;
  readonly year: YearFacts;
  readonly today: DayFacts;
  /** the year ring's turn: the fixed index (angle π) reads the day */
  readonly rotation: number;
  readonly groups: readonly PartGroup[];
  readonly segments: readonly Segment[];
  readonly labels: readonly LabelAnchor[];
  readonly picks: readonly PickPoint[];
}

/** Nothing to draw: no definition, or one that cannot run (the Orrery shows its read-only state). */
export interface OrreryEmpty {
  readonly kind: "empty";
  readonly reason: "none" | "fault";
  readonly message: string;
  readonly problems: readonly Problem[];
}

// ---------------------------------------------------------------------------
// Geometry constants (the handoff's v0)
// ---------------------------------------------------------------------------

export const GEOMETRY = {
  floorY: -0.16,
  plinthR: 1.32,
  plinthTop: -0.02,
  bezelIn: 1.18,
  bezelOut: 1.27,
  ringTop: 0.3,
  ringBottom: 0.25,
  ringOuter: 1.0,
  ringInner: 0.9,
  bandOuter: 0.86,
  bandWidth: 0.06,
  bandStep: 0.09,
  bodyR: 0.62,
  bodyY: 1.15,
  bodyStep: 0.12,
  gearR: 1.86,
  /** the fixed index: the front of the machine */
  index: Math.PI,
} as const;

// ---------------------------------------------------------------------------
// Preparation and memo (§18.3 D7)
// ---------------------------------------------------------------------------

interface Prepared {
  readonly kind: "prepared";
  readonly engine: Engine;
  readonly ast: CalendarAst;
  /** the year: "year" when it is a cycle, else the first cycle unit that slot units sit in, else the first cycle */
  readonly yearUnit: CycleUnitAst;
  /** the same unit as resolved (crossings as numbers) */
  readonly yearResolved: CycleUnitAst;
  /** slot units under the year, parents before children */
  readonly slotUnits: readonly SlotsUnitAst[];
  readonly years: Map<number, YearFacts>;
  readonly days: Map<number, DayFacts>;
}

const YEAR_MEMO = 64;
const DAY_MEMO = 512;
const prepared = new WeakMap<CalendarAst, Prepared | OrreryEmpty>();
const problemMemo = new WeakMap<CalendarAst, readonly Problem[]>();

/** `problems(ast)`, memoised by AST identity (§18.3 D3). Run it debounced: Hebrew costs about 200 ms cold. */
export function orreryProblems(ast: CalendarAst): readonly Problem[] {
  let p = problemMemo.get(ast);
  if (!p) problemMemo.set(ast, (p = safeProblems(ast)));
  return p;
}

function safeProblems(ast: CalendarAst): readonly Problem[] {
  try {
    return problems(ast);
  } catch (e) {
    return [{ message: e instanceof Error ? e.message : String(e) }];
  }
}

function prepare(ast: CalendarAst | null | undefined): Prepared | OrreryEmpty {
  if (!ast) return { kind: "empty", reason: "none", message: "no calendar definition", problems: [] };
  const hit = prepared.get(ast);
  if (hit) return hit;
  let out: Prepared | OrreryEmpty;
  try {
    const engine = new Engine(ast);
    const cycles = ast.units.filter((u): u is CycleUnitAst => u.kind === "cycle");
    const named = cycles.find((u) => u.id === "year");
    const yearUnit = named ?? cycles.find((c) => ast.units.some((u) => u.kind === "slots" && u.in === c.id)) ?? cycles[0];
    if (!yearUnit) throw new RangeError("the calendar has no cycle unit to draw as its year");
    const slotUnits: SlotsUnitAst[] = [];
    const under = new Set([yearUnit.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const u of ast.units)
        if (u.kind === "slots" && under.has(u.in) && !under.has(u.id)) {
          slotUnits.push(u);
          under.add(u.id);
          grew = true;
        }
    }
    out = { kind: "prepared", engine, ast, yearUnit, yearResolved: engine.ast.units.find((u) => u.id === yearUnit.id) as CycleUnitAst, slotUnits, years: new Map(), days: new Map() };
  } catch (e) {
    const found = orreryProblems(ast);
    out = { kind: "empty", reason: "fault", message: found[0]?.message ?? (e instanceof Error ? e.message : String(e)), problems: found };
  }
  prepared.set(ast, out);
  return out;
}

function remember<K, V>(m: Map<K, V>, cap: number, k: K, make: () => V): V {
  const v = m.get(k);
  if (v !== undefined) return v;
  if (m.size >= cap) m.delete(m.keys().next().value!);
  const made = make();
  m.set(k, made);
  return made;
}

/** The facts of year `index` (an occurrence index of the drawn year unit), memoised; null for a definition that cannot run. */
export function yearFacts(ast: CalendarAst, index: number): YearFacts | null {
  const p = prepare(ast);
  if (p.kind === "empty") return null;
  try {
    return remember(p.years, YEAR_MEMO, index, () => buildYear(p, index));
  } catch {
    return null; // past the day line, or not a whole index
  }
}

const longMemo = new WeakMap<CalendarAst, Map<string, number>>();

/**
 * Years in one INDEX cycle (L years) that read more crossings than the
 * fewest, each read through the engine's own start trace; memoised per AST
 * and unit.
 */
function longYears(p: Prepared, unit: string, L: number): number {
  let m = longMemo.get(p.ast);
  if (!m) longMemo.set(p.ast, (m = new Map<string, number>()));
  let n = m.get(unit);
  if (n === undefined) {
    const at = Array.from({ length: L + 1 }, (_, j) => p.engine.startTrace(unit, j).baseIndex);
    const steps = at.slice(1).map((x, j) => x - at[j]!);
    const fewest = Math.min(...steps);
    n = steps.filter((s) => s > fewest).length;
    m.set(unit, n);
  }
  return n;
}

function buildYear(p: Prepared, k: number): YearFacts {
  const e = p.engine;
  const y = p.yearUnit;
  if (!Number.isSafeInteger(k)) throw new RangeError(`year ${k} is not a whole index`);
  const start = e.start(y.id, k);
  const length = e.start(y.id, k + 1) - start;
  // the engine's starts are closed form far past the day line; the Orrery reads only years that touch it
  if (start > DAY_LIMIT || start + length - 1 < -DAY_LIMIT) throw new RangeError(`year ${k} lies past the day line`);
  // slot tables, parents first: a filler or empty parent slot holds nothing
  const slots: SlotTable[] = [];
  for (const u of p.slotUnits) {
    const parents = u.in === y.id ? [{ path: [k] }] : slots.filter((t) => t.unit === u.in).flatMap((t) => t.lengths.flatMap((len, i) => (len > 0 && !slotOf(p.ast, u.in, i)?.filler ? [{ path: [...t.path, i] }] : [])));
    for (const { path } of parents) {
      try {
        slots.push({ unit: u.id, path, lengths: e.slotLengths(u.id, path) });
      } catch {
        // past the day line: drawn without this table
      }
    }
  }
  const seasons: SeasonMarkFact[] = [];
  const s = p.ast.seasons;
  if (s && s.unit === y.id) {
    for (const r of e.seasonCalendar()?.year(k, true) ?? []) {
      const m = s.marks[r.order]!;
      const kind = !isDateMark(m) ? "fraction" : "day" in m ? "day" : "slot";
      seasons.push({ name: r.name, order: r.order, kind, at: r.at, phase: "from" in r && typeof r.from === "number" ? r.from : r.at / length });
    }
  }
  const gears = new Map<string, boolean>();
  for (const g of p.ast.gears) gears.set(g.id, gearOn(p, g, start));
  return { unit: y.id, index: k, number: k + (y.number ?? 0), start, length, trace: e.startTrace(y.id, k), slots, seasons, ledger: screws(p, k, start, length), gears };
}

function slotOf(ast: CalendarAst, unit: string, i: number) {
  const u = ast.units.find((x) => x.id === unit);
  return u?.kind === "slots" ? u.slots[i] : undefined;
}

/** A gear is read at the occurrence of its own unit (§2.4): the year's for a year gear. */
function gearOn(p: Prepared, g: GearAst, day: number): boolean {
  try {
    return gearMatches(g, p.engine.occurrenceAt(g.on, day)!.index);
  } catch {
    return false;
  }
}

function screws(p: Prepared, k: number, start: number, length: number): LedgerScrew[] {
  const out: LedgerScrew[] = [];
  const number = (n: number) => n + (p.yearUnit.number ?? 0);
  const ledger = p.yearUnit.ledger ?? [];
  const inForce = ledger.reduce((at, e, i) => (e.kind === "switch" && e.from <= k ? i : at), -1);
  ledger.forEach((e, i) => {
    const part: PartId = `ledger:${p.yearUnit.id}:${i}`;
    if (e.kind === "starts" && k >= e.from && k <= e.from + (e.lengths?.length ?? 0)) out.push({ part, kind: "starts", tag: `start pinned · D${p.engine.start(p.yearUnit.id, k)}` });
    if (e.kind === "switch" && i === inForce) out.push({ part, kind: "switch", tag: `rule changes from year ${number(e.from)}` });
    if (e.kind === "slots" && e.from === k) out.push({ part, kind: "slots", tag: `${e.unit} lengths set` });
  });
  const end = start + length;
  (p.ast.days ?? []).forEach((d, i) => {
    if (d.day >= start && d.day < end) out.push({ part: `day:${i}`, kind: "day", day: d.day, tag: d.name ?? (d.tags ?? []).join(", ") });
  });
  for (const r of p.ast.rules ?? []) for (const d of skipsOf(r.rule).days) if (d >= start && d < end) out.push({ part: `rule:${r.id}`, kind: "skip", day: d, tag: `${r.name ?? r.id} skips` });
  return out;
}

/** The facts of one whole day, memoised; null for a definition that cannot run. */
export function dayFacts(ast: CalendarAst, day: number): DayFacts | null {
  const p = prepare(ast);
  if (p.kind === "empty") return null;
  try {
    return remember(p.days, DAY_MEMO, day, () => buildDay(p, day));
  } catch {
    return null; // past the day line, or not a whole day
  }
}

function buildDay(p: Prepared, day: number): DayFacts {
  if (!Number.isSafeInteger(day) || Math.abs(day) > DAY_LIMIT) throw new RangeError(`day ${day} is not a whole day within ±${DAY_LIMIT}`);
  const e = p.engine;
  const positions = new Map<string, { index: number; offset: number; start: number; length: number } | null>();
  for (const u of p.ast.units) {
    const o = e.occurrenceAt(u.id, day);
    positions.set(u.id, o && { index: o.index, offset: day - o.start, start: o.start, length: o.length });
  }
  const bodies = new Map<string, number>();
  for (const b of p.ast.bodies ?? []) bodies.set(b.id, e.bodyPhase(b.id, day)!);
  const rules = new Map<string, boolean | "error">();
  (e.ast.rules ?? []).forEach((r, i) => {
    try {
      rules.set(r.id, e.days.named(i, day));
    } catch {
      rules.set(r.id, "error");
    }
  });
  const season = e.seasonAt(day);
  const year = positions.get(p.yearUnit.id)!;
  const fmt = (name?: string): string => {
    try {
      return formatDay(e, day, name);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  // without formats, the adapter's own wording (SeshatCalendar.format)
  const date = p.ast.formats?.length ? fmt() : `Year ${year.index + (p.yearUnit.number ?? 0)}, day ${year.offset + 1}${season ? ` (${season})` : ""}`;
  return {
    day,
    dayOfYear: year.offset,
    positions,
    bodies,
    rules,
    season,
    date,
    formats: (p.ast.formats ?? []).map((f) => ({ name: f.name, text: fmt(f.name) })),
  };
}

// ---------------------------------------------------------------------------
// LEDs (§18.3 D3)
// ---------------------------------------------------------------------------

/** The part a problem is about: its most specific location; a problem with none is about the calendar. */
export function problemPart(p: Problem): PartId {
  if (p.unit !== undefined && p.entry !== undefined) return `ledger:${p.unit}:${p.entry}`;
  if (p.unit !== undefined) return `unit:${p.unit}`;
  if (p.gear !== undefined) return `gear:${p.gear}`;
  if (p.body !== undefined) return `body:${p.body}`;
  if (p.rule !== undefined) return `rule:${p.rule}`;
  if (p.day !== undefined) return `day:${p.day}`;
  return "calendar";
}

/** Problems by the part they light, in order. */
export function problemsByPart(found: readonly Problem[]): Map<PartId, Problem[]> {
  const out = new Map<PartId, Problem[]>();
  for (const p of found) {
    const k = problemPart(p);
    const l = out.get(k);
    if (l) l.push(p);
    else out.set(k, [p]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** the last (debounced) verdict of `orreryProblems`, for the list's LEDs */
  readonly problems?: readonly Problem[];
}

/** The day the transport may show: whole days within ±DAY_LIMIT, keeping the fraction inside it. */
export function clampDay(day: number): { day: number; clamped: boolean } {
  if (!Number.isFinite(day)) return { day: 0.5, clamped: true };
  if (day < -DAY_LIMIT) return { day: -DAY_LIMIT + 0.5, clamped: true };
  if (day >= DAY_LIMIT + 1) return { day: DAY_LIMIT + 0.5, clamped: true };
  return { day, clamped: false };
}

/**
 * The Orrery for `ast` on transport day `day` (fractional: the crank and the
 * wheels' easing read the fraction; every fact reads the whole day). Never
 * throws for a missing or faulted definition.
 */
export function buildOrrery(ast: CalendarAst | null | undefined, day: number, opts: BuildOptions = {}): OrreryModel | OrreryEmpty {
  const p = prepare(ast);
  if (p.kind === "empty") return p;
  const c = clampDay(day);
  const d = Math.floor(c.day);
  try {
    const today = dayFacts(p.ast, d)!;
    const year = yearFacts(p.ast, p.engine.occurrenceAt(p.yearUnit.id, d)!.index)!;
    const yp = Math.max(0, Math.min(0.99999, (c.day - year.start) / year.length));
    const rotation = GEOMETRY.index - TAU * yp;
    const g = drawMachine(p, year, today, c.day, yp, rotation);
    return { kind: "orrery", ast: p.ast, day: c.day, clamped: c.clamped, year, today, rotation, groups: partGroups(p, year, today, opts.problems ?? []), ...g };
  } catch (e) {
    return { kind: "empty", reason: "fault", message: e instanceof Error ? e.message : String(e), problems: opts.problems ?? [] };
  }
}

// ---- parts list

const ratDays = (r: Rational) => `${toNumber(r).toFixed(2)} d`;
const signed = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/** d·h·parts (1/1080 h) of a period in days. */
export function dhp(days: number): string {
  const p = Math.round(days * 25920);
  return `${Math.floor(p / 25920)}d ${Math.floor((p % 25920) / 1080)}h ${p % 1080}p`;
}

function gearSpec(g: GearAst): string {
  return g.kind === "positions" ? `${g.positions.length} of ${g.period}` : g.terms.map((t) => `${t.sign > 0 ? "+" : "−"}${t.every}`).join(" ");
}

function lengthRange(p: Prepared, k: number): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = k - 9; j <= k + 9; j++) {
    const len = p.engine.length(p.yearUnit.id, j);
    lo = Math.min(lo, len);
    hi = Math.max(hi, len);
  }
  return lo === hi ? `${lo} d` : `${lo}–${hi} d`;
}

function unitSpec(p: Prepared, u: UnitAst, year: YearFacts): string {
  if (u.kind === "slots") {
    const fill = u.slots.filter((s) => s.filler).length;
    const reg = u.slots.length - fill;
    const first = u.slots[0]?.length;
    if (u.in !== p.yearUnit.id && typeof first === "number" && u.slots.every((s) => s.length === first)) return `${u.slots.length} × ${first}`;
    return fill ? `${reg} + ${fill} filler` : `${reg}`;
  }
  if (u.id === p.yearUnit.id) {
    if (u.crossing || u.stages?.length || u.ledger?.length) return lengthRange(p, year.index);
    const adds = (u.gears ?? []).map((t) => signed(t.add)).join(" ");
    return `${u.length}${adds ? ` ${adds}` : ""} d`;
  }
  if (u.labels?.length) return `${u.labels.length} labels`;
  return u.crossing ? "follows a crossing" : `${u.length} d`;
}

function partGroups(p: Prepared, year: YearFacts, today: DayFacts, found: readonly Problem[]): PartGroup[] {
  const issues = problemsByPart(found);
  const row = (id: PartId, name: string, spec: string, lit = false): PartRow => ({ id, name, spec, lit, issues: issues.get(id)?.length ?? 0 });
  const ast = p.ast;
  const cycles = ast.units.filter((u): u is CycleUnitAst => u.kind === "cycle");
  const groups: PartGroup[] = [{ label: "DRIVE", rows: [row("dayline", "day line", `D${today.day}`)] }];
  groups.push({ label: "BODIES · C1", add: "body", rows: (ast.bodies ?? []).map((b) => row(`body:${b.id}`, b.moon?.name ?? b.id, ratDays(b.period))) });
  const crossing: PartRow[] = [];
  for (const u of cycles) {
    if (!u.crossing) continue;
    const pos = today.positions.get(u.id);
    const first = pos?.offset === 0;
    const body = u.crossing.body;
    const resolved = p.engine.ast.units.find((x) => x.id === u.id) as CycleUnitAst;
    crossing.push(row(`crossing:${u.id}`, body ? `${u.id} · follows ${bodyName(ast, body.id)}` : `${u.id} · crossing`, dhp(toNumber(resolved.crossing!.period!)), first));
    if (u.crossing.index) crossing.push(row(`train:${u.id}`, `${u.id} · train`, `${u.crossing.index.a} : ${u.crossing.index.L}`));
  }
  if (crossing.length) groups.push({ label: "CROSSING · YEAR BASE", rows: crossing });
  groups.push({ label: "UNITS · C2", add: "cycle", rows: [p.yearUnit, ...p.slotUnits, ...cycles.filter((u) => u !== p.yearUnit), ...ast.units.filter((u) => u.kind === "slots" && !p.slotUnits.includes(u))].map((u) => row(`unit:${u.id}`, u.id, unitSpec(p, u, year))) });
  groups.push({ label: "GEARS · C3", add: "gear", rows: ast.gears.map((g) => row(`gear:${g.id}`, g.id, gearSpec(g) || "—", year.gears.get(g.id) === true)) });
  const stages: PartRow[] = [];
  const many = cycles.filter((u) => u.stages?.length).length > 1;
  for (const u of cycles)
    (u.stages ?? []).forEach((_, i) => {
      const shift = u === p.yearUnit ? stageShift(year.trace, i) : null;
      stages.push(row(`stage:${u.id}:${i}`, `${many ? `${u.id} ` : ""}stage ${i + 1}`, shift === null ? "" : `${signed(shift)} this year`, (shift ?? 0) !== 0));
    });
  // a year that starts by a crossing shows its stages group even with none, so the group header can carry ＋ stage
  if (stages.length || p.yearUnit.crossing) groups.push({ label: "STAGES · C4", add: "stage", rows: stages });
  // a calendar with a year and no seasons shows the group empty, so its header can carry ＋ mark (slice 5f)
  if (ast.seasons) groups.push({ label: "SEASONS", add: "season", rows: [row("seasons", "seasons", `${ast.seasons.marks.length} marks${ast.seasons.marks.some(isDateMark) ? " · dated" : ""}`)] });
  else if (cycles.some((u) => u.id === "year")) groups.push({ label: "SEASONS", add: "season", rows: [] });
  if (ast.rules?.length) groups.push({ label: "RULES · LAMPS", rows: ast.rules.map((r) => row(`rule:${r.id}`, r.name ?? r.id, r.tags?.length ? r.tags.join(", ") : "—", today.rules.get(r.id) === true)) });
  const ledger: PartRow[] = [];
  const touched = new Set(year.ledger.map((s) => s.part));
  for (const u of cycles)
    (u.ledger ?? []).forEach((e, i) => {
      const id: PartId = `ledger:${u.id}:${i}`;
      ledger.push(row(id, `${u.id} · ${e.kind}`, `from ${e.from + (u.number ?? 0)}`, touched.has(id)));
    });
  (ast.days ?? []).forEach((d, i) => ledger.push(row(`day:${i}`, d.name ?? `D${d.day}`, `D${d.day}`, touched.has(`day:${i}`))));
  if (ledger.length) groups.push({ label: "LEDGER · C6", rows: ledger });
  return groups;
}

function bodyName(ast: CalendarAst, id: string): string {
  const b = ast.bodies?.find((x) => x.id === id);
  return b?.moon?.name ?? id;
}

const stageShift = (t: StartTrace, i: number): number => t.levels[i + 1]! - t.levels[i]!;

/** One stage in year `k`, read through the engine's start trace: the start it reads, its shift, the rule that matched, and per rule the length its test reads (null for a weekday test). */
export interface StageFacts {
  /** the start the stage reads (the stage below's output) */
  readonly below: number;
  readonly shift: number;
  /** the index of the rule that matched, or −1 */
  readonly fired: number;
  /** per rule: a length test's occurrence k + at, as long as the stage below makes it; null for a weekday test */
  readonly lengths: ReadonlyArray<number | null>;
}

/** Stage `i` of cycle unit `unitId` in occurrence `k`, or null for a definition that cannot run (or an occurrence past the day line). */
export function stageFacts(ast: CalendarAst, unitId: string, i: number, k: number): StageFacts | null {
  const p = prepare(ast);
  if (p.kind === "empty") return null;
  const u = p.ast.units.find((x) => x.id === unitId);
  const stage = u?.kind === "cycle" ? u.stages?.[i] : undefined;
  if (!stage) return null;
  try {
    const e = p.engine;
    const tr = e.startTrace(unitId, k);
    return {
      below: tr.levels[i]!,
      shift: stageShift(tr, i),
      fired: tr.fired[i]!,
      lengths: stage.rules.map((r) => ("length" in r ? e.startTrace(unitId, k + r.length.at + 1).levels[i]! - e.startTrace(unitId, k + r.length.at).levels[i]! : null)),
    };
  } catch {
    return null;
  }
}

// ---- the machine

interface Drawn {
  segments: Segment[];
  labels: LabelAnchor[];
  picks: PickPoint[];
}

/** smoothstep in the last (1 − s) of a unit: wheels step late (the handoff's 10–18 %). */
export function ease(f: number, s: number): number {
  if (f <= s) return 0;
  const t = Math.min(1, (f - s) / (1 - s));
  return t * t * (3 - 2 * t);
}

/** The phase name a body shows at `phase` (the last named phase at or before it, wrapping), or "". */
export function phaseName(b: BodyAst, phase: number): string {
  const ps = [...(b.moon?.phases ?? [])].sort((x, y) => x.at - y.at);
  if (!ps.length) return "";
  let n = ps[ps.length - 1]!.name;
  for (const q of ps) if (phase >= q.at) n = q.name;
  return n;
}

/** frac(at / period + epoch), exactly (BigInt), then one division: a body's phase at a crossing instant. */
export function phaseAtInstant(b: BodyAst, at: Rational): number {
  const [pn, pd, en, ed, an, ad] = [b.period.n, b.period.d, b.epoch.n, b.epoch.d, at.n, at.d].map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint];
  const num = an * pd * ed + en * ad * pn;
  const den = ad * pn * ed;
  const r = ((num % den) + den) % den;
  return Number(r) / Number(den);
}

const sameRational = (a: Rational, b: Rational) => a.n === b.n && a.d === b.d;

/**
 * Where a cycle unit's crossing sits on a body's orbit: the body it follows at
 * its MARK, else a body sharing the crossing's period at its phase at crossing
 * 0 (Hebrew's Levanah sits six hours off); null when no body carries it.
 */
export function crossingMark(ast: CalendarAst, unitId: string): { readonly body: string; readonly phase: number } | null {
  const p = prepare(ast);
  const u = ast.units.find((x) => x.id === unitId);
  if (p.kind === "empty" || u?.kind !== "cycle" || !u.crossing) return null;
  const bodies = ast.bodies ?? [];
  if (u.crossing.body) {
    const id = u.crossing.body.id;
    return bodies.some((b) => b.id === id) ? { body: id, phase: toNumber(u.crossing.body.mark) } : null;
  }
  const X = (p.engine.ast.units.find((x) => x.id === unitId) as CycleUnitAst).crossing!;
  const shared = bodies.find((b) => sameRational(b.period, X.period!));
  return shared ? { body: shared.id, phase: phaseAtInstant(shared, X.at!) } : null;
}

function drawMachine(p: Prepared, year: YearFacts, today: DayFacts, dayF: number, yp: number, rotation: number): Drawn {
  const G = GEOMETRY;
  const IDX = G.index;
  const segments: Segment[] = [];
  const labels: LabelAnchor[] = [];
  const picks: PickPoint[] = [];
  let ROT = 0;
  const P = (r: number, a: number, y: number): Vec3 => [r * Math.sin(a + ROT), y, -r * Math.cos(a + ROT)];
  const seg = (a: Vec3, b: Vec3, state: SegState, part: PartId | null) => segments.push({ a, b, state, part });
  const poly = (pts: Vec3[], state: SegState, part: PartId | null, closed = false) => {
    for (let i = 0; i < pts.length - 1; i++) seg(pts[i]!, pts[i + 1]!, state, part);
    if (closed) seg(pts[pts.length - 1]!, pts[0]!, state, part);
  };
  const arc = (r: number, y: number, a0: number, a1: number, state: SegState, part: PartId | null, step = 0.05) => {
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
    let prev = P(r, a0, y);
    for (let i = 1; i <= n; i++) {
      const q = P(r, a0 + ((a1 - a0) * i) / n, y);
      seg(prev, q, state, part);
      prev = q;
    }
  };
  const pick = (pt: Vec3, part: PartId) => picks.push({ p: pt, part });
  const label = (pt: Vec3, text: string, state: LabelAnchor["state"], part: PartId | null, o: { priority?: number; onlySelected?: boolean } = {}) => labels.push({ p: pt, text, state, part, ...o });
  const ast = p.ast;
  const yT = G.ringTop;
  const yB = G.ringBottom;
  const RO = G.ringOuter;
  const RI = G.ringInner;
  const yF = G.floorY;
  const yA = yT + 0.16;
  const yearPart: PartId = `unit:${year.unit}`;

  // floor grid and plinth
  for (let i = -8; i <= 8; i++)
    for (let j = -8; j < 8; j++) {
      seg([j * 0.4, yF, i * 0.4], [(j + 1) * 0.4, yF, i * 0.4], "grid", null);
      seg([i * 0.4, yF, j * 0.4], [i * 0.4, yF, (j + 1) * 0.4], "grid", null);
    }
  arc(G.plinthR, G.plinthTop, 0, TAU, "dim", null, 0.09);
  arc(G.plinthR, yF, 0, TAU, "dim", null, 0.09);
  for (let i = 0; i < 24; i++) seg(P(G.plinthR, (TAU * i) / 24, G.plinthTop), P(G.plinthR, (TAU * i) / 24, yF), "dim", null);

  // seasons bezel, locked to the year ring; a dated mark carries a pin head
  ROT = rotation;
  const ms = year.seasons;
  if (ms.length) {
    const doy = today.dayOfYear;
    let cur = -1;
    ms.forEach((m, i) => {
      if (m.at <= doy) cur = i;
    });
    if (cur < 0) cur = ms.length - 1; // before the first mark: the last mark's season runs on from last year
    arc(G.bezelIn, G.plinthTop, 0, TAU, "dim", "seasons", 0.06);
    arc(G.bezelOut, G.plinthTop, 0, TAU, "dim", "seasons", 0.06);
    const yM = 1.225;
    ms.forEach((m, i) => {
      const a = TAU * m.phase;
      const nx = i + 1 < ms.length ? ms[i + 1]!.phase : ms[0]!.phase + 1;
      const am = (TAU * (m.phase + nx)) / 2;
      seg(P(1.15, a, G.plinthTop), P(1.3, a, G.plinthTop), "line", "seasons");
      seg(P(yM, a, G.plinthTop), P(yM, a, 0.07), "line", "seasons");
      if (m.kind !== "fraction") poly([P(yM, a, 0.07), P(yM + 0.025, a, 0.095), P(yM, a, 0.12), P(yM - 0.025, a, 0.095)], "line", "seasons", true);
      if (i === cur) arc(yM, G.plinthTop, a, TAU * nx, "hot", "seasons", 0.04);
      label(P(1.43, am, G.plinthTop), m.name.toUpperCase(), i === cur ? "hot" : "dim", "seasons");
      for (let q = a + 0.1; q < TAU * nx; q += 0.2) pick(P(yM, q, G.plinthTop), "seasons");
    });
  }

  // the year ring and its first slot unit
  const main = p.slotUnits.find((u) => u.in === year.unit);
  const mainTable = main && year.slots.find((t) => t.unit === main.id);
  const spans = new Map<string, Array<[number, number]>>(); // table key → each slot's angles
  const key = (t: SlotTable) => `${t.unit}|${t.path.join(",")}`;
  const anglesOf = (t: SlotTable, a0: number, a1: number): Array<[number, number]> => {
    const tot = t.lengths.reduce((x, y) => x + Math.max(0, y), 0) || 1;
    let acc = 0;
    return t.lengths.map((L) => {
      const s: [number, number] = [a0 + ((a1 - a0) * acc) / tot, a0 + ((a1 - a0) * (acc + Math.max(0, L))) / tot];
      acc += Math.max(0, L);
      return s;
    });
  };
  const curOf = (unit: string) => today.positions.get(unit) ?? null;
  if (main && mainTable) {
    const ang = anglesOf(mainTable, 0, TAU);
    spans.set(key(mainTable), ang);
    const curSlot = curOf(main.id)?.index ?? -1;
    mainTable.lengths.forEach((L, i) => {
      const s = main.slots[i]!;
      const part: PartId = `slot:${main.id}:${i}`;
      const [a0, a1] = ang[i]!;
      const name = s.name ?? `${i + (main.number ?? 1)}`;
      if (L <= 0) {
        const yc = yT + 0.15;
        seg(P(RO, a0, yB), P(RO, a0, yT + 0.12), "ghost", part);
        poly([P(RO, a0, yc - 0.03), P(RO + 0.03, a0, yc), P(RO, a0, yc + 0.03), P(RO - 0.03, a0, yc)], "ghost", part, true);
        label(P(RO, a0, yT + 0.23), name, "ghost", part, { onlySelected: true });
        pick(P(RO, a0, yc), part);
        return;
      }
      const cur = i === curSlot;
      const st: SegState = cur ? "hot" : "line";
      arc(RO, yT, a0, a1, st, part, 0.03);
      if (s.length === "slack") {
        const n = Math.max(2, Math.round(L / 2));
        let prev = P(RI, a0, yT);
        for (let j = 1; j <= n; j++) {
          const q = P(j % 2 ? RI + 0.03 : RI, a0 + ((a1 - a0) * j) / n, yT);
          seg(prev, q, st, part);
          prev = q;
        }
      } else arc(RI, yT, a0, a1, st, part, 0.03);
      arc(RO, yB, a0, a1, "dim", part, 0.05);
      seg(P(RI, a0, yT), P(RO, a0, yT), "line", part);
      seg(P(RO, a0, yT), P(RO, a0, yB), "line", part);
      if (L <= 400) for (let j = 1; j < L; j++) {
        const a = a0 + ((a1 - a0) * j) / L;
        seg(P(0.968, a, yT), P(RO, a, yT), "dim", part);
      }
      const am = (a0 + a1) / 2;
      if (s.filler) {
        const yb = yT + 0.1;
        seg(P(0.95, am, yT), P(0.95, am, yb), st, part);
        poly([P(0.92, am, yb), P(0.95, am - 0.03, yb), P(0.98, am, yb), P(0.95, am + 0.03, yb)], st, part, true);
        label(P(0.95, am, yb + 0.07), name, cur ? "hot" : "dim", part, { onlySelected: !cur });
      } else label(P(1.12, am, yT), name, cur ? "hot" : "dim", part);
      for (let a = a0 + 0.015; a < a1; a += 0.045) pick(P(0.95, a, yT), part);
      pick(P(0.95, am, yT), part);
    });
  } else {
    // a year without slots: one plain ring, ticked per day
    arc(RO, yT, 0, TAU, "line", yearPart, 0.03);
    arc(RI, yT, 0, TAU, "line", yearPart, 0.03);
    for (let a = 0; a < TAU; a += 0.2) pick(P(0.95, a, yT), yearPart);
  }

  // further slot units: bands inward, each inside its parent slot's arc (a tenday in a month)
  let band = 0;
  for (const u of p.slotUnits) {
    if (u === main) continue;
    const ro = G.bandOuter - G.bandStep * band++;
    const ri = ro - G.bandWidth;
    const part: PartId = `unit:${u.id}`;
    const pos = curOf(u.id);
    const parentPos = curOf(u.in);
    for (const t of year.slots.filter((x) => x.unit === u.id)) {
      const parentKey = u.in === year.unit ? null : `${u.in}|${t.path.slice(0, -1).join(",")}`;
      const span: [number, number] = parentKey === null ? [0, TAU] : (spans.get(parentKey)?.[t.path[t.path.length - 1]!] ?? [0, 0]);
      if (span[1] <= span[0]) continue;
      const ang = anglesOf(t, span[0], span[1]);
      spans.set(key(t), ang);
      const here = parentKey === null || (parentPos !== null && parentPos.index === t.path[t.path.length - 1] && today.positions.get(year.unit)?.index === t.path[0]);
      t.lengths.forEach((L, j) => {
        if (L <= 0) return;
        const b0 = ang[j]![0] + 0.004;
        const b1 = ang[j]![1] - 0.004;
        if (b1 <= b0) return;
        const st: SegState = here && pos?.index === j ? "hot" : "dim";
        const sp: PartId = `slot:${u.id}:${j}`;
        arc(ro, yT, b0, b1, st, sp, 0.04);
        arc(ri, yT, b0, b1, st, sp, 0.04);
        seg(P(ri, b0, yT), P(ro, b0, yT), st, sp);
        seg(P(ri, b1, yT), P(ro, b1, yT), st, sp);
        pick(P((ro + ri) / 2, (b0 + b1) / 2, yT), part);
      });
    }
  }

  // the year post, its stage pawls and ledger set-screws; spokes
  const stagesHere = p.yearUnit.stages ?? [];
  const postTop = stagesHere.length ? yT + 0.07 + 0.09 * stagesHere.length + 0.08 : yT + 0.14;
  seg(P(RO + 0.02, 0, G.plinthTop), P(RO + 0.02, 0, postTop), "line", yearPart);
  label(P(RO + 0.02, 0, postTop + 0.07), String(year.number), "line", yearPart);
  pick(P(RO + 0.02, 0, yT + 0.08), yearPart);
  pick(P(RO + 0.02, 0, yT + 0.2), yearPart);
  for (let i = 0; i < 6; i++) {
    const a = (TAU * (i + 0.5)) / 6;
    seg(P(0.05, a, yB), P(RI, a, yB), "dim", yearPart);
    pick(P(0.5, a, yB), yearPart);
    pick(P(0.75, a, yB), yearPart);
  }
  stagesHere.forEach((_, i) => {
    const part: PartId = `stage:${year.unit}:${i}`;
    const sh = stageShift(year.trace, i);
    const y = yT + 0.07 + i * 0.09;
    const st: SegState = sh !== 0 ? "hot" : "line";
    const R0 = RO + 0.02;
    poly([P(R0, 0, y + 0.035), P(R0 + 0.13, -0.05, y), P(R0, 0, y - 0.035)], st, part, true);
    poly([P(R0, 0, y + 0.035), P(R0, -0.05 * (1 + Math.abs(sh)), y), P(R0, 0, y - 0.035)], st, part);
    label(P(R0 + 0.26, -0.05, y), `S${i + 1} ${signed(sh)}`, st, part);
    pick(P(R0 + 0.07, -0.03, y), part);
    pick(P(R0 + 0.22, -0.05, y), part);
  });
  let onPost = 0;
  for (const s of year.ledger) {
    const R0 = RO + 0.04;
    const atDay = s.day !== undefined;
    const a = atDay ? (TAU * (s.day - year.start + 0.5)) / year.length : 0.05;
    const y = atDay ? (yT + yB) / 2 : G.plinthTop + 0.05 + 0.05 * onPost++;
    const st: SegState = "line";
    poly([P(R0, a, y + 0.022), P(R0 + 0.022, a, y), P(R0, a, y - 0.022), P(R0 - 0.022, a, y)], st, s.part, true);
    seg(P(R0 - 0.022, a, y), P(R0 + 0.022, a, y), st, s.part);
    label(P(R0 + 0.12, a, y), s.tag, "dim", s.part, { onlySelected: s.kind !== "switch" });
    pick(P(R0, a, y), s.part);
  }

  // the day line: arbor, fixed index, crank
  ROT = 0;
  seg([0, G.plinthTop, 0], [0, 1.42, 0], "line", "dayline");
  arc(0.05, yT + 0.03, 0, TAU, "line", "dayline", 0.5);
  arc(0.05, G.bodyY, 0, TAU, "line", "dayline", 0.5);
  {
    const IX = (r: number, y: number) => P(r, IDX, y);
    seg(IX(1.4, yF), IX(1.4, yA), "line", "dayline");
    seg(IX(1.4, yA), IX(0.92, yA), "line", "dayline");
    seg(IX(0.95, yA), IX(0.95, yT + 0.1), "hot", "dayline");
    poly([P(0.95, IDX - 0.028, yT + 0.1), P(0.95, IDX + 0.028, yT + 0.1), P(0.95, IDX, yT + 0.035)], "hot", "dayline", true);
    seg(IX(RI - 0.03, yT + 0.004), IX(RO + 0.05, yT + 0.004), "hot", "dayline");
    label(IX(1.4, yA + 0.09), today.date, "hot", "dayline", { priority: -1 });
    for (let r = 0.95; r <= 1.41; r += 0.09) pick(IX(r, yA), "dayline");
    pick(IX(1.4, yT), "dayline");
    pick([0, 0.9, 0], "dayline");
    pick([0, 0.6, 0], "dayline");
  }
  {
    const CA = IDX - 0.8;
    const ca = TAU * (dayF - Math.floor(dayF));
    const yc = -0.09;
    const ux = Math.sin(CA);
    const uz = -Math.cos(CA);
    const tx = Math.cos(CA);
    const tz = Math.sin(CA);
    const c0 = P(1.5, CA, yc);
    const W2 = (th: number, r: number): Vec3 => [c0[0] + r * Math.sin(th) * tx, c0[1] + r * Math.cos(th), c0[2] + r * Math.sin(th) * tz];
    seg(P(1.32, CA, yc), c0, "line", "dayline");
    let prev: Vec3 | null = null;
    for (let i = 0; i <= 16; i++) {
      const q = W2((TAU * i) / 16, 0.07);
      if (prev) seg(prev, q, "line", "dayline");
      prev = q;
    }
    const hp = W2(ca, 0.07);
    seg(c0, hp, "hot", "dayline");
    seg(hp, [hp[0] + 0.08 * ux, hp[1], hp[2] + 0.08 * uz], "hot", "dayline");
    label(P(1.6, CA, yc - 0.13), `D${today.day}`, "line", "dayline");
    pick(c0, "dayline");
  }

  // other cycle units: label wheels stacked on the arbor (the first unlabelled one is their hub), then plain wheels
  const others = ast.units.filter((u): u is CycleUnitAst => u.kind === "cycle" && u !== p.yearUnit);
  const hub = others.find((u) => !u.labels?.length);
  let wn = 0;
  for (const u of [...others.filter((x) => x.labels?.length), ...others.filter((x) => !x.labels?.length && x !== hub)]) {
    const part: PartId = `unit:${u.id}`;
    const pos = curOf(u.id)!;
    const N = u.labels?.length || Math.min(60, Math.max(1, pos.length));
    const li = u.labels?.length ? mod(pos.index, N) : pos.offset;
    const yw = 0.72 + wn * 0.13;
    const rw = Math.max(0.12, 0.24 - wn * 0.03);
    const e = ease((dayF - pos.start) / pos.length, 0.82);
    const hp: PartId = wn === 0 && hub ? `unit:${hub.id}` : part;
    wn++;
    arc(rw, yw, 0, TAU, "line", part, 0.1);
    arc(0.08, yw, 0, TAU, "line", hp, 0.3);
    for (let j = 0; j < N; j++) {
      const aj = Math.PI + (TAU * (j - li - (u.labels?.length ? e : 0))) / N;
      const on = j === li;
      poly([P(rw, aj - Math.min(0.2, Math.PI / N), yw), P(rw + 0.06, aj, yw), P(rw, aj + Math.min(0.2, Math.PI / N), yw)], on ? "hot" : "line", part);
      seg(P(0.08, aj, yw), P(rw, aj, yw), "dim", hp);
      const name = u.labels?.[j]?.name;
      if (name !== undefined) label(P(rw + 0.15, aj, yw), on ? name : name.slice(0, 3), on ? "hot" : "dim", part);
      pick(P(rw + 0.03, aj, yw), part);
    }
    poly([P(rw + 0.04, Math.PI, yw + 0.08), P(rw + 0.04, Math.PI - 0.12, yw + 0.15), P(rw + 0.04, Math.PI + 0.12, yw + 0.15)], "hot", part, true);
    pick(P(0.04, 0, yw), hp);
    if (!u.labels?.length) label(P(rw + 0.12, Math.PI, yw + 0.12), `${u.id} ${pos.offset + 1}/${pos.length}`, "line", part);
  }

  // bodies: a sphere on an arm, its orbit ticked at the named phases
  const bodies = ast.bodies ?? [];
  const sphere = (c0: Vec3, R: number, spin: number, st: SegState, part: PartId) => {
    for (const lat of [0, 0.6, -0.6]) {
      const y = c0[1] + R * Math.sin(lat);
      const rr = R * Math.cos(lat);
      let prev: Vec3 | null = null;
      for (let i = 0; i <= 16; i++) {
        const a = (TAU * i) / 16;
        const q: Vec3 = [c0[0] + rr * Math.cos(a), y, c0[2] + rr * Math.sin(a)];
        if (prev) seg(prev, q, st, part);
        prev = q;
      }
    }
    for (let m = 0; m < 3; m++) {
      const phi = spin + (m * Math.PI) / 3;
      let prev: Vec3 | null = null;
      for (let i = 0; i <= 16; i++) {
        const t = (TAU * i) / 16;
        const q: Vec3 = [c0[0] + R * Math.cos(t) * Math.cos(phi), c0[1] + R * Math.sin(t), c0[2] + R * Math.cos(t) * Math.sin(phi)];
        if (prev) seg(prev, q, st, part);
        prev = q;
      }
    }
  };
  const bodyAt = new Map<string, { y: number; r: number }>();
  bodies.forEach((b, bi) => {
    const part: PartId = `body:${b.id}`;
    const y = G.bodyY + bi * G.bodyStep;
    const r = G.bodyR;
    bodyAt.set(b.id, { y, r });
    // the engine's exact phase at the day's start, run on by the fraction of the day
    const ph = mod(today.bodies.get(b.id)! + (dayF - today.day) / toNumber(b.period), 1);
    const a = IDX + TAU * ph;
    const c0 = P(r, a, y);
    arc(r, y, 0, TAU, "dim", part, 0.06);
    for (const q of b.moon?.phases ?? []) {
      const pa = IDX + TAU * q.at;
      seg(P(r - 0.035, pa, y), P(r + 0.035, pa, y), "line", part);
      label(P(r + 0.13, pa, y), q.name, "dim", part, { onlySelected: true });
    }
    seg([0, y, 0], c0, "line", part);
    sphere(c0, 0.075, a * 3, "line", part);
    const pn = phaseName(b, today.bodies.get(b.id)!);
    label([c0[0], c0[1] + 0.15, c0[2]], `${b.moon?.name ?? b.id}${pn ? ` · ${pn}` : ""}`, "hot", part);
    pick(c0, part);
    for (let k = 0; k < 16; k++) pick(P(r, (TAU * k) / 16, y), part);
  });

  // crossings: a mark on the body that drives (or shares the period of) the base, a rod to the index; the train
  let own = 0;
  for (const u of ast.units) {
    if (u.kind !== "cycle" || !u.crossing) continue;
    const resolved = p.engine.ast.units.find((x) => x.id === u.id) as CycleUnitAst;
    const X = resolved.crossing!;
    const part: PartId = `crossing:${u.id}`;
    const pos = curOf(u.id)!;
    const rodState: SegState = pos.offset === 0 ? "hot" : "ghost";
    const isYear = u === p.yearUnit;
    const target = (y: number): Vec3 => (isYear ? P(0.95, IDX, yA) : [0, y, 0]);
    const mark = crossingMark(ast, u.id);
    if (mark) {
      const { y, r } = bodyAt.get(mark.body)!;
      const mA = IDX + TAU * mark.phase;
      seg(P(r - 0.07, mA, y), P(r + 0.07, mA, y), "line", part);
      seg(P(r, mA, y - 0.05), P(r, mA, y + 0.05), "line", part);
      poly([P(r + 0.07, mA, y), P(r + 0.1, mA - 0.03, y), P(r + 0.13, mA, y), P(r + 0.1, mA + 0.03, y)], "line", part, true);
      label(P(r + 0.24, mA, y), u.crossing.body ? `${u.id} mark` : "molad", "line", part);
      const A = P(r, mA, y - 0.05);
      const B = target(y - 0.05);
      seg(A, B, rodState, part);
      pick(P(r + 0.1, mA, y), part);
      pick(P(r + 0.22, mA, y), part);
      for (let q = 0.15; q < 1; q += 0.2) pick([A[0] + (B[0] - A[0]) * q, A[1] + (B[1] - A[1]) * q, A[2] + (B[2] - A[2]) * q], part);
    } else {
      const y = 0.9 - 0.1 * own++;
      const r = 0.36;
      const Pm = toNumber(X.period!);
      const ph = mod((dayF - toNumber(X.at!)) / Pm, 1);
      const c0 = P(r, IDX + TAU * ph, y);
      arc(r, y, 0, TAU, "dim", part, 0.08);
      seg(P(r - 0.05, IDX, y), P(r + 0.05, IDX, y), "line", part);
      label(P(r + 0.15, IDX, y), "mark", "dim", part);
      seg([0, y, 0], c0, "line", part);
      const R = 0.045;
      const v = [[R, 0, 0], [-R, 0, 0], [0, R, 0], [0, -R, 0], [0, 0, R], [0, 0, -R]].map((q): Vec3 => [c0[0] + q[0]!, c0[1] + q[1]!, c0[2] + q[2]!]);
      for (const [a, b] of [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]] as const) seg(v[a]!, v[b]!, "line", part);
      label([c0[0], c0[1] + 0.1, c0[2]], isYear ? "molad" : u.id, "line", part);
      pick(c0, part);
      for (let k = 0; k < 12; k++) pick(P(r, (TAU * k) / 12, y), part);
      seg(P(r + 0.05, IDX, y), target(y), rodState, part);
    }
    const I0 = u.crossing.index;
    if (I0 && isYear) {
      const tp: PartId = `train:${u.id}`;
      const yw = 0.5;
      const R1 = 0.2;
      const R2 = 0.08;
      const c2 = P(R1 + R2 + 0.03, IDX + Math.PI / 2, yw);
      const Lp = (rr: number, a: number): Vec3 => [c2[0] + rr * Math.sin(a), yw, c2[2] - rr * Math.cos(a)];
      arc(R1, yw, 0, TAU, "line", tp, 0.06);
      arc(0.05, yw, 0, TAU, "dim", tp, 0.5);
      const teeth = Math.min(I0.a, 400);
      for (let j = 0; j < teeth; j++) {
        const a = rotation + (TAU * j) / teeth;
        seg(P(R1, a, yw), P(R1 + 0.022, a, yw), "dim", tp);
      }
      for (let q = 0; q < 4; q++) seg(P(0.05, rotation + (TAU * q) / 4, yw), P(R1, rotation + (TAU * q) / 4, yw), "dim", tp);
      const phi = (TAU * (year.index + yp) * I0.a) / I0.L;
      let prev: Vec3 | null = null;
      for (let i = 0; i <= 20; i++) {
        const q = Lp(R2, (TAU * i) / 20);
        if (prev) seg(prev, q, "line", tp);
        prev = q;
      }
      const pins = Math.min(I0.L, 120);
      for (let j = 0; j < pins; j++) {
        const a = phi + (TAU * j) / pins;
        const hw = (Math.PI / pins) * 0.5;
        poly([Lp(R2, a - hw), Lp(R2 + 0.025, a), Lp(R2, a + hw)], "line", tp);
      }
      seg(Lp(0, 0), Lp(R2 - 0.01, phi), "hot", tp);
      seg([c2[0], yw - 0.06, c2[2]], [c2[0], yw + 0.1, c2[2]], "line", tp);
      label([c2[0], yw + 0.17, c2[2]], `${I0.a} : ${I0.L}`, "line", tp);
      pick(c2, tp);
      pick([c2[0], yw + 0.1, c2[2]], tp);
      for (let i = 0; i < 8; i++) pick(P(R1, (TAU * i) / 8, yw), tp);
    }
  }

  // gears: wheel stacks beside the slot they feed, riding the ring, a rod to it
  ROT = rotation;
  const mainAng = mainTable ? spans.get(key(mainTable)) : undefined;
  ast.gears.forEach((g, gi) => {
    const part: PartId = `gear:${g.id}`;
    const on = year.gears.get(g.id) === true;
    const k = g.on === year.unit ? year.index : (today.positions.get(g.on)?.index ?? 0);
    let ti = main ? main.slots.findIndex((s) => (s.gears ?? []).some((t) => t.gear === g.id)) : -1;
    if (ti < 0 && main && !(p.yearUnit.gears ?? []).some((t) => t.gear === g.id)) ti = main.slots.findIndex((s) => s.length === "slack");
    const [t0, t1] = ti >= 0 && mainAng ? mainAng[ti]! : [0, 0];
    const tA = (t0 + t1) / 2;
    const GA = tA + 0.5 + gi * 0.6;
    const c0 = P(G.gearR, GA, 0);
    const phin = GA + ROT + Math.PI;
    const wheels = g.kind === "positions" ? [{ N: g.period, off: g.offset ?? 0, pins: g.positions, sign: 1 }] : g.terms.map((t) => ({ N: t.every, off: t.offset ?? 0, pins: [0], sign: t.sign }));
    const e = ease(yp, 0.9);
    const yTop = 0.1 + 0.2 * Math.max(0, wheels.length - 1) + 0.12;
    seg([c0[0], yF, c0[2]], [c0[0], yTop, c0[2]], "line", part);
    {
      let prev: Vec3 | null = null;
      for (let i = 0; i <= 12; i++) {
        const a = (TAU * i) / 12;
        const q: Vec3 = [c0[0] + 0.08 * Math.sin(a), yF, c0[2] - 0.08 * Math.cos(a)];
        if (prev) seg(prev, q, "dim", part);
        prev = q;
      }
    }
    let r0 = 0.3;
    wheels.forEach((w, wi) => {
      const y = 0.1 + 0.2 * wi;
      const N = Math.max(1, w.N);
      const rr = Math.min(0.42, 0.13 + 0.055 * Math.log2(N + 1));
      if (wi === 0) r0 = rr;
      const pp = mod(k - w.off, N);
      const L = (r: number, a: number): Vec3 => [c0[0] + r * Math.sin(a), y, c0[2] - r * Math.cos(a)];
      const tA2 = (j: number) => phin + (TAU * (j - pp - e)) / N;
      {
        let prev: Vec3 | null = null;
        const n = Math.max(24, Math.round(rr * 80));
        for (let i = 0; i <= n; i++) {
          const q = L(rr, (TAU * i) / n);
          if (prev) seg(prev, q, "line", part);
          prev = q;
        }
      }
      if (N <= 60)
        for (let j = 0; j < N; j++) {
          const a = tA2(j);
          const hw = (Math.PI / N) * 0.55;
          poly([L(rr, a - hw), L(rr + 0.035, a), L(rr, a + hw)], "line", part);
        }
      else for (let j = 0; j < Math.min(N, 1000); j++) seg(L(rr, tA2((j * N) / Math.min(N, 1000))), L(rr + 0.022, tA2((j * N) / Math.min(N, 1000))), "dim", part);
      {
        let prev: Vec3 | null = null;
        for (let i = 0; i <= 10; i++) {
          const q = L(0.035, (TAU * i) / 10);
          if (prev) seg(prev, q, "line", part);
          prev = q;
        }
      }
      for (let s = 0; s < 4; s++) {
        const a = phin + (TAU * s) / 4 - (TAU * (pp + e)) / N;
        seg(L(0.035, a), L(rr, a), "dim", part);
      }
      for (const pj of w.pins) {
        const b = L(rr - 0.03, tA2(pj));
        const st: SegState = mod(pj, N) === pp && on ? "hot" : "line";
        seg(b, [b[0], y + 0.075, b[2]], st, part);
        seg([b[0] - 0.012, y + 0.075, b[2]], [b[0] + 0.012, y + 0.075, b[2]], st, part);
      }
      poly([L(rr + 0.13, phin), L(rr + 0.055, phin - 0.07), L(rr + 0.055, phin + 0.07)], "line", part, true);
      label(L(rr + 0.15, phin + Math.PI), g.kind === "positions" ? `${N}` : `${w.sign > 0 ? "+" : "−"}${N}`, "line", part);
      for (let i = 0; i < 10; i++) pick(L(rr, (TAU * i) / 10), part);
      pick(L(rr + 0.1, phin), part);
    });
    const A: Vec3 = [c0[0] + (r0 + 0.13) * Math.sin(phin), 0.1, c0[2] - (r0 + 0.13) * Math.cos(phin)];
    const B = P(RO + 0.01, tA, yB + 0.02);
    seg(A, B, on ? "hot" : "ghost", part);
    pick([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], part);
    label([c0[0], yTop + 0.09, c0[2]], g.id, on ? "hot" : "line", part);
    pick([c0[0], yTop, c0[2]], part);
  });

  // rule lamps on the plinth, right of the index: lit on a day the engine says the rule holds
  ROT = 0;
  const rules = ast.rules ?? [];
  const step = Math.min(0.18, (TAU - 1.6) / Math.max(1, rules.length));
  rules.forEach((r, i) => {
    const part: PartId = `rule:${r.id}`;
    const holds = today.rules.get(r.id);
    const st: SegState = holds === "error" ? "err" : holds ? "hot" : "dim";
    const a = IDX + 0.45 + i * step;
    const R = G.plinthR + 0.01;
    const y = (G.plinthTop + yF) / 2;
    seg(P(R, a, yF), P(R, a, y - 0.03), "dim", part);
    poly([P(R, a, y + 0.03), P(R + 0.03, a, y), P(R, a, y - 0.03), P(R - 0.03, a, y)], st, part, true);
    if (holds === true) seg(P(R - 0.015, a, y), P(R + 0.015, a, y), st, part);
    label(P(R + 0.16, a, y), r.name ?? r.id, holds === true ? "hot" : "dim", part, { onlySelected: holds !== true });
    pick(P(R, a, y), part);
  });

  return { segments, labels, picks };
}

// ---------------------------------------------------------------------------
// The inspector's NOW readout
// ---------------------------------------------------------------------------

/** The inspector header and NOW rows for `part` (null: the whole calendar), read from the model's day. */
export function partInfo(model: OrreryModel, part: PartId | null): PartInfo {
  const p = prepare(model.ast) as Prepared;
  const ast = model.ast;
  const { year, today } = model;
  const now: NowRow[] = [];
  const row = (key: string, value: string | number, tone?: NowRow["tone"]) => now.push({ key, value: String(value), ...(tone ? { tone } : {}) });
  const date = (d: number) => dayFacts(ast, d)?.date ?? `D${d}`;
  const info = (code: string, title: string, sub: string): PartInfo => ({ code, title, sub, now });
  const unitOf = (id: string) => ast.units.find((u) => u.id === id);
  if (part === null || part === "calendar") {
    row("today", today.date);
    row("day", `D${today.day}`);
    row("year", `${year.number} · ${year.length} d`);
    const main = p.slotUnits[0];
    const pos = main && today.positions.get(main.id);
    row("slot", main && pos ? (main.slots[pos.index]!.name ?? `${pos.index + (main.number ?? 1)}`) : "—");
    row("season", today.season ?? "—");
    return info("VCALENDAR", ast.name, "Seshat 1 · world definition");
  }
  if (part === "dayline") {
    row("day", `D${today.day}`);
    row("year index", year.index);
    row("day of year", `${today.dayOfYear + 1} of ${year.length}`);
    for (const f of today.formats) row(f.name, f.text);
    return info("DRIVE", "Day line", `one integer day · ±${DAY_LIMIT.toLocaleString("en-US")}`);
  }
  if (part === "seasons") {
    row("now", today.season ?? "—");
    for (const m of year.seasons) row(m.name, `${date(year.start + m.at)} · ${m.kind === "fraction" ? `from ${m.phase.toFixed(3)}` : m.kind === "day" ? "day of year" : "month and day"}`);
    return info("SEASONS", "Seasons", `over ${ast.seasons?.unit ?? "—"} · ${ast.seasons?.marks.length ?? 0} marks`);
  }
  const [kind, id, n] = part.split(":") as [string, string, string | undefined];
  const index = n === undefined ? NaN : Number(n);
  switch (kind) {
    case "body": {
      const b = ast.bodies?.find((x) => x.id === id);
      if (!b) break;
      const ph = today.bodies.get(b.id)!;
      const pn = phaseName(b, ph);
      row("phase", `${ph.toFixed(3)}${pn ? ` · ${pn}` : ""}`);
      row("period", `${b.period.n}${b.period.d === 1 ? "" : `/${b.period.d}`} d`);
      const ps = [...(b.moon?.phases ?? [])].sort((x, y) => x.at - y.at);
      const nx = ps.find((q) => q.at > ph) ?? (ps[0] && { name: ps[0].name, at: ps[0].at + 1 });
      if (nx) row(`next ${nx.name}`, `in ${((nx.at - ph) * toNumber(b.period)).toFixed(1)} d`);
      const followers = ast.units.filter((u) => u.kind === "cycle" && u.crossing?.body?.id === b.id).map((u) => u.id);
      if (followers.length) row("drives", followers.join(", "));
      return info("C1 · BODY", b.moon?.name ?? b.id, `${b.moon ? "moon" : "body"} · ${b.id}`);
    }
    case "crossing":
    case "train": {
      const u = unitOf(id);
      if (u?.kind !== "cycle" || !u.crossing) break;
      const tr = u === p.yearUnit ? year.trace : p.engine.startTrace(u.id, today.positions.get(u.id)!.index);
      const resolved = p.engine.ast.units.find((x) => x.id === u.id) as CycleUnitAst;
      const X = resolved.crossing!;
      if (kind === "train") {
        const I0 = u.crossing.index;
        if (!I0) break;
        const k = tr === year.trace ? year.index : today.positions.get(u.id)!.index;
        row("this year", `crossing ${tr.baseIndex}`);
        row("next year", `crossing ${p.engine.startTrace(u.id, k + 1).baseIndex}`);
        row("long years", `${longYears(p, u.id, I0.L)} in ${I0.L}`);
        row("mean year", `${((toNumber(X.period!) * I0.a) / I0.L).toFixed(4)} d`);
        return info("CROSSING · INDEX", `Train ${I0.a} : ${I0.L}`, "crossings counted per year");
      }
      const t = toNumber(X.at!) + tr.baseIndex * toNumber(X.period!);
      row("crossing", `no. ${tr.baseIndex}`);
      const mark = crossingMark(ast, u.id);
      if (mark) row("mark", `${bodyName(ast, mark.body)} at phase ${mark.phase.toFixed(6)}`);
      row("instant", `D${Math.floor(t)} · ${dhp(t - Math.floor(t)).replace(/^0d /, "")}`);
      row("crossing day", date(tr.baseStart));
      row("starts", tr.start === tr.baseStart ? "same day" : `${signed(tr.start - tr.baseStart)} d${tr.pinned ? " · pinned" : " · stages"}`);
      const ref = u.crossing.body;
      if (ref) {
        row("START", u.crossing.start === "after" ? "after" : "contains");
        row("K", ref.k ?? 0);
      }
      return info("CROSSING · YEAR BASE", ref ? `${u.id} follows ${bodyName(ast, ref.id)}` : "Molad", followSentence(ast, u.id) ?? `the ${u.id} starts on the day of its crossing`);
    }
    case "unit": {
      const u = unitOf(id);
      if (!u) break;
      const pos = today.positions.get(u.id);
      if (u.kind === "slots") {
        const tables = year.slots.filter((t) => t.unit === u.id);
        const days = tables.reduce((a, t) => a + t.lengths.reduce((x, y) => x + y, 0), 0);
        if (u.in === year.unit) row("this year", `${days} of ${year.length} d`);
        row("current", pos ? `${pos.index + (u.number ?? 1)} · ${u.slots[pos.index]!.name ?? "—"}` : "— (filler day)");
        return info("C2 · SLOTS", u.id, `in ${u.in} · ${u.slots.length} slots`);
      }
      if (u === p.yearUnit) {
        row("year", year.number);
        if (u.crossing) {
          row("crossing day", `D${year.trace.baseStart}`);
          (u.stages ?? []).forEach((_, i) => row(`stage ${i + 1}`, signed(stageShift(year.trace, i)), stageShift(year.trace, i) ? "on" : "off"));
        }
        row("starts", `D${year.start} · ${date(year.start)}`);
        row("length", `${year.length} d`);
        row("next starts", `D${year.start + year.length}`);
        if (year.trace.pinned) row("ledger", "start pinned");
        else if (year.trace.switched) row("ledger", "switched rule");
        return info("C2 · CYCLE", u.id, u.crossing ? `crossing base · ${(u.stages ?? []).length} stages` : `never resets · anchor D${u.anchor}`);
      }
      row("occurrence", pos!.index);
      if (u.labels?.length) row("label", u.labels[mod(pos!.index, u.labels.length)]!.name ?? "—");
      else row("day", `${pos!.offset + 1} of ${pos!.length}`);
      return info(u.labels?.length ? "C2 · CYCLE · C5" : "C2 · CYCLE", u.id, u.crossing ? "never resets · crossing base" : `${u.length} d · never resets · anchor D${u.anchor}`);
    }
    case "slot": {
      const u = unitOf(id);
      if (u?.kind !== "slots" || !u.slots[index]) break;
      const s = u.slots[index];
      const t = year.slots.find((x) => x.unit === u.id && (u.in === year.unit || x.path[x.path.length - 1] === today.positions.get(u.in)?.index)) ?? year.slots.find((x) => x.unit === u.id);
      const L = t?.lengths[index] ?? 0;
      if (u.in === year.unit && t) {
        const from = year.start + t.lengths.slice(0, index).reduce((a, b) => a + b, 0);
        if (L > 0) {
          row("this year", `${L} d`);
          row("from", date(from));
          row("to", date(from + L - 1));
        } else row("this year", "absent · 0 d", "off");
      } else row("here", `${L} d`);
      if (s.length === "slack") row("takes", `the rest${s.min !== undefined || s.max !== undefined ? ` · ${s.min ?? 0} to ${s.max ?? "∞"}` : ""}`);
      for (const gt of s.gears ?? []) row(`when ${gt.gear}`, `${signed(gt.add)} d · ${year.gears.get(gt.gear) ? "engaged" : "idle"}`, year.gears.get(gt.gear) ? "on" : "off");
      return info(s.filler ? "C2 · FILLER SLOT" : "C2 · SLOT", s.name ?? `slot ${index + (u.number ?? 1)}`, `${u.id} ${index + (u.number ?? 1)} of ${u.slots.length} · in ${u.in}`);
    }
    case "gear": {
      const g = ast.gears.find((x) => x.id === id);
      if (!g) break;
      const on = year.gears.get(g.id) === true;
      const at = g.on === year.unit ? year.index : (today.positions.get(g.on)?.index ?? 0);
      const unitNumber = (unitOf(g.on) as CycleUnitAst | undefined)?.number ?? 0;
      row(g.on, at + unitNumber);
      row("this year", on ? "engaged" : "idle", on ? "on" : "off");
      let next: number | null = null;
      for (let j = at + 1; j < at + 2000; j++)
        if (gearMatches(g, j)) {
          next = j;
          break;
        }
      row("next", next === null ? "—" : String(next + unitNumber));
      const period = gearPeriod(g);
      row("rate", `${gearBelow(g, period)} in ${period}`);
      return info("C3 · GEAR", g.id, `on ${g.on} · ${g.kind}`);
    }
    case "stage": {
      const u = unitOf(id);
      if (u?.kind !== "cycle" || !u.stages?.[index]) break;
      const tr = u === p.yearUnit ? year.trace : p.engine.startTrace(u.id, today.positions.get(u.id)!.index);
      const sh = stageShift(tr, index);
      const fired = tr.fired[index]!;
      row("this year", signed(sh), sh ? "on" : "off");
      row("matched", fired < 0 ? "no rule" : `rule ${fired + 1}`);
      row("start", `D${tr.levels[index + 1]} · ${date(tr.levels[index + 1]!)}`);
      return info("C4 · STAGE", `stage ${index + 1}`, index === 0 ? "reads the base" : `reads stage ${index}`);
    }
    case "rule": {
      const r = ast.rules?.find((x) => x.id === id);
      if (!r) break;
      const holds = today.rules.get(r.id);
      row("today", holds === "error" ? "fails" : holds ? "holds" : "does not hold", holds === "error" ? "err" : holds ? "on" : "off");
      if (r.tags?.length) row("tags", r.tags.join(", "));
      const skips = skipsOf(r.rule).days.filter((d) => d >= year.start && d < year.start + year.length);
      if (skips.length) row("skips this year", skips.map((d) => `D${d}`).join(", "));
      return info("RULE · LAMP", r.name ?? r.id, `rule ${r.id} · edit in the form view or as text`);
    }
    case "ledger": {
      const u = unitOf(id);
      const e = u?.kind === "cycle" ? u.ledger?.[index] : undefined;
      if (!u || !e) break;
      const number = (u as CycleUnitAst).number ?? 0;
      const touches = year.ledger.some((s) => s.part === part);
      row("kind", e.kind);
      row("from", e.from + number);
      row("this year", touches ? "applies" : "does not apply", touches ? "on" : "off");
      if (e.kind === "switch") row("tag", `rule changes from year ${e.from + number}`);
      if (e.kind === "starts") row("pins", `${(e.lengths?.length ?? 0) + 1} starts from D${e.startsOn}`);
      return info("C6 · LEDGER", `${u.id} · ${e.kind}`, "edit in Exceptions");
    }
    case "day": {
      const d = ast.days?.[Number(id)];
      if (!d) break;
      row("day", `D${d.day} · ${date(d.day)}`);
      if (d.tags?.length) row("tags", d.tags.join(", "));
      return info("C6 · DAY", d.name ?? `D${d.day}`, "edit in Exceptions");
    }
    case "format": {
      const f = today.formats.find((x) => x.name === id);
      if (!f) break;
      row("today", f.text);
      return info("FORMAT", f.name, "text only");
    }
  }
  return info("—", part, "not in this calendar");
}

/** The selected part's canonical text, for the inspector's TEXT and the WRITES footer; "" when it has none. */
export function partText(ast: CalendarAst, part: PartId | null): string {
  try {
    return printPart(ast, part ?? "calendar") ?? "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------------------
// Camera, projection, picking, label layout (pure: the canvas only paints)
// ---------------------------------------------------------------------------

export interface Camera {
  readonly yaw: number;
  readonly pitch: number;
  readonly dist: number;
  readonly tx: number;
  readonly tz: number;
}
export type ViewName = "iso" | "top" | "side";
export interface Viewport {
  /** CSS pixels */
  readonly width: number;
  readonly height: number;
}
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  /** distance in front of the camera; the near plane is CAMERA.near */
  readonly depth: number;
}

export const CAMERA = {
  targetY: 0.4,
  /** focal length as a share of min(width, height) */
  focal: 1.2,
  near: 0.2,
  pitchMin: 0.02,
  pitchMax: 1.52,
  distMin: 2.6,
  distMax: 11,
  /** per second, the share of the way to the target the camera eases */
  ease: 7,
  /** radians per pixel of drag */
  orbitYaw: 0.008,
  orbitPitch: 0.006,
  /** zoom per wheel delta unit */
  zoom: 0.0012,
  pickRadius: 13,
} as const;

export const VIEWS: Readonly<Record<ViewName, Camera>> = {
  iso: { yaw: 0.32, pitch: 0.56, dist: 4.75, tx: 0, tz: 0 },
  top: { yaw: 0, pitch: 1.5, dist: 5.2, tx: 0, tz: 0 },
  side: { yaw: 0.32, pitch: 0.08, dist: 4.9, tx: 0, tz: 0 },
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** A drag of (dx, dy) CSS pixels: yaw follows x, pitch y (clamped). */
export function orbit(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, yaw: cam.yaw - dx * CAMERA.orbitYaw, pitch: clamp(cam.pitch + dy * CAMERA.orbitPitch, CAMERA.pitchMin, CAMERA.pitchMax) };
}

/** A wheel step (deltaY as the event gives it). */
export function zoom(cam: Camera, deltaY: number): Camera {
  return { ...cam, dist: clamp(cam.dist * (1 + deltaY * CAMERA.zoom), CAMERA.distMin, CAMERA.distMax) };
}

/** One frame of easing toward `target` (dt in seconds, capped at 0.1); `moving` false once it has arrived. */
export function easeCamera(cam: Camera, target: Camera, dt: number): { camera: Camera; moving: boolean } {
  const f = Math.min(1, Math.min(0.1, Math.max(0, dt)) * CAMERA.ease);
  let moving = false;
  const out = { ...cam };
  for (const k of ["yaw", "pitch", "dist", "tx", "tz"] as const) {
    const d = target[k] - cam[k];
    if (Math.abs(d) > 0.0005) {
      out[k] = cam[k] + d * f;
      moving = true;
    } else out[k] = target[k];
  }
  return { camera: out, moving };
}

/** A world point on screen (the handoff's hand-rolled perspective), or null behind the near plane. */
export function project(cam: Camera, vp: Viewport, p: Vec3): ScreenPoint | null {
  const f = Math.min(vp.width, vp.height) * CAMERA.focal;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const x = p[0] - cam.tx;
  const y = p[1] - CAMERA.targetY;
  const z = p[2] - cam.tz;
  const x1 = x * cy - z * sy;
  const z1 = x * sy + z * cy;
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const depth = cam.dist - z2;
  if (depth < CAMERA.near) return null;
  return { x: vp.width / 2 + (f * x1) / depth, y: vp.height / 2 - (f * y2) / depth, depth };
}

/** Which of the four depth bands (alpha 1, .86, .68, .5) a depth falls in. */
export function depthBand(depth: number, cam: Camera): 0 | 1 | 2 | 3 {
  return clamp(Math.floor(depth - cam.dist + 2), 0, 3) as 0 | 1 | 2 | 3;
}

/** The part under (x, y): the nearest projected pick point within `radius` CSS pixels, or null. */
export function pickPart(picks: readonly PickPoint[], cam: Camera, vp: Viewport, x: number, y: number, radius: number = CAMERA.pickRadius): PartId | null {
  let best: PartId | null = null;
  let bd = radius * radius;
  for (const pk of picks) {
    const q = project(cam, vp, pk.p);
    if (!q) continue;
    const d2 = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d2 < bd) {
      bd = d2;
      best = pk.part;
    }
  }
  return best;
}

/** What the canvas shows a part as: selected or hovered (or a slot of the selected unit) is `sel`, a part with problems `err`. */
export interface Highlight {
  readonly selected: PartId | null;
  readonly hover: PartId | null;
  readonly errors?: ReadonlySet<PartId>;
}

function isHot(part: PartId | null, h: Highlight): boolean {
  if (!part) return false;
  if (part === h.selected || part === h.hover) return true;
  if (!part.startsWith("slot:")) return false;
  const unit = `unit:${part.split(":")[1]}`;
  return unit === h.selected || unit === h.hover;
}

export function paintState(s: Segment, h: Highlight): PaintState {
  if (s.state === "grid") return "grid";
  if (isHot(s.part, h)) return "sel";
  if (s.part && h.errors?.has(s.part)) return "err";
  return s.state;
}

/** The theme tint group of a part (the studio theme tints bodies, gears, stages and seasons). */
export function partGroupOf(part: PartId | null): string | null {
  return part ? part.split(":")[0]! : null;
}

export interface PlacedLabel {
  readonly text: string;
  readonly part: PartId | null;
  readonly state: Exclude<PaintState, "grid" | "err">;
  /** 12 px / 600 with an outline plate; otherwise 11 px / 500 */
  readonly big: boolean;
  /** the plate, CSS pixels */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** the anchor, when the label moved off it and needs a leader line */
  readonly leader?: { readonly x: number; readonly y: number };
  readonly band: 0 | 1 | 2 | 3;
}

const PRIORITY = { sel: 0, hot: 1, line: 2, ghost: 3, dim: 4 } as const;

/**
 * Screen-space label layout (the handoff's): priority order (the index date
 * first), nearest first within a priority, collision-culled over up to six
 * candidate offsets; small labels give up, big ones overlap at their anchor.
 * `measure(text, big)` is the text width in CSS pixels (the canvas measures).
 */
export function layoutLabels(labels: readonly LabelAnchor[], cam: Camera, vp: Viewport, h: Highlight, measure: (text: string, big: boolean) => number): PlacedLabel[] {
  const items: Array<{ t: LabelAnchor; q: ScreenPoint; st: PlacedLabel["state"]; pr: number }> = [];
  for (const t of labels) {
    const hot = isHot(t.part, h);
    if (t.onlySelected && !hot) continue;
    const q = project(cam, vp, t.p);
    if (!q || q.x < -40 || q.x > vp.width + 40 || q.y < -20 || q.y > vp.height + 20) continue;
    const st = hot ? "sel" : t.state;
    items.push({ t, q, st, pr: t.priority ?? PRIORITY[st] });
  }
  items.sort((a, b) => a.pr - b.pr || a.q.depth - b.q.depth);
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const hit = (r: { x: number; y: number; w: number; h: number }) => placed.some((p) => r.x < p.x + p.w && r.x + r.w > p.x && r.y < p.y + p.h && r.y + r.h > p.y);
  const out: PlacedLabel[] = [];
  for (const it of items) {
    const big = it.pr <= 1;
    const fs = big ? 12 : 11;
    const w = Math.ceil(measure(it.t.text, big)) + 8;
    const hh = fs + 6;
    const cands = [[0, 0], [0, -hh - 3], [0, hh + 3], [w / 2 + 8, 0], [-w / 2 - 8, 0], [0, -2 * hh - 6]] as const;
    const tries = it.pr <= 1 ? cands.length : it.pr === 2 ? 3 : 1;
    let r: { x: number; y: number; w: number; h: number } | null = null;
    let ci = 0;
    for (; ci < tries; ci++) {
      const c = { x: Math.round(it.q.x + cands[ci]![0] - w / 2), y: Math.round(it.q.y + cands[ci]![1] - hh / 2), w, h: hh };
      if (!hit(c)) {
        r = c;
        break;
      }
    }
    if (!r) {
      if (!big) continue;
      ci = 0;
      r = { x: Math.round(it.q.x - w / 2), y: Math.round(it.q.y - hh / 2), w, h: hh };
    }
    placed.push({ x: r.x - 2, y: r.y - 1, w: r.w + 4, h: r.h + 2 });
    out.push({ text: it.t.text, part: it.t.part, state: it.st, big, ...r, ...(ci > 0 ? { leader: { x: it.q.x, y: it.q.y } } : {}), band: depthBand(it.q.depth, cam) });
  }
  return out;
}
