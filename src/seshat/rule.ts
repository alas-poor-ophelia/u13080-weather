/**
 * L1 rules (docs/SESHAT-v0.md §3.2–3.4): a rule is a pure function of one
 * day, read through a DayView, evaluated three-valued (Kleene).
 *
 * Leaves keep the exact semantics of the predicates they replace:
 *   - phase: wrap(x) in [from, to), wrapping when from > to, never when
 *     from === to; float comparisons, bounds not normalized;
 *   - dayIn: closed [from, to], float comparisons, no wrap;
 *   - index: closed, an absent bound is open;
 *   - dates: one of the listed days (RDATE; EXDATE is `not dates`);
 *   - recur: the RRULE-vocabulary day filter of §3.5, answered by views that
 *     know a calendar's units (EngineView); any other view answers false;
 *   - a view value that is undefined (no such unit, body or field) is a
 *     definite false, never unknown. Unknown only comes from a host leaf or
 *     from the unknownTag hook.
 *   - shift and first read other days through the view's `at` (§16.3, §16.7 P7):
 *     a day off the line reads false; a view without `at` refuses them.
 */
import { wrap } from "./phase";
import { DEFAULT_YEAR_LENGTH, yearOf } from "./year";

export type HostKey = "regime" | "chance";

export type RuleAst =
  | { readonly kind: "all"; readonly of: readonly RuleAst[] }
  | { readonly kind: "any"; readonly of: readonly RuleAst[] }
  | { readonly kind: "not"; readonly of: RuleAst }
  /** exactly one of unit / body */
  | { readonly kind: "phase"; readonly unit?: string; readonly body?: string; readonly from: number; readonly to: number; readonly name?: undefined }
  /** a body's named phase (§16 D6): stored form, resolved to the FROM/TO form above before evaluation and hashing */
  | { readonly kind: "phase"; readonly unit?: string; readonly body?: string; readonly name: string; readonly from?: undefined; readonly to?: undefined }
  | { readonly kind: "dayIn"; readonly unit: string; readonly from: number; readonly to: number }
  | { readonly kind: "index"; readonly unit: string; readonly from?: number; readonly to?: number }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "dates"; readonly days: readonly number[] }
  | ({ readonly kind: "recur" } & Recur)
  /** holds on day d when `of` holds on d − days (§16.3; days = 1 is "the day after"); read off the day line, false */
  | { readonly kind: "shift"; readonly days: number; readonly of: RuleAst }
  /**
   * the first day matching `of` on or after an anchor day (`after`), within `within` days (§16.4, §16.7 P7):
   * d holds when `of` holds on d and, scanning back j = 0 … within, an anchor comes before any earlier match
   */
  | { readonly kind: "first"; readonly within: number; readonly after: RuleAst; readonly of: RuleAst }
  /** answered by the caller (Wadjet's regime and chance), never by Seshat */
  | { readonly kind: "host"; readonly key: HostKey; readonly arg: string | number }
  /** a stored shape that could not be compiled: evaluating it rethrows the error */
  | { readonly kind: "throw"; readonly error: unknown };

/**
 * A recurrence (docs/SESHAT-v0.md §3.5): RRULE's vocabulary, not its
 * semantics. Day d matches when it lies in an occurrence k ≥ k0 of `freq` with
 * (k − k0) mod interval = 0 (k0 holds `anchor`; whole periods count, so the
 * anchor's own period matches from its first day), every `by` holds, d is one of
 * the `setpos` positions among its period's matching days, d ≤ `until`, and
 * at most `count` matching days precede it from the start of period k0.
 * `freq` "day" is every day (DAILY); any other id is a declared unit.
 */
export interface Recur {
  readonly freq: string;
  readonly interval?: number;
  readonly anchor?: number;
  readonly by?: readonly By[];
  readonly setpos?: readonly number[];
  readonly count?: number;
  readonly until?: number;
}

/**
 * - nth: d's occurrence of `unit` is the n-th (1-based; negative from the end)
 *   of those whose start day lies in d's period. A slot unit whose parent is
 *   the period's unit counts its declared slots, so a length-0 slot keeps its
 *   number (Adar I, absent in a common year, is still month 6).
 * - label: the label name of d's occurrence of `unit`, or "#tag" for a tag on it.
 * - day: d's 1-based day within its occurrence of `unit` (negative from the end).
 */
export type By =
  | { readonly unit: string; readonly nth: readonly number[] }
  | { readonly unit: string; readonly label: readonly string[] }
  | { readonly unit: string; readonly day: readonly number[] };

/** One day, as a rule reads it. */
export interface DayView {
  readonly day: number;
  unitPhase(unit: string): number | undefined;
  dayInUnit(unit: string): number | undefined;
  index(unit: string): number | undefined;
  bodyPhase(body: string): number | undefined;
  hasTag(tag: string): boolean;
  /** absent: the view knows no calendar units, and every recurrence is false */
  recur?(r: Recur): boolean;
  /**
   * Another day of the same calendar (SHIFT and FIRST read it, §16.3), or undefined when `day` is off the
   * view's day line (every read there is false, §16.7 P7). Absent: the view has no other days, and a rule
   * holding SHIFT or FIRST is refused when it binds (TimeView.bind) and throws if evaluated anyway.
   */
  at?(day: number): DayView | undefined;
}

export interface EvalOptions {
  host(key: HostKey, arg: string | number): boolean | undefined;
  /** tags whose value is unknown in this evaluation (the spell-window estimate passes era tags) */
  unknownTag?: (tag: string) => boolean;
  /** evaluate every child of all/any instead of stopping at the deciding one */
  exhaustive?: boolean;
}

/** The fields of a day a TimeView reads (Wadjet's DayTime / TimeContext fit it). */
export interface TimeLike {
  readonly yearPhase: number;
  readonly dayOfYear?: number | undefined;
  readonly year?: number | undefined;
  readonly yearLength?: number | undefined;
  readonly dayOrdinal?: number | undefined;
  readonly moons?: ReadonlyArray<{ readonly name: string; readonly phase: number }> | undefined;
  readonly tags?: readonly string[] | undefined;
}

/**
 * A third-party-safe view over an adapter's day: one unit ("year") and the
 * moons as bodies, every value the adapter's own float. `extra` overlays tags
 * pushed earlier in the day without copying the adapter's list.
 */
export class TimeView implements DayView {
  constructor(
    readonly time: TimeLike,
    readonly day: number,
    private readonly extra?: readonly string[],
  ) {}

  /**
   * The rule, checked for this view (§3.2, §16.7 P5): a TimeView has no other days, so a rule reading
   * one (SHIFT, FIRST) is refused here, never evaluated to a silent false.
   */
  static bind(rule: RuleAst): RuleAst {
    const other = readsOtherDays(rule);
    if (other) throw new RangeError(`a ${other.toUpperCase()} rule reads other days, which a Wadjet day view does not have; it runs only on a calendar engine`);
    return rule;
  }

  /** The same day with more tags on top. */
  withTags(extra: readonly string[]): TimeView {
    return extra.length ? new TimeView(this.time, this.day, this.extra?.length ? [...this.extra, ...extra] : extra) : this;
  }

  unitPhase(unit: string): number | undefined {
    return unit === "year" ? this.time.yearPhase : undefined;
  }

  dayInUnit(unit: string): number | undefined {
    return unit === "year" ? this.time.dayOfYear : undefined;
  }

  index(unit: string): number | undefined {
    if (unit !== "year") return undefined;
    return yearOf({ year: this.time.year, dayOrdinal: this.time.dayOrdinal ?? this.day, yearLength: this.time.yearLength ?? DEFAULT_YEAR_LENGTH });
  }

  bodyPhase(body: string): number | undefined {
    return this.time.moons?.find((m) => m.name === body)?.phase;
  }

  hasTag(tag: string): boolean {
    return (this.time.tags?.includes(tag) ?? false) || (this.extra?.includes(tag) ?? false);
  }
}

/** Is x inside [lo, hi) on the unit circle (wraps if lo > hi; never if lo === hi)? */
export function inPhase(x: number, lo: number, hi: number): boolean {
  const t = wrap(x);
  if (lo === hi) return false;
  if (lo < hi) return t >= lo && t < hi;
  return t >= lo || t < hi;
}

export function evaluate(r: RuleAst, view: DayView, opts: EvalOptions): boolean | undefined {
  switch (r.kind) {
    case "all":
    case "any": {
      // all: false decides; any: true decides. Kleene: otherwise one unknown makes the whole unknown.
      const decide = r.kind === "any";
      let unknown = false;
      let decided = false;
      for (const q of r.of) {
        const v = evaluate(q, view, opts);
        if (v === decide) {
          decided = true;
          if (!opts.exhaustive) break;
        } else if (v === undefined) unknown = true;
      }
      return decided ? decide : unknown ? undefined : !decide;
    }
    case "not": {
      const v = evaluate(r.of, view, opts);
      return v === undefined ? undefined : !v;
    }
    case "phase": {
      // a named phase is resolved before evaluation; one that reaches here unresolved matches nothing
      if (r.from === undefined) return false;
      const x = r.body !== undefined ? view.bodyPhase(r.body) : view.unitPhase(r.unit!);
      return x === undefined ? false : inPhase(x, r.from, r.to);
    }
    case "dayIn": {
      const x = view.dayInUnit(r.unit);
      return x === undefined ? false : x >= r.from && x <= r.to;
    }
    case "index": {
      const x = view.index(r.unit);
      return x === undefined ? false : (r.from === undefined || x >= r.from) && (r.to === undefined || x <= r.to);
    }
    case "tag":
      if (opts.unknownTag?.(r.tag)) return undefined;
      return view.hasTag(r.tag);
    case "dates":
      return r.days.includes(view.day);
    case "recur":
      return view.recur ? view.recur(r) : false;
    case "host":
      return opts.host(r.key, r.arg);
    case "shift": {
      const v = other(view, r.kind, view.day - r.days);
      return v ? evaluate(r.of, v, opts) : false;
    }
    case "first":
      return first(r, view, opts);
    case "throw":
      throw r.error;
    default:
      return unreachableRule(r);
  }
}

/** Day `day` of the view's calendar, or undefined off its line; a view with no other days throws (TimeView.bind refuses first). */
function other(view: DayView, kind: string, day: number): DayView | undefined {
  if (!view.at) throw new RangeError(`a ${kind.toUpperCase()} rule reads other days, which this day view does not have`);
  return view.at(day);
}

/**
 * FIRST on day d (§16.7 P7) as the Kleene chain
 * match(d) ∧ (anchor(d) ∨ (¬match(d−1) ∧ (anchor(d−1) ∨ … (anchor(d−W) ∨ false)))),
 * read lazily from d backwards, so a decided answer stops the scan; a day off the line reads false.
 * Iterative, so a scan costs no stack: the chain so far is a function f of its unread tail X, read
 * once, kept as f(true) and f(false); for a read-once formula Kleene f(unknown) is their meet
 * (equal: that value; else unknown). Appending `t ∧ X` or `t ∨ X` substitutes into f.
 */
function first(r: Extract<RuleAst, { kind: "first" }>, view: DayView, opts: EvalOptions): boolean | undefined {
  // refused up front: an answer decided on day d alone would otherwise come back without the check (Parallax, 4b)
  if (!view.at) throw new RangeError(`a ${r.kind.toUpperCase()} rule reads other days, which this day view does not have`);
  type K = boolean | undefined;
  let [hi, lo]: [K, K] = [true, false];
  const f = (v: K): K => (v === true ? hi : v === false ? lo : hi === lo ? hi : undefined);
  const on = (node: RuleAst, x: number): K => {
    const v = x === view.day ? view : other(view, r.kind, x);
    return v ? evaluate(node, v, opts) : false;
  };
  hi = f(on(r.of, view.day)); // match(d) ∧ X
  for (let j = 0; hi !== lo; j++) {
    lo = f(on(r.after, view.day - j)); // anchor(d − j) ∨ X
    if (hi === lo || j >= r.within) break;
    const m = on(r.of, view.day - j - 1); // ¬match(d − j − 1) ∧ X
    hi = f(m === undefined ? undefined : !m);
  }
  // decided (f(true) = f(false)), or the scan ended: the tail is false
  return lo;
}

/** The first SHIFT or FIRST in a rule (a node reading other days), or undefined. */
export function readsOtherDays(r: RuleAst, depth = 0): "shift" | "first" | undefined {
  if (typeof r !== "object" || r === null || depth > 256) return undefined;
  if (r.kind === "shift" || r.kind === "first") return r.kind;
  for (const q of childrenOf(r)) {
    const k = readsOtherDays(q, depth + 1);
    if (k) return k;
  }
  return undefined;
}

/**
 * A node's direct sub-rules, for every kind (§16.7 P5): the walkers that only
 * need to reach every node (dependencies, world checks, named phases) go
 * through this one exhaustive switch, so a new kind cannot be missed.
 */
export function ruleChildren(r: RuleAst): readonly RuleAst[] {
  switch (r.kind) {
    case "all":
    case "any":
      return Array.isArray(r.of) ? (r.of as readonly RuleAst[]) : [];
    case "not":
    case "shift":
      return [r.of];
    case "first":
      return [r.after, r.of];
    case "phase":
    case "dayIn":
    case "index":
    case "tag":
    case "dates":
    case "recur":
    case "host":
    case "throw":
      return [];
    default:
      return unreachableRule(r);
  }
}

/** The rule kinds this build knows: the lenient walkers below skip anything else. */
const RULE_KINDS: ReadonlySet<string> = new Set(["all", "any", "not", "shift", "first", "phase", "dayIn", "index", "tag", "dates", "recur", "host", "throw"]);

/**
 * A node's children for walkers that must not throw on untyped input (the validator, the world checks):
 * an unknown kind has none here, and checkRule is what names it.
 */
export function childrenOf(r: unknown): readonly RuleAst[] {
  if (typeof r !== "object" || r === null || !RULE_KINDS.has((r as { kind?: unknown }).kind as string)) return [];
  return ruleChildren(r as RuleAst);
}

/** Every TAG a rule reads, in walk order (repeats kept). */
export function tagsRead(r: RuleAst, depth = 0): string[] {
  // depth guard: the validator reports deep nesting; a stored tree is never cyclic
  if (typeof r !== "object" || r === null || depth > 256) return [];
  if (r.kind === "tag") return typeof r.tag === "string" ? [r.tag] : [];
  return childrenOf(r).flatMap((q) => tagsRead(q, depth + 1));
}

/** The compile-time exhaustiveness check of a switch over RuleAst kinds; at run time an unknown kind (untyped input) throws. */
export function unreachableRule(r: never): never {
  throw new RangeError(`unknown rule kind ${JSON.stringify((r as { kind?: unknown } | null)?.kind)}`);
}
