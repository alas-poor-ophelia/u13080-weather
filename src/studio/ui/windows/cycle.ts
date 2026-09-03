/**
 * The moon **CYCLE** window (SPEC §3.4 "Sable · CYCLE").
 *
 * One panel per moon: a ring showing one full cycle as named phases, the
 * boundaries between them dragged around it, and a lit-shape moon in the
 * middle previewing the phase last touched. `MoonConfig.phases` is display
 * metadata (PLAN §2.2) — the engine never sees the names — so everything here
 * writes `settings.calendar.moons[i]` and nothing else.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **Moons are world scope** (SPEC §2). Every edit here reaches every zone
 *    in the vault, so the panel wears a `world · N zones` badge and the first
 *    world edit of a session goes through the confirm in
 *    `model/world-confirm.ts`.
 *  - **A plugin calendar is a mirror, not an editor** (SPEC §8). When the
 *    active adapter describes itself as `readOnly`, the ring draws the
 *    *description's* phases, every edit affordance is gone, and the footer
 *    says where the calendar is actually edited.
 *  - **The period and the epoch are readouts, not controls.** The prototype
 *    exposes the period as a title chip and has no epoch control at all; both
 *    are facts about the calendar, and under a plugin adapter they are not
 *    ours to change. Editing them was the plugin's own invention.
 *  - **The disc is hand-drawn SVG, not the Chart.** `ChartKind: "disc"` draws
 *    boundary spokes and drag handles but no ring arcs, no labels and no moon,
 *    and this window needs all three (plus double-click-an-arc-to-split).
 *    Rather than grow the shared Chart with a second disc dialect, the window
 *    owns its own `createSvg` ring — SPEC §3.4 allows either.
 *
 * The boundary maths is entirely `model/boundaries.ts`, shared with the
 * Seasons window; nothing in this file computes a phase itself. The moon's
 * lit shape is `model/moon-shape.ts`, shared with nothing yet — it is the one
 * derivation the prototype has and the model layer did not.
 */
import type { CalendarDescription } from "../../../plugin/time/adapter";
import {
  PHASE_LIMITS,
  angleOf,
  dragMark,
  fromPhases,
  merge,
  normalise,
  phaseOfAngle,
  rename,
  segments,
  split,
  splitLongest,
  toPhases,
  type Mark,
} from "../../model/boundaries";
import { grammar } from "../../model/copy";
import { DEFAULT_MOON_PHASES } from "../../model/devices";
import { cycleHint } from "../../model/hints-cycle";
import { litShapePath, phaseLabelTint, phaseTint } from "../../model/moon-shape";
import type { StudioState } from "../../model/state";
import { ledLevel, studioRules, unitKey, type StudioIssue } from "../../model/validation";
import { needsWorldConfirm } from "../../model/world-confirm";
import { createChip, type ChipComponent } from "../components";
import { beginDrag, markDragTarget } from "../pointer";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";

/** Window ids are `cycle:<moon name>` — one panel per moon, opened by name. */
export const CYCLE_WINDOW_PREFIX = "cycle:";

/**
 * The disc's SVG user-space box and the four radii on it, straight from the
 * prototype's `vst-sablemoon` markup: a 212 px square, a 48 px moon in the
 * middle, the phase ring at 78 and the phase names at 96.
 */
const SIZE = 212;
const CENTRE = SIZE / 2;
const MOON_R = 48;
const RING_R = 78;
const LABEL_R = 96;
const HANDLE_R = 6;

/** A whole-circle segment (one phase) cannot be drawn as an arc — it is the circle. */
const FULL_CIRCLE = 0.999;

/** A segment narrower than this has no room for its name on the ring (prototype: 0.045). */
const LABEL_MIN_LENGTH = 0.045;

/** The default period a moon with no config would carry (`DEFAULT_SETTINGS.calendar.moons`). */
const DEFAULT_CYCLE_DAYS = 29.53;

export function cycleWindowId(moonName: string): string {
  return `${CYCLE_WINDOW_PREFIX}${moonName}`;
}

/** Screen point for a disc angle: degrees clockwise from 12 o'clock (`angleOf`). */
function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CENTRE + r * Math.cos(rad), y: CENTRE + r * Math.sin(rad) };
}

/** A stroked arc along the ring from `fromDeg` to `toDeg`, clockwise. */
function arcPath(fromDeg: number, toDeg: number, r: number): string {
  const a = polar(fromDeg, r);
  const b = polar(toDeg, r);
  const sweptDeg = ((toDeg - fromDeg) % 360 + 360) % 360;
  const large = sweptDeg > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/** A plain window button: a real button for the keyboard, hinted like everything else. */
function cycleButton(parent: HTMLElement, o: { text: string; label: string; hint: string; part: string; onClick: () => void }): HTMLElement {
  const el = parent.createDiv({
    cls: "wadjet-studio-cycle-btn",
    text: o.text,
    attr: { role: "button", tabindex: "0", "aria-label": o.label, "data-hint": o.hint, "data-part": o.part },
  });
  const fire = (): void => {
    if (el.hasClass("is-disabled")) return;
    o.onClick();
  };
  el.addEventListener("click", fire);
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    fire();
  });
  return el;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  el.toggleClass("is-disabled", disabled);
  el.setAttrs({ "aria-disabled": disabled ? "true" : "false", tabindex: disabled ? "-1" : "0" });
}

/**
 * The builder for one moon's panel. Registered per moon by
 * `registerCycleWindows`; opened by a moon chip through `openCycleFor`.
 */
export function buildCycleWindow(moonName: string): WindowBuilder {
  return (ctx: SurfaceContext): WindowBuild => {
    let unsubscribe: (() => void) | null = null;
    let cancelDrag: (() => void) | null = null;
    let signature = "";
    /** The list index whose name is being typed into; paint holds off while it is open. */
    let editing: number | null = null;
    /**
     * The phase the moon in the middle is drawn at — the prototype's
     * `moonPreview`. Ephemeral view state, not the draft: hovering a phase or
     * dragging a boundary moves it, and it falls back to the last boundary.
     */
    let preview: number | null = null;

    const root = createDiv({ cls: "wadjet-studio-cycle" });

    const main = root.createDiv({ cls: "wadjet-studio-cycle-main" });
    const discWrap = main.createDiv({ cls: "wadjet-studio-cycle-disc", attr: { "data-hint": cycleHint("cycle.disc"), "data-part": "cycle-disc" } });
    let svg = discWrap.createSvg("svg");
    /** Redrawn in place while the pointer is over the ring, so hover never rips the disc out. */
    let moonPath: SVGElement | null = null;

    const side = main.createDiv({ cls: "wadjet-studio-cycle-side" });

    // The calendar the phases come from, and the reach of an edit to them.
    const head = side.createDiv({ cls: "wadjet-studio-cycle-head" });
    const sourceChip: ChipComponent = createChip(head, { label: "internal calendar", color: "var(--wadjet-studio-wind)", hint: cycleHint("cycle.source") });
    const worldChip: ChipComponent = createChip(head, { label: "world · 0 zones", color: "var(--wadjet-studio-gold)", hint: cycleHint("cycle.world") });
    sourceChip.el.addClass("is-source");
    sourceChip.el.setAttr("data-part", "cycle-source");
    worldChip.el.setAttr("data-part", "cycle-world");

    const caption = side.createDiv({ cls: "wadjet-studio-cycle-caption" });
    const list = side.createDiv({ cls: "wadjet-studio-cycle-list", attr: { "data-part": "cycle-list" } });
    const actions = side.createDiv({ cls: "wadjet-studio-cycle-actions" });
    const previewLine = side.createDiv({ cls: "wadjet-studio-cycle-preview", attr: { "data-hint": cycleHint("cycle.preview"), "data-part": "cycle-preview" } });
    const readouts = side.createDiv({ cls: "wadjet-studio-cycle-readouts" });
    const periodOut = readouts.createSpan({ cls: "wadjet-studio-cycle-readout wadjet-studio-num", attr: { "data-hint": cycleHint("cycle.period"), "data-part": "cycle-period" } });
    const epochOut = readouts.createSpan({ cls: "wadjet-studio-cycle-readout wadjet-studio-num", attr: { "data-hint": cycleHint("cycle.epoch"), "data-part": "cycle-epoch" } });
    const editLine = side.createDiv({ cls: "wadjet-studio-cycle-editin", attr: { "data-hint": cycleHint("cycle.edit"), "data-part": "cycle-editin" } });

    // --- state readers -----------------------------------------------------

    function description(): CalendarDescription | null {
      return ctx.calendar();
    }

    function readOnly(): boolean {
      return description()?.readOnly === true;
    }

    function sourceLabel(): string {
      const d = description();
      return d !== null && d.readOnly ? `${d.label} · read-only` : "internal calendar";
    }

    function draftMoon(state: StudioState): StudioState["world"]["calendar"]["moons"][number] | undefined {
      return state.world.calendar.moons.find((m) => m.name === moonName);
    }

    function mirrorMoon(): CalendarDescription["moons"][number] | undefined {
      return description()?.moons.find((m) => m.name === moonName);
    }

    /**
     * The phases on screen. A moon with none of its own starts from
     * `DEFAULT_MOON_PHASES` — shown, not written, until the first edit.
     */
    function marks(): Mark[] {
      if (readOnly()) return normalise(fromPhases(mirrorMoon()?.phases ?? []));
      const phases = draftMoon(ctx.store.get())?.phases;
      return normalise(fromPhases(phases !== undefined && phases.length > 0 ? phases : DEFAULT_MOON_PHASES));
    }

    function cycleDays(): number {
      if (readOnly()) return mirrorMoon()?.cycleDays ?? DEFAULT_CYCLE_DAYS;
      return draftMoon(ctx.store.get())?.cycleDays ?? DEFAULT_CYCLE_DAYS;
    }

    function phaseAtEpoch(): number {
      if (readOnly()) return mirrorMoon()?.phaseAtEpoch ?? 0;
      return draftMoon(ctx.store.get())?.phaseAtEpoch ?? 0;
    }

    /** The previewed phase: whatever was last touched, else the last boundary. */
    function previewPhase(list_: readonly Mark[]): number {
      if (preview !== null) return preview;
      return list_[list_.length - 1]?.at ?? 0;
    }

    // --- writes ------------------------------------------------------------

    /** Run `apply`, behind the session's one world-edit confirm (SPEC §2). */
    function guarded(apply: () => void): void {
      // A cancelled edit leaves a control showing a value nobody committed.
      confirmWorldEdit(ctx.plugin.app, ctx, "moons", apply, () => repaint(true));
    }

    function writeMarks(next: readonly Mark[], history: boolean): void {
      const phases = toPhases(normalise(next));
      ctx.store.update(
        (s) => {
          const moon = draftMoon(s);
          if (moon === undefined) return;
          moon.phases = phases;
        },
        { history },
      );
    }

    /** `null` from a boundary op means "refused" (limits) — leave the state alone. */
    function applyMarks(next: readonly Mark[] | null): void {
      if (next === null) return;
      guarded(() => writeMarks(next, true));
    }

    // --- the moon in the middle --------------------------------------------

    /**
     * Repaint only the lit shape and its caption. Hover fires a lot and the
     * ring must survive the pointer being on one of its own arcs, so this
     * never touches the disc's structure.
     */
    function paintMoon(list_: readonly Mark[]): void {
      const at = previewPhase(list_);
      moonPath?.setAttr("d", litShapePath(at, CENTRE, CENTRE, MOON_R));
      previewLine.setText(`disc preview · phase ${at.toFixed(2)} · d${(at * cycleDays()).toFixed(1)} of the cycle`);
    }

    function setPreview(at: number | null): void {
      preview = at;
      paintMoon(marks());
    }

    // --- disc --------------------------------------------------------------

    /** Where on the cycle the pointer is, in [0,1) — viewBox-corrected. */
    function phaseAt(ev: MouseEvent): number {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 0;
      const x = ((ev.clientX - rect.left) / rect.width) * SIZE - CENTRE;
      const y = ((ev.clientY - rect.top) / rect.height) * SIZE - CENTRE;
      return phaseOfAngle((Math.atan2(y, x) * 180) / Math.PI + 90);
    }

    function startDrag(ev: PointerEvent, name: string, node: SVGElement): void {
      if (ev.button !== 0 || readOnly()) return;
      ev.preventDefault();
      ev.stopPropagation();
      // The confirm cannot interrupt a live gesture; ask first, drag after.
      if (needsWorldConfirm()) {
        guarded(() => undefined);
        return;
      }
      cancelDrag = beginDrag(ev, {
        capture: node,
        onMove: (move) => {
          const list_ = marks();
          const at = list_.findIndex((m) => m.name === name);
          if (at < 0) return;
          const to = phaseAt(move);
          // The prototype's `moonBoundDown`: the moon shows where the boundary is going.
          preview = to;
          writeMarks(dragMark(list_, at, to, PHASE_LIMITS), false);
        },
        onEnd: (_end, _dx, _dy, moved) => {
          cancelDrag = null;
          // One drag, one undo step: the store pushes the pre-drag drafts here.
          if (moved) ctx.store.snapshot();
        },
      });
    }

    function drawDisc(list_: readonly Mark[]): void {
      svg.remove();
      svg = discWrap.createSvg("svg", { cls: "wadjet-studio-cycle-svg", attr: { viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img", "aria-label": `${moonName} phases` } });
      // The unlit disc, then the lit shape over it: together they are the moon.
      svg.createSvg("circle", { cls: "wadjet-studio-cycle-face", attr: { cx: CENTRE, cy: CENTRE, r: MOON_R } });
      moonPath = svg.createSvg("path", { cls: "wadjet-studio-cycle-moon", attr: { d: litShapePath(previewPhase(list_), CENTRE, CENTRE, MOON_R) } });

      const segs = segments(list_);
      segs.forEach((seg, i) => {
        const mid = seg.from + seg.length / 2;
        const attrs = { "data-index": String(i), "data-name": seg.name, "data-hint": cycleHint("cycle.arc") };
        const arc =
          seg.length >= FULL_CIRCLE
            ? svg.createSvg("circle", { cls: "wadjet-studio-cycle-arc", attr: { ...attrs, cx: CENTRE, cy: CENTRE, r: RING_R } })
            : svg.createSvg("path", { cls: "wadjet-studio-cycle-arc", attr: { ...attrs, d: arcPath(angleOf(seg.from), angleOf(seg.to) - 0.5, RING_R) } });
        // The ring lightens from new to full, the way the prototype's hsl ramp does.
        arc.setCssProps({ "--wadjet-studio-cycle-tint": phaseTint(mid).toFixed(3) });
        arc.addEventListener("dblclick", (ev: MouseEvent) => {
          if (readOnly()) return;
          ev.preventDefault();
          ev.stopPropagation();
          applyMarks(split(marks(), phaseAt(ev), PHASE_LIMITS));
        });
        arc.addEventListener("mouseenter", () => setPreview(mid));

        // The name sits outside the ring, at the middle of its own arc.
        if (seg.length < LABEL_MIN_LENGTH) return;
        const at = polar(angleOf(seg.from) + (seg.length / 2) * 360, LABEL_R);
        const label = svg.createSvg("text", {
          cls: "wadjet-studio-cycle-label",
          attr: { x: at.x.toFixed(2), y: at.y.toFixed(2), "text-anchor": "middle", "dominant-baseline": "middle", "data-index": String(i), "data-name": seg.name, "data-hint": cycleHint("cycle.name") },
        });
        label.setCssProps({ "--wadjet-studio-cycle-tint": phaseLabelTint(mid).toFixed(3) });
        label.setText(seg.name);
        label.addEventListener("dblclick", (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
          const row = list.querySelector<HTMLElement>(`.wadjet-studio-cycle-row[data-index="${i}"] .wadjet-studio-cycle-rowname`);
          if (row !== null) beginRename(i, row);
        });
      });

      // Boundary handles ride *on* the ring. Under a read-only calendar they
      // go — the arcs are the data, the handles are the edit.
      if (readOnly()) return;
      list_.forEach((mark, i) => {
        const end = polar(angleOf(mark.at), RING_R);
        const handle = svg.createSvg("circle", {
          cls: "wadjet-studio-cycle-handle",
          attr: { cx: end.x.toFixed(2), cy: end.y.toFixed(2), r: HANDLE_R, "data-index": String(i), "data-name": mark.name, "data-hint": cycleHint("cycle.handle") },
        });
        markDragTarget(handle);
        handle.addEventListener("pointerdown", (ev: PointerEvent) => startDrag(ev, mark.name, handle));
        handle.addEventListener("mouseenter", () => setPreview(mark.at));
      });
    }

    // The moon falls back to the last boundary once the pointer leaves the ring.
    discWrap.addEventListener("mouseleave", () => setPreview(null));

    // --- the phase list ----------------------------------------------------

    function beginRename(index: number, anchor: HTMLElement): void {
      if (readOnly() || editing !== null) return;
      const current = marks()[index]?.name ?? "";
      editing = index;
      anchor.empty();
      const input = anchor.createEl("input", { cls: "wadjet-studio-cycle-rename", type: "text", value: current, attr: { "data-part": "cycle-rename" } });
      input.focus();
      input.select();
      let done = false;
      const close = (apply: boolean): void => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        editing = null;
        if (apply && value.length > 0 && value !== current) applyMarks(rename(marks(), index, value));
        repaint(true);
      };
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          close(true);
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          close(false);
        }
        ev.stopPropagation();
      });
      input.addEventListener("blur", () => close(true));
    }

    function drawList(list_: readonly Mark[]): void {
      list.empty();
      const editable = !readOnly();
      const segs = segments(list_);
      const days = cycleDays();
      segs.forEach((seg, i) => {
        const row = list.createDiv({ cls: "wadjet-studio-cycle-row", attr: { "data-index": String(i), "data-name": seg.name, "data-part": "cycle-row" } });
        const swatch = row.createSpan({ cls: "wadjet-studio-cycle-swatch", attr: { "aria-hidden": "true" } });
        swatch.setCssProps({ "--wadjet-studio-cycle-tint": phaseTint(seg.from + seg.length / 2).toFixed(3) });
        const name = row.createSpan({ cls: "wadjet-studio-cycle-rowname", text: seg.name, attr: { "data-hint": cycleHint("cycle.name"), "data-part": "cycle-name" } });
        if (editable) name.addEventListener("dblclick", () => beginRename(i, name));
        // The prototype's row readout: the span this phase covers, then its
        // length in days. The last segment closes the cycle, so it ends at
        // 1.00 rather than at the wrapped 0.00 `segments` reports.
        const to = seg.to <= seg.from ? 1 : seg.to;
        row.createSpan({ cls: "wadjet-studio-cycle-rowat wadjet-studio-num", text: `${seg.from.toFixed(2)} – ${to.toFixed(2)} · ${(seg.length * days).toFixed(1)} d` });
        row.addEventListener("mouseenter", () => setPreview(seg.from + seg.length / 2));
        // The origin phase has no ×: merging it would move the start of the cycle.
        if (!editable || i === 0) return;
        const remove = row.createDiv({
          cls: "wadjet-studio-cycle-x",
          text: "×",
          attr: { role: "button", tabindex: "0", "aria-label": `Remove ${seg.name}`, "data-hint": cycleHint("cycle.remove"), "data-part": "cycle-remove" },
        });
        const fire = (): void => {
          if (remove.hasClass("is-disabled")) return;
          applyMarks(merge(marks(), i, PHASE_LIMITS));
        };
        setDisabled(remove, list_.length <= Math.max(2, PHASE_LIMITS.min));
        remove.addEventListener("click", fire);
        remove.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          fire();
        });
      });
    }

    // --- controls built once ----------------------------------------------

    const splitButton = cycleButton(actions, {
      text: "＋ split phase",
      label: "Split the longest phase",
      hint: cycleHint("cycle.split"),
      part: "cycle-split",
      onClick: () => applyMarks(splitLongest(marks(), PHASE_LIMITS)),
    });

    // --- paint -------------------------------------------------------------

    function repaint(force: boolean): void {
      // An open rename input is the user's, not the renderer's.
      if (editing !== null && !force) return;
      const state = ctx.store.get();
      const list_ = marks();
      const ro = readOnly();
      const key = `${JSON.stringify(list_)}|${cycleDays()}|${phaseAtEpoch()}|${String(ro)}|${sourceLabel()}|${Object.keys(state.zones).length}`;
      if (!force && key === signature) return;
      signature = key;

      root.toggleClass("is-readonly", ro);
      sourceChip.update({ label: sourceLabel(), color: ro ? "var(--wadjet-studio-gold)" : "var(--wadjet-studio-wind)" });
      const zones = Object.keys(state.zones).length;
      worldChip.update({ label: `world · ${zones} zones` });

      caption.setText(`PHASES · ${list_.length}`);
      drawDisc(list_);
      drawList(list_);
      paintMoon(list_);

      splitButton.toggleClass("is-hidden", ro);
      setDisabled(splitButton, list_.length >= PHASE_LIMITS.max);

      periodOut.setText(`↻ ${cycleDays().toFixed(2)} d`);
      epochOut.setText(`epoch ${phaseAtEpoch().toFixed(3)}`);

      const d = description();
      const hint = d !== null && d.readOnly ? (d.editHint ?? `edit in ${d.label}`) : "";
      editLine.setText(hint);
      editLine.toggleClass("is-hidden", hint === "");
    }

    unsubscribe = ctx.store.subscribe(() => repaint(false));
    repaint(true);

    // --- pull-based readouts ----------------------------------------------

    /** The grammar this panel produces (SPEC law 5) — never raw JSON. */
    function writes(): string {
      const d = description();
      if (d !== null && d.readOnly) return `nothing — ${d.label} owns this calendar`;
      const state = ctx.store.get();
      const moon = draftMoon(state);
      if (moon === undefined) return `calendar.moons — no moon named "${moonName}"`;
      const phases = marks().map((m) => `${m.name}@${m.at.toFixed(2)}`).join(", ");
      return grammar(`calendar.moons[${moonName}]`, `period ${moon.cycleDays.toFixed(2)} d`, `phases [${phases}]`);
    }

    function issues(): StudioIssue[] {
      const state = ctx.store.get();
      const zoneId = state.view.zoneId;
      const zone = zoneId === null ? undefined : state.zones[zoneId];
      if (zone === undefined) return [];
      const d = description();
      const ro = d?.readOnly === true;
      const all = studioRules({
        zone,
        eras: state.world.eras,
        seasons: ro ? (d?.seasons ?? []) : state.world.calendar.seasons,
        moons: ro ? (d?.moons ?? []) : state.world.calendar.moons,
        readOnlyCalendar: ro,
      });
      const mine = unitKey({ kind: "moon", name: moonName });
      return all.filter((i) => unitKey(i.unit) === mine);
    }

    return {
      title: moonName,
      // Prototype width (`proto-markup/`): a design constant, not a function of the content.
      width: 452,
      badge: "CYCLE",
      badgeColor: "var(--wadjet-studio-moon)",
      // The prototype's `↻ 29.53 d` title readout — the period is a fact, not a control.
      caption: `↻ ${cycleDays().toFixed(2)} d`,
      body: root,
      led: { on: true, scope: "device" },
      level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "moon", name: moonName }))),
      writes,
      issues,
      onClose: () => {
        cancelDrag?.();
        cancelDrag = null;
        unsubscribe?.();
        unsubscribe = null;
        sourceChip.destroy();
        worldChip.destroy();
        root.remove();
      },
    };
  };
}

/**
 * Register one panel per moon the studio knows about — the world draft's moons
 * plus, under a describing adapter, the ones only the calendar knows. Called
 * on every tick by `moons-surface.ts`, so a moon added or renamed elsewhere
 * becomes openable without a rebuild, and `windows.restore()` finds a builder
 * for every `cycle:*` id the leaf remembered.
 */
export function registerCycleWindows(ctx: SurfaceContext): void {
  const names = new Set<string>();
  for (const moon of ctx.store.get().world.calendar.moons) names.add(moon.name);
  for (const moon of ctx.calendar()?.moons ?? []) names.add(moon.name);
  for (const name of names) ctx.windows.register(cycleWindowId(name), buildCycleWindow(name));
}

/**
 * Open (or focus) the CYCLE window for `moonName` — SPEC law 2: a moon chip
 * on a device, a moon disc on the day card and the mixer all reach the moon
 * this way. Registers the builder on the way in, so a moon that only the
 * active calendar describes still opens.
 */
export function openCycleFor(ctx: SurfaceContext, moonName: string): void {
  ctx.windows.open(cycleWindowId(moonName), buildCycleWindow(moonName));
}
