import { describe, expect, test } from "bun:test";
import { gregorianTime } from "../src/core/generator";
import { ModifierEngine, evaluatePredicate, inPhaseRange, type PredicateContext } from "../src/core/modifiers";
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
