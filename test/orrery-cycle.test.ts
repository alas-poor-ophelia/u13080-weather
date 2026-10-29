/**
 * Orrery slice 5e (docs/SESHAT-v0.md §18.3, §18.6 items 1 and 2; bead
 * wadjet-b6x): the labelled cycle inspector's pure edits
 * (src/studio/model/orrery-cycle.ts over unit-edit.ts), on Gregorian (the
 * form's week: day names through `compile`), Balinese and Maya (labelled
 * cycles the form does not read: the AST's `cycle:` slice), HEBREW_WEEK (a
 * weekday a stage's test is titled by) and Harptos (no labelled cycle):
 *
 *   - a label rename, ＋ label and × (the week follows the count), and back is clean;
 *   - `today is` moves the weekday and its week together, and back is clean;
 *   - a rename of the id follows into the formats' tokens and the rules;
 *   - Remove cycle refuses while anything reads it, and takes the form's week whole;
 *   - refusals: a label a rule reads by name, a count change under a label filter,
 *     an anchor a rule reads by number, an id in use;
 *   - the stale guard: renames and removals replay as operations, `cycle:` slices
 *     as slices with what they read rechecked (`cycleReplayProblem`).
 */
import { describe, expect, test } from "bun:test";
import { editedSlices } from "../src/studio/model/ast-edit";
import { calendarOfDefinition, mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { addLabel, cycleEditable, inFormWeek, labelOn, removeCycle, removeLabel, renameCycle, renameLabel, setTodayIs } from "../src/studio/model/orrery-cycle";
import { residueCells } from "../src/studio/model/orrery-stages";
import { anchorFor, anchorProblem, anchorWarnings, cyclePartner, formatUnits, renameUnit, UNIT_OPS_REFUSED, unitOps, unitReaders } from "../src/studio/model/unit-edit";
import { initialState, type StudioSettingsLike } from "../src/studio/model/state";
import { applyStash, takeStash } from "../src/studio/model/stash";
import { createStore } from "../src/studio/model/store";
import { BALINESE, Engine, formatDay, GREGORIAN, HARPTOS, HEBREW, MAYA, parse, print, problems, type CalendarAst, type CycleUnitAst, type RuleDefAst, type SlotsUnitAst, type StageRule } from "../src/seshat";
import { HEBREW_WEEK, PASARAN } from "./fixtures/orrery";

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
const cycle = (ast: CalendarAst, id: string) => ast.units.find((u) => u.id === id) as CycleUnitAst & { anchor: number };
const names = (ast: CalendarAst, id: string) => (cycle(ast, id).labels ?? []).map((l) => l.name);
const withRule = (ast: CalendarAst, r: RuleDefAst): CalendarAst => ({ ...ast, rules: [...(ast.rules ?? []), r] });
const mondays: RuleDefAst = { id: "market", name: "Market", tags: ["market"], rule: { kind: "recur", freq: "day", by: [{ unit: "weekday", label: ["Monday"] }] } };
const thirdDay: RuleDefAst = { id: "third", tags: ["third"], rule: { kind: "index", unit: "weekday", from: 3, to: 3 } };
/** 2024-10-04, a Friday. */
const D = 20000;
const long = (ast: CalendarAst, day: number): string => formatDay(new Engine(ast), day, "long");

describe("the form's week (Gregorian)", () => {
  test("the weekday and the week are the form's: editable here, not the year", () => {
    const { draft } = opened(GREGORIAN);
    expect(cycleEditable(draft.ast!, "weekday", "year")).toBe(true);
    expect(cycleEditable(draft.ast!, "week", "year")).toBe(true);
    expect(cycleEditable(draft.ast!, "year", "year")).toBe(false);
    expect(inFormWeek(draft, draft.ast!, "weekday")).toBe(true);
    expect(inFormWeek(draft, draft.ast!, "week")).toBe(true);
    expect(cyclePartner(draft.ast!, "weekday")?.id).toBe("week");
    expect(labelOn(cycle(draft.ast!, "weekday"), D)).toBe(5);
    expect(long(draft.ast!, D)).toBe("Friday 4 October 2024");
  });

  test("a label rename goes through the form's week; the long format prints it; renamed back is clean", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(renameLabel(draft, base, "weekday", 5, "Freya's day"));
    expect(r.calendar.form?.week?.[5]).toBe("Freya's day");
    expect(r.calendar.ast).toBe(draft.ast); // the layer is untouched: the form part is pending
    expect(long(r.ast, D)).toBe("Freya's day 4 October 2024");
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(names(saved, "weekday")[5]).toBe("Freya's day");
    expect(sameCalendar(done(renameLabel(r.calendar, base, "weekday", 5, "Friday")).calendar, base)).toBe(true);
    expect(refused(renameLabel(draft, base, "weekday", 5, "  "))).toContain("blank");
  });

  test("＋ label makes an eight-day week (the week unit follows); × takes it back to clean", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = addLabel(draft, base, "weekday");
    const a = done(r);
    expect(r.index).toBe(7);
    expect(names(a.ast, "weekday")).toHaveLength(8);
    expect(names(a.ast, "weekday")[7]).toBe("Label");
    expect(cycle(a.ast, "week").length).toBe(8);
    expect(problems(a.ast)).toEqual([]);
    const saved = written(mergeCalendar(text, base, a.calendar));
    expect(cycle(saved, "week").length).toBe(8);
    expect(calendarOfDefinition(saved).form!.week).toHaveLength(8);
    const back = done(removeLabel(a.calendar, base, "weekday", 7));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });

  test("× on a day name makes a six-day week; the last label stays", () => {
    const { base, draft } = opened(GREGORIAN);
    const a = done(removeLabel(draft, base, "weekday", 0));
    expect(names(a.ast, "weekday")[0]).toBe("Monday");
    expect(cycle(a.ast, "week").length).toBe(6);
    let c = a.calendar;
    for (let i = 0; i < 5; i++) c = done(removeLabel(c, base, "weekday", 0)).calendar;
    expect(refused(removeLabel(c, base, "weekday", 0))).toContain("at least one label");
  });

  test("today is: the weekday and the week move together, Sunday falls on the Orrery's day, and back is clean", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const origin = cycle(draft.ast!, "weekday").anchor;
    const r = done(setTodayIs(draft, base, "weekday", 0, D, origin));
    expect(labelOn(cycle(r.ast, "weekday"), D)).toBe(0);
    expect(long(r.ast, D)).toBe("Sunday 4 October 2024");
    const shift = cycle(r.ast, "weekday").anchor - origin;
    expect(Math.abs(shift)).toBeLessThanOrEqual(3);
    expect(cycle(r.ast, "week").anchor - cycle(draft.ast!, "week").anchor).toBe(shift);
    expect(editedSlices(base.ast!, r.calendar.ast!).sort()).toEqual(["cycle:week", "cycle:weekday"]);
    // the form still reads the week as fields
    expect(calendarOfDefinition(r.ast).form!.week).toHaveLength(7);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(long(saved, D)).toBe("Sunday 4 October 2024");
    // a drag back to Friday from the same origin puts the anchors back exactly
    expect(sameCalendar(done(setTodayIs(r.calendar, base, "weekday", 5, D, origin)).calendar, base)).toBe(true);
  });

  test("a label rename pending in the form and today is together: one draft, saved together", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const a = done(renameLabel(draft, base, "weekday", 0, "Sol"));
    const b = done(setTodayIs(a.calendar, base, "weekday", 0, D, cycle(a.ast, "weekday").anchor));
    expect(long(b.ast, D)).toBe("Sol 4 October 2024");
    expect(long(written(mergeCalendar(text, base, b.calendar)), D)).toBe("Sol 4 October 2024");
  });

  test("rename the id: the long format's token follows; an id in use is refused", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(renameCycle(draft, base, "weekday", "day-name"));
    expect(r.ast.formats?.find((f) => f.name === "long")?.pattern).toBe("{day-name:name} {month:day} {month:name} {year}");
    expect(long(r.ast, D)).toBe("Friday 4 October 2024");
    expect(unitOps(base.ast!, r.calendar.ast!)).toEqual([{ kind: "rename", from: "weekday", to: "day-name" }]);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(saved.units.map((u) => u.id)).toEqual(["year", "month", "week", "day-name"]);
    expect(print(saved)).toContain("FORMAT:long={day-name\\:name}");
    // the form still reads its week
    expect(calendarOfDefinition(saved).form!.week).toHaveLength(7);
    expect(refused(renameCycle(draft, base, "weekday", "month"))).toContain("already taken by a unit");
    expect(refused(renameCycle(draft, base, "weekday", "leap"))).toContain("already taken by a gear");
    expect(refused(renameCycle(draft, base, "weekday", "Day Name"))).toContain("lower-case");
    // and back is clean
    expect(sameCalendar(done(renameCycle(r.calendar, base, "day-name", "weekday")).calendar, base)).toBe(true);
  });

  test("Remove cycle: refused while the long format prints the day names; without it the week goes whole, through the form", () => {
    const { base, draft } = opened(GREGORIAN);
    expect(unitReaders(draft.ast!, "weekday")).toEqual(['the format "long" prints it']);
    expect(refused(removeCycle(draft, base, "weekday"))).toContain('the format "long" prints it');
    expect(refused(removeCycle(draft, base, "week"))).toContain('the format "long" prints it');
    const short: CalendarAst = { ...GREGORIAN, formats: GREGORIAN.formats!.filter((f) => f.name === "default") };
    const o = opened(short);
    const r = done(removeCycle(o.draft, o.base, "weekday"));
    expect(r.calendar.form?.week).toBeNull();
    expect(r.ast.units.map((u) => u.id)).toEqual(["year", "month"]);
    expect(written(mergeCalendar(o.text, o.base, r.calendar)).units.map((u) => u.id)).toEqual(["year", "month"]);
  });

  test("a rule reading a day by name refuses its rename and any count change; today is follows the label", () => {
    const { base, draft } = opened(withRule(GREGORIAN, mondays));
    expect(refused(renameLabel(draft, base, "weekday", 1, "Moon day"))).toContain('the rule "Market" reads the weekday labelled "Monday"');
    expect(refused(renameLabel(draft, base, "weekday", 2, "Monday"))).toContain('labelled "Monday"');
    expect(refused(addLabel(draft, base, "weekday"))).toContain("new count");
    expect(refused(removeLabel(draft, base, "weekday", 6))).toContain("new count");
    done(renameLabel(draft, base, "weekday", 2, "Tiw"));
    done(setTodayIs(draft, base, "weekday", 0, D, cycle(draft.ast!, "weekday").anchor));
  });

  test("a rule reading the weekday by number refuses today is (it would match other days)", () => {
    const { base, draft } = opened(withRule(GREGORIAN, thirdDay));
    expect(refused(setTodayIs(draft, base, "weekday", 0, D, cycle(draft.ast!, "weekday").anchor))).toContain("by number");
  });

  test("a rename reaches the rules that read the unit", () => {
    const ast = withRule(GREGORIAN, mondays);
    const r = renameUnit(ast, "weekday", "dow");
    if ("refused" in r) throw new Error(r.reason);
    expect(r.ast.rules![0]!.rule).toEqual({ kind: "recur", freq: "day", by: [{ unit: "dow", label: ["Monday"] }] });
    const weekly = withRule(GREGORIAN, { id: "weekly", tags: ["w"], rule: { kind: "recur", freq: "week", by: [{ unit: "weekday", nth: [1] }] } });
    const w = renameUnit(weekly, "week", "sennight");
    if ("refused" in w) throw new Error(w.reason);
    expect(w.ast.rules![0]!.rule).toMatchObject({ freq: "sennight", by: [{ unit: "weekday", nth: [1] }] });
    expect(problems(w.ast)).toEqual([]);
  });
});

describe("labelled cycles the form does not read (Balinese, Maya, PASARAN)", () => {
  test("a Balinese label rename is the cycle's own slice", () => {
    const { base, draft } = opened(BALINESE);
    expect(inFormWeek(draft, draft.ast!, "triwara")).toBe(false);
    const r = done(renameLabel(draft, base, "triwara", 0, "Pasah!"));
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["cycle:triwara"]);
    expect(names(r.ast, "triwara")[0]).toBe("Pasah!");
    expect(problems(r.ast)).toEqual([]);
  });

  test("PASARAN (Gregorian with a five-day market week): the form reads no week, so the weekday's labels are its slice too; the week still follows a count change, and a Save writes it", () => {
    const { text, base, draft } = opened(PASARAN);
    expect(draft.form?.week).toBeUndefined();
    expect(inFormWeek(draft, draft.ast!, "weekday")).toBe(false);
    const r = done(addLabel(draft, base, "weekday"));
    expect(editedSlices(base.ast!, r.calendar.ast!).sort()).toEqual(["cycle:weekday", "length:week"]);
    expect(cycle(r.ast, "week").length).toBe(8);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(names(saved, "weekday")).toHaveLength(8);
    expect(cycle(saved, "week").length).toBe(8);
    const p = done(renameLabel(draft, base, "pasaran", 0, "Legi!"));
    expect(names(written(mergeCalendar(text, base, p.calendar)), "pasaran")[0]).toBe("Legi!");
  });

  test("＋ label on the triwara: a four-day cycle with no week to follow", () => {
    const { base, draft } = opened(BALINESE);
    expect(cyclePartner(draft.ast!, "triwara")).toBeUndefined();
    const r = done(addLabel(draft, base, "triwara"));
    expect(names(r.ast, "triwara")).toHaveLength(4);
    expect(problems(r.ast)).toEqual([]);
  });

  test("Remove cycle: the triwara (no format prints it) goes as an AST edit; the saptawara is refused; on PASARAN the market week is removed and saved", () => {
    const { base, draft } = opened(BALINESE);
    const r = done(removeCycle(draft, base, "triwara"));
    expect(unitOps(base.ast!, r.calendar.ast!)).toEqual([{ kind: "remove", id: "triwara" }]);
    expect(problems(r.ast)).toEqual([]);
    expect(refused(removeCycle(draft, base, "saptawara"))).toContain('the format "default" prints it');
    const o = opened(PASARAN);
    const p = done(removeCycle(o.draft, o.base, "pasaran"));
    expect(written(mergeCalendar(o.text, o.base, p.calendar)).units.map((u) => u.id)).toEqual(["year", "month", "week", "weekday"]);
  });

  test("Maya: today is on the tzolkin name moves it alone; renaming the tzolkin-number follows the round format", () => {
    const { base, draft } = opened(MAYA);
    const origin = cycle(draft.ast!, "tzolkin-name").anchor;
    const r = done(setTodayIs(draft, base, "tzolkin-name", 0, 0, origin));
    expect(labelOn(cycle(r.ast, "tzolkin-name"), 0)).toBe(0);
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["cycle:tzolkin-name"]);
    const n = done(renameCycle(r.calendar, base, "tzolkin-number", "trecena"));
    expect(n.ast.formats!.find((f) => f.name === "round")!.pattern).toContain("{trecena:name}");
    expect(problems(n.ast)).toEqual([]);
    expect(labelOn(cycle(n.ast, "tzolkin-name"), 0)).toBe(0);
  });
});

describe("a weekday a stage reads (HEBREW_WEEK) and a calendar without one (Hebrew, Harptos)", () => {
  test("the weekday is not the form's (no week runs with it); removing it is refused while a stage names its days", () => {
    const { base, draft } = opened(HEBREW_WEEK);
    expect(inFormWeek(draft, draft.ast!, "weekday")).toBe(false);
    expect(unitReaders(draft.ast!, "weekday")).toContain("the year's stages name its days");
    expect(refused(removeCycle(draft, base, "weekday"))).toContain("stages name its days");
  });

  test("today is on the weekday retitles the stage's cells and moves no year", () => {
    const { base, draft } = opened(HEBREW_WEEK);
    const start = new Engine(draft.ast!).start("year", 5786);
    const rule = (a: CalendarAst) => (a.units.find((u) => u.id === "year") as CycleUnitAst).stages![0]!.rules[0]! as Extract<StageRule, { residue: unknown }>;
    const before = residueCells(draft.ast!, rule(draft.ast!)).filter((c) => c.on).map((c) => c.label);
    expect(before).toEqual(["Rishon", "Revi'i", "Shishi"]);
    const r = done(setTodayIs(draft, base, "weekday", 1, start, cycle(draft.ast!, "weekday").anchor));
    expect(new Engine(r.ast).start("year", 5786)).toBe(start);
    expect(residueCells(r.ast, rule(r.ast)).filter((c) => c.on).map((c) => c.label)).not.toEqual(before);
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["cycle:weekday"]);
  });

  test("Hebrew and Harptos have no labelled cycle: no unit but the year is a cycle this edits", () => {
    for (const ast of [HEBREW, HARPTOS]) {
      const cycles = ast.units.filter((u) => u.kind === "cycle" && cycleEditable(ast, u.id, "year"));
      expect(cycles.filter((u) => u.kind === "cycle" && u.labels?.length)).toEqual([]);
    }
  });
});

describe("pieces", () => {
  test("anchorFor: the nearest anchor that puts a label on a day, at most half the labels away", () => {
    expect(anchorFor(3, 1, 7, 3, 0)).toBe(3);
    expect(anchorFor(3, 1, 7, 3, 1)).toBe(2);
    expect(anchorFor(3, 1, 7, 3, 6)).toBe(4);
    expect(anchorFor(3, 1, 7, D, 5)).toBe(3);
    expect(anchorFor(0, 5, 4, 12, 0)).toBe(-10); // 5-day occurrences: day 12 is in occurrence 2; label 0 is two occurrences on
  });
  test("formatUnits reads tokens, not escapes or placeholders", () => {
    expect(formatUnits("{weekday:name} {{x}} {@season} {month:day:pad2}")).toEqual(["weekday", "month"]);
  });
});

describe("the stale guard (§18.6 item 1)", () => {
  test("a rename replays onto the stored calendar: a rule added outside that reads the unit follows it", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(renameCycle(draft, base, "weekday", "dow"));
    const now = outside(text, (a) => withRule(a, mondays));
    const saved = written(mergeCalendar(now, base, r.calendar));
    expect(saved.rules!.find((x) => x.id === "market")!.rule).toEqual({ kind: "recur", freq: "day", by: [{ unit: "dow", label: ["Monday"] }] });
  });

  test("a rename is stale when the unit changed outside, or its new id was taken there", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(renameCycle(draft, base, "weekday", "dow"));
    const relabelled = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "weekday" && u.kind === "cycle" ? { ...u, labels: u.labels!.map((l, i) => (i === 0 ? { name: "Sun" } : l)) } : u)) }));
    expect(staleWhy(mergeCalendar(relabelled, base, r.calendar))).toContain("the weekday changed outside the studio");
    const taken = outside(text, (a) => ({ ...a, units: [...a.units, { id: "dow", kind: "cycle", anchor: 0, length: 10 }] }));
    expect(staleWhy(mergeCalendar(taken, base, r.calendar))).toContain('the id "dow" is already taken');
  });

  test("a removal is stale when a reader was added outside", () => {
    const { text, base, draft } = opened(PASARAN);
    const r = done(removeCycle(draft, base, "pasaran"));
    const printed = outside(text, (a) => ({ ...a, formats: [...a.formats!, { name: "market", pattern: "{pasaran:name}" }] }));
    expect(staleWhy(mergeCalendar(printed, base, r.calendar))).toContain('the format "market" prints it');
  });

  test("today is (cycle: slices) is stale when a rule reading the weekday was added outside; an unrelated edit still saves", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(setTodayIs(draft, base, "weekday", 0, D, cycle(draft.ast!, "weekday").anchor));
    expect(staleWhy(mergeCalendar(outside(text, (a) => withRule(a, mondays)), base, r.calendar))).toContain("a stage that reads the weekday changed outside");
    const renamedMonth = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "month" && u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 0 ? { ...s, name: "Janvier" } : s)) } : u)) }));
    const saved = written(mergeCalendar(renamedMonth, base, r.calendar));
    expect(long(saved, D)).toBe("Sunday 4 October 2024");
    expect((saved.units.find((u) => u.id === "month") as SlotsUnitAst).slots[0]!.name).toBe("Janvier");
  });

  test("a label edit is stale when the same cycle moved outside; another cycle's edit outside still saves", () => {
    const { text, base, draft } = opened(PASARAN);
    const r = done(renameLabel(draft, base, "pasaran", 0, "Legi!"));
    const shift = (id: string) => outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === id && u.kind === "cycle" && !u.crossing ? { ...u, anchor: u.anchor + 1 } : u)) }));
    expect(mergeCalendar(shift("pasaran"), base, r.calendar).kind).toBe("stale");
    expect(names(written(mergeCalendar(shift("weekday"), base, r.calendar)), "pasaran")[0]).toBe("Legi!");
  });
});

describe("renames and removals together (Parallax on 5e/5f): a Save writes exactly the draft, or refuses", () => {
  // Gregorian with two Balinese day cycles no part reads; the triwara carries a display NUMBER (outside every slice),
  // so a graft of its shell onto another unit shows
  const balinese = (id: string): CycleUnitAst => ({ ...cycle(BALINESE, id), anchor: 0 });
  const PLAIN: CalendarAst = { ...GREGORIAN, units: [...GREGORIAN.units, balinese("triwara"), balinese("sadwara")] };
  const NUMBERED: CalendarAst = { ...PLAIN, units: PLAIN.units.map((u) => (u.id === "triwara" ? { ...u, number: 5 } : u)) };
  const ids = (ast: CalendarAst) => ast.units.map((u) => u.id);
  const sadwara = names(BALINESE, "sadwara");

  test("remove the triwara, rename the sadwara to sixer: the sixer is the sadwara, the triwara's number goes with it", () => {
    const { text, base, draft } = opened(NUMBERED);
    const r = done(renameCycle(done(removeCycle(draft, base, "triwara")).calendar, base, "sadwara", "sixer"));
    expect(unitOps(base.ast!, r.calendar.ast!)).toEqual([
      { kind: "remove", id: "triwara" },
      { kind: "rename", from: "sadwara", to: "sixer" },
    ]);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(ids(saved)).toEqual(ids(r.calendar.ast!));
    expect(names(saved, "sixer")).toEqual(sadwara);
    expect(cycle(saved, "sixer").number).toBeUndefined();
    expect(sameCalendar(seshatDraft(saved), seshatDraft(r.calendar.ast!))).toBe(true);
  });

  test("remove the triwara, rename the sadwara to triwara: the new triwara is the sadwara", () => {
    const { text, base, draft } = opened(NUMBERED);
    const r = done(renameCycle(done(removeCycle(draft, base, "triwara")).calendar, base, "sadwara", "triwara"));
    expect(unitOps(base.ast!, r.calendar.ast!)).toEqual([
      { kind: "remove", id: "triwara" },
      { kind: "rename", from: "sadwara", to: "triwara" },
    ]);
    const saved = written(mergeCalendar(text, base, r.calendar));
    expect(ids(saved)).toEqual(ids(r.calendar.ast!));
    expect(names(saved, "triwara")).toEqual(sadwara);
    expect(cycle(saved, "triwara").number).toBeUndefined();
  });

  test("a swap through a temporary id is refused with a way out, never grafted", () => {
    const { text, base, draft } = opened(NUMBERED);
    let c = done(renameCycle(draft, base, "triwara", "tmp")).calendar;
    c = done(renameCycle(c, base, "sadwara", "triwara")).calendar;
    c = done(renameCycle(c, base, "tmp", "sadwara")).calendar;
    expect(unitOps(base.ast!, c.ast!)).toBeNull();
    expect(mergeCalendar(text, base, c)).toEqual({ kind: "error", message: UNIT_OPS_REFUSED });
    expect(UNIT_OPS_REFUSED).toContain("save after each rename");
  });

  test("rename and back is no operation and nothing to save", () => {
    const { text, base, draft } = opened(NUMBERED);
    const c = done(renameCycle(done(renameCycle(draft, base, "triwara", "sadwara-2")).calendar, base, "sadwara-2", "triwara")).calendar;
    expect(unitOps(base.ast!, c.ast!)).toEqual([]);
    expect(mergeCalendar(text, base, c).kind).toBe("unchanged");
  });

  test("remove, then a unit of the same id: saved when only its slices differ, refused when it differs outside them", () => {
    const back = (ast: CalendarAst, unit: CycleUnitAst): CalendarAst => ({ ...ast, units: ast.units.flatMap((u) => (u.id === "sadwara" ? [unit, u] : [u])) });
    const fresh = { id: "triwara", kind: "cycle", anchor: 0, length: 1, labels: [{ name: "A" }, { name: "B" }] } as CycleUnitAst;
    const plain = opened(PLAIN);
    const gone = done(removeCycle(plain.draft, plain.base, "triwara")).calendar;
    const again: CalendarDraft = { ...gone, ast: back(gone.ast!, fresh) };
    expect(unitOps(plain.base.ast!, again.ast!)).toEqual([]);
    expect(names(written(mergeCalendar(plain.text, plain.base, again)), "triwara")).toEqual(["A", "B"]);
    const numbered = opened(NUMBERED);
    const gone2 = done(removeCycle(numbered.draft, numbered.base, "triwara")).calendar;
    const again2: CalendarDraft = { ...gone2, ast: back(gone2.ast!, fresh) };
    expect(unitOps(numbered.base.ast!, again2.ast!)).toBeNull();
    expect(mergeCalendar(numbered.text, numbered.base, again2)).toEqual({ kind: "error", message: UNIT_OPS_REFUSED });
  });
});

describe("what the label count and the anchor read (Parallax on 5e/5f)", () => {
  const STAGED = (ast: CalendarAst): CalendarAst => ({ ...ast, units: ast.units.map((u) => (u.id === "year" && u.kind === "cycle" ? { ...u, stages: [{ rules: [{ add: 0, residue: { mod: 7, in: [0] } }] }] } : u)) });

  test("a count change is refused while a stage tests the weekday's days, on the AST path and the form's week", () => {
    const h = opened(HEBREW_WEEK);
    expect(refused(addLabel(h.draft, h.base, "weekday"))).toContain("stage 1 of the year tests the weekday's 7 days");
    expect(refused(removeLabel(h.draft, h.base, "weekday", 6))).toContain("stage 1 of the year");
    done(renameLabel(h.draft, h.base, "weekday", 0, "Yom Rishon")); // the count kept: allowed
    const g = opened(STAGED(GREGORIAN));
    expect(inFormWeek(g.draft, g.draft.ast!, "weekday")).toBe(true);
    expect(refused(addLabel(g.draft, g.base, "weekday"))).toContain("stage 1 of the year");
    expect(refused(removeLabel(g.draft, g.base, "weekday", 0))).toContain("stage 1 of the year");
  });

  test("today is: refused while the seasons divide the unit or a slot unit sits in it; a stage's test warns", () => {
    expect(anchorProblem(BALINESE, "pawukon")).toContain("the wuku sits in the pawukon");
    const seasoned: CalendarAst = { ...BALINESE, seasons: { unit: "pawukon", marks: [{ name: "One", from: 0 }] } };
    expect(anchorProblem(seasoned, "pawukon")).toContain("the seasons divide the pawukon");
    expect(anchorProblem(HEBREW_WEEK, "weekday")).toBeNull();
    expect(anchorWarnings(HEBREW_WEEK, "weekday")).toEqual(["stage 1 of the year keeps its days, so its weekday labels move with it"]);
    expect(anchorWarnings(GREGORIAN, "weekday")).toEqual([]);
  });

  test("a today is Save is stale when the stage reading the weekday changed outside", () => {
    const { text, base, draft } = opened(HEBREW_WEEK);
    const r = done(setTodayIs(draft, base, "weekday", 1, 0, cycle(draft.ast!, "weekday").anchor));
    const flip = (x: StageRule): StageRule => ("residue" in x ? { ...x, residue: { ...x.residue, offset: (x.residue.offset ?? 0) + 7 } } : x);
    const restaged = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "year" && u.kind === "cycle" ? { ...u, stages: u.stages!.map((st, i) => (i === 0 ? { rules: st.rules.map(flip) } : st)) } : u)) }));
    expect(restaged).not.toBe(text);
    expect(staleWhy(mergeCalendar(restaged, base, r.calendar))).toContain("a stage that reads the weekday changed outside");
  });
});

describe("a stash across a rename", () => {
  const settings = (text: string): StudioSettingsLike => ({ zones: [], eras: [], overrides: [], calendar: seshatDraft(parse(text)), calendarSource: "seshat" });
  test("a rename stashed and restored saves as the rename, onto the stored calendar and onto one changed outside since", () => {
    const text = print(GREGORIAN);
    const store = createStore(initialState(settings(text), null), (f) => f());
    store.update(
      (s) => {
        s.world.calendar = done(renameCycle(s.world.calendar, s.calendarBase!, "weekday", "dow")).calendar;
      },
      { history: true },
    );
    const stash = takeStash(store.get(), store)!;
    const back = applyStash(initialState(settings(text), null), structuredClone(stash));
    expect(unitOps(back.calendarBase!.ast!, back.world.calendar.ast!)).toEqual([{ kind: "rename", from: "weekday", to: "dow" }]);
    const saved = written(mergeCalendar(text, back.calendarBase!, back.world.calendar));
    expect(saved.formats!.some((f) => f.pattern.includes("{dow:name}"))).toBe(true);
    expect(long(saved, D)).toBe("Friday 4 October 2024");
    const now = outside(text, (a) => withRule(a, mondays));
    const later = applyStash(initialState(settings(now), null), structuredClone(stash));
    const saved2 = written(mergeCalendar(now, later.calendarBase!, later.world.calendar));
    expect(saved2.rules!.find((x) => x.id === "market")!.rule).toEqual({ kind: "recur", freq: "day", by: [{ unit: "dow", label: ["Monday"] }] });
  });
});
