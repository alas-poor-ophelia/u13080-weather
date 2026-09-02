/**
 * The Seasons · CALENDAR window's half of the hint tables (SPEC §3.1, §3.4
 * "Seasons").
 *
 * `model/hints.ts` is the header's table and the shared mechanism (the
 * `name — detail` attribute encoding, `parseHint`, the default hint). This
 * file holds the entries the Seasons window asks for, so its bead does not
 * have to share `hints.ts` with the header and playlist beads (see
 * `hints-playlist.ts` for the same pattern).
 *
 * Same house rules as `hints.ts` (SPEC §9): product microcopy, sentence
 * case, no explainer prose, no trailing full stop. The *name* says what the
 * control is; the *detail* says what moving it does or writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const SEASONS_HINTS: Record<string, Hint> = {
  "seasons.source": ["Calendar source", "internal calendar is edited here; a plugin calendar mirrors read-only"],
  "seasons.world": ["World scope", "seasons apply to every zone — the first edit this session asks to confirm"],
  "seasons.flag": ["Boundary", "drag to move the season's start"],
  "seasons.bar": ["Seasons", "double-click to split the season under the pointer"],
  "seasons.rename": ["Season name", "double-click to rename"],
  "seasons.merge": ["Merge", "removes this season into the one before it"],
  "seasons.split": ["Split the longest", "halves the longest season into two"],
  "seasons.day": ["Start day", "the season's first day, in the active calendar"],
  "seasons.editHint": ["Edit elsewhere", "this calendar is owned by another plugin"],
};

/**
 * The keys the Seasons window uses. `test/studio-hints-seasons.test.ts`
 * scans `src/studio/ui/windows/seasons.ts` and asserts this list is exactly
 * what it asks for, so a control added without a hint (or a hint left
 * behind by a deleted control) fails the unit gate.
 */
export const SEASONS_HINT_KEYS: readonly string[] = ["seasons.source", "seasons.world", "seasons.flag", "seasons.bar", "seasons.rename", "seasons.merge", "seasons.split", "seasons.day", "seasons.editHint"];

/**
 * The `data-hint` attribute value for `key`, the Seasons window's mirror of
 * `hints.ts`'s `hintAttr`. An unknown key falls back to the key itself
 * rather than an empty string, so a missing entry shows in the UI instead of
 * silently blanking the bar.
 */
export const seasonsHint: HintLookup = makeHintLookup(SEASONS_HINTS);
