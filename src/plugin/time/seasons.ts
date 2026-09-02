/**
 * Season lookup, shared by the internal calendar and by `World`'s hemisphere
 * flip (PLAN §0 D9). Pure and adapter-agnostic so it can be tested without a
 * calendar or a World.
 */
import type { DayTime } from "../../core/types";

/** A season boundary: `from` is a yearPhase in [0,1). */
export interface SeasonMark {
  name: string;
  from: number;
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
 * Southern-hemisphere view of a day: every `season:*` tag is replaced by the
 * single season half a year away, `(yearPhase + 0.5) mod 1`. Other tags (eras,
 * adapter-specific ones) keep their order. With no seasons to flip the context
 * is returned untouched — an opaque calendar is not an error (D9).
 *
 * When the context carried no season tag at all the flipped tag is still added:
 * `describe()` is the adapter's statement of its season layout, and a flipped
 * zone is a view of that layout, not of the tags the adapter happened to emit.
 */
export function flipSeasonTags(ctx: DayTime, seasons: readonly SeasonMark[]): DayTime {
  if (seasons.length === 0) return ctx;
  const name = seasonAtPhase(seasons, wrapPhase(ctx.yearPhase + 0.5));
  if (name === null) return ctx;
  const tag = `season:${name}`;
  const tags = ctx.tags ?? [];
  const at = tags.findIndex((t) => t.startsWith("season:"));
  const kept = tags.filter((t) => !t.startsWith("season:"));
  // keep the flipped tag where the first season tag was, so tag order is stable
  const next = at < 0 ? [...kept, tag] : [...kept.slice(0, at), tag, ...kept.slice(at)];
  return { ...ctx, tags: next };
}

function wrapPhase(x: number): number {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}
