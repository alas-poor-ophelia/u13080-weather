/**
 * P3c step 2 (docs/SESHAT-v0.md §15.3, §15.9 S5): the Studio's calendar draft
 * on a definition world. Moons are their bodies (wadjet-dea), the stale check
 * is per part, the form model's fields save through the one merge, and the
 * Seasons window can start the first season (wadjet-hhp).
 */
import { describe, expect, test } from "bun:test";
import { bodyFor, GREGORIAN, HEBREW, parse, print, type CalendarAst } from "../src/seshat";
import { calendarOfDefinition, mergeCalendar, type CalendarDraft } from "../src/studio/model/definition";
import { PHASE_LIMITS, SEASON_LIMITS, split, splitLongest } from "../src/studio/model/boundaries";

const luna = bodyFor(29.53, 0)!;
const DEF: CalendarAst = {
  ...GREGORIAN,
  seasons: { unit: "year", marks: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] },
  bodies: [
    { id: "luna", period: luna.period, epoch: luna.epoch, moon: { name: "Luna", phases: [{ name: "Full", at: 0.5 }] } },
    { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Ember" } },
  ],
  // a rule that reads the body by id: a rename must keep it
  rules: [{ id: "full", rule: { kind: "phase", body: "luna", from: 0.45, to: 0.55 }, tags: ["full-moon"] }],
};
const TEXT = print(DEF);
const BASE = calendarOfDefinition(parse(TEXT));
const clone = <T>(x: T): T => structuredClone(x);
const written = (r: ReturnType<typeof mergeCalendar>): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};

describe("a moon is its body (wadjet-dea)", () => {
  test("a rename keeps the body's id and exact numbers, so a rule reading it still runs", () => {
    const draft = clone(BASE);
    draft.moons[0]!.name = "Selene";
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.bodies![0]).toEqual({ ...DEF.bodies![0]!, moon: { name: "Selene", phases: [{ name: "Full", at: 0.5 }] } });
    expect(ast.rules).toEqual(DEF.rules);
  });

  test("the draft's order is the order written", () => {
    const draft = clone(BASE);
    draft.moons.reverse();
    expect(written(mergeCalendar(TEXT, BASE, draft)).bodies!.map((b) => b.id)).toEqual(["ember", "luna"]);
  });

  test("a moon the draft adds takes a fresh moon-N id at its place in the draft; a removed one goes", () => {
    const draft = clone(BASE);
    draft.moons = [draft.moons[1]!, { name: "Mote", cycleDays: 7, phaseAtEpoch: 0 }];
    const without = { ...DEF, rules: [] };
    const ast = written(mergeCalendar(print(without), calendarOfDefinition(without), draft));
    expect(ast.bodies!.map((b) => [b.id, b.moon?.name])).toEqual([
      ["ember", "Ember"],
      ["moon-1", "Mote"],
    ]);
  });

  test("removing the moon a rule reads is refused, naming the body", () => {
    const draft = clone(BASE);
    draft.moons = [draft.moons[1]!];
    expect(mergeCalendar(TEXT, BASE, draft)).toMatchObject({ kind: "error", message: expect.stringContaining("luna") as unknown as string });
  });

  test("a moon without an id never takes the body another moon names by id (Parallax probe, P3c step 2)", () => {
    const withRule = { ...DEF, rules: [{ id: "embers", rule: { kind: "phase" as const, body: "ember", from: 0, to: 0.1 } }] };
    const text = print(withRule);
    const base = calendarOfDefinition(parse(text));
    // a new moon called Ember placed first, the old Ember renamed Cinder after it
    const draft = { ...clone(base), moons: [{ name: "Ember", cycleDays: 10, phaseAtEpoch: 0 }, { ...base.moons[1]!, name: "Cinder" }, base.moons[0]!] };
    const ast = written(mergeCalendar(text, base, draft));
    const byName = new Map(ast.bodies!.map((b) => [b.moon!.name, b]));
    expect(byName.get("Cinder")!.id).toBe("ember");
    expect(byName.get("Cinder")!.period).toEqual({ n: 33, d: 1 });
    expect(byName.get("Ember")!.id).toBe("moon-1");
    expect(byName.get("Ember")!.period).toEqual({ n: 10, d: 1 });
  });

  test("a draft id with no body is kept, and a fresh moon-N never takes an id the draft names", () => {
    const draft = { ...clone(BASE), moons: [...clone(BASE).moons, { name: "Mote", cycleDays: 7, phaseAtEpoch: 0 }, { id: "moon-1", name: "Speck", cycleDays: 9, phaseAtEpoch: 0 }] };
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.bodies!.map((b) => [b.id, b.moon!.name])).toEqual([
      ["luna", "Luna"],
      ["ember", "Ember"],
      ["moon-2", "Mote"],
      ["moon-1", "Speck"],
    ]);
  });

  test("two draft moons with one id: the first keeps the body, the second is a new moon", () => {
    const draft = { ...clone(BASE), moons: [...clone(BASE).moons, { ...clone(BASE).moons[1]!, name: "Ember twin" }] };
    const ids = written(mergeCalendar(TEXT, BASE, draft)).bodies!.map((b) => b.id);
    expect(ids).toEqual(["luna", "ember", "moon-1"]);
  });

  test("a draft without ids (a stash from an older build) matches moons by name, as before", () => {
    const strip = (c: CalendarDraft): CalendarDraft => ({ ...c, moons: c.moons.map(({ id: _id, ...m }) => m) });
    const base = strip(BASE);
    const draft = clone(base);
    draft.moons[1]!.cycleDays = 34;
    const ast = written(mergeCalendar(TEXT, base, draft));
    expect(ast.bodies![0]).toEqual(DEF.bodies![0]);
    expect(ast.bodies![1]!.id).toBe("ember");
    expect(ast.bodies![1]!.period).toEqual({ n: 34, d: 1 });
  });
});

describe("stale is per part (§15.9 S5)", () => {
  test("an edit outside the studio to another part passes through; one to the same part refuses", () => {
    // settings changed the moons while the studio edited only the seasons
    const outside = print({ ...DEF, bodies: [DEF.bodies![0]!, { ...DEF.bodies![1]!, moon: { name: "Cinder" } }] });
    const draft = clone(BASE);
    draft.seasons[1]!.from = 0.6;
    const ast = written(mergeCalendar(outside, BASE, draft));
    expect(ast.seasons!.marks[1]!.from).toBe(0.6);
    expect(ast.bodies![1]!.moon!.name).toBe("Cinder");
    // the studio edited the moons too: that part changed underneath, so it refuses and offers the stored calendar
    const both = clone(draft);
    both.moons[0]!.name = "Selene";
    const r = mergeCalendar(outside, BASE, both);
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") expect(r.stored.moons[1]!.name).toBe("Cinder");
  });

  test("the same holds for the form's parts: months changed outside, a name edit passes; a months edit refuses", () => {
    const months = BASE.form!.months!;
    const outside = print(parse(TEXT.replace("SLOT:January=31", "SLOT:Janus=31")));
    expect(outside).not.toBe(TEXT);
    const named = { ...clone(BASE), form: { ...BASE.form, name: "Other" } };
    const ast = written(mergeCalendar(outside, BASE, named));
    expect(ast.name).toBe("Other");
    expect(calendarOfDefinition(ast).form!.months![0]!.name).toBe("Janus");
    const renamed = { ...clone(BASE), form: { ...BASE.form, months: months.map((m, i) => (i === 1 ? { ...m, name: "Febru" } : m)) } };
    expect(mergeCalendar(outside, BASE, renamed).kind).toBe("stale");
  });
});

describe("the form's parts save through the one merge", () => {
  test("the draft carries the parts that are fields, and only those", () => {
    expect(Object.keys(BASE.form!).sort()).toEqual(["ledger", "months", "name", "week", "year"]);
    const hebrew = calendarOfDefinition(HEBREW);
    expect(hebrew.form).not.toHaveProperty("year");
  });

  test("a year, month or week edit writes that part and leaves the rest as stored", () => {
    const draft = { ...clone(BASE), form: { ...BASE.form, year: { ...BASE.form!.year!, firstYear: 1 }, week: ["A", "B", "C", "D", "E", "F", "G"] } };
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.units.find((u) => u.id === "year")).toMatchObject({ number: 1 });
    expect(calendarOfDefinition(ast).form!.week).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(ast.bodies).toEqual(DEF.bodies);
    expect(ast.seasons).toEqual(DEF.seasons);
  });

  test("a form part the draft does not hold (text on the stored definition, or dropped) is never an edit", () => {
    const draft = clone(BASE);
    delete draft.form!.year;
    draft.seasons[0]!.name = "Rain";
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.units).toEqual(parse(TEXT).units);
  });

  test("an edit the definition refuses is an error, not a save", () => {
    const draft = { ...clone(BASE), form: { ...BASE.form, year: { ...BASE.form!.year!, length: 300 } } };
    expect(mergeCalendar(TEXT, BASE, draft).kind).toBe("error");
  });
});

describe("the first season (wadjet-hhp)", () => {
  test("with no seasons, a split starts the first one where asked, covering the whole year", () => {
    expect(split([], 0.25, SEASON_LIMITS)).toEqual([{ name: "Season", at: 0.25 }]);
    expect(split([], 0.25, SEASON_LIMITS, "Thaw")).toEqual([{ name: "Thaw", at: 0.25 }]);
    expect(splitLongest([], SEASON_LIMITS)).toEqual([{ name: "Season", at: 0 }]);
    // and the next split works from there
    expect(splitLongest([{ name: "Season", at: 0 }], SEASON_LIMITS)).toEqual([
      { name: "Season", at: 0 },
      { name: "Season 2", at: 0.5 },
    ]);
  });

  test("moon phases are unchanged: with none, a split still needs one to split", () => {
    expect(split([], 0.25, PHASE_LIMITS)).toBeNull();
    expect(splitLongest([], PHASE_LIMITS)).toBeNull();
  });

  test("a first season saves into a definition that had none", () => {
    const { seasons: _s, ...bare } = DEF;
    const text = print(bare);
    const base = calendarOfDefinition(parse(text));
    expect(base.seasons).toEqual([]);
    const draft = { ...clone(base), seasons: [{ name: "Season", from: 0.25 }] };
    expect(written(mergeCalendar(text, base, draft)).seasons).toEqual({ unit: "year", marks: [{ name: "Season", from: 0.25 }] });
  });
});
