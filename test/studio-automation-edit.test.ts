/**
 * `src/studio/model/automation-edit.ts` — the four gestures the FRC · warmth
 * lane accepts, held against the real validator (`validateProfile`, which
 * runs `validateAutomation` for the `automation[]` block) so every edit is
 * proven to leave a legal draft, and against `compile.ts`'s own
 * `getWarmthLane` / `WARMTH_LANE_ID` so the lane this file edits is the lane
 * the compiler reads.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { laneValue } from "../src/core/automation";
import { validateProfile } from "../src/core/profile";
import type { Preset, ZoneProfile } from "../src/core/types";
import { zoneFromPreset } from "../src/plugin/zones";
import {
  addPoint,
  DEFAULT_LANE_SPAN_YEARS,
  ensureLane,
  hasLane,
  LANE_MIN_Y_SPAN,
  lanePoints,
  laneYRange,
  MIN_LANE_POINTS,
  movePoint,
  removePoint,
  type LaneBounds,
  type LanePoint,
} from "../src/studio/model/automation-edit";
import { getWarmthLane, WARMTH_LANE_ID } from "../src/studio/model/compile";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const fjord = presets.find((p) => p.id === "fjord-coast")!;

const EPOCH = 1900;

function zone(): ZoneProfile {
  return zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone;
}

function errors(z: ZoneProfile): string[] {
  return validateProfile(z)
    .filter((i) => i.level === "error")
    .map((i) => `${i.path}: ${i.message}`);
}

const BOUNDS: LaneBounds = { minYear: EPOCH - 100, maxYear: EPOCH + 1100, minValue: -20, maxValue: 20 };

function seeded(): ZoneProfile {
  const z = zone();
  ensureLane(z, EPOCH);
  return z;
}

describe("automation-edit · ensureLane", () => {
  test("draws two neutral points a century apart and leaves the draft clean", () => {
    const z = zone();
    expect(hasLane(z)).toBe(false);
    expect(ensureLane(z, EPOCH)).toBe(true);
    expect(lanePoints(z)).toEqual([
      [EPOCH, 0],
      [EPOCH + DEFAULT_LANE_SPAN_YEARS, 0],
    ]);
    expect(getWarmthLane(z).id).toBe(WARMTH_LANE_ID);
    expect(getWarmthLane(z).param).toBe("temperature.mean");
    expect(getWarmthLane(z).op).toBe("offset");
    expect(errors(z)).toEqual([]);
  });

  test("never flattens a lane that already exists", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 4);
    const before = lanePoints(z);
    expect(ensureLane(z, EPOCH)).toBe(false);
    expect(lanePoints(z)).toEqual(before);
  });

  test("a fractional epoch still lands on a whole year", () => {
    const z = zone();
    ensureLane(z, 1900.6);
    expect(lanePoints(z)[0]![0]).toBe(1901);
    expect(errors(z)).toEqual([]);
  });
});

describe("automation-edit · addPoint", () => {
  test("keeps the years ascending wherever the point lands", () => {
    const z = seeded();
    expect(addPoint(z, EPOCH + 50, 4)).toBe(1);
    expect(addPoint(z, EPOCH - 10, -1)).toBe(0);
    expect(addPoint(z, EPOCH + 500, 2)).toBe(4);
    expect(lanePoints(z).map((p) => p[0])).toEqual([EPOCH - 10, EPOCH, EPOCH + 50, EPOCH + 100, EPOCH + 500]);
    expect(errors(z)).toEqual([]);
  });

  test("a point dropped on a year already taken replaces it, it does not double it", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 4);
    expect(addPoint(z, EPOCH + 50.4, -3)).toBe(1);
    expect(lanePoints(z)).toEqual([
      [EPOCH, 0],
      [EPOCH + 50, -3],
      [EPOCH + 100, 0],
    ]);
    expect(errors(z)).toEqual([]);
  });

  test("the year is rounded, so two adjacent drags cannot collide", () => {
    const z = seeded();
    addPoint(z, EPOCH + 20.4, 1);
    addPoint(z, EPOCH + 21.6, 2);
    expect(lanePoints(z).map((p) => p[0])).toEqual([EPOCH, EPOCH + 20, EPOCH + 22, EPOCH + 100]);
    expect(errors(z)).toEqual([]);
  });

  test("a non-finite pair writes nothing", () => {
    const z = seeded();
    expect(addPoint(z, Number.NaN, 3)).toBe(-1);
    expect(addPoint(z, EPOCH + 5, Number.POSITIVE_INFINITY)).toBe(-1);
    expect(lanePoints(z).length).toBe(2);
  });

  test("the added point is what the engine reads back at that year", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 4);
    expect(laneValue(getWarmthLane(z), EPOCH + 50)).toBeCloseTo(4, 10);
    expect(laneValue(getWarmthLane(z), EPOCH + 25)).toBeCloseTo(2, 10);
  });
});

describe("automation-edit · movePoint", () => {
  test("drags a point in both axes and stays clean", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 0);
    expect(movePoint(z, 1, EPOCH + 60.4, 3.5, BOUNDS)).toBe(true);
    expect(lanePoints(z)[1]).toEqual([EPOCH + 60, 3.5]);
    expect(errors(z)).toEqual([]);
  });

  test("cannot cross the point on its left or its right", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 0);
    movePoint(z, 1, EPOCH - 500, 0, BOUNDS);
    expect(lanePoints(z)[1]![0]).toBe(EPOCH + 1);
    movePoint(z, 1, EPOCH + 5000, 0, BOUNDS);
    expect(lanePoints(z)[1]![0]).toBe(EPOCH + 99);
    expect(errors(z)).toEqual([]);
  });

  test("neighbours one year either side leave the point where it is", () => {
    const z = seeded();
    addPoint(z, EPOCH + 1, 0);
    addPoint(z, EPOCH + 2, 0);
    expect(movePoint(z, 1, EPOCH + 40, 0, BOUNDS)).toBe(false);
    expect(lanePoints(z)[1]![0]).toBe(EPOCH + 1);
    expect(errors(z)).toEqual([]);
  });

  test("the end points clamp to the bounds, and the value clamps to the drawn range", () => {
    const z = seeded();
    movePoint(z, 0, BOUNDS.minYear - 400, BOUNDS.minValue - 50, BOUNDS);
    expect(lanePoints(z)[0]).toEqual([BOUNDS.minYear, BOUNDS.minValue]);
    movePoint(z, 1, BOUNDS.maxYear + 400, BOUNDS.maxValue + 50, BOUNDS);
    expect(lanePoints(z)[1]).toEqual([BOUNDS.maxYear, BOUNDS.maxValue]);
    expect(errors(z)).toEqual([]);
  });

  test("a frame that moves nothing writes nothing, and an unknown index is refused", () => {
    const z = seeded();
    expect(movePoint(z, 0, EPOCH + 0.2, 0, BOUNDS)).toBe(false);
    expect(movePoint(z, 7, EPOCH + 10, 1, BOUNDS)).toBe(false);
    expect(movePoint(z, 0, Number.NaN, 0, BOUNDS)).toBe(false);
  });
});

describe("automation-edit · removePoint", () => {
  test("drops a point when three are drawn", () => {
    const z = seeded();
    addPoint(z, EPOCH + 50, 4);
    expect(removePoint(z, 1)).toBe(true);
    expect(lanePoints(z).length).toBe(MIN_LANE_POINTS);
    expect(errors(z)).toEqual([]);
  });

  test("refuses the removal that would leave one point", () => {
    const z = seeded();
    expect(removePoint(z, 0)).toBe(false);
    expect(removePoint(z, 1)).toBe(false);
    expect(lanePoints(z).length).toBe(MIN_LANE_POINTS);
    expect(errors(z)).toEqual([]);
  });

  test("an unknown index is refused", () => {
    const z = seeded();
    expect(removePoint(z, 4)).toBe(false);
    expect(removePoint(z, -1)).toBe(false);
  });

  test("a lane already down to one point is removed outright, not left as a stub", () => {
    const z = zone();
    z.automation = [{ id: WARMTH_LANE_ID, param: "temperature.mean", op: "offset", points: [[EPOCH, 3]] }];
    expect(removePoint(z, 0)).toBe(true);
    expect(z.automation).toBeUndefined();
    expect(hasLane(z)).toBe(false);
    expect(errors(z)).toEqual([]);
  });
});

describe("automation-edit · laneYRange", () => {
  test("pads the points by 2 °C once the span is wide enough", () => {
    const points: LanePoint[] = [
      [EPOCH, -6],
      [EPOCH + 50, 6],
    ];
    expect(laneYRange(points)).toEqual([-8, 8]);
  });

  test("a flat lane still gets the minimum span, centred on the points", () => {
    const [lo, hi] = laneYRange([
      [EPOCH, 3],
      [EPOCH + 50, 3],
    ]);
    expect(hi - lo).toBeCloseTo(LANE_MIN_Y_SPAN, 10);
    expect((lo + hi) / 2).toBeCloseTo(3, 10);
  });

  test("no points at all is the flat case about zero", () => {
    const [lo, hi] = laneYRange([]);
    expect(hi - lo).toBeCloseTo(LANE_MIN_Y_SPAN, 10);
    expect((lo + hi) / 2).toBeCloseTo(0, 10);
  });
});

describe("automation-edit · the row's chart padding mirrors the component's", () => {
  test("CHART_PAD in automation-row.ts equals PAD in components/chart.ts", async () => {
    const chart = await Bun.file(new URL("../src/studio/ui/components/chart.ts", import.meta.url)).text();
    const row = await Bun.file(new URL("../src/studio/ui/rows/automation-row.ts", import.meta.url)).text();
    const pad = /^const PAD = (\d+);$/m.exec(chart)?.[1];
    const mirror = /^const CHART_PAD = (\d+);$/m.exec(row)?.[1];
    expect(pad).toBeDefined();
    expect(mirror).toBe(pad);
  });
});

/**
 * The FRC lane's 0 °C rule is the reading the row is *about*, and where it sits
 * is data, not decoration: the prototype's own map is `y = 8 − v · 2.4` over a
 * 34 px lane, so neutral sits a quarter of the way down and the lane keeps its
 * room for the deep excursions warmth actually takes. A data-derived range
 * centres it instead, which is the regression this pins. The row cannot be
 * imported under `bun test` (it draws with `obsidian`), so the constants are
 * read from its source, as `CHART_PAD` above is.
 */
describe("automation-edit · the row's neutral line sits where the prototype's does", () => {
  test("0 °C lands 8 px into a 34 px lane, edge to edge", async () => {
    const row = await Bun.file(new URL("../src/studio/ui/rows/automation-row.ts", import.meta.url)).text();
    const neutral = Number(/^const NEUTRAL_PX = ([\d.]+);$/m.exec(row)?.[1]);
    const height = Number(/^const ROW_HEIGHT = (\d+);$/m.exec(row)?.[1]);
    const perPx = /^const DEGREES_PER_PX = 1 \/ ([\d.]+);$/m.exec(row)?.[1];
    expect(height).toBe(34);
    expect(neutral).toBe(8);
    expect(perPx).toBe("2.4");
    expect(neutral / height).toBeCloseTo(8 / 34, 10);
    // A vertical inset would push the rule down off that pixel, so the lane
    // plots edge to edge and carries its headroom inside the scale instead.
    expect(row).toContain("top: 0, bottom: 0");
  });
});
