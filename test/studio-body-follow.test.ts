/**
 * P4 step 1, the plugin and Studio half (bead wadjet-01k.14, docs/SESHAT-v0.md
 * §16 D2, §16.7 P1): a moon a unit follows cannot be removed in any edit path;
 * an epoch edit moves the followers' K so occurrence numbering never changes;
 * a body-driven year is a text part with a reason and a sentence.
 */
import { describe, expect, test } from "bun:test";
import { calendarOfDefinition, mergeCalendar, planCalendarSave, seshatDraft } from "../src/studio/model/definition";
import { definitionRowEdit, definitionRows } from "../src/plugin/calendar-rows";
import { definitionSummary } from "../src/plugin/calendar-row";
import { compile, followSentence, FormError, recognise } from "../src/plugin/time/form";
import { Engine, epochEditK, GREGORIAN, parse, print, type CalendarAst, type CrossingAst, type UnitAst } from "../src/seshat";

const PHASES = [{ name: "New", at: 0 }, { name: "Full", at: 0.5 }];
const luna = (epoch = { n: 3, d: 10 }, period = { n: 2953, d: 100 }) => ({ id: "luna", period, epoch, moon: { name: "Luna", phases: PHASES } });
const EMBER = { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Ember" } };
const lunation = (crossing: CrossingAst): UnitAst => ({ id: "lunation", kind: "cycle", crossing });

/** Gregorian years, plus a lunation unit that starts on the day Luna is full. */
function world(epoch = { n: 3, d: 10 }, k?: number): CalendarAst {
  return { ...GREGORIAN, bodies: [luna(epoch), EMBER], units: [...GREGORIAN.units, lunation({ body: { id: "luna", mark: { n: 1, d: 2 }, ...(k ? { k } : {}) } })] };
}
/** A year of lunations: it begins on the first day after Luna is new. */
const LUNAR_YEAR: CalendarAst = { name: "Lunar", gears: [], bodies: [luna()], units: [{ id: "year", kind: "cycle", crossing: { body: { id: "luna", mark: { n: 0, d: 1 } }, start: "after" } }] };

const written = (r: ReturnType<typeof mergeCalendar>): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};
const kOf = (ast: CalendarAst): number | undefined => (ast.units.find((u) => u.id === "lunation") as { crossing: { body: { k?: number } } }).crossing.body.k;

describe("D2: a moon a unit follows cannot be removed", () => {
  const text = print(world());

  test("the form refuses by body id, naming the unit, whatever slot the moon sits in", () => {
    const ast = parse(text);
    const moons = recognise(ast).moons;
    if (moons.kind !== "form") throw new Error("moons should be a form part");
    expect(() => compile(ast, { moons: moons.value.filter((m) => m.id !== "luna") })).toThrow(FormError);
    expect(() => compile(ast, { moons: moons.value.filter((m) => m.id !== "luna") })).toThrow(/The moon "Luna" cannot be removed: the "lunation" unit follows it\. Change that unit first \(Edit definition\)\. To rename the moon, change only its name\./);
    // a moon nobody follows still goes
    expect(compile(ast, { moons: moons.value.filter((m) => m.id !== "ember") }).bodies!.map((b) => b.id)).toEqual(["luna"]);
  });

  test("Studio Save refuses and leaves the draft as it was", () => {
    const seeded = seshatDraft(parse(text));
    const draft = { ...seeded, moons: seeded.moons.filter((m) => m.id !== "luna") };
    const before = structuredClone(draft);
    const plan = planCalendarSave({ source: "seshat", calendar: seeded }, text, { calendar: draft, base: seeded, source: "seshat" });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.message).toContain('"lunation"');
    expect(draft).toEqual(before);
  });

  test("the settings Moons row refuses with the unit named; the stored text is untouched", () => {
    const rows = definitionRows(parse(text));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    const without = rows.moons.value.split("\n").filter((l) => !l.startsWith("Luna")).join("\n");
    const r = definitionRowEdit(text, "moons", without);
    expect(r).toEqual({ error: expect.stringContaining('the "lunation" unit follows it') });
  });
});

describe("P1: an epoch edit keeps every follower's occurrence numbering", () => {
  const P = 29.53;
  for (const [from, to] of [
    [{ n: 3, d: 10 }, { n: 1, d: 4 }],
    [{ n: 99, d: 100 }, { n: 1, d: 100 }],
    [{ n: 1, d: 100 }, { n: 99, d: 100 }],
  ] as const) {
    test(`Luna's epoch ${from.n}/${from.d} → ${to.n}/${to.d}: K moves by epochEditK, each lunation moves by under half a turn`, () => {
      const text = print(world(from, 4));
      const base = calendarOfDefinition(parse(text));
      const draft = { ...base, moons: base.moons.map((m) => (m.id === "luna" ? { ...m, phaseAtEpoch: to.n / to.d } : m)) };
      const out = written(mergeCalendar(text, base, draft));
      expect(out.bodies!.find((b) => b.id === "luna")!.epoch).toEqual(to);
      expect(kOf(out) ?? 0).toBe(4 + epochEditK(from, to));
      const [a, b] = [new Engine(parse(text)), new Engine(out)];
      for (let i = -500; i <= 500; i++) expect(Math.abs(b.start("lunation", i) - a.start("lunation", i))).toBeLessThanOrEqual(Math.ceil(P / 2) + 1);
    });
  }

  test("through the settings Moons row too", () => {
    const text = print(world({ n: 99, d: 100 }));
    const rows = definitionRows(parse(text));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    const line = rows.moons.value.split("\n").find((l) => l.startsWith("Luna"))!;
    const parts = line.split(",").map((s) => s.trim());
    parts[2] = "0.01";
    const r = definitionRowEdit(text, "moons", rows.moons.value.replace(line, parts.join(", ")));
    if (!("text" in r)) throw new Error(JSON.stringify(r));
    expect(kOf(parse(r.text))).toBe(epochEditK({ n: 99, d: 100 }, { n: 1, d: 100 }));
  });

  test("a period edit with it leaves K alone (the Save dialog reports what moved)", () => {
    const text = print(world({ n: 99, d: 100 }, 4));
    const base = calendarOfDefinition(parse(text));
    const draft = { ...base, moons: base.moons.map((m) => (m.id === "luna" ? { ...m, cycleDays: 30, phaseAtEpoch: 0.01 } : m)) };
    expect(kOf(written(mergeCalendar(text, base, draft)))).toBe(4);
  });

  test("an unchanged epoch leaves the definition text as it was", () => {
    const text = print(world({ n: 3, d: 10 }, 4));
    const base = calendarOfDefinition(parse(text));
    expect(mergeCalendar(text, base, { ...base, moons: base.moons.map((m) => ({ ...m, phases: [{ name: "New", at: 0 }] })) }).kind).toBe("write");
    expect(kOf(written(mergeCalendar(text, base, { ...base, moons: base.moons.map((m) => ({ ...m, phases: [{ name: "New", at: 0 }] })) })))).toBe(4);
  });
});

describe("a body-driven year in words", () => {
  test("the form shows it as text, saying what it follows", () => {
    expect(recognise(LUNAR_YEAR).year).toEqual({ kind: "text", why: "the year follows Luna (New phase)" });
  });

  test("the Calendar window's sentence names the moon and the phase, or the phase as a number", () => {
    expect(followSentence(LUNAR_YEAR, "year")).toBe("Each year begins on the first day after Luna reaches its New phase");
    const quarter: CalendarAst = { ...LUNAR_YEAR, units: [{ id: "year", kind: "cycle", crossing: { body: { id: "luna", mark: { n: 1, d: 4 } } } }] };
    expect(followSentence(quarter, "year")).toBe("Each year begins on the day Luna reaches phase 0.25");
    expect(followSentence(GREGORIAN, "year")).toBeNull();
  });

  test("the settings summary says what the units follow", () => {
    expect(definitionSummary(LUNAR_YEAR)).toContain("years follow Luna");
    expect(definitionSummary(world())).toContain("lunations follow Luna");
  });
});

describe("a moon followed only through a ledger switch (Reviewer Mara, 2026-10-22)", () => {
  /** Gregorian years, plus a 'tide' unit of 29 days that switches to following Luna from occurrence 1000 on. */
  function switchWorld(epoch = { n: 3, d: 10 }, k?: number): CalendarAst {
    const tide: UnitAst = {
      id: "tide",
      kind: "cycle",
      anchor: 0,
      length: 29,
      ledger: [{ kind: "switch", from: 1000, rule: { crossing: { body: { id: "luna", mark: { n: 0, d: 1 }, ...(k ? { k } : {}) } } } }],
    };
    return { ...GREGORIAN, bodies: [luna(epoch), EMBER], units: [...GREGORIAN.units, tide] };
  }
  const switchK = (ast: CalendarAst): number | undefined =>
    ((ast.units.find((u) => u.id === "tide") as unknown as { ledger: Array<{ rule: { crossing: { body: { k?: number } } } }> }).ledger[0]!.rule.crossing.body.k);

  test("the world runs (a valid fixture for the two checks below)", () => {
    expect(() => new Engine(switchWorld())).not.toThrow();
  });

  test("removing Luna is refused, naming the unit", () => {
    const ast = switchWorld();
    const moons = recognise(ast).moons;
    if (moons.kind !== "form") throw new Error("moons should be a form part");
    expect(() => compile(ast, { moons: moons.value.filter((m) => m.id !== "luna") })).toThrow(/"tide" unit follows it/);
  });

  test("an epoch edit across the wrap moves the switch's K, so its occurrences keep their numbers", () => {
    const before = switchWorld({ n: 99, d: 100 });
    const moons = recognise(before).moons;
    if (moons.kind !== "form") throw new Error("moons should be a form part");
    const after = compile(before, { moons: moons.value.map((m) => (m.id === "luna" ? { ...m, epoch: { n: 1, d: 100 } } : m)) });
    const k = switchK(after);
    expect(k).toBe(epochEditK({ n: 99, d: 100 }, { n: 1, d: 100 }));
    expect(k).not.toBe(0);
    // every occurrence from the switch on moves by less than half a lunation
    const a = new Engine(before);
    const b = new Engine(after);
    for (const i of [1000, 1001, 1500, 5000]) expect(Math.abs(b.start("tide", i) - a.start("tide", i))).toBeLessThan(2953 / 200);
  });
});
