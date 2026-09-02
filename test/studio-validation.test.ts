/**
 * Studio validation surface (bead wadjet-9f9.35, PLAN.md §5.5, SPEC.md §3.9).
 *
 * `mapIssue` is the contract between the three core validators and the
 * studio's units/windows — every normalised path in
 * `test/fixtures/studio/validator-paths.json` (wadjet-9f9.7) must resolve to
 * somewhere other than the "no window" bucket, except for the handful of
 * genuinely top-level paths (`id`, `climate`, `regimes`, `modifiers`,
 * `automation`, `eras`, `flipSeasons`) that are allowed to.
 */
import { describe, expect, test } from "bun:test";
import type { ValidationIssue } from "../src/core/profile";
import type { Era, Modifier, Preset, Regime, ZoneProfile } from "../src/core/types";
import {
  issuesByUnit,
  issuesFor,
  ledLevel,
  mapIssue,
  saveLabel,
  studioRules,
  unitKey,
  type StudioIssue,
  type StudioIssuesInput,
  type UnitRef,
} from "../src/studio/model/validation";

const here = (p: string) => new URL(p, import.meta.url);

const fjord = (await Bun.file(here("../presets/fjord-coast.json")).json()) as Preset;
const pathsFixture = (await Bun.file(here("./fixtures/studio/validator-paths.json")).json()) as { paths: string[] };
const tripZone = (await Bun.file(here("./fixtures/studio/trip-every-rule.json")).json()) as ZoneProfile;
const tripEras = (await Bun.file(here("./fixtures/studio/trip-every-rule.eras.json")).json()) as unknown as Era[];

/** A clean zone with a device modifier and a regime at index 0, so `modifiers[i]…`/`regimes[i]…` paths resolve. */
function baseZone(over: Partial<ZoneProfile> = {}): ZoneProfile {
  const regime: Regime = { id: "settled", weight: 1, meanDurationDays: 10 };
  const device: Modifier = { id: "campfire", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] };
  return { id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: [regime], modifiers: [device], ...over };
}
const baseEras: Era[] = [{ name: "Ice Age", from: 1 }];

const ALLOWED_ZONE_NONE = new Set(["id", "climate", "regimes", "modifiers", "automation", "eras", "flipSeasons"]);

/** `[i]`/`[j]`/`[k]` → `[0]`, so a normalised pattern becomes one concrete path. Tuple-literal indices (already digits) are untouched. */
function instantiate(path: string): string {
  return path.replace(/\[[ijk]\]/g, "[0]");
}

const dummyIssue = (path: string): ValidationIssue => ({ level: "error", path, message: "x" });

describe("mapIssue: every validator path has somewhere to show itself", () => {
  const zone = baseZone();
  for (const path of pathsFixture.paths) {
    test(path, () => {
      const concrete = instantiate(path);
      const mapped = mapIssue(dummyIssue(concrete), zone, baseEras);
      const isUnmapped = mapped.unit.kind === "zone" && mapped.win === "none";
      const top = concrete.split(/[.[]/)[0]!;
      if (!ALLOWED_ZONE_NONE.has(top)) {
        expect(isUnmapped, `${path} → ${JSON.stringify(mapped.unit)} / ${mapped.win}`).toBe(false);
      }
    });
  }
});

describe("mapIssue: routing decisions", () => {
  test("id and climate (bare) and eras (bare) fall back to the zone, no window", () => {
    expect(mapIssue(dummyIssue("id"), baseZone(), [])).toMatchObject({ unit: { kind: "zone" }, win: "none" });
    expect(mapIssue(dummyIssue("climate"), baseZone(), [])).toMatchObject({ unit: { kind: "zone" }, win: "none" });
    expect(mapIssue(dummyIssue("eras"), baseZone(), [])).toMatchObject({ unit: { kind: "zone" }, win: "none" });
  });

  test("flipSeasons opens the Atlas window", () => {
    expect(mapIssue(dummyIssue("flipSeasons"), baseZone(), [])).toEqual({ level: "error", path: "flipSeasons", message: "x", unit: { kind: "zone" }, win: "atlas" });
  });

  test("regimes* always routes to the fixed Regimes slot, indexed or not", () => {
    expect(mapIssue(dummyIssue("regimes"), baseZone(), [])).toMatchObject({ unit: { kind: "regimes" }, win: "regimes" });
    expect(mapIssue(dummyIssue("regimes[2].meanDurationDays"), baseZone(), [])).toMatchObject({ unit: { kind: "regimes" }, win: "regimes" });
  });

  test("automation* always routes to Forcings, indexed or not", () => {
    expect(mapIssue(dummyIssue("automation"), baseZone(), [])).toMatchObject({ unit: { kind: "forcings" }, win: "forcings" });
    expect(mapIssue(dummyIssue("automation[0].points[1][0]"), baseZone(), [])).toMatchObject({ unit: { kind: "forcings" }, win: "forcings" });
  });

  test("climate.<section>… routes to that section's channel", () => {
    expect(mapIssue(dummyIssue("climate.temperature.mean"), baseZone(), [])).toEqual({ level: "error", path: "climate.temperature.mean", message: "x", unit: { kind: "channel", channel: "temperature" }, win: "channel" });
    expect(mapIssue(dummyIssue("climate.precipitation.pwd.phase"), baseZone(), [])).toMatchObject({ unit: { kind: "channel", channel: "precipitation" } });
    expect(mapIssue(dummyIssue("climate.wind.speed"), baseZone(), [])).toMatchObject({ unit: { kind: "channel", channel: "wind" } });
    // humidity and cloud share the Sky channel (PLAN §7a: "Sky: cloud.dry/wet offset").
    expect(mapIssue(dummyIssue("climate.humidity.dry"), baseZone(), [])).toMatchObject({ unit: { kind: "channel", channel: "sky" } });
    expect(mapIssue(dummyIssue("climate.cloud.wet"), baseZone(), [])).toMatchObject({ unit: { kind: "channel", channel: "sky" } });
  });

  test("eras[i]… resolves to the era by name", () => {
    const eras: Era[] = [{ name: "Age of Frost", from: 1 }, { name: "Thaw", from: 50 }];
    expect(mapIssue(dummyIssue("eras[1].name"), baseZone(), eras)).toEqual({ level: "error", path: "eras[1].name", message: "x", unit: { kind: "era", name: "Thaw" }, win: "era" });
    // Out-of-range index (e.g. a synthetic issue against a shorter eras array): falls back to a stable placeholder rather than crashing.
    expect(mapIssue(dummyIssue("eras[5].name"), baseZone(), eras)).toMatchObject({ unit: { kind: "era", name: "#5" } });
  });

  test("modifiers[i]… resolves to the modifier's own id as a device", () => {
    const zone = baseZone({ modifiers: [{ id: "sable-stormtide", apply: [] }] });
    expect(mapIssue(dummyIssue("modifiers[0].when.all[2].tag"), zone, [])).toEqual({
      level: "error",
      path: "modifiers[0].when.all[2].tag",
      message: "x",
      unit: { kind: "device", id: "sable-stormtide" },
      win: "device",
    });
  });

  test("modifiers[i]…: layer:<param> routes to that param's channel window", () => {
    const zone = baseZone({ modifiers: [{ id: "layer:temperature.mean", stage: "climate", apply: [] }] });
    expect(mapIssue(dummyIssue("modifiers[0].apply"), zone, [])).toMatchObject({ unit: { kind: "channel", channel: "temperature" }, win: "channel" });
  });

  test("modifiers[i]…: layer:<param>:season:<X> and layer:<param>:moon:<X> still resolve on the param, not the suffix", () => {
    const zone = baseZone({
      modifiers: [
        { id: "layer:precipitation.pwd:season:Wet", apply: [] },
        { id: "layer:temperature.sd:moon:Sable", apply: [] },
      ],
    });
    expect(mapIssue(dummyIssue("modifiers[0].apply"), zone, [])).toMatchObject({ unit: { kind: "channel", channel: "precipitation" } });
    expect(mapIssue(dummyIssue("modifiers[1].apply"), zone, [])).toMatchObject({ unit: { kind: "channel", channel: "temperature" } });
  });

  test("modifiers[i]…: forcings:<param> routes to Forcings, not a device row", () => {
    const zone = baseZone({ modifiers: [{ id: "forcings:warmth", stage: "climate", apply: [] }] });
    expect(mapIssue(dummyIssue("modifiers[0].apply[0].value"), zone, [])).toMatchObject({ unit: { kind: "forcings" }, win: "forcings" });
  });
});

describe("issuesFor: the trip-every-rule fixture never lands in the unmapped bucket", () => {
  test("every issue it raises resolves off the zone/none default, except the genuinely top-level ones", () => {
    const input: StudioIssuesInput = { zone: tripZone, eras: tripEras, seasons: [], moons: [], readOnlyCalendar: false };
    const issues = issuesFor(input);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      const isUnmapped = issue.unit.kind === "zone" && issue.win === "none";
      const top = issue.path.split(/[.[]/)[0]!;
      if (!isUnmapped) continue;
      expect(ALLOWED_ZONE_NONE.has(top), `${issue.path}: ${issue.message}`).toBe(true);
    }
  });

  test("errors sort before warnings and validateAutomation's issues (nested inside validateProfile) are included", () => {
    const input: StudioIssuesInput = { zone: tripZone, eras: tripEras, seasons: [], moons: [], readOnlyCalendar: false };
    const issues = issuesFor(input);
    const firstWarningIdx = issues.findIndex((i) => i.level === "warning");
    const lastErrorIdx = issues.map((i) => i.level).lastIndexOf("error");
    expect(firstWarningIdx === -1 || lastErrorIdx < firstWarningIdx).toBe(true);
    expect(issues.some((i) => i.path.startsWith("automation"))).toBe(true);
  });
});

describe("studioRules", () => {
  const clean: StudioIssuesInput = { zone: baseZone({ modifiers: [] }), eras: [], seasons: [{ name: "Spring", from: 0 }, { name: "Autumn", from: 0.5 }], moons: [], readOnlyCalendar: false };

  test("a clean input trips nothing", () => {
    expect(studioRules(clean)).toEqual([]);
  });

  test("seasons: none at all is legal (a fresh world ships with no seasons)", () => {
    expect(studioRules({ ...clean, seasons: [] }).filter((i) => i.path === "seasons")).toEqual([]);
  });

  test("seasons: too many (7) trips the count rule", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `S${i}`, from: i / 7 }));
    const issues = studioRules({ ...clean, seasons: seven });
    expect(issues).toContainEqual(expect.objectContaining({ path: "seasons" }));
  });

  test("seasons: blank name trips the name rule", () => {
    const issues = studioRules({ ...clean, seasons: [{ name: "  ", from: 0 }] });
    expect(issues).toContainEqual(expect.objectContaining({ path: "seasons[0].name", message: "name is required" }));
  });

  test("seasons: duplicate names trip the uniqueness rule", () => {
    const issues = studioRules({ ...clean, seasons: [{ name: "Spring", from: 0 }, { name: "Spring", from: 0.5 }] });
    expect(issues).toContainEqual(expect.objectContaining({ path: "seasons[1].name", message: 'duplicate season name "Spring"' }));
  });

  test("seasons: rules are skipped entirely under a read-only calendar", () => {
    expect(studioRules({ ...clean, seasons: [], readOnlyCalendar: true })).toEqual([]);
  });

  test("moon: duplicate phase names", () => {
    const issues = studioRules({ ...clean, moons: [{ name: "Sable", phases: [{ name: "New", at: 0 }, { name: "New", at: 0.5 }] }] });
    expect(issues).toContainEqual(expect.objectContaining({ path: "moons.Sable.phases[1].name", message: 'duplicate phase name "New"', unit: { kind: "moon", name: "Sable" }, win: "cycle" }));
  });

  test("moon: phase at() out of [0,1)", () => {
    const issues = studioRules({ ...clean, moons: [{ name: "Sable", phases: [{ name: "Full", at: 1 }] }] });
    expect(issues).toContainEqual(expect.objectContaining({ path: "moons.Sable.phases[0].at", message: "must be in [0,1)" }));
  });

  test("moon: phase at() not ascending", () => {
    const issues = studioRules({ ...clean, moons: [{ name: "Sable", phases: [{ name: "New", at: 0.5 }, { name: "Full", at: 0.2 }] }] });
    expect(issues).toContainEqual(expect.objectContaining({ path: "moons.Sable.phases[1].at", message: "phase boundaries must be strictly ascending" }));
  });

});

describe("ledLevel", () => {
  test("undefined or empty is ok", () => {
    expect(ledLevel(undefined)).toBe("ok");
    expect(ledLevel([])).toBe("ok");
  });

  test("warning-only is warn", () => {
    const issues: StudioIssue[] = [{ level: "warning", path: "x", message: "m", unit: { kind: "zone" }, win: "none" }];
    expect(ledLevel(issues)).toBe("warn");
  });

  test("any error is error, even alongside warnings", () => {
    const issues: StudioIssue[] = [
      { level: "warning", path: "x", message: "m", unit: { kind: "zone" }, win: "none" },
      { level: "error", path: "y", message: "m", unit: { kind: "zone" }, win: "none" },
    ];
    expect(ledLevel(issues)).toBe("error");
  });
});

describe("saveLabel", () => {
  test("no issues: bare Save, not blocked", () => {
    expect(saveLabel([])).toEqual({ text: "Save ●", blocked: false });
  });

  test("warnings only: count shown, not blocked", () => {
    const issues: StudioIssue[] = [
      { level: "warning", path: "a", message: "m", unit: { kind: "zone" }, win: "none" },
      { level: "warning", path: "b", message: "m", unit: { kind: "zone" }, win: "none" },
    ];
    expect(saveLabel(issues)).toEqual({ text: "Save ● · 2 ⚠", blocked: false });
  });

  test("any errors: count shown, blocked, regardless of accompanying warnings", () => {
    const issues: StudioIssue[] = [
      { level: "error", path: "a", message: "m", unit: { kind: "zone" }, win: "none" },
      { level: "error", path: "b", message: "m", unit: { kind: "zone" }, win: "none" },
      { level: "error", path: "c", message: "m", unit: { kind: "zone" }, win: "none" },
      { level: "warning", path: "d", message: "m", unit: { kind: "zone" }, win: "none" },
    ];
    expect(saveLabel(issues)).toEqual({ text: "Save · 3 issues", blocked: true });
  });
});

describe("issuesByUnit", () => {
  test("groups by unitKey, preserving each issue's order within its bucket", () => {
    const issues: StudioIssue[] = [
      { level: "error", path: "modifiers[0].id", message: "required", unit: { kind: "device", id: "a" }, win: "device" },
      { level: "warning", path: "modifiers[0].mods", message: "unknown field", unit: { kind: "device", id: "a" }, win: "device" },
      { level: "error", path: "regimes", message: "required", unit: { kind: "regimes" }, win: "regimes" },
    ];
    const byUnit = issuesByUnit(issues);
    expect(byUnit.get("device:a")).toEqual([issues[0]!, issues[1]!]);
    expect(byUnit.get("regimes")).toEqual([issues[2]!]);
    expect(byUnit.size).toBe(2);
  });
});

describe("unitKey", () => {
  test("one key per UnitRef shape", () => {
    const cases: Array<[UnitRef, string]> = [
      [{ kind: "regimes" }, "regimes"],
      [{ kind: "device", id: "sable-stormtide" }, "device:sable-stormtide"],
      [{ kind: "forcings" }, "forcings"],
      [{ kind: "era", name: "Ice Age" }, "era:Ice Age"],
      [{ kind: "channel", channel: "wind" }, "channel:wind"],
      [{ kind: "zone" }, "zone"],
      [{ kind: "seasons" }, "seasons"],
      [{ kind: "moon", name: "Sable" }, "moon:Sable"],
    ];
    for (const [unit, key] of cases) expect(unitKey(unit)).toBe(key);
  });
});
