/**
 * `api.seshat` (docs/API.md §1b): reads and compile over a real engine. The opening of the editor is
 * walked in Obsidian (e2e step 102).
 */
import { describe, expect, test } from "bun:test";
import { ApiController, UNLOADED_CODE } from "../src/plugin/api";
import { Calendars } from "../src/plugin/calendars";
import { migrateSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import { GREGORIAN, HARPTOS, print, type SlotsUnitAst } from "../src/seshat";

const GREGORIAN_TEXT = print(GREGORIAN);
const HARPTOS_TEXT = print(HARPTOS);

function rig(opts: { openEditor?: () => Promise<void> } = {}) {
  const settings = migrateSettings({ worldSeed: "seed", zones: [] });
  const save = () => Promise.resolve();
  const time = new TimeRegistry(settings.activeTimeAdapter);
  time.register(new InternalCalendar(settings.calendar, () => settings.currentDayOrdinal, save));
  const state = () => ({ seed: settings.worldSeed, zones: settings.zones, eras: settings.eras, overrides: settings.overrides });
  const world = new World(state(), time);
  const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric", ...(opts.openEditor ? { openCalendarEditor: opts.openEditor } : {}) });
  const calendars = new Calendars({
    settings: () => settings,
    time,
    world,
    save,
    writeDay: save,
    rebuild: () => world.setState(state()),
    emitTimeChanged: () => controller.emitTimeChanged(),
    emitAdaptersChanged: () => world.emit("adapters-changed"),
    syncActiveSubscription: () => controller.syncActiveSubscription(),
  });
  controller.markReady();
  return { api: controller.api, controller, calendars, settings };
}

function compiled(input: Parameters<ReturnType<typeof rig>["api"]["seshat"]["compile"]>[0]) {
  const r = rig().api.seshat.compile(input);
  if ("problems" in r) throw new Error(r.problems[0]!.message);
  return r.calendar;
}

describe("calendar()", () => {
  test("is null on a world that does not run a definition", () => {
    expect(rig().api.seshat.calendar()).toBeNull();
  });

  test("reads the definition the world runs, and follows a save", async () => {
    const { api, calendars } = rig();
    await calendars.optIn(GREGORIAN_TEXT);
    const first = api.seshat.calendar()!;
    expect(first.name).toBe("Gregorian");
    expect(api.seshat.calendar()).toBe(first); // one view until the definition changes
    await calendars.saveDefinition(GREGORIAN_TEXT.replace("NAME:Gregorian", "NAME:Mine"));
    const second = api.seshat.calendar()!;
    expect(second.name).toBe("Mine");
    expect(first.name).toBe("Gregorian"); // a view is a snapshot
    expect(second.hash).toBe(first.hash); // a name reaches no day
  });

  test("is null again after switching back to the internal calendar", async () => {
    const { api, calendars } = rig();
    await calendars.optIn(GREGORIAN_TEXT);
    await calendars.setActive("internal");
    expect(api.seshat.calendar()).toBeNull();
  });
});

describe("a view", () => {
  // 2026-11-01 is day 20758 of the Gregorian definition, whose day 0 is 1970-01-01
  const DAY = 20758;

  test("answers structure and dates", () => {
    const c = compiled(GREGORIAN_TEXT);
    expect(c.definition.units.map((u) => u.id)).toEqual(["year", "month", "week", "weekday"]);
    expect(c.occurrenceAt("month", DAY)).toEqual({ index: 10, start: DAY, length: 30 });
    expect(c.labelAt("month", DAY)?.name).toBe("November");
    expect(c.labelAt("weekday", DAY)?.name).toBe("Sunday");
    expect(c.indexAt("year", DAY)).toBe(2026);
    expect(c.start("year", 2026)).toBe(20454);
    expect(c.length("year", 2024)).toBe(366);
    expect(c.slotLengths("month", [2024])[1]).toBe(29);
    expect(c.dayOf("month", [2026], 10, 0)).toBe(DAY);
    expect(c.positionOf("month", DAY)).toEqual({ index: 10, offset: 0 });
  });

  test("formats and parses, in the default and a named format", () => {
    const c = compiled(GREGORIAN_TEXT);
    expect(c.format(DAY)).toBe("2026-11-01");
    expect(c.format(DAY, "long")).toBe("Sunday 1 November 2026");
    expect(c.parse("2026-11-01")).toBe(DAY);
    expect(c.parse("not a date")).toBeNull();
    expect(() => c.format(DAY, "nope")).toThrow();
  });

  test("a filler day has no place in a unit under it", () => {
    const c = compiled(HARPTOS_TEXT);
    const midwinter = c.start("year", 0) + 30;
    expect(c.labelAt("month", midwinter)?.name).toBe("Midwinter");
    expect(c.occurrenceAt("tenday", midwinter)).toBeNull();
    expect(c.positionOf("tenday", midwinter)).toBeNull();
  });

  test("rules: holds reads the calendar; a rule that does not fit, or that reads weather, throws", () => {
    const c = compiled(GREGORIAN_TEXT);
    const sundays = { kind: "recur", freq: "week", by: [{ unit: "weekday", label: ["Sunday"] }] } as const;
    expect(c.holds(sundays, DAY)).toBe(true);
    expect(c.holds(sundays, DAY + 1)).toBe(false);
    expect(() => c.holds({ kind: "host", key: "regime", arg: "wet" }, DAY)).toThrow(RangeError);
    expect(() => c.holds({ kind: "index", unit: "nope" }, DAY)).toThrow(RangeError);
  });

  test("the caller cannot reach into the calendar", () => {
    const c = compiled(GREGORIAN_TEXT);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.definition.units[1])).toBe(true);
    expect(() => {
      (c.definition as { name: string }).name = "x";
    }).toThrow();
    const label = c.labelAt("month", DAY) as { name?: string };
    label.name = "Changed";
    expect(c.labelAt("month", DAY)?.name).toBe("November");
    expect(c.slotLengths("month", [2026])).not.toBe(c.slotLengths("month", [2026]));
  });
});

describe("compile()", () => {
  test("takes text or an AST, and they agree", () => {
    const fromAst = compiled(GREGORIAN);
    const fromText = compiled(GREGORIAN_TEXT);
    expect(fromAst.text).toBe(fromText.text);
    expect(fromAst.hash).toBe(fromText.hash);
  });

  test("touches nothing in the world", () => {
    const { api, settings } = rig();
    const before = JSON.stringify(settings);
    expect("calendar" in api.seshat.compile(GREGORIAN_TEXT)).toBe(true);
    expect(JSON.stringify(settings)).toBe(before);
    expect(api.seshat.calendar()).toBeNull();
  });

  test("reports problems instead of throwing", () => {
    const { compile } = rig().api.seshat;
    const problems = (r: ReturnType<typeof compile>) => ("problems" in r ? r.problems : []);
    expect(problems(compile("not a calendar")).length).toBeGreaterThan(0);
    expect(problems(compile(GREGORIAN_TEXT.replace("UID:year", "UID:annum"))).length).toBeGreaterThan(0); // it must be able to run a world
    expect(problems(compile({ ...GREGORIAN, units: [] })).length).toBeGreaterThan(0);
    expect(problems(compile({ nonsense: true } as never)).length).toBeGreaterThan(0);
    expect(problems(compile(7 as never))[0]!.message).toContain("Seshat text or a calendar AST");
  });
});

describe("openEditor()", () => {
  test("asks the host to open it", async () => {
    let opened = 0;
    await rig({ openEditor: () => (opened++, Promise.resolve()) }).api.seshat.openEditor();
    expect(opened).toBe(1);
  });

  test("rejects where there is no editor to open", async () => {
    const e = (await rig().api.seshat.openEditor().catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("no calendar editor");
  });
});

describe("after unload", () => {
  test("every member is dead", async () => {
    const { api, controller } = rig();
    controller.unload(() => {});
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return "no throw";
    };
    expect(code(() => api.seshat.calendar())).toBe(UNLOADED_CODE);
    expect(code(() => api.seshat.compile(GREGORIAN_TEXT))).toBe(UNLOADED_CODE);
    const e = (await api.seshat.openEditor().catch((x: unknown) => x)) as { code?: string };
    expect(e.code).toBe(UNLOADED_CODE);
  });
});

describe("docs/API.md §1b", () => {
  test("the worked example is in the doc as written here, and does what the doc says", async () => {
    const doc = await Bun.file(new URL("../docs/API.md", import.meta.url)).text();
    const section = doc.replaceAll("\r\n", "\n").slice(doc.indexOf("## 1b."), doc.indexOf("## 2. Events"));
    const calendar = compiled(GREGORIAN_TEXT);
    const day = 20758;
    // the block below is the doc's, line for line
    const monthUnit = calendar.definition.units.find((u) => u.id === "month") as SlotsUnitAst;
    const months = monthUnit.slots.map((s) => s.name);
    const thisMonth = calendar.labelAt("month", day)?.name;
    const held = calendar.occurrenceAt("month", day)!;
    const next = held.start + held.length;
    const year = calendar.indexAt("year", day);
    for (const line of [
      'const monthUnit = calendar.definition.units.find((u) => u.id === "month");',
      "const months = monthUnit.slots.map((s) => s.name);",
      'const thisMonth = calendar.labelAt("month", day)?.name;',
      'const held = calendar.occurrenceAt("month", day);',
      "const next = held.start + held.length;",
      'const year = calendar.indexAt("year", day);',
    ])
      expect(section).toContain(line);
    expect(months.slice(0, 2)).toEqual(["January", "February"]);
    expect(thisMonth).toBe("November");
    expect(next).toBe(20788);
    expect(year).toBe(2026);
    expect(section).toContain('`thisMonth` is `"November"` and `next` is `20788`');
  });
});
