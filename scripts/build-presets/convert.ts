/**
 * CligenStation (original units) → Preset (SI, Wadjet Curves).
 *
 * Every numeric rule is either CITED (with its source) or marked HEURISTIC.
 * Heuristics are collected in the HEURISTIC block so they can be revisited
 * in one place; nothing heuristic is silently mixed into cited math.
 */
import { argminPhase, monthlyKeyframes, monthlyKeyframesBinMatched } from "../../src/core/curve";
import { classifyKoppen } from "../../src/core/koppen";
import type { ClimateParams, MatchProfile, Orographic, Preset, Regime } from "../../src/core/types";
import { WIND_DIRS, type CligenStation } from "./cligen-parse";

export interface StationSpec {
  slug: string;
  name: string;
  ghcnId: string;
  character: string;
  koppen: string;
  continentality: number;
  orographic: Orographic;
}

// ---------------------------------------------------------------------------
// CITED constants
// ---------------------------------------------------------------------------
const IN_TO_MM = 25.4;
const FT_TO_M = 0.3048;
const MS_TO_KMH = 3.6;
const LANGLEY_TO_MJ = 0.04184; // 1 cal/cm² = 0.04184 MJ/m²
const fToC = (f: number) => ((f - 32) * 5) / 9;
const fDeltaToC = (f: number) => (f * 5) / 9;

/** Default scalar AR(1) persistence = Richardson A[0][0] (A2-constants.md §4). */
const PERSISTENCE_DEFAULT = 0.567;

/** GWGEN Table 1 wet/dry-day regressions x̄_{wet|dry} = c0 + c1·x̄ (A2-constants.md §3). */
const GWGEN = {
  tmaxDry: { c0: 0.0727, c1: 1.0211 },
  tmaxWet: { c0: -0.5204, c1: 0.9459 },
  tminDry: { c0: -0.51, c1: 1.0188 },
  tminWet: { c0: 1.0411, c1: 0.9685 },
};

/** GWGEN global gamma shape when only the mean is known (A2-constants.md §2). */
const GAMMA_SHAPE_FALLBACK = 0.792;

/** FAO-56 (Allen et al. 1998) Ångström coefficients, eq. 35: Rs/Ra = a + b·n/N. */
const ANGSTROM_A = 0.25;
const ANGSTROM_B = 0.5;

// ---------------------------------------------------------------------------
// HEURISTIC constants — not from a citation; revisit with data.
// ---------------------------------------------------------------------------
const HEURISTIC = {
  /** RH on wet days relative to the monthly mean RH (bounded). */
  humidityWetBoost: 0.15,
  humidityWetCap: 0.98,
  humiditySd: 0.1,
  /** Cloud cover on wet days relative to the monthly mean cloud fraction. */
  cloudWetBoost: 0.35,
  cloudWetCap: 0.98,
  cloudSd: 0.15,
  /** Wind speed multiplier on wet days (CLIGEN has no wet/dry wind split). */
  windWetDayScale: 1.3,
  /** Months with near-zero extraterrestrial radiation (polar night) fall back to this cloud fraction. */
  polarNightCloud: 0.7,
} as const;

/** Default regime set (DESIGN-v1.md §2 example). */
export const DEFAULT_REGIMES: Regime[] = [
  { id: "normal", weight: 0.7, meanDurationDays: 12 },
  {
    id: "wet-spell",
    weight: 0.15,
    meanDurationDays: 6,
    apply: [
      { param: "precipitation.pww", op: "scale", value: 1.25 },
      { param: "precipitation.pwd", op: "scale", value: 1.6 },
    ],
  },
  {
    id: "dry-spell",
    weight: 0.15,
    meanDurationDays: 9,
    apply: [
      { param: "precipitation.pwd", op: "scale", value: 0.4 },
      { param: "temperature.diurnalRange", op: "scale", value: 1.3 },
    ],
  },
];

const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MID_MONTH_DOY = [15, 45, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349]; // FAO-56 Table 2.5 approximations

/**
 * Extraterrestrial radiation Ra (MJ m⁻² day⁻¹), FAO-56 eq. 21–25.
 * Returns 0 during polar night (ωs undefined).
 */
export function extraterrestrialRadiation(latDeg: number, dayOfYear: number): number {
  const Gsc = 0.082; // MJ m⁻² min⁻¹
  const phi = (latDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * dayOfYear) / 365 - 1.39);
  const x = -Math.tan(phi) * Math.tan(delta);
  if (x >= 1) return 0; // sun never rises
  const ws = x <= -1 ? Math.PI : Math.acos(x); // sun never sets → ωs = π
  return ((24 * 60) / Math.PI) * Gsc * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

/** Relative humidity (0..1) from dew point and air temperature, Magnus formula (Alduchov & Eskridge 1996 constants). */
export function relativeHumidity(dewC: number, tempC: number): number {
  const e = (t: number) => Math.exp((17.625 * t) / (243.04 + t));
  return Math.min(1, Math.max(0, e(dewC) / e(tempC)));
}

/** Stationary wet-day probability of the two-state chain. */
export function stationaryWet(pww: number, pwd: number): number {
  const denom = 1 - pww + pwd;
  return denom <= 0 ? 0 : pwd / denom;
}

function circularMean(degrees: number[], weights: number[]): { meanDeg: number; spreadDeg: number } {
  let x = 0;
  let y = 0;
  let w = 0;
  for (let i = 0; i < degrees.length; i++) {
    const r = (degrees[i]! * Math.PI) / 180;
    x += weights[i]! * Math.cos(r);
    y += weights[i]! * Math.sin(r);
    w += weights[i]!;
  }
  if (w === 0) return { meanDeg: 0, spreadDeg: 180 };
  const R = Math.hypot(x, y) / w;
  const meanDeg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  // circular standard deviation: sqrt(-2 ln R), in degrees
  const spreadDeg = R <= 0 ? 180 : Math.min(180, (Math.sqrt(-2 * Math.log(R)) * 180) / Math.PI);
  return { meanDeg, spreadDeg };
}

export interface Converted {
  climate: ClimateParams;
  monthlyTempC: number[];
  monthlyPrecipMm: number[];
  koppenComputed: string;
  derived: {
    expectedWetDays: number[];
    rhMean: number[];
    cloudMean: number[];
    sunshineFraction: number[];
  };
}

export function convertStation(s: CligenStation): Converted {
  const tmax = s.tmaxF.map(fToC);
  const tmin = s.tminF.map(fToC);
  const tmean = tmax.map((t, i) => (t + tmin[i]!) / 2);
  const diurnal = tmax.map((t, i) => t - tmin[i]!);
  const sdT = s.sdTmax.map((v, i) => fDeltaToC((v + s.sdTmin[i]!) / 2));

  // Wet-day temperature offsets from GWGEN Table 1 (wet - dry at the monthly mean):
  // the mean shifts by (dMax + dMin)/2 and the diurnal range by (dMax - dMin), which is negative.
  // BOUNDED: GWGEN's global regression overstates the wet-day Tmax depression in the humid
  // tropics (Darwin: -2.8 C implied vs 0.8 C total SD TMAX). Each offset is capped so the
  // wet/dry split explains at most half of the station's own variance: |d| <= SD*sqrt(0.5/(pi(1-pi))).
  // Residual SDs are then WITHIN-state: sd_within^2 = SD^2 - d^2*pi(1-pi).
  const piMonthly = s.pww.map((p, i) => stationaryWet(Math.min(1, Math.max(0, p)), Math.min(1, Math.max(0, s.pwd[i]!))));
  const cap = (d: number, sdTotal: number, pi: number) => {
    const v = pi * (1 - pi);
    if (v <= 1e-6) return d;
    const lim = sdTotal * Math.sqrt(0.5 / v);
    return Math.max(-lim, Math.min(lim, d));
  };
  const within = (sdTotal: number, d: number, pi: number) => Math.sqrt(Math.max(0, sdTotal * sdTotal - d * d * pi * (1 - pi)));
  const wetDayOffset: number[] = [];
  const wetDayRangeOffset: number[] = [];
  const sdHigh: number[] = [];
  const sdLow: number[] = [];
  for (let i = 0; i < 12; i++) {
    const t = tmean[i]!;
    const pi = piMonthly[i]!;
    const sdMaxC = fDeltaToC(s.sdTmax[i]!);
    const sdMinC = fDeltaToC(s.sdTmin[i]!);
    const dMax = cap(GWGEN.tmaxWet.c0 + GWGEN.tmaxWet.c1 * t - (GWGEN.tmaxDry.c0 + GWGEN.tmaxDry.c1 * t), sdMaxC, pi);
    const dMin = cap(GWGEN.tminWet.c0 + GWGEN.tminWet.c1 * t - (GWGEN.tminDry.c0 + GWGEN.tminDry.c1 * t), sdMinC, pi);
    wetDayOffset.push((dMax + dMin) / 2);
    wetDayRangeOffset.push(dMax - dMin);
    sdHigh.push(within(sdMaxC, dMax, pi));
    sdLow.push(within(sdMinC, dMin, pi));
  }

  // Precipitation: method of moments on wet-day amounts.
  const meanMm = s.meanP.map((v) => v * IN_TO_MM);
  const sdMm = s.sdP.map((v) => v * IN_TO_MM);
  const shape = meanMm.map((m, i) => {
    const sd = sdMm[i]!;
    if (m <= 0 || sd <= 0) return GAMMA_SHAPE_FALLBACK;
    return (m * m) / (sd * sd);
  });
  const scale = meanMm.map((m, i) => (m <= 0 ? 0.1 : m / shape[i]!));
  const pww = s.pww.map((p) => Math.min(1, Math.max(0, p)));
  const pwd = s.pwd.map((p) => Math.min(1, Math.max(0, p)));
  const expectedWetDays = pww.map((p, i) => stationaryWet(p, pwd[i]!) * DAYS_IN_MONTH[i]!);
  const monthlyPrecipMm = expectedWetDays.map((d, i) => d * meanMm[i]!);

  // Humidity from dew point.
  const rhMean = s.dewPtF.map((d, i) => relativeHumidity(fToC(d), tmean[i]!));

  // Cloud from solar radiation via FAO-56 Ångström; polar night → fallback.
  const sunshineFraction: number[] = [];
  const cloudMean: number[] = [];
  for (let m = 0; m < 12; m++) {
    const Ra = extraterrestrialRadiation(s.latitude, MID_MONTH_DOY[m]!);
    const Rs = s.solRad[m]! * LANGLEY_TO_MJ;
    if (Ra < 0.5) {
      sunshineFraction.push(NaN);
      cloudMean.push(HEURISTIC.polarNightCloud);
      continue;
    }
    const nN = Math.min(1, Math.max(0, (Rs / Ra - ANGSTROM_A) / ANGSTROM_B));
    sunshineFraction.push(nN);
    cloudMean.push(1 - nN);
  }

  // Wind: vector-mean prevailing direction per month, weighted speed.
  const dirDeg = WIND_DIRS.map((_, i) => i * 22.5);
  const windDirection: number[] = [];
  const windSpread: number[] = [];
  const windSpeed: number[] = [];
  const windSpeedSd: number[] = [];
  for (let m = 0; m < 12; m++) {
    const pct = WIND_DIRS.map((d) => s.wind[d].pct[m]!);
    const { meanDeg, spreadDeg } = circularMean(dirDeg, pct);
    windDirection.push(meanDeg);
    windSpread.push(spreadDeg);
    const totalPct = pct.reduce((a, b) => a + b, 0);
    const spd = totalPct > 0 ? WIND_DIRS.reduce((acc, d, i) => acc + pct[i]! * s.wind[d].mean[m]!, 0) / totalPct : 0;
    const sdv = totalPct > 0 ? WIND_DIRS.reduce((acc, d, i) => acc + pct[i]! * s.wind[d].sd[m]!, 0) / totalPct : 0;
    windSpeed.push(spd * MS_TO_KMH);
    windSpeedSd.push(sdv * MS_TO_KMH);
  }
  const calm = s.calmPct.map((p) => Math.min(1, Math.max(0, p / 100)));

  // Temperature curves are bin-matched so the interpolant's monthly averages equal the station's
  // monthly means (validation found a 0.5–1 °C curvature bias at continental stations otherwise).
  const meanCurve = monthlyKeyframesBinMatched(tmean);

  const climate: ClimateParams = {
    temperature: {
      mean: meanCurve,
      diurnalRange: monthlyKeyframesBinMatched(diurnal),
      phase: argminPhase(meanCurve),
      wetDayOffset: monthlyKeyframesBinMatched(wetDayOffset),
      persistence: PERSISTENCE_DEFAULT,
      sd: monthlyKeyframesBinMatched(sdT),
      sdHigh: monthlyKeyframesBinMatched(sdHigh),
      sdLow: monthlyKeyframesBinMatched(sdLow),
      wetDayRangeOffset: monthlyKeyframesBinMatched(wetDayRangeOffset),
    },
    precipitation: {
      pww: monthlyKeyframes(pww),
      pwd: monthlyKeyframes(pwd),
      shape: monthlyKeyframes(shape),
      scale: monthlyKeyframes(scale),
      freezingPoint: 0,
    },
    humidity: {
      dry: monthlyKeyframes(rhMean),
      wet: monthlyKeyframes(rhMean.map((r) => Math.min(HEURISTIC.humidityWetCap, r + HEURISTIC.humidityWetBoost))),
      sd: HEURISTIC.humiditySd,
    },
    cloud: {
      dry: monthlyKeyframes(cloudMean),
      wet: monthlyKeyframes(cloudMean.map((c) => Math.min(HEURISTIC.cloudWetCap, c + HEURISTIC.cloudWetBoost))),
      sd: HEURISTIC.cloudSd,
    },
    wind: {
      speed: monthlyKeyframes(windSpeed),
      speedSd: monthlyKeyframes(windSpeedSd),
      direction: monthlyKeyframes(windDirection),
      directionSpread: monthlyKeyframes(windSpread),
      wetDayScale: HEURISTIC.windWetDayScale,
      calmFraction: monthlyKeyframes(calm),
    },
  };

  const koppen = classifyKoppen(tmean, monthlyPrecipMm, s.latitude >= 0);

  return {
    climate,
    monthlyTempC: tmean,
    monthlyPrecipMm,
    koppenComputed: koppen.code,
    derived: { expectedWetDays, rhMean, cloudMean, sunshineFraction },
  };
}

export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, norm(o[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

export function buildPreset(spec: StationSpec, s: CligenStation, conv: Converted, dataset: { name: string; doi: string; license: string }): Preset {
  const match: MatchProfile = {
    latitude: s.latitude,
    altitude: Math.round(s.elevationFt * FT_TO_M),
    continentality: spec.continentality,
    orographic: spec.orographic,
    koppen: conv.koppenComputed,
  };
  const body = { climate: conv.climate, regimes: DEFAULT_REGIMES };
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson(body));
  const contentHash = `sha256:${hasher.digest("hex")}`;
  return {
    schemaVersion: 0,
    id: spec.slug,
    name: spec.name,
    character: spec.character,
    match,
    koppenAssigned: spec.koppen,
    climate: conv.climate,
    regimes: DEFAULT_REGIMES,
    source: {
      dataset: dataset.name,
      doi: dataset.doi,
      license: dataset.license,
      ghcnId: spec.ghcnId,
      stationName: s.name,
      country: s.country,
      latitude: s.latitude,
      longitude: s.longitude,
      elevationM: match.altitude,
      yearsOfRecord: s.years,
      windSource: { interpolated: s.windStations.length > 0, stations: s.windStations },
    },
    contentHash,
  };
}
