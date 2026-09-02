/**
 * Automation lanes (PLAN.md §2, decision D6).
 *
 * A lane is a value that moves over the world's *years*: `points` are
 * `[year, value]` pairs, `value(y)` is linear between them and clamped to the
 * first/last value outside the authored span. The lane is applied as a
 * daily-stage `offset`/`scale` op on a curve parameter, pushed ahead of the
 * zone's own daily modifiers. For `offset`/`scale` on a curve this is
 * observably identical to a climate-stage op, so `Generator` needs no change.
 *
 * Absent `automation` = today's behaviour, exactly (history protection).
 */
import { isCurvePath } from "./curve-ops";
import type { ValidationIssue } from "./profile";
import type { AutomationLane, DayTime, ModifierOp } from "./types";

/**
 * Year length assumed when the caller's `timeOf` supplies neither `year` nor
 * `yearLength` (e.g. `gregorianTime`, which returns only yearPhase/dayOfYear).
 * The plugin's real adapters return a `TimeContext` that carries both.
 */
export const FALLBACK_YEAR_LENGTH = 365;

/**
 * The calendar year of a day. Mirrors eras.ts yearOf — duplicated (two lines)
 * rather than imported so this module does not close the import cycle
 * profile → automation → eras → profile.
 */
function yearOf(t: DayTime & { dayOrdinal: number; yearLength: number }): number {
  return t.year ?? Math.floor(t.dayOrdinal / t.yearLength) + 1;
}

/** Linear between points, clamped to the first/last value outside; a single point is a constant. */
export function laneValue(lane: AutomationLane, fractionalYear: number): number {
  const pts = lane.points;
  // a lane with no points is a validation error; treat it as the op's identity
  if (!pts || pts.length === 0) return lane.op === "scale" ? 1 : 0;
  const first = pts[0]!;
  if (pts.length === 1 || fractionalYear <= first[0]) return first[1];
  const last = pts[pts.length - 1]!;
  if (fractionalYear >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    if (fractionalYear <= x1) {
      const [x0, y0] = pts[i - 1]!;
      const span = x1 - x0;
      return span <= 0 ? y1 : y0 + ((y1 - y0) * (fractionalYear - x0)) / span;
    }
  }
  return last[1];
}

/**
 * The day's automation ops, in lane order. The fractional year is
 * `yearOf(t) + t.yearPhase`, so a lane point at year N lands on the first
 * instant of year N. Lanes with `enabled === false` are skipped.
 */
export function automationOps(lanes: readonly AutomationLane[] | undefined, t: DayTime & { dayOrdinal: number; yearLength: number }): ModifierOp[] {
  if (!lanes || lanes.length === 0) return [];
  const y = yearOf(t) + t.yearPhase;
  const ops: ModifierOp[] = [];
  for (const lane of lanes) {
    if (lane.enabled === false) continue;
    const value = laneValue(lane, y);
    ops.push(lane.op === "scale" ? { param: lane.param, op: "scale", value } : { param: lane.param, op: "offset", value });
  }
  return ops;
}

const LANE_FIELDS = ["id", "param", "op", "points", "enabled"];

/** Validate `ZoneProfile.automation`. Paths are `automation[i]…`, relative to the zone. */
export function validateAutomation(lanes: unknown, issues: ValidationIssue[]): void {
  if (lanes === undefined) return;
  if (!Array.isArray(lanes)) {
    issues.push({ level: "error", path: "automation", message: "must be an array of automation lanes" });
    return;
  }
  const ids = new Set<string>();
  lanes.forEach((l: Partial<AutomationLane>, i) => {
    const where = `automation[${i}]`;
    if (typeof l !== "object" || l === null) {
      issues.push({ level: "error", path: where, message: "lane must be an object" });
      return;
    }
    if (typeof l.id !== "string" || !l.id.trim()) issues.push({ level: "error", path: `${where}.id`, message: "required" });
    else if (ids.has(l.id)) issues.push({ level: "error", path: `${where}.id`, message: `duplicate automation lane id "${l.id}"` });
    else ids.add(l.id);
    if (typeof l.param !== "string" || !isCurvePath(l.param)) issues.push({ level: "error", path: `${where}.param`, message: `unknown parameter path "${String(l.param)}"` });
    if (l.op !== "offset" && l.op !== "scale") issues.push({ level: "error", path: `${where}.op`, message: `unknown op "${String(l.op)}" — automation ops are offset, scale` });
    if (l.enabled !== undefined && typeof l.enabled !== "boolean") issues.push({ level: "error", path: `${where}.enabled`, message: "enabled must be true or false" });
    // Symmetric with eras.ts: a misspelled field is silently ignored, so say so.
    // Before the `points` bail-out, or a lane with bad points would never be told.
    for (const k of Object.keys(l)) if (!LANE_FIELDS.includes(k)) issues.push({ level: "warning", path: `${where}.${k}`, message: "unknown field (ignored)" });
    if (!Array.isArray(l.points) || l.points.length === 0) {
      issues.push({ level: "error", path: `${where}.points`, message: "at least one [year, value] point is required" });
      return;
    }
    let prevYear = -Infinity;
    l.points.forEach((pt, j) => {
      const at = `${where}.points[${j}]`;
      if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number") {
        issues.push({ level: "error", path: at, message: "point must be [year, value]" });
        return;
      }
      if (!Number.isFinite(pt[0])) issues.push({ level: "error", path: `${at}[0]`, message: "year must be finite" });
      else {
        if (pt[0] <= prevYear) issues.push({ level: "error", path: `${at}[0]`, message: "years must be strictly ascending" });
        prevYear = pt[0];
      }
      if (!Number.isFinite(pt[1])) issues.push({ level: "error", path: `${at}[1]`, message: "value must be finite" });
    });
  });
}
