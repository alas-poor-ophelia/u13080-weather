import { describe, expect, test } from "bun:test";
import { GENERATOR_VERSION } from "../src/core/version";
import { parseCodeblock, resolveDate } from "../src/plugin/codeblock-parse";
import { DEFAULT_SETTINGS, generatorMismatch, migrateSettings } from "../src/plugin/settings";
import { TimeRegistry, type TimeAdapter } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import { slugify, uniqueId, zoneFromGeography, zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;

describe("settings", () => {
  test("migrate fills defaults and a seed; preserves zones", () => {
    const s = migrateSettings({ zones: [{ id: "a" }], calendar: { yearLength: 400 } });
    expect(s.worldSeed).toMatch(/^[0-9a-f]{16}$/);
    expect(s.calendar.yearLength).toBe(400);
    expect(s.calendar.moons).toEqual(DEFAULT_SETTINGS.calendar.moons);
    expect(s.zones).toHaveLength(1);
    expect(s.generatorVersion).toBe(GENERATOR_VERSION);
    expect(generatorMismatch(s)).toBe(false);
    expect(generatorMismatch({ ...s, generatorVersion: "wadjet-gen/0.0.0" })).toBe(true);
    expect(migrateSettings(undefined).zones).toEqual([]);
  });
});

describe("InternalCalendar", () => {
  const cfg = { yearLength: 360, epochYear: 1000, moons: [{ name: "Sable", cycleDays: 30, phaseAtEpoch: 0.5 }], seasons: [{ name: "Thaw", from: 0 }, { name: "Ashfall", from: 0.6 }, { name: "Frost", from: 0.75 }] };
  let day = 365;
  const cal = new InternalCalendar(cfg, () => day);

  test("toContext: phase, dayOfYear, moons, season tags", () => {
    const c = cal.toContext(365);
    expect(c.yearLength).toBe(360);
    expect(c.dayOfYear).toBe(5);
    expect(c.yearPhase).toBeCloseTo(5 / 360, 12);
    expect(c.moons![0]!.phase).toBeCloseTo(((365 / 30 + 0.5) % 1 + 1) % 1, 12);
    expect(c.tags).toEqual(["season:Thaw"]);
    expect(cal.toContext(360 * 2 + 250).tags).toEqual(["season:Ashfall"]);
    expect(cal.toContext(-1).dayOfYear).toBe(359); // extrapolates before the epoch
    expect(cal.toContext(-1).tags).toEqual(["season:Frost"]);
  });

  test("now follows the current day; parse/format round-trip", () => {
    expect(cal.now().dayOrdinal).toBe(365);
    day = 12;
    expect(cal.now().dayOrdinal).toBe(12);
    expect(cal.format(365)).toBe("Year 1001, day 6 (Thaw)");
    expect(cal.parse("1001-6")).toBe(365);
    expect(cal.parse("  42 ")).toBe(42);
    expect(cal.parse("1001-400")).toBeNull();
    expect(cal.parse("nonsense")).toBeNull();
  });

  test("configHash changes with calendar config", () => {
    const a = cal.configHash();
    cal.update({ ...cfg, yearLength: 361 });
    expect(cal.configHash()).not.toBe(a);
    cal.update(cfg);
    expect(cal.configHash()).toBe(a);
  });
});

describe("codeblock parser", () => {
  test("defaults, keys, errors", () => {
    expect(parseCodeblock("")).toEqual({ date: "today", style: "card", range: 7, errors: [] });
    const s = parseCodeblock("zone: greywold\ndate: +3\nhour: 14\nstyle: table\nrange: 10\n# comment");
    expect(s).toEqual({ zone: "greywold", date: "+3", hour: 14, style: "table", range: 10, errors: [] });
    const bad = parseCodeblock("style: fancy\nhour: 25\nrange: 0\nbogus: 1\nnot a line");
    expect(bad.errors).toHaveLength(5);
  });

  test("resolveDate: today, relative, ordinal, adapter parse", () => {
    expect(resolveDate("today", 100)).toEqual({ day: 100 });
    expect(resolveDate("+3", 100)).toEqual({ day: 103 });
    expect(resolveDate("- 2", 100)).toEqual({ day: 98 });
    expect(resolveDate("-50", null).day).toBeNull();
    expect(resolveDate("12345", null)).toEqual({ day: 12345 });
    expect(resolveDate("1001-6", 0, (s) => (s === "1001-6" ? 365 : null))).toEqual({ day: 365 });
    expect(resolveDate("garbage", 0, () => null).error).toContain("cannot parse");
    expect(resolveDate("today", null).error).toContain("no current date");
  });
});

describe("zone authoring", () => {
  test("slug and unique ids", () => {
    expect(slugify("Greywold Highlands!")).toBe("greywold-highlands");
    expect(slugify("Côte d'Azur")).toBe("cote-d-azur");
    expect(slugify("???")).toBe("zone");
    expect(uniqueId("a", new Set(["a", "a-2"]))).toBe("a-3");
  });

  test("zoneFromPreset copies (not references) the climate; geography applies Tier A", () => {
    const { zone, provenance } = zoneFromPreset({ name: "Fjord", preset: fjord, existingIds: new Set() });
    expect(zone.id).toBe("fjord");
    expect(zone.climate).toEqual(fjord.climate);
    expect(zone.climate).not.toBe(fjord.climate);
    expect(zone.preset).toEqual({ id: "fjord-coast", contentHash: fjord.contentHash, matched: "manual" });
    expect(provenance).toContain("Copied from preset");
    const g = zoneFromGeography("Southern Fjord", { latitude: -60, altitude: 500, continentality: 0.1, orographic: "windward" }, PRESETS, new Set(["fjord"]));
    expect(g.zone.preset!.id).toBe("fjord-coast");
    expect(g.zone.preset!.matched).toBe("auto");
    expect(g.zone.geography!.latitude).toBe(-60);
    expect(g.provenance).toContain("flipped");
    expect(g.zone.climate).not.toEqual(fjord.climate);
  });
});

describe("World (the API behind the plugin)", () => {
  const cfg = { yearLength: 365, epochYear: 1, moons: [], seasons: [] };
  const today = 200;
  const cal = new InternalCalendar(cfg, () => today);
  const time = new TimeRegistry("internal");
  time.register(cal);
  const { zone } = zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() });
  const world = new World({ seed: "world-seed", zones: [zone], overrides: [] }, time);

  test("getReport / getRange / now / listZones / describe", () => {
    const r = world.getReport("greywold", { dayOrdinal: 200 });
    expect(r.zoneId).toBe("greywold");
    expect(r.provenance.worldSeed).toBe("world-seed");
    expect(r.provenance.calendarHash).toBe(cal.configHash());
    expect(world.getRange("greywold", 198, 202).map((x) => x.dayOrdinal)).toEqual([198, 199, 200, 201, 202]);
    expect(world.getRange("greywold", 198, 202)[2]).toEqual(r);
    expect(world.now()!.dayOrdinal).toBe(200);
    expect(world.listZones()).toEqual([{ id: "greywold", name: "Greywold", issues: [] }]);
    expect(world.describe(r)).toContain("°C");
    expect(() => world.getReport("nope", { dayOrdinal: 1 })).toThrow(/unknown zone/i);
    expect(world.getReport("greywold", { dayOrdinal: 200, hour: 6 }).temperature.current).toBeDefined();
  });

  test("overrides flow through setState", () => {
    world.setState({ seed: "world-seed", zones: [zone], overrides: [{ zoneId: "greywold", dayOrdinal: 200, patch: { conditions: ["dragonstorm"] } }] });
    expect(world.getReport("greywold", { dayOrdinal: 200 }).conditions).toContain("dragonstorm");
    expect(world.getReport("greywold", { dayOrdinal: 201 }).overridden).toBe(false);
  });

  test("changing the calendar config invalidates the cached generator (weather moves with the seasons)", () => {
    const before = world.getReport("greywold", { dayOrdinal: 200 });
    cal.update({ ...cfg, yearLength: 200 });
    const after = world.getReport("greywold", { dayOrdinal: 200 });
    expect(after.provenance.calendarHash).not.toBe(before.provenance.calendarHash);
    expect(after.temperature.mean).not.toBe(before.temperature.mean);
    cal.update(cfg);
    expect(world.getReport("greywold", { dayOrdinal: 200 }).temperature).toEqual(before.temperature);
  });

  test("a second time adapter can be registered and selected; consumers may pass their own TimeContext", () => {
    const other: TimeAdapter = {
      id: "other-cal",
      now: () => ({ dayOrdinal: 5, yearPhase: 0.9, yearLength: 10, source: "other-cal" }),
      toContext: (d) => ({ dayOrdinal: d, yearPhase: ((d % 10) + 10) % 10 / 10, yearLength: 10, source: "other-cal" }),
      configHash: () => "other:1",
    };
    const off = time.register(other);
    time.setActive("other-cal");
    expect(world.now()!.source).toBe("other-cal");
    expect(world.getReport("greywold", other.toContext(5)).provenance.calendarHash).toBe("other:1");
    off();
    expect(world.now()!.source).toBe("internal"); // falls back
    time.setActive("internal");
  });

  test("zone resolvers are consulted by kind and errors are contained", () => {
    const off1 = world.registerZoneResolver({ id: "bad", kinds: ["hex"], resolve: () => { throw new Error("boom"); } });
    const off2 = world.registerZoneResolver({ id: "map", kinds: ["hex"], resolve: (l) => (l.kind === "hex" && l.q === 1 ? "greywold" : null) });
    expect(world.resolveZone({ kind: "hex", mapId: "m", q: 1, r: 1 })).toBe("greywold");
    expect(world.resolveZone({ kind: "hex", mapId: "m", q: 2, r: 1 })).toBeNull();
    expect(world.resolveZone({ kind: "note", path: "x.md" })).toBeNull();
    off1();
    off2();
  });

  test("events: ready flag, listeners, unsubscribe", () => {
    let n = 0;
    const off = world.on("profiles-changed", () => n++);
    world.setState({ seed: "world-seed", zones: [zone], overrides: [] });
    expect(n).toBe(1);
    off();
    world.setState({ seed: "world-seed", zones: [zone], overrides: [] });
    expect(n).toBe(1);
    expect(world.ready).toBe(false);
    world.emit("ready");
    expect(world.ready).toBe(true);
  });
});

describe("bundled presets", () => {
  test("26 presets, all with content hashes and computed Köppen", () => {
    expect(PRESETS.length).toBe(26);
    for (const p of PRESETS) {
      expect(p.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(p.match.koppen.length).toBeGreaterThanOrEqual(2);
    }
  });
});
