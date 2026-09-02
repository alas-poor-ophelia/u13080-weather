import { describe, expect, test } from "bun:test";
import { seasonAtPhase } from "../src/plugin/time/seasons";
import {
  PHASE_LIMITS,
  SEASON_LIMITS,
  angleOf,
  dragMark,
  evenMarks,
  fromPhases,
  fromSeasons,
  markAt,
  merge,
  normalise,
  phaseOfAngle,
  rename,
  segments,
  split,
  splitLongest,
  toPhases,
  toSeasons,
  validateMarks,
  type Mark,
  type MarkLimits,
} from "../src/studio/model/boundaries";

const FOUR_SEASONS: Mark[] = [
  { name: "Spring", at: 0 },
  { name: "Summer", at: 0.25 },
  { name: "Autumn", at: 0.5 },
  { name: "Winter", at: 0.75 },
];

const OFFSET_LAYOUT: Mark[] = [
  { name: "A", at: 0.6 },
  { name: "B", at: 0.1 },
  { name: "C", at: 0.9 },
];

const SINGLE: Mark[] = [{ name: "All year", at: 0.3 }];

describe("normalise", () => {
  test("sorts by at", () => {
    const n = normalise(OFFSET_LAYOUT);
    expect(n.map((m) => m.name)).toEqual(["B", "A", "C"]);
    expect(n.map((m) => m.at)).toEqual([0.1, 0.6, 0.9]);
  });

  test("wraps ats into [0,1)", () => {
    const n = normalise([
      { name: "X", at: 1.25 },
      { name: "Y", at: -0.1 },
    ]);
    expect(n.find((m) => m.name === "X")!.at).toBeCloseTo(0.25, 12);
    expect(n.find((m) => m.name === "Y")!.at).toBeCloseTo(0.9, 12);
  });

  test("returns copies, not the input objects", () => {
    const n = normalise(FOUR_SEASONS);
    n[0]!.name = "Mutated";
    expect(FOUR_SEASONS[0]!.name).toBe("Spring");
  });
});

describe("segments", () => {
  test("four even seasons", () => {
    const segs = segments(FOUR_SEASONS);
    expect(segs).toEqual([
      { name: "Spring", from: 0, to: 0.25, length: 0.25 },
      { name: "Summer", from: 0.25, to: 0.5, length: 0.25 },
      { name: "Autumn", from: 0.5, to: 0.75, length: 0.25 },
      { name: "Winter", from: 0.75, to: 0, length: 0.25 },
    ]);
  });

  test("single mark covers the whole circle", () => {
    const segs = segments(SINGLE);
    expect(segs).toEqual([{ name: "All year", from: 0.3, to: 0.3, length: 1 }]);
  });

  test("wrap segment length is computed correctly", () => {
    const segs = segments(OFFSET_LAYOUT); // sorted: B .1, A .6, C .9
    const wrap = segs.find((s) => s.name === "C")!;
    expect(wrap.from).toBeCloseTo(0.9, 12);
    expect(wrap.to).toBeCloseTo(0.1, 12);
    expect(wrap.length).toBeCloseTo(0.2, 12);
  });

  test("lengths always sum to 1", () => {
    const segs = segments(OFFSET_LAYOUT);
    const total = segs.reduce((sum, s) => sum + s.length, 0);
    expect(total).toBeCloseTo(1, 9);
  });
});

describe("markAt matches seasonAtPhase", () => {
  const layouts = [FOUR_SEASONS, OFFSET_LAYOUT, SINGLE];
  for (const layout of layouts) {
    test(`layout starting ${layout[0]!.name}`, () => {
      const seasonMarks = toSeasons(layout);
      for (let i = 0; i < 100; i++) {
        const phase = i / 100;
        expect(markAt(layout, phase)!.name).toBe(seasonAtPhase(seasonMarks, phase)!);
      }
    });
  }

  test("empty input returns null", () => {
    expect(markAt([], 0.5)).toBeNull();
  });
});

describe("dragMark", () => {
  test("clamps against both neighbours (interior index)", () => {
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.1 };
    // try to drag Summer (.25) onto Spring (0)
    const dragged = dragMark(FOUR_SEASONS, 1, 0.01, limits);
    const summer = dragged[1]!;
    expect(summer.at).toBeGreaterThanOrEqual(0 + limits.minGap - 1e-9);
    // and past Autumn (.5)
    const draggedHigh = dragMark(FOUR_SEASONS, 1, 0.9, limits);
    expect(draggedHigh[1]!.at).toBeLessThanOrEqual(0.5 - limits.minGap + 1e-9);
  });

  test("index 0 may move, clamped across the wrap to the last mark", () => {
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.1 };
    // Spring (0) dragged past Winter (.75) going backwards
    const dragged = dragMark(FOUR_SEASONS, 0, 0.76, limits);
    expect(dragged[0]!.at).toBeLessThanOrEqual(0.75 + limits.minGap + 1e-9);
    expect(dragged[0]!.at).toBeGreaterThanOrEqual(0.75 + limits.minGap - 1e-9);

    // dragged forward, clamped before Summer (.25)
    const draggedFwd = dragMark(FOUR_SEASONS, 0, 0.24, limits);
    expect(draggedFwd[0]!.at).toBeLessThanOrEqual(0.25 - limits.minGap + 1e-9);
  });

  test("last index clamps across the wrap to mark 0", () => {
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.1 };
    // Winter (.75) dragged near Spring (0), wrapping
    const dragged = dragMark(FOUR_SEASONS, 3, 0.99, limits);
    // must stay >= .1 before wrap-around to Spring(0) i.e. at <= 0.9, and >= .5+.1
    expect(dragged[3]!.at).toBeGreaterThanOrEqual(0.5 + limits.minGap - 1e-9);
    expect(dragged[3]!.at).toBeLessThanOrEqual(1 - limits.minGap + 1e-9);
  });

  test("single mark can move freely", () => {
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.1 };
    const dragged = dragMark(SINGLE, 0, 0.87, limits);
    expect(dragged[0]!.at).toBeCloseTo(0.87, 12);
  });

  test("n === 2: neighbours share the same other mark, whole circle available", () => {
    const two: Mark[] = [
      { name: "X", at: 0 },
      { name: "Y", at: 0.5 },
    ];
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.05 };
    const dragged = dragMark(two, 0, 0.9, limits);
    expect(dragged[0]!.at).toBeCloseTo(0.9, 9);
    expect(dragged[0]!.at).toBeLessThanOrEqual(0.5 + (1 - limits.minGap) + 1e-9);
  });
});

describe("split", () => {
  test("splits inside each segment of a 4-season layout", () => {
    const segs = segments(FOUR_SEASONS);
    for (const seg of segs) {
      const mid = (seg.from + seg.length / 2) % 1;
      const result = split(FOUR_SEASONS, mid, SEASON_LIMITS)!;
      expect(result).not.toBeNull();
      expect(result.length).toBe(5);
      expect(new Set(result.map((m) => m.name)).size).toBe(5);
    }
  });

  test("default name is '<segment name> 2', bumped if taken", () => {
    const result = split(FOUR_SEASONS, 0.1, SEASON_LIMITS)!;
    expect(result.some((m) => m.name === "Spring 2")).toBe(true);

    const withTaken: Mark[] = [...FOUR_SEASONS, { name: "Spring 2", at: 0.2 }];
    // Spring's own segment is now [0, .2); split it again, still inside Spring's territory
    const withTakenLimits: MarkLimits = { min: 1, max: 10, minGap: 0.01 };
    const result2 = split(withTaken, 0.1, withTakenLimits)!;
    expect(result2.some((m) => m.name === "Spring 3")).toBe(true);
  });

  test("explicit name is used as-is (trimmed)", () => {
    const result = split(FOUR_SEASONS, 0.1, SEASON_LIMITS, "  Thaw  ")!;
    expect(result.some((m) => m.name === "Thaw")).toBe(true);
  });

  test("refuses at the count limit", () => {
    const six: Mark[] = evenMarks(["A", "B", "C", "D", "E", "F"]);
    expect(split(six, 0.05, SEASON_LIMITS)).toBeNull();
  });

  test("refuses when a resulting half would be below minGap", () => {
    const limits: MarkLimits = { min: 1, max: 6, minGap: 0.1 };
    // Spring segment is [0, .25); splitting at .05 leaves a .05 half < .1
    expect(split(FOUR_SEASONS, 0.05, limits)).toBeNull();
    // but splitting near the middle is fine
    expect(split(FOUR_SEASONS, 0.125, limits)).not.toBeNull();
  });

  test("splits the wrap segment", () => {
    const result = split(FOUR_SEASONS, 0.9, SEASON_LIMITS)!;
    expect(result).not.toBeNull();
    expect(result.some((m) => m.name === "Winter 2")).toBe(true);
  });
});

describe("splitLongest", () => {
  test("picks the wrap segment when it is longest", () => {
    const marks: Mark[] = [
      { name: "A", at: 0.1 },
      { name: "B", at: 0.3 },
      { name: "C", at: 0.4 }, // wrap segment C->A is 0.7 long, the longest
    ];
    const result = splitLongest(marks, SEASON_LIMITS)!;
    expect(result).not.toBeNull();
    expect(result.length).toBe(4);
    expect(result.some((m) => m.name === "C 2")).toBe(true);
    // the new mark should land in the middle of the wrap segment: 0.4 + 0.7/2 = 0.75 (mod 1)
    const inserted = result.find((m) => m.name === "C 2")!;
    expect(inserted.at).toBeCloseTo(0.75, 9);
  });

  test("halves the longest of an uneven layout", () => {
    const marks: Mark[] = [
      { name: "A", at: 0 },
      { name: "B", at: 0.1 },
      { name: "C", at: 0.2 },
    ];
    // A's segment [0,.1) and B's [.1,.2) are short; C's wrap segment [.2,1) i.e. length .8 is longest
    const result = splitLongest(marks, SEASON_LIMITS)!;
    expect(result.length).toBe(4);
  });

  test("returns null when refused (e.g. at the count limit)", () => {
    const six: Mark[] = evenMarks(["A", "B", "C", "D", "E", "F"]);
    expect(splitLongest(six, SEASON_LIMITS)).toBeNull();
  });
});

describe("merge", () => {
  test("merges an interior mark's segment into the previous one", () => {
    const result = merge(FOUR_SEASONS, 1, SEASON_LIMITS)!; // remove Summer
    expect(result.map((m) => m.name)).toEqual(["Spring", "Autumn", "Winter"]);
    // Spring's segment now extends through what was Summer's territory
    const segs = segments(result);
    const spring = segs.find((s) => s.name === "Spring")!;
    expect(spring.length).toBeCloseTo(0.5, 9);
  });

  test("index 0 merges into the last mark, across the wrap", () => {
    const result = merge(FOUR_SEASONS, 0, SEASON_LIMITS)!; // remove Spring
    expect(result.map((m) => m.name)).toEqual(["Summer", "Autumn", "Winter"]);
    const segs = segments(result);
    const winter = segs.find((s) => s.name === "Winter")!;
    // Winter's wrap segment now runs .75 -> .25 (absorbing Spring's old territory)
    expect(winter.from).toBeCloseTo(0.75, 9);
    expect(winter.to).toBeCloseTo(0.25, 9);
    expect(winter.length).toBeCloseTo(0.5, 9);
  });

  test("refuses at the minimum", () => {
    expect(merge(SINGLE, 0, SEASON_LIMITS)).toBeNull();
    const two: Mark[] = [
      { name: "A", at: 0 },
      { name: "B", at: 0.5 },
    ];
    expect(merge(two, 0, { min: 2, max: 6, minGap: 0.01 })).toBeNull();
  });
});

describe("rename", () => {
  test("trims the name", () => {
    const result = rename(FOUR_SEASONS, 0, "  Highsun  ");
    expect(result[0]!.name).toBe("Highsun");
    expect(result[0]!.at).toBe(0);
  });

  test("does not enforce uniqueness", () => {
    const result = rename(FOUR_SEASONS, 0, "Summer");
    expect(result[0]!.name).toBe("Summer");
    expect(result[1]!.name).toBe("Summer");
  });
});

describe("validateMarks", () => {
  test("clean layout has no issues", () => {
    expect(validateMarks(FOUR_SEASONS, SEASON_LIMITS)).toEqual([]);
  });

  test("count out of range", () => {
    expect(validateMarks([], SEASON_LIMITS).some((i) => i.message.includes("marks"))).toBe(true);
    const seven = evenMarks(["A", "B", "C", "D", "E", "F", "G"]);
    expect(validateMarks(seven, SEASON_LIMITS).some((i) => i.message.includes("marks"))).toBe(true);
  });

  test("empty name", () => {
    const marks: Mark[] = [{ name: "  ", at: 0 }];
    const issues = validateMarks(marks, PHASE_LIMITS);
    expect(issues.some((i) => i.index === 0 && i.message.includes("required"))).toBe(true);
  });

  test("duplicate name (case-sensitive)", () => {
    const marks: Mark[] = [
      { name: "Spring", at: 0 },
      { name: "Spring", at: 0.5 },
    ];
    const issues = validateMarks(marks, SEASON_LIMITS);
    expect(issues.some((i) => i.index === 1 && i.message.includes("duplicate"))).toBe(true);

    const caseDiffers: Mark[] = [
      { name: "Spring", at: 0 },
      { name: "spring", at: 0.5 },
    ];
    expect(validateMarks(caseDiffers, SEASON_LIMITS).some((i) => i.message.includes("duplicate"))).toBe(false);
  });

  test("at out of [0,1)", () => {
    const marks: Mark[] = [{ name: "A", at: 1 }];
    expect(validateMarks(marks, PHASE_LIMITS).some((i) => i.index === 0 && i.message.includes("[0,1)"))).toBe(true);
    const negative: Mark[] = [{ name: "A", at: -0.1 }];
    expect(validateMarks(negative, PHASE_LIMITS).some((i) => i.index === 0 && i.message.includes("[0,1)"))).toBe(true);
  });

  test("not strictly ascending after normalise (duplicate at)", () => {
    const marks: Mark[] = [
      { name: "A", at: 0.3 },
      { name: "B", at: 0.3 },
    ];
    expect(validateMarks(marks, PHASE_LIMITS).some((i) => i.message.includes("ascending"))).toBe(true);
  });

  test("gap below minGap", () => {
    const marks: Mark[] = [
      { name: "A", at: 0 },
      { name: "B", at: 0.01 },
    ];
    expect(validateMarks(marks, SEASON_LIMITS).some((i) => i.message.includes("minimum gap"))).toBe(true);
  });
});

describe("season/phase conversions round-trip", () => {
  test("toSeasons / fromSeasons", () => {
    const seasons = toSeasons(FOUR_SEASONS);
    expect(seasons).toEqual([
      { name: "Spring", from: 0 },
      { name: "Summer", from: 0.25 },
      { name: "Autumn", from: 0.5 },
      { name: "Winter", from: 0.75 },
    ]);
    expect(fromSeasons(seasons)).toEqual(FOUR_SEASONS);
  });

  test("toPhases / fromPhases", () => {
    const phases = toPhases(FOUR_SEASONS);
    expect(phases).toEqual([
      { name: "Spring", at: 0 },
      { name: "Summer", at: 0.25 },
      { name: "Autumn", at: 0.5 },
      { name: "Winter", at: 0.75 },
    ]);
    expect(fromPhases(phases)).toEqual(FOUR_SEASONS);
  });
});

describe("angle conversions", () => {
  test("angleOf", () => {
    expect(angleOf(0)).toBe(0);
    expect(angleOf(0.25)).toBe(90);
    expect(angleOf(0.5)).toBe(180);
  });

  test("phaseOfAngle wraps", () => {
    expect(phaseOfAngle(0)).toBe(0);
    expect(phaseOfAngle(90)).toBeCloseTo(0.25, 12);
    expect(phaseOfAngle(-90)).toBeCloseTo(0.75, 12);
    expect(phaseOfAngle(720 + 180)).toBeCloseTo(0.5, 12);
  });

  test("round-trips for at in [0,1)", () => {
    for (const at of [0, 0.1, 0.16, 0.42, 0.68, 0.86, 0.999]) {
      expect(phaseOfAngle(angleOf(at))).toBeCloseTo(at, 9);
    }
  });
});

describe("evenMarks", () => {
  test("4 names", () => {
    expect(evenMarks(["Spring", "Summer", "Autumn", "Winter"])).toEqual(FOUR_SEASONS);
  });

  test("5 names", () => {
    const marks = evenMarks(["a", "b", "c", "d", "e"]);
    expect(marks.map((m) => m.at)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
  });
});

describe("golden: default 5-phase moon layout", () => {
  test("New 0 · Crescent 0.16 · Half 0.42 · Gibbous 0.68 · Full 0.86 validates under PHASE_LIMITS", () => {
    const phases: Mark[] = [
      { name: "New", at: 0 },
      { name: "Crescent", at: 0.16 },
      { name: "Half", at: 0.42 },
      { name: "Gibbous", at: 0.68 },
      { name: "Full", at: 0.86 },
    ];
    expect(validateMarks(phases, PHASE_LIMITS)).toEqual([]);
  });
});
