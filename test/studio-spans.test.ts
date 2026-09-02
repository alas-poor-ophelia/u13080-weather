import { describe, expect, test } from "bun:test";
import type { Predicate } from "../src/core/types";
import { InternalCalendar } from "../src/plugin/time/internal";
import type { Span } from "../src/studio/model/lanes";
import {
  DEFAULT_MAX_SPANS,
  dayOrdinalAt,
  fractionalYear,
  moonPhaseAt,
  spansFor,
  spellRuns,
  type SpanCalendar,
  type SpanOptions,
} from "../src/studio/model/spans";
import type { Window } from "../src/studio/model/zoom";

// A 360-day year with 30-day moon cycles: 12 whole cycles per year, so every
// expectation below is exact rather than "about".
const CAL: SpanCalendar = {
  yearLength: 360,
  epochYear: 1,
  seasons: [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Autumn", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ],
  moons: [{ name: "Sable", cycleDays: 30, phaseAtEpoch: 0 }],
  eras: [
    { name: "Ashfall", from: 1200, to: 1260 },
    { name: "Long Night", from: 1400 },
    { name: "Sunken", from: 1000, to: 1100, enabled: false },
  ],
};

/** Seasons that do not start at phase 0, so the last one wraps the year boundary. */
const CAL_OFFSET: SpanCalendar = {
  ...CAL,
  seasons: [
    { name: "Spring", from: 0.1 },
    { name: "Summer", from: 0.35 },
    { name: "Autumn", from: 0.6 },
    { name: "Winter", from: 0.85 },
  ],
};

const day = (dayOfYear: number, year = 1500): number => year + dayOfYear / 360;

/** Days 103–106 of year 1500 (inside Summer): the Day zoom preset, 3 days wide. */
const DAY: Window = { a: day(103), b: day(106) };
const YEAR: Window = { a: 1500, b: 1501 };
const ERA: Window = { a: 1000, b: 2000 };

const opts = (window: Window, over: Partial<SpanOptions> = {}): SpanOptions => ({ window, ...over });
const spans = (when: Predicate | undefined, window: Window, over: Partial<SpanOptions> = {}, cal = CAL): Span[] =>
  spansFor(when, undefined, cal, opts(window, over));

const bounds = (s: Span): [number, number] => [s.from, s.to];

describe("spans: calendar arithmetic", () => {
  test("fractionalYear is the internal calendar's own model", () => {
    // dayOrdinal 0 is day 1 of `epochYear`
    expect(fractionalYear(0, CAL)).toBe(1);
    expect(fractionalYear(360, CAL)).toBe(2);
    expect(fractionalYear(180, CAL)).toBe(1.5);
    const ical = new InternalCalendar({ yearLength: 360, epochYear: 1, moons: [], seasons: [] }, () => 0);
    for (const d of [0, 1, 359, 360, 539_640, 539_743]) {
      const ctx = ical.toContext(d);
      expect(fractionalYear(d, CAL)).toBeCloseTo(ctx.year! + ctx.yearPhase, 9);
    }
  });

  test("dayOrdinalAt inverts fractionalYear", () => {
    expect(dayOrdinalAt(1500, CAL)).toBe(539_640);
    expect(dayOrdinalAt(fractionalYear(12_345, CAL), CAL)).toBeCloseTo(12_345, 6);
  });

  test("moonPhaseAt mirrors InternalCalendar.toContext exactly", () => {
    const moons = [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0.37 }];
    const ical = new InternalCalendar({ yearLength: 360, epochYear: 1, moons, seasons: [] }, () => 0);
    for (const d of [0, 1, 15, 29, 30, 1000, 539_640, -7]) {
      expect(moonPhaseAt(moons[0]!, d)).toBe(ical.toContext(d).moons![0]!.phase);
    }
  });

  test("moonPhaseAt defaults phaseAtEpoch to 0", () => {
    expect(moonPhaseAt({ name: "M", cycleDays: 30 }, 15)).toBeCloseTo(0.5, 12);
  });
});

describe("spans: row `undefined` (always) — no lane", () => {
  test("no `when` and no spell has no time to draw, at every zoom", () => {
    for (const w of [DAY, YEAR, ERA]) expect(spans(undefined, w)).toEqual([]);
  });
});

describe("spans: row `yearPhase [a,b]` — one editable clip per year", () => {
  const when: Predicate = { yearPhase: [0.2, 0.3] };

  test("Day zoom shows the one clip it falls inside, with its true (unclipped) edges", () => {
    const out = spans(when, DAY);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "yp:1500", from: 1500.2, to: 1500.3, kind: "clip", editable: true });
  });

  test("Year zoom shows exactly one clip", () => {
    const out = spans(when, YEAR);
    expect(out).toHaveLength(1);
    expect(bounds(out[0]!)).toEqual([1500.2, 1500.3]);
    expect(out[0]!.editable).toBe(true);
  });

  test("Era zoom would need one clip per year: the overflow bar instead", () => {
    const out = spans(when, ERA);
    expect(out).toEqual([{ id: "many", from: 1000, to: 2000, kind: "bar", editable: false, label: "…" }]);
  });

  test("a wrap-around range [0.9, 0.1] is ONE clip crossing the year boundary", () => {
    const out = spans({ yearPhase: [0.9, 0.1] }, YEAR);
    expect(out.map((s) => s.id)).toEqual(["yp:1499", "yp:1500"]);
    for (const s of out) {
      expect(s.to - s.from).toBeCloseTo(0.2, 9);
      expect(s.from).toBeLessThan(s.to);
    }
    expect(out[0]!.from).toBeCloseTo(1499.9, 9); // starts in the previous year, ends inside the window
    expect(out[0]!.to).toBeCloseTo(1500.1, 9);
    expect(out[1]!.to).toBeCloseTo(1501.1, 9);
  });

  test("an empty range (a === b) is the engine's `never`", () => {
    expect(spans({ yearPhase: [0.4, 0.4] }, YEAR)).toEqual([]);
  });

  test("[0, 1] covers the whole year", () => {
    const out = spans({ yearPhase: [0, 1] }, YEAR);
    expect(out).toHaveLength(1);
    expect(bounds(out[0]!)).toEqual([1500, 1501]);
  });
});

describe("spans: row `dayOfYear [a,b]` — the same clip, divided by yearLength", () => {
  const when: Predicate = { dayOfYear: [100, 110] };

  test("Year zoom: both ends inclusive, so day 110 is covered whole", () => {
    const out = spans(when, YEAR);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("doy:1500");
    expect(out[0]!.from).toBeCloseTo(day(100), 12);
    expect(out[0]!.to).toBeCloseTo(day(111), 12);
    expect(out[0]!.editable).toBe(true);
  });

  test("Day zoom keeps the same clip", () => {
    const out = spans(when, DAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBeCloseTo(day(100), 12);
  });

  test("Era zoom overflows to the bar", () => {
    expect(spans(when, ERA).map((s) => s.kind)).toEqual(["bar"]);
  });

  test("dayOfYear never wraps (the engine compares `d >= a && d <= b`)", () => {
    expect(spans({ dayOfYear: [350, 10] }, YEAR)).toEqual([]);
  });

  test("a single day is one day long", () => {
    const out = spans({ dayOfYear: [5, 5] }, YEAR);
    expect(out).toHaveLength(1);
    expect((out[0]!.to - out[0]!.from) * 360).toBeCloseTo(1, 9);
  });
});

describe("spans: row `moon {name, phase}` — one pulse per cycle", () => {
  const when: Predicate = { moon: { name: "Sable", phase: [0.45, 0.55] } };

  test("Year zoom: window days / cycleDays pulses, each (b−a)·cycleDays long", () => {
    const out = spans(when, YEAR);
    expect(out).toHaveLength(360 / 30);
    for (const s of out) {
      expect(s.kind).toBe("pulse");
      expect(s.editable).toBe(false);
      expect((s.to - s.from) * 360).toBeCloseTo(0.1 * 30, 9);
    }
  });

  test("each pulse starts exactly where the moon enters phase a", () => {
    for (const s of spans(when, YEAR)) {
      expect(moonPhaseAt(CAL.moons[0]!, dayOrdinalAt(s.from, CAL))).toBeCloseTo(0.45, 6);
      expect(moonPhaseAt(CAL.moons[0]!, dayOrdinalAt(s.to, CAL))).toBeCloseTo(0.55, 6);
    }
  });

  test("cycle ids are absolute, so they survive a pan", () => {
    const first = spans(when, YEAR)[0]!;
    expect(first.id).toBe("moon:Sable:17988");
    const panned = spans(when, { a: 1500.5, b: 1501.5 });
    expect(panned.map((s) => s.id)).toContain("moon:Sable:17994");
  });

  test("Day zoom: the one pulse the 3-day window touches", () => {
    const out = spans(when, DAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBeCloseTo(day(103.5), 9);
    expect(out[0]!.to).toBeCloseTo(day(106.5), 9);
  });

  test("Era zoom: 12 000 pulses is not a lane — the overflow bar", () => {
    expect(spans(when, ERA)).toEqual([{ id: "many", from: 1000, to: 2000, kind: "bar", editable: false, label: "…" }]);
  });

  test("a range straddling the wrap (0.95 → 0.05) still yields whole pulses", () => {
    const out = spans({ moon: { name: "Sable", phase: [0.95, 0.05] } }, YEAR);
    expect(out).toHaveLength(13); // 12 in the year + the one that starts in the last days of 1499
    expect(out[0]!.from).toBeLessThan(1500);
    for (const s of out) {
      expect((s.to - s.from) * 360).toBeCloseTo(3, 9);
      expect(moonPhaseAt(CAL.moons[0]!, dayOrdinalAt(s.from, CAL))).toBeCloseTo(0.95, 6);
    }
  });

  test("an unknown moon, a zero cycle and an empty range all give no pulses", () => {
    expect(spans({ moon: { name: "Nowhere", phase: [0, 0.5] } }, YEAR)).toEqual([]);
    expect(spans({ moon: { name: "Sable", phase: [0.3, 0.3] } }, YEAR)).toEqual([]);
  });

  test("a season gate at amount 0 dims the pulses it mutes, and only those", () => {
    const gates = [{ source: "season:Winter", amount: 0 }];
    const out = spans(when, YEAR, { gates });
    expect(out.filter((s) => s.dim === true)).toHaveLength(3); // the three cycles whose midpoint is in Winter
    for (const s of out.filter((x) => x.dim === true)) expect(s.from).toBeGreaterThan(1500.75);
    expect(out.filter((s) => s.dim !== true)).toHaveLength(9);
  });

  test("an era gate at amount 0 dims every pulse the era covers", () => {
    const gates = [{ source: "era:Long Night", amount: 0 }];
    expect(spans(when, YEAR, { gates }).every((s) => s.dim === true)).toBe(true);
    // year 1300 is before the era begins
    expect(spans(when, { a: 1300, b: 1301 }, { gates }).some((s) => s.dim === true)).toBe(false);
  });

  test("a gate that only dims (amount > 0) or names a disabled era does not dim", () => {
    expect(spans(when, YEAR, { gates: [{ source: "season:Winter", amount: 0.5 }] }).some((s) => s.dim === true)).toBe(false);
    expect(spans(when, { a: 1050, b: 1051 }, { gates: [{ source: "era:Sunken", amount: 0 }] }).some((s) => s.dim === true)).toBe(false);
  });
});

describe("spans: row `tag season:X` — the season band, read-only", () => {
  test("Year zoom: one band, the season's own segment", () => {
    const out = spans({ tag: "season:Summer" }, YEAR);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: "season:Summer:1500", from: 1500.25, to: 1500.5, kind: "band", editable: false, label: "Summer" });
  });

  test("Day zoom: the band the window sits inside, uncut", () => {
    const out = spans({ tag: "season:Summer" }, DAY);
    expect(out).toHaveLength(1);
    expect(bounds(out[0]!)).toEqual([1500.25, 1500.5]);
  });

  test("Era zoom: a band per year is the overflow bar", () => {
    expect(spans({ tag: "season:Summer" }, ERA).map((s) => s.kind)).toEqual(["bar"]);
  });

  test("the last season wraps the year boundary", () => {
    const out = spans({ tag: "season:Winter" }, YEAR, {}, CAL_OFFSET);
    // 1499's Winter runs into 1500, and 1500's runs out of it: both touch the window
    expect(out.map((s) => s.id)).toEqual(["season:Winter:1499", "season:Winter:1500"]);
    expect(out[0]!.from).toBeCloseTo(1499.85, 9);
    expect(out[0]!.to).toBeCloseTo(1500.1, 9);
    expect(out[1]!.from).toBeCloseTo(1500.85, 9);
    expect(out[1]!.to).toBeCloseTo(1501.1, 9);
  });

  test("flipSeasons shifts every band by half a year", () => {
    const flipped: SpanCalendar = { ...CAL, flipSeasons: true };
    const out = spans({ tag: "season:Summer" }, YEAR, {}, flipped);
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBeCloseTo(1500.75, 9);
    expect(out[0]!.to).toBeCloseTo(1501, 9);
    expect(out[0]!.to - out[0]!.from).toBeCloseTo(0.25, 9);
  });

  test("a season the calendar does not have has no band", () => {
    expect(spans({ tag: "season:Monsoon" }, YEAR)).toEqual([]);
  });
});

describe("spans: row `tag era:X` — clip at Era zoom, bar at Year and tighter", () => {
  test("Era zoom: a clip over the era's years, `to` inclusive", () => {
    const out = spans({ tag: "era:Ashfall" }, ERA);
    expect(out).toEqual([{ id: "era:Ashfall", from: 1200, to: 1261, kind: "clip", editable: false, label: "Ashfall" }]);
  });

  test("an open era ends at the window end at Era zoom", () => {
    const out = spans({ tag: "era:Long Night" }, ERA);
    expect(bounds(out[0]!)).toEqual([1400, 2000]);
    expect(bounds(spans({ tag: "era:Long Night" }, { a: 1000, b: 1600 })[0]!)).toEqual([1400, 1600]);
  });

  test("Year zoom: a full-window bar, but only when the era covers the centre year", () => {
    expect(spans({ tag: "era:Long Night" }, YEAR)).toEqual([
      { id: "era:Long Night", from: 1500, to: 1501, kind: "bar", editable: false, label: "Long Night" },
    ]);
    expect(spans({ tag: "era:Ashfall" }, YEAR)).toEqual([]);
    expect(bounds(spans({ tag: "era:Ashfall" }, { a: 1250, b: 1251 })[0]!)).toEqual([1250, 1251]);
  });

  test("Day zoom is 'Year and tighter': still the bar", () => {
    const out = spans({ tag: "era:Long Night" }, DAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("bar");
    expect(bounds(out[0]!)).toEqual([DAY.a, DAY.b]);
  });

  test("a disabled era tags nothing, so it has no lane at any zoom", () => {
    for (const w of [DAY, YEAR, ERA, { a: 1000, b: 1101 }]) expect(spans({ tag: "era:Sunken" }, w)).toEqual([]);
  });

  test("an unknown era, and an era outside the window, have no spans", () => {
    expect(spans({ tag: "era:Nowhere" }, ERA)).toEqual([]);
    expect(spans({ tag: "era:Ashfall" }, { a: 1000, b: 1100 })).toEqual([]);
  });
});

describe("spans: rows with no lane", () => {
  test("an unrecognised tag, `chance` and `regime` draw nothing", () => {
    for (const w of [DAY, YEAR, ERA]) {
      expect(spans({ tag: "sable-tide" }, w)).toEqual([]);
      expect(spans({ chance: 0.3 }, w)).toEqual([]);
      expect(spans({ regime: "storm" }, w)).toEqual([]);
    }
  });
});

describe("spans: row `all` — the intersection, never editable", () => {
  const when: Predicate = { all: [{ tag: "season:Winter" }, { moon: { name: "Sable", phase: [0.45, 0.55] } }] };

  test("season ∧ moon keeps only the pulses inside the band", () => {
    const out = spans(when, YEAR);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.id)).toEqual(["all:0", "all:1", "all:2"]);
    for (const s of out) {
      expect(s.kind).toBe("window");
      expect(s.editable).toBe(false);
      expect(s.from).toBeGreaterThanOrEqual(1500.75);
      expect((s.to - s.from) * 360).toBeCloseTo(3, 9);
    }
  });

  test("a leaf with no time (chance) is ignored, not intersected away", () => {
    const out = spans({ all: [{ tag: "season:Winter" }, { chance: 0.2 }] }, YEAR);
    expect(out).toHaveLength(1);
    expect(bounds(out[0]!)).toEqual([1500.75, 1501]);
    expect(out[0]!.kind).toBe("window");
  });

  test("a timed-but-empty leaf (a disabled era) does mute the composite", () => {
    expect(spans({ all: [{ tag: "era:Sunken" }, { tag: "season:Winter" }] }, YEAR)).toEqual([]);
  });

  test("only timeless leaves means no lane at all", () => {
    expect(spans({ all: [{ chance: 0.2 }, { regime: "storm" }] }, YEAR)).toEqual([]);
  });

  test("disjoint leaves intersect to nothing", () => {
    expect(spans({ all: [{ tag: "season:Winter" }, { tag: "season:Summer" }] }, YEAR)).toEqual([]);
  });
});

describe("spans: row `any` — the union, merged", () => {
  test("two touching seasons merge into one span", () => {
    const out = spans({ any: [{ tag: "season:Spring" }, { tag: "season:Summer" }] }, YEAR);
    expect(out).toHaveLength(1);
    expect(bounds(out[0]!)).toEqual([1500, 1500.5]);
    expect(out[0]!.id).toBe("any:0");
    expect(out[0]!.kind).toBe("window");
  });

  test("disjoint seasons stay separate, in order", () => {
    const out = spans({ any: [{ tag: "season:Spring" }, { tag: "season:Autumn" }] }, YEAR);
    expect(out.map(bounds)).toEqual([
      [1500, 1500.25],
      [1500.5, 1500.75],
    ]);
  });
});

describe("spans: row `not` — the complement within the window", () => {
  test("not season:Summer is the other three seasons (Autumn and Winter merge)", () => {
    const out = spans({ not: { tag: "season:Summer" } }, YEAR);
    expect(out.map(bounds)).toEqual([
      [1500, 1500.25],
      [1500.5, 1501],
    ]);
    for (const s of out) {
      expect(s.kind).toBe("window");
      expect(s.editable).toBe(false);
    }
    const covered = out.reduce((sum, s) => sum + (s.to - s.from), 0);
    expect(covered).toBeCloseTo(0.75, 9);
  });

  test("the complement of nothing is the whole window", () => {
    const out = spans({ not: { tag: "season:Monsoon" } }, YEAR);
    expect(out.map(bounds)).toEqual([[1500, 1501]]);
  });

  test("the complement of a timeless predicate is unknown, so no lane", () => {
    expect(spans({ not: { chance: 0.5 } }, YEAR)).toEqual([]);
  });
});

describe("spans: nested composites", () => {
  test("all[ any[Autumn, Winter], not[moon] ] is the half-year minus the pulses", () => {
    const when: Predicate = {
      all: [
        { any: [{ tag: "season:Autumn" }, { tag: "season:Winter" }] },
        { not: { moon: { name: "Sable", phase: [0.45, 0.55] } } },
      ],
    };
    const out = spans(when, YEAR);
    expect(out).toHaveLength(7); // 6 pulses inside the half-year cut it into 7 pieces
    expect(out[0]!.from).toBeCloseTo(1500.5, 9);
    expect(out[out.length - 1]!.to).toBeCloseTo(1501, 9);
    const covered = out.reduce((sum, s) => sum + (s.to - s.from), 0);
    expect(covered * 360).toBeCloseTo(180 - 6 * 3, 6);
    for (const s of out) expect(s.kind).toBe("window");
  });

  test("an overflowing leaf overflows the whole composite", () => {
    const out = spans({ all: [{ tag: "season:Summer" }, { tag: "era:Ashfall" }] }, ERA);
    expect(out.map((s) => s.id)).toEqual(["many"]);
  });
});

describe("spans: row `+ spell` — dashed window plus solid runs", () => {
  const when: Predicate = { yearPhase: [0.25, 0.5] };
  const spell = { meanStartsPerYear: 2, meanDurationDays: 5 };

  test("the `when` spans become `window` (dashed) but keep their editability", () => {
    const out = spansFor(when, spell, CAL, opts(YEAR));
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("window");
    expect(out[0]!.editable).toBe(true);
    expect(bounds(out[0]!)).toEqual([1500.25, 1500.5]);
  });

  test("a spell with no `when` has no dashed window — only its runs", () => {
    expect(spansFor(undefined, spell, CAL, opts(YEAR))).toEqual([]);
  });

  test("spellRuns groups consecutive active days into solid runs", () => {
    const first = dayOrdinalAt(1500, CAL);
    const active = Array.from({ length: 21 }, (_, i) => ({ dayOrdinal: first + i, active: [5, 6, 7, 12, 13].includes(i) }));
    const runs = spellRuns(active, CAL, YEAR);
    expect(runs).toHaveLength(2);
    expect(runs.map((s) => [s.kind, s.editable])).toEqual([
      ["run", false],
      ["run", false],
    ]);
    expect(runs[0]!.from).toBeCloseTo(day(5), 12);
    expect(runs[0]!.to).toBeCloseTo(day(8), 12); // day 7 is covered whole
    expect(runs[1]!.from).toBeCloseTo(day(12), 12);
    expect(runs[1]!.to).toBeCloseTo(day(14), 12);
    expect(runs[0]!.id).toBe(`run:${first + 5}`);
  });

  test("a gap in the ordinals breaks a run", () => {
    const first = dayOrdinalAt(1500, CAL);
    const runs = spellRuns(
      [
        { dayOrdinal: first, active: true },
        { dayOrdinal: first + 1, active: true },
        { dayOrdinal: first + 5, active: true },
      ],
      CAL,
      YEAR
    );
    expect(runs.map((s) => [s.from - 1500, s.to - 1500].map((x) => Math.round(x * 360)))).toEqual([
      [0, 2],
      [5, 6],
    ]);
  });

  test("runs outside the window are dropped", () => {
    const active = [{ dayOrdinal: dayOrdinalAt(1400, CAL), active: true }];
    expect(spellRuns(active, CAL, YEAR)).toEqual([]);
    expect(spellRuns([], CAL, YEAR)).toEqual([]);
  });

  test("the lane is the dashed window plus the runs, in that order", () => {
    const first = dayOrdinalAt(1500, CAL);
    const active = Array.from({ length: 360 }, (_, i) => ({ dayOrdinal: first + i, active: i >= 100 && i < 104 }));
    const lane = [...spansFor(when, spell, CAL, opts(YEAR)), ...spellRuns(active, CAL, YEAR)];
    expect(lane.map((s) => s.kind)).toEqual(["window", "run"]);
  });
});

describe("spans: maxSpans", () => {
  test("the default is 400 and the cap is a single labelled bar", () => {
    expect(DEFAULT_MAX_SPANS).toBe(400);
    const out = spans({ yearPhase: [0.2, 0.3] }, ERA);
    expect(out).toEqual([{ id: "many", from: 1000, to: 2000, kind: "bar", editable: false, label: "…" }]);
  });

  test("an explicit cap bites earlier", () => {
    const decade: Window = { a: 1500, b: 1510 };
    expect(spans({ yearPhase: [0.2, 0.3] }, decade, { maxSpans: 3 }).map((s) => s.id)).toEqual(["many"]);
    expect(spans({ yearPhase: [0.2, 0.3] }, decade, { maxSpans: 100 })).toHaveLength(10);
  });

  test("the cap covers the window exactly", () => {
    const out = spans({ moon: { name: "Sable", phase: [0.45, 0.55] } }, ERA);
    expect(bounds(out[0]!)).toEqual([ERA.a, ERA.b]);
  });
});

describe("spans: invariants across every row and zoom", () => {
  const rows: Array<[string, Predicate | undefined]> = [
    ["always", undefined],
    ["yearPhase", { yearPhase: [0.2, 0.3] }],
    ["yearPhase wrap", { yearPhase: [0.9, 0.1] }],
    ["dayOfYear", { dayOfYear: [100, 110] }],
    ["moon", { moon: { name: "Sable", phase: [0.45, 0.55] } }],
    ["moon wrap", { moon: { name: "Sable", phase: [0.95, 0.05] } }],
    ["season", { tag: "season:Summer" }],
    ["era", { tag: "era:Long Night" }],
    ["era closed", { tag: "era:Ashfall" }],
    ["tag other", { tag: "sable-tide" }],
    ["chance", { chance: 0.3 }],
    ["regime", { regime: "storm" }],
    ["all", { all: [{ tag: "season:Winter" }, { moon: { name: "Sable", phase: [0.45, 0.55] } }] }],
    ["any", { any: [{ tag: "season:Spring" }, { tag: "season:Autumn" }] }],
    ["not", { not: { tag: "season:Summer" } }],
    ["nested", { all: [{ any: [{ tag: "season:Autumn" }] }, { not: { tag: "season:Winter" } }] }],
  ];

  for (const [name, when] of rows) {
    test(`${name}: every span has from < to and touches the window`, () => {
      for (const w of [DAY, YEAR, ERA]) {
        for (const spell of [undefined, { meanStartsPerYear: 1, meanDurationDays: 4 }]) {
          for (const s of spansFor(when, spell, CAL, opts(w))) {
            expect(s.from).toBeLessThan(s.to);
            expect(s.to).toBeGreaterThan(w.a);
            expect(s.from).toBeLessThan(w.b);
            expect(Number.isFinite(s.from) && Number.isFinite(s.to)).toBe(true);
          }
        }
      }
    });
  }

  test("ids are unique within a lane", () => {
    for (const [, when] of rows) {
      for (const w of [DAY, YEAR, ERA]) {
        const ids = spansFor(when, undefined, CAL, opts(w)).map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });
});
