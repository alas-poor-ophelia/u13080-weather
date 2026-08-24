import { describe, expect, test } from "bun:test";
import { parseCligenPar, WIND_DIRS } from "../scripts/build-presets/cligen-parse";
import { convertStation, extraterrestrialRadiation, relativeHumidity, stationaryWet } from "../scripts/build-presets/convert";
import { evalCurve, monthCentrePhase } from "../src/core/curve";
import type { Keyframe } from "../src/core/types";

const fixture = await Bun.file(new URL("./fixtures/NO000050540.par", import.meta.url)).text();

describe("cligen-parse header: country and name are separated by a run of spaces", () => {
  test("multi-word country and bracketed territory", async () => {
    const fremont = parseCligenPar(await Bun.file(new URL("./fixtures/par/USS0006K08S.par", import.meta.url)).text());
    expect(fremont.country).toBe("United States");
    expect(fremont.name).toBe("Fremont Pass");
    const janMayen = parseCligenPar(" Jan Mayen [Norway]    Jan Mayen\n" + fixture.split(/\r?\n/).slice(1).join("\n"));
    expect(janMayen.country).toBe("Jan Mayen [Norway]");
    expect(janMayen.name).toBe("Jan Mayen");
  });
});

describe("cligen-parse (Bergen Florida fixture)", () => {
  const s = parseCligenPar(fixture);

  test("header", () => {
    expect(s.country).toBe("Norway");
    expect(s.name).toBe("Bergen Florida");
    expect(s.latitude).toBe(60.38);
    expect(s.longitude).toBe(5.33);
    expect(s.years).toBe(30);
    expect(s.type).toBe(1);
    expect(s.elevationFt).toBe(39);
  });

  test("monthly rows are transcribed exactly, original units", () => {
    expect(s.meanP).toEqual([0.47, 0.44, 0.41, 0.35, 0.28, 0.34, 0.35, 0.44, 0.51, 0.54, 0.52, 0.53]);
    expect(s.pww[0]).toBe(0.82);
    expect(s.pwd[7]).toBe(0.4);
    expect(s.tmaxF[6]).toBe(61.28);
    expect(s.tminF[1]).toBe(32.11);
    expect(s.sdTmin[11]).toBe(7.36);
    expect(s.solRad[11]).toBe(14);
    expect(s.dewPtF[7]).toBe(52.01);
    expect(s.timePk[11]).toBe(1.0);
  });

  test("all 16 wind sectors + calm parsed; percentages sum to ~100 with calm", () => {
    for (const d of WIND_DIRS) expect(s.wind[d].pct).toHaveLength(12);
    expect(s.wind.N.pct[0]).toBe(4.34);
    expect(s.wind.N.mean[0]).toBe(3.5);
    expect(s.wind.NNE.mean[0]).toBe(3.26);
    expect(s.calmPct[0]).toBe(47.39);
    for (let m = 0; m < 12; m++) {
      const total = WIND_DIRS.reduce((a, d) => a + s.wind[d].pct[m]!, 0) + s.calmPct[m]!;
      expect(Math.abs(total - 100)).toBeLessThan(1.5);
    }
  });

  test("interpolated wind provenance is captured", () => {
    expect(s.windStations[0]).toEqual({ name: "CORDOVA AK", weight: 1 });
    expect(s.windStations.some((w) => w.name.startsWith("MIDDLETON AFS"))).toBe(true);
  });

  test("rejects truncated input", () => {
    expect(() => parseCligenPar(fixture.split("\n").slice(0, 30).join("\n"))).toThrow();
  });
});

describe("convert (Bergen)", () => {
  const conv = convertStation(parseCligenPar(fixture));
  const t = conv.climate.temperature;
  const p = conv.climate.precipitation;

  test("temperature in °C with a January minimum near 2.7 °C and July ~14 °C", () => {
    const jan = evalCurve(t.mean, monthCentrePhase(0));
    const jul = evalCurve(t.mean, monthCentrePhase(6));
    expect(jan).toBeCloseTo(((38.42 + 33.0) / 2 - 32) * (5 / 9), 0); // bin-matched: near, not exact
    expect(jul).toBeGreaterThan(13.5);
    expect(jul).toBeLessThan(15);
    expect(t.phase).toBeGreaterThan(0.02);
    expect(t.phase).toBeLessThan(0.15); // coldest in Jan–Feb
    expect(t.persistence).toBe(0.567);
  });

  test("precipitation: gamma by moments reproduces the wet-day mean; annual total plausible for Bergen", () => {
    for (let m = 0; m < 12; m++) {
      const at = monthCentrePhase(m);
      const mean = evalCurve(p.shape, at) * evalCurve(p.scale, at);
      expect(mean).toBeCloseTo(conv.monthlyPrecipMm[m]! / conv.derived.expectedWetDays[m]!, 6);
    }
    const annual = conv.monthlyPrecipMm.reduce((a, b) => a + b, 0);
    expect(annual).toBeGreaterThan(2000);
    expect(annual).toBeLessThan(2800); // Bergen normal ≈ 2250 mm
    expect(conv.derived.expectedWetDays.reduce((a, b) => a + b, 0)).toBeGreaterThan(200);
  });

  test("keyframes evaluate exactly to their source values at month midpoints", () => {
    const kf = p.pww as Keyframe[];
    expect(kf).toHaveLength(12);
    expect(evalCurve(kf, kf[3]!.at)).toBeCloseTo(0.74, 12);
  });

  test("humidity and cloud are fractions; Bergen is humid and cloudy", () => {
    for (let m = 0; m < 12; m++) {
      const at = monthCentrePhase(m);
      const rh = evalCurve(conv.climate.humidity.dry, at);
      const cl = evalCurve(conv.climate.cloud.dry, at);
      expect(rh).toBeGreaterThan(0.6);
      expect(rh).toBeLessThanOrEqual(1);
      expect(cl).toBeGreaterThanOrEqual(0);
      expect(cl).toBeLessThanOrEqual(1);
    }
    const meanCloud = conv.derived.cloudMean.reduce((a, b) => a + b, 0) / 12;
    expect(meanCloud).toBeGreaterThan(0.5);
  });

  test("wind converted to km/h with a finite prevailing direction", () => {
    const w = conv.climate.wind;
    const jan = evalCurve(w.speed, monthCentrePhase(0));
    expect(jan).toBeGreaterThan(5);
    expect(jan).toBeLessThan(40);
    const dir = evalCurve(w.direction, monthCentrePhase(0));
    expect(dir).toBeGreaterThanOrEqual(0);
    expect(dir).toBeLessThan(360);
    expect(evalCurve(w.calmFraction, monthCentrePhase(0))).toBeCloseTo(0.4739, 4);
  });

  test("Köppen computed for Bergen is Cfb", () => {
    expect(conv.koppenComputed).toBe("Cfb");
  });
});

describe("convert helpers", () => {
  test("stationaryWet", () => {
    expect(stationaryWet(0.82, 0.37)).toBeCloseTo(0.37 / (1 - 0.82 + 0.37), 12);
    expect(stationaryWet(0, 0)).toBe(0);
  });

  test("relativeHumidity: dew point = temperature → 100%", () => {
    expect(relativeHumidity(10, 10)).toBeCloseTo(1, 12);
    expect(relativeHumidity(0, 20)).toBeLessThan(0.3);
  });

  test("extraterrestrial radiation: FAO-56 worked example (20°S, 3 Sep → Ra ≈ 32.2)", () => {
    // Allen et al. 1998, Example 8: latitude 20°S, day 246 → Ra = 32.2 MJ m⁻² day⁻¹
    expect(extraterrestrialRadiation(-20, 246)).toBeCloseTo(32.2, 0);
    expect(extraterrestrialRadiation(80, 355)).toBe(0); // polar night
  });
});
