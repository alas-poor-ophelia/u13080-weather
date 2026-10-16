/**
 * The public API object, driven without Obsidian through ApiController (the
 * same object main.ts hands out): surface, validation, events, unload, time
 * control, async resolvers, interpreters, the frontmatter resolver and the
 * code block's zone fallback. Classification and glyph tables are tested
 * with src/core/classify.ts and src/core/glyphs.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ApiController, API_VERSION, UNLOADED_CODE, type WadjetAPI } from "../src/plugin/api";
import { parseCodeblock, pickCodeblockZone } from "../src/plugin/codeblock-parse";
import { WADJET_EVENTS, type WadjetEventPayloads } from "../src/plugin/events";
import { frontmatterResolver } from "../src/plugin/frontmatter-resolver";
import { formatInterpretation, type WeatherInterpreter } from "../src/plugin/interpreters";
import { TimeRegistry, type TimeAdapter } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World, MAX_DAY_ORDINAL, MAX_RANGE_DAYS, type WorldState } from "../src/plugin/world";
import { SaveQueue, setAndSave } from "../src/plugin/persist";
import { glyph as coreGlyph } from "../src/core/glyphs";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import type { WeatherReport } from "../src/core/report";
import type { ZoneProfile } from "../src/core/types";
import { API_KEYS } from "./types/conformance";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const zoneNamed = (name: string, extra: Partial<ZoneProfile> = {}): ZoneProfile => ({ ...zoneFromPreset({ name, preset: fjord, existingIds: new Set() }).zone, ...extra });

const SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

interface Harness {
  api: WadjetAPI;
  controller: ApiController;
  world: World;
  time: TimeRegistry;
  cal: InternalCalendar;
  day: { value: number };
  saves: number[];
  events: Array<{ event: string; payload: unknown }>;
}

function harness(opts: { state?: Partial<WorldState>; writeDelay?: Promise<void> } = {}): Harness {
  const day = { value: 100 };
  const saves: number[] = [];
  const cal = new InternalCalendar(
    { yearLength: 360, epochYear: 1, moons: [], seasons: SEASONS },
    () => day.value,
    async (d) => {
      day.value = d;
      if (opts.writeDelay) await opts.writeDelay;
      saves.push(d);
    },
  );
  const time = new TimeRegistry("internal");
  time.register(cal);
  const world = new World({ seed: "s", zones: [zoneNamed("Greywold"), zoneNamed("Ashfall Coast", { flipSeasons: true })], overrides: [], ...opts.state }, time);
  world.timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) }; // no window under bun
  const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
  controller.syncActiveSubscription();
  // main.ts wiring: registry changes resubscribe and fire time/adapters events
  time.onChange((c) => {
    controller.syncActiveSubscription();
    if (c.id === "internal" || c.id === time.active?.id) controller.emitTimeChanged();
    world.emit("adapters-changed");
  });
  const events: Harness["events"] = [];
  for (const e of WADJET_EVENTS) world.on(e, (payload) => events.push({ event: e, payload }));
  controller.markReady();
  return { api: controller.api, controller, world, time, cal, day, saves, events };
}

/**
 * The members of the `interface WadjetAPI { ... }` block in `text`, one
 * normalised `name:signature` string each, in written order: line comments
 * dropped, members split on top-level `;`, whitespace removed around
 * punctuation and collapsed elsewhere. All three files write members in
 * property syntax, so the strings compare directly.
 */
function wadjetApiMembers(text: string): string[] {
  const block = text.match(/interface WadjetAPI \{([\s\S]*?)\n\}/);
  if (!block) throw new Error("no interface WadjetAPI block");
  const body = block[1]!.replace(/\/\/[^\n]*/g, "");
  const members: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if ("({[<".includes(ch)) depth++;
    else if (")}]".includes(ch) || (ch === ">" && !cur.endsWith("="))) depth--;
    if (ch === ";" && depth === 0) {
      members.push(cur);
      cur = "";
    } else cur += ch;
  }
  members.push(cur);
  return members
    .map((m) =>
      m
        .replace(/\s+/g, " ")
        .replace(/\s*([(){}[\]<>:;,|&?=])\s*/g, "$1")
        .trim(),
    )
    .filter(Boolean);
}

/** What a promise rejected with (undefined if it resolved). */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

const of = <E extends keyof WadjetEventPayloads>(h: Harness, e: E) => h.events.filter((x) => x.event === e).map((x) => x.payload as WadjetEventPayloads[E]);

let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("surface", () => {
  test("Object.keys(api) is exactly the WadjetAPI member list", () => {
    const { api } = harness();
    expect(Object.keys(api).sort()).toEqual([...API_KEYS].sort());
    expect(api.apiVersion).toBe(1);
    expect(API_VERSION).toBe(1);
  });

  test("docs/API.md and README.md WadjetAPI blocks match the d.ts member for member, signature for signature", async () => {
    const dts = await Bun.file(new URL("../types/wadjet.d.ts", import.meta.url)).text();
    const expected = wadjetApiMembers(dts);
    expect(expected.map((m) => m.slice(0, m.indexOf(":"))).sort()).toEqual([...API_KEYS].sort());
    for (const doc of ["../docs/API.md", "../README.md"]) {
      const text = await Bun.file(new URL(doc, import.meta.url)).text();
      expect({ doc, members: wadjetApiMembers(text) }).toEqual({ doc, members: expected });
    }
  });

  test("the signature normaliser sees a changed type, not only a changed name", () => {
    const block = (sig: string) => `interface WadjetAPI {\n  format: ${sig}; // a comment\n  interpret: <T = unknown>(id: string, options?: { a: number; b?: string }) => T;\n  now: () => TimeContext | null;\n}`;
    const base = wadjetApiMembers(block("(dayOrdinal: number) => string"));
    expect(base).toHaveLength(3);
    expect(wadjetApiMembers(block("( dayOrdinal :number )=>\n    string"))).toEqual(base);
    expect(wadjetApiMembers(block("(dayOrdinal: number) => string | null"))).not.toEqual(base);
  });
});

describe("getReport / getRange validation", () => {
  test("time defaults to now() as a daily report", () => {
    const h = harness();
    const r = h.api.getReport("greywold");
    expect(r.dayOrdinal).toBe(100);
    expect(r.hour).toBeUndefined();
    expect(r).toEqual(h.api.getReport("greywold", { dayOrdinal: 100 }));
  });

  test("no current day: a clear error asking for a time", () => {
    const h = harness();
    const opaque: TimeAdapter = { id: "none", now: () => null, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "none" }), configHash: () => "n" };
    h.time.register(opaque);
    h.time.setActive("none");
    expect(() => h.api.getReport("greywold")).toThrow("The active calendar has no current day; pass a time.");
  });

  test("non-integer dayOrdinal and bad hours throw, naming the value", () => {
    const { api } = harness();
    expect(() => api.getReport("greywold", { dayOrdinal: 1.5 })).toThrow(TypeError);
    expect(() => api.getReport("greywold", { dayOrdinal: 1.5 })).toThrow(/1\.5/);
    expect(() => api.getReport("greywold", { dayOrdinal: Number.NaN })).toThrow(/NaN/);
    expect(() => api.getReport("greywold", {} as { dayOrdinal: number })).toThrow(/undefined/);
    expect(() => api.getReport("greywold", 5 as unknown as { dayOrdinal: number })).toThrow(TypeError);
    expect(() => api.getReport("greywold", { dayOrdinal: 1, hour: 24 })).toThrow(RangeError);
    expect(() => api.getReport("greywold", { dayOrdinal: 1, hour: -1 })).toThrow(RangeError);
    expect(api.getReport("greywold", { dayOrdinal: 1, hour: 23.5 }).hour).toBe(23.5);
  });

  test("getRange: integer bounds, from <= to, at most 3660 days", () => {
    const { api } = harness();
    expect(() => api.getRange("greywold", 0.5, 3)).toThrow(TypeError);
    expect(() => api.getRange("greywold", 0, Infinity)).toThrow(TypeError);
    expect(() => api.getRange("greywold", 5, 4)).toThrow(RangeError);
    expect(() => api.getRange("greywold", 0, MAX_RANGE_DAYS)).toThrow(RangeError);
    expect(api.getRange("greywold", 0, MAX_RANGE_DAYS - 1)).toHaveLength(MAX_RANGE_DAYS);
  });

  test("describe: anything but 'prose' is 'short'", () => {
    const { api } = harness();
    const r = api.getReport("greywold", { dayOrdinal: 3 });
    const short = api.describe(r, "short");
    expect(api.describe(r)).toBe(short);
    expect(api.describe(r, "bogus" as "short")).toBe(short);
    expect(api.describe(r, { style: "prose" } as unknown as "short")).toBe(short);
    expect(api.describe(r, "prose")).not.toBe(short);
  });
});

describe("timeAt", () => {
  test("matches the adapter plus era tags; with a zone id the flip is applied", () => {
    const h = harness({ state: { eras: [{ name: "Ash", from: 1 }] } });
    const plain = h.api.timeAt(10);
    expect(plain.tags).toEqual(["season:Spring", "era:Ash"]);
    expect(h.api.timeAt(10, "greywold").tags).toEqual(plain.tags);
    expect(h.api.timeAt(10, "ashfall-coast").tags).toEqual(["season:Autumn", "era:Ash"]);
    expect(() => h.api.timeAt(10, "nope")).toThrow(RangeError);
    expect(() => h.api.timeAt(1.2)).toThrow(TypeError);
  });
});

describe("format / parse", () => {
  test("go through the active adapter, with Day N / integer fallbacks", () => {
    const h = harness();
    expect(h.api.format(365)).toBe(h.cal.format(365));
    expect(h.api.parse("2-6")).toBe(365);
    expect(h.api.parse("nonsense")).toBeNull();
    const bare: TimeAdapter = { id: "bare", now: () => null, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "bare" }), configHash: () => "b" };
    h.time.register(bare);
    h.time.setActive("bare");
    expect(h.api.format(7)).toBe("Day 7");
    expect(h.api.parse(" -12 ")).toBe(-12);
    expect(h.api.parse("2-6")).toBeNull();
    expect(() => h.api.format(1.5)).toThrow(TypeError);
  });
});

describe("events", () => {
  test("payloads are frozen objects carrying their type", () => {
    const h = harness();
    const ready = of(h, "ready");
    expect(ready).toEqual([{ type: "ready" }]);
    expect(Object.isFrozen(ready[0])).toBe(true);
  });

  test("a throwing listener is logged and the others still run", () => {
    const h = harness();
    let reached = false;
    h.api.on("adapters-changed", () => {
      throw new Error("boom");
    });
    h.api.on("adapters-changed", () => (reached = true));
    h.world.emit("adapters-changed");
    expect(reached).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  test("profiles-changed diffs per zone: profile, name, flip, overrides; seed/eras/bands mean all", () => {
    const h = harness();
    const [grey, ash] = [zoneNamed("Greywold"), zoneNamed("Ashfall Coast", { flipSeasons: true })];
    const last = () => of(h, "profiles-changed").at(-1)!;
    const base: WorldState = { seed: "s", zones: [grey, ash], overrides: [] };

    h.world.setState(base);
    expect(last()).toEqual({ type: "profiles-changed", all: false, zoneIds: [] });
    expect(Object.isFrozen(last().zoneIds)).toBe(true);

    h.world.setState({ ...base, overrides: [{ zoneId: "greywold", dayOrdinal: 3, patch: { note: "x" } }] });
    expect(last()).toEqual({ type: "profiles-changed", all: false, zoneIds: ["greywold"] });

    h.world.setState({ ...base, zones: [grey, { ...ash, name: "Ash coast" }] });
    expect(last().zoneIds).toEqual(["greywold", "ashfall-coast"]); // the override went away, the name changed

    h.world.setState({ ...base, zones: [grey, { ...ash, flipSeasons: false }] });
    expect(last().zoneIds).toEqual(["ashfall-coast"]);

    h.world.setState({ ...base, zones: [grey] });
    expect(last().zoneIds).toEqual(["ashfall-coast"]); // removed

    h.world.setState({ ...base, zones: [grey, ash, zoneNamed("New")] });
    expect(last().zoneIds).toEqual(["ashfall-coast", "new"]); // added back, added

    // in-place mutation (what the settings UI does) is still seen
    const mutable: WorldState = { seed: "s", zones: [zoneNamed("Greywold")], overrides: [] };
    h.world.setState(mutable);
    mutable.zones[0]!.climate.temperature.mean = { kind: "constant", value: 99 } as never;
    h.world.setState(mutable);
    expect(last()).toEqual({ type: "profiles-changed", all: false, zoneIds: ["greywold"] });

    h.world.setState({ ...mutable, seed: "other" });
    expect(last()).toEqual({ type: "profiles-changed", all: true, zoneIds: ["greywold"] });
    h.world.setState({ ...mutable, seed: "other", eras: [{ name: "Ash", from: 1 }] });
    expect(last().all).toBe(true);
  });

  test("time-changed carries the current day and the active adapter id", async () => {
    const h = harness();
    await h.api.setNow(42);
    expect(of(h, "time-changed")).toEqual([{ type: "time-changed", current: 42, adapterId: "internal" }]);
  });

  test("resolvers-changed on register and on the first unregister only", () => {
    const h = harness();
    const off = h.api.registerZoneResolver({ id: "x", kinds: ["hex"], resolve: () => null });
    off();
    off();
    expect(of(h, "resolvers-changed")).toHaveLength(2);
  });
});

describe("unload", () => {
  test("flag first, then the unload event, then the workspace event; everything after is dead", async () => {
    const h = harness();
    const order: string[] = [];
    h.api.on("unload", (p) => order.push(`unload:${p.type}:${String(h.api.ready)}`));
    const offTime = h.api.on("time-changed", () => order.push("late"));
    const offResolver = h.api.registerZoneResolver({ id: "r", kinds: ["note"], resolve: () => "greywold" });
    const offInterp = h.api.registerInterpreter({ id: "t.x", label: "X", facet: "f", interpret: () => 1 });
    const offAdapter = h.api.registerTimeAdapter({ id: "other", now: () => null, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 1, source: "other" }), configHash: () => "o" });

    h.controller.unload(() => order.push("workspace"));
    expect(order).toEqual(["unload:unload:false", "workspace"]);
    expect(h.api.ready).toBe(false);

    for (const call of [() => h.api.now(), () => h.api.getReport("greywold", { dayOrdinal: 1 }), () => h.api.on("ready", () => {}), () => h.api.classify({} as WeatherReport), () => h.api.canSetNow()]) {
      let err: unknown;
      try {
        call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe(UNLOADED_CODE);
      expect((err as Error).message).toMatch(/wadjet:ready/);
    }
    expect(await rejection(h.api.setNow(1))).toMatchObject({ code: UNLOADED_CODE });
    expect(await rejection(h.api.resolveZoneAsync({ kind: "note", path: "a" }))).toMatchObject({ code: UNLOADED_CODE });

    // unsubscribers are idempotent no-ops
    const adaptersBefore = h.time.list();
    for (const off of [offTime, offResolver, offInterp, offAdapter]) {
      expect(() => off()).not.toThrow();
      expect(() => off()).not.toThrow();
    }
    expect(h.time.list()).toEqual(adaptersBefore);
    h.world.emit("time-changed", { current: 1, adapterId: "x" });
    expect(order).not.toContain("late");
  });

  test("a setNow in flight at unload resolves false and fires nothing after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ writeDelay: gate });
    const pending = h.api.setNow(7);
    await Promise.resolve();
    h.controller.unload(() => {});
    release();
    expect(await pending).toBe(false);
    expect(of(h, "time-changed")).toEqual([]);
  });
});

describe("time control", () => {
  test("internal calendar: canSetNow, setNow writes and emits once", async () => {
    const h = harness();
    expect(h.api.canSetNow()).toBe(true);
    expect(await h.api.setNow(250)).toBe(true);
    expect(h.day.value).toBe(250);
    expect(h.saves).toEqual([250]);
    expect(h.api.now()!.dayOrdinal).toBe(250);
    expect(of(h, "time-changed")).toHaveLength(1);
  });

  test("non-integers reject with TypeError and change nothing", async () => {
    const h = harness();
    expect(await rejection(h.api.setNow(1.5))).toBeInstanceOf(TypeError);
    expect(await rejection(h.api.setNow(Number.POSITIVE_INFINITY))).toBeInstanceOf(TypeError);
    expect(await rejection(h.api.advance(0.5))).toBeInstanceOf(TypeError);
    expect(await rejection(h.api.advance("1" as unknown as number))).toBeInstanceOf(TypeError);
    expect(h.day.value).toBe(100);
  });

  test("advance is serialised: back-to-back calls add up even with a slow save", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ writeDelay: gate });
    const a = h.api.advance(1);
    const b = h.api.advance(1);
    const c = h.api.advance(-5);
    release();
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
    expect(h.saves).toEqual([101, 102, 97]);
    expect(of(h, "time-changed").map((p) => p.current)).toEqual([101, 102, 97]);
  });

  test("an adapter without setNow: canSetNow false, setNow/advance resolve false, readOnly is irrelevant", async () => {
    const h = harness();
    const ro: TimeAdapter = {
      id: "ro",
      now: () => ({ dayOrdinal: 1, yearPhase: 0, yearLength: 10, source: "ro" }),
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "ro" }),
      configHash: () => "ro",
      describe: () => ({ label: "Ro", readOnly: false, yearLength: 10, seasons: [], moons: [] }),
    };
    h.time.register(ro);
    h.time.setActive("ro");
    expect(h.api.canSetNow()).toBe(false);
    expect(await h.api.setNow(5)).toBe(false);
    expect(await h.api.advance(1)).toBe(false);
  });

  test("a third-party setNow: readOnly adapters can still be moved; Wadjet fires time-changed when the adapter has no subscribe", async () => {
    const h = harness();
    let current = 10;
    const ext: TimeAdapter = {
      id: "ext",
      now: () => ({ dayOrdinal: current, yearPhase: 0, yearLength: 10, source: "ext" }),
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "ext" }),
      configHash: () => "ext",
      describe: () => ({ label: "Ext", readOnly: true, yearLength: 10, seasons: [], moons: [] }),
      setNow: (d) => {
        current = d;
      },
    };
    h.time.register(ext);
    h.time.setActive("ext");
    h.events.length = 0;
    expect(h.api.canSetNow()).toBe(true);
    expect(await h.api.advance(3)).toBe(true);
    expect(current).toBe(13);
    expect(of(h, "time-changed")).toEqual([{ type: "time-changed", current: 13, adapterId: "ext" }]);
  });

  test("a throwing third-party setNow resolves false and logs the adapter id", async () => {
    const h = harness();
    h.time.register({
      id: "bad",
      now: () => null,
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "bad" }),
      configHash: () => "bad",
      setNow: () => Promise.reject(new Error("nope")),
    });
    h.time.setActive("bad");
    expect(await h.api.setNow(1)).toBe(false);
    expect(String(errSpy.mock.calls.at(-1)?.[0])).toContain('"bad"');
  });

  test("subscribe: the active adapter's own changes fire time-changed; switching resubscribes", () => {
    const h = harness();
    const subs = new Set<() => void>();
    const ext: TimeAdapter = {
      id: "ext",
      now: () => ({ dayOrdinal: 5, yearPhase: 0, yearLength: 10, source: "ext" }),
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "ext" }),
      configHash: () => "ext",
      subscribe: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };
    h.time.register(ext);
    expect(subs.size).toBe(0); // not active yet
    h.time.setActive("ext");
    h.controller.syncActiveSubscription();
    expect(subs.size).toBe(1);
    h.events.length = 0;
    for (const cb of subs) cb();
    expect(of(h, "time-changed")).toEqual([{ type: "time-changed", current: 5, adapterId: "ext" }]);
    h.time.setActive("internal");
    h.controller.syncActiveSubscription();
    expect(subs.size).toBe(0);
  });
});

describe("zone resolvers", () => {
  test("a resolver needs resolve or resolveAsync", () => {
    const { api } = harness();
    expect(() => api.registerZoneResolver({ id: "empty", kinds: ["note"] })).toThrow(TypeError);
  });

  test("resolveZone skips async-only resolvers; resolveZoneAsync walks both in order", async () => {
    const { api } = harness();
    api.registerZoneResolver({ id: "a", kinds: ["note"], resolveAsync: () => Promise.resolve("ashfall-coast") });
    api.registerZoneResolver({ id: "s", kinds: ["note"], resolve: () => "greywold" });
    expect(api.resolveZone({ kind: "note", path: "x" })).toBe("greywold");
    expect(await api.resolveZoneAsync({ kind: "note", path: "x" })).toBe("ashfall-coast");
  });

  test("timeouts, throws and unknown ids fall through to the next resolver", async () => {
    const h = harness();
    h.world.resolverTimeoutMs = 20;
    h.api.registerZoneResolver({ id: "slow", kinds: ["hex"], resolveAsync: () => new Promise((r) => setTimeout(() => r("ashfall-coast"), 200)) });
    h.api.registerZoneResolver({ id: "throws", kinds: ["hex"], resolveAsync: () => Promise.reject(new Error("x")) });
    h.api.registerZoneResolver({ id: "ghost", kinds: ["hex"], resolve: () => "no-such-zone" });
    h.api.registerZoneResolver({ id: "ok", kinds: ["hex"], resolve: () => "greywold" });
    expect(await h.api.resolveZoneAsync({ kind: "hex", mapId: "m", q: 0, r: 0 })).toBe("greywold");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('"slow"');
  });

  test("a zone deleted while a resolver awaited is not returned", async () => {
    const h = harness();
    h.api.registerZoneResolver({
      id: "a",
      kinds: ["note"],
      resolveAsync: async () => {
        await Promise.resolve();
        h.world.setState({ seed: "s", zones: [zoneNamed("Greywold")], overrides: [] });
        return "ashfall-coast";
      },
    });
    expect(await h.api.resolveZoneAsync({ kind: "note", path: "x" })).toBeNull();
  });

  test("the chain is snapshotted when resolveZoneAsync starts", async () => {
    const h = harness();
    h.api.registerZoneResolver({
      id: "adds",
      kinds: ["note"],
      resolveAsync: () => {
        h.api.registerZoneResolver({ id: "late", kinds: ["note"], resolve: () => "greywold" });
        return Promise.resolve(null);
      },
    });
    expect(await h.api.resolveZoneAsync({ kind: "note", path: "x" })).toBeNull();
    expect(await h.api.resolveZoneAsync({ kind: "note", path: "x" })).toBe("greywold");
  });
});

describe("wadjet.frontmatter resolver", () => {
  const zones = [
    { id: "ashfall", name: "greywold" }, // listed first, and its name collides with the other zone's id
    { id: "greywold", name: "Greywold" },
  ];
  const fm: Record<string, Record<string, unknown>> = {
    "id.md": { "weather-zone": "greywold" },
    "name.md": { "weather-zone": "  GREYWOLD " },
    "ash.md": { "weather-zone": "Ashfall" },
    "num.md": { "weather-zone": 7 },
    "none.md": { other: 1 },
  };
  const r = frontmatterResolver((p) => fm[p], () => zones);

  test("id match wins over a case-insensitive name match", () => {
    expect(r.resolve!({ kind: "note", path: "id.md" })).toBe("greywold");
    expect(r.resolve!({ kind: "note", path: "name.md" })).toBe("ashfall"); // no id "GREYWOLD"; the first case-insensitive name match
    expect(r.resolve!({ kind: "note", path: "ash.md" })).toBeNull(); // ids are exact; "Ashfall" is neither an id nor a name
  });

  test("absent or unusable values are null", () => {
    expect(r.resolve!({ kind: "note", path: "none.md" })).toBeNull();
    expect(r.resolve!({ kind: "note", path: "num.md" })).toBeNull();
    expect(r.resolve!({ kind: "note", path: "missing.md" })).toBeNull();
    expect(r.resolve!({ kind: "hex", mapId: "m", q: 0, r: 0 })).toBeNull();
  });

  test("registered first, it answers note locators through the API", () => {
    const h = harness();
    h.api.registerZoneResolver(frontmatterResolver((p) => (p === "a.md" ? { "weather-zone": "Ashfall coast" } : null), () => h.api.listZones()));
    expect(h.api.resolveZone({ kind: "note", path: "a.md" })).toBe("ashfall-coast");
    expect(h.api.resolveZone({ kind: "note", path: "b.md" })).toBeNull();
  });
});

describe("code block", () => {
  test("interpret: a comma list; not with table or value", () => {
    expect(parseCodeblock("interpret: my-system.mood, other.x").interpret).toEqual(["my-system.mood", "other.x"]);
    expect(parseCodeblock("interpret: ").errors).toContain("interpret needs at least one interpreter id");
    expect(parseCodeblock("style: table\ninterpret: a.b").errors).toContain("interpret works with the card, line and prose styles");
    expect(parseCodeblock("style: line\ninterpret: a.b").errors).toEqual([]);
  });

  test("zone: explicit wins; else the note's resolver answer; else the first zone", () => {
    const resolve = (p: string) => (p === "tagged.md" ? "ashfall-coast" : null);
    expect(pickCodeblockZone({ zone: "greywold" }, "tagged.md", resolve, "first")).toEqual({ zoneId: "greywold", viaResolver: false });
    expect(pickCodeblockZone({}, "tagged.md", resolve, "first")).toEqual({ zoneId: "ashfall-coast", viaResolver: true });
    expect(pickCodeblockZone({}, "plain.md", resolve, "first")).toEqual({ zoneId: "first", viaResolver: true });
    expect(pickCodeblockZone({}, "x.md", () => { throw new Error("x"); }, undefined)).toEqual({ zoneId: undefined, viaResolver: true });
  });
});

describe("interpreters", () => {
  const mood: WeatherInterpreter<{ mood: string }> = {
    id: "my-system.mood",
    label: "Mood",
    facet: "mood",
    description: "How the day feels",
    interpret: (r, ctx) => ({ mood: `${ctx.classification.precipitation}/${r.zoneId}/${typeof ctx.options?.["tone"] === "string" ? ctx.options["tone"] : ""}` }),
    format: (x) => x.mood,
  };

  test("register, list by facet, get, interpret with a full context", () => {
    const h = harness();
    let seen: unknown;
    h.api.registerInterpreter(mood as WeatherInterpreter);
    h.api.registerInterpreter({ id: "my-system.ctx", label: "Ctx", facet: "debug", interpret: (_r, ctx) => (seen = ctx) });
    expect(h.api.listInterpreters()).toEqual([
      { id: "my-system.mood", label: "Mood", facet: "mood", description: "How the day feels" },
      { id: "my-system.ctx", label: "Ctx", facet: "debug" },
    ]);
    expect(h.api.listInterpreters("mood").map((i) => i.id)).toEqual(["my-system.mood"]);
    expect(h.api.getInterpreter("my-system.mood")).toBe(mood as WeatherInterpreter);
    expect(h.api.getInterpreter("nope")).toBeNull();

    const r = h.api.getReport("ashfall-coast", { dayOrdinal: 10, hour: 9 });
    expect(h.api.interpret<{ mood: string }>("my-system.mood", r, { tone: "grim" }).mood).toBe(`${h.api.classify(r).precipitation}/ashfall-coast/grim`);
    h.api.interpret("my-system.ctx", r);
    expect(seen).toEqual({ zoneId: "ashfall-coast", classification: h.api.classify(r), time: { ...h.api.timeAt(10, "ashfall-coast"), hour: 9 } });
    expect(of(h, "interpreters-changed")).toEqual([
      { type: "interpreters-changed", facet: "mood" },
      { type: "interpreters-changed", facet: "debug" },
    ]);
  });

  test("a live duplicate id throws wadjet-duplicate-id; unregister is only-if-same and idempotent", () => {
    const h = harness();
    const off = h.api.registerInterpreter(mood as WeatherInterpreter);
    let dup: unknown;
    try {
      h.api.registerInterpreter({ ...(mood as WeatherInterpreter) });
    } catch (e) {
      dup = e;
    }
    expect(dup).toMatchObject({ code: "wadjet-duplicate-id" });
    off();
    off();
    const again = { ...(mood as WeatherInterpreter) };
    h.api.registerInterpreter(again);
    off(); // stale closure from the first registration
    expect(h.api.getInterpreter("my-system.mood")).toBe(again);
    expect(of(h, "interpreters-changed")).toHaveLength(3); // register, unregister, register
  });

  test("malformed interpreters are TypeErrors", () => {
    const { api } = harness();
    expect(() => api.registerInterpreter({ id: "", label: "x", facet: "f", interpret: () => 0 })).toThrow(TypeError);
    expect(() => api.registerInterpreter({ id: "a.b", label: "x", facet: "f" } as unknown as WeatherInterpreter)).toThrow(TypeError);
  });

  test("unknown id is a RangeError; a throwing interpreter is wrapped with its id and cause", () => {
    const h = harness();
    const r = h.api.getReport("greywold", { dayOrdinal: 1 });
    expect(() => h.api.interpret("nope", r)).toThrow(RangeError);
    const cause = new Error("bad dice");
    h.api.registerInterpreter({
      id: "x.boom",
      label: "Boom",
      facet: "f",
      interpret: () => {
        throw cause;
      },
    });
    let err: Error | undefined;
    try {
      h.api.interpret("x.boom", r);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('Interpreter "x.boom" failed: bad dice');
    expect(err?.cause).toBe(cause);
  });

  test("formatInterpretation: format(), else compact JSON, never throws", () => {
    expect(formatInterpretation(mood as WeatherInterpreter, { mood: "grim" })).toBe("grim");
    expect(formatInterpretation({ id: "a", label: "A", facet: "f", interpret: () => 0 }, { a: 1 })).toBe('{"a":1}');
    expect(formatInterpretation({ id: "a", label: "A", facet: "f", interpret: () => 0, format: () => { throw new Error("x"); } }, 1)).toBe("(format failed: x)");
  });
});

describe("review fixes", () => {
  test("profiles-changed: an internal calendar edit means all; an adapter switch does not", () => {
    const cfg = { yearLength: 360, epochYear: 1, moons: [], seasons: SEASONS };
    const h = harness();
    const last = () => of(h, "profiles-changed").at(-1)!;
    const state: WorldState = { seed: "s", zones: [zoneNamed("Greywold"), zoneNamed("Ashfall Coast", { flipSeasons: true })], overrides: [] };
    h.world.setState(state);
    expect(last()).toEqual({ type: "profiles-changed", all: false, zoneIds: [] });

    const edits = [{ ...cfg, yearLength: 365 }, { ...cfg, yearLength: 365, epochYear: 7 }, { ...cfg, yearLength: 365, epochYear: 7, seasons: SEASONS.slice(0, 2) }, { ...cfg, yearLength: 365, epochYear: 7, seasons: SEASONS.slice(0, 2), moons: [{ name: "Ember", cycleDays: 29, phaseAtEpoch: 0 }] }];
    for (const edit of edits) {
      h.cal.update(edit);
      h.world.setState(state);
      expect(last()).toEqual({ type: "profiles-changed", all: true, zoneIds: ["greywold", "ashfall-coast"] });
    }
    h.world.setState(state);
    expect(last().all).toBe(false); // nothing moved since

    const ext: TimeAdapter = { id: "ext", now: () => null, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "ext" }), configHash: () => "ext-1" };
    h.time.register(ext);
    h.time.setActive("ext");
    h.world.setState(state);
    expect(last()).toEqual({ type: "profiles-changed", all: false, zoneIds: [] }); // a switch is time-changed/adapters-changed, not profiles-changed
    ext.configHash = () => "ext-2";
    h.world.setState(state);
    expect(last().all).toBe(true); // the active third-party calendar's own config moved
  });

  test("SaveQueue: one write at a time, the last write carries the newest state, even when writes settle out of order", async () => {
    const settings = { n: 0 };
    const written: number[] = [];
    const resolvers: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const q = new SaveQueue(
      (data) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const n = (data as { n: number }).n;
        return new Promise<void>((resolve) =>
          resolvers.push(() => {
            inFlight--;
            written.push(n);
            resolve();
          }),
        );
      },
      () => ({ ...settings }),
      () => true,
    );
    const tick = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    settings.n = 1;
    const a = q.save();
    await tick();
    settings.n = 2;
    const b = q.save();
    settings.n = 3;
    const c = q.save(); // coalesces with b: neither has started
    expect(c).toBe(b);
    // A host whose promises would settle out of order: resolve every pending write newest-first.
    // Only one is ever pending, so nothing can overtake.
    let settled = false;
    const all = Promise.all([a, b, c]).then(() => (settled = true));
    for (let round = 0; !settled && round < 50; round++) {
      await tick();
      for (const r of resolvers.splice(0).reverse()) r();
    }
    await all;
    expect(maxInFlight).toBe(1);
    expect(written).toEqual([1, 3]);
    expect(written.at(-1)).toBe(settings.n);
  });

  test("SaveQueue: a failed write rejects its callers and the next save still runs; nothing starts once dead", async () => {
    let alive = true;
    let fail = true;
    const written: unknown[] = [];
    const q = new SaveQueue(
      (d) => {
        if (fail) return Promise.reject(new Error("disk full"));
        written.push(d);
        return Promise.resolve();
      },
      () => "snap",
      () => alive,
    );
    expect(await rejection(q.save())).toMatchObject({ message: "disk full" });
    fail = false;
    await q.save();
    expect(written).toEqual(["snap"]);
    alive = false;
    await q.save();
    expect(written).toEqual(["snap"]);
  });

  test("a failed save of the internal calendar's day rolls it back: setNow resolves false, no time-changed", async () => {
    const settings = { currentDayOrdinal: 100 };
    let failNext = false;
    const q = new SaveQueue(
      () => (failNext ? Promise.reject(new Error("write failed")) : Promise.resolve()),
      () => settings,
      () => true,
    );
    const write = (d: number) =>
      setAndSave(
        () => settings.currentDayOrdinal,
        (v) => (settings.currentDayOrdinal = v),
        d,
        () => q.save(),
      );
    const cal = new InternalCalendar({ yearLength: 360, epochYear: 1, moons: [], seasons: SEASONS }, () => settings.currentDayOrdinal, write);
    const time = new TimeRegistry("internal");
    time.register(cal);
    const world = new World({ seed: "s", zones: [zoneNamed("Greywold")], overrides: [] }, time);
    const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
    controller.syncActiveSubscription();
    const fired: unknown[] = [];
    world.on("time-changed", (p) => fired.push(p));

    failNext = true;
    expect(await controller.api.setNow(250)).toBe(false);
    expect(settings.currentDayOrdinal).toBe(100);
    expect(controller.api.now()!.dayOrdinal).toBe(100);
    expect(fired).toEqual([]);

    failNext = false;
    expect(await controller.api.advance(2)).toBe(true);
    expect(settings.currentDayOrdinal).toBe(102);
    expect(fired).toEqual([{ type: "time-changed", current: 102, adapterId: "internal" }]);
  });

  test("setAndSave leaves a value someone else set meanwhile", async () => {
    let v = 1;
    let fail!: (e: Error) => void;
    const p = setAndSave(
      () => v,
      (x) => (v = x),
      2,
      () => new Promise<void>((_, reject) => (fail = reject)),
    );
    v = 5;
    fail(new Error("no"));
    expect(await rejection(p)).toMatchObject({ message: "no" });
    expect(v).toBe(5);
  });

  test("day arguments: safe integers only, the stored day within plus or minus MAX_DAY_ORDINAL", async () => {
    const h = harness();
    expect(MAX_DAY_ORDINAL).toBe(10_000_000);
    expect(await rejection(h.api.setNow(2 ** 53))).toBeInstanceOf(TypeError);
    expect(await rejection(h.api.advance(2 ** 53))).toBeInstanceOf(TypeError);
    expect(() => h.api.getReport("greywold", { dayOrdinal: 2 ** 53 })).toThrow(TypeError);
    expect(() => h.api.timeAt(-(2 ** 53))).toThrow(TypeError);
    expect(await rejection(h.api.setNow(MAX_DAY_ORDINAL + 1))).toBeInstanceOf(RangeError);
    expect(await rejection(h.api.setNow(-MAX_DAY_ORDINAL - 1))).toBeInstanceOf(RangeError);
    expect(await h.api.setNow(MAX_DAY_ORDINAL)).toBe(true);
    expect(await rejection(h.api.advance(1))).toBeInstanceOf(RangeError); // the target, not the argument, is out of range
    expect(h.day.value).toBe(MAX_DAY_ORDINAL);
    expect(await h.api.advance(-1)).toBe(true);
    expect(await h.api.setNow(-MAX_DAY_ORDINAL)).toBe(true);
    expect(await rejection(h.cal.setNow(MAX_DAY_ORDINAL + 1))).toBeInstanceOf(RangeError); // the internal calendar's own last line
    expect(h.day.value).toBe(-MAX_DAY_ORDINAL);
  });

  test("a queued setNow names the adapter it moved, even if the calendar source switched meanwhile", async () => {
    const h = harness();
    let current = 10;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ext: TimeAdapter = {
      id: "ext",
      now: () => ({ dayOrdinal: current, yearPhase: 0, yearLength: 10, source: "ext" }),
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 10, source: "ext" }),
      configHash: () => "ext",
      setNow: async (d) => {
        await gate;
        current = d;
      },
    };
    h.time.register(ext);
    h.time.setActive("ext");
    h.events.length = 0;
    const pending = h.api.setNow(20);
    await Promise.resolve();
    await Promise.resolve();
    h.time.setActive("internal");
    release();
    expect(await pending).toBe(true);
    expect(of(h, "time-changed")).toEqual([{ type: "time-changed", current: 20, adapterId: "ext" }]);
  });

  test("registerTimeAdapter refuses the id internal with wadjet-reserved-id", () => {
    const h = harness();
    let err: unknown;
    try {
      h.api.registerTimeAdapter({ id: "internal", now: () => null, toContext: (d) => ({ dayOrdinal: d, yearPhase: 0, yearLength: 1, source: "internal" }), configHash: () => "x" });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "wadjet-reserved-id" });
    expect(h.time.get("internal")).toBe(h.cal);
  });

  test("interpreter unregister uses the id it registered under", () => {
    const h = harness();
    const i: WeatherInterpreter = { id: "t.one", label: "One", facet: "f", interpret: () => 1 };
    const off = h.api.registerInterpreter(i);
    i.id = "t.renamed";
    i.facet = "g";
    off();
    expect(h.api.getInterpreter("t.one")).toBeNull();
    expect(of(h, "interpreters-changed").map((p) => p.facet)).toEqual(["f", "f"]);
  });

  test("interpreters get their own copies of the report and options", () => {
    const h = harness();
    h.api.registerInterpreter({
      id: "t.vandal",
      label: "Vandal",
      facet: "f",
      interpret: (r, ctx) => {
        r.temperature.mean = 999;
        r.conditions.push("vandalised");
        (ctx.options!["nested"] as { x: number }).x = 999;
        return null;
      },
    });
    let seen: number | undefined;
    h.api.registerInterpreter({ id: "t.reader", label: "Reader", facet: "f", interpret: (r) => (seen = r.temperature.mean) });
    const r = h.api.getReport("greywold", { dayOrdinal: 5 });
    const before = JSON.stringify(r);
    const options = { nested: { x: 1 } };
    h.api.interpret("t.vandal", r, options);
    h.api.interpret("t.reader", r);
    expect(JSON.stringify(r)).toBe(before);
    expect(options.nested.x).toBe(1);
    expect(seen).toBe(r.temperature.mean);
    const fnOpt = { cb: () => 1 }; // structuredClone refuses functions: a one-level copy instead
    let gotCb: unknown;
    h.api.registerInterpreter({ id: "t.fn", label: "Fn", facet: "f", interpret: (_r, ctx) => (gotCb = ctx.options?.["cb"]) });
    h.api.interpret("t.fn", r, fnOpt);
    expect(gotCb).toBe(fnOpt.cb);
  });

  test("an async listener's rejection is logged like a throw", async () => {
    const h = harness();
    let ran = false;
    // A listener that returns a promise, as an async function would.
    const asyncListener: unknown = () => Promise.reject(new Error("async boom"));
    h.api.on("time-changed", asyncListener as () => void);
    h.api.on("time-changed", () => (ran = true));
    await h.api.setNow(3);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ran).toBe(true);
    expect(errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('"time-changed" listener threw') && String(c[1]).includes("async boom"))).toBe(true);
  });

  test("glyph(report, null) and classify of non-finite numbers never throw", () => {
    const h = harness();
    const r = h.api.getReport("greywold", { dayOrdinal: 5 });
    expect(h.api.glyph(r, null as unknown as undefined)).toContain("<svg");
    expect(coreGlyph("rain", null)).toBe(coreGlyph("rain"));
    const nan: WeatherReport = {
      ...r,
      humidity: Number.NaN,
      cloudCover: Number.NaN,
      visibilityKm: Number.NaN,
      wind: { speedKph: Number.NaN, directionDeg: Number.NaN },
      precipitation: { ...r.precipitation, type: "rain", amountMm: Number.NaN },
      temperature: { ...r.temperature, mean: Number.NaN, current: 30 },
    };
    const c = h.api.classify(nan);
    expect(c).toMatchObject({ beaufort: 0, beaufortLabel: "Calm", compass: "N", oktas: 0, visibility: "moderate", precipitation: "very-light" });
    expect(c.feelsLike.mean).toBeNaN();
    expect(c.feelsLike.current).toBe(30); // no heat index without a humidity
    const inf = h.api.classify({ ...nan, wind: { speedKph: Infinity, directionDeg: -Infinity }, visibilityKm: Infinity, cloudCover: Infinity, precipitation: { ...nan.precipitation, amountMm: Infinity }, temperature: { ...nan.temperature, mean: 5 } });
    expect(inf).toMatchObject({ beaufort: 12, compass: "N", visibility: "excellent", oktas: 8, precipitation: "extremely-heavy" });
    expect(inf.feelsLike.mean).toBe(5); // no wind chill from an infinite wind
    expect(h.api.glyphKey(nan)).toBe("rain");
  });
});
