/**
 * The rows surface — the one place `view.ts` learns that the playlist's data
 * rows exist.
 *
 * `playlist.ts` mounts whatever `registerRow` has been handed and does not
 * care who handed it over (see its "row API" block). Registration has to
 * happen *somewhere*, though, and a bare `import "./rows/regimes-row"` for its
 * side effect is exactly the kind of import a bundler is entitled to drop.
 * So each row bead's factory is listed here, this surface registers them at
 * `mount`, and `view.ts` grows one line in `SURFACES` instead of one line per
 * row.
 *
 * **Adding a row:** import your `create<X>Row` and append one entry to `ROWS`.
 * Nothing else in this file changes. Order in the playlist comes from the
 * row's own `order` (`ROW_ORDER`), never from this list.
 *
 * The surface owns no DOM of its own: `registerRow` mounts a row into the
 * playlist immediately when the playlist is already live (late registration is
 * part of the row API), and the playlist tears every row down with the leaf.
 */
import { registerRow, type PlaylistRow } from "./playlist";
import { createAutomationRow } from "./rows/automation-row";
import { createDeviceRowsManager } from "./rows/device-rows";
import { createErasRow } from "./rows/eras-row";
import { createRegimesRow } from "./rows/regimes-row";
import type { Surface, SurfaceContext } from "./surfaces";

/**
 * Every playlist row, one FACTORY per bead. Append; do not reorder (order
 * lives on the row). Factories, not instances: each leaf calls them once at
 * `mount`, so two studio leaves hold two sets of rows (bead wadjet-9f9.45).
 */
export const ROWS: ReadonlyArray<() => PlaylistRow> = [createRegimesRow, createErasRow, createDeviceRowsManager, createAutomationRow];

export function createRowsSurface(): Surface {
  return {
    mount(ctx: SurfaceContext) {
      for (const row of ROWS) registerRow(ctx, row());
    },

    render() {
      // Rows render themselves: the playlist calls each row's `render` once per
      // tick with the measured geometry. This surface has nothing to repaint.
    },

    destroy() {
      // The registry belongs to the leaf (`ctx.rows`, bead wadjet-9f9.45) and
      // goes away with it, so there is nothing to unregister;
      // `createPlaylistSurface().destroy()` is what takes the mounted rows
      // down with the view.
    },
  };
}
