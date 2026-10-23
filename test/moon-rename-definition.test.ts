/**
 * Bead wadjet-zoy (follow-up to wadjet-noy): a moon rename on a definition
 * world renames its references in the same save from every path outside the
 * Studio Save — the settings Moons row (the body keeps its id, so a unit
 * following it keeps following), Edit definition (a VBODY that kept its UID),
 * and Undo the last calendar change (back, and forward again on redo). A
 * removal of a followed moon is still refused, with words that point
 * somewhere; a switch to another definition is not a rename; an open Studio's
 * dirty drafts follow.
 */
import { describe, expect, test } from "bun:test";
import { ApiController } from "../src/plugin/api";
import { definitionRowEdit } from "../src/plugin/calendar-rows";
import { Calendars, definitionMoonRenames } from "../src/plugin/calendars";
import { migrateSettings, type DevicePreset, type WadjetSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import type { Modifier, Predicate } from "../src/core/types";
import { GREGORIAN, parse, print, type CalendarAst } from "../src/seshat";
import { calendarOfDefinition } from "../src/studio/model/definition";
import { getCycle, setCycle } from "../src/studio/model/compile";
import { renameMoonsInDrafts, type MoonRenames } from "../src/studio/model/moon-rename";
import { initialState } from "../src/studio/model/state";
import { createStore } from "../src/studio/model/store";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const PHASES = [
  { name: "New", at: 0 },
  { name: "Full", at: 0.5 },
];
/** Gregorian, Luna (with named phases, followed by the lunation unit) and Ember. */
const DEF: CalendarAst = {
  ...GREGORIAN,
  bodies: [
    { id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 }, moon: { name: "Luna", phases: PHASES } },
    { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Ember" } },
  ],
  units: [...GREGORIAN.units, { id: "lunation", kind: "cycle", crossing: { body: { id: "luna", mark: { n: 1, d: 2 } } } }],
};
const TEXT = print(DEF);

const tide: Modifier = { id: "tide", when: { moon: { name: "Luna", phase: [0.9, 0.1] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5 }] };
const deep: Modifier = { id: "deep", when: { all: [{ not: { moon: { name: "Ember", phase: [0, 0.5] } } }, { tag: "season:winter" }] }, apply: [{ param: "temperature.mean", op: "offset", value: -1 }] };
const preset: DevicePreset = { name: "Spring tide", kind: "moon", when: { moon: { name: "Luna", phase: [0.9, 0.1] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.2 }] };

function rig(moonsRenamed?: (r: MoonRenames) => void) {
  const z = zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone;
  z.modifiers.push(structuredClone(tide), structuredClone(deep));
  setCycle(z, "temperature.mean", { moon: "Luna", depth: 2, envelope: [[0.5, 1]] });
  const settings: WadjetSettings = migrateSettings({ worldSeed: "seed", zones: [z], devicePresets: [structuredClone(preset)] });
  const saves: WadjetSettings[] = [];
  let fail = false;
  const save = () => {
    if (fail) {
      fail = false;
      return Promise.reject(new Error("disk full"));
    }
    saves.push(JSON.parse(JSON.stringify(settings)) as WadjetSettings);
    return Promise.resolve();
  };
  const time = new TimeRegistry(settings.activeTimeAdapter);
  time.register(new InternalCalendar(settings.calendar, () => settings.currentDayOrdinal, async () => {}));
  const state = () => ({ seed: settings.worldSeed, zones: settings.zones, eras: settings.eras, overrides: settings.overrides });
  const world = new World(state(), time);
  const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
  const order: string[] = [];
  const calendars = new Calendars({
    settings: () => settings,
    time,
    world,
    save,
    writeDay: async () => {},
    rebuild: () => {
      order.push("rebuild");
      world.setState(state());
    },
    emitTimeChanged: () => controller.emitTimeChanged(),
    emitAdaptersChanged: () => world.emit("adapters-changed"),
    syncActiveSubscription: () => controller.syncActiveSubscription(),
    moonsRenamed: (r) => {
      order.push("renamed");
      moonsRenamed?.(r);
    },
  });
  return { settings, calendars, saves, order, failNextSave: () => void (fail = true) };
}
type Rig = ReturnType<typeof rig>;

/** Every moon name the zone's predicates, its ☾ layer and the device preset name, in order. */
function names(r: Rig): string[] {
  const out: string[] = [];
  const walk = (p: Predicate): void => {
    if ("all" in p) p.all.forEach(walk);
    else if ("any" in p) p.any.forEach(walk);
    else if ("not" in p) walk(p.not);
    else if ("moon" in p) out.push(p.moon.name);
  };
  for (const m of r.settings.zones[0]!.modifiers) if (m.id === "tide" || m.id === "deep") walk(m.when!);
  for (const p of r.settings.devicePresets ?? []) if (p.when) walk(p.when);
  return out;
}
const layer = (r: Rig, moon: string) => getCycle(r.settings.zones[0]!, "temperature.mean", moon) !== null;
const moonsOf = (r: Rig) => (parse(r.settings.calendar.definition as string).bodies ?? []).map((b) => `${b.id}=${b.moon?.name}`);
const follows = (text: string) => JSON.stringify(parse(text).units.find((u) => u.id === "lunation"));

async function opted(cb?: (r: MoonRenames) => void): Promise<Rig> {
  const r = rig(cb);
  await r.calendars.optIn(TEXT);
  r.saves.splice(0);
  r.order.splice(0);
  return r;
}

/** The settings Moons row's edit, saved as the settings tab does. */
async function rowSave(r: Rig, text: string): Promise<void> {
  const edit = definitionRowEdit(r.settings.calendar.definition as string, "moons", text);
  if (!("text" in edit)) throw new Error(`expected a write, got ${JSON.stringify(edit)}`);
  await r.calendars.saveDefinition(edit.text, { renames: edit.renames });
}

const LUNA = "29.53, 0.3, New@0, Full@0.5";
const EMBER = "33, 0";

describe("settings Moons row on a definition world", () => {
  test("a followed moon renamed in the row keeps its body: the unit still follows it, and every reference follows in one save", async () => {
    const r = await opted();
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
    const before = follows(TEXT);
    await rowSave(r, `Selene, ${LUNA}\nEmber, ${EMBER}`);
    expect(moonsOf(r)).toEqual(["luna=Selene", "ember=Ember"]);
    expect(follows(r.settings.calendar.definition as string)).toBe(before);
    expect(names(r)).toEqual(["Selene", "Ember", "Selene"]);
    expect(layer(r, "Selene")).toBe(true);
    expect(layer(r, "Luna")).toBe(false);
    // one save carries the definition and the references
    expect(r.saves.length).toBe(1);
    expect(r.saves[0]!.calendar.definition).toBe(r.settings.calendar.definition);
    expect(JSON.stringify(r.saves[0]!.zones)).toContain('"Selene"');
    expect(r.order).toEqual(["renamed", "rebuild"]);
  });

  test("a swap swaps the references", async () => {
    const r = await opted();
    await rowSave(r, `Ember, ${LUNA}\nLuna, ${EMBER}`);
    expect(moonsOf(r)).toEqual(["luna=Ember", "ember=Luna"]);
    expect(names(r)).toEqual(["Ember", "Luna", "Ember"]);
  });

  test("a line that changed more than its name is a new body: refused for a followed moon, with words that point somewhere", async () => {
    const r = await opted();
    const edit = definitionRowEdit(TEXT, "moons", `Selene, 29.6, 0.3, New@0, Full@0.5\nEmber, ${EMBER}`);
    expect(edit).toEqual({ error: expect.stringContaining('The moon "Luna" cannot be removed: the "lunation" unit follows it. Change that unit first (Edit definition). To rename the moon, change only its name.') });
    expect(JSON.stringify(edit)).not.toContain("Studio");
    // removing it outright is refused the same way
    expect(definitionRowEdit(TEXT, "moons", `Ember, ${EMBER}`)).toEqual({ error: expect.stringContaining('The moon "Luna" cannot be removed') });
    // an unfollowed moon renamed with a new cycle is a delete and a create: references stay
    await rowSave(r, `Luna, ${LUNA}\nCinder, 34, 0`);
    expect(moonsOf(r).some((m) => m.startsWith("ember="))).toBe(false);
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
  });

  test("a failed save puts the references back", async () => {
    const r = await opted();
    r.failNextSave();
    const edit = definitionRowEdit(TEXT, "moons", `Selene, ${LUNA}\nEmber, ${EMBER}`);
    if (!("text" in edit)) throw new Error("expected a write");
    const failed = await r.calendars.saveDefinition(edit.text, { renames: edit.renames }).then(() => undefined, (e: unknown) => e);
    expect(String(failed)).toContain("disk full");
    expect(r.settings.calendar.definition).toBe(TEXT);
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
    expect(r.order).toEqual([]);
  });
});

const withBodies = (bodies: NonNullable<CalendarAst["bodies"]>): string => print({ ...DEF, bodies });

describe("Edit definition", () => {
  test("a VBODY that kept its UID and changed its MOON name renames the references; a UID change does not", async () => {
    const r = await opted();
    await r.calendars.saveDefinition(withBodies([{ ...DEF.bodies![0]!, moon: { name: "Selene", phases: PHASES } }, DEF.bodies![1]!]), { renames: "byUid" });
    expect(names(r)).toEqual(["Selene", "Ember", "Selene"]);
    expect(r.saves.length).toBe(1);
    await r.calendars.saveDefinition(withBodies([{ ...DEF.bodies![0]!, moon: { name: "Selene", phases: PHASES } }, { ...DEF.bodies![1]!, id: "cinder", moon: { name: "Cinder" } }]), { renames: "byUid" });
    expect(names(r)).toEqual(["Selene", "Ember", "Selene"]);
  });

  test("a switch (no renames asked for) never renames, even when a UID repeats", async () => {
    const r = await opted();
    await r.calendars.optIn(withBodies([{ ...DEF.bodies![0]!, moon: { name: "Selene", phases: PHASES } }, DEF.bodies![1]!]));
    expect(moonsOf(r)[0]).toBe("luna=Selene");
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
  });
});

describe("Undo the last calendar change", () => {
  test("undo renames the references back and redo forward again, each in its one save", async () => {
    const r = await opted();
    await rowSave(r, `Ember, ${LUNA}\nLuna, ${EMBER}`); // a swap, the hardest case
    expect(names(r)).toEqual(["Ember", "Luna", "Ember"]);
    await r.calendars.undo();
    expect(moonsOf(r)).toEqual(["luna=Luna", "ember=Ember"]);
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
    expect(layer(r, "Luna")).toBe(true);
    await r.calendars.undo();
    expect(moonsOf(r)).toEqual(["luna=Ember", "ember=Luna"]);
    expect(names(r)).toEqual(["Ember", "Luna", "Ember"]);
    expect(r.saves.length).toBe(3);
    expect(JSON.stringify(r.saves[1]!.zones)).toBe(JSON.stringify(r.saves[0]!.zones).replace(/Ember|Luna/g, (m) => (m === "Ember" ? "Luna" : "Ember")));
  });

  test("undoing a switch to a definition that reuses a UID with another orbit renames nothing", async () => {
    const r = await opted();
    const other = withBodies([{ ...DEF.bodies![0]!, period: { n: 30, d: 1 }, moon: { name: "Selene", phases: PHASES } }, DEF.bodies![1]!]);
    expect([...definitionMoonRenames(TEXT, other)]).toEqual([["Luna", "Selene"]]);
    expect([...definitionMoonRenames(TEXT, other, { sameOrbit: true })]).toEqual([]);
    await r.calendars.saveDefinition(other);
    await r.calendars.undo();
    expect(moonsOf(r)[0]).toBe("luna=Luna");
    expect(names(r)).toEqual(["Luna", "Ember", "Luna"]);
    expect(r.order).not.toContain("renamed");
  });
});

describe("an open Studio", () => {
  test("its dirty drafts take the rename before the refresh, keeping their unsaved edits; history follows", async () => {
    let store: ReturnType<typeof createStore> | null = null;
    const r = await opted((renames) => store!.amend((d) => renameMoonsInDrafts(d, renames)));
    // main.ts studioSettings() on a world running its definition
    const studioSettings = () => ({ ...r.settings, calendar: calendarOfDefinition(parse(r.settings.calendar.definition as string)), calendarSource: "seshat" as const });
    store = createStore(initialState(studioSettings(), r.settings.zones[0]!.id), () => {});
    const id = r.settings.zones[0]!.id;
    store.update((s) => (s.zones[id]!.name = "Greywold (edited)"), { history: true });
    expect(store.dirtyZones().has(id)).toBe(true);
    await rowSave(r, `Selene, ${LUNA}\nEmber, ${EMBER}`);
    const z = store.get().zones[id]!;
    expect(z.name).toBe("Greywold (edited)");
    expect(z.modifiers.find((m) => m.id === "tide")!.when).toEqual({ moon: { name: "Selene", phase: [0.9, 0.1] } });
    expect(getCycle(z, "temperature.mean", "Selene")).not.toBeNull();
    expect(store.get().world.devicePresets[0]!.when).toEqual({ moon: { name: "Selene", phase: [0.9, 0.1] } });
    // the step before the user's edit names the moon as settings do now, too
    store.undo();
    expect(store.get().zones[id]!.modifiers.find((m) => m.id === "tide")!.when).toEqual({ moon: { name: "Selene", phase: [0.9, 0.1] } });
  });
});
