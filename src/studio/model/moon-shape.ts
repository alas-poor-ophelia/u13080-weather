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
 * The tints are the prototype's `hsl(222, 26%, 28 + mid*45%)` ramp, restated
 * as an *opacity* of `--wadjet-studio-moon` over the panel. The studio keeps
 * every colour in `styles.css` (SPEC §9, BRIEF), so a data-driven shade
 * arrives as a number the stylesheet multiplies a palette token by, never as
 * a colour string built in TypeScript.
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
 * How lit a phase *looks* on the ring, as an opacity of the moon colour over
 * the panel: 0.12 at new, 0.88 at full. The prototype ramps the ring's HSL
 * lightness 28% → 73% across the cycle; over the studio's panel (#2a2d31,
 * L 18%) with the moon token (#cdd9ee, L 86%) those two lightnesses are
 * roughly these two opacities, so the ring reads the same without a colour
 * leaving the stylesheet. The ends are pushed a little further apart than the
 * arithmetic asks for, because the moon token is less saturated than the
 * prototype's blue and needs the extra lightness range to separate as clearly.
 */
export function phaseTint(phase: number): number {
  return 0.12 + clamp(phase) * 0.76;
}

/**
 * The same ramp for a phase *name* on the ring, which the prototype keeps
 * brighter (lightness 48% → 78%) so every label stays readable — including
 * the one on the new-moon arc.
 */
export function phaseLabelTint(phase: number): number {
  return 0.44 + clamp(phase) * 0.44;
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
