/**
 * A Save replays the draft's AST slices onto the definition stored at Save
 * time (src/studio/model/definition.ts `mergeLayers`, docs/SESHAT-v0.md
 * §18.6 item 1). Each slice's edits were checked against parts of the draft
 * they read but do not write; when storage moved one of those since the seed,
 * the replay would bind differently, so the Save is stale with its reason
 * (ast-edit.ts `replayProblem`), never silently wrong:
 *
 *   - slots:u    the rules (BYNTH, BYDAY, BYLABEL), exceptions and marks that read u's slots;
 *   - marks      the slots of each unit a dated mark names;
 *   - crossing:u the body its K was chosen against;
 *   - gear:g     the terms naming g after a rename or removal, the ids an added gear takes;
 *   - feeds:u    each term's gear still counting u;
 *   - the form's months: the rules and exceptions that read them.
 *
 * Each case also checks that a stored edit elsewhere still saves.
 */
import { describe, expect, test } from "bun:test";
import { setCrossingOffset, setGearFeed, setSeasonMark } from "../src/studio/model/ast-edit";
import { applyAstEdit, mergeCalendar, planCalendarSave, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { addGearPart, renameGearIn } from "../src/studio/model/orrery-gears";
import { moveSlot, renameSlot } from "../src/studio/model/orrery-slots";
import { GREGORIAN, HARPTOS, parse, print, problems, type CalendarAst, type CycleUnitAst, type RuleDefAst, type SlotAst, type SlotsUnitAst } from "../src/seshat";
import { LUNAR } from "./fixtures/orrery";

function done(r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
}
function opened(ast: CalendarAst): { text: string; base: CalendarDraft; draft: CalendarDraft } {
  const text = print(ast);
  const base = seshatDraft(parse(text));
  return { text, base, draft: structuredClone(base) };
}
/** The stored text after an edit made outside the Studio (checked to run, so a stale result is the replay's). */
const outside = (text: string, fn: (a: CalendarAst) => CalendarAst): string => {
  const a = fn(parse(text));
  expect(problems(a)).toEqual([]);
  return print(a);
};
const written = (r: MergeResult): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};
const staleWhy = (r: MergeResult): string => {
  if (r.kind !== "stale") throw new Error(`expected stale, got ${JSON.stringify(r)}`);
  return r.reason ?? "";
};
const slotsOf = (ast: CalendarAst, id: string): readonly SlotAst[] => (ast.units.find((u) => u.id === id) as SlotsUnitAst).slots;
const withSlots = (ast: CalendarAst, id: string, fn: (s: readonly SlotAst[]) => SlotAst[]): CalendarAst => ({ ...ast, units: ast.units.map((u) => (u.id === id && u.kind === "slots" ? { ...u, slots: fn(u.slots) } : u)) });
const withRule = (ast: CalendarAst, r: RuleDefAst): CalendarAst => ({ ...ast, rules: [...(ast.rules ?? []), r] });
const unrelated: RuleDefAst = { id: "solstice", tags: ["solstice"], rule: { kind: "dates", days: [172] } };
const cycle = (ast: CalendarAst, id: string) => ast.units.find((u) => u.id === id) as CycleUnitAst;
const swap = (s: readonly SlotAst[], i: number, j: number): SlotAst[] => s.map((x, k) => (k === i ? s[j]! : k === j ? s[i]! : x));

describe("slots:<unit>: what reads the slots must be as the edit saw it", () => {
  // Harptos: Alturiak (2) and Ches (3) trade places; the months still fill the year
  const moved = () => {
    const o = opened(HARPTOS);
    return { ...o, cal: done(moveSlot(o.draft, o.base, "month", 2, 1)).calendar };
  };
  test("a BYNTH rule on the months added in storage refuses the Save, with the reason in the plan", () => {
    const { text, base, cal } = moved();
    const now = outside(text, (a) => withRule(a, { id: "third-month", tags: ["t"], rule: { kind: "recur", freq: "year", by: [{ unit: "month", nth: [3] }] } }));
    const m = mergeCalendar(now, base, cal);
    expect(staleWhy(m)).toContain("reads the month");
    const plan = planCalendarSave({ source: "seshat", calendar: seshatDraft(parse(now)) }, now, { calendar: cal, base, source: "seshat" });
    expect(plan.kind === "refuse" && plan.message).toContain("reads the month");
  });
  test("a BYNTH rule on the tenday inside the months, a BYLABEL rule, an exception, a dated mark: each refuses", () => {
    const { text, base, cal } = moved();
    const edits: Array<(a: CalendarAst) => CalendarAst> = [
      (a) => withRule(a, { id: "t3", tags: ["t"], rule: { kind: "recur", freq: "year", by: [{ unit: "tenday", nth: [3] }] } }),
      (a) => withRule(a, { id: "ches", tags: ["t"], rule: { kind: "recur", freq: "year", by: [{ unit: "month", label: ["Ches"] }] } }),
      (a) => ({ ...a, units: a.units.map((u) => (u.id === "year" && u.kind === "cycle" ? { ...u, ledger: [{ kind: "slots", from: 3, unit: "tenday", path: [0], lengths: [9, 10, 11] }] } : u)) }),
      (a) => ({ ...a, seasons: { unit: "year", marks: [{ name: "Spring", slot: { unit: "month", index: 3, day: 19 } }] } }),
    ];
    for (const e of edits) expect(mergeCalendar(outside(text, e), base, cal).kind).toBe("stale");
  });
  test("a rule that reads no slot, added in storage, survives the Save of the move", () => {
    const { text, base, cal } = moved();
    const got = written(mergeCalendar(outside(text, (a) => withRule(a, unrelated)), base, cal));
    expect([slotsOf(got, "month")[3]!.name, got.rules![0]!.id]).toEqual(["Alturiak", "solstice"]);
  });
  test("a rename, then a BYLABEL rule naming the old name in storage: stale", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(renameSlot(draft, base, "month", 3, "Chess")).calendar;
    const now = outside(text, (a) => withRule(a, { id: "ches", tags: ["t"], rule: { kind: "recur", freq: "year", by: [{ unit: "month", label: ["Ches"] }] } }));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain("the month");
  });
});

describe("the form's months: the rules and exceptions that read them", () => {
  test("Gregorian: a move through the form, then a BYNTH rule on the months in storage: stale; an unrelated rule: written", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const cal = done(moveSlot(draft, base, "month", 2, 1)).calendar;
    expect(cal.ast).toBe(draft.ast); // the form path: the months part is pending, no slice
    const ruled = outside(text, (a) => withRule(a, { id: "m3", tags: ["t"], rule: { kind: "recur", freq: "year", by: [{ unit: "month", nth: [3] }] } }));
    expect(staleWhy(mergeCalendar(ruled, base, cal))).toContain("reads the month");
    const got = written(mergeCalendar(outside(text, (a) => withRule(a, unrelated)), base, cal));
    expect(slotsOf(got, "month")[3]!.name).toBe("March");
  });
});

describe("marks: a dated mark names its slot by index", () => {
  const dated: CalendarAst = { ...HARPTOS, seasons: { unit: "year", marks: [{ name: "Spring", slot: { unit: "month", index: 3, day: 19 } }] } };
  test("the months reordered in storage refuse a mark edit; a tenday rename in storage does not", () => {
    const { text, base, draft } = opened(dated);
    const cal = done(applyAstEdit(draft, base, (a) => setSeasonMark(a, 0, { name: "Spring", slot: { unit: "month", index: 3, day: 20 } }))).calendar;
    const now = outside(text, (a) => withSlots(a, "month", (s) => swap(s, 2, 3)));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain("a season starts on a day of the month");
    const tenday = outside(text, (a) => withSlots(a, "tenday", (s) => s.map((x, i) => (i === 0 ? { ...x, name: "First" } : x))));
    expect(written(mergeCalendar(tenday, base, cal)).seasons!.marks[0]).toEqual({ name: "Spring", slot: { unit: "month", index: 3, day: 20 } });
  });
});

describe("crossing:<unit>: its K was chosen against the body it follows", () => {
  test("the moon's epoch moved in storage refuses an offset edit; a rule added in storage does not", () => {
    const { text, base, draft } = opened(LUNAR);
    const cal = done(applyAstEdit(draft, base, (a) => setCrossingOffset(a, "year", { n: 1, d: 4 }))).calendar;
    const now = outside(text, (a) => ({ ...a, bodies: a.bodies!.map((b) => ({ ...b, epoch: { n: 1, d: 3 } })) }));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain('follows the body "moon"');
    const got = written(mergeCalendar(outside(text, (a) => withRule(a, unrelated)), base, cal));
    expect(cycle(got, "year").crossing!.body!.offset).toEqual({ n: 1, d: 4 });
  });
});

describe("gear:<id>: the terms naming a renamed gear, the ids an added gear takes", () => {
  test("a rename, then a term naming the old id added in storage: stale (not a broken definition)", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(renameGearIn(draft, base, "shieldmeet", "leap")).calendar;
    // the tenday's slots, a slice the rename did not touch
    const now = outside(text, (a) => withSlots(a, "tenday", (s) => s.map((x, i) => (i === 0 ? { ...x, gears: [{ gear: "shieldmeet", add: 0 }] } : x))));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain('gear "shieldmeet" is renamed or removed');
    const got = written(mergeCalendar(outside(text, (a) => withRule(a, unrelated)), base, cal));
    expect(got.gears.map((g) => g.id)).toEqual(["leap"]);
  });
  test("an added gear whose id a rule took in storage: stale", () => {
    const { text, base, draft } = opened(HARPTOS);
    const r = addGearPart(draft, base);
    const cal = done(r).calendar;
    const now = outside(text, (a) => withRule(a, { ...unrelated, id: r.id! }));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain(`the id "${r.id!}" was taken by a rule`);
  });
});

describe("feeds:<unit>: a term's gear counts the unit it lengthens", () => {
  test("a gear moved to count the week in storage refuses a new feed of the year", () => {
    const odd: CalendarAst = { ...GREGORIAN, gears: [...GREGORIAN.gears, { id: "odd", on: "year", kind: "intervals", terms: [{ every: 2, sign: 1 }] }] };
    expect(problems(odd)).toEqual([]);
    const { text, base, draft } = opened(odd);
    const cal = done(applyAstEdit(draft, base, (a) => setGearFeed(a, "odd", "year", 0))).calendar;
    const now = outside(text, (a) => ({ ...a, gears: a.gears.map((g) => (g.id === "odd" ? { ...g, on: "week" } : g)) }));
    expect(staleWhy(mergeCalendar(now, base, cal))).toContain('gear "odd" no longer counts the year');
  });
});
