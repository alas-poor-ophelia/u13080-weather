import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { eraModifiers, eraTags, erasHash, validateEras, withEraTags, yearOf } from "../src/core/eras";
import { createGenerator, validateProfile } from "../src/core/profile";
import type { DayTime, Era, Preset } from "../src/core/types";
import { InternalCalendar } from "../src/plugin/time/internal";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { World } from "../src/plugin/world";
import { zoneFromPreset } from "../src/plugin/zones";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const prairie = presets.find((p) => p.id === "prairie")!;
const zone = zoneFromPreset({ name: "Greywold", preset: prairie, existingIds: new Set() }).zone;

const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [], seasons: [] }, () => 0);
const iceAge: Era = { name: "Ice Age", from: 3, to: 4, apply: [{ param: "temperature.mean", op: "offset", value: -8 }] };
const thaw: Era = { name: "Thaw", from: 5 };

describe("era timeline", () => {
  test("years and tags: inclusive from/to, open-ended, chaining, none", () => {
    const y = (d: number) => yearOf(cal.toContext(d));
    expect(y(0)).toBe(1);
    expect(y(365 * 2)).toBe(3);
    expect(eraTags([iceAge, thaw], 2)).toEqual([]);
    expect(eraTags([iceAge, thaw], 3)).toEqual(["era:Ice Age"]);
    expect(eraTags([iceAge, thaw], 4)).toEqual(["era:Ice Age"]);
    expect(eraTags([iceAge, thaw], 5)).toEqual(["era:Thaw"]);
    expect(eraTags([iceAge, thaw], 9000)).toEqual(["era:Thaw"]);
    const t = withEraTags([iceAge], { ...cal.toContext(365 * 2), tags: ["season:Winter"] });
    expect(t.tags).toEqual(["season:Winter", "era:Ice Age"]);
  });

  test("an adapter without a year counts from year 1 at day 0", () => {
    const t: DayTime & { dayOrdinal: number; yearLength: number } = { dayOrdinal: 400, yearLength: 400, yearPhase: 0 };
    expect(yearOf(t)).toBe(2);
  });

  test("era ops reach every zone through the generator, only inside the era", () => {
    const timeOf = (d: number) => withEraTags([iceAge], cal.toContext(d));
    const plain = createGenerator(zone, "seed", timeOf).generator;
    const withEra = createGenerator(zone, "seed", timeOf, eraModifiers([iceAge])).generator;
    expect(validateProfile(zone).filter((i) => i.level === "error")).toEqual([]);
    let inside = 0;
    for (let d = 365 * 2; d < 365 * 4; d += 7) {
      const a = plain.day(d);
      const b = withEra.day(d);
      expect(b.tempMean).toBeLessThan(a.tempMean);
      inside++;
    }
    expect(inside).toBeGreaterThan(50);
    for (let d = 0; d < 365 * 2; d += 7) expect(withEra.day(d).tempMean).toBe(plain.day(d).tempMean);
    for (let d = 365 * 4; d < 365 * 5; d += 7) expect(withEra.day(d).tempMean).toBe(plain.day(d).tempMean);
  });

  test("a pure-tag era (no apply) makes no modifier but a zone modifier can react to it", () => {
    expect(eraModifiers([thaw])).toEqual([]);
    const z = { ...zone, modifiers: [{ id: "thaw-rains", when: { tag: "era:Thaw" }, apply: [{ param: "precipitation.pwd", op: "set" as const, value: 1 }], tag: "thaw-rain" }] };
    const g = createGenerator(z, "seed", (d) => withEraTags([thaw], cal.toContext(d))).generator;
    expect(g.day(365 * 6).tags).toContain("thaw-rain");
    expect(g.day(10).tags).not.toContain("thaw-rain");
  });

  test("World: eras change provenance.calendarHash and the report, and rebuild the cache", () => {
    const time = new TimeRegistry("internal");
    time.register(cal);
    const w = new World({ seed: "seed", zones: [zone], overrides: [] }, time);
    const before = w.getReport(zone.id, { dayOrdinal: 365 * 3 });
    w.setState({ seed: "seed", zones: [zone], eras: [iceAge], overrides: [] });
    const after = w.getReport(zone.id, { dayOrdinal: 365 * 3 });
    expect(after.provenance.calendarHash).not.toBe(before.provenance.calendarHash);
    expect(after.provenance.calendarHash).toContain(erasHash([iceAge]));
    expect(after.temperature.mean).toBeLessThan(before.temperature.mean);
    expect(after.conditions).not.toContain("era:Ice Age"); // calendar tags are not conditions
    expect(erasHash([iceAge])).not.toBe(erasHash([{ ...iceAge, to: 5 }]));
  });

  test("a disabled era tags nothing, makes no modifier, and leaves the weather as if it were not there", () => {
    const off = { ...iceAge, enabled: false };
    expect(eraTags([off, thaw], 3)).toEqual([]);
    expect(eraTags([off, thaw], 5)).toEqual(["era:Thaw"]);
    expect(withEraTags([off], { ...cal.toContext(365 * 2), tags: ["season:Winter"] }).tags).toEqual(["season:Winter"]);
    expect(eraModifiers([off])).toEqual([]);
    expect(eraModifiers([{ ...iceAge, enabled: true }]).map((m) => m.id)).toEqual(["era:Ice Age"]);
    const plain = createGenerator(zone, "seed", (d) => cal.toContext(d)).generator;
    const disabled = createGenerator(zone, "seed", (d) => withEraTags([off], cal.toContext(d)), eraModifiers([off])).generator;
    for (let d = 365 * 3; d < 365 * 4; d += 11) expect(disabled.day(d)).toEqual(plain.day(d));
  });

  test("validation", () => {
    const errs = (e: unknown) => validateEras(e).filter((i) => i.level === "error").map((i) => i.path);
    expect(errs([iceAge, thaw])).toEqual([]);
    expect(errs("x")).toEqual(["eras"]);
    expect(errs([{ name: "", from: 1 }])).toEqual(["eras[0].name"]);
    expect(errs([{ name: "A", from: 1.5 }])).toEqual(["eras[0].from"]);
    expect(errs([{ name: "A", from: 5, to: 4 }])).toEqual(["eras[0].to"]);
    expect(errs([{ name: "A", from: 1 }, { name: "A", from: 2 }])).toEqual(["eras[1].name"]);
    expect(errs([{ name: "A", from: 1, apply: [{ param: "nope", op: "set", value: 1 }] }])).toEqual(["eras[0].apply[0].param"]);
    expect(errs([{ name: "A", from: 1, apply: [{ param: "temperature.phase", op: "set", value: 1 }] }])).toEqual(["eras[0].apply[0].param"]); // scalars are climate-stage only
    expect(validateEras([{ name: "A", from: 1, colour: "blue" }]).map((i) => i.level)).toEqual(["warning"]);
    expect(validateEras([{ name: "A", from: 1, enabled: false }])).toEqual([]); // known field: no "unknown field" warning
    expect(errs([{ name: "A", from: 1, enabled: "yes" }])).toEqual(["eras[0].enabled"]);
    expect(validateProfile({ ...zone, modifiers: [{ id: "era:x", apply: [] }] }).some((i) => i.path === "modifiers[0].id")).toBe(true);
  });
});
