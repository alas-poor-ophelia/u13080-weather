/**
 * Statistical validation of every shipped preset against its raw station file.
 * Tolerances are derived from sample size (30 years) so the suite is a
 * bias detector, not a noise detector:
 *   wet days     5σ of a Markov-inflated binomial
 *   precip       5σ on the gamma mean given the expected wet-day count (months ≥ 5 mm)
 *   temperature  5σ of an AR(1) mean with the preset's daily SD
 *   spells       3% (the Markov chain is exact; this catches chain bugs)
 *   Tmax/Tmin SD 5σ of a sample SD (≈ sd/√(2n), AR-inflated) + 10% model slack
 *   annual       precipitation 5σ on the gamma mean over the year's wet days, wet days 5%
 * Plus: the shipped default regimes must not bias annual wet days or precipitation by more than 6%.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { evalCurve, monthCentrePhase } from "../src/core/curve";
import type { Preset } from "../src/core/types";
import { stationaryWet } from "../scripts/build-presets/convert";
import { loadPar, validatePreset } from "../scripts/validate/validate";

const YEARS = 30;
const presetDir = new URL("../presets/", import.meta.url);
const parDir = new URL("./fixtures/par/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(presetDir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, presetDir)).json() as Promise<Preset>),
);
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

describe(`validation: ${presets.length} presets vs their station files (${YEARS} years)`, () => {
  expect(presets.length).toBe(26);

  test.each(presets.map((p) => [p.id, p] as const))("%s", async (_, p) => {
    const par = await loadPar(p.source.ghcnId, parDir);
    const v = validatePreset(p, par, YEARS, "neutral");
    const rho = p.climate.temperature.persistence;
    const ar = Math.sqrt((1 + rho) / (1 - rho));

    for (const m of v.months) {
      const n = DAYS[m.month]! * YEARS;
      const pi = stationaryWet(par.pww[m.month]!, par.pwd[m.month]!);
      const pwwM = par.pww[m.month]!;
      const markov = Math.sqrt((1 + pwwM) / (1 - pwwM + 1e-9)); // persistence inflation of the binomial SE
      const seWet = Math.sqrt((pi * (1 - pi)) / n) * markov * DAYS[m.month]!;
      expect(Math.abs(m.wetDays.gen - m.wetDays.exp)).toBeLessThan(5 * seWet + 0.2);

      if (m.precipMm.exp >= 5) {
        const shape = evalCurve(p.climate.precipitation.shape, monthCentrePhase(m.month));
        const wetN = Math.max(1, pi * n);
        const cvMean = Math.sqrt(1 / (shape * wetN)); // CV of the sample mean of a gamma
        const tolRel = 5 * Math.sqrt(cvMean * cvMean + (seWet / m.wetDays.exp) ** 2) + 0.02;
        expect(Math.abs(m.precipMm.gen - m.precipMm.exp) / m.precipMm.exp).toBeLessThan(tolRel);
      }

      const sd = evalCurve(p.climate.temperature.sd, monthCentrePhase(m.month));
      const seT = (sd * ar) / Math.sqrt(n);
      expect(Math.abs(m.tmaxC.gen - m.tmaxC.exp)).toBeLessThan(5 * seT + 0.1);
      expect(Math.abs(m.tminC.gen - m.tminC.exp)).toBeLessThan(5 * seT + 0.1);
      const seSdRel = (ar / Math.sqrt(2 * n)) * 5 + 0.1;
      expect(Math.abs(m.tmaxSdC.gen - m.tmaxSdC.exp) / m.tmaxSdC.exp).toBeLessThan(seSdRel);
      expect(Math.abs(m.tminSdC.gen - m.tminSdC.exp) / m.tminSdC.exp).toBeLessThan(seSdRel);
    }

    expect(v.worst.wetSpellRel).toBeLessThan(0.03);
    expect(v.worst.drySpellRel).toBeLessThan(0.03);
    const annualWetN = v.annual.wetDays.exp * YEARS;
    const annualShape = evalCurve(p.climate.precipitation.shape, 0.5);
    expect(Math.abs(v.annual.precipMm.gen - v.annual.precipMm.exp) / v.annual.precipMm.exp).toBeLessThan(5 / Math.sqrt(annualShape * annualWetN) + 0.02);
    expect(Math.abs(v.annual.wetDays.gen - v.annual.wetDays.exp) / v.annual.wetDays.exp).toBeLessThan(0.05);
    expect(Math.abs(v.annual.tmeanC.gen - v.annual.tmeanC.exp)).toBeLessThan(0.3);

    const s = validatePreset(p, par, YEARS, "shipped");
    expect(Math.abs(s.annual.wetDays.gen / v.annual.wetDays.gen - 1)).toBeLessThan(0.06);
    expect(Math.abs(s.annual.precipMm.gen / v.annual.precipMm.gen - 1)).toBeLessThan(0.06);
  });
});
