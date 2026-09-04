/**
 * The CYCLE window's hint table (SPEC §3.1, §3.4 "Sable · CYCLE").
 *
 * Same contract as `hints.ts`: every interactive element carries
 * `data-hint="name — detail"`, the *name* says what the control is and the
 * *detail* says what moving it writes. This window's table lives in its own
 * file because it is per-window vocabulary rather than the studio-wide chrome
 * the header owns, and `test/studio-hints-cycle.test.ts` holds the two halves
 * against each other the way `studio-hints.test.ts` does for the header.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stops.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const CYCLE_HINTS: Record<string, Hint> = {
  "cycle.disc": ["Cycle", "one full moon cycle, from new to new"],
  "cycle.arc": ["Phase", "double-click to split it where you clicked"],
  "cycle.handle": ["Phase boundary", "drag around the disc — writes calendar.moons[i].phases[j].at"],
  "cycle.name": ["Phase name", "double-click to rename — writes calendar.moons[i].phases[j].name"],
  "cycle.remove": ["Remove phase", "merges it into the phase before it"],
  "cycle.split": ["Split phase", "halves the longest phase and names the new half"],
  "cycle.preview": ["Phase preview", "the disc shows the moon's lit shape at the last-touched boundary"],
  "cycle.source": ["Calendar source", "which calendar owns these phases"],
  "cycle.edit": ["Edit elsewhere", "this calendar belongs to another plugin"],
};
// Gone with the controls they belonged to (World B 3.2/3.3): `cycle.period`
// now rides in the title bar's caption, which carries no `data-hint`, and the
// panel no longer shows an epoch readout or a `world · N zones` chip at all.

/**
 * The keys `src/studio/ui/windows/cycle.ts` uses. The unit test scans that
 * file and asserts this list is exactly what it asks for, so a control added
 * without a hint (or a hint left behind by a deleted control) fails the unit
 * gate rather than showing a raw key in the hint bar.
 */
export const CYCLE_HINT_KEYS: readonly string[] = [
  "cycle.disc",
  "cycle.arc",
  "cycle.handle",
  "cycle.name",
  "cycle.remove",
  "cycle.split",
  "cycle.preview",
  "cycle.source",
  "cycle.edit",
];

/**
 * The `data-hint` attribute value for `key`. An unknown key falls back to the
 * key itself — the same rule `hintAttr` follows, so a missing entry is visible
 * in the UI instead of silently blanking the bar.
 */
export const cycleHint: HintLookup = makeHintLookup(CYCLE_HINTS);
