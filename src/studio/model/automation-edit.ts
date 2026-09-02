/**
 * Pure edits over the zone's `FRC · warmth` automation lane (SPEC §3.2
 * "FRC · warmth", §3.4 "Forcings · ZONE", PLAN §5.3).
 *
 * The lane itself is a *view* over `ZoneProfile.automation` — `compile.ts`
 * owns the read (`getWarmthLane`) and the write (`setWarmthLane`), and this
 * file owns the four gestures the playlist row and the Forcings window make
 * on it: add a point, drag one, drop one, and draw the first lane.
 *
 * Three rules the whole file is written around:
 *
 *  - **Years are whole.** `core/automation.ts` interpolates on a *fractional*
 *    year, so a point could sit at 1904.37 — but the validator wants strictly
 *    ascending years and a lane a user can hit twice in the same place is a
 *    lane they can no longer edit. Every year that arrives here is rounded,
 *    and a point dropped on a year that is already taken *replaces* it rather
 *    than making a second one.
 *  - **Points never cross.** `movePoint` clamps to `bounds` first and to its
 *    two neighbours second, so the neighbours always win: dragging a point
 *    past the one beside it stops one year short of it instead of reordering
 *    the lane behind the pointer.
 *  - **Two points or none.** SPEC §3.2 keeps ≥ 2 points, because a one-point
 *    lane is a constant and a constant is what the `＋ trim` knob already is.
 *    `removePoint` refuses the removal that would leave one; a lane that
 *    somehow holds 0 or 1 already is dropped entirely (`setWarmthLane([])`)
 *    rather than left as a stub.
 *
 * Every function mutates its `ZoneProfile` in place (the store's convention,
 * `model/store.ts`) and leaves `validateProfile` no worse than it found it.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { ZoneProfile } from "../../core/types";
import { getWarmthLane, setWarmthLane } from "./compile";

/** SPEC §3.2 "right-click removes (≥ 2 kept)". */
export const MIN_LANE_POINTS = 2;

/** The span `ensureLane` draws when the zone has no warmth lane at all. */
export const DEFAULT_LANE_SPAN_YEARS = 100;

/** The padding `laneYRange` leaves above and below the drawn points, in °C. */
export const LANE_Y_PAD = 2;
/** The smallest °C span the lane is ever drawn across, so a flat lane is not a knife-edge. */
export const LANE_MIN_Y_SPAN = 8;

/** One `[year, value]` pair — years in whole world years, values in °C. */
export type LanePoint = [number, number];

/** How far a dragged point may travel: the pannable year extent and the drawn °C range. */
export interface LaneBounds {
  minYear: number;
  maxYear: number;
  minValue: number;
  maxValue: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Whole world years — see the header note. */
function wholeYear(y: number): number {
  return Math.round(y);
}

/** The lane's points, copied — callers may splice the result without touching the draft. */
export function lanePoints(z: ZoneProfile): LanePoint[] {
  return getWarmthLane(z).points.map((p) => [p[0], p[1]] as LanePoint);
}

/** True when the zone actually stores a warmth lane (an absent lane reads as no points). */
export function hasLane(z: ZoneProfile): boolean {
  return lanePoints(z).length > 0;
}

/**
 * The °C range the lane is drawn across: the points ± `LANE_Y_PAD`, widened
 * about its own centre to `LANE_MIN_Y_SPAN` when the points sit closer
 * together than that (a flat lane included). No points at all is the same
 * flat case, centred on zero.
 */
export function laneYRange(points: readonly LanePoint[]): [number, number] {
  const values = points.map((p) => p[1]).filter((v) => Number.isFinite(v));
  const lo = (values.length === 0 ? 0 : Math.min(...values)) - LANE_Y_PAD;
  const hi = (values.length === 0 ? 0 : Math.max(...values)) + LANE_Y_PAD;
  const span = hi - lo;
  if (span >= LANE_MIN_Y_SPAN) return [lo, hi];
  const grow = (LANE_MIN_Y_SPAN - span) / 2;
  return [lo - grow, hi + grow];
}

/**
 * Draw the zone's first warmth lane: two neutral points a century apart from
 * the world's epoch. Returns false — and writes nothing — when the zone
 * already has a lane, so the Forcings window's lane row can call it on every
 * click without ever flattening an authored lane.
 */
export function ensureLane(z: ZoneProfile, epochYear: number): boolean {
  if (hasLane(z)) return false;
  const y0 = wholeYear(Number.isFinite(epochYear) ? epochYear : 1);
  setWarmthLane(z, [
    [y0, 0],
    [y0 + DEFAULT_LANE_SPAN_YEARS, 0],
  ]);
  return true;
}

/**
 * Add a point, keeping the years ascending. A point already sitting on that
 * whole year is *replaced* rather than doubled (two points on one year is a
 * validation error, and a lane cannot be edited through a point hiding
 * another). Returns the point's index, so a drag-create can keep dragging the
 * point it just made, or −1 when the input was not a finite pair.
 */
export function addPoint(z: ZoneProfile, year: number, value: number): number {
  if (!Number.isFinite(year) || !Number.isFinite(value)) return -1;
  const points = lanePoints(z);
  const y = wholeYear(year);
  const at = points.findIndex((p) => p[0] === y);
  if (at >= 0) {
    points[at] = [y, value];
    setWarmthLane(z, points);
    return at;
  }
  const before = points.findIndex((p) => p[0] > y);
  const index = before < 0 ? points.length : before;
  points.splice(index, 0, [y, value]);
  setWarmthLane(z, points);
  return index;
}

/**
 * Drag one point to `year` / `value`. The year is clamped to `bounds` and
 * then to the neighbours (which therefore win); the value is clamped to
 * `bounds` only. Returns false when the index is unknown or the point would
 * not actually move, so a drag frame that changed nothing writes nothing.
 */
export function movePoint(z: ZoneProfile, index: number, year: number, value: number, bounds: LaneBounds): boolean {
  if (!Number.isFinite(year) || !Number.isFinite(value)) return false;
  const points = lanePoints(z);
  const point = points[index];
  if (point === undefined) return false;
  const prev = points[index - 1];
  const next = points[index + 1];

  let y = clamp(wholeYear(year), bounds.minYear, bounds.maxYear);
  if (prev !== undefined) y = Math.max(y, prev[0] + 1);
  if (next !== undefined) y = Math.min(y, next[0] - 1);
  // Neighbours one year either side leave nowhere legal to land: stay put.
  if (prev !== undefined && next !== undefined && next[0] - prev[0] <= 2) y = point[0];

  const v = clamp(value, bounds.minValue, bounds.maxValue);
  if (y === point[0] && v === point[1]) return false;
  points[index] = [y, v];
  setWarmthLane(z, points);
  return true;
}

/**
 * Drop one point. Refused (false, nothing written) when the lane is already
 * down to `MIN_LANE_POINTS` — SPEC §3.2's "≥ 2 kept". A lane that somehow
 * holds 0 or 1 point is not a lane at all and is removed outright.
 */
export function removePoint(z: ZoneProfile, index: number): boolean {
  const points = lanePoints(z);
  if (points[index] === undefined) return false;
  if (points.length <= 1) {
    setWarmthLane(z, []);
    return true;
  }
  if (points.length <= MIN_LANE_POINTS) return false;
  points.splice(index, 1);
  setWarmthLane(z, points);
  return true;
}
