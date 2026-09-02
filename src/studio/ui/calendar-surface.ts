/**
 * The calendar surface — a registrar, not a region (mirrors `moons-surface.ts`).
 *
 * Seasons are a world source (SPEC §5: "Moons, eras, seasons are the same
 * idea at world level — *sources*, not devices"), so this surface owns no
 * part of the shell. All it does is make the Seasons · CALENDAR window
 * (`windows/seasons.ts`) openable by id — from the ruler's `Calendar ⚑`
 * label (`ctx.windows.open("seasons")`) and from `windows.restore()` on a
 * leaf that remembered it open.
 *
 * The Sable · CYCLE window (SPEC §3.4) is *not* registered here: it is
 * per-moon (`windows/cycle.ts`'s `buildCycleWindow(moonName)`), and
 * `moons-surface.ts` already owns registering one panel per moon via
 * `registerCycleWindows`. Registering it a second time here would just
 * overwrite the same builder map entry every tick for no gain, so this
 * surface stays Seasons-only.
 */
import { buildSeasonsWindow, SEASONS_WINDOW } from "./windows/seasons";
import type { Surface, SurfaceContext } from "./surfaces";

export function createCalendarSurface(): Surface {
  return {
    mount(ctx: SurfaceContext) {
      ctx.windows.register(SEASONS_WINDOW, buildSeasonsWindow);
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
