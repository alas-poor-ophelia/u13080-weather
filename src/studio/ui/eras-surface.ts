/**
 * The eras surface — a registrar, not a region.
 *
 * Eras are a world source (SPEC §5: "Moons, eras, seasons are the same idea
 * at world level — *sources*, not devices"), so this surface owns no part of
 * the shell. What it needs is a builder registered per era, before
 * `windows.restore()` runs, so an `era:<name>` panel the leaf remembered
 * comes back and an eras-lane clip or a mixer era unit can `open` one by
 * name (SPEC law 2 — relational access).
 *
 * `render` re-registers because the set of eras is itself editable: an era
 * added, renamed or removed by this very window (or, later, the eras lane)
 * has to become openable — or stop being one — without rebuilding the leaf.
 * Registration is a map write per era — cheap enough for a per-tick call, and
 * the same pattern `moons-surface.ts` uses for `cycle:*` windows.
 */
import { registerEraWindows } from "./windows/era";
import type { Surface, SurfaceContext } from "./surfaces";

export function createErasSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  return {
    mount(next) {
      ctx = next;
      registerEraWindows(next);
    },

    render() {
      if (ctx !== null) registerEraWindows(ctx);
    },

    destroy() {
      ctx = null;
    },
  };
}
