/**
 * Classification (integration API, DESIGN.md §D as revised by R6 and R8):
 * WeatherReport → standard meteorological scales.
 *
 * Pure, deterministic, and unopinionated: every class here is a published
 * scale, cited next to its table. Nothing in this file decides a game
 * consequence, and nothing reads `report.descriptors` (those words are
 * user-editable; classification keys on numbers only).
 */
import { compassPoint as compassPointImpl, type WeatherReport } from "./report";

export type PrecipitationClass = "none" | "very-light" | "light" | "moderate" | "heavy" | "very-heavy" | "extremely-heavy";
export type VisibilityClass = "very-poor" | "poor" | "moderate" | "good" | "very-good" | "excellent";

export interface Classification {
  /** 0..12, WMO Beaufort force from wind.speedKph */
  beaufort: number;
  /** WMO name for the force, sentence case ("Calm", "Light air", ... "Hurricane force") */
  beaufortLabel: string;
  /** 16-point compass direction the wind blows FROM ("WSW") */
  compass: string;
  /** 0..8 WMO oktas from cloudCover */
  oktas: number;
  visibility: VisibilityClass;
  precipitation: PrecipitationClass;
  /** sleet or snow */
  frozenPrecipitation: boolean;
  /** apparent temperature, °C rounded to 0.1 (wind chill, heat index, or the air temperature) */
  feelsLike: { mean: number; current?: number };
}

// ---------------------------------------------------------------------------
// Beaufort — the WMO Beaufort scale of wind force, km/h equivalents at 10 m
// (as tabulated in the WMO Manual on Marine Meteorological Services,
// WMO-No. 558, and the Guide to Instruments and Methods of Observation,
// WMO-No. 8). Each row is the LOWER bound (inclusive) of the force:
//   0 Calm            < 1        7 Near gale       50–61
//   1 Light air       1–5        8 Gale            62–74
//   2 Light breeze    6–11       9 Strong gale     75–88
//   3 Gentle breeze   12–19     10 Storm           89–102
//   4 Moderate breeze 20–28     11 Violent storm   103–117
//   5 Fresh breeze    29–38     12 Hurricane force ≥ 118
//   6 Strong breeze   39–49
// The published km/h bands are integer ranges; half-open intervals on the
// lower bounds place every real value (5.5 km/h → force 1).
// ---------------------------------------------------------------------------
export const BEAUFORT_KPH: readonly number[] = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
export const BEAUFORT_LABELS: readonly string[] = [
  "Calm",
  "Light air",
  "Light breeze",
  "Gentle breeze",
  "Moderate breeze",
  "Fresh breeze",
  "Strong breeze",
  "Near gale",
  "Gale",
  "Strong gale",
  "Storm",
  "Violent storm",
  "Hurricane force",
];

export function beaufort(speedKph: number): number {
  if (!(speedKph > 0)) return 0; // NaN, negative and zero are calm
  let force = 0;
  for (const from of BEAUFORT_KPH) if (speedKph >= from) force++;
  return force;
}

/** 16-point compass name for a direction in degrees (0 = N, clockwise). A non-finite direction reads as "N". */
export function compassPoint(directionDeg: number): string {
  return compassPointImpl(Number.isFinite(directionDeg) ? directionDeg : 0);
}

// ---------------------------------------------------------------------------
// Precipitation — India Meteorological Department, 24-hour rainfall
// categories (IMD "Terminologies and glossary", rainfall intensity for a
// station, mm/day), applied to the report's water-equivalent daily total
// regardless of type:
//   very light  0.1–2.4      heavy           64.5–115.5
//   light       2.5–15.5     very heavy      115.6–204.4
//   moderate    15.6–64.4    extremely heavy ≥ 204.5
// "none" is a day whose precipitation type is none. Lower bounds are
// inclusive (half-open intervals), so every amount lands in one class; a wet
// day with an amount below 0.1 mm, or a NaN amount, reads as very light.
// ---------------------------------------------------------------------------
export const PRECIPITATION_MM: ReadonlyArray<{ from: number; cls: PrecipitationClass }> = [
  { from: -Infinity, cls: "very-light" },
  { from: 2.5, cls: "light" },
  { from: 15.6, cls: "moderate" },
  { from: 64.5, cls: "heavy" },
  { from: 115.6, cls: "very-heavy" },
  { from: 204.5, cls: "extremely-heavy" },
];

export function precipitationClass(report: Pick<WeatherReport, "precipitation">): PrecipitationClass {
  if (report.precipitation.type === "none") return "none";
  let cls: PrecipitationClass = "very-light";
  for (const row of PRECIPITATION_MM) if (report.precipitation.amountMm >= row.from) cls = row.cls;
  return cls;
}

// ---------------------------------------------------------------------------
// Visibility — Met Office general-public visibility scale (Met Office
// "Visibility" glossary / shipping forecast guide):
//   very poor < 1 km     good       10–20 km
//   poor      1–4 km     very good  20–40 km
//   moderate  4–10 km    excellent  ≥ 40 km
// Lower bounds inclusive. The stock generator caps visibility at 40 km, so
// "excellent" occurs only at exactly 40 km or through an override. Fog is a
// condition (report.conditions), not a visibility class. NaN reads as
// "moderate", the middle of the scale (±Infinity land at its two ends).
// ---------------------------------------------------------------------------
export const VISIBILITY_KM: ReadonlyArray<{ from: number; cls: VisibilityClass }> = [
  { from: -Infinity, cls: "very-poor" },
  { from: 1, cls: "poor" },
  { from: 4, cls: "moderate" },
  { from: 10, cls: "good" },
  { from: 20, cls: "very-good" },
  { from: 40, cls: "excellent" },
];

/** The class for a NaN visibility: the middle of the scale, neither a hazard nor a clear day. */
export const VISIBILITY_NAN_CLASS: VisibilityClass = "moderate";

export function visibilityClass(km: number): VisibilityClass {
  if (Number.isNaN(km)) return VISIBILITY_NAN_CLASS;
  let cls: VisibilityClass = "very-poor";
  for (const row of VISIBILITY_KM) if (km >= row.from) cls = row.cls;
  return cls;
}

// ---------------------------------------------------------------------------
// Oktas — WMO Manual on Codes (WMO-No. 306), Code table 2700: 0 only for a
// sky completely free of cloud, 8 only for a completely overcast sky; any
// trace of cloud is at least 1 okta and any break is at most 7.
// ---------------------------------------------------------------------------
export function oktas(cloudCover: number): number {
  if (!(cloudCover > 0)) return 0;
  if (cloudCover >= 1) return 8;
  return Math.min(7, Math.max(1, Math.round(cloudCover * 8)));
}

// ---------------------------------------------------------------------------
// Apparent temperature
// ---------------------------------------------------------------------------
const cToF = (c: number) => (c * 9) / 5 + 32;
const fToC = (f: number) => ((f - 32) * 5) / 9;
const r1 = (x: number) => {
  const v = Math.round(x * 10) / 10;
  return v === 0 ? 0 : v; // no −0
};

/**
 * Wind chill, °C. The joint NWS / Environment Canada index (JAG/TI 2001),
 * metric form: 13.12 + 0.6215 T − 11.37 V^0.16 + 0.3965 T V^0.16, with V the
 * 10 m wind in km/h. Defined for T ≤ 10 °C and V > 4.8 km/h; outside that
 * range this returns T unchanged.
 */
export function windChill(tempC: number, windKph: number): number {
  if (!(tempC <= 10) || !(windKph > 4.8)) return tempC;
  const v16 = Math.pow(windKph, 0.16);
  return 13.12 + 0.6215 * tempC - 11.37 * v16 + 0.3965 * tempC * v16;
}

/**
 * Heat index, °F, the full NWS algorithm (NWS Weather Prediction Center,
 * "The Heat Index Equation", Rothfusz 1990 SR 90-23):
 *   1. Steadman's simple form HI = 0.5 (T + 61 + (T − 68) × 1.2 + RH × 0.094),
 *      averaged with T.
 *   2. If that average is ≥ 80 °F, the Rothfusz regression instead, with
 *      the low-humidity adjustment (RH < 13 % and 80 ≤ T ≤ 112 °F: subtract
 *      ((13 − RH) / 4) × √((17 − |T − 95|) / 17)) and the high-humidity
 *      adjustment (RH > 85 % and 80 ≤ T ≤ 87 °F: add ((RH − 85) / 10) × ((87 − T) / 5)).
 * T in °F, RH in percent (0..100).
 */
export function heatIndexF(tempF: number, rhPct: number): number {
  const T = tempF;
  const RH = rhPct;
  const simple = 0.5 * (T + 61 + (T - 68) * 1.2 + RH * 0.094);
  if ((simple + T) / 2 < 80) return (simple + T) / 2;
  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * RH -
    0.22475541 * T * RH -
    0.00683783 * T * T -
    0.05481717 * RH * RH +
    0.00122874 * T * T * RH +
    0.00085282 * T * RH * RH -
    0.00000199 * T * T * RH * RH;
  if (RH < 13 && T >= 80 && T <= 112) hi -= ((13 - RH) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  else if (RH > 85 && T >= 80 && T <= 87) hi += ((RH - 85) / 10) * ((87 - T) / 5);
  return hi;
}

/** Heat index applies from 80 °F (≈ 26.7 °C) up, where the NWS table starts. */
const HEAT_INDEX_FROM_F = 80;

/**
 * Apparent temperature, °C (unrounded): wind chill when T ≤ 10 °C and wind
 * > 4.8 km/h; heat index when T ≥ 80 °F; otherwise the air temperature.
 * `humidity` is a fraction 0..1, as in WeatherReport.
 *
 * The heat index switches on in one step at 80 °F, and at low humidity the
 * NWS algorithm reads BELOW the air temperature, so feels-like can drop as
 * the air crosses 80 °F. That is the published algorithm, kept as is.
 *
 * Non-finite inputs never throw: a non-finite temperature is returned as is;
 * a non-finite wind gives no wind chill and a non-finite humidity no heat
 * index (the air temperature instead).
 */
export function apparentTemperature(tempC: number, humidity: number, windKph: number): number {
  if (!Number.isFinite(tempC)) return tempC;
  if (tempC <= 10 && Number.isFinite(windKph) && windKph > 4.8) return windChill(tempC, windKph);
  const tF = cToF(tempC);
  if (tF >= HEAT_INDEX_FROM_F && Number.isFinite(humidity)) return fToC(heatIndexF(tF, Math.min(100, Math.max(0, humidity * 100))));
  return tempC;
}

/** Pure: a WeatherReport's standard classifications. Never reads descriptor strings. */
export function classify(report: WeatherReport): Classification {
  const force = beaufort(report.wind.speedKph);
  const feel = (t: number) => r1(apparentTemperature(t, report.humidity, report.wind.speedKph));
  const current = report.temperature.current;
  return {
    beaufort: force,
    beaufortLabel: BEAUFORT_LABELS[force]!,
    compass: compassPoint(report.wind.directionDeg),
    oktas: oktas(report.cloudCover),
    visibility: visibilityClass(report.visibilityKm),
    precipitation: precipitationClass(report),
    frozenPrecipitation: report.precipitation.type === "sleet" || report.precipitation.type === "snow",
    feelsLike: { mean: feel(report.temperature.mean), ...(current !== undefined ? { current: feel(current) } : {}) },
  };
}
