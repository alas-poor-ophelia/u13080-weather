import { describe, expect, test } from "bun:test";
import { evalCurve } from "../src/core/curve";
import { BLOCK, Generator, WARMUP, gregorianTime, type GeneratorConfig } from "../src/core/generator";
import { applyDayOps, type DayParams } from "../src/core/ops";
import type { Preset, Regime } from "../src/core/types";

async function preset(slug: string): Promise<Preset> {
  return (await Bun.file(new URL(`../presets/${slug}.json`, import.meta.url)).json()) as Preset;
}

const NEUTRAL: Regime[] = [{ id: "normal", weight: 1, meanDurationDays: 12 }];

function cfgFor(p: Preset, over: Partial<GeneratorConfig> = {}): GeneratorConfig {
  return { seed: "test-seed", zoneId: p.id, climate: p.climate, regimes: p.regimes, timeOf: gregorianTime, ...over };
}

const fjord = await preset("fjord-coast");
const desert = await preset("red-desert");
const frozen = await preset("frozen-heartland");

describe("generator: structural determinism", () => {
  test("single-day and range queries agree exactly, including across block boundaries", () => {
    const g1 = new Generator(cfgFor(fjord));
    const g2 = new Generator(cfgFor(fjord));
    const from = 3 * BLOCK - 10;
    const to = 5 * BLOCK + 10; // spans three blocks
    const range = g2.range(from, to);
    for (let d = from; d <= to; d++) {
      expect(g1.day(d)).toEqual(range[d - from]!);
    }
  });

  test("order of queries does not matter", () => {
    const a = new Generator(cfgFor(fjord));
    const b = new Generator(cfgFor(fjord));
    const r1 = [a.day(1000), a.day(5), a.day(-300), a.day(64)];
    const r2 = [b.day(64), b.day(-300), b.day(5), b.day(1000)].reverse();
    expect(r1).toEqual(r2);
  });

  test("negative days work and are stable", () => {
    const g = new Generator(cfgFor(fjord));
    expect(g.day(-1)).toEqual(new Generator(cfgFor(fjord)).day(-1));
    expect(g.day(-1).dayOrdinal).toBe(-1);
  });

  test("seed and zone id both change the output", () => {
    const base = new Generator(cfgFor(fjord)).range(0, 30).map((r) => r.precipMm);
    const seed = new Generator(cfgFor(fjord, { seed: "other" })).range(0, 30).map((r) => r.precipMm);
    const zone = new Generator(cfgFor(fjord, { zoneId: "elsewhere" })).range(0, 30).map((r) => r.precipMm);
    expect(base).not.toEqual(seed);
    expect(base).not.toEqual(zone);
  });

  test("warm-up constants are what the design says", () => {
    expect(BLOCK).toBe(64);
    expect(WARMUP).toBe(90);
  });

  test("rejects invalid persistence / regimes", () => {
    expect(() => new Generator(cfgFor(fjord, { climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, persistence: 0.99 } } }))).toThrow(RangeError);
    expect(() => new Generator(cfgFor(fjord, { regimes: [] }))).toThrow(RangeError);
    expect(() => new Generator(cfgFor(fjord, { regimes: [{ id: "x", weight: 0, meanDurationDays: 5 }] }))).toThrow(RangeError);
  });
});

/** Monthly aggregation over N years of a record stream. */
function monthly(recs: ReturnType<Generator["range"]>) {
  const m = Array.from({ length: 12 }, () => ({ n: 0, wet: 0, precip: 0, temp: 0 }));
  for (const r of recs) {
    const i = Math.min(11, Math.floor(r.yearPhase * 12));
    const b = m[i]!;
    b.n++;
    if (r.wet) b.wet++;
    b.precip += r.precipMm;
    b.temp += r.tempMean;
  }
  return m.map((b) => ({ wetFrac: b.wet / b.n, precipPerDay: b.precip / b.n, tempMean: b.temp / b.n }));
}

function stationary(p: Preset, t: number) {
  const pww = evalCurve(p.climate.precipitation.pww, t);
  const pwd = evalCurve(p.climate.precipitation.pwd, t);
  return pwd / (1 - pww + pwd);
}

describe("generator: fidelity to the preset (neutral regime, 40 years)", () => {
  const YEARS = 40;
  const DAYS = Math.round(YEARS * 365.25);

  test.each([
    ["fjord-coast", fjord],
    ["red-desert", desert],
    ["frozen-heartland", frozen],
  ])("%s: wet-day fraction, precipitation, and temperature track the curves", (_, p) => {
    const g = new Generator(cfgFor(p, { regimes: NEUTRAL, seed: "fidelity" }));
    const m = monthly(g.range(0, DAYS - 1));
    const rho = p.climate.temperature.persistence;
    const binAvg = (c: Parameters<typeof evalCurve>[0], i: number) => {
      let a = 0;
      for (let k = 0; k < 50; k++) a += evalCurve(c, (i + (k + 0.5) / 50) / 12);
      return a / 50;
    };
    for (let i = 0; i < 12; i++) {
      const t = (i + 0.5) / 12;
      const piWet = stationary(p, t);
      const nDays = DAYS / 12;
      // wet-day fraction: binomial-ish SE inflated for Markov persistence
      expect(Math.abs(m[i]!.wetFrac - piWet)).toBeLessThan(4 * Math.sqrt((piWet * (1 - piWet)) / nDays) * 2 + 0.005);
      // precipitation per day: gamma tails → tolerance from expected wet-day count
      const wetMean = evalCurve(p.climate.precipitation.shape, t) * evalCurve(p.climate.precipitation.scale, t);
      const expectedPerDay = piWet * wetMean;
      const expectedWetDays = piWet * nDays;
      const tol = 0.05 + 4 / Math.sqrt(Math.max(expectedWetDays, 1));
      expect(Math.abs(m[i]!.precipPerDay - expectedPerDay) / Math.max(expectedPerDay, 1e-9)).toBeLessThan(tol);
      // temperature: compare against the BIN-AVERAGED curve (midpoint value is biased by curvature)
      const tMean = binAvg(p.climate.temperature.mean, i) + piWet * binAvg(p.climate.temperature.wetDayOffset, i);
      const sd = binAvg(p.climate.temperature.sd, i);
      const se = (sd * Math.sqrt((1 + rho) / (1 - rho))) / Math.sqrt(nDays);
      expect(Math.abs(m[i]!.tempMean - tMean)).toBeLessThan(4 * se + 0.15);
    }
  });

  test("fjord-coast: realised transition frequencies match the pww/pwd curves (200 years)", () => {
    const g = new Generator(cfgFor(fjord, { regimes: NEUTRAL, seed: "spells" }));
    const recs = g.range(0, Math.round(200 * 365.25) - 1);
    // Expected P(W|W) is the pww curve averaged over days that FOLLOW a wet day; use the
    // realised wet days as the weighting to avoid the seasonal selection effect.
    let ww = 0;
    let wn = 0;
    let dw = 0;
    let dn = 0;
    let pwwExp = 0;
    let pwdExp = 0;
    for (let i = 1; i < recs.length; i++) {
      const prev = recs[i - 1]!.wet;
      const cur = recs[i]!.wet;
      const t = recs[i]!.yearPhase;
      if (prev) {
        wn++;
        if (cur) ww++;
        pwwExp += evalCurve(fjord.climate.precipitation.pww, t);
      } else {
        dn++;
        if (cur) dw++;
        pwdExp += evalCurve(fjord.climate.precipitation.pwd, t);
      }
    }
    expect(Math.abs(ww / wn - pwwExp / wn)).toBeLessThan(0.006);
    expect(Math.abs(dw / dn - pwdExp / dn)).toBeLessThan(0.006);
    // mean wet spell ≈ 1 / (1 − P(W|W))
    const spells: number[] = [];
    let run = 0;
    for (const r of recs) {
      if (r.wet) run++;
      else if (run > 0) {
        spells.push(run);
        run = 0;
      }
    }
    const meanSpell = spells.reduce((a, b) => a + b, 0) / spells.length;
    expect(Math.abs(meanSpell - 1 / (1 - ww / wn)) / meanSpell).toBeLessThan(0.03);
  });

  test("temperature residual has unit variance and the configured lag-1 autocorrelation", () => {
    const g = new Generator(cfgFor(frozen, { regimes: NEUTRAL, seed: "ar1" }));
    const res = g.range(0, DAYS - 1).map((r) => r.tempResidual);
    const mean = res.reduce((a, b) => a + b, 0) / res.length;
    const v = res.reduce((a, b) => a + (b - mean) ** 2, 0) / res.length;
    let c = 0;
    for (let i = 1; i < res.length; i++) c += (res[i]! - mean) * (res[i - 1]! - mean);
    const rho = c / res.length / v;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(v - 1)).toBeLessThan(0.05);
    expect(Math.abs(rho - frozen.climate.temperature.persistence)).toBeLessThan(0.03);
  });

  test("snow falls in a Yakutian winter and rain in a Bergen summer", () => {
    const fz = new Generator(cfgFor(frozen, { regimes: NEUTRAL })).range(0, 365 * 5);
    const janWet = fz.filter((r) => r.wet && r.yearPhase < 0.1);
    expect(janWet.length).toBeGreaterThan(0);
    expect(janWet.every((r) => r.precipType === "snow")).toBe(true);
    const bg = new Generator(cfgFor(fjord, { regimes: NEUTRAL })).range(0, 365 * 5);
    const julWet = bg.filter((r) => r.wet && r.yearPhase > 0.5 && r.yearPhase < 0.6);
    expect(julWet.every((r) => r.precipType === "rain" || r.precipType === "drizzle")).toBe(true);
  });

  test("all fields are finite and within their domains", () => {
    for (const r of new Generator(cfgFor(desert)).range(-200, 2000)) {
      expect(Number.isFinite(r.tempMean)).toBe(true);
      expect(r.tempHigh).toBeGreaterThanOrEqual(r.tempLow);
      expect(r.precipMm).toBeGreaterThanOrEqual(0);
      expect(r.wet ? r.precipMm > 0 : r.precipMm === 0).toBe(true);
      expect(r.humidity).toBeGreaterThanOrEqual(0);
      expect(r.humidity).toBeLessThanOrEqual(1);
      expect(r.cloudCover).toBeGreaterThanOrEqual(0);
      expect(r.cloudCover).toBeLessThanOrEqual(1);
      expect(r.windSpeedKph).toBeGreaterThanOrEqual(0);
      expect(r.windDirectionDeg).toBeGreaterThanOrEqual(0);
      expect(r.windDirectionDeg).toBeLessThan(360);
      if (r.calm) expect(r.windSpeedKph).toBe(0);
    }
  });
});

describe("generator: regime layer", () => {
  test("regime occupancy roughly follows weight × duration", () => {
    const g = new Generator(cfgFor(fjord, { seed: "regimes" }));
    const recs = g.range(0, 365 * 40);
    const counts = new Map<string, number>();
    for (const r of recs) counts.set(r.regime, (counts.get(r.regime) ?? 0) + 1);
    // expected occupancy ∝ weight × meanDuration
    const expW = fjord.regimes.map((r) => r.weight * r.meanDurationDays);
    const total = expW.reduce((a, b) => a + b, 0);
    fjord.regimes.forEach((r, i) => {
      const frac = (counts.get(r.id) ?? 0) / recs.length;
      expect(Math.abs(frac - expW[i]! / total)).toBeLessThan(0.05);
    });
  });

  test("a dry-spell regime lowers the wet-day fraction while active; a wet-spell raises it", () => {
    const g = new Generator(cfgFor(fjord, { seed: "regime-effect" }));
    const recs = g.range(0, 365 * 40);
    const frac = (id: string) => {
      const rs = recs.filter((r) => r.regime === id);
      return rs.filter((r) => r.wet).length / rs.length;
    };
    expect(frac("dry-spell")).toBeLessThan(frac("normal"));
    expect(frac("wet-spell")).toBeGreaterThan(frac("normal"));
  });

  test("dailyModifiers hook is applied, sees the regime, and its tags land on the record", () => {
    const seen = new Set<string>();
    const g = new Generator(
      cfgFor(fjord, {
        dailyModifiers: (_d, regime) => {
          seen.add(regime);
          return { ops: [{ param: "precipitation.pwd", op: "set", value: 0 }, { param: "precipitation.pww", op: "set", value: 0 }], tags: ["drought"] };
        },
      }),
    );
    const recs = g.range(0, 400);
    expect(recs.every((r) => !r.wet && r.tags.includes("drought"))).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("ops", () => {
  const base: DayParams = {
    "temperature.mean": 10,
    "temperature.diurnalRange": 8,
    "temperature.wetDayOffset": -1,
    "temperature.sd": 3,
    "temperature.sdHigh": 3,
    "temperature.sdLow": 3,
    "temperature.wetDayRangeOffset": 0,
    "precipitation.pww": 0.6,
    "precipitation.pwd": 0.3,
    "precipitation.shape": 0.8,
    "precipitation.scale": 5,
    "humidity.dry": 0.5,
    "humidity.wet": 0.8,
    "cloud.dry": 0.4,
    "cloud.wet": 0.9,
    "wind.speed": 15,
    "wind.speedSd": 5,
    "wind.direction": 350,
    "wind.directionSpread": 30,
    "wind.calmFraction": 0.2,
  };

  test("set / offset / scale / clamp in order", () => {
    const out = applyDayOps(base, [
      { param: "temperature.mean", op: "offset", value: -4 },
      { param: "temperature.mean", op: "scale", value: 2 },
      { param: "precipitation.pwd", op: "scale", value: 10 },
      { param: "wind.direction", op: "offset", value: 30 },
      { param: "cloud.dry", op: "clamp", min: 0.6 },
      { param: "precipitation.scale", op: "set", value: -3 },
    ]);
    expect(out["temperature.mean"]).toBe(12);
    expect(out["precipitation.pwd"]).toBe(1); // clamped probability
    expect(out["wind.direction"]).toBe(20); // wrapped
    expect(out["cloud.dry"]).toBe(0.6);
    expect(out["precipitation.scale"]).toBe(1e-9); // floored positive
    expect(out["temperature.sd"]).toBe(3); // untouched
  });

  test("unknown path throws", () => {
    expect(() => applyDayOps(base, [{ param: "precipitation.chance", op: "set", value: 1 }])).toThrow(RangeError);
  });
});
