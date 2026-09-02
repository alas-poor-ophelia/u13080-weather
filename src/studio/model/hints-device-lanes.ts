/**
 * Hint table for the data-driven device lanes (SPEC §4; bead wadjet-9f9.33).
 *
 * A separate file from `hints-rows.ts` for the reason that file gives itself:
 * each row bead owns its own table, so two crews never edit one object literal.
 * The device rows are also the only rows whose *name* is data — a lane is
 * titled after the device it draws — so the label's hint is built
 * (`deviceLaneTip`) rather than tabled, exactly as `regimeBlockTip` is.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stop. The detail says what the shape means, or where it is
 * edited when it is read-only here.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { HINT_SEPARATOR, makeHintLookup, type Hint, type HintLookup } from "./hints";

/**
 * One entry per SPEC §4 shape, keyed `lane.device.<kind>` so the row can look a
 * span's hint up by the `data-kind` the Lane already wrote on it.
 */
export const DEVICE_LANE_HINTS: Record<string, Hint> = {
  "lane.device": ["Device lane", "when this device fires — click the name to open it"],
  "lane.device.lane": ["Device lane", "drag a clip to move it, its white edges to resize — writes the device's when"],
  "lane.device.clip": ["Clip", "one per year — drag to move it, the white edges to resize"],
  "lane.device.pulse": ["Moon pulse", "one per cycle — click opens the cycle editor; dimmed where a gate mutes it"],
  "lane.device.band": ["Season band", "read-only here — edit the season in Calendar"],
  "lane.device.bar": ["Era", "read-only here — edit the span in the Eras lane"],
  "lane.device.window": ["Spell window", "the device fires somewhere inside — starts and duration are knobs in the window"],
  "lane.device.run": ["Rolled run", "the days this spell actually ran in the seeded roll"],
  "lane.device.many": ["Too many to draw", "zoom in to see this device's spans"],
};

/**
 * Every key `ui/rows/device-rows.ts` asks for.
 * `test/studio-device-lanes.test.ts` holds this list against the table in both
 * directions, so a key added to one and not the other fails the unit gate
 * rather than printing a raw key into the hint bar.
 */
export const DEVICE_LANE_HINT_KEYS: readonly string[] = Object.keys(DEVICE_LANE_HINTS);

/** The `data-hint` value for `key`; an unknown key comes back as-is, so a gap is visible rather than blank. */
export const deviceLaneHint: HintLookup = makeHintLookup(DEVICE_LANE_HINTS);

/** The hint key for one span, from the `data-kind` the Lane wrote on it. */
export function deviceSpanHintKey(kind: string): string {
  const key = `lane.device.${kind}`;
  return key in DEVICE_LANE_HINTS ? key : "lane.device.lane";
}

/**
 * The tip the row's label column carries: the device's own name as the hint's
 * *name*, and its when-summary as the detail (`whenSummary`, the same string
 * the rack unit's chip shows). Not a table entry — the name is data.
 */
export function deviceLaneTip(name: string, whenSummary: string): string {
  return whenSummary === "" ? name : `${name}${HINT_SEPARATOR}${whenSummary}`;
}
