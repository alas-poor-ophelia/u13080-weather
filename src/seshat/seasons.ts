/**
 * Seasons by phase (docs/SESHAT-v0.md §13.4): one rule for the legacy
 * internal calendar and for a Seshat definition, so the two cannot drift.
 * Moved here from src/plugin/time/seasons.ts (which re-exports it).
 */

/** A season boundary: `from` is a phase in [0, 1). */
export interface SeasonMark {
  readonly name: string;
  readonly from: number;
}

/**
 * The season covering `phase`: the last mark whose `from <= phase`, wrapping to
 * the final mark when `phase` falls before the first one. Returns null when the
 * calendar defines no seasons.
 */
export function seasonAtPhase(seasons: readonly SeasonMark[], phase: number): string | null {
  const s = [...seasons].sort((a, b) => a.from - b.from);
  if (s.length === 0) return null;
  let cur = s[s.length - 1]!;
  for (const x of s) if (phase >= x.from) cur = x;
  return cur.name;
}

/**
 * The one season resolver (§16.7 P6): the engine's `seasonAt` and the
 * adapter's `toContext` both read seasons through it. `o` is the occurrence of
 * the seasons unit holding `day` (for the adapter, the year, also past
 * ±DAY_LIMIT). Fraction marks only for now, with the float comparison
 * byte-identical to before: (day − start) / length against each `from`.
 */
export function seasonIn(seasons: { readonly marks: readonly SeasonMark[] }, o: { readonly index: number; readonly start: number; readonly length: number }, day: number): string | null {
  return seasonAtPhase(seasons.marks, (day - o.start) / o.length);
}
