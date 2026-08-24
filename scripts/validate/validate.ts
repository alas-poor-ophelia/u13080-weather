/**
 * Statistical validation: regenerate a preset for N years and compare the
 * result against the RAW CLIGEN station file it was built from — not against
 * the preset's own curves. This closes the loop from source data to output.
 *
 * Metrics per calendar month:
 *   wetDays        generated wet days / month  vs  stationary π_w × days   (from P(W/W), P(W/D))
 *   precipMm       generated total / month     vs  π_w × days × MEAN P
 *   tmaxC, tminC   generated mean high / low   vs  TMAX AV / TMIN AV (°F→°C)
 *   tmaxSdC        generated SD of daily high  vs  SD TMAX
 * Per preset:
 *   wetSpell, drySpell  mean run lengths vs the Markov expectation using the
 *                       realised transition frequencies (avoids seasonal selection bias)
 *
 * A 365-day year with calendar-month bins (day 0 = Jan 1) matches how the
 * station statistics were compiled.
 */
import { parseCligenPar, type CligenStation } from "../build-presets/cligen-parse";
import { stationaryWet } from "../build-presets/convert";
import { Generator, type DailyRecord } from "../../src/core/generator";
import type { DayTime, Preset, Regime } from "../../src/core/types";

export const NEUTRAL_REGIMES: Regime[] = [{ id: "normal", weight: 1, meanDurationDays: 12 }];

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const CUM = DAYS.reduce<number[]>((a, d, i) => [...a, (a[i - 1] ?? 0) + d], []);
const YEAR = 365;

export function calendarTime(d: number): DayTime {
  const doy = ((d % YEAR) + YEAR) % YEAR;
  return { yearPhase: doy / YEAR, dayOfYear: doy };
}
export function monthOf(doy: number): number {
  for (let m = 0; m < 12; m++) if (doy < CUM[m]!) return m;
  return 11;
}

const fToC = (f: number) => ((f - 32) * 5) / 9;
const fDeltaToC = (f: number) => (f * 5) / 9;
const IN_TO_MM = 25.4;

export interface MonthMetric {
  month: number;
  wetDays: { gen: number; exp: number };
  precipMm: { gen: number; exp: number };
  tmaxC: { gen: number; exp: number };
  tminC: { gen: number; exp: number };
  tmaxSdC: { gen: number; exp: number };
  tminSdC: { gen: number; exp: number };
}

export interface PresetValidation {
  presetId: string;
  station: string;
  years: number;
  regimes: "neutral" | "shipped";
  months: MonthMetric[];
  wetSpell: { gen: number; exp: number };
  drySpell: { gen: number; exp: number };
  annual: { precipMm: { gen: number; exp: number }; wetDays: { gen: number; exp: number }; tmeanC: { gen: number; exp: number } };
  /** worst deviations, for the summary table */
  worst: { wetDaysAbs: number; precipRel: number; tmaxAbs: number; tminAbs: number; tmaxSdRel: number; tminSdRel: number; wetSpellRel: number; drySpellRel: number };
}

export function validatePreset(preset: Preset, par: CligenStation, years: number, regimes: "neutral" | "shipped", seed = "validation"): PresetValidation {
  const g = new Generator({ seed, zoneId: preset.id, climate: preset.climate, regimes: regimes === "neutral" ? NEUTRAL_REGIMES : preset.regimes, timeOf: calendarTime });
  const recs = g.range(0, years * YEAR - 1);

  // monthly accumulators
  const acc = Array.from({ length: 12 }, () => ({ n: 0, wet: 0, precip: 0, tmax: 0, tmin: 0, tmax2: 0, tmin2: 0 }));
  let ww = 0;
  let wn = 0;
  let dw = 0;
  let dn = 0;
  const wetRuns: number[] = [];
  const dryRuns: number[] = [];
  let run = 0;
  let runWet = recs[0]!.wet;
  for (let i = 0; i < recs.length; i++) {
    const r: DailyRecord = recs[i]!;
    const m = monthOf(r.dayOrdinal % YEAR);
    const a = acc[m]!;
    a.n++;
    if (r.wet) a.wet++;
    a.precip += r.precipMm;
    a.tmax += r.tempHigh;
    a.tmin += r.tempLow;
    a.tmax2 += r.tempHigh * r.tempHigh;
    a.tmin2 += r.tempLow * r.tempLow;
    if (i > 0) {
      const prev = recs[i - 1]!.wet;
      if (prev) {
        wn++;
        if (r.wet) ww++;
      } else {
        dn++;
        if (r.wet) dw++;
      }
    }
    if (r.wet === runWet) run++;
    else {
      (runWet ? wetRuns : dryRuns).push(run);
      runWet = r.wet;
      run = 1;
    }
  }

  const months: MonthMetric[] = acc.map((a, m) => {
    const pi = stationaryWet(par.pww[m]!, par.pwd[m]!);
    const expWet = pi * DAYS[m]!;
    const meanTmax = a.tmax / a.n;
    const varTmax = a.tmax2 / a.n - meanTmax * meanTmax;
    const meanTmin = a.tmin / a.n;
    const varTmin = a.tmin2 / a.n - meanTmin * meanTmin;
    return {
      month: m,
      wetDays: { gen: (a.wet / a.n) * DAYS[m]!, exp: expWet },
      precipMm: { gen: (a.precip / a.n) * DAYS[m]!, exp: expWet * par.meanP[m]! * IN_TO_MM },
      tmaxC: { gen: meanTmax, exp: fToC(par.tmaxF[m]!) },
      tminC: { gen: a.tmin / a.n, exp: fToC(par.tminF[m]!) },
      tmaxSdC: { gen: Math.sqrt(Math.max(0, varTmax)), exp: fDeltaToC(par.sdTmax[m]!) },
      tminSdC: { gen: Math.sqrt(Math.max(0, varTmin)), exp: fDeltaToC(par.sdTmin[m]!) },
    };
  });

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const pwwReal = ww / wn;
  const pwdReal = dw / dn;
  const wetSpell = { gen: mean(wetRuns), exp: 1 / (1 - pwwReal) };
  const drySpell = { gen: mean(dryRuns), exp: 1 / pwdReal };

  const sum = (f: (m: MonthMetric) => number) => months.reduce((a, m) => a + f(m), 0);
  const annual = {
    precipMm: { gen: sum((m) => m.precipMm.gen), exp: sum((m) => m.precipMm.exp) },
    wetDays: { gen: sum((m) => m.wetDays.gen), exp: sum((m) => m.wetDays.exp) },
    tmeanC: { gen: sum((m) => (m.tmaxC.gen + m.tminC.gen) / 2) / 12, exp: sum((m) => (m.tmaxC.exp + m.tminC.exp) / 2) / 12 },
  };

  const rel = (g: number, e: number) => (e === 0 ? (g === 0 ? 0 : Infinity) : Math.abs(g - e) / e);
  const worst = {
    wetDaysAbs: Math.max(...months.map((m) => Math.abs(m.wetDays.gen - m.wetDays.exp))),
    // relative precip deviation only where the month is not nearly dry (< 5 mm)
    precipRel: Math.max(...months.filter((m) => m.precipMm.exp >= 5).map((m) => rel(m.precipMm.gen, m.precipMm.exp)), 0),
    tmaxAbs: Math.max(...months.map((m) => Math.abs(m.tmaxC.gen - m.tmaxC.exp))),
    tminAbs: Math.max(...months.map((m) => Math.abs(m.tminC.gen - m.tminC.exp))),
    tmaxSdRel: Math.max(...months.map((m) => rel(m.tmaxSdC.gen, m.tmaxSdC.exp))),
    tminSdRel: Math.max(...months.map((m) => rel(m.tminSdC.gen, m.tminSdC.exp))),
    wetSpellRel: rel(wetSpell.gen, wetSpell.exp),
    drySpellRel: rel(drySpell.gen, drySpell.exp),
  };

  return { presetId: preset.id, station: par.name, years, regimes, months, wetSpell, drySpell, annual, worst };
}

export async function loadPar(ghcnId: string, dir: URL): Promise<CligenStation> {
  return parseCligenPar(await Bun.file(new URL(`${ghcnId}.par`, dir)).text());
}

/** Markdown summary table. */
export function summaryTable(rows: PresetValidation[]): string {
  const h = "| preset | station | regimes | annual mm gen/exp | wet d gen/exp | Tmean gen/exp | worst wet d | worst mm % | worst Tmax | worst Tmin | Tmax SD % | Tmin SD % | wet spell % | dry spell % |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const f = (x: number, d = 1) => x.toFixed(d);
  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "∞");
  return [
    h,
    sep,
    ...rows.map(
      (r) =>
        `| ${r.presetId} | ${r.station} | ${r.regimes} | ${f(r.annual.precipMm.gen, 0)}/${f(r.annual.precipMm.exp, 0)} | ${f(r.annual.wetDays.gen, 0)}/${f(r.annual.wetDays.exp, 0)} | ${f(r.annual.tmeanC.gen)}/${f(r.annual.tmeanC.exp)} | ${f(r.worst.wetDaysAbs)} | ${pct(r.worst.precipRel)} | ${f(r.worst.tmaxAbs, 2)} | ${f(r.worst.tminAbs, 2)} | ${pct(r.worst.tmaxSdRel)} | ${pct(r.worst.tminSdRel)} | ${pct(r.worst.wetSpellRel)} | ${pct(r.worst.drySpellRel)} |`,
    ),
  ].join("\n");
}
