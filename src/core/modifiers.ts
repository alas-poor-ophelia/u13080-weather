/**
 * The modifier engine (DESIGN-v1.md §3): evaluates the closed predicate
 * grammar (compiled once per engine to Seshat rules, src/core/rules.ts), the
 * deterministic `chance` and `spell` primitives, and produces the day's ops +
 * tags for the generator's dailyModifiers hook.
 *
 * Determinism: every random decision is hash(seed, zone, day, "mod:<id>:…").
 * A spell's activity on day d is recomputed by scanning a bounded window of
 * earlier days with the same hashed draws, so it is a pure function of d.
 */
import { wrap } from "../seshat/phase";
import { evaluate, TimeView, type EvalOptions, type RuleAst } from "../seshat/rule";
import { DEFAULT_YEAR_LENGTH } from "../seshat/year";
import { DrawStream, bernoulli, drawKey, geometricDuration } from "./rng";
import { compilePredicate, generationOptions, staticOptions, type RuleHostContext } from "./rules";
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
  const x = wrap(t);
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

/** A daily modifier as the engine runs it: the stored object (never written to), its compiled rule and envelope carrier. */
interface Compiled {
  readonly m: Modifier;
  /** absent: no `when`, always on */
  readonly rule?: RuleAst;
  /** the moon named by a bare top-level `{ moon }` predicate; absent: the day's first moon */
  readonly carrier?: string;
}

function compileModifier(m: Modifier): Compiled {
  const w = m.when;
  if (!w) return { m };
  const rule = compilePredicate(w);
  return "moon" in w ? { m, rule, carrier: w.moon.name } : { m, rule };
}

/**
 * The carrier moon's phase: the moon named in a bare `{ moon }` predicate,
 * else the first moon of the day, else undefined (no carrier → factor 1).
 */
function carrierPhase(c: Compiled, time: DayTime): number | undefined {
  if (c.carrier !== undefined) return time.moons?.find((x) => x.name === c.carrier)?.phase;
  return time.moons?.[0]?.phase;
}

function envelopeFactor(c: Compiled, op: ModifierOp, time: DayTime): number {
  if (!op.envelope?.length) return 1;
  const phase = carrierPhase(c, time);
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

/** Longest internal-calendar year (settings validation), and the most days a spell window scan reads. */
export const YEAR_LENGTH_MAX = 10_000;

export class ModifierEngine {
  private readonly daily: Compiled[];
  private readonly windowDays = new Map<string, number>();
  /** one host context, filled in before each evaluation; both option sets read it */
  private readonly host: RuleHostContext;
  private readonly generation: EvalOptions;
  private readonly estimate: EvalOptions;

  constructor(readonly cfg: ModifierEngineConfig) {
    this.host = { seed: cfg.seed, zoneId: cfg.zoneId, modifierId: "", dayOrdinal: 0, regime: "" };
    this.generation = generationOptions(this.host);
    this.estimate = staticOptions(this.host);
    // a disabled modifier never reaches a day: no ops, no tag, not in `active`, and no spell window
    this.daily = cfg.modifiers.filter((m) => (m.stage ?? "daily") === "daily" && m.enabled !== false).map(compileModifier);
    for (const c of this.daily) {
      if (c.m.spell) this.windowDays.set(c.m.id, this.estimateWindowDays(c));
    }
  }

  /** Ops and tags for day d given the regime the generator has chosen. */
  forDay(dayOrdinal: number, regime: string): DailyModifierResult {
    const ops: ModifierOp[] = [];
    const tags: string[] = [];
    const active: string[] = [];
    const base = this.cfg.timeOf(dayOrdinal);
    for (const c of this.daily) {
      const m = c.m;
      // tags set by earlier modifiers today are visible to later ones (spells replay past days and see only calendar tags)
      const time = tags.length ? { ...base, tags: [...(base.tags ?? []), ...tags] } : base;
      const on = m.spell ? this.spellActive(c, dayOrdinal, regime) : this.matches(c, dayOrdinal, time, regime);
      if (!on) continue;
      // gates and envelopes only rewrite MAGNITUDE: the modifier stays active and still sets its
      // tag even at factor 0, and `time` here is the same object the predicate saw (so a gate can
      // read a tag pushed by an earlier modifier today).
      const gate = gateFactor(m, time);
      ops.push(...m.apply.filter((o) => o.enabled !== false).map((o) => scaleOpMagnitude(o, gate * envelopeFactor(c, o, time))));
      if (m.tag) tags.push(m.tag);
      active.push(m.id);
    }
    return { ops, tags, active };
  }

  /** Evaluate c's rule on one day; the host context carries what the chance and regime leaves read. */
  private evaluate(c: Compiled, rule: RuleAst, dayOrdinal: number, time: DayTime, regime: string, opts: EvalOptions): boolean | undefined {
    this.host.modifierId = c.m.id;
    this.host.dayOrdinal = dayOrdinal;
    this.host.regime = regime;
    return evaluate(rule, new TimeView(time, dayOrdinal), opts);
  }

  private matches(c: Compiled, dayOrdinal: number, time: DayTime, regime: string): boolean {
    if (!c.rule) return true;
    return this.evaluate(c, c.rule, dayOrdinal, time, regime, this.generation) === true;
  }

  /**
   * Window size for converting meanStartsPerYear into a per-day start
   * probability: the number of days in a reference year (days 0..L-1, L the
   * year length the calendar reports at day 0, or 365 when the time source
   * reports none) on which `when` can hold. Regime and era terms are UNKNOWN
   * for this estimate (the regime is decided during generation, and an era
   * rarely covers the reference year): a day counts unless `when` is false
   * whatever they turn out to be, so `not era:X` and `not regime` are counted
   * correctly too. Tags from other modifiers are not visible to it. A year longer than YEAR_LENGTH_MAX is sampled on its first
   * YEAR_LENGTH_MAX days and the count scaled to the full year.
   */
  private estimateWindowDays(c: Compiled): number {
    const reported = (this.cfg.timeOf(0) as DayTime & { yearLength?: number }).yearLength;
    const year = typeof reported === "number" && Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : DEFAULT_YEAR_LENGTH;
    if (!c.rule) return year;
    const scanned = Math.min(year, YEAR_LENGTH_MAX);
    let n = 0;
    for (let d = 0; d < scanned; d++) {
      if (this.evaluate(c, c.rule, d, this.cfg.timeOf(d), "", this.estimate) !== false) n++;
    }
    // no day of the reference year qualifies: fall back to a whole year rather than collapsing to a
    // per-day start probability of meanStartsPerYear
    if (n === 0) return year;
    return scanned === year ? n : Math.max(1, Math.round((n * year) / scanned));
  }

  private startsAt(c: Compiled, d: number, regime: string): boolean {
    const m = c.m;
    const time = this.cfg.timeOf(d);
    if (!this.matches(c, d, time, regime)) return false;
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
  private spellActive(c: Compiled, d: number, regime: string): boolean {
    const m = c.m;
    const L = Math.min(SPELL_LOOKBACK_MAX, Math.ceil(m.spell!.meanDurationDays * 8) + 1);
    let activeUntil = -Infinity;
    for (let s = d - L; s <= d; s++) {
      if (s <= activeUntil) continue;
      if (this.startsAt(c, s, regime)) activeUntil = s + this.durationAt(m, s) - 1;
    }
    return d <= activeUntil;
  }
}
