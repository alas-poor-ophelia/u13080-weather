/**
 * The atlas surface — a registrar, not a region (the same shape
 * `eras-surface.ts` uses for `era:*` panels).
 *
 * The Atlas owns no part of the shell: it is reached from the header's SRC
 * chip, which stands for the station the zone was copied from (SPEC law 2).
 * This surface is the ONLY thing that registers a builder under `atlas`
 * (bead wadjet-9f9.45 deleted the header's placeholder registration, which
 * only ever lost the id by mount order — one reordering of `SURFACES` away
 * from the SRC chip opening an empty panel).
 *
 * `test/studio-surfaces.test.ts` holds `view.ts`'s `SURFACES` to listing this
 * surface, so the chip can never be live with nobody behind it. Registration
 * runs before `windows.restore()`, so an Atlas panel the leaf remembered comes
 * back as the real window.
 */
import { ATLAS_WINDOW, buildAtlasWindow } from "./windows/atlas";
import type { Surface, SurfaceContext } from "./surfaces";

export function createAtlasSurface(): Surface {
  return {
    mount(ctx: SurfaceContext) {
      ctx.windows.register(ATLAS_WINDOW, buildAtlasWindow);
    },

    render() {
      // Nothing per tick: the panel repaints from its own store subscription.
    },

    destroy() {
      // The window manager tears its own panels down (`WindowManager.destroy`).
    },
  };
}
