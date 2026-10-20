/**
 * translate(ast, k) (docs/SESHAT-v0.md §13.11 "Day 0"): the calendar moved k
 * days later reads on day d + k what the original reads on day d. Checked on
 * every world-calendar preset (all P1 calendars with a year), for several k,
 * over a span of days and far days: every unit's occurrence (start, length,
 * index), every unit's label, the day's tags and the formatted date. Plus:
 * gear offsets (occurrence indices) and bodies do not move; the result
 * validates; k = 0 is the identity.
 */
import { describe, expect, test } from "bun:test";
import { BAHAI, COPTIC, Engine, ETHIOPIAN, formatDay, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, GREGORIAN, HARPTOS, HEBREW, ISLAMIC_CIVIL, ISLAMIC_TBLA, parse, print, ROMAN, translate, validate, type CalendarAst } from "../src/seshat";

const PRESETS: Record<string, CalendarAst> = { GREGORIAN, ISLAMIC_CIVIL, ISLAMIC_TBLA, COPTIC, ETHIOPIAN, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, HARPTOS, HEBREW, ROMAN, BAHAI };
const KS = [1, -1, 6, 7, 365, -730_119, 1_000_003];

function reading(e: Engine, ast: CalendarAst, d: number): unknown {
  return {
    units: ast.units.map((u) => {
      const o = u.kind === "cycle" ? e.occurrenceAt(u.id, d) : null;
      return { id: u.id, o: o && { length: o.length, index: o.index, offsetInto: d - o.start }, label: e.labelAt(u.id, d) ?? null };
    }),
    tags: e.tagsAt(d),
    text: ast.formats?.length ? formatDay(e, d) : null,
  };
}

describe("a translated calendar reads on d + k what the original reads on d", () => {
  for (const [name, ast] of Object.entries(PRESETS)) {
    test(name, () => {
      const e = new Engine(ast);
      const days = [...Array.from({ length: 800 }, (_, i) => i * 37 - 14_000), 0, 1, -1, 3_000_000, -3_000_000];
      for (const k of KS) {
        const moved = translate(ast, k);
        expect([name, k, validate(moved)]).toEqual([name, k, []]);
        const m = new Engine(moved);
        for (const d of days) expect([k, d, reading(m, moved, d + k)]).toEqual([k, d, reading(e, ast, d)]);
      }
    });
  }

  test("k = 0 is the identity, and a non-integer k is refused", () => {
    expect(translate(GREGORIAN, 0)).toBe(GREGORIAN);
    expect(() => translate(GREGORIAN, 1.5)).toThrow(RangeError);
  });

  test("gear offsets (occurrence indices) stay; bodies, day labels and rule days move", () => {
    const ast: CalendarAst = {
      ...GREGORIAN,
      bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 1, d: 3 }, moon: { name: "Luna" } }],
      days: [{ day: 10, tags: ["coronation"] }],
      rules: [
        { id: "fair", tags: ["fair"], rule: { kind: "any", of: [{ kind: "dates", days: [5, 6] }, { kind: "recur", freq: "year", anchor: 100, until: 5000 }] } },
        { id: "full", tags: ["full"], rule: { kind: "phase", body: "luna", from: 0.45, to: 0.55 } },
      ],
    };
    const moved = translate(ast, 50);
    expect(moved.gears).toEqual(ast.gears);
    expect(moved.bodies).not.toEqual(ast.bodies);
    expect(moved.days).toEqual([{ day: 60, tags: ["coronation"] }]);
    expect(moved.rules![0]!.rule).toEqual({ kind: "any", of: [{ kind: "dates", days: [55, 56] }, { kind: "recur", freq: "year", anchor: 150, until: 5050 }] });
    expect(moved.rules![1]!.rule).toEqual(ast.rules![1]!.rule);
    // everything follows the dates, the body too: its phase on d + k is its phase on d, exactly
    const e = new Engine(ast);
    const m = new Engine(moved);
    for (const k of [50, -1, 7, 123_457]) {
      const mk = new Engine(translate(ast, k));
      for (let d = -400; d <= 400; d += 3) {
        expect([k, d, mk.tagsAt(d + k)]).toEqual([k, d, e.tagsAt(d)]);
        const [a, b] = [mk.moonsAt(d + k)[0]!.phase, e.moonsAt(d)[0]!.phase];
        expect([k, d, Object.is(a, b)]).toEqual([k, d, true]);
      }
    }
    expect(m.moonsAt(123 + 50)).toEqual(e.moonsAt(123));
  });

  test("a translated calendar prints and reads back to itself", () => {
    for (const ast of Object.values(PRESETS)) {
      const moved = translate(ast, 12_345);
      expect(validate(moved)).toEqual([]);
      expect(parse(print(moved))).toEqual(parse(print(parse(print(moved)))));
      expect(print(parse(print(moved)))).toBe(print(moved));
      expect(print(moved)).not.toBe(print(ast)); // it did move
    }
  });

  test("rules that count from day 0 move with it: a daily recurrence without an anchor, an index on the day itself", () => {
    const ast: CalendarAst = {
      ...GREGORIAN,
      rules: [
        { id: "third", tags: ["third"], rule: { kind: "recur", freq: "day", interval: 3 } },
        { id: "daily", tags: ["daily"], rule: { kind: "recur", freq: "day" } },
        { id: "span", tags: ["span"], rule: { kind: "index", unit: "day", from: 100, to: 200 } },
        { id: "open", tags: ["open"], rule: { kind: "index", unit: "day", from: -50 } },
        { id: "monthly", tags: ["monthly"], rule: { kind: "recur", freq: "month", interval: 1, by: [{ unit: "month", day: [1] }] } },
      ],
    };
    const e = new Engine(ast);
    for (const k of [1, 2, 50, -7, 1000]) {
      const moved = translate(ast, k);
      expect(validate(moved)).toEqual([]);
      const m = new Engine(moved);
      for (let d = -300; d <= 300; d++) expect([k, d, m.tagsAt(d + k)]).toEqual([k, d, e.tagsAt(d)]);
    }
  });
});
