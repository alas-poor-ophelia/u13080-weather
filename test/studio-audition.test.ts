import { describe, expect, test } from "bun:test";
import { auditionKey, firstDayOfYear, regimeRuns, rollYear, shareOfYear, type AuditionInput, type AuditionYear } from "../src/studio/model/audition";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import type { Era, Preset, Regime, ZoneProfile } from "../src/core/types";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [], ...over };
}

const cfg = { yearLength: 360, epochYear: 1, moons: [], seasons: [] as Array<{ name: string; from: number }> };

function baseInput(over: Partial<AuditionInput> = {}): AuditionInput {
  const cal = new InternalCalendar(cfg, () => 0);
  return { zone: zone(), eras: [] as Era[], seed: "world-seed", adapter: cal, year: 1, salt: 0, ...over };
}

describe("auditionKey / firstDayOfYear", () => {
  test("firstDayOfYear finds year 1 and year 3 via parse", () => {
    const cal = new InternalCalendar(cfg, () => 0);
    expect(firstDayOfYear(cal, 1)).toBe(0);
    expect(firstDayOfYear(cal, 3)).toBe(720);
  });

  test("firstDayOfYear scans without parse()", () => {
    const yearLength = 100;
    const noParse = {
      id: "no-parse",
      now: () => null,
      toContext: (d: number) => {
        const y = Math.floor(d / yearLength) + 1;
        const doy = d - (y - 1) * yearLength;
        return { dayOrdinal: d, yearPhase: doy / yearLength, yearLength, dayOfYear: doy, year: y, source: "no-parse" };
      },
      configHash: () => "no-parse:1",
    };
    expect(firstDayOfYear(noParse, 1)).toBe(0);
    expect(firstDayOfYear(noParse, 4)).toBe(300);
  });

  test("auditionKey changes with seed, salt, profile, calendar, eras, flip, year", () => {
    const i = baseInput();
    const k = auditionKey(i);
    expect(auditionKey({ ...i, salt: 1 })).not.toBe(k);
    expect(auditionKey({ ...i, seed: "other" })).not.toBe(k);
    expect(auditionKey({ ...i, year: 2 })).not.toBe(k);
    expect(auditionKey({ ...i, zone: zone({ modifiers: [{ id: "x", apply: [] }] }) })).not.toBe(k);
    expect(auditionKey({ ...i, zone: zone({ flipSeasons: true }) })).not.toBe(k);
    expect(auditionKey({ ...i, eras: [{ name: "Frostfall", from: 1, to: 5 }] })).not.toBe(k);
  });

  test("auditionKey changes with this zone's pins, and ignores another zone's", () => {
    const i = baseInput();
    const k = auditionKey(i);
    // Overrides are an input to the roll (`buildReport` applies them), so the
    // key has to move when one is added — otherwise a right-click pin hands
    // back the cached, unpinned year.
    const pinned = auditionKey({ ...i, overrides: [{ zoneId: "greywold", dayOrdinal: 5, patch: { note: "storm" } }] });
    expect(pinned).not.toBe(k);
    expect(auditionKey({ ...i, overrides: [{ zoneId: "elsewhere", dayOrdinal: 5, patch: { note: "storm" } }] })).toBe(k);
    expect(auditionKey({ ...i, overrides: [] })).toBe(k);
  });
});

describe("shareOfYear", () => {
  test("weight × meanDurationDays normalised to sum 1", () => {
    const regimes: Regime[] = [
      { id: "a", weight: 0.7, meanDurationDays: 12 },
      { id: "b", weight: 0.15, meanDurationDays: 6 },
      { id: "c", weight: 0.15, meanDurationDays: 9 },
    ];
    const shares = shareOfYear(regimes);
    const sum = shares.reduce((s, x) => s + x.share, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(shares.find((x) => x.id === "a")!.share).toBeGreaterThan(shares.find((x) => x.id === "b")!.share);
  });

  test("all-zero weights normalise to 0, not NaN", () => {
    const regimes: Regime[] = [
      { id: "a", weight: 0, meanDurationDays: 12 },
      { id: "b", weight: 0, meanDurationDays: 6 },
    ];
    expect(shareOfYear(regimes)).toEqual([
      { id: "a", share: 0 },
      { id: "b", share: 0 },
    ]);
  });
});

describe("regimeRuns", () => {
  test("groups consecutive same-regime days; breaks on change and on a gap", () => {
    const days = [
      { dayOfYear: 0, record: { regime: "normal" } },
      { dayOfYear: 1, record: { regime: "normal" } },
      { dayOfYear: 2, record: { regime: "wet-spell" } },
      { dayOfYear: 3, record: { regime: "wet-spell" } },
      { dayOfYear: 4, record: { regime: "normal" } },
      // gap: dayOfYear 6 instead of 5, same regime as the previous run — must NOT merge
      { dayOfYear: 6, record: { regime: "normal" } },
    ] as never;
    expect(regimeRuns(days)).toEqual([
      { regime: "normal", from: 0, to: 1 },
      { regime: "wet-spell", from: 2, to: 3 },
      { regime: "normal", from: 4, to: 4 },
      { regime: "normal", from: 6, to: 6 },
    ]);
  });

  test("a single-run year", () => {
    const days = Array.from({ length: 5 }, (_, i) => ({ dayOfYear: i, record: { regime: "normal" } })) as never;
    expect(regimeRuns(days)).toEqual([{ regime: "normal", from: 0, to: 4 }]);
  });

  test("empty input", () => {
    expect(regimeRuns([])).toEqual([]);
  });
});

describe("rollYear", () => {
  test("salt 0 matches World.getReport byte-for-byte for the same days", () => {
    const cal = new InternalCalendar(cfg, () => 0);
    const time = new TimeRegistry("internal");
    time.register(cal);
    const z = zone();
    const world = new World({ seed: "world-seed", zones: [z], overrides: [] }, time);

    const year = rollYear(baseInput({ zone: z, adapter: cal }));
    expect(year.days.length).toBe(cfg.yearLength);
    for (const day of year.days) {
      const expected = world.getReport("greywold", { dayOrdinal: day.dayOrdinal });
      expect(day.report).toEqual(expected);
    }
  });

  test("salt 1 differs from salt 0", () => {
    const i = baseInput();
    const a = rollYear(i);
    const b = rollYear({ ...i, salt: 1 });
    expect(a.days.length).toBe(b.days.length);
    const diff = a.days.some((d, idx) => d.report.temperature.mean !== b.days[idx]!.report.temperature.mean || d.record.regime !== b.days[idx]!.record.regime);
    expect(diff).toBe(true);
  });

  test("memo: hit on the same key, miss after a modifier edit", () => {
    const cache = new Map<string, AuditionYear>();
    const i = baseInput();
    const a = rollYear(i, cache);
    const b = rollYear(i, cache);
    expect(a).toBe(b); // same object: cache hit
    const edited = { ...i, zone: zone({ modifiers: [{ id: "colder", apply: [{ param: "temperature.mean" as const, op: "offset" as const, value: -5 }] }] }) };
    const c = rollYear(edited, cache);
    expect(c).not.toBe(a);
    expect(c.key).not.toBe(a.key);
  });

  test("regimeRuns on the rolled year groups correctly, including a single-run year", () => {
    const i = baseInput({ zone: zone({ regimes: [{ id: "only", weight: 1, meanDurationDays: 1000 }] }) });
    const year = rollYear(i);
    expect(year.regimeRuns.length).toBe(1);
    expect(year.regimeRuns[0]).toEqual({ regime: "only", from: 0, to: 359 });
  });

  test("invalid profile returns issues and no days, instead of throwing", () => {
    const i = baseInput({ zone: zone({ regimes: [] }) });
    const year = rollYear(i);
    expect(year.days).toEqual([]);
    expect(year.regimeRuns).toEqual([]);
    expect(year.issues.some((x) => x.level === "error")).toBe(true);
  });

  test("an era with apply changes the roll", () => {
    const eras: Era[] = [{ name: "Long Winter", from: 1, to: 10, apply: [{ param: "temperature.mean", op: "offset", value: -8 }] }];
    const i = baseInput();
    const withEra = rollYear({ ...i, eras });
    const without = rollYear(i);
    const diff = withEra.days.some((d, idx) => d.report.temperature.mean !== without.days[idx]!.report.temperature.mean);
    expect(diff).toBe(true);
  });

  test("powering a device off changes the key and the roll (wadjet-3bv)", () => {
    // The mixer LED writes `Modifier.enabled = false`; `profileHash` keeps that
    // key, so the cache must miss and the engine must skip the device.
    const gust = { id: "gust", apply: [{ param: "wind.speed" as const, op: "offset" as const, value: 12 }] };
    const on = rollYear(baseInput({ zone: zone({ modifiers: [gust] }) }));
    const off = rollYear(baseInput({ zone: zone({ modifiers: [{ ...gust, enabled: false }] }) }));
    expect(off.key).not.toBe(on.key);
    expect(off.days.length).toBe(on.days.length);
    const diff = off.days.some((d, idx) => JSON.stringify(d.report.wind) !== JSON.stringify(on.days[idx]!.report.wind));
    expect(diff).toBe(true);
  });

  test("a pinned day is marked and its report carries the patch", () => {
    const i = baseInput();
    const firstDay = firstDayOfYear(i.adapter, i.year);
    const pinnedDay = firstDay + 5;
    const year = rollYear({ ...i, overrides: [{ zoneId: "greywold", dayOrdinal: pinnedDay, patch: { conditions: ["dragonstorm"] } }] });
    const day = year.days.find((d) => d.dayOrdinal === pinnedDay)!;
    expect(day.pinned).toBe(true);
    expect(day.report.overridden).toBe(true);
    expect(day.report.conditions).toContain("dragonstorm");
    const other = year.days.find((d) => d.dayOrdinal !== pinnedDay)!;
    expect(other.pinned).toBe(false);
    expect(other.report.overridden).toBe(false);
  });

  test("flipSeasons zone under the internal calendar with seasons matches World too", () => {
    const seasonCfg = { yearLength: 360, epochYear: 1, moons: [], seasons: [{ name: "Thaw", from: 0 }, { name: "High", from: 0.5 } ] };
    const cal = new InternalCalendar(seasonCfg, () => 0);
    const time = new TimeRegistry("internal");
    time.register(cal);
    const z = zone({ flipSeasons: true });
    const world = new World({ seed: "world-seed", zones: [z], overrides: [] }, time);

    const year = rollYear(baseInput({ zone: z, adapter: cal }));
    expect(year.days.length).toBe(seasonCfg.yearLength);
    // sanity: the flip actually changed which season tag shows on day 0 vs the unflipped calendar
    expect(cal.toContext(0).tags).toEqual(["season:Thaw"]);
    expect(year.days[0]!.time.tags).toEqual(["season:High"]);
    for (const day of year.days) {
      const expected = world.getReport("greywold", { dayOrdinal: day.dayOrdinal });
      expect(day.report).toEqual(expected);
    }
  });

  test("active carries the ids of the modifiers that fired: a tagged spell matches record.tags", () => {
    const spell = {
      id: "sable-stormtide",
      tag: "stormtide",
      spell: { meanStartsPerYear: 8, meanDurationDays: 4 },
      apply: [{ param: "precipitation.scale" as const, op: "scale" as const, value: 2 }],
    };
    const year = rollYear(baseInput({ zone: zone({ modifiers: [spell] }) }));
    expect(year.days.length).toBe(cfg.yearLength);
    // The only tagged modifier in the zone, so `active` and `record.tags` are
    // the same fact seen from two sides — the engine's own list, and what the
    // roll wrote into the record.
    for (const day of year.days) {
      expect(day.active.includes("sable-stormtide")).toBe(day.record.tags.includes("stormtide"));
    }
    const fired = year.days.filter((d) => d.active.includes("sable-stormtide"));
    expect(fired.length).toBeGreaterThan(0);
    expect(fired.length).toBeLessThan(year.days.length);
  });

  test("active is empty for a zone with no daily modifiers", () => {
    const year = rollYear(baseInput());
    expect(year.days.every((d) => d.active.length === 0)).toBe(true);
  });

  test("performance: one year stays well under budget", () => {
    const i = baseInput();
    const start = performance.now();
    rollYear(i);
    const ms = performance.now() - start;
    console.log(`rollYear: one year in ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
