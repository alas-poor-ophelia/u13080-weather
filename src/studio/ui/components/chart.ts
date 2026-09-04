/**
 * Chart — the studio's only plot. Five kinds share one SVG: curve (a line,
 * optionally filled), band (the area between two series), automation (a line
 * whose points drag), rose (16 polar sectors, wind), disc (a circle whose
 * phase boundaries drag, the moon cycle). Nothing here interprets the data:
 * callers hand it points already in the units they want on screen.
 *
 * A plot can also be *read*, not just seen (bead wadjet-6rw.10). Four optional
 * props turn the bare line into a chart with an axis, and all four are generic
 * — every channel editor, and any future plot, composes them the same way:
 *
 *   `pad`      per-side plot inset. The left side is the tick gutter, so a
 *              chart with `ticks` needs room there (the prototype's is 38 px).
 *              `padX` is the shorthand for left+right alone — a playlist row
 *              is measured against the ruler's tick strip, so it plots at
 *              `padX: 0` and its curve lands on the ruler's own pixels.
 *   `ticks`    y-axis tick labels, right-aligned in that gutter. The caller
 *              picks the values, because only the caller knows the unit.
 *   `bands`    x-domain tint rects behind everything — season bands on a year
 *              domain, moon-phase bands on a cycle one. A band *is* the label:
 *              the studio never prints a season name inside a plot.
 *   `rules`    horizontal lines at a value. Solid, a rule is a grid line (a
 *              playlist row's axis positions); dashed, a reference the reader
 *              is meant to notice (0 °C freezing).
 *   `envelope` a translucent ribbon between two series (mean ± spread).
 *
 * `selected` / `onSelect` give the `automation` kind a selected handle, so a
 * panel can show a readout for the point under the finger.
 *
 * The `rose` kind has two forms. Without `wedges` it is the 16-bucket
 * histogram `series[0]` describes; with them it is the direction rose —
 * rings, the four cardinals, and one coloured sector per wedge on its own
 * bearing (degrees clockwise from north).
 */
import { beginDrag, markDragTarget, noteTouchPointer } from "../pointer";

export type ChartKind = "curve" | "band" | "automation" | "rose" | "disc";
export type ChartDomain = "year" | "cycle" | "history";
export type ChartPhase = "drag" | "end";

export interface ChartSeries {
  points: Array<[number, number]>;
  color: string;
  /**
   * The x/y pairs the LINE (and its fill, and a band's edge) is stroked
   * through, when they are not the same as the handles.
   *
   * `points` is the keyed set: one circle per entry, one drag index per entry,
   * and the `automation` kind's `onPoint` reports that index. A curve between
   * those keys is not a chord — the studio's channel curves are the monotone
   * cubic `core/curve.ts` evaluates — so a caller that knows the interpolant
   * hands over a dense sample of it here and the corners go away without the
   * handle count moving. Unset, the line is drawn through `points`, which is
   * what every caller that has no interpolant to sample wants.
   */
  line?: Array<[number, number]>;
  fill?: boolean;
  /** SVG `stroke-dasharray` — a reference or comparison line, drawn dashed. */
  dash?: string;
  /** Stroke width in px; defaults to the stylesheet's 1.6. */
  width?: number;
}

export interface ChartMarker {
  x: number;
  label?: string;
}

/** A tint rect spanning `[from, to]` of the x domain, drawn behind every series. */
export interface ChartBand {
  from: number;
  to: number;
  color: string;
}

/**
 * One axis tick: where it sits in data space, and what it reads. Serves both
 * axes — `ticks` puts it in the left gutter, `xTicks` under the plot.
 *
 * `color` is for the one tick that is a *reading* rather than a scale mark
 * (the moon envelope's `full ●`); like a rule's, it arrives as an attribute so
 * the stylesheet can leave the default alone.
 */
export interface ChartTick {
  value: number;
  label: string;
  color?: string;
}

/**
 * A horizontal line at a y value in the series' own units. One object serves
 * both readings: solid, it is a *grid* line (a playlist row's axis positions,
 * which the ruler above already labels); dashed, it is a *reference* — a value
 * that means something on its own, like SPEC §3.2's 0 °C freezing line.
 */
export interface ChartRule {
  value: number;
  /** SVG `stroke-dasharray`, as on a series. Set = a reference; unset = a grid line. */
  dash?: string;
  color?: string;
  /** Printed just inside the plot's left edge, above the line. */
  label?: string;
}

/** The translucent ribbon between two series (mean ± spread). */
export interface ChartEnvelope {
  lo: Array<[number, number]>;
  hi: Array<[number, number]>;
  color: string;
}

/**
 * One wedge of the `rose` kind: a sector at a bearing, in its own colour.
 *
 * `angle` is degrees clockwise from north — the compass convention, not SVG's
 * — and `radius` is a fraction of the rose, so a caller may make one wedge
 * reach further than another without knowing the pixel size.
 */
export interface ChartWedge {
  angle: number;
  /** the sector's angular width, in degrees */
  spread: number;
  /** 0–1 of the rose radius */
  radius: number;
  color: string;
}

/** Plot inset, per side. Defaults to 6 px all round. */
export interface ChartPad {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface ChartProps {
  kind: ChartKind;
  domain: ChartDomain;
  width: number;
  height: number;
  series: ChartSeries[];
  yRange?: [number, number];
  editable?: boolean;
  onPoint?(index: number, x: number, y: number, phase: ChartPhase): void;
  onAdd?(x: number, y: number): void;
  onRemove?(index: number): void;
  markers?: ChartMarker[];
  pad?: ChartPad;
  /**
   * Shorthand for `pad.left` and `pad.right` together, for the one case that
   * only ever wants the horizontal inset changed: a playlist channel row is
   * measured against the ruler's tick strip, so a curve inset by `PAD` would
   * sit a few pixels left of the day it is drawn at. `pad` wins per side.
   */
  padX?: number;
  /**
   * The x extent to plot, overriding the domain's own. A year and a cycle are
   * whole by default and a history follows its data; the one caller that wants
   * neither is the moon envelope overlay, which plots the last third of a cycle
   * (`[0.70, 1]`) across the full width because that is where an onset lives.
   */
  xRange?: [number, number];
  bands?: ChartBand[];
  ticks?: ChartTick[];
  /** X-axis labels under the plot, centred on their value. The y-axis pair is `ticks`. */
  xTicks?: ChartTick[];
  rules?: ChartRule[];
  envelope?: ChartEnvelope | null;
  /**
   * `rose` only: one sector per wedge, at its own bearing, instead of the
   * 16-bucket histogram `series[0]` draws. Supplying wedges also draws the
   * rings and the N/E/S/W cardinals — a bearing is unreadable without them.
   */
  wedges?: ChartWedge[];
  /** `rose` only: how many concentric rings sit behind the wedges. Default 3. */
  rings?: number;
  /** The highlighted `automation` handle — drawn larger, in `.is-selected`. */
  selected?: number | null;
  /** Fired on pointer-down over a handle, before the drag starts. */
  onSelect?(index: number): void;
}

const PAD = 6;
const ROSE_SECTORS = 16;
const POINT_R = 4;
/** The selected `automation` handle, in px — the prototype's 7 against 4.5. */
const POINT_R_SELECTED = 6.5;
/** Gap between a tick label's right edge and the plot's left edge. */
const TICK_GAP = 6;
/** Baseline drop from the plot's floor to an x-axis label (the prototype's 78 → 90). */
const X_TICK_GAP = 12;

export interface ChartComponent {
  el: HTMLElement;
  update(next: Partial<ChartProps>): void;
  destroy(): void;
}

export function createChart(parent: HTMLElement, initial: ChartProps): ChartComponent {
  let props = initial;
  let cancelDrag: (() => void) | null = null;

  const el = parent.createDiv({ cls: "wadjet-studio-chart" });
  markDragTarget(el);
  let svg = el.createSvg("svg");

  /**
   * The x extent actually plotted: the caller's `xRange` if it named one, else
   * a whole year or moon cycle ([0,1]) and a history that follows its data.
   */
  function xRange(): [number, number] {
    if (props.xRange) return props.xRange;
    if (props.domain !== "history") return [0, 1];
    const xs = props.series.flatMap((s) => strokeOf(s).map((p) => p[0]));
    if (xs.length === 0) return [0, 1];
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? [lo, lo + 1] : [lo, hi];
  }

  function yRange(): [number, number] {
    if (props.yRange) return props.yRange;
    // The stroked set, not the handles: a dense sample of an interpolant rises
    // between two keys, and an axis fitted to the keys alone would clip it.
    const ys = props.series.flatMap((s) => strokeOf(s).map((p) => p[1]));
    if (ys.length === 0) return [0, 1];
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    return lo === hi ? [lo - 1, lo + 1] : [lo, hi];
  }

  const padL = (): number => props.pad?.left ?? props.padX ?? PAD;
  const padR = (): number => props.pad?.right ?? props.padX ?? PAD;
  const padT = (): number => props.pad?.top ?? PAD;
  const padB = (): number => props.pad?.bottom ?? PAD;

  const plotW = (): number => Math.max(1, props.width - padL() - padR());
  const plotH = (): number => Math.max(1, props.height - padT() - padB());

  function sx(x: number): number {
    const [a, b] = xRange();
    return padL() + ((x - a) / (b - a)) * plotW();
  }
  function sy(y: number): number {
    const [a, b] = yRange();
    return padT() + (1 - (y - a) / (b - a)) * plotH();
  }
  function invX(px: number): number {
    const [a, b] = xRange();
    return a + ((px - padL()) / plotW()) * (b - a);
  }
  function invY(py: number): number {
    const [a, b] = yRange();
    return a + (1 - (py - padT()) / plotH()) * (b - a);
  }

  function localPoint(ev: MouseEvent): { x: number; y: number } {
    const r = svg.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function polyline(pts: Array<[number, number]>): string {
    return pts.map((p) => `${sx(p[0]).toFixed(2)},${sy(p[1]).toFixed(2)}`).join(" ");
  }

  function pathOf(pts: Array<[number, number]>): string {
    return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`).join(" ");
  }

  /**
   * A year is a loop, so a curve keyed at month centres stops ~4 % short of
   * both plot edges and leaves a bare-tint margin the prototype does not have
   * (its `poly` samples the whole [0,1] domain). The wrapped value is the same
   * at x = 0 and x = 1, so carrying the ink to both edges leaves no seam.
   * Handles are drawn from `points`, never from this, so keyframes still count.
   * A series that brought dense `line` samples already spans the whole domain,
   * and the `first[0] <= 0` guard below leaves it alone: the seam is closed by
   * the real interpolant rather than by this straight chord across the wrap.
   */
  function edged(pts: Array<[number, number]>): Array<[number, number]> {
    if (props.domain !== "year" || pts.length < 2) return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last || first[0] <= 0 || last[0] >= 1) return pts;
    const span = first[0] + 1 - last[0];
    const y = last[1] + ((1 - last[0]) / span) * (first[1] - last[1]);
    return [[0, y], ...pts, [1, y]];
  }

  /** What a series is STROKED through: its dense samples if it brought any, else its handles. */
  function strokeOf(s: ChartSeries): Array<[number, number]> {
    return s.line !== undefined && s.line.length > 1 ? s.line : s.points;
  }

  function drawSeries(s: ChartSeries): void {
    const pts = edged(strokeOf(s));
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last) return;
    if (s.fill) {
      const floor = (props.height - padB()).toFixed(2);
      const d = `${pathOf(pts)} L ${sx(last[0]).toFixed(2)} ${floor} L ${sx(first[0]).toFixed(2)} ${floor} Z`;
      svg.createSvg("path", { cls: "wadjet-studio-chart-fill", attr: { d, fill: s.color } });
    }
    svg.createSvg("polyline", {
      cls: "wadjet-studio-chart-line",
      attr: {
        points: polyline(pts),
        stroke: s.color,
        ...(s.dash === undefined ? {} : { "stroke-dasharray": s.dash }),
        ...(s.width === undefined ? {} : { "stroke-width": String(s.width) }),
      },
    });
  }

  /** Season / moon-phase tints, behind every mark. A band *is* the label (SPEC §9). */
  function drawBands(): void {
    for (const b of props.bands ?? []) {
      const x0 = sx(Math.min(b.from, b.to));
      const x1 = sx(Math.max(b.from, b.to));
      if (x1 - x0 <= 0) continue;
      svg.createSvg("rect", {
        cls: "wadjet-studio-chart-tint",
        attr: { x: x0.toFixed(2), y: padT().toFixed(2), width: (x1 - x0).toFixed(2), height: plotH().toFixed(2), fill: b.color },
      });
    }
  }

  /**
   * Horizontal rules — a playlist row's grid positions, the 0 °C reference.
   * Drawn UNDER the series so a curve is never crossed out, and clipped to the
   * plot's own y extent so a rule never strays into the tick gutter. The hue
   * comes from the attribute, as it does for a series line.
   */
  function drawRules(): void {
    const [lo, hi] = yRange();
    const slack = Math.abs(hi - lo) * 1e-6;
    for (const r of props.rules ?? []) {
      if (r.value < Math.min(lo, hi) - slack || r.value > Math.max(lo, hi) + slack) continue;
      const y = sy(r.value).toFixed(2);
      const line = svg.createSvg("line", {
        cls: "wadjet-studio-chart-rule",
        attr: {
          x1: padL().toFixed(2),
          x2: (props.width - padR()).toFixed(2),
          y1: y,
          y2: y,
          stroke: r.color ?? "var(--wadjet-studio-text-mute)",
          ...(r.dash === undefined ? {} : { "stroke-dasharray": r.dash }),
        },
      });
      line.toggleClass("is-dashed", r.dash !== undefined);
      if (r.label !== undefined) {
        svg
          .createSvg("text", { cls: "wadjet-studio-chart-rule-label", attr: { x: (padL() + TICK_GAP).toFixed(2), y: (sy(r.value) - 3).toFixed(2) } })
          .setText(r.label);
      }
    }
  }

  /** The ± ribbon. `lo`/`hi` are two curves over the same domain, not a fill to the floor. */
  function drawEnvelope(): void {
    const e = props.envelope;
    if (!e || e.lo.length === 0 || e.hi.length === 0) return;
    const up = edged(e.hi).map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    const down = [...edged(e.lo)].reverse().map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    svg.createSvg("path", { cls: "wadjet-studio-chart-band", attr: { d: `M ${up.join(" L ")} L ${down.join(" L ")} Z`, fill: e.color } });
  }

  /** Tick labels, right-aligned in the left gutter. Drawn last so no mark covers a number. */
  function drawTicks(): void {
    const [lo, hi] = yRange();
    for (const t of props.ticks ?? []) {
      if (t.value < Math.min(lo, hi) || t.value > Math.max(lo, hi)) continue;
      svg
        .createSvg("text", {
          cls: "wadjet-studio-chart-tick",
          attr: { x: (padL() - TICK_GAP).toFixed(2), y: (sy(t.value) + 3).toFixed(2), "text-anchor": "end" },
        })
        .setText(t.label);
    }
  }

  /**
   * X-axis labels, centred on their value in the strip under the plot. The
   * caller picks the values for the same reason it picks the y ticks: only it
   * knows what the x unit means (`0.90`, `full ●`).
   *
   * A label ON the domain's end is anchored to it instead of centred: the last
   * one carries a reading rather than a scale mark (the envelope's `full ●`),
   * and half of it would otherwise hang off the plot and be clipped away.
   */
  function drawXTicks(): void {
    const [lo, hi] = xRange();
    const [min, max] = [Math.min(lo, hi), Math.max(lo, hi)];
    for (const t of props.xTicks ?? []) {
      if (t.value < min || t.value > max) continue;
      svg
        .createSvg("text", {
          cls: "wadjet-studio-chart-xtick",
          attr: {
            x: sx(t.value).toFixed(2),
            y: (props.height - padB() + X_TICK_GAP).toFixed(2),
            "text-anchor": t.value === max ? "end" : t.value === min ? "start" : "middle",
            fill: t.color ?? "var(--wadjet-studio-text-mute)",
          },
        })
        .setText(t.label);
    }
  }

  function drawBand(): void {
    const [lo, hi] = props.series;
    if (!lo || !hi || lo.points.length === 0) {
      props.series.forEach(drawSeries);
      return;
    }
    const up = edged(strokeOf(lo)).map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    const down = [...edged(strokeOf(hi))].reverse().map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    svg.createSvg("path", { cls: "wadjet-studio-chart-band", attr: { d: `M ${up.join(" L ")} L ${down.join(" L ")} Z`, fill: lo.color } });
    svg.createSvg("polyline", { cls: "wadjet-studio-chart-line", attr: { points: polyline(edged(strokeOf(hi))), stroke: hi.color } });
  }

  /** Compass bearing (degrees clockwise from north) to a point on the rose. */
  function bearing(cx: number, cy: number, deg: number, r: number): [number, number] {
    const a = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  }

  /**
   * The prototype's direction rose: rings, the four cardinals, then one
   * coloured sector per wedge with a spoke and a dot on its bearing. A bearing
   * cannot be read off a bare sector, so the spoke and the dot are part of the
   * mark, not decoration.
   */
  function drawWedges(cx: number, cy: number, r: number, wedges: ChartWedge[]): void {
    const rings = props.rings ?? 3;
    svg.createSvg("circle", { cls: "wadjet-studio-chart-rose-face", attr: { cx, cy, r } });
    for (let i = 1; i < rings; i++) svg.createSvg("circle", { cls: "wadjet-studio-chart-rose-ring", attr: { cx, cy, r: ((r * i) / rings).toFixed(2) } });
    for (const [label, deg] of [
      ["N", 0],
      ["E", 90],
      ["S", 180],
      ["W", 270],
    ] as Array<[string, number]>) {
      const [x, y] = bearing(cx, cy, deg, r + 10);
      svg.createSvg("text", { cls: "wadjet-studio-chart-cardinal", attr: { x: x.toFixed(2), y: (y + 3.5).toFixed(2), "text-anchor": "middle" } }).setText(label);
    }
    for (const w of wedges) {
      const rr = Math.max(0, Math.min(1, w.radius)) * r;
      const [ax, ay] = bearing(cx, cy, w.angle - w.spread / 2, rr);
      const [bx, by] = bearing(cx, cy, w.angle + w.spread / 2, rr);
      const [tx, ty] = bearing(cx, cy, w.angle, rr - 6);
      svg.createSvg("path", {
        // `is-wedge` keeps the histogram form's stylesheet stroke off this
        // one: a wedge's rim is its own colour, and CSS beats the attribute.
        cls: ["wadjet-studio-chart-sector", "is-wedge"],
        attr: { d: `M ${cx} ${cy} L ${ax.toFixed(2)} ${ay.toFixed(2)} A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${bx.toFixed(2)} ${by.toFixed(2)} Z`, fill: w.color, stroke: w.color },
      });
      svg.createSvg("line", { cls: "wadjet-studio-chart-spoke", attr: { x1: cx, y1: cy, x2: tx.toFixed(2), y2: ty.toFixed(2), stroke: w.color } });
      svg.createSvg("circle", { cls: "wadjet-studio-chart-bearing", attr: { cx: tx.toFixed(2), cy: ty.toFixed(2), r: 6, stroke: w.color } });
    }
    svg.createSvg("circle", { cls: "wadjet-studio-chart-hub", attr: { cx, cy, r: 3.5 } });
  }

  function drawRose(): void {
    const cx = props.width / 2;
    const cy = props.height / 2;
    const r = Math.min(props.width, props.height) / 2 - PAD;
    const wedges = props.wedges;
    if (wedges !== undefined) {
      drawWedges(cx, cy, r - 12, wedges);
      return;
    }
    const s = props.series[0];
    if (!s) return;
    const max = Math.max(1, ...s.points.map((p) => p[1]));
    const step = (2 * Math.PI) / ROSE_SECTORS;
    for (const [sector, value] of s.points) {
      const a0 = sector * step - Math.PI / 2 - step / 2;
      const a1 = a0 + step;
      const rr = (value / max) * r;
      const p0 = `${(cx + rr * Math.cos(a0)).toFixed(2)} ${(cy + rr * Math.sin(a0)).toFixed(2)}`;
      const p1 = `${(cx + rr * Math.cos(a1)).toFixed(2)} ${(cy + rr * Math.sin(a1)).toFixed(2)}`;
      svg.createSvg("path", { cls: "wadjet-studio-chart-sector", attr: { d: `M ${cx} ${cy} L ${p0} A ${rr.toFixed(2)} ${rr.toFixed(2)} 0 0 1 ${p1} Z`, fill: s.color } });
    }
  }

  /** Disc points are phases in [0,1) — the boundaries between named moon phases. */
  function drawDisc(): void {
    const cx = props.width / 2;
    const cy = props.height / 2;
    const r = Math.min(props.width, props.height) / 2 - PAD - POINT_R;
    const s = props.series[0];
    svg.createSvg("circle", { cls: "wadjet-studio-chart-disc", attr: { cx, cy, r } });
    if (!s) return;
    s.points.forEach(([phase], i) => {
      const a = phase * 2 * Math.PI - Math.PI / 2;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      svg.createSvg("line", { cls: "wadjet-studio-chart-boundary", attr: { x1: cx, y1: cy, x2: x, y2: y, stroke: s.color } });
      const handle = svg.createSvg("circle", { cls: "wadjet-studio-chart-point", attr: { cx: x, cy: y, r: POINT_R, fill: s.color, "data-index": i } });
      bindPoint(handle, i, true);
    });
  }

  /**
   * The editable line last of all the lines, so the reference curves it is
   * being compared against never paint over it — then the handles on top.
   */
  function drawAutomation(): void {
    const s = props.series[0];
    if (!s) return;
    props.series.slice(1).forEach(drawSeries);
    drawSeries(s);
    s.points.forEach((p, i) => {
      const on = props.selected === i;
      const dot = svg.createSvg("circle", {
        cls: "wadjet-studio-chart-point",
        // A handle is a ring, not a disc: dark centre, series-coloured rim, so
        // it stays legible where it sits on top of its own line.
        attr: { cx: sx(p[0]).toFixed(2), cy: sy(p[1]).toFixed(2), r: on ? POINT_R_SELECTED : POINT_R, fill: "var(--wadjet-studio-bg-alt)", stroke: s.color, "data-index": i },
      });
      dot.toggleClass("is-selected", on);
      bindPoint(dot, i, false);
    });
  }

  /** Wire one draggable handle. `radial` means the value is an angle around the disc. */
  function bindPoint(node: SVGElement, index: number, radial: boolean): void {
    if (!props.editable || !props.onPoint) return;
    markDragTarget(node);
    node.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      noteTouchPointer(ev, node);
      props.onSelect?.(index);
      ev.preventDefault();
      ev.stopPropagation();
      const report = (move: MouseEvent, phase: ChartPhase): void => {
        const p = localPoint(move);
        if (radial) {
          const a = Math.atan2(p.y - props.height / 2, p.x - props.width / 2) + Math.PI / 2;
          props.onPoint?.(index, ((a / (2 * Math.PI)) % 1 + 1) % 1, 0, phase);
        } else {
          props.onPoint?.(index, invX(p.x), invY(p.y), phase);
        }
      };
      cancelDrag = beginDrag(ev, {
        capture: node,
        onMove: (move) => report(move, "drag"),
        onEnd: (end, _dx, _dy, moved) => {
          cancelDrag = null;
          if (moved) report(end, "end");
        },
      });
    });
    node.addEventListener("contextmenu", (ev: MouseEvent) => {
      if (!props.onRemove) return;
      ev.preventDefault();
      ev.stopPropagation();
      props.onRemove(index);
    });
  }

  function drawMarkers(): void {
    for (const m of props.markers ?? []) {
      const x = sx(m.x).toFixed(2);
      svg.createSvg("line", { cls: "wadjet-studio-chart-marker", attr: { x1: x, y1: padT(), x2: x, y2: props.height - padB() } });
      if (m.label) svg.createSvg("text", { cls: "wadjet-studio-chart-marker-label", attr: { x, y: padT() + 9 } }).setText(m.label);
    }
  }

  function onDblClick(ev: MouseEvent): void {
    if (!props.onAdd) return;
    const p = localPoint(ev);
    props.onAdd(invX(p.x), invY(p.y));
  }

  function paint(): void {
    el.setAttrs({ "data-kind": props.kind, "data-domain": props.domain });
    svg.remove();
    svg = el.createSvg("svg", { cls: "wadjet-studio-chart-svg", attr: { width: props.width, height: props.height, viewBox: `0 0 ${props.width} ${props.height}` } });
    const cartesian = props.kind !== "rose" && props.kind !== "disc";
    // Back to front: tints, rules, ribbon, lines, then the numbers on top.
    if (cartesian) {
      drawBands();
      drawRules();
      drawEnvelope();
    }
    if (props.kind === "rose") drawRose();
    else if (props.kind === "disc") drawDisc();
    else if (props.kind === "band") drawBand();
    else if (props.kind === "automation") drawAutomation();
    else props.series.forEach(drawSeries);
    if (cartesian) {
      drawMarkers();
      drawTicks();
      drawXTicks();
    }
    svg.addEventListener("dblclick", onDblClick);
  }

  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    destroy() {
      cancelDrag?.();
      el.remove();
    },
  };
}
