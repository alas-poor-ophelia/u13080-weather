/**
 * Lane — one playlist row of spans. Drag the body to move, the white 4 px
 * edges to resize (10 px under a finger), click-drag empty lane to create,
 * right-click to delete, click to open (SPEC §3.2, §3.8). Every span shape
 * in the studio is one of six kinds; the geometry and hit testing are pure
 * (`src/studio/model/lanes.ts`).
 */
import { hitTest, moveSpan, pxToYear, resizeSpan, spanToPx, type LaneGeometry, type Span } from "../../model/lanes";
import { beginDrag, consumeJustDragged, edgePxFor, markDragTarget, noteTouchPointer } from "../pointer";

export interface LaneProps {
  geometry: LaneGeometry;
  spans: Span[];
  /** Row height in px; sub-rows (`span.row`) divide it. Default 28. */
  height?: number;
  /** Palette colour for this lane's spans. Defaults to calendar gold. */
  color?: string;
  /** Years a span may occupy. Unset means the lane does no clamping of its own. */
  bounds?: { min: number; max: number };
  /** Shortest span a resize may leave. Default: two pixels worth of years. */
  minLength?: number;
  onCreate?(from: number, to: number): void;
  onMove?(span: Span, from: number): void;
  onResize?(span: Span, zone: "start" | "end", to: number): void;
  onDelete?(span: Span): void;
  onOpen?(span: Span): void;
  onHover?(span: Span | null): void;
}

const DEFAULT_HEIGHT = 28;
const OPEN_BOUNDS = { min: -Infinity, max: Infinity };
/** One day, in fractional years. */
const DAY_YEARS = 1 / 365;
/** Below this, a year is too few pixels to drag by day — ←/→ moves a year instead (SPEC §3.8). */
const YEAR_STEP_BELOW_PX_PER_YEAR = 50;
/** Shift multiplies a keyboard move by this many steps. */
const FINE_MULTIPLIER = 7;

export interface LaneComponent {
  el: HTMLElement;
  update(next: Partial<LaneProps>): void;
  destroy(): void;
}

export function createLane(parent: HTMLElement, initial: LaneProps): LaneComponent {
  let props = initial;
  /** The span being dragged, drawn in place of its stored self until pointerup. */
  let preview: Span | null = null;
  /** The create-drag rectangle, in years. */
  let ghost: { from: number; to: number } | null = null;
  let cancelDrag: (() => void) | null = null;
  let hovered: string | null = null;

  const el = parent.createDiv({ cls: "wadjet-studio-lane" });
  markDragTarget(el);
  const spansEl = el.createDiv({ cls: "wadjet-studio-lane-spans" });

  const bounds = (): { min: number; max: number } => props.bounds ?? OPEN_BOUNDS;
  const minLength = (): number => props.minLength ?? 2 / props.geometry.pxPerYear;

  /** Lane-local x for a pointer event. */
  function localX(ev: PointerEvent | MouseEvent): number {
    return ev.clientX - el.getBoundingClientRect().left;
  }

  /**
   * The geometry with the edge width the current pointer deserves — 4 px for
   * a mouse, 10 px for a finger or pen (SPEC §8). Mirrored onto the element
   * as `data-edge-px` so both a touch pointer and its hit-test width are
   * externally observable without reaching into closure state.
   */
  function geomFor(ev: PointerEvent): LaneGeometry {
    noteTouchPointer(ev, el);
    const g = { ...props.geometry, edgePx: edgePxFor(ev) };
    el.setAttr("data-edge-px", String(g.edgePx));
    return g;
  }

  function drawn(): Span[] {
    const p = preview;
    if (!p) return props.spans;
    return props.spans.map((s) => (s.id === p.id ? p : s));
  }

  function paint(): void {
    const rows = Math.max(1, ...props.spans.map((s) => (s.row ?? 0) + 1));
    el.setCssProps({
      "--wadjet-studio-lane-height": `${props.height ?? DEFAULT_HEIGHT}px`,
      "--wadjet-studio-lane-rows": String(rows),
      "--wadjet-studio-span-color": props.color ?? "var(--wadjet-studio-gold)",
    });
    spansEl.empty();
    for (const s of drawn()) {
      const { left, width } = spanToPx(s, props.geometry);
      const node = spansEl.createDiv({ cls: "wadjet-studio-span", attr: { "data-kind": s.kind, "data-id": s.id } });
      node.setCssProps({
        "--wadjet-studio-span-left": `${left}px`,
        "--wadjet-studio-span-width": `${Math.max(1, width)}px`,
        "--wadjet-studio-span-row": String(s.row ?? 0),
      });
      node.toggleClass("is-dim", s.dim === true);
      node.toggleClass("is-editable", s.editable);
      if (s.label) node.createSpan({ cls: "wadjet-studio-span-label", text: s.label });
      if (s.editable) {
        node.setAttrs({ tabindex: "0", role: "button", "aria-label": s.label ?? s.id });
        node.createDiv({ cls: "wadjet-studio-span-edge is-start" });
        node.createDiv({ cls: "wadjet-studio-span-edge is-end" });
      }
    }
    if (ghost) {
      const g = spansEl.createDiv({ cls: "wadjet-studio-span is-ghost" });
      const left = props.geometry.x0 + (Math.min(ghost.from, ghost.to) - props.geometry.windowFrom) * props.geometry.pxPerYear;
      g.setCssProps({
        "--wadjet-studio-span-left": `${left}px`,
        "--wadjet-studio-span-width": `${Math.max(1, Math.abs(ghost.to - ghost.from) * props.geometry.pxPerYear)}px`,
        "--wadjet-studio-span-row": "0",
      });
    }
  }

  function startResize(ev: PointerEvent, span: Span, zone: "start" | "end", g: LaneGeometry): void {
    ev.preventDefault();
    cancelDrag = beginDrag(ev, {
      capture: el,
      onMove: (move) => {
        preview = resizeSpan(span, zone, pxToYear(localX(move), g), minLength(), bounds());
        paint();
      },
      onEnd: (end, _dx, _dy, moved) => {
        cancelDrag = null;
        const next = resizeSpan(span, zone, pxToYear(localX(end), g), minLength(), bounds());
        preview = null;
        paint();
        if (moved) props.onResize?.(span, zone, zone === "start" ? next.from : next.to);
      },
    });
  }

  function startMove(ev: PointerEvent, span: Span, g: LaneGeometry, x0: number): void {
    ev.preventDefault();
    cancelDrag = beginDrag(ev, {
      capture: el,
      onMove: (move) => {
        preview = moveSpan(span, pxToYear(localX(move), g) - pxToYear(x0, g), bounds());
        paint();
      },
      onEnd: (end, _dx, _dy, moved) => {
        cancelDrag = null;
        const next = moveSpan(span, pxToYear(localX(end), g) - pxToYear(x0, g), bounds());
        preview = null;
        paint();
        if (moved) props.onMove?.(span, next.from);
      },
    });
  }

  function startCreate(ev: PointerEvent, g: LaneGeometry, x0: number): void {
    const startYear = pxToYear(x0, g);
    ev.preventDefault();
    cancelDrag = beginDrag(ev, {
      capture: el,
      onMove: (move) => {
        ghost = { from: startYear, to: pxToYear(localX(move), g) };
        paint();
      },
      onEnd: (end, _dx, _dy, moved) => {
        cancelDrag = null;
        const endYear = pxToYear(localX(end), g);
        ghost = null;
        paint();
        if (moved) props.onCreate?.(Math.min(startYear, endYear), Math.max(startYear, endYear));
      },
    });
  }

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const g = geomFor(ev);
    const x0 = localX(ev);
    const hit = hitTest(props.spans, x0, g);
    if (hit?.span.editable && hit.zone !== "body" && props.onResize) startResize(ev, hit.span, hit.zone, g);
    else if (hit?.span.editable && props.onMove) startMove(ev, hit.span, g, x0);
    else if (!hit && props.onCreate) startCreate(ev, g, x0);
  }

  function onClick(ev: MouseEvent): void {
    // The browser fires a click straight after every drag; that one is not a click.
    if (consumeJustDragged()) return;
    if (!props.onOpen) return;
    const hit = hitTest(props.spans, localX(ev), props.geometry);
    if (hit) props.onOpen(hit.span);
  }

  function onContextMenu(ev: MouseEvent): void {
    if (!props.onDelete) return;
    const hit = hitTest(props.spans, localX(ev), props.geometry);
    if (!hit?.span.editable) return;
    ev.preventDefault();
    props.onDelete(hit.span);
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!props.onHover || cancelDrag) return;
    const hit = hitTest(props.spans, localX(ev), geomFor(ev));
    const id = hit?.span.id ?? null;
    if (id === hovered) return;
    hovered = id;
    props.onHover(hit?.span ?? null);
  }

  function onPointerLeave(): void {
    if (!props.onHover || hovered === null) return;
    hovered = null;
    props.onHover(null);
  }

  /**
   * Keyboard on a focused editable span (SPEC §3.8): ←/→ move it by one day,
   * or one year once a year is under `YEAR_STEP_BELOW_PX_PER_YEAR` px (Era
   * zoom — a day is imperceptible there); shift moves seven steps at once.
   * Delete/Backspace removes it; Enter opens it.
   */
  function onKeyDown(ev: KeyboardEvent): void {
    const node = (ev.target as HTMLElement).closest<HTMLElement>(".wadjet-studio-span[data-id]");
    if (!node) return;
    const id = node.getAttribute("data-id");
    const span = props.spans.find((s) => s.id === id);
    if (!span || !span.editable) return;

    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      if (!props.onMove) return;
      ev.preventDefault();
      const dir = ev.key === "ArrowRight" ? 1 : -1;
      const stepYears = props.geometry.pxPerYear < YEAR_STEP_BELOW_PX_PER_YEAR ? 1 : DAY_YEARS;
      const dYears = dir * stepYears * (ev.shiftKey ? FINE_MULTIPLIER : 1);
      const next = moveSpan(span, dYears, bounds());
      if (next.from !== span.from) props.onMove(span, next.from);
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      if (!props.onDelete) return;
      ev.preventDefault();
      props.onDelete(span);
    } else if (ev.key === "Enter") {
      if (!props.onOpen) return;
      ev.preventDefault();
      props.onOpen(span);
    }
  }

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("click", onClick);
  el.addEventListener("contextmenu", onContextMenu);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerleave", onPointerLeave);
  el.addEventListener("keydown", onKeyDown);
  paint();

  return {
    el,
    update(next) {
      props = { ...props, ...next };
      paint();
    },
    destroy() {
      cancelDrag?.();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("click", onClick);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("keydown", onKeyDown);
      el.remove();
    },
  };
}
