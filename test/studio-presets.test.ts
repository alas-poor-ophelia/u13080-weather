import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { validateProfile } from "../src/core/profile";
import type { Modifier, Preset, ZoneProfile } from "../src/core/types";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { MODIFIER_EXAMPLES } from "../src/plugin/modifier-examples";
import { zoneFromPreset } from "../src/plugin/zones";
import { DEFAULT_MOON_PHASES, kindOf, phasesFor, toDevice, toModifier, whenSummary } from "../src/studio/model/devices";
import { SHIPPED_PRESETS, presetToDevice } from "../src/studio/model/presets";

/**
 * wadjet-9f9.34 — "delete hand-built lanes; Stormtide/Ashfall/Neverain become
 * presets". The studio never had hand-built lanes for these three (every
 * device lane is data-driven off `spansFor` — SPEC §4 last line, PLAN D12);
 * `grep -ri "stormtide|ashfall|neverain" src/studio` finds nothing but the
 * doc comment in `presets.ts`. This file verifies the half of the bead that
 * *is* work: the shipped copy-paste examples decompile into ordinary devices,
 * and where an example and a shipped preset describe the same idea, they
 * agree.
 */

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);
const fjord = presets.find((p) => p.id === "fjord-coast")!;

function zoneWith(mods: ZoneProfile["modifiers"]): ZoneProfile {
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

describe("MODIFIER_EXAMPLES decompile into devices", () => {
  test("every example is a non-custom device, except Sky-fire's composite predicate", () => {
    for (const e of MODIFIER_EXAMPLES) {
      const d = toDevice(e.modifier, calendar);
      if (e.title === "Sky-fire (flavour only)") {
        // { all: [{ chance }, { not: { regime } }] } is a composite outside the
        // studio's five kinds (moon/spell/tag/chance/trim) — SPEC §3.4's WHEN
        // segmented control has no "all"/"not" combinator, so this is the one
        // example that legitimately falls back to `custom` and keeps its raw
        // predicate verbatim.
        expect(kindOf(e.modifier)).toBe("custom");
        expect(d.custom).toBe(true);
      } else {
        expect(d.custom).not.toBe(true);
      }
      // Every example round-trips byte-for-byte regardless of custom status.
      expect(toModifier(d)).toEqual(e.modifier);
    }
  });

  test("whenSummary produces the chip each example shows in the mixer rack", () => {
    const chips = Object.fromEntries(MODIFIER_EXAMPLES.map((e) => [e.title, whenSummary(toDevice(e.modifier, calendar), calendar.yearLength)]));
    expect(chips).toEqual({
      "Stormtide under a full moon": "moon:Sable · custom range",
      "Ashfall spells": "days 222–261 · + spell 0.6/yr · 18 d",
      "Dark-moon calm": "moon:Sable · custom range",
      "The valley where it never rains": "always",
      "Sky-fire (flavour only)": "always",
    });
    // Stormtide's and Dark-moon calm's windows ([0.88,1.0] and [0.94,0.06]) do
    // not sit on DEFAULT_MOON_PHASES boundaries (nearest is Full at 0.86), so
    // they read as "custom range" rather than a named phase — expected, see
    // the moon-phase agreement test below. Sky-fire's chip is "always" because
    // a custom device's `when` is always reported as `{ kind: "always" }`; the
    // raw `all`/`not` predicate still fires correctly (asserted in
    // modifier-examples.test.ts), it is just not summarised by this chip. Both
    // are pre-existing `devices.ts` behaviour, not something this bead changes.
  });
});

describe("shipped presets stay consistent with the examples they were borrowed from", () => {
  test("every shipped preset inserted into fjord-coast validates without errors", () => {
    const taken = new Set<string>();
    const mods = SHIPPED_PRESETS.map((p) => {
      const d = presetToDevice(p, calendar, taken);
      taken.add(d.id);
      return toModifier(d);
    });
    expect(validateProfile(zoneWith(mods)).filter((i) => i.level === "error")).toEqual([]);
  });

  test("all five presets alongside all five examples validate together in one zone", () => {
    const taken = new Set<string>();
    const presetMods = SHIPPED_PRESETS.map((p) => {
      const d = presetToDevice(p, calendar, taken);
      taken.add(d.id);
      return toModifier(d);
    });
    const exampleMods: Modifier[] = MODIFIER_EXAMPLES.map((e) => e.modifier);
    expect(validateProfile(zoneWith([...presetMods, ...exampleMods])).filter((i) => i.level === "error")).toEqual([]);
  });

  test("Stormtide (example) and Spring-tide (preset) both target the Full arc, but Stormtide is authored as a tighter 'near full' window inside it", () => {
    const stormtide = MODIFIER_EXAMPLES[0]!;
    expect(stormtide.title).toBe("Stormtide under a full moon");
    const stormtideWhen = stormtide.modifier.when as { moon: { name: string; phase: [number, number] } };
    expect(stormtideWhen.moon.name).toBe("Sable");

    const springTide = SHIPPED_PRESETS[0]!;
    expect(springTide.name).toBe("Spring-tide");
    const springTideWhen = springTide.when as { moon: { name: string; phase: [number, number] } };

    // Spring-tide is written exactly on the phase boundary and names "Full".
    expect(phasesFor(DEFAULT_MOON_PHASES, springTideWhen.moon.phase)).toEqual(["Full"]);
    // Stormtide's [0.88, 1.0] does NOT sit on that boundary (Full starts at
    // 0.86) — it does not resolve to a named phase, it is a custom range.
    expect(phasesFor(DEFAULT_MOON_PHASES, stormtideWhen.moon.phase)).toEqual([]);
    // But it is a strict subset of the Full arc [0.86, 1.0): both examples
    // agree on which arc of the cycle "full moon weather" lives in, Stormtide
    // is just narrower — consistent with its blurb ("near full"), not a bug.
    const fullPhase = DEFAULT_MOON_PHASES.find((p) => p.name === "Full")!;
    expect(stormtideWhen.moon.phase[0]).toBeGreaterThanOrEqual(fullPhase.at);
    // Both windows end at the same point in the cycle: Stormtide's `1.0` and
    // Spring-tide's wrapped `0` are the same instant (new moon / cycle start).
    expect(stormtideWhen.moon.phase[1] % 1).toBe(springTideWhen.moon.phase[1] % 1);
  });

  test("Ashfall (example) and Volcanic (preset) share the same when-shape and spell; Volcanic adds one op", () => {
    const ashfall = MODIFIER_EXAMPLES[1]!;
    expect(ashfall.title).toBe("Ashfall spells");
    const volcanic = SHIPPED_PRESETS[1]!;
    expect(volcanic.name).toBe("Volcanic");

    // Same predicate shape (both a yearPhase window), same spell cadence.
    expect("yearPhase" in ashfall.modifier.when!).toBe(true);
    expect("yearPhase" in volcanic.when!).toBe(true);
    expect(ashfall.modifier.when).toEqual(volcanic.when);
    expect(ashfall.modifier.spell).toEqual(volcanic.spell);

    // Values: Volcanic is documented (presets.ts) as "Ashfall with a
    // temperature drop" — assert that relationship rather than assuming
    // byte-identical apply arrays.
    console.log("Ashfall apply:", JSON.stringify(ashfall.modifier.apply));
    console.log("Volcanic apply:", JSON.stringify(volcanic.apply));
    const tempOps = volcanic.apply.filter((op) => op.param === "temperature.mean");
    const nonTempOps = volcanic.apply.filter((op) => op.param !== "temperature.mean");
    expect(tempOps).toEqual([{ param: "temperature.mean", op: "offset", value: -3 }]);
    expect(nonTempOps).toEqual(ashfall.modifier.apply);
  });

  test("Drought curse (preset) matches the era-tag shape used by 'the valley where it never rains' example's neighbours in kind, not value", () => {
    // The Drought curse preset (`tag: era:Drought`) has no example counterpart
    // among MODIFIER_EXAMPLES — "the valley where it never rains" is a
    // climate-stage `trim` device instead, so there is no cross-check to make
    // here beyond both being legal, non-custom devices.
    const drought = SHIPPED_PRESETS[2]!;
    expect(drought.name).toBe("Drought curse");
    expect(kindOf({ id: "x", stage: "daily", when: drought.when!, apply: drought.apply })).toBe("tag");
  });
});
