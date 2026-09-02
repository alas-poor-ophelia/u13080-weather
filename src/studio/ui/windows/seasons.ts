/**
 * Seasons · CALENDAR window (SPEC §3.4 "Seasons · CALENDAR", PLAN §0.1,
 * bead wadjet-9f9.27).
 *
 * A horizontal bar of the year (0 → 1), one tinted segment per season, with
 * draggable ⚑ flags at every boundary. All the boundary maths — drag, split,
 * split-the-longest, merge, rename — is `model/boundaries.ts`; this file is
 * only the DOM, the pointer wiring and the world-scoped write.
 *
 * Two things worth knowing before editing this file:
 *
 *  - **This is a window body, not a surface.** `WindowManager.renderAll`
 *    only re-reads `writes()`/`issues()`/`level()` (pull-based, SPEC law 5).
 *    Everything else drawn here — the bar, the chips, the read-only line —
 *    repaints only because this file subscribes to the store itself and
 *    unsubscribes in `onClose` (the manager calls `onClose` once, on × or
 *    `close(id)`).
 *  - **Seasons live in `state.world.calendar.seasons` under an *editable*
 *    calendar** (SPEC §2: world scope, `settings.calendar.seasons`, internal
 *    adapter only). Under a describing adapter that reports `readOnly`, the
 *    adapter's own description is the truth to mirror and every edit
 *    affordance is hidden (SPEC §3.4, §8; PLAN §3).
 *
 * `state.world.calendar.seasons` is kept normalised (ascending `at`, wrapped
 * into [0,1)) by every write this file makes, so `Mark[]` index and
 * `segments()` output index always agree (`boundaries.ts`'s own contract for
 * callers — see its file doc).
 */
import { dayLabel } from "../../model/format";
import { seasonsHint } from "../../model/hints-seasons";
import { cycleColour } from "../../model/palette";
import type { StudioState } from "../../model/state";
import { dragMark, fromSeasons, merge, normalise, rename, SEASON_LIMITS, segments, split, splitLongest, toSeasons, type Mark, type Segment } from "../../model/boundaries";
import { issuesFor, ledLevel, unitKey, type StudioIssue } from "../../model/validation";
import { needsWorldConfirm } from "../../model/world-confirm";
import { createChip, type ChipComponent } from "../components";
import { beginDrag, markDragTarget } from "../pointer";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";

/** The id this window is registered and opened under (SPEC §3.4). */
export const SEASONS_WINDOW = "seasons";

/** Year length to assume when the active adapter does not describe itself. */
const DEFAULT_YEAR_LENGTH = 365;

/** A segment's fill: `model/palette.ts`'s band cycle at 30 %, over the panel. */
function tint(index: number): string {
  return `color-mix(in srgb, ${cycleColour(index)} 30%, var(--wadjet-studio-panel))`;
}

function setDisabled(el: HTMLElement, disabled: boolean): void {
  el.toggleClass("is-disabled", disabled);
  el.setAttrs({ "aria-disabled": disabled ? "true" : "false", tabindex: disabled ? "-1" : "0" });
}

/** What the calendar looks like to this window: which seasons to show, and whether they can be edited. */
interface CalendarView {
  readOnly: boolean;
  label: string;
  editHint?: string;
  seasons: ReadonlyArray<{ name: string; from: number }>;
  yearLength: number;
}

/**
 * Mirrors `header.ts`'s `derive()` and `ruler.ts`'s `spanCalendarFor()`: an
 * adapter that does not describe itself (`calendar()` returns `null`) is
 * treated the same as the internal one — nothing to mirror as read-only, so
 * the world draft is the truth (matches `InternalCalendar.describe()`
 * always reporting `readOnly: false`).
 */
function calendarView(ctx: SurfaceContext, state: StudioState): CalendarView {
  const description = ctx.calendar();
  const readOnly = description?.readOnly ?? false;
  const seasons = readOnly ? (description?.seasons ?? []) : state.world.calendar.seasons;
  const yearLength = description?.yearLength ?? DEFAULT_YEAR_LENGTH;
  const label = readOnly ? (description?.label ?? "calendar") : "internal calendar";
  return { readOnly, label, seasons, yearLength, ...(description?.editHint !== undefined ? { editHint: description.editHint } : {}) };
}

/**
 * The seasons-unit issues (SPEC §3.9), from the real validator. `issuesFor`'s
 * input type always wants a `zone` (it also runs `validateProfile`), even
 * though the "seasons" bucket only ever comes from its `studioRules` half —
 * so a world with no zone yet (nothing to validate against) shows no issues,
 * rather than reaching for a fabricated zone just to satisfy the type.
 */
function seasonsIssues(ctx: SurfaceContext, state: StudioState, view: CalendarView): StudioIssue[] {
  const zoneId = state.view.zoneId;
  const zone = zoneId === null ? null : (state.zones[zoneId] ?? null);
  if (zone === null) return [];
  const moons = view.readOnly ? (ctx.calendar()?.moons ?? []) : state.world.calendar.moons;
  const all = issuesFor({ zone, eras: state.world.eras, seasons: view.seasons, moons, readOnlyCalendar: view.readOnly });
  return all.filter((i) => i.unit.kind === "seasons");
}

/**
 * Gate a world mutation behind the session's one confirm (SPEC §2). When a
 * confirm is not needed (already given this session), `run` fires immediately.
 */
function withWorldConfirm(ctx: SurfaceContext, run: () => void): void {
  confirmWorldEdit(ctx.plugin.app, ctx, "seasons", run);
}

export const buildSeasonsWindow: WindowBuilder = (ctx) => {
  const body = createDiv({ cls: "wadjet-studio-seasons" });
  const topRow = body.createDiv({ cls: "wadjet-studio-seasons-top" });
  const sourceChip: ChipComponent = createChip(topRow, { label: "internal calendar", hint: seasonsHint("seasons.source") });
  const worldChip: ChipComponent = createChip(topRow, { label: "world · 0 zones", hint: seasonsHint("seasons.world") });
  sourceChip.el.setAttr("data-part", "source");
  worldChip.el.setAttr("data-part", "world");

  const bar = body.createDiv({ cls: "wadjet-studio-seasons-bar", attr: { "data-hint": seasonsHint("seasons.bar") } });
  markDragTarget(bar);
  const daysEl = body.createDiv({ cls: "wadjet-studio-seasons-days" });

  const actions = body.createDiv({ cls: "wadjet-studio-seasons-actions" });
  const splitBtn = actions.createDiv({
    cls: "wadjet-studio-seasons-split",
    text: "＋ split the longest",
    attr: { role: "button", tabindex: "0", "data-hint": seasonsHint("seasons.split") },
  });

  const editLink = body.createDiv({ cls: "wadjet-studio-seasons-editlink is-hidden", attr: { "data-hint": seasonsHint("seasons.editHint") } });

  /** `view.seasons` as `Mark[]` — index-aligned with the draft as long as it stays normalised (see the file doc). */
  function currentMarks(view: CalendarView): Mark[] {
    return fromSeasons(view.seasons);
  }

  /** The one write-through this window makes: always normalised, so index alignment holds on the next paint. */
  function writeMarks(next: Mark[]): void {
    ctx.store.update((s) => {
      s.world.calendar.seasons = toSeasons(normalise(next));
    }, { history: true });
  }

  function trySplitAt(marks: Mark[], phase: number): void {
    withWorldConfirm(ctx, () => {
      const next = split(marks, phase, SEASON_LIMITS);
      if (next === null) return;
      writeMarks(next);
    });
  }

  function trySplitLongest(marks: Mark[]): void {
    withWorldConfirm(ctx, () => {
      const next = splitLongest(marks, SEASON_LIMITS);
      if (next === null) return;
      writeMarks(next);
    });
  }

  function tryMerge(marks: Mark[], index: number): void {
    withWorldConfirm(ctx, () => {
      const next = merge(marks, index, SEASON_LIMITS);
      if (next === null) return;
      writeMarks(next);
    });
  }

  function tryRename(marks: Mark[], index: number, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === marks[index]?.name) return;
    withWorldConfirm(ctx, () => {
      writeMarks(rename(marks, index, trimmed));
    });
  }

  function phaseFromClientX(clientX: number): number {
    const rect = bar.getBoundingClientRect();
    const w = rect.width || 1;
    const frac = (clientX - rect.left) / w;
    return Math.min(0.999999, Math.max(0, frac));
  }

  function startFlagDrag(ev: PointerEvent, index: number): void {
    ev.preventDefault();
    beginDrag(ev, {
      onMove: (move) => {
        const state = ctx.store.get();
        const view = calendarView(ctx, state);
        if (view.readOnly) return;
        const marks = currentMarks(view);
        const next = dragMark(marks, index, phaseFromClientX(move.clientX), SEASON_LIMITS);
        ctx.store.update((s) => {
          s.world.calendar.seasons = toSeasons(next);
        });
      },
      onEnd: () => {
        // `dragMark` never reorders, so this is a no-op sort in the common
        // case; it is here so a drag can never leave the draft unsorted.
        ctx.store.update((s) => {
          s.world.calendar.seasons = toSeasons(normalise(fromSeasons(s.world.calendar.seasons)));
        });
        ctx.store.snapshot();
      },
    });
  }

  function onFlagPointerDown(ev: PointerEvent, index: number, view: CalendarView): void {
    if (ev.button !== 0 || view.readOnly) return;
    if (needsWorldConfirm()) {
      // The gesture cannot resume once a modal steals focus, so the first
      // attempt only confirms; the drag itself starts on the next one.
      withWorldConfirm(ctx, () => undefined);
      return;
    }
    startFlagDrag(ev, index);
  }

  /** The current draft's marks, read fresh at interaction time — never a value captured by an earlier render. */
  function freshMarks(): Mark[] {
    const state = ctx.store.get();
    return currentMarks(calendarView(ctx, state));
  }

  /** The primary piece of a (possibly wrap-split) segment carries the label, rename and ×; the wrapped tail is a plain tint. */
  function renderSegmentPiece(container: HTMLElement, seg: Segment, index: number, from: number, to: number, view: CalendarView, marksLength: number, primary: boolean): void {
    const width = Math.max(0, to - from);
    const el = container.createDiv({ cls: "wadjet-studio-seasons-segment", attr: { "data-index": String(index) } });
    el.setCssProps({ "--wadjet-studio-seasons-left": `${from * 100}%`, "--wadjet-studio-seasons-width": `${width * 100}%`, "--wadjet-studio-seasons-tint": tint(index) });
    if (!primary) return;

    const label = el.createSpan({ cls: "wadjet-studio-seasons-segment-label", text: seg.name, attr: { "data-hint": seasonsHint("seasons.rename") } });
    if (!view.readOnly) {
      label.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        openRenameInput(el, label, index);
      });
    }

    if (!view.readOnly) {
      const remove = el.createSpan({ cls: "wadjet-studio-seasons-segment-remove", text: "×", attr: { role: "button", tabindex: "0", "aria-label": `Merge ${seg.name}`, "data-hint": seasonsHint("seasons.merge") } });
      setDisabled(remove, marksLength <= SEASON_LIMITS.min);
      remove.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (remove.hasClass("is-disabled")) return;
        tryMerge(freshMarks(), index);
      });
    }
  }

  function openRenameInput(segEl: HTMLElement, label: HTMLElement, index: number): void {
    if (segEl.find(".wadjet-studio-seasons-segment-input")) return;
    label.addClass("is-hidden");
    const input = segEl.createEl("input", { cls: "wadjet-studio-seasons-segment-input", type: "text", value: label.getText() });
    input.focus();
    input.select();
    const close = (apply: boolean): void => {
      if (apply) tryRename(freshMarks(), index, input.value);
      input.remove();
      label.removeClass("is-hidden");
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        close(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close(false);
      }
    });
    input.addEventListener("blur", () => close(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
  }

  function renderBar(view: CalendarView): void {
    bar.empty();
    daysEl.empty();
    const marks = currentMarks(view);

    if (marks.length === 0) {
      bar.createSpan({ cls: "wadjet-studio-seasons-empty", text: "no seasons yet" });
      return;
    }

    const segs = segments(marks);
    segs.forEach((seg, index) => {
      if (seg.from === seg.to) {
        // Single mark: the whole circle, possibly seamed at phase 0.
        renderSegmentPiece(bar, seg, index, seg.from, 1, view, marks.length, true);
        if (seg.from > 0) renderSegmentPiece(bar, seg, index, 0, seg.from, view, marks.length, false);
      } else if (seg.to > seg.from) {
        // Normal (non-wrapping) segment.
        renderSegmentPiece(bar, seg, index, seg.from, seg.to, view, marks.length, true);
      } else {
        // Wraps past the year boundary: draw the tail at the right edge and
        // the head at the left edge; the label/× live on the (larger) tail.
        renderSegmentPiece(bar, seg, index, seg.from, 1, view, marks.length, true);
        renderSegmentPiece(bar, seg, index, 0, seg.to, view, marks.length, false);
      }
    });

    marks.forEach((m, index) => {
      const flag = bar.createDiv({ cls: "wadjet-studio-seasons-flag", text: "⚑", attr: { role: "button", "data-hint": seasonsHint("seasons.flag"), "aria-label": `${m.name} boundary` } });
      flag.setCssProps({ "--wadjet-studio-seasons-left": `${m.at * 100}%` });
      markDragTarget(flag);
      setDisabled(flag, view.readOnly);
      flag.addEventListener("dblclick", (ev) => ev.stopPropagation());
      flag.addEventListener("pointerdown", (ev) => onFlagPointerDown(ev, index, view));

      const day = daysEl.createSpan({ cls: "wadjet-studio-seasons-day", text: dayLabel(Math.round(m.at * view.yearLength) + 1, view.yearLength), attr: { "data-hint": seasonsHint("seasons.day") } });
      day.setCssProps({ "--wadjet-studio-seasons-left": `${m.at * 100}%` });
    });
  }

  function onBarDblClick(ev: MouseEvent): void {
    const state = ctx.store.get();
    const view = calendarView(ctx, state);
    if (view.readOnly) return;
    const marks = currentMarks(view);
    if (marks.length === 0) return;
    trySplitAt(marks, phaseFromClientX(ev.clientX));
  }

  function onSplitClick(): void {
    if (splitBtn.hasClass("is-disabled")) return;
    const state = ctx.store.get();
    const view = calendarView(ctx, state);
    if (view.readOnly) return;
    trySplitLongest(currentMarks(view));
  }

  bar.addEventListener("dblclick", onBarDblClick);
  splitBtn.addEventListener("click", onSplitClick);
  splitBtn.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    onSplitClick();
  });

  function paint(): void {
    const state = ctx.store.get();
    const view = calendarView(ctx, state);
    const n = Object.keys(state.zones).length;

    sourceChip.update({ label: view.readOnly ? `${view.label} · read-only` : view.label });
    worldChip.update({ label: `world · ${n} zones` });

    renderBar(view);

    const marks = currentMarks(view);
    splitBtn.toggleClass("is-hidden", view.readOnly);
    setDisabled(splitBtn, marks.length === 0 || marks.length >= SEASON_LIMITS.max);

    editLink.toggleClass("is-hidden", !view.readOnly || view.editHint === undefined);
    if (view.editHint !== undefined) editLink.setText(view.editHint);
  }

  const unsubStore = ctx.store.subscribe(() => paint());
  const unsubAdapters = ctx.plugin.api.on("adapters-changed", () => paint());
  paint();

  const build: WindowBuild = {
    title: "Seasons",
    badge: "CALENDAR",
    body,
    led: { on: true, scope: "device" },
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "seasons" }))),
    writes: () => `calendar.seasons ${JSON.stringify(calendarView(ctx, ctx.store.get()).seasons)}`,
    issues: () => {
      const state = ctx.store.get();
      return seasonsIssues(ctx, state, calendarView(ctx, state));
    },
    onClose: () => {
      unsubStore();
      unsubAdapters();
    },
  };
  return build;
};
