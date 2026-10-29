import { describe, expect, test } from "bun:test";
import type { Preset, ZoneProfile } from "../src/core/types";
import { Body, HEBREW, print, rational, toNumber, type Rational } from "../src/seshat";
import { SAFE } from "../src/seshat/rational";
import { dragToValue, nudge, type KnobSpec } from "../src/studio/model/knob";
import { cellOf, cellOfValue, cellValue, checkBody, fromMolad, knobRational, moladOf, moveBody, PARTS_PER_DAY } from "../src/studio/model/rational-knob";
import { initialState } from "../src/studio/model/state";
import { createStore } from "../src/studio/model/store";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
const CENT = rational(1, 100);
const MOLAD = rational(765433, 25920); // 29.530594135802469…
const OFF_GRID = rational(487, 16); // 30.4375

describe("rational knob: step cells", () => {
  test("the cell a rational shows in, rounding half up", () => {
    expect(cellOf(MOLAD, CENT)).toBe(2953);
    expect(cellOf(OFF_GRID, CENT)).toBe(3044); // 3043.75
    expect(cellOf(rational(201, 200), CENT)).toBe(101); // 1.005, an exact tie
    expect(cellOf(rational(-201, 200), CENT)).toBe(-100); // −100.5 rounds up, toward +∞
    expect(cellOf(rational(3, 1), rational(1, 4))).toBe(12);
  });

  test("a float knob value is read at its shortest decimal, so it agrees with the rational on a tie", () => {
    expect(1.005 * 100).toBeLessThan(100.5); // the float product would round down
    expect(cellOfValue(1.005, CENT)).toBe(101);
    expect(cellOfValue(29.53, CENT)).toBe(2953);
    expect(cellOfValue(0.29, CENT)).toBe(29);
  });

  test("cellValue is cell·step, reduced", () => {
    expect(cellValue(2953, CENT)).toEqual({ n: 2953, d: 100 });
    expect(cellValue(3050, CENT)).toEqual({ n: 61, d: 2 });
    expect(cellValue(3000, CENT)).toEqual({ n: 30, d: 1 });
  });

  test("a step must be positive", () => {
    expect(() => cellOf(MOLAD, { n: 0, d: 1 })).toThrow(RangeError);
    expect(() => cellOf(MOLAD, { n: -1, d: 100 })).toThrow(RangeError);
  });
});

describe("rational knob: writes and the origin snap-back", () => {
  test("the knob as seeded writes the origin itself", () => {
    expect(knobRational(toNumber(MOLAD), MOLAD, CENT)).toBe(MOLAD);
    expect(knobRational(toNumber(OFF_GRID), OFF_GRID, CENT)).toBe(OFF_GRID);
  });

  test("765433/25920 shows as 29.53: any value in that cell writes the molad back exactly", () => {
    for (const v of [29.525, 29.53, 29.5349, 29.530594]) expect(knobRational(v, MOLAD, CENT)).toBe(MOLAD);
    expect(knobRational(29.5249, MOLAD, CENT)).toEqual({ n: 738, d: 25 }); // the 29.52 cell, reduced
    expect(knobRational(29.535, MOLAD, CENT)).toEqual({ n: 1477, d: 50 }); // the next cell's lower edge
  });

  test("487/16 = 30.4375 is off the 0.01 grid: kept until the knob leaves the 30.44 cell", () => {
    expect(knobRational(30.44, OFF_GRID, CENT)).toBe(OFF_GRID);
    expect(knobRational(30.435, OFF_GRID, CENT)).toBe(OFF_GRID); // the cell's lower edge
    expect(knobRational(30.4449, OFF_GRID, CENT)).toBe(OFF_GRID);
    expect(knobRational(30.45, OFF_GRID, CENT)).toEqual({ n: 609, d: 20 });
    expect(knobRational(30.43, OFF_GRID, CENT)).toEqual({ n: 3043, d: 100 });
  });

  test("a moved value is the step grid's rational, reduced", () => {
    expect(knobRational(29.54, MOLAD, CENT)).toEqual({ n: 1477, d: 50 });
    expect(knobRational(29.5, MOLAD, CENT)).toEqual({ n: 59, d: 2 });
    expect(knobRational(30, null, CENT)).toEqual({ n: 30, d: 1 });
    // with no origin, a value is just its cell
    expect(knobRational(toNumber(MOLAD), null, CENT)).toEqual({ n: 2953, d: 100 });
  });

  test("a drag that ends where it began snaps back; one that wanders and returns does too", () => {
    const spec: KnobSpec = { min: 1, max: 1000, step: 0.01, scale: "log" };
    const start = toNumber(MOLAD);
    const frames = [-3, -8, -2, 4, 1, 0].map((dy) => knobRational(dragToValue(start, dy, spec), MOLAD, CENT));
    expect(frames.slice(0, 2).every((r) => r !== MOLAD)).toBe(true);
    expect(frames.at(-1)).toBe(MOLAD);
  });

  test("a keyboard nudge from the origin leaves its cell", () => {
    const spec: KnobSpec = { min: 1, max: 100, step: 0.01 };
    expect(knobRational(nudge(toNumber(MOLAD), spec, 1), MOLAD, CENT)).toEqual({ n: 1477, d: 50 });
    expect(knobRational(nudge(toNumber(MOLAD), spec, -1), MOLAD, CENT)).toEqual({ n: 738, d: 25 });
  });

  test("a molad step (1/25920) on a molad origin: one part either way, and back", () => {
    const part = rational(1, PARTS_PER_DAY);
    const v = toNumber(MOLAD);
    expect(knobRational(v + 1 / PARTS_PER_DAY, MOLAD, part)).toEqual(rational(765434, 25920));
    expect(knobRational(v - 1 / PARTS_PER_DAY, MOLAD, part)).toEqual(rational(765432, 25920));
    expect(knobRational(v + 0.3 / PARTS_PER_DAY, MOLAD, part)).toBe(MOLAD);
  });
});

describe("rational knob: the Body safe-integer limit", () => {
  test("checkBody agrees with new Body on every case", () => {
    const big = 2 ** 27 + 1; // P·Q ≈ 2^54, past SAFE
    const cases: Array<[Rational, Rational]> = [
      [MOLAD, rational(0)],
      [MOLAD, rational(12084, 25920)],
      [rational(big, big - 2), rational(0)],
      [rational(94906267, 3), rational(0)], // P·Q < SAFE, 2·P·F with F = 1
      [rational(1e8 + 7, 1), rational(1, 5e7 + 1)], // 2·P·F > SAFE
      [rational(-5, 1), rational(0)],
      [rational(0), rational(0)],
    ];
    for (const [p, e] of cases) {
      let runs = true;
      try {
        new Body(p, e);
      } catch {
        runs = false;
      }
      expect(checkBody(p, e).kind).toBe(runs ? "write" : "refused");
    }
  });

  test("a refusal says why, plainly", () => {
    const r = checkBody(rational(1e8 + 7, 1), rational(1, 5e7 + 1));
    expect(r).toEqual({ kind: "refused", reason: expect.stringContaining("too large to count exactly") });
    expect(checkBody(rational(-1), rational(0))).toEqual({ kind: "refused", reason: "a period must be longer than 0 days" });
  });

  test("the limit is the epoch's reduced denominator: an epoch of 7/2 counts as 1/2", () => {
    const P = rational(Math.floor(SAFE / 4), 1);
    expect(checkBody(P, rational(7, 2)).kind).toBe("write");
    expect(checkBody(P, rational(1, 3)).kind).toBe("refused");
  });
});

describe("rational knob: moving a body keeps the half that did not move", () => {
  const stored = { period: MOLAD, epoch: rational(12084, 25920) };

  test("the Hebrew molad stores 765433/25920 (the fixture this module is shaped for)", () => {
    expect(print(HEBREW)).toContain("765433/25920");
  });

  test("a period-only move keeps the stored epoch rational, exactly and as the same object", () => {
    const w = moveBody(stored, { period: rational(1477, 50) });
    expect(w.kind).toBe("write");
    if (w.kind !== "write") return;
    expect(w.period).toEqual({ n: 1477, d: 50 });
    expect(w.epoch).toBe(stored.epoch);
  });

  test("an epoch-only move keeps the stored period", () => {
    const w = moveBody(stored, { epoch: rational(1, 4) });
    expect(w.kind === "write" && w.period === stored.period && w.epoch.n === 1 && w.epoch.d === 4).toBe(true);
  });

  test("a mixed pair that would overflow is refused, never re-derived", () => {
    const fine = { period: rational(1, 1), epoch: rational(1, Math.floor(SAFE / 4)) };
    const w = moveBody(fine, { period: rational(3, 1) });
    expect(w.kind).toBe("refused");
    // the same move on a coarser epoch runs, keeping it
    expect(moveBody({ ...fine, epoch: rational(1, 3) }, { period: rational(3, 1) })).toEqual({ kind: "write", period: { n: 3, d: 1 }, epoch: { n: 1, d: 3 } });
  });

  test("no move is the stored pair", () => {
    expect(moveBody(stored, {})).toEqual({ kind: "write", period: stored.period, epoch: stored.epoch });
  });
});

describe("rational knob: molad d·h·parts", () => {
  test("reads 765433/25920 as 29d 12h 793p, exactly", () => {
    expect(moladOf(MOLAD)).toEqual({ molad: { days: 29, hours: 12, parts: 793 }, exact: true });
    expect(moladOf(rational(12084, 25920))).toEqual({ molad: { days: 0, hours: 11, parts: 204 }, exact: true }); // BaHaRaD 5h 204p + 6h
  });

  test("a reduced rational whose denominator divides 25920 is exact", () => {
    expect(moladOf(rational(1, 2))).toEqual({ molad: { days: 0, hours: 12, parts: 0 }, exact: true });
    expect(moladOf(rational(30))).toEqual({ molad: { days: 30, hours: 0, parts: 0 }, exact: true });
  });

  test("a value off the parts grid rounds to the nearest part and says so", () => {
    expect(moladOf(rational(1, 7))).toEqual({ molad: { days: 0, hours: 3, parts: 463 }, exact: false }); // 3702.857… parts
  });

  test("negative spans keep hours and parts non-negative", () => {
    expect(moladOf(rational(-1, 25920))).toEqual({ molad: { days: -1, hours: 23, parts: 1079 }, exact: true });
  });

  test("writes n/25920, reduced, and round-trips", () => {
    expect(fromMolad({ days: 29, hours: 12, parts: 793 })).toEqual({ kind: "write", value: MOLAD });
    expect(fromMolad({ days: 0, hours: 12, parts: 0 })).toEqual({ kind: "write", value: { n: 1, d: 2 } });
    for (const r of [MOLAD, rational(12084, 25920), rational(-1, 25920), rational(365, 1)]) {
      const w = fromMolad(moladOf(r).molad);
      expect(w).toEqual({ kind: "write", value: r });
    }
  });

  test("refuses hours and parts out of range, and non-integers", () => {
    expect(fromMolad({ days: 0, hours: 24, parts: 0 }).kind).toBe("refused");
    expect(fromMolad({ days: 0, hours: -1, parts: 0 }).kind).toBe("refused");
    expect(fromMolad({ days: 0, hours: 0, parts: 1080 }).kind).toBe("refused");
    expect(fromMolad({ days: 0.5, hours: 0, parts: 0 }).kind).toBe("refused");
    expect(fromMolad({ days: 2 ** 50, hours: 0, parts: 0 })).toEqual({ kind: "refused", reason: "that many days is too large to count exactly" });
  });
});

describe("rational knob: a drag through the store is one undo step, and a snap-back is none", () => {
  const zone: ZoneProfile = { id: "z", name: "Z", schemaVersion: 1, climate: structuredClone(fjord.climate), regimes: structuredClone(fjord.regimes), modifiers: [] };
  const harness = () =>
    createStore(initialState({ zones: [zone], eras: [], calendar: { seasons: [], moons: [{ name: "Sable", cycleDays: toNumber(MOLAD), phaseAtEpoch: 0 }] }, devicePresets: [], overrides: [] }, "z"), (f) => f());
  const spec: KnobSpec = { min: 1, max: 1000, step: 0.01, scale: "log" };

  /** The editor's onChange: write every frame without history, snapshot when the gesture ends (device/index.ts `gesture`). */
  function drag(store: ReturnType<typeof harness>, dys: number[]): void {
    const start = toNumber(MOLAD);
    dys.forEach((dy, i) => {
      const r = knobRational(dragToValue(start, dy, spec), MOLAD, CENT);
      store.update((s) => {
        s.world.calendar.moons[0]!.cycleDays = toNumber(r);
      });
      if (i === dys.length - 1) store.snapshot();
    });
  }

  test("many frames, one snapshot: one undo step", () => {
    const store = harness();
    drag(store, [-1, -3, -6, -9, -12]);
    expect(store.worldDirty()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.get().world.calendar.moons[0]!.cycleDays).toBe(toNumber(MOLAD));
    expect(store.canUndo()).toBe(false);
  });

  test("a drag that ends in the origin's cell leaves the draft equal to stored and takes no step", () => {
    const store = harness();
    drag(store, [-4, -9, -3, 0]);
    expect(store.worldDirty()).toBe(false);
    expect(store.canUndo()).toBe(false);
  });
});
