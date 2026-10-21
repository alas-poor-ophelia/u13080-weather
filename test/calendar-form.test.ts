/**
 * P3c step 1 (docs/SESHAT-v0.md §15.2, §15.9 B3 B4 S3 S4 S8): the form model.
 * Gates: a no-op edit prints identical text; each `form` part compiles back to
 * its own AST; edit then revert gives the identical hash; every excluded shape
 * is `text` and passes through compile untouched.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, HEBREW, ROMAN, print, type CalendarAst, type UnitAst } from "../src/seshat";
import { compile, FormError, recognise, type CalendarForm, type FormEdits } from "../src/plugin/time/form";
import { definitionFromLegacy, prepareDefinition, SeshatCalendar } from "../src/plugin/time/seshat";
import { WORLD_PRESETS } from "../src/plugin/opt-in";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { SESHAT_FIXTURES } from "./fixtures/seshat/calendars";

const PLAIN = (() => {
  const r = definitionFromLegacy(DEFAULT_SETTINGS.calendar);
  if ("refused" in r) throw new Error(r.refused);
  return r.ast;
})();
const ALL: Array<[string, CalendarAst]> = [
  ["plain", PLAIN],
  ...WORLD_PRESETS.map((p) => [`preset ${p.id}`, p.ast] as [string, CalendarAst]),
  ...Object.entries(SESHAT_FIXTURES).map(([k, a]) => [`fixture ${k}`, a] as [string, CalendarAst]),
];
const PARTS = ["name", "year", "months", "week", "seasons", "moons"] as const;
const hash = (ast: CalendarAst): string => new SeshatCalendar(print(ast), () => 0).configHash();
const formOf = <K extends (typeof PARTS)[number]>(f: CalendarForm, k: K) => {
  const p = f[k];
  if (p.kind !== "form") throw new Error(`${k} is text: ${p.why}`);
  return p.value as NonNullable<FormEdits[K]>;
};

describe("round trip over every preset, fixture and the plain new-world definition", () => {
  test.each(ALL)("%s: no edit is the same calendar, and every form part writes back to itself", (_name, ast) => {
    expect(compile(ast, {})).toBe(ast);
    const f = recognise(ast);
    for (const k of PARTS) {
      const p = f[k];
      if (p.kind === "text") {
        expect(p.why.length).toBeGreaterThan(0);
        expect(() => compile(ast, { [k]: null })).toThrow(FormError);
        continue;
      }
      expect(print(compile(ast, { [k]: p.value }))).toBe(print(ast));
    }
  });
});

describe("what the form recognises", () => {
  test("Gregorian: every part is a field; leap years in displayed years", () => {
    const f = recognise(GREGORIAN);
    expect(formOf(f, "year")).toEqual({
      length: 365,
      firstYear: 0,
      leap: { add: 1, terms: [{ every: 4, at: 0, sign: 1 }, { every: 100, at: 0, sign: -1 }, { every: 400, at: 0, sign: 1 }] },
    });
    expect(formOf(f, "months")).toHaveLength(12);
    expect(formOf(f, "months")[1]).toEqual({ name: "February", length: "slack" });
    expect(formOf(f, "week")).toEqual(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
    expect(f.others).toEqual([]);
  });

  test("the plain definition: a 365-day year, no months, no week, no seasons, the default moon", () => {
    const f = recognise(PLAIN);
    expect(formOf(f, "year")).toEqual({ length: 365, firstYear: 1, leap: null });
    expect(f.months).toEqual({ kind: "form", value: null });
    expect(f.week).toEqual({ kind: "form", value: null });
    expect(formOf(f, "seasons")).toEqual([]);
    expect(formOf(f, "moons").map((m) => [m.name, m.period])).toEqual([["Moon", { n: 2953, d: 100 }]]);
  });

  test("Hebrew's year is text (it follows the moon) while its other parts may still be fields (R1)", () => {
    const f = recognise(HEBREW);
    expect(f.year.kind).toBe("text");
    expect(f.name.kind).toBe("form");
    expect(f.seasons.kind).toBe("form");
    expect(f.moons.kind).toBe("form");
  });

  test("a ledger on the year never makes the year text (B3), and passes through a year edit", () => {
    expect(ROMAN.units.find((u) => u.id === "year")).toHaveProperty("ledger");
    const withLedger: CalendarAst = {
      ...PLAIN,
      units: [{ ...(PLAIN.units[0] as Extract<CalendarAst["units"][number], { kind: "cycle" }>), ledger: [{ kind: "starts", from: 10, startsOn: 3651 }] }],
    };
    const y = formOf(recognise(withLedger), "year");
    const out = compile(withLedger, { year: { ...y, length: 360 } });
    expect((out.units[0] as { ledger?: unknown }).ledger).toEqual([{ kind: "starts", from: 10, startsOn: 3651 }]);
  });

  test("which presets' years, months and weeks are fields (pinned, so a recogniser that gave up everywhere fails)", () => {
    const fields = (k: "year" | "months" | "week") => WORLD_PRESETS.filter((p) => recognise(p.ast)[k].kind === "form").map((p) => p.id);
    expect(fields("year")).toEqual(["gregorian", "coptic", "ethiopian", "french-republican", "bahai"]);
    expect(fields("months")).toEqual(["gregorian", "islamic-civil", "islamic-tbla", "coptic", "ethiopian"]);
    expect(fields("week")).toEqual(WORLD_PRESETS.map((p) => p.id));
  });

  test("a text part survives, deep-equal, an edit to every other part that is a field", () => {
    const y = HEBREW.units.find((u) => u.id === "year");
    const out = compile(HEBREW, { seasons: [{ name: "Wet", from: 0 }], name: "Renamed", week: ["A", "B", "C", "D", "E", "F", "G"] });
    expect(out.units.find((u) => u.id === "year")).toEqual(y);
    for (const [, ast] of ALL) {
      const f = recognise(ast);
      const edits: FormEdits = {
        ...(f.name.kind === "form" ? { name: "Renamed" } : {}),
        ...(f.seasons.kind === "form" ? { seasons: [{ name: "Wet", from: 0 }] } : {}),
      };
      const out = compile(ast, edits);
      // nothing but the name and the seasons field moved: units, gears, bodies, rules, days, formats are as stored
      for (const key of ["units", "gears", "bodies", "rules", "days", "formats"] as const) expect(out[key]).toEqual(ast[key] as never);
      for (const k of PARTS) if (f[k].kind === "text") expect(recognise(out)[k]).toEqual(f[k]);
    }
  });
});

describe("edits", () => {
  test("edit then revert gives the identical hash and text, for every form part of Gregorian", () => {
    const f = recognise(GREGORIAN);
    const edits: FormEdits[] = [
      { name: "Other" },
      { year: { ...formOf(f, "year"), length: 360 } },
      { year: { ...formOf(f, "year"), firstYear: 1 } },
      { year: { ...formOf(f, "year"), leap: null } },
      { months: formOf(f, "months").map((m, i) => (i === 0 ? { ...m, name: "Janus" } : m)) },
      { week: ["A", "B", "C", "D", "E"] },
      { seasons: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] },
      { moons: [{ name: "Moon", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 } }] },
    ];
    for (const e of edits) {
      const k = Object.keys(e)[0] as keyof FormEdits;
      const edited = compile(GREGORIAN, e);
      expect(print(edited)).not.toBe(print(GREGORIAN));
      const back = compile(edited, { [k]: formOf(f, k) });
      expect(print(back)).toBe(print(GREGORIAN));
      expect(hash(back)).toBe(hash(GREGORIAN));
    }
  });

  test("changing the first year keeps the same displayed years leap (B4)", () => {
    const y = formOf(recognise(GREGORIAN), "year");
    const shifted = compile(GREGORIAN, { year: { ...y, firstYear: 1 } });
    expect("text" in prepareDefinition(print(shifted))).toBe(true);
    const e = new Engine(shifted);
    // index i is displayed as year i + 1
    for (const shown of [1900, 1999, 2000, 2001, 2004, 2100, 2400]) {
      const leap = (shown % 4 === 0 && shown % 100 !== 0) || shown % 400 === 0;
      expect(e.length("year", shown - 1)).toBe(leap ? 366 : 365);
    }
    // and the leap gear's offset is what changed, not the terms the form shows
    expect(formOf(recognise(shifted), "year").leap).toEqual(y.leap);
  });

  test("stored offsets spelled differently for the same years (French −1, Bahá'í 3) are kept by edits that leave their meaning", () => {
    for (const id of ["french-republican", "bahai"]) {
      const ast = WORLD_PRESETS.find((p) => p.id === id)!.ast;
      const y = formOf(recognise(ast), "year");
      expect(y.firstYear).toBe(1);
      expect(y.leap!.terms[0]).toEqual({ every: 4, at: 0, sign: 1 });
      // a length edit leaves the leap gear exactly as stored
      const longer = compile(ast, { year: { ...y, length: 366 } });
      expect(longer.gears).toEqual(ast.gears);
      // first year 5 is still 1 mod 4: the four-year term keeps its stored spelling
      const five = compile(ast, { year: { ...y, firstYear: 5 } });
      const firstTerm = (a: CalendarAst): unknown => {
        const g = a.gears[0];
        return g?.kind === "intervals" ? g.terms[0] : undefined;
      };
      expect(firstTerm(five)).toEqual(firstTerm(ast));
      expect(firstTerm(ast)).toBeDefined();
    }
  });

  test("over awkward first years, every year-field preset keeps the same displayed years leap, and its stored value compiles back to it", () => {
    // the Studio compiles stored + draft every time, so "revert" is the draft equal to the stored value again
    const presets = WORLD_PRESETS.filter((p) => recognise(p.ast).year.kind === "form");
    expect(presets.length).toBe(5);
    for (const { ast } of presets) {
      const y = formOf(recognise(ast), "year");
      if (!y.leap) continue;
      // a ledger switch counts occurrences, not displayed years (B3): Bahá'í follows the equinox from occurrence
      // 171, whatever that year is called, so only years the leap rule governs are compared
      const yearUnit = ast.units.find((u) => u.id === "year") as { ledger?: ReadonlyArray<{ kind: string; from: number }> };
      const firstSwitch = Math.min(...(yearUnit.ledger ?? []).filter((l) => l.kind === "switch").map((l) => l.from));
      const leapYears = (a: CalendarAst, first: number): number[] => {
        const e = new Engine(a);
        return [-401, -400, -100, -4, -1, 0, 1, 3, 4, 100, 400, 2000, 2100, 4000]
          .filter((shown) => shown - first < firstSwitch && shown - y.firstYear < firstSwitch)
          .filter((shown) => e.length("year", shown - first) > y.length);
      };
      const governed = (first: number): number[] => [-401, -400, -100, -4, -1, 0, 1, 3, 4, 100, 400, 2000, 2100, 4000].filter((s) => s - first < firstSwitch && s - y.firstYear < firstSwitch);
      for (const first of [-1000, -401, -4, -3, -1, 0, 1, 2, 7, 399, 1000, 4001]) {
        const moved = compile(ast, { year: { ...y, firstYear: first } });
        const prepared = prepareDefinition(print(moved));
        if ("error" in prepared) {
          // only a calendar with a ledger switch can refuse: moving its leap years can leave the year before the
          // switch too short for its months (Bahá'í at most first years). Refused with a located problem, never saved.
          expect(Number.isFinite(firstSwitch)).toBe(true);
          expect(prepared.problems.every((p) => p.unit !== undefined)).toBe(true);
          continue;
        }
        const expected = leapYears(ast, y.firstYear).filter((s) => governed(first).includes(s));
        // never vacuous: some governed year in the sample is leap
        if (governed(first).length >= 4) expect(expected.length).toBeGreaterThan(0);
        expect(leapYears(moved, first)).toEqual(expected);
        expect(formOf(recognise(moved), "year")).toEqual({ ...y, firstYear: first });
      }
      expect(print(compile(ast, { year: y }))).toBe(print(ast));
    }
  });

  test("a leap rule added to the plain definition counts displayed years", () => {
    const y = formOf(recognise(PLAIN), "year");
    const out = compile(PLAIN, { year: { ...y, leap: { add: 1, terms: [{ every: 4, at: 0, sign: 1 }] } } });
    expect("text" in prepareDefinition(print(out))).toBe(true);
    const e = new Engine(out);
    // firstYear 1: index 3 is year 4
    expect([0, 1, 2, 3, 4, 7].map((i) => e.length("year", i))).toEqual([365, 365, 365, 366, 365, 366]);
  });

  test("months and a week added to the plain definition prepare, with fresh unit ids", () => {
    const out = compile(PLAIN, {
      months: [{ name: "First", length: 180 }, { name: "Second", length: "slack" }],
      week: ["Oneday", "Twoday", "Threeday"],
    });
    const r = prepareDefinition(print(out));
    if ("error" in r) throw new Error(r.error);
    expect(out.units.map((u) => u.id)).toEqual(["year", "month", "week", "weekday"]);
    const f = recognise(r.ast);
    expect(formOf(f, "months")).toEqual([{ name: "First", length: 180 }, { name: "Second", length: "slack" }]);
    expect(formOf(f, "week")).toEqual(["Oneday", "Twoday", "Threeday"]);
    expect(new Engine(r.ast).length("week", 0)).toBe(3);
  });

  test("months that no longer fill a changed year are refused by validation, not by the form (S4)", () => {
    const f = recognise(GREGORIAN);
    const out = compile(GREGORIAN, { months: formOf(f, "months").map((m) => (m.length === "slack" ? { ...m, length: 28 } : m)), year: { ...formOf(f, "year"), length: 300 } });
    const r = prepareDefinition(print(out));
    if (!("error" in r)) throw new Error("expected a refusal");
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.unit).toBe("month");
  });

  test("removing months or the week refuses while a format names them (S4)", () => {
    for (const [e, unit] of [
      [{ months: null }, "month"],
      [{ week: null }, "weekday"],
    ] as Array<[FormEdits, string]>) {
      const r = prepareDefinition(print(compile(GREGORIAN, e)));
      if (!("error" in r)) throw new Error("expected a refusal");
      expect(r.problems.every((p) => p.message.includes("format") && p.message.includes(unit))).toBe(true);
    }
    const noFormats: CalendarAst = { ...GREGORIAN, formats: [] };
    expect("text" in prepareDefinition(print(compile(noFormats, { months: null, week: null })))).toBe(true);
  });

  test("a week of another length keeps its names in step with its days: the week's own anchor while it lines up, else the first name's day", () => {
    const e0 = new Engine(GREGORIAN);
    const kept = compile(GREGORIAN, { week: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"] });
    expect(kept.units.find((u) => u.id === "week")).toMatchObject({ anchor: 3, length: 14 });
    // a week stored a whole week later than its names: still aligned at 7, not at 5
    const later: CalendarAst = { ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "week" ? ({ ...u, anchor: 10 } as UnitAst) : u)) };
    expect(recognise(later).week.kind).toBe("form");
    const out = compile(later, { week: ["A", "B", "C", "D", "E"] });
    expect(out.units.find((u) => u.id === "week")).toMatchObject({ anchor: 3, length: 5 });
    const e = new Engine(out);
    // day 3 starts a week and is named A, as day 3 was Sunday before
    expect(e0.occurrenceAt("week", 3)!.start).toBe(3);
    expect(e.occurrenceAt("week", 3)!.start).toBe(3);
    expect(e.occurrenceAt("week", 8)!.start).toBe(8);
    expect(recognise(out).week).toEqual({ kind: "form", value: ["A", "B", "C", "D", "E"] });
  });

  test("adding a week beside another cycle of its length is refused, not left unreadable", () => {
    const withCycle: CalendarAst = { ...PLAIN, units: [...PLAIN.units, { id: "market", kind: "cycle", anchor: 0, length: 3 }] };
    expect(() => compile(withCycle, { week: ["a", "b", "c"] })).toThrow(/unreadable as fields/);
    expect(compile(withCycle, { week: ["a", "b", "c", "d"] }).units.map((u) => u.id)).toEqual(["year", "market", "week", "weekday"]);
  });

  test("an undefined edit is no edit; null removes only months and the week", () => {
    // the types forbid it (exactOptionalPropertyTypes); a draft spread from JS can still carry it
    const blank = { months: undefined, year: undefined, seasons: undefined, moons: undefined, name: undefined, week: undefined } as unknown as FormEdits;
    expect(compile(GREGORIAN, blank)).toBe(GREGORIAN);
  });

  test("leap terms must be whole numbers, every at least 1", () => {
    const y = formOf(recognise(GREGORIAN), "year");
    for (const bad of [{ every: 0, at: 0, sign: 1 }, { every: 4.5, at: 0, sign: 1 }, { every: 4, at: Number.NaN, sign: 1 }] as const) {
      expect(() => compile(GREGORIAN, { year: { ...y, leap: { add: 1, terms: [bad] } } })).toThrow(FormError);
    }
    expect(() => compile(GREGORIAN, { year: { ...y, leap: { add: 0.5, terms: y.leap!.terms } } })).toThrow(FormError);
    expect(() => compile(GREGORIAN, { year: { ...y, firstYear: 1.5 } })).toThrow(FormError);
  });

  test("moons keep their ids, exact rationals, phases and places among other bodies (S3)", () => {
    const ast: CalendarAst = {
      ...PLAIN,
      bodies: [
        { id: "sun", period: { n: 36524, d: 100 }, epoch: { n: 0, d: 1 } },
        { id: "moon-1", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Moon", phases: [{ name: "Full", at: 0.5 }] } },
      ],
    };
    const moons = formOf(recognise(ast), "moons");
    const renamed = compile(ast, { moons: [{ ...moons[0]!, name: "Selene" }, { name: "Mote", period: { n: 7, d: 1 }, epoch: { n: 0, d: 1 } }] });
    expect(renamed.bodies).toEqual([
      ast.bodies![0]!,
      { id: "moon-1", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Selene", phases: [{ name: "Full", at: 0.5 }] } },
      { id: "moon", period: { n: 7, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Mote" } },
    ]);
    expect(compile(ast, { moons: [] }).bodies).toEqual([ast.bodies![0]!]);
    expect(compile(PLAIN, { moons: [] })).not.toHaveProperty("bodies");
  });

  test("a stored empty body list is a field and stays; a new moon never takes an id the list names", () => {
    const empty: CalendarAst = { ...PLAIN, bodies: [] };
    expect(recognise(empty).moons).toEqual({ kind: "form", value: [] });
    const m = { period: { n: 7, d: 1 }, epoch: { n: 0, d: 1 } };
    const out = compile(empty, { moons: [{ ...m, name: "New" }, { ...m, id: "moon", name: "Named" }] });
    expect(out.bodies!.map((b) => b.id)).toEqual(["moon-2", "moon"]);
  });

  test("an edit to a text part is refused, naming why", () => {
    expect(() => compile(HEBREW, { year: { length: 354, firstYear: 1, leap: null } })).toThrow(/cannot be edited here/);
  });

  test("seasons: an empty list adds no field, keeps a stored empty field, and removes one that held seasons", () => {
    const empty: CalendarAst = { ...PLAIN, seasons: { unit: "year", marks: [] } };
    expect(compile(empty, { seasons: [] })).toEqual(empty);
    const { seasons: _s, ...bare } = PLAIN;
    expect(compile(bare as CalendarAst, { seasons: [] })).not.toHaveProperty("seasons");
    const held = compile(bare, { seasons: [{ name: "Wet", from: 0 }] });
    expect(compile(held, { seasons: [] })).not.toHaveProperty("seasons");
    // the empty field is hashed: it is not the same calendar as none
    expect(hash(empty)).not.toBe(hash(bare as CalendarAst));
  });
});
