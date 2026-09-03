/**
 * The insert picker's pure model (SPEC §3.6, PLAN D12).
 *
 * Same discipline as `studio-device-edit.test.ts`: every insert ends with the
 * real `validateProfile` over a zone built from the shipped `fjord-coast`
 * preset, never an invented one (SPEC law 4).
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Preset, ZoneProfile } from "../src/core/types";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { zoneFromPreset } from "../src/plugin/zones";
import { channelOf, devices } from "../src/studio/model/compile";
import { toDevice } from "../src/studio/model/devices";
import { insertDevice, insertKinds, insertPreset, presetsFor } from "../src/studio/model/insert";
import { SHIPPED_PRESETS } from "../src/studio/model/presets";
import type { WorldDraft } from "../src/studio/model/state";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

const calendar: CalendarDescription = {
  label: "internal calendar",
  readOnly: false,
  yearLength: 365,
  epochYear: 1,
  seasons: [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Harvest", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ],
  moons: [
    {
      name: "Sable",
      cycleDays: 29.53,
      phases: [
        { name: "New", at: 0 },
        { name: "Crescent", at: 0.16 },
        { name: "Half", at: 0.42 },
        { name: "Gibbous", at: 0.68 },
        { name: "Full", at: 0.86 },
      ],
    },
  ],
};

function zoneWith(mods: ZoneProfile["modifiers"]): ZoneProfile {
  return { ...zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone, modifiers: mods };
}

/** The one assertion every test ends on: the draft the picker produced is a legal profile. */
function expectValid(z: ZoneProfile): void {
  expect(validateProfile(z).filter((i) => i.level === "error")).toEqual([]);
}

function emptyWorld(): WorldDraft {
  return { eras: [], calendar: { seasons: calendar.seasons, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] }, devicePresets: [], regimePresets: [], overrides: [] };
}

describe("insert · insertKinds", () => {
  test("one row per Predicate shape, in WHEN order, each with a label and a hint", () => {
    const kinds = insertKinds();
    expect(kinds.map((k) => k.kind)).toEqual(["trim", "moon", "spell", "tag", "chance"]);
    for (const k of kinds) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.hint.length).toBeGreaterThan(0);
    }
  });

  test("returns a fresh array — mutating the result never touches the next call", () => {
    const first = insertKinds();
    first.pop();
    expect(insertKinds().length).toBe(5);
  });
});

describe("insert · presetsFor", () => {
  test("shipped presets first, then the world's own, badged apart", () => {
    const world = emptyWorld();
    world.devicePresets.push({ name: "Mine", kind: "chance", apply: [{ param: "wind.speed", op: "scale", value: 1.2 }] });
    const options = presetsFor(world);
    expect(options.length).toBe(SHIPPED_PRESETS.length + 1);
    expect(options.slice(0, SHIPPED_PRESETS.length).every((o) => o.source === "shipped")).toBe(true);
    expect(options[options.length - 1]).toMatchObject({ name: "Mine", kind: "chance", source: "yours" });
  });

  test("a world with no presets of its own still lists every shipped one", () => {
    expect(presetsFor(emptyWorld()).map((o) => o.name)).toEqual(SHIPPED_PRESETS.map((p) => p.name));
  });
});

describe("insert · insertDevice", () => {
  test("every kind lands after the existing devices, before forcings:*, with a default apply for the chain", () => {
    for (const { kind } of insertKinds()) {
      const z = zoneWith([{ id: "Existing", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }, { id: "forcings:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 0 }] }]);
      const id = insertDevice(z, kind, "wind", calendar);
      expect(z.modifiers.map((m) => m.id)).toEqual(["Existing", id, "forcings:temperature.mean"]);
      const inserted = z.modifiers.find((m) => m.id === id)!;
      expect(inserted.apply.length).toBeGreaterThan(0);
      expect(inserted.apply.some((op) => channelOf(op.param) === "wind")).toBe(true);
      expectValid(z);
    }
  });

  test("the id is unique against the zone's existing modifiers", () => {
    const z = zoneWith([{ id: "Trim", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    const id = insertDevice(z, "trim", "temperature", calendar);
    expect(id).toBe("Trim 2");
    expectValid(z);
  });

  test("decompiles back to a device of the kind it was inserted as", () => {
    const z = zoneWith([]);
    const id = insertDevice(z, "moon", "temperature", calendar);
    const m = z.modifiers.find((x) => x.id === id)!;
    expect(toDevice(m, calendar).kind).toBe("moon");
    expectValid(z);
  });
});

describe("insert · insertPreset", () => {
  test("every shipped preset validates when inserted into fjord-coast, keeping its own apply untouched", () => {
    for (const preset of SHIPPED_PRESETS) {
      const z = zoneWith([]);
      const id = insertPreset(z, preset, "wind", calendar);
      const m = z.modifiers.find((x) => x.id === id)!;
      expect(m.apply).toEqual(preset.apply);
      expectValid(z);
    }
  });

  test("Föhn days writes all three of its ops, spanning temperature, wind and sky", () => {
    const fohn = SHIPPED_PRESETS.find((p) => p.name === "Föhn days")!;
    const z = zoneWith([]);
    const id = insertPreset(z, fohn, "wind", calendar);
    const m = z.modifiers.find((x) => x.id === id)!;
    expect(m.apply.length).toBe(3);
    expect(new Set(m.apply.map((op) => channelOf(op.param)))).toEqual(new Set(["temperature", "wind", "sky"]));
    expectValid(z);
  });

  test("a user preset from the world draft inserts the same way a shipped one does", () => {
    const world = emptyWorld();
    world.devicePresets.push({ name: "House blend", kind: "chance", when: { chance: 0.2 }, apply: [{ param: "wind.speed", op: "scale", value: 1.1 }] });
    const z = zoneWith([]);
    const preset = presetsFor(world).find((o) => o.name === "House blend")!.preset;
    const id = insertPreset(z, preset, "wind", calendar);
    expect(devices(z).map((m) => m.id)).toEqual([id]);
    expectValid(z);
  });

  test("lands after the existing devices, before forcings:*", () => {
    const z = zoneWith([{ id: "Existing", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }, { id: "forcings:precipitation", stage: "climate", apply: [{ param: "precipitation.pwd", op: "scale", value: 1 }] }]);
    const id = insertPreset(z, SHIPPED_PRESETS[0]!, "wind", calendar);
    expect(z.modifiers.map((m) => m.id)).toEqual(["Existing", id, "forcings:precipitation"]);
    expectValid(z);
  });
});
