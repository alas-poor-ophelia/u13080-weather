/**
 * The calendar's two views (docs/SESHAT-v0.md §18.3 D9, §18.6 item 8): the
 * Orrery (window `orrery`) and the plain-language form (window `calendar`).
 * Both are about the one calendar the world runs, so each carries the same
 * Orrery | Form toggle in its title bar's head slot.
 *
 * - The two stay two window ids. `windows.open("calendar")` and
 *   `openCalendarWindow(ctx, tab)` open the form, as they always have; this
 *   module only wraps the two builders and adds the way between them.
 * - Switching closes one view and opens the other where it stood: the
 *   closing window's stored position is copied to the other id first, so the
 *   manager's "a remembered position wins" rule places it (and its reclamp
 *   keeps a 1200 px Orrery inside a narrow box).
 * - The chosen view is remembered per Studio view (`view.calendarMode`,
 *   persisted with the leaf). The ruler's Calendar ⚑ opens it; absent, the
 *   Orrery.
 */
import { calendarHint } from "../../model/hints-calendar";
import { createSegmented } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuilder } from "../windows";
import { CALENDAR_WINDOW, openCalendarWindow, type CalendarTab } from "./calendar";
import { ORRERY_WINDOW } from "./orrery";

export type CalendarMode = "orrery" | "form";

const WINDOW_OF: Readonly<Record<CalendarMode, string>> = { orrery: ORRERY_WINDOW, form: CALENDAR_WINDOW };

/** The form's tab when the toggle brings it up: the year, the first part after Seasons (the form falls back to its Calendar tab off a definition). */
export const FORM_TAB_FROM_ORRERY: CalendarTab = "year";

/** The view the ruler's ⚑ opens: the last one chosen with the toggle, else the Orrery. */
export function calendarMode(ctx: SurfaceContext): CalendarMode {
  return ctx.store.get().view.calendarMode ?? "orrery";
}

/** The ruler's Calendar ⚑: the remembered view. The form opens on Seasons, as it has from the ruler since 2026-10-21. */
export function openCalendarView(ctx: SurfaceContext): void {
  if (calendarMode(ctx) === "form") openCalendarWindow(ctx, "seasons");
  else ctx.windows.open(ORRERY_WINDOW);
}

/** Swap to `to`: remember it, close the other view, and open this one where the other stood. */
export function switchCalendarMode(ctx: SurfaceContext, to: CalendarMode): void {
  const fromId = WINDOW_OF[to === "orrery" ? "form" : "orrery"];
  const toId = WINDOW_OF[to];
  const at = ctx.store.get().view.windowPos[fromId];
  ctx.store.update((s) => {
    s.view.calendarMode = to;
    if (at !== undefined) s.view.windowPos[toId] = { ...at };
  });
  // both may be open (one opened by id): the target reopens at the spot rather than staying put
  ctx.windows.close(toId);
  ctx.windows.close(fromId);
  if (to === "form") openCalendarWindow(ctx, FORM_TAB_FROM_ORRERY);
  else ctx.windows.open(toId);
}

/** `build` with the Orrery | Form toggle first in its head slot, showing `mode`. */
export function withModeToggle(mode: CalendarMode, build: WindowBuilder): WindowBuilder {
  return (ctx) => {
    const built = build(ctx);
    const toggle = createSegmented(createDiv(), {
      options: [
        { value: "orrery", label: "Orrery" },
        { value: "form", label: "Form" },
      ],
      value: mode,
      onChange: (v) => switchCalendarMode(ctx, v as CalendarMode),
    });
    toggle.el.addClass("wadjet-studio-calendar-mode");
    toggle.el.setAttrs({ "aria-label": "Calendar view", "data-hint": calendarHint("calendar.mode") });
    // a press on the toggle is a choice, not the start of a title-bar drag
    const keep = (ev: PointerEvent): void => ev.stopPropagation();
    toggle.el.addEventListener("pointerdown", keep);
    const head = built.head;
    const onClose = built.onClose;
    return {
      ...built,
      head: (slot) => {
        slot.appendChild(toggle.el);
        head?.(slot);
      },
      onClose: () => {
        toggle.el.removeEventListener("pointerdown", keep);
        toggle.destroy();
        onClose?.();
      },
    };
  };
}
