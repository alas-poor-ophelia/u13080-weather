/**
 * The Era window's hint table (SPEC §3.1, §3.4 "Era").
 *
 * Same contract as `hints.ts`: every interactive element carries
 * `data-hint="name — detail"`, the *name* says what the control is and the
 * *detail* says what moving it writes. This window's table lives in its own
 * file because it is per-window vocabulary rather than the studio-wide chrome
 * the header owns — `test/studio-hints-era.test.ts` holds the two halves
 * against each other the way `studio-hints-cycle.test.ts` does for CYCLE.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stops.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const ERA_HINTS: Record<string, Hint> = {
  "era.enabled": ["Power", "on tags every covered day era:<name> and applies its ops — off does neither"],
  "era.name": ["Name", "the tag this era hands out — writes world.eras[i].name and every era:<name> predicate that used the old one"],
  "era.world": ["World scope", "eras are world-level — every zone sees this"],
  "era.from": ["From", "the first year this era covers — writes world.eras[i].from"],
  "era.to": ["To", "the last year this era covers — blank is open-ended, writes world.eras[i].to"],
  "era.playlist": ["Playlist", "zoom the playlist to this era's span"],
  "era.op": ["Op", "drag to change its magnitude — writes world.eras[i].apply[j].value"],
  "era.opLed": ["Power", "mutes this op only, without removing it"],
  "era.opRemove": ["Remove op", "drops it from world.eras[i].apply"],
  "era.opAdd": ["Add op", "pick a parameter to change while this era is active"],
  "era.delete": ["Delete era", "removes it from world.eras and closes this window"],
};

/**
 * The keys `src/studio/ui/windows/era.ts` uses. The unit test scans that file
 * and asserts this list is exactly what it asks for, so a control added
 * without a hint (or a hint left behind by a deleted control) fails the unit
 * gate rather than showing a raw key in the hint bar.
 */
export const ERA_HINT_KEYS: readonly string[] = ["era.enabled", "era.name", "era.world", "era.from", "era.to", "era.playlist", "era.op", "era.opLed", "era.opRemove", "era.opAdd", "era.delete"];

/**
 * The `data-hint` attribute value for `key`. An unknown key falls back to the
 * key itself — the same rule `hintAttr` follows, so a missing entry is visible
 * in the UI instead of silently blanking the bar.
 */
export const eraHint: HintLookup = makeHintLookup(ERA_HINTS);
