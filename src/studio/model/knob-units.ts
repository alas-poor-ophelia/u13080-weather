/**
 * The seam between a knob's METRIC spec/value (`model/knob.ts`) and
 * `settings.units` (SPEC §8; PLAN §4 `format.ts`; H-1384).
 *
 * `format.ts` covers the *display* half — metric → text — and is done. It
 * deliberately does not cover two things a display-only module cannot own:
 *
 *   - **Typed knob entry.** A knob's `spec`/`value` stay metric (the drag
 *     range keeps its metric "feel"); its `fmt` shows the reader's units. So
 *     text the reader *types* is in display units too, and must be converted
 *     back to metric before it is stored — and only that one value, never a
 *     value the reader merely saw rendered (H-1384). `parseDisplay` below is
 *     a knob `parse` callback that does exactly this: parse in display units
 *     (clamped to the spec's own range, converted into that unit), convert
 *     the *result* back to metric.
 *   - **Which of an era/device op's raw params are unit-bearing at all.**
 *     `model/devices.ts` (`PARAM_SHAPES`) already knows this for its own knob
 *     *ranges*, but that table is private to that file, which this session's
 *     device crew owns. `OP_QUANTITY` below is a second, deliberately small
 *     copy of the same three facts — temperature/speed/amount params only,
 *     because those are the only shapes `format.ts` converts at all (every
 *     other quantity already passes typed text straight through `parseTyped`
 *     unchanged — see `needsUnitParse`). Keep the two in sync if either
 *     table changes which params carry which unit.
 */
import type { KnobSpec } from "./knob";
import { parseTyped } from "./knob";
import { displaySpec, format, fromDisplay, type Quantity } from "./format";
import type { Units } from "../../core/units";

/**
 * Only these four quantities change shape under `settings.units`
 * (`format.ts`'s `toDisplay`/`fromDisplay`); every other quantity is already
 * the identity in both systems, so a caller need not supply a knob `parse`
 * for them at all — the default `parseTyped(text, spec)` is already correct.
 */
export function needsUnitParse(q: Quantity): boolean {
  return q === "temperature" || q === "temperatureDelta" || q === "amount" || q === "speed";
}

/**
 * A knob `parse` callback (H-1384): reads typed text as a number in the
 * *display* unit, clamped to `spec`'s own range converted into that unit via
 * `displaySpec`, then converts the accepted result back to metric — the one
 * value that conversion ever touches. `null` when the text does not start
 * with a number, same contract as `parseTyped`.
 */
export function parseDisplay(spec: KnobSpec, q: Quantity, units: Units): (text: string) => number | null {
  return (text) => {
    const raw = parseTyped(text, displaySpec(spec, q, units));
    return raw === null ? null : fromDisplay(raw, q, units);
  };
}

/** Params whose value is a temperature — `offset` on one of these is a delta (no +32 in imperial); `set`/`clamp` is the absolute value. Mirrors `devices.ts`'s `PARAM_SHAPES` `unit: "°C"` entries. */
const TEMPERATURE_PARAMS: ReadonlySet<string> = new Set([
  "temperature.mean",
  "temperature.diurnalRange",
  "temperature.wetDayOffset",
  "temperature.wetDayRangeOffset",
  "temperature.sd",
  "temperature.sdHigh",
  "temperature.sdLow",
  "precipitation.freezingPoint",
]);
/** `unit: "km/h"` entries. A speed conversion is a pure ratio, so offset vs. absolute makes no difference here. */
const SPEED_PARAMS: ReadonlySet<string> = new Set(["wind.speed", "wind.speedSd"]);
/** `unit: "mm"` entries. Also a pure ratio. */
const AMOUNT_PARAMS: ReadonlySet<string> = new Set(["precipitation.scale"]);

/**
 * The `format.ts` quantity an era/device/regime op's raw value is, or `null`
 * when it is one of `devices.ts`'s unit-invariant shapes (probabilities,
 * degrees, multipliers, `temperature.phase`/`persistence` …) whose own
 * `KnobSpecFor.fmt` is already correct in every `settings.units`.
 */
export function opQuantity(param: string, isOffset: boolean): Quantity | null {
  if (TEMPERATURE_PARAMS.has(param)) return isOffset ? "temperatureDelta" : "temperature";
  if (SPEED_PARAMS.has(param)) return "speed";
  if (AMOUNT_PARAMS.has(param)) return "amount";
  return null;
}

/**
 * An op knob's readout: `format.ts`-converted text for a unit-bearing param,
 * `fallback` (the op's own `KnobSpecFor.fmt`, already correct) otherwise.
 * `isOffset` both picks `temperature` vs. `temperatureDelta` and matches
 * `devices.ts`'s own convention of a signed readout for an `offset` op.
 */
export function opFmt(param: string, isOffset: boolean, units: Units, fallback: (v: number) => string): (v: number) => string {
  const q = opQuantity(param, isOffset);
  if (q === null) return fallback;
  return (v) => {
    const f = format(v, q, units, isOffset ? { signed: true } : undefined);
    return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
  };
}
