import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import type { Preset, ZoneProfile } from "../src/core/types";
import { defaultView, initialState, type StudioSettingsLike, type StudioState } from "../src/studio/model/state";
import { createStore, MAX_HISTORY, type Store } from "../src/studio/model/store";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(id: string, name: string): ZoneProfile {
  return { id, name, schemaVersion: 1, climate: structuredClone(fjord.climate), regimes: structuredClone(fjord.regimes), modifiers: [] };
}

function settings(): StudioSettingsLike {
  return {
    zones: [zone("greywold", "Greywold"), zone("saltmarsh", "Saltmarsh")],
    eras: [{ name: "Long Winter", from: 100, to: 200 }],
    calendar: {
      seasons: [
        { name: "winter", from: 0 },
        { name: "summer", from: 0.5 },
      ],
      moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }],
    },
    devicePresets: [],
    overrides: [],
  };
}

/** A store whose scheduler collects flush callbacks, so batching is assertable. */
function harness(zoneId: string | null = "greywold"): { store: Store; q: Array<() => void>; flush: () => void } {
  const q: Array<() => void> = [];
  const store = createStore(initialState(settings(), zoneId), (f) => {
    q.push(f);
  });
  return {
    store,
    q,
    flush: () => {
      for (const f of q.splice(0)) f();
    },
  };
}

const greywold = (s: StudioState): ZoneProfile => s.zones.greywold!;
const weight = (s: StudioState): number => greywold(s).regimes[0]!.weight;

describe("initialState", () => {
  test("deep-copies into both the drafts and saved; mutating a draft touches neither", () => {
    const input = settings();
    const st = initialState(input, "greywold");

    st.zones.greywold!.name = "Greywold (edited)";
    st.zones.greywold!.regimes[0]!.weight = 999;
    st.world.eras[0]!.from = -1;
    st.world.calendar.seasons[0]!.name = "wintre";

    expect(st.saved.zones.greywold!.name).toBe("Greywold");
    expect(st.saved.zones.greywold!.regimes[0]!.weight).toBe(input.zones[0]!.regimes[0]!.weight);
    expect(st.saved.world.eras[0]!.from).toBe(100);
    expect(st.saved.world.calendar.seasons[0]!.name).toBe("winter");
    // and the caller's settings object is untouched
    expect(input.zones[0]!.name).toBe("Greywold");
    expect(input.eras[0]!.from).toBe(100);
    expect(input.calendar.seasons[0]!.name).toBe("winter");
  });

  test("drafts are keyed by zone id; the view opens on a real zone or on none", () => {
    const st = initialState(settings(), "saltmarsh");
    expect(Object.keys(st.zones).sort()).toEqual(["greywold", "saltmarsh"]);
    expect(st.view.zoneId).toBe("saltmarsh");
    expect(initialState(settings(), "no-such-zone").view.zoneId).toBeNull();
    expect(initialState(settings(), null).view.zoneId).toBeNull();
    expect(st.view).toEqual({ ...defaultView("saltmarsh") });
  });

  test("devicePresets default to an empty list when settings predate them", () => {
    const s = settings();
    delete s.devicePresets;
    expect(initialState(s, null).world.devicePresets).toEqual([]);
  });

  test("regimePresets default to an empty list when settings predate them", () => {
    const s = settings();
    delete s.regimePresets;
    expect(initialState(s, null).world.regimePresets).toEqual([]);
  });
});

describe("subscribe (batched)", () => {
  test("two updates in one tick produce one notification", () => {
    const { store, q, flush } = harness();
    let calls = 0;
    const seen: StudioState[] = [];
    store.subscribe((s) => {
      calls++;
      seen.push(s);
    });

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 5;
    });
    store.update((d) => {
      d.view.jsonOpen = true;
    });

    expect(calls).toBe(0);
    expect(q.length).toBe(1); // one flush scheduled, not two
    flush();
    expect(calls).toBe(1);
    expect(seen[0]).toBe(store.get());

    // the next tick schedules again
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 6;
    });
    expect(q.length).toBe(1);
    flush();
    expect(calls).toBe(2);
  });

  test("a flush callback run twice notifies once", () => {
    const { store, q } = harness();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 5;
    });
    const f = q[0]!;
    f();
    f();
    expect(calls).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    const { store, flush } = harness();
    let calls = 0;
    const off = store.subscribe(() => {
      calls++;
    });
    off();
    store.update((d) => {
      d.view.jsonOpen = true;
    });
    flush();
    expect(calls).toBe(0);
  });
});

describe("dirty tracking", () => {
  test("dirtyZones flips only on an effective change", () => {
    const { store } = harness();
    const w0 = weight(store.get());

    expect(store.dirtyZones().size).toBe(0);
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = w0 + 3;
    });
    expect([...store.dirtyZones()]).toEqual(["greywold"]);

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = w0;
    });
    expect(store.dirtyZones().size).toBe(0);
  });

  test("the comparison is canonical: re-keying a draft is not a change", () => {
    const { store } = harness();
    store.update((d) => {
      const z = greywold(d);
      d.zones.greywold = { modifiers: z.modifiers, regimes: z.regimes, climate: z.climate, schemaVersion: 1, name: z.name, id: z.id };
    });
    expect(canonicalJson(store.get().zones.greywold)).toBe(canonicalJson(store.get().saved.zones.greywold));
    expect(store.dirtyZones().size).toBe(0);
  });

  test("an added or removed zone is dirty", () => {
    const { store } = harness();
    store.update((d) => {
      delete d.zones.saltmarsh;
      d.zones.fen = zone("fen", "Fen");
    });
    expect([...store.dirtyZones()].sort()).toEqual(["fen", "saltmarsh"]);
  });

  test("worldDirty follows an era edit and nothing else", () => {
    const { store } = harness();
    expect(store.worldDirty()).toBe(false);

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 42;
      d.view.jsonOpen = true;
    });
    expect(store.worldDirty()).toBe(false);

    store.update((d) => {
      d.world.eras[0]!.to = 250;
    });
    expect(store.worldDirty()).toBe(true);
    store.update((d) => {
      d.world.eras[0]!.to = 200;
    });
    expect(store.worldDirty()).toBe(false);
  });

  test("markSaved clears dirty, notifies, and keeps the undo history", () => {
    const { store, flush } = harness();
    let calls = 0;
    store.subscribe(() => {
      calls++;
    });

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 42;
      d.world.eras[0]!.name = "Ashfall";
    });
    store.snapshot();
    expect(store.dirtyZones().has("greywold")).toBe(true);
    expect(store.worldDirty()).toBe(true);

    store.markSaved();
    flush();
    expect(calls).toBe(1);
    expect(store.dirtyZones().size).toBe(0);
    expect(store.worldDirty()).toBe(false);
    expect(store.canUndo()).toBe(true);

    // undoing past the save re-dirties against the new saved copy
    store.undo();
    expect(store.dirtyZones().has("greywold")).toBe(true);
  });
});

describe("setZone", () => {
  test("switching zones keeps both drafts", () => {
    const { store } = harness();
    store.update((d) => {
      d.zones.greywold!.name = "Greywold II";
    });
    store.setZone("saltmarsh");
    expect(store.get().view.zoneId).toBe("saltmarsh");
    store.update((d) => {
      d.zones.saltmarsh!.name = "Saltmarsh II";
    });
    store.setZone("greywold");

    expect(store.get().zones.greywold!.name).toBe("Greywold II");
    expect(store.get().zones.saltmarsh!.name).toBe("Saltmarsh II");
    expect(store.dirtyZones()).toEqual(new Set(["greywold", "saltmarsh"]));
  });

  test("setting the zone already in view does not notify", () => {
    const { store, q } = harness();
    store.setZone("greywold");
    expect(q.length).toBe(0);
    store.setZone("saltmarsh");
    expect(q.length).toBe(1);
  });
});

describe("undo / redo", () => {
  test("one drag is one step: many updates, one snapshot at pointer-up", () => {
    const { store } = harness();
    const p0 = greywold(store.get()).climate.temperature.persistence;

    for (let i = 1; i <= 10; i++) {
      store.update((d) => {
        greywold(d).climate.temperature.persistence = 0.5 + i / 100;
      });
    }
    expect(store.canUndo()).toBe(false); // nothing committed mid-drag
    store.snapshot();
    expect(store.canUndo()).toBe(true);

    expect(store.undo()).toBe(true);
    expect(greywold(store.get()).climate.temperature.persistence).toBe(p0);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);

    expect(store.redo()).toBe(true);
    expect(greywold(store.get()).climate.temperature.persistence).toBeCloseTo(0.6, 9);
    expect(store.canRedo()).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
  });

  test("a snapshot with nothing changed is skipped", () => {
    const { store } = harness();
    store.snapshot();
    store.snapshot();
    expect(store.canUndo()).toBe(false);

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 7;
    });
    store.snapshot();
    store.snapshot(); // no change since the last one
    store.update((d) => {
      d.view.jsonOpen = true; // view state is not part of the drafts
    });
    store.snapshot();

    expect(store.undo()).toBe(true);
    expect(store.canUndo()).toBe(false); // exactly one step was recorded
  });

  test("a new snapshot discards the redo branch", () => {
    const { store } = harness();
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 1;
    });
    store.snapshot();
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 2;
    });
    store.snapshot();

    store.undo();
    expect(weight(store.get())).toBe(1);
    expect(store.canRedo()).toBe(true);

    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 3;
    });
    store.snapshot();
    expect(store.canRedo()).toBe(false);
    expect(store.redo()).toBe(false);
    store.undo();
    expect(weight(store.get())).toBe(1);
  });

  test("update with history snapshots the pre-change drafts and skips no-ops", () => {
    const { store } = harness();
    store.update(
      (d) => {
        d.view.jsonOpen = true;
      },
      { history: true },
    );
    expect(store.canUndo()).toBe(false); // drafts unchanged → no step

    store.update(
      (d) => {
        d.world.eras.push({ name: "Ashfall", from: 300 });
      },
      { history: true },
    );
    expect(store.canUndo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.get().world.eras.map((e) => e.name)).toEqual(["Long Winter"]);
    expect(store.redo()).toBe(true);
    expect(store.get().world.eras.map((e) => e.name)).toEqual(["Long Winter", "Ashfall"]);
  });

  test("an uncommitted drag is committed by the next history update", () => {
    const { store } = harness();
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 11;
    });
    store.update(
      (d) => {
        d.world.eras[0]!.from = 5;
      },
      { history: true },
    );
    store.undo();
    expect(store.get().world.eras[0]!.from).toBe(100);
    expect(weight(store.get())).toBe(11); // the drag survives as its own step
    store.undo();
    expect(weight(store.get())).not.toBe(11);
  });

  test(`history is bounded at ${String(MAX_HISTORY)} steps`, () => {
    const { store } = harness();
    const extra = 5;
    for (let i = 1; i <= MAX_HISTORY + extra; i++) {
      store.update((d) => {
        d.zones.greywold!.regimes[0]!.weight = i;
      });
      store.snapshot();
    }
    let steps = 0;
    while (store.undo()) steps++;
    expect(steps).toBe(MAX_HISTORY);
    expect(weight(store.get())).toBe(extra); // the oldest steps fell off the bottom
  });

  test("undo and redo notify, batched like any other change", () => {
    const { store, q, flush } = harness();
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 9;
    });
    store.snapshot();
    flush();

    let calls = 0;
    store.subscribe(() => {
      calls++;
    });
    store.undo();
    store.redo();
    expect(q.length).toBe(1);
    flush();
    expect(calls).toBe(1);

    // a refused undo notifies nobody
    q.length = 0;
    while (store.undo()) {
      /* drain */
    }
    flush();
    expect(store.undo()).toBe(false);
    expect(q.length).toBe(0);
  });

  test("undo leaves view state alone", () => {
    const { store } = harness();
    store.update((d) => {
      d.world.eras[0]!.name = "Ashfall";
    });
    store.snapshot();
    store.update((d) => {
      d.view.jsonOpen = true;
      d.view.window = { a: 3, b: 9 };
      d.view.openWindows.push("era:Ashfall");
      d.view.windowPos["era:Ashfall"] = { x: 10, y: 20, z: 1 };
      d.view.rerollSalt = 4;
      d.view.colours.eras = [2];
    });

    store.undo();
    expect(store.get().world.eras[0]!.name).toBe("Long Winter");
    expect(store.get().view).toEqual({
      zoneId: "greywold",
      window: { a: 3, b: 9 },
      openWindows: ["era:Ashfall"],
      windowPos: { "era:Ashfall": { x: 10, y: 20, z: 1 } },
      colours: { seasons: [], eras: [2], regimes: [] },
      jsonOpen: true,
      fixedOpen: {},
      rerollSalt: 4,
    });
  });

  test("restored drafts are copies: the history is never aliased to the live state", () => {
    const { store } = harness();
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 1;
    });
    store.snapshot();
    store.undo();
    const w0 = weight(store.get());

    // mutate the live state in place; the entry that was just restored must not move with it
    store.update((d) => {
      d.zones.greywold!.regimes[0]!.weight = 77;
    });
    store.snapshot();
    store.undo();
    expect(weight(store.get())).toBe(w0);

    // the redo branch kept the uncommitted-then-committed value, not a shared reference
    store.redo();
    expect(weight(store.get())).toBe(77);
  });
});
