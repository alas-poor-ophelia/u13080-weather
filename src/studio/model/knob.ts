/**
 * Pure knob math: drag-to-value, keyboard nudge, angle and power-arc
 * geometry, normalisation and typed-entry parsing. No DOM, no Obsidian —
 * see PLAN.md §4 D3. The DOM component (`src/studio/ui/components/knob.ts`)
 * is the only thing that touches a pointer or the keyboard.
 */

/** A knob's value range and rounding. `bipolar` defaults `neutral` to the range's centre. */
export interface KnobSpec {
  min: number;
  max: number;
  neutral?: number;
  step?: number;
  bipolar?: boolean;
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
  const r = range(spec);
  if (r === 0) return 0;
  return (clamp(value, spec) - spec.min) / r;
}

/** `value`'s angle on the knob face, linear across −135°…+135°. */
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
