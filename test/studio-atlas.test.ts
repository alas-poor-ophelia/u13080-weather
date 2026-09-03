/**
 * The pure half of the Atlas window (`src/studio/model/atlas.ts`).
 *
 * The three rules this file exists to pin down (SPEC §3.4, PLAN §5.4, Q4):
 *
 *  - **Re-base keeps the zone and takes the station.** Climate and regimes are
 *    the preset's; id, name, modifiers, automation and flipSeasons are the
 *    zone's; the geography is gone.
 *  - **Tier A adjusts temperature only.** A hemisphere-straddling match must
 *    not shift precipitation, wind or sky by half a year, and must not move
 *    `temperature.phase` — the hemisphere is carried by `flipSeasons`, which
 *    the header chip reads (PLAN D9).
 *  - **Every station is real.** `stations()` is the shipped set, so the list
 *    can never show a number nobody measured (SPEC law 4).
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import { applyTierA, describeTierA, latitudeBaselineC, rankPresets, tierAAdjustment, tierAParts } from "../src/core/tier-a";
import type { Geography, Modifier, Preset, ZoneProfile } from "../src/core/types";
import { PRESETS } from "../src/generated/presets";
import {
  adjustedSpark,
  annualOf,
  candidatesFor,
  CLIMATE_BLOBS,
  climateSpace,
  koppenGroup,
  latitudeForBaselineC,
  matchByGeography,
  matchParts,
  presetOf,
  previewMatch,
  rebase,
  searchStations,
  SPACE_H,
  SPACE_W,
  SPARK_SAMPLES,
  sparkOf,
  spaceX,
  spaceXForTerrain,
  spaceY,
  stationOf,
  stations,
  terrainForSpaceX,
  zoneKoppen,
  zonePoint,
} from "../src/studio/model/atlas";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

/** A Bergen-based zone with everything the re-base has to carry through. */
function zone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  const modifiers: Modifier[] = [{ id: "forcings:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] }];
  return {
    id: "bergen",
    name: "Bergen",
    schemaVersion: 1,
    preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers,
    automation: [{ id: "frc.warmth", param: "temperature.mean", op: "offset", points: [[1, 0], [100, 1]] }],
    ...over,
  };
}

function expectClean(z: ZoneProfile): void {
  expect(validateProfile(z).filter((i) => i.level === "error")).toEqual([]);
}

/** A place well south of the equator, so every match straddles it. */
const SOUTHERN: Geography = { latitude: -35, altitude: 120, orographic: "none" };

describe("studio atlas · stations", () => {
  test("the list is the shipped presets minus the alternates, with their real records", () => {
    const list = stations();
    const main = PRESETS.filter((p) => !(p as Preset & { alternate?: boolean }).alternate);
    expect(list.length).toBe(main.length);
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect(list.map((s) => s.id)).toEqual(main.map((p) => p.id));

    const bergen = list.find((s) => s.id === "fjord-coast");
    expect(bergen).toBeDefined();
    // The list names the PLACE, not the preset title and not the GHCN record.
    expect(bergen!.name).toBe("Bergen");
    expect(bergen!.name).toBe(fjord.source.place);
    expect(bergen!.presetName).toBe(fjord.name);
    expect(bergen!.koppen).toBe(fjord.match.koppen);
    expect(bergen!.character).toBe(fjord.character);
    expect(bergen!.sourceName).toBe(fjord.source.stationName);
    expect(bergen!.country).toBe(fjord.source.country);
    expect(bergen!.years).toBe(fjord.source.yearsOfRecord);
    expect(bergen!.latitude).toBe(fjord.match.latitude);
    expect(bergen!.altitude).toBe(fjord.match.altitude);
    expect(bergen!.continentality).toBe(fjord.match.continentality);
    expect(bergen!.orographic).toBe(fjord.match.orographic);
  });

  test("every station's Köppen is the computed class, never the curator's assigned one", () => {
    for (const s of stations()) expect(s.koppen).toBe(presetOf(s.id)!.match.koppen);
  });

  test("search filters on name, station, country and class; an empty query is the whole list", () => {
    expect(searchStations("").length).toBe(stations().length);
    expect(searchStations("   ").length).toBe(stations().length);
    expect(searchStations("fjord").map((s) => s.id)).toEqual(["fjord-coast"]);
    expect(searchStations("undoolya").map((s) => s.id)).toEqual(["red-desert"]);
    expect(searchStations("BERGEN").map((s) => s.id)).toEqual(["fjord-coast"]);
    expect(searchStations("norway").map((s) => s.id)).toContain("fjord-coast");
    expect(searchStations("no such place")).toEqual([]);
  });

  test("stationOf and presetOf answer only for stations that ship", () => {
    expect(stationOf("fjord-coast")?.name).toBe(fjord.source.place);
    expect(stationOf("atlantis")).toBeNull();
    expect(presetOf("atlantis")).toBeNull();
  });
});

describe("studio atlas · re-base", () => {
  test("takes the station's climate and regimes, keeps the zone's own everything", () => {
    const before = zone({ flipSeasons: true, geography: { ...SOUTHERN } });
    const desert = presetOf("red-desert")!;
    const { zone: after, provenance } = rebase(before, "red-desert");

    expect(after.climate).toEqual(desert.climate);
    expect(after.regimes).toEqual(desert.regimes);
    expect(after.preset).toEqual({ id: desert.id, contentHash: desert.contentHash, matched: "manual" });
    expect(after.geography).toBeUndefined();

    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.modifiers).toEqual(before.modifiers);
    expect(after.automation).toEqual(before.automation);
    expect(after.flipSeasons).toBe(true);
    expect(provenance).toContain(desert.source.stationName);
    expectClean(after);
  });

  test("does not mutate the zone it was handed", () => {
    const before = zone();
    const snapshot = JSON.stringify(before);
    rebase(before, "red-desert");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("a zone with no preset can still be re-based, and an unknown id is refused", () => {
    const bare = zone();
    delete bare.preset;
    expect(rebase(bare, "taiga").zone.preset?.id).toBe("taiga");
    expect(() => rebase(zone(), "atlantis")).toThrow();
  });

  test("the Köppen class follows the station it was re-based onto", () => {
    const after = rebase(zone({ modifiers: [] }), "red-desert").zone;
    expect(zoneKoppen(after)).toBe(presetOf("red-desert")!.match.koppen);
  });
});

describe("studio atlas · match by geography", () => {
  test("picks rankPresets' best over the non-alternate set, and quotes describeTierA exactly", () => {
    const result = matchByGeography(zone(), SOUTHERN);
    const expected = rankPresets(SOUTHERN, PRESETS.filter((p) => !(p as Preset & { alternate?: boolean }).alternate))[0]!;
    expect(result.candidate.preset.id).toBe(expected.preset.id);
    expect(result.candidate.distance).toBeCloseTo(expected.distance, 12);
    expect(result.provenance).toBe(describeTierA(expected.preset, tierAAdjustment(SOUTHERN, expected.preset.match)));
    expect(previewMatch(SOUTHERN)).toEqual({ candidate: result.candidate, provenance: result.provenance });
  });

  test("writes the geography, marks the preset auto, and keeps the zone's own edits", () => {
    const before = zone();
    const { zone: after } = matchByGeography(before, SOUTHERN);
    expect(after.geography).toEqual(SOUTHERN);
    expect(after.preset?.matched).toBe("auto");
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.modifiers).toEqual(before.modifiers);
    expect(after.automation).toEqual(before.automation);
    expectClean(after);
  });

  test("a hemisphere-straddling match sets flipSeasons and reports it", () => {
    const result = matchByGeography(zone(), SOUTHERN);
    expect(result.candidate.preset.match.latitude).toBeGreaterThan(0);
    expect(result.flipped).toBe(true);
    expect(result.zone.flipSeasons).toBe(true);
    expect(result.provenance).toContain("seasons flipped");
  });

  test("a cross-equator match shifts the curves like the settings tab does, and also sets flipSeasons", () => {
    const result = matchByGeography(zone(), SOUTHERN);
    const source = result.candidate.preset;
    expect(result.flipped).toBe(true);
    const adj = tierAAdjustment(SOUTHERN, source.match);
    expect(adj.hemisphereFlipped).toBe(true);
    // Byte-identical to the settings tab's by-geography path.
    expect(result.zone.climate).toEqual(applyTierA(structuredClone(source.climate), adj));
    // The physical half-year shift moved the phase; the tag remap rides on the flag.
    expect(result.zone.climate.temperature.phase).not.toBe(source.climate.temperature.phase);
    expect(result.zone.flipSeasons).toBe(true);
  });

  test("a same-hemisphere match leaves flipSeasons exactly as it found it", () => {
    const north: Geography = { latitude: 58, altitude: 20, orographic: "windward" };
    expect(matchByGeography(zone(), north).flipped).toBe(false);
    expect(matchByGeography(zone(), north).zone.flipSeasons).toBeUndefined();
    // Set by hand earlier, it survives a match that has no opinion about it.
    expect(matchByGeography(zone({ flipSeasons: true }), north).zone.flipSeasons).toBe(true);
  });

  test("continentality is an optional axis: omitting it keeps the station's own swing", () => {
    const bare: Geography = { latitude: 60, altitude: 12, orographic: "windward" };
    const withAxis: Geography = { ...bare, continentality: 0.9 };
    const a = matchByGeography(zone(), bare);
    const b = matchByGeography(zone(), withAxis);
    expect(a.zone.geography?.continentality).toBeUndefined();
    expect(a.provenance).not.toContain("continentality");
    expect(b.provenance).toContain("continentality");
    expect(b.zone.climate.temperature.mean).not.toEqual(a.zone.climate.temperature.mean);
  });

  test("candidatesFor returns the nearest n, best first, over the non-alternate set", () => {
    const three = candidatesFor(SOUTHERN, 3);
    expect(three.length).toBe(3);
    expect(three[0]!.distance).toBeLessThanOrEqual(three[1]!.distance);
    expect(three[1]!.distance).toBeLessThanOrEqual(three[2]!.distance);
    expect(candidatesFor(SOUTHERN, 0)).toEqual([]);
    expect(candidatesFor(SOUTHERN, 999).length).toBe(stations().length);
  });
});

describe("studio atlas · sparks and Köppen", () => {
  test("a preset sparks its own temperature, twelve samples", () => {
    const spark = sparkOf(fjord);
    expect(spark.length).toBe(SPARK_SAMPLES);
    expect(spark.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...spark) - Math.min(...spark)).toBeGreaterThan(0);
  });

  test("a zone sparks its effective base — the climate-stage layer it is carrying is in it", () => {
    const plain = zone({ modifiers: [] });
    // A climate-stage *layer* — what `effectiveBase` compiles. The forcings
    // trim the fixture zone carries is a later stage and is deliberately not.
    const offset = zone({ modifiers: [{ id: "layer:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] }] });
    const a = sparkOf(plain);
    const b = sparkOf(offset);
    expect(b.length).toBe(SPARK_SAMPLES);
    for (let i = 0; i < SPARK_SAMPLES; i++) expect(b[i]! - a[i]!).toBeCloseTo(2, 6);
  });

  test("zoneKoppen reads the compiled draft, and refuses to invent a class for a broken one", () => {
    expect(zoneKoppen(zone({ modifiers: [] }))).toBe(fjord.match.koppen);
    const broken = zone({ modifiers: [{ id: "layer:temperature.mean:curve", stage: "climate", apply: [{ param: "not.a.path", op: "offset", value: 1 }] }] });
    expect(zoneKoppen(broken)).toBeNull();
  });
});

describe("studio atlas · the climate space", () => {
  test("a station's year is the same aggregation core/koppen.ts classifies on", () => {
    const bergen = stationOf("fjord-coast")!;
    const year = annualOf(fjord);
    expect(bergen.meanC).toBeCloseTo(year.meanC, 9);
    expect(bergen.minC).toBeCloseTo(year.minC, 9);
    expect(bergen.maxC).toBeCloseTo(year.maxC, 9);
    // The record says "wet 230 days a year"; the curves say 223. Real data, not the blurb.
    expect(bergen.wetDays).toBeGreaterThan(200);
    expect(bergen.wetDays).toBeLessThan(250);
    expect(bergen.rainMm).toBeGreaterThan(1500);
    // The min/max pair is the coldest and warmest of the twelve samples.
    const samples = sparkOf(fjord);
    expect(bergen.minC).toBeCloseTo(Math.min(...samples), 9);
    expect(bergen.maxC).toBeCloseTo(Math.max(...samples), 9);
  });

  test("the axes run warm-to-cold down and dry-to-wet across", () => {
    expect(spaceY(27)).toBeLessThan(spaceY(0));
    expect(spaceY(0)).toBeLessThan(spaceY(-20));
    expect(spaceX(200)).toBeLessThan(spaceX(900));
    expect(spaceX(900)).toBeLessThan(spaceX(2500));
    // Both axes are clamped inside the map, whatever they are handed.
    for (const v of [-500, 500]) {
      expect(spaceY(v)).toBeGreaterThanOrEqual(0);
      expect(spaceY(v)).toBeLessThanOrEqual(SPACE_H);
    }
    for (const v of [0, 1, 100000]) {
      expect(spaceX(v)).toBeGreaterThanOrEqual(0);
      expect(spaceX(v)).toBeLessThanOrEqual(SPACE_W);
    }
  });

  test("terrain is the same axis: leeward dry, windward wet, and it round-trips", () => {
    expect(spaceXForTerrain("leeward")).toBeLessThan(spaceXForTerrain("none"));
    expect(spaceXForTerrain("none")).toBeLessThan(spaceXForTerrain("windward"));
    for (const o of ["leeward", "none", "windward"] as const) expect(terrainForSpaceX(spaceXForTerrain(o))).toBe(o);
  });

  test("every station is placed, inside the map, with a de-collided label", () => {
    const points = climateSpace();
    expect(points.map((p) => p.id)).toEqual(stations().map((s) => s.id));
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(SPACE_W);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(SPACE_H);
      expect(p.name.length).toBeGreaterThan(0);
      expect(Math.abs(p.labelX - p.x)).toBeCloseTo(9, 6);
      expect(["start", "end"]).toContain(p.anchor);
    }
    // Deterministic: the same set of stations always draws the same map.
    expect(climateSpace()).toEqual(points);
  });

  test("stations land in the blob their Köppen group names", () => {
    const blob = (g: string) => CLIMATE_BLOBS.find((b) => b.group === g)!;
    const inside = (p: { x: number; y: number }, g: string): boolean => {
      const b = blob(g);
      return ((p.x - b.cx) / b.rx) ** 2 + ((p.y - b.cy) / b.ry) ** 2 <= 1;
    };
    const by = new Map(climateSpace().map((p) => [p.id, p]));
    // One representative per group, checked against its own ellipse.
    expect(inside(by.get("equatorial-rainforest")!, "A")).toBe(true);
    expect(inside(by.get("savanna")!, "A")).toBe(true);
    expect(inside(by.get("red-desert")!, "B")).toBe(true);
    expect(inside(by.get("silk-road-basin")!, "B")).toBe(true);
    expect(inside(by.get("fjord-coast")!, "C")).toBe(true);
    expect(inside(by.get("atlantic-green")!, "C")).toBe(true);
    expect(inside(by.get("taiga")!, "D-E")).toBe(true);
    expect(inside(by.get("tundra")!, "D-E")).toBe(true);
  });

  test("koppenGroup is the class's first letter, and anything odd reads as temperate", () => {
    expect(koppenGroup("Af")).toBe("A");
    expect(koppenGroup("BWh")).toBe("B");
    expect(koppenGroup("Cfb")).toBe("C");
    expect(koppenGroup("Dfc")).toBe("D");
    expect(koppenGroup("ET")).toBe("E");
    expect(koppenGroup("")).toBe("C");
    expect(koppenGroup("??")).toBe("C");
  });
});

describe("studio atlas · geography on the map", () => {
  test("latitudeForBaselineC inverts the core baseline, in the hemisphere it was given", () => {
    for (const lat of [0, 12, 35.5, 60.38, 89]) {
      expect(latitudeForBaselineC(latitudeBaselineC(lat), false)).toBeCloseTo(lat, 4);
      expect(latitudeForBaselineC(latitudeBaselineC(-lat), true)).toBeCloseTo(-lat, 4);
    }
    expect(latitudeForBaselineC(latitudeBaselineC(-42), true)).toBeLessThan(0);
    expect(latitudeForBaselineC(latitudeBaselineC(42), false)).toBeGreaterThan(0);
  });

  test("the zone dot keeps the match's rainfall and moves only by Tier A's temperature", () => {
    const bergen = stationOf("fjord-coast")!;
    const home = zonePoint({ latitude: bergen.latitude, altitude: bergen.altitude, orographic: bergen.orographic })!;
    expect(home.matchId).toBe("fjord-coast");
    // Its own geography: the dot sits on the record it matched.
    expect(home.y).toBeCloseTo(home.matchY, 6);
    expect(home.x).toBe(spaceXForTerrain(bergen.orographic));

    // A kilometre higher is colder, so the dot drops.
    const high = zonePoint({ latitude: bergen.latitude, altitude: bergen.altitude + 1000, orographic: bergen.orographic })!;
    const highStation = stationOf(high.matchId)!;
    expect(high.y).toBeGreaterThan(spaceY(highStation.meanC));
    // Tier A adjusts temperature only, so x is always the match's own rainfall column.
    expect(high.matchX).toBe(spaceX(highStation.rainMm));
  });

  test("matchParts is exactly what describeTierA joins, and the sparks bracket the adjustment", () => {
    const place = { latitude: -35, altitude: 1200, orographic: "none" } as const;
    const candidate = candidatesFor(place, 1)[0]!;
    const adj = tierAAdjustment(place, candidate.preset.match);
    expect(matchParts(place)).toEqual(tierAParts(adj));
    expect(previewMatch(place)!.provenance).toContain(matchParts(place)[0]!);

    const record = sparkOf(candidate.preset);
    const adjusted = adjustedSpark(candidate.preset, adj);
    expect(adjusted.length).toBe(SPARK_SAMPLES);
    // Tier A moves the YEAR'S MEAN by exactly latitude + altitude; the swing
    // scale and the hemisphere shift both leave the mean where it was.
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(adjusted) - mean(record)).toBeCloseTo(adj.latitudeDeltaC + adj.altitudeDeltaC, 3);
    expect(Math.abs(adj.altitudeDeltaC)).toBeGreaterThan(0.05);
    // The record itself is untouched.
    expect(sparkOf(candidate.preset)).toEqual(record);
  });

  test("a place with no adjustment to make reports no parts at all", () => {
    const bergen = stationOf("fjord-coast")!;
    expect(matchParts({ latitude: bergen.latitude, altitude: bergen.altitude, orographic: bergen.orographic })).toEqual([]);
  });
});
