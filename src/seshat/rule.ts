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
 */
import { wrap } from "./phase";
import { DEFAULT_YEAR_LENGTH, yearOf } from "./year";

export type HostKey = "regime" | "chance";

export type RuleAst =
  | { readonly kind: "all"; readonly of: readonly RuleAst[] }
  | { readonly kind: "any"; readonly of: readonly RuleAst[] }
  | { readonly kind: "not"; readonly of: RuleAst }
  /** exactly one of unit / body */
  | { readonly kind: "phase"; readonly unit?: string; readonly body?: string; readonly from: number; readonly to: number }
  | { readonly kind: "dayIn"; readonly unit: string; readonly from: number; readonly to: number }
  | { readonly kind: "index"; readonly unit: string; readonly from?: number; readonly to?: number }
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "dates"; readonly days: readonly number[] }
  | ({ readonly kind: "recur" } & Recur)
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
    case "throw":
      throw r.error;
  }
}
