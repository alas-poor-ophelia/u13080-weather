/**
 * The playlist's row registry — one per studio leaf (bead wadjet-9f9.45).
 *
 * The row API (`ui/playlist.ts`) used to keep its registry at module scope,
 * which made a row INSTANCE a singleton: two studio leaves (a duplicated tab,
 * a popout, a `workspace.json` that lists two) mounted the *same* row objects
 * twice, so the second leaf's `mount` overwrote the host the first leaf's row
 * was drawing into and the first leaf rendered into orphaned nodes for the
 * rest of its life.
 *
 * The fix is this file: row FACTORIES stay module-level (they are code), row
 * INSTANCES live in a registry the leaf owns and hands to its surfaces through
 * `SurfaceContext.rows`. Two leaves therefore hold two registries, holding two
 * sets of instances, each pointed at its own DOM.
 *
 * The registry is deliberately generic over `{ id, order }` and knows nothing
 * about the playlist, so it is pure (PLAN D3: no Obsidian imports) and
 * unit-testable without a leaf — `ui/playlist.ts` cannot be imported under
 * `bun test` at all, since everything it draws with imports `obsidian`.
 */

/** The minimum a registry entry carries: an identity and a sort position. */
export interface RegisteredRow {
  id: string;
  order: number;
}

/**
 * One leaf's rows. `byId` is the registry proper; `live` is the set of
 * "something changed" callbacks a mounted surface adds, so a row registered
 * after the surface came up is mounted immediately rather than at the next
 * store tick.
 */
export interface RowRegistry<R extends RegisteredRow = RegisteredRow> {
  byId: Map<string, R>;
  live: Set<() => void>;
}

export function createRowRegistry<R extends RegisteredRow = RegisteredRow>(): RowRegistry<R> {
  return { byId: new Map<string, R>(), live: new Set<() => void>() };
}

/**
 * Register (or replace) a row under its own id, then notify every live
 * listener. Idempotent per `id`: registering a second object under an id the
 * registry already holds replaces the first, which is how the device manager
 * re-sorts its lanes without rebuilding them.
 */
export function addRow<R extends RegisteredRow>(registry: RowRegistry<R>, row: R): void {
  registry.byId.set(row.id, row);
  // A copy, because a listener is allowed to register or retire a row of its
  // own (the device manager does exactly that) while it is being notified.
  for (const notify of [...registry.live]) notify();
}

/** Retire a row. Unknown ids are ignored and notify nobody. */
export function removeRow<R extends RegisteredRow>(registry: RowRegistry<R>, id: string): void {
  if (!registry.byId.delete(id)) return;
  for (const notify of [...registry.live]) notify();
}

/** Every registered row, in `order` then `id` order. */
export function sortedRows<R extends RegisteredRow>(registry: RowRegistry<R>): R[] {
  return [...registry.byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
