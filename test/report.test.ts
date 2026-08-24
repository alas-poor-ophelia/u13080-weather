import { describe as group, expect, test } from "bun:test";
import { gregorianTime, type DailyRecord } from "../src/core/generator";
import { GENERATOR_VERSION } from "../src/core/version";
import { createGenerator } from "../src/core/profile";
import {
  DEFAULT_BANDS,
  HEURISTIC,
  _internal,
  applyPatch,
  bandLabel,
  buildReport,
  compassPoint,
  describe,
  diurnalTemperature,
  intensityFromMm,
  overrideKey,
  withMinus,
  precipitationWindow,
  visibilityKm,
  type OverridePatch,
  type ReportBuilderConfig,
} from "../src/core/report";
import type { Preset, ZoneProfile } from "../src/core/types";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
const zone: ZoneProfile = { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [] };
const { generator, resolved } = createGenerator(zone, "seed", gregorianTime);
const cfg: ReportBuilderConfig = { seed: "seed", provenance: { profileHash: resolved.profileHash, calendarHash: "cal:test" } };

const rec = (over: Partial<DailyRecord> = {}): DailyRecord => ({
  dayOrdinal: 10,
  yearPhase: 0.03,
  regime: "normal",
  wet: true,
  precipMm: 6.123456,
  precipType: "rain",
  tempMean: 4.4444,
  tempHigh: 7.7777,
  tempLow: 1.1111,
  tempResidual: 0.3,
  humidity: 0.876543,
  cloudCover: 0.91234,
  windSpeedKph: 17.6,
  windDirectionDeg: 247.4,
  calm: false,
  tags: ["stormtide"],
  ...over,
});

group("report: rounding, shape, provenance", () => {
  test("fields are rounded to the documented steps and the shape matches the contract", () => {
    const r = buildReport(rec(), "greywold", cfg);
    expect(r.schemaVersion).toBe(0);
    expect(r.temperature).toEqual({ high: 7.8, low: 1.1, mean: 4.4 });
    expect(r.precipitation.amountMm).toBe(6.1);
    expect(r.precipitation.intensity).toBe(Math.round((1 - Math.exp(-6.123456 / 20)) * 100) / 100);
    expect(r.humidity).toBe(0.88);
    expect(r.cloudCover).toBe(0.91);
    expect(r.wind).toEqual({ speedKph: 18, directionDeg: 247 });
    expect(r.hour).toBeUndefined();
    expect(r.temperature.current).toBeUndefined();
    expect(r.precipitation.active).toBeUndefined();
    expect(r.conditions).toEqual(["stormtide"]);
    expect(r.overridden).toBe(false);
    expect(r.provenance).toEqual({ worldSeed: "seed", generatorVersion: GENERATOR_VERSION, rngVersion: "wadjet-rng/1", profileHash: resolved.profileHash, calendarHash: "cal:test" });
    expect(r.descriptors).toEqual({ temperature: "cold", precipitation: "steady", wind: "breezy", sky: "overcast" });
  });

  test("report is JSON-serialisable plain data", () => {
    const r = buildReport(rec(), "greywold", cfg);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

group("report: descriptors and derived fields", () => {
  test("band tables are monotone and user-editable", () => {
    expect(bandLabel(DEFAULT_BANDS.temperature, -20)).toBe("bitter");
    expect(bandLabel(DEFAULT_BANDS.temperature, 16)).toBe("mild");
    expect(bandLabel(DEFAULT_BANDS.precipitation, 60)).toBe("flooding");
    expect(bandLabel(DEFAULT_BANDS.wind, 0)).toBe("calm");
    const custom = { ...DEFAULT_BANDS, temperature: [{ from: -Infinity, label: "nippy" }, { from: 20, label: "toasty" }] };
    expect(buildReport(rec({ tempMean: 25 }), "z", { ...cfg, bands: custom }).descriptors.temperature).toBe("toasty");
  });

  test("dry day → 'dry' regardless of amount band; type none ⇒ 0 mm", () => {
    const r = buildReport(rec({ wet: false, precipMm: 0, precipType: "none" }), "z", cfg);
    expect(r.descriptors.precipitation).toBe("dry");
    expect(r.precipitation).toEqual({ type: "none", amountMm: 0, intensity: 0 });
  });

  test("intensity is monotone in mm and saturates", () => {
    let prev = -1;
    for (const mm of [0, 0.5, 1, 4, 10, 25, 50, 100, 1000]) {
      const i = intensityFromMm(mm);
      expect(i).toBeGreaterThan(prev);
      expect(i).toBeLessThanOrEqual(1);
      prev = i;
    }
    expect(intensityFromMm(0)).toBe(0);
  });

  test("visibility: fog rule, snow worse than rain, cloud reduces", () => {
    expect(visibilityKm("none", 0, 0, 0.95, 3)).toEqual({ km: HEURISTIC.fogVisibilityKm, fog: true });
    expect(visibilityKm("rain", 0.5, 0, 0.95, 3).fog).toBe(false); // real rain is not fog
    expect(visibilityKm("none", 0, 0, 0.95, 20).fog).toBe(false); // wind clears it
    expect(visibilityKm("snow", 0.5, 0.5, 0.5, 10).km).toBeLessThan(visibilityKm("rain", 0.5, 0.5, 0.5, 10).km);
    expect(visibilityKm("none", 0, 1, 0.5, 10).km).toBeLessThan(visibilityKm("none", 0, 0, 0.5, 10).km);
    const r = buildReport(rec({ wet: false, precipMm: 0, precipType: "none", humidity: 0.97, windSpeedKph: 2 }), "z", cfg);
    expect(r.conditions).toContain("fog");
    expect(r.visibilityKm).toBe(0.4);
  });
});

group("report: diurnal interpolation", () => {
  test("temperature peaks at the warmest hour and bottoms 12 h later", () => {
    expect(diurnalTemperature(10, 8, HEURISTIC.warmestHour)).toBeCloseTo(14, 9);
    expect(diurnalTemperature(10, 8, HEURISTIC.warmestHour - 12)).toBeCloseTo(6, 9);
    const r = buildReport(rec(), "z", cfg, 15);
    expect(r.hour).toBe(15);
    expect(r.temperature.current).toBe(7.8);
  });

  test("precipitation window is deterministic, sized by intensity, and `active` follows it", () => {
    const w1 = precipitationWindow("seed", "z", 10, 0.5);
    const w2 = precipitationWindow("seed", "z", 10, 0.5);
    expect(w1).toEqual(w2);
    expect(w1.lengthHours).toBeCloseTo(HEURISTIC.precipWindowBaseH + HEURISTIC.precipWindowSpanH * 0.5, 9);
    expect(precipitationWindow("seed", "z", 10, 1).lengthHours).toBeGreaterThan(w1.lengthHours);
    let activeHours = 0;
    for (let h = 0; h < 24; h++) if (buildReport(rec(), "z", cfg, h).precipitation.active) activeHours++;
    const w = precipitationWindow("seed", "z", 10, intensityFromMm(6.123456));
    expect(Math.abs(activeHours - w.lengthHours)).toBeLessThanOrEqual(1);
    expect(buildReport(rec({ wet: false, precipMm: 0, precipType: "none" }), "z", cfg, 12).precipitation.active).toBe(false);
    expect(_internal.inWindow(1, 22, 5)).toBe(true); // wraps midnight
    expect(_internal.inWindow(5, 22, 5)).toBe(false);
  });
});

group("report: overrides", () => {
  test("deep-merge: patched fields win, unpatched stay generated, conditions append, descriptors recomputed", () => {
    const patch: OverridePatch = { precipitation: { type: "rain", amountMm: 60 }, wind: { speedKph: 95 }, conditions: ["dragonstorm"], note: "The Wyrm's arrival" };
    const overrides = new Map([[overrideKey("greywold", 10), patch]]);
    const r = buildReport(rec(), "greywold", { ...cfg, overrides });
    expect(r.overridden).toBe(true);
    expect(r.precipitation.amountMm).toBe(60);
    expect(r.precipitation.intensity).toBe(Math.round(intensityFromMm(60) * 100) / 100);
    expect(r.wind).toEqual({ speedKph: 95, directionDeg: 247 }); // direction untouched
    expect(r.temperature.mean).toBe(4.4);
    expect(r.conditions).toEqual(["stormtide", "dragonstorm"]);
    expect(r.descriptors.precipitation).toBe("flooding");
    expect(r.descriptors.wind).toBe("storm");
    // a different day is unaffected
    expect(buildReport(rec({ dayOrdinal: 11 }), "greywold", { ...cfg, overrides }).overridden).toBe(false);
  });

  test("type none zeroes the amount; explicit descriptor words win over bands", () => {
    const base = buildReport(rec(), "z", cfg);
    const p = applyPatch(base, { precipitation: { type: "none" }, descriptors: { sky: "eerily still" } });
    expect(p.precipitation).toEqual({ type: "none", amountMm: 0, intensity: 0 });
    const r = buildReport(rec(), "z", { ...cfg, overrides: new Map([[overrideKey("z", 10), { descriptors: { sky: "eerily still" } }]]) });
    expect(r.descriptors.sky).toBe("eerily still");
  });
});

group("report: describe()", () => {
  test("short and prose styles", () => {
    const r = buildReport(rec(), "z", cfg);
    expect(describe(r)).toBe("Cold, steady rain, breezy from the WSW, overcast. 1.1 to 7.8 °C [stormtide].");
    // negatives are typeset with a real minus sign, never "-0.6–0.9"
    expect(withMinus(-0.6)).toBe("−0.6");
    expect(withMinus("-12.0")).toBe("−12.0");
    expect(withMinus(1.1)).toBe("1.1");
    const p = describe(buildReport(rec(), "z", cfg, 9), "prose");
    expect(p).toContain("It is");
    expect(p).toContain("steady rain");
    expect(p).toContain("WSW");
    const calm = describe(buildReport(rec({ windSpeedKph: 0, calm: true }), "z", cfg));
    expect(calm).toContain("calm");
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(225)).toBe("SW");
  });
});

group("report: end to end with the generator", () => {
  test("a year of fjord-coast reports is consistent", () => {
    for (let d = 0; d < 365; d++) {
      const r = buildReport(generator.day(d), "greywold", cfg, 12);
      expect(r.temperature.low).toBeLessThanOrEqual(r.temperature.current!);
      expect(r.temperature.current!).toBeLessThanOrEqual(r.temperature.high);
      expect(r.precipitation.type === "none" ? r.precipitation.amountMm === 0 : r.precipitation.amountMm > 0).toBe(true);
      expect(r.visibilityKm).toBeGreaterThan(0);
      expect(r.descriptors.precipitation.length).toBeGreaterThan(0);
    }
  });
});
