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
import { applyTierA, describeTierA, rankPresets, tierAAdjustment } from "../src/core/tier-a";
import type { Geography, Modifier, Preset, ZoneProfile } from "../src/core/types";
import { PRESETS } from "../src/generated/presets";
import { candidatesFor, matchByGeography, presetOf, previewMatch, rebase, searchStations, SPARK_SAMPLES, sparkOf, stationOf, stations, zoneKoppen } from "../src/studio/model/atlas";

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
    expect(bergen!.name).toBe(fjord.name);
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
    expect(searchStations("BERGEN").map((s) => s.id)).toEqual(["fjord-coast"]);
    expect(searchStations("norway").map((s) => s.id)).toContain("fjord-coast");
    expect(searchStations("no such place")).toEqual([]);
  });

  test("stationOf and presetOf answer only for stations that ship", () => {
    expect(stationOf("fjord-coast")?.name).toBe(fjord.name);
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
