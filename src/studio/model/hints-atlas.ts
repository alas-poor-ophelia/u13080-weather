/**
 * The Atlas window's hint table (SPEC §3.1, §3.4).
 *
 * Same contract as `hints.ts`: every interactive element carries
 * `data-hint="name — detail"`, the *name* says what the control is and the
 * *detail* says what moving it writes.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stops.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const ATLAS_HINTS: Record<string, Hint> = {
  // --- shared chrome ---
  "atlas.mode": ["Mode", "pick a station by hand, or describe the place and let Tier A match it"],

  // --- station mode (SPEC §3.4) ---
  "atlas.search": ["Search", "filter the stations by name, country or Köppen class"],
  "atlas.station": ["Station", "a real station the plugin ships — select it to see its record"],
  "atlas.card": ["Station record", "the source behind the numbers — dataset station, country, years of record"],
  "atlas.spark": ["Spark", "the station's year of temperature against this zone's own"],
  "atlas.rebase": ["Re-base zone", "copies the station's climate and regimes in — writes zone.preset, matched manual"],

  // --- geography mode (SPEC §3.4) ---
  "atlas.map": ["Place", "drag the zone ↕ latitude and ↔ terrain"],
  "atlas.latitude": ["Latitude", "degrees, negative south of the equator — steers the match and the temperature"],
  "atlas.altitude": ["Altitude", "metres above sea level — cools the match by the lapse rate"],
  "atlas.swing": ["Seasonal swing", "keep the matched station's own swing, or scale it by continentality"],
  "atlas.continentality": ["Continentality", "0 coast, 1 deep interior — scales the seasonal swing"],
  "atlas.terrain": ["Terrain", "which side of the range the zone sits on — steers the match"],
  "atlas.match": ["Closest match", "the station Tier A picks for this place, and what it adjusts"],
  "atlas.matchbtn": ["Match by geography", "copies the matched station in, adjusted — writes zone.geography and zone.preset, matched auto"],
};

/**
 * The keys `src/studio/ui/windows/atlas.ts` uses.
 * `test/studio-hints-atlas.test.ts` scans that file and asserts this list is
 * exactly what it asks for, so a control added without a hint (or a hint left
 * behind by a deleted control) fails the unit gate rather than showing a raw
 * key in the hint bar.
 */
export const ATLAS_HINT_KEYS: readonly string[] = [
  "atlas.mode",
  "atlas.search",
  "atlas.station",
  "atlas.card",
  "atlas.spark",
  "atlas.rebase",
  "atlas.map",
  "atlas.latitude",
  "atlas.altitude",
  "atlas.swing",
  "atlas.continentality",
  "atlas.terrain",
  "atlas.match",
  "atlas.matchbtn",
];

/**
 * The `data-hint` attribute value for `key`. An unknown key falls back to the
 * key itself — the same rule `hintAttr` follows, so a missing entry is visible
 * in the UI instead of silently blanking the bar.
 */
export const atlasHint: HintLookup = makeHintLookup(ATLAS_HINTS);
