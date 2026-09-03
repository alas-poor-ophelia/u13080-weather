/**
 * The mixer rail's model (SPEC §3.3): chain projection, per-chain mute and the
 * unit cards. The rail's DOM is `src/studio/ui/mixer.ts`; everything asserted
 * here is what that file paints and what its LEDs write.
 *
 * Two contracts the rest of the studio depends on and that are checked in both
 * directions: a mute is a real `enabled: false` in the zone file (never a UI
 * flag), and a muted zone still validates — the studio must never write a draft
 * Save cannot accept.
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Era, Modifier, Preset, ZoneProfile } from "../src/core/types";
import { TRIM_ID, WARMTH_LANE_ID, WETNESS_ID } from "../src/studio/model/compile";
import {
  CHAIN_COLOR_VAR,
  CHAIN_LABEL,
  CHAINS,
  chainOps,
  chainsOf,
  eraNameOf,
  fixedStripFor,
  forcingsIdFor,
  forcingsMutedInChain,
  isEraUnit,
  isMutedInChain,
  regimesMutedInChain,
  reorderInChain,
  setChainMute,
  setForcingsChainMute,
  setRegimesChainMute,
  unitsFor,
} from "../src/studio/model/mixer";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(modifiers: Modifier[] = []): ZoneProfile {
  return {
    id: "greywold",
    name: "Greywold",
    schemaVersion: 1,
    preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers,
  };
}

/** A device that writes to two chains at once — the ⧉ linked twin. */
function linked(id = "stormtide"): Modifier {
  return {
    id,
    when: { tag: "season:Winter" },
    apply: [
      { param: "temperature.mean", op: "offset", value: -2 },
      { param: "precipitation.pww", op: "scale", value: 1.4 },
      { param: "wind.speed", op: "scale", value: 1.2 },
    ],
  };
}

/** A device with everything in one chain — its LED is device power. */
function single(id = "heatwave"): Modifier {
  return { id, when: { tag: "season:Summer" }, apply: [{ param: "temperature.mean", op: "offset", value: 3 }] };
}

/** A PRECIP-only device — never touched by a TEMP-chain reorder. */
function precipOnly(id: string): Modifier {
  return { id, when: { tag: "season:Autumn" }, apply: [{ param: "precipitation.pww", op: "scale", value: 1.1 }] };
}

const errors = (z: ZoneProfile): string[] => validateProfile(z).filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`);

const slots = (cards: ReadonlyArray<{ slot: string }>): string[] => cards.map((c) => c.slot);
const ids = (cards: ReadonlyArray<{ id: string }>): string[] => cards.map((c) => c.id);

describe("mixer chains", () => {
  test("the rail is the four channels, labelled and coloured from the palette", () => {
    expect([...CHAINS]).toEqual(["temperature", "precipitation", "wind", "sky"]);
    expect(CHAINS.map((c) => CHAIN_LABEL[c])).toEqual(["TEMP", "PRECIP", "WIND", "SKY"]);
    for (const c of CHAINS) expect(CHAIN_COLOR_VAR[c]).toBe(`var(--wadjet-studio-${c === "temperature" ? "temp" : c === "precipitation" ? "precip" : c})`);
  });

  test("chainOps picks the ops of one channel; humidity and cloud are both SKY", () => {
    const m: Modifier = {
      id: "d",
      apply: [
        { param: "temperature.mean", op: "offset", value: 1 },
        { param: "cloud.dry", op: "offset", value: 0.1 },
        { param: "humidity.wet", op: "offset", value: 0.1 },
        { param: "nonsense.path", op: "offset", value: 1 },
      ],
    };
    expect(chainOps(m, "temperature").map((o) => o.param)).toEqual(["temperature.mean"]);
    expect(chainOps(m, "sky").map((o) => o.param)).toEqual(["cloud.dry", "humidity.wet"]);
    expect(chainOps(m, "wind")).toEqual([]);
    // An op on a path with no channel belongs to none of them and is never lost twice.
    expect([...chainsOf(m)]).toEqual(["temperature", "sky"]);
  });

  test("isMutedInChain needs at least one op, and every one of them off", () => {
    const m = linked();
    expect(isMutedInChain(m, "temperature")).toBe(false);
    expect(isMutedInChain(m, "sky")).toBe(false); // writes nothing here
    m.apply[0]!.enabled = false;
    expect(isMutedInChain(m, "temperature")).toBe(true);
    expect(isMutedInChain(m, "precipitation")).toBe(false);
  });
});

describe("per-chain mute", () => {
  test("a linked device is muted op by op, and only in the chain that was clicked", () => {
    const z = zone([linked()]);
    setChainMute(z, "stormtide", "temperature", true);
    const m = z.modifiers[0]!;
    expect(m.apply.map((o) => o.enabled)).toEqual([false, undefined, undefined]);
    // Device power is untouched: the device still runs, just not into TEMP.
    expect(m.enabled).toBeUndefined();
    expect(isMutedInChain(m, "temperature")).toBe(true);
    expect(isMutedInChain(m, "precipitation")).toBe(false);
    expect(errors(z)).toEqual([]);

    setChainMute(z, "stormtide", "temperature", false);
    expect(m.apply.map((o) => o.enabled)).toEqual([undefined, undefined, undefined]);
    expect("enabled" in m.apply[0]!).toBe(false);
  });

  test("a single-chain device's LED is device power (SPEC 3.3)", () => {
    const z = zone([single()]);
    setChainMute(z, "heatwave", "temperature", true);
    const m = z.modifiers[0]!;
    expect(m.enabled).toBe(false);
    expect(m.apply[0]!.enabled).toBeUndefined();
    expect(errors(z)).toEqual([]);

    setChainMute(z, "heatwave", "temperature", false);
    expect("enabled" in m).toBe(false);
  });

  test("a chain the device does not write to, and an unknown id, are no-ops", () => {
    const z = zone([single()]);
    const before = JSON.stringify(z.modifiers);
    setChainMute(z, "heatwave", "wind", true);
    setChainMute(z, "nobody", "temperature", true);
    expect(JSON.stringify(z.modifiers)).toBe(before);
  });

  test("regimes mute round-trips per chain and the draft still validates", () => {
    const z = zone();
    // fjord's states write to PRECIP and TEMP; the mute must split them.
    expect(regimesMutedInChain(z, "precipitation")).toBe(false);
    setRegimesChainMute(z, "precipitation", true);
    expect(regimesMutedInChain(z, "precipitation")).toBe(true);
    expect(regimesMutedInChain(z, "temperature")).toBe(false);
    for (const r of z.regimes) {
      for (const o of r.apply ?? []) {
        if (o.param.startsWith("precipitation.")) expect(o.enabled).toBe(false);
        else expect(o.enabled).toBeUndefined();
      }
    }
    expect(errors(z)).toEqual([]);

    setRegimesChainMute(z, "precipitation", false);
    expect(regimesMutedInChain(z, "precipitation")).toBe(false);
    expect(JSON.stringify(z.regimes)).toBe(JSON.stringify(fjord.regimes));
  });

  test("a chain with no regime ops is never 'muted' and mutes nothing", () => {
    const z = zone();
    expect(regimesMutedInChain(z, "wind")).toBe(false);
    const before = JSON.stringify(z.regimes);
    setRegimesChainMute(z, "wind", true);
    expect(regimesMutedInChain(z, "wind")).toBe(false);
    expect(JSON.stringify(z.regimes)).toBe(before);
  });

  test("forcings mute is TEMP → trim, PRECIP → wetness, nothing elsewhere", () => {
    expect(forcingsIdFor("temperature")).toBe(TRIM_ID);
    expect(forcingsIdFor("precipitation")).toBe(WETNESS_ID);
    expect(forcingsIdFor("wind")).toBeNull();
    expect(forcingsIdFor("sky")).toBeNull();

    const z = zone([
      { id: TRIM_ID, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1.5 }] },
      {
        id: WETNESS_ID,
        stage: "climate",
        apply: [
          { param: "precipitation.pww", op: "scale", value: 1.2 },
          { param: "precipitation.pwd", op: "scale", value: 1.2 },
        ],
      },
    ]);

    setForcingsChainMute(z, "temperature", true);
    expect(forcingsMutedInChain(z, "temperature")).toBe(true);
    expect(forcingsMutedInChain(z, "precipitation")).toBe(false);
    expect(z.modifiers[0]!.apply[0]!.enabled).toBe(false);
    expect(errors(z)).toEqual([]);

    setForcingsChainMute(z, "precipitation", true);
    expect(z.modifiers[1]!.apply.map((o) => o.enabled)).toEqual([false, false]);
    expect(errors(z)).toEqual([]);

    setForcingsChainMute(z, "temperature", false);
    setForcingsChainMute(z, "precipitation", false);
    expect(forcingsMutedInChain(z, "temperature")).toBe(false);
    expect(z.modifiers.flatMap((m) => m.apply).every((o) => !("enabled" in o))).toBe(true);

    // A chain with no forcings slot at all.
    setForcingsChainMute(z, "wind", true);
    expect(forcingsMutedInChain(z, "wind")).toBe(false);
  });

  test("forcings that are not in the zone are not 'muted' either", () => {
    const z = zone();
    expect(forcingsMutedInChain(z, "temperature")).toBe(false);
    setForcingsChainMute(z, "temperature", true);
    expect(z.modifiers).toEqual([]);
  });
});

describe("the fixed strip", () => {
  test("regimes appear in all four chains, forcings only in TEMP and PRECIP", () => {
    const z = zone();
    for (const chain of CHAINS) {
      const strip = fixedStripFor(z, chain, 0);
      expect(strip.regimes.count).toBe(fjord.regimes.length);
      if (chain === "temperature" || chain === "precipitation") expect(strip.forcings).not.toBeNull();
      else expect(strip.forcings).toBeNull();
    }
  });

  test("the TEMP total is trim plus the warmth lane at the window's centre year", () => {
    const z = zone([{ id: TRIM_ID, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 0.5 }] }]);
    z.automation = [
      {
        id: WARMTH_LANE_ID,
        param: "temperature.mean",
        op: "offset",
        points: [
          [1000, 0],
          [2000, 2],
        ],
      },
    ];
    expect(fixedStripFor(z, "temperature", 1000).forcings!.total).toBeCloseTo(0.5, 10);
    expect(fixedStripFor(z, "temperature", 1500).forcings!.total).toBeCloseTo(1.5, 10);
    expect(fixedStripFor(z, "temperature", 2000).forcings!.total).toBeCloseTo(2.5, 10);
    // Outside the lane the value is clamped, never extrapolated.
    expect(fixedStripFor(z, "temperature", 9000).forcings!.total).toBeCloseTo(2.5, 10);
    expect(fixedStripFor(z, "temperature", 0).forcings!.present).toBe(true);
    expect(errors(z)).toEqual([]);
  });

  test("PRECIP shows the wetness factor, and a zone with none reads neutral and absent", () => {
    const bare = zone();
    expect(fixedStripFor(bare, "precipitation", 0)).toEqual({ regimes: { count: 3, mutedInChain: false }, forcings: { present: false, total: 1, mutedInChain: false } });
    expect(fixedStripFor(bare, "temperature", 0).forcings).toEqual({ present: false, total: 0, mutedInChain: false });

    const wet = zone([
      {
        id: WETNESS_ID,
        stage: "climate",
        apply: [
          { param: "precipitation.pww", op: "scale", value: 1.25 },
          { param: "precipitation.pwd", op: "scale", value: 1.25 },
        ],
      },
    ]);
    expect(fixedStripFor(wet, "precipitation", 0).forcings).toEqual({ present: true, total: 1.25, mutedInChain: false });
  });

  test("the strip reports the chain's own mute state", () => {
    const z = zone([{ id: TRIM_ID, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }]);
    setRegimesChainMute(z, "precipitation", true);
    setForcingsChainMute(z, "temperature", true);
    expect(fixedStripFor(z, "precipitation", 0).regimes.mutedInChain).toBe(true);
    expect(fixedStripFor(z, "temperature", 0).regimes.mutedInChain).toBe(false);
    expect(fixedStripFor(z, "temperature", 0).forcings!.mutedInChain).toBe(true);
  });
});

describe("unit cards", () => {
  const eras: Era[] = [
    { name: "Long Winter", from: 400, to: 900, apply: [{ param: "temperature.mean", op: "offset", value: -1.5 }] },
    { name: "Doldrums", from: 1200, apply: [{ param: "wind.speed", op: "scale", value: 0.7 }] },
    { name: "Quiet Age", from: 50, to: 60 },
  ];

  test("devices come in modifiers order, then eras, in one slot sequence", () => {
    const z = zone([single("alpha"), linked("bravo"), single("charlie")]);
    const cards = unitsFor(z, eras, "temperature", null, 4);
    expect(ids(cards)).toEqual(["alpha", "bravo", "charlie", "era:Long Winter"]);
    // An era is appended, never numbered into the rack it cannot be dragged in.
    expect(slots(cards)).toEqual(["01", "02", "03", "E"]);
  });

  test("a device in several chains is linked; one in a single chain is not", () => {
    const z = zone([single("alpha"), linked("bravo")]);
    const temp = unitsFor(z, [], "temperature", null, 1);
    expect(temp.map((c) => c.linked)).toEqual([false, true]);
    // The linked device is the only card in WIND, and takes slot 01 there.
    const wind = unitsFor(z, [], "wind", null, 1);
    expect(ids(wind)).toEqual(["bravo"]);
    expect(slots(wind)).toEqual(["01"]);
    expect(wind[0]!.linked).toBe(true);
  });

  test("an era unit carries the world badge, no drag, and its own unit key", () => {
    const z = zone();
    const cards = unitsFor(z, eras, "wind", null, 7);
    expect(ids(cards)).toEqual(["era:Doldrums"]);
    const era = cards[0]!;
    expect(isEraUnit(era)).toBe(true);
    expect(era.name).toBe("Doldrums");
    expect(era.kind).toBe("era");
    expect(era.slot).toBe("E");
    expect(era.world).toBe(7);
    expect(era.reorderable).toBe(false);
    expect(era.chips[0]!.label).toBe("1200 – ∞");
    expect(era.chips[1]!.label).toBe("wind ×0.70");
    // An era with no ops on this channel is not a unit at all.
    expect(unitsFor(z, eras, "sky", null, 7)).toEqual([]);
  });

  test("layer: and forcings: modifiers are never units", () => {
    const z = zone([
      { id: "layer:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] },
      { id: TRIM_ID, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] },
      single("alpha"),
    ]);
    expect(ids(unitsFor(z, [], "temperature", null, 1))).toEqual(["alpha"]);
  });

  test("a card carries the when summary, the chain's ops and its power state", () => {
    const z = zone([linked("bravo")]);
    setChainMute(z, "bravo", "precipitation", true);
    const [card] = unitsFor(z, [], "precipitation", null, 1);
    expect(card!.kind).toBe("tag");
    expect(card!.enabled).toBe(true);
    expect(card!.mutedInChain).toBe(true);
    expect(card!.reorderable).toBe(true);
    expect(card!.world).toBeUndefined();
    expect(card!.chips.map((c) => c.label)).toEqual(["season:Winter", "precip ×1.40"]);
    // A muted op loses the chain colour, so the card reads as "declared, off".
    expect(card!.chips[1]!.color).toBeUndefined();
    expect(unitsFor(z, [], "temperature", null, 1)[0]!.chips[1]!.color).toBe(CHAIN_COLOR_VAR.temperature);
  });

  test("a chip speaks product copy: the macro name for a moon device, the apply word for the rest", () => {
    const z = zone([
      { id: "storm", when: { moon: { name: "Sable", phase: [0.9, 1] } }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5 }] },
      { id: "ash", when: { yearPhase: [0.6, 0.72] }, apply: [{ param: "cloud.dry", op: "set", value: 0.95 }] },
    ]);
    expect(unitsFor(z, [], "precipitation", null, 1)[0]!.chips[1]!.label).toBe("storm odds ×1.50");
    expect(unitsFor(z, [], "sky", null, 1)[0]!.chips[1]!.label).toBe("sky 0.95 — ash-dark");
    // The rail's when chip is the gate alone, short enough for a card — and it
    // reads `format.ts`'s day range, so it says exactly what the playlist
    // caption and the device window say about the same clip (bead
    // wadjet-9f9.48.2; it used to floor the start and print `d219–261`).
    expect(unitsFor(z, [], "sky", null, 1)[0]!.chips[0]!.label).toBe("clip d219–263");
    // The device name is product copy, never the modifier id.
    expect(unitsFor(z, [], "precipitation", null, 1)[0]!.name).toBe("Storm");
  });

  test("eraNameOf recovers world.eras[i].name from an era unit's id", () => {
    const z = zone();
    const [card] = unitsFor(z, eras, "wind", null, 1);
    expect(eraNameOf(card!)).toBe("Doldrums");
  });
});

describe("device drag-reorder", () => {
  test("reordering within TEMP leaves PRECIP-only devices in the same relative order", () => {
    const z = zone([single("t1"), precipOnly("p1"), single("t2"), precipOnly("p2"), single("t3")]);
    // TEMP-local order is t1, t2, t3 (slots 0,1,2); drag t1 to the end.
    reorderInChain(z, "temperature", 0, 2);
    expect(unitsFor(z, [], "temperature", null, 1).map((c) => c.id)).toEqual(["t2", "t3", "t1"]);
    // PRECIP never saw a drag: its two devices keep their own order.
    expect(unitsFor(z, [], "precipitation", null, 1).map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(errors(z)).toEqual([]);
  });

  test("dragging a card back onto its own slot is a no-op", () => {
    const z = zone([single("t1"), single("t2"), single("t3")]);
    const before = JSON.stringify(z.modifiers);
    reorderInChain(z, "temperature", 1, 1);
    expect(JSON.stringify(z.modifiers)).toBe(before);
  });

  test("an out-of-range slot is clamped, not a crash", () => {
    const z = zone([single("t1"), single("t2")]);
    reorderInChain(z, "temperature", 0, 99);
    expect(unitsFor(z, [], "temperature", null, 1).map((c) => c.id)).toEqual(["t2", "t1"]);
    reorderInChain(z, "temperature", 5, 0); // fromSlot out of range: no-op
    expect(unitsFor(z, [], "temperature", null, 1).map((c) => c.id)).toEqual(["t2", "t1"]);
  });

  test("layer: and forcings: modifiers keep their normaliseOrder positions across a reorder", () => {
    const z = zone([
      { id: "layer:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] },
      single("t1"),
      single("t2"),
      { id: TRIM_ID, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] },
      single("t3"),
      { id: WETNESS_ID, stage: "climate", apply: [{ param: "precipitation.pww", op: "scale", value: 1 }] },
    ]);
    const before = z.modifiers.map((m) => m.id);
    reorderInChain(z, "temperature", 0, 2); // t1 -> after t3
    const after = z.modifiers.map((m) => m.id);
    // Every non-device id kept its own index in modifiers[] (PLAN §2.3).
    before.forEach((id, i) => {
      if (id === "layer:temperature.mean" || id === TRIM_ID || id === WETNESS_ID) expect(after[i]).toBe(id);
    });
    expect(unitsFor(z, [], "temperature", null, 1).map((c) => c.id)).toEqual(["t2", "t3", "t1"]);
    expect(errors(z)).toEqual([]);
  });

  test("a chain with only one device has nothing to reorder against", () => {
    const z = zone([single("lonely"), precipOnly("p1")]);
    const before = JSON.stringify(z.modifiers);
    reorderInChain(z, "temperature", 0, 0);
    expect(JSON.stringify(z.modifiers)).toBe(before);
  });
});
