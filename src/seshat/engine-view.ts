/**
 * Rules over a compiled calendar (docs/SESHAT-v0.md §3.2, §3.5): the
 * DayView of an Engine, and the recurrence filter `recur`.
 *
 * Unit references are checked when a rule is bound (`EngineDays.bind`): on
 * a calendar, a reference to a unit or body it lacks is an error, never a
 * silent false. Rules read a day's unit and day tags, never the tags of
 * named rules (VRULE), so no rule can depend on itself.
 *
 * `recur` costs O(1) per day for the period and the `label`/`day` filters.
 * `nth` on a unit not nested by declaration lists the period's occurrences
 * once per period; `setpos` and `count` list the period's matching days once
 * per period (both cached on the bound rule node, which is immutable AST).
 * A `setpos` period longer than SETPOS_PERIOD_MAX days and a `count` walk
 * longer than COUNT_WORK_MAX days throw rather than run unbounded.
 */
import type { Engine } from "./engine";
import { evaluate, type By, type DayView, type EvalOptions, type Recur, type RuleAst } from "./rule";
import { checkRule, SETPOS_PERIOD_MAX } from "./validate";

export { SETPOS_PERIOD_MAX };

export const COUNT_WORK_MAX = 1_000_000;

/** A unit occurrence holding a day: its index (a cycle's, or a slot's in its parent), first day and length. */
interface Occurrence {
  readonly index: number;
  readonly start: number;
  readonly length: number;
}

const NO_HOST: EvalOptions = { host: () => undefined };

/** Index of x in an ascending array, or -1. */
function find(xs: readonly number[], x: number): number {
  let [lo, hi] = [0, xs.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = xs[mid]!;
    if (v === x) return mid;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export class EngineDays {
  /** rule node → period start → that period's matching days (setpos applied) */
  private readonly periodDays = new WeakMap<object, Map<number, readonly number[]>>();
  /** unit|period start|period length → starts of the unit's occurrences that begin inside the period (two freqs can share a start) */
  private readonly starts = new Map<string, readonly number[]>();
  /** rule node → matching days counted per period from the anchor, in order */
  /** `work` is the days walked so far, over every call: past COUNT_WORK_MAX the rule throws on every later call too */
  private readonly counted = new WeakMap<object, { next: number; total: number; work: number; before: Map<number, number> }>();

  constructor(readonly engine: Engine) {}

  /** The rule, checked against this calendar's units: a missing reference throws. */
  bind(rule: RuleAst): RuleAst {
    const errors = checkRule(rule, this.engine.ast);
    if (errors.length) throw new RangeError(`rule does not fit calendar "${this.engine.ast.name}": ${errors.join("; ")}`);
    return rule;
  }

  view(day: number): DayView {
    return new EngineView(this, day);
  }

  /** Does `rule` (already bound) hold on `day`? Host leaves are unknown here, so a calendar rule never has one. */
  holds(rule: RuleAst, day: number): boolean {
    return evaluate(rule, this.view(day), NO_HOST) === true;
  }

  occurrence(unit: string, day: number): Occurrence | null {
    return unit === "day" ? { index: day, start: day, length: 1 } : this.engine.occurrenceAt(unit, day);
  }

  recur(r: Recur, day: number): boolean {
    const period = this.period(r, day);
    if (!period) return false;
    if (r.until !== undefined && day > r.until) return false;
    if (r.setpos === undefined && r.count === undefined) return this.byAll(r, day, period);
    const days = this.matchingDays(r, period);
    const i = find(days, day);
    if (i < 0) return false;
    return r.count === undefined || this.countedBefore(r, period) + i + 1 <= r.count;
  }

  /** d's occurrence of `freq` when it is the anchor's or a later one the interval selects; else null. Whole periods count: the anchor's own period matches from its first day. */
  private period(r: Recur, day: number): Occurrence | null {
    const p = this.occurrence(r.freq, day);
    if (!p) return null;
    const a = this.anchorPeriod(r);
    if (!a) return null;
    if (p.start < a.start) return null;
    const interval = r.interval ?? 1;
    // interval > 1 is a cycle unit or "day" (validator), where index is a global count
    return interval === 1 || (p.index - a.index) % interval === 0 ? p : null;
  }

  private anchorPeriod(r: Recur): Occurrence | null {
    if (r.anchor !== undefined) return this.occurrence(r.freq, r.anchor);
    if (r.freq === "day") return { index: 0, start: 0, length: 1 };
    const cycle = this.engine.isCycle(r.freq);
    // occurrence 0 of a cycle; a slot unit has no global occurrence 0, so no lower bound
    return cycle ? { index: 0, start: this.engine.start(r.freq, 0), length: this.engine.length(r.freq, 0) } : { index: 0, start: -Infinity, length: 0 };
  }

  private byAll(r: Recur, day: number, period: Occurrence): boolean {
    for (const b of r.by ?? []) if (!this.byHolds(b, r.freq, day, period)) return false;
    return true;
  }

  private byHolds(b: By, freq: string, day: number, period: Occurrence): boolean {
    if ("label" in b) {
      const l = b.unit === "day" ? null : this.engine.labelAt(b.unit, day);
      if (!l) return false;
      return b.label.some((x) => (x.startsWith("#") ? (l.tags?.includes(x.slice(1)) ?? false) : l.name === x));
    }
    const o = this.occurrence(b.unit, day);
    if (!o) return false;
    if ("day" in b) {
      const pos = day - o.start + 1;
      return b.day.some((n) => n === pos || n === pos - o.length - 1);
    }
    // nth: declared slots of the period's own unit keep their numbers; anything else counts by start day
    if (this.engine.parentOf(b.unit) === freq) {
      const declared = this.engine.slotCount(b.unit);
      return b.nth.some((n) => n === o.index + 1 || n === o.index - declared);
    }
    const starts = this.startsIn(b.unit, period);
    const i = find(starts, o.start);
    if (i < 0) return false; // the occurrence began before the period
    return b.nth.some((n) => n === i + 1 || n === i - starts.length);
  }

  /** Starts of `unit`'s occurrences that begin inside `period`, in day order. */
  private startsIn(unit: string, period: Occurrence): readonly number[] {
    const key = `${unit}|${period.start}|${period.length}`;
    const hit = this.starts.get(key);
    if (hit) return hit;
    const out: number[] = [];
    const end = period.start + period.length;
    for (let x = period.start; x < end; ) {
      const o = this.occurrence(unit, x);
      if (!o) {
        x++; // a filler day: no occurrence of the unit holds it
        continue;
      }
      if (o.start >= period.start) out.push(o.start);
      x = o.start + Math.max(1, o.length);
    }
    this.starts.set(key, out);
    return out;
  }

  /** The days of `period` that pass every `by` and `setpos`, ascending; cached unless `cache` is false (the count walk). */
  private matchingDays(r: Recur, period: Occurrence, cache = true): readonly number[] {
    let byPeriod = this.periodDays.get(r);
    if (!byPeriod) this.periodDays.set(r, (byPeriod = new Map<number, readonly number[]>()));
    const hit = byPeriod.get(period.start);
    if (hit) return hit;
    if (r.setpos !== undefined && period.length > SETPOS_PERIOD_MAX) throw new RangeError(`BYSETPOS over a ${period.length}-day period of "${r.freq}"; the limit is ${SETPOS_PERIOD_MAX} days`);
    const all: number[] = [];
    for (let x = period.start; x < period.start + period.length; x++) if (this.byAll(r, x, period)) all.push(x);
    const days = r.setpos === undefined ? all : all.filter((_, i) => r.setpos!.some((n) => n === i + 1 || n === i - all.length));
    if (cache) byPeriod.set(period.start, days);
    return days;
  }

  /** Matching days in the periods from the anchor's up to (not including) `period`; resumes where the last call stopped. */
  private countedBefore(r: Recur, period: Occurrence): number {
    let memo = this.counted.get(r);
    if (!memo) {
      const start = this.anchorPeriod(r)!.start;
      // the validator requires an anchor for count over a slot unit, which has no occurrence 0
      if (!Number.isFinite(start)) throw new RangeError(`COUNT over "${r.freq}" needs an anchor`);
      this.counted.set(r, (memo = { next: start, total: 0, work: 0, before: new Map() }));
    }
    while (memo.next <= period.start) {
      if (memo.work > COUNT_WORK_MAX) throw new RangeError(`COUNT walks more than ${COUNT_WORK_MAX} days from the anchor`);
      const p = this.occurrence(r.freq, memo.next);
      if (!p) {
        memo.next++; // a filler day between occurrences of a slot unit
        memo.work++;
        continue;
      }
      memo.before.set(p.start, memo.total);
      memo.work += Math.max(1, p.length);
      if (this.period(r, p.start)) memo.total += this.matchingDays(r, p, false).length;
      memo.next = p.start + Math.max(1, p.length);
    }
    return memo.before.get(period.start)!;
  }
}

class EngineView implements DayView {
  constructor(
    private readonly days: EngineDays,
    readonly day: number,
  ) {}

  unitPhase(unit: string): number | undefined {
    const o = this.days.occurrence(unit, this.day);
    return o ? (this.day - o.start) / o.length : undefined;
  }

  dayInUnit(unit: string): number | undefined {
    const o = this.days.occurrence(unit, this.day);
    return o ? this.day - o.start : undefined;
  }

  index(unit: string): number | undefined {
    if (unit === "day") return this.day;
    return this.days.engine.isCycle(unit) ? this.days.engine.indexAt(unit, this.day) : undefined;
  }

  bodyPhase(): number | undefined {
    return undefined; // bodies join the AST in step 4; bind rejects a body reference until then
  }

  hasTag(tag: string): boolean {
    return this.days.engine.baseTagsAt(this.day).includes(tag);
  }

  recur(r: Recur): boolean {
    return this.days.recur(r, this.day);
  }
}
