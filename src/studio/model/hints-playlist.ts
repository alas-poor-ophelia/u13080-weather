/**
 * The playlist's half of the hint tables (SPEC §3.1, §3.2).
 *
 * `model/hints.ts` is the header's table and the shared mechanism (the
 * `name — detail` attribute encoding, `parseHint`, the default hint). This
 * file holds the entries the *playlist* surface and the calendar ruler ask
 * for, so the two beads that write them do not have to share one file.
 *
 * Same house rules as `hints.ts` (SPEC §9): product microcopy, sentence case,
 * no explainer prose, no trailing full stop. The *name* says what the control
 * is; the *detail* says what moving it does or writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const PLAYLIST_HINTS: Record<string, Hint> = {
  // --- the calendar ruler (SPEC §3.2) ---
  "ruler.calendar": ["Calendar", "season bands and era tint — opens the seasons window"],
  "ruler.ticks": ["Timeline", "drag to pan; wheel to zoom under the cursor"],

  // --- the playlist itself ---
  "playlist.window": ["Playlist", "wheel zooms under the cursor, shift+wheel pans, the labels scroll"],
  "playlist.daycard": ["Day card", "the generated day at this zoom — arrives with the channel rows"],

  // --- the four composed channel rows (SPEC §1) ---
  "row.temperature": ["Temperature", "the composed temperature curve — empty until the channel rows land"],
  "row.precipitation": ["Precipitation", "the composed precipitation curve — empty until the channel rows land"],
  "row.wind": ["Wind", "the composed wind curve — empty until the channel rows land"],
  "row.sky": ["Sky", "the composed sky curve — empty until the channel rows land"],
};

/**
 * The keys the playlist surface and the ruler use.
 * `test/studio-hints-playlist.test.ts` scans both files and asserts this list
 * is exactly what they ask for, so a control added without a hint (or a hint
 * left behind by a deleted control) fails the unit gate.
 */
export const PLAYLIST_HINT_KEYS: readonly string[] = [
  "ruler.calendar",
  "ruler.ticks",
  "playlist.window",
  "playlist.daycard",
  "row.temperature",
  "row.precipitation",
  "row.wind",
  "row.sky",
];

/**
 * The `data-hint` attribute value for `key`, the playlist's mirror of
 * `hints.ts`'s `hintAttr`. An unknown key falls back to the key itself rather
 * than an empty string, so a missing entry shows in the UI instead of
 * silently blanking the bar.
 */
export const playlistHint: HintLookup = makeHintLookup(PLAYLIST_HINTS);
