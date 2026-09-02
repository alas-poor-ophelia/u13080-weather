/**
 * The header ⇅ chip's pure logic (`src/studio/model/hemisphere.ts`), pinned
 * against the same hemisphere test `tier-a.ts`'s `tierAAdjustment` uses (PLAN
 * D9, Q4, §0.1) so the Atlas match and the header chip can never disagree
 * about what "straddles the equator" means.
 */
import { describe, expect, test } from "bun:test";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { tierAAdjustment } from "../src/core/tier-a";
import type { ZoneProfile } from "../src/core/types";
import { flipHint, flipState, straddlesEquator, type PresetLatitude } from "../src/studio/model/hemisphere";

function preset(id: string, latitude: number): PresetLatitude {
  return { id, match: { latitude } };
}

const NORTH = preset("north-station", 51);

/** The `MatchProfile` a real preset would carry alongside `NORTH`'s latitude — enough for `tierAAdjustment`. */
const NORTH_MATCH = { latitude: NORTH.match.latitude, altitude: 10, continentality: 0.5, orographic: "none" as const, koppen: "Cfb" };

function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  return {
    id: "z",
    name: "Z",
    schemaVersion: 1,
    preset: { id: NORTH.id, contentHash: "sha256:north", matched: "auto" },
    climate: {} as ZoneProfile["climate"],
    regimes: [],
    modifiers: [],
    ...over,
  };
}

describe("studio hemisphere · straddlesEquator", () => {
  test("opposite non-zero signs straddle, agreeing with tierAAdjustment", () => {
    const z = zone({ geography: { latitude: -35, altitude: 100, orographic: "none" } });
    expect(straddlesEquator(z, [NORTH])).toBe(true);
    expect(tierAAdjustment({ latitude: -35, altitude: 100, orographic: "none" }, NORTH_MATCH).hemisphereFlipped).toBe(true);
  });

  test("same hemisphere does not straddle", () => {
    const z = zone({ geography: { latitude: 20, altitude: 100, orographic: "none" } });
    expect(straddlesEquator(z, [NORTH])).toBe(false);
  });

  test("a zone with no geography never straddles", () => {
    expect(straddlesEquator(zone(), [NORTH])).toBe(false);
  });

  test("a zone latitude of exactly 0 never straddles", () => {
    const z = zone({ geography: { latitude: 0, altitude: 100, orographic: "none" } });
    expect(straddlesEquator(z, [NORTH])).toBe(false);
  });

  test("a preset id nothing ships under answers false", () => {
    const z = zone({ geography: { latitude: -35, altitude: 100, orographic: "none" }, preset: { id: "nope", contentHash: "sha256:x", matched: "manual" } });
    expect(straddlesEquator(z, [NORTH])).toBe(false);
  });

  test("a preset sitting exactly on the equator never straddles", () => {
    const equatorial = preset("equatorial", 0);
    const z = zone({ geography: { latitude: -10, altitude: 0, orographic: "none" }, preset: { id: equatorial.id, contentHash: "sha256:equatorial", matched: "auto" } });
    expect(straddlesEquator(z, [equatorial])).toBe(false);
  });
});

const DESCRIBING: CalendarDescription = { label: "Internal", readOnly: false, yearLength: 365, seasons: [{ name: "Winter", from: 0.75 }], moons: [] };
const NO_SEASONS: CalendarDescription = { label: "Fake", readOnly: true, yearLength: 400, seasons: [], moons: [] };

describe("studio hemisphere · flipState", () => {
  test("off when the flag is not set, whatever the calendar", () => {
    expect(flipState(zone(), DESCRIBING)).toBe("off");
    expect(flipState(zone(), null)).toBe("off");
  });

  test("on under a describing calendar with seasons", () => {
    expect(flipState(zone({ flipSeasons: true }), DESCRIBING)).toBe("on");
  });

  test("on-opaque under an adapter with no describe()", () => {
    expect(flipState(zone({ flipSeasons: true }), null)).toBe("on-opaque");
  });

  test("on-no-seasons under a describing adapter naming zero seasons", () => {
    expect(flipState(zone({ flipSeasons: true }), NO_SEASONS)).toBe("on-no-seasons");
  });
});

describe("studio hemisphere · flipHint", () => {
  test("off and on carry no override — the static zone.flip detail shows", () => {
    expect(flipHint("off")).toBeUndefined();
    expect(flipHint("on")).toBeUndefined();
  });

  test("on-opaque names the calendar's silence, on-no-seasons its empty layout", () => {
    expect(flipHint("on-opaque")).toBe("this calendar does not describe its seasons; tags are not remapped");
    expect(flipHint("on-no-seasons")).toBe("this calendar has no seasons");
  });
});
