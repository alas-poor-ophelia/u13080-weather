/**
 * The Forcings window's and the FRC · warmth row's hint table (SPEC §3.1,
 * §3.2, §3.4 "Forcings · ZONE").
 *
 * Same contract as `hints.ts`: every interactive element carries
 * `data-hint="name — detail"`, the *name* says what the control is and the
 * *detail* says what moving it writes. The window and its playlist row share
 * one table because they are one subject — the zone's warmth — reached from
 * two places (SPEC law 2).
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer
 * prose, no trailing full stops.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const FORCINGS_HINTS: Record<string, Hint> = {
  // --- the Forcings · ZONE window (SPEC §3.4) ---
  "forcings.lane": ["Warmth lane", "the drawn offset at this window's centre year — click to zoom the playlist to Era"],
  "forcings.trim": ["Trim", "a constant °C on top of the lane — writes forcings:temperature.mean"],
  "forcings.total": ["Total into TEMP", "trim plus the lane at the centre year — what the temperature chain receives"],
  "forcings.wetness": ["Wetness", "scales both wet-day probabilities — writes forcings:precipitation"],
  "forcings.koppen": ["Köppen class", "the zone's climate class, read from its own curves — a diagnostic, never an input"],

  // --- the FRC · warmth playlist row (SPEC §3.2) ---
  "forcings.row": ["FRC · warmth", "the zone's warmth over the years — opens the forcings window"],
  "forcings.points": ["Warmth points", "drag a point ↕ °C ↔ year, drag the empty lane to add one, right-click to remove"],
};

/**
 * The keys `src/studio/ui/windows/forcings.ts` and
 * `src/studio/ui/rows/automation-row.ts` use.
 * `test/studio-hints-forcings.test.ts` scans both files and asserts this list
 * is exactly what they ask for, so a control added without a hint (or a hint
 * left behind by a deleted control) fails the unit gate rather than showing a
 * raw key in the hint bar.
 */
export const FORCINGS_HINT_KEYS: readonly string[] = ["forcings.lane", "forcings.trim", "forcings.total", "forcings.wetness", "forcings.koppen", "forcings.row", "forcings.points"];

/**
 * The `data-hint` attribute value for `key`. An unknown key falls back to the
 * key itself — the same rule `hintAttr` follows, so a missing entry is visible
 * in the UI instead of silently blanking the bar.
 */
export const forcingsHint: HintLookup = makeHintLookup(FORCINGS_HINTS);
