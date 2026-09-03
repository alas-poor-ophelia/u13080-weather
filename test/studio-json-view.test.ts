import { describe, expect, test } from "bun:test";
import { validateProfile } from "../src/core/profile";
import type { Override } from "../src/core/report";
import type { Modifier, Preset, ZoneProfile } from "../src/core/types";
import { sections, zoneFileText, zoneForSave } from "../src/studio/model/json-view";
import type { WorldDraft } from "../src/studio/model/state";

const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;

function zone(overrides: Partial<ZoneProfile> = {}): ZoneProfile {
  return {
    id: "greywold",
    name: "Greywold",
    schemaVersion: 1,
    climate: structuredClone(fjord.climate),
    regimes: structuredClone(fjord.regimes),
    modifiers: [],
    ...overrides,
  };
}

function world(overrides: Partial<WorldDraft> = {}): WorldDraft {
  return {
    eras: [{ name: "Wet Age", from: 0 }],
    calendar: { seasons: [{ name: "Warm", from: 0 }, { name: "Cold", from: 0.5 }], moons: [] },
    devicePresets: [],
    regimePresets: [],
    overrides: [],
    ...overrides,
  };
}

const device = (id: string, param = "temperature.mean"): Modifier => ({ id, when: { tag: "storm" }, apply: [{ param, op: "offset", value: -1 }] });
const layer = (param: string, value: number): Modifier => ({ id: `layer:${param}`, stage: "climate", apply: [{ param, op: "offset", value }] });
const forcings = (param: string, value: number): Modifier => ({ id: `forcings:${param}`, stage: "climate", apply: [{ param, op: "offset", value }] });

describe("json-view · sections", () => {
  test("order and scope: every optional key present", () => {
    const z = zone({
      preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
      geography: { latitude: 40, altitude: 0, orographic: "none" },
      flipSeasons: true,
      automation: [{ id: "frc.warmth", param: "temperature.mean", op: "offset", points: [[0, 0]] }],
    });
    const secs = sections(z, world());
    expect(secs.map((s) => s.key)).toEqual(["id", "name", "preset", "geography", "flipSeasons", "climate", "regimes", "modifiers", "automation", "overrides", "eras", "calendar.seasons", "calendar.moons", "devicePresets"]);
    const zoneKeys = new Set(["id", "name", "preset", "geography", "flipSeasons", "climate", "regimes", "modifiers", "automation", "overrides"]);
    for (const s of secs) expect(s.scope).toBe(zoneKeys.has(s.key) ? "zone" : "world");
  });

  test("optional zone keys are omitted when absent", () => {
    const secs = sections(zone(), world());
    expect(secs.map((s) => s.key)).toEqual(["id", "name", "climate", "regimes", "modifiers", "overrides", "eras", "calendar.seasons", "calendar.moons", "devicePresets"]);
  });

  test("automation omitted when absent, included when non-empty", () => {
    expect(sections(zone(), world()).some((s) => s.key === "automation")).toBe(false);
    expect(sections(zone({ automation: [] }), world()).some((s) => s.key === "automation")).toBe(false);
    const withLane = zone({ automation: [{ id: "frc.warmth", param: "temperature.mean", op: "offset", points: [[0, 1]] }] });
    const secs = sections(withLane, world());
    const automation = secs.find((s) => s.key === "automation");
    expect(automation).toBeDefined();
    expect(automation!.text).toContain("frc.warmth");
  });

  test("overrides filtered to this zone", () => {
    const overrides: Override[] = [
      { zoneId: "greywold", dayOrdinal: 5, patch: { note: "mine" } },
      { zoneId: "elsewhere", dayOrdinal: 5, patch: { note: "not mine" } },
    ];
    const secs = sections(zone(), world({ overrides }));
    const section = secs.find((s) => s.key === "overrides")!;
    const parsed = JSON.parse(section.text) as Override[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.zoneId).toBe("greywold");
    expect(section.text).not.toContain("not mine");
  });

  test("modifiers normalised (layer → device → forcings) without mutating the input", () => {
    const modifiers = [forcings("precipitation.pww", 0.2), device("storm-fx"), layer("temperature.mean", 1)];
    const z = zone({ modifiers });
    const before = modifiers.map((m) => m.id);

    const secs = sections(z, world());
    const modSection = secs.find((s) => s.key === "modifiers")!;
    const parsed = JSON.parse(modSection.text) as Modifier[];
    expect(parsed.map((m) => m.id)).toEqual(["layer:temperature.mean", "storm-fx", "forcings:precipitation.pww"]);

    // The caller's draft — and the array a window is bound to — is untouched.
    expect(modifiers.map((m) => m.id)).toEqual(before);
    expect(z.modifiers).toBe(modifiers);
  });

  test("never a layers key", () => {
    const z = zone({ modifiers: [layer("temperature.mean", 1), forcings("precipitation.pww", 0.1)] });
    const secs = sections(z, world());
    for (const s of secs) expect(s.text).not.toContain('"layers"');
  });
});

describe("json-view · zoneFileText", () => {
  test("parses back and validates clean for fjord-coast", () => {
    const z = zone({
      modifiers: [forcings("precipitation.pww", 0.2), layer("temperature.mean", 1)],
      preset: { id: fjord.id, contentHash: fjord.contentHash, matched: "manual" },
    });
    const overrides: Override[] = [{ zoneId: "greywold", dayOrdinal: 0, patch: { note: "hail" } }];
    const text = zoneFileText(z, overrides);

    const parsed = JSON.parse(text) as ZoneProfile & { overrides: Override[] };
    expect(parsed.overrides).toHaveLength(1);
    const { overrides: _drop, ...zoneOnly } = parsed;
    const errors = validateProfile(zoneOnly).filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  test("modifiers are normalised without mutating the input, and no layers key ever appears", () => {
    const modifiers = [device("storm-fx"), layer("temperature.mean", 1), forcings("precipitation.pww", 0.2)];
    const z = zone({ modifiers });
    const text = zoneFileText(z, []);

    expect(text).not.toContain('"layers"');
    const parsed = JSON.parse(text) as ZoneProfile;
    expect(parsed.modifiers.map((m) => m.id)).toEqual(["layer:temperature.mean", "storm-fx", "forcings:precipitation.pww"]);
    expect(modifiers.map((m) => m.id)).toEqual(["storm-fx", "layer:temperature.mean", "forcings:precipitation.pww"]);
  });

  test("overrides filtered to this zone are appended", () => {
    const overrides: Override[] = [
      { zoneId: "greywold", dayOrdinal: 1, patch: {} },
      { zoneId: "other-zone", dayOrdinal: 1, patch: {} },
    ];
    const text = zoneFileText(zone(), overrides);
    const parsed = JSON.parse(text) as ZoneProfile & { overrides: Override[] };
    expect(parsed.overrides).toEqual([{ zoneId: "greywold", dayOrdinal: 1, patch: {} }]);
  });
});

/* ── zoneForSave: the one "as it would be saved" clone (bead wadjet-9f9.45) ── */

describe("json-view · zoneForSave", () => {
  /**
   * `ui/header.ts commit()` writes `zoneForSave(draft)` into
   * `plugin.settings.zones`, and the drawer shows `zoneForSave` too, so a zone
   * that arrived out of order through the JSON escape hatch is saved in the
   * order the drawer promised. Before this bead the drawer normalised and the
   * write-through did not.
   */
  const OUT_OF_ORDER: Modifier[] = [forcings("precipitation.pww", 0.1), device("ashfall"), layer("temperature.mean", 2)];

  test("normalises modifiers into layer → devices → forcings", () => {
    const saved = zoneForSave(zone({ modifiers: structuredClone(OUT_OF_ORDER) }));
    expect(saved.modifiers.map((m) => m.id)).toEqual(["layer:temperature.mean", "ashfall", "forcings:precipitation.pww"]);
  });

  test("never mutates the draft the windows are bound to", () => {
    const draft = zone({ modifiers: structuredClone(OUT_OF_ORDER) });
    const before = structuredClone(draft);
    const saved = zoneForSave(draft);
    expect(draft).toEqual(before);
    expect(saved.modifiers).not.toBe(draft.modifiers);
    expect(saved.modifiers[0]).not.toBe(draft.modifiers[0]);
  });

  test("is exactly what the drawer prints, so 'as it would be saved' is true", () => {
    const draft = zone({ modifiers: structuredClone(OUT_OF_ORDER) });
    const drawer = JSON.parse(zoneFileText(draft, [])) as ZoneProfile;
    expect(drawer.modifiers.map((m) => m.id)).toEqual(zoneForSave(draft).modifiers.map((m) => m.id));
  });

  test("an already-ordered zone comes back unchanged", () => {
    const ordered: Modifier[] = [layer("temperature.mean", 2), device("ashfall"), forcings("precipitation.pww", 0.1)];
    const draft = zone({ modifiers: structuredClone(ordered) });
    expect(zoneForSave(draft)).toEqual(draft);
  });
});
