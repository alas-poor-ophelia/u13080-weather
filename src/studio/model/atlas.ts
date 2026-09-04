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
import { evalCurve, sampleCurve } from "../../core/curve";
import { describeKoppen, koppenOfClimate } from "../../core/koppen";
import { resolveProfile } from "../../core/profile";
import { applyTierA, describeTierA, latitudeBaselineC, rankPresets, tierAAdjustment, tierAParts, type MatchCandidate, type TierAAdjustment } from "../../core/tier-a";
import type { Geography, Orographic, Preset, ZoneProfile } from "../../core/types";
import { PRESETS } from "../../generated/presets";
import { zoneFromPreset } from "../../plugin/zones";
import { effectiveBase } from "./compile";

/** How many samples a spark line carries — one per month of the year (SPEC §3.4). */
export const SPARK_SAMPLES = 12;

/** The curve every spark and every Tier A adjustment is about. */
const TEMPERATURE = "temperature.mean";

/** The Köppen group a class code falls in — the four blobs of the climate space. */
export type KoppenGroup = "A" | "B" | "C" | "D" | "E";

/** One row of the station list, and the card that opens from it. */
export interface Station {
  id: string;
  /**
   * The station's place, as the list and the card name it — `Bergen`, from
   * `source.place`. NOT the preset title (`Fjord Coast`), which names the
   * *character* rather than the place, and not the dataset's own record name
   * (`Bergen Florida`), which is a GHCN facility string.
   */
  name: string;
  /** the preset title behind the station — `Fjord Coast` */
  presetName: string;
  /** the COMPUTED class (`match.koppen`), never the curator's assigned one */
  koppen: string;
  /** `temperate oceanic` — the class in words, from `core/koppen.ts`'s own table */
  koppenDescription: string;
  /** `C` — the class's first letter, which is the climate-space blob it sits in */
  group: KoppenGroup;
  /** the preset's one-line character, as the card's sentence */
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
  /** coldest and warmest monthly mean, °C — the card's `2° … 14 °C` */
  minC: number;
  maxC: number;
  /** mean annual temperature, °C — the climate space's y axis */
  meanC: number;
  /** mean annual rainfall, mm — the climate space's x axis */
  rainMm: number;
  /** wet days a year — the card's `wet 223 d/yr` */
  wetDays: number;
}

/**
 * The presets a user may pick from: the shipped set minus the `alternate`
 * ones, mirroring `settings-tab.ts` and `zoneFromGeography`. Computed once —
 * `PRESETS` is generated and never changes at runtime.
 */
const MAIN_PRESETS: readonly Preset[] = PRESETS.filter((p) => !(p as Preset & { alternate?: boolean }).alternate);

/**
 * The station's year in three numbers, from its own curves: mean annual
 * temperature, mean annual rainfall and wet days. Exactly the aggregation
 * `core/koppen.ts` classifies on — expected rain per month is
 * days × stationary wet-day probability × mean wet-day amount — so the
 * numbers the Atlas prints and the class it prints them under agree by
 * construction. Real data only (SPEC law 4).
 */
export function annualOf(preset: Preset): { meanC: number; minC: number; maxC: number; rainMm: number; wetDays: number } {
  const t = preset.climate.temperature;
  const p = preset.climate.precipitation;
  const daysPerBin = 365.25 / 12;
  let meanC = 0;
  let rainMm = 0;
  let wetDays = 0;
  let minC = Infinity;
  let maxC = -Infinity;
  for (let i = 0; i < 12; i++) {
    const at = (i + 0.5) / 12;
    const c = evalCurve(t.mean, at);
    meanC += c / 12;
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    const pww = evalCurve(p.pww, at);
    const pwd = evalCurve(p.pwd, at);
    const denom = 1 - pww + pwd;
    const wet = denom <= 0 ? 0 : daysPerBin * (pwd / denom);
    wetDays += wet;
    rainMm += Math.max(0, wet * evalCurve(p.shape, at) * evalCurve(p.scale, at));
  }
  return { meanC, minC, maxC, rainMm, wetDays };
}

/** The blob a class sits in: its first letter, with anything unrecognised read as C. */
export function koppenGroup(code: string): KoppenGroup {
  const head = code.charAt(0).toUpperCase();
  return head === "A" || head === "B" || head === "C" || head === "D" || head === "E" ? head : "C";
}

const STATIONS: readonly Station[] = MAIN_PRESETS.map((p) => {
  const year = annualOf(p);
  return {
    id: p.id,
    name: p.source.place,
    presetName: p.name,
    koppen: p.match.koppen,
    koppenDescription: describeKoppen(p.match.koppen),
    group: koppenGroup(p.match.koppen),
    character: p.character,
    latitude: p.match.latitude,
    altitude: p.match.altitude,
    continentality: p.match.continentality,
    orographic: p.match.orographic,
    sourceName: p.source.stationName,
    country: p.source.country,
    years: p.source.yearsOfRecord,
    ...year,
  };
});

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

/**
 * Case-insensitive filter over place, preset title, dataset station name,
 * country, Köppen class and character. The Atlas itself no longer shows a
 * search box (the prototype has none), but the filter is the one place that
 * knows every name a station answers to, and `settings-tab.ts` and the tests
 * read it.
 */
export function searchStations(query: string): readonly Station[] {
  const q = query.trim().toLowerCase();
  if (q === "") return STATIONS;
  return STATIONS.filter((s) => `${s.name} ${s.presetName} ${s.sourceName} ${s.country} ${s.koppen} ${s.character}`.toLowerCase().includes(q));
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

// ---------------------------------------------------------------------------
// The Köppen climate space (SPEC §3.4; `proto-markup/1267-vst-atlas.html`)
// ---------------------------------------------------------------------------

/**
 * The map is a scatter in climate space, not a map of the Earth:
 *
 *   y   mean annual temperature — warm at the top, cold at the bottom
 *   x   mean annual rainfall on a log axis — dry at the left, wet at the right
 *
 * Both axes come out of `annualOf`, so a station's dot and the class printed
 * beside it are the same reading (SPEC law 4 — nothing here is invented).
 *
 * The four blobs are the prototype's own ellipses, and the two scales are
 * anchored so that the shipped stations land inside the blob their Köppen
 * group names: A up and to the right, B at the dry left, C in the middle
 * band, D–E along the cold bottom. The units are the SVG's, 480 × 380.
 */
export const SPACE_W = 480;
export const SPACE_H = 380;

/** y = `SPACE_Y_AT` at `SPACE_C_AT` °C, `SPACE_Y_PER_C` units colder per degree. */
const SPACE_C_AT = 26.1;
const SPACE_Y_AT = 80;
const SPACE_Y_PER_C = 8.6;
/** x is log-rainfall, anchored at the dry and wet ends of the shipped set. */
const SPACE_MM_DRY = 150;
const SPACE_MM_WET = 2800;
const SPACE_X_DRY = 56;
const SPACE_X_WET = 428;
/** Dots stay clear of the frame so their labels have somewhere to sit. */
const SPACE_X_RANGE: readonly [number, number] = [26, 452];
const SPACE_Y_RANGE: readonly [number, number] = [30, 352];

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Where a mean annual temperature sits on the map's y axis. */
export function spaceY(meanC: number): number {
  return clampTo(SPACE_Y_AT + (SPACE_C_AT - meanC) * SPACE_Y_PER_C, SPACE_Y_RANGE[0], SPACE_Y_RANGE[1]);
}

/** Where a mean annual rainfall sits on the map's x axis. */
export function spaceX(rainMm: number): number {
  const span = (SPACE_X_WET - SPACE_X_DRY) / (Math.log(SPACE_MM_WET) - Math.log(SPACE_MM_DRY));
  const x = SPACE_X_DRY + (Math.log(Math.max(1, rainMm)) - Math.log(SPACE_MM_DRY)) * span;
  return clampTo(x, SPACE_X_RANGE[0], SPACE_X_RANGE[1]);
}

/**
 * Terrain reads as the same axis: a leeward slope is the dry side of the range
 * and a windward one the wet side, so the zone dot's x is a column, and
 * dragging it across the columns is what picks the terrain. Both the columns
 * and the thresholds are the prototype's.
 */
const TERRAIN_X: Record<Orographic, number> = { leeward: 100, none: 250, windward: 400 };

export function spaceXForTerrain(o: Orographic): number {
  return TERRAIN_X[o];
}

export function terrainForSpaceX(x: number): Orographic {
  return x < 175 ? "leeward" : x > 325 ? "windward" : "none";
}

/** One of the four soft ellipses the stations are scattered over. */
export interface ClimateBlob {
  group: KoppenGroup | "D-E";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  label: string;
  labelX: number;
  labelY: number;
}

/** The prototype's four blobs, verbatim (`proto-markup/1267-vst-atlas.html`). */
export const CLIMATE_BLOBS: readonly ClimateBlob[] = [
  { group: "A", cx: 360, cy: 80, rx: 130, ry: 80, label: "A · tropical", labelX: 360, labelY: 46 },
  { group: "B", cx: 110, cy: 150, rx: 100, ry: 90, label: "B · dry", labelX: 86, labelY: 96 },
  { group: "C", cx: 290, cy: 210, rx: 150, ry: 80, label: "C · temperate", labelX: 330, labelY: 176 },
  { group: "D-E", cx: 180, cy: 310, rx: 170, ry: 60, label: "D–E · cold & polar", labelX: 120, labelY: 290 },
];

/** A station's dot on the map, with its name already placed clear of its neighbours'. */
export interface StationPoint {
  id: string;
  name: string;
  group: KoppenGroup;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  anchor: "start" | "end";
}

/**
 * The map's stations, hand-placed.
 *
 * The prototype does not compute this scatter: `Component.STATIONS`
 * (`proto-markup/1397-logic-class-Component.js`) is a CURATED table of ten
 * records with x/y chosen by hand in the map's own 480 × 380 space, each one
 * inside the ellipse its Köppen group draws and each label already clear of
 * its neighbours'. Twenty-six computed dots do not spread that comfortably —
 * they collide, and some land outside their own blob — so the MAP keeps the
 * prototype's table verbatim while the LIST and the search keep every shipped
 * station (`stations()`).
 *
 * Each prototype station has an exact shipped counterpart — same place, same
 * Köppen class — so this is a straight rename of the prototype's own ids to
 * the shipped preset slugs. Nothing is substituted or approximated.
 */
export const MAP_STATIONS: readonly { id: string; x: number; y: number }[] = [
  { id: "fjord-coast", x: 348, y: 222 }, // bergen · Bergen, Cfb
  { id: "southern-oceanic", x: 300, y: 236 }, // hobart · Hobart, Cfb
  { id: "atlantic-green", x: 262, y: 196 }, // coruna · A Coruña, Csb
  { id: "equatorial-rainforest", x: 402, y: 66 }, // singapore · Singapore, Af
  { id: "savanna", x: 330, y: 96 }, // darwin · Darwin, Aw
  { id: "red-desert", x: 92, y: 128 }, // undoolya · Undoolya, BWh
  { id: "silk-road-basin", x: 148, y: 182 }, // lanzhou · Lanzhou, BSk
  { id: "taiga", x: 176, y: 306 }, // sodankyla · Sodankylä, Dfc
  { id: "tundra", x: 96, y: 344 }, // nyalesund · Ny-Ålesund, ET
  { id: "alpine-pass", x: 240, y: 322 }, // fremont · Fremont Pass, Dfc
];

/** Roughly how wide a label is in map units, at the 10 the map draws them at. */
function labelWidth(name: string): number {
  return name.length * 5.2 + 4;
}

/** The box a label occupies, for the guest's de-collision pass below. */
function labelBox(x: number, y: number, name: string, anchor: "start" | "end"): { x0: number; y0: number; x1: number; y1: number } {
  const w = labelWidth(name);
  const x0 = anchor === "start" ? x : x - w;
  return { x0, y0: y - 9, x1: x0 + w, y1: y + 2 };
}

/**
 * Where the guest's label may sit, best first: the prototype's own placement,
 * then BELOW the dot rather than beside it — the dot itself never moves,
 * because its position is the reading. The left-anchored pair is a last
 * resort for a wet station near the right edge, where a right-anchored label
 * would run off the map entirely.
 */
const GUEST_OFFSETS: readonly { dx: number; dy: number; anchor: "start" | "end" }[] = [
  { dx: 10, dy: -6, anchor: "start" },
  { dx: 10, dy: 13, anchor: "start" },
  { dx: 10, dy: 23, anchor: "start" },
  { dx: -10, dy: -6, anchor: "end" },
  { dx: -10, dy: 13, anchor: "end" },
  { dx: -10, dy: 23, anchor: "end" },
];

/**
 * The stations the map draws: the curated ten, in the prototype's own places
 * and with the prototype's own label offset — `x + 10, y - 6`, anchored left,
 * for every dot (`atlasLabelEls`). No de-collision pass among them: the
 * table's coordinates already avoid it.
 *
 * `selected` adds ONE guest: sixteen shipped stations are not on the curated
 * map, and a selection that vanishes when it is picked from the list is worse
 * than a scatter. The guest is drawn at its COMPUTED climate-space position
 * (`spaceX`/`spaceY` — the same reading its class is printed from), so the
 * curated ten are untouched and only the selection is ever added. Its label
 * takes the first placement that clears every curated label and every blob
 * caption; the dot stays where the numbers put it.
 */
export function climateSpace(selected?: string | null): StationPoint[] {
  const points: StationPoint[] = MAP_STATIONS.flatMap((m) => {
    const s = stationOf(m.id);
    return s === null ? [] : [{ id: s.id, name: s.name, group: s.group, x: m.x, y: m.y, labelX: m.x + 10, labelY: m.y - 6, anchor: "start" as const }];
  });
  const guest = selected === undefined || selected === null || points.some((p) => p.id === selected) ? null : stationOf(selected);
  if (guest === null) return points;

  const x = spaceX(guest.rainMm);
  const y = spaceY(guest.meanC);
  const taken = [
    ...CLIMATE_BLOBS.map((b) => labelBox(b.labelX - labelWidth(b.label) / 2, b.labelY, b.label, "start")),
    ...points.map((p) => labelBox(p.labelX, p.labelY, p.name, p.anchor)),
  ];
  const clear = (box: { x0: number; y0: number; x1: number; y1: number }): boolean =>
    box.x0 >= 0 && box.x1 <= SPACE_W && taken.every((t) => box.x1 <= t.x0 || box.x0 >= t.x1 || box.y1 <= t.y0 || box.y0 >= t.y1);
  const at = GUEST_OFFSETS.find((o) => clear(labelBox(x + o.dx, y + o.dy, guest.name, o.anchor))) ?? GUEST_OFFSETS[0]!;
  points.push({ id: guest.id, name: guest.name, group: guest.group, x, y, labelX: x + at.dx, labelY: y + at.dy, anchor: at.anchor });
  return points;
}

/**
 * The card's sentence, in the prototype's form: the preset's character with
 * the wet-day count the stats line prints, ending in a period —
 * `Fjord Coast — mild, grey, rain 223 d/yr.` A character that quotes a day
 * count of its own (`wet 230 days a year`, a curator's round number) has that
 * clause dropped, so the card prints ONE wet-day figure and it is the one
 * `annualOf` computes. `wetDays` is passed already formatted, so it is
 * literally the string the stats line above it carries.
 */
export function stationDescription(s: Station, wetDays: string): string {
  const character = s.character.replace(/,?\s*(?:wet|rain)\s+\d+\s+days? a year/i, "");
  return `${s.presetName} — ${character}, rain ${wetDays} d/yr.`;
}

// ---------------------------------------------------------------------------
// Geography mode: the zone dot, and what Tier A does to the record it matches
// ---------------------------------------------------------------------------

/**
 * Invert `latitudeBaselineC`. The baseline falls monotonically with |latitude|
 * in each hemisphere, so a bisection on 0…90 lands on the latitude a dragged
 * temperature asks for. `south` keeps the drag in the hemisphere it started in
 * — crossing the equator is a decision, not a slip of the wrist.
 */
export function latitudeForBaselineC(target: number, south: boolean): number {
  const sign = south ? -1 : 1;
  let lo = 0;
  let hi = 90;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (latitudeBaselineC(sign * mid) > target) lo = mid;
    else hi = mid;
  }
  return sign * ((lo + hi) / 2);
}

/**
 * Where a described place sits on the map.
 *
 * Tier A adjusts temperature only, so the place keeps its matched station's
 * rainfall — the dot moves straight down the column its terrain names, by
 * exactly the latitude and altitude correction the match is about to apply.
 * `null` when no station ships to match.
 *
 * The record's own point is where the CURATED table put it (`MAP_STATIONS`),
 * so the dashed link lands on the dot the user can actually see; a station the
 * map does not draw falls back to its computed place. The zone then hangs off
 * that point by the correction alone — the y axis is `SPACE_Y_PER_C` units per
 * degree, and colder is further down.
 */
export function zonePoint(geo: Geography): { x: number; y: number; matchId: string; matchX: number; matchY: number } | null {
  const candidate = candidatesFor(geo, 1)[0];
  if (candidate === undefined) return null;
  const station = stationOf(candidate.preset.id);
  if (station === null) return null;
  const adj = tierAAdjustment(geo, candidate.preset.match);
  const at = climateSpace(station.id).find((p) => p.id === station.id);
  const matchY = at?.y ?? spaceY(station.meanC);
  return {
    x: spaceXForTerrain(geo.orographic),
    y: clampTo(matchY - (adj.latitudeDeltaC + adj.altitudeDeltaC) * SPACE_Y_PER_C, SPACE_Y_RANGE[0], SPACE_Y_RANGE[1]),
    matchId: station.id,
    matchX: at?.x ?? spaceX(station.rainMm),
    matchY,
  };
}

/** How many map units one °C of the y axis is — what a vertical drag divides by. */
export const SPACE_UNITS_PER_C = SPACE_Y_PER_C;

/** The core baseline and adjustment, re-exported so the window drags latitude without importing core. */
export { latitudeBaselineC, tierAAdjustment };

/**
 * What Tier A would change about the matched record, clause by clause — the
 * exact strings `describeTierA` joins into its sentence (`core/tier-a.ts`), so
 * the card and the Notice can never drift apart.
 */
export function matchParts(geo: Geography): string[] {
  const candidate = candidatesFor(geo, 1)[0];
  return candidate === undefined ? [] : tierAParts(tierAAdjustment(geo, candidate.preset.match));
}

/**
 * The matched station's temperature year after Tier A — the solid curve of the
 * geography spark, against the record's own dashed one. Twelve samples, like
 * every other spark here.
 */
export function adjustedSpark(preset: Preset, adj: TierAAdjustment): number[] {
  return sampleCurve(applyTierA(structuredClone(preset.climate), adj).temperature.mean, SPARK_SAMPLES);
}
