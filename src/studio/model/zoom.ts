/**
 * Pure calendar-ruler math: continuous zoom and pan over a `Window` in
 * fractional years, wheel/drag deltas, zoom presets, morph thresholds and
 * the tick plan. No DOM, no Obsidian — see PLAN.md §4 D3. The DOM ruler
 * component is the only thing that touches a pointer or the wheel event.
 */

/** A visible span of the timeline, in fractional years. Always `b > a`. */
export interface Window {
  a: number;
  b: number;
}

/** The world's pannable/zoomable extent, in fractional years. */
export interface ZoomBounds {
  min: number;
  max: number;
}

/** The narrowest a window may ever get: two days, expressed in years. */
export const MIN_WINDOW_DAYS = 2;
/** The widest a window may ever get, in years. */
export const MAX_WINDOW_YEARS = 1100;

const MIN_WIDTH_YEARS = MIN_WINDOW_DAYS / 365;
const DAYS_PER_YEAR = 365;

/** A label-density cap: never more than one labelled tick per 24 px. */
const PX_PER_LABEL = 24;

/**
 * `Window`s are typically `epochYear + fraction`, so `b - a` loses a few
 * ULPs of precision to cancellation at real-world year magnitudes. This
 * keeps a value built to land exactly on a threshold from tipping into the
 * next band or bucket.
 */
const EPSILON = 1e-9;

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** The window's width in fractional years. */
export function width(w: Window): number {
  return w.b - w.a;
}

/**
 * Enforces the [2 day, 1100 year] width limits (growing or shrinking around
 * the window's own centre), then shifts the window into `bounds`. Shrinks to
 * fit `bounds` only when `bounds` is narrower than the (already width-clamped)
 * window — otherwise position is adjusted by translation only, width unchanged.
 */
export function clampWindow(w: Window, bounds: ZoomBounds): Window {
  const centre = (w.a + w.b) / 2;
  const rawWidth = width(w);
  let widthYears = clampNumber(rawWidth, MIN_WIDTH_YEARS, MAX_WINDOW_YEARS);

  let a = centre - widthYears / 2;
  let b = centre + widthYears / 2;

  const boundsWidth = bounds.max - bounds.min;
  if (widthYears > boundsWidth) {
    widthYears = boundsWidth;
    const c2 = (a + b) / 2;
    a = c2 - widthYears / 2;
    b = c2 + widthYears / 2;
  }

  if (a < bounds.min) {
    const d = bounds.min - a;
    a += d;
    b += d;
  } else if (b > bounds.max) {
    const d = b - bounds.max;
    a -= d;
    b -= d;
  }

  return { a, b };
}

/**
 * Zooms `w` by `factor` (< 1 zooms in, > 1 zooms out) around the year under
 * `cursorFrac` (0..1 across the lane). That year stays fixed by the visible
 * window, up to final clamping against the width limits and `bounds`.
 */
export function zoomAt(w: Window, cursorFrac: number, factor: number, bounds: ZoomBounds): Window {
  const frac = clampNumber(cursorFrac, 0, 1);
  const yearAtCursor = w.a + frac * width(w);
  const newWidth = clampNumber(width(w) * factor, MIN_WIDTH_YEARS, MAX_WINDOW_YEARS);
  const a = yearAtCursor - frac * newWidth;
  const b = a + newWidth;
  return clampWindow({ a, b }, bounds);
}

/** Wheel-to-zoom-factor curve: `deltaY > 0` (scroll down) zooms out. */
export function wheelZoomFactor(deltaY: number): number {
  return 1.0016 ** deltaY;
}

/** Shifts `w` by `dYears` (positive moves the window later) and clamps. */
export function panBy(w: Window, dYears: number, bounds: ZoomBounds): Window {
  return clampWindow({ a: w.a + dYears, b: w.b + dYears }, bounds);
}

/** Wheel-pan: shift proportional to the visible width. */
export function panByWheel(w: Window, delta: number, bounds: ZoomBounds): Window {
  const dt = delta * width(w) * 0.0012;
  return panBy(w, dt, bounds);
}

/** Drag-pan: dragging the ruler right (`dxPx > 0`) reveals earlier years. */
export function panByDrag(w: Window, dxPx: number, laneWidthPx: number, bounds: ZoomBounds): Window {
  const dt = -(dxPx / laneWidthPx) * width(w);
  return panBy(w, dt, bounds);
}

export type ZoomPreset = "day" | "month" | "season" | "year" | "era";

function centreOf(w: Window): number {
  return (w.a + w.b) / 2;
}

function centredWindow(centre: number, widthYears: number, bounds: ZoomBounds): Window {
  return clampWindow({ a: centre - widthYears / 2, b: centre + widthYears / 2 }, bounds);
}

/**
 * The window for a zoom preset, built around `current`'s centre (or, for
 * Season/Year, the calendar year the centre falls in).
 *
 * - Day = 3 days, Month = 30 days, both centred on the current centre.
 * - Season = the season containing the centre's `yearPhase`, from `seasons`
 *   (a quarter of the year when `seasons` is empty).
 * - Year = one calendar year, floored on the current centre.
 * - Era = 1000 years, centred on the current centre, clamped to `bounds`.
 */
export function presetWindow(
  p: ZoomPreset,
  current: Window,
  bounds: ZoomBounds,
  seasons: ReadonlyArray<{ name: string; from: number }>
): Window {
  const centre = centreOf(current);
  switch (p) {
    case "day":
      return centredWindow(centre, 3 / DAYS_PER_YEAR, bounds);
    case "month":
      return centredWindow(centre, 30 / DAYS_PER_YEAR, bounds);
    case "season": {
      const year = Math.floor(centre);
      const phase = centre - year;
      if (seasons.length === 0) {
        const q = clampNumber(Math.floor(phase * 4), 0, 3);
        return clampWindow({ a: year + q * 0.25, b: year + (q + 1) * 0.25 }, bounds);
      }
      const sorted = [...seasons].sort((x, y) => x.from - y.from);
      let idx = 0;
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i]!.from <= phase) idx = i;
      }
      const from = sorted[idx]!.from;
      const to = idx + 1 < sorted.length ? sorted[idx + 1]!.from : 1;
      return clampWindow({ a: year + from, b: year + to }, bounds);
    }
    case "year": {
      const year = Math.floor(centre);
      return clampWindow({ a: year, b: year + 1 }, bounds);
    }
    case "era":
      return centredWindow(centre, 1000, bounds);
  }
}

/**
 * The zoom-preset band `w` currently reads as, by width: `day` ≤ 9 days,
 * `month` ≤ 60 days, `season` ≤ 0.55 y, `year` ≤ 4 y, else `era`.
 */
export function zoomLabel(w: Window): ZoomPreset {
  const widthYears = width(w);
  const days = widthYears * DAYS_PER_YEAR;
  if (days <= 9 + EPSILON) return "day";
  if (days <= 60 + EPSILON) return "month";
  if (widthYears <= 0.55 + EPSILON) return "season";
  if (widthYears <= 4 + EPSILON) return "year";
  return "era";
}

/** The view morph for a window at a given lane width: density and mode flags. */
export function morph(
  w: Window,
  laneWidthPx: number
): { pxPerYear: number; pxPerDay: number; fine: boolean; isDay: boolean; showBands: boolean } {
  const pxPerYear = laneWidthPx / width(w);
  const pxPerDay = pxPerYear / DAYS_PER_YEAR;
  return {
    pxPerYear,
    pxPerDay,
    fine: pxPerYear >= 300,
    isDay: width(w) * DAYS_PER_YEAR <= 7.5,
    showBands: pxPerYear >= 150,
  };
}

export interface Tick {
  year: number;
  label: string;
  major: boolean;
}

interface Step {
  /** The tick spacing, in fractional years. */
  years: number;
  kind: "day" | "year";
}

/**
 * The tick spacing for the given pixel densities, finest first: per-day
 * (`pxPerDay > 26`), every 5 days (`> 4.5`), every 15 days (`> 1.1`),
 * per-year (`pxPerYear > 55`), every 10 years (`> 5.5`), else every 100 years.
 */
function chooseStep(pxPerDay: number, pxPerYear: number): Step {
  if (pxPerDay > 26) return { years: 1 / DAYS_PER_YEAR, kind: "day" };
  if (pxPerDay > 4.5) return { years: 5 / DAYS_PER_YEAR, kind: "day" };
  if (pxPerDay > 1.1) return { years: 15 / DAYS_PER_YEAR, kind: "day" };
  if (pxPerYear > 55) return { years: 1, kind: "year" };
  if (pxPerYear > 5.5) return { years: 10, kind: "year" };
  return { years: 100, kind: "year" };
}

/**
 * The tick plan for `w` at `laneWidthPx`: spacing follows the pixel-density
 * table (day ticks sit at day boundaries `year + d/365`, year ticks at
 * integer years); labels are thinned so at most one labelled tick lands per
 * ~24 px (`major: false` ticks are unlabeled but still returned, for minor
 * marks). `year`s are ascending.
 */
export function ticks(
  w: Window,
  laneWidthPx: number,
  format: { year(y: number): string; day(y: number, dayIndex: number): string }
): Tick[] {
  const { pxPerYear, pxPerDay } = morph(w, laneWidthPx);
  const step = chooseStep(pxPerDay, pxPerYear);

  const i0 = Math.ceil(w.a / step.years - EPSILON);
  const i1 = Math.floor(w.b / step.years + EPSILON);
  if (i1 < i0) return [];

  const count = i1 - i0 + 1;
  const cap = Math.max(1, Math.floor(laneWidthPx / PX_PER_LABEL));
  const thin = Math.max(1, Math.ceil(count / cap));

  const out: Tick[] = [];
  for (let i = i0; i <= i1; i++) {
    // `+ 0` folds a stray `-0` (e.g. `i === 0`, `step.years` fine) to `0`.
    const year = i * step.years + 0;
    const major = (i - i0) % thin === 0;
    let label = "";
    if (major) {
      if (step.kind === "day") {
        const y = Math.floor(year + EPSILON);
        const dayIndex = Math.round((year - y) * DAYS_PER_YEAR);
        label = format.day(y, dayIndex);
      } else {
        label = format.year(Math.round(year));
      }
    }
    out.push({ year, label, major });
  }
  return out;
}

/** The x position (px) of `y` within a lane of `laneWidthPx`, given `w`. */
export function yearToPx(y: number, w: Window, laneWidthPx: number): number {
  return ((y - w.a) / width(w)) * laneWidthPx;
}

/** The year at pixel `px` within a lane of `laneWidthPx`, given `w`. */
export function pxToYearAt(px: number, w: Window, laneWidthPx: number): number {
  return w.a + (px / laneWidthPx) * width(w);
}
