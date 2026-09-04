/**
 * The moon's **lit shape**, and the tint ramp that runs with it (SPEC §3.4
 * "Sable · CYCLE").
 *
 * The CYCLE window's ring is only half the widget: the other half is the moon
 * drawn in the middle of it, showing how much of the disc is lit at the phase
 * the pointer last touched. That shape is one SVG path — a half circle plus a
 * half ellipse whose horizontal radius shrinks to nothing at the quarters and
 * flips sign past them — and it is the prototype's `moonPath` exactly.
 *
 * The ramp comes in two forms, because it is asked two different questions.
 *
 *  - `phaseColour` / `phaseLabelColour` are the prototype's ramp verbatim —
 *    `hsl(222, 26%, 28 + phase*45%)` for the ring and its dots, a brighter
 *    `48 + phase*30%` for the names. Alpha cannot stand in for it: an opacity
 *    of `--wadjet-studio-moon` over a near-neutral dark panel desaturates as
 *    it darkens, so the new-moon end of the ring came out grey where the
 *    prototype is still blue. A data-driven *shade* is data, not chrome, so it
 *    is built here and handed to the stylesheet as a custom property — the
 *    same route `windows/seasons.ts` takes for its band tints.
 *  - `phaseTint` is the opacity form, still what the day card's moon and the
 *    moon modifier's phase chips want: those sit on their own surfaces and
 *    read as "how lit", not as a position on the ring.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */

/**
 * The path of the lit part of a moon at `phase` ∈ [0,1]: 0 is new (nothing
 * lit), 0.5 is half, 1 is full. Drawn as the right half of the disc followed
 * by an elliptical arc back to the top, whose x-radius `r·|1−2·phase|` is the
 * terminator: full width and swept the short way at new, zero at half, full
 * width swept the long way at full.
 *
 * A completely empty path would be invisible *and* unclickable, so a new moon
 * keeps the prototype's 2% sliver.
 */
export function litShapePath(phase: number, cx: number, cy: number, r: number): string {
  const f = Math.max(0.02, clamp(phase));
  const rx = Math.abs(r * (1 - 2 * f));
  const sweep = f < 0.5 ? 0 : 1;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${rx.toFixed(2)} ${r} 0 1 ${sweep} ${cx} ${cy - r}`;
}

/**
 * How lit a phase *looks*, as an opacity of the moon colour over whatever it
 * is drawn on: 0.12 at new, 0.88 at full. The day card's moon and the moon
 * modifier's phase chips use this; the CYCLE ring uses `phaseColour` instead
 * (see the file doc).
 */
export function phaseTint(phase: number): number {
  return 0.12 + clamp(phase) * 0.76;
}

/**
 * The colour of one phase on the CYCLE ring — the prototype's `moonSegEls`
 * ramp exactly: hue and saturation fixed at the moon's own blue, lightness
 * 28% at new to 73% at full. Callers pass a segment MIDPOINT, so the default
 * five-phase ring runs 32% (`#3c4967`) to 70% (`#9fabc6`) rather than the full
 * span — those are the two shades the prototype capture shows.
 */
export function phaseColour(phase: number): string {
  return ringColour(28 + clamp(phase) * 45);
}

/**
 * The same ramp for a phase *name* on the ring, which the prototype keeps
 * brighter (lightness 48% → 78%) so every label stays readable — including
 * the one on the new-moon arc.
 */
export function phaseLabelColour(phase: number): string {
  return ringColour(48 + clamp(phase) * 30);
}

/** One rung of the ring ramp: the moon's hue and saturation at `lightness` percent. */
function ringColour(lightness: number): string {
  return `hsl(222, 26%, ${lightness.toFixed(1)}%)`;
}

/**
 * A phase into [0,1]. Unlike `boundaries.ts` this clamps rather than wraps,
 * because 1 here means "full", not "new again" — every caller passes a
 * boundary `at` or a segment midpoint, both already in range, and a number
 * that somehow left it should saturate rather than jump to the far end of the
 * cycle. A non-finite phase draws a new moon.
 */
function clamp(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
