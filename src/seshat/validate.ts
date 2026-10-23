/**
 * The structural validator (docs/SESHAT-v0.md §5), for the AST subset in
 * ast.ts. It returns every problem it finds, as plain sentences; an empty
 * list means the calendar can be compiled.
 *
 * Covered here: ids and references (V1), monotone lengths (V3: every
 * occurrence at least one day, stages included), stage windows (V2),
 * magnitudes (V5), one base per unit (V8), gear sanity, and slot sums. The
 * inverse bound (V4) is computed by the start rule, and cycle lcm (V6) by
 * Engine.round. The ledger (C6) is checked for shape and order (V7), then for
 * continuity on the compiled starts. Labels (C5) are checked for shape.
 */
import type { BodyAst, CalendarAst, CycleRule, LiteralCrossingAst, CycleUnitAst, GearTerm, SlotsUnitAst, StageAst, UnitAst } from "./ast";
import { DAY_LIMIT } from "./day";
import { baseLengths, linearBase } from "./base";
import { gearMatcher, gearPeriod, lcm, mod, type GearAst } from "./gear";
import { slotLengthsIn } from "./slots";
import { compileUnit } from "./piecewise";
import { stageReach } from "./start";
import { Body } from "./body";
import { checkFormats } from "./format";
import { gcd } from "./rational";
import { crossingOrigin, crossingProblem, phaseNameProblem, resolve } from "./resolve";
import { tagsRead, type By, type RuleAst } from "./rule";

/** Largest gear period checked residue by residue; a bigger one is refused rather than sampled. */
const GEAR_PERIOD_MAX = 100_000;
/** Most distinct gears one slot unit may read: its slot sums are checked under every combination. */
const SLOT_GEARS_MAX = 8;
/**
 * V5: the largest anchor, length or gear add, in days. With every occurrence at
 * least one day, a day within ±DAY_LIMIT has |index| ≤ 3·DAY_LIMIT, so every
 * product in Engine.start stays below 2^52, where the floor divisions are exact.
 */
const MAGNITUDE_MAX = 2 * DAY_LIMIT;
/** V5 for a linear base: every k·a + c and (d + 1)·L − c stays below this, where the floor divisions are exact. */
const LINEAR_MAX = 2 ** 52;
/** V2: the farthest occurrence a stage rule may read, either way. */
const STAGE_WINDOW_MAX = 8;
/** Most occurrences of a staged cycle the slot-sum scan reads (Hebrew needs about 55,000). */
const SCAN_MAX = 1_000_000;
/** The occurrence indices a ledger entry may name: a day within ±DAY_LIMIT reaches no further (V5). */
const INDEX_MAX = 3 * DAY_LIMIT;
/** Most pinned starts in one unit's ledger. */
const PIN_MAX = 100_000;
/** Ledger switches per unit: a decree is rare, and the validator and engine walk them (quadratic past this). */
const SWITCH_MAX = 1_000;
/** Deepest all/any/not nesting in a rule: the text parser refuses blocks nested past NESTING_MAX (200). */
export const RULE_DEPTH_MAX = 64;
/** Largest |DAYS| of a SHIFT (§16.4). */
export const SHIFT_DAYS_MAX = 400;
/** Largest WITHIN of a FIRST (§16.4). */
export const FIRST_WITHIN_MAX = 400;


const isInt = (x: unknown): boolean => Number.isSafeInteger(x);
/** n/d as the text writes it: safe integers, lowest terms, positive denominator. */
const lowest = (r: unknown): boolean => isObj(r) && isInt(r.n) && isInt(r.d) && (r.d as number) > 0 && gcd(r.n as number, r.d as number) === 1;
/** No unpaired UTF-16 surrogate (by code unit, so this source holds no escape sequences). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}
/** Every declared id (units, gears, bodies, rules): the text syntax's id grammar. */
const ID_GRAMMAR = /^[a-z][a-z0-9-]*$/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Longest period BYSETPOS scans: checked here for constant-length cycles, and when a rule runs for the rest (engine-view.ts). */
export const SETPOS_PERIOD_MAX = 400;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
/** An unchecked value as it appears in the AST, for messages. */
const show = (x: unknown): string => String(JSON.stringify(x));
const inBounds = (x: number): boolean => isInt(x) && Math.abs(x) <= MAGNITUDE_MAX;

/**
 * One validation problem and the part of the definition it is about, so an
 * editor can show it beside the field or ledger entry it names (§15.9 S1).
 * A problem with no location is about the calendar as a whole.
 */
export interface Problem {
  readonly message: string;
  /** the unit it is about; with `entry`, the cycle unit whose ledger holds the entry */
  readonly unit?: string;
  /** 0-based index into that unit's ledger */
  readonly entry?: number;
  readonly gear?: string;
  readonly body?: string;
  readonly rule?: string;
  /** 0-based index into the calendar's day labels */
  readonly day?: number;
}
type Where = Omit<Problem, "message">;

export function validate(ast: CalendarAst): string[] {
  return problems(ast).map((p) => p.message);
}

/** `validate` with each problem's location: the same messages, in the same order. */
export function problems(stored: CalendarAst): Problem[] {
  // every check runs on resolved numbers (§16.2 D1); a crossing that cannot resolve stays as stored and reports here
  const ast = resolve(stored);
  const bodyMap = new Map((Array.isArray(ast.bodies) ? ast.bodies : []).filter((b): b is BodyAst => isObj(b)).map((b) => [b.id, b] as const));
  const errors: string[] = [];
  const locs: Array<Where | undefined> = [];
  /** the problems pushed since `n` that have no location yet are about `where` */
  const own = (n: number, where: Where): void => {
    for (let i = n; i < errors.length; i++) locs[i] ??= where;
  };
  const units = new Map(ast.units.map((u) => [u.id, u]));
  const gears = new Map(ast.gears.map((g) => [g.id, g]));
  const ids = [...ast.units.map((u) => u.id), ...ast.gears.map((g) => g.id), ...(ast.rules ?? []).map((r) => r.id), ...(ast.bodies ?? []).map((b) => b.id)];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`id "${id}" is declared more than once`);
  // one id grammar for every declared id, so every calendar has a text form (§4.1)
  for (const id of new Set(ids)) if (typeof id !== "string" || !ID_GRAMMAR.test(id)) errors.push(`id ${show(id)} must match [a-z][a-z0-9-]*`);
  if (typeof ast.name !== "string" || CONTROL.test(ast.name)) errors.push(`the calendar's name must be a string without control characters`);
  /** named phase points: season marks start at `from`, moon phases sit `at` */
  const marks = (ms: unknown, where: string, key: "from" | "at" = "from"): void => {
    if (!Array.isArray(ms)) return void errors.push(`${where}: marks must be a list`);
    for (const [i, m] of (ms as unknown[]).entries()) {
      if (!isObj(m) || typeof m.name !== "string" || !m.name) errors.push(`${where}: mark ${i + 1} needs a name`);
      else if (typeof m[key] !== "number" || !Number.isFinite(m[key]) || (m[key]) < 0 || (m[key]) >= 1) errors.push(`${where}: mark "${m.name}" must be at a phase in [0, 1)`);
    }
  };
  /** season marks (§16 D7): a fraction, DAY:N (N ≥ 1), or a day ≥ 1 of a declared, non-filler slot of a slot unit directly in the seasons unit */
  const seasonMarks = (ms: unknown, seasonsUnit: UnitAst | undefined): void => {
    if (!Array.isArray(ms)) return void errors.push(`seasons: marks must be a list`);
    for (const [i, m] of (ms as unknown[]).entries()) {
      if (!isObj(m) || typeof m.name !== "string" || !m.name) errors.push(`seasons: mark ${i + 1} needs a name`);
      else if ("slot" in m) {
        const at = `seasons: mark "${m.name}"`;
        const sl = m.slot;
        if (!isObj(sl) || typeof sl.unit !== "string") errors.push(`${at} needs a slot unit`);
        else {
          const su = units.get(sl.unit);
          if (!su) errors.push(`${at}: no unit "${sl.unit}"`);
          else if (su.kind !== "slots" || seasonsUnit === undefined || su.in !== seasonsUnit.id) errors.push(`${at}: "${su.id}" is not a slot unit directly in the seasons unit "${String(seasonsUnit?.id ?? (ast.seasons as { unit?: unknown }).unit)}"`);
          else if (typeof sl.index !== "number" || !isInt(sl.index) || sl.index < 0 || sl.index >= su.slots.length) errors.push(`${at}: "${su.id}" has no slot ${typeof sl.index === "number" ? sl.index + (su.number ?? 1) : show(sl.index)}`);
          else if (su.slots[sl.index]!.filler) errors.push(`${at}: slot ${sl.index + (su.number ?? 1)} of "${su.id}" is a filler slot; a season cannot start in one`);
          if (typeof sl.day !== "number" || !isInt(sl.day) || sl.day < 1) errors.push(`${at}: the day in the slot must be a whole number from 1`);
        }
      } else if ("day" in m) {
        if (typeof m.day !== "number" || !isInt(m.day) || m.day < 1) errors.push(`seasons: mark "${m.name}" must be on a whole day of the year from 1`);
      } else if (typeof m.from !== "number" || !Number.isFinite(m.from) || m.from < 0 || m.from >= 1) errors.push(`seasons: mark "${m.name}" must be at a phase in [0, 1)`);
    }
  };
  if (ast.seasons !== undefined) {
    const u = units.get(ast.seasons.unit);
    if (!u) errors.push(`seasons: no unit "${String(ast.seasons.unit)}"`);
    else if (u.kind !== "cycle") errors.push(`seasons: "${u.id}" is a slot unit; seasons follow a cycle unit's phase`);
    seasonMarks(ast.seasons.marks, u);
  }
  // predicates match moons by name, so two moons of one name would be one moon to every rule
  const moonNames = (ast.bodies ?? []).flatMap((b) => (b.moon ? [b.moon.name] : []));
  for (const n of new Set(moonNames.filter((n, i) => moonNames.indexOf(n) !== i))) errors.push(`moon "${n}" is declared more than once`);
  for (const b of ast.bodies ?? []) {
    const n = errors.length;
    if (b.moon !== undefined) {
      if (!isObj(b.moon) || typeof b.moon.name !== "string" || !b.moon.name) errors.push(`body "${b.id}": a moon needs a name`);
      else if (b.moon.phases !== undefined) marks(b.moon.phases, `moon "${b.moon.name}" phases`, "at");
    }
    // the text prints rationals as stored, and its parser reads only lowest terms with a positive denominator
    if (!lowest(b.period) || !lowest(b.epoch)) errors.push(`body "${b.id}": period and epoch must be n/d in lowest terms with d > 0`);
    else {
      try {
        new Body(b.period, b.epoch);
      } catch (e) {
        errors.push(`body "${b.id}": ${(e as Error).message}`);
      }
    }
    own(n, { body: b.id });
  }
  // a stored calendar travels as UTF-8: a lone surrogate would come back as U+FFFD, a different string.
  // And one spelling per string (NFC, ruled 2026-10-19): a tag in another Unicode form would silently stop matching.
  const broken = new Set<string>();
  const unnormal = new Set<string>();
  const strings = (x: unknown): void => {
    if (typeof x === "string") {
      if (!wellFormed(x)) broken.add(x);
      else if (x.normalize("NFC") !== x) unnormal.add(x);
    } else if (Array.isArray(x)) x.forEach(strings);
    else if (isObj(x)) Object.values(x).forEach(strings);
  };
  strings(ast);
  for (const s of broken) errors.push(`${show(s)} is not well-formed text (a lone surrogate)`);
  for (const s of unnormal) errors.push(`${show(s)} is not in Unicode NFC (store names and tags in NFC)`);
  for (const [i, d] of (ast.days ?? []).entries()) {
    const n = errors.length;
    if (!isInt(d.day)) errors.push(`day label ${i + 1}: day ${show(d.day)} is not a whole day`);
    checkLabel(d, `day label ${i + 1}`, (msg) => errors.push(msg));
    own(n, { day: i });
  }

  // ids with a problem of their own; the slot-sum check needs its unit, parent and gears clean, whatever the declaration order
  const bad = new Set<string>();
  const fail = (id: string, msg: string) => {
    bad.add(id);
    errors.push(msg);
  };

  for (const g of ast.gears) {
    const n = errors.length;
    const on = units.get(g.on);
    if (!on) errors.push(`gear "${g.id}": no unit "${g.on}"`);
    else if (on.kind !== "cycle") errors.push(`gear "${g.id}": reads "${g.on}", which is not a cycle unit`);
    checkGear(g, errors);
    if (errors.length > n) bad.add(g.id);
    own(n, { gear: g.id });
  }

  /** Gear terms must name a gear that reads `on`; returns the most a length can lose to them. */
  const checkTerms = (id: string, where: string, terms: readonly GearTerm[] | undefined, on: string): number => {
    let loss = 0;
    for (const t of terms ?? []) {
      const g = gears.get(t.gear);
      if (!g) fail(id, `${where}: no gear "${t.gear}"`);
      else if (g.on !== on) fail(id, `${where}: gear "${t.gear}" reads "${g.on}", not "${on}"`);
      if (!inBounds(t.add)) fail(id, `${where}: gear "${t.gear}" adds ${t.add}, not a whole number of days within ±${MAGNITUDE_MAX}`);
      else loss += Math.min(0, t.add);
    }
    return loss;
  };

  for (const u of ast.units) {
    const at = `unit "${u.id}"`;
    const n0 = errors.length;
    if (u.kind === "cycle") {
      const unitFail = (msg: string) => fail(u.id, `${at}: ${msg}`);
      /** a start rule: the unit's own, or a ledger switch's (V3, V5, V8 per rule) */
      const checkRule = (rule: CycleRule, where: string) => {
        const rf = (msg: string) => fail(u.id, `${where}: ${msg}`);
        // the most gear terms and stages can take off an occurrence
        const loss = checkTerms(u.id, where, rule.gears, u.id) - checkStages(rule.stages, rf);
        const shortest = checkBase(rule, loss, rf, bodyMap);
        if (shortest !== null && shortest + loss < 1) rf(`an occurrence can be ${shortest + loss} days long; every occurrence needs at least one day (V3)`);
      };
      checkRule(u, at);
      if (u.labels !== undefined) {
        if (!Array.isArray(u.labels) || !u.labels.length) unitFail("labels must be a non-empty list");
        else (u.labels as unknown[]).forEach((l, i) => checkLabel(l, `label ${i + 1}`, unitFail));
      }
      own(n0, { unit: u.id });
      if (u.ledger !== undefined) {
        const located = (entry: number | undefined, check: () => void): void => {
          const n = errors.length;
          check();
          own(n, entry === undefined ? { unit: u.id } : { unit: u.id, entry });
        };
        checkLedger(
          u,
          units,
          (msg, entry) => located(entry, () => unitFail(msg)),
          (rule, where, entry) => located(entry, () => checkRule(rule, `${at} ${where}`)),
        );
      }
      continue;
    }
    const chain = chainOf(u, units);
    const root = Array.isArray(chain) ? (chain[0] as CycleUnitAst) : null;
    if (!units.has(u.in)) fail(u.id, `${at}: no parent unit "${u.in}"`);
    else if (chain === "loop") fail(u.id, `${at}: its parents loop back on themselves; a slot unit must sit under a cycle unit`);
    else if (chain === "missing") bad.add(u.id); // the unit missing higher up reports itself
    for (const [i, s] of u.slots.entries()) {
      const where = `${at} slot ${i + 1}`;
      if (s.name !== undefined || s.tags !== undefined) checkLabel({ name: s.name, tags: s.tags }, "its name and tags", (msg) => fail(u.id, `${where}: ${msg}`));
      if (s.length === "slack") {
        if (s.gears?.length) fail(u.id, `${where}: a slack slot takes what is left and cannot carry gear terms`);
        const min = s.min ?? 0;
        if (s.min !== undefined && (!inBounds(s.min) || s.min < 0)) fail(u.id, `${where}: min ${s.min} is not a whole number of days in 0..${MAGNITUDE_MAX}`);
        if (s.max !== undefined && (!inBounds(s.max) || s.max < min)) fail(u.id, `${where}: max ${s.max} is not a whole number of days from min (${min}) to ${MAGNITUDE_MAX}`);
        if (s.fill !== undefined && !inBounds(s.fill)) fail(u.id, `${where}: fill ${s.fill} is not a whole number`);
        continue;
      }
      if (s.min !== undefined || s.max !== undefined || s.fill !== undefined) fail(u.id, `${where}: min, max and fill belong to slack slots only`);
      if (typeof s.length === "object") {
        if (s.gears?.length) fail(u.id, `${where}: a keyed slot takes its length from its table and cannot carry gear terms`);
        if (isObj(s.length)) checkKeyed(s.length, (msg) => fail(u.id, `${where}: ${msg}`));
        else fail(u.id, `${where}: length ${show(s.length)} is not a number, "slack" or a keyed table`);
        continue;
      }
      if (!inBounds(s.length) || s.length < 0) fail(u.id, `${where}: length ${s.length} is not a whole number of days in 0..${MAGNITUDE_MAX}`);
      if (root) checkTerms(u.id, where, s.gears, root.id);
    }
    own(n0, { unit: u.id });
  }

  // V7 on the compiled starts: strictly increasing across every pin and switch (one comparison per boundary)
  for (const u of ast.units) {
    if (u.kind !== "cycle" || !u.ledger?.length || bad.has(u.id)) continue;
    const read = [u, ...u.ledger.flatMap((e) => (e.kind === "switch" ? [e.rule] : []))].flatMap((r) => r.gears ?? []).map((t) => t.gear);
    if (read.some((g) => bad.has(g) || !gears.has(g))) continue;
    const rule = compileUnit(u, gears);
    // each boundary and the entry that puts it there (the first to name it)
    const boundaries = new Map<number, number>();
    for (const [i, e] of u.ledger.entries()) {
      if (e.kind === "switch" && !boundaries.has(e.from)) boundaries.set(e.from, i);
      if (e.kind === "starts") for (let k = e.from; k <= e.from + (e.lengths?.length ?? 0) + 1; k++) if (!boundaries.has(k)) boundaries.set(k, i);
    }
    for (const [k, entry] of [...boundaries].sort((a, b) => a[0] - b[0])) {
      const [before, here] = [rule.start(k - 1), rule.start(k)];
      const n = errors.length;
      if (here <= before) fail(u.id, `unit "${u.id}": occurrence ${k - 1} would be ${here - before} days long (it starts on day ${before}, the next on day ${here}); every occurrence needs at least one day (V7)`);
      own(n, { unit: u.id, entry });
    }
  }

  // slot sums need the whole chain clean: the unit, every slot unit above it, the cycle, and every gear they read.
  // Parents come first, so a unit whose parent's sums failed is skipped rather than reporting the same fault again.
  const done = new Set<string>();
  const scans = new Map<string, CycleState[] | string>();
  const sums = (u: SlotsUnitAst, chain: UnitAst[]): void => {
    if (done.has(u.id)) return;
    done.add(u.id);
    const parent = chain[chain.length - 2]!;
    if (parent.kind === "slots") sums(parent, chain.slice(0, -1));
    if (chain.some((c) => bad.has(c.id))) return;
    const read = chain
      .flatMap((c) => (c.kind === "cycle" ? [...(c.gears ?? []), ...(c.ledger ?? []).flatMap((e) => (e.kind === "switch" ? (e.rule.gears ?? []) : []))] : c.slots.flatMap((s) => s.gears ?? [])))
      .map((t) => t.gear);
    if (read.some((g) => bad.has(g) || !gears.has(g))) return;
    const n = errors.length;
    const failed = checkSlotSums(u, chain, [...new Set(read)], gears, scans, errors);
    if (failed !== true) {
      bad.add(u.id);
      own(n, failed.entry === undefined ? { unit: u.id } : { unit: chain[0]!.id, entry: failed.entry });
    }
  };
  for (const u of ast.units) {
    const chain = u.kind === "slots" ? chainOf(u, units) : null;
    if (u.kind === "slots" && Array.isArray(chain)) sums(u, chain);
  }
  errors.push(...checkFormats(ast));
  for (const r of ast.rules ?? []) {
    const n = errors.length;
    if (r.tags !== undefined) checkLabel({ tags: r.tags }, `rule "${r.id}"`, (msg) => errors.push(msg));
    errors.push(...checkRule(r.rule, ast, `rule "${r.id}"`));
    own(n, { rule: r.id });
  }
  for (const c of ruleCycles(ast)) {
    const n = errors.length;
    errors.push(`rules read each other's tags in a cycle: ${c.map((id) => `"${id}"`).join(" → ")}`);
    own(n, { rule: c[0]! });
  }
  return errors.map((message, i) => ({ message, ...locs[i] }));
}

/**
 * One base per unit that never resets (V8): a constant anchor and length, or a
 * crossing. A crossing's rationals must be in lowest terms (so equal calendars
 * hash equal), its period at least one day, and its integer form must stay
 * below 2^52 for every day within ±DAY_LIMIT (V5, §2.3.2). `loss` is the most
 * the unit's gear terms can take off an occurrence. Returns the shortest base
 * occurrence, or null when the base is unusable.
 */
function checkBase(u: CycleRule, loss: number, fail: (msg: string) => void, bodies: ReadonlyMap<string, BodyAst>): number | null {
  const n0 = u as { anchor?: unknown; length?: unknown; crossing?: unknown };
  if (u.crossing == null) {
    if (n0.anchor === undefined || n0.length === undefined) return fail("needs a base: an anchor and a length, or a crossing (V8)"), null;
    let ok = true;
    if (!isInt(u.anchor) || Math.abs(u.anchor) > DAY_LIMIT) ok = (fail(`anchor ${u.anchor} is not a whole day within ±${DAY_LIMIT}`), false);
    if (!inBounds(u.length)) ok = (fail(`length ${u.length} is not a whole number of days within ±${MAGNITUDE_MAX}`), false);
    return ok ? u.length : null;
  }
  if (n0.anchor !== undefined || n0.length !== undefined) return fail("has both a crossing and an anchor or length; a unit has one base (V8)"), null;
  // still a body reference or a start mode after the resolve pass: it could not resolve
  const unresolved = n0.crossing as { body?: unknown; start?: unknown } | null;
  if (typeof unresolved === "object" && unresolved !== null && (unresolved.body !== undefined || unresolved.start !== undefined)) {
    return fail(crossingProblem(u.crossing, bodies) ?? "crossing could not resolve"), null;
  }
  const x = n0.crossing as { period?: unknown; at?: unknown } | null;
  const isRational = (r: unknown): r is { n: number; d: number } => typeof r === "object" && r !== null && isInt((r as { n: unknown }).n) && isInt((r as { d: unknown }).d);
  if (typeof x !== "object" || x === null || !isRational(x.period) || !isRational(x.at)) return fail("crossing needs a period and an instant, each a rational { n, d } of safe integers"), null;
  const { period, at } = u.crossing as LiteralCrossingAst;
  // a resolved body reference names its body in V5 and V8 messages (§16.4)
  const origin = crossingOrigin(u.crossing);
  const after = origin?.after ? ";START=after" : "";
  const named = origin?.body !== undefined
    ? `crossing following body "${origin.body}"${after} (period ${period.n}/${period.d}, instant ${at.n}/${at.d})`
    : origin?.after?.at
      ? `crossing ${period.n}/${period.d} at ${origin.after.at.n}/${origin.after.at.d};START=after (instant ${at.n}/${at.d})`
      : `crossing ${period.n}/${period.d} at ${at.n}/${at.d}`;
  if (period.d <= 0 || at.d <= 0 || gcd(period.n, period.d) !== 1 || gcd(at.n, at.d) !== 1) return fail("crossing period and instant must be rationals n/d in lowest terms with d > 0"), null;
  if (period.n < period.d) return fail(`${origin ? `${named}: ` : ""}crossing period ${period.n}/${period.d} is shorter than one day (V8)`), null;
  if (Math.abs(at.n / at.d) > DAY_LIMIT) return fail(`${origin ? `${named}: ` : ""}crossing instant ${at.n}/${at.d} is outside ±${DAY_LIMIT}`), null;
  const index = (n0.crossing as { index?: unknown }).index as { a?: unknown; c?: unknown; L?: unknown } | undefined;
  if (index !== undefined && (typeof index !== "object" || index === null || !isInt(index.a) || !isInt(index.c) || !isInt(index.L) || (index.a as number) < 1 || (index.L as number) < 1)) {
    return fail("crossing index must be { a, c, L } of safe integers with a ≥ 1 and L ≥ 1 (the crossing number floor((k·a + c)/L))"), null;
  }
  const { a, c, L } = linearBase(u);
  const idx = u.crossing.index;
  // occurrence k spans floor or ceil of index.a / index.L crossings; each crossing step is floor or ceil of a / L days
  const shortest = (idx ? baseLengths(idx)[0]! : 1) * baseLengths({ a, c, L })[0]!;
  if (shortest < 1) return fail("crossing index steps by 0 crossings; every occurrence needs at least one day (V3)"), null;
  // the engine evaluates k·a + c and (d + 1)·L − c (through the index map, k·index.a + index.c first), k within the
  // indices a day in range can reach, plus correction steps; gear terms and stages can shorten an occurrence to
  // shortest + loss (≥ 1 by V3), so they reach that many more indices
  const kMax = Math.ceil((3 * DAY_LIMIT) / Math.max(1, shortest + loss)) + 2;
  const mMax = idx ? Math.ceil((kMax * idx.a + Math.abs(idx.c)) / idx.L) + 1 : kMax;
  const fits = Math.abs(c) + (DAY_LIMIT + 1) * L < LINEAR_MAX && Math.abs(c) + mMax * a < LINEAR_MAX && isInt(c) && (!idx || kMax * idx.a + Math.abs(idx.c) < LINEAR_MAX);
  if (!fits) return fail(`${named} is too fine for exact integer days within ±${DAY_LIMIT} (V5): use a coarser period or instant`), null;
  return shortest;
}

function checkGear(g: GearAst, errors: string[]): void {
  if (g.kind === "positions") {
    if (!isInt(g.period) || g.period < 1 || g.period > GEAR_PERIOD_MAX) return void errors.push(`gear "${g.id}": period ${g.period} is not a whole number in 1..${GEAR_PERIOD_MAX}`);
    if (new Set(g.positions).size !== g.positions.length) errors.push(`gear "${g.id}": a position is listed twice`);
    for (const p of g.positions) if (!isInt(p) || p < 0 || p >= g.period) errors.push(`gear "${g.id}": position ${p} is outside 0..${g.period - 1}`);
    if (g.offset !== undefined && !inBounds(g.offset)) errors.push(`gear "${g.id}": offset ${g.offset} is not a whole number within ±${MAGNITUDE_MAX}`);
    return;
  }
  if (!g.terms.length) return void errors.push(`gear "${g.id}": no intervals`);
  for (const t of g.terms) {
    if (!isInt(t.every) || t.every < 1 || t.every > GEAR_PERIOD_MAX) return void errors.push(`gear "${g.id}": interval ${t.every} is not a whole number in 1..${GEAR_PERIOD_MAX}`);
    if (t.offset !== undefined && !inBounds(t.offset)) return void errors.push(`gear "${g.id}": offset ${t.offset} is not a whole number within ±${MAGNITUDE_MAX}`);
  }
  const period = gearPeriod(g);
  if (period > GEAR_PERIOD_MAX) return void errors.push(`gear "${g.id}": period ${period} is too long to check (max ${GEAR_PERIOD_MAX})`);
  // the O(1) count assumes the signed sum is 0 or 1 at every index: check one full period
  for (let n = 0; n < period; n++) {
    let s = 0;
    for (const t of g.terms) if (mod(n - (t.offset ?? 0), t.every) === 0) s += t.sign;
    if (s !== 0 && s !== 1) return void errors.push(`gear "${g.id}": index ${n} is counted ${s} times; include/exclude intervals must nest`);
  }
}

/** The units from the cycle down to `u`, or why there is no such chain: a parent is missing, or the parents loop. */
function chainOf(u: UnitAst, units: Map<string, UnitAst>): UnitAst[] | "missing" | "loop" {
  const chain: UnitAst[] = [u];
  for (let c = u; c.kind === "slots"; ) {
    const p = units.get(c.in);
    if (!p) return "missing";
    if (chain.includes(p)) return "loop";
    chain.unshift(p);
    c = p;
  }
  return chain;
}

/** A keyed slot length (C2): ordered [parent length, length] pairs, each parent length once. */
function checkKeyed(k: Record<string, unknown>, fail: (msg: string) => void): void {
  if (k.by !== "parent" || !Array.isArray(k.table) || !k.table.length) return fail('a keyed length is { by: "parent", table: [[parentLength, length], …] } with at least one row');
  const parents = new Set<number>();
  for (const row of k.table as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !isInt(row[0]) || (row[0] as number) < 1 || !inBounds(row[1] as number) || (row[1] as number) < 0) return fail(`table row ${show(row)} is not [parent length ≥ 1, length ≥ 0]`);
    if (parents.has(row[0] as number)) return fail(`table lists parent length ${show(row[0])} twice`);
    parents.add(row[0] as number);
  }
}

/**
 * C6 ledger shape (§2.7.1, V7): switches in strictly increasing order with a
 * valid rule each; pinned runs that do not overlap one another or sit on a
 * switch's first occurrence; slot overrides that name a slot unit under this
 * cycle, the right path and one length per slot. Continuity is checked on the
 * compiled starts afterwards.
 */
function checkLedger(u: CycleUnitAst, units: ReadonlyMap<string, UnitAst>, fail: (msg: string, entry?: number) => void, checkRule: (rule: CycleRule, where: string, entry: number) => void): void {
  if (!Array.isArray(u.ledger)) return fail("ledger must be a list");
  const switchCount = (u.ledger as unknown[]).filter((e) => isObj(e) && e.kind === "switch").length;
  if (switchCount > SWITCH_MAX) return fail(`${switchCount} ledger switches; at most ${SWITCH_MAX}`);
  let lastSwitch = -Infinity;
  const switches = new Map<number, number>();
  const pinned = new Set<number>();
  const overridden = new Set<string>();
  for (const [i, e] of (u.ledger as unknown[]).entries()) {
    const where = `ledger entry ${i + 1}`;
    if (!isObj(e)) {
      fail(`${where} is not an object`, i);
      continue;
    }
    if (!isInt(e.from) || Math.abs(e.from as number) > INDEX_MAX) {
      fail(`${where}: from ${show(e.from)} is not a whole occurrence index within ±${INDEX_MAX}`, i);
      continue;
    }
    const from = e.from as number;
    if (e.kind === "switch") {
      if (from <= lastSwitch) fail(`${where}: switches must come in increasing order of from`, i);
      lastSwitch = from;
      switches.set(from, i);
      if (!isObj(e.rule)) fail(`${where}: a switch needs a rule`, i);
      else checkRule(e.rule as unknown as CycleRule, `${where} (switch at ${from})`, i);
    } else if (e.kind === "starts") {
      if (!isInt(e.startsOn) || Math.abs(e.startsOn as number) > MAGNITUDE_MAX) fail(`${where}: startsOn ${show(e.startsOn)} is not a whole day within ±${MAGNITUDE_MAX}`, i);
      const lengths = e.lengths ?? [];
      if (!Array.isArray(lengths) || (lengths as unknown[]).some((l) => !isInt(l) || (l as number) < 1 || (l as number) > MAGNITUDE_MAX)) {
        fail(`${where}: lengths must be whole numbers of days ≥ 1`, i);
        continue;
      }
      const lastStart = (e.startsOn as number) + (lengths as number[]).reduce((a, b) => a + b, 0);
      if (Math.abs(lastStart) > MAGNITUDE_MAX) fail(`${where}: its last pinned start, day ${lastStart}, is outside ±${MAGNITUDE_MAX}`, i);
      for (let k = from; k <= from + lengths.length; k++) {
        if (pinned.has(k)) fail(`${where}: occurrence ${k} is pinned twice`, i);
        pinned.add(k);
      }
      if (pinned.size > PIN_MAX) fail(`${where}: more than ${PIN_MAX} pinned starts`, i);
    } else if (e.kind === "slots") {
      const target = typeof e.unit === "string" ? units.get(e.unit) : undefined;
      const chain = target ? chainOf(target, new Map(units)) : null;
      if (!target || target.kind !== "slots" || !Array.isArray(chain) || chain[0] !== u) {
        fail(`${where}: unit ${show(e.unit)} is not a slot unit under "${u.id}"`, i);
        continue;
      }
      const path = e.path ?? [];
      const between = chain.slice(1, -1) as SlotsUnitAst[];
      const pathOk = Array.isArray(path) && path.length === between.length && (path as unknown[]).every((x, j) => isInt(x) && (x as number) >= 0 && (x as number) < between[j]!.slots.length && !between[j]!.slots[x as number]!.filler);
      if (!pathOk) fail(`${where}: path must name one non-filler slot of each of the ${between.length} slot unit(s) between "${u.id}" and "${target.id}"`, i);
      if (!Array.isArray(e.lengths) || e.lengths.length !== target.slots.length || (e.lengths as unknown[]).some((l) => !isInt(l) || (l as number) < 0 || (l as number) > MAGNITUDE_MAX)) fail(`${where}: lengths must be ${target.slots.length} whole numbers of days ≥ 0, one per slot of "${target.id}"`, i);
      const key = `${target.id}|${from}|${show(path)}`;
      if (overridden.has(key)) fail(`${where}: occurrence ${from} of "${target.id}" is overridden twice`, i);
      overridden.add(key);
    } else fail(`${where}: kind ${show(e.kind)} is not switch, starts or slots`, i);
  }
  for (const k of pinned) if (switches.has(k)) fail(`occurrence ${k} is both pinned and a switch's first occurrence; pin the next one instead`, switches.get(k));
}

/** C5: a label's name is a string; its tags are distinct non-empty strings (they are hashed and reach predicates). */
function checkLabel(l: unknown, where: string, fail: (msg: string) => void): void {
  if (!isObj(l)) return fail(`${where} must be an object with a name and/or tags`);
  if (l.name !== undefined && typeof l.name !== "string") fail(`${where}: name ${show(l.name)} is not a string`);
  else if (typeof l.name === "string" && CONTROL.test(l.name)) fail(`${where}: name ${show(l.name)} has a control character`);
  if (Array.isArray(l.tags) && (l.tags as unknown[]).some((t) => typeof t === "string" && CONTROL.test(t))) fail(`${where}: a tag has a control character`);
  if (l.tags === undefined) return;
  if (!Array.isArray(l.tags) || (l.tags as unknown[]).some((t) => typeof t !== "string" || !t)) return fail(`${where}: tags must be a list of non-empty strings`);
  if (new Set(l.tags).size !== l.tags.length) fail(`${where}: a tag is listed twice`);
}

/**
 * Stages (C4, V2): each rule shifts by a whole number of days and reads a
 * finite window of the stage below (a residue of its start, or the length of
 * occurrence k + at, |at| ≤ STAGE_WINDOW_MAX). Stages read only the stage
 * below by construction, so they are acyclic. Returns the most the stages
 * together can take off an occurrence (Σ up + down), for V3.
 */
function checkStages(stages: CycleUnitAst["stages"], fail: (msg: string) => void): number {
  if (stages === undefined) return 0;
  if (!Array.isArray(stages)) return fail("stages must be a list"), 0;
  let reach = 0;
  for (const [j, stage] of (stages as unknown[]).entries()) {
    const where = `stage ${j + 1}`;
    const rules = isObj(stage) ? stage.rules : undefined;
    if (!Array.isArray(rules) || !rules.length) {
      fail(`${where} has no rules`);
      continue;
    }
    let ok = true;
    for (const [i, r] of (rules as unknown[]).entries()) {
      const at = `${where} rule ${i + 1}`;
      const bad = (msg: string) => ((ok = false), fail(`${at}: ${msg}`));
      if (!isObj(r)) {
        bad("a rule is an object with an add and a residue or length test");
        continue;
      }
      if (!inBounds(r.add as number)) bad(`add ${show(r.add)} is not a whole number of days within ±${MAGNITUDE_MAX}`);
      if (isObj(r.residue)) {
        const { mod: m, offset, in: set } = r.residue;
        if (!isInt(m) || (m as number) < 1 || (m as number) > GEAR_PERIOD_MAX) bad(`mod ${show(m)} is not a whole number in 1..${GEAR_PERIOD_MAX}`);
        else if (!Array.isArray(set) || !set.length) bad("a residue test needs at least one residue");
        else if (new Set(set).size !== set.length || (set as unknown[]).some((x) => !isInt(x) || (x as number) < 0 || (x as number) >= (m as number))) bad(`residues must be distinct whole numbers in 0..${(m as number) - 1}`);
        if (offset !== undefined && !inBounds(offset as number)) bad(`offset ${show(offset)} is not a whole number within ±${MAGNITUDE_MAX}`);
      } else if (isObj(r.length)) {
        const { at: w, is } = r.length;
        if (!isInt(w) || Math.abs(w as number) > STAGE_WINDOW_MAX) bad(`window offset ${show(w)} is not a whole number within ±${STAGE_WINDOW_MAX} (V2)`);
        if (!isInt(is) || (is as number) < 1) bad(`length ${show(is)} is not a whole number of days ≥ 1`);
      } else bad("a rule tests a residue or a length");
    }
    if (ok) {
      const { up, down } = stageReach(stage as StageAst);
      reach += up + down;
    }
  }
  return reach;
}

interface CycleState {
  readonly total: number;
  readonly on: (g: string) => boolean;
  readonly label: string;
  /** set when a ledger slot override names this occurrence, so its slots are read with the override */
  readonly k?: number;
}

/**
 * Every state an occurrence of the chain's cycle can be in: its length and
 * which gears match. With stages or a derived index, lengths depend on
 * neighbouring occurrences, so the states are read off every occurrence a day
 * within ±DAY_LIMIT can reach (exact; no unreachable combination can fail the
 * check). Otherwise they are every gear combination with every base length
 * (stricter than reality, never looser).
 */
function cycleStates(chain: UnitAst[], involved: string[], gears: ReadonlyMap<string, GearAst>, scans: Map<string, CycleState[] | string>): CycleState[] | string {
  const root = chain[0] as CycleUnitAst;
  const keyed = chain.some((c) => c.kind === "slots" && c.slots.some((sl) => isObj(sl.length)));
  const switchRules = (root.ledger ?? []).flatMap((e) => (e.kind === "switch" ? [e.rule] : []));
  const staged = [root, ...switchRules].some((r) => r.stages?.length || r.crossing?.index);
  if (!staged && (root.ledger?.length || keyed)) return ruleStates(root, switchRules, involved, gears);
  if (staged) {
    // one scan per cycle and gear set, shared by every slot unit under it
    const cacheKey = `${root.id}|${involved.join()}`;
    const cached = scans.get(cacheKey);
    if (cached) return cached;
    const rule = compileUnit(root, gears);
    const [lo, hi] = [rule.indexAt(-DAY_LIMIT), rule.indexAt(DAY_LIMIT)];
    if (hi - lo > SCAN_MAX) {
      const msg = `"${root.id}" has ${hi - lo + 1} occurrences within ±${DAY_LIMIT}; slot units under a staged, ledgered or keyed cycle are checked occurrence by occurrence, at most ${SCAN_MAX}`;
      scans.set(cacheKey, msg);
      return msg;
    }
    // occurrences a slot override names are checked one by one; the rest by distinct state
    const overridden = new Set((root.ledger ?? []).flatMap((e) => (e.kind === "slots" ? [e.from] : [])));
    const seen = new Map<string, CycleState>();
    const match = involved.map((id) => gearMatcher(gears.get(id)!));
    for (let k = lo, s = rule.start(lo); k <= hi; k++) {
      const next = rule.start(k + 1);
      let mask = 0;
      for (let i = 0; i < involved.length; i++) if (match[i]!(k)) mask |= 1 << i;
      const key = overridden.has(k) ? `k${k}` : `${next - s}|${mask}`;
      if (!seen.has(key)) {
        const m = mask;
        seen.set(key, { total: next - s, on: (g) => ((m >> involved.indexOf(g)) & 1) === 1, label: `"${root.id}" ${k}: ${next - s} days`, ...(overridden.has(k) && { k }) });
      }
      s = next;
    }
    const states = [...seen.values()];
    scans.set(cacheKey, states);
    return states;
  }
  const states: CycleState[] = [];
  for (let mask = 0; mask < 1 << involved.length; mask++) {
    const on = (g: string) => ((mask >> involved.indexOf(g)) & 1) === 1;
    const label = involved.map((id, i) => `${id}=${(mask >> i) & 1}`).join(", ") || "always";
    const add = (root.gears ?? []).reduce((a, t) => a + (on(t.gear) ? t.add : 0), 0);
    for (const len of baseLengths(linearBase(root))) states.push({ total: len + add, on, label });
  }
  return states;
}

/**
 * States of a cycle whose rules have no stages: one gear period of each rule
 * (exact, as gear-only lengths repeat with the lcm of the gear periods; a
 * crossing base adds its two base lengths to every gear state, stricter than
 * reality), plus every occurrence a ledger entry touches, read off the
 * compiled starts, each with its own index so a slot override applies.
 */
function ruleStates(root: CycleUnitAst, switchRules: CycleRule[], involved: string[], gears: ReadonlyMap<string, GearAst>): CycleState[] {
  const states: CycleState[] = [];
  const match = involved.map((g) => gearMatcher(gears.get(g)!));
  const bitsAt = (k: number) => {
    const bits = match.map((m) => m(k));
    return (g: string) => bits[involved.indexOf(g)] ?? false;
  };
  for (const [j, rule] of [root, ...switchRules].entries()) {
    const name = j === 0 ? `"${root.id}"` : `"${root.id}" switch ${j}`;
    const terms = (rule.gears ?? []).map((t) => ({ add: t.add, g: gears.get(t.gear)!, m: gearMatcher(gears.get(t.gear)!) }));
    const base = baseLengths(linearBase(rule));
    // lengths and every gear bit the slots read repeat together with the lcm of all their periods
    let period = 1;
    for (const g of new Set([...terms.map((t) => t.g), ...involved.map((id) => gears.get(id)!)])) {
      period = lcm(period, gearPeriod(g));
      if (period > SCAN_MAX) break;
    }
    if (period > SCAN_MAX) {
      // too long to walk: every combination of gear bits with every base length, stricter than reality, never looser
      for (let mask = 0; mask < 1 << involved.length; mask++) {
        const on = (g: string) => ((mask >> involved.indexOf(g)) & 1) === 1;
        const add = terms.reduce((a, t) => a + (on(t.g.id) ? t.add : 0), 0);
        const label = `${name}, ${involved.map((id, i) => `${id}=${(mask >> i) & 1}`).join(", ") || "always"}`;
        for (const len of base) states.push({ total: len + add, on, label });
      }
      continue;
    }
    const seen = new Set<string>();
    for (let k = 0; k < period; k++) {
      const on = bitsAt(k);
      const add = terms.reduce((a, t) => a + (t.m(k) ? t.add : 0), 0);
      for (const len of base) {
        const key = `${len + add}|${involved.map((g) => (on(g) ? 1 : 0)).join("")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        states.push({ total: len + add, on, label: `${name}, occurrence ${k} of a ${period}-occurrence gear period` });
      }
    }
  }
  const rule = compileUnit(root, gears);
  const touched = new Set<number>();
  for (const e of root.ledger ?? []) {
    const last = e.kind === "starts" ? e.from + (e.lengths?.length ?? 0) : e.from;
    for (let k = e.from - 1; k <= last; k++) touched.add(k);
  }
  const overridden = new Set((root.ledger ?? []).flatMap((e) => (e.kind === "slots" ? [e.from] : [])));
  for (const k of touched) {
    const total = rule.start(k + 1) - rule.start(k);
    states.push({ total, on: bitsAt(k), label: `"${root.id}" ${k}: ${total} days`, ...(overridden.has(k) && { k }) });
  }
  return states;
}

/**
 * In every state of the chain's cycle, each slot unit's slots must fit every
 * length a non-filler occurrence of its parent can have (slotLengthsIn: fixed
 * slots and their gear terms, slack within its min and max).
 */
function checkSlotSums(u: SlotsUnitAst, chain: UnitAst[], involved: string[], gears: ReadonlyMap<string, GearAst>, scans: Map<string, CycleState[] | string>, errors: string[]): true | { entry?: number } {
  if (involved.length > SLOT_GEARS_MAX) return (errors.push(`unit "${u.id}": reads ${involved.length} gears; at most ${SLOT_GEARS_MAX}`), {});
  const states = cycleStates(chain, involved, gears, scans);
  if (typeof states === "string") return (errors.push(`unit "${u.id}": ${states}`), {});
  // override key -> [lengths, index of its ledger entry on the chain's cycle]
  const overrides = new Map(((chain[0] as CycleUnitAst).ledger ?? []).flatMap((e, i) => (e.kind === "slots" ? [[`${e.unit}|${[e.from, ...(e.path ?? [])].join(",")}`, [e.lengths, i]] as const] : [])));
  for (const state of states) {
    // parent occurrences at each level, with their slot path when an override could name one
    let parents = [{ len: state.total, path: [] as number[] }];
    for (const c of chain.slice(1) as SlotsUnitAst[]) {
      const next: Array<{ len: number; path: number[] }> = [];
      const lens = new Set<number>();
      for (const p of parents) {
        const override = state.k === undefined ? undefined : overrides.get(`${c.id}|${[state.k, ...p.path].join(",")}`);
        const got = slotLengthsIn(c, p.len, state.on, override?.[0]);
        if (typeof got === "string") {
          if (c === u) return (errors.push(`unit "${u.id}": ${got} (${state.label})`), override ? { entry: override[1] } : {});
          continue; // a parent's own failure is reported by the parent
        }
        c.slots.forEach((sl, i) => {
          if (sl.filler || (state.k === undefined && lens.has(got[i]!))) return;
          lens.add(got[i]!);
          next.push({ len: got[i]!, path: [...p.path, i] });
        });
      }
      parents = next;
    }
  }
  return true;
}

/**
 * The tags only named rules set (§16 D8, §16.7 P2), each with the indices of
 * the rules setting it in declaration order. A tag a unit label, a slot, a day
 * label or a season mark (`season:<name>`) also sets is not here: a rule reads
 * it base-only, exactly as before rules could read rules.
 */
export function ruleTagSetters(ast: CalendarAst): Map<string, number[]> {
  const base = new Set<string>();
  for (const u of Array.isArray(ast.units) ? ast.units : []) {
    if (!isObj(u)) continue;
    const labels: unknown = u.kind === "cycle" ? u.labels : u.slots;
    for (const l of Array.isArray(labels) ? (labels as unknown[]) : []) if (isObj(l) && Array.isArray(l.tags)) for (const t of l.tags as unknown[]) base.add(t as string);
  }
  for (const d of Array.isArray(ast.days) ? ast.days : []) if (isObj(d) && Array.isArray(d.tags)) for (const t of d.tags as unknown[]) base.add(t as string);
  for (const m of Array.isArray(ast.seasons?.marks) ? ast.seasons.marks : []) if (isObj(m) && typeof m.name === "string") base.add(`season:${m.name}`);
  const out = new Map<string, number[]>();
  for (const [i, r] of (Array.isArray(ast.rules) ? ast.rules : []).entries()) {
    if (!isObj(r) || !Array.isArray(r.tags)) continue;
    for (const t of r.tags as unknown[]) {
      if (typeof t !== "string" || base.has(t)) continue;
      const at = out.get(t);
      if (!at) out.set(t, [i]);
      else if (at[at.length - 1] !== i) at.push(i);
    }
  }
  return out;
}

/**
 * Named rules that depend on themselves through tags (§16 D8): rule A depends
 * on B when A reads a tag only named rules set and B sets it. Each cycle as
 * the rule ids along it, first id repeated at the end (`a → b → a`; a rule
 * reading its own tag is `a → a`). One cycle per back edge of a depth-first
 * walk in declaration order, so every cyclic calendar reports at least one.
 */
export function ruleCycles(ast: CalendarAst): string[][] {
  const rules: NonNullable<CalendarAst["rules"]> = Array.isArray(ast.rules) ? ast.rules : [];
  const setters = ruleTagSetters(ast);
  const deps = rules.map((r) => (isObj(r) ? [...new Set(tagsRead(r.rule).flatMap((t) => setters.get(t) ?? []))] : []));
  const state = new Array<0 | 1 | 2>(rules.length).fill(0); // 0 unseen, 1 on the path, 2 done
  const path: number[] = [];
  const cycles: string[][] = [];
  const visit = (i: number): void => {
    state[i] = 1;
    path.push(i);
    for (const j of deps[i]!) {
      if (state[j] === 1) cycles.push([...path.slice(path.indexOf(j)), j].map((k) => String(rules[k]!.id)));
      else if (state[j] === 0) visit(j);
    }
    path.pop();
    state[i] = 2;
  };
  for (let i = 0; i < rules.length; i++) if (state[i] === 0) visit(i);
  return cycles;
}

/**
 * A rule's references and shape against one calendar (§3.3, §3.5). Used for
 * the calendar's named rules and by EngineDays.bind for any other rule. A
 * calendar rule has no host leaves (regime and chance belong to Wadjet).
 * `freq` and `by` may also name the built-in "day".
 */
export function checkRule(rule: RuleAst, ast: CalendarAst, where = "rule"): string[] {
  const errors: string[] = [];
  const units = new Map(ast.units.map((u) => [u.id, u]));
  const unit = (id: unknown, at: string, allowDay: boolean): boolean => {
    if (allowDay && id === "day") return true;
    if (typeof id === "string" && units.has(id)) return true;
    errors.push(`${at}: no unit ${show(id)}`);
    return false;
  };
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const ints = (xs: unknown, at: string, nonzero: boolean) => {
    if (!Array.isArray(xs) || xs.length === 0 || xs.some((x) => !isInt(x) || (nonzero && x === 0))) errors.push(`${at} must be a non-empty list of ${nonzero ? "non-zero " : ""}whole numbers`);
  };
  const walk = (r: RuleAst, at: string, depth = 0): void => {
    if (depth > RULE_DEPTH_MAX) return void errors.push(`${at}: rules nest deeper than ${RULE_DEPTH_MAX}`);
    // not isObj: its Record guard would drop the interface-typed recur member from the union
    if (typeof r !== "object" || r === null) return void errors.push(`${at}: not a rule`);
    switch (r.kind) {
      case "all":
      case "any":
        if (!Array.isArray(r.of)) return void errors.push(`${at}: ${r.kind} needs a list`);
        return (r.of as readonly RuleAst[]).forEach((q, i) => walk(q, `${at}.${r.kind}[${i}]`, depth + 1));
      case "not":
        return walk(r.of, `${at}.not`, depth + 1);
      case "shift":
        // DAYS 0 would be the node itself: refused as pointless, so a SHIFT always reads another day
        if (!isInt(r.days) || r.days === 0 || Math.abs(r.days) > SHIFT_DAYS_MAX) errors.push(`${at}: SHIFT DAYS must be a whole number of days, not 0, at most ${SHIFT_DAYS_MAX} either way`);
        return walk(r.of, `${at}.shift`, depth + 1);
      case "first":
        if (!isInt(r.within) || r.within < 1 || r.within > FIRST_WITHIN_MAX) errors.push(`${at}: FIRST WITHIN must be a whole number from 1 to ${FIRST_WITHIN_MAX}`);
        walk(r.after, `${at}.first.after`, depth + 1);
        return walk(r.of, `${at}.first`, depth + 1);
      case "phase":
        // a named phase that resolved is plain bounds by now; one still named could not resolve, and says why (§16 D6, P3)
        if (r.name !== undefined) return void errors.push(`${at}: ${phaseNameProblem(r, new Map((ast.bodies ?? []).filter(isObj).map((b) => [b.id, b])))}`);
        if ((r.unit === undefined) === (r.body === undefined)) errors.push(`${at}: phase names exactly one of unit and body`);
        if (r.body !== undefined && !(ast.bodies ?? []).some((b) => b.id === r.body)) errors.push(`${at}: no body ${show(r.body)}`);
        if (r.unit !== undefined) unit(r.unit, at, false);
        if (!num(r.from) || !num(r.to)) errors.push(`${at}: phase bounds must be numbers`);
        return;
      case "dayIn":
        unit(r.unit, at, false);
        if (!num(r.from) || !num(r.to)) errors.push(`${at}: dayIn bounds must be numbers`);
        return;
      case "index":
        if (unit(r.unit, at, true) && r.unit !== "day" && units.get(r.unit)!.kind !== "cycle") errors.push(`${at}: index reads a cycle unit; "${r.unit}" is a slot unit`);
        if ((r.from !== undefined && !num(r.from)) || (r.to !== undefined && !num(r.to))) errors.push(`${at}: index bounds must be numbers`);
        return;
      case "tag":
        // a tag set only by named rules reads those rules (§16 D8); any other tag reads the base tags only (§16.7 P2).
        // Cycles between named rules are the calendar's check (ruleCycles), not one rule's.
        if (typeof r.tag !== "string" || !r.tag) errors.push(`${at}: a tag is a non-empty string`);
        return;
      case "dates":
        return ints(r.days, `${at}: dates`, false);
      case "recur":
        return checkRecur(r, at);
      case "host":
        return void errors.push(`${at}: a calendar rule cannot read "${r.key}" (Wadjet's, not the calendar's)`);
      case "throw":
        return void errors.push(`${at}: a rule that could not be compiled`);
      default: {
        // exhaustive over RuleAst (§16.7 P5); untyped input can still carry any kind
        const unknown: never = r;
        return void errors.push(`${at}: unknown rule kind ${show((unknown as { kind?: unknown }).kind)}`);
      }
    }
  };
  const checkRecur = (r: Extract<RuleAst, { kind: "recur" }>, at: string): void => {
    const freqOk = unit(r.freq, `${at} freq`, true);
    const cycle = r.freq === "day" || units.get(r.freq)?.kind === "cycle";
    if (r.interval !== undefined && (!isInt(r.interval) || r.interval < 1)) errors.push(`${at}: interval must be a whole number ≥ 1`);
    else if (freqOk && (r.interval ?? 1) > 1 && !cycle) errors.push(`${at}: interval > 1 needs a cycle unit; "${r.freq}" is a slot unit, which has no global count`);
    if (r.anchor !== undefined && !isInt(r.anchor)) errors.push(`${at}: anchor must be a whole day`);
    if (r.until !== undefined && !isInt(r.until)) errors.push(`${at}: until must be a whole day`);
    if (r.count !== undefined && (!isInt(r.count) || r.count < 1)) errors.push(`${at}: count must be a whole number ≥ 1`);
    if (r.count !== undefined && freqOk && !cycle && r.anchor === undefined) errors.push(`${at}: count over slot unit "${r.freq}" needs an anchor (a slot unit has no occurrence 0)`);
    if (r.setpos !== undefined) ints(r.setpos, `${at}: setpos`, true);
    // a constant-length cycle's period is known here; a variable one is checked when the rule runs
    const f = units.get(r.freq);
    const constant = f?.kind === "cycle" && f.length !== undefined && !f.gears?.length && !f.stages?.length && !f.ledger?.length ? f.length : undefined;
    if (r.setpos !== undefined && constant !== undefined && constant > SETPOS_PERIOD_MAX) errors.push(`${at}: setpos over "${r.freq}", whose ${constant}-day period is past the ${SETPOS_PERIOD_MAX}-day limit`);
    if (r.by !== undefined && !Array.isArray(r.by)) return void errors.push(`${at}: by must be a list of filters`);
    for (const [i, b] of ((r.by ?? []) as readonly By[]).entries()) checkBy(b, `${at} by[${i}]`);
  };
  const checkBy = (b: By, at: string): void => {
    if (typeof b !== "object" || b === null) return void errors.push(`${at}: not a filter`);
    const kinds = ["nth", "label", "day"].filter((k) => k in b);
    if (kinds.length !== 1) return void errors.push(`${at}: a filter has exactly one of nth, label and day`);
    if (!unit(b.unit, at, !("label" in b))) return;
    if ("label" in b) {
      if (!Array.isArray(b.label) || b.label.length === 0 || b.label.some((x) => typeof x !== "string" || !x || x === "#")) errors.push(`${at}: label must be a non-empty list of names or #tags`);
    } else ints("nth" in b ? b.nth : b.day, `${at}: ${kinds[0]}`, true);
  };
  walk(rule, where);
  return errors;
}
