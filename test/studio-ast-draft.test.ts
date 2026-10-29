/**
 * Orrery step 3 (docs/SESHAT-v0.md §18.6 items 1-6, bead wadjet-b6x): the AST
 * layer of a Seshat world's calendar draft.
 *
 *   - a Seshat draft carries `ast` (the stored definition plus AST-only edits);
 *     legacy drafts carry none and behave as before;
 *   - Save writes the draft whole (print(draftAst)) when storage is as the
 *     Studio last loaded or saved it, and asks first when it is not
 *     (ruling 2026-10-30): Overwrite, Reload or Cancel;
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
import { applyAstEdit, calendarAfterSave, calendarOfDefinition, draftAst, mergeCalendar, moveMoon, planCalendarSave, resolveConflict, seshatDraft, studioSave, type CalendarDraft, type CalendarEdit, type ConflictChoice, type MergeResult } from "../src/studio/model/definition";
import { prepareDefinition } from "../src/plugin/time/seshat";
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
      expect(planCalendarSave({ source: "seshat", calendar: base }, text, { calendar: draft, base, source: "seshat" })).toEqual({ kind: "none", reseed: base });
      expect(draftAst(draft)).toEqual({ ast: draft.ast! });
    });
  }

  test("an AST edit and its reverse leave the draft equal to the base", () => {
    const { text, base, draft } = opened(LUNAR);
    const there = done(applyAstEdit(draft, (a) => setCrossingStart(a, "year", true))).calendar;
    expect(same(there, base)).toBe(false);
    const back = done(applyAstEdit(there, (a) => setCrossingStart(a, "year", false))).calendar;
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
    const moved = done(moveMoon(draft, "moon", { period: molad }));
    expect(moved.ast.bodies![0]!.period).toEqual(molad);
    expect(moved.ast.bodies![0]!.epoch).toEqual({ n: 1, d: 4 }); // the unmoved half, exactly
    const cal = moved.calendar;
    cal.moons[0]!.name = "Levanah";
    const b = written(mergeCalendar(text, base, cal)).bodies![0]!;
    expect([b.period, b.epoch, b.moon!.name]).toEqual([molad, { n: 1, d: 4 }, "Levanah"]);
  });

  test("a move back to the stored pair leaves the draft clean", () => {
    const { base, draft } = opened(LUNAR);
    const there = done(moveMoon(draft, "moon", { period: { n: 3, d: 1 } })).calendar;
    const back = done(moveMoon(there, "moon", { period: { n: 2953059, d: 100000 } })).calendar;
    expect(same(back, base)).toBe(true);
  });

  test("an epoch move goes through compile: the year that follows the moon keeps its numbering", () => {
    const { draft } = opened(LUNAR);
    const epoch = { n: 9, d: 10 };
    const r = done(moveMoon(draft, "moon", { epoch }));
    expect(unit(r.ast, "year").crossing!.body!.k ?? 0).toBe(epochEditK({ n: 1, d: 4 }, epoch));
    expect(problems(r.ast)).toEqual([]);
  });

  test("a pair past the Body limit is refused with the reason, and so is a missing moon", () => {
    const { draft } = opened(LUNAR);
    expect(reason(moveMoon(draft, "moon", { period: { n: 94906267, d: 94906265 }, epoch: { n: 1, d: 94906263 } }))).toContain("too large");
    expect(reason(moveMoon(draft, "nope", { period: { n: 30, d: 1 } }))).toContain("no moon");
  });
});

describe("applyAstEdit", () => {
  test("the field parts an AST edit moves are re-read, and are not edits of their own", () => {
    const { text, base, draft } = opened(GREGORIAN);
    const r = done(applyAstEdit(draft, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }])));
    expect(r.calendar.form!.year!.leap!.terms).toEqual([{ every: 4, at: 0, sign: 1 }]);
    expect(same(r.ast, r.calendar.ast)).toBe(true); // nothing pending: the layer is the draft
    expect(written(mergeCalendar(text, base, r.calendar)).gears[0]).toEqual({ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }] });
  });

  test("dated season marks: the ribbon's projection follows the mark", () => {
    const { text, base, draft } = opened(LUNAR);
    const r = done(applyAstEdit(draft, (a) => setSeasonMark(a, 1, { name: "Bloom", day: 90 })));
    expect(same(r.calendar.seasons, base.seasons)).toBe(false);
    expect(same(r.calendar.seasons, calendarOfDefinition(r.ast).seasons)).toBe(true);
    expect(written(mergeCalendar(text, base, r.calendar)).seasons!.marks[1]).toEqual({ name: "Bloom", day: 90 });
  });

  test("an AST edit that would move a part with an unsaved field edit is refused", () => {
    const { draft } = opened(GREGORIAN);
    draft.form = { ...draft.form, year: { ...draft.form!.year!, length: 360 } };
    expect(reason(applyAstEdit(draft, (a) => setGearIntervals(a, "leap", [{ every: 4, sign: 1 }])))).toContain("year");
  });

  test("legacy calendars have no layer", () => {
    const legacy: CalendarDraft = { seasons: [], moons: [] };
    expect(reason(applyAstEdit(legacy, (a) => ({ ast: a })))).toContain("not a definition");
    expect("error" in draftAst(legacy)).toBe(true);
  });

  test("a field edit that does not compile is the refusal, as a Save would say it", () => {
    const { text, base, draft } = opened(LUNAR);
    draft.moons = []; // the year follows the moon
    const d = draftAst(draft);
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
    const d = draftAst(applied.world.calendar);
    expect("ast" in d && d.ast.rules![0]!.tags).toEqual(["bright"]); // the draft shows the stored rule, not the stash's base
  });

  test("a current stash keeps its layer as stashed", () => {
    const text = print(LUNAR);
    const store = createStore(initialState(settings(text), null), (f) => f());
    const st = store.get();
    const r = done(applyAstEdit(st.world.calendar, (a) => setCrossingStart(a, "year", true)));
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
        s.world.calendar = done(applyAstEdit(s.world.calendar, (a) => setCrossingStart(a, "year", true))).calendar;
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
        s.world.calendar = done(moveMoon(s.world.calendar, "moon", { period: { n, d: 100 } })).calendar;
      });
    }
    store.snapshot();
    expect(store.get().world.calendar.moons[0]!.exact!.period).toEqual({ n: 149, d: 5 });
    expect(store.undo()).toBe(true);
    expect(store.canUndo()).toBe(false);
    expect(store.worldDirty()).toBe(false);
  });
});

// ---- the edit functions

/** Each edit's result is a valid definition, and a Save writes it exactly. */
function replays(ast: CalendarAst, edit: (a: CalendarAst) => AstEdit): CalendarAst {
  const { text, base, draft } = opened(ast);
  const next = ok(edit(draft.ast!));
  expect(problems(next)).toEqual([]);
  const r = done(applyAstEdit(draft, edit));
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

// ---- a Studio Save: one check, one dialog (ruling 2026-10-30)

/** Gregorian with a moon and a unit that follows it: a crossing slice and a gear slice to edit. */
const FOLLOWED: CalendarAst = {
  ...GREGORIAN,
  bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 }, moon: { name: "Luna" } }],
  units: [...GREGORIAN.units, { id: "lunation", kind: "cycle", crossing: { body: { id: "luna", mark: { n: 1, d: 2 } } } }],
};
const seshatSettings = (text: string): StudioSettingsLike => ({ zones: [], eras: [{ name: "Age", from: 0, to: 10 }], overrides: [], calendar: seshatDraft(parse(text)), calendarSource: "seshat" });
/**
 * A Studio Save through the steps header.ts `save` runs: the plan (`studioSave`); a conflict answered with
 * `choice` (`resolveConflict`); Reload reseeds with history; a refusal saves nothing; otherwise the definition is
 * "written" (returned as the stored text), the draft reseeded (`calendarAfterSave`) and markSaved called. The
 * zones, eras and the Save dialog are header.ts's alone.
 */
function headerSave(store: ReturnType<typeof createStore>, stored: string, choice: ConflictChoice = "cancel") {
  const first = studioSave(store.get(), { calendarSource: "seshat", calendar: seshatDraft(parse(stored)) }, stored);
  const plan = first.kind === "conflict" ? resolveConflict(first, choice) : first;
  const reseed = (calendar: CalendarDraft, history: boolean) =>
    store.update(
      (x) => {
        x.world.calendar = structuredClone(calendar);
        x.calendarBase = structuredClone(calendar);
        x.calendarSource = "seshat";
      },
      { history },
    );
  if (plan === null || plan.kind === "refuse") return { first, plan, stored };
  if (plan.kind === "none" && plan.reloaded) reseed(plan.reseed, true);
  const text = plan.kind === "definition" ? plan.text : null;
  reseed(calendarAfterSave(plan, store.get().world.calendar, text), false);
  store.markSaved();
  return { first, plan, stored: text ?? stored };
}
/** The stored text after an outside edit to the crossing and to gear:leap. */
const S1 = (text: string) => print(ok(setGearIntervals(ok(setCrossingOffset(parse(text), "lunation", { n: 1, d: 4 })), "leap", [{ every: 4, sign: 1 }])));
/** What a Save of the draft writes: the draft AST, printed and prepared. */
const printed = (calendar: CalendarDraft): string => {
  const d = draftAst(calendar);
  if ("error" in d) throw new Error(d.error);
  const p = prepareDefinition(print(d.ast));
  if ("error" in p) throw new Error(p.error);
  return p.text;
};
/** A store on FOLLOWED with a crossing edit and a name edit made in the Studio. */
function edited(s0: string) {
  const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
  store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
  store.update((s) => (s.world.calendar.form = { ...s.world.calendar.form, name: "Mine" }), { history: true });
  return store;
}

describe("a Studio Save writes the draft whole, or asks first (ruling 2026-10-30)", () => {
  test("unchanged storage: Save writes exactly the draft, and the draft reseeds from what was written", () => {
    const s0 = print(FOLLOWED);
    const store = edited(s0);
    const shown = printed(store.get().world.calendar);
    const r = headerSave(store, s0);
    expect(r.first.kind).toBe("definition");
    expect(r.stored).toBe(shown);
    expect(unit(parse(r.stored), "lunation").crossing!.start).toBe("after");
    expect(parse(r.stored).name).toBe("Mine");
    expect(store.worldDirty()).toBe(false);
    expect(same(store.get().calendarBase, seshatDraft(parse(r.stored)))).toBe(true);
  });

  test("changed storage and edits: the plan is a conflict; Overwrite writes the draft, Reload reseeds from storage, Cancel saves nothing", () => {
    const s0 = print(FOLLOWED);
    const s1 = S1(s0);
    const store = edited(s0);
    const shown = printed(store.get().world.calendar);
    const plan = studioSave(store.get(), { calendarSource: "seshat", calendar: seshatDraft(parse(s1)) }, s1);
    if (plan.kind !== "conflict") throw new Error(`expected a conflict, got ${plan.kind}`);
    expect(plan.overwrite).toEqual({ kind: "definition", text: shown, rewrites: false });
    expect(resolveConflict(plan, "overwrite")).toEqual(plan.overwrite);
    expect(resolveConflict(plan, "reload")).toEqual({ kind: "none", reseed: seshatDraft(parse(s1)), reloaded: true });
    expect(resolveConflict(plan, "cancel")).toBeNull();
  });

  test("Overwrite: the stored calendar becomes what the Studio shows; the outside edit is gone", () => {
    const s0 = print(FOLLOWED);
    const store = edited(s0);
    const shown = printed(store.get().world.calendar);
    const r = headerSave(store, S1(s0), "overwrite");
    expect(r.first.kind).toBe("conflict");
    expect(r.stored).toBe(shown);
    expect(unit(parse(r.stored), "lunation").crossing!.body!.offset).toBeUndefined();
    expect(store.worldDirty()).toBe(false);
  });

  test("Reload: the draft shows the stored calendar, the eras edit is saved; undo brings the calendar edits back, and Save then writes them without asking", () => {
    const s0 = print(FOLLOWED);
    const s1 = S1(s0);
    const store = edited(s0);
    store.update((s) => (s.world.eras[0]!.to = 20), { history: true });
    const r = headerSave(store, s1, "reload");
    expect(r.first.kind).toBe("conflict");
    expect(r.stored).toBe(s1); // nothing written to the calendar
    expect(same(store.get().world.calendar, seshatDraft(parse(s1)))).toBe(true);
    expect(same(store.get().calendarBase, seshatDraft(parse(s1)))).toBe(true);
    expect(store.get().saved.world.eras[0]).toEqual({ name: "Age", from: 0, to: 20 });
    expect(store.worldDirty()).toBe(false);
    expect(store.undo()).toBe(true); // undo changes the draft only: the edits come back over the reloaded base
    expect(store.get().world.calendar.form!.name).toBe("Mine");
    expect(same(store.get().calendarBase, seshatDraft(parse(s1)))).toBe(true);
    const again = headerSave(store, s1);
    expect(again.first.kind).toBe("definition");
    expect(parse(again.stored).name).toBe("Mine");
  });

  test("Cancel: nothing is saved, and the draft and its base stay as they were", () => {
    const s0 = print(FOLLOWED);
    const store = edited(s0);
    const before = canonicalJson(store.get().world);
    const r = headerSave(store, S1(s0), "cancel");
    expect(r.plan).toBeNull();
    expect(canonicalJson(store.get().world)).toBe(before);
    expect(same(store.get().calendarBase!.ast, parse(s0))).toBe(true);
    expect(store.worldDirty()).toBe(true);
  });

  test("no calendar edits and changed storage: nothing is written to the calendar, and the draft reseeds from storage", () => {
    const s0 = print(FOLLOWED);
    const s1 = S1(s0);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.eras[0]!.name = "Long age"), { history: true });
    const r = headerSave(store, s1);
    expect(r.first).toEqual({ kind: "none", reseed: seshatDraft(parse(s1)) });
    expect(r.stored).toBe(s1);
    expect(same(store.get().world.calendar, seshatDraft(parse(s1)))).toBe(true);
    expect(same(store.get().calendarBase, seshatDraft(parse(s1)))).toBe(true);
    expect(store.get().saved.world.eras[0]!.name).toBe("Long age");
    expect(store.worldDirty()).toBe(false);
  });

  test("undo then Save writes what is shown (wadjet-gvk): edit, Save, undo, Save; redo, Save", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
    const t1 = headerSave(store, s0).stored;
    expect(unit(parse(t1), "lunation").crossing!.start).toBe("after");
    expect(store.undo()).toBe(true);
    const shown = printed(store.get().world.calendar);
    const r = headerSave(store, t1);
    expect(r.first.kind).toBe("definition"); // storage is what the Studio last wrote: no question
    expect(r.stored).toBe(shown);
    expect(unit(parse(r.stored), "lunation").crossing!.start).toBeUndefined();
    expect(store.redo()).toBe(true);
    const back = headerSave(store, r.stored);
    expect(back.first.kind).toBe("definition");
    expect(unit(parse(back.stored), "lunation").crossing!.start).toBe("after");
  });

  test("a refresh from settings under an edited calendar keeps the edit and its base, so the Save asks", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar.form = { ...s.world.calendar.form, name: "Mine" }), { history: true });
    const s1 = print({ ...parse(s0), rules: [{ id: "r", tags: ["x"], rule: { kind: "dates", days: [1] } }] });
    store.update((s) => adoptSettings(s, initialState(seshatSettings(s1), null), store.dirtyZones(), true));
    expect(store.get().world.calendar.form!.name).toBe("Mine");
    expect(same(store.get().calendarBase!.ast, parse(s0))).toBe(true);
    const r = headerSave(store, s1, "overwrite");
    expect(r.first.kind).toBe("conflict");
    expect([parse(r.stored).name, parse(r.stored).rules ?? []]).toEqual(["Mine", []]);
  });

  test("an untouched calendar under a dirty world takes the stored one on a refresh; an undo past it is an edit like any other", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.eras[0]!.to = 20), { history: true });
    store.update((s) => (s.world.eras[0]!.name = "Long age"), { history: true });
    const s1 = S1(s0);
    store.update((s) => adoptSettings(s, initialState(seshatSettings(s1), null), store.dirtyZones(), store.worldDirty()));
    expect(same(store.get().world.calendar.ast, parse(s1))).toBe(true);
    expect(store.undo()).toBe(true); // the calendar from before the refresh is back in the draft
    expect(same(store.get().world.calendar.ast, parse(s0))).toBe(true);
    // the draft now differs from what was last loaded (s1), and storage is still s1: Save writes what is shown
    const r = headerSave(store, s1);
    expect(r.first.kind).toBe("definition");
    expect(same(parse(r.stored), parse(printed(seshatDraft(parse(s0)))))).toBe(true);
    expect(store.get().saved.world.eras[0]).toEqual({ name: "Age", from: 0, to: 20 });
  });

  test("Save, reseed, markSaved: clean, and a refresh from the same text stays clean", () => {
    const s0 = print(FOLLOWED);
    const store = createStore(initialState(seshatSettings(s0), null), (f) => f());
    store.update((s) => (s.world.calendar = done(applyAstEdit(s.world.calendar, (a) => setCrossingStart(a, "lunation", true))).calendar), { history: true });
    const r = headerSave(store, s0);
    expect(r.plan?.kind).toBe("definition");
    expect(store.worldDirty()).toBe(false);
    store.update((s) => adoptSettings(s, initialState(seshatSettings(r.stored), null), store.dirtyZones(), store.worldDirty()));
    expect(store.worldDirty()).toBe(false);
    expect(headerSave(store, r.stored).plan?.kind).toBe("none");
  });

  test("a world that switched calendars since: the question is asked, and Overwrite says why it cannot write", () => {
    const { text, base, draft } = opened(LUNAR);
    draft.form = { ...draft.form, name: "Mine" };
    const legacy: CalendarDraft = { seasons: [], moons: [] };
    const plan = planCalendarSave({ source: "legacy", calendar: legacy }, text, { calendar: draft, base, source: "seshat" });
    if (plan.kind !== "conflict") throw new Error(`expected a conflict, got ${plan.kind}`);
    expect(plan.overwrite.kind === "refuse" && plan.overwrite.message).toContain("now runs the legacy calendar");
    expect(resolveConflict(plan, "reload")).toEqual({ kind: "none", reseed: legacy, reloaded: true });
  });
});

describe("a legacy world: the same check, the legacy fields written", () => {
  const base: CalendarDraft = { seasons: [{ name: "winter", from: 0 }], moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] };
  const draft: CalendarDraft = { ...clone(base), moons: [{ name: "Sable", cycleDays: 30, phaseAtEpoch: 0 }] };
  const moved: CalendarDraft = { ...clone(base), seasons: [{ name: "summer", from: 0 }] };

  test("unchanged storage writes the fields; the settings calendar's other fields are no change", () => {
    expect(planCalendarSave({ source: "legacy", calendar: base }, undefined, { calendar: draft, base, source: "legacy" })).toEqual({ kind: "legacy" });
    const settingsCalendar = { ...base, yearLength: 365 } as CalendarDraft;
    expect(planCalendarSave({ source: "legacy", calendar: settingsCalendar }, undefined, { calendar: draft, base, source: "legacy" })).toEqual({ kind: "legacy" });
  });

  test("changed storage and edits: a conflict; Overwrite writes the fields, Reload reseeds them, Cancel saves nothing", () => {
    const plan = planCalendarSave({ source: "legacy", calendar: moved }, undefined, { calendar: draft, base, source: "legacy" });
    if (plan.kind !== "conflict") throw new Error(`expected a conflict, got ${plan.kind}`);
    expect(resolveConflict(plan, "overwrite")).toEqual({ kind: "legacy" });
    expect(resolveConflict(plan, "reload")).toEqual({ kind: "none", reseed: moved, reloaded: true });
    expect(resolveConflict(plan, "cancel")).toBeNull();
  });

  test("no edits and changed storage: nothing written, the draft takes the stored fields", () => {
    expect(planCalendarSave({ source: "legacy", calendar: moved }, undefined, { calendar: base, base, source: "legacy" })).toEqual({ kind: "none", reseed: moved });
  });

  test("after a legacy write the draft takes the fields as written: no body ids, no exact halves", () => {
    const withIds: CalendarDraft = { ...draft, moons: [{ ...draft.moons[0]!, id: "moon-1", exact: { period: { n: 30, d: 1 } } }] };
    expect(calendarAfterSave({ kind: "legacy" }, withIds, null)).toEqual({ seasons: base.seasons, moons: [{ name: "Sable", cycleDays: 30, phaseAtEpoch: 0 }] });
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
  test("a stash whose base lacks the layer is an edit over another calendar: the Save asks first", () => {
    const { text, draft } = opened(LUNAR);
    const cal = done(applyAstEdit(draft, (a) => setCrossingStart(a, "year", true))).calendar;
    const store = createStore(initialState(seshatSettings(text), null), (f) => f());
    store.update((s) => (s.world.calendar = cal));
    const stash = takeStash(store.get(), store)!;
    delete stash.calendarBase!.ast;
    const applied = applyStash(initialState(seshatSettings(text), null), stash);
    expect(applied.world.calendar.ast).toBeDefined();
    expect(planCalendarSave({ source: "seshat", calendar: seshatDraft(parse(text)) }, text, { calendar: applied.world.calendar, base: applied.calendarBase!, source: "seshat" }).kind).toBe("conflict");
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
    const d = draftAst(applied.world.calendar);
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
    store.update((s) => (s.world.calendar = done(moveMoon(s.world.calendar, "moon", { period: { n: 765_433, d: 25_920 } })).calendar), { history: true });
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

