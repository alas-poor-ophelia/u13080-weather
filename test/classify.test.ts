import { describe as group, expect, test } from "bun:test";
import {
  BEAUFORT_LABELS,
  apparentTemperature,
  beaufort,
  classify,
  compassPoint,
  heatIndexF,
  oktas,
  precipitationClass,
  visibilityClass,
  windChill,
  type PrecipitationClass,
  type VisibilityClass,
} from "../src/core/classify";
import { buildReport, type WeatherReport } from "../src/core/report";
import type { DailyRecord } from "../src/core/generator";

type ReportOver = Omit<Partial<WeatherReport>, "temperature" | "precipitation" | "wind"> & {
  temperature?: Partial<WeatherReport["temperature"]>;
  precipitation?: Partial<WeatherReport["precipitation"]>;
  wind?: Partial<WeatherReport["wind"]>;
};

/** A hand-made report: classification must work on any well-formed report, not only generated ones. */
function mk(over: ReportOver = {}): WeatherReport {
  const { temperature, precipitation, wind, ...rest } = over;
  return {
    schemaVersion: 0,
    zoneId: "z",
    dayOrdinal: 1,
    temperature: { high: 18, low: 8, mean: 13, ...temperature },
    precipitation: { type: "none", amountMm: 0, intensity: 0, ...precipitation },
    humidity: 0.6,
    cloudCover: 0.3,
    wind: { speedKph: 10, directionDeg: 270, ...wind },
    visibilityKm: 30,
    regime: "normal",
    conditions: [],
    descriptors: { temperature: "mild", precipitation: "dry", wind: "breezy", sky: "scattered" },
    overridden: false,
    provenance: { worldSeed: "s", generatorVersion: "g", rngVersion: "r", profileHash: "p", calendarHash: "c" },
    ...rest,
  };
}

const cToF = (c: number) => (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const MPH = 1.609344;

group("classify: Beaufort (WMO, km/h)", () => {
  // [speed, force] at every band's lower bound and just below it.
  const table: Array<[number, number]> = [
    [0, 0], [0.99, 0],
    [1, 1], [5.99, 1],
    [6, 2], [11.99, 2],
    [12, 3], [19.99, 3],
    [20, 4], [28.99, 4],
    [29, 5], [38.99, 5],
    [39, 6], [49.99, 6],
    [50, 7], [61.99, 7],
    [62, 8], [74.99, 8],
    [75, 9], [88.99, 9],
    [89, 10], [102.99, 10],
    [103, 11], [117.99, 11],
    [118, 12], [300, 12],
  ];
  test.each(table)("%p km/h is force %p", (kph, force) => {
    expect(beaufort(kph)).toBe(force);
  });
  test("nonsense speeds are calm", () => {
    expect(beaufort(-5)).toBe(0);
    expect(beaufort(Number.NaN)).toBe(0);
  });
  test("labels are the WMO names in sentence case", () => {
    expect(BEAUFORT_LABELS).toEqual([
      "Calm", "Light air", "Light breeze", "Gentle breeze", "Moderate breeze", "Fresh breeze", "Strong breeze",
      "Near gale", "Gale", "Strong gale", "Storm", "Violent storm", "Hurricane force",
    ]);
    for (const l of BEAUFORT_LABELS) expect(l).toBe(l[0]!.toUpperCase() + l.slice(1).toLowerCase());
    expect(classify(mk({ wind: { speedKph: 64 } })).beaufortLabel).toBe("Gale");
  });
});

group("classify: compass", () => {
  test.each([
    [0, "N"], [11.24, "N"], [11.25, "NNE"], [90, "E"], [247.5, "WSW"], [348.74, "NNW"], [348.75, "N"], [360, "N"], [-90, "W"],
  ] as Array<[number, string]>)("%p° is %p", (deg, point) => {
    expect(compassPoint(deg)).toBe(point);
  });
});

group("classify: oktas (WMO code table 2700)", () => {
  test.each([
    [0, 0], [0.001, 1], [0.0625, 1], [0.1, 1], [0.1875, 2], [0.5, 4], [0.8125, 7], [0.9, 7], [0.99, 7], [1, 8],
  ] as Array<[number, number]>)("cloud %p is %p oktas", (cloud, n) => {
    expect(oktas(cloud)).toBe(n);
  });
});

group("classify: visibility (Met Office public scale)", () => {
  const table: Array<[number, VisibilityClass]> = [
    [0, "very-poor"], [0.4, "very-poor"], [0.99, "very-poor"],
    [1, "poor"], [3.99, "poor"],
    [4, "moderate"], [9.99, "moderate"],
    [10, "good"], [19.99, "good"],
    [20, "very-good"], [39.99, "very-good"],
    [40, "excellent"], [80, "excellent"],
  ];
  test.each(table)("%p km is %p", (km, cls) => {
    expect(visibilityClass(km)).toBe(cls);
  });
  test("fog is a condition, not a visibility class", () => {
    const c = classify(mk({ conditions: ["fog"], visibilityKm: 0.4 }));
    expect(c.visibility).toBe("very-poor");
  });
});

group("classify: precipitation (IMD 24-hour categories)", () => {
  const table: Array<[number, PrecipitationClass]> = [
    [0.1, "very-light"], [2.4, "very-light"],
    [2.5, "light"], [15.5, "light"],
    [15.6, "moderate"], [64.4, "moderate"],
    [64.5, "heavy"], [115.5, "heavy"],
    [115.6, "very-heavy"], [204.4, "very-heavy"],
    [204.5, "extremely-heavy"], [500, "extremely-heavy"],
  ];
  test.each(table)("%p mm is %p", (mm, cls) => {
    expect(precipitationClass(mk({ precipitation: { type: "rain", amountMm: mm } }))).toBe(cls);
  });
  test("between the published one-decimal bounds every value still lands somewhere", () => {
    expect(precipitationClass(mk({ precipitation: { type: "rain", amountMm: 2.45 } }))).toBe("very-light");
    expect(precipitationClass(mk({ precipitation: { type: "rain", amountMm: 15.55 } }))).toBe("light");
    expect(precipitationClass(mk({ precipitation: { type: "rain", amountMm: 204.45 } }))).toBe("very-heavy");
    expect(precipitationClass(mk({ precipitation: { type: "rain", amountMm: 0 } }))).toBe("very-light");
  });
  test("type none is none; snow is classed on its water equivalent", () => {
    expect(classify(mk()).precipitation).toBe("none");
    expect(classify(mk({ precipitation: { type: "snow", amountMm: 20 } })).precipitation).toBe("moderate");
  });
  test("frozen precipitation is sleet or snow", () => {
    const frozen = (type: WeatherReport["precipitation"]["type"]) => classify(mk({ precipitation: { type, amountMm: 3 } })).frozenPrecipitation;
    expect(frozen("snow")).toBe(true);
    expect(frozen("sleet")).toBe(true);
    expect(frozen("rain")).toBe(false);
    expect(frozen("drizzle")).toBe(false);
    expect(classify(mk()).frozenPrecipitation).toBe(false);
  });
});

group("classify: wind chill (NWS / Environment Canada)", () => {
  // NWS Wind Chill Chart (weather.gov/safety/cold-wind-chill-chart), °F at mph, integer values.
  const chart: Array<[number, number, number]> = [
    [40, 5, 36],
    [30, 10, 21],
    [5, 25, -17],
    [0, 15, -19],
    [0, 30, -26],
    [-10, 20, -35],
    [-20, 30, -53],
  ];
  test.each(chart)("%p °F at %p mph feels like %p °F", (tF, mph, expected) => {
    expect(Math.round(cToF(windChill(fToC(tF), mph * MPH)))).toBe(expected);
  });
  test("applies only at T ≤ 10 °C and wind > 4.8 km/h", () => {
    expect(windChill(10.1, 30)).toBe(10.1);
    expect(windChill(-5, 4.8)).toBe(-5);
    expect(windChill(10, 30)).toBeLessThan(10);
  });
});

group("classify: heat index (NWS algorithm)", () => {
  // NWS Heat Index Chart (weather.gov/safety/heat-index), °F at relative humidity %, integer values.
  const chart: Array<[number, number, number]> = [
    [80, 40, 80],
    [84, 70, 90],
    [86, 90, 105],
    [90, 50, 95],
    [90, 90, 122],
    [96, 65, 121],
    [100, 40, 109],
    [104, 55, 137],
    [110, 40, 136],
  ];
  test.each(chart)("%p °F at %p%% feels like %p °F", (tF, rh, expected) => {
    expect(Math.round(heatIndexF(tF, rh))).toBe(expected);
  });

  // The Rothfusz regression, verbatim from the NWS WPC page, to check the adjustments in isolation.
  const rothfusz = (T: number, RH: number) =>
    -42.379 + 2.04901523 * T + 10.14333127 * RH - 0.22475541 * T * RH - 0.00683783 * T * T - 0.05481717 * RH * RH +
    0.00122874 * T * T * RH + 0.00085282 * T * RH * RH - 0.00000199 * T * T * RH * RH;

  test("low-humidity adjustment: RH < 13 % and 80–112 °F subtracts ((13 − RH)/4)·√((17 − |T − 95|)/17)", () => {
    expect(heatIndexF(95, 5)).toBeCloseTo(rothfusz(95, 5) - 2, 10);
    expect(heatIndexF(100, 10)).toBeCloseTo(rothfusz(100, 10) - 0.75 * Math.sqrt(12 / 17), 10);
  });
  test("high-humidity adjustment: RH > 85 % and 80–87 °F adds ((RH − 85)/10)·((87 − T)/5)", () => {
    expect(heatIndexF(82, 95)).toBeCloseTo(rothfusz(82, 95) + 1, 10);
    expect(heatIndexF(88, 95)).toBeCloseTo(rothfusz(88, 95), 10); // above 87 °F: no adjustment
  });
  test("Steadman's simple form is used while its average with T stays below 80 °F", () => {
    const T = 80;
    const RH = 10;
    const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
    expect((simple + T) / 2).toBeLessThan(80);
    expect(heatIndexF(T, RH)).toBeCloseTo((simple + T) / 2, 10);
  });
});

group("classify: feels-like", () => {
  test("mild days feel like the air temperature", () => {
    expect(apparentTemperature(18, 0.6, 30)).toBe(18);
    expect(classify(mk({ temperature: { mean: 13 } })).feelsLike).toEqual({ mean: 13 });
  });
  test("cold windy days use wind chill on the daily wind, rounded to 0.1 °C", () => {
    const c = classify(mk({ temperature: { mean: -10, current: -12 }, wind: { speedKph: 30 } }));
    // Environment Canada wind chill index table: −10 °C at 30 km/h → −20 (to the integer)
    expect(Math.round(windChill(-10, 30))).toBe(-20);
    // Environment Canada table: −20 °C at 20 km/h → −30; 0 °C at 10 km/h → −3
    expect(Math.round(windChill(-20, 20))).toBe(-30);
    expect(Math.round(windChill(0, 10))).toBe(-3);
    expect(c.feelsLike.mean).toBe(Math.round(windChill(-10, 30) * 10) / 10);
    expect(c.feelsLike.current).toBe(Math.round(windChill(-12, 30) * 10) / 10);
  });
  test("hot humid days use the heat index on the daily humidity", () => {
    const c = classify(mk({ temperature: { mean: fToC(90) }, humidity: 0.5, wind: { speedKph: 30 } }));
    expect(Math.round(cToF(c.feelsLike.mean))).toBe(95);
  });
  test("current is present only when the report has an hour reading", () => {
    expect("current" in classify(mk()).feelsLike).toBe(false);
    expect(classify(mk({ temperature: { current: 5 }, wind: { speedKph: 3 } })).feelsLike.current).toBe(5);
  });
  test("no negative zero", () => {
    expect(Object.is(classify(mk({ temperature: { mean: -0.01 }, wind: { speedKph: 0 } })).feelsLike.mean, -0)).toBe(false);
  });
});

group("classify: the whole record", () => {
  test("a hand-made stormy report", () => {
    const c = classify(
      mk({
        precipitation: { type: "rain", amountMm: 70, intensity: 0.97 },
        wind: { speedKph: 80, directionDeg: 247 },
        cloudCover: 1,
        visibilityKm: 3.2,
        temperature: { mean: 8 },
        humidity: 0.95,
      }),
    );
    expect(c).toEqual({
      beaufort: 9,
      beaufortLabel: "Strong gale",
      compass: "WSW",
      oktas: 8,
      visibility: "poor",
      precipitation: "heavy",
      frozenPrecipitation: false,
      feelsLike: { mean: Math.round(windChill(8, 80) * 10) / 10 },
    });
  });
  test("classification never reads descriptor strings", () => {
    const base = mk({ precipitation: { type: "drizzle", amountMm: 0.4, intensity: 0.02 } });
    const renamed = { ...base, descriptors: { temperature: "x", precipitation: "torrential", wind: "hurricane", sky: "clear" } };
    expect(classify(renamed)).toEqual(classify(base));
  });
  test("works on built reports", () => {
    const rec: DailyRecord = {
      dayOrdinal: 3, yearPhase: 0, regime: "normal", wet: true, precipMm: 6, precipType: "rain",
      tempMean: 4, tempHigh: 7, tempLow: 1, tempResidual: 0, humidity: 0.8, cloudCover: 0.9,
      windSpeedKph: 17.6, windDirectionDeg: 247.4, calm: false, tags: [],
    };
    const r = buildReport(rec, "z", { seed: "s", provenance: { profileHash: "p", calendarHash: "c" } }, 9);
    const c = classify(r);
    expect(c.beaufort).toBe(3);
    expect(c.compass).toBe("WSW");
    expect(c.precipitation).toBe("light");
    expect(c.feelsLike.current).toBeDefined();
  });
});
