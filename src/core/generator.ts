/**
 * The daily generator (DESIGN-v1.md §4–§5).
 *
 * WGEN-family: two-state Markov wet/dry, gamma wet-day amounts, standardized
 * AR(1) temperature residual conditioned on wet/dry, wet/dry-conditioned
 * humidity / cloud / wind, and a slow semi-Markov regime layer that modulates
 * the day's parameters.
 *
 * Determinism is structural, not statistical:
 *  - every random draw is hash(seed, zone, day, name) — see rng.ts;
 *  - day d belongs to block floor(d / BLOCK); computing ANY day in a block
 *    always starts at blockStart − WARMUP from a state hashed from the block
 *    index and replays the identical sequence. generateDay(d) and any range
 *    containing d therefore agree exactly.
 *
 * Output is the raw DailyRecord (full floats). Rounding, descriptors, and
 * overrides are the report layer's job.
 *
 * GENERATOR_VERSION must change if any numeric behaviour here changes.
 *   0.0.2: wet-day temperature offset made mean-preserving (validation found a pi_w*offset bias);
 *          separate high/low residual SDs with Richardson's 0.633 same-day correlation;
 *          wet-day diurnal-range offset (wet days are less extreme).
 */
import { evalCurve } from "./curve";
import { applyDayOps, type DayParams } from "./ops";
import { DrawStream, bernoulli, drawKey, gamma, geometricDuration, normal, weightedIndex } from "./rng";
import type { ClimateParams, DayTime, ModifierOp, Regime } from "./types";

export const BLOCK = 64;
export const WARMUP = 90;
export const MAX_PERSISTENCE = 0.95;
/** Richardson (1981) same-day Tmax-Tmin residual correlation, M0[0][1]. */
export const TMAX_TMIN_CORR = 0.633;

export type PrecipType = "none" | "drizzle" | "rain" | "sleet" | "snow";

export interface DailyRecord {
  dayOrdinal: number;
  yearPhase: number;
  regime: string;
  wet: boolean;
  precipMm: number;
  precipType: PrecipType;
  tempMean: number;
  tempHigh: number;
  tempLow: number;
  /** standardized AR(1) residual (diagnostic) */
  tempResidual: number;
  humidity: number;
  cloudCover: number;
  windSpeedKph: number;
  windDirectionDeg: number;
  calm: boolean;
  /** tags contributed by active modifiers (and, later, overrides) */
  tags: string[];
}

export interface DailyModifiers {
  ops: readonly ModifierOp[];
  tags: readonly string[];
}

export interface GeneratorConfig {
  seed: string;
  zoneId: string;
  climate: ClimateParams;
  regimes: readonly Regime[];
  /** Per-day time information — supplied by the time adapter. */
  timeOf: (dayOrdinal: number) => DayTime;
  /** Optional daily-stage modifiers (applied after the regime's own ops). */
  dailyModifiers?: (dayOrdinal: number, regime: string) => DailyModifiers;
}

/** Thresholds for precipitation typing relative to freezingPoint. */
const DRIZZLE_MM = 1.0;
const SLEET_BAND_C = 2.0;

interface ChainState {
  regimeIndex: number;
  regimeRemaining: number;
  wet: boolean;
  residual: number;
}

export function evaluateDayParams(c: ClimateParams, t: number): DayParams {
  return {
    "temperature.mean": evalCurve(c.temperature.mean, t),
    "temperature.diurnalRange": evalCurve(c.temperature.diurnalRange, t),
    "temperature.wetDayOffset": evalCurve(c.temperature.wetDayOffset, t),
    "temperature.sd": evalCurve(c.temperature.sd, t),
    "temperature.sdHigh": evalCurve(c.temperature.sdHigh ?? c.temperature.sd, t),
    "temperature.sdLow": evalCurve(c.temperature.sdLow ?? c.temperature.sd, t),
    "temperature.wetDayRangeOffset": evalCurve(c.temperature.wetDayRangeOffset ?? 0, t),
    "precipitation.pww": evalCurve(c.precipitation.pww, t),
    "precipitation.pwd": evalCurve(c.precipitation.pwd, t),
    "precipitation.shape": evalCurve(c.precipitation.shape, t),
    "precipitation.scale": evalCurve(c.precipitation.scale, t),
    "humidity.dry": evalCurve(c.humidity.dry, t),
    "humidity.wet": evalCurve(c.humidity.wet, t),
    "cloud.dry": evalCurve(c.cloud.dry, t),
    "cloud.wet": evalCurve(c.cloud.wet, t),
    "wind.speed": evalCurve(c.wind.speed, t),
    "wind.speedSd": evalCurve(c.wind.speedSd, t),
    "wind.direction": evalCurve(c.wind.direction, t),
    "wind.directionSpread": evalCurve(c.wind.directionSpread, t),
    "wind.calmFraction": evalCurve(c.wind.calmFraction, t),
  };
}

function validate(cfg: GeneratorConfig): void {
  const p = cfg.climate.temperature.persistence;
  if (!(p >= 0 && p <= MAX_PERSISTENCE)) throw new RangeError(`temperature.persistence must be in [0, ${MAX_PERSISTENCE}] (got ${p})`);
  if (cfg.regimes.length === 0) throw new RangeError("at least one regime is required");
  for (const r of cfg.regimes) {
    if (!(r.weight >= 0)) throw new RangeError(`regime ${r.id}: weight must be >= 0`);
    if (!(r.meanDurationDays >= 1)) throw new RangeError(`regime ${r.id}: meanDurationDays must be >= 1`);
  }
  if (!cfg.regimes.some((r) => r.weight > 0)) throw new RangeError("at least one regime needs weight > 0");
}

export class Generator {
  private readonly blocks = new Map<number, DailyRecord[]>();
  private readonly weights: number[];

  constructor(readonly cfg: GeneratorConfig) {
    validate(cfg);
    this.weights = cfg.regimes.map((r) => r.weight);
  }

  day(dayOrdinal: number): DailyRecord {
    if (!Number.isInteger(dayOrdinal)) throw new RangeError("dayOrdinal must be an integer");
    const b = Math.floor(dayOrdinal / BLOCK);
    const rec = this.block(b)[dayOrdinal - b * BLOCK];
    if (!rec) throw new Error("generator: block lookup failed");
    return rec;
  }

  range(fromDay: number, toDay: number): DailyRecord[] {
    if (!Number.isInteger(fromDay) || !Number.isInteger(toDay)) throw new RangeError("range bounds must be integers");
    if (toDay < fromDay) throw new RangeError("range: toDay < fromDay");
    const out: DailyRecord[] = [];
    for (let d = fromDay; d <= toDay; d++) out.push(this.day(d));
    return out;
  }

  /** Drop cached blocks (e.g. after a profile change — callers should really make a new Generator). */
  clearCache(): void {
    this.blocks.clear();
  }

  private block(b: number): DailyRecord[] {
    const cached = this.blocks.get(b);
    if (cached) return cached;
    const blockStart = b * BLOCK;
    const start = blockStart - WARMUP;
    let state = this.initialState(b, start);
    const out: DailyRecord[] = [];
    for (let d = start; d < blockStart + BLOCK; d++) {
      const { record, next } = this.step(state, d);
      state = next;
      if (d >= blockStart) out.push(record);
    }
    this.blocks.set(b, out);
    return out;
  }

  private stream(day: number, name: string): DrawStream {
    return new DrawStream(drawKey(this.cfg.seed, this.cfg.zoneId, day, name));
  }

  /** Hashed from the block index only — independent of any other block or query. */
  private initialState(b: number, startDay: number): ChainState {
    const s = new DrawStream(drawKey(this.cfg.seed, this.cfg.zoneId, b, "block-init"));
    const regimeIndex = weightedIndex(s, this.weights);
    const regimeRemaining = geometricDuration(s, this.cfg.regimes[regimeIndex]!.meanDurationDays);
    const t = this.cfg.timeOf(startDay).yearPhase;
    const pww = evalCurve(this.cfg.climate.precipitation.pww, t);
    const pwd = evalCurve(this.cfg.climate.precipitation.pwd, t);
    const denom = 1 - pww + pwd;
    const piWet = denom <= 0 ? 0 : pwd / denom;
    const wet = bernoulli(s, piWet);
    const residual = normal(s);
    return { regimeIndex, regimeRemaining, wet, residual };
  }

  private step(prev: ChainState, d: number): { record: DailyRecord; next: ChainState } {
    const cfg = this.cfg;
    const t = cfg.timeOf(d).yearPhase;

    // --- regime layer (semi-Markov) ---
    let regimeIndex = prev.regimeIndex;
    let regimeRemaining = prev.regimeRemaining - 1;
    if (regimeRemaining <= 0) {
      const rs = this.stream(d, "regime");
      regimeIndex = weightedIndex(rs, this.weights);
      regimeRemaining = geometricDuration(rs, cfg.regimes[regimeIndex]!.meanDurationDays);
    }
    const regime = cfg.regimes[regimeIndex]!;

    // --- parameters for the day ---
    let params = evaluateDayParams(cfg.climate, t);
    const ops: ModifierOp[] = [...(regime.apply ?? [])];
    let tags: string[] = [];
    if (cfg.dailyModifiers) {
      const dm = cfg.dailyModifiers(d, regime.id);
      ops.push(...dm.ops);
      tags = [...dm.tags];
    }
    if (ops.length) params = applyDayOps(params, ops);

    // --- precipitation occurrence and amount ---
    const pWet = prev.wet ? params["precipitation.pww"] : params["precipitation.pwd"];
    const wet = bernoulli(this.stream(d, "wet"), pWet);
    const precipMm = wet ? gamma(this.stream(d, "amount"), params["precipitation.shape"], params["precipitation.scale"]) : 0;

    // --- temperature ---
    // One standardized AR(1) residual drives the daily high; the low shares it with
    // Richardson's same-day Tmax-Tmin correlation (M0[0][1] = 0.633, A2-constants.md section 4).
    const rho = cfg.climate.temperature.persistence;
    const residual = rho * prev.residual + Math.sqrt(1 - rho * rho) * normal(this.stream(d, "temp"));
    const residualLow = TMAX_TMIN_CORR * residual + Math.sqrt(1 - TMAX_TMIN_CORR * TMAX_TMIN_CORR) * normal(this.stream(d, "temp-low"));
    // Wet/dry split is mean-preserving: wet days sit +offset*(1-piWet) above the all-day mean,
    // dry days -offset*piWet below it, where piWet is today's stationary wet probability.
    const pwwT = params["precipitation.pww"];
    const pwdT = params["precipitation.pwd"];
    const denomT = 1 - pwwT + pwdT;
    const piWet = denomT <= 0 ? 0 : pwdT / denomT;
    const offset = params["temperature.wetDayOffset"];
    const split = wet ? offset * (1 - piWet) : -offset * piWet;
    const rangeOffset = params["temperature.wetDayRangeOffset"];
    const rangeSplit = wet ? rangeOffset * (1 - piWet) : -rangeOffset * piWet;
    const meanToday = params["temperature.mean"] + split;
    const half = Math.max(0, params["temperature.diurnalRange"] + rangeSplit) / 2;
    let tempHigh = meanToday + half + residual * params["temperature.sdHigh"];
    let tempLow = meanToday - half + residualLow * params["temperature.sdLow"];
    if (tempLow > tempHigh) [tempLow, tempHigh] = [tempHigh, tempLow];
    const tempMean = (tempHigh + tempLow) / 2;

    // --- precipitation type ---
    const fp = cfg.climate.precipitation.freezingPoint;
    let precipType: PrecipType = "none";
    if (wet) {
      if (tempMean <= fp) precipType = "snow";
      else if (tempMean <= fp + SLEET_BAND_C) precipType = "sleet";
      else precipType = precipMm < DRIZZLE_MM ? "drizzle" : "rain";
    }

    // --- humidity, cloud ---
    const hs = this.stream(d, "humidity");
    const humidity = clamp01((wet ? params["humidity.wet"] : params["humidity.dry"]) + normal(hs) * cfg.climate.humidity.sd);
    const cs = this.stream(d, "cloud");
    const cloudCover = clamp01((wet ? params["cloud.wet"] : params["cloud.dry"]) + normal(cs) * cfg.climate.cloud.sd);

    // --- wind ---
    const ws = this.stream(d, "wind");
    const calm = bernoulli(ws, params["wind.calmFraction"]);
    const speedBase = params["wind.speed"] * (wet ? cfg.climate.wind.wetDayScale : 1);
    const windSpeedKph = calm ? 0 : Math.max(0, speedBase + normal(ws) * params["wind.speedSd"]);
    const windDirectionDeg = wrapDeg(params["wind.direction"] + normal(ws) * params["wind.directionSpread"]);

    const record: DailyRecord = {
      dayOrdinal: d,
      yearPhase: t,
      regime: regime.id,
      wet,
      precipMm,
      precipType,
      tempMean,
      tempHigh,
      tempLow,
      tempResidual: residual,
      humidity,
      cloudCover,
      windSpeedKph,
      windDirectionDeg,
      calm,
      tags,
    };
    return { record, next: { regimeIndex, regimeRemaining, wet, residual } };
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function wrapDeg(x: number): number {
  return ((x % 360) + 360) % 360;
}

/** Gregorian-ish time for tests and the internal fallback adapter: day 0 = Jan 1, 365.25-day year. */
export function gregorianTime(dayOrdinal: number): DayTime {
  const y = 365.25;
  const r = ((dayOrdinal % y) + y) % y;
  return { yearPhase: r / y, dayOfYear: Math.floor(r) };
}
