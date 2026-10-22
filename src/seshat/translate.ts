/**
 * Translate a calendar along the day line (docs/SESHAT-v0.md §13.11, "Day 0",
 * ruled 2026-10-19): the calendar of `translate(ast, k)` reads on day d + k
 * exactly what `ast` reads on day d. Opting a world in uses it to land today
 * on a chosen date without moving any stored day number (pins, overrides).
 *
 * What moves is every absolute day the AST holds: a constant base's anchor
 * (on a unit and in a ledger switch), a crossing's instant, a ledger pin's
 * start day, a stage's weekday-residue offset (it tests the absolute start
 * day mod n), a day label's day, and a rule's dates, recurrence anchor and
 * until, and the bounds of an `index` rule on the day itself. A daily
 * recurrence without an anchor is anchored on day 0 (engine-view
 * anchorPeriod: its interval and its lower bound count from there), so it is
 * given the anchor k. Occurrence indices (gears, ledger `from`, label
 * cycles, `index` rules on a cycle unit) and phases do not move: they are
 * counted from the occurrence, which moved with its anchor.
 *
 * Bodies move too (epoch E becomes E - k/period, exactly), so a body read
 * by a rule keeps its place among the dates, and a unit following a body
 * keeps its occurrence numbers (K absorbs the epoch's wrap, §16.7 P1). The world's own moons are the
 * world's sky and must not move (ruled 2026-10-19): the opt-in adds them
 * after translating (src/plugin/opt-in.ts).
 */
import type { CalendarAst, CrossingAst, CycleRule, LedgerEntry, StageAst, UnitAst } from "./ast";
import type { BodyAst } from "./ast";
import type { Rational } from "./rational";
import { translateWrap } from "./resolve";
import type { RuleAst } from "./rule";

const mod = (a: number, n: number) => ((a % n) + n) % n;

function shiftRational(r: Rational, k: number): Rational {
  const n = r.n + k * r.d;
  if (!Number.isSafeInteger(n)) throw new RangeError(`moving ${r.n}/${r.d} by ${k} days leaves safe integers`);
  return { n, d: r.d };
}

const big = (n: number) => BigInt(n);
const gcdBig = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};

/** The epoch that puts a body's phase on day d + k where it was on day d: frac(E - k/P), exactly. */
function body(b: BodyAst, k: number): BodyAst {
  const { period: p, epoch: e } = b;
  let n = big(e.n) * big(p.n) - big(k) * big(p.d) * big(e.d);
  let d = big(e.d) * big(p.n);
  if (d < 0n) [n, d] = [-n, -d];
  n = ((n % d) + d) % d;
  const g = gcdBig(n, d) || 1n;
  [n, d] = [n / g, d / g];
  if (d > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`body "${b.id}": its phase after moving ${k} days needs a denominator past safe integers`);
  return { ...b, epoch: { n: Number(n), d: Number(d) } };
}

function stages(ss: readonly StageAst[] | undefined, k: number): { stages?: readonly StageAst[] } {
  if (!ss) return {};
  return {
    stages: ss.map((s) => ({
      rules: s.rules.map((r) => ("residue" in r ? { ...r, residue: { ...r.residue, offset: mod((r.residue.offset ?? 0) + k, r.residue.mod) } } : r)),
    })),
  };
}

type Bodies = ReadonlyMap<string, BodyAst>;

/**
 * A crossing written as numbers moves its instant. A crossing following a
 * body moves with the body (§16.7 P1): the body's epoch becomes
 * frac(E − k/P) = E − k/P + m, which moves every crossing by k − m·P, so m is
 * added to K in the same step and each crossing moves by exactly k with its
 * number unchanged. A body not in this calendar cannot move with it, and
 * shifting the offset instead would silently cut the unit loose from its
 * moon, so that is refused: add the body before translating.
 */
function crossing(c: CrossingAst, k: number, bodies: Bodies, unit: string): CrossingAst {
  if (c.body === undefined) return { ...c, at: shiftRational(c.at, k) };
  const b = bodies.get(c.body.id);
  if (!b) throw new RangeError(`crossing of unit "${unit}" follows body "${c.body.id}", which this calendar does not hold; add the body before translating`);
  const K = (c.body.k ?? 0) + translateWrap(b.period, b.epoch, k);
  if (!Number.isSafeInteger(K)) throw new RangeError(`moving a crossing following body "${b.id}" by ${k} days leaves safe integers`);
  const { k: _k, ...ref } = c.body;
  return { ...c, body: { ...ref, ...(K !== 0 ? { k: K } : {}) } };
}

function rule(r: CycleRule, k: number, bodies: Bodies, name: string): CycleRule {
  const moved = stages(r.stages, k);
  if (r.crossing !== undefined) return { ...r, ...moved, crossing: crossing(r.crossing, k, bodies, name) };
  return { ...r, ...moved, anchor: r.anchor + k };
}

function ledger(e: LedgerEntry, k: number, bodies: Bodies, name: string): LedgerEntry {
  switch (e.kind) {
    case "switch":
      return { ...e, rule: rule(e.rule, k, bodies, name) };
    case "starts":
      return { ...e, startsOn: e.startsOn + k };
    case "slots":
      return e;
  }
}

function unit(u: UnitAst, k: number, bodies: Bodies): UnitAst {
  if (u.kind === "slots") return u;
  const { ledger: l, ...rest } = u;
  const moved = rule(rest, k, bodies, u.id) as typeof rest;
  return { ...moved, ...(l ? { ledger: l.map((e) => ledger(e, k, bodies, u.id)) } : {}) };
}

function ruleAst(r: RuleAst, k: number): RuleAst {
  switch (r.kind) {
    case "all":
    case "any":
      return { ...r, of: r.of.map((q) => ruleAst(q, k)) };
    case "not":
      return { ...r, of: ruleAst(r.of, k) };
    case "dates":
      return { ...r, days: r.days.map((d) => d + k) };
    case "recur": {
      // a daily recurrence with no anchor counts from day 0, which moves; a cycle's occurrence 0 moves with its own anchor
      const anchor = r.anchor !== undefined ? r.anchor + k : r.freq === "day" ? k : undefined;
      return { ...r, ...(anchor !== undefined ? { anchor } : {}), ...(r.until !== undefined ? { until: r.until + k } : {}) };
    }
    case "index":
      // the index of the day unit is the day number itself
      if (r.unit !== "day") return r;
      return { ...r, ...(r.from !== undefined ? { from: r.from + k } : {}), ...(r.to !== undefined ? { to: r.to + k } : {}) };
    default:
      return r;
  }
}

/** The calendar moved `k` days later along the day line (k a safe integer; validate the result, which may leave ±DAY_LIMIT). */
export function translate(ast: CalendarAst, k: number): CalendarAst {
  if (!Number.isSafeInteger(k)) throw new RangeError(`a translation is a whole number of days (got ${k})`);
  if (k === 0) return ast;
  const bodies: Bodies = new Map((ast.bodies ?? []).map((b) => [b.id, b]));
  return {
    ...ast,
    units: ast.units.map((u) => unit(u, k, bodies)),
    ...(ast.bodies ? { bodies: ast.bodies.map((b) => body(b, k)) } : {}),
    ...(ast.days ? { days: ast.days.map((d) => ({ ...d, day: d.day + k })) } : {}),
    ...(ast.rules ? { rules: ast.rules.map((r) => ({ ...r, rule: ruleAst(r.rule, k) })) } : {}),
  };
}
