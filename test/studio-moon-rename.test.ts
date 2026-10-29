/**
 * Bead wadjet-noy: a moon rename renames every reference to the moon in the
 * same save (ruled 2026-10-23). Covers the pure helpers, the Studio Save's
 * amend over the drafts and their history, and the legacy Moons row's rule.
 */
import { describe, expect, test } from "bun:test";
import { gregorianTime } from "../src/core/generator";
import { ModifierEngine } from "../src/core/modifiers";
import { canonicalJson, profileHash } from "../src/core/profile";
import type { DayTime, Modifier, Preset, ZoneProfile } from "../src/core/types";
import { moonRowRenames, parseMoonsText, serialiseMoonsText } from "../src/plugin/calendar-text";
import type { DevicePreset } from "../src/plugin/settings";
import { getCycle, setCycle } from "../src/studio/model/compile";
import { followMoonRenames, moonRenames, renameMoonReferences, renameMoonsInPredicate, renameMoonsInZone } from "../src/studio/model/moon-rename";
import { initialState, type StudioSettingsLike } from "../src/studio/model/state";
import { createStore, type Store } from "../src/studio/model/store";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

const tide: Modifier = { id: "tide", when: { moon: { name: "Moon", phase: [0.88, 0.12] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5 }], tag: "tide" };
const nested: Modifier = {
  id: "nested",
  when: { all: [{ any: [{ moon: { name: "Moon", phase: [0.4, 0.6] } }, { tag: "season:winter" }] }, { not: { moon: { name: "Pale", phase: [0, 0.5] } } }] },
  apply: [{ param: "temperature.mean", op: "offset", value: -1 }],
};
const dangling: Modifier = { id: "ghost", when: { moon: { name: "Selene", phase: [0, 0.5] } }, apply: [{ param: "temperature.mean", op: "offset", value: 1 }] };

function zone(id: string, modifiers: Modifier[]): ZoneProfile {
  const z: ZoneProfile = { id, name: id, schemaVersion: 1, climate: structuredClone(fjord.climate), regimes: structuredClone(fjord.regimes), modifiers: structuredClone(modifiers) };
  return z;
}

const preset: DevicePreset = { name: "Spring tide", kind: "moon", when: { moon: { name: "Moon", phase: [0.9, 0.1] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.2 }] };

function withCycle(z: ZoneProfile, moon: string): ZoneProfile {
  setCycle(z, "temperature.mean", { moon, depth: 2, envelope: [[0.5, 1]] });
  return z;
}

/** A moon `name` whose phase runs a 29.5-day cycle, beside a second moon Pale. */
const timeOf =
  (name: string) =>
  (d: number): DayTime => ({ ...gregorianTime(d), moons: [{ name, phase: (d % 29.5) / 29.5 }, { name: "Pale", phase: (d % 11) / 11 }], tags: [] });

function activeDays(z: ZoneProfile, moonName: string, id: string): number[] {
  const e = new ModifierEngine({ seed: "s", zoneId: z.id, modifiers: z.modifiers, timeOf: timeOf(moonName) });
  const out: number[] = [];
  for (let d = 0; d < 120; d++) if (e.forDay(d, "normal").active.includes(id)) out.push(d);
  return out;
}

describe("moonRenames: identity as the Studio draft tracks it", () => {
  test("by body id on a definition world; a swap is two renames", () => {
    expect([...moonRenames([{ id: "moon-1", name: "Moon" }], [{ id: "moon-1", name: "Selene" }])]).toEqual([["Moon", "Selene"]]);
    const swap = moonRenames(
      [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      [
        { id: "b", name: "A" },
        { id: "a", name: "B" },
      ],
    );
    expect([...swap].sort()).toEqual([
      ["A", "B"],
      ["B", "A"],
    ]);
  });
  test("by position on the legacy calendar, only when the count holds", () => {
    expect([...moonRenames([{ name: "Moon" }, { name: "Pale" }], [{ name: "Selene" }, { name: "Pale" }])]).toEqual([["Moon", "Selene"]]);
    expect(moonRenames([{ name: "Moon" }], [{ name: "Selene" }, { name: "Pale" }]).size).toBe(0);
  });
  test("a new body, a dropped one, ids on one side only, or a name two moons share is not a rename", () => {
    expect(moonRenames([{ id: "moon-1", name: "Moon" }], [{ id: "moon-2", name: "Selene" }]).size).toBe(0);
    expect(moonRenames([{ name: "Moon" }], [{ id: "moon-1", name: "Selene" }]).size).toBe(0);
    expect(moonRenames([{ name: "Moon" }, { name: "Pale" }], [{ name: "Pale" }, { name: "Pale" }]).size).toBe(0);
  });
});

describe("renaming references", () => {
  test("every reference kind: when leaves at any depth, the ☾ layer id and its predicate, device presets", () => {
    const z = withCycle(zone("z", [tide, nested, dangling]), "Moon");
    const settings = { zones: [z], devicePresets: [preset], eras: [{ name: "Long Winter", from: 1 }] };
    const out = renameMoonReferences(settings, new Map([["Moon", "Selene"]]));
    const byId = (id: string) => out.zones[0]!.modifiers.find((m) => m.id === id)!;
    expect(byId("tide").when).toEqual({ moon: { name: "Selene", phase: [0.88, 0.12] } });
    expect(canonicalJson(byId("nested").when)).toBe(canonicalJson({ all: [{ any: [{ moon: { name: "Selene", phase: [0.4, 0.6] } }, { tag: "season:winter" }] }, { not: { moon: { name: "Pale", phase: [0, 0.5] } } }] }));
    expect(getCycle(out.zones[0]!, "temperature.mean", "Selene")).toEqual({ moon: "Selene", depth: 2, envelope: [[0.5, 1]] });
    expect(getCycle(out.zones[0]!, "temperature.mean", "Moon")).toBeNull();
    expect(out.devicePresets[0]!.when).toEqual({ moon: { name: "Selene", phase: [0.9, 0.1] } });
    // untouched parts are the same objects, byte for byte
    expect(out.eras).toBe(settings.eras);
    expect(out.zones[0]!.climate).toBe(z.climate);
    expect(out.zones[0]!.regimes).toBe(z.regimes);
  });

  test("a name no moon carries is untouched, and a zone naming no renamed moon is the same object", () => {
    const z = zone("z", [dangling]);
    expect(renameMoonsInZone(z, new Map([["Moon", "Selene"]]))).toBe(z);
    const p = { moon: { name: "Selene", phase: [0, 1] as [number, number] } };
    expect(renameMoonsInPredicate(p, new Map([["Moon", "Pale"]]))).toBe(p);
  });

  test("a swap A→B, B→A swaps the references once", () => {
    const z = zone("z", [
      { id: "a", when: { moon: { name: "A", phase: [0, 0.5] } }, apply: [] },
      { id: "b", when: { any: [{ moon: { name: "B", phase: [0, 0.5] } }] }, apply: [] },
    ]);
    withCycle(z, "A");
    withCycle(z, "B");
    const out = renameMoonsInZone(
      z,
      new Map([
        ["A", "B"],
        ["B", "A"],
      ]),
    );
    const byId = (id: string) => out.modifiers.find((m) => m.id === id)!;
    expect(byId("a").when).toEqual({ moon: { name: "B", phase: [0, 0.5] } });
    expect(byId("b").when).toEqual({ any: [{ moon: { name: "A", phase: [0, 0.5] } }] });
    const ids = out.modifiers.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getCycle(out, "temperature.mean", "A")?.moon).toBe("A");
    expect(getCycle(out, "temperature.mean", "B")?.moon).toBe("B");
  });

  test("a ☾ layer whose new id is taken keeps its id; its predicate still follows", () => {
    const z = withCycle(withCycle(zone("z", []), "Moon"), "Selene");
    const out = renameMoonsInZone(z, new Map([["Moon", "Selene"]]));
    const ids = out.modifiers.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.modifiers.every((m) => m.when !== undefined && "moon" in m.when && m.when.moon.name === "Selene")).toBe(true);
  });

  test("the renamed condition matches the same days as before, and the zone's profile hash moves", () => {
    const before = zone("z", [tide, nested]);
    const after = renameMoonsInZone(before, new Map([["Moon", "Selene"]]));
    for (const id of ["tide", "nested"]) {
      const was = activeDays(before, "Moon", id);
      expect(was.length).toBeGreaterThan(0);
      expect(activeDays(after, "Selene", id)).toEqual(was);
      // without the rename the condition silently never matches (the bug)
      if (id === "tide") expect(activeDays(before, "Selene", id)).toEqual([]);
    }
    expect(profileHash(after)).not.toBe(profileHash(before));
  });
});

function settingsLike(moons: StudioSettingsLike["calendar"]["moons"]): StudioSettingsLike {
  return {
    zones: [withCycle(zone("greywold", [tide, nested, dangling]), "Moon"), zone("saltmarsh", [])],
    eras: [],
    calendar: { seasons: [], moons },
    devicePresets: [structuredClone(preset)],
    overrides: [],
  };
}

/** What the Studio Save does before it writes (src/studio/ui/header.ts `save`). */
function saveRenames(store: Store): Map<string, string> {
  const s = store.get();
  const base = s.calendarBase ?? s.saved.world.calendar;
  const renames = moonRenames(base.moons, s.world.calendar.moons);
  if (renames.size > 0) store.amend(followMoonRenames(base.moons, renames));
  return renames;
}

describe("Studio Save: the rename and its references in one save, undone together", () => {
  for (const kind of ["definition", "legacy"] as const) {
    test(`${kind} world: references follow, the zones go dirty, undo and redo keep moon and references together`, () => {
      const moons = kind === "definition" ? [{ id: "moon-1", name: "Moon", cycleDays: 29.5, phaseAtEpoch: 0 }] : [{ name: "Moon", cycleDays: 29.5, phaseAtEpoch: 0 }];
      const store = createStore(initialState(settingsLike(moons), "greywold"), () => {});
      const untouched = canonicalJson(store.get().zones.saltmarsh);
      store.update((s) => (s.world.calendar.moons[0]!.name = "Selene"), { history: true });
      // a later edit, so undo has a step between the rename and now
      store.update((s) => (s.zones.greywold!.name = "Greywold"), { history: true });
      expect(store.dirtyZones().has("greywold")).toBe(true);
      expect([...saveRenames(store)]).toEqual([["Moon", "Selene"]]);
      const s = store.get();
      expect(s.zones.greywold!.modifiers.find((m) => m.id === "tide")!.when).toEqual({ moon: { name: "Selene", phase: [0.88, 0.12] } });
      expect(getCycle(s.zones.greywold!, "temperature.mean", "Selene")).not.toBeNull();
      expect(s.zones.greywold!.modifiers.find((m) => m.id === "ghost")!.when).toEqual(dangling.when);
      expect(s.world.devicePresets[0]!.when).toEqual({ moon: { name: "Selene", phase: [0.9, 0.1] } });
      expect(canonicalJson(s.zones.saltmarsh)).toBe(untouched);
      // the Save's reseed: the calendar written is what the Studio last saved (header.ts, calendarAfterSave)
      store.update((x) => (x.calendarBase = structuredClone(x.world.calendar)));
      store.markSaved();
      expect(store.dirtyZones().size).toBe(0);

      const tideName = () => {
        const w = store.get().zones.greywold!.modifiers.find((m) => m.id === "tide")!.when!;
        return "moon" in w ? w.moon.name : null;
      };
      // undo the later edit: the moon is still Selene, and so are its references
      store.undo();
      expect(store.get().world.calendar.moons[0]!.name).toBe("Selene");
      expect(tideName()).toBe("Selene");
      // undo the rename: both go back
      store.undo();
      expect(store.get().world.calendar.moons[0]!.name).toBe("Moon");
      expect(tideName()).toBe("Moon");
      expect(store.get().world.devicePresets[0]!.when).toEqual(preset.when);
      store.redo();
      expect(store.get().world.calendar.moons[0]!.name).toBe("Selene");
      expect(tideName()).toBe("Selene");
      store.undo();
      // saving the undone rename renames the references back, again in one save
      expect([...saveRenames(store)]).toEqual([["Selene", "Moon"]]);
      expect(tideName()).toBe("Moon");
      expect(getCycle(store.get().zones.greywold!, "temperature.mean", "Moon")).not.toBeNull();
    });
  }

  test("two moons swapping names in the Studio swap their references once", () => {
    const moons = [
      { id: "moon-1", name: "Moon", cycleDays: 29.5, phaseAtEpoch: 0 },
      { id: "moon-2", name: "Pale", cycleDays: 11, phaseAtEpoch: 0 },
    ];
    const store = createStore(initialState(settingsLike(moons), "greywold"), () => {});
    store.update((s) => {
      s.world.calendar.moons[0]!.name = "Pale";
      s.world.calendar.moons[1]!.name = "Moon";
    }, { history: true });
    saveRenames(store);
    const w = store.get().zones.greywold!.modifiers.find((m) => m.id === "nested")!.when!;
    expect(canonicalJson(w)).toBe(canonicalJson({ all: [{ any: [{ moon: { name: "Pale", phase: [0.4, 0.6] } }, { tag: "season:winter" }] }, { not: { moon: { name: "Moon", phase: [0, 0.5] } } }] }));
  });

  test("no rename, no amend: the drafts and the history are untouched", () => {
    const store = createStore(initialState(settingsLike([{ id: "moon-1", name: "Moon", cycleDays: 29.5, phaseAtEpoch: 0 }]), "greywold"), () => {});
    store.update((s) => (s.world.calendar.moons[0]!.cycleDays = 30), { history: true });
    const before = canonicalJson({ z: store.get().zones, w: store.get().world });
    expect(saveRenames(store).size).toBe(0);
    expect(canonicalJson({ z: store.get().zones, w: store.get().world })).toBe(before);
    expect(store.canUndo()).toBe(true);
  });
});

describe("legacy settings Moons row: a line that changed only its name is a rename", () => {
  const stored = parseMoonsText("Moon, 29.53, 0, New@0, Full@0.5\nPale, 11, 0.25");
  const row = (text: string) => [...moonRowRenames(stored, parseMoonsText(text))];
  test("name only, count and order kept → rename", () => {
    expect(row("Selene, 29.53, 0, New@0, Full@0.5\nPale, 11, 0.25")).toEqual([["Moon", "Selene"]]);
    expect(serialiseMoonsText(stored)).toBe("Moon, 29.53, 0, New@0, Full@0.5\nPale, 11, 0.25");
  });
  test("a name and anything else on the line, a reorder, or a line more or fewer → delete and create", () => {
    expect(row("Selene, 30, 0, New@0, Full@0.5\nPale, 11, 0.25")).toEqual([]);
    expect(row("Selene, 29.53, 0\nPale, 11, 0.25")).toEqual([]);
    expect(row("Pale, 11, 0.25\nMoon, 29.53, 0, New@0, Full@0.5")).toEqual([]);
    expect(row("Selene, 29.53, 0, New@0, Full@0.5")).toEqual([]);
    expect(row("Selene, 29.53, 0, New@0, Full@0.5\nPale, 11, 0.25\nThird, 7, 0")).toEqual([]);
  });
  test("two lines swapping names (all else equal) swap; settings keep everything else", () => {
    const twins = parseMoonsText("A, 10, 0\nB, 10, 0");
    const r = moonRowRenames(twins, parseMoonsText("B, 10, 0\nA, 10, 0"));
    expect([...r].sort()).toEqual([
      ["A", "B"],
      ["B", "A"],
    ]);
    const settings = { zones: [zone("z", [{ id: "a", when: { moon: { name: "A", phase: [0, 1] } }, apply: [] }])], devicePresets: [] as DevicePreset[], worldSeed: "w" };
    const out = renameMoonReferences(settings, r);
    expect(out.zones[0]!.modifiers[0]!.when).toEqual({ moon: { name: "B", phase: [0, 1] } });
    expect(out.devicePresets).toBe(settings.devicePresets);
    expect(out.worldSeed).toBe("w");
  });
});
