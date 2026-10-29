/**
 * Orrery slice 5d (docs/SESHAT-v0.md §18.3, §18.6 items 1 and 2; bead
 * wadjet-b6x): the stage inspector's pure edits (src/studio/model/orrery-stages.ts),
 * through `setStages` (ast-edit.ts) and the validator's own start-rule
 * checks, on Hebrew (the real preset), HEBREW_WEEK (Hebrew with a weekday
 * cycle, so a weekday test reads by day name) and LUNAR:
 *
 *   - a residue cell toggled moves this year's start (HEBREW_LOOSE, whose
 *     months fill a year a day longer or shorter; on the real preset the
 *     months then stop adding up, which problems() says), and toggled back is
 *     clean (5787 starts D20708, 385 days);
 *   - cells are ordered and titled by weekday when a seven-label day cycle
 *     exists; the rule reads "starts on Rishon · Revi'i · Shishi → +1";
 *   - a new rule or stage moves nothing; order is meaning (first match);
 *   - refusals: the last day of a test, the last rule of a stage, a stage on
 *     a fixed-day year, a window past V2, a year left no day (V3);
 *   - the stale guard covers `stages:<unit>`, and the weekday cycle a test
 *     was edited by (`replayProblem`).
 */
import { describe, expect, test } from "bun:test";
import { editedSlices, setStages } from "../src/studio/model/ast-edit";
import { mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { stageFacts } from "../src/studio/model/orrery-geometry";
import { addRule, addStage, moveRule, removeRule, removeStage, residueCells, residueOf, ruleSentence, setLengthRule, setResidueRule, stagesApply, toggleResidue } from "../src/studio/model/orrery-stages";
import { Engine, GREGORIAN, HEBREW, parse, print, problems, type CalendarAst, type CycleUnitAst, type StageRule } from "../src/seshat";
import { HEBREW_DAYS, HEBREW_LOOSE, HEBREW_WEEK, LUNAR } from "./fixtures/orrery";

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
const outside = (text: string, fn: (a: CalendarAst) => CalendarAst) => print(fn(parse(text)));
const year = (ast: CalendarAst): CycleUnitAst => ast.units.find((u) => u.id === "year") as CycleUnitAst;
const rule = (ast: CalendarAst, i: number, j: number): StageRule => year(ast).stages![i]!.rules[j]!;
/** Hebrew 5787 is year index 5786. */
const Y5787 = 5786;
const startAndLength = (ast: CalendarAst, k = Y5787): [number, number] => {
  const e = new Engine(ast);
  return [e.start("year", k), e.length("year", k)];
};
const starts = (ast: CalendarAst, from: number, to: number): number[] => {
  const e = new Engine(ast);
  return Array.from({ length: to - from }, (_, i) => e.start("year", from + i));
};

describe("a residue rule (Hebrew stage 1, lo ADU rosh)", () => {
  test("5787's molad day falls on residue 5, which the rule does not name: toggling it on moves the year a day later, toggling it off is clean", () => {
    const { base, draft } = opened(HEBREW_LOOSE);
    expect(startAndLength(draft.ast!)).toEqual([20708, 385]);
    const f = stageFacts(draft.ast!, "year", 0, Y5787)!;
    expect(f).toEqual({ below: 20708, shift: 0, fired: -1, lengths: [null] });
    const r0 = rule(draft.ast!, 0, 0);
    expect("residue" in r0 && residueOf(r0, f.below)).toBe(5);
    const on = done(toggleResidue(draft, base, "year", 0, 0, 5));
    expect(editedSlices(base.ast!, on.calendar.ast!)).toEqual(["stages:year"]);
    const r1 = rule(on.ast, 0, 0);
    expect("residue" in r1 && r1.residue.in).toEqual([2, 4, 5, 6]);
    expect(stageFacts(on.ast, "year", 0, Y5787)).toMatchObject({ shift: 1, fired: 0 });
    expect(startAndLength(on.ast)).toEqual([20709, 384]);
    const off = done(toggleResidue(on.calendar, base, "year", 0, 0, 5));
    expect(sameCalendar(off.calendar, base)).toBe(true);
    expect(startAndLength(off.ast)).toEqual([20708, 385]);
  });
  test("without a weekday cycle the cells are 0 to 6 and the rule reads by number", () => {
    const r = rule(HEBREW, 0, 0) as Extract<StageRule, { residue: unknown }>;
    expect(residueCells(HEBREW, r).map((c) => [c.residue, c.label, c.on])).toEqual([0, 1, 2, 3, 4, 5, 6].map((k) => [k, null, [2, 4, 6].includes(k)]));
    expect(ruleSentence(HEBREW, r)).toBe("starts on 2 · 4 · 6 of 7 → +1");
  });
  test("with a seven-label day cycle the cells are in weekday order, titled by weekday: Rishon · Revi'i · Shishi", () => {
    const r = rule(HEBREW_WEEK, 0, 0) as Extract<StageRule, { residue: unknown }>;
    const cells = residueCells(HEBREW_WEEK, r);
    expect(cells.map((c) => c.label)).toEqual([...HEBREW_DAYS]);
    expect(cells.filter((c) => c.on).map((c) => c.label)).toEqual(["Rishon", "Revi'i", "Shishi"]);
    expect(ruleSentence(HEBREW_WEEK, r)).toBe("starts on Rishon · Revi'i · Shishi → +1");
    // 1 Tishri 5787 (12 September 2026) is a Shabbat: its cell is the one residue 5 sits in
    expect(cells.find((c) => c.residue === 5)!.label).toBe("Shabbat");
    expect(problems(HEBREW_WEEK)).toEqual([]);
  });
  test("mod keeps the days below it, from the rule as the editor was built; a mod naming no day is refused; back to 7 is clean", () => {
    const { base, draft } = opened(HEBREW);
    const days = [2, 4, 6];
    const five = done(setResidueRule(draft, base, "year", 0, 0, { mod: 5 }, days));
    expect(rule(five.ast, 0, 0)).toEqual({ add: 1, residue: { mod: 5, offset: -2092590, in: [2, 4] } });
    expect(refused(setResidueRule(five.calendar, base, "year", 0, 0, { mod: 2 }, days))).toContain("name no day");
    const back = done(setResidueRule(five.calendar, base, "year", 0, 0, { mod: 7 }, days));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("the last day of a test is kept, a cell outside the mod is refused, and a residue edit on a length rule says so", () => {
    const { base, draft } = opened(HEBREW);
    const one = done(setResidueRule(draft, base, "year", 0, 0, { mod: 3 }, [2, 4, 6]));
    expect(refused(toggleResidue(one.calendar, base, "year", 0, 0, 2))).toContain("remove the rule instead");
    expect(refused(toggleResidue(draft, base, "year", 0, 0, 7))).toContain("outside 0 to 6");
    expect(refused(toggleResidue(draft, base, "year", 1, 0, 0))).toContain("tests a length");
  });
  test("add 0 stops the stage moving anything; add back to 1 is clean", () => {
    const { base, draft } = opened(HEBREW);
    const zero = done(setResidueRule(draft, base, "year", 0, 0, { add: 0 }));
    expect(stageFacts(zero.ast, "year", 0, 5780)!.shift).toBe(0);
    expect(sameCalendar(done(setResidueRule(zero.calendar, base, "year", 0, 0, { add: 1 })).calendar, base)).toBe(true);
  });
});

describe("a length rule's readouts", () => {
  test("the sentences, and this year's lengths in the stage below: 385 this year, 354 last year", () => {
    expect(ruleSentence(HEBREW, rule(HEBREW, 1, 0))).toBe("this year runs 356 d → +2");
    expect(ruleSentence(HEBREW, rule(HEBREW, 1, 1))).toBe("last year runs 382 d → +1");
    expect(stageFacts(HEBREW, "year", 1, Y5787)).toEqual({ below: 20708, shift: 0, fired: -1, lengths: [385, 354] });
  });
  test("on the real preset the same toggle lands, and problems() says the months no longer fill the years", () => {
    const { base, draft } = opened(HEBREW);
    const on = done(toggleResidue(draft, base, "year", 0, 0, 5));
    expect(problems(on.ast).some((p) => p.unit === "month")).toBe(true);
    const off = done(toggleResidue(on.calendar, base, "year", 0, 0, 5));
    expect(startAndLength(off.ast)).toEqual([20708, 385]);
  });
});

describe("a length rule (Hebrew stage 2)", () => {
  test("runs, add and the window each write the rule; back is clean and the sanity figure holds", () => {
    const { base, draft } = opened(HEBREW_LOOSE);
    const a = done(setLengthRule(draft, base, "year", 1, 0, { is: 385 }));
    expect(rule(a.ast, 1, 0)).toEqual({ add: 2, length: { at: 0, is: 385 } });
    expect(stageFacts(a.ast, "year", 1, Y5787)).toMatchObject({ fired: 0, shift: 2 });
    const b = done(setLengthRule(a.calendar, base, "year", 1, 0, { at: 1, add: 3 }));
    expect(rule(b.ast, 1, 0)).toEqual({ add: 3, length: { at: 1, is: 385 } });
    expect(ruleSentence(b.ast, rule(b.ast, 1, 0))).toBe("next year runs 385 d → +3");
    const back = done(setLengthRule(b.calendar, base, "year", 1, 0, { at: 0, is: 356, add: 2 }));
    expect(sameCalendar(back.calendar, base)).toBe(true);
    expect(startAndLength(back.ast)).toEqual([20708, 385]);
  });
  test("a window past V2 is refused with the validator's reason, and problems() reports one stored", () => {
    const { base, draft } = opened(HEBREW);
    expect(refused(setLengthRule(draft, base, "year", 1, 0, { at: 9 }))).toContain("window offset 9 is not a whole number within ±8");
    const stored: CalendarAst = { ...HEBREW, units: HEBREW.units.map((u) => (u.id === "year" && u.kind === "cycle" ? ({ ...u, stages: [u.stages![0]!, { rules: [{ add: 2, length: { at: 9, is: 356 } }] }] }) : u)) };
    expect(problems(stored).some((p) => p.code === "V2" && p.unit === "year")).toBe(true);
  });
  test("a shift that could leave a year no day is refused (V3, the validator's own words)", () => {
    const { base, draft } = opened(HEBREW);
    expect(refused(setLengthRule(draft, base, "year", 1, 0, { add: -1000 }))).toContain("every occurrence needs at least one day");
  });
});

describe("rules and stages: add, order, remove", () => {
  test("＋ length rule and ＋ residue rule go last and move nothing (every start 5700-5800 as before); remove is clean", () => {
    const { base, draft } = opened(HEBREW);
    const was = starts(HEBREW, 5700, 5800);
    const a = done(addRule(draft, base, "year", 1, "length", 385));
    expect(rule(a.ast, 1, 2)).toEqual({ add: 0, length: { at: 0, is: 385 } });
    const b = done(addRule(a.calendar, base, "year", 0, "residue"));
    expect(rule(b.ast, 0, 1)).toEqual({ add: 0, residue: { mod: 7, in: [0] } });
    expect(starts(b.ast, 5700, 5800)).toEqual(was);
    const c = done(removeRule(b.calendar, base, "year", 0, 1));
    const d = done(removeRule(c.calendar, base, "year", 1, 2));
    expect(sameCalendar(d.calendar, base)).toBe(true);
  });
  test("a new weekday rule on HEBREW_WEEK starts on its first label (offset at the cycle's anchor)", () => {
    const { base, draft } = opened(HEBREW_WEEK);
    const r = done(addRule(draft, base, "year", 0, "residue"));
    const x = rule(r.ast, 0, 1) as Extract<StageRule, { residue: unknown }>;
    expect(x.residue.offset).toBe(3);
    expect(ruleSentence(r.ast, x)).toBe("starts on Rishon → +0");
  });
  test("order is meaning: swapping stage 2's rules changes which fires; swapping back is clean; past the ends is refused", () => {
    const { base, draft } = opened(HEBREW);
    const s = done(moveRule(draft, base, "year", 1, 0, 1));
    expect(rule(s.ast, 1, 0)).toEqual(rule(HEBREW, 1, 1));
    expect(refused(moveRule(draft, base, "year", 1, 0, -1))).toContain("already read first");
    expect(refused(moveRule(draft, base, "year", 1, 1, 1))).toContain("already read last");
    expect(sameCalendar(done(moveRule(s.calendar, base, "year", 1, 1, -1)).calendar, base)).toBe(true);
  });
  test("a stage keeps one rule; ＋ stage reads the last and moves nothing; Remove stage", () => {
    const { base, draft } = opened(HEBREW);
    expect(refused(removeRule(draft, base, "year", 0, 0))).toContain("remove the stage instead");
    const was = starts(HEBREW, 5700, 5800);
    const a = addStage(draft, base, "year");
    expect("refused" in a ? null : a.index).toBe(2);
    const added = done(a);
    expect(year(added.ast).stages!.length).toBe(3);
    expect(starts(added.ast, 5700, 5800)).toEqual(was);
    const back = done(removeStage(added.calendar, base, "year", 2));
    expect(sameCalendar(back.calendar, base)).toBe(true);
    expect(startAndLength(back.ast)).toEqual([20708, 385]);
    const gone = done(removeStage(draft, base, "year", 0));
    expect(year(gone.ast).stages).toEqual([HEBREW.units.flatMap((u) => (u.kind === "cycle" ? (u.stages ?? []) : []))[1]!]);
  });
  test("LUNAR: a crossing year with no stages takes a first one; a fixed-day year (Gregorian) takes none", () => {
    expect(stagesApply(LUNAR, "year")).toBe(true);
    const l = opened(LUNAR);
    const r = done(addStage(l.draft, l.base, "year"));
    expect(year(r.ast).stages).toEqual([{ rules: [{ add: 0, residue: { mod: 7, in: [0] } }] }]);
    expect(problems(r.ast)).toEqual([]);
    expect(sameCalendar(done(removeStage(r.calendar, l.base, "year", 0)).calendar, l.base)).toBe(true);
    expect(stagesApply(GREGORIAN, "year")).toBe(false);
    const g = opened(GREGORIAN);
    expect(refused(addStage(g.draft, g.base, "year"))).toContain("starts on fixed days");
  });
  test("setStages refuses a stage without rules (the AST half)", () => {
    const r = setStages(HEBREW, "year", [{ rules: [] }]);
    expect("refused" in r && r.reason).toContain("at least one rule");
  });
});

describe("stale guard: stages:<unit>", () => {
  test("a stage edit against stages changed in storage is stale; a change elsewhere survives the Save", () => {
    const { text, base, draft } = opened(HEBREW);
    const r = done(setResidueRule(draft, base, "year", 0, 0, { add: 0 }));
    const moved = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "year" && u.kind === "cycle" ? ({ ...u, stages: [u.stages![1]!, u.stages![0]!] }) : u)) }));
    expect(mergeCalendar(moved, base, r.calendar).kind).toBe("stale");
    const out = written(mergeCalendar(outside(text, (a) => ({ ...a, name: "Hebrew (edited)" })), base, r.calendar));
    expect(out.name).toBe("Hebrew (edited)");
    expect(rule(out, 0, 0)).toEqual({ add: 0, residue: { mod: 7, offset: -2092590, in: [2, 4, 6] } });
  });
  test("a weekday cell edited by day name is stale when the weekday cycle moved in storage (the reason says so)", () => {
    const { text, base, draft } = opened(HEBREW_LOOSE);
    const r = done(toggleResidue(draft, base, "year", 0, 0, 5));
    const shifted = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "weekday" && u.kind === "cycle" ? ({ ...u, anchor: 4 } as CycleUnitAst) : u)) }));
    expect(staleWhy(mergeCalendar(shifted, base, r.calendar))).toContain("reads the weekday days");
    const out = written(mergeCalendar(outside(text, (a) => ({ ...a, name: "Hebrew (edited)" })), base, r.calendar));
    expect(out.name).toBe("Hebrew (edited)");
    const x = rule(out, 0, 0) as Extract<StageRule, { residue: unknown }>;
    expect(x.residue.in).toEqual([2, 4, 5, 6]);
  });
});
