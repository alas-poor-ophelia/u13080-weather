/**
 * The device window's edit vocabulary (SPEC §3.4, PLAN D12).
 *
 * Every mutation the window can make goes through one of these helpers, so the
 * contract worth pinning is the one the window leans on: **a helper never
 * leaves the draft invalid**. Each test therefore ends the same way — run the
 * real `validateProfile` over the zone and assert no errors — on a real zone
 * built from the shipped `fjord-coast` preset, never an invented one
 * (SPEC law 4).
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Modifier, ModifierOp, Preset, ZoneProfile } from "../src/core/types";
import type { DevicePreset } from "../src/plugin/settings";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { zoneFromPreset } from "../src/plugin/zones";
import {
  WHEN_KINDS,
  addGate,
  addOp,
  defaultSpell,
  defaultWhenFor,
  deviceOf,
  loadPreset,
  neutralEnvelope,
  newOpFor,
  paramsByChannel,
  presetNames,
  removeDevice,
  removeGate,
  removeOp,
  renameDevice,
  restage,
  saveAsPreset,
  setEnvelope,
  setGateAmount,
  setGateSource,
  setOpEnabled,
  setOpValue,
  setSpell,
  setWhen,
  updateDevice,
} from "../src/studio/model/device-edit";
import { toDevice, toModifier, type Device } from "../src/studio/model/devices";
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
    { name: "Ivory", cycleDays: 41, phases: [{ name: "Dark", at: 0 }, { name: "Bright", at: 0.5 }] },
  ],
};

function zoneWith(mods: Modifier[]): ZoneProfile {
  return { ...zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone, modifiers: mods };
}

/** The one assertion every test ends on: the draft the window produced is a legal profile. */
function expectValid(z: ZoneProfile): void {
  expect(validateProfile(z).filter((i) => i.level === "error")).toEqual([]);
}

const gale: Modifier = { id: "Gale", stage: "daily", when: { chance: 0.1 }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] };

function device(m: Modifier): Device {
  return toDevice(m, calendar);
}

function emptyWorld(): WorldDraft {
  return { eras: [], calendar: { seasons: calendar.seasons, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] }, devicePresets: [], overrides: [] };
}

describe("device-edit · updateDevice", () => {
  test("decompiles, mutates and recompiles in place — the chain keeps its order", () => {
    const z = zoneWith([{ id: "A", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }, gale, { id: "B", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] }]);
    expect(updateDevice(z, "Gale", (d) => setOpValue(d, 0, 2), calendar)).toBe(true);
    expect(z.modifiers.map((m) => m.id)).toEqual(["A", "Gale", "B"]);
    expect(z.modifiers[1]!.apply[0]).toEqual({ param: "wind.speed", op: "scale", value: 2 });
    expectValid(z);
  });

  test("an unknown id is a no-op, not a throw", () => {
    const z = zoneWith([gale]);
    expect(updateDevice(z, "nope", (d) => setOpValue(d, 0, 9), calendar)).toBe(false);
    expect(z.modifiers).toEqual([gale]);
  });

  test("a custom device round-trips its raw predicate through an edit", () => {
    const raw: Modifier = { id: "Odd", stage: "daily", when: { not: { tag: "era:Drought" } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 0.5 }] };
    const z = zoneWith([raw]);
    updateDevice(z, "Odd", (d) => setOpValue(d, 0, 0.25), calendar);
    expect(z.modifiers[0]!.when).toEqual({ not: { tag: "era:Drought" } });
    expect(z.modifiers[0]!.apply[0]).toEqual({ param: "precipitation.pwd", op: "scale", value: 0.25 });
    expectValid(z);
  });
});

describe("device-edit · rename and remove", () => {
  test("renameDevice moves the id and rewrites nothing else", () => {
    const z = zoneWith([gale, { id: "Other", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    expect(renameDevice(z, "Gale", "Storm")).toBe("Storm");
    expect(z.modifiers.map((m) => m.id)).toEqual(["Storm", "Other"]);
    expect(z.modifiers[0]!.apply).toEqual(gale.apply);
    expectValid(z);
  });

  test("a colliding name is suffixed, and renaming to itself is a no-op", () => {
    const z = zoneWith([gale, { id: "Storm", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    expect(renameDevice(z, "Gale", "Storm")).toBe("Storm 2");
    expect(renameDevice(z, "Storm 2", "Storm 2")).toBe("Storm 2");
    expect(renameDevice(z, "Storm 2", "   ")).toBe("Device");
    expectValid(z);
  });

  test("removeDevice drops exactly one modifier", () => {
    const z = zoneWith([gale, { id: "Other", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    expect(removeDevice(z, "Gale")).toBe(true);
    expect(removeDevice(z, "Gale")).toBe(false);
    expect(z.modifiers.map((m) => m.id)).toEqual(["Other"]);
    expectValid(z);
  });
});

describe("device-edit · WHEN", () => {
  test("every WHEN kind's default compiles to a valid predicate", () => {
    for (const { when } of WHEN_KINDS) {
      const z = zoneWith([gale]);
      updateDevice(z, "Gale", (d) => setWhen(d, defaultWhenFor(when, calendar)), calendar);
      expectValid(z);
      const back = deviceOf(z, "Gale", calendar)!;
      expect(back.when.kind).toBe(when);
    }
  });

  test("always drops the predicate and puts the device on the climate stage", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => setWhen(d, { kind: "always" }), calendar);
    expect(z.modifiers[0]!.when).toBeUndefined();
    expect(z.modifiers[0]!.stage).toBe("climate");
    expectValid(z);
  });

  test("several tags compile to any, one to a bare tag", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => setWhen(d, { kind: "tag", tags: ["season:Winter"] }), calendar);
    expect(z.modifiers[0]!.when).toEqual({ tag: "season:Winter" });
    updateDevice(z, "Gale", (d) => setWhen(d, { kind: "tag", tags: ["season:Winter", "era:Drought"] }), calendar);
    expect(z.modifiers[0]!.when).toEqual({ any: [{ tag: "season:Winter" }, { tag: "era:Drought" }] });
    expectValid(z);
  });

  test("a custom device's predicate is not the studio's to rewrite", () => {
    const raw: Modifier = { id: "Odd", stage: "daily", when: { regime: "storm" }, apply: [{ param: "wind.speed", op: "scale", value: 2 }] };
    const z = zoneWith([raw]);
    updateDevice(z, "Odd", (d) => setWhen(d, { kind: "chance", p: 0.5 }), calendar);
    expect(z.modifiers[0]!.when).toEqual({ regime: "storm" });
    expectValid(z);
  });
});

describe("device-edit · SPELL", () => {
  test("switching the spell on writes the real field names and keeps the stage daily", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => setSpell(d, defaultSpell(calendar)), calendar);
    expect(z.modifiers[0]!.spell).toEqual({ meanStartsPerYear: 0.6, meanDurationDays: 14 });
    expectValid(z);
  });

  test("a spell on an unconditional device forces the daily stage", () => {
    const z = zoneWith([{ id: "Trim", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    updateDevice(z, "Trim", (d) => setSpell(d, { meanStartsPerYear: 1, meanDurationDays: 5 }), calendar);
    expect(z.modifiers[0]!.stage).toBe("daily");
    expectValid(z);
    updateDevice(z, "Trim", (d) => setSpell(d, undefined), calendar);
    expect(z.modifiers[0]!.stage).toBe("climate");
    expect(z.modifiers[0]!.spell).toBeUndefined();
    expectValid(z);
  });
});

describe("device-edit · APPLY", () => {
  test("newOpFor is the chain's own default where there is one, an offset of zero otherwise", () => {
    expect(newOpFor("wind.speed")).toEqual({ param: "wind.speed", op: "scale", value: 1 });
    expect(newOpFor("precipitation.pwd")).toEqual({ param: "precipitation.pwd", op: "scale", value: 1 });
    expect(newOpFor("temperature.sd")).toEqual({ param: "temperature.sd", op: "offset", value: 0 });
  });

  test("paramsByChannel offers curve paths daily, curve plus scalar at the climate stage, minus what is taken", () => {
    const daily = paramsByChannel("daily").flatMap((g) => g.params);
    expect(daily).toContain("temperature.mean");
    expect(daily).not.toContain("temperature.phase");
    const climate = paramsByChannel("climate").flatMap((g) => g.params);
    expect(climate).toContain("temperature.phase");
    expect(paramsByChannel("daily", ["temperature.mean"]).flatMap((g) => g.params)).not.toContain("temperature.mean");
    expect(paramsByChannel("daily").map((g) => g.channel)).toEqual(["temperature", "precipitation", "wind", "sky"]);
  });

  test("every param the menu can offer produces an op the validator accepts", () => {
    for (const stage of ["daily", "climate"] as const) {
      const z = zoneWith([{ id: "Bank", stage, ...(stage === "daily" ? { when: { chance: 0.5 } } : {}), apply: [{ param: "temperature.mean", op: "offset", value: 0 }] }]);
      for (const group of paramsByChannel(stage)) for (const param of group.params) updateDevice(z, "Bank", (d) => addOp(d, newOpFor(param)), calendar);
      expectValid(z);
    }
  });

  test("op power, value and removal", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => addOp(d, newOpFor("temperature.mean")), calendar);
    updateDevice(z, "Gale", (d) => setOpValue(d, 1, -3.5), calendar);
    updateDevice(z, "Gale", (d) => setOpEnabled(d, 1, false), calendar);
    expect(z.modifiers[0]!.apply[1]).toEqual({ param: "temperature.mean", op: "offset", value: -3.5, enabled: false });
    updateDevice(z, "Gale", (d) => setOpEnabled(d, 1, true), calendar);
    expect(z.modifiers[0]!.apply[1]).toEqual({ param: "temperature.mean", op: "offset", value: -3.5 });
    updateDevice(z, "Gale", (d) => removeOp(d, 1), calendar);
    expect(z.modifiers[0]!.apply).toHaveLength(1);
    expectValid(z);
  });

  test("setOpValue leaves a clamp alone — it has no value to set", () => {
    const clamp: ModifierOp = { param: "wind.speed", op: "clamp", max: 90 };
    const z = zoneWith([{ id: "Cap", stage: "daily", when: { chance: 0.5 }, apply: [clamp] }]);
    updateDevice(z, "Cap", (d) => setOpValue(d, 0, 5), calendar);
    expect(z.modifiers[0]!.apply[0]).toEqual(clamp);
    expectValid(z);
  });
});

describe("device-edit · MOD", () => {
  test("a gate is a tag, dimmed into [0, 1]", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => void addGate(d, "season:Winter", 0.5), calendar);
    expect(z.modifiers[0]!.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);
    updateDevice(z, "Gale", (d) => setGateAmount(d, 0, 4), calendar);
    expect(z.modifiers[0]!.mods![0]!.amount).toBe(1);
    updateDevice(z, "Gale", (d) => setGateAmount(d, 0, -2), calendar);
    expect(z.modifiers[0]!.mods![0]!.amount).toBe(0);
    expectValid(z);
  });

  test("a moon is a carrier, never a gate", () => {
    const d = device(gale);
    expect(addGate(d, "moon:Sable", 1)).toBe(false);
    expect(addGate(d, "  ", 1)).toBe(false);
    setGateSource(d, 0, "moon:Sable");
    expect(d.mods).toEqual([]);
  });

  test("a gate forces the daily stage, and removing the last one lets it go back", () => {
    const z = zoneWith([{ id: "Trim", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    updateDevice(z, "Trim", (d) => void addGate(d, "season:Winter", 0.5), calendar);
    expect(z.modifiers[0]!.stage).toBe("daily");
    expectValid(z);
    updateDevice(z, "Trim", (d) => removeGate(d, 0), calendar);
    expect(z.modifiers[0]!.stage).toBe("climate");
    expect(z.modifiers[0]!.mods).toBeUndefined();
    expectValid(z);
  });

  test("an envelope sorts, wraps its phases and clamps its strengths", () => {
    const z = zoneWith([gale]);
    updateDevice(
      z,
      "Gale",
      (d) =>
        setEnvelope(d, 0, [
          [0.8, 2],
          [0.2, -1],
          [1.25, 0.5],
        ]),
      calendar,
    );
    expect(z.modifiers[0]!.apply[0]!.envelope).toEqual([
      [0.2, 0],
      [0.25, 0.5],
      [0.8, 1],
    ]);
    expectValid(z);
  });

  test("an envelope forces the daily stage; removing it releases it", () => {
    const z = zoneWith([{ id: "Trim", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    updateDevice(z, "Trim", (d) => setEnvelope(d, 0, neutralEnvelope()), calendar);
    expect(z.modifiers[0]!.stage).toBe("daily");
    expectValid(z);
    updateDevice(z, "Trim", (d) => setEnvelope(d, 0, undefined), calendar);
    expect(z.modifiers[0]!.stage).toBe("climate");
    expect(z.modifiers[0]!.apply[0]!.envelope).toBeUndefined();
    expectValid(z);
  });

  test("an empty envelope removes rather than writing the shape the validator rejects", () => {
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => setEnvelope(d, 0, []), calendar);
    expect(z.modifiers[0]!.apply[0]!.envelope).toBeUndefined();
    expectValid(z);
  });

  test("restage keeps a device daily while anything daily-only is attached", () => {
    const d = device({ id: "X", apply: [{ param: "wind.speed", op: "scale", value: 2 }] });
    restage(d);
    expect(d.stage).toBe("climate");
    d.mods.push({ source: "season:Winter", amount: 0.5 });
    restage(d);
    expect(d.stage).toBe("daily");
  });
});

describe("device-edit · presets", () => {
  test("saveAsPreset stores the shape and uniquifies the name against shipped and user presets", () => {
    const world = emptyWorld();
    const d = device(gale);
    const saved = saveAsPreset(world, d, "Gale preset");
    expect(saved).toEqual({ name: "Gale preset", kind: "chance", when: { chance: 0.1 }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] });
    expect(world.devicePresets).toHaveLength(1);
    expect(saveAsPreset(world, d, "Gale preset").name).toBe("Gale preset 2");
    expect(saveAsPreset(world, d, "Volcanic").name).toBe("Volcanic 2");
    expect(presetNames(world)).toContain("Spring-tide");
  });

  test("a preset only loads over a device of the same kind", () => {
    const d = device(gale);
    const volcanic = SHIPPED_PRESETS.find((p) => p.kind === "spell")!;
    expect(loadPreset(d, volcanic, calendar, [])).toBe(false);
    const fohn = SHIPPED_PRESETS.find((p) => p.name === "Föhn days")!;
    expect(loadPreset(d, fohn, calendar, [])).toBe(true);
    expect(d.id).toBe("Gale");
    expect(d.when).toEqual({ kind: "chance", p: 0.06 });
    expect(d.apply).toHaveLength(3);
  });

  test("every shipped preset loads over a fresh device of its kind and stays valid", () => {
    for (const preset of SHIPPED_PRESETS) {
      const seed = toModifier({ ...device(gale), kind: preset.kind, id: "Slot", name: "Slot" });
      const z = zoneWith([seed]);
      updateDevice(z, "Slot", (d) => void loadPreset(d, preset, calendar, otherIds(z, "Slot")), calendar);
      expect(z.modifiers[0]!.id).toBe("Slot");
      expectValid(z);
    }
  });

  test("a saved preset round-trips back over the device it came from", () => {
    const world = emptyWorld();
    const z = zoneWith([{ id: "Tide", stage: "daily", when: { moon: { name: "Sable", phase: [0.86, 0] } }, apply: [{ param: "wind.speed", op: "scale", value: 1.6 }], mods: [{ source: "season:Winter", amount: 0.4 }] }]);
    const before = structuredClone(z.modifiers[0]!);
    const saved = saveAsPreset(world, deviceOf(z, "Tide", calendar)!, "Sable tide");
    updateDevice(z, "Tide", (d) => setOpValue(d, 0, 1), calendar);
    updateDevice(z, "Tide", (d) => void loadPreset(d, saved, calendar, []), calendar);
    expect(z.modifiers[0]).toEqual(before);
    expectValid(z);
  });
});

function otherIds(z: ZoneProfile, id: string): string[] {
  return z.modifiers.filter((m) => m.id !== id).map((m) => m.id);
}

describe("device-edit · the shipped world stays legal", () => {
  test("a device driven through every WHEN kind, a spell, ops, a gate and an envelope validates at every step", () => {
    const z = zoneWith([gale]);
    const steps: Array<(d: Device) => void> = [
      (d) => setWhen(d, defaultWhenFor("moon", calendar)),
      (d) => setSpell(d, defaultSpell(calendar)),
      (d) => addOp(d, newOpFor("temperature.mean")),
      (d) => setOpValue(d, 1, -2),
      (d) => void addGate(d, "season:Winter", 0.25),
      (d) => setEnvelope(d, 0, neutralEnvelope()),
      (d) => setWhen(d, defaultWhenFor("tag", calendar)),
      (d) => setWhen(d, defaultWhenFor("yearWindow", calendar)),
      (d) => setWhen(d, defaultWhenFor("chance", calendar)),
      (d) => setWhen(d, defaultWhenFor("always", calendar)),
    ];
    for (const step of steps) {
      updateDevice(z, "Gale", step, calendar);
      expectValid(z);
    }
    // Gates and an envelope are daily-stage only, so "always" cannot make this
    // one unconditional while they are attached (see `restage`).
    expect(z.modifiers[0]!.stage).toBe("daily");
    expect(z.modifiers[0]!.when).toBeUndefined();
  });

  test("a preset saved from that device is loadable and legal", () => {
    const world = emptyWorld();
    const z = zoneWith([gale]);
    updateDevice(z, "Gale", (d) => void addGate(d, "season:Winter", 0.25), calendar);
    const preset: DevicePreset = saveAsPreset(world, deviceOf(z, "Gale", calendar)!, "Gale preset");
    const fresh = zoneWith([{ ...gale, id: "Other" }]);
    updateDevice(fresh, "Other", (d) => void loadPreset(d, preset, calendar, []), calendar);
    expect(fresh.modifiers[0]!.mods).toEqual([{ source: "season:Winter", amount: 0.25 }]);
    expectValid(fresh);
  });
});
