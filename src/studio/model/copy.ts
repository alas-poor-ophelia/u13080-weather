/**
 * Product copy for engine values (SPEC §9, BRIEF "copy is product copy, never
 * engine ids").
 *
 * Two vocabularies live here, because the prototype uses two and they are not
 * interchangeable:
 *
 *  - **`"target"`** (the default) — the short names a device/era/regime apply
 *    knob wears: `temp`, `precip`, `wind`, `sky`. Used wherever a *knob or a
 *    unit chip* names the thing it nudges, because the row already sits under
 *    a heading that says which device it belongs to.
 *  - **`"macro"`** — the longer names the channel macros and the Stormtide
 *    bindings wear: `storm odds`, `stickiness`, `day swing`, `warmth`. Used
 *    wherever the name has to stand alone with no other context.
 *
 * Numbers route through `format.ts`, so a value rendered here honours
 * `settings.units` and uses the studio's real minus (U+2212) and tabular
 * digits. That is a deliberate difference from the prototype's `toFixed`,
 * which is metric-only and uses an ASCII hyphen.
 *
 * The WRITES footer is the one place that stays in engine grammar — SPEC law 5
 * asks for "the exact JSON grammar it produces", not product copy. `grammar()`
 * and `applyPhrase()` build that side; `describeOp()` builds the chip side.
 */
import { format, toDisplay, type Quantity } from "./format";
import type { ModifierOp } from "../../core/types";
import type { Units } from "../../core/units";

export type Vocabulary = "target" | "macro";

export interface CopyOptions {
  vocabulary?: Vocabulary;
  units?: Units;
}

interface ParamCopy {
  /** short apply-knob name (`temp`, `precip`, `sky`) */
  target: string;
  /** standalone macro name (`warmth`, `storm odds`, `cloud`) */
  macro: string;
  /** how the value reads once formatted */
  quantity: Quantity;
  /** decimals for `offset`; `scale` is always 2 */
  digits?: number;
}

/**
 * Every param the studio can write, with both names and the quantity its
 * value carries. Unknown params fall back to the last path segment, so a new
 * engine param reads as itself rather than throwing.
 */
const PARAMS: Record<string, ParamCopy> = {
  "temperature.mean": { target: "temp", macro: "warmth", quantity: "temperatureDelta", digits: 1 },
  "temperature.diurnalRange": { target: "day swing", macro: "day swing", quantity: "temperatureDelta", digits: 1 },
  "temperature.diurnal": { target: "day swing", macro: "day swing", quantity: "temperatureDelta", digits: 1 },
  "precipitation.pwd": { target: "precip", macro: "storm odds", quantity: "probability" },
  "precipitation.pww": { target: "precip", macro: "stickiness", quantity: "probability" },
  "precipitation.amount": { target: "rain", macro: "amount", quantity: "amount", digits: 1 },
  "wind.speed": { target: "wind", macro: "wind", quantity: "speed", digits: 0 },
  "wind.direction": { target: "direction", macro: "direction", quantity: "direction" },
  "wind.calm": { target: "calm", macro: "calm", quantity: "fraction" },
  "wind.gust": { target: "gust", macro: "gust", quantity: "factor" },
  "cloud.dry": { target: "sky", macro: "cloud", quantity: "fraction" },
  "cloud.wet": { target: "sky", macro: "cloud", quantity: "fraction" },
  "humidity.dry": { target: "humidity", macro: "humidity", quantity: "fraction" },
  "humidity.wet": { target: "humidity", macro: "humidity", quantity: "fraction" },
};

/** A slug's last path segment, hyphens and underscores opened out. */
function tail(param: string): string {
  const seg = param.split(".").pop() ?? param;
  return seg.replace(/[-_]/g, " ");
}

/** The friendly name for a param path — `precipitation.pwd` → `precip` (target) or `storm odds` (macro). */
export function paramName(param: string, vocabulary: Vocabulary = "target"): string {
  const copy = PARAMS[param];
  return copy ? copy[vocabulary] : tail(param);
}

/**
 * The plain-language tail the prototype hangs off a `set`: `— no rain`,
 * `— ash-dark`. Only params where the number alone means nothing get one.
 */
function setGloss(param: string, value: number): string {
  if (param === "precipitation.pwd" || param === "precipitation.pww") {
    if (value === 0) return " — no rain";
    return "";
  }
  if (param === "cloud.dry" || param === "cloud.wet") {
    return value > 0.8 ? " — ash-dark" : value > 0.4 ? " — hazed" : " — clearish";
  }
  return "";
}

/**
 * `digits: "param"` uses the param's own precision (an offset in °C is always
 * one decimal); `digits: "value"` shows exactly the decimals the number
 * carries, which is what a `set` needs — the prototype writes `0 — no rain`,
 * not `0.00 — no rain`, but still `0.95 — ash-dark`.
 */
function fmtValue(value: number, param: string, signed: boolean, units: Units, digits: "param" | "value"): string {
  const copy = PARAMS[param];
  const quantity: Quantity = copy?.quantity ?? "fraction";
  const opts: { digits?: number; signed: boolean } = { signed };
  if (digits === "value") opts.digits = decimalsFor(toDisplay(value, quantity, units));
  else if (copy?.digits !== undefined) opts.digits = copy.digits;
  const f = format(value, quantity, units, opts);
  return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
}

/** `×1.50` — a scale factor, always two decimals, never unit-converted. */
export function factorText(value: number): string {
  return `×${format(value, "factor", "metric", { digits: 2 }).text}`;
}

/**
 * The chip text for one op: friendly name, then the value with its unit and
 * any gloss. `set` on a Curve has no scalar to show, so it reads as a curve.
 *
 *   describeOp({ param: "precipitation.pwd", op: "scale", value: 1.5 }, { vocabulary: "macro" })
 *     → "storm odds ×1.50"
 *   describeOp({ param: "temperature.mean", op: "offset", value: -8 })
 *     → "temp −8.0 °C"
 */
export function describeOp(op: ModifierOp, opts?: CopyOptions): string {
  const name = paramName(op.param, opts?.vocabulary ?? "target");
  const units = opts?.units ?? "metric";
  switch (op.op) {
    case "scale":
      return `${name} ${factorText(op.value)}`;
    case "offset":
      return `${name} ${fmtValue(op.value, op.param, true, units, "param")}`;
    case "set": {
      if (typeof op.value !== "number") return `${name} ∿ curve`;
      return `${name} ${fmtValue(op.value, op.param, false, units, "value")}${setGloss(op.param, op.value)}`;
    }
    case "clamp": {
      const lo = op.min === undefined ? "" : fmtValue(op.min, op.param, false, units, "value");
      const hi = op.max === undefined ? "" : fmtValue(op.max, op.param, false, units, "value");
      return `${name} ${lo}–${hi}`.replace(/\s+/g, " ").trim();
    }
  }
}

/**
 * The dim `op · param` annotation under an apply knob — `scale · precipitation.pwd`.
 * `field` overrides the param path where one column stands for two writes
 * (`devices.ts` `COMPOSED_FIELD`).
 */
export function opGloss(op: ModifierOp, field: string = op.param): string {
  return `${op.op} · ${field}`;
}

const SMALL_WORDS = new Set(["of", "the", "and", "in", "on", "at", "a", "an"]);

/**
 * A display name from a modifier id or a tag: `sable-stormtide` →
 * `Sable Stormtide`, `era:Ice Age` → `Ice Age`, `neverain` → `Neverain`.
 * A word that already carries a capital is left as the author typed it, so
 * `A Coruña` and `MST` survive.
 */
export function displayName(idOrTag: string): string {
  const bare = idOrTag.includes(":") ? idOrTag.slice(idOrTag.indexOf(":") + 1) : idOrTag;
  const words = bare.trim().replace(/[-_]+/g, " ").split(/\s+/).filter((w) => w.length > 0);
  return words
    .map((w, i) => {
      if (/[A-Z]/.test(w)) return w;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w[0]!.toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * The kind pill's colour, by badge text. The prototype's DEV_KINDS carry a
 * colour each; the studio's own kinds (ERA, STATES, CHANNEL …) take the
 * neutral text colour. Returns a palette `var()`, never a literal.
 */
export function kindColor(badge: string): string {
  switch (badge.trim().toUpperCase()) {
    // The prototype's curse badge is #f0885c — the same hue SPELL wears
    // (`1213-vst-neverain.html`), not the error red this used to reach for.
    case "CURSE":
    case "SPELL":
      return "var(--wadjet-studio-temp)";
    case "MOON":
      return "var(--wadjet-studio-moon)";
    case "TAG":
      return "var(--wadjet-studio-gold)";
    case "DICE":
    case "CHANCE":
      return "var(--wadjet-studio-wind)";
    case "TRIM":
      return "var(--wadjet-studio-sky)";
    default:
      return "var(--wadjet-studio-text)";
  }
}

/**
 * Join the clauses of a WRITES grammar with the studio's separator, dropping
 * empties so a caller can pass a conditional clause inline:
 *
 *   grammar(`modifiers[${i}]`, whenPhrase, applyPhrase(op))
 *     → "modifiers[2] · when.moon Sable · apply precipitation.pwd ×1.50"
 */
export function grammar(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).join(" · ");
}

/**
 * One op as a WRITES clause. Engine grammar, not product copy: the param path
 * stays intact, only the value is formatted (SPEC law 5).
 */
export function applyPhrase(op: ModifierOp): string {
  switch (op.op) {
    case "scale":
      return `apply ${op.param} ${factorText(op.value)}`;
    case "offset":
      return `apply ${op.param} ${format(op.value, "fraction", "metric", { signed: true, digits: decimalsFor(op.value) }).text}`;
    case "set":
      return typeof op.value === "number"
        ? `apply ${op.param} = ${format(op.value, "fraction", "metric", { digits: decimalsFor(op.value) }).text}`
        : `apply ${op.param} = ∿curve`;
    case "clamp":
      return `apply ${op.param} clamp ${op.min ?? "−∞"}…${op.max ?? "∞"}`;
  }
}

/** Enough decimals to show the value without inventing precision (0–2). */
function decimalsFor(value: number): number {
  if (Number.isInteger(value)) return 0;
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// One day's condition (SPEC §3.2 "Day view") — bead wadjet-6rw.3
// ---------------------------------------------------------------------------

/** The fields a day's condition is read off — `core/report.ts`'s `WeatherReport`, narrowed. */
export interface ConditionSource {
  precipitation: { type: string; amountMm: number };
  cloudCover: number;
  conditions: readonly string[];
  descriptors: { precipitation: string; sky: string };
}

/**
 * The day's condition in one phrase — what the day IS (`broken cloud`,
 * `steady rain`, `ashfall`), never a sentence about it. The day card's hero
 * line and its NEIGHBOUR rows both read this, so the two always agree.
 */
export function conditionOf(r: ConditionSource): string {
  if (r.conditions.includes("ashfall")) return "ashfall";
  if (r.precipitation.type !== "none") {
    // `steady rain`, `light snow` — but never `drizzle drizzle`: the intensity
    // band and the precipitation type share a word at the bottom of the scale.
    const band = r.descriptors.precipitation;
    return band === r.precipitation.type ? band : `${band} ${r.precipitation.type}`;
  }
  if (r.conditions.includes("fog")) return "fog";
  return r.descriptors.sky;
}

/**
 * The condition's code pill — the prototype's `BKN` / `SN` / `+RA`. Aviation
 * codes rather than an abbreviation of our own: they are the one three-letter
 * weather vocabulary a reader may already know, and the prototype uses them
 * verbatim.
 */
export function conditionCode(r: ConditionSource): string {
  if (r.conditions.includes("ashfall")) return "VA";
  switch (r.precipitation.type) {
    case "snow":
      return "SN";
    case "sleet":
      return "RASN";
    case "drizzle":
      return "DZ";
    case "rain":
      return r.precipitation.amountMm > HEAVY_RAIN_MM ? "+RA" : "RA";
  }
  if (r.conditions.includes("fog")) return "FG";
  if (r.cloudCover >= 0.8) return "OVC";
  if (r.cloudCover >= 0.5) return "BKN";
  if (r.cloudCover >= 0.2) return "SCT";
  return "SKC";
}

/** The mm/day at which rain reads as heavy — `report.ts`'s own `heavy` band. */
const HEAVY_RAIN_MM = 10;

/**
 * The condition's hue (SPEC §9), as a palette `var()`: ash gold, frozen
 * precipitation moon, liquid precipitation precip-blue, a dry day neutral.
 */
export function conditionColour(r: Pick<ConditionSource, "precipitation" | "conditions">): string {
  if (r.conditions.includes("ashfall")) return "var(--wadjet-studio-gold)";
  if (r.precipitation.type === "snow" || r.precipitation.type === "sleet") return "var(--wadjet-studio-moon)";
  if (r.precipitation.type !== "none") return "var(--wadjet-studio-precip)";
  return "var(--wadjet-studio-text-dim)";
}
