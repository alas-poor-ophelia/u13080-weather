/**
 * Seshat P3a step 1 (docs/SESHAT-v0.md §13.4–13.6, §13.11): the AST's seasons
 * and moons, held to the legacy internal calendar, and the hashed content.
 *
 *   - seasons: Engine.seasonAt gives the season InternalCalendar tags, every
 *     day, for integer years, including unsorted marks, equal starts, a single
 *     mark and marks exactly on day boundaries; the year phase is the same float;
 *   - moons: a body built from the legacy body's exact rationals gives the same
 *     phase (Object.is) every day;
 *   - definitionContent: changing a removed field leaves it equal, changing a
 *     kept field changes it.
 */
import { describe, expect, test } from "bun:test";
import { bodyFor, definitionContent, Engine, GREGORIAN, parse, print, seasonAtPhase, validate, type CalendarAst, type SeasonMark } from "../src/seshat";
import { seasonAtPhase as pluginSeasonAtPhase } from "../src/plugin/time/seasons";
import { InternalCalendar } from "../src/plugin/time/internal";
import type { InternalCalendarConfig } from "../src/plugin/settings";

/** A definition that encodes a legacy integer-length config: one year cycle from day 0, its seasons and moons. */
function fromLegacy(cfg: InternalCalendarConfig): CalendarAst {
  return {
    name: "legacy",
    gears: [],
    units: [{ id: "year", kind: "cycle", number: cfg.epochYear, anchor: 0, length: cfg.yearLength }],
    seasons: { unit: "year", marks: cfg.seasons },
    bodies: cfg.moons.map((m, i) => {
      const b = bodyFor(m.cycleDays, m.phaseAtEpoch)!;
      return { id: `moon-${i}`, period: b.period, epoch: b.epoch, moon: { name: m.name } };
    }),
  };
}

const FOUR: SeasonMark[] = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
const MOONS: InternalCalendarConfig["moons"] = [
  { name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 },
  { name: "Ash", cycleDays: 7.3, phaseAtEpoch: -0.25 },
  { name: "Ember", cycleDays: 33, phaseAtEpoch: 1.2 },
];

describe("seasons and moons match the legacy internal calendar", () => {
  test("seasonAtPhase is one function, re-exported where the plugin always imported it", () => {
    expect(pluginSeasonAtPhase).toBe(seasonAtPhase);
  });

  const SEASON_CASES: Array<[string, number, SeasonMark[]]> = [
    ["four seasons, 365 days", 365, FOUR],
    ["four seasons, 400 days", 400, FOUR],
    ["unsorted marks", 360, [FOUR[2]!, FOUR[0]!, FOUR[3]!, FOUR[1]!]],
    ["equal starts (stable sort decides)", 365, [{ name: "A", from: 0.3 }, { name: "B", from: 0.3 }, { name: "C", from: 0.6 }]],
    ["a single mark is the whole year", 365, [{ name: "Only", from: 0.4 }]],
    ["marks exactly on day boundaries", 360, [{ name: "a", from: 0 }, { name: "b", from: 90 / 360 }, { name: "c", from: 1 / 3 }, { name: "d", from: 0.5 }]],
    ["no seasons", 365, []],
  ];
  for (const [name, yearLength, seasons] of SEASON_CASES) {
    test(`${name}: same season, same year phase, every day over ±2000 and far out`, () => {
      const cfg: InternalCalendarConfig = { yearLength, epochYear: 1, moons: MOONS, seasons };
      const legacy = new InternalCalendar(cfg, () => 0);
      const e = new Engine(fromLegacy(cfg));
      const days = [...Array.from({ length: 4001 }, (_, i) => i - 2000), 10_000_000 - 1, -10_000_000, 3_650_000];
      for (const d of days) {
        const c = legacy.toContext(d);
        const want = c.tags?.find((t) => t.startsWith("season:"))?.slice(7) ?? null;
        expect([d, e.seasonAt(d)]).toEqual([d, want]);
        const o = e.occurrenceAt("year", d)!;
        expect(Object.is((d - o.start) / o.length, c.yearPhase)).toBe(true);
        expect(o.index + 1).toBe(c.year!);
      }
    });
  }

  test("moons: a body built from the legacy body's exact rationals gives the same phase every day", () => {
    const cfg: InternalCalendarConfig = { yearLength: 365, epochYear: 1, moons: MOONS, seasons: FOUR };
    const legacy = new InternalCalendar(cfg, () => 0);
    const e = new Engine(fromLegacy(cfg));
    for (const d of [...Array.from({ length: 4001 }, (_, i) => i - 2000), 2953, -295300, 9_999_999, -9_999_999]) {
      const want = legacy.toContext(d).moons!;
      const got = e.moonsAt(d);
      expect(got.map((m) => m.name)).toEqual(want.map((m) => m.name));
      for (const [i, m] of got.entries()) expect([d, m.name, Object.is(m.phase, want[i]!.phase)]).toEqual([d, m.name, true]);
    }
  });
});

describe("validation and text for seasons and moons", () => {
  const base: CalendarAst = { ...GREGORIAN, seasons: { unit: "year", marks: FOUR }, bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna", phases: [{ name: "Full", at: 0.5 }] } }] };

  test("a valid calendar with seasons and a moon round-trips through text", () => {
    expect(validate(base)).toEqual([]);
    const text = print(base);
    expect(text).toContain("BEGIN:VSEASONS");
    expect(text).toContain("MOON:Luna");
    expect(parse(text)).toEqual(base);
    expect(print(parse(text))).toBe(text);
  });

  test("the validator refuses what a season or moon cannot mean", () => {
    const err = (ast: CalendarAst) => validate(ast).join(" | ");
    expect(err({ ...base, seasons: { unit: "moon", marks: FOUR } })).toContain('seasons: no unit "moon"');
    expect(err({ ...base, seasons: { unit: "month", marks: FOUR } })).toContain("is a slot unit");
    expect(err({ ...base, seasons: { unit: "year", marks: [{ name: "x", from: 1 }] } })).toContain("phase in [0, 1)");
    expect(err({ ...base, seasons: { unit: "year", marks: [{ name: "", from: 0 }] } })).toContain("needs a name");
    const twin = { ...base.bodies![0]!, id: "luna-2" };
    expect(err({ ...base, bodies: [...base.bodies!, twin] })).toContain('moon "Luna" is declared more than once');
    expect(err({ ...base, bodies: [{ ...base.bodies![0]!, moon: { name: "" } }] })).toContain("a moon needs a name");
  });

  test("PHASE lines need a MOON line, and one VSEASONS block per calendar", () => {
    const text = print(base);
    expect(() => parse(text.replace("MOON:Luna\n", ""))).toThrow(/PHASE lines belong to a body with a MOON line/);
    const seasons = text.slice(text.indexOf("BEGIN:VSEASONS"), text.indexOf("END:VSEASONS") + "END:VSEASONS".length);
    expect(() => parse(text.replace(seasons, `${seasons}\n\n${seasons}`))).toThrow(/one VSEASONS block/);
  });
});

describe("definitionContent: what the hash covers", () => {
  const ast: CalendarAst = {
    ...GREGORIAN,
    seasons: { unit: "year", marks: FOUR },
    bodies: [{ id: "luna", period: { n: 2953, d: 100 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna", phases: [{ name: "Full", at: 0.5 }] } }],
    rules: [{ id: "harvest", tags: ["festival"], rule: { kind: "recur", freq: "year", by: [{ unit: "month", label: ["October"] }] } }],
  };
  const same = (b: CalendarAst) => JSON.stringify(definitionContent(b)) === JSON.stringify(definitionContent(ast));
  const units = (f: (u: CalendarAst["units"][number]) => CalendarAst["units"][number]) => ({ ...ast, units: ast.units.map(f) });

  test("display fields do not move it", () => {
    expect(same({ ...ast, name: "Renamed" })).toBe(true);
    expect(same({ ...ast, formats: [{ name: "default", pattern: "{year}" }] })).toBe(true);
    expect(same(units((u) => (u.id === "week" ? { ...u, number: 5 } : u)))).toBe(true);
    expect(same({ ...ast, rules: ast.rules!.map((r) => ({ ...r, id: "renamed" })) })).toBe(true);
    expect(same({ ...ast, bodies: ast.bodies!.map((b) => ({ ...b, moon: { name: b.moon!.name, phases: [] } })) })).toBe(true);
    // absent and empty optional lists are one value
    expect(same({ ...ast, days: [] })).toBe(true);
  });

  test("everything that reaches a day, a tag, a year number, a moon or a match moves it", () => {
    expect(same(units((u) => (u.id === "year" ? { ...u, number: 1 } : u)))).toBe(false); // eras attach by year (B1)
    expect(same(units((u) => (u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 9 ? { ...s, name: "Octobre" } : s)) } : u)))).toBe(false); // BYLABEL matches names
    expect(same(units((u) => (u.id === "weekday" && u.kind === "cycle" ? { ...u, labels: u.labels!.map((l, i) => (i === 0 ? { name: "Sun" } : l)) } : u)))).toBe(false);
    expect(same({ ...ast, bodies: ast.bodies!.map((b) => ({ ...b, moon: { name: "Selene" } })) })).toBe(false); // predicates match moon names
    expect(same({ ...ast, bodies: ast.bodies!.map((b) => ({ ...b, period: { n: 2954, d: 100 } })) })).toBe(false);
    expect(same({ ...ast, seasons: { unit: "year", marks: FOUR.map((m, i) => (i === 1 ? { ...m, name: "High summer" } : m)) } })).toBe(false); // season tags
    expect(same({ ...ast, seasons: { unit: "year", marks: FOUR.map((m, i) => (i === 1 ? { ...m, from: 0.26 } : m)) } })).toBe(false);
    expect(same({ ...ast, rules: ast.rules!.map((r) => ({ ...r, tags: ["harvest-fair"] })) })).toBe(false);
    expect(same({ ...ast, days: [{ day: 0, tags: ["coronation"] }] })).toBe(false);
  });
});
