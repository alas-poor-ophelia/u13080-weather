/**
 * Orrery step 3 (docs/SESHAT-v0.md §18.6 items 1-6, bead wadjet-b6x): the AST
 * layer of a Seshat world's calendar draft.
 *
 *   - a Seshat draft carries `ast` (the stored definition plus AST-only edits);
 *     legacy drafts carry none and behave as before;
 *   - Save replays the edited slices and the pending field parts onto the
 *     definition stored at Save time: an outside edit to a part the draft never
 *     touched survives, one to a part it did touch is refused;
 *   - nothing edited writes nothing; a field edit writes exactly what the
 *     field-only path wrote; an exact period survives a name edit and a move;
 *   - an older stash is seeded with the layer; undo covers both kinds of edit;
 *   - the AST edit functions (ast-edit.ts) on the presets and the Orrery fixtures.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import {
  addSeasonMark,
  editedSlices,
  outsideSlices,
  removeSeasonMark,
  setCrossingBody,
  setCrossingMark,
  setCrossingOffset,
  setCrossingStart,
  setGearIntervals,
  setGearPositions,
  setLiteralCrossing,
  setSeasonMark,
  setStages,
  type AstEdit,
} from "../src/studio/model/ast-edit";
import { applyAstEdit, calendarOfDefinition, draftAst, mergeCalendar, moveMoon, planCalendarSave, seshatDraft, studioSave, type CalendarDraft, type CalendarEdit, type MergeResult } from "../src/studio/model/definition";
import { adoptSettings, initialState, type StudioSettingsLike } from "../src/studio/model/state";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { applyStash, takeStash } from "../src/studio/model/stash";
import { createStore } from "../src/studio/model/store";
import {
  BAHAI,
  BALINESE,
  COPTIC,
  epochEditK,
  ETHIOPIAN,
  FRENCH_REPUBLICAN,
  FRENCH_REPUBLICAN_EQUINOX,
  GREGORIAN,
  HARPTOS,
  HEBREW,
  ISLAMIC_CIVIL,
  ISLAMIC_TBLA,
  MAYA,
  parse,
  print,
  problems,
  resolveCrossing,
  ROMAN,
  toNumber,
  type BodyAst,
  type CalendarAst,
  type CycleUnitAst,
  type Rational,
} from "../src/seshat";
import { ESCAPED, LEVANAH, LUNAR } from "./fixtures/orrery";

const PRESETS: Record<string, CalendarAst> = { GREGORIAN, ISLAMIC_CIVIL, ISLAMIC_TBLA, COPTIC, ETHIOPIAN, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, HARPTOS, HEBREW, MAYA, BALINESE, ROMAN, BAHAI };
const ALL: Record<string, CalendarAst> = { ...PRESETS, LUNAR, ESCAPED, LEVANAH };

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const clone = <T>(v: T): T => structuredClone(v);
const ok = (r: AstEdit): CalendarAst => {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r.ast;
};
const reason = (r: AstEdit | CalendarEdit): string => {
  if (!("refused" in r)) throw new Error("expected a refusal");
  return r.reason;
};
const done = (r: CalendarEdit): { calendar: CalendarDraft; ast: CalendarAst } => {
  if ("refused" in r) throw new Error(`refused: ${r.reason}`);
  return r;
};
const written = (r: MergeResult): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};
/** The stored text and the draft a Seshat world opens on (base and draft as the Studio seeds them). */
function opened(ast: CalendarAst): { text: string; base: CalendarDraft; draft: CalendarDraft } {
  const text = print(ast);
  const base = seshatDraft(parse(text));
  return { text, base, draft: clone(base) };
}
const unit = (ast: CalendarAst, id: string) => ast.units.find((u) => u.id === id) as CycleUnitAst;
const withoutAst = ({ ast: _a, ...c }: CalendarDraft): CalendarDraft => c;

describe("the draft carries the AST layer on Seshat worlds only", () => {
  test("seshatDraft: calendarOfDefinition's fields and the definition", () => {
    for (const [name, ast] of Object.entries(ALL)) {
      const d = seshatDraft(ast);
      expect(same(withoutAst(d), calendarOfDefinition(ast)), name).toBe(true);
      expect(same(d.ast, ast), name).toBe(true);
      expect(d.ast).not.toBe(ast); // a copy: the draft is mutated in place
    }
  });

  test("initialState keeps the layer; a legacy calendar has none", () => {
    const seshat = initialState({ zones: [], eras: [], overrides: [], calendar: seshatDraft(LUNAR), calendarSource: "seshat" }, null);
    expect(same(seshat.world.calendar.ast, LUNAR)).toBe(true);
    expect(same(seshat.calendarBase!.ast, LUNAR)).toBe(true);
    expect(same(seshat.saved.world.calendar.ast, LUNAR)).toBe(true);
    const legacy = initialState({ zones: [], eras: [], overrides: [], calendar: { seasons: [], moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] } }, null);
    expect("ast" in legacy.world.calendar).toBe(false);
  });
});

describe("open, change nothing, Save: nothing is written", () => {
  for (const [name, ast] of Object.entries(ALL)) {
    test(name, () => {
      const { text, base, draft } = opened(ast);
      expect(mergeCalendar(text, base, draft)).toEqual({ kind: "unchanged" });
      expect(planCalendarSave({ source: "seshat", calendar: base }, text, { calendar: draft, base, source: "seshat" })).toEqual({ kind: "none" });
      expect(draftAst(draft, base)).toEqual({ ast: draft.ast! });
    });
  }

  test("an AST edit and its reverse leave the draft equal to the base", () => {
    const { text, base, draft } = opened(LUNAR);
    const there = done(applyAstEdit(draft, base, (a) => setCrossingStart(a, "year", true))).calendar;
    expect(same(there, base)).toBe(false);
    const back = done(applyAstEdit(there, base, (a) => setCrossingStart(a, "year", false))).calendar;
    expect(same(back, base)).toBe(true);
    expect(mergeCalendar(text, base, back)).toEqual({ kind: "unchanged" });
  });

  test("a field edit writes exactly what the field-only path writes", () => {
    const quiet: string[] = [];
    for (const [name, ast] of Object.entries(ALL)) {
      const { text, base, draft } = opened(ast);
      draft.form = { ...draft.form, name: `${ast.name} (edited)` };
      const layered = mergeCalendar(text, base, draft);
      const fields = mergeCalendar(text, withoutAst(base), withoutAst(draft));
      expect(layered, name).toEqual(fields);
      if (layered.kind !== "write") quiet.push(name);
    }
    expect(quiet).toEqual(["MAYA", "BALINESE"]); // no year, so no world calendar, by either path
  });
});

describe("exact periods (§18.3 D2)", () => {
  test("a name edit keeps 765433/25920", () => {
    const { text, base, draft } = opened(LEVANAH);
    draft.moons[0]!.name = "Yareach";
    const b = written(mergeCalendar(text, base, draft)).bodies![0]!;
    expect(b.moon!.name).toBe("Yareach");
    expect(b.period).toEqual({ n: 765_433, d: 25_920 });
    expect(b.epoch).toEqual({ n: 579_383, d: 765_433 });
  });

  test("an exact move keeps its period through Save, a later name edit and a float-free round trip", () => {
    const { text, base, draft } = opened(LUNAR);
    const molad = { n: 765_433, d: 25_920 };
    const moved = done(moveMoon(draft, base, "moon", { period: molad }));
    expect(moved.ast.bodies![0]!.period).toEqual(molad);
    expect(moved.ast.bodies![0]!.epoch).toEqual({ n: 1, d: 4 }); // the unmoved half, exactly
    const cal = moved.calendar;
    cal.moons[0]!.name = "Levanah";
    const b = written(mergeCalendar(text, base, cal)).bodies![0]!;
    expect([b.period, b.epoch, b.moon!.name]).toEqual([molad, { n: 1, d: 4 }, "Levanah"]);
  });

  test("a move back to the stored pair leaves the draft clean", () => {
    const { base, draft } = opened(LUNAR);
    const there = done(moveMoon(draft, base, "moon", { period: { n: 3, d: 1 } })).calendar;
    const back = done(moveMoon(there, base, "moon", { period: { n: 2953059, d: 100000 } })).calendar;
    expect(same(back, base)).toBe(true);
  });

  test("an epoch move goes through compile: the year that follows the moon keeps its numbering", () => {
    const { base, draft } = opened(LUNAR);
    const epoch = { n: 9, d: 10 };
    const r = done(moveMoon(draft, base, "moon", { epoch }));
    expect(unit(r.ast, "year").crossing!.body!.k ?? 0).toBe(epochEditK({ n: 1, d: 4 }, epoch));
    expect(problems(r.ast)).toEqual([]);
  });

  test("a pair past the Body limit is refused with the reason, and so is a missing moon", () => {
    const { base, draft } = opened(LUNAR);
    expect(reason(moveMoon(draft, base, "moon", { period: { n: 94906267, d: 94906265 }, epoch: { n: 1, d: 94906263 } }))).toContain("too large");
    expect(reason(moveMoon(draft, base, "nope", { period: { n: 30, d: 1 } }))).toContain("no moon");
  });
});

describe("the stale guard (§18.6 item 1)", () => {
  /** The stored text after an edit made outside the Studio (settings, Edit definition). */
  const outside = (text: string, fn: (a: CalendarAst) => CalendarAst) => print(fn(parse(text)));

  test("an outside edit to parts the draft never touched survives a Save of an AST edit", () => {
    const { text, base, draft } = opened(LUNAR);
    const cal = done(applyAstEdit(draft, base, (a) => setCrossingStart(a, "year", true))).calendar;
    const now = outside(text, (a) => ({
      ...a,
      rules: a.rules!.map((r) => ({ ...r, tags: ["full", "bright"] })),
      days: [{ day: 11, name: "Founding" }],
      units: a.units.map((u) => (u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 0 ? { ...s, name: "Firstmonth" } : s)) } : u)),
    }));
    const got = written(mergeCalendar(now, base, cal));
    expect(unit(got, "year").crossing!.start).toBe("after");
    expect(got.rules![0]!.tags).toEqual(["full", "bright"]);
    expect(got.days).toEqual([{ day: 11, name: "Founding" }]);
    expect((got.units[1] as { slots: ReadonlyArray<{ name?: string }> }).slots[0]!.name).toBe("Firstmonth");
  });

  test("an outside edit to the year's length survives a Save of a leap-gear edit (the slices are finer than the year part)", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const cal = done(applyAstEdit(draft, base, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }]))).calendar;
    const now = outside(text, (a) => ({ ...a, units: a.units.map((u) => (u.id === "year" ? { ...u, number: 5 } : u)) }));
    const got = written(mergeCalendar(now, base, cal));
    expect(unit(got, "year").number).toBe(5);
    expect(got.gears[0]).toEqual({ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
  });

  test("an outside edit to a rule survives a Save of a field edit", () => {
    const { text, base, draft } = opened(LUNAR);
    draft.form = { ...draft.form, name: "Renamed" };
    const now = outside(text, (a) => ({ ...a, rules: a.rules!.map((r) => ({ ...r, tags: ["bright"] })) }));
    const got = written(mergeCalendar(now, base, draft));
    expect([got.name, got.rules![0]!.tags]).toEqual(["Renamed", ["bright"]]);
  });

  test("an outside edit to the slice the draft edited refuses, showing the stored calendar", () => {
    const { text, base, draft } = opened(LUNAR);
    const cal = done(applyAstEdit(draft, base, (a) => setCrossingStart(a, "year", true))).calendar;
    const now = outside(text, (a) => ok(setCrossingOffset(a, "year", { n: 1, d: 4 })));
    const m = mergeCalendar(now, base, cal);
    expect(m.kind).toBe("stale");
    if (m.kind === "stale") expect(same(m.stored.ast, parse(now))).toBe(true);
    const plan = planCalendarSave({ source: "seshat", calendar: seshatDraft(parse(now)) }, now, { calendar: cal, base, source: "seshat" });
    expect(plan.kind).toBe("refuse");
  });

  test("an outside edit to the gear the draft edited refuses", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const cal = done(applyAstEdit(draft, base, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }]))).calendar;
    const now = outside(text, (a) => ok(setGearIntervals(a, "leap", [{ every: 4, sign: 1 }, { every: 128, sign: -1 }])));
    expect(mergeCalendar(now, base, cal).kind).toBe("stale");
  });

  test("an outside edit to a field part the draft edited refuses as before", () => {
    const { text, base, draft } = opened(LUNAR);
    draft.form = { ...draft.form, name: "Mine" };
    const now = outside(text, (a) => ({ ...a, name: "Theirs" }));
    expect(mergeCalendar(now, base, draft).kind).toBe("stale");
    expect(mergeCalendar(now, withoutAst(base), withoutAst(draft)).kind).toBe("stale");
  });
});

describe("applyAstEdit", () => {
  test("the field parts an AST edit moves are re-read, and are not edits of their own", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(applyAstEdit(draft, base, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }])));
    expect(r.calendar.form!.year!.leap!.terms).toEqual([{ every: 4, at: 0, sign: 1 }]);
    expect(same(r.ast, r.calendar.ast)).toBe(true); // nothing pending: the layer is the draft
    expect(written(mergeCalendar(text, base, r.calendar)).gears[0]).toEqual({ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
  });

  test("dated season marks: the ribbon's projection follows the mark", () => {
    const { text, base, draft } = opened(LUNAR);
    const r = done(applyAstEdit(draft, base, (a) => setSeasonMark(a, 1, { name: "Bloom", day: 90 })));
    expect(same(r.calendar.seasons, base.seasons)).toBe(false);
    expect(same(r.calendar.seasons, calendarOfDefinition(r.ast).seasons)).toBe(true);
    expect(written(mergeCalendar(text, base, r.calendar)).seasons!.marks[1]).toEqual({ name: "Bloom", day: 90 });
  });

  test("an AST edit that would move a part with an unsaved field edit is refused", () => {
    const { base, draft } = opened(GREGORIAN);
    draft.form = { ...draft.form, year: { ...draft.form!.year!, length: 360 } };
    expect(reason(applyAstEdit(draft, base, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }])))).toContain("year");
  });

  test("an edit reaching past its slice is refused; legacy calendars have no layer", () => {
    const { base, draft } = opened(LUNAR);
    expect(reason(applyAstEdit(draft, base, (a) => ({ ast: { ...a, name: "x" } })))).toContain("past the part");
    const legacy: CalendarDraft = { seasons: [], moons: [] };
    expect(reason(applyAstEdit(legacy, legacy, (a) => ({ ast: a })))).toContain("not a definition");
    expect("error" in draftAst(legacy, legacy)).toBe(true);
  });

  test("a field edit that does not compile is the refusal, as a Save would say it", () => {
    const { text, base, draft } = opened(LUNAR);
    draft.moons = []; // the year follows the moon
    const d = draftAst(draft, base);
    expect("error" in d && d.error).toContain("cannot be removed");
    const m = mergeCalendar(text, base, draft);
    expect(m.kind === "error" && m.message).toBe("error" in d ? d.error : "");
  });
});

describe("the stash (§18.6 item 4)", () => {
  const settings = (text: string): StudioSettingsLike => ({ zones: [], eras: [], overrides: [], calendar: seshatDraft(parse(text)), calendarSource: "seshat" });

  test("a stash from a build before the layer is seeded with the stored definition", () => {
    const text = print(LUNAR);
    const store = createStore(initialState(settings(text), null), (f) => f());
    store.update((s) => {
      s.world.calendar.form = { ...s.world.calendar.form, name: "Stashed" };
    });
    const stash = takeStash(store.get(), store)!;
    delete stash.world!.calendar.ast; // the older shape
    delete stash.calendarBase!.ast;
    const applied = applyStash(initialState(settings(text), null), stash);
    expect(same(applied.world.calendar.ast, parse(text))).toBe(true);
    expect(same(applied.calendarBase!.ast, parse(text))).toBe(true);
    const got = written(mergeCalendar(text, applied.calendarBase!, applied.world.calendar));
    expect(same(got, { ...parse(text), name: "Stashed" })).toBe(true);
  });

  test("seeded over a definition that changed since: the outside edit survives, the stashed edit applies", () => {
    const text = print(LUNAR);
    const store = createStore(initialState(settings(text), null), (f) => f());
    store.update((s) => {
      s.world.calendar.form = { ...s.world.calendar.form, name: "Stashed" };
    });
    const stash = takeStash(store.get(), store)!;
    delete stash.world!.calendar.ast;
    delete stash.calendarBase!.ast;
    const now = print({ ...parse(text), rules: LUNAR.rules!.map((r) => ({ ...r, tags: ["bright"] })) });
    const applied = applyStash(initialState(settings(now), null), stash);
    const got = written(mergeCalendar(now, applied.calendarBase!, applied.world.calendar));
    expect([got.name, got.rules![0]!.tags]).toEqual(["Stashed", ["bright"]]);
    const d = draftAst(applied.world.calendar, applied.calendarBase!);
    expect("ast" in d && d.ast.rules![0]!.tags).toEqual(["bright"]); // the draft shows the stored rule, not the stash's base
  });

  test("a current stash keeps its layer as stashed", () => {
    const text = print(LUNAR);
    const store = createStore(initialState(settings(text), null), (f) => f());
    const st = store.get();
    const r = done(applyAstEdit(st.world.calendar, st.calendarBase!, (a) => setCrossingStart(a, "year", true)));
    store.update((s) => {
      s.world.calendar = r.calendar;
    });
    const applied = applyStash(initialState(settings(text), null), takeStash(store.get(), store)!);
    expect(unit(applied.world.calendar.ast!, "year").crossing!.start).toBe("after");
  });
});

describe("undo (§18.6 item 5)", () => {
  test("a form edit and an AST edit are one step each, both ways", () => {
    const text = print(LUNAR);
    const store = createStore(initialState({ zones: [], eras: [], overrides: [], calendar: seshatDraft(parse(text)), calendarSource: "seshat" }, null), (f) => f());
    const start = canonicalJson(store.get().world);
    store.update((s) => (s.world.calendar.form = { ...s.world.calendar.form, name: "Edited" }), { history: true });
    const named = canonicalJson(store.get().world);
    store.update(
      (s) => {
        s.world.calendar = done(applyAstEdit(s.world.calendar, s.calendarBase!, (a) => setCrossingStart(a, "year", true))).calendar;
      },
      { history: true },
    );
    const both = canonicalJson(store.get().world);
    expect(store.worldDirty()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(canonicalJson(store.get().world)).toBe(named);
    expect(store.undo()).toBe(true);
    expect(canonicalJson(store.get().world)).toBe(start);
    expect(store.worldDirty()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(canonicalJson(store.get().world)).toBe(both);
    const s = store.get();
    expect(written(mergeCalendar(text, s.calendarBase!, s.world.calendar)).name).toBe("Edited");
  });

  test("a drag's frames are one step (updated without history, snapshot at the end)", () => {
    const store = createStore(initialState({ zones: [], eras: [], overrides: [], calendar: seshatDraft(LUNAR), calendarSource: "seshat" }, null), (f) => f());
    for (const n of [2960, 2970, 2980]) {
      store.update((s) => {
        s.world.calendar = done(moveMoon(s.world.calendar, s.calendarBase!, "moon", { period: { n, d: 100 } })).calendar;
      });
    }
    store.snapshot();
    expect(store.get().world.calendar.moons[0]!.exact!.period).toEqual({ n: 149, d: 5 });
    expect(store.undo()).toBe(true);
    expect(store.canUndo()).toBe(false);
    expect(store.worldDirty()).toBe(false);
  });
});

describe("a legacy world is unchanged", () => {
  test("no layer, and Save writes its fields as before", () => {
    const st = initialState({ zones: [], eras: [], overrides: [], calendar: { seasons: [{ name: "winter", from: 0 }], moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] } }, null);
    expect(st.world.calendar.ast).toBeUndefined();
    const draft = clone(st.world.calendar);
    draft.moons[0]!.cycleDays = 30;
    expect(planCalendarSave({ source: "legacy", calendar: st.calendarBase! }, undefined, { calendar: draft, base: st.calendarBase!, source: "legacy" })).toEqual({ kind: "legacy" });
    // the settings calendar carries more than the draft (the year length): an untouched draft still saves nothing
    const settingsCalendar = { ...st.calendarBase!, yearLength: 365 } as CalendarDraft;
    expect(planCalendarSave({ source: "legacy", calendar: settingsCalendar }, undefined, { calendar: st.calendarBase!, base: st.calendarBase!, source: "legacy" })).toEqual({ kind: "none" });
  });
});

// ---- the edit functions

/** Each edit keeps everything outside its slice, the result is a valid definition, and a Save replays it exactly. */
function replays(ast: CalendarAst, edit: (a: CalendarAst) => AstEdit): CalendarAst {
  const { text, base, draft } = opened(ast);
  const next = ok(edit(draft.ast!));
  expect(same(outsideSlices(next), outsideSlices(draft.ast!))).toBe(true);
  expect(problems(next)).toEqual([]);
  const r = done(applyAstEdit(draft, base, edit));
  const m = mergeCalendar(text, base, r.calendar);
  if (m.kind === "unchanged") expect(same(next, draft.ast)).toBe(true);
  else expect(same(written(m), parse(print(r.ast)))).toBe(true);
  return next;
}

describe("gears", () => {
  test("intervals: writing a preset's own terms changes nothing; a new rule is valid and saved", () => {
    for (const [name, ast] of Object.entries(ALL)) {
      for (const g of ast.gears) {
        if (g.kind !== "intervals") continue;
        expect(same(ok(setGearIntervals(ast, g.id, g.terms)), ast), `${name} ${g.id}`).toBe(true);
      }
    }
    const julian = replays(GREGORIAN, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }]));
    expect(editedSlices(GREGORIAN, julian)).toEqual(["gear:leap"]);
    replays(ROMAN, (a) => setGearIntervals(a, "leap", [{ every: 4, offset: 1, sign: 1 }]));
  });

  test("positions: a preset's own table changes nothing; a moved table is valid and saved", () => {
    for (const [name, ast] of Object.entries(ALL)) {
      for (const g of ast.gears) {
        if (g.kind !== "positions") continue;
        expect(same(ok(setGearPositions(ast, g.id, g)), ast), `${name} ${g.id}`).toBe(true);
      }
    }
    const moved = replays(ISLAMIC_CIVIL, (a) => {
      const g = a.gears[0] as { period: number; positions: readonly number[] };
      return setGearPositions(a, "leap", { period: g.period, positions: [...g.positions.slice(1), (g.positions[0]! + 1) % g.period].reverse() });
    });
    const g = moved.gears[0] as { positions: readonly number[] };
    expect(g.positions).toEqual([...g.positions].sort((a, b) => a - b));
  });

  test("refusals name the problem", () => {
    expect(reason(setGearIntervals(GREGORIAN, "nope", [{ every: 4, sign: 1 }]))).toContain("no gear");
    expect(reason(setGearIntervals(HEBREW, "leap", [{ every: 4, sign: 1 }]))).toContain("positions");
    expect(reason(setGearIntervals(GREGORIAN, "leap", [{ every: 0, sign: 1 }]))).toContain("at least 1");
    expect(reason(setGearIntervals(GREGORIAN, "leap", [{ every: 4, sign: 2 as 1 }]))).toContain("adds");
    expect(reason(setGearIntervals(GREGORIAN, "leap", []))).toContain("at least one");
    expect(reason(setGearPositions(GREGORIAN, "leap", { period: 4, positions: [0] }))).toContain("intervals");
    expect(reason(setGearPositions(HEBREW, "leap", { period: 19, positions: [19] }))).toContain("outside");
    expect(reason(setGearPositions(HEBREW, "leap", { period: 1.5, positions: [] }))).toContain("whole");
  });
});

describe("stages", () => {
  test("Hebrew's own stages change nothing; new stages are valid and saved; none removes the field", () => {
    const stages = unit(HEBREW, "year").stages!;
    expect(same(ok(setStages(HEBREW, "year", stages)), HEBREW)).toBe(true);
    // a market day that never falls on the week's first day (Hebrew's months are keyed on its year lengths, so its own stages stay)
    const market: CalendarAst = { ...GREGORIAN, units: [...GREGORIAN.units, { id: "market", kind: "cycle", anchor: 0, length: 8 }] };
    const staged = replays(market, (a) => setStages(a, "market", [{ rules: [{ add: 1, residue: { mod: 7, in: [0] } }, { add: -1, length: { at: 0, is: 9 } }] }]));
    expect(editedSlices(market, staged)).toEqual(["stages:market"]);
    const none = ok(setStages(HEBREW, "year", []));
    expect("stages" in unit(none, "year")).toBe(false);
    expect(editedSlices(HEBREW, none)).toEqual(["stages:year"]);
  });

  test("refusals", () => {
    expect(reason(setStages(HEBREW, "month", []))).toContain("no cycle unit");
    expect(reason(setStages(HEBREW, "year", [{ rules: [] }]))).toContain("at least one rule");
    expect(reason(setStages(HEBREW, "year", [{ rules: [{ add: 0.5, residue: { mod: 7, in: [0] } }] }]))).toContain("whole");
    expect(reason(setStages(HEBREW, "year", [{ rules: [{ add: 1, residue: { mod: 7, in: [7] } }] }]))).toContain("0 to 6");
  });
});

describe("crossings", () => {
  const bodies = (a: CalendarAst) => new Map((a.bodies ?? []).map((b) => [b.id, b]));
  const instant = (a: CalendarAst): number => {
    const r = resolveCrossing(unit(a, "year").crossing!, bodies(a));
    if ("error" in r) throw new Error(r.error);
    return toNumber(r.crossing.at);
  };
  const P = toNumber(LUNAR.bodies![0]!.period);

  test("START: after, and back; K stays", () => {
    const after = replays(LUNAR, (a) => setCrossingStart(a, "year", true));
    expect(unit(after, "year").crossing!.start).toBe("after");
    expect(unit(after, "year").crossing!.body!.k).toBeUndefined();
    expect(same(ok(setCrossingStart(after, "year", false)), LUNAR)).toBe(true);
  });

  test("a moved mark moves K by the smallest shift, so crossing 0 stays within half a period", () => {
    for (const mark of [{ n: 1, d: 10 }, { n: 1, d: 2 }, { n: 9, d: 10 }] as Rational[]) {
      const next = replays(LUNAR, (a) => setCrossingMark(a, "year", mark));
      expect(unit(next, "year").crossing!.body!.k ?? 0).toBe(epochEditK(mark, { n: 0, d: 1 }));
      expect(Math.abs(instant(next) - instant(LUNAR))).toBeLessThanOrEqual(P / 2);
    }
    expect(unit(ok(setCrossingMark(LUNAR, "year", { n: 9, d: 10 })), "year").crossing!.body!.k).toBe(-1);
  });

  test("a shift of most of a period moves K back one", () => {
    const offset = { n: 25, d: 1 };
    const next = replays(LUNAR, (a) => setCrossingOffset(a, "year", offset));
    expect(unit(next, "year").crossing!.body!.k).toBe(-1);
    expect(Math.abs(instant(next) - instant(LUNAR))).toBeLessThanOrEqual(P / 2);
    expect(same(ok(setCrossingOffset(next, "year", { n: 0, d: 1 })), LUNAR)).toBe(true);
  });

  test("another body: crossing 0 lands nearest where it was", () => {
    const other: BodyAst = { id: "other", period: { n: 147653, d: 5000 }, epoch: { n: 3, d: 7 }, moon: { name: "Other" } };
    const two: CalendarAst = { ...LUNAR, bodies: [...LUNAR.bodies!, other] };
    const next = replays(two, (a) => setCrossingBody(a, "year", "other"));
    expect(unit(next, "year").crossing!.body!.id).toBe("other");
    expect(Math.abs(instant(next) - instant(two))).toBeLessThanOrEqual(toNumber(other.period) / 2);
    expect(reason(setCrossingBody(two, "year", "nope"))).toContain("no body");
  });

  test("a crossing written as numbers: Hebrew's own numbers change nothing; refusals", () => {
    const c = unit(HEBREW, "year").crossing as { period: Rational; at: Rational };
    expect(same(ok(setLiteralCrossing(HEBREW, "year", { period: c.period, at: c.at })), HEBREW)).toBe(true);
    expect(reason(setLiteralCrossing(LUNAR, "year", { at: { n: 0, d: 1 } }))).toContain("follows the body");
    expect(reason(setLiteralCrossing(HEBREW, "year", { period: { n: 0, d: 1 } }))).toContain("longer than 0");
    expect(reason(setLiteralCrossing(HEBREW, "year", { at: { n: 2, d: 4 } }))).toContain("lowest terms");
    expect(reason(setCrossingMark(HEBREW, "year", { n: 1, d: 2 }))).toContain("written as numbers");
    expect(reason(setCrossingStart(GREGORIAN, "year", true))).toContain("does not start by a crossing");
    expect(reason(setCrossingMark(LUNAR, "year", { n: 1, d: 1 }))).toContain("phase from 0");
  });

  test("Levanah: the epoch six hours before the crossing is no assumption of the K arithmetic", () => {
    const follow: CalendarAst = { ...LEVANAH, units: [...LEVANAH.units, { id: "lunation", kind: "cycle", crossing: { body: { id: "levanah", mark: { n: 0, d: 1 } } } }] };
    const next = ok(setCrossingMark(follow, "lunation", { n: 3, d: 4 }));
    expect((unit(next, "lunation").crossing!.body!.k ?? 0)).toBe(-1);
    expect(problems(next)).toEqual([]);
  });
});

describe("dated season marks", () => {
  test("each kind of mark, set, added and removed, is valid and saved", () => {
    replays(LUNAR, (a) => setSeasonMark(a, 0, { name: "Thaw", day: 20 }));
    replays(LUNAR, (a) => setSeasonMark(a, 1, { name: "Bloom", slot: { unit: "month", index: 3, day: 5 } }));
    replays(LUNAR, (a) => setSeasonMark(a, 2, { name: "Harvest", from: 0.6 }));
    const four = replays(LUNAR, (a) => addSeasonMark(a, { name: "Frost", day: 300 }));
    expect(four.seasons!.marks.length).toBe(4);
    replays(LUNAR, (a) => removeSeasonMark(a, 0));
    const none = ok(removeSeasonMark(ok(removeSeasonMark(ok(removeSeasonMark(LUNAR, 0)), 0)), 0));
    expect(none.seasons).toBeUndefined();
    expect(ok(addSeasonMark(GREGORIAN, { name: "Spring", slot: { unit: "month", index: 2, day: 21 } })).seasons).toEqual({ unit: "year", marks: [{ name: "Spring", slot: { unit: "month", index: 2, day: 21 } }] });
  });

  test("a mark keeps only its own kind's fields; refusals", () => {
    const odd = { name: "Thaw", day: 20, from: 0.3 };
    const m = ok(setSeasonMark(LUNAR, 0, odd)).seasons!.marks[0];
    expect(m).toEqual({ name: "Thaw", day: 20 });
    expect(reason(setSeasonMark(LUNAR, 5, { name: "x", from: 0 }))).toContain("no season 6");
    expect(reason(setSeasonMark(LUNAR, 0, { name: " ", from: 0 }))).toContain("name");
    expect(reason(setSeasonMark(LUNAR, 0, { name: "x", from: 1 }))).toContain("fraction");
    expect(reason(setSeasonMark(LUNAR, 0, { name: "x", day: 0 }))).toContain("day 1");
    expect(reason(setSeasonMark(LUNAR, 0, { name: "x", slot: { unit: "year", index: 0, day: 1 } }))).toContain("not one");
    expect(reason(setSeasonMark(LUNAR, 0, { name: "x", slot: { unit: "month", index: 12, day: 1 } }))).toContain("no slot 13");
    expect(reason(addSeasonMark(MAYA, { name: "x", from: 0 }))).toContain("no year");
  });
});

// ---- Parallax pass on step 3: the base travels with history, one-sided layers, seating, exact halves, seams

/** Gregorian with a moon and a unit that follows it: a crossing slice and a gear slice to edit. */
const FOLLOWED: CalendarAst = {
  ...GREGORIAN,
  bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 }, moon: { name: "Luna" } }],
  units: [...GREGORIAN.units, { id: "lunation", kind: "cycle", crossing: { body: { id: "luna", mark: { n: 1, d: 2 } } } }],
};
const seshatSettings = (text: string): StudioSettingsLike => ({ zones: [], eras: [{ name: "Age", from: 0, to: 10 }], overrides: [], calendar: seshatDraft(parse(text)), calendarSource: "seshat" });
/**
 * A Studio Save through the code header.ts `save` runs (`studioSave`): the plan; a refusal reseeds with history;
 * otherwise the definition is "written" (returned as the stored text), the draft reseeded and markSaved called
 * with the rebase studioSave decides. The zones, eras and the Save dialog are header.ts's alone.
 */
function headerSave(store: ReturnType<typeof createStore>, stored: string) {
  const decided = studioSave(store.get(), { calendarSource: "seshat", calendar: seshatDraft(parse(stored)) }, stored);
  const plan = decided.plan;
  const reseed = (calendar: CalendarDraft, history: boolean) =>
    store.update(
      (x) => {
        x.world.calendar = structuredClone(calendar);
        x.calendarBase = structuredClone(calendar);
        x.calendarSource = "seshat";
      },
      { history },
    );
  if (plan.kind === "refuse") {
    if (plan.reseed) reseed(plan.reseed, true);
    return { plan, stored };
  }
  const text = plan.kind === "definition" ? plan.text : null;
  const after = decided.after(text);
  if (after.reseed) reseed(after.reseed, false);
  store.markSaved({ rebaseFrom: after.rebaseFrom });
  return { plan, stored: text ?? stored };
}
/** The stored text after an outside edit to the crossing and to gear:leap. */
const S1 = (text: string) => print(ok(setGearIntervals(ok(setCrossingOffset(parse(text), "lunation", { n: 1, d: 4 })), "leap", [{ every: 4, sign: 1 }])));

describe("the base travels with undo (Parallax blocker)", () => {
  test("stale refusal, undo, Save: the outside gear edit is never overwritten", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, s.calendarBase!, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
    const s1 = S1(s0);
    expect(headerSave(store, s1).plan.kind).toBe("refuse"); // stale: the crossing moved outside
    expect(store.undo()).toBe(true); // the edit comes back, judged against the base it was made under
    expect(same(store.get().calendarBase!.ast, parse(s0))).toBe(true);
    const again = headerSave(store, s1).plan;
    expect(again.kind).toBe("refuse");
    expect(again.kind === "refuse" && again.message).toContain("make them again here");
  });

  test("an eras edit, an outside change, a refresh, undo of the eras: the era saves, the calendar is left as stored", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.eras[0]!.to = 20), { history: true });
    store.update((s) => (s.world.eras[0]!.name = "Long age"), { history: true });
    const s1 = S1(s0);
    store.update((s) => adoptSettings(s, initialState(seshatSettings(s1), null), store.dirtyZones(), store.worldDirty()));
    expect(same(store.get().world.calendar.ast, parse(s1))).toBe(true); // the untouched calendar took the stored one
    expect(store.undo()).toBe(true); // undo the rename: the calendar from before the refresh is back, with its own base
    expect(same(store.get().world.calendar.ast, parse(s0))).toBe(true);
    const r = headerSave(store, s1);
    expect(r.plan.kind).toBe("none"); // nothing written to the calendar
    expect(r.stored).toBe(s1); // the outside change stays in storage
    expect(store.get().saved.world.eras[0]).toEqual({ name: "Age", from: 0, to: 20 }); // the era edit saved
    expect(same(store.get().world.calendar.ast, parse(s1))).toBe(true); // the draft shows the stored calendar
    expect(store.worldDirty()).toBe(false);
  });

  test("a refresh with a dirty world and an edited calendar keeps the edit and its base", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar.form = { ...s.world.calendar.form, name: "Mine" }), { history: true });
    const s1 = print({ ...parse(s0), rules: [{ id: "r", tags: ["x"], rule: { kind: "dates", days: [1] } }] });
    store.update((s) => adoptSettings(s, initialState(seshatSettings(s1), null), store.dirtyZones(), true));
    expect(store.get().world.calendar.form!.name).toBe("Mine");
    expect(same(store.get().calendarBase!.ast, parse(s0))).toBe(true);
    const r = headerSave(store, s1);
    expect(r.plan.kind).toBe("definition");
    expect([parse(r.stored).name, parse(r.stored).rules!.length]).toEqual(["Mine", 1]);
  });

  test("Save, reseed, markSaved: clean, and a refresh from the same text stays clean", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, s.calendarBase!, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
    const r = headerSave(store, s0);
    expect(r.plan.kind).toBe("definition");
    expect(store.worldDirty()).toBe(false);
    store.update((s) => adoptSettings(s, initialState(seshatSettings(r.stored), null), store.dirtyZones(), store.worldDirty()));
    expect(store.worldDirty()).toBe(false);
    expect(headerSave(store, r.stored).plan).toEqual({ kind: "none" });
  });
});

describe("after Save the reseeded draft is what the adapter loads", () => {
  for (const [name, ast] of Object.entries(ALL)) {
    test(name, () => {
      const { text, base, draft } = opened(ast);
      draft.form = { ...draft.form, name: `${ast.name} 2` };
      const m = mergeCalendar(text, base, draft);
      const saved = m.kind === "write" ? m.text : text;
      const adapter = new SeshatCalendar(saved, () => 0).definition();
      if (!adapter) {
        expect(["MAYA", "BALINESE"]).toContain(name); // no year: the adapter faults, and the Studio opens no draft on it
        return;
      }
      const fresh = initialState({ zones: [], eras: [], overrides: [], calendar: seshatDraft(adapter), calendarSource: "seshat" }, null);
      expect(canonicalJson(seshatDraft(parse(saved)))).toBe(canonicalJson(fresh.saved.world.calendar));
    });
  }
});

describe("one-sided layers and seating", () => {
  test("a draft with the layer and a base without it is stale, never nothing to save", () => {
    const { text, base, draft } = opened(LUNAR);
    const cal = done(applyAstEdit(draft, base, (a) => setCrossingStart(a, "year", true))).calendar;
    expect(mergeCalendar(text, withoutAst(base), cal).kind).toBe("stale");
    expect(mergeCalendar(text, base, withoutAst(draft)).kind).toBe("stale");
    const store = createStore(initialState(seshatSettings(text), null), (f) => f());
    store.update((s) => (s.world.calendar = cal));
    const stash = takeStash(store.get(), store)!;
    delete stash.calendarBase!.ast;
    const applied = applyStash(initialState(seshatSettings(text), null), stash);
    expect(applied.world.calendar.ast).toBeDefined();
    expect(planCalendarSave({ source: "seshat", calendar: seshatDraft(parse(text)) }, text, { calendar: applied.world.calendar, base: applied.calendarBase!, source: "seshat" }).kind).toBe("refuse");
  });

  test("a seeded stash shows the newer definition in every part it never edited, fields and layer alike", () => {
    const text = print(LUNAR);
    const store = createStore(initialState(seshatSettings(text), null), (f) => f());
    store.update((s) => (s.world.calendar.form = { ...s.world.calendar.form, name: "Stashed" }));
    const stash = takeStash(store.get(), store)!;
    delete stash.world!.calendar.ast;
    delete stash.calendarBase!.ast;
    const newer = parse(text);
    const now = print({ ...newer, bodies: newer.bodies!.map((x) => ({ ...x, moon: { ...x.moon!, name: "Selene" } })) });
    const applied = applyStash(initialState(seshatSettings(now), null), stash);
    expect(applied.world.calendar.moons[0]!.name).toBe("Selene");
    expect(applied.calendarBase!.moons[0]!.name).toBe("Selene");
    expect(applied.world.calendar.form!.name).toBe("Stashed");
    const d = draftAst(applied.world.calendar, applied.calendarBase!);
    if ("error" in d) throw new Error(d.error);
    expect(same(withoutAst(applied.world.calendar), calendarOfDefinition(d.ast))).toBe(true); // one calendar
    expect(written(mergeCalendar(now, applied.calendarBase!, applied.world.calendar)).name).toBe("Stashed");
  });
});

describe("exact halves", () => {
  test("an exact half that cannot run with the other is an error, never a float-derived pair", () => {
    const { text, base, draft } = opened(LUNAR);
    const period = { n: 295305900001, d: 10000000000 };
    draft.moons[0] = { ...draft.moons[0]!, cycleDays: toNumber(period), exact: { period } };
    const m = mergeCalendar(text, base, draft);
    expect(m.kind === "error" && m.message).toContain("cannot run together");
  });

  test("a float write drops the exact half it moved, so a return to the stored value is clean", () => {
    const store = createStore(initialState(seshatSettings(print(LUNAR)), null), (f) => f());
    const was = store.get().world.calendar.moons[0]!.cycleDays;
    store.update((s) => (s.world.calendar = done(moveMoon(s.world.calendar, s.calendarBase!, "moon", { period: { n: 765_433, d: 25_920 } })).calendar), { history: true });
    expect(store.get().world.calendar.moons[0]!.exact).toEqual({ period: { n: 765_433, d: 25_920 } });
    store.update((s) => (s.world.calendar.moons[0]!.cycleDays = was), { history: true }); // the float knob
    expect(store.get().world.calendar.moons[0]!.exact).toBeUndefined();
    expect(store.worldDirty()).toBe(false);
  });
});

test("a crossing within a day of day 0: START contains to after moves the start one day, K stays", () => {
  // crossing 0 at (1/2 - 29/60)·P = P/60, about 0.49 d: day 0 holds it, and the first day after it is day 1
  const near: CalendarAst = { ...FOLLOWED, bodies: [{ ...FOLLOWED.bodies![0]!, epoch: { n: 29, d: 60 } }] };
  const at = (a: CalendarAst) => {
    const r = resolveCrossing(unit(a, "lunation").crossing!, new Map(a.bodies!.map((b) => [b.id, b])));
    if ("error" in r) throw new Error(r.error);
    return toNumber(r.crossing.at);
  };
  const after = replays(near, (a) => setCrossingStart(a, "lunation", true));
  expect(Math.floor(at(near))).toBe(0);
  expect(Math.floor(at(after))).toBe(1);
  expect(unit(after, "lunation").crossing!.body!.k).toBeUndefined();
});

describe("undo past a Save (markSaved rebases history made over the base the Save started from)", () => {
  /** A Save of a crossing edit through studioSave, then undo past it. */
  function savedOnce(outsideFirst: boolean) {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, s.calendarBase!, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
    // the stored text this Save starts from: as seeded, or moved outside in a part the draft never touched
    const stored = outsideFirst ? print(ok(setGearIntervals(parse(s0), "leap", [{ every: 4, sign: 1 }]))) : s0;
    const r = headerSave(store, stored);
    expect(r.plan.kind).toBe("definition");
    expect(store.undo()).toBe(true);
    return { store, text: r.stored };
  }

  test("nothing moved outside: undo and Save revert the saved edit", () => {
    const { store, text } = savedOnce(false);
    const r = headerSave(store, text);
    expect(r.plan.kind).toBe("definition");
    expect(unit(parse(r.stored), "lunation").crossing!.start).toBeUndefined();
  });

  test("the stored calendar had moved outside: undo and Save write nothing to the calendar, the outside gear stays", () => {
    const { store, text } = savedOnce(true);
    const r = headerSave(store, text);
    expect(r.plan.kind).toBe("none");
    expect(r.stored).toBe(text);
    expect(store.get().world.calendar.ast!.gears[0]).toEqual({ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
  });
});
