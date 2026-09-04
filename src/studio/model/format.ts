/**
 * Studio number/unit formatting (PLAN §4 `format.ts`; SPEC §8).
 *
 * Storage is always metric — every draft, modifier and knob spec in
 * `src/studio/model` holds metric numbers. This module is the *display*
 * edge: it converts a metric value to whatever `settings.units` asks for,
 * formats it with tabular digits and a real minus sign, and converts a
 * user-typed display value back to metric.
 *
 * The conversion table itself lives in `src/core/units.ts` (`cToF`, `fToC`,
 * `mmToIn`, `inToMm`, `kphToMph`, `mphToKph`) — this file adds no new
 * arithmetic for temperature/amount/speed, it only routes to that table and
 * covers the quantities units.ts doesn't know about (direction, fractions,
 * percents, factors, calendar counts).
 *
 * **H-1384 — untouched values never round-trip.** `toDisplay` → `fromDisplay`
 * is *not* guaranteed to be the identity for every input, because the
 * imperial units round (0.1 °F, 0.01 in, 0.1 mph — the same rounding
 * `core/units.ts` bakes into `cToF`/`mmToIn`/`kphToMph`). A field a user
 * never edited must keep its original stored metric value; callers MUST NOT
 * write `fromDisplay(toDisplay(storedValue, q, units), q, units)` back over
 * a field just because the UI rendered it in imperial. Call `fromDisplay`
 * only on a value the user actually typed/dragged in display units. See the
 * "untouched value" example in `test/studio-format.test.ts`.
 */
import { compassPoint, withMinus } from "../../core/report";
import { cToF, fToC, inToMm, kphToMph, mmToIn, mphToKph, type Units } from "../../core/units";

export type Quantity = "temperature" | "temperatureDelta" | "amount" | "speed" | "direction" | "fraction" | "percent" | "factor" | "days" | "years" | "phase" | "probability" | "count";

/** `text` is the number (real minus, tabular digits); `unit` is the bare suffix — no leading space, "" when the unit is embedded in `text` (direction) or there is none. */
export interface Fmt {
  text: string;
  unit: string;
}

const MI_PER_KM = 1.609344; // matches core/units.ts's kphToMph/mphToKph exactly

function roundTo(x: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round(x * p) / p;
}

function normalizeDeg(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return d === 360 ? 0 : d;
}

/** Default decimal places per quantity when `opts.digits` is omitted. Amount differs by system (mm: 0.1, in: 0.01 — same split as `core/units.ts`). */
function defaultDigits(q: Quantity, units: Units): number {
  switch (q) {
    case "temperature":
    case "temperatureDelta":
    case "speed":
      return 1;
    case "amount":
      return units === "imperial" ? 2 : 1;
    case "direction":
    case "days":
    case "years":
    case "count":
      return 0;
    case "fraction":
    case "phase":
    case "probability":
    case "percent":
    case "factor":
      return 2;
  }
}

/** The bare unit suffix for a quantity ("" for direction — its degree sign is embedded in `format`'s text, see below). */
export function unitLabel(q: Quantity, units: Units): string {
  const imp = units === "imperial";
  switch (q) {
    case "temperature":
    case "temperatureDelta":
      return imp ? "°F" : "°C";
    case "amount":
      return imp ? "in" : "mm";
    case "speed":
      return imp ? "mph" : "km/h";
    case "direction":
      return "°";
    case "percent":
      return "%";
    case "factor":
      return "×";
    case "days":
      return "d";
    case "years":
      return "y";
    case "fraction":
    case "phase":
    case "probability":
    case "count":
      return "";
  }
}

/**
 * Metric → display units. Identity for quantities units.ts has no table for
 * (direction, fraction, percent, factor, days, years, phase, probability,
 * count — none of these change shape with `settings.units`). No rounding
 * beyond what `cToF`/`mmToIn`/`kphToMph` already do; `temperatureDelta`
 * scales by the 9/5 ratio with no +32 offset and no extra rounding.
 */
export function toDisplay(value: number, q: Quantity, units: Units): number {
  if (units === "metric") return value;
  switch (q) {
    case "temperature":
      return cToF(value);
    case "temperatureDelta":
      return (value * 9) / 5;
    case "amount":
      return mmToIn(value);
    case "speed":
      return kphToMph(value);
    default:
      return value;
  }
}

/** Display → metric, the inverse of `toDisplay`. Use only on a value the user actually edited — see H-1384 above. */
export function fromDisplay(value: number, q: Quantity, units: Units): number {
  if (units === "metric") return value;
  switch (q) {
    case "temperature":
      return fToC(value);
    case "temperatureDelta":
      return (value * 5) / 9;
    case "amount":
      return inToMm(value);
    case "speed":
      return mphToKph(value);
    default:
      return value;
  }
}

/** Fixed-digit text: never exponential, never "-0", real minus (U+2212). */
export function tabular(n: number, digits: number): string {
  const v = Object.is(n, -0) ? 0 : n;
  let fixed = v.toFixed(digits);
  if (/^-0(\.0*)?$/.test(fixed)) fixed = fixed.slice(1); // "-0.00" rounding artifact
  return withMinus(fixed);
}

/**
 * `+` only on a POSITIVE value. Zero is neither raised nor lowered, and the
 * prototype's readouts say so — `0.0 °C`, not `+0.0 °C` (`1230-vst-macro.html`;
 * `Component.js`'s knob formatter is `v > 0 ? "+" : ""`).
 */
function signPrefix(text: string, value: number, signed: boolean): string {
  return signed && value > 0 ? `+${text}` : text;
}

/**
 * A metric value as display-unit text. `temperatureDelta` uses the 9/5 ratio
 * without +32 (an offset of 2 °C is 3.6 °F); `direction` renders a compass
 * point plus rounded degrees ("SW 225°") with the ° folded into `text` since
 * there is no separate suffix to hang it on; `percent` treats `value` as a
 * 0..1 fraction and multiplies by 100; `factor`/`phase`/`probability`/
 * `fraction`/`days`/`years`/`count` pass the value through as-is.
 */
export function format(value: number, q: Quantity, units: Units, opts?: { digits?: number; signed?: boolean }): Fmt {
  const digits = opts?.digits ?? defaultDigits(q, units);
  const signed = opts?.signed ?? false;

  if (q === "direction") {
    const deg = Math.round(normalizeDeg(value)) % 360;
    return { text: `${compassPoint(value)} ${deg}°`, unit: "" };
  }

  const display = q === "percent" ? value * 100 : toDisplay(value, q, units);
  const text = signPrefix(tabular(display, digits), display, signed);
  return { text, unit: unitLabel(q, units) };
}

/** A knob spec converted for display. `neutral`/`step` are only present in the output when present in the input (`exactOptionalPropertyTypes`). */
export function displaySpec(spec: { min: number; max: number; neutral?: number; step?: number }, q: Quantity, units: Units): { min: number; max: number; neutral?: number; step?: number } {
  const out: { min: number; max: number; neutral?: number; step?: number } = {
    min: toDisplay(spec.min, q, units),
    max: toDisplay(spec.max, q, units),
  };
  if (spec.neutral !== undefined) out.neutral = toDisplay(spec.neutral, q, units);
  if (spec.step !== undefined) out.step = displayStep(spec.step, q, units);
  return out;
}

/**
 * Step size stays the intuitive click resolution in the target system rather
 * than a literal unit conversion of the metric step: temperature/
 * temperatureDelta keep their step as-is (0.1 °C stays 0.1 °F, not 0.18),
 * amount scales by 1/25.4 rounded to 0.01, speed scales by 1/mi-per-km
 * rounded to 0.1. Everything else has no unit system, so the step is
 * untouched.
 */
function displayStep(step: number, q: Quantity, units: Units): number {
  if (units === "metric") return step;
  switch (q) {
    case "amount":
      return roundTo(step / 25.4, 2);
    case "speed":
      return roundTo(step / MI_PER_KM, 1);
    default:
      return step;
  }
}

/**
 * The studio's ONE day-ordinal convention (bead wadjet-9f9.48.2): `d130` —
 * **0-based** within the year, and no space after the `d`.
 *
 * The prototype writes a day exactly this way everywhere it names one
 * (`1397-logic-class-Component.js`): the ruler ticks are
 * `d${((d3 % 365) + 365) % 365}`, the season rows are
 * `fromDay: Math.round(sn.from * 365)` under a `from d{{ sr.fromDay }}`
 * template, and a pin chip is `d${p2.day}`. That makes the whole studio agree
 * with its own ruler, which runs `d0 … d365`, and with the Seasons window's
 * WRITES line, which is 0-based too.
 *
 * Days outside the year wrap into `[0, yearLength)`, so the day after `d364`
 * is `d0`. **Display only** — day ordinals in `data.json` and in the engine are
 * untouched by this.
 */
export function dayLabel(dayOfYear: number, yearLength: number): string {
  return `d${wrapDay(dayOfYear, yearLength)}`;
}

function wrapDay(day: number, yearLength: number): number {
  const n = Math.max(1, Math.round(yearLength));
  return ((Math.round(day) % n) + n) % n;
}

/**
 * The two day ordinals a yearly clip `[start, start + length)` covers, in
 * fractional years. The prototype's `whenLabel` rounds the two edges
 * independently — `d${Math.round(w.s * 365)} – d${Math.round((w.s + w.len) * 365)}`
 * — so this does too, and every surface that prints the clip reads it from
 * here rather than rounding its own way. (The rail chip used to floor the
 * start and subtract one from the end, which is how the same Ashfall clip came
 * out as `clip d222–261` in the rail and `d223 – d263` in the playlist.)
 *
 * `start` may be an absolute year fraction (`1962.61`); the year part is
 * dropped, and the end is allowed past `yearLength` for a clip that wraps.
 */
export function dayRange(start: number, length: number, yearLength: number): [number, number] {
  const year = Math.floor(start);
  return [Math.round((start - year) * yearLength), Math.round((start - year + length) * yearLength)];
}

/**
 * A clip's day range: `d223 – d263`, or tight `d223–263` where the column is
 * too narrow for the second `d` (the rail chip and a lane's sub-line — see
 * `model/device-lanes.ts`).
 */
export function dayRangeLabel(start: number, length: number, yearLength: number, opts?: { tight?: boolean }): string {
  const [from, to] = dayRange(start, length, yearLength);
  return dayRangeLabelOf(from, to, opts);
}

/** `dayRangeLabel` for a range already counted in whole days (`{ dayOfYear: [223, 263] }`). */
export function dayRangeLabelOf(from: number, to: number, opts?: { tight?: boolean }): string {
  return opts?.tight === true ? `d${from}–${to}` : `d${from} – d${to}`;
}

/** "Y 1962" — negative years use a real minus. */
export function yearLabel(year: number): string {
  return `Y ${tabular(year, 0)}`;
}

/**
 * A zoom window `[a, b)` in fractional years as the header readout's range
 * (bead wadjet-6rw.6 — the prototype's `windowLabel`, `0025-header.html`):
 *
 *   - **2.5 years or wider** — bare years, no `Y` prefix: `1862 – 2862`. The
 *     zoom presets already say which scale this is; the prefix was noise.
 *   - **8 days or narrower** — the one day under the centre: `day 36 · 1962`.
 *   - **anything between** — days within the year, then the year:
 *     `d0 – d365 · 1962`. Days are counted from 0 at the year boundary, so a
 *     whole year reads `d0 – d365` rather than `d 1–365` — `dayRangeLabel`'s
 *     convention, which is the whole studio's.
 */
export function windowLabel(a: number, b: number, yearLength: number): string {
  const widthYears = b - a;
  const mid = (a + b) / 2;
  const midYear = Math.floor(mid);
  if (widthYears >= 2.5) return `${tabular(Math.round(a), 0)} – ${tabular(Math.round(b), 0)}`;
  if (widthYears * yearLength <= 8) return `day ${Math.round((mid - midYear) * yearLength)} · ${tabular(midYear, 0)}`;
  return `${dayRangeLabel(a, widthYears, yearLength)} · ${tabular(midYear, 0)}`;
}
