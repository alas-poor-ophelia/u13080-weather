/**
 * Pure knob math: drag-to-value, keyboard nudge, angle and power-arc
 * geometry, normalisation and typed-entry parsing. No DOM, no Obsidian —
 * see PLAN.md §4 D3. The DOM component (`src/studio/ui/components/knob.ts`)
 * is the only thing that touches a pointer or the keyboard.
 */

/**
 * A knob's value range and rounding. `bipolar` defaults `neutral` to the range's centre.
 *
 * `scale` (default `"linear"`): a `"log"` knob spreads its travel evenly over
 * the ratio max/min instead of the difference, so a period knob from 0.5 to
 * 10 000 days gives each decade the same sweep. Drag, angle, the power arc
 * and an un-stepped keyboard nudge all move in that log travel; `step` stays
 * a grid in VALUE space (a stepped nudge adds `step`, a drag snaps to it). A
 * log knob needs 0 < min < max (`knobSpecError`).
 */
export interface KnobSpec {
  min: number;
  max: number;
  neutral?: number;
  step?: number;
  bipolar?: boolean;
  scale?: "linear" | "log";
}

/** 150 px of vertical drag spans the full [min,max] range (SPEC §3.8). */
const DRAG_PX_FOR_FULL_RANGE = 150;
/** Shift-drag / shift-nudge precision multiplier. */
const FINE_FACTOR = 0.1;
/** Knobs sweep −135°…+135° (SPEC law 6). */
const ANGLE_SPAN = 135;
/** Below this, the power arc collapses to nothing rather than a sliver. */
const ARC_MIN_DEGREES = 1;

function range(spec: KnobSpec): number {
  return spec.max - spec.min;
}

/**
 * Why `spec` cannot drive a knob, or null when it can. Only a log knob has a
 * condition of its own: its range must be positive (0 < min < max), since the
 * travel is ln(value / min).
 */
export function knobSpecError(spec: KnobSpec): string | null {
  if (spec.scale !== "log") return null;
  if (!(Number.isFinite(spec.min) && spec.min > 0)) return `a log knob needs a minimum above 0 (got ${spec.min})`;
  if (!(Number.isFinite(spec.max) && spec.max > spec.min)) return `a log knob needs a maximum above its minimum (got ${spec.min} to ${spec.max})`;
  return null;
}

/** Whether `spec` is a log knob; throws on a log spec `knobSpecError` refuses (a programming error, never user input). */
function isLog(spec: KnobSpec): boolean {
  if (spec.scale !== "log") return false;
  const err = knobSpecError(spec);
  if (err !== null) throw new RangeError(err);
  return true;
}

/** A log knob's travel in [0,1] for `value` (clamped). */
function logTravel(value: number, spec: KnobSpec): number {
  const v = clamp(value, spec);
  return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
}

/** The value at log travel `t` (clamped to [0,1]); the ends are exactly min and max. */
function logValue(t: number, spec: KnobSpec): number {
  if (t <= 0) return spec.min;
  if (t >= 1) return spec.max;
  return clamp(spec.min * Math.exp(t * Math.log(spec.max / spec.min)), spec);
}

/** Snap a log knob's raw value to the step grid in value space, staying in range. */
function logSnap(raw: number, spec: KnobSpec, factor: number): number {
  if (!spec.step) return raw;
  return clamp(roundToStep(raw, spec.step * factor), spec);
}

/** The angle-zero value: an explicit `neutral`, else the range's centre when `bipolar`, else `min`. */
function neutralOf(spec: KnobSpec): number {
  if (spec.neutral !== undefined) return spec.neutral;
  if (spec.bipolar) return (spec.min + spec.max) / 2;
  return spec.min;
}

function clamp(value: number, spec: KnobSpec): number {
  return Math.min(spec.max, Math.max(spec.min, value));
}

/** How many decimal places `step` itself carries, so rounding matches its own precision. */
function decimalsOf(step: number): number {
  const s = step.toString();
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Round to the nearest `step` via the step's own decimal precision — avoids float garbage like 0.30000000000000004. */
function roundToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const steps = Math.round(value / step);
  return Number((steps * step).toFixed(decimalsOf(step)));
}

/**
 * The value after a vertical drag of `dyPx` from `startValue`. Dragging up
 * (negative `dyPx`) increases the value; 150 px covers the full range.
 * `fine` (shift) scales the drag by ×0.1. Result is clamped to [min,max]
 * and rounded to `step` when given.
 */
export function dragToValue(startValue: number, dyPx: number, spec: KnobSpec, fine?: boolean): number {
  const factor = fine ? FINE_FACTOR : 1;
  if (isLog(spec)) return logSnap(logValue(logTravel(startValue, spec) + (-dyPx / DRAG_PX_FOR_FULL_RANGE) * factor, spec), spec, factor);
  const delta = ((-dyPx / DRAG_PX_FOR_FULL_RANGE) * range(spec)) * factor;
  const raw = clamp(startValue + delta, spec);
  if (!spec.step) return raw;
  // Fine mode also sharpens the rounding grid — otherwise a ×0.1 drag would
  // round straight back to the value it started from.
  return clamp(roundToStep(raw, spec.step * factor), spec);
}

/**
 * The value after `steps` keyboard nudges (may be negative, or larger than
 * 1 for PageUp/PageDown's 10-step jump). Each step is `spec.step` when
 * given, else 1% of the range. `fine` (shift) scales every step by ×0.1.
 */
export function nudgeBy(value: number, spec: KnobSpec, steps: number, fine?: boolean): number {
  const factor = fine ? FINE_FACTOR : 1;
  // a log knob without a step moves 1% of its log travel; with one, the step is in value space as on a linear knob
  if (isLog(spec) && !spec.step) return logValue(logTravel(value, spec) + 0.01 * factor * steps, spec);
  const base = spec.step ?? range(spec) * 0.01;
  const raw = clamp(value + base * factor * steps, spec);
  if (!spec.step) return raw;
  // Fine mode also sharpens the rounding grid, for the same reason as dragToValue above.
  return clamp(roundToStep(raw, spec.step * factor), spec);
}

/**
 * The value after one keyboard nudge in `dir`. Steps by `spec.step` when
 * given, else 1% of the range. `fine` (shift) scales the step by ×0.1.
 */
export function nudge(value: number, spec: KnobSpec, dir: 1 | -1, fine?: boolean): number {
  return nudgeBy(value, spec, dir, fine);
}

/** `value`'s position in [0,1] across [min,max]. A zero-width range normalises to 0. */
export function normalise(value: number, spec: KnobSpec): number {
  if (isLog(spec)) return logTravel(value, spec);
  const r = range(spec);
  if (r === 0) return 0;
  return (clamp(value, spec) - spec.min) / r;
}

/** `value`'s angle on the knob face, linear in `normalise` across −135°…+135° (so a log knob's angle is logarithmic in value). */
export function valueToAngle(value: number, spec: KnobSpec): number {
  return -ANGLE_SPAN + normalise(value, spec) * (2 * ANGLE_SPAN);
}

/**
 * The power arc: from the neutral value's angle (which is −135° when no
 * `neutral` is set and the knob isn't bipolar) to `value`'s angle. `null`
 * when the sweep is under 1° — nothing worth drawing.
 */
export function arcAngles(value: number, spec: KnobSpec): { from: number; to: number } | null {
  const from = valueToAngle(neutralOf(spec), spec);
  const to = valueToAngle(value, spec);
  if (Math.abs(to - from) < ARC_MIN_DEGREES) return null;
  return { from, to };
}

/**
 * Parse typed knob entry: a leading number, comma or dot decimal, optional
 * trailing unit text ignored ("12 °C", "1.4×"). Clamped to [min,max];
 * `null` when the text doesn't start with a number.
 */
export function parseTyped(text: string, spec: KnobSpec): number | null {
  const match = text.trim().match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return clamp(n, spec);
}
