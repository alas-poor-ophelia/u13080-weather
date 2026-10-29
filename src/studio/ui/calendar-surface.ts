/**
 * The calendar surface — a registrar, not a region (mirrors `moons-surface.ts`).
 *
 * Seasons are a world source (SPEC §5: "Moons, eras, seasons are the same
 * idea at world level — *sources*, not devices"), so this surface owns no
 * part of the shell. All it does is make the calendar's two views openable
 * by id: the Calendar form (`windows/calendar.ts`, the Seasons editor its
 * first tab) and the Orrery (`windows/orrery.ts`), from the ruler's
 * `Calendar ⚑` label (`openCalendarView`, `windows/calendar-mode.ts`) and from
 * `windows.restore()` on a leaf that remembered one open.
 *
 * The Sable · CYCLE window (SPEC §3.4) is *not* registered here: it is
 * per-moon (`windows/cycle.ts`'s `buildCycleWindow(moonName)`), and
 * `moons-surface.ts` already owns registering one panel per moon via
 * `registerCycleWindows`. Registering it a second time here would just
 * overwrite the same builder map entry every tick for no gain, so this
 * surface stays Seasons-only.
 */
import { buildCalendarWindow, CALENDAR_WINDOW } from "./windows/calendar";
import { withModeToggle } from "./windows/calendar-mode";
import { buildOrreryWindow, ORRERY_WINDOW } from "./windows/orrery";
import type { Surface, SurfaceContext } from "./surfaces";

export function createCalendarSurface(): Surface {
  return {
    mount(ctx: SurfaceContext) {
      // the calendar's two views (docs/SESHAT-v0.md §18.3 D9), each with the Orrery | Form toggle:
      // the form, whose first tab is the Seasons editor (ruled 2026-10-21), and the calendar drawn
      // as a machine (§18), read-only for now
      ctx.windows.register(CALENDAR_WINDOW, withModeToggle("form", buildCalendarWindow));
      ctx.windows.register(ORRERY_WINDOW, withModeToggle("orrery", buildOrreryWindow));
    },

    render() {
      // Registration only; the window's own body repaints itself (see
      // `windows/seasons.ts`'s file doc) and `renderAll` covers writes/issues.
    },

    destroy() {
      // Nothing owned here to tear down — the manager drops builders itself.
    },
  };
}
