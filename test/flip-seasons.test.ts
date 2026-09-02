/**
 * flipSeasons (PLAN §0 D9): the southern-hemisphere view of a calendar's
 * season tags, resolved in World when the active adapter describes its seasons.
 */
import { describe, expect, test } from "bun:test";
import { profileHash, validateProfile } from "../src/core/profile";
import type { DayTime, ZoneProfile } from "../src/core/types";
import { TimeRegistry, type TimeAdapter } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { flipSeasonTags, seasonAtPhase, type SeasonMark } from "../src/plugin/time/seasons";
import { World } from "../src/plugin/world";
import { PRESETS } from "../src/generated/presets";

const FOUR: SeasonMark[] = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

describe("seasonAtPhase", () => {
  test("boundaries are inclusive at the start of a season", () => {
    expect(seasonAtPhase(FOUR, 0)).toBe("Spring");
    expect(seasonAtPhase(FOUR, 0.2499)).toBe("Spring");
    expect(seasonAtPhase(FOUR, 0.25)).toBe("Summer");
    expect(seasonAtPhase(FOUR, 0.5)).toBe("Autumn");
    expect(seasonAtPhase(FOUR, 0.75)).toBe("Winter");
    expect(seasonAtPhase(FOUR, 0.999)).toBe("Winter");
  });

  test("a phase before the first season wraps to the last one", () => {
    const late: SeasonMark[] = [{ name: "Thaw", from: 0.2 }, { name: "Frost", from: 0.7 }];
    expect(seasonAtPhase(late, 0)).toBe("Frost");
    expect(seasonAtPhase(late, 0.19)).toBe("Frost");
    expect(seasonAtPhase(late, 0.2)).toBe("Thaw");
    expect(seasonAtPhase(late, 0.95)).toBe("Frost");
  });

  test("input order does not matter, and no seasons means no season", () => {
    expect(seasonAtPhase([...FOUR].reverse(), 0.3)).toBe("Summer");
    expect(seasonAtPhase([], 0.3)).toBeNull();
  });

  test("matches InternalCalendar.seasonAt exactly (it delegates here)", () => {
    const cfg = { yearLength: 400, epochYear: 1, moons: [], seasons: FOUR };
    const cal = new InternalCalendar(cfg, () => 0);
    for (let i = 0; i < 400; i++) {
      const p = i / 400;
      expect(cal.seasonAt(p)).toBe(seasonAtPhase(FOUR, p));
    }
    const empty = new InternalCalendar({ ...cfg, seasons: [] }, () => 0);
    expect(empty.seasonAt(0.3)).toBeNull();
  });
});

describe("flipSeasonTags", () => {
  test("replaces the season tag with the one half a year away, keeping other tags in place", () => {
    const ctx: DayTime = { yearPhase: 0.3, tags: ["era:Ash", "season:Summer", "weather:odd"] };
    expect(flipSeasonTags(ctx, FOUR).tags).toEqual(["era:Ash", "season:Winter", "weather:odd"]);
    expect(flipSeasonTags({ yearPhase: 0.8, tags: ["season:Winter"] }, FOUR).tags).toEqual(["season:Summer"]);
  });

  test("every season tag collapses to one", () => {
    const ctx: DayTime = { yearPhase: 0.1, tags: ["season:A", "season:B", "era:X"] };
    expect(flipSeasonTags(ctx, FOUR).tags).toEqual(["season:Autumn", "era:X"]);
  });

  test("no seasons: the context passes through untouched", () => {
    const ctx: DayTime = { yearPhase: 0.3, tags: ["season:Summer"] };
    expect(flipSeasonTags(ctx, [])).toBe(ctx);
  });

  test("the flip wraps past the end of the year", () => {
    expect(flipSeasonTags({ yearPhase: 0.9, tags: [] }, FOUR).tags).toEqual(["season:Summer"]); // 1.4 wraps to 0.4
    expect(flipSeasonTags({ yearPhase: 0.6, tags: [] }, FOUR).tags).toEqual(["season:Spring"]); // 1.1 wraps to 0.1
  });
});

// --- World ------------------------------------------------------------------

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;

/** A zone that tags the day with whichever of the two seasons it can see. */
function zoneOf(id: string, flip?: boolean): ZoneProfile {
  return {
    id,
    name: id,
    schemaVersion: 1,
    climate: fjord.climate,
    regimes: fjord.regimes,
    modifiers: [
      { id: "saw-summer", when: { tag: "season:Summer" }, apply: [], tag: "saw:Summer" },
      { id: "saw-winter", when: { tag: "season:Winter" }, apply: [], tag: "saw:Winter" },
    ],
    ...(flip === undefined ? {} : { flipSeasons: flip }),
  };
}

const CAL = { yearLength: 400, epochYear: 1, moons: [], seasons: FOUR };
const AT_030 = 120; // 120/400 = yearPhase 0.30
const AT_080 = 320; // 320/400 = yearPhase 0.80

function internalWorld(zones: ZoneProfile[]): { world: World; cal: InternalCalendar } {
  const cal = new InternalCalendar(CAL, () => AT_030);
  const time = new TimeRegistry("internal");
  time.register(cal);
  return { world: new World({ seed: "flip-seed", zones, overrides: [] }, time), cal };
}

const conditions = (world: World, id: string, day: number): string[] => world.getReport(id, { dayOrdinal: day }).conditions;

describe("World: flipSeasons", () => {
  test("a flipped zone and its unflipped twin see opposite seasons on the same day", () => {
    const { world } = internalWorld([zoneOf("north"), zoneOf("south", true)]);

    expect(conditions(world, "north", AT_030)).toContain("saw:Summer");
    expect(conditions(world, "north", AT_030)).not.toContain("saw:Winter");
    expect(conditions(world, "south", AT_030)).toContain("saw:Winter");
    expect(conditions(world, "south", AT_030)).not.toContain("saw:Summer");

    expect(conditions(world, "north", AT_080)).toContain("saw:Winter");
    expect(conditions(world, "north", AT_080)).not.toContain("saw:Summer");
    expect(conditions(world, "south", AT_080)).toContain("saw:Summer");
    expect(conditions(world, "south", AT_080)).not.toContain("saw:Winter");
  });

  test("flipSeasons: false behaves exactly like an absent flag", () => {
    // same zone id in two worlds, so the per-zone seeding is identical and only the flag differs
    const a = internalWorld([zoneOf("z")]).world.getReport("z", { dayOrdinal: AT_030 });
    const b = internalWorld([zoneOf("z", false)]).world.getReport("z", { dayOrdinal: AT_030 });
    expect(b).toEqual(a);
  });

  test("an opaque adapter (no describe) leaves a flipped zone's tags alone", () => {
    const opaque: TimeAdapter = {
      id: "opaque",
      now: () => null,
      toContext: (d) => ({ dayOrdinal: d, yearPhase: 0.3, yearLength: 400, tags: ["season:Summer"], source: "opaque" }),
      configHash: () => "opaque:1",
    };
    const time = new TimeRegistry("opaque");
    time.register(opaque);
    const world = new World({ seed: "flip-seed", zones: [zoneOf("south", true)], overrides: [] }, time);
    expect(conditions(world, "south", AT_030)).toContain("saw:Summer");
    expect(conditions(world, "south", AT_030)).not.toContain("saw:Winter");
  });

  test("a calendar with zero seasons is not an error for a flipped zone", () => {
    const cal = new InternalCalendar({ ...CAL, seasons: [] }, () => AT_030);
    const time = new TimeRegistry("internal");
    time.register(cal);
    const world = new World({ seed: "flip-seed", zones: [zoneOf("south", true)], overrides: [] }, time);
    expect(conditions(world, "south", AT_030)).not.toContain("saw:Summer");
    expect(conditions(world, "south", AT_030)).not.toContain("saw:Winter");
  });

  test("toggling the flag rebuilds the cached generator (the |flip cache marker)", () => {
    const { world } = internalWorld([zoneOf("z")]);
    expect(conditions(world, "z", AT_030)).toContain("saw:Summer");
    // same seed, same profileHash, same calendarHash — only |flip can invalidate the cache
    world.setState({ seed: "flip-seed", zones: [zoneOf("z", true)], overrides: [] });
    expect(conditions(world, "z", AT_030)).toContain("saw:Winter");
    world.setState({ seed: "flip-seed", zones: [zoneOf("z")], overrides: [] });
    expect(conditions(world, "z", AT_030)).toContain("saw:Summer");
  });
});

describe("flipSeasons: schema", () => {
  test("profileHash ignores the flag (it is calendar-side, not profile-side)", () => {
    const plain = zoneOf("z");
    expect(profileHash(zoneOf("z", true))).toBe(profileHash(plain));
    expect(profileHash(zoneOf("z", false))).toBe(profileHash(plain));
  });

  test("the validator accepts a boolean and rejects anything else", () => {
    expect(validateProfile(zoneOf("z", true))).toEqual([]);
    expect(validateProfile(zoneOf("z", false))).toEqual([]);
    expect(validateProfile(zoneOf("z"))).toEqual([]);
    const bad = { ...zoneOf("z"), flipSeasons: "yes" } as unknown as ZoneProfile;
    expect(validateProfile(bad)).toContainEqual({ level: "error", path: "flipSeasons", message: "flipSeasons must be true or false" });
  });
});
