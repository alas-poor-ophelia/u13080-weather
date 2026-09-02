/**
 * Hint table for the playlist's *data* rows — the lanes that read a real
 * derivation rather than a placeholder (SPEC §3.1's hint bar, §3.2).
 *
 * `hints-playlist.ts` is the playlist surface's own table: the ruler, the
 * playlist window, and the four composed-channel rows `playlist.ts` still
 * mounts as placeholders. This file is the table the rows registered from
 * `ui/rows/*` ask for, so the beads that write one row each never edit one
 * object literal together — each appends its own `row.<id>` entries and its
 * own keys to `ROW_HINT_KEYS`.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stop. The name says what the control is; the detail says
 * what it shows or what clicking it does.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { HINT_SEPARATOR, makeHintLookup, type Hint, type HintLookup } from "./hints";

/** The eras lane (SPEC §3.2 "Eras · world"; bead wadjet-9f9.19). */
export const ERAS_ROW_HINTS: Record<string, Hint> = {
  "row.eras": ["Eras · world", "the world's era timeline — every zone gets these tags"],
  "row.eras.lane": ["Eras", "drag empty lane to add an era; drag a clip to move it, its white edges to resize — writes world.eras"],
  "row.eras.clip": ["Era", "click opens the era window; right-click removes it from world.eras"],
  "row.eras.bar": ["Era", "an era over the middle of this window — click opens it; edit its span at Era zoom"],
};

export const ROW_HINTS: Record<string, Hint> = {
  // --- the regimes lane (SPEC §3.2, §6; bead wadjet-9f9.18) ---
  "row.regimes": ["Regimes", "the rolled state sequence — click a block to select that state"],
  "row.regimes.share": ["Regimes", "share of the year — weight × dwell; zoom in for the rolled runs"],
  "row.regimes.issues": ["Regimes", "fix the zone's issues and the roll comes back"],
  ...ERAS_ROW_HINTS,
};

/**
 * Every key `ui/rows/*` asks for. `test/studio-hints-rows.test.ts` holds this
 * list against `ROW_HINTS` in both directions, so a key added to one and not
 * the other fails the unit gate rather than printing a raw key into the bar.
 */
export const ROW_HINT_KEYS: readonly string[] = ["row.regimes", "row.regimes.share", "row.regimes.issues", ...Object.keys(ERAS_ROW_HINTS)];

/** The `data-hint` attribute value for `key`; an unknown key is returned as-is, so a gap is visible rather than blank. */
export const rowHint: HintLookup = makeHintLookup(ROW_HINTS);

/**
 * The tip one regime block carries: the state's id as the hint's *name* (the
 * `regime:` form devices gate on, so the bar reads like the day tip does) and
 * the dwell so far as its detail. `day` is 1-based within the run and `days`
 * is the run's whole length, so the left edge of a block reads `day 1 of N`.
 *
 * Not a `ROW_HINTS` entry: the name is data, not microcopy — the same reason
 * `hints-audition.ts` builds `dayTip` rather than tabling one.
 */
export function regimeBlockTip(id: string, day: number, days: number): string {
  return `regime:${id}${HINT_SEPARATOR}day ${day} of ${days}`;
}

/** The tip one share-bar segment carries: the state, and its share of the year as a whole percent (SPEC §6). */
export function regimeShareTip(id: string, share: number): string {
  return `regime:${id}${HINT_SEPARATOR}${Math.round(share * 100)}% of the year`;
}
