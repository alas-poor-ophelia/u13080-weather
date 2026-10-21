/**
 * Seshat P3a step 4 (docs/SESHAT-v0.md §13.8, §13.11 B3, M4, NFC ruling): the
 * Studio on a world that runs a stored definition.
 *
 *   - the draft opens on the definition's seasons and moons;
 *   - Save merges into a fresh parse: an untouched calendar writes nothing;
 *     a moon keeps its exact rational unless its numbers changed; a
 *     phases-only edit leaves the hash alone; edits outside the calendar
 *     draft (month names) made in the stored text survive;
 *   - a stored calendar that moved under unsaved calendar work is stale;
 *   - a non-canonical stored text is flagged as a rewrite;
 *   - the seed base travels with the draft (initialState, markSaved, stash);
 *   - a zone literal equal to a calendar name only after NFC is a warning.
 */
import { describe, expect, test } from "bun:test";
import { calendarOfDefinition, mergeCalendar, planCalendarSave, type CalendarDraft } from "../src/studio/model/definition";
import { initialState, type StudioSettingsLike } from "../src/studio/model/state";
import { createStore } from "../src/studio/model/store";
import { applyStash, takeStash } from "../src/studio/model/stash";
import { issuesFor, nfcIssues } from "../src/studio/model/validation";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import { Body, GREGORIAN, parse, print, type CalendarAst } from "../src/seshat";
import type { ZoneProfile } from "../src/core/types";

const SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
// 295299734/9999991 days: a round trip through cycleDays gives another rational back (the denominator is past bodyFor's cap)
const DEF: CalendarAst = {
  ...GREGORIAN,
  seasons: { unit: "year", marks: SEASONS },
  bodies: [
    { id: "luna", period: { n: 295299734, d: 9999991 }, epoch: { n: 1234567, d: 9999991 }, moon: { name: "Luna", phases: [{ name: "Full", at: 0.5 }] } },
    { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Ember" } },
  ],
};
const TEXT = print(DEF);
const BASE = calendarOfDefinition(parse(TEXT));
const clone = <T>(v: T): T => structuredClone(v);
const written = (r: ReturnType<typeof mergeCalendar>): CalendarAst => {
  if (r.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return parse(r.text);
};

describe("the draft opens on the definition", () => {
  test("seasons as stored, moons in declaration order with their body ids, numbers and phases", () => {
    expect(BASE.seasons).toEqual(SEASONS);
    expect(BASE.moons).toEqual([
      { id: "luna", name: "Luna", cycleDays: 295299734 / 9999991, phaseAtEpoch: 1234567 / 9999991, phases: [{ name: "Full", at: 0.5 }] },
      { id: "ember", name: "Ember", cycleDays: 33, phaseAtEpoch: 0 },
    ]);
  });
});

describe("Save merges into a fresh parse of the stored text", () => {
  test("an untouched calendar writes nothing", () => {
    expect(mergeCalendar(TEXT, BASE, clone(BASE))).toEqual({ kind: "unchanged" });
  });

  test("a seasons edit keeps every body's exact rational", () => {
    const draft = clone(BASE);
    draft.seasons[1]!.from = 0.3;
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.seasons!.marks[1]!.from).toBe(0.3);
    expect(ast.bodies).toEqual(DEF.bodies);
  });

  test("a phases-only edit leaves the hash alone", () => {
    const draft = clone(BASE);
    draft.moons[0]!.phases = [
      { name: "New", at: 0 },
      { name: "Full", at: 0.5 },
    ];
    const r = mergeCalendar(TEXT, BASE, draft);
    const ast = written(r);
    expect(ast.bodies![0]!.moon!.phases).toEqual(draft.moons[0]!.phases);
    expect(ast.bodies![0]!.period).toEqual({ n: 295299734, d: 9999991 });
    if (r.kind !== "write") throw new Error("write");
    expect(new SeshatCalendar(r.text, () => 0).configHash()).toBe(new SeshatCalendar(TEXT, () => 0).configHash());
  });

  test("a changed cycle takes the rational of the number written; a removed moon goes; a new moon gets a fresh id", () => {
    const draft = clone(BASE);
    draft.moons[0]!.cycleDays = 29.5;
    draft.moons.splice(1, 1);
    draft.moons.push({ name: "Ash", cycleDays: 7.3, phaseAtEpoch: 0.25 });
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect(ast.bodies!.map((b) => [b.id, b.moon?.name, b.period])).toEqual([
      ["luna", "Luna", { n: 59, d: 2 }],
      ["moon-1", "Ash", { n: 73, d: 10 }],
    ]);
    expect(ast.bodies![0]!.epoch).toEqual({ n: 1234567, d: 9999991 }); // the epoch did not change, so it stays exact
  });

  test("a changed epoch keeps the exact period", () => {
    const draft = clone(BASE);
    draft.moons[0]!.phaseAtEpoch = 0.5;
    const ast = written(mergeCalendar(TEXT, BASE, draft));
    expect([ast.bodies![0]!.period, ast.bodies![0]!.epoch]).toEqual([{ n: 295299734, d: 9999991 }, { n: 1, d: 2 }]);
  });

  test("a kept exact period beside a new epoch too fine for it falls back to the pair that runs", () => {
    const draft = clone(BASE);
    // 2·P·F must stay a safe integer: P = 295299734, so this epoch's denominator cannot sit beside the exact period
    draft.moons[0]!.phaseAtEpoch = 0.7770876399966369; // bodyFor gives 13374624/17211217: 2·295299734·17211217 > 2^53
    const r = mergeCalendar(TEXT, BASE, draft);
    expect(r.kind).toBe("write");
    const b = written(r).bodies![0]!;
    expect(() => new Body(b.period, b.epoch)).not.toThrow();
  });

  test("what the draft does not hold survives: a month renamed in the stored text is kept", () => {
    const stored = TEXT.replace("SLOT:March=31", "SLOT:Marzo=31");
    const draft = clone(BASE);
    draft.seasons[0]!.name = "Thaw";
    const ast = written(mergeCalendar(stored, BASE, draft));
    expect(print(ast)).toContain("SLOT:Marzo=31");
    expect(ast.seasons!.marks[0]!.name).toBe("Thaw");
  });

  test("a stored calendar that moved under the draft is stale, and says what is stored", () => {
    const moved = print({ ...DEF, seasons: { unit: "year", marks: SEASONS.slice(0, 2) } });
    const draft = clone(BASE);
    draft.seasons[3]!.name = "Frost";
    const r = mergeCalendar(moved, BASE, draft);
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") expect(r.stored.seasons).toEqual(SEASONS.slice(0, 2));
    // the same move with an untouched draft is no conflict: nothing is written
    expect(mergeCalendar(moved, BASE, clone(BASE))).toEqual({ kind: "unchanged" });
  });

  test("a non-canonical stored text is a rewrite; a canonical one is not", () => {
    const draft = clone(BASE);
    draft.seasons[1]!.from = 0.3;
    const handEdited = TEXT.replace("\nBEGIN:VUNIT", "\n\n\nBEGIN:VUNIT");
    expect(handEdited).not.toBe(TEXT);
    expect(mergeCalendar(handEdited, BASE, draft)).toMatchObject({ kind: "write", rewrites: true });
    expect(mergeCalendar(TEXT, BASE, draft)).toMatchObject({ kind: "write", rewrites: false });
  });

  test("a draft that cannot run is an error, and nothing is written", () => {
    const draft = clone(BASE);
    draft.moons[1]!.cycleDays = 0;
    expect(mergeCalendar(TEXT, BASE, draft).kind).toBe("error");
    const twin = clone(BASE);
    twin.moons.push({ name: "Luna", cycleDays: 10, phaseAtEpoch: 0 });
    expect(mergeCalendar(TEXT, BASE, twin)).toMatchObject({ kind: "error", message: expect.stringContaining("more than once") as unknown as string });
  });

  test("seasons can be cleared, and a calendar without seasons can gain them", () => {
    const none = clone(BASE);
    none.seasons = [];
    // clearing the last season removes the field (an empty field is hashed, so adding and clearing again gives back the same calendar: §15.9)
    expect(written(mergeCalendar(TEXT, BASE, none))).not.toHaveProperty("seasons");
    const bare = print({ ...DEF, seasons: undefined } as unknown as CalendarAst);
    const bareBase = calendarOfDefinition(parse(bare));
    const gained = { ...clone(bareBase), seasons: [{ name: "Wet", from: 0 }] };
    expect(written(mergeCalendar(bare, bareBase, gained)).seasons).toEqual({ unit: "year", marks: [{ name: "Wet", from: 0 }] });
  });
});

describe("planCalendarSave: the calendar goes where it came from, or nowhere", () => {
  const LEGACY: CalendarDraft = { seasons: [{ name: "Wet", from: 0 }], moons: [{ name: "Moon", cycleDays: 29.53, phaseAtEpoch: 0 }] };
  const edited = (c: CalendarDraft): CalendarDraft => ({ ...clone(c), seasons: [...clone(c.seasons), { name: "Extra", from: 0.9 }] });

  test("an untouched draft writes nothing, whatever the source", () => {
    expect(planCalendarSave({ source: "legacy", calendar: LEGACY }, undefined, { calendar: clone(LEGACY), base: LEGACY, source: "legacy" })).toEqual({ kind: "none" });
    expect(planCalendarSave({ source: "seshat", calendar: BASE }, TEXT, { calendar: clone(BASE), base: BASE, source: "seshat" })).toEqual({ kind: "none" });
    expect(planCalendarSave({ source: "fault", calendar: LEGACY }, "broken", { calendar: clone(LEGACY), base: LEGACY, source: "fault" })).toEqual({ kind: "none" });
  });

  test("an edited legacy draft writes the legacy fields; an edited definition draft writes the definition", () => {
    expect(planCalendarSave({ source: "legacy", calendar: LEGACY }, undefined, { calendar: edited(LEGACY), base: LEGACY, source: "legacy" })).toEqual({ kind: "legacy" });
    const p = planCalendarSave({ source: "seshat", calendar: BASE }, TEXT, { calendar: edited(BASE), base: BASE, source: "seshat" });
    expect(p.kind).toBe("definition");
    if (p.kind === "definition") expect(parse(p.text).seasons!.marks.at(-1)).toEqual({ name: "Extra", from: 0.9 });
  });

  test("a draft from another calendar is never written into this one (Brynn's switch case)", () => {
    // a definition draft, then the world switched back to the internal calendar
    const fromDefinition = planCalendarSave({ source: "legacy", calendar: LEGACY }, TEXT, { calendar: edited(BASE), base: BASE, source: "seshat" });
    expect(fromDefinition).toMatchObject({ kind: "refuse", reseed: LEGACY });
    // untouched: nothing written, and the draft takes the calendar the world runs
    expect(planCalendarSave({ source: "legacy", calendar: LEGACY }, TEXT, { calendar: clone(BASE), base: BASE, source: "seshat" })).toEqual({ kind: "none", reseed: LEGACY });
    // the other way round
    expect(planCalendarSave({ source: "seshat", calendar: BASE }, TEXT, { calendar: edited(LEGACY), base: LEGACY, source: "legacy" })).toMatchObject({ kind: "refuse", reseed: BASE });
  });

  test("a faulted definition saves no calendar edit; a stale or broken merge is refused, a stale one with the stored calendar", () => {
    // the fault guard itself refuses (not a later parse error): the stored text here parses, and its own message says so
    const faulted = planCalendarSave({ source: "fault", calendar: LEGACY }, TEXT, { calendar: edited(LEGACY), base: LEGACY, source: "fault" });
    expect(faulted).toMatchObject({ kind: "refuse", message: expect.stringContaining("cannot run, so its seasons and moons cannot be saved") as unknown as string });
    const moved = print({ ...DEF, seasons: { unit: "year", marks: SEASONS.slice(0, 2) } });
    expect(planCalendarSave({ source: "seshat", calendar: BASE }, moved, { calendar: edited(BASE), base: BASE, source: "seshat" })).toMatchObject({ kind: "refuse", reseed: { seasons: SEASONS.slice(0, 2) } });
    const bad = clone(BASE);
    bad.moons[1]!.cycleDays = 0;
    const p = planCalendarSave({ source: "seshat", calendar: BASE }, TEXT, { calendar: bad, base: BASE, source: "seshat" });
    expect(p.kind).toBe("refuse");
    expect("reseed" in p).toBe(false);
  });

  test("a merge that prints the stored text again writes nothing", () => {
    // an epoch phase of 1 is an edit to the draft, but it reduces to the same body (phase 0), so the text prints as stored;
    // a "definition" plan here would reach saveDefinition, which skips an unchanged text, and the zones would not be saved
    const same = clone(BASE);
    same.moons[1]!.phaseAtEpoch = 1;
    expect(mergeCalendar(TEXT, BASE, same)).toMatchObject({ kind: "write", text: TEXT });
    expect(planCalendarSave({ source: "seshat", calendar: BASE }, TEXT, { calendar: same, base: BASE, source: "seshat" })).toEqual({ kind: "none" });
  });
});

describe("the seed base travels with the world draft", () => {
  const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
  const settings = (calendar: CalendarDraft): StudioSettingsLike => ({ zones: [zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone], eras: [], calendar, devicePresets: [], overrides: [] });

  test("initialState seeds it; edits leave it; markSaved moves it", () => {
    const store = createStore(initialState(settings(BASE), null), (f) => f());
    expect(store.get().calendarBase).toEqual(BASE);
    store.update((s) => void (s.world.calendar.seasons[0]!.name = "Thaw"), { history: true });
    expect(store.get().calendarBase).toEqual(BASE);
    store.markSaved();
    expect(store.get().calendarBase!.seasons[0]!.name).toBe("Thaw");
  });

  test("a stash across a calendar switch: an untouched calendar takes the current one, an edited one keeps its source", () => {
    const seshatState = initialState({ ...settings(BASE), calendarSource: "seshat" }, null);
    const store = createStore(seshatState, (f) => f());
    store.update((s) => void s.world.eras.push({ name: "Ice", from: 1, to: 2 }), { history: true }); // world dirty, calendar untouched
    const legacyCal: CalendarDraft = { seasons: [{ name: "Wet", from: 0 }], moons: [] };
    const reopened = applyStash(initialState(settings(legacyCal), null), takeStash(store.get(), store)!);
    expect(reopened.world.calendar).toEqual(legacyCal);
    expect(reopened.calendarSource).toBe("legacy");
    expect(reopened.world.eras.map((e) => e.name)).toEqual(["Ice"]);
    store.update((s) => void (s.world.calendar.seasons[0]!.name = "Thaw"), { history: true }); // now the calendar is edited too
    const kept = applyStash(initialState(settings(legacyCal), null), takeStash(store.get(), store)!);
    expect(kept.world.calendar.seasons[0]!.name).toBe("Thaw");
    expect(kept.calendarSource).toBe("seshat"); // so Save refuses it rather than write it into the internal calendar
  });

  test("a stash of a dirty world carries it, so a reopened studio still detects a stale save", () => {
    const store = createStore(initialState(settings(BASE), null), (f) => f());
    store.update((s) => void (s.world.calendar.seasons[0]!.name = "Thaw"), { history: true });
    const stash = takeStash(store.get(), store)!;
    expect(stash.calendarBase).toEqual(BASE);
    const moved = { ...clone(BASE), seasons: SEASONS.slice(0, 2) };
    const reopened = applyStash(initialState(settings(moved), null), stash);
    expect(reopened.calendarBase).toEqual(BASE);
    expect(reopened.world.calendar.seasons[0]!.name).toBe("Thaw");
  });
});

describe("a zone literal that matches a calendar name only after NFC", () => {
  const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
  const composed = "Hiver" + String.fromCharCode(0x00e9); // "Hiveré", one code point
  const decomposed = "Hiver" + "e" + String.fromCharCode(0x0301); // the same letter as e + combining acute
  const zoneWith = (tag: string, moon: string, source: string): ZoneProfile => ({
    ...zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone,
    modifiers: [{ id: "frost", when: { any: [{ tag }, { moon: { name: moon, phase: [0, 0.5] } }] }, mods: [{ source, amount: 1 }], apply: [], tag: "frost" }],
  });
  const input = (zone: ZoneProfile) => ({ zone, eras: [], seasons: [{ name: composed, from: 0 }], moons: [{ name: composed }], readOnlyCalendar: false });

  test("a malformed draft (the JSON drawer accepts anything) raises nothing here and does not throw", () => {
    const bad = { ...zoneWith("x", "y", "z"), modifiers: [{ id: "m", when: { all: "nope", any: [null, { moon: null }], not: 5 }, mods: "x" }, null, 7] } as unknown as ZoneProfile;
    expect(nfcIssues(input(bad))).toEqual([]);
    expect(nfcIssues(input({ ...bad, modifiers: "none" } as unknown as ZoneProfile))).toEqual([]);
  });

  test("each literal spelled with other code points is a warning on its device, naming the calendar's spelling", () => {
    expect(decomposed).not.toBe(composed);
    expect(decomposed.normalize("NFC")).toBe(composed);
    const issues = nfcIssues(input(zoneWith(`season:${decomposed}`, decomposed, `season:${decomposed}`)));
    expect(issues.map((i) => i.path)).toEqual(["modifiers[0].when.any[0].tag", "modifiers[0].when.any[1].moon.name", "modifiers[0].mods[0].source"]);
    for (const i of issues) {
      expect(i.level).toBe("warning");
      expect(i.unit).toEqual({ kind: "device", id: "frost" });
      expect(i.message).toContain(composed);
    }
    expect(issuesFor(input(zoneWith(`season:${decomposed}`, decomposed, `season:${decomposed}`))).filter((i) => i.message.includes("Unicode"))).toHaveLength(3);
  });

  test("the calendar's own spelling, and an unrelated name, raise nothing", () => {
    expect(nfcIssues(input(zoneWith(`season:${composed}`, composed, `season:${composed}`)))).toEqual([]);
    expect(nfcIssues(input(zoneWith("season:Spring", "Other", "era:None")))).toEqual([]);
  });
});
