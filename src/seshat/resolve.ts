/**
 * The resolve pass (docs/SESHAT-v0.md §16.2 D1, §16.7 P4): a pure
 * `CalendarAst → CalendarAst` run before validation, compilation and hashing.
 * Authoring forms become the numbers the engine reads, so every existing check
 * (V5, V8, the closed form) runs on resolved numbers and equal behaviour hashes
 * equal. `print` keeps printing the stored AST.
 *
 * Today it resolves crossing bases: a body reference to `(period, at)`, and
 * `START=after` to `at + (L − 1)/L`. A definition with neither comes back as
 * the same object. A crossing that cannot resolve (a missing body, a mark out
 * of range, numbers past safe integers) is left as stored: `validate` reports
 * it through `crossingProblem`, and the world faults (no fallback).
 *
 * Arithmetic is BigInt, checked back into safe integers at the end.
 */
import type { BodyAst, CalendarAst, CrossingAst, CycleRule, LedgerEntry, LiteralCrossingAst, UnitAst } from "./ast";
import type { Rational } from "./rational";

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

/** The calendar with every authoring form resolved to numbers; `ast` itself when nothing needs it. */
export function resolve(ast: CalendarAst): CalendarAst {
  if (!Array.isArray(ast.units)) return ast;
  const stored: readonly UnitAst[] = ast.units;
  const bodies = new Map((Array.isArray(ast.bodies) ? ast.bodies : []).filter((b): b is BodyAst => isObj(b)).map((b) => [b.id, b]));
  const units = stored.map((u) => unit(u, bodies));
  return units.some((u, i) => u !== stored[i]) ? { ...ast, units } : ast;
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
