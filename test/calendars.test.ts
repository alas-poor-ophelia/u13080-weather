/**
 * Seshat P3a step 3 (docs/SESHAT-v0.md §13.2, §13.7, §13.11 B2/M1/M3): the
 * stored definition and calendar switching, driven through `Calendars` with
 * main.ts's wiring (the registry echo is skipped while `quiet`).
 *
 *   - opt-in and opt-out fire time-changed and adapters-changed once each and
 *     never profiles-changed; the definition stays on opt-out;
 *   - an edit after a switch fires profiles-changed all:true (wadjet-439);
 *   - a stored value that cannot run is a fault: kept byte for byte, no
 *     fallback, World refuses with code "wadjet-no-calendar"; repairing it
 *     fires all:true;
 *   - a failed save changes nothing; input is NFC and canonical.
 */
import { describe, expect, test } from "bun:test";
import { ApiController } from "../src/plugin/api";
import { Calendars, DefinitionError, SESHAT_ID } from "../src/plugin/calendars";
import { WADJET_EVENTS } from "../src/plugin/events";
import { migrateSettings, type WadjetSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { NO_CALENDAR_CODE, World } from "../src/plugin/world";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import { GREGORIAN, parse, print, type CalendarAst } from "../src/seshat";
import { calendarOfDefinition, mergeCalendar, type CalendarDraft } from "../src/studio/model/definition";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { blastRadius, describeBlast } from "../src/plugin/time/blast";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
const DEF: CalendarAst = { ...GREGORIAN, seasons: { unit: "year", marks: SEASONS }, bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna" } }] };
const TEXT = print(DEF);

interface Rig {
  settings: WadjetSettings;
  time: TimeRegistry;
  world: World;
  calendars: Calendars;
  events: Array<{ event: string; payload: unknown }>;
  count: (e: string) => number;
  clear: () => void;
  saves: unknown[];
  failNextSave: () => void;
}

/** main.ts's onload wiring, without Obsidian: `stored` is data.json as loaded. */
function rig(stored: unknown = {}): Rig {
  const settings = migrateSettings({ worldSeed: "seed", zones: [zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone], ...(stored as object) });
  const saves: unknown[] = [];
  let fail = false;
  const save = () => {
    if (fail) {
      fail = false;
      return Promise.reject(new Error("disk full"));
    }
    saves.push(JSON.parse(JSON.stringify(settings)));
    return Promise.resolve();
  };
  const time = new TimeRegistry(settings.activeTimeAdapter);
  const internal = new InternalCalendar(settings.calendar, () => settings.currentDayOrdinal, async (d) => {
    settings.currentDayOrdinal = d;
    await save();
  });
  time.register(internal);
  const state = () => ({ seed: settings.worldSeed, zones: settings.zones, eras: settings.eras, overrides: settings.overrides });
  const world = new World(state(), time);
  const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
  const calendars = new Calendars({
    settings: () => settings,
    time,
    world,
    save,
    writeDay: async (d) => {
      settings.currentDayOrdinal = d;
      await save();
    },
    rebuild: () => world.setState(state()),
    emitTimeChanged: () => controller.emitTimeChanged(),
    emitAdaptersChanged: () => world.emit("adapters-changed"),
    syncActiveSubscription: () => controller.syncActiveSubscription(),
  });
  time.onChange((change) => {
    if (calendars.quiet) return;
    controller.syncActiveSubscription();
    if (change.id === settings.activeTimeAdapter) controller.emitTimeChanged();
    world.emit("adapters-changed");
  });
  controller.syncActiveSubscription();
  const events: Rig["events"] = [];
  for (const e of WADJET_EVENTS) world.on(e, (payload) => events.push({ event: e, payload }));
  controller.markReady();
  events.splice(0); // "ready"
  return {
    settings,
    time,
    world,
    calendars,
    events,
    count: (e) => events.filter((x) => x.event === e).length,
    clear: () => void events.splice(0),
    saves,
    failNextSave: () => void (fail = true),
  };
}

/** The rejection of `p`, or undefined if it resolved: asserted on directly, so no assertion floats. */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);
const zone = (r: Rig) => r.settings.zones[0]!.id;
const all = (r: Rig) => (r.events.filter((e) => e.event === "profiles-changed").at(-1)?.payload as { all: boolean } | undefined)?.all;
const codeOf = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
  return "no throw";
};

describe("opting in and out", () => {
  test("a world with no definition registers no seshat adapter", () => {
    const r = rig();
    expect(r.calendars.seshat).toBeNull();
    expect(r.time.list()).toEqual(["internal"]);
    expect(r.calendars.fault()).toBeNull();
  });

  test("opt-in stores the canonical text, switches once, and leaves the legacy fields alone", async () => {
    const r = rig();
    const legacy = JSON.stringify({ ...r.settings.calendar });
    await r.calendars.optIn(TEXT.replace("\nBEGIN:VUNIT", "\n\n\nBEGIN:VUNIT")); // extra blank lines: not canonical
    expect(r.settings.activeTimeAdapter).toBe(SESHAT_ID);
    expect(r.settings.calendar.definition).toBe(TEXT);
    const { definition: _d, ...rest } = r.settings.calendar;
    expect(JSON.stringify(rest)).toBe(legacy);
    expect([r.count("time-changed"), r.count("adapters-changed"), r.count("profiles-changed")]).toEqual([1, 1, 0]);
    expect(r.world.now()!.source).toBe(SESHAT_ID);
    expect(r.world.getReport(zone(r), { dayOrdinal: 10 }).provenance.calendarHash).toMatch(/^seshat:/);
    expect(r.saves.length).toBe(1);
  });

  test("opt-out keeps the definition; an edit while out fires no time-changed; opting back in switches once", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    r.clear();
    await r.calendars.setActive("internal");
    expect(r.settings.calendar.definition).toBe(TEXT);
    expect(r.world.now()!.source).toBe("internal");
    expect([r.count("time-changed"), r.count("adapters-changed"), r.count("profiles-changed")]).toEqual([1, 1, 0]);
    r.clear();
    await r.calendars.saveDefinition(print({ ...DEF, seasons: { unit: "year", marks: SEASONS.slice(0, 2) } }));
    expect(r.count("time-changed")).toBe(0);
    expect(all(r)).toBe(false); // the running calendar did not change
    r.clear();
    await r.calendars.setActive(SESHAT_ID);
    expect([r.count("time-changed"), r.count("adapters-changed"), r.count("profiles-changed")]).toEqual([1, 1, 0]);
    expect(r.world.timeAt(0).tags).toContain("season:Spring");
  });

  test("an edit after the switch fires profiles-changed all:true once (wadjet-439), time-changed and adapters-changed once", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    r.clear();
    await r.calendars.saveDefinition(print({ ...DEF, seasons: { unit: "year", marks: SEASONS.map((s, i) => (i === 1 ? { ...s, from: 0.3 } : s)) } }));
    expect([r.count("profiles-changed"), r.count("time-changed"), r.count("adapters-changed")]).toEqual([1, 1, 1]);
    expect(all(r)).toBe(true);
  });

  test("a rename that leaves the hash alone fires adapters-changed but no time-changed and all:false", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    const hash = r.world.calendarHash();
    r.clear();
    await r.calendars.saveDefinition(print({ ...DEF, name: "Renamed" }));
    expect(r.world.calendarHash()).toBe(hash);
    expect([r.count("time-changed"), r.count("adapters-changed")]).toEqual([0, 1]);
    expect(all(r)).toBe(false);
    expect(r.calendars.seshat!.describe().label).toBe("Renamed");
  });

  test("saving the same text again is a no-op", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    r.clear();
    const n = r.saves.length;
    await r.calendars.saveDefinition(TEXT);
    expect(r.saves.length).toBe(n);
    expect(r.events).toEqual([]);
  });
});

describe("what is stored is checked, NFC and canonical", () => {
  test("text that cannot run is refused before anything changes", async () => {
    const r = rig();
    const before = JSON.stringify(r.settings);
    expect(await rejection(r.calendars.optIn("BEGIN:VCALENDAR\nnonsense"))).toBeInstanceOf(DefinitionError);
    const noYear = await rejection(r.calendars.optIn(print({ name: "x", gears: [], units: [{ id: "annum", kind: "cycle", anchor: 0, length: 10 }] })));
    expect(noYear).toBeInstanceOf(DefinitionError);
    expect((noYear as Error).message).toMatch(/id "year"/);
    expect(JSON.stringify(r.settings)).toBe(before);
    expect(r.events).toEqual([]);
    expect(r.time.list()).toEqual(["internal"]);
  });

  test("a syntax error names its line", async () => {
    const r = rig();
    const e = await r.calendars.optIn(TEXT.replace("END:VCALENDAR", "END:VNOTHING")).then(
      () => null,
      (x: unknown) => x as DefinitionError,
    );
    expect(e).toBeInstanceOf(DefinitionError);
    expect(typeof e!.line).toBe("number");
    expect(e!.message).toMatch(/^Line \d+: /);
  });

  test("names are stored NFC", async () => {
    const r = rig();
    const decomposed = "Lu" + "n" + "a" + String.fromCharCode(0x0301); // "Luná" with a combining acute
    const composed = decomposed.normalize("NFC");
    expect(decomposed).not.toBe(composed);
    await r.calendars.optIn(print({ ...DEF, bodies: [{ ...DEF.bodies![0]!, moon: { name: decomposed } }] }));
    const stored = r.settings.calendar.definition as string;
    expect(stored).toContain(`MOON:${composed}`);
    expect(stored).not.toContain(decomposed);
    expect(r.world.now()!.moons![0]!.name).toBe(composed);
  });

  test("a failed opt-in save puts every field back and registers nothing", async () => {
    const r = rig();
    const before = JSON.stringify(r.settings);
    r.failNextSave();
    expect((await rejection(r.calendars.optIn(TEXT)) as Error).message).toBe("disk full");
    expect(JSON.stringify(r.settings)).toBe(before);
    expect("definition" in r.settings.calendar).toBe(false);
    expect(r.time.list()).toEqual(["internal"]);
    expect(r.events).toEqual([]);
  });

  test("a failed definition save keeps the old text and the old engine", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    const hash = r.world.calendarHash();
    r.clear();
    r.failNextSave();
    expect((await rejection(r.calendars.saveDefinition(print({ ...DEF, seasons: { unit: "year", marks: SEASONS.slice(1) } }))) as Error).message).toBe("disk full");
    expect(r.settings.calendar.definition).toBe(TEXT);
    expect(r.world.calendarHash()).toBe(hash);
    expect(r.world.timeAt(0).tags).toContain("season:Spring");
    expect(r.events).toEqual([]);
  });

  test("a failed switch save keeps the old choice", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    r.clear();
    r.failNextSave();
    expect((await rejection(r.calendars.setActive("internal")) as Error).message).toBe("disk full");
    expect(r.settings.activeTimeAdapter).toBe(SESHAT_ID);
    expect(r.world.now()!.source).toBe(SESHAT_ID);
    expect(r.events).toEqual([]);
  });
});

describe("a stored definition that cannot run is a fault, never a fallback", () => {
  const broken = TEXT.replace("GEAR:leap*1", "GEAR:nogear*1");

  test("it loads faulted, keeps its text byte for byte through a save, and World refuses with a code", async () => {
    const r = rig({ activeTimeAdapter: SESHAT_ID, calendar: { definition: broken } });
    expect(r.calendars.fault()).toMatch(/nogear/);
    expect(r.time.active!.id).toBe(SESHAT_ID); // no fallback to internal
    expect(r.world.now()).toBeNull();
    expect(codeOf(() => r.world.getReport(zone(r), { dayOrdinal: 1 }))).toBe(NO_CALENDAR_CODE);
    expect(codeOf(() => r.world.timeAt(1))).toBe(NO_CALENDAR_CODE);
    expect(r.world.calendarHash()).toMatch(/seshat:fault:/);
    await r.calendars.setActive(SESHAT_ID); // any save
    expect((r.saves.at(-1) as WadjetSettings).calendar.definition).toBe(broken);
  });

  test("a world set to run a definition that stores none is a fault, not the internal calendar", () => {
    const r = rig({ activeTimeAdapter: SESHAT_ID });
    expect(r.calendars.fault()).toMatch(/none is stored/);
    expect(r.time.active!.id).toBe(SESHAT_ID);
    expect(codeOf(() => r.world.getReport(zone(r), { dayOrdinal: 1 }))).toBe(NO_CALENDAR_CODE);
  });

  test("a non-string stored value is kept verbatim by migrateSettings and faults", () => {
    const odd = { units: [1, 2, 3] };
    const s = migrateSettings({ calendar: { definition: odd } });
    expect(s.calendar.definition).toEqual(odd);
    const r = rig({ activeTimeAdapter: SESHAT_ID, calendar: { definition: odd } });
    expect(r.calendars.fault()).toMatch(/not text/);
  });

  test("repairing it fires profiles-changed all:true and the world runs again", async () => {
    const r = rig({ activeTimeAdapter: SESHAT_ID, calendar: { definition: broken } });
    r.clear();
    await r.calendars.saveDefinition(TEXT);
    expect(r.calendars.fault()).toBeNull();
    expect(all(r)).toBe(true);
    expect(r.count("time-changed")).toBe(1);
    expect(r.world.getReport(zone(r), { dayOrdinal: 1 }).provenance.calendarHash).toMatch(/^seshat:[0-9a-f]/);
  });

  test("a faulted definition on a world that left seshat makes no difference to its weather", () => {
    const r = rig({ activeTimeAdapter: "internal", calendar: { definition: broken } });
    expect(r.calendars.fault()).not.toBeNull();
    expect(r.world.getReport(zone(r), { dayOrdinal: 1 }).provenance.calendarHash).toMatch(/ical:/);
  });

  test("the stored text is the one parse reads back", () => {
    expect(print(parse(TEXT))).toBe(TEXT);
  });
});

describe("a stored definition is never replaced without being asked (Parallax F1)", () => {
  const broken = TEXT.replace("GEAR:leap*1", "GEAR:nogear*1");
  const other = print({ ...DEF, name: "Other", seasons: { unit: "year", marks: SEASONS.slice(0, 1) } });

  test("broken, then opted out, then opted in to another calendar: refused, the broken text kept byte for byte", async () => {
    const r = rig({ activeTimeAdapter: SESHAT_ID, calendar: { definition: broken } });
    await r.calendars.setActive("internal");
    expect(r.settings.calendar.definition).toBe(broken);
    const e = await rejection(r.calendars.optIn(other));
    expect(e).toBeInstanceOf(DefinitionError);
    expect((e as Error).message).toMatch(/replaces it/);
    expect(r.settings.calendar.definition).toBe(broken);
    expect(r.settings.activeTimeAdapter).toBe("internal");
  });

  test("asked for, it replaces; the same text again needs no asking", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    await r.calendars.setActive("internal");
    await r.calendars.optIn(TEXT); // the stored text itself: nothing is replaced
    expect(r.settings.activeTimeAdapter).toBe(SESHAT_ID);
    await r.calendars.setActive("internal");
    await r.calendars.optIn(other, { replaceStored: true });
    expect(r.settings.calendar.definition).toBe(other);
  });
});

describe("the current day is shared", () => {
  test("seshat's setNow writes the one stored day and its subscribers hear it", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    r.clear();
    await r.calendars.seshat!.setNow(777);
    expect(r.settings.currentDayOrdinal).toBe(777);
    expect(r.world.now()!.dayOrdinal).toBe(777);
    expect(r.count("time-changed")).toBe(1);
  });
});

/**
 * P3c acceptance (bead wadjet-01k.4, docs/SESHAT-v0.md §15.5): a ledger edit,
 * made through the Studio's merge, fires profiles-changed all:true exactly
 * once on Save, and the Save dialog's first affected day is the first day a
 * day-by-day comparison of the two calendars finds.
 */
describe("a ledger edit (P3c acceptance)", () => {
  const ledgerEdit = (stored: string, edit: (l: NonNullable<NonNullable<CalendarDraft["form"]>["ledger"]>) => NonNullable<NonNullable<CalendarDraft["form"]>["ledger"]>): string => {
    const base = calendarOfDefinition(parse(stored));
    const draft: CalendarDraft = { ...structuredClone(base), form: { ...base.form, ledger: edit(base.form!.ledger!) } };
    const m = mergeCalendar(stored, base, draft);
    if (m.kind !== "write") throw new Error(`expected a write, got ${JSON.stringify(m)}`);
    return m.text;
  };
  const firstByHand = (a: SeshatCalendar, b: SeshatCalendar, from: number, to: number): number | null => {
    for (let d = from; d <= to; d++) if (JSON.stringify([a.toContext(d), a.yearOfDay(d)]) !== JSON.stringify([b.toContext(d), b.yearOfDay(d)])) return d;
    return null;
  };

  test("a marked day: one profiles-changed all:true on Save; the first affected day is that day", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    const stored = r.settings.calendar.definition as string;
    const text = ledgerEdit(stored, (l) => ({ ...l, days: [...l.days, { day: 1000, name: "Coronation", tags: ["coronation"] }] }));
    const before = new SeshatCalendar(stored, () => 0);
    const after = new SeshatCalendar(text, () => 0);
    const blast = await blastRadius(before, after, 0, { spells: false, years: 5 });
    expect(blast.first).toBe(1000);
    expect(blast.first).toBe(firstByHand(before, after, blast.from, blast.to));
    expect(describeBlast(blast, (d) => after.format(d), 5)).toContain(`from ${after.format(1000)} through`);
    r.clear();
    await r.calendars.saveDefinition(text);
    expect(r.count("profiles-changed")).toBe(1);
    expect(all(r)).toBe(true);
    expect(r.world.timeAt(1000).tags).toContain("coronation");
  });

  test("a year's start moved by a pin: the first affected day is the start of the year before it (§3: from − 1)", async () => {
    const r = rig();
    await r.calendars.optIn(TEXT);
    const stored = r.settings.calendar.definition as string;
    // Gregorian day 0 is 1970-01-01 (year index 1970); 1973 starts on day 1096; pin it one day later
    const before = new SeshatCalendar(stored, () => 0);
    expect(before.yearStart(1973)).toBe(1096);
    const text = ledgerEdit(stored, (l) => ({ ...l, units: { ...l.units, year: [...(l.units.year ?? []), { kind: "starts", from: 1973, startsOn: 1097 }] } }));
    const after = new SeshatCalendar(text, () => 0);
    expect(after.yearStart(1973)).toBe(1097);
    const blast = await blastRadius(before, after, 0, { spells: false, years: 5 });
    // 1972 gets one day longer, and every day of a year carries its length and its phase in it: 1972 starts on day 730
    expect(before.yearStart(1972)).toBe(730);
    expect(blast.first).toBe(730);
    expect(blast.first).toBe(firstByHand(before, after, blast.from, blast.to));
    r.clear();
    await r.calendars.saveDefinition(text);
    expect(r.count("profiles-changed")).toBe(1);
    expect(all(r)).toBe(true);
  });
});
