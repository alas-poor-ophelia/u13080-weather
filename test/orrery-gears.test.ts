/**
 * Orrery slice 5c (docs/SESHAT-v0.md §18.3, §18.6 items 1 and 2; bead
 * wadjet-b6x): the gear inspector's pure edits (src/studio/model/orrery-gears.ts)
 * and their AST half (ast-edit.ts `renameGear`, `addGear`, `removeGear`,
 * `setGearKind`, `setGearFeed`, slices `feeds:<unit>` and `ledger:<unit>`).
 *
 *   - Gregorian reads its leap rule as fields (`FormDraft.year.leap`): its
 *     terms and leap days go through the form and `compile`, so a year-length
 *     edit pending beside them is never refused;
 *   - a rename follows the gear into every term that names it: the year's own
 *     terms (Gregorian), a slot's (Hebrew's Adar I, a positions gear of 19),
 *     both (Harptos's Shieldmeet), and a ledger switch's rule (Roman);
 *   - a kind switch keeps the same years engaged;
 *   - the sum over the lcm is `problems()`'s to say, on the gear;
 */
import { describe, expect, test } from "bun:test";
import { editedSlices, kindRoundTrips, renameGear, setGearFeed, setGearKind, type AstEdit } from "../src/studio/model/ast-edit";
import { mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { addGearPart, addTerm, feedsOf, feedTargets, formReadsGear, removeGearPart, removeTerm, renameGearIn, setFeed, setKind, setTerm, termEngaged, togglePosition } from "../src/studio/model/orrery-gears";
import { setYearLength } from "../src/studio/model/orrery-slots";
import { gearMatches, GREGORIAN, HARPTOS, HEBREW, parse, print, problems, ROMAN, type CalendarAst, type CycleUnitAst, type GearAst, type SlotsUnitAst } from "../src/seshat";

const clone = <T>(v: T): T => structuredClone(v);
function done(r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
}
const refused = (r: CalendarEdit | AstEdit): string => {
  if (!("refused" in r)) throw new Error("not refused");
  return r.reason;
};
const ok = (r: AstEdit): CalendarAst => {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r.ast;
};
const written = (r: MergeResult): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};
function opened(ast: CalendarAst): { text: string; base: CalendarDraft; draft: CalendarDraft } {
  const text = print(ast);
  const base = seshatDraft(parse(text));
  return { text, base, draft: clone(base) };
}
const gear = (ast: CalendarAst, id: string): GearAst | undefined => ast.gears.find((g) => g.id === id);
const year = (ast: CalendarAst): CycleUnitAst => ast.units.find((u) => u.id === "year") as CycleUnitAst;
const slots = (ast: CalendarAst, id: string): SlotsUnitAst => ast.units.find((u) => u.id === id) as SlotsUnitAst;
const gearProblems = (ast: CalendarAst, id: string) => problems(ast).filter((p) => p.gear === id);
/** Every gear term id the definition holds, wherever it is. */
const termIds = (ast: CalendarAst): string[] =>
  ast.units.flatMap((u) => (u.kind === "cycle" ? [...(u.gears ?? []), ...(u.ledger ?? []).flatMap((e) => (e.kind === "switch" ? (e.rule.gears ?? []) : []))] : u.slots.flatMap((s) => s.gears ?? [])).map((t) => t.gear));
const sameYears = (a: GearAst, b: GearAst, from: number, to: number): boolean => {
  for (let n = from; n < to; n++) if (gearMatches(a, n) !== gearMatches(b, n)) return false;
  return true;
};

describe("terms through the form (Gregorian)", () => {
  test("every 4 → 5: the form's leap rule, the layer untouched; 2025 is a leap year; back to 4 is clean", () => {
    const { base, draft } = opened(GREGORIAN);
    expect(formReadsGear(draft, draft.ast!, "leap")).toBe(true);
    const r = done(setTerm(draft, "leap", 0, { every: 5 }));
    expect(r.calendar.ast).toBe(draft.ast);
    expect(r.calendar.form!.year!.leap!.terms[0]).toEqual({ every: 5, at: 0, sign: 1 });
    const g = gear(r.ast, "leap")!;
    expect(g.kind === "intervals" && g.terms.map((t) => t.every)).toEqual([5, 100, 400]);
    expect(gearMatches(g, 2025)).toBe(true);
    expect(gearMatches(g, 2024)).toBe(false);
    expect(problems(r.ast)).toEqual([]);
    const back = done(setTerm(r.calendar, "leap", 0, { every: 4 }));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("a pending year length and a leap edit sit side by side (one form part)", () => {
    const { draft } = opened(GREGORIAN);
    const a = done(setYearLength(draft, "year", 366));
    const b = done(setTerm(a.calendar, "leap", 0, { every: 5 }));
    expect(year(b.ast).length).toBe(366);
    const g = gear(b.ast, "leap")!;
    expect(g.kind === "intervals" && g.terms[0]!.every).toBe(5);
  });
  test("＋ term adds an EXRULE that nests; flipping −100 to + breaks the sum, on the gear", () => {
    const { draft } = opened(GREGORIAN);
    const r = done(addTerm(draft, "leap"));
    const g = gear(r.ast, "leap")!;
    expect(g.kind === "intervals" && g.terms[3]).toEqual({ every: 1600, sign: -1 });
    expect(problems(r.ast)).toEqual([]);
    const bad = done(setTerm(draft, "leap", 1, { sign: 1 }));
    expect(gearProblems(bad.ast, "leap")[0]?.message).toContain("is counted 3 times");
  });
  test("an offset past the interval wraps into ±(every − 1); the term pin follows", () => {
    const { draft } = opened(HARPTOS);
    const r = done(setTerm(draft, "shieldmeet", 0, { offset: 5 }));
    const g = gear(r.calendar.ast!, "shieldmeet")!;
    expect(g.kind === "intervals" && g.terms[0]).toEqual({ every: 4, offset: 1, sign: 1 });
    expect(termEngaged({ every: 4, offset: -1, sign: 1 }, 1371)).toBe(true);
    expect(termEngaged({ every: 4, offset: -1, sign: 1 }, 1372)).toBe(false);
  });
  test("refusals: the last term, a missing term, terms on a table", () => {
    const { draft } = opened(HARPTOS);
    expect(refused(removeTerm(draft, "shieldmeet", 0))).toContain("at least one term");
    expect(refused(setTerm(draft, "shieldmeet", 4, { every: 3 }))).toContain("no term 5");
    const heb = opened(HEBREW);
    expect(refused(setTerm(heb.draft, "leap", 0, { every: 3 }))).toContain("table of positions");
  });
});

describe("rename follows every reference", () => {
  test("Gregorian: the gear and the year's term; the year still reads as fields", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(renameGearIn(draft, "leap", "bissextile"));
    expect(gear(r.ast, "leap")).toBeUndefined();
    expect(gear(r.ast, "bissextile")).toBeDefined();
    expect(year(r.ast).gears).toEqual([{ gear: "bissextile", add: 1 }]);
    expect(editedSlices(base.ast!, r.calendar.ast!).sort()).toEqual(["feeds:year", "gear:bissextile", "gear:leap"]);
    expect(r.calendar.form?.year).toEqual(base.form?.year);
    expect(problems(r.ast)).toEqual([]);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(termIds(saved)).toEqual(["bissextile"]);
    expect(saved.gears.map((g) => g.id)).toEqual(["bissextile"]);
  });
  test("Gregorian: a pending leap edit through the form keeps the new id", () => {
    const { draft } = opened(GREGORIAN);
    const a = done(setTerm(draft, "leap", 0, { every: 5 }));
    const b = done(renameGearIn(a.calendar, "leap", "quint"));
    const g = gear(b.ast, "quint")!;
    expect(g.kind === "intervals" && g.terms[0]!.every).toBe(5);
    expect(termIds(b.ast)).toEqual(["quint"]);
  });
  test("Hebrew: a positions gear of 19 feeding Adar I", () => {
    const { text, base, draft } = opened(HEBREW);
    const month = HEBREW.units.find((u) => u.kind === "slots" && u.slots.some((s) => s.gears?.length))!.id;
    const r = done(renameGearIn(draft, "leap", "embolism"));
    expect(termIds(r.ast)).toEqual(["embolism"]);
    const adar = slots(r.ast, month).slots.find((s) => s.name === "Adar I")!;
    expect(adar.gears).toEqual([{ gear: "embolism", add: 30 }]);
    const g = gear(r.ast, "embolism")!;
    expect(g.kind === "positions" && g.period).toBe(19);
    expect((editedSlices(base.ast!, r.calendar.ast!) as string[]).sort()).toEqual(["gear:embolism", "gear:leap", `slots:${month}`].sort());
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(termIds(saved)).toEqual(["embolism"]);
  });
  test("Harptos: Shieldmeet's year term and its filler slot", () => {
    const { base, draft } = opened(HARPTOS);
    const r = done(renameGearIn(draft, "shieldmeet", "midsummer-leap"));
    expect(termIds(r.ast)).toEqual(["midsummer-leap", "midsummer-leap"]);
    expect(slots(r.ast, "month").slots.find((s) => s.name === "Shieldmeet")!.gears).toEqual([{ gear: "midsummer-leap", add: 1 }]);
    expect(editedSlices(base.ast!, r.calendar.ast!).sort()).toEqual(["feeds:year", "gear:midsummer-leap", "gear:shieldmeet", "slots:month"]);
    expect(problems(r.ast)).toEqual([]);
  });
  test("Roman: a ledger switch's rule, as the ledger slice", () => {
    const { base, draft } = opened(ROMAN);
    const r = done(renameGearIn(draft, "leap", "julian"));
    expect(termIds(r.ast)).not.toContain("leap");
    expect(termIds(r.ast)).toContain("julian");
    const sw = year(r.ast).ledger!.find((e) => e.kind === "switch");
    expect(sw?.kind === "switch" && sw.rule.gears).toEqual([{ gear: "julian", add: 1 }]);
    expect(editedSlices(base.ast!, r.calendar.ast!)).toContain("ledger:year");
    expect(problems(r.ast)).toEqual([]);
  });
  test("refusals name what is wrong and change nothing", () => {
    expect(refused(renameGear(ROMAN, "leap", "intercalary"))).toContain('"intercalary" is already taken by a gear');
    expect(refused(renameGear(GREGORIAN, "leap", "month"))).toContain("taken by a unit");
    expect(refused(renameGear(GREGORIAN, "leap", "Leap Year"))).toContain("lower-case letters");
    expect(refused(renameGear(GREGORIAN, "nope", "x"))).toContain('no gear "nope"');
    expect(ok(renameGear(GREGORIAN, "leap", " leap "))).toBe(GREGORIAN);
  });
});

describe("kind", () => {
  test("Hebrew's table becomes one interval per position and back, the same years engaged", () => {
    const { draft } = opened(HEBREW);
    const r = done(setKind(draft, "leap", "intervals"));
    const g = gear(r.calendar.ast!, "leap")!;
    expect(g.kind === "intervals" && g.terms.length).toBe(7);
    expect(g.kind === "intervals" && g.terms.every((t) => t.every === 19 && t.sign === 1)).toBe(true);
    expect(sameYears(g, gear(HEBREW, "leap")!, -40, 80)).toBe(true);
    const back = ok(setGearKind(r.calendar.ast!, "leap", "positions"));
    expect(sameYears(gear(back, "leap")!, gear(HEBREW, "leap")!, -40, 80)).toBe(true);
  });
  test("Gregorian's terms become a 400-year table of 97; a longer cycle is refused", () => {
    const t = ok(setGearKind(GREGORIAN, "leap", "positions"));
    const g = gear(t, "leap")!;
    expect(g.kind === "positions" && [g.period, g.positions.length]).toEqual([400, 97]);
    const long = { ...GREGORIAN, gears: [{ id: "leap", on: "year", kind: "intervals" as const, terms: [{ every: 4, sign: 1 as const }, { every: 1000, sign: -1 as const }] }] };
    expect(refused(setGearKind(long, "leap", "positions"))).toContain("at most 400");
  });
  test("Gregorian and Harptos switch to a table and back to the terms they had (the fewest intervals), the form reading Gregorian's year again", () => {
    const g = opened(GREGORIAN);
    const there = done(setKind(g.draft, "leap", "positions"));
    const back = done(setKind(there.calendar, "leap", "intervals"));
    expect(gear(back.ast, "leap")).toEqual(gear(GREGORIAN, "leap"));
    expect(back.calendar.form?.year).toEqual(g.base.form?.year);
    expect(sameCalendar(back.calendar, g.base)).toBe(true);
    expect(kindRoundTrips(GREGORIAN, "leap")).toBe(true);
    const h = opened(HARPTOS);
    const t = done(setKind(h.draft, "shieldmeet", "positions"));
    expect(gear(t.ast, "shieldmeet")).toEqual({ id: "shieldmeet", on: "year", kind: "positions", period: 4, positions: [0], offset: -1 });
    const hb = done(setKind(t.calendar, "shieldmeet", "intervals"));
    expect(gear(hb.ast, "shieldmeet")).toEqual(gear(HARPTOS, "shieldmeet"));
    expect(sameCalendar(hb.calendar, h.base)).toBe(true);
    expect(kindRoundTrips(HARPTOS, "shieldmeet")).toBe(true);
  });
  test("a sum spelt longer than it needs comes back in its shorter spelling, the same years engaged (the inspector asks first)", () => {
    const spelt: CalendarAst = { ...GREGORIAN, gears: [{ id: "leap", on: "year", kind: "intervals", terms: [{ every: 2, sign: 1 }, { every: 2, offset: 1, sign: 1 }, { every: 4, offset: 1, sign: -1 }, { every: 4, offset: 2, sign: -1 }, { every: 4, offset: 3, sign: -1 }] }] };
    expect(kindRoundTrips(spelt, "leap")).toBe(false);
    const back = ok(setGearKind(ok(setGearKind(spelt, "leap", "positions")), "leap", "intervals"));
    expect(gear(back, "leap")).toEqual({ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
    expect(sameYears(gear(back, "leap")!, gear(spelt, "leap")!, -40, 80)).toBe(true);
    expect(kindRoundTrips(HEBREW, "leap")).toBe(true); // a table loses no terms
  });
  test("Gregorian through the AST: the year stops reading as fields, refused while the year holds a field edit", () => {
    const { draft } = opened(GREGORIAN);
    const r = done(setKind(draft, "leap", "positions"));
    expect(r.calendar.form?.year).toBeUndefined();
    const pending = done(setYearLength(draft, "year", 366));
    expect(refused(setKind(pending.calendar, "leap", "positions"))).toContain("the year has an unsaved edit");
  });
  test("the cycle-year grid toggles a position", () => {
    const { base, draft } = opened(HEBREW);
    const r = done(togglePosition(draft, "leap", 1));
    const g = gear(r.calendar.ast!, "leap")!;
    expect(g.kind === "positions" && g.positions).toEqual([0, 1, 3, 6, 8, 11, 14, 17]);
    expect(g.kind === "positions" && g.offset).toBe(-1);
    const back = done(togglePosition(r.calendar, "leap", 1));
    expect(sameCalendar(back.calendar, base)).toBe(true);
    expect(refused(togglePosition(draft, "leap", 19))).toContain("outside 0 to 18");
  });
});

describe("feeds", () => {
  test("Gregorian: the year's leap days through the form; a slot feed through the AST", () => {
    const { draft } = opened(GREGORIAN);
    const r = done(setFeed(draft, "leap", { unit: "year" }, 2));
    expect(r.calendar.form!.year!.leap!.add).toBe(2);
    expect(r.calendar.ast).toBe(draft.ast);
    const jan = done(setFeed(draft, "leap", { unit: "month", slot: 0 }, 1));
    expect(slots(jan.ast, "month").slots[0]!.gears).toEqual([{ gear: "leap", add: 1 }]);
    expect(feedsOf(jan.ast, "leap").map((f) => f.label)).toEqual(["year length", "January"]);
    expect(problems(jan.ast).some((p) => p.unit === "month")).toBe(false); // February takes the rest
  });
  test("a slot that takes the rest, and a unit the gear does not count, are refused with the reason", () => {
    const { draft } = opened(GREGORIAN);
    expect(refused(setFeed(draft, "leap", { unit: "month", slot: 1 }, 1))).toContain("takes the rest");
    expect(feedTargets(draft.ast!, "leap").find((t) => t.target.slot === 1)?.why).toContain("takes the rest");
    expect(refused(setGearFeed(GREGORIAN, "leap", "month", 1))).toContain("no cycle unit");
  });
  test("Harptos: removing the year feed is the feeds:year slice; Shieldmeet still carries it", () => {
    const { base, draft } = opened(HARPTOS);
    const r = done(setFeed(draft, "shieldmeet", { unit: "year" }, null));
    expect(year(r.calendar.ast!).gears).toBeUndefined();
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["feeds:year"]);
    expect(feedsOf(r.ast, "shieldmeet").map((f) => f.label)).toEqual(["Shieldmeet"]);
    expect(feedTargets(r.ast, "shieldmeet")[0]?.label).toBe("year length");
  });
});

describe("add and remove", () => {
  test("＋ gear: every 4 on the year, feeding nothing; problems() says nothing of it", () => {
    const { base, draft } = opened(GREGORIAN);
    const r = done(addGearPart(draft));
    expect((r as { id?: string }).id).toBe("gear");
    expect(gear(r.ast, "gear")).toEqual({ id: "gear", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
    expect(feedsOf(r.ast, "gear")).toEqual([]);
    expect(gearProblems(r.ast, "gear")).toEqual([]);
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["gear:gear"]);
    const two = done(addGearPart(r.calendar));
    expect((two as { id?: string }).id).toBe("gear-2");
  });
  test("remove: Gregorian through the form (the year has no leap rule); Harptos takes its terms along; Roman refuses for its switch", () => {
    const g = opened(GREGORIAN);
    const r = done(removeGearPart(g.draft, "leap"));
    expect(r.ast.gears).toEqual([]);
    expect(year(r.ast).gears).toBeUndefined();
    const h = opened(HARPTOS);
    const hr = done(removeGearPart(h.draft, "shieldmeet"));
    expect(termIds(hr.ast)).toEqual([]);
    expect(editedSlices(h.base.ast!, hr.calendar.ast!).sort()).toEqual(["feeds:year", "gear:shieldmeet", "slots:month"]);
    const ro = opened(ROMAN);
    expect(refused(removeGearPart(ro.draft, "leap"))).toContain("rule change from year 754");
  });
});

