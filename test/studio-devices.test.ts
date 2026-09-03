import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { validateProfile } from "../src/core/profile";
import type { Modifier, Preset, SpellSpec, ZoneProfile } from "../src/core/types";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { MODIFIER_EXAMPLES } from "../src/plugin/modifier-examples";
import { zoneFromPreset } from "../src/plugin/zones";
import {
  DEFAULT_MOON_PHASES,
  ENVELOPE_SHAPES,
  type Device,
  type DeviceKind,
  defaultApplyFor,
  deviceGrammar,
  displayName,
  envelopeShape,
  envelopeShapeName,
  gatePercent,
  kindOf,
  knobSpecFor,
  moonRange,
  newDevice,
  opValueText,
  phasesFor,
  toDevice,
  toModifier,
  uniqueDeviceId,
  whenPhrase,
  whenSummary,
  yearWindowsOf,
} from "../src/studio/model/devices";
import { SHIPPED_PRESETS, deviceToPreset, presetToDevice } from "../src/studio/model/presets";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const fjord = presets.find((p) => p.id === "fjord-coast")!;

function zoneWith(mods: Modifier[]): ZoneProfile {
  return { ...zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() }).zone, modifiers: mods };
}

const calendar: CalendarDescription = {
  label: "internal calendar",
  readOnly: false,
  yearLength: 365,
  seasons: [
    { name: "Thaw", from: 0 },
    { name: "Harvest", from: 0.5 },
  ],
  moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0, phases: [...DEFAULT_MOON_PHASES] }],
};

/** One device per kind, each carrying a feature the round trip must not lose. */
const ROUND_TRIP_DEVICES: Device[] = [
  { id: "Trim", name: "Trim", kind: "trim", enabled: true, when: { kind: "always" }, apply: [{ param: "temperature.mean", op: "offset", value: 1.5 }], mods: [], stage: "climate" },
  {
    id: "Spring-tide",
    name: "Spring-tide",
    kind: "moon",
    enabled: true,
    when: { kind: "moon", moon: "Sable", phases: ["Full"], range: [0.86, 0] },
    apply: [{ param: "precipitation.pwd", op: "scale", value: 1.4, envelope: [[0, 0], [0.5, 1]] }],
    mods: [{ source: "season:Harvest", amount: 0.5 }],
    tag: "springtide",
    stage: "daily",
  },
  {
    id: "Volcanic",
    name: "Volcanic",
    kind: "spell",
    enabled: false,
    when: { kind: "yearWindow", start: 0.61, length: 0.11 },
    spell: { meanStartsPerYear: 0.6, meanDurationDays: 18 },
    apply: [{ param: "cloud.dry", op: "set", value: 0.95 }],
    mods: [],
    stage: "daily",
  },
  {
    id: "Wet season",
    name: "Wet season",
    kind: "tag",
    enabled: true,
    when: { kind: "tag", tags: ["season:Thaw", "season:Harvest"] },
    apply: [{ param: "precipitation.pww", op: "scale", value: 1.2, enabled: false }],
    mods: [],
    stage: "daily",
  },
  { id: "Föhn days", name: "Föhn days", kind: "chance", enabled: true, when: { kind: "chance", p: 0.06 }, apply: [{ param: "wind.speed", op: "scale", value: 1.8 }], mods: [], stage: "daily" },
  {
    id: "Wrapped window",
    name: "Wrapped window",
    kind: "spell",
    enabled: true,
    when: { kind: "yearWindow", start: 0.95, length: 0.1 },
    apply: [{ param: "temperature.mean", op: "offset", value: -8 }],
    mods: [],
    stage: "daily",
  },
];

/** Predicates the studio deliberately does not model — every one must survive as a `custom` device. */
const CUSTOM_MODIFIERS: Modifier[] = [
  { id: "sky-fire", stage: "daily", when: { all: [{ chance: 0.02 }, { not: { regime: "wet-spell" } }] }, apply: [], tag: "sky-fire" },
  { id: "in-wet-spell", stage: "daily", when: { regime: "wet-spell" }, apply: [{ param: "wind.speed", op: "scale", value: 1.1 }] },
  { id: "not-winter", stage: "daily", when: { not: { tag: "season:Winter" } }, apply: [{ param: "temperature.mean", op: "offset", value: 1 }] },
  { id: "midsummer", stage: "daily", when: { dayOfYear: [150, 200] }, apply: [{ param: "temperature.mean", op: "offset", value: 2 }] },
  { id: "mixed-any", stage: "daily", when: { any: [{ tag: "season:Thaw" }, { chance: 0.1 }] }, apply: [] },
];

describe("device ⇄ modifier round trip", () => {
  test("every kind survives compile → decompile", () => {
    for (const d of ROUND_TRIP_DEVICES) expect(toDevice(toModifier(d), calendar)).toEqual(d);
  });

  test("kindOf matches the kind the device declares", () => {
    for (const d of ROUND_TRIP_DEVICES) expect(kindOf(toModifier(d))).toBe(d.kind);
  });

  test("every shipped modifier example decompiles and recompiles byte for byte", () => {
    for (const e of MODIFIER_EXAMPLES) expect(toModifier(toDevice(e.modifier, calendar))).toEqual(e.modifier);
  });

  test("a device with no calendar reads its moon window as a custom range", () => {
    const d = toDevice(MODIFIER_EXAMPLES[0]!.modifier, null);
    expect(d.kind).toBe("moon");
    expect(d.when).toEqual({ kind: "moon", moon: "Sable", phases: [], range: [0.88, 1.0] });
    expect(toModifier(d)).toEqual(MODIFIER_EXAMPLES[0]!.modifier);
  });

  test("predicates outside the five kinds fall back to custom and keep their raw modifier", () => {
    for (const m of CUSTOM_MODIFIERS) {
      expect(kindOf(m)).toBe("custom");
      const d = toDevice(m, calendar);
      expect(d.custom).toBe(true);
      expect(d.raw).toEqual(m);
      expect(toModifier(d)).toEqual(m);
      expect(toDevice(toModifier(d), calendar)).toEqual(d);
    }
  });

  test("a custom device still takes a power switch and an op edit", () => {
    const d = toDevice(CUSTOM_MODIFIERS[1]!, calendar);
    const edited: Device = { ...d, enabled: false, apply: [{ param: "wind.speed", op: "scale", value: 2 }] };
    const m = toModifier(edited);
    expect(m.when).toEqual({ regime: "wet-spell" });
    expect(m.enabled).toBe(false);
    expect(m.apply).toEqual([{ param: "wind.speed", op: "scale", value: 2 }]);
  });

  test("a single-element any collapses to a bare tag (the one documented normalisation)", () => {
    const d = toDevice({ id: "x", stage: "daily", when: { any: [{ tag: "season:Thaw" }] }, apply: [] }, calendar);
    expect(d.when).toEqual({ kind: "tag", tags: ["season:Thaw"] });
    expect(toModifier(d).when).toEqual({ tag: "season:Thaw" });
  });

  test("displayName strips studio id prefixes and leaves device names alone", () => {
    expect(displayName({ id: "layer:temperature.mean", apply: [] })).toBe("temperature.mean");
    expect(displayName({ id: "forcings:temperature.mean", apply: [] })).toBe("temperature.mean");
    expect(displayName({ id: "Spring-tide", apply: [] })).toBe("Spring-tide");
  });
});

describe("moon phase names ⇄ compiled range", () => {
  const P = DEFAULT_MOON_PHASES;

  test("a single phase spans to the next boundary, wrapping past the end of the cycle", () => {
    expect(moonRange(P, ["Full"])).toEqual([0.86, 0]);
    expect(moonRange(P, ["New"])).toEqual([0, 0.16]);
    expect(moonRange(P, ["Half"])).toEqual([0.42, 0.68]);
  });

  test("a contiguous run spans from its first boundary to the one after its last", () => {
    expect(moonRange(P, ["New", "Crescent"])).toEqual([0, 0.42]);
    expect(moonRange(P, ["Gibbous", "Full"])).toEqual([0.68, 0]);
    expect(moonRange(P, ["Full", "New"])).toEqual([0.86, 0.16]);
  });

  test("selecting everything is the whole cycle, never the never-matching [a, a]", () => {
    expect(moonRange(P, P.map((p) => p.name))).toEqual([0, 1]);
    expect(moonRange(P, [])).toEqual([0, 1]);
    expect(moonRange(P, ["Waning"])).toEqual([0, 1]);
  });

  test("a non-contiguous selection takes the smallest arc that covers it", () => {
    expect(moonRange(P, ["New", "Half"])).toEqual([0, 0.68]);
    // Full → New → Crescent → Half is 0.56 of the cycle; Crescent → … → New is 0.84.
    expect(moonRange(P, ["Crescent", "Full"])).toEqual([0.86, 0.42]);
  });

  test("phasesFor inverts moonRange for every contiguous selection", () => {
    const selections = [["New"], ["Crescent"], ["Half"], ["Gibbous"], ["Full"], ["New", "Crescent"], ["Gibbous", "Full"], ["Full", "New"], ["Half", "Gibbous", "Full"]];
    for (const sel of selections) expect(phasesFor(P, moonRange(P, sel))).toEqual(sel);
    expect(phasesFor(P, moonRange(P, P.map((p) => p.name)))).toEqual(P.map((p) => p.name));
  });

  test("a range whose ends miss the boundaries is a custom range", () => {
    expect(phasesFor(P, [0.88, 1.0])).toEqual([]);
    expect(phasesFor(P, [0.3, 0.42])).toEqual([]);
    expect(phasesFor(P, [0.42, 0.42])).toEqual([]);
    expect(phasesFor([], [0, 0.5])).toEqual([]);
  });

  test("[a, 1] and [a, 0] name the same arc", () => {
    expect(phasesFor(P, [0.86, 1])).toEqual(["Full"]);
    expect(phasesFor(P, [0.86, 0])).toEqual(["Full"]);
  });
});

describe("naming", () => {
  test("a device name is kept verbatim and suffixed on collision", () => {
    expect(uniqueDeviceId("Ashfall", [])).toBe("Ashfall");
    expect(uniqueDeviceId("Ashfall", ["Ashfall"])).toBe("Ashfall 2");
    expect(uniqueDeviceId("Ashfall", ["Ashfall", "Ashfall 2"])).toBe("Ashfall 3");
    expect(uniqueDeviceId("Sable Stormtide", ["Sable Stormtide", "Ashfall"])).toBe("Sable Stormtide 2");
    expect(uniqueDeviceId("   ", [])).toBe("Device");
  });
});

describe("whenSummary chips", () => {
  const chip = (when: Device["when"], spell?: SpellSpec) => whenSummary({ id: "d", name: "d", kind: "trim", enabled: true, when, apply: [], mods: [], stage: "daily", ...(spell ? { spell } : {}) });

  test("one string per kind", () => {
    expect(chip({ kind: "always" })).toBe("always");
    expect(chip({ kind: "moon", moon: "Sable", phases: ["Full"], range: [0.86, 0] })).toBe("moon:Sable · Full");
    expect(chip({ kind: "moon", moon: "Sable", phases: [], range: [0.88, 1] })).toBe("moon:Sable · custom range");
    expect(chip({ kind: "moon", moon: "Sable", phases: ["Gibbous", "Full"], range: [0.68, 0] })).toBe("moon:Sable · Gibbous, Full");
    expect(chip({ kind: "tag", tags: ["season:Harvest"] })).toBe("season:Harvest");
    expect(chip({ kind: "tag", tags: ["season:Harvest", "era:Drought"] })).toBe("season:Harvest or era:Drought");
    expect(chip({ kind: "yearWindow", start: 0.55, length: 0.12 })).toBe("days 201–245");
    expect(chip({ kind: "chance", p: 0.06 })).toBe("6 % of days");
    expect(chip({ kind: "chance", p: 0.025 })).toBe("2.5 % of days");
  });

  test("a spell is appended to whatever window carries it", () => {
    expect(chip({ kind: "yearWindow", start: 0.55, length: 0.12 }, { meanStartsPerYear: 0.6, meanDurationDays: 14 })).toBe("days 201–245 · + spell 0.6/yr · 14 d");
    expect(chip({ kind: "always" }, { meanStartsPerYear: 3, meanDurationDays: 6 })).toBe("always · + spell 3/yr · 6 d");
  });

  test("the year window is read in the calendar's own days", () => {
    expect(chip({ kind: "yearWindow", start: 0.5, length: 0.1 })).toBe("days 183–219");
    expect(whenSummary({ ...ROUND_TRIP_DEVICES[0]!, when: { kind: "yearWindow", start: 0.5, length: 0.1 } }, 100)).toBe("days 50–60");
  });
});

describe("knob ranges", () => {
  test("offsets are symmetric in the parameter's own unit", () => {
    const temp = knobSpecFor({ param: "temperature.mean", op: "offset", value: 0 });
    expect([temp.min, temp.max, temp.neutral, temp.step]).toEqual([-10, 10, 0, 0.1]);
    expect(temp.fmt(1.5)).toBe("+1.5 °C");
    expect(temp.fmt(-3)).toBe("-3.0 °C");

    const sky = knobSpecFor({ param: "cloud.dry", op: "offset", value: 0 });
    expect([sky.min, sky.max, sky.neutral, sky.step]).toEqual([-1, 1, 0, 0.01]);
    expect(sky.fmt(-0.3)).toBe("-0.30");

    const wind = knobSpecFor({ param: "wind.speed", op: "offset", value: 0 });
    expect([wind.min, wind.max, wind.step]).toEqual([-50, 50, 0.5]);
    expect(wind.fmt(12)).toBe("+12.0 km/h");
  });

  test("every scale is the same multiplier knob, neutral at ×1", () => {
    for (const param of ["precipitation.pwd", "wind.speed", "temperature.mean"]) {
      const k = knobSpecFor({ param, op: "scale", value: 1 });
      expect([k.min, k.max, k.neutral, k.step]).toEqual([0, 3, 1, 0.01]);
      expect(k.fmt(1.4)).toBe("×1.40");
    }
  });

  test("set and clamp sweep the parameter's own domain", () => {
    const p = knobSpecFor({ param: "precipitation.pwd", op: "set", value: 0 });
    expect([p.min, p.max, p.step]).toEqual([0, 1, 0.01]);
    expect(p.fmt(0.95)).toBe("0.95");

    const dir = knobSpecFor({ param: "wind.direction", op: "set", value: 0 });
    expect([dir.min, dir.max, dir.step]).toEqual([0, 360, 1]);
    expect(dir.fmt(180)).toBe("180°");

    const clamped = knobSpecFor({ param: "humidity.dry", op: "clamp", max: 0.3 });
    expect([clamped.min, clamped.max]).toEqual([0, 1]);
  });

  test("an unknown parameter still gets a usable knob", () => {
    const k = knobSpecFor({ param: "nonsense.path", op: "offset", value: 0 });
    expect(Number.isFinite(k.min) && Number.isFinite(k.max) && k.step > 0).toBe(true);
  });
});

describe("new devices", () => {
  const kinds: DeviceKind[] = ["trim", "moon", "spell", "tag", "chance"];

  test("every kind produces a valid modifier on a real zone", () => {
    const mods = kinds.map((k) => toModifier(newDevice(k, "temperature", calendar, [])));
    expect(validateProfile(zoneWith(mods)).filter((i) => i.level === "error")).toEqual([]);
  });

  test("every kind validates on every channel, with no calendar to lean on", () => {
    for (const channel of ["temperature", "precipitation", "wind", "sky"] as const) {
      const mods = kinds.map((k) => toModifier(newDevice(k, channel, null, [])));
      expect(validateProfile(zoneWith(mods)).filter((i) => i.level === "error")).toEqual([]);
    }
  });

  test("the defaults are the ones the spec names", () => {
    expect(newDevice("moon", "precipitation", calendar, []).when).toEqual({ kind: "moon", moon: "Sable", phases: ["Full"], range: [0.86, 0] });
    expect(newDevice("moon", "precipitation", null, []).when).toEqual({ kind: "moon", moon: "Moon", phases: [], range: [0.4, 0.6] });
    const spell = newDevice("spell", "precipitation", calendar, []);
    expect(spell.when).toEqual({ kind: "yearWindow", start: 0.55, length: 0.12 });
    expect(spell.spell).toEqual({ meanStartsPerYear: 0.6, meanDurationDays: 14 });
    expect(newDevice("tag", "wind", calendar, []).when).toEqual({ kind: "tag", tags: ["season:Thaw"] });
    expect(newDevice("chance", "sky", calendar, []).when).toEqual({ kind: "chance", p: 0.1 });
  });

  test("a trim has no when and so sits at the climate stage; everything else is daily", () => {
    expect(newDevice("trim", "temperature", calendar, []).stage).toBe("climate");
    for (const k of kinds.filter((k) => k !== "trim")) expect(newDevice(k, "temperature", calendar, []).stage).toBe("daily");
  });

  test("the channel decides the neutral op", () => {
    expect(defaultApplyFor("temperature")).toEqual({ param: "temperature.mean", op: "offset", value: 0 });
    expect(defaultApplyFor("precipitation")).toEqual({ param: "precipitation.pwd", op: "scale", value: 1 });
    expect(defaultApplyFor("wind")).toEqual({ param: "wind.speed", op: "scale", value: 1 });
    expect(defaultApplyFor("sky")).toEqual({ param: "cloud.dry", op: "offset", value: 0 });
    for (const channel of ["temperature", "precipitation", "wind", "sky"] as const) expect(newDevice("trim", channel, calendar, []).apply).toEqual([defaultApplyFor(channel)]);
  });

  test("names avoid collisions", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 3; i++) taken.add(newDevice("moon", "temperature", calendar, taken).id);
    expect([...taken]).toEqual(["Moon-bound", "Moon-bound 2", "Moon-bound 3"]);
  });
});

describe("shipped device presets", () => {
  test("all five are present and distinct", () => {
    expect(SHIPPED_PRESETS.map((p) => p.name)).toEqual(["Spring-tide", "Volcanic", "Drought curse", "Monsoon burst", "Föhn days"]);
  });

  test("every preset inserted into fjord-coast validates without errors", () => {
    const taken = new Set<string>();
    const mods = SHIPPED_PRESETS.map((p) => {
      const d = presetToDevice(p, calendar, taken);
      taken.add(d.id);
      return toModifier(d);
    });
    expect(validateProfile(zoneWith(mods)).filter((i) => i.level === "error")).toEqual([]);
  });

  test("every preset's modifier round-trips through the device model", () => {
    for (const p of SHIPPED_PRESETS) {
      const m = toModifier(presetToDevice(p, calendar, []));
      expect(toModifier(toDevice(m, calendar))).toEqual(m);
      expect(kindOf(m)).toBe(p.kind);
    }
  });

  test("a preset keeps the kind it declares and never carries an instance's id or tag", () => {
    for (const p of SHIPPED_PRESETS) {
      const d = presetToDevice(p, calendar, []);
      expect(d.kind).toBe(p.kind);
      expect(d.id).toBe(p.name);
      expect(d.tag).toBeUndefined();
      expect(d.stage).toBe("daily"); // all five carry a when
    }
  });

  test("a moon preset retargets to the world's own moon and its own Full", () => {
    const other: CalendarDescription = {
      ...calendar,
      moons: [{ name: "Lantern", cycleDays: 40, phases: [{ name: "New", at: 0 }, { name: "Full", at: 0.5 }] }],
    };
    const d = presetToDevice(SHIPPED_PRESETS[0]!, other, []);
    expect(d.when).toEqual({ kind: "moon", moon: "Lantern", phases: ["Full"], range: [0.5, 0] });
  });

  test("a moon preset with no calendar keeps the range it shipped with", () => {
    const d = presetToDevice(SHIPPED_PRESETS[0]!, null, []);
    expect(d.when).toEqual({ kind: "moon", moon: "Sable", phases: [], range: [0.86, 0] });
  });

  test("a moon preset falls back to the numeric range when the world's moon has no matching phase", () => {
    const other: CalendarDescription = { ...calendar, moons: [{ name: "Lantern", cycleDays: 40, phases: [{ name: "Bright", at: 0.3 }] }] };
    const d = presetToDevice(SHIPPED_PRESETS[0]!, other, []);
    expect(d.when).toEqual({ kind: "moon", moon: "Lantern", phases: [], range: [0.86, 0] });
  });

  test("presets instantiate under unique names", () => {
    const taken = new Set(["Volcanic"]);
    expect(presetToDevice(SHIPPED_PRESETS[1]!, calendar, taken).id).toBe("Volcanic 2");
  });

  test("deviceToPreset is the inverse of presetToDevice", () => {
    for (const p of SHIPPED_PRESETS) expect(deviceToPreset(presetToDevice(p, null, []), p.name)).toEqual(p);
  });

  test("saving a custom device as a preset keeps its raw predicate", () => {
    const d = toDevice(CUSTOM_MODIFIERS[0]!, calendar);
    const saved = deviceToPreset(d, "Sky-fire");
    expect(saved.when).toEqual(CUSTOM_MODIFIERS[0]!.when);
    expect(presetToDevice(saved, calendar, []).custom).toBe(true);
  });

  test("saving a rack device as a preset drops id, stage and tag but keeps gates", () => {
    const saved = deviceToPreset(ROUND_TRIP_DEVICES[1]!, "My tide");
    expect(saved).toEqual({
      name: "My tide",
      kind: "moon",
      when: { moon: { name: "Sable", phase: [0.86, 0] } },
      apply: [{ param: "precipitation.pwd", op: "scale", value: 1.4, envelope: [[0, 0], [0.5, 1]] }],
      mods: [{ source: "season:Harvest", amount: 0.5 }],
    });
  });
});

describe("year windows (`＋ add window`)", () => {
  const many: Device = {
    ...ROUND_TRIP_DEVICES[2]!,
    when: { kind: "yearWindow", start: 0.61, length: 0.11, extra: [{ start: 0.8, length: 0.05 }] },
  };

  test("one clip compiles to a bare yearPhase, several to an any of them", () => {
    expect(toModifier(ROUND_TRIP_DEVICES[2]!).when).toEqual({ yearPhase: [0.61, 0.72] });
    expect(toModifier(many).when).toEqual({
      any: [{ yearPhase: [0.61, 0.72] }, { yearPhase: [0.8, 0.85] }],
    });
  });

  test("an any of yearPhase decompiles back to the same clip list", () => {
    const round = toDevice(toModifier(many), calendar);
    expect(round.kind).toBe("spell");
    expect(round.when).toEqual(many.when);
    expect(yearWindowsOf(round.when)).toEqual([
      { start: 0.61, length: 0.11 },
      { start: 0.8, length: 0.05 },
    ]);
  });

  test("a mixed any is still a custom device", () => {
    const mixed = toDevice({ id: "m", apply: [], when: { any: [{ yearPhase: [0, 0.1] }, { tag: "era:Drought" }] } }, calendar);
    expect(mixed.custom).toBe(true);
  });

  test("several clips read as a count, one reads as its days", () => {
    expect(whenSummary(many)).toBe("2 windows · + spell 0.6/yr · 18 d");
    expect(whenSummary(ROUND_TRIP_DEVICES[2]!)).toBe("days 223–263 · + spell 0.6/yr · 18 d");
  });

  test("yearWindowsOf is empty for every other kind", () => {
    expect(yearWindowsOf({ kind: "always" })).toEqual([]);
    expect(yearWindowsOf({ kind: "chance", p: 0.1 })).toEqual([]);
  });
});

describe("onset envelopes", () => {
  test("a named shape round-trips through its own points", () => {
    for (const shape of ENVELOPE_SHAPES) expect(envelopeShapeName(envelopeShape(shape.name))).toBe(shape.name);
  });

  test("no envelope reads as none, a drawn one as custom", () => {
    expect(envelopeShapeName(undefined)).toBe("none");
    expect(envelopeShapeName([])).toBe("none");
    expect(envelopeShapeName([[0.1, 0], [0.4, 1]])).toBe("custom");
  });

  test("an unknown shape name falls back rather than throwing", () => {
    expect(envelopeShapeName(envelopeShape("nope"))).toBe("Ease in");
  });
});

describe("apply copy and the WRITES grammar", () => {
  test("a value reads with its consequence, never its name", () => {
    expect(opValueText({ param: "precipitation.pwd", op: "set", value: 0 })).toBe("0 — no rain");
    expect(opValueText({ param: "cloud.dry", op: "set", value: 0.95 })).toBe("0.95 — ash-dark");
    expect(opValueText({ param: "precipitation.pwd", op: "scale", value: 1.5 })).toBe("×1.50");
    expect(opValueText({ param: "wind.speed", op: "offset", value: 12 })).toBe("+12 km/h");
  });

  test("gate amounts read as whole percents", () => {
    expect(gatePercent(0.72)).toBe("72%");
    expect(gatePercent(1)).toBe("100%");
  });

  test("the footer is the authored grammar, not the serialised object", () => {
    expect(deviceGrammar(ROUND_TRIP_DEVICES[1]!, 0)).toBe("modifiers[0] · when.moon Sable [0.86, 0.00] · apply precipitation.pwd ×1.40 · mods 1 · envelope 1");
    expect(deviceGrammar(ROUND_TRIP_DEVICES[2]!, 1)).toBe("modifiers[1] · off · when.yearPhase [0.61, 0.72] · spell 0.6/yr 18 d · apply cloud.dry = 0.95");
    expect(deviceGrammar(ROUND_TRIP_DEVICES[0]!, 2)).toBe("modifiers[2] · stage climate · apply temperature.mean +1.5");
  });

  test("a device with nothing to apply says so rather than trailing off", () => {
    expect(deviceGrammar({ ...ROUND_TRIP_DEVICES[0]!, apply: [] }, 0)).toBe("modifiers[0] · stage climate · no apply");
  });

  test("whenPhrase covers every kind the segmented offers", () => {
    const at = (when: Device["when"]): string => whenPhrase({ ...ROUND_TRIP_DEVICES[0]!, when });
    expect(at({ kind: "always" })).toBe("stage climate");
    expect(at({ kind: "tag", tags: ["era:Drought"] })).toBe("when.tag era:Drought");
    expect(at({ kind: "tag", tags: ["season:Thaw", "era:Drought"] })).toBe("when.any tag season:Thaw, tag era:Drought");
    expect(at({ kind: "chance", p: 0.06 })).toBe("when.chance 0.06");
  });
});
