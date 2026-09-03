/**
 * The pure half of the Regimes window's `preset ▾`
 * (`src/studio/model/regime-presets.ts`).
 *
 * Three rules carry the control:
 *
 *  - **The pill names the set the zone is on.** A zone copied from a station
 *    record still holds that record's states, so it reads `Fjord Coast`; one
 *    knob later it reads `custom`; once a saved set is loaded it reads that
 *    set's name. The zone's OWN base record wins over any other record that
 *    happens to ship the same states — and today every record does, so that
 *    precedence is the only thing that keeps the pill honest.
 *  - **Equality is by value.** A set that came back through the JSON drawer has
 *    the same fields in a different order and must still count as the same set.
 *  - **Loading and saving both copy.** No shipped record and no saved set may
 *    ever share an object with the zone's live draft.
 */
import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Preset, Regime, ZoneProfile } from "../src/core/types";
import type { RegimePreset } from "../src/plugin/settings";
import { CUSTOM_SET, currentSetName, loadRegimeSet, regimeSetByName, regimeSetsOffered, regimeSetSub, regimesEqual, saveRegimeSet } from "../src/studio/model/regime-presets";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
const desert = (await Bun.file(new URL("../presets/red-desert.json", import.meta.url)).json()) as Preset;

/** A set nothing ships, so a test can tell "loaded" from "still the base". */
const HOUSE: Regime[] = [
  { id: "calm", weight: 1, meanDurationDays: 5 },
  { id: "gale", weight: 0.2, meanDurationDays: 3, apply: [{ param: "wind.speed", op: "scale", value: 1.6 }] },
];

function zone(): ZoneProfile {
  return {
    id: "bergen",
    name: "Bergen",
    schemaVersion: 1,
    preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers: [],
  };
}

function world(regimePresets: RegimePreset[] = []): { regimePresets: RegimePreset[] } {
  return { regimePresets };
}

/** The same states, written with the keys in a different order — a JSON round-trip. */
function reordered(regimes: readonly Regime[]): Regime[] {
  return regimes.map((r) => {
    const flipped: Record<string, unknown> = {};
    for (const k of Object.keys(r).reverse()) flipped[k] = (r as unknown as Record<string, unknown>)[k];
    return flipped as unknown as Regime;
  });
}

describe("studio · regime presets · the offered sets", () => {
  test("the shipped records are grouped by content, and the world's own follow badged yours", () => {
    const mine: RegimePreset = { name: "House states", regimes: structuredClone(HOUSE) };
    const offered = regimeSetsOffered(world([mine]));

    // Every station record ships the SAME three states today — what a record
    // curates is the climate — so the shipped half collapses to one option
    // rather than 26 identical ones.
    const shipped = offered.filter((s) => !s.yours);
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped.length).toBe(new Set(shipped.map((s) => JSON.stringify(s.regimes))).size);
    // Shipped first, the user's last (SPEC §3.6's order).
    expect(offered.filter((s) => s.yours).map((s) => s.name)).toEqual(["House states"]);
    expect(offered[offered.length - 1]!.name).toBe("House states");
    // Every entry carries real states, so the `N states` sub is never a guess.
    expect(offered.every((s) => s.regimes.length > 0)).toBe(true);
  });

  test("a group speaks under the zone's OWN record's name when the zone is in it", () => {
    const bergen = zone();
    const dune = zone();
    dune.preset = { id: desert.id, contentHash: desert.contentHash, matched: "manual" };

    expect(regimeSetsOffered(world(), bergen).some((s) => s.name === fjord.name)).toBe(true);
    expect(regimeSetsOffered(world(), dune).some((s) => s.name === desert.name)).toBe(true);
    // …and the pill's reading is always one of the offered names, so the
    // `<select>` can never be left sitting on an option that is not there.
    for (const z of [bergen, dune]) expect(regimeSetsOffered(world(), z).map((s) => s.name)).toContain(currentSetName(z, world()));
  });

  test("the sub is the state count, singular at one", () => {
    expect(regimeSetSub({ regimes: fjord.regimes })).toBe(`${fjord.regimes.length} states`);
    expect(regimeSetSub({ regimes: [{ id: "normal", weight: 1, meanDurationDays: 4 }] })).toBe("1 state");
  });

  test("a set can be found back by the name it was offered under", () => {
    const mine: RegimePreset = { name: "House states", regimes: structuredClone(HOUSE) };
    expect(regimeSetByName(world([mine]), "House states")?.yours).toBe(true);
    expect(regimeSetByName(world(), fjord.name, zone())?.regimes).toEqual(fjord.regimes);
    expect(regimeSetByName(world(), "nothing named this")).toBe(null);
  });
});

describe("studio · regime presets · equality", () => {
  test("key order does not change a set's identity", () => {
    expect(regimesEqual(fjord.regimes, reordered(fjord.regimes))).toBe(true);
    expect(regimesEqual(fjord.regimes, structuredClone(fjord.regimes))).toBe(true);
  });

  test("a different value, a different order of states, or a missing state all break equality", () => {
    const changed = structuredClone(fjord.regimes);
    changed[0]!.weight = changed[0]!.weight + 0.01;
    expect(regimesEqual(fjord.regimes, changed)).toBe(false);
    expect(regimesEqual(fjord.regimes, [...fjord.regimes].reverse())).toBe(false);
    expect(regimesEqual(fjord.regimes, fjord.regimes.slice(1))).toBe(false);
    expect(regimesEqual(fjord.regimes, HOUSE)).toBe(false);
  });
});

describe("studio · regime presets · the name the pill wears", () => {
  test("a freshly copied zone reads its base record's name", () => {
    expect(currentSetName(zone(), world())).toBe(fjord.name);
  });

  test("one edited value reads custom", () => {
    const z = zone();
    z.regimes[0]!.meanDurationDays += 3;
    expect(currentSetName(z, world())).toBe(CUSTOM_SET);
  });

  test("key order alone never reads custom", () => {
    const z = zone();
    z.regimes = reordered(z.regimes);
    expect(currentSetName(z, world())).toBe(fjord.name);
  });

  test("a user set is consulted before the shipped list once the base no longer matches", () => {
    const z = zone();
    const mine: RegimePreset = { name: "House states", regimes: structuredClone(HOUSE) };
    loadRegimeSet(z, HOUSE);
    expect(currentSetName(z, world([mine]))).toBe("House states");
    // Nothing knows these states without the user's set: the pill says so.
    expect(currentSetName(z, world())).toBe(CUSTOM_SET);
  });

  test("the zone's own base record wins over a user set that copies it", () => {
    const copycat: RegimePreset = { name: "Copy of Bergen", regimes: structuredClone(fjord.regimes) };
    expect(currentSetName(zone(), world([copycat]))).toBe(fjord.name);
  });

  test("a zone with no base record still names a shipped set it happens to match", () => {
    const z = zone();
    delete z.preset;
    expect(currentSetName(z, world())).toBe(regimeSetsOffered(world(), z)[0]!.name);
  });
});

describe("studio · regime presets · load", () => {
  test("loading replaces regimes[] wholesale and leaves a valid draft", () => {
    const z = zone();
    const mine: RegimePreset = { name: "House states", regimes: structuredClone(HOUSE) };
    expect(loadRegimeSet(z, mine.regimes)).toBe(true);
    expect(z.regimes.map((r) => r.id)).toEqual(["calm", "gale"]);
    expect(validateProfile(z).filter((i) => i.level === "error")).toEqual([]);
    expect(currentSetName(z, world([mine]))).toBe("House states");
  });

  test("the loaded states are a copy, ops included — editing the draft never touches the set", () => {
    const z = zone();
    const was = structuredClone(HOUSE);
    loadRegimeSet(z, HOUSE);
    z.regimes[0]!.weight = 0.999;
    // The nested `apply` is cloned too, not shared by reference.
    expect(z.regimes[1]!.apply).not.toBe(HOUSE[1]!.apply);
    z.regimes[1]!.apply!.push({ param: "temperature.mean", op: "offset", value: 9 });
    expect(HOUSE).toEqual(was);
  });

  test("an empty set is refused: a zone keeps at least one state (SPEC §6)", () => {
    const z = zone();
    expect(loadRegimeSet(z, [])).toBe(false);
    expect(z.regimes).toEqual(fjord.regimes);
  });

  test("the zone's other fields are untouched — this is a state set, not a re-base", () => {
    const z = zone();
    const climate = structuredClone(z.climate);
    loadRegimeSet(z, HOUSE);
    expect(z.climate).toEqual(climate);
    // `zone.preset` still points at the record the zone was COPIED from; only
    // the pill's reading moves, because the states no longer match it.
    expect(z.preset?.id).toBe(fjord.id);
  });
});

describe("studio · regime presets · save", () => {
  test("saving writes a named copy of the zone's states into the world draft", () => {
    const w = world();
    const z = zone();
    const saved = saveRegimeSet(w, z, "House states");

    expect(saved?.name).toBe("House states");
    expect(w.regimePresets).toHaveLength(1);
    expect(w.regimePresets[0]!.regimes).toEqual(z.regimes);
    // A copy: the saved set must not move when the zone is edited next.
    z.regimes[0]!.weight = 0.42;
    expect(w.regimePresets[0]!.regimes[0]!.weight).not.toBe(0.42);
  });

  test("the saved set is offered back, and the pill reads its name at once", () => {
    const w = world();
    const z = zone();
    z.regimes[0]!.meanDurationDays += 3;
    expect(currentSetName(z, w)).toBe(CUSTOM_SET);
    saveRegimeSet(w, z, "House states");
    expect(currentSetName(z, w)).toBe("House states");
    expect(regimeSetsOffered(w, z).some((s) => s.name === "House states" && s.yours)).toBe(true);
  });

  test("a name already taken is suffixed rather than shadowing the set it collides with", () => {
    const w = world();
    const z = zone();
    saveRegimeSet(w, z, "House states");
    z.regimes[0]!.weight += 0.05;
    expect(saveRegimeSet(w, z, "House states")?.name).toBe("House states-2");
    // A shipped record's name and the reserved reading are taken too.
    expect(saveRegimeSet(w, z, fjord.name)?.name).toBe(`${fjord.name}-2`);
    expect(saveRegimeSet(w, z, desert.name)?.name).toBe(`${desert.name}-2`);
    expect(saveRegimeSet(w, z, CUSTOM_SET)?.name).toBe(`${CUSTOM_SET}-2`);
  });

  test("a blank name writes nothing", () => {
    const w = world();
    expect(saveRegimeSet(w, zone(), "   ")).toBe(null);
    expect(w.regimePresets).toEqual([]);
  });
});
