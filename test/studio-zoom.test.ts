import { describe, expect, test } from "bun:test";
import {
  BOUNDS_AFTER,
  BOUNDS_BEFORE,
  ERA_PAD,
  ERA_SPAN,
  MAX_WINDOW_YEARS,
  MIN_WINDOW_DAYS,
  clampWindow,
  eraFrame,
  morph,
  panBy,
  panByDrag,
  panByWheel,
  presetWindow,
  pxToYearAt,
  ticks,
  wheelZoomFactor,
  width,
  worldBounds,
  yearToPx,
  zoomAt,
  zoomLabel,
  type Window,
  type ZoomBounds,
} from "../src/studio/model/zoom";

const WIDE_BOUNDS: ZoomBounds = { min: -100000, max: 100000 };
const fmt = { year: (y: number) => `Y${y}`, day: (y: number, d: number) => `Y${y}D${d}` };

describe("zoom: width limits", () => {
  test("clampWindow enforces the 2-day minimum, centred", () => {
    const w = clampWindow({ a: 2000, b: 2000.001 }, WIDE_BOUNDS);
    expect(width(w)).toBeCloseTo(MIN_WINDOW_DAYS / 365, 12);
    // centred on the input window's own centre
    expect((w.a + w.b) / 2).toBeCloseTo(2000.0005, 9);
  });

  test("clampWindow enforces the 1100-year maximum, centred", () => {
    const w = clampWindow({ a: 0, b: 5000 }, WIDE_BOUNDS);
    expect(width(w)).toBeCloseTo(MAX_WINDOW_YEARS, 9);
    expect((w.a + w.b) / 2).toBeCloseTo(2500, 9);
  });

  test("clampWindow shrinks only when bounds are narrower than the window", () => {
    const bounds: ZoomBounds = { min: 0, max: 50 };
    const w = clampWindow({ a: -10, b: 60 }, bounds); // width 70 > bounds width 50
    expect(width(w)).toBeCloseTo(50, 9);
  });

  test("clampWindow does not shrink when bounds are wider than the window", () => {
    const bounds: ZoomBounds = { min: -1000, max: 1000 };
    const w = clampWindow({ a: 10, b: 20 }, bounds);
    expect(width(w)).toBeCloseTo(10, 9);
    expect(w).toEqual({ a: 10, b: 20 });
  });
});

describe("zoom: zoomAt invariant", () => {
  const w: Window = { a: 2000, b: 2010 };

  for (const cursorFrac of [0, 0.25, 0.5, 0.75, 1]) {
    for (const factor of [0.5, 0.9, 1.5, 3]) {
      test(`cursor year fixed at frac=${cursorFrac}, factor=${factor}`, () => {
        const yearBefore = w.a + cursorFrac * width(w);
        const after = zoomAt(w, cursorFrac, factor, WIDE_BOUNDS);
        const yearAfter = after.a + cursorFrac * width(after);
        expect(yearAfter).toBeCloseTo(yearBefore, 9);
      });
    }
  }

  test("zoomAt clamps width to the min/max limits", () => {
    const zoomedIn = zoomAt(w, 0.5, 1e-6, WIDE_BOUNDS);
    expect(width(zoomedIn)).toBeCloseTo(MIN_WINDOW_DAYS / 365, 9);

    const zoomedOut = zoomAt(w, 0.5, 1e6, WIDE_BOUNDS);
    expect(width(zoomedOut)).toBeCloseTo(MAX_WINDOW_YEARS, 9);
  });

  test("zoomAt clamped to bounds: cursor invariant is not guaranteed, but the window respects bounds", () => {
    const bounds: ZoomBounds = { min: 1995, max: 2015 };
    const after = zoomAt({ a: 2000, b: 2010 }, 1, 3, bounds); // zooming out anchored at the right edge
    expect(after.a).toBeGreaterThanOrEqual(bounds.min - 1e-9);
    expect(after.b).toBeLessThanOrEqual(bounds.max + 1e-9);
  });
});

describe("zoom: wheel factor", () => {
  test("deltaY = 0 is a no-op factor", () => {
    expect(wheelZoomFactor(0)).toBeCloseTo(1, 12);
  });

  test("deltaY > 0 zooms out (factor > 1)", () => {
    expect(wheelZoomFactor(100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeCloseTo(1.0016 ** 100, 9);
  });

  test("deltaY < 0 zooms in (factor < 1)", () => {
    expect(wheelZoomFactor(-100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.0016 ** -100, 9);
  });
});

describe("zoom: pan", () => {
  test("panBy shifts both endpoints and clamps to bounds", () => {
    const bounds: ZoomBounds = { min: 0, max: 100 };
    const w: Window = { a: 90, b: 95 };
    const panned = panBy(w, 20, bounds); // would land {110,115}; clamped back by 15
    expect(panned).toEqual({ a: 95, b: 100 });
  });

  test("panBy within bounds is an exact shift", () => {
    const w: Window = { a: 10, b: 20 };
    expect(panBy(w, 5, WIDE_BOUNDS)).toEqual({ a: 15, b: 25 });
  });

  test("panByWheel scales the shift by width * 0.0012", () => {
    const w: Window = { a: 90, b: 95 }; // width 5
    const panned = panByWheel(w, 10, WIDE_BOUNDS);
    const expectedDt = 10 * 5 * 0.0012;
    expect(panned.a).toBeCloseTo(90 + expectedDt, 9);
    expect(panned.b).toBeCloseTo(95 + expectedDt, 9);
  });

  test("panByDrag: dragging right (dxPx > 0) reveals earlier years", () => {
    const w: Window = { a: 100, b: 110 }; // width 10
    const panned = panByDrag(w, 100, 1000, WIDE_BOUNDS); // dt = -(100/1000)*10 = -1
    expect(panned.a).toBeCloseTo(99, 9);
    expect(panned.b).toBeCloseTo(109, 9);
  });

  test("panByDrag: dragging left (dxPx < 0) reveals later years", () => {
    const w: Window = { a: 100, b: 110 };
    const panned = panByDrag(w, -100, 1000, WIDE_BOUNDS);
    expect(panned.a).toBeCloseTo(101, 9);
    expect(panned.b).toBeCloseTo(111, 9);
  });
});

describe("zoom: presets", () => {
  const bounds: ZoomBounds = { min: 1900, max: 3100 };
  const current: Window = { a: 2005.5, b: 2005.7 }; // centre 2005.6

  test("day = 3 days centred on the current centre", () => {
    const w = presetWindow("day", current, bounds, []);
    expect(width(w)).toBeCloseTo(3 / 365, 12);
    expect((w.a + w.b) / 2).toBeCloseTo(2005.6, 9);
  });

  test("month = 30 days centred on the current centre", () => {
    const w = presetWindow("month", current, bounds, []);
    expect(width(w)).toBeCloseTo(30 / 365, 12);
    expect((w.a + w.b) / 2).toBeCloseTo(2005.6, 9);
  });

  test("season with 4 seasons: the season containing the centre's yearPhase", () => {
    const seasons = [
      { name: "Spring", from: 0 },
      { name: "Summer", from: 0.25 },
      { name: "Autumn", from: 0.5 },
      { name: "Winter", from: 0.75 },
    ];
    const w = presetWindow("season", current, bounds, seasons); // phase 0.6 -> Autumn [0.5,0.75)
    expect(w.a).toBeCloseTo(2005.5, 9);
    expect(w.b).toBeCloseTo(2005.75, 9);
  });

  test("season with no seasons: falls back to a quarter of the year", () => {
    const w = presetWindow("season", current, bounds, []); // phase 0.6 -> quarter index 2 -> [0.5,0.75)
    expect(w.a).toBeCloseTo(2005.5, 9);
    expect(w.b).toBeCloseTo(2005.75, 9);
  });

  test("year = one calendar year, floored on the current centre", () => {
    const w = presetWindow("year", current, bounds, []);
    expect(w).toEqual({ a: 2005, b: 2006 });
  });

  test("era = 1000 years centred on the current centre, unclamped case", () => {
    const w = presetWindow("era", current, WIDE_BOUNDS, []);
    expect(w.a).toBeCloseTo(2005.6 - 500, 6);
    expect(w.b).toBeCloseTo(2005.6 + 500, 6);
  });

  test("era clamped to bounds when the centred window would spill over", () => {
    const narrowBounds: ZoomBounds = { min: 1000, max: 3000 };
    const nearEdge: Window = { a: 1004.9, b: 1005.1 }; // centre 1005
    const w = presetWindow("era", nearEdge, narrowBounds, []);
    expect(w.a).toBeCloseTo(1000, 9); // 505..1505 shifted up to the bound
    expect(w.b).toBeCloseTo(2000, 9);
  });

  test("era FRAMES the world's eras when it has any, wherever the reader was", () => {
    // The audit world: Ice Age 1200–1900, Thaw 1901–1950, Long Summer 1951–∞.
    const eras = [
      { name: "Ice Age", from: 1200, to: 1900 },
      { name: "Thaw", from: 1901, to: 1950 },
      { name: "Long Summer", from: 1951 },
    ];
    const bounds = worldBounds(1, eras);
    const w = presetWindow("era", { a: 0, b: 1 }, bounds, [], eras);
    // The prototype's own `setWin(1100, 2100)`.
    expect(w.a).toBeCloseTo(1100, 9);
    expect(w.b).toBeCloseTo(2100, 9);
  });

  test("a disabled era is not framed, and a world with none keeps the centred window", () => {
    expect(eraFrame([{ name: "Off", from: 1200, to: 1900, enabled: false }])).toBeNull();
    expect(eraFrame([])).toBeNull();
    const w = presetWindow("era", current, WIDE_BOUNDS, [], [{ name: "Off", from: 1200, enabled: false }]);
    expect(w.a).toBeCloseTo(2005.6 - ERA_SPAN / 2, 6);
  });

  test("the frame grows past ERA_SPAN when the eras themselves are wider", () => {
    expect(eraFrame([{ name: "Long", from: 200, to: 1800 }])).toEqual({ a: 100, b: 1900 });
  });
});

describe("zoom: worldBounds", () => {
  test("with no eras it is the epoch's own reach", () => {
    expect(worldBounds(1)).toEqual({ min: 1 - BOUNDS_BEFORE, max: 1 + BOUNDS_AFTER });
  });

  test("an era past the epoch's reach widens it, so the era is reachable at all", () => {
    // Without this the audit world's eras (1200–) sit outside `epoch + 1100`
    // and the Eras lane reads empty at every zoom.
    const b = worldBounds(1, [{ name: "Ice Age", from: 1200, to: 1900 }, { name: "Long Summer", from: 1951 }]);
    expect(b.min).toBe(1 - BOUNDS_BEFORE);
    expect(b.max).toBeGreaterThanOrEqual(2100);
    expect(clampWindow({ a: 1100, b: 2100 }, b)).toEqual({ a: 1100, b: 2100 });
  });

  test("an era BEFORE the epoch widens the other end", () => {
    expect(worldBounds(1000, [{ name: "Deep past", from: 10, to: 20 }]).min).toBe(10 - ERA_PAD);
  });
});

describe("zoom: zoomLabel thresholds", () => {
  const atDays = (days: number): Window => ({ a: 2000, b: 2000 + days / 365 });
  const atYears = (years: number): Window => ({ a: 2000, b: 2000 + years });

  test("day at and just past the 9-day threshold", () => {
    expect(zoomLabel(atDays(9))).toBe("day");
    expect(zoomLabel(atDays(9.001))).toBe("month");
  });

  test("month at and just past the 60-day threshold", () => {
    expect(zoomLabel(atDays(60))).toBe("month");
    expect(zoomLabel(atDays(60.1))).toBe("season");
  });

  test("season at and just past the 0.55-year threshold", () => {
    expect(zoomLabel(atYears(0.55))).toBe("season");
    expect(zoomLabel(atYears(0.5501))).toBe("year");
  });

  test("year at and just past the 4-year threshold", () => {
    expect(zoomLabel(atYears(4))).toBe("year");
    expect(zoomLabel(atYears(4.001))).toBe("era");
  });
});

describe("zoom: morph thresholds", () => {
  test("fine flips exactly at pxPerYear = 300", () => {
    const w: Window = { a: 0, b: 10 };
    expect(morph(w, 3000).fine).toBe(true); // pxPerYear = 300
    expect(morph(w, 2999).fine).toBe(false);
  });

  test("isDay flips exactly at width*365 = 7.5 days", () => {
    const atThreshold: Window = { a: 0, b: 7.5 / 365 };
    const justOver: Window = { a: 0, b: 7.50001 / 365 };
    expect(morph(atThreshold, 1000).isDay).toBe(true);
    expect(morph(justOver, 1000).isDay).toBe(false);
  });

  test("showBands flips exactly at pxPerYear = 150", () => {
    const w: Window = { a: 0, b: 10 };
    expect(morph(w, 1500).showBands).toBe(true); // pxPerYear = 150
    expect(morph(w, 1499).showBands).toBe(false);
  });

  test("pxPerDay is pxPerYear / 365", () => {
    const w: Window = { a: 0, b: 10 };
    const m = morph(w, 3650);
    expect(m.pxPerYear).toBeCloseTo(365, 9);
    expect(m.pxPerDay).toBeCloseTo(1, 9);
  });
});

describe("zoom: ticks", () => {
  test("per-day ticks at day boundaries when pxPerDay > 26", () => {
    const w: Window = { a: 2000, b: 2000 + 10 / 365 }; // 10-day window
    const t = ticks(w, 2000, fmt); // pxPerYear = 73000, pxPerDay = 200
    expect(t.length).toBe(11);
    expect(t.every((x) => x.major)).toBe(true);
    expect(t[0]!.year).toBeCloseTo(2000, 9);
    expect(t[0]!.label).toBe("Y2000D0");
    expect(t[5]!.label).toBe("Y2000D5");
    // monotonic
    for (let i = 1; i < t.length; i++) expect(t[i]!.year).toBeGreaterThan(t[i - 1]!.year);
  });

  test("tick density never exceeds ~laneWidthPx/24 labelled ticks", () => {
    const w: Window = { a: 2000, b: 2000 + 10 / 365 };
    const laneWidthPx = 100;
    const t = ticks(w, laneWidthPx, fmt);
    const majorCount = t.filter((x) => x.major).length;
    expect(majorCount).toBeLessThanOrEqual(Math.floor(laneWidthPx / 24));
  });

  test("per-year ticks when pxPerYear > 55 (and pxPerDay <= 1.1)", () => {
    const w: Window = { a: 1000, b: 1100 }; // 100 years
    const t = ticks(w, 6000, fmt); // pxPerYear = 60
    expect(t.length).toBe(101);
    expect(t[0]!.year).toBe(1000);
    expect(t[0]!.label).toBe("Y1000");
    expect(t[100]!.year).toBe(1100);
    for (let i = 1; i < t.length; i++) expect(t[i]!.year).toBeGreaterThan(t[i - 1]!.year);
  });

  test("every-100-years ticks at the widest zoom", () => {
    const w: Window = { a: 0, b: 1100 };
    const t = ticks(w, 600, fmt); // pxPerYear ~ 0.545
    expect(t.map((x) => x.year)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]);
    expect(t.every((x) => x.major)).toBe(true);
    expect(t.every((x) => x.label.startsWith("Y"))).toBe(true);
  });

  test("tick density never exceeds the cap across a sweep of zoom levels", () => {
    const windows: Window[] = [
      { a: 2000, b: 2000 + 3 / 365 },
      { a: 2000, b: 2000 + 30 / 365 },
      { a: 2000, b: 2000.25 },
      { a: 2000, b: 2001 },
      { a: 2000, b: 2010 },
      { a: 1500, b: 2600 },
      { a: 900, b: 2000 },
    ];
    for (const w of windows) {
      for (const laneWidthPx of [200, 600, 1200, 2400]) {
        const t = ticks(w, laneWidthPx, fmt);
        const majorCount = t.filter((x) => x.major).length;
        expect(majorCount).toBeLessThanOrEqual(Math.max(1, Math.floor(laneWidthPx / 24)));
        for (let i = 1; i < t.length; i++) expect(t[i]!.year).toBeGreaterThan(t[i - 1]!.year);
      }
    }
  });
});

describe("zoom: px round-trips", () => {
  test("yearToPx / pxToYearAt invert each other", () => {
    const w: Window = { a: 1990, b: 2050 };
    const laneWidthPx = 1234;
    for (const y of [1990, 2000, 2020, 2049.5, 2050]) {
      const px = yearToPx(y, w, laneWidthPx);
      expect(pxToYearAt(px, w, laneWidthPx)).toBeCloseTo(y, 9);
    }
    for (const px of [0, 100, 617, 1234]) {
      const y = pxToYearAt(px, w, laneWidthPx);
      expect(yearToPx(y, w, laneWidthPx)).toBeCloseTo(px, 9);
    }
  });

  test("yearToPx: a at px 0, b at laneWidthPx", () => {
    const w: Window = { a: 100, b: 200 };
    expect(yearToPx(100, w, 500)).toBeCloseTo(0, 9);
    expect(yearToPx(200, w, 500)).toBeCloseTo(500, 9);
    expect(yearToPx(150, w, 500)).toBeCloseTo(250, 9);
  });
});
