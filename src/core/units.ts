/**
 * Display units. Reports are always metric; this is the ONE place that turns
 * them into what the user asked for, shared by the renderer, the settings
 * tab and the public API so no two surfaces disagree.
 *
 * Numeric precision matches the report's own rounding: 0.1 °F, 0.01 in,
 * 0.1 mph, 0.1 mi.
 */
import type { WeatherReport } from "./report";

export type Units = "metric" | "imperial";

export const UNIT_LABELS: Record<Units, { temperature: string; amount: string; speed: string; distance: string }> = {
  metric: { temperature: "°C", amount: "mm", speed: "km/h", distance: "km" },
  imperial: { temperature: "°F", amount: "in", speed: "mph", distance: "mi" },
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export const cToF = (c: number): number => r1((c * 9) / 5 + 32);
export const fToC = (f: number): number => r1(((f - 32) * 5) / 9);
export const mmToIn = (mm: number): number => r2(mm / 25.4);
export const inToMm = (inch: number): number => r1(inch * 25.4);
export const kphToMph = (kph: number): number => r1(kph / 1.609344);
export const mphToKph = (mph: number): number => r1(mph * 1.609344);
export const kmToMi = (km: number): number => r1(km / 1.609344);

/**
 * A report in a chosen unit system. Same fields as `WeatherReport`, but the
 * unit-bearing keys lose their unit suffix (`amountMm` → `amount`,
 * `speedKph` → `speed`, `visibilityKm` → `visibility`) and `units` /
 * `labels` say what they are in. Metric in → metric out, same renaming.
 */
export interface ConvertedReport extends Omit<WeatherReport, "precipitation" | "wind" | "visibilityKm"> {
  units: Units;
  labels: (typeof UNIT_LABELS)[Units];
  precipitation: { type: WeatherReport["precipitation"]["type"]; amount: number; intensity: number; active?: boolean };
  wind: { speed: number; directionDeg: number };
  visibility: number;
}

export function convertReport(r: WeatherReport, units: Units): ConvertedReport {
  const { precipitation, wind, visibilityKm, temperature, ...rest } = r;
  const imp = units === "imperial";
  const t = (c: number) => (imp ? cToF(c) : c);
  return {
    ...rest,
    units,
    labels: UNIT_LABELS[units],
    temperature: { high: t(temperature.high), low: t(temperature.low), mean: t(temperature.mean), ...(temperature.current !== undefined ? { current: t(temperature.current) } : {}) },
    precipitation: { type: precipitation.type, amount: imp ? mmToIn(precipitation.amountMm) : precipitation.amountMm, intensity: precipitation.intensity, ...(precipitation.active !== undefined ? { active: precipitation.active } : {}) },
    wind: { speed: imp ? kphToMph(wind.speedKph) : wind.speedKph, directionDeg: wind.directionDeg },
    visibility: imp ? kmToMi(visibilityKm) : visibilityKm,
  };
}

/** The dotted paths a code block's `field:` may name — leaves of a ConvertedReport. */
export const REPORT_FIELDS = [
  "temperature.high",
  "temperature.low",
  "temperature.mean",
  "temperature.current",
  "precipitation.type",
  "precipitation.amount",
  "precipitation.intensity",
  "precipitation.active",
  "humidity",
  "cloudCover",
  "wind.speed",
  "wind.directionDeg",
  "visibility",
  "regime",
  "conditions",
  "descriptors.temperature",
  "descriptors.precipitation",
  "descriptors.wind",
  "descriptors.sky",
  "overridden",
  "units",
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

export function isReportField(s: string): s is ReportField {
  return (REPORT_FIELDS as readonly string[]).includes(s);
}

/** Read a field off a converted report; undefined when the report lacks it (e.g. `current` without an hour). */
export function reportField(r: ConvertedReport, field: ReportField): unknown {
  return field.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), r);
}

/** A field as text for a note: numbers bare, lists comma-joined, booleans yes/no. */
export function fieldText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number" || typeof v === "string") return String(v);
  return JSON.stringify(v);
}
