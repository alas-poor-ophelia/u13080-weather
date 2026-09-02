/**
 * Chart — the studio's only plot. Five kinds share one SVG: curve (a line,
 * optionally filled), band (the area between two series), automation (a line
 * whose points drag), rose (16 polar sectors, wind), disc (a circle whose
 * phase boundaries drag, the moon cycle). Nothing here interprets the data:
 * callers hand it points already in the units they want on screen.
 */
import { beginDrag, markDragTarget, noteTouchPointer } from "../pointer";

export type ChartKind = "curve" | "band" | "automation" | "rose" | "disc";
export type ChartDomain = "year" | "cycle" | "history";
export type ChartPhase = "drag" | "end";

export interface ChartSeries {
  points: Array<[number, number]>;
  color: string;
  fill?: boolean;
}

export interface ChartMarker {
  x: number;
  label?: string;
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
}

const PAD = 6;
const ROSE_SECTORS = 16;
const POINT_R = 4;

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

  /** The x extent actually plotted: a whole year or moon cycle is [0,1]; history follows the data. */
  function xRange(): [number, number] {
    if (props.domain !== "history") return [0, 1];
    const xs = props.series.flatMap((s) => s.points.map((p) => p[0]));
    if (xs.length === 0) return [0, 1];
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    return lo === hi ? [lo, lo + 1] : [lo, hi];
  }

  function yRange(): [number, number] {
    if (props.yRange) return props.yRange;
    const ys = props.series.flatMap((s) => s.points.map((p) => p[1]));
    if (ys.length === 0) return [0, 1];
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    return lo === hi ? [lo - 1, lo + 1] : [lo, hi];
  }

  const plotW = (): number => props.width - 2 * PAD;
  const plotH = (): number => props.height - 2 * PAD;

  function sx(x: number): number {
    const [a, b] = xRange();
    return PAD + ((x - a) / (b - a)) * plotW();
  }
  function sy(y: number): number {
    const [a, b] = yRange();
    return PAD + (1 - (y - a) / (b - a)) * plotH();
  }
  function invX(px: number): number {
    const [a, b] = xRange();
    return a + ((px - PAD) / plotW()) * (b - a);
  }
  function invY(py: number): number {
    const [a, b] = yRange();
    return a + (1 - (py - PAD) / plotH()) * (b - a);
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

  function drawSeries(s: ChartSeries): void {
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (!first || !last) return;
    if (s.fill) {
      const floor = (props.height - PAD).toFixed(2);
      const d = `${pathOf(s.points)} L ${sx(last[0]).toFixed(2)} ${floor} L ${sx(first[0]).toFixed(2)} ${floor} Z`;
      svg.createSvg("path", { cls: "wadjet-studio-chart-fill", attr: { d, fill: s.color } });
    }
    svg.createSvg("polyline", { cls: "wadjet-studio-chart-line", attr: { points: polyline(s.points), stroke: s.color } });
  }

  function drawBand(): void {
    const [lo, hi] = props.series;
    if (!lo || !hi || lo.points.length === 0) {
      props.series.forEach(drawSeries);
      return;
    }
    const up = lo.points.map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    const down = [...hi.points].reverse().map((p) => `${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`);
    svg.createSvg("path", { cls: "wadjet-studio-chart-band", attr: { d: `M ${up.join(" L ")} L ${down.join(" L ")} Z`, fill: lo.color } });
    svg.createSvg("polyline", { cls: "wadjet-studio-chart-line", attr: { points: polyline(hi.points), stroke: hi.color } });
  }

  function drawRose(): void {
    const cx = props.width / 2;
    const cy = props.height / 2;
    const r = Math.min(props.width, props.height) / 2 - PAD;
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

  function drawAutomation(): void {
    const s = props.series[0];
    if (!s) return;
    drawSeries(s);
    s.points.forEach((p, i) => {
      const dot = svg.createSvg("circle", { cls: "wadjet-studio-chart-point", attr: { cx: sx(p[0]).toFixed(2), cy: sy(p[1]).toFixed(2), r: POINT_R, fill: s.color, "data-index": i } });
      bindPoint(dot, i, false);
    });
    props.series.slice(1).forEach(drawSeries);
  }

  /** Wire one draggable handle. `radial` means the value is an angle around the disc. */
  function bindPoint(node: SVGElement, index: number, radial: boolean): void {
    if (!props.editable || !props.onPoint) return;
    markDragTarget(node);
    node.addEventListener("pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      noteTouchPointer(ev, node);
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
      svg.createSvg("line", { cls: "wadjet-studio-chart-marker", attr: { x1: x, y1: PAD, x2: x, y2: props.height - PAD } });
      if (m.label) svg.createSvg("text", { cls: "wadjet-studio-chart-marker-label", attr: { x, y: PAD + 9 } }).setText(m.label);
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
    if (props.kind === "rose") drawRose();
    else if (props.kind === "disc") drawDisc();
    else if (props.kind === "band") drawBand();
    else if (props.kind === "automation") drawAutomation();
    else props.series.forEach(drawSeries);
    if (props.kind !== "rose" && props.kind !== "disc") drawMarkers();
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
