/**
 * The structural validator (docs/SESHAT-v0.md §5), for the AST subset in
 * ast.ts. It returns every problem it finds, as plain sentences; an empty
 * list means the calendar can be compiled.
 *
 * Covered here: ids and references (V1), monotone lengths (V3: every
 * occurrence at least one day), magnitudes (V5), one base per unit (V8),
 * gear sanity, and slot sums. Stage windows (V2), the inverse bound (V4),
 * cycle lcm (V6) and ledger order (V7) arrive with stages, cycle labels and
 * the ledger.
 */
import type { CalendarAst, CycleUnitAst, GearTerm, SlotsUnitAst, UnitAst } from "./ast";
import { DAY_LIMIT } from "./day";
import { baseLengths, linearBase } from "./base";
import { gearPeriod, mod, type GearAst } from "./gear";
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

const isInt = (x: unknown): boolean => Number.isSafeInteger(x);
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
      const loss = checkTerms(u.id, at, u.gears, u.id);
      const shortest = checkBase(u, loss, (msg) => fail(u.id, `${at}: ${msg}`));
      if (shortest !== null && shortest + loss < 1) fail(u.id, `${at}: an occurrence can be ${shortest + loss} days long; every occurrence needs at least one day (V3)`);
      continue;
    }
    const chain = chainOf(u, units);
    const root = Array.isArray(chain) ? (chain[0] as CycleUnitAst) : null;
    if (!units.has(u.in)) fail(u.id, `${at}: no parent unit "${u.in}"`);
    else if (chain === "loop") fail(u.id, `${at}: its parents loop back on themselves; a slot unit must sit under a cycle unit`);
    else if (chain === "missing") bad.add(u.id); // the unit missing higher up reports itself
    for (const [i, s] of u.slots.entries()) {
      const where = `${at} slot ${i + 1}`;
      if (s.length === "slack") {
        if (s.gears?.length) fail(u.id, `${where}: a slack slot takes what is left and cannot carry gear terms`);
        continue;
      }
      if (!inBounds(s.length) || s.length < 0) fail(u.id, `${where}: length ${s.length} is not a whole number of days in 0..${MAGNITUDE_MAX}`);
      if (root) checkTerms(u.id, where, s.gears, root.id);
    }
    if (u.slots.filter((s) => s.length === "slack").length > 1) fail(u.id, `${at}: more than one slack slot`);
  }

  // slot sums need the whole chain clean: the unit, every slot unit above it, the cycle, and every gear they read.
  // Parents come first, so a unit whose parent's sums failed is skipped rather than reporting the same fault again.
  const done = new Set<string>();
  const sums = (u: SlotsUnitAst, chain: UnitAst[]): void => {
    if (done.has(u.id)) return;
    done.add(u.id);
    const parent = chain[chain.length - 2]!;
    if (parent.kind === "slots") sums(parent, chain.slice(0, -1));
    if (chain.some((c) => bad.has(c.id))) return;
    const read = chain.flatMap((c) => (c.kind === "cycle" ? (c.gears ?? []) : c.slots.flatMap((s) => s.gears ?? []))).map((t) => t.gear);
    if (read.some((g) => bad.has(g) || !gears.has(g))) return;
    if (!checkSlotSums(u, chain, [...new Set(read)], errors)) bad.add(u.id);
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
function checkBase(u: CycleUnitAst, loss: number, fail: (msg: string) => void): number | null {
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
  const { a, c, L } = linearBase(u);
  const shortest = baseLengths({ a, c, L })[0]!;
  // the engine evaluates k·a + c and (d + 1)·L − c, k within the indices a day in range can reach, plus correction
  // steps; gear terms can shorten an occurrence to shortest + loss (≥ 1 by V3), so they reach that many more indices
  const kMax = Math.ceil((3 * DAY_LIMIT) / Math.max(1, shortest + loss)) + 2;
  if (!(Math.abs(c) + (DAY_LIMIT + 1) * L < LINEAR_MAX && Math.abs(c) + kMax * a < LINEAR_MAX && isInt(c))) {
    return fail(`crossing ${period.n}/${period.d} at ${at.n}/${at.d} is too fine for exact integer days within ±${DAY_LIMIT} (V5): use a coarser period or instant`), null;
  }
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

/**
 * Under every combination of the gears the chain reads, each slot unit's
 * slots must fit every length a non-filler occurrence of its parent can have:
 * fixed slots no longer than it with a slack slot, exactly as long without
 * one, and no slot shorter than 0 days.
 */
function checkSlotSums(u: SlotsUnitAst, chain: UnitAst[], involved: string[], errors: string[]): boolean {
  const fail = (msg: string) => (errors.push(msg), false);
  if (involved.length > SLOT_GEARS_MAX) return fail(`unit "${u.id}": reads ${involved.length} gears; at most ${SLOT_GEARS_MAX}`);
  for (let mask = 0; mask < 1 << involved.length; mask++) {
    const add = (terms: readonly GearTerm[] | undefined) => (terms ?? []).reduce((a, t) => a + t.add * ((mask >> involved.indexOf(t.gear)) & 1), 0);
    const state = involved.map((id, i) => `${id}=${(mask >> i) & 1}`).join(", ") || "always";
    // lengths a non-filler occurrence of each level can have, top down; this unit's own slots are checked at the last step
    const root = chain[0] as CycleUnitAst;
    let parentLengths = baseLengths(linearBase(root)).map((l) => l + add(root.gears));
    for (const c of chain.slice(1) as SlotsUnitAst[]) {
      const fixedLens = c.slots.map((s) => (s.length === "slack" ? 0 : s.length + add(s.gears)));
      const fixed = fixedLens.reduce((a, b) => a + b, 0);
      const hasSlack = c.slots.some((s) => s.length === "slack");
      const next = new Set<number>();
      for (const total of parentLengths) {
        if (c === u) {
          const neg = fixedLens.findIndex((l) => l < 0);
          if (neg >= 0) return fail(`unit "${u.id}" slot ${neg + 1}: ${fixedLens[neg]} days (${state})`);
          // every combination is checked, reachable or not: that only makes the check stricter
          if (hasSlack ? fixed > total : fixed !== total) return fail(`unit "${u.id}": slots total ${fixed} days but its parent occurrence is ${total} (${state})`);
        }
        c.slots.forEach((s, i) => {
          if (!s.filler) next.add(s.length === "slack" ? total - fixed : fixedLens[i]!);
        });
      }
      if (c === u) break; // on to the next gear state
      parentLengths = [...next];
    }
  }
  return true;
}
