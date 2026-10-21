/**
 * P3c step 0 (docs/SESHAT-v0.md §15.9 S1): every validation problem carries
 * the part of the definition it is about, so the calendar window can show it
 * on the ledger entry or field it names. `validate` keeps its messages and
 * their order; `problems` adds the location. Also the two calendar fields
 * the later steps read (origin, previous) and their sanitizers.
 */
import { describe, expect, test } from "bun:test";
import { GREGORIAN, print, problems, validate, type CalendarAst, type Problem } from "../src/seshat";
import { prepareDefinition, worldProblems } from "../src/plugin/time/seshat";
import { migrateSettings } from "../src/plugin/settings";
import { SESHAT_FIXTURES } from "./fixtures/seshat/calendars";

// a ten-day year of two five-day parts
const TEN: CalendarAst = {
  name: "ten",
  gears: [],
  units: [
    { id: "year", kind: "cycle", anchor: 0, length: 10 },
    { id: "part", kind: "slots", in: "year", slots: [{ name: "a", length: 5 }, { name: "b", length: 5 }] },
  ],
};
const withLedger = (ledger: unknown[]): CalendarAst => ({ ...TEN, units: [{ ...TEN.units[0]!, ledger } as CalendarAst["units"][number], TEN.units[1]!] });
const where = (p: Problem): Omit<Problem, "message"> => {
  const { message: _m, ...rest } = p;
  return rest;
};

describe("validation problems carry their location", () => {
  test("the base calendar is clean, so each case below fails only on what it changes", () => {
    expect(problems(TEN)).toEqual([]);
    expect(problems(withLedger([{ kind: "slots", from: 1, unit: "part", lengths: [3, 7] }]))).toEqual([]);
  });

  test("a ledger entry of an unknown kind is that entry's problem", () => {
    const found = problems(withLedger([{ kind: "slots", from: 1, unit: "part", lengths: [3, 7] }, { kind: "bogus", from: 2 }]));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("ledger entry 2: kind");
    expect(where(found[0]!)).toEqual({ unit: "year", entry: 1 });
  });

  test("a switch whose own rule is broken is that switch's problem", () => {
    const found = problems(withLedger([{ kind: "switch", from: 5, rule: { anchor: 0, length: 0 } }]));
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(where(p)).toEqual({ unit: "year", entry: 0 });
  });

  test("a pin that leaves an occurrence no days (V7, on the compiled starts) is the pin's problem", () => {
    // occurrence 2 starts on day 20 by the rule; pinning occurrence 3 there leaves occurrence 2 empty
    const found = problems(withLedger([{ kind: "slots", from: 1, unit: "part", lengths: [3, 7] }, { kind: "starts", from: 3, startsOn: 20 }]));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("(V7)");
    expect(where(found[0]!)).toEqual({ unit: "year", entry: 1 });
  });

  test("a pin on a switch's first occurrence is the switch's problem", () => {
    const found = problems(withLedger([{ kind: "starts", from: 2, startsOn: 20 }, { kind: "switch", from: 3, rule: { anchor: 0, length: 10 } }, { kind: "starts", from: 3, startsOn: 30 }]));
    const clash = found.filter((p) => p.message.includes("both pinned and a switch"));
    expect(clash).toHaveLength(1);
    expect(where(clash[0]!)).toEqual({ unit: "year", entry: 1 });
  });

  test("a slot override that does not fill its year is the override's problem, on the cycle that holds it", () => {
    const found = problems(withLedger([{ kind: "slots", from: 1, unit: "part", lengths: [3, 8] }]));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('unit "part"');
    expect(where(found[0]!)).toEqual({ unit: "year", entry: 0 });
  });

  test("a slot unit whose own slots do not fill the year is the slot unit's problem", () => {
    const ast: CalendarAst = { ...TEN, units: [TEN.units[0]!, { id: "part", kind: "slots", in: "year", slots: [{ name: "a", length: 5 }, { name: "b", length: 6 }] }] };
    const found = problems(ast);
    expect(found).toHaveLength(1);
    expect(where(found[0]!)).toEqual({ unit: "part" });
  });

  test("gears, bodies, named rules and day labels each own their problems", () => {
    const ast: CalendarAst = {
      ...TEN,
      gears: [{ id: "leap", on: "nope", kind: "intervals", terms: [{ every: 4, sign: 1 }] }],
      bodies: [{ id: "luna", period: { n: 2, d: 4 }, epoch: { n: 0, d: 1 } }],
      rules: [{ id: "feast", rule: { kind: "dates", days: [] } }],
      days: [{ day: 1.5, name: "half" }],
    };
    const found = problems(ast);
    expect(found.map(where)).toEqual([{ body: "luna" }, { day: 0 }, { gear: "leap" }, { rule: "feast" }]);
  });

  test("validate is problems without locations: same messages, same order, on every fixture and every case here", () => {
    const cases: CalendarAst[] = [
      ...Object.values(SESHAT_FIXTURES),
      withLedger([{ kind: "bogus", from: 2 }]),
      withLedger([{ kind: "switch", from: 5, rule: { anchor: 0, length: 0 } }]),
      withLedger([{ kind: "starts", from: 3, startsOn: 20 }]),
      withLedger([{ kind: "slots", from: 1, unit: "part", lengths: [3, 8] }]),
    ];
    for (const ast of cases) expect(problems(ast).map((p) => p.message)).toEqual(validate(ast));
  });
});

describe("prepareDefinition reports every problem", () => {
  test("all of them, located, with the first as the error", () => {
    const ast: CalendarAst = {
      ...GREGORIAN,
      units: GREGORIAN.units.map((u) => (u.id === "year" ? { ...u, id: "annum" } : u)),
    };
    // renaming the year breaks the units that sit in it and the world's need for a year
    const text = print(ast);
    const r = prepareDefinition(text);
    if (!("error" in r)) throw new Error("expected a refusal");
    expect(r.problems.length).toBeGreaterThan(1);
    expect(r.error).toBe(r.problems[0]!.message);
    expect(r.problems.some((p) => p.message.includes('id "year"'))).toBe(true);
  });

  test("a world rule problem names its rule", () => {
    const ast: CalendarAst = { ...TEN, rules: [{ id: "thrice", rule: { kind: "recur", freq: "year", count: 3 } }] };
    expect(problems(ast)).toEqual([]);
    expect(worldProblems(ast).map(where)).toEqual([{ rule: "thrice" }]);
  });

  test("a parse error is one problem with no location, and keeps its line", () => {
    const r = prepareDefinition("not a calendar");
    if (!("error" in r)) throw new Error("expected a refusal");
    expect(r.problems).toEqual([{ message: r.error }]);
  });

  test("a clean definition still prepares", () => {
    expect("text" in prepareDefinition(print(GREGORIAN))).toBe(true);
  });
});

describe("calendar origin and the undo record (§15.1 R3, §15.9 S6)", () => {
  const load = (calendar: Record<string, unknown>) => {
    const warnings: string[] = [];
    const s = migrateSettings({ calendar }, (m) => warnings.push(m));
    return { calendar: s.calendar, warnings };
  };

  test("a missing origin stays missing (reads as legacy) and a missing file adds none", () => {
    expect(load({}).calendar).not.toHaveProperty("origin");
    expect(migrateSettings(null).calendar).not.toHaveProperty("origin");
    expect(migrateSettings(undefined).calendar).not.toHaveProperty("previous");
  });

  test("origin 'definition' is kept; anything else is dropped with a message, never turned into a definition world", () => {
    expect(load({ origin: "definition" })).toEqual({ calendar: expect.objectContaining({ origin: "definition" }), warnings: [] });
    for (const v of ["legacy", "", 1, null, { origin: "definition" }]) {
      const r = load({ origin: v });
      expect(r.calendar).not.toHaveProperty("origin");
      expect(r.warnings).toHaveLength(1);
    }
  });

  test("a previous record keeps its definition as stored, even one that cannot run", () => {
    const r = load({ previous: { definition: 42, activeTimeAdapter: "seshat", stray: true } });
    expect(r.calendar.previous).toEqual({ definition: 42, activeTimeAdapter: "seshat" });
    expect(r.warnings).toEqual([]);
    expect(load({ previous: { activeTimeAdapter: "internal" } }).calendar.previous).toEqual({ activeTimeAdapter: "internal" });
  });

  test("a previous record without an adapter id is dropped with a message", () => {
    for (const v of [null, "text", { definition: "x" }, { activeTimeAdapter: 3 }]) {
      const r = load({ previous: v });
      expect(r.calendar).not.toHaveProperty("previous");
      expect(r.warnings).toHaveLength(1);
    }
  });

  test("the stored definition and the legacy fields pass through untouched beside them", () => {
    const r = load({ definition: "SESHAT:1\r\nnot canonical", origin: "definition", yearLength: 360 });
    expect(r.calendar.definition).toBe("SESHAT:1\r\nnot canonical");
    expect(r.calendar.yearLength).toBe(360);
  });
});
