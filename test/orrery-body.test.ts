/**
 * Orrery slice 5a (docs/SESHAT-v0.md §18.3 D2, §18.6 items 2, 6, 11; bead
 * wadjet-b6x): the body inspector's pure edits (src/studio/model/orrery-body.ts).
 *
 *   - `＋ phase` goes at the middle of the largest gap, round the turn;
 *   - every edit goes through `compile`'s guards: a moon a unit follows is not
 *     removed, a phase a rule names is not renamed or removed, with the
 *     guard's reason and the draft as it was;
 *   - a knob writes the draft's rational in its own cell, the stored one in
 *     the stored cell (a drag back leaves the draft clean), else the grid;
 *   - a new moon is editable before it is saved, and the draft reader keeps
 *     the AST's identity while nothing changed.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import { GREGORIAN, parse, print, type CalendarAst } from "../src/seshat";
import { draftAst, moveMoon, seshatDraft, type CalendarDraft, type CalendarEdit } from "../src/studio/model/definition";
import { addBody, addPhase, draftReader, epochWrite, fractionWrite, freshName, knobWrite, moonOf, phaseInsertAt, phaseRules, phasesProblem, removeBody, renameBody, setBodyPhases } from "../src/studio/model/orrery-body";
import { cellOf } from "../src/studio/model/rational-knob";

/** Gregorian with a moon, a month that follows it, and a rule that reads its Full phase by name. */
const LUNAR: CalendarAst = parse(
  print({
    ...GREGORIAN,
    bodies: [{ id: "moon", period: { n: 59, d: 2 }, epoch: { n: 0, d: 1 }, moon: { name: "Lantern", phases: [{ name: "New", at: 0 }, { name: "Waxing", at: 0.05 }, { name: "Full", at: 0.45 }, { name: "Waning", at: 0.55 }] } }],
    rules: [{ id: "full-moon", name: "Full moon", tags: ["full"], rule: { kind: "phase", body: "moon", name: "Full" } }],
  }).replace("END:VCALENDAR", "BEGIN:VUNIT\nUID:lunar-month\nCROSSING:BODY=moon;MARK=0\nEND:VUNIT\n\nEND:VCALENDAR"),
);
/** The same moon with nothing following it and no rule reading it. */
const FREE: CalendarAst = { ...GREGORIAN, bodies: [LUNAR.bodies![0]!] };

function done(r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
}
const refused = (r: CalendarEdit): string => {
  if (!("refused" in r)) throw new Error("not refused");
  return r.reason;
};

describe("phaseInsertAt: the middle of the largest gap", () => {
  test("no phases: at 0; one phase: opposite it", () => {
    expect(phaseInsertAt([])).toBe(0);
    expect(phaseInsertAt([0])).toBe(0.5);
    expect(phaseInsertAt([0.3])).toBe(0.8);
    expect(phaseInsertAt([0.8])).toBe(0.3);
  });
  test("the largest gap, wherever it falls in the list", () => {
    expect(phaseInsertAt([0, 0.05, 0.45, 0.55])).toBe(0.78); // 0.55 → 1: the wrap gap is largest
    expect(phaseInsertAt([0.45, 0, 0.55, 0.05])).toBe(0.78); // order does not matter
    expect(phaseInsertAt([0, 0.6, 0.7, 0.9])).toBe(0.3);
    expect(phaseInsertAt([0.2, 0.3])).toBe(0.75); // wrap: 0.3 → 1.2, middle 0.75
    expect(phaseInsertAt([0.5, 0.6])).toBe(0.05); // wrap: 0.6 → 1.5, middle 1.05 → 0.05
  });
  test("ties take the first gap; the result stays in [0, 1)", () => {
    expect(phaseInsertAt([0, 0.25, 0.5, 0.75])).toBe(0.13);
    expect(phaseInsertAt([0.995])).toBeLessThan(1);
  });
  test("freshName counts up past the names taken", () => {
    expect(freshName("Phase", [])).toBe("Phase");
    expect(freshName("Phase", ["Phase", "Phase 2"])).toBe("Phase 3");
  });
});

describe("the body edits go through compile's guards", () => {
  const base = seshatDraft(LUNAR);
  test("removing a moon a unit follows is refused with its reason, and nothing changes", () => {
    const why = refused(removeBody(base, base, "moon"));
    expect(why).toContain('cannot be removed: the "lunar-month" unit follows it');
  });
  test("renaming or removing a phase a rule names is refused; another phase moves freely", () => {
    const phases = base.moons[0]!.phases!;
    expect(refused(setBodyPhases(base, base, "moon", phases.map((p) => (p.name === "Full" ? { ...p, name: "Bright" } : p))))).toContain('"full-moon" rule names it');
    expect(refused(setBodyPhases(base, base, "moon", phases.filter((p) => p.name !== "Full")))).toContain('"full-moon" rule names it');
    const r = done(setBodyPhases(base, base, "moon", phases.map((p) => (p.name === "Waxing" ? { ...p, name: "Crescent", at: 0.1 } : p))));
    expect(r.ast.bodies![0]!.moon!.phases!.map((p) => `${p.name}=${p.at}`)).toEqual(["New=0", "Crescent=0.1", "Full=0.45", "Waning=0.55"]);
    expect(phaseRules(r.ast, "moon", "Full")).toEqual(["full-moon"]);
    expect(phaseRules(r.ast, "moon", "Crescent")).toEqual([]);
  });
  test("a phase list is checked before it is written", () => {
    expect(phasesProblem([{ name: "", at: 0 }])).toBe("a phase needs a name");
    expect(phasesProblem([{ name: "A", at: 0 }, { name: "A", at: 0.5 }])).toContain('two phases are named "A"');
    expect(phasesProblem([{ name: "A", at: 1 }])).toContain("from 0 up to");
    expect(refused(setBodyPhases(base, base, "moon", [{ name: "New", at: -0.1 }]))).toContain("from 0 up to");
  });
  test("＋ phase inserts at the middle of the largest gap, named afresh", () => {
    const r = done(addPhase(base, base, "moon"));
    expect(r.calendar.moons[0]!.phases!.at(-1)).toEqual({ name: "Phase", at: 0.78 });
    expect(print(r.ast)).toContain("PHASE:Phase=0.78");
  });
  test("a rename keeps the body; an empty or duplicate name is refused", () => {
    const r = done(renameBody(base, base, "moon", "  Selûne "));
    expect(r.ast.bodies![0]).toMatchObject({ id: "moon", period: { n: 59, d: 2 }, moon: { name: "Selûne" } });
    expect(refused(renameBody(base, base, "moon", " "))).toBe("a moon needs a name");
    const two = done(addBody(base, base, LUNAR)).calendar;
    expect(refused(renameBody(two, base, "moon-1", "Lantern"))).toContain("declared more than once");
  });
  test("a free moon is removed; a body that is not a moon is not editable", () => {
    const free = seshatDraft(FREE);
    const r = done(removeBody(free, free, "moon"));
    expect(r.ast.bodies ?? []).toEqual([]);
    const sun: CalendarAst = { ...GREGORIAN, bodies: [{ id: "sun", period: { n: 36524219, d: 100000 }, epoch: { n: 0, d: 1 } }] };
    expect(moonOf(seshatDraft(sun), sun, "sun")).toContain("is not a moon");
  });
});

describe("＋ body", () => {
  test("a new moon has a fresh id, a free name and exact numbers, and is editable before Save", () => {
    const base = seshatDraft(LUNAR);
    const r = addBody(base, base, LUNAR);
    if ("refused" in r) throw new Error(r.reason);
    expect(r.id).toBe("moon-1");
    const b = r.ast.bodies!.find((x) => x.id === "moon-1")!;
    expect(b).toMatchObject({ period: { n: 59, d: 2 }, epoch: { n: 0, d: 1 }, moon: { name: "Moon" } });
    expect(b.moon!.phases!.length).toBeGreaterThan(0);
    const moved = done(moveMoon(r.calendar, base, "moon-1", { period: { n: 3, d: 1 } }));
    expect(moved.ast.bodies!.find((x) => x.id === "moon-1")!.period).toEqual({ n: 3, d: 1 });
    expect(done(removeBody(moved.calendar, base, "moon-1")).ast.bodies!.map((x) => x.id)).toEqual(["moon"]);
  });
});

describe("knobWrite: the origin the knob snaps back to", () => {
  const step = { n: 1, d: 100 };
  test("inside the draft's own cell: the draft's rational, exactly", () => {
    const cur = { n: 765433, d: 25920 }; // 29.530594… shows 29.53
    expect(knobWrite(29.53, cur, { n: 59, d: 2 }, step)).toBe(cur);
  });
  test("inside the stored cell: the stored rational, so a drag back is clean", () => {
    const stored = { n: 487, d: 16 }; // 30.4375 shows 30.44
    const moved = { n: 61, d: 2 };
    expect(knobWrite(30.44, moved, stored, step)).toBe(stored);
    expect(cellOf(stored, step)).toBe(3044);
  });
  test("anywhere else: the step grid, reduced", () => {
    expect(knobWrite(29.6, { n: 59, d: 2 }, { n: 59, d: 2 }, step)).toEqual({ n: 148, d: 5 });
  });
  test("a period drag and its return leave the draft equal to the base", () => {
    const base = seshatDraft(LUNAR);
    const there = done(moveMoon(base, base, "moon", { period: knobWrite(29.6, { n: 59, d: 2 }, { n: 59, d: 2 }, step) }));
    expect(print(there.ast)).toContain("PERIOD:148/5");
    const back = done(moveMoon(there.calendar, base, "moon", { period: knobWrite(29.5, { n: 148, d: 5 }, { n: 59, d: 2 }, step) }));
    expect(canonicalJson(back.calendar)).toBe(canonicalJson(base));
  });
});

describe("draftReader", () => {
  test("the same AST object while nothing changed; dirty after an edit; the layer with the reason when the fields do not compile", () => {
    const read = draftReader();
    const base = seshatDraft(LUNAR);
    const cal = structuredClone(base);
    const a = read(cal, base)!;
    expect(a.dirty).toBe(false);
    expect(a.error).toBeNull();
    expect(read(cal, base)!.ast).toBe(a.ast);
    const moved = done(addPhase(cal, base, "moon")).calendar;
    const b = read(moved, base)!;
    expect(b.dirty).toBe(true);
    expect(b.ast).not.toBe(a.ast);
    expect(b.ast).toEqual(("ast" in draftAst(moved, base) ? (draftAst(moved, base) as { ast: CalendarAst }).ast : null)!);
    const broken: CalendarDraft = { ...cal, moons: cal.moons.filter((m) => m.id !== "moon") };
    const c = read(broken, base)!;
    expect(c.error).toContain("cannot be removed");
    expect(c.ast).toBe(broken.ast!);
    expect(read({ seasons: [], moons: [] }, base)).toBeNull();
  });
});

describe("5a review: the epoch and phase knobs keep their exact origin", () => {
  const STEP = { n: 1, d: 100 };
  test("an epoch past one turn keeps its whole turns: 3/2 moved a step is 151/100, never 51/100", () => {
    const e = { n: 3, d: 2 };
    expect(epochWrite(0.51, e, null, STEP, 0.99)).toEqual({ n: 151, d: 100 });
    expect(epochWrite(0.5, e, null, STEP, 0.99)).toBe(e); // its own cell: itself
    expect(epochWrite(0.25, { n: -3, d: 4 }, null, STEP, 0.99)).toEqual({ n: -3, d: 4 }); // −3/4 shows 0.25, its own cell
    expect(epochWrite(0.3, { n: -3, d: 4 }, null, STEP, 0.99)).toEqual({ n: -7, d: 10 }); // −1 + 0.3
  });
  test("back to the stored epoch's cell writes the stored epoch", () => {
    const stored = { n: 5, d: 4 };
    expect(epochWrite(0.25, { n: 13, d: 10 }, stored, STEP, 0.99)).toBe(stored);
  });
  test("an epoch from 0.995 up shows in the top cell and snaps back there", () => {
    const e = { n: 997, d: 1000 };
    expect(epochWrite(0.99, e, null, STEP, 0.99)).toBe(e);
    expect(epochWrite(0.98, e, null, STEP, 0.99)).toEqual({ n: 49, d: 50 });
  });
  test("a phase start: its own cell keeps the exact value, 0.995 included; another cell is the grid's", () => {
    expect(fractionWrite(0.45, 0.4512, STEP, 0.99)).toBe(0.4512);
    expect(fractionWrite(0.99, 0.997, STEP, 0.99)).toBe(0.997);
    expect(fractionWrite(0.47, 0.4512, STEP, 0.99)).toBe(0.47);
  });
});
