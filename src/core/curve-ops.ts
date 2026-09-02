/**
 * Climate-stage ops: structural edits to Curves (DESIGN-v1.md §2 "Ops on a Curve").
 *
 * | op     | constant | harmonic                     | keyframes            |
 * | set    | replace (constant or Curve) | replace (constant or Curve) | replace (constant or Curve) |
 * | offset | +v       | mean += v                    | every value += v     |
 * | scale  | ×v       | mean ×= v, amplitude ×= v    | every value ×= v     |
 * | clamp  | clamp    | sampled to keyframes, clamped| every value clamped  |
 *
 * Deviation from the doc, stated: a clamped harmonic is materialised as 24
 * keyframes and clamped point-wise (monotone interpolation keeps it within
 * bounds) rather than carried as a "runtime bound". Same observable effect,
 * one fewer Curve variant.
 */
import { evalCurve, isHarmonic, wrapPhase } from "./curve";
import type { ClimateParams, Curve, Keyframe, ModifierOp } from "./types";

export const CURVE_PATHS = [
  "temperature.mean",
  "temperature.diurnalRange",
  "temperature.wetDayOffset",
  "temperature.sd",
  "temperature.sdHigh",
  "temperature.sdLow",
  "temperature.wetDayRangeOffset",
  "precipitation.pww",
  "precipitation.pwd",
  "precipitation.shape",
  "precipitation.scale",
  "humidity.dry",
  "humidity.wet",
  "cloud.dry",
  "cloud.wet",
  "wind.speed",
  "wind.speedSd",
  "wind.direction",
  "wind.directionSpread",
  "wind.calmFraction",
] as const;
export type CurvePath = (typeof CURVE_PATHS)[number];

export const SCALAR_PATHS = ["temperature.phase", "temperature.persistence", "precipitation.freezingPoint", "humidity.sd", "cloud.sd", "wind.wetDayScale"] as const;
export type ScalarPath = (typeof SCALAR_PATHS)[number];

export type ClimatePath = CurvePath | ScalarPath;

export function isCurvePath(p: string): p is CurvePath {
  return (CURVE_PATHS as readonly string[]).includes(p);
}
export function isScalarPath(p: string): p is ScalarPath {
  return (SCALAR_PATHS as readonly string[]).includes(p);
}

export function getPath(c: ClimateParams, path: ClimatePath): Curve | number {
  const [a, b] = path.split(".") as [keyof ClimateParams, string];
  return (c[a] as unknown as Record<string, Curve | number>)[b]!;
}

function setPath(c: ClimateParams, path: ClimatePath, v: Curve | number): ClimateParams {
  const [a, b] = path.split(".") as [keyof ClimateParams, string];
  return { ...c, [a]: { ...(c[a] as object), [b]: v } };
}

export function applyCurveOp(curve: Curve, op: ModifierOp): Curve {
  switch (op.op) {
    case "set":
      return op.value;
    case "offset":
      if (typeof curve === "number") return curve + op.value;
      if (isHarmonic(curve)) return { ...curve, mean: curve.mean + op.value };
      return curve.map((k) => ({ at: k.at, value: k.value + op.value }));
    case "scale":
      if (typeof curve === "number") return curve * op.value;
      if (isHarmonic(curve)) return { ...curve, mean: curve.mean * op.value, amplitude: curve.amplitude * op.value };
      return curve.map((k) => ({ at: k.at, value: k.value * op.value }));
    case "clamp": {
      const cl = (v: number) => {
        let x = v;
        if (op.min !== undefined && x < op.min) x = op.min;
        if (op.max !== undefined && x > op.max) x = op.max;
        return x;
      };
      if (typeof curve === "number") return cl(curve);
      const kfs: Keyframe[] = isHarmonic(curve) ? Array.from({ length: 24 }, (_, i) => ({ at: (i + 0.5) / 24, value: evalCurve(curve, (i + 0.5) / 24) })) : curve;
      return kfs.map((k) => ({ at: k.at, value: cl(k.value) }));
    }
  }
}

function applyScalarOp(v: number, op: ModifierOp): number {
  switch (op.op) {
    case "set":
      // a Curve-valued set on a ScalarPath is rejected by the validator upstream
      return typeof op.value === "number" ? op.value : v;
    case "offset":
      return v + op.value;
    case "scale":
      return v * op.value;
    case "clamp": {
      let x = v;
      if (op.min !== undefined && x < op.min) x = op.min;
      if (op.max !== undefined && x > op.max) x = op.max;
      return x;
    }
  }
}

/** Apply climate-stage ops in order. Unknown paths throw. Returns a new ClimateParams. */
export function applyClimateOps(climate: ClimateParams, ops: readonly ModifierOp[]): ClimateParams {
  let c = climate;
  for (const op of ops) {
    if (isCurvePath(op.param)) {
      const cur = getPath(c, op.param) as Curve | undefined;
      // optional curves default to their fallback before an op touches them
      const base = cur ?? (op.param === "temperature.sdHigh" || op.param === "temperature.sdLow" ? (getPath(c, "temperature.sd")) : 0);
      c = setPath(c, op.param, applyCurveOp(base, op));
    }
    else if (isScalarPath(op.param)) c = setPath(c, op.param, applyScalarOp(getPath(c, op.param) as number, op));
    else throw new RangeError(`unknown climate parameter path "${op.param}"`);
  }
  return c;
}

/** Scale a curve's deviation from its annual mean by k (continentality adjustment). */
export function scaleAmplitude(curve: Curve, k: number): Curve {
  if (typeof curve === "number") return curve;
  if (isHarmonic(curve)) return { ...curve, amplitude: curve.amplitude * k };
  const mean = curve.reduce((a, b) => a + b.value, 0) / curve.length;
  return curve.map((p) => ({ at: p.at, value: mean + (p.value - mean) * k }));
}

/** Shift a curve along the year by dPhase (e.g. 0.5 to flip hemisphere). */
export function shiftPhase(curve: Curve, dPhase: number): Curve {
  if (typeof curve === "number") return curve;
  if (isHarmonic(curve)) return { ...curve, phase: wrapPhase(curve.phase + dPhase) };
  return curve.map((p) => ({ at: wrapPhase(p.at + dPhase), value: p.value }));
}

/** Apply a transform to every Curve-valued field of a ClimateParams. */
export function mapCurves(c: ClimateParams, f: (curve: Curve, path: CurvePath) => Curve): ClimateParams {
  let out = c;
  for (const p of CURVE_PATHS) {
    const cur = getPath(out, p) as Curve | undefined;
    if (cur !== undefined) out = setPath(out, p, f(cur, p));
  }
  return out;
}
