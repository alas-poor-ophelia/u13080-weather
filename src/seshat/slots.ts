/**
 * Slot lengths inside one parent occurrence (docs/SESHAT-v0.md §2.3): fixed
 * slots plus their gear terms, then the slack slots, each given its `min`
 * and the rest handed out in `fill` order up to each `max`.
 *
 * Shared by the engine (one occurrence) and the validator (every gear state,
 * or every real occurrence), so the two can never share out slack differently.
 */
import type { SlotsUnitAst } from "./ast";

/**
 * The lengths of `u`'s slots in a parent occurrence of `total` days, where
 * `matches(gear)` says whether a gear matches this occurrence's cycle index.
 * A string is the reason they cannot fit.
 */
export function slotLengthsIn(u: SlotsUnitAst, total: number, matches: (gear: string) => boolean): number[] | string {
  const lens: number[] = [];
  const slack: number[] = [];
  let used = 0;
  for (const [i, s] of u.slots.entries()) {
    if (s.length === "slack") {
      lens.push(s.min ?? 0);
      slack.push(i);
    } else {
      let len = s.length;
      for (const t of s.gears ?? []) if (matches(t.gear)) len += t.add;
      if (len < 0) return `slot ${i + 1} is ${len} days`;
      lens.push(len);
    }
    used += lens[i]!;
  }
  let extra = total - used;
  if (!slack.length && extra !== 0) return `slots total ${used} days but its parent occurrence is ${total}`;
  if (extra < 0) return `slots take at least ${used} days but its parent occurrence is ${total}`;
  // one slack slot (the common case) needs no ordering
  const order = slack.length < 2 ? slack : slack.map((i) => ({ i, fill: u.slots[i]!.fill ?? Infinity })).sort((x, y) => x.fill - y.fill || x.i - y.i).map((x) => x.i);
  for (const i of order) {
    const room = (u.slots[i]!.max ?? Infinity) - lens[i]!;
    const give = Math.min(extra, room);
    lens[i]! += give;
    extra -= give;
  }
  if (extra > 0) return `slots take at most ${total - extra} days but its parent occurrence is ${total}`;
  return lens;
}
