/**
 * Daily-stage parameter ops (DESIGN-v1.md §3). These act on already-evaluated
 * scalars for a single day. Climate-stage ops on Curves live elsewhere.
 */
import type { ModifierOp } from "./types";

/** All scalar parameters the generator reads for one day, by dotted path. */
export interface DayParams {
  "temperature.mean": number;
  "temperature.diurnalRange": number;
  "temperature.wetDayOffset": number;
  "temperature.sd": number;
  "temperature.sdHigh": number;
  "temperature.sdLow": number;
  "temperature.wetDayRangeOffset": number;
  "precipitation.pww": number;
  "precipitation.pwd": number;
  "precipitation.shape": number;
  "precipitation.scale": number;
  "humidity.dry": number;
  "humidity.wet": number;
  "cloud.dry": number;
  "cloud.wet": number;
  "wind.speed": number;
  "wind.speedSd": number;
  "wind.direction": number;
  "wind.directionSpread": number;
  "wind.calmFraction": number;
}

export type DayParamPath = keyof DayParams;

const PROBABILITY_PATHS: DayParamPath[] = ["precipitation.pww", "precipitation.pwd", "humidity.dry", "humidity.wet", "cloud.dry", "cloud.wet", "wind.calmFraction"];
const POSITIVE_PATHS: DayParamPath[] = ["precipitation.shape", "precipitation.scale", "temperature.sd", "temperature.sdHigh", "temperature.sdLow", "wind.speedSd", "wind.directionSpread"];
const NONNEGATIVE_PATHS: DayParamPath[] = ["temperature.diurnalRange", "wind.speed"];

export function isDayParamPath(p: string): p is DayParamPath {
  return Object.prototype.hasOwnProperty.call(EMPTY, p);
}

const EMPTY: DayParams = {
  "temperature.mean": 0,
  "temperature.diurnalRange": 0,
  "temperature.wetDayOffset": 0,
  "temperature.sd": 0,
  "temperature.sdHigh": 0,
  "temperature.sdLow": 0,
  "temperature.wetDayRangeOffset": 0,
  "precipitation.pww": 0,
  "precipitation.pwd": 0,
  "precipitation.shape": 0,
  "precipitation.scale": 0,
  "humidity.dry": 0,
  "humidity.wet": 0,
  "cloud.dry": 0,
  "cloud.wet": 0,
  "wind.speed": 0,
  "wind.speedSd": 0,
  "wind.direction": 0,
  "wind.directionSpread": 0,
  "wind.calmFraction": 0,
};

/**
 * Apply ops in order, then normalise: probabilities clamped to [0,1],
 * strictly-positive params floored at a tiny epsilon, non-negatives at 0,
 * direction wrapped to [0,360). Unknown paths throw — a typo in a profile is
 * a validation error, not a silent no-op.
 */
export function applyDayOps(params: DayParams, ops: readonly ModifierOp[]): DayParams {
  const out: DayParams = { ...params };
  for (const op of ops) {
    if (!isDayParamPath(op.param)) throw new RangeError(`unknown parameter path "${op.param}"`);
    const cur = out[op.param];
    switch (op.op) {
      case "set":
        // a Curve-valued set is climate-stage only; the validator rejects it upstream, so skip it here rather than write a non-number
        if (typeof op.value !== "number") break;
        out[op.param] = op.value;
        break;
      case "offset":
        out[op.param] = cur + op.value;
        break;
      case "scale":
        out[op.param] = cur * op.value;
        break;
      case "clamp": {
        let v = cur;
        if (op.min !== undefined && v < op.min) v = op.min;
        if (op.max !== undefined && v > op.max) v = op.max;
        out[op.param] = v;
        break;
      }
    }
  }
  for (const p of PROBABILITY_PATHS) out[p] = Math.min(1, Math.max(0, out[p]));
  for (const p of POSITIVE_PATHS) out[p] = Math.max(1e-9, out[p]);
  for (const p of NONNEGATIVE_PATHS) out[p] = Math.max(0, out[p]);
  out["wind.direction"] = ((out["wind.direction"] % 360) + 360) % 360;
  return out;
}
