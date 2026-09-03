/**
 * Seasons · CALENDAR window (SPEC §3.4 "Seasons · CALENDAR", PLAN §0.1,
 * bead wadjet-9f9.27).
 *
 * The prototype's shape, top to bottom: a 16 px colour ribbon of the year
 * with a ⚑ handle standing on every movable boundary, the per-season
 * durations under it, then the four-row list — `swatch · name · from dN ·
 * N d · ×` — and `＋ split the longest season` closing it. All the boundary
 * maths — drag, split, split-the-longest, merge, rename — is
 * `model/boundaries.ts`; this file is only the DOM, the pointer wiring and
 * the world-scoped write.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **This is a window body, not a surface.** `WindowManager.renderAll`
 *    only re-reads `writes()`/`issues()`/`level()` (pull-based, SPEC law 5).
 *    Everything else drawn here repaints only because this file subscribes to
 *    the store itself and unsubscribes in `onClose`.
 *  - **Seasons live in `state.world.calendar.seasons` under an *editable*
 *    calendar** (SPEC §2: world scope, `settings.calendar.seasons`, internal
 *    adapter only). Under a describing adapter that reports `readOnly`, the
 *    adapter's own description is the truth to mirror and every edit
 *    affordance is hidden (SPEC §3.4, §8; PLAN §3).
 *  - **The bar is a ribbon, the list is the editor.** The names, the start
 *    days and the × live in the list rows (`.wadjet-studio-seasons-segment`),
 *    never inside the coloured band — that is the prototype's split, and it
 *    is what lets the ribbon stay 16 px tall.
 *  - **Season colour is `SEASON_CYCLE`, not `DATA_CYCLE`.** Gold leads the
 *    data cycle so an *era* band reads as calendar; leading the seasons with
 *    it rotates all four of the shipped names onto the wrong hue.
 *
 * `state.world.calendar.seasons` is kept normalised (ascending `at`, wrapped
 * into [0,1)) by every write this file makes, so `Mark[]` index and
 * `segments()` output index always agree (`boundaries.ts`'s own contract for
 * callers — see its file doc).
 */
import { dayLabel, tabular } from "../../model/format";
import { seasonsHint } from "../../model/hints-seasons";
import { cycleColour, SEASON_CYCLE } from "../../model/palette";
import type { StudioState } from "../../model/state";
import { dragMark, fromSeasons, merge, normalise, rename, SEASON_LIMITS, segments, split, splitLongest, toSeasons, type Mark, type Segment } from "../../model/boundaries";
import { grammar } from "../../model/copy";
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

/** The season's own hue, full strength — the ⚑, the stem and the duration label. */
function seasonColour(index: number): string {
  return cycleColour(index, SEASON_CYCLE);
}

/**
 * A band's fill. The prototype composites the hue at `55` (a third), which is
 * why its ribbon reads as four dark bands rather than four bright blocks —
 * `color-mix(… , transparent)` is the same compositing, over whatever the
 * panel happens to be.
 */
function tint(index: number): string {
  return `color-mix(in srgb, ${seasonColour(index)} 33%, transparent)`;
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
 * The WRITES grammar (SPEC law 5) — the prototype's compact `name@fraction`
 * list, plus the tag the calendar stamps. One line, never JSON.
 */
function seasonsGrammar(view: CalendarView): string {
  const list = normalise(fromSeasons(view.seasons))
    .map((m) => `${m.name}@${tabular(m.at, 2)}`)
    .join(", ");
  return grammar(`calendar.seasons [${list}]`, "tags season:*");
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

  // The source badge belongs in the title bar's right end (SPEC §3.4), which
  // the Window component has no slot for yet — so it is positioned there from
  // this section's CSS. Swap it for a real chrome slot when one lands.
  const sourceChip: ChipComponent = createChip(body, { label: "internal calendar", hint: seasonsHint("seasons.source"), dot: false });
  sourceChip.el.addClass("wadjet-studio-seasons-source");
  sourceChip.el.setAttr("data-part", "source");

  const barWrap = body.createDiv({ cls: "wadjet-studio-seasons-barwrap" });
  const bar = barWrap.createDiv({ cls: "wadjet-studio-seasons-bar", attr: { "data-hint": seasonsHint("seasons.bar") } });
  markDragTarget(bar);
  const flagsEl = barWrap.createDiv({ cls: "wadjet-studio-seasons-flags" });
  const daysEl = body.createDiv({ cls: "wadjet-studio-seasons-durations" });

  // Small-caps head, lower-case tail — the tail is the only statement of the
  // season → tag relationship anywhere in the studio.
  const caption = body.createDiv({ cls: "wadjet-studio-seasons-caption", attr: { "data-hint": seasonsHint("seasons.world") } });
  caption.createSpan({ cls: "wadjet-studio-seasons-caption-text", text: "Seasons" });
  caption.createSpan({ cls: "wadjet-studio-seasons-caption-tail", text: "· each stamps tag season:name" });

  const list = body.createDiv({ cls: "wadjet-studio-seasons-list" });
  const rowsEl = list.createDiv({ cls: "wadjet-studio-seasons-rows" });
  const splitBtn = list.createDiv({
    cls: "wadjet-studio-seasons-split",
    text: "＋ split the longest season",
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

  /** One coloured piece of the ribbon. A season that wraps past the year boundary draws two. */
  function renderBand(index: number, from: number, to: number): void {
    const band = bar.createDiv({ cls: "wadjet-studio-seasons-band" });
    band.setCssProps({
      "--wadjet-studio-seasons-left": `${from * 100}%`,
      "--wadjet-studio-seasons-width": `${Math.max(0, to - from) * 100}%`,
      "--wadjet-studio-seasons-tint": tint(index),
    });
  }

  function renderRibbon(segs: Segment[]): void {
    bar.empty();
    segs.forEach((seg, index) => {
      if (seg.from === seg.to) {
        // Single mark: the whole circle, possibly seamed at phase 0.
        renderBand(index, seg.from, 1);
        if (seg.from > 0) renderBand(index, 0, seg.from);
      } else if (seg.to > seg.from) {
        renderBand(index, seg.from, seg.to);
      } else {
        // Wraps past the year boundary: a tail at the right edge, a head at the left.
        renderBand(index, seg.from, 1);
        renderBand(index, 0, seg.to);
      }
    });
  }

  /**
   * A ⚑ on every boundary that can actually move. A mark sitting exactly on
   * phase 0 is the ribbon's left edge — the prototype draws no handle there,
   * and dragging it would only ever push it right off its own year start.
   */
  function renderFlags(view: CalendarView, marks: Mark[]): void {
    flagsEl.empty();
    marks.forEach((m, index) => {
      if (m.at === 0) return;
      const flag = flagsEl.createDiv({ cls: "wadjet-studio-seasons-flag", attr: { role: "button", "data-hint": seasonsHint("seasons.flag"), "aria-label": `${m.name} boundary` } });
      flag.setCssProps({ "--wadjet-studio-seasons-left": `${m.at * 100}%`, "--wadjet-studio-seasons-colour": seasonColour(index) });
      flag.createSpan({ cls: "wadjet-studio-seasons-flag-glyph", text: "⚑" });
      flag.createDiv({ cls: "wadjet-studio-seasons-flag-stem" });
      markDragTarget(flag);
      setDisabled(flag, view.readOnly);
      flag.addEventListener("dblclick", (ev) => ev.stopPropagation());
      flag.addEventListener("pointerdown", (ev) => onFlagPointerDown(ev, index, view));
    });
  }

  /** `Thaw 73d` under each band, the name in the season's own colour. */
  function renderDurations(view: CalendarView, segs: Segment[]): void {
    daysEl.empty();
    segs.forEach((seg, index) => {
      const cell = daysEl.createDiv({ cls: "wadjet-studio-seasons-duration", text: `${seg.name} ` });
      cell.setCssProps({ "--wadjet-studio-seasons-width": `${seg.length * 100}%`, "--wadjet-studio-seasons-colour": seasonColour(index) });
      cell.createSpan({ cls: "wadjet-studio-seasons-duration-days", text: `${tabular(Math.round(seg.length * view.yearLength), 0)}d` });
    });
  }

  /** `▪ Thaw …… from d0   73 d   ×` — the row that owns the name, the rename and the merge. */
  function renderRows(view: CalendarView, marks: Mark[], segs: Segment[]): void {
    rowsEl.empty();
    marks.forEach((m, index) => {
      const seg = segs[index];
      const row = rowsEl.createDiv({ cls: "wadjet-studio-seasons-segment", attr: { "data-index": String(index) } });
      const swatch = row.createDiv({ cls: "wadjet-studio-seasons-swatch", attr: { role: "img", "aria-label": `${m.name} colour` } });
      swatch.setCssProps({ "--wadjet-studio-seasons-colour": seasonColour(index) });

      const label = row.createSpan({ cls: "wadjet-studio-seasons-segment-label", text: m.name, attr: { "data-hint": seasonsHint("seasons.rename") } });
      if (!view.readOnly) {
        label.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          openRenameInput(row, label, index);
        });
      }

      // No `+ 1`: the prototype's season row is `fromDay: Math.round(sn.from *
      // 365)`, 0-based, and so is `dayLabel` (bead wadjet-9f9.48.2). The row now
      // agrees with the ruler underneath it and with this window's own WRITES
      // line, which have always counted from d0.
      row.createSpan({ cls: "wadjet-studio-seasons-from", text: `from ${dayLabel(Math.round(m.at * view.yearLength), view.yearLength)}`, attr: { "data-hint": seasonsHint("seasons.day") } });
      row.createSpan({ cls: "wadjet-studio-seasons-days", text: `${tabular(Math.round((seg?.length ?? 0) * view.yearLength), 0)} d` });

      if (!view.readOnly) {
        const remove = row.createSpan({ cls: "wadjet-studio-seasons-segment-remove", text: "×", attr: { role: "button", tabindex: "0", "aria-label": `Merge ${m.name}`, "data-hint": seasonsHint("seasons.merge") } });
        setDisabled(remove, marks.length <= SEASON_LIMITS.min);
        remove.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (remove.hasClass("is-disabled")) return;
          tryMerge(freshMarks(), index);
        });
      }
    });
  }

  function openRenameInput(rowEl: HTMLElement, label: HTMLElement, index: number): void {
    if (rowEl.find(".wadjet-studio-seasons-segment-input")) return;
    label.addClass("is-hidden");
    const input = rowEl.createEl("input", { cls: "wadjet-studio-seasons-segment-input", type: "text", value: label.getText() });
    input.focus();
    input.select();
    // Enter closes the field, and taking the focus off it fires the blur
    // handler below — so `close` has to be idempotent (the CYCLE and STATES
    // renames already are) or the rename is applied twice and the second
    // `input.remove()` throws on a node that has already gone.
    let closed = false;
    const close = (apply: boolean): void => {
      if (closed) return;
      closed = true;
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
    const marks = currentMarks(view);
    if (marks.length === 0) {
      bar.empty();
      flagsEl.empty();
      daysEl.empty();
      rowsEl.empty();
      bar.createSpan({ cls: "wadjet-studio-seasons-empty", text: "no seasons yet" });
      return;
    }
    const segs = segments(marks);
    renderRibbon(segs);
    renderFlags(view, marks);
    renderDurations(view, segs);
    renderRows(view, marks, segs);
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

    sourceChip.update({ label: view.readOnly ? `${view.label} · read-only` : view.label });

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
    // Prototype width (`proto-markup/`): a design constant, not a function of the content.
    width: 380,
    badge: "CALENDAR",
    badgeColor: "var(--wadjet-studio-gold)",
    body,
    led: { on: true, scope: "device" },
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "seasons" }))),
    writes: () => seasonsGrammar(calendarView(ctx, ctx.store.get())),
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
