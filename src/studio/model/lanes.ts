/**
 * Pure playlist-lane math: span pixel geometry and hit testing. No DOM, no
 * Obsidian — see PLAN.md §4 D3. `spansFor` (deriving spans from a zone
 * draft) lands in a later bead; this file owns only the shape and the
 * pointer arithmetic the Lane component needs.
 */

export type SpanKind = "clip" | "pulse" | "band" | "bar" | "window" | "run";

/** A lane span in fractional years (`from < to`). */
export interface Span {
  id: string;
  from: number;
  to: number;
  kind: SpanKind;
  editable: boolean;
  dim?: boolean;
  row?: number;
  label?: string;
}

/** How a lane maps fractional years to pixels. `edgePx` is 4 for mouse, 10 for touch (SPEC §3.8). */
export interface LaneGeometry {
  x0: number;
  pxPerYear: number;
  windowFrom: number;
  edgePx: number;
}

/** `s`'s pixel rectangle within `g`. */
export function spanToPx(s: Span, g: LaneGeometry): { left: number; width: number } {
  const left = g.x0 + (s.from - g.windowFrom) * g.pxPerYear;
  const width = (s.to - s.from) * g.pxPerYear;
  return { left, width };
}

/** The fractional year under pixel `xPx`. */
export function pxToYear(xPx: number, g: LaneGeometry): number {
  return g.windowFrom + (xPx - g.x0) / g.pxPerYear;
}

/**
 * What's under `xPx`: the topmost span (last in `spans`) whose rectangle
 * contains the point, and which zone. Edges (within `g.edgePx` of a
 * boundary) take precedence over the body; non-editable spans only ever
 * report "body" — they have no edges to grab.
 */
export function hitTest(spans: readonly Span[], xPx: number, g: LaneGeometry): { span: Span; zone: "start" | "end" | "body" } | null {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    const { left, width } = spanToPx(s, g);
    const right = left + width;
    if (xPx < left || xPx > right) continue;
    if (s.editable && xPx <= left + g.edgePx) return { span: s, zone: "start" };
    if (s.editable && xPx >= right - g.edgePx) return { span: s, zone: "end" };
    return { span: s, zone: "body" };
  }
  return null;
}

/** `s` moved by `dYears`, keeping its length, clamped so both ends stay within `bounds`. */
export function moveSpan(s: Span, dYears: number, bounds: { min: number; max: number }): Span {
  const length = s.to - s.from;
  let from = s.from + dYears;
  let to = s.to + dYears;
  if (from < bounds.min) {
    from = bounds.min;
    to = from + length;
  }
  if (to > bounds.max) {
    to = bounds.max;
    from = to - length;
  }
  return { ...s, from, to };
}

/**
 * `s` with its `start` or `end` edge dragged to `toYear`, honouring
 * `minLength` (the edge can never cross the other one closer than that)
 * and `bounds`.
 */
export function resizeSpan(s: Span, zone: "start" | "end", toYear: number, minLength: number, bounds: { min: number; max: number }): Span {
  if (zone === "start") {
    const maxFrom = s.to - minLength;
    const from = Math.min(Math.max(toYear, bounds.min), maxFrom);
    return { ...s, from };
  }
  const minTo = s.from + minLength;
  const to = Math.max(Math.min(toYear, bounds.max), minTo);
  return { ...s, to };
}

/**
 * Greedy interval-graph colouring by `from`: each span goes in the first
 * row whose last span already ended, opening a new row up to `maxRows`.
 * Overlaps beyond `maxRows` pile into the last row. Returns copies with
 * `row` set; the eras lane uses this for its ≤3 sub-rows.
 */
export function stackRows(spans: readonly Span[], maxRows: number): Span[] {
  const rows = Math.max(1, maxRows);
  const order = spans.map((s, i) => ({ s, i })).sort((a, b) => a.s.from - b.s.from || a.i - b.i);
  const rowEnds: number[] = [];
  const rowOf = new Map<number, number>();
  for (const { s, i } of order) {
    let row = -1;
    for (let r = 0; r < rowEnds.length; r++) {
      if (s.from >= rowEnds[r]!) {
        row = r;
        break;
      }
    }
    if (row === -1) {
      if (rowEnds.length < rows) {
        row = rowEnds.length;
        rowEnds.push(s.to);
      } else {
        row = rows - 1;
        rowEnds[row] = Math.max(rowEnds[row]!, s.to);
      }
    } else {
      rowEnds[row] = s.to;
    }
    rowOf.set(i, row);
  }
  return spans.map((s, i) => ({ ...s, row: rowOf.get(i)! }));
}
