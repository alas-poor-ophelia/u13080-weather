/**
 * P4 step 2 (docs/SESHAT-v0.md §16 D6, §16.7 P3; wadjet-01k.16): a rule names a
 * body's phase (`PHASE:BODY=<id>;NAME=<phase>`), resolved before hashing to the
 * span from that mark to the next (sorted, wrapping; a single mark spans the turn).
 */
import { describe, expect, test } from "bun:test";
import { definitionContent, Engine, GREGORIAN, parse, phaseSpan, print, validate, type BodyAst, type CalendarAst, type RuleAst } from "../src/seshat";
import { canonicalJson } from "../src/core/profile";
import { planCalendarSave, seshatDraft } from "../src/studio/model/definition";
import { definitionRowEdit, definitionRows } from "../src/plugin/calendar-rows";
import { compile, FormError, recognise } from "../src/plugin/time/form";

type Marks = ReadonlyArray<{ name: string; at: number }>;
const luna = (phases?: Marks): BodyAst => ({ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 }, moon: { name: "Luna", ...(phases ? { phases } : {}) } });
const EMBER: BodyAst = { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 1, d: 7 }, moon: { name: "Ember", phases: [{ name: "Low", at: 0 }, { name: "High", at: 0.4 }] } };
const world = (phases: Marks | undefined, rule: RuleAst, more: BodyAst[] = [EMBER]): CalendarAst => ({ ...GREGORIAN, bodies: [luna(phases), ...more], rules: [{ id: "lit", tags: ["lit"], rule }] });
const named = (name: string): RuleAst => ({ kind: "phase", body: "luna", name });
const hash = (ast: CalendarAst) => canonicalJson(definitionContent(ast));
const lit = (e: Engine) => Array.from({ length: 1500 }, (_, i) => e.tagsAt(i * 7 - 3000).includes("lit"));

const LAYOUTS: Array<[string, Marks, Record<string, [number, number]>]> = [
  ["two marks", [{ name: "New", at: 0 }, { name: "Full", at: 0.5 }], { New: [0, 0.5], Full: [0.5, 0] }],
  ["four marks, unsorted", [{ name: "Full", at: 0.5 }, { name: "New", at: 0 }, { name: "Last", at: 0.75 }, { name: "First", at: 0.25 }], { New: [0, 0.25], First: [0.25, 0.5], Full: [0.5, 0.75], Last: [0.75, 0] }],
  ["a single mark", [{ name: "Only", at: 0.3 }], { Only: [0, 1] }],
  ["a span wrapping past 1", [{ name: "A", at: 0.2 }, { name: "B", at: 0.9 }], { A: [0.2, 0.9], B: [0.9, 0.2] }],
];

describe("P4 step 2: a named phase is the FROM/TO span it names", () => {
  for (const [what, marks, spans] of LAYOUTS) {
    test(`${what}: each name resolves to its span, matches the same days and hashes as the literal`, () => {
      for (const [name, [from, to]] of Object.entries(spans)) {
        expect(phaseSpan("luna", name, new Map([["luna", luna(marks)]]))).toEqual({ from, to });
        const byName = world(marks, named(name));
        const byBounds = world(marks, { kind: "phase", body: "luna", from, to });
        expect(validate(byName)).toEqual([]);
        const days = lit(new Engine(byName));
        expect(days).toEqual(lit(new Engine(byBounds)));
        expect(days.some(Boolean)).toBe(true);
        expect(hash(byName)).toBe(hash(byBounds));
      }
    });
  }

  test("text: NAME round-trips and the stored text keeps it; NAME with bounds is refused", () => {
    const ast = world(LAYOUTS[0]![1], { kind: "not", of: named("Full ; odd=name") });
    const text = print(ast);
    expect(text).toContain("PHASE:BODY=luna;NAME=");
    expect(parse(text)).toEqual(ast);
    expect(print(parse(text))).toBe(text);
    expect(() => parse(text.replace("PHASE:BODY=luna;NAME=", "PHASE:BODY=luna;FROM=0;NAME="))).toThrow(/NAME or FROM and TO/);
    expect(() => parse(text.replace("PHASE:BODY=luna;NAME=", "PHASE:BODY=luna;WHEN=x;NAME="))).toThrow(/no parameter WHEN/);
    expect(() => print({ ...ast, rules: [{ id: "x", rule: { kind: "phase", body: "luna", name: "Full", from: 0, to: 1 } as unknown as RuleAst }] })).toThrow(/exactly one/);
  });

  test("the hash moves when a named boundary moves, and not when an unnamed body's phases move", () => {
    const marks = LAYOUTS[0]![1];
    const base = world(marks, named("Full"));
    expect(hash(world([{ name: "New", at: 0 }, { name: "Full", at: 0.55 }], named("Full")))).not.toBe(hash(base));
    expect(hash(world([{ name: "New", at: 0.05 }, { name: "Full", at: 0.5 }], named("Full")))).not.toBe(hash(base));
    // Ember's phases are display: no rule names them
    expect(hash(world(marks, named("Full"), [{ ...EMBER, moon: { name: "Ember", phases: [{ name: "Low", at: 0.1 }] } }]))).toBe(hash(base));
    // and a world reading Luna by bounds does not move with Luna's names
    const bounds: RuleAst = { kind: "phase", body: "luna", from: 0.5, to: 0 };
    expect(hash(world([{ name: "New", at: 0 }, { name: "Full", at: 0.55 }], bounds))).toBe(hash(world(marks, bounds)));
  });
});

describe("P4 step 2: validation of a named phase (P3)", () => {
  const marks = LAYOUTS[0]![1];
  const one = (ast: CalendarAst) => validate(ast).join("\n");
  test("the body exists, has a moon facet and named phases", () => {
    expect(one(world(marks, { kind: "phase", body: "sol", name: "Full" }))).toMatch(/body "sol", which is not declared/);
    expect(one({ ...world(marks, named("Full")), bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 } }] })).toMatch(/no moon facet/);
    expect(one(world(undefined, named("Full")))).toMatch(/body "luna", which has no named phases/);
  });
  test("the named phase exists; the message names the body and lists its phases", () => {
    expect(one(world(marks, named("Gibbous")))).toMatch(/phase "Gibbous" of body "luna", which has no such phase \(its phases: "New", "Full"\)/);
  });
  test("duplicate names and duplicate marks are errors once a rule names the body's phases, not before", () => {
    const dupName = [{ name: "New", at: 0 }, { name: "New", at: 0.5 }];
    const dupMark = [{ name: "New", at: 0.5 }, { name: "Full", at: 0.5 }];
    expect(one(world(dupName, named("New")))).toMatch(/more than one phase named "New"/);
    expect(one(world(dupMark, named("Full")))).toMatch(/more than one phase at 0.5/);
    const bounds: RuleAst = { kind: "phase", body: "luna", from: 0, to: 0.5 };
    expect(validate(world(dupName, bounds))).toEqual([]);
    expect(validate(world(dupMark, bounds))).toEqual([]);
  });
  test("a named phase belongs to a body, not a unit", () => {
    expect(one(world(marks, { kind: "phase", unit: "year", name: "Full" }))).toMatch(/belongs to a body/);
  });
  test("an engine refuses to run a definition whose named phase does not resolve", () => {
    expect(() => new Engine(world(marks, named("Gibbous")))).toThrow(/no such phase/);
  });
});

describe("P4 step 2: a phase a rule names cannot be renamed or removed (P3)", () => {
  const marks = LAYOUTS[0]![1];
  const text = print(world(marks, named("Full")));
  const base = seshatDraft(parse(text));
  const renamed = (ms: typeof base.moons) => ms.map((m) => (m.id === "luna" ? { ...m, phases: m.phases!.map((p) => (p.name === "Full" ? { ...p, name: "Bright" } : p)) } : m));

  test("the form refuses a rename, a removal and the moon's removal, naming the rule and the phase", () => {
    const ast = parse(text);
    const moons = recognise(ast).moons;
    if (moons.kind !== "form") throw new Error("moons should be a form part");
    const msg = /The phase "Full" of the moon "Luna" cannot be renamed or removed: the "lit" rule names it/;
    expect(() => compile(ast, { moons: moons.value.map((m) => (m.id === "luna" ? { ...m, phases: m.phases!.map((p) => (p.name === "Full" ? { ...p, name: "Bright" } : p)) } : m)) })).toThrow(FormError);
    expect(() => compile(ast, { moons: moons.value.map((m) => (m.id === "luna" ? { ...m, phases: m.phases!.filter((p) => p.name !== "Full") } : m)) })).toThrow(msg);
    expect(() => compile(ast, { moons: moons.value.filter((m) => m.id !== "luna") })).toThrow(msg);
    // the marks still move; the hash follows the moved boundary
    const moved = compile(ast, { moons: moons.value.map((m) => (m.id === "luna" ? { ...m, phases: [{ name: "New", at: 0.1 }, { name: "Full", at: 0.6 }] } : m)) });
    expect(hash(moved)).not.toBe(hash(ast));
    // a phase no rule names still renames
    const other = compile(ast, { moons: moons.value.map((m) => (m.id === "ember" ? { ...m, phases: [{ name: "Dim", at: 0 }] } : m)) });
    expect(other.bodies!.find((b) => b.id === "ember")!.moon!.phases).toEqual([{ name: "Dim", at: 0 }]);
  });

  test("Studio Save refuses a rename and leaves the draft as it was", () => {
    const draft = { ...base, moons: renamed(base.moons) };
    const before = structuredClone(draft);
    const plan = planCalendarSave({ source: "seshat", calendar: base }, text, { calendar: draft, base, source: "seshat" });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.message).toContain('the "lit" rule names it');
    expect(draft).toEqual(before);
  });

  test("the settings Moons row refuses with the rule named; the stored text is untouched", () => {
    const rows = definitionRows(parse(text));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    expect(rows.moons.value).toContain("Full@0.5");
    expect(definitionRowEdit(text, "moons", rows.moons.value.replace("Full@0.5", "Bright@0.5"))).toEqual({ error: expect.stringContaining('The phase "Full" of the moon "Luna"') });
  });
});
