/**
 * The Engine memoizes slot lengths of units that cannot vary (whole-number
 * slots, no gear terms, no ledger slot override). These pin the edges of
 * that rule: an override on an otherwise fixed unit must still be honoured,
 * and the memo must never leak out through the public slotLengths.
 */
import { describe, expect, test } from "bun:test";
import { Engine, validate, type CalendarAst } from "../src/seshat";

// a ten-day year of two five-day parts; year 1's parts are 3 and 7 by decree (a ledger slot override)
const DECREED: CalendarAst = {
  name: "decreed",
  gears: [],
  units: [
    { id: "year", kind: "cycle", anchor: 0, length: 10, ledger: [{ kind: "slots", from: 1, unit: "part", lengths: [3, 7] }] },
    { id: "part", kind: "slots", in: "year", slots: [{ name: "a", length: 5 }, { name: "b", length: 5 }] },
  ],
};

describe("seshat engine: fixed slot lengths", () => {
  test("a ledger slot override on a whole-number unit is honoured in every year it names, and only there", () => {
    expect(validate(DECREED)).toEqual([]);
    const e = new Engine(DECREED);
    expect(e.slotLengths("part", [0])).toEqual([5, 5]);
    expect(e.slotLengths("part", [1])).toEqual([3, 7]);
    expect(e.slotLengths("part", [2])).toEqual([5, 5]);
    // year 1 is days 10..19: part b starts on day 13, not 15
    expect([12, 13, 14, 15].map((d) => e.positionOf("part", d))).toEqual([
      { index: 0, offset: 2 },
      { index: 1, offset: 0 },
      { index: 1, offset: 1 },
      { index: 1, offset: 2 },
    ]);
    expect(e.occurrenceAt("part", 13)).toEqual({ index: 1, start: 13, length: 7 });
    expect(e.positionOf("part", 25)).toEqual({ index: 1, offset: 0 });
  });

  test("slotLengths returns a fresh array: a caller's write never reaches the engine", () => {
    // no override, so "part" is memoized
    const e = new Engine({ ...DECREED, units: [{ id: "year", kind: "cycle", anchor: 0, length: 10 }, DECREED.units[1]!] });
    const lens = e.slotLengths("part", [0]);
    lens[0] = 99;
    expect(e.slotLengths("part", [0])).toEqual([5, 5]);
    expect(e.positionOf("part", 5)).toEqual({ index: 1, offset: 0 });
  });
});
