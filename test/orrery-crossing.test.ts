/**
 * Orrery slice 5d (docs/SESHAT-v0.md §18.3 D8, §18.6 items 1, 2 and 11; bead
 * wadjet-b6x): the crossing and train inspectors' pure edits
 * (src/studio/model/orrery-crossing.ts) and their AST half (ast-edit.ts
 * `setCrossingIndex`, and the validator's own start-rule check every crossing
 * edit now runs, `startRuleProblem`):
 *
 *   - Hebrew (the real preset): the molad's period and crossing 0 in days,
 *     hours and parts, snapping back to the stored value; START; the train
 *     235/1/19, with refusals for a ratio the validator would not take; the
 *     sanity figure (5787 starts D20708, 385 days) after a no-op;
 *   - LUNAR: a year that follows the Moon keeps its numbers when its mark,
 *     offset or body moves (K), and START keeps K;
 *   - LEVANAH: a crossing edit leaves the body sharing its period untouched;
 *   - the stale guard covers the train (the `crossing:<unit>` slice).
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import { editedSlices, setCrossingIndex, type AstEdit } from "../src/studio/model/ast-edit";
import { mergeCalendar, sameCalendar, seshatDraft, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { crossingZero, followable, followBody, markWrite, offsetWrite, periodWrite, setCrossingZero, setLiteralPeriod, setMark, setOffset, setStartMode, setTrain, trainIn, zeroWrite } from "../src/studio/model/orrery-crossing";
import { moladOf } from "../src/studio/model/rational-knob";
import { Engine, epochEditK, HEBREW, rational, parse, print, problems, startRuleProblem, type BodyCrossingAst, type CalendarAst, type CycleUnitAst, type LiteralCrossingAst } from "../src/seshat";
import { LEVANAH, LEVANAH_BODY, LUNAR } from "./fixtures/orrery";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function done(r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
}
const refused = (r: CalendarEdit | AstEdit): string => {
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
const outside = (text: string, fn: (a: CalendarAst) => CalendarAst) => print(fn(parse(text)));
const year = (ast: CalendarAst): CycleUnitAst => ast.units.find((u) => u.id === "year") as CycleUnitAst;
const literal = (ast: CalendarAst): LiteralCrossingAst => year(ast).crossing as LiteralCrossingAst;
const followed = (ast: CalendarAst): BodyCrossingAst => year(ast).crossing as BodyCrossingAst;
const withYear = (ast: CalendarAst, fn: (u: CycleUnitAst) => CycleUnitAst): CalendarAst => ({ ...ast, units: ast.units.map((u) => (u.id === "year" && u.kind === "cycle" ? fn(u) : u)) });
/** Hebrew 5787 (year index 5786): starts D20708, 385 days. */
const sanity = (ast: CalendarAst): [number, number] => {
  const e = new Engine(ast);
  return [e.start("year", 5786), e.length("year", 5786)];
};

describe("the molad written as numbers (Hebrew)", () => {
  test("the period's knobs read 29 d 12 h 793 p exactly, and writing them back is the stored period", () => {
    const p = literal(HEBREW).period;
    expect(moladOf(p)).toEqual({ molad: { days: 29, hours: 12, parts: 793 }, exact: true });
    expect(periodWrite({ days: 29, hours: 12, parts: 793 }, p, p)).toBe(p);
  });
  test("one part more is 765434/25920 reduced; back to 793 parts is clean, the sanity figure holds", () => {
    const { base, draft } = opened(HEBREW);
    const p = literal(draft.ast!).period;
    const w = periodWrite({ days: 29, hours: 12, parts: 794 }, p, p);
    expect(w).toEqual({ n: 382717, d: 12960 });
    const r = done(setLiteralPeriod(draft, base, "year", w as { n: number; d: number }));
    expect(literal(r.ast).period).toEqual({ n: 382717, d: 12960 });
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["crossing:year"]);
    const back = done(setLiteralPeriod(r.calendar, base, "year", periodWrite({ days: 29, hours: 12, parts: 793 }, literal(r.ast).period, p) as { n: number; d: number }));
    expect(sameCalendar(back.calendar, base)).toBe(true);
    expect(sanity(back.ast)).toEqual([20708, 385]);
  });
  test("a period edit keeps the year holding the Orrery's day in place: crossing 0 moves, the far past moves instead; back is exact", () => {
    const { base, draft } = opened(HEBREW);
    const p = literal(draft.ast!).period;
    const was = new Engine(draft.ast!);
    // without a reference the far past stays and the present moves (the finding: 5787 starts 3 days later)
    const loose = done(setLiteralPeriod(draft, base, "year", { n: 382717, d: 12960 }));
    expect(new Engine(loose.ast).start("year", 5786)).not.toBe(was.start("year", 5786));
    const r = done(setLiteralPeriod(draft, base, "year", { n: 382717, d: 12960 }, 5786));
    const now = new Engine(r.ast);
    expect(now.start("year", 5786)).toBe(was.start("year", 5786));
    expect(now.start("year", 5786)).toBe(20708);
    expect(now.start("year", 0)).not.toBe(was.start("year", 0));
    // exactly: crossing j = floor((5786·235 + 1)/19) is at the same instant, in rationals
    const j = Math.floor((5786 * 235 + 1) / 19);
    const instant = (c: LiteralCrossingAst) => BigInt(c.at.n) * BigInt(c.period.d) + BigInt(j) * BigInt(c.period.n) * BigInt(c.at.d);
    const den = (c: LiteralCrossingAst) => BigInt(c.at.d) * BigInt(c.period.d);
    const a = literal(draft.ast!);
    const b = literal(r.ast);
    expect(instant(a) * den(b)).toBe(instant(b) * den(a));
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["crossing:year"]);
    const back = done(setLiteralPeriod(r.calendar, base, "year", periodWrite({ days: 29, hours: 12, parts: 793 }, literal(r.ast).period, p) as { n: number; d: number }, 5786));
    expect(literal(back.ast).at).toEqual(literal(HEBREW).at);
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("hours and parts out of range, and a period under a day, are refused with their reasons", () => {
    const p = literal(HEBREW).period;
    expect(periodWrite({ days: 29, hours: 24, parts: 0 }, p, p)).toContain("hours run from 0 to 23");
    const { base, draft } = opened(HEBREW);
    expect(refused(setLiteralPeriod(draft, base, "year", { n: 1, d: 2 }))).toContain("is shorter than one day");
  });
  test("crossing 0 is 11 h 204 p on its day (BaHaRaD plus six hours); an hour later and back is clean", () => {
    const at = literal(HEBREW).at;
    expect(crossingZero(at)).toEqual({ day: -2092590, hours: 11, parts: 204, exact: true });
    const { base, draft } = opened(HEBREW);
    const w = zeroWrite(12, 204, at, at);
    expect(w).toEqual(rational(-2092590 * 25920 + 12 * 1080 + 204, 25920));
    const r = done(setCrossingZero(draft, base, "year", w as { n: number; d: number }));
    expect(crossingZero(literal(r.ast).at)).toMatchObject({ day: -2092590, hours: 12, parts: 204 });
    expect(zeroWrite(11, 204, literal(r.ast).at, at)).toBe(at);
    const back = done(setCrossingZero(r.calendar, base, "year", at));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("START after: the start resolves later in the day; back to contains is clean", () => {
    const { base, draft } = opened(HEBREW);
    const r = done(setStartMode(draft, base, "year", true));
    expect(year(r.ast).crossing!.start).toBe("after");
    expect(print(r.ast)).toContain("START=after");
    const back = done(setStartMode(r.calendar, base, "year", false));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("LEVANAH: a period edit leaves the body sharing the molad's period as it was", () => {
    const { base, draft } = opened(LEVANAH);
    const r = done(setLiteralPeriod(draft, base, "year", { n: 382717, d: 12960 }));
    expect(literal(r.ast).period).toEqual({ n: 382717, d: 12960 });
    expect(r.ast.bodies).toEqual([LEVANAH_BODY]);
  });
});

describe("the train (INDEX a/c/L)", () => {
  test("Hebrew's 235/1/19: a no-op keeps the layer and the sanity figure", () => {
    const { base, draft } = opened(HEBREW);
    expect(trainIn(draft.ast!, "year")).toEqual({ a: 235, c: 1, L: 19 });
    const r = done(setTrain(draft, base, "year", { a: 235 }));
    expect(r.calendar.ast).toBe(draft.ast);
    expect(sameCalendar(r.calendar, base)).toBe(true);
    expect(sanity(r.ast)).toEqual([20708, 385]);
  });
  test("the phase moves which years read an extra month (out of step with Adar I: problems() says so on the months); back is clean", () => {
    const { base, draft } = opened(HEBREW);
    const r = done(setTrain(draft, base, "year", { c: 2 }));
    expect(year(r.ast).crossing!.index).toEqual({ a: 235, c: 2, L: 19 });
    expect(editedSlices(base.ast!, r.calendar.ast!)).toEqual(["crossing:year"]);
    expect(print(r.ast)).toContain("INDEX=235/2/19");
    expect(problems(r.ast).some((p) => p.unit === "month")).toBe(true);
    const back = done(setTrain(r.calendar, base, "year", { c: 1 }));
    expect(sameCalendar(back.calendar, base)).toBe(true);
    expect(sanity(back.ast)).toEqual([20708, 385]);
  });
  test("refusals: whole numbers of at least 1, and a ratio that leaves a year no crossing (the validator's own reason)", () => {
    const { base, draft } = opened(HEBREW);
    expect(refused(setTrain(draft, base, "year", { a: 0 }))).toContain("whole number of at least 1");
    expect(refused(setTrain(draft, base, "year", { L: 2.5 }))).toContain("whole number of at least 1");
    expect(refused(setTrain(draft, base, "year", { c: 0.5 }))).toContain("whole number");
    const why = refused(setTrain(draft, base, "year", { a: 1, L: 60 }));
    expect(why).toContain("steps by 0 crossings");
    expect<string | null>(why).toBe(startRuleProblem(withYear(HEBREW, (u) => ({ ...u, crossing: { ...u.crossing!, index: { a: 1, c: 1, L: 60 } } }) as CycleUnitAst), "year"));
    expect(refused(setCrossingIndex(HEBREW, "month", { a: 1, c: 0, L: 1 }))).toContain("no cycle unit");
    expect(refused(setTrain(draft, base, "nope", { a: 2 }))).toContain("no cycle unit");
  });
  test("LUNAR's 12/0/1: thirteen crossings a year make the months not add up (problems() says so on the months)", () => {
    const { base, draft } = opened(LUNAR);
    const r = done(setTrain(draft, base, "year", { a: 13 }));
    expect(year(r.ast).crossing!.index).toEqual({ a: 13, c: 0, L: 1 });
    expect(problems(r.ast).some((p) => p.unit === "month")).toBe(true);
    expect(sameCalendar(done(setTrain(r.calendar, base, "year", { a: 12 })).calendar, base)).toBe(true);
  });
  test("LEVANAH: a train edit leaves the body as it was", () => {
    const { base, draft } = opened(LEVANAH);
    const r = done(setTrain(draft, base, "year", { c: 0 }));
    expect(r.ast.bodies).toEqual([LEVANAH_BODY]);
  });
  test("stale guard: a train edit against a crossing changed in storage is stale; a change elsewhere survives the Save", () => {
    // LUNAR reads one crossing more each year from c 1: the same lengths, the years a month later
    const { text, base, draft } = opened(LUNAR);
    const r = done(setTrain(draft, base, "year", { c: 1 }));
    expect(problems(r.ast)).toEqual([]);
    const moved = outside(text, (a) => withYear(a, (u) => ({ ...u, crossing: { ...u.crossing!, start: "after" } }) as CycleUnitAst));
    expect(mergeCalendar(moved, base, r.calendar).kind).toBe("stale");
    const renamed = outside(text, (a) => ({ ...a, name: "Lunar (edited)" }));
    const out = written(mergeCalendar(renamed, base, r.calendar));
    expect(out.name).toBe("Lunar (edited)");
    expect(year(out).crossing!.index).toEqual({ a: 12, c: 1, L: 1 });
  });
});

describe("a year that follows a body (LUNAR)", () => {
  test("the sentence reads the moon and its named mark; START after keeps K", () => {
    const { base, draft } = opened(LUNAR);
    const r = done(setStartMode(draft, base, "year", true));
    expect(followed(r.ast).start).toBe("after");
    expect(followed(r.ast).body.k).toBeUndefined();
    expect(sameCalendar(done(setStartMode(r.calendar, base, "year", false)).calendar, base)).toBe(true);
  });
  test("a moved mark moves K by epochEditK, so a mid-year day stays in its year; the knob snaps back to the stored mark", () => {
    const { base, draft } = opened(LUNAR);
    const was = followed(draft.ast!).body.mark;
    expect(markWrite(0.004, was, was)).toBe(was);
    const mark = markWrite(0.25, was, was);
    expect(mark).toEqual({ n: 1, d: 4 });
    const r = done(setMark(draft, base, "year", mark));
    expect(followed(r.ast).body.k ?? 0).toBe(epochEditK(mark, was));
    const day = 20_000;
    expect(new Engine(r.ast).indexAt("year", day)).toBe(new Engine(draft.ast!).indexAt("year", day));
    const back = done(setMark(r.calendar, base, "year", markWrite(0, mark, was)));
    expect(sameCalendar(back.calendar, base)).toBe(true);
  });
  test("an offset of six hours is 1/4 day; K keeps the numbers; back to 0 is clean", () => {
    const { base, draft } = opened(LUNAR);
    const zero = { n: 0, d: 1 };
    const w = offsetWrite(6, zero, zero);
    expect(w).toEqual({ n: 1, d: 4 });
    const r = done(setOffset(draft, base, "year", w));
    expect(followed(r.ast).body.offset).toEqual({ n: 1, d: 4 });
    expect(followed(r.ast).body.k ?? 0).toBe(0);
    expect(offsetWrite(0, w, zero)).toBe(zero);
    expect(sameCalendar(done(setOffset(r.calendar, base, "year", zero)).calendar, base)).toBe(true);
  });
  test("follow another body: K puts crossing 0 nearest where it was; a body turning in under a day is offered with why, and refused", () => {
    const twin: CalendarAst = { ...LUNAR, bodies: [...LUNAR.bodies!, { id: "twin", period: { n: 2953059, d: 100000 }, epoch: { n: 3, d: 10 } }, { id: "spark", period: { n: 1, d: 2 }, epoch: { n: 0, d: 1 } }] };
    expect(followable(twin, "year")).toEqual([
      { id: "twin", name: "twin", why: null },
      { id: "spark", name: "spark", why: "turns in less than a day" },
    ]);
    const { base, draft } = opened(twin);
    const r = done(followBody(draft, base, "year", "twin"));
    expect(followed(r.ast).body.id).toBe("twin");
    // the same period, a twentieth of a turn off in epoch: the crossings fall a day or two from where they did, so a mid-year day keeps its year
    const a = new Engine(draft.ast!);
    const b = new Engine(r.ast);
    for (const k of [0, 30, 50]) expect(b.indexAt("year", a.start("year", k) + 150)).toBe(k);
    expect(refused(followBody(draft, base, "year", "spark"))).toContain("less than a day");
  });
  test("a crossing written as numbers has no body to follow, and a body crossing no literal period", () => {
    const h = opened(HEBREW);
    expect(refused(setMark(h.draft, h.base, "year", { n: 1, d: 2 }))).toContain("written as numbers");
    const l = opened(LUNAR);
    expect(refused(setLiteralPeriod(l.draft, l.base, "year", { n: 30, d: 1 }))).toContain("follows the body");
  });
  test("stale guard: a mark edit replays while the moon is as it saw it", () => {
    const { text, base, draft } = opened(LUNAR);
    const r = done(setMark(draft, base, "year", { n: 1, d: 4 }));
    const out = written(mergeCalendar(outside(text, (a) => ({ ...a, name: "Lunar (edited)" })), base, r.calendar));
    expect(same(followed(out).body, followed(r.ast).body)).toBe(true);
    const moved = outside(text, (a) => ({ ...a, bodies: a.bodies!.map((b) => ({ ...b, epoch: { n: 1, d: 3 } })) }));
    const m = mergeCalendar(moved, base, r.calendar);
    expect(m.kind).toBe("stale");
  });
});
