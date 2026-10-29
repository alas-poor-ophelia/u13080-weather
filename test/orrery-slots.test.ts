/**
 * Orrery slice 5b (docs/SESHAT-v0.md §18.3, §18.6 items 1 and 2; bead
 * wadjet-b6x): the year, slot unit and slot inspectors' pure edits
 * (src/studio/model/orrery-slots.ts) and their AST half (ast-edit.ts
 * `setCycleLength`, `setSlotUnit`, slices `length:<unit>` and `slots:<unit>`).
 *
 *   - Gregorian reads its year and months as fields: the edits go through
 *     the form (`FormDraft.year`, `FormDraft.months`) and `compile`; an edit
 *     the form cannot write (a filler, a second slot taking the rest) takes
 *     the AST path, and is refused while the months hold a field edit;
 *   - Harptos (fillers, a gear on a slot, the tenday) is text to the form:
 *     every edit is an AST edit on its own slice;
 *   - a slack slot (February, and one with limits) loses its limits when it
 *     takes a fixed length;
 *   - a slot unit that no longer fills its parent is `problems()`'s to say,
 *     on the unit;
 *   - the stale guard covers the new slices: an outside edit to another part
 *     survives a Save, one to the slice the draft edited refuses.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import { editedSlices, setCycleLength, setSlotUnit, slotOrderProblem, type AstEdit } from "../src/studio/model/ast-edit";
import { applyAstEdit, mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { addSlot, moveSlot, removeSlot, renameSlot, setSlotDays, setSlotFiller, setSlotRest, setYearLength, slotFlag, yearRange } from "../src/studio/model/orrery-slots";
import { GREGORIAN, HARPTOS, HEBREW, parse, print, problems, type CalendarAst, type CycleUnitAst, type SlotAst, type SlotsUnitAst } from "../src/seshat";

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
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
const slotsOf = (ast: CalendarAst, id: string): readonly SlotAst[] => (ast.units.find((u) => u.id === id) as SlotsUnitAst).slots;
const year = (ast: CalendarAst): CycleUnitAst => ast.units.find((u) => u.id === "year") as CycleUnitAst;
const fills = (ast: CalendarAst, unit: string): boolean => !problems(ast).some((p) => p.unit === unit);
/** The stored text after an edit made outside the Studio. */
const outside = (text: string, fn: (a: CalendarAst) => CalendarAst) => print(fn(parse(text)));
const withSlots = (ast: CalendarAst, id: string, fn: (s: readonly SlotAst[]) => SlotAst[]): CalendarAst => ({ ...ast, units: ast.units.map((u) => (u.id === id && u.kind === "slots" ? { ...u, slots: fn(u.slots) } : u)) });

describe("the year's length", () => {
  test("Gregorian: through the form's year; back to 365 leaves the draft clean", () => {
    const { base, draft } = opened(GREGORIAN);
    const r = done(setYearLength(draft, base, "year", 366));
    expect(r.calendar.form!.year!.length).toBe(366);
    expect(r.calendar.ast).toBe(draft.ast); // the layer is untouched: the form part is pending
    expect(year(r.ast).length).toBe(366);
    expect(fills(r.ast, "month")).toBe(true); // February takes the rest
    const back = done(setYearLength(r.calendar, base, "year", 365));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("Harptos: the form reads its year as text, so the AST's length:year slice; the months stop filling", () => {
    const { base, draft } = opened(HARPTOS);
    expect(draft.form?.year).toBeUndefined();
    const r = done(setYearLength(draft, base, "year", 366));
    expect(year(r.calendar.ast!).length).toBe(366);
    expect(year(r.ast).gears).toEqual(year(HARPTOS).gears);
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["length:year"]);
    expect(problems(r.ast).find((p) => p.unit === "month")?.message).toContain("parent occurrence is 366");
  });
  test("refusals: a crossing base, a missing unit, a length that is no whole number", () => {
    expect(refused(setCycleLength(HEBREW, "year", 360))).toContain("starts by a crossing");
    expect(refused(setCycleLength(GREGORIAN, "nope", 360))).toContain('no cycle unit "nope"');
    const { base, draft } = opened(GREGORIAN);
    expect(refused(setYearLength(draft, base, "year", 0))).toContain("at least 1");
    expect(refused(setYearLength(draft, base, "year", 365.5))).toContain("whole number");
  });
  test("the knob's range is 300 to 420, widened to hold the year", () => {
    expect(yearRange(365)).toEqual({ min: 300, max: 420 });
    expect(yearRange(260)).toEqual({ min: 260, max: 420 });
    expect(yearRange(445)).toEqual({ min: 300, max: 445 });
  });
});

describe("Gregorian slots: through the form's months", () => {
  test("days: January takes 34, February (the rest) gives them up, the year still fills; the layer is untouched", () => {
    const { base, draft } = opened(GREGORIAN);
    const r = done(setSlotDays(draft, base, "month", 0, 34));
    expect(r.calendar.form!.months![0]).toEqual({ name: "January", length: 34 });
    expect(r.calendar.ast).toBe(draft.ast);
    expect(slotsOf(r.ast, "month")[0]!.length).toBe(34);
    expect(fills(r.ast, "month")).toBe(true);
    expect(sameCalendar(done(setSlotDays(r.calendar, base, "month", 0, 31)).calendar, base)).toBe(true);
  });
  test("rename, move, add, remove: each a months edit; an added slot that the year cannot hold is problems()'s to flag", () => {
    const { base, draft } = opened(GREGORIAN);
    const named = done(renameSlot(draft, base, "month", 0, "  Janus "));
    expect(slotsOf(named.ast, "month")[0]!.name).toBe("Janus");
    expect(refused(renameSlot(draft, base, "month", 0, " "))).toContain("keeps one");
    const moved = done(moveSlot(draft, base, "month", 0, 1));
    expect(slotsOf(moved.ast, "month").slice(0, 2).map((s) => s.name)).toEqual(["February", "January"]);
    expect(refused(moveSlot(draft, base, "month", 0, -1))).toContain("first slot");
    expect(refused(moveSlot(draft, base, "month", 11, 1))).toContain("last slot");
    const added = addSlot(draft, base, "month", 0);
    const a = done(added);
    expect(added.index).toBe(1);
    expect(slotsOf(a.ast, "month")[1]).toEqual({ name: "New slot", length: 31 });
    expect(a.calendar.form!.months).toHaveLength(13);
    expect(problems(a.ast).find((p) => p.unit === "month")?.message).toContain("slots take at least");
    const removed = done(removeSlot(draft, base, "month", 11));
    expect(slotsOf(removed.ast, "month")).toHaveLength(11);
    expect(fills(removed.ast, "month")).toBe(true); // February takes December's days
  });
  test("an edit the form cannot write takes the AST path: a filler, a second slot taking the rest", () => {
    const { base, draft } = opened(GREGORIAN);
    const f = done(setSlotFiller(draft, base, "month", 3, true));
    expect(slotsOf(f.calendar.ast!, "month")[3]).toEqual({ name: "April", length: 30, filler: true });
    expect(f.calendar.form!.months).toBeUndefined(); // the months now read as text
    expect(editedSlices(base.ast!, f.calendar.ast!)).toEqual(["slots:month"]);
    const rest = done(setSlotRest(draft, base, "month", 3, true, 30));
    expect(slotsOf(rest.ast, "month").filter((s) => s.length === "slack")).toHaveLength(2);
    expect(slotFlag(slotsOf(f.ast, "month")[3]!)).toBe("filler");
  });
  test("an AST-path edit is refused while the months hold an unsaved field edit (one source per part)", () => {
    const { base, draft } = opened(GREGORIAN);
    const renamed = done(renameSlot(draft, base, "month", 0, "Janus")).calendar;
    expect(refused(setSlotFiller(renamed, base, "month", 3, true))).toContain("months have an unsaved edit");
  });
  test("a season on a month follows it through a reorder (compile's remap), and removing its month is refused", () => {
    const dated: CalendarAst = { ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Spring", slot: { unit: "month", index: 2, day: 20 } }] } };
    const { base, draft } = opened(dated);
    const moved = done(moveSlot(draft, base, "month", 1, 1)); // February after March
    expect(moved.ast.seasons!.marks[0]).toEqual({ name: "Spring", slot: { unit: "month", index: 1, day: 20 } });
    expect(refused(removeSlot(draft, base, "month", 2))).toContain("Spring");
  });
});

describe("Harptos slots: fillers, a gear on a slot, the tenday: the AST's slots: slices", () => {
  test("days on Hammer: slots:month; the months and the tendays stop filling", () => {
    const { base, draft } = opened(HARPTOS);
    expect(draft.form?.months).toBeUndefined();
    const r = done(setSlotDays(draft, base, "month", 0, 31));
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["slots:month"]);
    expect(slotsOf(r.ast, "month")[0]).toEqual({ name: "Hammer", length: 31 });
    const units = new Set(problems(r.ast).map((p) => p.unit));
    expect(units.has("month") || units.has("tenday")).toBe(true);
  });
  test("Shieldmeet keeps its gear and stays a filler through a rename and a days edit; the flag says so", () => {
    const { base, draft } = opened(HARPTOS);
    const i = slotsOf(HARPTOS, "month").findIndex((s) => s.name === "Shieldmeet");
    const r = done(renameSlot(draft, base, "month", i, "Shieldmoot"));
    const r2 = done(setSlotDays(r.calendar, base, "month", i, 0));
    const s = slotsOf(r2.ast, "month")[i]!;
    expect(s).toEqual({ name: "Shieldmoot", length: 0, gears: [{ gear: "shieldmeet", add: 1 }], filler: true });
    expect(slotFlag(s)).toBe("filler · gear");
    expect(fills(r2.ast, "month")).toBe(true);
  });
  test("a festival that is no longer a filler must be tiled by tendays: problems() says so", () => {
    const { base, draft } = opened(HARPTOS);
    const r = done(setSlotFiller(draft, base, "month", 1, false)); // Midwinter, one day
    expect(slotsOf(r.ast, "month")[1]).toEqual({ name: "Midwinter", length: 1 });
    expect(problems(r.ast).length).toBeGreaterThan(0);
  });
  test("the tenday's unnamed slots: a name is optional, and the tenday is its own slice", () => {
    const { base, draft } = opened(HARPTOS);
    const r = done(renameSlot(draft, base, "tenday", 0, "First"));
    expect(slotsOf(r.ast, "tenday")[0]).toEqual({ name: "First", length: 10 });
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["slots:tenday"]);
    expect(done(renameSlot(draft, base, "tenday", 1, "")).calendar).toEqual(draft); // nothing to write
    const added = addSlot(draft, base, "tenday", -1);
    expect(slotsOf(done(added).ast, "tenday")[3]).toEqual({ length: 10 }); // no names: none given
  });
  test("move, add after, remove; a unit keeps one slot", () => {
    const { base, draft } = opened(HARPTOS);
    const moved = done(moveSlot(draft, base, "month", 0, 1));
    expect(slotsOf(moved.ast, "month").slice(0, 2).map((s) => s.name)).toEqual(["Midwinter", "Hammer"]);
    const after = addSlot(draft, base, "month", 0);
    expect(after.index).toBe(1);
    expect(slotsOf(done(after).ast, "month")[1]).toEqual({ name: "New slot", length: 30 });
    expect(slotsOf(done(removeSlot(draft, base, "month", 1)).ast, "month")).toHaveLength(slotsOf(HARPTOS, "month").length - 1);
    const one = withSlots(HARPTOS, "tenday", (s) => [{ ...s[0]!, length: 30 }]);
    const o = opened(one);
    expect(refused(removeSlot(o.draft, o.base, "tenday", 0))).toContain("at least one slot");
  });
  test("a dated season follows its month through an AST reorder; removing its month is refused, naming it", () => {
    const dated: CalendarAst = { ...HARPTOS, seasons: { unit: "year", marks: [{ name: "Spring", slot: { unit: "month", index: 3, day: 19 } }] } }; // Ches 19
    const { base, draft } = opened(dated);
    const moved = done(moveSlot(draft, base, "month", 2, 1)); // Alturiak after Ches
    expect(moved.ast.seasons!.marks[0]).toEqual({ name: "Spring", slot: { unit: "month", index: 2, day: 19 } });
    expect(editedSlices(base.ast!, moved.calendar.ast!)).toEqual(["slots:month", "marks"]);
    expect(refused(removeSlot(draft, base, "month", 3))).toContain("Spring starts in Ches");
  });
});

describe("a slack slot", () => {
  const LIMITED = withSlots(GREGORIAN, "month", (s) => s.map((x, i) => (i === 1 ? { name: "February", length: "slack", min: 28, max: 29, fill: 0 } : x)));
  test("with limits it is text to the form; a fixed length drops the limits; takes-the-rest off fixes this year's days", () => {
    const { base, draft } = opened(LIMITED);
    expect(draft.form?.months).toBeUndefined();
    const days = done(setSlotDays(draft, base, "month", 1, 28));
    expect(slotsOf(days.ast, "month")[1]).toEqual({ name: "February", length: 28 });
    const off = done(setSlotRest(draft, base, "month", 1, false, 29));
    expect(slotsOf(off.ast, "month")[1]).toEqual({ name: "February", length: 29 });
    expect(problems(off.ast).some((p) => p.unit === "month")).toBe(true); // a fixed February fails common years
    expect(slotFlag(slotsOf(LIMITED, "month")[1]!)).toBe("rest");
  });
  test("Gregorian's February: takes-the-rest off then on again is clean", () => {
    const { base, draft } = opened(GREGORIAN);
    const off = done(setSlotRest(draft, base, "month", 1, false, 28));
    expect(off.calendar.form!.months![1]).toEqual({ name: "February", length: 28 });
    const on = done(setSlotRest(off.calendar, base, "month", 1, true, 28));
    expect(sameCalendar(on.calendar, base)).toBe(true);
  });
  test("a keyed length is refused at the days knob", () => {
    const keyed = withSlots(GREGORIAN, "month", (s) => s.map((x, i) => (i === 1 ? { name: "February", length: { by: "parent", table: [[365, 28], [366, 29]] } } : x)));
    const { base, draft } = opened(keyed);
    expect(refused(setSlotDays(draft, base, "month", 1, 28))).toContain("row by row");
  });
});

describe("reordering guards", () => {
  test("a rule that reads the months by number refuses a move, an add and a remove; a rename goes through", () => {
    const ruled: CalendarAst = { ...GREGORIAN, rules: [{ id: "spring-month", rule: { kind: "index", unit: "month", from: 2, to: 2 } }] };
    const { base, draft } = opened(ruled);
    expect(slotOrderProblem(ruled, "month")).toContain('"spring-month"');
    expect(refused(moveSlot(draft, base, "month", 0, 1))).toContain("by number");
    expect(refused(addSlot(draft, base, "month", 0))).toContain("by number");
    expect(refused(removeSlot(draft, base, "month", 0))).toContain("by number");
    expect(slotsOf(done(renameSlot(draft, base, "month", 0, "Janus")).ast, "month")[0]!.name).toBe("Janus");
  });
  test("an exception that sets the tenday's lengths refuses a reorder of the months it sits in", () => {
    const ledgered: CalendarAst = { ...HARPTOS, units: HARPTOS.units.map((u) => (u.id === "year" && u.kind === "cycle" ? { ...u, ledger: [{ kind: "slots", from: 3, unit: "tenday", path: [0], lengths: [9, 10, 11] }] } : u)) };
    expect(slotOrderProblem(ledgered, "month")).toContain("tenday lengths");
    expect(refused(setSlotUnit(ledgered, "month", [...slotsOf(ledgered, "month")].reverse(), slotsOf(ledgered, "month").map((_, i, a) => a.length - 1 - i)))).toContain("Exceptions");
    expect("ast" in setSlotUnit(ledgered, "month", slotsOf(ledgered, "month").map((s, i) => (i === 0 ? { ...s, name: "Hammer!" } : s)))).toBe(true);
  });
  test("setSlotUnit refuses what no slot can be", () => {
    expect(refused(setSlotUnit(HARPTOS, "month", []))).toContain("at least one slot");
    expect(refused(setSlotUnit(HARPTOS, "month", [{ length: -1 }], [0]))).toContain("from 0 up");
    expect(refused(setSlotUnit(HARPTOS, "month", [{ length: 3, min: 1 }], [0]))).toContain("takes the rest");
    expect(refused(setSlotUnit(HARPTOS, "nope", [{ length: 3 }]))).toContain('no slot unit "nope"');
  });
});

describe("the stale guard on the new slices (§18.6 item 1)", () => {
  test("slots:month: an outside edit to the tenday, the year's number and a rule survives the Save", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(renameSlot(draft, base, "month", 0, "Hammerfall")).calendar;
    const tenday = (x: CalendarAst) => withSlots(x, "tenday", (sl) => sl.map((t, i) => (i === 0 ? { ...t, name: "First" } : t)));
    const now = outside(text, (a) => {
      const t = tenday(a);
      return { ...t, units: t.units.map((u) => (u.id === "year" ? { ...u, number: 1300 } : u)) };
    });
    const got = written(mergeCalendar(now, base, cal));
    expect(slotsOf(got, "month")[0]!.name).toBe("Hammerfall");
    expect(slotsOf(got, "tenday")[0]!.name).toBe("First");
    expect(year(got).number).toBe(1300);
  });
  test("slots:month: an outside edit to the months refuses, showing the stored calendar", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(setSlotDays(draft, base, "month", 0, 31)).calendar;
    const now = outside(text, (a) => withSlots(a, "month", (s) => s.map((x, i) => (i === 2 ? { ...x, name: "Alturiak!" } : x))));
    const m = mergeCalendar(now, base, cal);
    expect(m.kind).toBe("stale");
    if (m.kind === "stale") expect(same(m.stored.ast, parse(now))).toBe(true);
  });
  test("length:year: an outside edit to the months survives (together they run); one to the year's length refuses", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(setYearLength(draft, base, "year", 366)).calendar;
    // a two-day Midwinter (a filler: no tenday to tile) makes the months 366 days, as the draft's year is
    const months = outside(text, (a) => withSlots(a, "month", (s) => s.map((x, i) => (i === 1 ? { ...x, length: 2 } : x))));
    const got = written(mergeCalendar(months, base, cal));
    expect([year(got).length, slotsOf(got, "month")[1]!.length]).toEqual([366, 2]);
    const longer = outside(text, (a) => ok(setCycleLength(a, "year", 364)));
    expect(mergeCalendar(longer, base, cal).kind).toBe("stale");
  });
  test("slots:tenday and slots:month are separate: an outside edit to one survives a Save of the other", () => {
    const { text, base, draft } = opened(HARPTOS);
    const cal = done(renameSlot(draft, base, "tenday", 0, "First")).calendar;
    const now = outside(text, (a) => withSlots(a, "month", (s) => s.map((x, i) => (i === 0 ? { ...x, name: "Hammerfall" } : x))));
    const got = written(mergeCalendar(now, base, cal));
    expect([slotsOf(got, "tenday")[0]!.name, slotsOf(got, "month")[0]!.name]).toEqual(["First", "Hammerfall"]);
  });
  test("an AST slot edit on a form calendar: an outside year edit survives (finer than the form's year part)", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const cal = done(setSlotFiller(draft, base, "month", 3, true)).calendar;
    const now = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "year" ? { ...u, number: 5 } : u)) }));
    const got = written(mergeCalendar(now, base, cal));
    expect(year(got).number).toBe(5);
    expect(slotsOf(got, "month")[3]!.filler).toBe(true);
  });
  test("applyAstEdit still refuses an edit past its slices; a length edit is inside its slice", () => {
    const { base, draft } = opened(HARPTOS);
    expect(refused(applyAstEdit(draft, base, (a) => ({ ast: { ...a, units: a.units.map((u) => (u.id === "year" ? { ...u, anchor: 5 } : u)) } as CalendarAst })))).toContain("past the part");
    expect("calendar" in applyAstEdit(draft, base, (a) => setCycleLength(a, "year", 360))).toBe(true);
  });
});
