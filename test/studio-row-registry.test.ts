/**
 * wadjet-9f9.45 — the playlist's row registry is the LEAF's, not the module's.
 *
 * The defect this pins: `ui/playlist.ts` used to keep one `Map` at module
 * scope, so a row INSTANCE was a singleton. Two studio leaves (a duplicated
 * tab, a popout, a `workspace.json` that lists two) mounted the same row
 * objects twice — the second leaf's `mount` overwrote the host the first
 * leaf's row drew into, and the first leaf spent the rest of its life
 * rendering into orphaned nodes.
 *
 * `model/row-registry.ts` is the pure half, so the isolation is testable
 * without a leaf: `ui/playlist.ts` itself cannot be imported under `bun test`
 * at all (everything it draws with imports `obsidian`, which is typings-only
 * here — see `studio-hints.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { addRow, createRowRegistry, removeRow, sortedRows, type RegisteredRow } from "../src/studio/model/row-registry";

interface FakeRow extends RegisteredRow {
  /** stands in for the row's captured host: which leaf this instance draws into */
  leaf: string;
}

const row = (id: string, order: number, leaf: string): FakeRow => ({ id, order, leaf });

describe("createRowRegistry", () => {
  test("starts empty", () => {
    const reg = createRowRegistry<FakeRow>();
    expect(reg.byId.size).toBe(0);
    expect(sortedRows(reg)).toEqual([]);
  });

  test("two registries hold distinct instances under the same ids", () => {
    const one = createRowRegistry<FakeRow>();
    const two = createRowRegistry<FakeRow>();

    // The same factory, called once per leaf — which is exactly what
    // `createPlaylistSurface().mount()` and `createRowsSurface().mount()` do.
    for (const reg of [one, two]) {
      const leaf = reg === one ? "leaf-1" : "leaf-2";
      addRow(reg, row("temperature", 50, leaf));
      addRow(reg, row("precipitation", 51, leaf));
    }

    expect(one.byId.size).toBe(2);
    expect(two.byId.size).toBe(2);
    expect(one.byId.get("temperature")).not.toBe(two.byId.get("temperature"));
    expect(one.byId.get("temperature")!.leaf).toBe("leaf-1");
    expect(two.byId.get("temperature")!.leaf).toBe("leaf-2");
  });

  test("unregister only affects its own registry", () => {
    const one = createRowRegistry<FakeRow>();
    const two = createRowRegistry<FakeRow>();
    addRow(one, row("device:ashfall", 30, "leaf-1"));
    addRow(two, row("device:ashfall", 30, "leaf-2"));

    removeRow(one, "device:ashfall");

    expect(one.byId.has("device:ashfall")).toBe(false);
    expect(two.byId.has("device:ashfall")).toBe(true);
    expect(two.byId.get("device:ashfall")!.leaf).toBe("leaf-2");
  });

  test("a live listener fires on its own registry only", () => {
    const one = createRowRegistry<FakeRow>();
    const two = createRowRegistry<FakeRow>();
    let syncedOne = 0;
    let syncedTwo = 0;
    one.live.add(() => syncedOne++);
    two.live.add(() => syncedTwo++);

    addRow(one, row("regimes", 10, "leaf-1"));
    expect([syncedOne, syncedTwo]).toEqual([1, 0]);

    removeRow(one, "regimes");
    expect([syncedOne, syncedTwo]).toEqual([2, 0]);

    addRow(two, row("regimes", 10, "leaf-2"));
    expect([syncedOne, syncedTwo]).toEqual([2, 1]);
  });
});

describe("addRow / removeRow", () => {
  test("registering twice under one id replaces the earlier instance (the device manager's re-sort)", () => {
    const reg = createRowRegistry<FakeRow>();
    const first = row("device:ashfall", 30, "leaf-1");
    const second = row("device:ashfall", 31, "leaf-1");
    addRow(reg, first);
    addRow(reg, second);
    expect(reg.byId.size).toBe(1);
    expect(reg.byId.get("device:ashfall")).toBe(second);
  });

  test("an unknown id notifies nobody", () => {
    const reg = createRowRegistry<FakeRow>();
    let synced = 0;
    reg.live.add(() => synced++);
    removeRow(reg, "nope");
    expect(synced).toBe(0);
  });

  test("a listener may register a row of its own while being notified (the device manager's re-entry)", () => {
    const reg = createRowRegistry<FakeRow>();
    let depth = 0;
    let reentered = false;
    reg.live.add(() => {
      depth++;
      if (depth === 1 && !reentered) {
        reentered = true;
        addRow(reg, row("device:ashfall", 30, "leaf-1"));
      }
      depth--;
    });
    addRow(reg, row("regimes", 10, "leaf-1"));
    expect([...reg.byId.keys()].sort()).toEqual(["device:ashfall", "regimes"]);
  });
});

describe("sortedRows", () => {
  test("orders by `order`, then by id", () => {
    const reg = createRowRegistry<FakeRow>();
    addRow(reg, row("sky", 53, "leaf-1"));
    addRow(reg, row("regimes", 10, "leaf-1"));
    addRow(reg, row("device:b", 30, "leaf-1"));
    addRow(reg, row("device:a", 30, "leaf-1"));
    expect(sortedRows(reg).map((r) => r.id)).toEqual(["regimes", "device:a", "device:b", "sky"]);
  });

  test("two registries sort independently", () => {
    const one = createRowRegistry<FakeRow>();
    const two = createRowRegistry<FakeRow>();
    addRow(one, row("regimes", 10, "leaf-1"));
    addRow(two, row("sky", 53, "leaf-2"));
    expect(sortedRows(one).map((r) => r.id)).toEqual(["regimes"]);
    expect(sortedRows(two).map((r) => r.id)).toEqual(["sky"]);
  });
});
