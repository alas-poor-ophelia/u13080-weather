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
import type { CalendarAst, CycleRule, CycleUnitAst, GearTerm, SlotsUnitAst, StageAst, UnitAst } from "./ast";
import { DAY_LIMIT } from "./day";
import { baseLengths, linearBase } from "./base";
import { gearMatches, gearPeriod, lcm, mod, type GearAst } from "./gear";
import { slotLengthsIn } from "./slots";
import { compileUnit } from "./piecewise";
import { stageReach } from "./start";
import { gcd } from "./rational";

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

const isInt = (x: unknown): boolean => Number.isSafeInteger(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
/** An unchecked value as it appears in the AST, for messages. */
const show = (x: unknown): string => String(JSON.stringify(x));
const inBounds = (x: number): boolean => isInt(x) && Math.abs(x) <= MAGNITUDE_MAX;

export function validate(ast: CalendarAst): string[] {
  const errors: string[] = [];
  const units = new Map(ast.units.map((u) => [u.id, u]));
  const gears = new Map(ast.gears.map((g) => [g.id, g]));
  const ids = [...ast.units.map((u) => u.id), ...ast.gears.map((g) => g.id)];
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) errors.push(`id "${id}" is declared more than once`);

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
    if (u.kind === "cycle") {
      const unitFail = (msg: string) => fail(u.id, `${at}: ${msg}`);
      /** a start rule: the unit's own, or a ledger switch's (V3, V5, V8 per rule) */
      const checkRule = (rule: CycleRule, where: string) => {
        const rf = (msg: string) => fail(u.id, `${where}: ${msg}`);
        // the most gear terms and stages can take off an occurrence
        const loss = checkTerms(u.id, where, rule.gears, u.id) - checkStages(rule.stages, rf);
        const shortest = checkBase(rule, loss, rf);
        if (shortest !== null && shortest + loss < 1) rf(`an occurrence can be ${shortest + loss} days long; every occurrence needs at least one day (V3)`);
      };
      checkRule(u, at);
      if (u.labels !== undefined) {
        if (!Array.isArray(u.labels) || !u.labels.length) unitFail("labels must be a non-empty list");
        else (u.labels as unknown[]).forEach((l, i) => checkLabel(l, `label ${i + 1}`, unitFail));
      }
      if (u.ledger !== undefined) checkLedger(u, units, unitFail, (rule, where) => checkRule(rule, `${at} ${where}`));
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
  }

  // V7 on the compiled starts: strictly increasing across every pin and switch (one comparison per boundary)
  for (const u of ast.units) {
    if (u.kind !== "cycle" || !u.ledger?.length || bad.has(u.id)) continue;
    const read = [u, ...u.ledger.flatMap((e) => (e.kind === "switch" ? [e.rule] : []))].flatMap((r) => r.gears ?? []).map((t) => t.gear);
    if (read.some((g) => bad.has(g) || !gears.has(g))) continue;
    const rule = compileUnit(u, gears);
    const boundaries = new Set<number>();
    for (const e of u.ledger) {
      if (e.kind === "switch") boundaries.add(e.from);
      if (e.kind === "starts") for (let k = e.from; k <= e.from + (e.lengths?.length ?? 0) + 1; k++) boundaries.add(k);
    }
    for (const k of [...boundaries].sort((a, b) => a - b)) {
      const [before, here] = [rule.start(k - 1), rule.start(k)];
      if (here <= before) fail(u.id, `unit "${u.id}": occurrence ${k - 1} would be ${here - before} days long (it starts on day ${before}, the next on day ${here}); every occurrence needs at least one day (V7)`);
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
    if (!checkSlotSums(u, chain, [...new Set(read)], gears, scans, errors)) bad.add(u.id);
  };
  for (const u of ast.units) {
    const chain = u.kind === "slots" ? chainOf(u, units) : null;
    if (u.kind === "slots" && Array.isArray(chain)) sums(u, chain);
  }
  return errors;
}

/**
 * One base per unit that never resets (V8): a constant anchor and length, or a
 * crossing. A crossing's rationals must be in lowest terms (so equal calendars
 * hash equal), its period at least one day, and its integer form must stay
 * below 2^52 for every day within ±DAY_LIMIT (V5, §2.3.2). `loss` is the most
 * the unit's gear terms can take off an occurrence. Returns the shortest base
 * occurrence, or null when the base is unusable.
 */
function checkBase(u: CycleRule, loss: number, fail: (msg: string) => void): number | null {
  const n0 = u as { anchor?: unknown; length?: unknown; crossing?: unknown };
  if (u.crossing == null) {
    if (n0.anchor === undefined || n0.length === undefined) return fail("needs a base: an anchor and a length, or a crossing (V8)"), null;
    let ok = true;
    if (!isInt(u.anchor) || Math.abs(u.anchor) > DAY_LIMIT) ok = (fail(`anchor ${u.anchor} is not a whole day within ±${DAY_LIMIT}`), false);
    if (!inBounds(u.length)) ok = (fail(`length ${u.length} is not a whole number of days within ±${MAGNITUDE_MAX}`), false);
    return ok ? u.length : null;
  }
  if (n0.anchor !== undefined || n0.length !== undefined) return fail("has both a crossing and an anchor or length; a unit has one base (V8)"), null;
  const x = n0.crossing as { period?: unknown; at?: unknown } | null;
  const isRational = (r: unknown): r is { n: number; d: number } => typeof r === "object" && r !== null && isInt((r as { n: unknown }).n) && isInt((r as { d: unknown }).d);
  if (typeof x !== "object" || x === null || !isRational(x.period) || !isRational(x.at)) return fail("crossing needs a period and an instant, each a rational { n, d } of safe integers"), null;
  const { period, at } = u.crossing;
  if (period.d <= 0 || at.d <= 0 || gcd(period.n, period.d) !== 1 || gcd(at.n, at.d) !== 1) return fail("crossing period and instant must be rationals n/d in lowest terms with d > 0"), null;
  if (period.n < period.d) return fail(`crossing period ${period.n}/${period.d} is shorter than one day (V8)`), null;
  if (Math.abs(at.n / at.d) > DAY_LIMIT) return fail(`crossing instant ${at.n}/${at.d} is outside ±${DAY_LIMIT}`), null;
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
  if (!fits) return fail(`crossing ${period.n}/${period.d} at ${at.n}/${at.d} is too fine for exact integer days within ±${DAY_LIMIT} (V5): use a coarser period or instant`), null;
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
function checkLedger(u: CycleUnitAst, units: ReadonlyMap<string, UnitAst>, fail: (msg: string) => void, checkRule: (rule: CycleRule, where: string) => void): void {
  if (!Array.isArray(u.ledger)) return fail("ledger must be a list");
  let lastSwitch = -Infinity;
  const switches = new Set<number>();
  const pinned = new Set<number>();
  const overridden = new Set<string>();
  for (const [i, e] of (u.ledger as unknown[]).entries()) {
    const where = `ledger entry ${i + 1}`;
    if (!isObj(e)) {
      fail(`${where} is not an object`);
      continue;
    }
    if (!isInt(e.from) || Math.abs(e.from as number) > INDEX_MAX) {
      fail(`${where}: from ${show(e.from)} is not a whole occurrence index within ±${INDEX_MAX}`);
      continue;
    }
    const from = e.from as number;
    if (e.kind === "switch") {
      if (from <= lastSwitch) fail(`${where}: switches must come in increasing order of from`);
      lastSwitch = from;
      switches.add(from);
      if (!isObj(e.rule)) fail(`${where}: a switch needs a rule`);
      else checkRule(e.rule as unknown as CycleRule, `${where} (switch at ${from})`);
    } else if (e.kind === "starts") {
      if (!isInt(e.startsOn) || Math.abs(e.startsOn as number) > MAGNITUDE_MAX) fail(`${where}: startsOn ${show(e.startsOn)} is not a whole day within ±${MAGNITUDE_MAX}`);
      const lengths = e.lengths ?? [];
      if (!Array.isArray(lengths) || (lengths as unknown[]).some((l) => !isInt(l) || (l as number) < 1 || (l as number) > MAGNITUDE_MAX)) {
        fail(`${where}: lengths must be whole numbers of days ≥ 1`);
        continue;
      }
      const lastStart = (e.startsOn as number) + (lengths as number[]).reduce((a, b) => a + b, 0);
      if (Math.abs(lastStart) > MAGNITUDE_MAX) fail(`${where}: its last pinned start, day ${lastStart}, is outside ±${MAGNITUDE_MAX}`);
      for (let k = from; k <= from + lengths.length; k++) {
        if (pinned.has(k)) fail(`${where}: occurrence ${k} is pinned twice`);
        pinned.add(k);
      }
      if (pinned.size > PIN_MAX) fail(`${where}: more than ${PIN_MAX} pinned starts`);
    } else if (e.kind === "slots") {
      const target = typeof e.unit === "string" ? units.get(e.unit) : undefined;
      const chain = target ? chainOf(target, new Map(units)) : null;
      if (!target || target.kind !== "slots" || !Array.isArray(chain) || chain[0] !== u) {
        fail(`${where}: unit ${show(e.unit)} is not a slot unit under "${u.id}"`);
        continue;
      }
      const path = e.path ?? [];
      const between = chain.slice(1, -1) as SlotsUnitAst[];
      const pathOk = Array.isArray(path) && path.length === between.length && (path as unknown[]).every((x, j) => isInt(x) && (x as number) >= 0 && (x as number) < between[j]!.slots.length && !between[j]!.slots[x as number]!.filler);
      if (!pathOk) fail(`${where}: path must name one non-filler slot of each of the ${between.length} slot unit(s) between "${u.id}" and "${target.id}"`);
      if (!Array.isArray(e.lengths) || e.lengths.length !== target.slots.length || (e.lengths as unknown[]).some((l) => !isInt(l) || (l as number) < 0 || (l as number) > MAGNITUDE_MAX)) fail(`${where}: lengths must be ${target.slots.length} whole numbers of days ≥ 0, one per slot of "${target.id}"`);
      const key = `${target.id}|${from}|${show(path)}`;
      if (overridden.has(key)) fail(`${where}: occurrence ${from} of "${target.id}" is overridden twice`);
      overridden.add(key);
    } else fail(`${where}: kind ${show(e.kind)} is not switch, starts or slots`);
  }
  for (const k of pinned) if (switches.has(k)) fail(`occurrence ${k} is both pinned and a switch's first occurrence; pin the next one instead`);
}

/** C5: a label's name is a string; its tags are distinct non-empty strings (they are hashed and reach predicates). */
function checkLabel(l: unknown, where: string, fail: (msg: string) => void): void {
  if (!isObj(l)) return fail(`${where} must be an object with a name and/or tags`);
  if (l.name !== undefined && typeof l.name !== "string") fail(`${where}: name ${show(l.name)} is not a string`);
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
    for (let k = lo, s = rule.start(lo); k <= hi; k++) {
      const next = rule.start(k + 1);
      let mask = 0;
      for (let i = 0; i < involved.length; i++) if (gearMatches(gears.get(involved[i]!)!, k)) mask |= 1 << i;
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
  const bitsAt = (k: number) => {
    const bits = involved.map((g) => gearMatches(gears.get(g)!, k));
    return (g: string) => bits[involved.indexOf(g)] ?? false;
  };
  for (const [j, rule] of [root, ...switchRules].entries()) {
    const name = j === 0 ? `"${root.id}"` : `"${root.id}" switch ${j}`;
    const terms = (rule.gears ?? []).map((t) => ({ add: t.add, g: gears.get(t.gear)! }));
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
      const add = terms.reduce((a, t) => a + (gearMatches(t.g, k) ? t.add : 0), 0);
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
function checkSlotSums(u: SlotsUnitAst, chain: UnitAst[], involved: string[], gears: ReadonlyMap<string, GearAst>, scans: Map<string, CycleState[] | string>, errors: string[]): boolean {
  if (involved.length > SLOT_GEARS_MAX) return (errors.push(`unit "${u.id}": reads ${involved.length} gears; at most ${SLOT_GEARS_MAX}`), false);
  const states = cycleStates(chain, involved, gears, scans);
  if (typeof states === "string") return (errors.push(`unit "${u.id}": ${states}`), false);
  const overrides = new Map(((chain[0] as CycleUnitAst).ledger ?? []).flatMap((e) => (e.kind === "slots" ? [[`${e.unit}|${[e.from, ...(e.path ?? [])].join(",")}`, e.lengths] as const] : [])));
  for (const state of states) {
    // parent occurrences at each level, with their slot path when an override could name one
    let parents = [{ len: state.total, path: [] as number[] }];
    for (const c of chain.slice(1) as SlotsUnitAst[]) {
      const next: Array<{ len: number; path: number[] }> = [];
      const lens = new Set<number>();
      for (const p of parents) {
        const override = state.k === undefined ? undefined : overrides.get(`${c.id}|${[state.k, ...p.path].join(",")}`);
        const got = slotLengthsIn(c, p.len, state.on, override);
        if (typeof got === "string") {
          if (c === u) return (errors.push(`unit "${u.id}": ${got} (${state.label})`), false);
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
