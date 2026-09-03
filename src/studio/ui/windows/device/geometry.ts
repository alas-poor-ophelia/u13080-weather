/**
 * The device window's pure drawing maths and colour lookups — year-phase
 * spans, season bands, the moon face, the gate ring, and the tag hues. Every
 * function here is a function of its arguments alone.
 */
import type { Era, ModifierOp } from "../../../../core/types";
import type { Device } from "../../../model/devices";
import { SEASON_CYCLE, cycleColour } from "../../../model/palette";
import { CHANNEL_COLOUR, DISC_C, DISC_R } from "./constants";

export function colourOf(param: string): string {
  const root = param.split(".")[0] ?? "";
  if (root === "temperature") return CHANNEL_COLOUR.temperature;
  if (root === "precipitation") return CHANNEL_COLOUR.precipitation;
  if (root === "wind") return CHANNEL_COLOUR.wind;
  return CHANNEL_COLOUR.sky;
}

/** The `season:*` / `era:*` tags this world offers, in calendar then timeline order. */
export function tagSources(seasons: ReadonlyArray<{ name: string }>, eras: readonly Era[]): string[] {
  return [...seasons.map((s) => `season:${s.name}`), ...eras.map((e) => `era:${e.name}`)];
}

/**
 * A tag's own hue: a season takes its band colour, an era takes calendar gold.
 * A season walks `SEASON_CYCLE`, not `DATA_CYCLE` — the same list the Seasons
 * window and the calendar ruler use, so Thaw is green in all three.
 */
export function tagColour(tag: string, seasons: ReadonlyArray<{ name: string }>): string {
  const at = seasons.findIndex((s) => `season:${s.name}` === tag);
  return at >= 0 ? cycleColour(at, SEASON_CYCLE) : "var(--wadjet-studio-gold)";
}

/** `[a, b)` in year phase, split at the wrap so a window across new year draws as two clips. */
export function windowSpans(start: number, length: number): Array<[number, number]> {
  const a = ((start % 1) + 1) % 1;
  const span = Math.min(1, Math.max(0, length));
  if (span === 0) return [];
  if (a + span <= 1) return [[a, a + span]];
  return [
    [a, 1],
    [0, a + span - 1],
  ];
}

/** Season bands as `[from, to)` in year phase; an empty calendar draws one neutral band. */
export function seasonBands(seasons: ReadonlyArray<{ name: string; from: number }>): Array<{ from: number; to: number; name: string; index: number }> {
  if (seasons.length === 0) return [{ from: 0, to: 1, name: "", index: 0 }];
  const sorted = [...seasons].map((s, i) => ({ ...s, index: i })).sort((a, b) => a.from - b.from);
  return sorted.map((s, i) => ({ from: s.from, to: sorted[(i + 1) % sorted.length]!.from + (i === sorted.length - 1 ? 1 : 0), name: s.name, index: s.index }));
}

/**
 * The lit face of a moon at `phase` (0 new, 0.5 full) — the prototype's
 * `moonPath`: a half-disc plus a terminator ellipse whose x-radius is how far
 * from full the phase sits.
 */
export function moonPath(phase: number, cx: number, cy: number, r: number): string {
  const f = Math.max(0.02, Math.min(1, phase));
  const rx = Math.abs(r * (1 - 2 * f));
  const sweep = f < 0.5 ? 0 : 1;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 1 ${sweep} ${cx} ${cy - r}`;
}

/** A point on the gate ring: phase 0 at the top, running clockwise. */
export function ringPoint(phase: number): { x: number; y: number } {
  const a = phase * 2 * Math.PI;
  return { x: DISC_C + DISC_R * Math.sin(a), y: DISC_C - DISC_R * Math.cos(a) };
}

/** How much of the cycle `[a, b)` covers — a full circle when the ends meet. */
export function ringSpan(a: number, b: number): number {
  const d = (((b - a) % 1) + 1) % 1;
  return d === 0 ? 1 : d;
}

/** The gate arc from `a` clockwise to `b`; a full circle stops a hair short so it still draws. */
export function ringArc(a: number, b: number): string {
  const span = Math.min(0.999, ringSpan(a, b));
  const from = ringPoint(a);
  const to = ringPoint(a + span);
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${DISC_R} ${DISC_R} 0 ${span > 0.5 ? 1 : 0} 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

/** The ops an envelope may be drawn on — `set` installs a value, it has no onset to shape. */
export const shapeable = (d: Device): Array<{ op: ModifierOp; i: number }> => d.apply.map((op, i) => ({ op, i })).filter((o) => o.op.op === "offset" || o.op.op === "scale");
