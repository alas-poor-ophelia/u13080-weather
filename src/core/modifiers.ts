/**
 * The modifier engine (DESIGN-v1.md §3): evaluates the closed predicate
 * grammar, the deterministic `chance` and `spell` primitives, and produces
 * the day's ops + tags for the generator's dailyModifiers hook.
 *
 * Determinism: every random decision is hash(seed, zone, day, "mod:<id>:…").
 * A spell's activity on day d is recomputed by scanning a bounded window of
 * earlier days with the same hashed draws, so it is a pure function of d.
 */
import { DrawStream, bernoulli, drawKey, geometricDuration } from "./rng";
import type { DayTime, Modifier, ModifierOp, Predicate } from "./types";

export interface PredicateContext extends DayTime {
  dayOrdinal: number;
  regime: string;
  seed: string;
  zoneId: string;
  modifierId: string;
}

/** Is x inside [lo, hi) on the unit circle (wraps if lo > hi)? */
export function inPhaseRange(x: number, lo: number, hi: number): boolean {
  const t = ((x % 1) + 1) % 1;
  if (lo === hi) return false;
  if (lo < hi) return t >= lo && t < hi;
  return t >= lo || t < hi;
}

export function evaluatePredicate(p: Predicate, ctx: PredicateContext): boolean {
  if ("all" in p) return p.all.every((q) => evaluatePredicate(q, ctx));
  if ("any" in p) return p.any.some((q) => evaluatePredicate(q, ctx));
  if ("not" in p) return !evaluatePredicate(p.not, ctx);
  if ("moon" in p) {
    const m = ctx.moons?.find((x) => x.name === p.moon.name);
    if (!m) return false;
    return inPhaseRange(m.phase, p.moon.phase[0], p.moon.phase[1]);
  }
  if ("yearPhase" in p) return inPhaseRange(ctx.yearPhase, p.yearPhase[0], p.yearPhase[1]);
  if ("dayOfYear" in p) {
    if (ctx.dayOfYear === undefined) return false;
    return ctx.dayOfYear >= p.dayOfYear[0] && ctx.dayOfYear <= p.dayOfYear[1];
  }
  if ("tag" in p) return ctx.tags?.includes(p.tag) ?? false;
  if ("regime" in p) return ctx.regime === p.regime;
  if ("chance" in p) {
    const s = new DrawStream(drawKey(ctx.seed, ctx.zoneId, ctx.dayOrdinal, `mod:${ctx.modifierId}:chance`));
    return bernoulli(s, p.chance);
  }
  return false;
}

/** Does the predicate reference anything only known at generation time (regime)? */
export function predicateUsesRegime(p: Predicate | undefined): boolean {
  if (!p) return false;
  if ("all" in p) return p.all.some(predicateUsesRegime);
  if ("any" in p) return p.any.some(predicateUsesRegime);
  if ("not" in p) return predicateUsesRegime(p.not);
  return "regime" in p;
}

export interface ModifierEngineConfig {
  seed: string;
  zoneId: string;
  modifiers: readonly Modifier[];
  timeOf: (dayOrdinal: number) => DayTime;
}

export interface DailyModifierResult {
  ops: ModifierOp[];
  tags: string[];
  /** ids of modifiers active today (diagnostics / tests) */
  active: string[];
}

/** Max days a spell can be looked back for. Spells longer than this are a misuse (use regimes). */
export const SPELL_LOOKBACK_MAX = 400;

export class ModifierEngine {
  private readonly daily: Modifier[];
  private readonly windowDays = new Map<string, number>();

  constructor(readonly cfg: ModifierEngineConfig) {
    this.daily = cfg.modifiers.filter((m) => (m.stage ?? "daily") === "daily");
    for (const m of this.daily) {
      if (m.spell) this.windowDays.set(m.id, this.estimateWindowDays(m));
    }
  }

  /** Ops and tags for day d given the regime the generator has chosen. */
  forDay(dayOrdinal: number, regime: string): DailyModifierResult {
    const ops: ModifierOp[] = [];
    const tags: string[] = [];
    const active: string[] = [];
    const base = this.cfg.timeOf(dayOrdinal);
    for (const m of this.daily) {
      // tags set by earlier modifiers today are visible to later ones (spells replay past days and see only calendar tags)
      const time = tags.length ? { ...base, tags: [...(base.tags ?? []), ...tags] } : base;
      const on = m.spell ? this.spellActive(m, dayOrdinal, regime) : this.matches(m, dayOrdinal, time, regime);
      if (!on) continue;
      ops.push(...m.apply);
      if (m.tag) tags.push(m.tag);
      active.push(m.id);
    }
    return { ops, tags, active };
  }

  private ctx(m: Modifier, dayOrdinal: number, time: DayTime, regime: string): PredicateContext {
    return { ...time, dayOrdinal, regime, seed: this.cfg.seed, zoneId: this.cfg.zoneId, modifierId: m.id };
  }

  private matches(m: Modifier, dayOrdinal: number, time: DayTime, regime: string): boolean {
    if (!m.when) return true;
    return evaluatePredicate(m.when, this.ctx(m, dayOrdinal, time, regime));
  }

  /**
   * Window size for converting meanStartsPerYear into a per-day start
   * probability: the number of days in a reference year (days 0..364) on
   * which the static part of `when` holds. Regime predicates are treated as
   * true for this estimate (the regime is unknown outside generation), and
   * tags from other modifiers are not visible to it.
   */
  private estimateWindowDays(m: Modifier): number {
    if (!m.when) return 365;
    const staticWhen = stripRegime(m.when);
    let n = 0;
    for (let d = 0; d < 365; d++) {
      if (evaluatePredicate(staticWhen, this.ctx(m, d, this.cfg.timeOf(d), ""))) n++;
    }
    // no day of the reference year qualifies (e.g. gated on an era that starts later): fall back to
    // a whole year rather than collapsing to a per-day start probability of meanStartsPerYear
    return n === 0 ? 365 : n;
  }

  private startsAt(m: Modifier, d: number, regime: string): boolean {
    const time = this.cfg.timeOf(d);
    if (!this.matches(m, d, time, regime)) return false;
    const p = Math.min(1, m.spell!.meanStartsPerYear / this.windowDays.get(m.id)!);
    const s = new DrawStream(drawKey(this.cfg.seed, this.cfg.zoneId, d, `mod:${m.id}:spell`));
    return bernoulli(s, p);
  }

  private durationAt(m: Modifier, start: number): number {
    const s = new DrawStream(drawKey(this.cfg.seed, this.cfg.zoneId, start, `mod:${m.id}:spell-duration`));
    return geometricDuration(s, m.spell!.meanDurationDays);
  }

  /**
   * Scan a bounded window before d, replaying start draws, honouring
   * "no re-trigger while active". Regime-dependent spells use the CURRENT
   * regime for the whole scan (documented approximation: spells gated on a
   * regime are unusual; regimes have their own duration).
   */
  private spellActive(m: Modifier, d: number, regime: string): boolean {
    const L = Math.min(SPELL_LOOKBACK_MAX, Math.ceil(m.spell!.meanDurationDays * 8) + 1);
    let activeUntil = -Infinity;
    for (let s = d - L; s <= d; s++) {
      if (s <= activeUntil) continue;
      if (this.startsAt(m, s, regime)) activeUntil = s + this.durationAt(m, s) - 1;
    }
    return d <= activeUntil;
  }
}

function stripRegime(p: Predicate): Predicate {
  if ("all" in p) return { all: p.all.map(stripRegime) };
  if ("any" in p) return { any: p.any.map(stripRegime) };
  if ("not" in p) return { not: stripRegime(p.not) };
  if ("regime" in p) return { all: [] }; // vacuously true
  return p;
}
