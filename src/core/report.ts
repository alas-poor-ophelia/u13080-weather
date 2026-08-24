/**
 * Report layer (DESIGN-v1.md §7–§8): DailyRecord → WeatherReport.
 *
 * Responsibilities, in order:
 *   1. diurnal interpolation (if an hour is given)           — deterministic
 *   2. derived fields: intensity, visibility, fog            — HEURISTIC, stated
 *   3. overrides (deep-merge patch, always win)              — the only persisted state
 *   4. rounding (0.1 °C, 0.1 mm, 0.01 fractions, 1 km/h, 1°) — hides cross-engine ulp noise
 *   5. descriptors from user-editable band tables            — words for humans
 *   6. provenance
 *
 * Numbers are for machines, words for humans; consumers must key on numbers
 * (`precipitation.intensity`) and must never exhaustively switch on the
 * descriptor strings, which are user-configurable.
 */
import type { DailyRecord, PrecipType } from "./generator";
import { DrawStream, drawKey, uniform } from "./rng";
import { GENERATOR_VERSION, RNG_VERSION, SCHEMA_VERSION } from "./version";

export interface Provenance {
  worldSeed: string;
  generatorVersion: string;
  rngVersion: string;
  profileHash: string;
  calendarHash: string;
}

export interface WeatherReport {
  schemaVersion: typeof SCHEMA_VERSION;
  zoneId: string;
  dayOrdinal: number;
  hour?: number;

  temperature: { high: number; low: number; mean: number; current?: number };
  precipitation: { type: PrecipType; amountMm: number; intensity: number; active?: boolean };
  humidity: number;
  cloudCover: number;
  wind: { speedKph: number; directionDeg: number };
  visibilityKm: number;

  regime: string;
  conditions: string[];
  descriptors: { temperature: string; precipitation: string; wind: string; sky: string };

  overridden: boolean;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Descriptor bands — user-editable. A band applies when value >= `from`.
// ---------------------------------------------------------------------------
export interface Band {
  from: number;
  label: string;
}
export interface DescriptorBands {
  /** °C on the daily mean */
  temperature: Band[];
  /** mm daily total; the first band (from 0) is the dry label */
  precipitation: Band[];
  /** km/h */
  wind: Band[];
  /** cloud cover fraction */
  sky: Band[];
}

export const DEFAULT_BANDS: DescriptorBands = {
  temperature: [
    { from: -Infinity, label: "bitter" },
    { from: -10, label: "freezing" },
    { from: 0, label: "cold" },
    { from: 8, label: "cool" },
    { from: 15, label: "mild" },
    { from: 22, label: "warm" },
    { from: 29, label: "hot" },
    { from: 35, label: "sweltering" },
  ],
  precipitation: [
    { from: 0, label: "dry" },
    { from: 0.1, label: "drizzle" },
    { from: 1, label: "light" },
    { from: 4, label: "steady" },
    { from: 10, label: "heavy" },
    { from: 25, label: "torrential" },
    { from: 50, label: "flooding" },
  ],
  wind: [
    { from: 0, label: "calm" },
    { from: 2, label: "light air" },
    { from: 12, label: "breezy" },
    { from: 29, label: "windy" },
    { from: 50, label: "gale" },
    { from: 89, label: "storm" },
    { from: 118, label: "hurricane" },
  ],
  sky: [
    { from: 0, label: "clear" },
    { from: 0.2, label: "scattered" },
    { from: 0.5, label: "cloudy" },
    { from: 0.8, label: "overcast" },
  ],
};

export function bandLabel(bands: Band[], value: number): string {
  let label = bands[0]?.label ?? "";
  for (const b of bands) if (value >= b.from) label = b.label;
  return label;
}

// ---------------------------------------------------------------------------
// HEURISTIC constants — stated, revisit with feedback.
// ---------------------------------------------------------------------------
export const HEURISTIC = {
  /** intensity = 1 − exp(−mm / INTENSITY_SCALE_MM): 10 mm → 0.39, 25 → 0.71, 50 → 0.92 */
  intensityScaleMm: 20,
  /** visibility on a clear dry day, km */
  clearVisibilityKm: 40,
  /** cloud reduces visibility by up to this fraction */
  cloudVisibilityLoss: 0.4,
  /** divisor growth per unit intensity, rain vs snow */
  rainVisibilityFactor: 4,
  snowVisibilityFactor: 10,
  /** fog when humidity ≥ this, wind < this, and no more than drizzle */
  fogHumidity: 0.92,
  fogWindKph: 8,
  fogVisibilityKm: 0.4,
  /** diurnal: warmest at 15:00, coldest at 03:00 (cosine) */
  warmestHour: 15,
  /** precipitation window length in hours: base + span × intensity */
  precipWindowBaseH: 2,
  precipWindowSpanH: 12,
} as const;

export function intensityFromMm(mm: number): number {
  return mm <= 0 ? 0 : 1 - Math.exp(-mm / HEURISTIC.intensityScaleMm);
}

export function diurnalTemperature(mean: number, range: number, hour: number): number {
  return mean + (range / 2) * Math.cos((2 * Math.PI * (hour - HEURISTIC.warmestHour)) / 24);
}

/** Deterministic precipitation window for a wet day: [start, start + length) hours, wrapping midnight. */
export function precipitationWindow(seed: string, zoneId: string, day: number, intensity: number): { startHour: number; lengthHours: number } {
  const startHour = uniform(drawKey(seed, zoneId, day, "precip-window")) * 24;
  const lengthHours = Math.min(24, HEURISTIC.precipWindowBaseH + HEURISTIC.precipWindowSpanH * intensity);
  return { startHour, lengthHours };
}

function inWindow(hour: number, start: number, length: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  const end = start + length;
  if (end <= 24) return h >= start && h < end;
  return h >= start || h < end - 24;
}

export function visibilityKm(precipType: PrecipType, intensity: number, cloud: number, humidity: number, windKph: number): { km: number; fog: boolean } {
  const fog = humidity >= HEURISTIC.fogHumidity && windKph < HEURISTIC.fogWindKph && (precipType === "none" || precipType === "drizzle");
  if (fog) return { km: HEURISTIC.fogVisibilityKm, fog: true };
  let km = HEURISTIC.clearVisibilityKm * (1 - HEURISTIC.cloudVisibilityLoss * cloud);
  if (precipType === "snow" || precipType === "sleet") km /= 1 + HEURISTIC.snowVisibilityFactor * intensity;
  else if (precipType !== "none") km /= 1 + HEURISTIC.rainVisibilityFactor * intensity;
  return { km, fog: false };
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------
export interface OverridePatch {
  temperature?: Partial<WeatherReport["temperature"]>;
  precipitation?: Partial<WeatherReport["precipitation"]>;
  humidity?: number;
  cloudCover?: number;
  wind?: Partial<WeatherReport["wind"]>;
  visibilityKm?: number;
  /** appended to generated conditions */
  conditions?: string[];
  /** explicit descriptor words win over the band tables */
  descriptors?: Partial<WeatherReport["descriptors"]>;
  note?: string;
}

export interface Override {
  zoneId: string;
  dayOrdinal: number;
  patch: OverridePatch;
}

export function overrideKey(zoneId: string, dayOrdinal: number): string {
  return `${zoneId}${String.fromCharCode(0x1f)}${dayOrdinal}`; // U+001F unit separator
}

/** Integer-scaled rounding: avoids 7.800000000000001 from Math.round(x / 0.1) * 0.1. */
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
/** A wet day never reports 0 mm: anything under 0.05 mm is shown as a 0.1 mm trace. */
const TRACE_MM = 0.1;

export interface ReportBuilderConfig {
  seed: string;
  provenance: Omit<Provenance, "worldSeed" | "generatorVersion" | "rngVersion">;
  bands?: DescriptorBands;
  overrides?: ReadonlyMap<string, OverridePatch>;
}

/** Pure: DailyRecord (+ optional hour) → WeatherReport. */
export function buildReport(rec: DailyRecord, zoneId: string, cfg: ReportBuilderConfig, hour?: number): WeatherReport {
  const bands = cfg.bands ?? DEFAULT_BANDS;
  const range = rec.tempHigh - rec.tempLow;
  const mean = rec.tempMean;

  // 1. diurnal
  const current = hour === undefined ? undefined : diurnalTemperature(mean, range, hour);
  const intensity = intensityFromMm(rec.precipMm);
  let active: boolean | undefined;
  if (hour !== undefined) {
    if (!rec.wet) active = false;
    else {
      const w = precipitationWindow(cfg.seed, zoneId, rec.dayOrdinal, intensity);
      active = inWindow(hour, w.startHour, w.lengthHours);
    }
  }

  // 2. derived
  const vis = visibilityKm(rec.precipType, intensity, rec.cloudCover, rec.humidity, rec.windSpeedKph);
  const conditions = [...rec.tags];
  if (vis.fog) conditions.push("fog");

  let report: WeatherReport = {
    schemaVersion: SCHEMA_VERSION,
    zoneId,
    dayOrdinal: rec.dayOrdinal,
    ...(hour !== undefined ? { hour } : {}),
    temperature: { high: rec.tempHigh, low: rec.tempLow, mean, ...(current !== undefined ? { current } : {}) },
    precipitation: { type: rec.precipType, amountMm: rec.precipMm, intensity, ...(active !== undefined ? { active } : {}) },
    humidity: rec.humidity,
    cloudCover: rec.cloudCover,
    wind: { speedKph: rec.windSpeedKph, directionDeg: rec.windDirectionDeg },
    visibilityKm: vis.km,
    regime: rec.regime,
    conditions,
    descriptors: { temperature: "", precipitation: "", wind: "", sky: "" },
    overridden: false,
    provenance: { worldSeed: cfg.seed, generatorVersion: GENERATOR_VERSION, rngVersion: RNG_VERSION, ...cfg.provenance },
  };

  // 3. overrides
  const patch = cfg.overrides?.get(overrideKey(zoneId, rec.dayOrdinal));
  let explicitDescriptors: Partial<WeatherReport["descriptors"]> | undefined;
  if (patch) {
    report = applyPatch(report, patch);
    explicitDescriptors = patch.descriptors;
  }

  // 4. rounding
  report.temperature = {
    high: r1(report.temperature.high),
    low: r1(report.temperature.low),
    mean: r1(report.temperature.mean),
    ...(report.temperature.current !== undefined ? { current: r1(report.temperature.current) } : {}),
  };
  const roundedMm = r1(report.precipitation.amountMm);
  report.precipitation = {
    ...report.precipitation,
    amountMm: report.precipitation.type === "none" ? 0 : Math.max(TRACE_MM, roundedMm),
    intensity: r2(report.precipitation.intensity),
  };
  report.humidity = r2(report.humidity);
  report.cloudCover = r2(report.cloudCover);
  report.wind = { speedKph: Math.round(report.wind.speedKph), directionDeg: Math.round(report.wind.directionDeg) % 360 };
  report.visibilityKm = r1(report.visibilityKm);

  // 5. descriptors (after patch + rounding so words match numbers)
  report.descriptors = {
    temperature: explicitDescriptors?.temperature ?? bandLabel(bands.temperature, report.temperature.mean),
    precipitation: explicitDescriptors?.precipitation ?? (report.precipitation.type === "none" ? bands.precipitation[0]?.label ?? "dry" : bandLabel(bands.precipitation, report.precipitation.amountMm)),
    wind: explicitDescriptors?.wind ?? bandLabel(bands.wind, report.wind.speedKph),
    sky: explicitDescriptors?.sky ?? bandLabel(bands.sky, report.cloudCover),
  };
  return report;
}

/** Deep-merge a patch over a report. Unpatched fields stay generated. */
export function applyPatch(report: WeatherReport, patch: OverridePatch): WeatherReport {
  const out: WeatherReport = {
    ...report,
    temperature: { ...report.temperature, ...strip(patch.temperature) },
    precipitation: { ...report.precipitation, ...strip(patch.precipitation) },
    wind: { ...report.wind, ...strip(patch.wind) },
    conditions: [...report.conditions, ...(patch.conditions ?? [])],
    overridden: true,
  };
  if (patch.humidity !== undefined) out.humidity = patch.humidity;
  if (patch.cloudCover !== undefined) out.cloudCover = patch.cloudCover;
  if (patch.visibilityKm !== undefined) out.visibilityKm = patch.visibilityKm;
  // keep precipitation consistent: patched amount with no type → infer; patched type none → zero amount
  if (patch.precipitation) {
    if (patch.precipitation.type === "none") out.precipitation = { ...out.precipitation, type: "none", amountMm: 0, intensity: 0 };
    else if (patch.precipitation.amountMm !== undefined && patch.precipitation.intensity === undefined) out.precipitation.intensity = intensityFromMm(patch.precipitation.amountMm);
    if (out.precipitation.type === "none" && out.precipitation.amountMm > 0) out.precipitation.type = "rain";
  }
  return out;
}

function strip<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Human text
// ---------------------------------------------------------------------------
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compassPoint(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** Typeset a number/formatted string with a real minus sign (U+2212) instead of a hyphen-minus. */
export function withMinus(x: number | string): string {
  return String(x).replace(/^-/, "−");
}

export function describe(r: WeatherReport, style: "short" | "prose" = "short"): string {
  const d = r.descriptors;
  const precip = r.precipitation.type === "none" ? d.precipitation : `${d.precipitation} ${r.precipitation.type}`;
  const wind = r.wind.speedKph === 0 ? "calm" : `${d.wind} from the ${compassPoint(r.wind.directionDeg)}`;
  const extras = r.conditions.filter((c) => c !== "fog").join(", ");
  if (style === "short") {
    const parts = [cap(d.temperature), precip, wind, d.sky];
    if (r.conditions.includes("fog")) parts.push("fog");
    return `${parts.join(", ")}. ${withMinus(r.temperature.low)} to ${withMinus(r.temperature.high)} °C${extras ? ` [${extras}]` : ""}.`;
  }
  const sky = r.conditions.includes("fog") ? "Fog hangs in the air" : `The sky is ${d.sky}`;
  const p =
    r.precipitation.type === "none"
      ? "and it stays dry"
      : `with ${d.precipitation} ${r.precipitation.type}${r.precipitation.active === true ? " falling now" : r.precipitation.active === false ? " expected at some point" : ""} (${r.precipitation.amountMm} mm)`;
  const w = r.wind.speedKph === 0 ? "The air is still." : `A ${d.wind} wind blows from the ${compassPoint(r.wind.directionDeg)} at ${r.wind.speedKph} km/h.`;
  const t = r.temperature.current !== undefined ? `It is ${withMinus(r.temperature.current)} °C now; ` : "";
  return `${t}A ${d.temperature} day, ${withMinus(r.temperature.low)} to ${withMinus(r.temperature.high)} °C. ${sky}, ${p}. ${w}${extras ? ` Conditions: ${extras}.` : ""}`;
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Convenience for the API: a builder bound to a seed/provenance/bands/overrides. */
export class ReportBuilder {
  constructor(readonly cfg: ReportBuilderConfig) {}
  build(rec: DailyRecord, zoneId: string, hour?: number): WeatherReport {
    return buildReport(rec, zoneId, this.cfg, hour);
  }
}

/** Exposed for tests: window membership. */
export const _internal = { inWindow, DrawStream };
