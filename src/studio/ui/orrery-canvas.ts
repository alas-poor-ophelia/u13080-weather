/**
 * The Orrery's scope: the Studio's first <canvas> (docs/SESHAT-v0.md §18.3 D6,
 * §18.6 item 10; bead wadjet-b6x, slice 1a-ii). It projects and paints the
 * pure model (model/orrery-geometry.ts) and owns the camera and the
 * fractional transport day; every fact it draws comes from the model.
 *
 * Rendering is the design handoff's: hand-rolled perspective (`project`),
 * segments batched by paint state, colour and four depth bands (alpha 1 /
 * .86 / .68 / .5), additive blending with a 20 % glow pass on the phosphor
 * and amber themes, labels laid out by `layoutLabels` on opaque plates in the
 * theme's background colour.
 *
 * The frame loop (D6):
 * - draws only when something is dirty (a new model, the camera easing, the
 *   day easing, a hover, a resize) or the transport is playing; an idle
 *   scope requests no frames at all;
 * - takes requestAnimationFrame and ResizeObserver from the canvas's own
 *   window (`ownerDocument.defaultView`), and `rehome()` moves both when the
 *   leaf moves to another window, cancelling the frame left on the old one;
 * - never draws at 0 × 0: a hidden scope (a background tab, a closed
 *   sidebar) stops until the observer reports a size again;
 * - re-reads devicePixelRatio, clamped to 2, on every resize, and clamps the
 *   backing store; the canvas gets explicit pixel and CSS sizes (wadjet-ytu);
 * - `destroy()` cancels the frame, disconnects the observer, ends a drag and
 *   removes every listener.
 */
import type { PartId } from "../../seshat";
import { clampDay, easeCamera, layoutLabels, orbit, paintState, partGroupOf, pickPart, project, VIEWS, zoom, type Camera, type Highlight, type OrreryModel, type PaintState, type ViewName, type Viewport } from "../model/orrery-geometry";
import type { OrreryTheme } from "../model/orrery-transport";
import { beginDrag, consumeJustDragged, markDragTarget, noteTouchPointer } from "./pointer";


interface ThemeColours {
  readonly bg: string;
  readonly glow: string;
  readonly line: string;
  readonly hot: string;
  readonly sel: string;
  readonly err: string;
  /** additive blending and the glow pass */
  readonly add: boolean;
  /** per part group, the studio theme's tints */
  readonly tint?: Readonly<Record<string, string>>;
}

/** The handoff's themes (Rendering): canvas colours are passed in JS, never read from CSS. */
export const THEME_COLOURS: Readonly<Record<OrreryTheme, ThemeColours>> = {
  phosphor: { bg: "#020a05", glow: "rgba(40,255,110,0.08)", line: "#4dff88", hot: "#d8ffe4", sel: "#f4fff7", err: "#ff5a4f", add: true },
  amber: { bg: "#0a0600", glow: "rgba(255,160,30,0.08)", line: "#ffb23e", hot: "#ffe8c2", sel: "#fff7ea", err: "#ff5a4f", add: true },
  studio: {
    bg: "#17181a",
    glow: "rgba(255,255,255,0.025)",
    line: "#8c939c",
    hot: "#f2f3f5",
    sel: "#ffffff",
    err: "#e0605c",
    add: false,
    tint: { body: "#cdd9ee", crossing: "#cdd9ee", gear: "#e8c15a", train: "#e8c15a", stage: "#e8c15a", seasons: "#e8c15a", unit: "#aab0b9", slot: "#aab0b9", dayline: "#d3d7dd" },
  },
};

/** Stroke per paint state (the handoff's: grid .1, dim .42, ghost .6 dashed, line .85, err/hot 1.5 px, sel 1.8 px). */
const SPEC: Readonly<Record<PaintState, { a: number; w: number; dash?: readonly number[]; glow?: boolean }>> = {
  grid: { a: 0.1, w: 1 },
  dim: { a: 0.42, w: 1 },
  ghost: { a: 0.6, w: 1, dash: [3, 4] },
  line: { a: 0.85, w: 1, glow: true },
  err: { a: 1, w: 1.5, glow: true },
  hot: { a: 1, w: 1.5, glow: true },
  sel: { a: 1, w: 1.8, glow: true },
};
const ORDER: Readonly<Record<PaintState, number>> = { grid: 0, dim: 1, ghost: 2, line: 3, err: 4, hot: 5, sel: 6 };
const BAND_ALPHA = [1, 0.86, 0.68, 0.5] as const;
const LABEL_ALPHA: Readonly<Record<string, number>> = { sel: 1, hot: 1, line: 0.95, ghost: 0.78, dim: 0.82 };
const LABEL_BAND = [1, 0.94, 0.86, 0.78] as const;
const FONT = "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, Menlo, 'Liberation Mono', monospace";
/** the backing store's longest side and its area, whatever the scope's size and density */
const BACKING_SIDE = 4096;
const BACKING_AREA = 8_388_608;
/** while playing, how often the window hears the day (ms) */
const DAY_SYNC_MS = 60;
/** the paused day eases toward its target at this rate (per second) */
const DAY_EASE = 9;

export interface OrreryCanvasOptions {
  /** The model at fractional day `day`; null when there is nothing to draw. */
  build(day: number): OrreryModel | null;
  /** The part under the pointer changed (null: none). */
  onHover(part: PartId | null): void;
  /** A click on a part (not on empty scope). */
  onPick(part: PartId): void;
  /** While playing: the whole day the transport reached (throttled). */
  onDay(day: number): void;
  /** Playback stopped by itself: the day line ended, or the scope was hidden. */
  onStop(): void;
}

export interface OrreryCanvas {
  /** the scope's well: the canvas and the window's overlays live in it */
  readonly el: HTMLElement;
  /** Move to whole day `day`: eased from where the scope is, or at once with `jump`. */
  setDay(day: number, jump?: boolean): void;
  /** Play at `rate` days a second, or stop (null). */
  setPlaying(rate: number | null): void;
  setHighlight(h: { selected: PartId | null; errors: ReadonlySet<PartId> }): void;
  setTheme(theme: OrreryTheme): void;
  setView(view: ViewName): void;
  /** The model changed under the same day (a new definition, a new verdict): rebuild and draw. */
  invalidate(): void;
  /** Re-resolve the canvas's window (the leaf moved to another one). */
  rehome(): void;
  destroy(): void;
}

export function createOrreryCanvas(parent: HTMLElement, opts: OrreryCanvasOptions): OrreryCanvas {
  const well = parent.createDiv({ cls: "wadjet-studio-orrery-well" });
  const canvas = well.createEl("canvas", { cls: "wadjet-studio-orrery-canvas", attr: { "aria-label": "Calendar orrery" } });
  markDragTarget(canvas);
  const ctx2d = canvas.getContext("2d");

  let win: Document["defaultView"] = null;
  let observer: ResizeObserver | null = null;
  let frame: number | null = null;
  let last = 0;
  let W = 0;
  let H = 0;
  let dpr = 1;

  let theme: OrreryTheme = "phosphor";
  let view: ViewName = "iso";
  let cam: Camera = { ...VIEWS.iso };
  let camT: Camera = { ...VIEWS.iso };
  let target = 0;
  let dayF = 0.5;
  let rate: number | null = null;
  let lastSync = 0;
  let selected: PartId | null = null;
  let hover: PartId | null = null;
  let errors: ReadonlySet<PartId> = new Set();
  let model: OrreryModel | null = null;
  /** the day the model was built for; NaN forces a rebuild */
  let builtFor = Number.NaN;
  let dirty = true;
  let cancelDrag: (() => void) | null = null;
  let dragging = false;
  let destroyed = false;
  const widths = new Map<string, number>();

  const viewport = (): Viewport => ({ width: W, height: H });

  function schedule(): void {
    if (destroyed || frame !== null || !win || W <= 0 || H <= 0) return;
    frame = win.requestAnimationFrame(tick);
  }

  function touch(): void {
    dirty = true;
    schedule();
  }

  function tick(t: number): void {
    frame = null;
    if (destroyed || W <= 0 || H <= 0) return;
    const dt = last === 0 ? 0 : Math.min(0.1, Math.max(0, (t - last) / 1000));
    last = t;
    let moving = false;
    if (rate !== null) {
      const c = clampDay(dayF + dt * rate);
      dayF = c.day;
      moving = true;
      const whole = Math.floor(dayF);
      if (c.clamped) stop();
      else if (whole !== target && t - lastSync > DAY_SYNC_MS) {
        lastSync = t;
        target = whole;
        opts.onDay(whole);
      }
    } else {
      const goal = target + 0.5;
      const diff = goal - dayF;
      if (Math.abs(diff) > 3000) dayF = goal;
      else if (Math.abs(diff) > 0.0005) {
        dayF += diff * Math.min(1, dt * DAY_EASE);
        moving = true;
      } else dayF = goal;
    }
    if (!dragging) {
      const e = easeCamera(cam, camT, dt);
      cam = e.camera;
      if (e.moving) moving = true;
    }
    if (moving || dirty) {
      dirty = false;
      draw();
    }
    if (moving) {
      // a frame after the last movement, so `last` is fresh when the next change lands
      if (win) frame = win.requestAnimationFrame(tick);
    } else last = 0;
  }

  /** Playback ends on its own: the window hears the day it stopped on, then that it stopped. */
  function stop(): void {
    if (rate === null) return;
    rate = null;
    target = Math.floor(dayF);
    opts.onDay(target);
    opts.onStop();
  }

  function currentModel(): OrreryModel | null {
    if (dayF !== builtFor) {
      builtFor = dayF;
      model = opts.build(dayF);
    }
    return model;
  }

  function colourOf(state: PaintState, part: PartId | null, th: ThemeColours): string {
    if (state === "hot") return th.hot;
    if (state === "sel") return th.sel;
    if (state === "err") return th.err;
    const g = partGroupOf(part);
    return (g && th.tint?.[g]) || th.line;
  }

  function measure(text: string, big: boolean): number {
    const key = `${big ? "B" : "s"}${text}`;
    let w = widths.get(key);
    if (w === undefined && ctx2d) {
      ctx2d.font = `${big ? 600 : 500} ${big ? 12 : 11}px ${FONT}`;
      w = ctx2d.measureText(text).width;
      if (widths.size > 2000) widths.clear();
      widths.set(key, w);
    }
    return w ?? text.length * 7;
  }

  function draw(): void {
    const ctx = ctx2d;
    if (!ctx || W <= 0 || H <= 0) return;
    const th = THEME_COLOURS[theme];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    const rg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    rg.addColorStop(0, th.glow);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
    const m = currentModel();
    if (!m) return;
    const vp = viewport();
    const h: Highlight = { selected, hover, errors };

    // batch: state|colour → four depth bands of x0 y0 x1 y1
    const batches = new Map<string, { state: PaintState; colour: string; bands: number[][] }>();
    for (const s of m.segments) {
      const a = project(cam, vp, s.a);
      const b = project(cam, vp, s.b);
      if (!a || !b) continue;
      const st = paintState(s, h);
      const colour = colourOf(st, s.part, th);
      const key = `${st}|${colour}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { state: st, colour, bands: [[], [], [], []] }));
      const band = Math.max(0, Math.min(3, Math.floor((a.depth + b.depth) / 2 - cam.dist + 2)));
      batch.bands[band]!.push(a.x, a.y, b.x, b.y);
    }
    ctx.globalCompositeOperation = th.add ? "lighter" : "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const batch of [...batches.values()].sort((x, y) => ORDER[x.state] - ORDER[y.state])) {
      const sp = SPEC[batch.state];
      ctx.strokeStyle = batch.colour;
      ctx.setLineDash(sp.dash ? [...sp.dash] : []);
      batch.bands.forEach((arr, bi) => {
        if (!arr.length) return;
        ctx.beginPath();
        for (let i = 0; i < arr.length; i += 4) {
          ctx.moveTo(arr[i]!, arr[i + 1]!);
          ctx.lineTo(arr[i + 2]!, arr[i + 3]!);
        }
        if (sp.glow && th.add) {
          ctx.globalAlpha = sp.a * BAND_ALPHA[bi]! * 0.2;
          ctx.lineWidth = sp.w + 3;
          ctx.stroke();
        }
        ctx.globalAlpha = sp.a * BAND_ALPHA[bi]!;
        ctx.lineWidth = sp.w;
        ctx.stroke();
      });
    }

    // labels on opaque plates that cut the lines behind them
    ctx.setLineDash([]);
    ctx.globalCompositeOperation = "source-over";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const l of layoutLabels(m.labels, cam, vp, h, measure)) {
      const col = colourOf(l.state, l.part, th);
      const a = (LABEL_ALPHA[l.state] ?? 0.8) * LABEL_BAND[l.band];
      if (l.leader) {
        const ex = Math.max(l.x, Math.min(l.x + l.w, l.leader.x));
        const ey = Math.max(l.y, Math.min(l.y + l.h, l.leader.y));
        ctx.globalAlpha = 0.7 * a;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(l.leader.x, l.leader.y);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.fillRect(l.leader.x - 1.5, l.leader.y - 1.5, 3, 3);
      }
      ctx.globalAlpha = l.big ? 0.92 : 0.8;
      ctx.fillStyle = th.bg;
      ctx.beginPath();
      ctx.rect(l.x, l.y, l.w, l.h);
      ctx.fill();
      if (l.big) {
        ctx.globalAlpha = 0.55 * a;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.strokeRect(l.x + 0.5, l.y + 0.5, l.w - 1, l.h - 1);
      }
      ctx.font = `${l.big ? 600 : 500} ${l.big ? 12 : 11}px ${FONT}`;
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      ctx.fillText(l.text, l.x + 4, l.y + l.h / 2 + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  function resize(width: number, height: number): void {
    const w = Math.max(0, Math.floor(width));
    const hgt = Math.max(0, Math.floor(height));
    dpr = Math.min(2, Math.max(1, win?.devicePixelRatio || 1));
    W = w;
    H = hgt;
    if (w <= 0 || hgt <= 0) {
      // hidden (a background tab, the narrow layout): no frames, and a transport that cannot be seen does not run
      if (frame !== null && win) win.cancelAnimationFrame(frame);
      frame = null;
      stop();
      return;
    }
    let scale = dpr;
    scale = Math.min(scale, BACKING_SIDE / w, BACKING_SIDE / hgt, Math.sqrt(BACKING_AREA / (w * hgt)));
    dpr = Math.max(0.25, scale);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(hgt * dpr));
    canvas.setCssProps({ "--wadjet-orrery-w": `${w}px`, "--wadjet-orrery-h": `${hgt}px` });
    touch();
  }

  function attach(): void {
    const next = canvas.ownerDocument.defaultView;
    if (next === win) return;
    if (frame !== null && win) win.cancelAnimationFrame(frame);
    frame = null;
    observer?.disconnect();
    observer = null;
    win = next;
    last = 0;
    if (!win) return;
    observer = new win.ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r) resize(r.width, r.height);
    });
    observer.observe(well);
  }

  function localPoint(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function partAt(ev: PointerEvent | MouseEvent): PartId | null {
    if (!model || W <= 0) return null;
    const p = localPoint(ev);
    return pickPart(model.picks, cam, viewport(), p.x, p.y);
  }

  function setHover(part: PartId | null): void {
    if (part === hover) return;
    hover = part;
    opts.onHover(part);
    touch();
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    noteTouchPointer(ev, canvas);
    ev.preventDefault();
    let px = 0;
    let py = 0;
    dragging = true;
    cancelDrag?.();
    cancelDrag = beginDrag(ev, {
      capture: canvas,
      onMove: (_m, dx, dy, moved) => {
        if (!moved) return;
        camT = orbit(camT, dx - px, dy - py);
        cam = { ...cam, yaw: camT.yaw, pitch: camT.pitch };
        px = dx;
        py = dy;
        canvas.addClass("is-dragging");
        touch();
      },
      onEnd: (end, _dx, _dy, moved) => {
        cancelDrag = null;
        dragging = false;
        canvas.removeClass("is-dragging");
        if (moved) {
          consumeJustDragged();
          return;
        }
        const part = partAt(end);
        if (part) opts.onPick(part);
      },
    });
  }

  function onPointerMove(ev: PointerEvent): void {
    if (dragging) return;
    setHover(partAt(ev));
  }

  function onPointerLeave(): void {
    if (!dragging) setHover(null);
  }

  function onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    camT = zoom(camT, ev.deltaY);
    touch();
  }

  function onDblClick(ev: MouseEvent): void {
    ev.preventDefault();
    camT = { ...VIEWS[view] };
    touch();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDblClick);
  attach();

  return {
    el: well,
    setDay(day, jump = false) {
      target = Math.floor(day);
      if (jump || rate !== null) dayF = target + 0.5;
      touch();
    },
    setPlaying(next) {
      if (next === rate) return;
      rate = next;
      if (next === null) {
        target = Math.floor(dayF);
        opts.onDay(target);
      } else lastSync = 0;
      touch();
    },
    setHighlight(next) {
      if (next.selected === selected && next.errors === errors) return;
      selected = next.selected;
      errors = next.errors;
      touch();
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      touch();
    },
    setView(next) {
      view = next;
      camT = { ...VIEWS[next] };
      touch();
    },
    invalidate() {
      builtFor = Number.NaN;
      touch();
    },
    rehome() {
      attach();
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelDrag?.();
      cancelDrag = null;
      if (frame !== null && win) win.cancelAnimationFrame(frame);
      frame = null;
      observer?.disconnect();
      observer = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDblClick);
      model = null;
      widths.clear();
      well.remove();
    },
  };
}
