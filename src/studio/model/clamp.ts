/**
 * Pure window-box geometry (SPEC §3.4): keep every floating panel inside the
 * studio box, and give a freshly opened panel with no remembered position a
 * cascade start point. No DOM, no Obsidian — `components/window.ts` and
 * `ui/windows.ts` are the only callers.
 */

/** Where a panel with no remembered position lands: a cascade from the top-left. */
export const CASCADE_ORIGIN = 24;
export const CASCADE_STEP = 22;

/**
 * Constrain a `w`×`h` rect at `(x, y)` inside a `boxW`×`boxH` box. The full
 * width must stay onscreen (a window is dragged by its whole horizontal
 * extent), but only the top `margin` px — the title bar — has to (a panel
 * taller than the box may still hang off its bottom edge, so long as its bar
 * stays reachable to drag it back).
 */
export function clampRect(x: number, y: number, w: number, h: number, boxW: number, boxH: number, margin: number): { x: number; y: number } {
  const maxX = Math.max(0, boxW - w);
  const maxY = Math.max(0, boxH - Math.min(margin, h));
  return {
    x: Math.min(Math.max(0, x), maxX),
    y: Math.min(Math.max(0, y), maxY),
  };
}

/**
 * The prototype's own studio box (`Climate Studio v3.dc.html` at 1560×960) —
 * the frame `Component.DEFPOS` measured its per-window start points in.
 */
export const PROTO_BOX_W = 1560;
export const PROTO_BOX_H = 960;

/**
 * A prototype DEFPOS point, scaled into this studio's box. The prototype opens
 * every panel at a place chosen for it — forcings low and central, atlas high
 * and left — rather than cascading them all off the top-left corner, and that
 * arrangement is a layout, not a coordinate: it has to survive a box that is
 * not 1560×960. Clamped, so a narrow leaf still lands inside.
 */
export function defaultPosition(x: number, y: number, boxW: number, boxH: number): { x: number; y: number } {
  return clampRect(Math.round((x / PROTO_BOX_W) * boxW), Math.round((y / PROTO_BOX_H) * boxH), 0, 0, boxW, boxH, 0);
}

/** The `index`-th panel's start point: a diagonal cascade, clamped inside the box. */
export function cascadePosition(index: number, boxW: number, boxH: number): { x: number; y: number } {
  const x = CASCADE_ORIGIN + index * CASCADE_STEP;
  const y = CASCADE_ORIGIN + index * CASCADE_STEP;
  return clampRect(x, y, 0, 0, boxW, boxH, 0);
}
