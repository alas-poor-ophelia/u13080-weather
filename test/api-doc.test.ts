/**
 * docs/API.md §5 worked example: the fixture must actually behave like a
 * `TimeAdapter` (register, describe, extrapolate, honour its own leap-year
 * rule), and the code block in the doc must not have drifted from the
 * fixture it claims to mirror.
 */
import { describe, expect, test } from "bun:test";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { makeAdapter } from "./fixtures/api/third-party-calendar";

describe("test/fixtures/api/third-party-calendar.ts", () => {
  test("registers in a TimeRegistry and becomes active", () => {
    const registry = new TimeRegistry("almanac-of-foo");
    const unregister = registry.register(makeAdapter());
    expect(registry.active?.id).toBe("almanac-of-foo");
    unregister();
    // Symmetric unregister: falls back to whatever else is registered (nothing here, so undefined).
    expect(registry.active).toBeUndefined();
  });

  test("describe() shape", () => {
    const d = makeAdapter().describe!();
    expect(d.label).toBe("Almanac of Foo");
    expect(d.readOnly).toBe(true);
    expect(d.yearLength).toBe(400);
    expect(d.epochYear).toBe(1);
    expect(d.editHint).toBe("Almanac of Foo settings");
    expect(d.seasons).toEqual([
      { name: "Wet", from: 0 },
      { name: "Dry", from: 0.5 },
    ]);
    expect(d.moons).toHaveLength(2);
    expect(d.moons[0]!.name).toBe("Ember");
    expect(d.moons[0]!.phases).toEqual([
      { name: "new", at: 0 },
      { name: "waxing", at: 0.25 },
      { name: "full", at: 0.5 },
      { name: "waning", at: 0.75 },
    ]);
    expect(d.moons[1]!.name).toBe("Cinder");
    expect(d.moons[1]!.phases).toBeUndefined();
  });

  test("toContext extrapolates for negative and huge day ordinals without throwing", () => {
    const a = makeAdapter();
    for (const day of [-1, -1_000_000, 0, Number.MAX_SAFE_INTEGER / 2, Number.MAX_SAFE_INTEGER]) {
      const c = a.toContext(day);
      expect(Number.isFinite(c.yearPhase)).toBe(true);
      expect(c.yearPhase).toBeGreaterThanOrEqual(0);
      expect(c.yearPhase).toBeLessThan(1);
      expect([400, 401]).toContain(c.yearLength);
      expect(Number.isFinite(c.year)).toBe(true);
    }
  });

  test("the leap-year rule is honoured for a known day", () => {
    const a = makeAdapter();
    // Year 3 (0-indexed year 2, the last non-leap year of the first cycle) is days [800, 1200), 400 days long.
    const lastDayOfYear3 = a.toContext(1199);
    expect(lastDayOfYear3.year).toBe(3);
    expect(lastDayOfYear3.yearLength).toBe(400);
    expect(lastDayOfYear3.dayOfYear).toBe(399);

    // Year 4 is the leap year of the cycle: days [1200, 1601), 401 days long.
    const firstDayOfYear4 = a.toContext(1200);
    expect(firstDayOfYear4.year).toBe(4);
    expect(firstDayOfYear4.yearLength).toBe(401);
    expect(firstDayOfYear4.dayOfYear).toBe(0);

    const lastDayOfYear4 = a.toContext(1600);
    expect(lastDayOfYear4.year).toBe(4);
    expect(lastDayOfYear4.yearLength).toBe(401);
    expect(lastDayOfYear4.dayOfYear).toBe(400);

    // The cycle repeats: day 1601 is the first day of year 5 (a fresh non-leap year).
    const firstDayOfYear5 = a.toContext(1601);
    expect(firstDayOfYear5.year).toBe(5);
    expect(firstDayOfYear5.yearLength).toBe(400);
    expect(firstDayOfYear5.dayOfYear).toBe(0);
  });
});

describe("docs/API.md worked example", () => {
  test("the code block matches the fixture it claims to mirror", async () => {
    const fixtureText = await Bun.file(new URL("./fixtures/api/third-party-calendar.ts", import.meta.url)).text();
    const bodyMatch = fixtureText.match(/export function makeAdapter\(\)[\s\S]*/);
    expect(bodyMatch).not.toBeNull();
    const fixtureBody = bodyMatch![0].trim();

    const docText = await Bun.file(new URL("../docs/API.md", import.meta.url)).text();
    expect(docText).toContain("mirrors test/fixtures/api/third-party-calendar.ts");

    const normalise = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(normalise(docText)).toContain(normalise(fixtureBody));
  });
});
