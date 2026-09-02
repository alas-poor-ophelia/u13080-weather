/**
 * Hint-bar entries for the JSON drawer (SPEC §3.7, bead wadjet-9f9.37).
 *
 * Kept separate from `src/studio/model/hints.ts` — that table (and
 * `HEADER_HINT_KEYS`) is a scan contract owned by the header bead
 * (`test/studio-hints.test.ts` asserts it is *exactly* what `header.ts` asks
 * for), so a second surface adding entries there would fail that test rather
 * than its own. This table shares the same `data-hint` grammar and separator
 * (`hintAttr`/`parseHint` in `hints.ts`), so the studio's one delegated hint
 * listener reads either table's output without change.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const JSON_HINTS: Record<string, Hint> = {
  "json.copy.zone": ["Copy", "the zone file as shown, to the clipboard"],
  "json.copy.world": ["Copy", "the world keys as shown, to the clipboard"],
  "json.climate.fold": ["Climate", "folded by default — click to expand its five channels"],
};

/** Every key `json-drawer.ts` asks for; `test/studio-hints-json.test.ts` holds it to that. */
export const JSON_HINT_KEYS: readonly string[] = ["json.copy.zone", "json.copy.world", "json.climate.fold"];

/** Same grammar as `hints.ts:hintAttr` — an unknown key falls back to the key itself. */
export const jsonHint: HintLookup = makeHintLookup(JSON_HINTS);
