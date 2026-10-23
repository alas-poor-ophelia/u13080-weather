/**
 * Bead wadjet-7md: a saved world follows a data.json that changed from outside
 * (Obsidian Sync). The harness is main.ts's wiring without Obsidian: a fake
 * disk behind FirstSave + SaveQueue, Calendars, World and the API controller,
 * and `follow()` doing what Plugin.followExternal does. Nothing is written in
 * response to an outside change.
 */
import { describe, expect, test } from "bun:test";
import { ApiController } from "../src/plugin/api";
import { Calendars } from "../src/plugin/calendars";
import { WADJET_EVENTS } from "../src/plugin/events";
import { FirstSave, readExternal, SaveQueue } from "../src/plugin/persist";
import { migrateSettings, type WadjetSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import { GREGORIAN, print, type CalendarAst } from "../src/seshat";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const DEF: CalendarAst = { ...GREGORIAN, bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna" } }] };
const TEXT = print(DEF);
const TEXT2 = print({ ...DEF, bodies: [{ id: "luna", period: { n: 2801, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna" } }] });

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** main.ts's wiring over a fake disk holding `stored`, already loaded (a saved world). */
function plugin(stored: Record<string, unknown>) {
  const p = {
    disk: clone(stored) as unknown,
    writes: [] as unknown[],
    reads: 0,
    /** while set, a write waits on it before resolving (it has already reached the disk) */
    gate: null as Promise<void> | null,
    failRead: false,
    settings: migrateSettings(clone(stored)),
    events: [] as Array<{ event: string; payload: unknown }>,
    logs: [] as string[],
  };
  const read = () => {
    p.reads++;
    if (p.failRead) return Promise.reject(new SyntaxError("Unexpected end of JSON input"));
    return Promise.resolve(clone(p.disk));
  };
  const first = new FirstSave(read, () => {});
  first.noteDisk(p.disk);
  const queue = new SaveQueue(
    first.guard(async (data) => {
      const copy = clone(data);
      p.writes.push(copy);
      p.disk = copy;
      if (p.gate) await p.gate;
    }),
    () => p.settings,
    () => true,
  );
  const time = new TimeRegistry(p.settings.activeTimeAdapter);
  const internal = new InternalCalendar(p.settings.calendar, () => p.settings.currentDayOrdinal);
  time.register(internal);
  const state = () => ({ seed: p.settings.worldSeed, zones: p.settings.zones, eras: p.settings.eras, overrides: p.settings.overrides });
  const world = new World(state(), time);
  const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
  const calendars = new Calendars({
    settings: () => p.settings,
    time,
    world,
    save: () => queue.save(),
    writeDay: async (d) => {
      p.settings.currentDayOrdinal = d;
      await queue.save();
    },
    rebuild: () => world.setState(state()),
    emitTimeChanged: () => controller.emitTimeChanged(),
    emitAdaptersChanged: () => world.emit("adapters-changed"),
    syncActiveSubscription: () => controller.syncActiveSubscription(),
  });
  controller.syncActiveSubscription();
  for (const e of WADJET_EVENTS) world.on(e, (payload) => p.events.push({ event: e, payload }));
  controller.markReady();
  p.events.splice(0);
  /** Plugin.followExternal */
  const follow = async (): Promise<boolean> => {
    const found = await readExternal({ read, queue, first, alive: () => true, log: (m) => p.logs.push(m) });
    if (found === null || first.current !== "saved") return false;
    const next: WadjetSettings = migrateSettings(found);
    first.noteDisk(found);
    calendars.follow(() => {
      p.settings = next;
      internal.update(next.calendar);
    });
    return true;
  };
  const count = (e: string) => p.events.filter((x) => x.event === e).length;
  const all = () => (p.events.filter((e) => e.event === "profiles-changed").at(-1)?.payload as { all: boolean } | undefined)?.all;
  return Object.assign(p, { queue, first, calendars, world, time, follow, count, all });
}

const base = () => clone(migrateSettings({ worldSeed: "seed", zones: [zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone] })) as unknown as Record<string, unknown>;

describe("a saved world follows an outside data.json (bead wadjet-7md)", () => {
  test("an outside change replaces the settings and fires profiles-changed all:true for a new seed; nothing is written", async () => {
    const p = plugin(base());
    p.disk = { ...(p.disk as object), worldSeed: "synced" };
    expect(await p.follow()).toBe(true);
    expect(p.settings.worldSeed).toBe("synced");
    expect(p.world.seed).toBe("synced");
    expect(p.count("profiles-changed")).toBe(1);
    expect(p.all()).toBe(true);
    expect(p.count("adapters-changed")).toBe(0);
    expect(p.count("time-changed")).toBe(0);
    expect(p.writes).toEqual([]);
  });

  test("a renamed zone fires profiles-changed for that zone; a moved day fires time-changed", async () => {
    const p = plugin(base());
    const d = clone(p.disk) as WadjetSettings;
    d.zones[0]!.name = "Northwold";
    d.currentDayOrdinal = 40;
    p.disk = d;
    expect(await p.follow()).toBe(true);
    expect(p.settings.zones[0]!.name).toBe("Northwold");
    expect(p.count("time-changed")).toBe(1);
    expect(p.writes).toEqual([]);
  });

  test("Wadjet's own write echoing is ignored, and so is an outside copy already adopted", async () => {
    const p = plugin(base());
    p.settings.worldSeed = "local";
    await p.queue.save();
    expect(await p.follow()).toBe(false);
    p.disk = { ...(p.disk as object), worldSeed: "synced" };
    expect(await p.follow()).toBe(true);
    p.events.splice(0);
    expect(await p.follow()).toBe(false);
    expect(p.events).toEqual([]);
    expect(p.writes.length).toBe(1);
  });

  test("a change during a running save waits for it, then reads and applies the outside copy without writing", async () => {
    const p = plugin(base());
    let open!: () => void;
    p.gate = new Promise((r) => (open = r));
    p.settings.worldSeed = "local";
    const saving = p.queue.save();
    await Promise.resolve();
    expect(p.queue.busy).toBe(true);
    const following = p.follow();
    // Sync lands its copy while the local write is still running
    p.disk = { ...(p.disk as object), worldSeed: "synced" };
    await Promise.resolve();
    expect(p.reads).toBe(0);
    open();
    await saving;
    expect(await following).toBe(true);
    expect(p.reads).toBe(1);
    expect(p.settings.worldSeed).toBe("synced");
    expect(p.writes.length).toBe(1);
  });

  test("a change during a running save that the save overwrote is that save's echo: nothing changes", async () => {
    const p = plugin(base());
    let open!: () => void;
    p.gate = new Promise((r) => (open = r));
    p.settings.worldSeed = "local";
    const saving = p.queue.save();
    const following = p.follow();
    open();
    await saving;
    expect(await following).toBe(false);
    expect(p.settings.worldSeed).toBe("local");
  });

  test("a read that fails or is not settings is ignored: the settings stay, nothing is written", async () => {
    const p = plugin(base());
    const before = p.settings;
    p.failRead = true;
    expect(await p.follow()).toBe(false);
    p.failRead = false;
    for (const bad of [null, "{\"worldSeed\":", [1, 2], 7]) {
      p.disk = bad;
      expect(await p.follow()).toBe(false);
    }
    expect(p.settings).toBe(before);
    expect(p.events).toEqual([]);
    expect(p.logs.length).toBe(5);
    expect(p.writes).toEqual([]);
  });

  test("a changed definition text remounts the calendar: its hash moves, all:true, time-changed and adapters-changed", async () => {
    const p = plugin({ ...base(), activeTimeAdapter: "seshat", calendar: { ...(base().calendar as object), definition: TEXT } });
    const seshat = p.calendars.seshat!;
    expect(p.time.active).toBe(seshat);
    const hash = seshat.configHash();
    const d = clone(p.disk) as WadjetSettings;
    d.calendar.definition = TEXT2;
    p.disk = d;
    expect(await p.follow()).toBe(true);
    expect(p.calendars.seshat).toBe(seshat);
    expect(seshat.configHash()).not.toBe(hash);
    expect(p.all()).toBe(true);
    expect(p.count("time-changed")).toBe(1);
    expect(p.count("adapters-changed")).toBe(1);
    expect(p.writes).toEqual([]);
  });

  test("a switch to a stored definition from outside mounts it and makes it the running calendar", async () => {
    const p = plugin(base());
    expect(p.calendars.seshat).toBeNull();
    const d = clone(p.disk) as WadjetSettings;
    d.calendar.definition = TEXT;
    d.activeTimeAdapter = "seshat";
    p.disk = d;
    expect(await p.follow()).toBe(true);
    expect(p.calendars.seshat).not.toBeNull();
    expect(p.time.active).toBe(p.calendars.seshat!);
    expect(p.count("time-changed")).toBe(1);
    expect(p.count("adapters-changed")).toBe(1);
  });

  test("the next local save writes the outside copy plus the local edit, not the stale copy", async () => {
    const p = plugin(base());
    const d = clone(p.disk) as WadjetSettings;
    d.zones[0]!.name = "Northwold";
    p.disk = d;
    await p.follow();
    p.settings.worldSeed = "local";
    await p.queue.save();
    const w = p.writes.at(-1) as WadjetSettings;
    expect(w.zones[0]!.name).toBe("Northwold");
    expect(w.worldSeed).toBe("local");
  });

  test("a new world that has not saved is not followed (it yields instead; bead wadjet-1ou)", async () => {
    const p = plugin(base());
    p.first.startNew();
    p.first.external();
    p.disk = { ...(p.disk as object), worldSeed: "synced" };
    expect(await p.follow()).toBe(false);
    expect(p.first.current).toBe("yielded");
  });
});
