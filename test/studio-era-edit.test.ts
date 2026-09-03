/**
 * `src/studio/model/era-edit.ts` — pure edits over `world.eras`, held against
 * the real validator (`validateEras`) so every edit is proven to leave a
 * legal draft, and `renameEra`'s rewrite of zone predicates/gates held
 * against `src/core/eras.ts`'s own `ERA_TAG_PREFIX`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { validateEras } from "../src/core/eras";
import type { Modifier, Preset, ZoneProfile } from "../src/core/types";
import { zoneFromPreset } from "../src/plugin/zones";
import { addEra, addOp, removeEra, removeOp, renameEra, setEnabled, setOpEnabled, setOpValue, setSpan } from "../src/studio/model/era-edit";
import type { WorldDraft } from "../src/studio/model/state";

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

function world(): WorldDraft {
  return { eras: [], calendar: { seasons: [], moons: [] }, devicePresets: [], regimePresets: [], overrides: [] };
}

function errors(w: WorldDraft) {
  return validateEras(w.eras).filter((i) => i.level === "error");
}

describe("era-edit · addEra", () => {
  test("names are unique and numbered, and the draft stays clean", () => {
    const w = world();
    const a = addEra(w, 100, 200);
    const b = addEra(w, 300);
    expect(a).toBe("Era 1");
    expect(b).toBe("Era 2");
    expect(w.eras).toEqual([
      { name: "Era 1", from: 100, to: 200 },
      { name: "Era 2", from: 300 },
    ]);
    expect(errors(w)).toEqual([]);
  });

  test("an open-ended era carries no `to`", () => {
    const w = world();
    addEra(w, 50);
    expect(w.eras[0]!.to).toBeUndefined();
    expect(errors(w)).toEqual([]);
  });

  test("a `to` before `from` is clamped up to `from`, never left invalid", () => {
    const w = world();
    addEra(w, 500, 100);
    expect(w.eras[0]).toEqual({ name: "Era 1", from: 500, to: 500 });
    expect(errors(w)).toEqual([]);
  });

  test("skips an already-taken \"Era N\" name (e.g. a hand-authored era)", () => {
    const w = world();
    w.eras.push({ name: "Era 1", from: 0 });
    const name = addEra(w, 10);
    expect(name).toBe("Era 2");
    expect(errors(w)).toEqual([]);
  });
});

describe("era-edit · setSpan / setEnabled / removeEra", () => {
  test("setSpan rewrites from/to and clamps to >= from", () => {
    const w = world();
    addEra(w, 0, 100);
    setSpan(w, "Era 1", 50, 40);
    expect(w.eras[0]).toEqual({ name: "Era 1", from: 50, to: 50 });
    expect(errors(w)).toEqual([]);
  });

  test("setSpan with `to` undefined opens the era", () => {
    const w = world();
    addEra(w, 0, 100);
    setSpan(w, "Era 1", 10, undefined);
    expect(w.eras[0]).toEqual({ name: "Era 1", from: 10 });
    expect(errors(w)).toEqual([]);
  });

  test("setEnabled writes `false` only, and omits it once re-enabled", () => {
    const w = world();
    addEra(w, 0);
    setEnabled(w, "Era 1", false);
    expect(w.eras[0]!.enabled).toBe(false);
    expect(errors(w)).toEqual([]);
    setEnabled(w, "Era 1", true);
    expect(w.eras[0]!.enabled).toBeUndefined();
    expect(errors(w)).toEqual([]);
  });

  test("removeEra drops the era and leaves the rest clean", () => {
    const w = world();
    addEra(w, 0);
    addEra(w, 100);
    removeEra(w, "Era 1");
    expect(w.eras.map((e) => e.name)).toEqual(["Era 2"]);
    expect(errors(w)).toEqual([]);
  });

  test("an edit against a name that does not exist is a no-op", () => {
    const w = world();
    addEra(w, 0);
    setSpan(w, "Nope", 1, 2);
    setEnabled(w, "Nope", false);
    removeEra(w, "Nope");
    expect(w.eras).toEqual([{ name: "Era 1", from: 0 }]);
  });
});

describe("era-edit · addOp / setOpValue / removeOp / setOpEnabled", () => {
  test("the op lifecycle leaves the draft clean at every step", () => {
    const w = world();
    addEra(w, 0);
    addOp(w, "Era 1", { param: "temperature.mean", op: "offset", value: -8 });
    expect(w.eras[0]!.apply).toEqual([{ param: "temperature.mean", op: "offset", value: -8 }]);
    expect(errors(w)).toEqual([]);

    setOpValue(w, "Era 1", 0, -12);
    expect(w.eras[0]!.apply).toEqual([{ param: "temperature.mean", op: "offset", value: -12 }]);
    expect(errors(w)).toEqual([]);

    setOpEnabled(w, "Era 1", 0, false);
    expect(w.eras[0]!.apply![0]).toMatchObject({ enabled: false });
    expect(errors(w)).toEqual([]);

    setOpEnabled(w, "Era 1", 0, true);
    expect(w.eras[0]!.apply![0]!.enabled).toBeUndefined();

    addOp(w, "Era 1", { param: "precipitation.pwd", op: "scale", value: 1.4 });
    expect(w.eras[0]!.apply).toHaveLength(2);
    expect(errors(w)).toEqual([]);

    removeOp(w, "Era 1", 0);
    expect(w.eras[0]!.apply).toEqual([{ param: "precipitation.pwd", op: "scale", value: 1.4 }]);
    expect(errors(w)).toEqual([]);
  });

  test("setOpValue on a clamp op (no single value) is a no-op, never crashes", () => {
    const w = world();
    addEra(w, 0);
    addOp(w, "Era 1", { param: "temperature.mean", op: "clamp", min: -10, max: 10 });
    setOpValue(w, "Era 1", 0, 999);
    expect(w.eras[0]!.apply![0]).toEqual({ param: "temperature.mean", op: "clamp", min: -10, max: 10 });
  });
});

describe("era-edit · renameEra", () => {
  test("rewrites a bare `{ tag: era:<old> }` predicate and a mod-matrix gate on every zone", () => {
    const w = world();
    addEra(w, 1200, 1900);
    const zones: Record<string, ZoneProfile> = {
      greywold: zoneWith([{ id: "frost", when: { tag: "era:Era 1" }, apply: [{ param: "temperature.mean", op: "offset", value: -2 }] }]),
      saltmarsh: zoneWith([{ id: "chill", apply: [{ param: "temperature.mean", op: "offset", value: -1 }], mods: [{ source: "era:Era 1", amount: 0.5 }] }]),
    };

    const after = renameEra(w, zones, "Era 1", "Ice Age");
    expect(after).toBe("Ice Age");
    expect(w.eras[0]!.name).toBe("Ice Age");
    expect(zones["greywold"]!.modifiers[0]!.when).toEqual({ tag: "era:Ice Age" });
    expect(zones["saltmarsh"]!.modifiers[0]!.mods).toEqual([{ source: "era:Ice Age", amount: 0.5 }]);
    expect(errors(w)).toEqual([]);
  });

  test("rewrites the tag nested inside all/any/not, leaving unrelated tags alone", () => {
    const w = world();
    addEra(w, 0);
    const zones: Record<string, ZoneProfile> = {
      z: zoneWith([
        {
          id: "gated",
          when: { all: [{ any: [{ tag: "era:Era 1" }, { tag: "season:Harvest" }] }, { not: { tag: "era:Era 1" } }] },
          apply: [{ param: "temperature.mean", op: "offset", value: 1 }],
        },
      ]),
    };

    renameEra(w, zones, "Era 1", "Long Winter");
    expect(zones["z"]!.modifiers[0]!.when).toEqual({
      all: [{ any: [{ tag: "era:Long Winter" }, { tag: "season:Harvest" }] }, { not: { tag: "era:Long Winter" } }],
    });
  });

  test("a blank or unchanged name is a no-op", () => {
    const w = world();
    addEra(w, 0);
    expect(renameEra(w, {}, "Era 1", "   ")).toBe("Era 1");
    expect(renameEra(w, {}, "Era 1", "Era 1")).toBe("Era 1");
    expect(w.eras[0]!.name).toBe("Era 1");
  });

  test("renaming onto an existing era's name is uniquified, not a collision", () => {
    const w = world();
    addEra(w, 0);
    addEra(w, 100);
    const after = renameEra(w, {}, "Era 2", "Era 1");
    expect(after).toBe("Era 1 2");
    expect(w.eras.map((e) => e.name)).toEqual(["Era 1", "Era 1 2"]);
    expect(errors(w)).toEqual([]);
  });

  test("renaming a name that does not exist is a no-op", () => {
    const w = world();
    addEra(w, 0);
    expect(renameEra(w, {}, "Nope", "Whatever")).toBe("Nope");
    expect(w.eras[0]!.name).toBe("Era 1");
  });
});
