/**
 * The header's `⇅` chip logic (SPEC §3.1; PLAN D9, Q4, §0.1 "Hemisphere
 * (Atlas, W7)").
 *
 * Two mechanisms exist and only one is this file's business: `matchByGeography`
 * (`model/atlas.ts`) applies BOTH a physical curve shift (`applyTierA`) and the
 * `flipSeasons` tag flag when a match straddles the equator. The header chip
 * toggles only the flag — it never re-runs Tier A — so a Guildmaster who
 * flips it back off (or back on) after the match still has the physically
 * shifted curves, just read with or without the half-year tag remap.
 *
 * `straddlesEquator` exists so the chip can be OFFERED even after the flag has
 * been turned off by hand: the geography and the matched preset still disagree
 * on hemisphere, so turning it back on is one click away rather than a trip
 * back to the Atlas.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */
import type { CalendarDescription } from "../../plugin/time/adapter";
import type { ZoneProfile } from "../../core/types";

/** The slice of a preset `straddlesEquator` needs — a real `Preset[]` (`generated/presets.ts`) satisfies this. */
export interface PresetLatitude {
  id: string;
  match: { latitude: number };
}

/**
 * Does the zone's own geography and its matched preset's station latitude
 * straddle the equator? The same test `tier-a.ts`'s `tierAAdjustment` uses for
 * `hemisphereFlipped`: opposite signs, and neither exactly on the line.
 *
 * `undefined` at either end (no geography, or a preset id nothing ships under)
 * answers `false` — there is nothing to straddle.
 */
export function straddlesEquator(z: ZoneProfile, presets: readonly PresetLatitude[]): boolean {
  const lat = z.geography?.latitude;
  if (lat === undefined || lat === 0) return false;
  const preset = presets.find((p) => p.id === z.preset?.id);
  const other = preset?.match.latitude;
  if (other === undefined || other === 0) return false;
  return Math.sign(lat) !== Math.sign(other);
}

/**
 * The chip's four faces:
 *
 *  - `"off"` — `flipSeasons` is not set (whether or not the chip is offered).
 *  - `"on"` — set, under a calendar that describes seasons: the flip actually
 *    remaps tags.
 *  - `"on-opaque"` — set, but the active adapter has no `describe()` at all:
 *    `World` cannot see any tags to remap (PLAN D9), so the flag is inert.
 *  - `"on-no-seasons"` — set, the adapter describes itself, but names zero
 *    seasons: also inert, for a different reason worth a different hint.
 */
export type FlipState = "off" | "on" | "on-opaque" | "on-no-seasons";

/** `flipState(z, calendar)` — which of the four faces the chip and its LED are in right now. */
export function flipState(z: ZoneProfile, calendar: CalendarDescription | null): FlipState {
  if (z.flipSeasons !== true) return "off";
  if (calendar === null) return "on-opaque";
  if (calendar.seasons.length === 0) return "on-no-seasons";
  return "on";
}

/** The hint-bar override for a warn state; `undefined` lets the static `zone.flip` detail show instead. */
export function flipHint(state: FlipState): string | undefined {
  if (state === "on-opaque") return "this calendar does not describe its seasons; tags are not remapped";
  if (state === "on-no-seasons") return "this calendar has no seasons";
  return undefined;
}
