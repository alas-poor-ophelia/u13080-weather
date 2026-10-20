/**
 * Seshat P3a step 2 (docs/SESHAT-v0.md §13.3, §13.6, §13.11): the `seshat`
 * time adapter.
 *
 *   - differential: a definition made from a legacy config, stored as text,
 *     drives World to the same TimeContext and the same WeatherReport as the
 *     legacy InternalCalendar on the golden-cal worlds (eras, flipped seasons,
 *     moon predicates, spells), every day over ±2000 and far out; only the
 *     adapter id and the calendar hash differ;
 *   - load: text that does not parse, validate or pass the world checks is a
 *     fault (read-only, no context, a hash of the raw text), never a fallback;
 *   - hash, describe, format/parse, setNow, and a named rule that throws.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, HEBREW, parse, print, ROMAN, type CalendarAst } from "../src/seshat";
import { TimeRegistry, type TimeAdapter } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { checkWorldCalendar, definitionFromLegacy, SeshatCalendar, WORLD_RULES_MAX } from "../src/plugin/time/seshat";
import type { InternalCalendarConfig } from "../src/plugin/settings";
import { World } from "../src/plugin/world";
import { CAL_SEED, makeWorlds, MOONS_365, MOONS_400 } from "./golden/golden-cal";

/** The rejection of `p`, or undefined if it resolved: asserted on directly, so no assertion floats. */
const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

const FOUR = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
const CONFIGS: Record<string, InternalCalendarConfig> = {
  "internal-365": { yearLength: 365, epochYear: 1, moons: MOONS_365, seasons: FOUR },
  "internal-400": { yearLength: 400, epochYear: 1, moons: MOONS_400, seasons: FOUR },
};

function textOf(cfg: InternalCalendarConfig): string {
  const r = definitionFromLegacy(cfg);
  if ("refused" in r) throw new Error(r.refused);
  return print(r.ast);
}

function worldOn(adapter: TimeAdapter, spec: ReturnType<typeof makeWorlds>[number]): World {
  const time = new TimeRegistry(adapter.id);
  time.register(adapter);
  return new World({ seed: CAL_SEED, zones: spec.zones, eras: spec.eras, overrides: [] }, time);
}

describe("a definition from a legacy config runs the world exactly as the legacy calendar", () => {
  for (const spec of makeWorlds().filter((w) => w.id in CONFIGS)) {
    test(
      `${spec.id}: same TimeContext and WeatherReport in every zone, ±2000 days and the golden days`,
      () => {
        const cfg = CONFIGS[spec.id]!;
        const legacy = worldOn(new InternalCalendar(cfg, () => 0), spec);
        const seshat = worldOn(new SeshatCalendar(textOf(cfg), () => 0), spec);
        const days = [...new Set([...Array.from({ length: 4001 }, (_, i) => i - 2000), ...spec.days])];
        for (const z of spec.zones) {
          for (const d of days) {
            const a = legacy.timeAt(d, z.id);
            const b = seshat.timeAt(d, z.id);
            expect(b.source).toBe("seshat");
            expect([d, { ...b, source: a.source }]).toEqual([d, a]);
            const { provenance: pa, ...ra } = legacy.getReport(z.id, { dayOrdinal: d });
            const { provenance: pb, ...rb } = seshat.getReport(z.id, { dayOrdinal: d });
            expect([d, rb]).toEqual([d, ra]);
            expect(Object.keys(pb).sort()).toEqual(Object.keys(pa).sort());
          }
        }
        expect(seshat.calendarHash()).not.toBe(legacy.calendarHash());
      },
      60_000,
    );
  }

  test("beyond the day line it extrapolates by whole edge years: exact for constant years, total for any", () => {
    const cfg = CONFIGS["internal-365"]!;
    const legacy = new InternalCalendar(cfg, () => 0);
    const seshat = new SeshatCalendar(textOf(cfg), () => 0);
    for (const d of [10_000_001, 10_000_090, 10_010_401, -10_000_001, -10_000_154, -10_012_345]) expect([d, { ...seshat.toContext(d), source: "internal" }]).toEqual([d, legacy.toContext(d)]);
    const greg = new SeshatCalendar(print(GREGORIAN), () => 0);
    const edge = greg.toContext(10_000_000);
    const past = greg.toContext(10_000_000 + 365 * 40);
    expect(past.year! - edge.year!).toBeGreaterThanOrEqual(39);
    expect(past.year! - edge.year!).toBeLessThanOrEqual(40);
    expect(greg.toContext(-10_009_999).dayOrdinal).toBe(-10_009_999);
  });

  test("across the day line, years of any length run on without a jump (Parallax F4)", () => {
    const seasons = { unit: "year", marks: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] };
    for (const cal of [GREGORIAN, HEBREW, ROMAN]) {
      const a = new SeshatCalendar(print({ ...cal, seasons }), () => 0);
      for (const [from, to] of [
        [10_000_000 - 900, 10_000_000 + 3000],
        [-10_000_000 - 3000, -10_000_000 + 900],
      ] as const) {
        let prev = a.toContext(from);
        for (let d = from + 1; d <= to; d++) {
          const c = a.toContext(d);
          if (c.year === prev.year) expect([cal.name, d, c.dayOfYear]).toEqual([cal.name, d, prev.dayOfYear! + 1]);
          else expect([cal.name, d, c.year, c.dayOfYear, prev.dayOfYear]).toEqual([cal.name, d, prev.year! + 1, 0, prev.yearLength - 1]);
          expect(Object.is(c.yearPhase, c.dayOfYear! / c.yearLength)).toBe(true);
          expect(c.tags![0]).toBe(c.yearPhase < 0.5 ? "season:Wet" : "season:Dry");
          prev = c;
        }
      }
    }
  });

  test("the stored text is canonical and reads back to the same definition", () => {
    const text = textOf(CONFIGS["internal-365"]!);
    expect(print(parse(text))).toBe(text);
    const a = new SeshatCalendar(text, () => 0);
    expect(a.fault).toBeNull();
    expect(a.text()).toBe(text);
  });

  test("definitionFromLegacy refuses what has no whole-day form, and names moons it approximates", () => {
    const cfg = CONFIGS["internal-365"]!;
    expect(definitionFromLegacy({ ...cfg, yearLength: 365.25 })).toEqual({ refused: "a year of 365.25 days has no whole-day form" });
    expect(definitionFromLegacy({ ...cfg, epochYear: 0.5 })).toEqual({ refused: "epoch year 0.5 is not a whole year" });
    expect(definitionFromLegacy({ ...cfg, moons: [{ name: "Bad", cycleDays: 0, phaseAtEpoch: 0 }] })).toEqual({ refused: 'moon "Bad": a cycle of 0 days cannot run' });
    const r = definitionFromLegacy(cfg);
    expect("ast" in r && r.lossy).toEqual([]);
    const odd = definitionFromLegacy({ ...cfg, moons: [{ name: "Odd", cycleDays: 29.530588853, phaseAtEpoch: 0.123456789 }] });
    expect("ast" in odd && odd.lossy).toEqual(["Odd"]);
    // lossy or not, the moon runs the legacy body's own rationals: the same phase every day
    if (!("ast" in odd)) throw new Error("refused");
    const legacy = new InternalCalendar({ ...cfg, moons: [{ name: "Odd", cycleDays: 29.530588853, phaseAtEpoch: 0.123456789 }] }, () => 0);
    const seshat = new SeshatCalendar(print(odd.ast), () => 0);
    for (const d of [-9_999_999, -12345, 0, 1, 2953, 4_000_000, 9_999_999]) expect(Object.is(seshat.toContext(d).moons![0]!.phase, legacy.toContext(d).moons![0]!.phase)).toBe(true);
  });
});

describe("a stored definition that cannot run is a fault, never a fallback", () => {
  const good = print(GREGORIAN);
  const faults: Array<[string, unknown, RegExp]> = [
    ["not text", { units: [] }, /not text/],
    ["a syntax error", good.replace("END:VCALENDAR", "END:VNOTHING"), /./],
    ["a validation error", good.replace("GEAR:leap*1", "GEAR:nogear*1"), /nogear/],
    ["no year unit (the world check)", print({ name: "annual", gears: [], units: [{ id: "annum", kind: "cycle", anchor: 0, length: 10 }] }), /id "year"/],
    ["seasons over a unit other than the year (the world check, Parallax F3)", print({ ...GREGORIAN, seasons: { unit: "week", marks: [{ name: "A", from: 0 }] } }), /seasons run over its year, not "week"/],
    ["too many named rules (the world check)", print({ ...GREGORIAN, rules: Array.from({ length: WORLD_RULES_MAX + 1 }, (_, k) => ({ id: `r${k}`, tags: ["t"], rule: { kind: "recur", freq: "year" } })) }), /at most/],
  ];
  for (const [name, stored, msg] of faults) {
    test(name, () => {
      const a = new SeshatCalendar(stored, () => 5);
      expect(a.fault).not.toBeNull();
      expect(a.fault!.message).toMatch(msg);
      expect(a.now()).toBeNull();
      expect(a.definition()).toBeNull();
      expect(a.text()).toBeNull();
      const d = a.describe();
      expect(d.readOnly).toBe(true);
      expect(d.label).toContain("fault");
      expect(a.configHash()).toMatch(/^seshat:fault:[0-9a-f]{16}$/);
    });
  }

  test("a syntax fault carries its line; distinct raw texts hash apart; update recovers", () => {
    const bad = good.replace("END:VCALENDAR", "END:VNOTHING");
    const a = new SeshatCalendar(bad, () => 0);
    expect(typeof a.fault!.line).toBe("number");
    expect(new SeshatCalendar(`${bad}x`, () => 0).configHash()).not.toBe(a.configHash());
    a.update(good);
    expect(a.fault).toBeNull();
    expect(a.configHash()).toMatch(/^seshat:[0-9a-f]{16}$/);
  });

  test("the world checks: a year cycle, at most the named-rule cap, no COUNT, BYSETPOS on a short constant period", () => {
    const rule = (r: unknown) => ({ ...GREGORIAN, rules: [{ id: "r", tags: ["t"], rule: r }] }) as CalendarAst;
    expect(checkWorldCalendar(GREGORIAN)).toEqual([]);
    expect(checkWorldCalendar({ ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "year" ? { ...u, id: "annum" } : u)) }).join()).toContain('id "year"');
    expect(checkWorldCalendar(rule({ kind: "recur", freq: "year", count: 3 })).join()).toContain("COUNT");
    expect(checkWorldCalendar(rule({ kind: "not", of: { kind: "recur", freq: "year", count: 3 } })).join()).toContain("COUNT");
    expect(checkWorldCalendar(rule({ kind: "recur", freq: "year", by: [{ unit: "weekday", label: ["Monday"] }], setpos: [1] })).join()).toContain("BYSETPOS");
    expect(checkWorldCalendar(rule({ kind: "any", of: [{ kind: "recur", freq: "week", by: [{ unit: "weekday", label: ["Monday"] }], setpos: [1] }] }))).toEqual([]);
    expect(checkWorldCalendar(rule({ kind: "recur", freq: "day", setpos: [1] }))).toEqual([]);
    const many = { ...GREGORIAN, rules: Array.from({ length: WORLD_RULES_MAX + 1 }, (_, i) => ({ id: `r${i}`, tags: ["t"], rule: { kind: "recur", freq: "year" } })) } as CalendarAst;
    expect(checkWorldCalendar(many).join()).toContain(`at most ${WORLD_RULES_MAX}`);
  });
});

describe("hash, describe, format, parse, setNow", () => {
  const cfg = CONFIGS["internal-365"]!;
  const text = textOf(cfg);
  const ast = parse(text);

  test("the hash moves with what reaches a day and ignores what only names the calendar", () => {
    const h = (a: CalendarAst) => new SeshatCalendar(print(a), () => 0).configHash();
    expect(h(ast)).toMatch(/^seshat:[0-9a-f]{16}$/);
    expect(h({ ...ast, name: "Renamed" })).toBe(h(ast));
    expect(h({ ...ast, formats: [{ name: "default", pattern: "{year}/{year:day}" }] })).toBe(h(ast));
    expect(h({ ...ast, units: ast.units.map((u) => ({ ...u, number: 2 })) })).not.toBe(h(ast));
    expect(h({ ...ast, seasons: { unit: "year", marks: FOUR.slice(1) } })).not.toBe(h(ast));
  });

  test("describe gives the Studio the legacy shape, editable", () => {
    const d = new SeshatCalendar(text, () => 0).describe();
    const l = new InternalCalendar(cfg, () => 0).describe();
    expect(d.readOnly).toBe(false);
    expect(d.editHint).toBeUndefined();
    expect(d.yearLength).toBe(l.yearLength);
    expect(d.epochYear).toBe(l.epochYear);
    expect(d.seasons).toEqual(l.seasons);
    expect(d.moons.map((m) => [m.name, m.cycleDays])).toEqual(l.moons.map((m) => [m.name, m.cycleDays]));
  });

  test("a definition from the internal calendar writes and reads dates as it does (Parallax F9)", () => {
    const a = new SeshatCalendar(text, () => 0);
    const legacy = new InternalCalendar(cfg, () => 0);
    for (const d of [-800, -1, 0, 1, 90, 364, 365, 100_000, 9_999_999]) expect([d, a.format(d)]).toEqual([d, legacy.format(d)]);
    expect(a.format(0)).toBe("Year 1, day 1 (Spring)");
    for (const t of ["1-1", "3-14", "-5-365", "2-366", "2-0", " 42 ", "not a day", "1-1-1"]) expect([t, a.parse(t)]).toEqual([t, legacy.parse(t)]);
  });

  test("a calendar with formats writes and reads through them", () => {
    const g = new SeshatCalendar(print(GREGORIAN), () => 0);
    for (const d of [-800, -1, 0, 1, 364, 365, 100_000]) expect(g.parse(g.format(d))).toBe(d);
    expect(g.format(0)).toBe("1970-01-01");
  });

  test("setNow checks the day, writes it and tells subscribers; now() reads the stored day", async () => {
    let stored = 3;
    const a = new SeshatCalendar(text, () => stored, (d) => void (stored = d));
    let calls = 0;
    const off = a.subscribe(() => calls++);
    await a.setNow(400);
    expect(stored).toBe(400);
    expect(calls).toBe(1);
    expect(a.now()!.dayOrdinal).toBe(400);
    off();
    await a.setNow(1);
    expect(calls).toBe(1);
    expect(await rejection(a.setNow(1.5))).toBeInstanceOf(TypeError);
    expect(stored).toBe(1);
    expect(((await rejection(new SeshatCalendar(text, () => 0).setNow(1))) as Error).message).toMatch(/no place to store/);
  });

  test("a named rule that throws loses only its own tags, and is reported once (Parallax F5)", () => {
    const rules = [
      { id: "fails", tags: ["bad"], rule: { kind: "dates" as const, days: [7, 8] } },
      { id: "fine", tags: ["fair"], rule: { kind: "dates" as const, days: [7, 8] } },
    ];
    const a = new SeshatCalendar(print({ ...ast, days: [{ day: 7, tags: ["coronation"] }], rules }), () => 0);
    // the real per-rule path: the engine's rule evaluation throws for one rule only
    const days = (a as unknown as { engine: Engine }).engine.days;
    const holds = days.holds.bind(days);
    const failing = a.definition()!.rules![0]!.rule;
    days.holds = (r, d) => {
      if (r === failing) throw new Error("boom");
      return holds(r, d);
    };
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      expect(a.toContext(7).tags).toEqual(["season:Spring", "coronation", "fair"]);
      expect(a.toContext(8).tags).toEqual(["season:Spring", "fair"]);
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(1);
    expect(String((errors[0] as unknown[])[0])).toContain('"fails"');
  });

  test("Engine.tagsAt isolates a throwing rule only when asked to; otherwise it throws as before", () => {
    // a COUNT walk past 10^6 days passes validation and throws when it runs (world calendars refuse COUNT)
    const cal: CalendarAst = { ...GREGORIAN, rules: [{ id: "walk", tags: ["w"], rule: { kind: "recur", freq: "day", anchor: -2_000_000, count: 3_000_000 } }, { id: "ok", tags: ["ok"], rule: { kind: "dates", days: [5] } }] };
    const e = new Engine(cal);
    expect(() => e.tagsAt(5)).toThrow();
    const seen: string[] = [];
    expect(e.tagsAt(5, (id) => seen.push(id))).toEqual(["ok"]);
    expect(seen).toEqual(["walk"]);
  });
});
