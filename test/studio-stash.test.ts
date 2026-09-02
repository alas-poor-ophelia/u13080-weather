import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import type { Preset, ZoneProfile } from "../src/core/types";
import { applyStash, takeStash } from "../src/studio/model/stash";
import { initialState, type StudioSettingsLike } from "../src/studio/model/state";
import { createStore, type Store } from "../src/studio/model/store";

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

function harness(zoneId: string | null = "greywold"): Store {
  return createStore(initialState(settings(), zoneId), (f) => f());
}

describe("takeStash", () => {
  test("returns null when nothing is dirty", () => {
    const store = harness();
    expect(takeStash(store.get(), store)).toBeNull();
  });

  test("stashes only the dirty zones, not the clean ones", () => {
    const store = harness();
    store.update((s) => {
      s.zones.greywold!.name = "Greywold (edited)";
    });
    const stash = takeStash(store.get(), store);
    expect(stash).not.toBeNull();
    expect(Object.keys(stash!.zones)).toEqual(["greywold"]);
    expect(stash!.zones["greywold"]!.name).toBe("Greywold (edited)");
    expect(stash!.world).toBeUndefined();
  });

  test("includes the world draft only when it is dirty", () => {
    const store = harness();
    store.update((s) => {
      s.world.eras[0]!.from = -1;
    });
    const stash = takeStash(store.get(), store);
    expect(stash).not.toBeNull();
    expect(Object.keys(stash!.zones)).toEqual([]);
    expect(stash!.world).toBeDefined();
    expect(stash!.world!.eras[0]!.from).toBe(-1);
  });

  test("stashes both halves when both are dirty", () => {
    const store = harness();
    store.update((s) => {
      s.zones.saltmarsh!.name = "Saltmarsh (edited)";
      s.world.calendar.seasons[0]!.name = "wintre";
    });
    const stash = takeStash(store.get(), store);
    expect(stash).not.toBeNull();
    expect(Object.keys(stash!.zones)).toEqual(["saltmarsh"]);
    expect(stash!.world!.calendar.seasons[0]!.name).toBe("wintre");
  });

  test("a dirty zone whose draft no longer exists (deleted) is skipped, not thrown", () => {
    const store = harness();
    store.update((s) => {
      delete s.zones.greywold;
    });
    const stash = takeStash(store.get(), store);
    // "greywold" is dirty (present in saved, absent in drafts) but has no
    // draft to clone — takeStash must not crash and must not fabricate one.
    expect(stash).not.toBeNull();
    expect(stash!.zones["greywold"]).toBeUndefined();
  });
});

describe("applyStash", () => {
  test("a stashed zone draft replaces the fresh copy; untouched zones are unaffected", () => {
    const fresh = initialState(settings(), "greywold");
    const stashed = zone("greywold", "Greywold (stashed)");
    const merged = applyStash(fresh, { zones: { greywold: stashed } });

    expect(merged.zones.greywold!.name).toBe("Greywold (stashed)");
    expect(merged.zones.saltmarsh).toEqual(fresh.zones.saltmarsh);
    // saved is untouched: the reapplied draft still reads as dirty.
    expect(merged.saved.zones.greywold!.name).toBe("Greywold");
  });

  test("a stashed world draft replaces the whole world draft", () => {
    const fresh = initialState(settings(), "greywold");
    const world = structuredClone(fresh.world);
    world.eras[0]!.from = -1;
    const merged = applyStash(fresh, { zones: {}, world });

    expect(merged.world.eras[0]!.from).toBe(-1);
    expect(merged.saved.world.eras[0]!.from).toBe(100);
  });

  test("no stashed world leaves the fresh world draft alone", () => {
    const fresh = initialState(settings(), "greywold");
    const merged = applyStash(fresh, { zones: {} });
    expect(canonicalJson(merged.world)).toBe(canonicalJson(fresh.world));
  });

  /**
   * The phantom (bead wadjet-9f9.45): a zone deleted from settings between the
   * close and the reopen must not come back as a draft with no settings row —
   * `commit()` looks the id up in `settings.zones` and skips what it cannot
   * find, so a resurrected draft is one the user can edit but never save.
   */
  test("a stashed zone whose id is gone from settings is dropped, not resurrected", () => {
    const gone: StudioSettingsLike = { ...settings(), zones: [zone("greywold", "Greywold")] };
    const fresh = initialState(gone, "greywold");
    expect(Object.keys(fresh.zones)).toEqual(["greywold"]);

    const merged = applyStash(fresh, { zones: { greywold: zone("greywold", "Greywold (stashed)"), saltmarsh: zone("saltmarsh", "Saltmarsh (stashed)") } });

    expect(Object.keys(merged.zones)).toEqual(["greywold"]);
    expect(merged.zones.saltmarsh).toBeUndefined();
    // The surviving zone still gets its draft back.
    expect(merged.zones.greywold!.name).toBe("Greywold (stashed)");
    // And the reopened store sees exactly one dirty zone, not two.
    const reopened = createStore(merged, (f) => f());
    expect(reopened.dirtyZones()).toEqual(new Set(["greywold"]));
  });

  test("a stash whose zones are ALL gone still applies the world draft", () => {
    const gone: StudioSettingsLike = { ...settings(), zones: [] };
    const fresh = initialState(gone, null);
    const world = structuredClone(fresh.world);
    world.eras[0]!.from = -1;

    const merged = applyStash(fresh, { zones: { greywold: zone("greywold", "Greywold (stashed)") }, world });

    expect(merged.zones).toEqual({});
    expect(merged.world.eras[0]!.from).toBe(-1);
  });

  test("round-trips a dirty store through take/apply: the reapplied state is dirty the same way", () => {
    const store = harness();
    store.update((s) => {
      s.zones.greywold!.name = "Greywold (edited)";
      s.world.eras[0]!.from = -1;
    });
    const before = store.get();
    const stash = takeStash(before, store)!;

    const fresh = initialState(settings(), "greywold");
    const merged = applyStash(fresh, stash);

    expect(merged.zones.greywold!.name).toBe("Greywold (edited)");
    expect(merged.zones.saltmarsh!.name).toBe("Saltmarsh");
    expect(merged.world.eras[0]!.from).toBe(-1);

    // Dirty against the fresh baseline the same way the original store was.
    const reopened = createStore(merged, (f) => f());
    expect(reopened.dirtyZones()).toEqual(new Set(["greywold"]));
    expect(reopened.worldDirty()).toBe(true);
  });
});
