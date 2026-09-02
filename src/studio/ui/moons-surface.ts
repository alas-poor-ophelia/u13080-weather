/**
 * The moons surface — a registrar, not a region.
 *
 * Moons are world sources (SPEC §5: "Moons, eras, seasons are the same idea at
 * world level — *sources*, not devices"), so they own no part of the shell.
 * What they need is a builder registered per moon, before `windows.restore()`
 * runs, so a `cycle:<moon>` panel the leaf remembered comes back and a moon
 * chip anywhere in the studio can `openCycleFor` by name.
 *
 * `render` re-registers because the set of moons is itself editable: a moon
 * added or renamed in settings (or by an adapter registering) has to become
 * openable without rebuilding the leaf. Registration is a map write per moon —
 * cheap enough for a per-tick call.
 */
import { registerCycleWindows } from "./windows/cycle";
import type { Surface, SurfaceContext } from "./surfaces";

export function createMoonsSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  return {
    mount(next) {
      ctx = next;
      registerCycleWindows(next);
    },

    render() {
      if (ctx !== null) registerCycleWindows(ctx);
    },

    destroy() {
      ctx = null;
    },
  };
}
