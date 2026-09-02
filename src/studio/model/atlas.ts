/**
 * The pure half of the `Atlas · STATION` window (SPEC §3.4, PLAN §5.4).
 *
 * The Atlas is the only place in the studio where a zone's *source* changes,
 * and it changes it in exactly two ways:
 *
 *  - **Re-base** (`rebase`) — the user picked a station by hand. The preset's
 *    `climate` and `regimes` are copied in whole, `preset.matched` becomes
 *    `"manual"`, and the zone stops being described by a geography. Everything
 *    that is the *zone's* rather than the station's survives: id, name,
 *    modifiers, automation, flipSeasons.
 *  - **Match by geography** (`matchByGeography`) — the user described a place
 *    and Tier A picked the nearest station for them. Same copy, plus the
 *    geography, plus `preset.matched = "auto"`.
 *
 * Two contracts worth stating outright, because they are easy to get wrong:
 *
 *  - **Hemisphere: two mechanisms, both applied.** `applyTierA` shifts every
 *    curve by half a year (and `temperature.phase`) when the match crosses the
 *    equator — that is the PHYSICAL climate of a zone in the other hemisphere,
 *    and it is exactly what the settings tab's by-geography path does
 *    (`zoneFromGeography`), so the studio must match it or the two paths
 *    disagree. `flipSeasons` is the SEMANTIC half: under a calendar whose
 *    `season:*` labels are laid out for the station's hemisphere, the shifted
 *    zone needs its tags read half a year away (PLAN D9). The header chip
 *    toggles only the tag remap (PLAN Q4); it never touches the curves.
 *  - **`flipSeasons` is never cleared here.** A match that does not straddle
 *    the equator leaves the flag exactly as the user left it; only the header
 *    chip clears it (SPEC §3.1).
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3). `test/studio-atlas.test.ts`
 * holds every rule above against the real shipped presets.
 */
import { sampleCurve } from "../../core/curve";
import { koppenOfClimate } from "../../core/koppen";
import { resolveProfile } from "../../core/profile";
import { applyTierA, describeTierA, rankPresets, tierAAdjustment, type MatchCandidate } from "../../core/tier-a";
import type { Geography, Orographic, Preset, ZoneProfile } from "../../core/types";
import { PRESETS } from "../../generated/presets";
import { zoneFromPreset } from "../../plugin/zones";
import { effectiveBase } from "./compile";

/** How many samples a spark line carries — one per month of the year (SPEC §3.4). */
export const SPARK_SAMPLES = 12;

/** The curve every spark and every Tier A adjustment is about. */
const TEMPERATURE = "temperature.mean";

/** One row of the station list, and the card that opens from it. */
export interface Station {
  id: string;
  name: string;
  /** the COMPUTED class (`match.koppen`), never the curator's assigned one */
  koppen: string;
  /** the preset's one-line character, as the list shows it */
  character: string;
  latitude: number;
  altitude: number;
  continentality: number;
  orographic: Orographic;
  /** the real station behind the preset — `source.stationName` */
  sourceName: string;
  /** the country the station is in, for the card */
  country: string;
  /** years of record behind the station's numbers */
  years: number;
}

/**
 * The presets a user may pick from: the shipped set minus the `alternate`
 * ones, mirroring `settings-tab.ts` and `zoneFromGeography`. Computed once —
 * `PRESETS` is generated and never changes at runtime.
 */
const MAIN_PRESETS: readonly Preset[] = PRESETS.filter((p) => !(p as Preset & { alternate?: boolean }).alternate);

const STATIONS: readonly Station[] = MAIN_PRESETS.map((p) => ({
  id: p.id,
  name: p.name,
  koppen: p.match.koppen,
  character: p.character,
  latitude: p.match.latitude,
  altitude: p.match.altitude,
  continentality: p.match.continentality,
  orographic: p.match.orographic,
  sourceName: p.source.stationName,
  country: p.source.country,
  years: p.source.yearsOfRecord,
}));

/** Every station the Atlas lists (SPEC §3.4). Real data only (SPEC law 4). */
export function stations(): readonly Station[] {
  return STATIONS;
}

/** The preset behind a station id, or `null` when nothing ships under it. */
export function presetOf(id: string): Preset | null {
  return MAIN_PRESETS.find((p) => p.id === id) ?? null;
}

/** The station row for an id, or `null`. */
export function stationOf(id: string): Station | null {
  return STATIONS.find((s) => s.id === id) ?? null;
}

/** Case-insensitive filter over name, station name, country and Köppen class — what the search box does. */
export function searchStations(query: string): readonly Station[] {
  const q = query.trim().toLowerCase();
  if (q === "") return STATIONS;
  return STATIONS.filter((s) => `${s.name} ${s.sourceName} ${s.country} ${s.koppen} ${s.character}`.toLowerCase().includes(q));
}

/**
 * Re-base `z` onto the station `presetId` names: the preset's climate and
 * regimes copied in whole, `preset.matched = "manual"`, no geography. The
 * zone's own identity and edits (id, name, modifiers, automation, flipSeasons,
 * coordinate) come through untouched.
 *
 * The copy itself goes through `zoneFromPreset` so this can never drift from
 * the shape `AddZoneModal` writes.
 */
export function rebase(z: ZoneProfile, presetId: string): { zone: ZoneProfile; provenance: string } {
  const preset = presetOf(presetId);
  if (preset === null) throw new Error(`no shipped preset "${presetId}"`);
  const copied = zoneFromPreset({ name: z.name, preset, existingIds: new Set<string>() });
  const zone: ZoneProfile = {
    ...structuredClone(z),
    climate: copied.zone.climate,
    regimes: copied.zone.regimes,
    preset: { id: preset.id, contentHash: preset.contentHash, matched: "manual" },
  };
  delete zone.geography;
  return { zone, provenance: copied.provenance };
}

/** The nearest `n` stations to a geography, best first (SPEC §3.4's closest-match card). */
export function candidatesFor(geo: Geography, n: number): MatchCandidate[] {
  return rankPresets(geo, MAIN_PRESETS).slice(0, Math.max(0, n));
}

/**
 * The closest-match card's reading, without touching the zone: the station
 * Tier A picks for `geo`, how far it is, and the exact `describeTierA`
 * sentence the card and the Notice show. `null` when nothing ships.
 */
export function previewMatch(geo: Geography): { candidate: MatchCandidate; provenance: string } | null {
  const candidate = candidatesFor(geo, 1)[0];
  if (candidate === undefined) return null;
  return { candidate, provenance: describeTierA(candidate.preset, tierAAdjustment(geo, candidate.preset.match)) };
}

export interface GeographyMatch {
  zone: ZoneProfile;
  candidate: MatchCandidate;
  /** the exact `describeTierA` sentence the card and the Notice show */
  provenance: string;
  /** the match straddles the equator, so `flipSeasons` was set */
  flipped: boolean;
}

/**
 * Match `z` to the nearest station for `geo` and adjust it (SPEC §3.4).
 *
 * Temperature only: see the file header. The hemisphere is carried by
 * `flipSeasons`, which is set — never cleared — when the zone's latitude and
 * the matched station's latitude are both non-zero and of opposite sign.
 */
export function matchByGeography(z: ZoneProfile, geo: Geography): GeographyMatch {
  const candidate = candidatesFor(geo, 1)[0];
  if (candidate === undefined) throw new Error("no presets available");
  const preset = candidate.preset;
  const adjustment = tierAAdjustment(geo, preset.match);
  // Same adjustment the settings tab applies (zones.ts): a cross-equator match
  // shifts the curves; the tag remap rides on `flipSeasons` below.
  const climate = applyTierA(structuredClone(preset.climate), adjustment);
  const zone: ZoneProfile = {
    ...structuredClone(z),
    climate,
    regimes: structuredClone(preset.regimes),
    preset: { id: preset.id, contentHash: preset.contentHash, matched: "auto" },
    geography: structuredClone(geo),
  };
  if (adjustment.hemisphereFlipped) zone.flipSeasons = true;
  return { zone, candidate, provenance: describeTierA(preset, adjustment), flipped: adjustment.hemisphereFlipped };
}

/**
 * Twelve temperature samples for a spark line: a preset's own
 * `temperature.mean`, or a zone's *effective base* — the curve its
 * climate-stage layers have already edited, which is what the studio's
 * channel editors draw.
 */
export function sparkOf(subject: Preset | ZoneProfile): number[] {
  const curve = "match" in subject ? subject.climate.temperature.mean : effectiveBase(subject, TEMPERATURE);
  return sampleCurve(curve, SPARK_SAMPLES);
}

/**
 * The Köppen class of a zone's *compiled* climate, the same reading the header
 * badge takes. `null` when the draft is one the resolver rejects — a class is
 * never invented for a profile that cannot be resolved (SPEC law 4).
 */
export function zoneKoppen(z: ZoneProfile): string | null {
  try {
    return koppenOfClimate(resolveProfile(z).climate).code;
  } catch {
    return null;
  }
}
