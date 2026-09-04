import { describe, expect, test } from "bun:test";
import { gregorianTime } from "../src/core/generator";
import { ModifierEngine, evaluatePredicate, inPhaseRange, sampleEnvelope, type PredicateContext } from "../src/core/modifiers";
import type { DayTime, Modifier } from "../src/core/types";

const base: PredicateContext = { dayOrdinal: 100, yearPhase: 0.3, dayOfYear: 109, regime: "normal", seed: "s", zoneId: "z", modifierId: "m", moons: [{ name: "Sable", phase: 0.95 }], tags: ["witch-month"] };

describe("predicates", () => {
  test("inPhaseRange wraps", () => {
    expect(inPhaseRange(0.95, 0.9, 1)).toBe(true);
    expect(inPhaseRange(0.02, 0.9, 0.1)).toBe(true);
    expect(inPhaseRange(0.5, 0.9, 0.1)).toBe(false);
    expect(inPhaseRange(0.5, 0.5, 0.5)).toBe(false);
  });

  test("each leaf predicate", () => {
    expect(evaluatePredicate({ moon: { name: "Sable", phase: [0.88, 1] } }, base)).toBe(true);
    expect(evaluatePredicate({ moon: { name: "Sable", phase: [0.4, 0.6] } }, base)).toBe(false);
    expect(evaluatePredicate({ moon: { name: "Nope", phase: [0, 1] } }, base)).toBe(false);
    expect(evaluatePredicate({ yearPhase: [0.25, 0.5] }, base)).toBe(true);
    expect(evaluatePredicate({ dayOfYear: [100, 120] }, base)).toBe(true);
    expect(evaluatePredicate({ dayOfYear: [110, 120] }, base)).toBe(false);
    expect(evaluatePredicate({ tag: "witch-month" }, base)).toBe(true);
    expect(evaluatePredicate({ tag: "festival" }, base)).toBe(false);
    expect(evaluatePredicate({ regime: "normal" }, base)).toBe(true);
    expect(evaluatePredicate({ regime: "dry-spell" }, base)).toBe(false);
  });

  test("composition", () => {
    expect(evaluatePredicate({ all: [{ tag: "witch-month" }, { not: { regime: "wet-spell" } }] }, base)).toBe(true);
    expect(evaluatePredicate({ any: [{ tag: "festival" }, { yearPhase: [0.9, 0.1] }] }, base)).toBe(false);
    expect(evaluatePredicate({ all: [] }, base)).toBe(true);
  });

  test("chance is deterministic per (seed, zone, day, modifier) and ≈ p in frequency", () => {
    const a = evaluatePredicate({ chance: 0.3 }, base);
    expect(evaluatePredicate({ chance: 0.3 }, { ...base })).toBe(a);
    let hits = 0;
    for (let d = 0; d < 10000; d++) if (evaluatePredicate({ chance: 0.3 }, { ...base, dayOrdinal: d })) hits++;
    expect(Math.abs(hits / 10000 - 0.3)).toBeLessThan(0.02);
    // different modifier id → different draw
    let same = 0;
    for (let d = 0; d < 1000; d++) if (evaluatePredicate({ chance: 0.5 }, { ...base, dayOrdinal: d }) === evaluatePredicate({ chance: 0.5 }, { ...base, dayOrdinal: d, modifierId: "other" })) same++;
    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });
});

const withMoon = (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name: "Sable", phase: ((d % 29.5) + 29.5) % 29.5 / 29.5 }], tags: d % 7 === 0 ? ["market-day"] : [] });

describe("ModifierEngine", () => {
  test("plain daily modifier: ops + tag when predicate holds", () => {
    const mods: Modifier[] = [{ id: "stormtide", when: { moon: { name: "Sable", phase: [0.88, 1] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5 }], tag: "stormtide" }];
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: mods, timeOf: withMoon });
    let on = 0;
    for (let d = 0; d < 590; d++) {
      const r = e.forDay(d, "normal");
      if (r.active.includes("stormtide")) {
        on++;
        expect(r.ops).toEqual(mods[0]!.apply);
        expect(r.tags).toEqual(["stormtide"]);
      } else expect(r.ops).toEqual([]);
    }
    expect(on / 590).toBeCloseTo(0.12, 1);
  });

  test("climate-stage modifiers are ignored by the daily engine", () => {
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [{ id: "c", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: -3 }] }], timeOf: gregorianTime });
    expect(e.forDay(10, "normal").ops).toEqual([]);
  });

  test("spell: runs of consecutive days, no re-trigger while active, roughly the requested frequency", () => {
    const mods: Modifier[] = [
      {
        id: "ashfall",
        when: { yearPhase: [0.61, 0.72] },
        spell: { meanStartsPerYear: 0.8, meanDurationDays: 15 },
        apply: [{ param: "precipitation.pwd", op: "set", value: 0 }],
        tag: "ashfall",
      },
    ];
    const e = new ModifierEngine({ seed: "ash", zoneId: "z", modifiers: mods, timeOf: gregorianTime });
    const YEARS = 60;
    const N = Math.round(YEARS * 365.25);
    const active: boolean[] = [];
    for (let d = 0; d < N; d++) active.push(e.forDay(d, "normal").active.includes("ashfall"));
    // count runs and lengths
    const runs: number[] = [];
    let run = 0;
    for (const a of active) {
      if (a) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
    expect(runs.length).toBeGreaterThan(YEARS * 0.4);
    expect(runs.length).toBeLessThan(YEARS * 1.4);
    const meanLen = runs.reduce((a, b) => a + b, 0) / runs.length;
    expect(meanLen).toBeGreaterThan(9);
    expect(meanLen).toBeLessThan(22);
    // every active day either lies inside the window or continues a spell that started inside it
    for (let d = 1; d < N; d++) {
      if (active[d] && !active[d - 1]) {
        const t = gregorianTime(d).yearPhase;
        expect(t >= 0.61 && t < 0.72).toBe(true);
      }
    }
  });

  test("spell activity is a pure function of the day (same answer regardless of query order)", () => {
    const mods: Modifier[] = [{ id: "fog", spell: { meanStartsPerYear: 6, meanDurationDays: 4 }, apply: [], tag: "fog" }];
    const a = new ModifierEngine({ seed: "p", zoneId: "z", modifiers: mods, timeOf: gregorianTime });
    const b = new ModifierEngine({ seed: "p", zoneId: "z", modifiers: mods, timeOf: gregorianTime });
    const days = [500, 12, 733, -40, 501];
    const ra = days.map((d) => a.forDay(d, "normal").active.length);
    const rb = [...days].reverse().map((d) => b.forDay(d, "normal").active.length).reverse();
    expect(ra).toEqual(rb);
  });
});

describe("engine: tags between modifiers and spell windows", () => {
  const timeOf = (d: number): DayTime => gregorianTime(d);

  test("a tag set by an earlier modifier is visible to a later one the same day, not to an earlier one", () => {
    const omen: Modifier = { id: "omen", when: { chance: 1 }, apply: [], tag: "omen" };
    const react: Modifier = { id: "react", when: { tag: "omen" }, apply: [], tag: "storm" };
    const forward = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [omen, react], timeOf }).forDay(10, "normal");
    expect(forward.tags).toEqual(["omen", "storm"]);
    const backward = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [react, omen], timeOf }).forDay(10, "normal");
    expect(backward.tags).toEqual(["omen"]);
  });

  test("a spell gated on a tag no reference-year day carries uses a whole-year window, not 'always on'", () => {
    // the tag appears only from day 3000 on — like an era that starts after year 1
    const late = (d: number): DayTime => ({ ...gregorianTime(d), tags: d >= 3000 ? ["era:Late"] : [] });
    const m: Modifier = { id: "s", when: { tag: "era:Late" }, spell: { meanStartsPerYear: 3, meanDurationDays: 10 }, apply: [], tag: "on" };
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: late });
    let on = 0;
    for (let d = 3000; d < 3000 + 365 * 4; d++) if (e.forDay(d, "normal").tags.length) on++;
    const share = on / (365 * 4);
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.25); // ~8% expected; before the fix this was 100%
    for (let d = 0; d < 3000; d += 50) expect(e.forDay(d, "normal").tags).toEqual([]);
  });
});

describe("engine: enabled flags", () => {
  const timeOf = (d: number): DayTime => gregorianTime(d);
  const always: Modifier = { id: "always", when: { chance: 1 }, apply: [{ param: "wind.speed", op: "scale", value: 2 }], tag: "always" };

  test("a disabled modifier is absent from active, sets no tag and contributes no ops", () => {
    const on = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [always], timeOf }).forDay(10, "normal");
    expect(on).toEqual({ ops: always.apply, tags: ["always"], active: ["always"] });
    const off = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [{ ...always, enabled: false }], timeOf }).forDay(10, "normal");
    expect(off).toEqual({ ops: [], tags: [], active: [] });
    // and it is invisible to a modifier that reacts to its tag
    const react: Modifier = { id: "react", when: { tag: "always" }, apply: [], tag: "storm" };
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [{ ...always, enabled: false }, react], timeOf });
    expect(e.forDay(10, "normal").active).toEqual([]);
  });

  test("a disabled spell modifier never starts (its window estimate is skipped too)", () => {
    const fog: Modifier = { id: "fog", spell: { meanStartsPerYear: 30, meanDurationDays: 4 }, apply: [], tag: "fog" };
    const e = new ModifierEngine({ seed: "p", zoneId: "z", modifiers: [{ ...fog, enabled: false }], timeOf });
    for (let d = 0; d < 365; d++) expect(e.forDay(d, "normal").active).toEqual([]);
  });

  test("a disabled op is dropped while its siblings in the same modifier still apply", () => {
    const m: Modifier = {
      id: "mixed",
      when: { chance: 1 },
      apply: [
        { param: "precipitation.pwd", op: "set", value: 0, enabled: false },
        { param: "wind.speed", op: "scale", value: 2 },
        { param: "cloud.dry", op: "set", value: 0.9, enabled: true },
      ],
      tag: "mixed",
    };
    const r = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf }).forDay(10, "normal");
    expect(r.active).toEqual(["mixed"]);
    expect(r.ops.map((o) => o.param)).toEqual(["wind.speed", "cloud.dry"]);
  });
});

describe("envelope sampling", () => {
  test("sorts, interpolates linearly and wraps across 1→0", () => {
    const ramp: Array<[number, number]> = [[0, 0], [0.5, 1]];
    expect(sampleEnvelope(ramp, 0)).toBe(0); // exactly on a point
    expect(sampleEnvelope(ramp, 0.5)).toBe(1);
    expect(sampleEnvelope(ramp, 0.25)).toBeCloseTo(0.5, 12); // mid-segment
    expect(sampleEnvelope(ramp, 0.75)).toBeCloseTo(0.5, 12); // wrapping segment 0.5 → 1.0
    expect(sampleEnvelope([[0.5, 1], [0, 0]], 0.25)).toBeCloseTo(0.5, 12); // input order does not matter
    // a wrap that spans the seam: last point 0.9, first point 0.1
    const seam: Array<[number, number]> = [[0.1, 0], [0.9, 2]];
    expect(sampleEnvelope(seam, 0.95)).toBeCloseTo(1.5, 12);
    expect(sampleEnvelope(seam, 0.05)).toBeCloseTo(0.5, 12);
    expect(sampleEnvelope(seam, 0.5)).toBeCloseTo(1, 12);
    // phases outside [0,1) fold in; a single point is a constant; empty is 1
    expect(sampleEnvelope(ramp, 1.25)).toBeCloseTo(0.5, 12);
    expect(sampleEnvelope(ramp, -0.75)).toBeCloseTo(0.5, 12);
    expect(sampleEnvelope([[0.3, 0.25]], 0.9)).toBe(0.25);
    expect(sampleEnvelope([], 0.9)).toBe(1);
  });
});

describe("engine: mod-matrix gates", () => {
  const harvest = (d: number): DayTime => ({ ...gregorianTime(d), tags: d % 2 === 0 ? ["season:Harvest"] : [] });
  const gated: Modifier = {
    id: "gated",
    apply: [
      { param: "precipitation.pwd", op: "offset", value: 10 },
      { param: "wind.speed", op: "scale", value: 2 },
      { param: "cloud.dry", op: "set", value: 0.9 },
      { param: "humidity.wet", op: "clamp", min: 0.2 },
    ],
    mods: [{ source: "season:Harvest", amount: 0.5 }],
  };

  test("inside its source a gate is ×1; OUTSIDE it magnitudes fall to (1 − amount) (D19)", () => {
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [gated], timeOf: harvest });
    // inside the source the device runs at the strength its author wrote, and the ops come
    // through as the very same objects, so a satisfied gate cannot perturb history
    const on = e.forDay(0, "normal");
    expect(on.ops).toEqual(gated.apply);
    expect(on.ops[0]).toBe(gated.apply[0]);
    // outside it the gate restricts: offset ×0.5, scale halfway toward 1, set/clamp untouched
    expect(e.forDay(1, "normal").ops).toEqual([
      { param: "precipitation.pwd", op: "offset", value: 5 },
      { param: "wind.speed", op: "scale", value: 1.5 },
      { param: "cloud.dry", op: "set", value: 0.9 },
      { param: "humidity.wet", op: "clamp", min: 0.2 },
    ]);
  });

  test("amount 0.72 leaves 0.28 of the device outside the source", () => {
    const m: Modifier = { id: "seven", apply: [{ param: "precipitation.pwd", op: "offset", value: 10 }], mods: [{ source: "season:Harvest", amount: 0.72 }] };
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: harvest });
    expect((e.forDay(0, "normal").ops[0] as { value: number }).value).toBe(10);
    expect((e.forDay(1, "normal").ops[0] as { value: number }).value).toBeCloseTo(2.8, 12);
  });

  test("a hard gate (amount 1) silences the device outside its source and leaves it whole inside", () => {
    const m: Modifier = { id: "hard", apply: [{ param: "precipitation.pwd", op: "offset", value: 10 }, { param: "wind.speed", op: "scale", value: 2 }], mods: [{ source: "season:Harvest", amount: 1 }] };
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: harvest });
    expect(e.forDay(0, "normal").ops).toEqual(m.apply);
    expect(e.forDay(1, "normal").ops).toEqual([
      { param: "precipitation.pwd", op: "offset", value: 0 },
      { param: "wind.speed", op: "scale", value: 1 },
    ]);
  });

  test("amount 0 is no gate at all: ×1 on every day, inside the source or out", () => {
    const m: Modifier = { id: "none", apply: [{ param: "precipitation.pwd", op: "offset", value: 10 }], mods: [{ source: "season:Harvest", amount: 0 }] };
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: harvest });
    for (const d of [0, 1, 2, 3]) expect(e.forDay(d, "normal").ops).toEqual(m.apply);
  });

  test("two gates multiply: full only where BOTH tags are on the day", () => {
    const tagsOn = (tags: string[]) => (d: number): DayTime => ({ ...gregorianTime(d), tags });
    const m: Modifier = {
      id: "two",
      apply: [{ param: "precipitation.pwd", op: "offset", value: 8 }],
      mods: [
        { source: "season:Harvest", amount: 0.5 },
        { source: "era:Long Winter", amount: 0.25 },
      ],
    };
    const at = (tags: string[]) => (new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: tagsOn(tags) }).forDay(3, "normal").ops[0] as { value: number }).value;
    expect(at(["season:Harvest", "era:Long Winter"])).toBe(8); // both sources: ×1 × ×1
    expect(at(["season:Harvest"])).toBe(6); // outside the era only: ×0.75
    expect(at(["era:Long Winter"])).toBe(4); // outside the season only: ×0.5
    expect(at([])).toBeCloseTo(3, 12); // outside both: ×0.5 × ×0.75
  });

  test("a gated `scale` below 1 stays non-negative: 1 + (v − 1)·f for every legal f", () => {
    // f ∈ [0, 1] is what the validator guarantees (a gate is ×1 inside its source and
    // ×(1 − amount) outside it), and it is what keeps 1 + (v − 1)·f from crossing zero
    // for a shrinking scale — the sign cannot flip, so no op can silently invert the
    // parameter it scales.
    const shrink: Modifier = { id: "shrink", apply: [{ param: "wind.speed", op: "scale", value: 0.5 }] };
    // day 1 is OUTSIDE Harvest, so the gate bites and f is 1 − amount
    const at = (amount: number) => new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [{ ...shrink, mods: [{ source: "season:Harvest", amount }] }], timeOf: harvest }).forDay(1, "normal").ops[0]!;
    for (const amount of [0, 0.75]) {
      const op = at(amount);
      expect(op).toEqual({ param: "wind.speed", op: "scale", value: 1 + (0.5 - 1) * (1 - amount) });
      expect((op as { value: number }).value).toBeGreaterThanOrEqual(0);
    }
    expect(at(0)).toEqual({ param: "wind.speed", op: "scale", value: 0.5 });
    expect(at(0.75)).toEqual({ param: "wind.speed", op: "scale", value: 0.875 });
  });

  test("a gate sees a tag set by an EARLIER modifier the same day", () => {
    const timeOf = (d: number): DayTime => gregorianTime(d);
    const storm: Modifier = { id: "storm", when: { chance: 1 }, apply: [], tag: "storm" };
    const react: Modifier = { id: "react", apply: [{ param: "wind.speed", op: "offset", value: 10 }], mods: [{ source: "storm", amount: 0.25 }] };
    // the storm tag is on the day, so the gate is satisfied and the device runs whole
    expect(new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [storm, react], timeOf }).forDay(5, "normal").ops).toEqual([{ param: "wind.speed", op: "offset", value: 10 }]);
    // order matters: a gate listed before its source sees nothing, so it restricts (×0.75)
    expect(new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [react, storm], timeOf }).forDay(5, "normal").ops).toEqual([{ param: "wind.speed", op: "offset", value: 7.5 }]);
  });

  test("a hard gate mutes outside its source but keeps the modifier active and its tag", () => {
    const e = new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [{ ...gated, tag: "gated", mods: [{ source: "season:Harvest", amount: 1 }] }], timeOf: harvest });
    const r = e.forDay(1, "normal");
    expect(r.active).toEqual(["gated"]);
    expect(r.tags).toEqual(["gated"]);
    expect(r.ops.slice(0, 2)).toEqual([
      { param: "precipitation.pwd", op: "offset", value: 0 },
      { param: "wind.speed", op: "scale", value: 1 },
    ]);
  });

  test("a spell honours its gates", () => {
    const fog: Modifier = {
      id: "fog",
      spell: { meanStartsPerYear: 60, meanDurationDays: 4 },
      apply: [{ param: "wind.speed", op: "offset", value: 10 }],
      mods: [{ source: "season:Harvest", amount: 0.5 }],
    };
    const e = new ModifierEngine({ seed: "p", zoneId: "z", modifiers: [fog], timeOf: harvest });
    let insideDays = 0;
    let outsideDays = 0;
    for (let d = 0; d < 365; d++) {
      const r = e.forDay(d, "normal");
      if (!r.active.length) continue;
      const value = (r.ops[0] as { value: number }).value;
      if (d % 2 === 0) {
        expect(value).toBe(10); // inside season:Harvest the gate is satisfied
        insideDays++;
      } else {
        expect(value).toBe(5); // outside it the gate takes half
        outsideDays++;
      }
    }
    expect(insideDays).toBeGreaterThan(0);
    expect(outsideDays).toBeGreaterThan(0);
  });
});

describe("engine: onset envelopes", () => {
  const twoMoons = (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name: "Alpha", phase: 0.25 }, { name: "Sable", phase: 0.75 }] });
  const env: Array<[number, number]> = [[0.25, 1], [0.75, 0]];

  test("the carrier is the moon named in a bare when.moon, else the first moon of the day", () => {
    const named: Modifier = { id: "named", when: { moon: { name: "Sable", phase: [0, 1] } }, apply: [{ param: "wind.speed", op: "offset", value: 10, envelope: env }] };
    const other: Modifier = { id: "other", when: { yearPhase: [0, 1] }, apply: [{ param: "wind.speed", op: "offset", value: 10, envelope: env }] };
    const at = (m: Modifier, timeOf: (d: number) => DayTime = twoMoons) => (new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf }).forDay(4, "normal").ops[0] as { value: number }).value;
    expect(at(named)).toBe(0); // Sable sits at phase 0.75 → strength 0
    expect(at(other)).toBe(10); // first moon Alpha at 0.25 → strength 1
    // a compound predicate is not a bare moon: the first moon carries it
    expect(at({ ...other, when: { all: [{ moon: { name: "Sable", phase: [0, 1] } }, { yearPhase: [0, 1] }] } })).toBe(10);
    // no moons on the day at all → factor 1
    expect(at(other, gregorianTime)).toBe(10);
  });

  test("magnitude is scaled at a point, mid-segment and across the wrap; set/clamp ignore it", () => {
    const phase =
      (p: number) =>
      (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name: "Sable", phase: p }] });
    const ramp: Array<[number, number]> = [[0, 0], [0.5, 1]];
    const m: Modifier = {
      id: "onset",
      apply: [
        { param: "precipitation.pwd", op: "offset", value: 10, envelope: ramp },
        { param: "wind.speed", op: "scale", value: 3, envelope: ramp },
        { param: "cloud.dry", op: "set", value: 0.9, envelope: ramp },
      ],
    };
    const at = (p: number) => new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf: phase(p) }).forDay(1, "normal").ops;
    expect(at(0.5)).toEqual([
      { param: "precipitation.pwd", op: "offset", value: 10 },
      { param: "wind.speed", op: "scale", value: 3 },
      { param: "cloud.dry", op: "set", value: 0.9 },
    ]);
    expect((at(0.25)[0] as { value: number }).value).toBeCloseTo(5, 12); // mid-segment
    expect((at(0.25)[1] as { value: number }).value).toBeCloseTo(2, 12); // scale: 1 + (3-1)·0.5
    expect((at(0.75)[0] as { value: number }).value).toBeCloseTo(5, 12); // the wrapping segment
    expect((at(0)[0] as { value: number }).value).toBe(0);
    expect((at(0)[1] as { value: number }).value).toBe(1);
    // set is untouched at every phase, and the envelope field never reaches the ops
    for (const p of [0, 0.25, 0.5, 0.75]) {
      expect((at(p)[2] as { value: number }).value).toBe(0.9);
      for (const op of at(p)) expect("envelope" in op).toBe(false);
    }
  });

  test("gate and envelope multiply", () => {
    // the day is OUTSIDE season:Harvest, so the gate contributes 1 − 0.5 and the
    // envelope another 0.5 on top of it
    const timeOf = (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name: "Sable", phase: 0.25 }], tags: [] });
    const m: Modifier = {
      id: "both",
      apply: [{ param: "precipitation.pwd", op: "offset", value: 10, envelope: [[0, 0], [0.5, 1]] }],
      mods: [{ source: "season:Harvest", amount: 0.5 }],
    };
    expect((new ModifierEngine({ seed: "s", zoneId: "z", modifiers: [m], timeOf }).forDay(1, "normal").ops[0] as { value: number }).value).toBeCloseTo(2.5, 12);
  });
});
