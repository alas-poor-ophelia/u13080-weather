/**
 * Season lookup, shared by the internal calendar and by `World`'s hemisphere
 * flip (PLAN §0 D9). Pure and adapter-agnostic so it can be tested without a
 * calendar or a World.
 */
import type { DayTime } from "../../core/types";
import { wrap } from "../../seshat/phase";

// one season rule for the legacy calendar and a Seshat definition (docs/SESHAT-v0.md §13.4)
import { seasonAtPhase, type SeasonMark } from "../../seshat/seasons";

export { seasonAtPhase, type SeasonMark };

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
  const name = seasonAtPhase(seasons, wrap(ctx.yearPhase + 0.5));
  if (name === null) return ctx;
  const tag = `season:${name}`;
  const tags = ctx.tags ?? [];
  const at = tags.findIndex((t) => t.startsWith("season:"));
  const kept = tags.filter((t) => !t.startsWith("season:"));
  // keep the flipped tag where the first season tag was, so tag order is stable
  const next = at < 0 ? [...kept, tag] : [...kept.slice(0, at), tag, ...kept.slice(at)];
  return { ...ctx, tags: next };
}

