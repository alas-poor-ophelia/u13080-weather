/**
 * The audition strip's hint table and its day tip (SPEC §3.5, §3.1).
 *
 * `model/hints.ts` holds the studio's *static* hints — one entry per control,
 * reviewed as a set. The audition needs the same table plus one thing no static
 * table can hold: the **day tip**, which is a different sentence for each of the
 * 365 cells and is rebuilt from the roll rather than from a string constant.
 * Both live here so the strip's DOM file stays free of copy.
 *
 * House rules are `hints.ts`'s (SPEC §9): product microcopy, sentence case, the
 * name says what the control is and the detail says what it writes.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */
import { describe, type WeatherReport } from "../../core/report";
import { dayLabel } from "./format";
import { HINT_SEPARATOR, makeHintLookup, type Hint, type HintLookup } from "./hints";

export const AUDITION_HINTS: Record<string, Hint> = {
  "audition.strip": ["Audition", "one seeded year — hover a day, right-click to pin it"],
  "audition.seasons": ["Seasons", "the calendar's season bands under the year — edit them in Calendar"],
  "audition.moon": ["Full moon", "the first moon's phase crossing 0.5"],
  "audition.reroll": ["Re-roll", "draw another preview year — the world seed never changes and pins are kept"],
  "audition.legend": ["Legend", "what a cell's colour means"],
  "audition.pin": ["Pinned day", "an override fixes this day's weather — × removes it"],
  "audition.pins": ["Pins", "the days this zone has fixed by hand"],
  "audition.seed": ["Audition year", "the year and world seed this roll used — a re-roll salts the preview, never the seed"],
};

/**
 * The keys `src/studio/ui/audition.ts` uses. `test/studio-hints-audition.test.ts`
 * scans that file and holds it against this list in both directions, so a
 * control added without a hint fails the unit gate instead of printing a raw
 * key into the hint bar.
 */
export const AUDITION_HINT_KEYS: readonly string[] = ["audition.strip", "audition.seasons", "audition.moon", "audition.reroll", "audition.legend", "audition.pin", "audition.pins", "audition.seed"];

/** The `data-hint` attribute value for `key`; an unknown key falls back to the key itself, as `hintAttr` does. */
export const auditionHint: HintLookup = makeHintLookup(AUDITION_HINTS);

/**
 * One cell's hint: `d129 — <the report, short> · regime:<id>`.
 *
 * The sentence is `core/report.ts`'s own `describe(report, "short")` — the same
 * text the codeblock renderer and the public API produce, so the strip can
 * never drift into a second vocabulary for the same day (SPEC law 4). The
 * regime is appended because the strip is where the regimes lane is read from
 * and `describe` has no reason to name it.
 *
 * `dayOfYear` is **0-based**, the way `AuditionDay` carries it (the internal
 * calendar's `TimeContext.dayOfYear`), and so is `dayLabel` — the tip shows
 * `d0` for the first day of the year, matching the ruler under the strip
 * (bead wadjet-9f9.48.2).
 */
export function dayTip(report: WeatherReport, dayOfYear: number, yearLength: number): string {
  return `${dayLabel(dayOfYear, yearLength)}${HINT_SEPARATOR}${describe(report, "short")} · regime:${report.regime}`;
}
