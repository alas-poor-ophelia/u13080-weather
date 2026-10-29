/**
 * Orrery slice 5f (docs/SESHAT-v0.md §18.3 D8, §18.6 items 1, 2 and 11; bead
 * wadjet-b6x): the Seasons inspector's pure edits
 * (src/studio/model/orrery-seasons.ts), on Gregorian (no seasons yet),
 * Harptos (months with fillers), Hebrew (a year that follows the molad) and
 * LUNAR (marks of all three kinds):
 *
 *   - fraction marks go through the draft's seasons field (the Seasons
 *     window's draft), kept ascending; ＋ mark, rename, the from knob, ×;
 *   - a kind switch keeps the start day this year (fraction → day of year →
 *     month · day → fraction), goes through the AST's `marks` slice, and a
 *     Save writes `DAY:` and `month:M.D`;
 *   - an unsaved fraction edit is folded into the layer when a mark is dated;
 *   - refusals: a blank name, a day 0, a month that is not in the year, a
 *     slot a season starts in;
 *   - the stale guard: the marks slice, and the slots a dated mark names.
 */
import { describe, expect, test } from "bun:test";
import { editedSlices } from "../src/studio/model/ast-edit";
import { mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { yearFacts } from "../src/studio/model/orrery-geometry";
import { addMark, convertMark, fractionFor, removeMark, renameMark, setMarkDay, setMarkFrom, setMarkKind, setMarkSlot, type SeasonYear } from "../src/studio/model/orrery-seasons";
import { moveSlot, removeSlot } from "../src/studio/model/orrery-slots";
import { fractionBoundary, GREGORIAN, HARPTOS, HEBREW, parse, print, problems, type CalendarAst, type SeasonMarkAst, type SlotsUnitAst } from "../src/seshat";
import { LUNAR } from "./fixtures/orrery";

function done(r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
}
const refused = (r: CalendarEdit): string => {
  if (!("refused" in r)) throw new Error("not refused");
  return r.reason;
};
function opened(ast: CalendarAst): { text: string; base: CalendarDraft; draft: CalendarDraft } {
  const text = print(ast);
  const base = seshatDraft(parse(text));
  return { text, base, draft: structuredClone(base) };
}
const written = (r: MergeResult): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};
const staleWhy = (r: MergeResult): string => {
  if (r.kind !== "stale") throw new Error(`expected stale, got ${JSON.stringify(r)}`);
  return r.reason ?? "";
};
const outside = (text: string, fn: (a: CalendarAst) => CalendarAst): string => {
  const a = fn(parse(text));
  expect(problems(a)).toEqual([]);
  return print(a);
};
const marks = (ast: CalendarAst): readonly SeasonMarkAst[] => ast.seasons?.marks ?? [];
/** This year's facts as the window hands them to the editor (orrery.ts `seasonYear`). */
function seasonYear(ast: CalendarAst, k: number): SeasonYear {
  const y = yearFacts(ast, k)!;
  const at: Array<number | null> = marks(ast).map(() => null);
  for (const f of y.seasons) at[f.order] = f.at;
  const slots = new Map<string, readonly number[]>();
  for (const t of y.slots) if (t.path.length === 1) slots.set(t.unit, t.lengths);
  return { length: y.length, at, slots };
}
/** The day (0-based, into year k) each mark starts on, in declaration order. */
const startDays = (ast: CalendarAst, k: number): Array<number | null> => seasonYear(ast, k).at.slice();
/** Gregorian 2024 is year index 2024. */
const Y = 2024;

describe("fraction marks go through the seasons field (Gregorian: no seasons yet)", () => {
  test("＋ mark twice: the field holds them ascending, the draft compiles them over the year, and a Save writes them", () => {
    const { text, base, draft } = opened(GREGORIAN);
    expect(draft.ast!.seasons).toBeUndefined();
    const a = addMark(draft, base, []);
    const one = done(a);
    expect(a.index).toBe(0);
    expect(one.calendar.seasons).toEqual([{ name: "Season", from: 0 }]);
    expect(one.calendar.ast).toBe(draft.ast); // the layer is untouched: the field is pending
    const b = addMark(one.calendar, base, [0]);
    const two = done(b);
    expect(two.calendar.seasons).toEqual([
      { name: "Season", from: 0 },
      { name: "Season 2", from: 0.5 },
    ]);
    expect(b.index).toBe(1);
    expect(problems(two.ast)).toEqual([]);
    expect(marks(written(mergeCalendar(text, base, two.calendar)))).toEqual([
      { name: "Season", from: 0 },
      { name: "Season 2", from: 0.5 },
    ]);
  });

  test("the from knob reorders the field ascending, edits the mark it holds through a drag past a neighbour, and back is clean", () => {
    const { base, draft } = opened({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Spring", from: 0.2 }, { name: "Summer", from: 0.45 }, { name: "Autumn", from: 0.7 }] } });
    const origin = marks(draft.ast!);
    const f1 = done(setMarkFrom(draft, base, 0, 0.5, origin));
    expect(f1.calendar.seasons.map((s) => s.name)).toEqual(["Summer", "Spring", "Autumn"]);
    const f2 = done(setMarkFrom(f1.calendar, base, 0, 0.6, origin));
    expect(f2.calendar.seasons).toEqual([
      { name: "Summer", from: 0.45 },
      { name: "Spring", from: 0.6 },
      { name: "Autumn", from: 0.7 },
    ]);
    expect(sameCalendar(done(setMarkFrom(f2.calendar, base, 0, 0.2, origin)).calendar, base)).toBe(true);
  });

  test("rename and ×; refusals", () => {
    const { base, draft } = opened({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] } });
    const r = done(renameMark(draft, base, 1, "Dust"));
    expect(r.calendar.seasons[1]!.name).toBe("Dust");
    expect(refused(renameMark(draft, base, 1, " "))).toContain("needs a name");
    const x = done(removeMark(draft, base, 0));
    expect(x.calendar.seasons).toEqual([{ name: "Dry", from: 0.5 }]);
    const none = done(removeMark(x.calendar, base, 0));
    expect(none.ast.seasons).toBeUndefined();
    expect(refused(setMarkFrom(draft, base, 0, 1, marks(draft.ast!)))).toContain("fraction of the year");
    expect(refused(setMarkDay(draft, base, 0, 0))).toContain("day 1 or later");
  });
});

describe("dated marks go through the AST (`marks`)", () => {
  test("Gregorian: fraction → day of year keeps the start day, the slice is marks, the field reads the projection, a Save writes DAY:", () => {
    const { text, base, draft } = opened({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Winter", from: 0 }, { name: "Summer", from: 0.5 }] } });
    const year = seasonYear(draft.ast!, Y);
    expect(year.at).toEqual([0, 183]);
    const r = setMarkKind(draft, base, 1, "day", year);
    const d = done(r);
    expect(r.kept).toBe(true);
    expect(marks(d.ast)[1]).toEqual({ name: "Summer", day: 184 });
    expect(startDays(d.ast, Y)).toEqual([0, 183]);
    expect(editedSlices(base.ast!, d.calendar.ast!)).toEqual(["marks"]);
    expect(d.calendar.seasons.map((s) => s.name)).toEqual(["Winter", "Summer"]);
    const saved = written(mergeCalendar(text, base, d.calendar));
    expect(print(saved)).toContain("Summer=DAY:184");
    // and on: a day knob moves it (the strip moves with it), then month · day keeps that day
    const moved = done(setMarkDay(d.calendar, base, 1, 200));
    expect(startDays(moved.ast, Y)).toEqual([0, 199]);
    const m = setMarkKind(moved.calendar, base, 1, "slot", seasonYear(moved.ast, Y));
    expect(m.kept).toBe(true);
    expect(marks(done(m).ast)[1]).toEqual({ name: "Summer", slot: { unit: "month", index: 6, day: 18 } }); // 2024-07-18 is day 200
    expect(print(written(mergeCalendar(text, base, done(m).calendar)))).toContain("Summer=month:7.18");
    // back to a fraction on the same day: the form reads the seasons as fields again
    const f = setMarkKind(done(m).calendar, base, 1, "fraction", seasonYear(done(m).ast, Y));
    expect(f.kept).toBe(true);
    const fr = marks(done(f).ast)[1] as { from: number };
    expect(fractionBoundary(fr.from, 366)).toBe(199);
  });

  test("an unsaved fraction edit is folded into the layer when a mark is dated (one draft, nothing dropped)", () => {
    const { text, base, draft } = opened({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Winter", from: 0 }, { name: "Summer", from: 0.5 }] } });
    const renamed = done(renameMark(draft, base, 0, "Frost"));
    const d = done(setMarkKind(renamed.calendar, base, 1, "day", seasonYear(renamed.ast, Y)));
    expect(marks(d.calendar.ast!)).toEqual([{ name: "Frost", from: 0 }, { name: "Summer", day: 184 }]);
    expect(marks(written(mergeCalendar(text, base, d.calendar)))).toEqual([{ name: "Frost", from: 0 }, { name: "Summer", day: 184 }]);
  });

  test("Harptos: ＋ mark, then month · day lands in the right month past the fillers; Midwinter-style fillers count as months", () => {
    const { text, base, draft } = opened(HARPTOS);
    const a = done(addMark(draft, base, []));
    const b = done(addMark(a.calendar, base, [0]));
    const year = seasonYear(b.ast, 1372);
    const r = setMarkKind(b.calendar, base, 1, "slot", year);
    const m = marks(done(r).ast)[1] as { slot: { unit: string; index: number; day: number } };
    expect(r.kept).toBe(true);
    const month = HARPTOS.units.find((u) => u.id === "month") as SlotsUnitAst;
    expect(m.slot.unit).toBe("month");
    expect(startDays(done(r).ast, 1372)[1]).toBe(year.at[1]);
    expect(month.slots[m.slot.index]).toBeDefined();
    const saved = written(mergeCalendar(text, base, done(r).calendar));
    expect(problems(saved)).toEqual([]);
    // the month dropdown: another month, same day
    const next = done(setMarkSlot(done(r).calendar, base, 1, { unit: "month", index: 0, day: 5 }));
    expect(startDays(next.ast, 1372)[1]).toBe(4);
    expect(refused(setMarkSlot(done(r).calendar, base, 1, { unit: "tenday", index: 0, day: 1 }))).toContain("directly in the year");
  });

  test("Hebrew (a year that follows the molad): day of year and month · day convert on this year's lengths", () => {
    const { text, base, draft } = opened({ ...HEBREW, seasons: { unit: "year", marks: [{ name: "Tishrei", from: 0 }, { name: "Nisan", from: 0.5 }] } });
    const year = seasonYear(draft.ast!, 5786);
    const d = setMarkKind(draft, base, 1, "slot", year);
    expect(d.kept).toBe(true);
    expect(startDays(done(d).ast, 5786)[1]).toBe(year.at[1]);
    expect(problems(written(mergeCalendar(text, base, done(d).calendar)))).toEqual([]);
  });

  test("LUNAR: a dated layer keeps every edit in the AST, a fraction knob there edits by index, and × keeps the other kinds", () => {
    const { text, base, draft } = opened(LUNAR);
    const origin = marks(draft.ast!);
    const f = done(setMarkFrom(draft, base, 0, 0.2, origin));
    expect(marks(f.ast)).toEqual([{ name: "Thaw", from: 0.2 }, { name: "Bloom", day: 80 }, { name: "Harvest", slot: { unit: "month", index: 6, day: 1 } }]);
    expect(editedSlices(base.ast!, f.calendar.ast!)).toEqual(["marks"]);
    const x = done(removeMark(f.calendar, base, 1));
    expect(marks(written(mergeCalendar(text, base, x.calendar)))).toEqual([{ name: "Thaw", from: 0.2 }, { name: "Harvest", slot: { unit: "month", index: 6, day: 1 } }]);
  });

  test("a slot a season starts in cannot be removed; a move carries the mark with its slot", () => {
    const { base, draft } = opened(LUNAR);
    expect(refused(removeSlot(draft, base, "month", 6))).toContain("Harvest");
    const moved = done(moveSlot(draft, base, "month", 6, 1));
    expect(marks(moved.ast)[2]).toEqual({ name: "Harvest", slot: { unit: "month", index: 7, day: 1 } });
  });
});

describe("pieces", () => {
  test("fractionFor lands on the day: a knob step when one does, else at / length", () => {
    for (const length of [365, 366, 354, 383, 385]) for (let at = 0; at < length; at += 7) expect(fractionBoundary(fractionFor(at, length), length)).toBe(at);
    expect(fractionFor(0, 365)).toBe(0);
  });

  test("convertMark: a mark that falls on no day this year starts at the year's (or the month's) first day, and says so", () => {
    expect(convertMark({ name: "X", from: 0.5 }, "day", null, 365, null)).toEqual({ mark: { name: "X", day: 1 }, kept: false });
    expect(convertMark({ name: "X", day: 40 }, "slot", 39, 365, { id: "month", lengths: [31, 28] })).toEqual({ mark: { name: "X", slot: { unit: "month", index: 1, day: 9 } }, kept: true });
    expect(convertMark({ name: "X", day: 40 }, "slot", 39, 365, null)).toContain("no months");
  });
});

describe("the stale guard (§18.6 item 1)", () => {
  test("a dated mark is stale when the marks changed outside; an unrelated edit outside still saves", () => {
    const { text, base, draft } = opened(LUNAR);
    const d = done(setMarkDay(draft, base, 1, 90));
    const renamed = outside(text, (a) => ({ ...a, seasons: { ...a.seasons!, marks: a.seasons!.marks.map((m, i) => (i === 0 ? { ...m, name: "Melt" } : m)) } }));
    expect(mergeCalendar(renamed, base, d.calendar).kind).toBe("stale");
    const other = outside(text, (a) => ({ ...a, name: "Lunar renamed" }));
    const saved = written(mergeCalendar(other, base, d.calendar));
    expect(saved.name).toBe("Lunar renamed");
    expect(marks(saved)[1]).toEqual({ name: "Bloom", day: 90 });
  });

  test("a month · day mark is stale when its months changed outside (replayProblem)", () => {
    const { text, base, draft } = opened(LUNAR);
    const d = done(setMarkSlot(draft, base, 2, { unit: "month", index: 6, day: 3 }));
    const lengths = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "month" && u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 0 ? { ...s, name: "First" } : s)) } : u)) }));
    expect(staleWhy(mergeCalendar(lengths, base, d.calendar))).toContain("a season starts on a day of the month");
  });
});
