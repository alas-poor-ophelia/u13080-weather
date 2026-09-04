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

/**
 * Sample an onset envelope at phase `t` (PLAN §0 D8). Points are sorted by
 * phase and interpolated linearly; the segment from the last point to the
 * first wraps across 1→0. A single point is a constant; an empty envelope is 1.
 * Pure: no RNG, no state.
 */
export function sampleEnvelope(env: readonly (readonly [number, number])[], t: number): number {
  if (env.length === 0) return 1;
  const pts = [...env].sort((a, b) => a[0] - b[0]);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length === 1) return first[1];
  const x = ((t % 1) + 1) % 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (x >= a[0] && x <= b[0]) return b[0] === a[0] ? a[1] : a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
  }
  // outside [first, last]: the wrapping segment last → first + 1
  const span = first[0] + 1 - last[0];
  const d = x >= last[0] ? x - last[0] : x + 1 - last[0];
  return span === 0 ? last[1] : last[1] + (first[1] - last[1]) * (d / span);
}

/**
 * A gate RESTRICTS a device to its source (PLAN §0 D19). On a day carrying the
 * gate's `source` tag the gate contributes ×1 — the device runs at the strength
 * its author wrote; on every OTHER day it contributes ×(1 − amount). So `amount`
 * is the gate's STRENGTH, not a dimmer: 1 is a hard gate (silent outside the
 * source), 0.5 halves the device outside it, 0 is no gate at all.
 *
 * A gate source is a TAG, never a moon (PLAN §2.4). Gates multiply, so a device
 * with two gates runs full only on a day carrying BOTH sources. No gates = 1.
 * `time.tags` is the day's context as the modifier's own predicate saw it, so
 * tags pushed by EARLIER modifiers today do gate later ones.
 */
function gateFactor(m: Modifier, time: DayTime): number {
  if (!m.mods?.length) return 1;
  const tags = time.tags ?? [];
  let f = 1;
  for (const g of m.mods) if (!tags.includes(g.source)) f *= 1 - g.amount;
  return f;
}

/**
 * The carrier moon's phase: the moon named in a bare `{ moon }` predicate,
 * else the first moon of the day, else undefined (no carrier → factor 1).
 */
function carrierPhase(m: Modifier, time: DayTime): number | undefined {
  const w = m.when;
  if (w && "moon" in w) return time.moons?.find((x) => x.name === w.moon.name)?.phase;
  return time.moons?.[0]?.phase;
}

function envelopeFactor(m: Modifier, op: ModifierOp, time: DayTime): number {
  if (!op.envelope?.length) return 1;
  const phase = carrierPhase(m, time);
  return phase === undefined ? 1 : sampleEnvelope(op.envelope, phase);
}

/**
 * Rewrite an op's magnitude by factor `f` and drop the envelope (downstream
 * `applyDayOps` must never see it): `offset v → v·f`, `scale v → 1 + (v−1)·f`,
 * `set`/`clamp` pass through. f = 1 with no envelope returns the op unchanged.
 *
 * `f` is always in [0, 1]: a gate factor is 1 inside its source and 1 − amount
 * outside it, an envelope strength is a dimmer, and `validateGates` /
 * `validateEnvelope` reject any `amount`/`strength` outside [0, 1]. With
 * a non-negative `scale` value that pins `1 + (v−1)·f` between `v` and 1, so a
 * dimmer can never flip the sign of a scale. The invariant is the validator's;
 * the engine deliberately does no clamping of its own.
 */
function scaleOpMagnitude(op: ModifierOp, f: number): ModifierOp {
  if (f === 1 && op.envelope === undefined) return op;
  const out = { ...op };
  delete out.envelope;
  if (out.op === "offset") return { ...out, value: out.value * f };
  if (out.op === "scale") return { ...out, value: 1 + (out.value - 1) * f };
  return out;
}

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
    // a disabled modifier never reaches a day: no ops, no tag, not in `active`, and no spell window
    this.daily = cfg.modifiers.filter((m) => (m.stage ?? "daily") === "daily" && m.enabled !== false);
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
      // gates and envelopes only rewrite MAGNITUDE: the modifier stays active and still sets its
      // tag even at factor 0, and `time` here is the same object the predicate saw (so a gate can
      // read a tag pushed by an earlier modifier today).
      const gate = gateFactor(m, time);
      ops.push(...m.apply.filter((o) => o.enabled !== false).map((o) => scaleOpMagnitude(o, gate * envelopeFactor(m, o, time))));
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
