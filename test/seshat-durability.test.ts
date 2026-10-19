/**
 * wadjet-qff: a cross-model (Parallax) durability pass on the text syntax
 * before P3 makes it a stored form. Each test is one of its repros; the rule
 * they share: anything validate() and print() accept, parse() must accept,
 * and nothing a calendar can hold may hang or crash validation.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, parse, print, validate, type CalendarAst, type RuleAst } from "../src/seshat";

const withBody = (period: { n: number; d: number }, epoch: { n: number; d: number }): CalendarAst => ({ ...GREGORIAN, bodies: [{ id: "m", period, epoch }] });

describe("what validates and prints, parses", () => {
  test("a body rational not in lowest terms (or with a negative denominator) is a validation error, and the printer refuses it", () => {
    for (const [period, epoch] of [
      [{ n: 118, d: 4 }, { n: 0, d: 1 }],
      [{ n: 59, d: 2 }, { n: 2, d: 4 }],
      [{ n: 59, d: 2 }, { n: 3, d: -2 }],
    ] as const) {
      const ast = withBody(period, epoch);
      expect(validate(ast).join()).toContain("lowest terms");
      expect(() => print(ast)).toThrow(/lowest terms/);
    }
    const ok = withBody({ n: 59, d: 2 }, { n: 1, d: 2 });
    expect(validate(ok)).toEqual([]);
    expect(parse(print(ok))).toEqual(ok);
  });

  test("rules nest at most 64 deep: deeper is a validation error and a print error; 64 round-trips", () => {
    const nest = (n: number): RuleAst => {
      let r: RuleAst = { kind: "tag", tag: "x" };
      for (let i = 0; i < n; i++) r = { kind: "not", of: r };
      return r;
    };
    const cal = (n: number): CalendarAst => ({ ...GREGORIAN, rules: [{ id: "deep", rule: nest(n) }] });
    expect(validate(cal(64))).toEqual([]);
    expect(parse(print(cal(64)))).toEqual(cal(64));
    expect(validate(cal(65)).join()).toContain("nest deeper than 64");
    expect(() => print(cal(65))).toThrow(/nest deeper than 64/);
    expect(() => print(cal(200))).toThrow(/nest deeper than 64/);
  });

  test("the printer refuses a field it has no text form for, at every level, so a save never drops it", () => {
    const extra = <T extends object>(o: T): T => ({ ...o, colour: "red" });
    const g = GREGORIAN;
    const cases: CalendarAst[] = [
      extra(g),
      { ...g, units: g.units.map((u, i) => (i === 0 ? extra(u) : u)) },
      { ...g, units: g.units.map((u) => (u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 0 ? extra(s) : s)) } : u)) },
      { ...g, units: g.units.map((u) => (u.id === "weekday" && u.kind === "cycle" ? { ...u, labels: u.labels!.map((l, i) => (i === 0 ? extra(l) : l)) } : u)) },
      { ...g, gears: g.gears.map(extra) },
      { ...g, formats: g.formats!.map(extra) },
      { ...g, days: [extra({ day: 0, name: "x" })] },
      { ...g, rules: [extra({ id: "r", rule: { kind: "tag", tag: "x" } })] },
      { ...g, rules: [{ id: "r", rule: extra({ kind: "tag", tag: "x" }) }] },
      { ...g, rules: [{ id: "r", rule: { kind: "recur", freq: "year", by: [extra({ unit: "month", nth: [1] })] } }] },
    ];
    for (const c of cases) expect(() => print(c)).toThrow(/has a field "colour" with no text form/);
    // a key holding undefined is absent, not unknown
    expect(() => print({ ...g, colour: undefined } as CalendarAst)).not.toThrow();
  });
});

describe("nothing a stored calendar holds hangs or crashes validation", () => {
  test("a unit that is its own parent (a typo in IN) is an error list, fast, with a format reading it", () => {
    const ast: CalendarAst = { name: "loop", gears: [], units: [{ id: "a", kind: "slots", in: "a", slots: [{ name: "x", length: 1 }] }], formats: [{ name: "default", pattern: "{a}" }] };
    const t = performance.now();
    const errors = validate(ast);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(errors.join()).toContain("loops");
  });

  test("two positions gears of period 100,000 with 99,999 positions each validate in seconds, not minutes (was 17 s)", () => {
    const all = Array.from({ length: 99_999 }, (_, i) => i);
    const ast: CalendarAst = {
      name: "big gears",
      gears: [
        { id: "g1", on: "year", kind: "positions", period: 100_000, positions: all },
        { id: "g2", on: "year", kind: "positions", period: 100_000, positions: all.map((p) => p + 1) },
      ],
      units: [
        { id: "year", kind: "cycle", anchor: 0, length: 400, ledger: [{ kind: "switch", from: 10, rule: { anchor: 0, length: 400 } }] },
        { id: "part", kind: "slots", in: "year", slots: [{ name: "a", length: 100, gears: [{ gear: "g1", add: 1 }, { gear: "g2", add: 1 }] }, { name: "b", length: "slack" }] },
      ],
    };
    const t = performance.now();
    validate(ast);
    expect(performance.now() - t).toBeLessThan(5000);
  });

  test("more than 1,000 ledger switches on one unit is a validation error", () => {
    const ledger = Array.from({ length: 1001 }, (_, i) => ({ kind: "switch" as const, from: i * 10, rule: { anchor: 0, length: 365 } }));
    const ast: CalendarAst = { name: "decrees", gears: [], units: [{ id: "year", kind: "cycle", anchor: 0, length: 365, ledger }] };
    expect(validate(ast).join()).toContain("1001 ledger switches; at most 1000");
  });
});

describe("strings and numbers survive a trip through a file", () => {
  test("a lone surrogate anywhere is a validation error (UTF-8 would turn it into U+FFFD)", () => {
    const lone = `a${String.fromCharCode(0xd800)}`;
    expect(validate({ ...GREGORIAN, days: [{ day: 0, tags: [lone] }] }).join()).toContain("not well-formed text");
    expect(validate({ ...GREGORIAN, name: `${String.fromCharCode(0xdc00)}x` }).join()).toContain("not well-formed text");
    // a proper pair is fine
    expect(validate({ ...GREGORIAN, name: `moon ${String.fromCharCode(0xd83c, 0xdf15)}` })).toEqual([]);
  });

  test("names and tags are NFC (ruled 2026-10-19): a decomposed accent is a validation error", () => {
    const composed = `caf${String.fromCharCode(0xe9)}`;
    const decomposed = `cafe${String.fromCharCode(0x301)}`;
    expect(composed).not.toBe(decomposed);
    expect(decomposed.normalize("NFC")).toBe(composed);
    expect(validate({ ...GREGORIAN, days: [{ day: 0, tags: [composed] }] })).toEqual([]);
    expect(validate({ ...GREGORIAN, days: [{ day: 0, tags: [decomposed] }] }).join()).toContain("not in Unicode NFC");
  });

  test("display numbers past 2^40 are refused (their digits would not print exactly)", () => {
    const at = (number: number): CalendarAst => ({ ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "year" ? { ...u, number } : u)) });
    expect(validate(at(2 ** 40))).toEqual([]);
    expect(validate(at(2 ** 40 + 1)).join()).toContain("within ±2^40");
    expect(new Engine(at(-(2 ** 40))).ast.units[0]!.number).toBe(-(2 ** 40));
  });
});
