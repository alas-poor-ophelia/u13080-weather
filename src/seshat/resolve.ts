/**
 * The resolve pass (docs/SESHAT-v0.md §16.2 D1, §16.7 P4): a pure
 * `CalendarAst → CalendarAst` run before validation, compilation and hashing.
 * Authoring forms become the numbers the engine reads, so every existing check
 * (V5, V8, the closed form) runs on resolved numbers and equal behaviour hashes
 * equal. `print` keeps printing the stored AST.
 *
 * It resolves crossing bases: a body reference to `(period, at)`, and
 * `START=after` to `at + (L − 1)/L`; and a rule's named phase (§16 D6, P3) to
 * the `FROM/TO` span it names. A definition with none of these comes back as
 * the same object. A named phase that cannot resolve stays as stored and
 * `validate` reports it through `phaseNameProblem`. A crossing that cannot resolve (a missing body, a mark out
 * of range, numbers past safe integers) is left as stored: `validate` reports
 * it through `crossingProblem`, and the world faults (no fallback).
 *
 * Arithmetic is BigInt, checked back into safe integers at the end.
 */
import type { BodyAst, CalendarAst, CrossingAst, CycleRule, LedgerEntry, LiteralCrossingAst, RuleDefAst, UnitAst } from "./ast";
import type { Rational } from "./rational";
import type { RuleAst } from "./rule";

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const gcdBig = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
const floorBig = (n: bigint, d: bigint): bigint => {
  const q = n / d;
  return (n % d !== 0n && (n < 0n) !== (d < 0n)) ? q - 1n : q;
};

/** An exact rational over BigInt, reduced, denominator positive. */
interface Big {
  n: bigint;
  d: bigint;
}
const big = (r: Rational): Big => ({ n: BigInt(r.n), d: BigInt(r.d) });
function reduce(n: bigint, d: bigint): Big {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcdBig(n, d) || 1n;
  return { n: n / g, d: d / g };
}
const add = (a: Big, b: Big): Big => reduce(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Big, b: Big): Big => reduce(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Big, b: Big): Big => reduce(a.n * b.n, a.d * b.d);
const int = (k: bigint): Big => ({ n: k, d: 1n });
function toSafe(x: Big): Rational | null {
  if (x.n > SAFE || x.n < -SAFE || x.d > SAFE) return null;
  return { n: Number(x.n), d: Number(x.d) };
}

const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const isRat = (r: unknown): r is Rational => typeof r === "object" && r !== null && isInt((r as Rational).n) && isInt((r as Rational).d) && (r as Rational).d > 0 && gcdBig(BigInt((r as Rational).n), BigInt((r as Rational).d)) === 1n;

/**
 * Where a resolved crossing came from, so V5 and V8 messages can name it as
 * written (§16.4): the body it follows, and for `START=after` the stored
 * instant (absent for a body) rather than only the shifted one.
 */
export interface CrossingOrigin {
  readonly body?: string;
  readonly after?: { readonly at?: Rational };
}
const origins = new WeakMap<object, CrossingOrigin>();

/** Where a resolved crossing came from, or undefined for a crossing written as plain numbers (nothing resolved). */
export function crossingOrigin(c: CrossingAst): CrossingOrigin | undefined {
  return origins.get(c);
}

/** `START=after`: ceil instead of floor, exactly: floor((k·a + c + L − 1)/L) = ceil((k·a + c)/L) with L = lcm(period.d, at.d). */
function after(period: Big, at: Big): Big {
  const L = (period.d / gcdBig(period.d, at.d)) * at.d;
  return add(at, reduce(L - 1n, L));
}

/**
 * Why a crossing cannot resolve, or null when it can (or needs nothing). The
 * body's own problems are the body's to report; this names what the crossing
 * adds: the reference, the mark, the numbers.
 */
export function crossingProblem(c: CrossingAst, bodies: ReadonlyMap<string, BodyAst>): string | null {
  const r = resolveCrossing(c, bodies);
  return "error" in r ? r.error : null;
}

/** The literal crossing a stored crossing resolves to (no body, no start), or why it cannot. */
export function resolveCrossing(c: CrossingAst, bodies: ReadonlyMap<string, BodyAst>): { crossing: LiteralCrossingAst } | { error: string } {
  const raw = c as { start?: unknown; body?: unknown };
  if (raw.start !== undefined && raw.start !== "after") return { error: `crossing start ${JSON.stringify(raw.start)} is not "after" (absent means contains)` };
  if (raw.body === undefined) {
    if (c.start === undefined) return { crossing: c as LiteralCrossingAst };
    const lit = c as LiteralCrossingAst;
    const pair = (r: unknown) => typeof r === "object" && r !== null && isInt((r as Rational).n) && isInt((r as Rational).d);
    if (!pair(lit.period) || !pair(lit.at)) return { error: "crossing needs a period and an instant, each a rational { n, d } of safe integers" };
    if (!isRat(lit.period) || !isRat(lit.at)) return { error: "crossing period and instant must be rationals n/d in lowest terms with d > 0" };
    if (lit.period.n <= 0) return { error: `crossing ${lit.period.n}/${lit.period.d} at ${lit.at.n}/${lit.at.d};START=after: the period must be positive` };
    const at = toSafe(after(big(lit.period), big(lit.at)));
    if (!at) return { error: `crossing ${lit.period.n}/${lit.period.d} at ${lit.at.n}/${lit.at.d};START=after: its instant needs integers past safe range (V5)` };
    const { start: _s, ...rest } = lit;
    const crossing: LiteralCrossingAst = { ...rest, at };
    origins.set(crossing, { after: { at: lit.at } });
    return { crossing };
  }
  const ref = raw.body as { id?: unknown; mark?: unknown; offset?: unknown; k?: unknown };
  if (typeof ref !== "object" || ref === null || typeof ref.id !== "string") return { error: "crossing body reference needs a body id" };
  if ((c as { period?: unknown }).period !== undefined || (c as { at?: unknown }).at !== undefined) return { error: `crossing follows body "${ref.id}" and also has a period or an instant; it has one or the other` };
  const b = bodies.get(ref.id);
  if (!b) return { error: `crossing follows body "${ref.id}", which is not declared` };
  if (!isRat(ref.mark) || ref.mark.n < 0 || ref.mark.n >= ref.mark.d) return { error: `crossing following body "${ref.id}": mark must be a rational n/d in lowest terms in [0, 1)` };
  if (ref.offset !== undefined && !isRat(ref.offset)) return { error: `crossing following body "${ref.id}": offset must be a rational n/d in lowest terms` };
  if (ref.k !== undefined && !isInt(ref.k)) return { error: `crossing following body "${ref.id}": K must be a safe integer` };
  if (!isRat(b.period) || !isRat(b.epoch)) return { error: `crossing follows body "${ref.id}", whose period or epoch is not a rational in lowest terms` };
  if (b.period.n < b.period.d) return { error: `crossing follows body "${ref.id}", whose period ${b.period.n}/${b.period.d} is shorter than one day (V8)` };
  const P = big(b.period);
  // at = (φ − E + K)·P + o
  let at = add(mul(add(sub(big(ref.mark), big(b.epoch)), int(BigInt(ref.k ?? 0))), P), ref.offset ? big(ref.offset) : int(0n));
  if (c.start === "after") at = after(P, at);
  const safeAt = toSafe(at);
  if (!safeAt) return { error: `crossing following body "${ref.id}" puts its instant past safe integers (V5): use a coarser body or offset` };
  const { body: _b, start: _s, ...rest } = c;
  const crossing: LiteralCrossingAst = { period: b.period, at: safeAt, ...rest };
  origins.set(crossing, { body: ref.id, ...(c.start === "after" ? { after: {} } : {}) });
  return { crossing };
}

// the pass runs before validation, so it reads hostile shapes without throwing and leaves them to the validator
const isObj = (x: unknown): x is object => typeof x === "object" && x !== null;

function rule<R extends CycleRule>(r: R, bodies: ReadonlyMap<string, BodyAst>): R {
  if (!isObj(r)) return r;
  const c = r.crossing;
  if (!isObj(c) || (c.body === undefined && c.start === undefined)) return r;
  const out = resolveCrossing(c, bodies);
  return "error" in out ? r : { ...r, crossing: out.crossing };
}

function ledger(e: LedgerEntry, bodies: ReadonlyMap<string, BodyAst>): LedgerEntry {
  if (!isObj(e) || e.kind !== "switch") return e;
  const r = rule(e.rule, bodies);
  return r === e.rule ? e : { ...e, rule: r };
}

function unit(u: UnitAst, bodies: ReadonlyMap<string, BodyAst>): UnitAst {
  if (!isObj(u) || u.kind !== "cycle") return u;
  let out = rule(u, bodies);
  if (Array.isArray(u.ledger)) {
    const stored: readonly LedgerEntry[] = u.ledger;
    const l = stored.map((e) => ledger(e, bodies));
    if (l.some((e, i) => e !== stored[i])) out = { ...out, ledger: l };
  }
  return out;
}

/**
 * The span a body's named phase covers (§16 D6, P3), or why it has none: from
 * its mark to the next mark by `at`, the last wrapping to the first; a single
 * mark spans the whole turn (FROM=0;TO=1). Duplicate names or duplicate marks
 * on the body are errors once a rule names its phases.
 */
export function phaseSpan(body: string, name: string, bodies: ReadonlyMap<string, BodyAst>): { from: number; to: number } | { error: string } {
  const b = bodies.get(body);
  if (!b) return { error: `names phase ${JSON.stringify(name)} of body "${body}", which is not declared` };
  const raw = isObj(b.moon) ? (b.moon as { phases?: unknown }).phases : undefined;
  if (!Array.isArray(raw) || raw.length === 0) return { error: `names phase ${JSON.stringify(name)} of body "${body}", which has ${isObj(b.moon) ? "no named phases" : "no moon facet and so no named phases"}` };
  const marks = (raw as unknown[]).filter((m): m is { name: string; at: number } => isObj(m) && typeof (m as { name?: unknown }).name === "string" && typeof (m as { at?: unknown }).at === "number" && Number.isFinite((m as { at: number }).at));
  if (marks.length !== raw.length || marks.some((m) => m.at < 0 || m.at >= 1)) return { error: `names a phase of body "${body}", whose phases are not each a name at a phase in [0, 1)` };
  const names = marks.map((m) => m.name);
  const dupNames = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupNames.length) return { error: `names a phase of body "${body}", which has more than one phase named ${dupNames.map((n) => JSON.stringify(n)).join(", ")}` };
  const ats = marks.map((m) => m.at);
  const dupAts = [...new Set(ats.filter((a, i) => ats.indexOf(a) !== i))];
  if (dupAts.length) return { error: `names a phase of body "${body}", which has more than one phase at ${dupAts.join(", ")}` };
  const sorted = [...marks].sort((x, y) => x.at - y.at);
  const i = sorted.findIndex((m) => m.name === name);
  if (i < 0) return { error: `names phase ${JSON.stringify(name)} of body "${body}", which has no such phase (its phases: ${sorted.map((m) => JSON.stringify(m.name)).join(", ")})` };
  if (sorted.length === 1) return { from: 0, to: 1 };
  return { from: sorted[i]!.at, to: sorted[(i + 1) % sorted.length]!.at };
}

/** Why a named phase node cannot resolve, or null when it can (or is not one). */
export function phaseNameProblem(r: RuleAst, bodies: ReadonlyMap<string, BodyAst>): string | null {
  if (r.kind !== "phase" || r.name === undefined) return null;
  if (typeof r.name !== "string") return "a phase name is a string";
  if (r.unit !== undefined || typeof r.body !== "string") return `names phase ${JSON.stringify(r.name)}: a named phase belongs to a body (BODY=), not a unit`;
  if ((r as { from?: unknown }).from !== undefined || (r as { to?: unknown }).to !== undefined) return `names phase ${JSON.stringify(r.name)} and also has bounds; it has one or the other`;
  const s = phaseSpan(r.body, r.name, bodies);
  return "error" in s ? s.error : null;
}

/** A rule tree with each named phase resolved to its span; `r` itself when it names none. */
function ruleTree(r: RuleAst, bodies: ReadonlyMap<string, BodyAst>, depth = 0): RuleAst {
  // depth guard: the validator reports deep nesting; hostile cycles never reach here (ASTs are trees)
  if (!isObj(r) || depth > 64) return r;
  switch (r.kind) {
    case "all":
    case "any": {
      if (!Array.isArray(r.of)) return r;
      const stored: readonly RuleAst[] = r.of;
      const of = stored.map((q) => ruleTree(q, bodies, depth + 1));
      return of.some((q, i) => q !== stored[i]) ? { ...r, of } : r;
    }
    case "not": {
      const of = ruleTree(r.of, bodies, depth + 1);
      return of === r.of ? r : { ...r, of };
    }
    case "phase": {
      if (r.name === undefined || phaseNameProblem(r, bodies) !== null) return r;
      const span = phaseSpan(r.body!, r.name, bodies) as { from: number; to: number };
      // the resolved node drops the name: equal spans hash equal, and a moved boundary moves the hash
      return { kind: "phase", body: r.body!, from: span.from, to: span.to };
    }
    case "dayIn":
    case "index":
    case "tag":
    case "dates":
    case "recur":
    case "host":
    case "throw":
      return r;
    default:
      // untyped input can carry an unknown kind: left as stored, the validator names it (§16.7 P5: a new kind with children recurses here)
      return ((x: never) => x)(r);
  }
}

/** A rule (a calendar's or one bound from outside) with its named phases resolved against `ast`'s bodies. */
export function resolveRule(r: RuleAst, ast: CalendarAst): RuleAst {
  return ruleTree(r, bodyMap(ast));
}

const bodyMap = (ast: CalendarAst): Map<string, BodyAst> => new Map((Array.isArray(ast.bodies) ? ast.bodies : []).filter((b): b is BodyAst => isObj(b)).map((b) => [b.id, b]));

/** The calendar with every authoring form resolved to numbers; `ast` itself when nothing needs it. */
export function resolve(ast: CalendarAst): CalendarAst {
  if (!Array.isArray(ast.units)) return ast;
  const stored: readonly UnitAst[] = ast.units;
  const bodies = bodyMap(ast);
  const units = stored.map((u) => unit(u, bodies));
  const storedRules: readonly RuleDefAst[] | undefined = Array.isArray(ast.rules) ? ast.rules : undefined;
  const rules = storedRules?.map((d) => {
    if (!isObj(d)) return d;
    const rule = ruleTree(d.rule, bodies);
    return rule === d.rule ? d : { ...d, rule };
  });
  const unitsMoved = units.some((u, i) => u !== stored[i]);
  const rulesMoved = !!rules && rules.some((d, i) => d !== storedRules![i]);
  if (!unitsMoved && !rulesMoved) return ast;
  return { ...ast, ...(unitsMoved ? { units } : {}), ...(rulesMoved ? { rules } : {}) };
}

/**
 * The K change that keeps a body-driven unit's crossings where a person
 * expects when the body's epoch is edited from `oldEpoch` to `newEpoch`
 * (§16.7 P1): the crossings move by the smallest shift, in [−1/2, 1/2) of a
 * turn, so 0.99 → 0.01 moves them by 0.02 of a turn, not 0.98. Add the result
 * to the reference's K (absent is 0).
 */
export function epochEditK(oldEpoch: Rational, newEpoch: Rational): number {
  // crossings move by (E − E' + j) turns; pick the integer j that puts that in [−1/2, 1/2)
  const x = sub(big(oldEpoch), big(newEpoch));
  const j = -floorBig(2n * x.n + x.d, 2n * x.d);
  return Number(j);
}

/**
 * The wrap count m when translate moves a body's epoch from E to
 * frac(E − k/P): E' = E − k/P + m. Adding m to K keeps every occurrence index
 * (§16.7 P1).
 */
export function translateWrap(period: Rational, epoch: Rational, k: number): number {
  const shifted = sub(big(epoch), reduce(BigInt(k) * BigInt(period.d), BigInt(period.n)));
  return Number(-floorBig(shifted.n, shifted.d));
}
