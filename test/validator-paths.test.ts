/**
 * The validator path map (bead wadjet-9f9.7, PLAN.md §5.5).
 *
 * The Climate Studio maps every issue path emitted by `validateProfile` /
 * `validateAutomation` / `validateEras` onto a unit — a device row, a channel
 * window, the forcings strip, an era chip — so that no issue can be raised with
 * nowhere to show it. That map is written against this fixture, which makes
 * this test the contract between the validators and the UI:
 *
 *   1. `test/fixtures/studio/trip-every-rule.json` (+ `.eras.json`) trips every
 *      rule that can be written in JSON and can co-exist in one document.
 *   2. `MINI_FIXTURES` covers the rest: rules that short-circuit the document
 *      (`climate` missing), rules mutually exclusive with a main-fixture rule
 *      (the persistence warning band is the error's complement), and rules
 *      needing a value JSON cannot express (`NaN` / `Infinity`).
 *   3. The union of their normalised paths must equal `EXPECTED_PATHS`, also
 *      checked in as `test/fixtures/studio/validator-paths.json` for the
 *      studio's path → unit map to import.
 *   4. `EMIT_SITES` pins how many places the three validators can raise an
 *      issue, so a new rule cannot land without visiting this file.
 *
 * Adding a rule: trip it in the fixture (or in `MINI_FIXTURES` if it cannot
 * live there), then update `EXPECTED_PATHS`, `validator-paths.json`,
 * `EMIT_SITES`, the counts below, and the studio's map.
 */
import { describe, expect, test } from "bun:test";
import { validateEras } from "../src/core/eras";
import { validateProfile, type ValidationIssue } from "../src/core/profile";
import type { AutomationLane, ClimateParams, Preset, ZoneProfile } from "../src/core/types";

const here = (p: string) => new URL(p, import.meta.url);

const zone = (await Bun.file(here("./fixtures/studio/trip-every-rule.json")).json()) as ZoneProfile;
const eras = (await Bun.file(here("./fixtures/studio/trip-every-rule.eras.json")).json()) as unknown;
const pathsFixture = (await Bun.file(here("./fixtures/studio/validator-paths.json")).json()) as { paths: string[] };
const fjord = (await Bun.file(here("../presets/fjord-coast.json")).json()) as Preset;

/** A zone with no issues at all, so a mini-fixture's own issue is the only one it raises. */
const clean = (over: Partial<ZoneProfile> = {}): ZoneProfile => ({ id: "greywold", name: "Greywold", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [], ...over });
/** These fixtures are deliberately ill-typed — being ill-typed is what is under test. */
const illTyped = <T>(v: unknown): T => v as T;

/** Rules the main fixture cannot reach, each with the reason it needs a document of its own. */
const MINI_FIXTURES: Array<{ why: string; issues: () => ValidationIssue[] }> = [
  { why: "climate — a missing climate short-circuits every other climate rule", issues: () => validateProfile(clean({ climate: illTyped<ClimateParams>(undefined) })) },
  { why: 'climate.<curve> "must be finite" for a constant — JSON has no NaN', issues: () => validateProfile(clean({ climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, mean: NaN } } })) },
  { why: 'climate.<curve>[i].value "must be finite" for a keyframe — JSON has no NaN', issues: () => validateProfile(clean({ climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, sd: [{ at: 0, value: NaN }] } } })) },
  { why: "climate.temperature.persistence — the warning band (0.9, MAX_PERSISTENCE] is the error's complement", issues: () => validateProfile(clean({ climate: { ...fjord.climate, temperature: { ...fjord.climate.temperature, persistence: 0.93 } } })) },
  { why: "regimes — an empty list excludes every per-regime rule", issues: () => validateProfile(clean({ regimes: [] })) },
  { why: "automation — not an array excludes every per-lane rule", issues: () => validateProfile(clean({ automation: illTyped<AutomationLane[]>("nope") })) },
  { why: "automation[i].points[j][0] — a year that is not finite; JSON has no Infinity", issues: () => validateProfile(clean({ automation: [{ id: "warmth", param: "temperature.mean", op: "offset", points: [[Infinity, 0]] }] })) },
  { why: "automation[i].points[j][1] — a value that is not finite; JSON has no NaN", issues: () => validateProfile(clean({ automation: [{ id: "warmth", param: "temperature.mean", op: "offset", points: [[1, NaN]] }] })) },
  { why: "eras — not an array excludes every per-era rule", issues: () => validateEras("nope") },
];

/**
 * `[3]` → `[i]`, the next depth `[7]` → `[j]`, and so on: the path becomes a
 * pattern rather than a coordinate. An index that directly follows another
 * index (`automation[0].points[2][0]`) is a fixed tuple slot — `[0]` is a year
 * and `[1]` is a value, which do not share a unit — and is kept literal.
 */
const DEPTH = ["i", "j", "k", "l", "m"];
function normalisePath(path: string): string {
  let depth = 0;
  return path.replace(/\[(\d+)\]/g, (m: string, _digits: string, at: number) => (path[at - 1] === "]" ? m : `[${DEPTH[depth++] ?? "n"}]`));
}

const mainIssues = [...validateProfile(zone), ...validateEras(eras)];
const miniIssues = MINI_FIXTURES.map((f) => f.issues());
const allIssues = [...mainIssues, ...miniIssues.flat()];
const normalised = [...new Set(allIssues.map((i) => normalisePath(i.path)))].sort();

/**
 * Every place the three validators can raise an issue. Recount with:
 *
 *   grep -o '{ level: "' src/core/profile.ts src/core/automation.ts src/core/eras.ts | wc -l
 *
 * 81 `issues.push({ level: … })` calls plus the one early `return [{ level: … }]`
 * in `validateEras`. If this number changes, a rule was added or removed — trip
 * the new one in the fixture and update the lists below.
 */
const EMIT_SITES = 82;
const emitSites = (await Promise.all(["../src/core/profile.ts", "../src/core/automation.ts", "../src/core/eras.ts"].map((s) => Bun.file(here(s)).text()))).reduce((n, text) => n + (text.match(/\{ level: "/g)?.length ?? 0), 0);

/** What the fixtures raise. Some emit sites are tripped more than once (different ids, different parameters), so this is above EMIT_SITES. */
const EXPECTED_ERRORS = 93;
const EXPECTED_WARNINGS = 7;
/** How much of the coverage lives in the single main document — the rest is MINI_FIXTURES, one issue each. */
const MAIN_FIXTURE_ISSUES = 91;

/** Sorted. The comment on each line is every message the fixtures raise at that path. */
const EXPECTED_PATHS: string[] = [
  "automation", // error: must be an array of automation lanes
  "automation[i]", // error: lane must be an object
  "automation[i].colour", // warning: unknown field (ignored) — the path is `automation[i].<any unknown key>`
  "automation[i].enabled", // error: enabled must be true or false
  "automation[i].id", // error: required | error: duplicate automation lane id "warmth"
  "automation[i].op", // error: unknown op "warp" — automation ops are offset, scale
  "automation[i].param", // error: unknown parameter path "nope"
  "automation[i].points", // error: at least one [year, value] point is required
  "automation[i].points[j]", // error: point must be [year, value]
  "automation[i].points[j][0]", // error: years must be strictly ascending | error: year must be finite
  "automation[i].points[j][1]", // error: value must be finite
  "climate", // error: required
  "climate.precipitation.pwd.phase", // error: must be in [0,1)
  "climate.precipitation.pww.phase", // error: harmonic phase is required (no silent default)
  "climate.precipitation.shape", // error: not a Curve
  "climate.temperature.diurnalRange[i]", // error: keyframe needs numeric at and value
  "climate.temperature.mean", // error: keyframe array is empty | error: must be finite
  "climate.temperature.persistence", // error: must be in [0, 0.95] | warning: above 0.9: a faint seam may appear every 64 days
  "climate.temperature.phase", // error: must be in [0,1)
  "climate.temperature.sd", // error: harmonic needs numeric mean and amplitude
  "climate.temperature.sdHigh", // error: not a Curve
  "climate.temperature.sdLow.phase", // error: harmonic phase is required (no silent default)
  "climate.temperature.sd[i].value", // error: must be finite
  "climate.temperature.wetDayOffset[i].at", // error: must be in [0,1)
  "climate.temperature.wetDayRangeOffset.phase", // error: must be in [0,1)
  "eras", // error: must be an array of eras
  "eras[i]", // error: era must be an object
  "eras[i].apply", // error: apply must be an array
  "eras[i].apply[j].param", // error: unknown parameter path "temperature.phase"
  "eras[i].colour", // warning: unknown field (ignored) — the path is `eras[i].<any unknown key>`
  "eras[i].enabled", // error: enabled must be true or false
  "eras[i].from", // error: from must be a whole year
  "eras[i].name", // error: name is required | error: duplicate era name "Ice Age"
  "eras[i].to", // error: to must be a whole year (or omitted for open-ended) | error: to must not be before from
  "flipSeasons", // error: flipSeasons must be true or false
  "id", // error: required
  "modifiers[i]", // error: climate-stage modifiers are unconditional (no when/spell); use stage: daily
  "modifiers[i].apply", // error: apply must be an array
  "modifiers[i].apply[j]", // error: op must be an object | error: clamp needs min and/or max
  "modifiers[i].apply[j].enabled", // error: enabled must be true or false
  "modifiers[i].apply[j].envelope", // error: envelope is a daily-stage onset shape; climate-stage ops cannot carry one | error: envelope must be a non-empty array of [phase, strength] points | warning: envelope has no effect on set/clamp
  "modifiers[i].apply[j].envelope[k]", // error: envelope point must be [phase in [0,1), strength in [0,1]]
  "modifiers[i].apply[j].op", // error: unknown op "warp" — ops are set, offset, scale, clamp
  "modifiers[i].apply[j].param", // error: unknown parameter path "nope"
  "modifiers[i].apply[j].value", // error: "temperature.phase" is a scalar parameter, not a curve — set it to a number | error: set with a curve is climate stage only | error: value must be a finite number
  "modifiers[i].apply[j].value.phase", // error: harmonic phase is required (no silent default)
  "modifiers[i].apply[j].value[k].at", // error: must be in [0,1)
  "modifiers[i].enabled", // error: enabled must be true or false
  "modifiers[i].id", // error: required | error: ids starting with "era:" are reserved for the era timeline | error: duplicate modifier id "era:ice"
  "modifiers[i].mods", // error: gates (mods) are daily-stage only; a climate-stage modifier is unconditional | error: mods must be an array
  "modifiers[i].mods[j]", // error: gate must be an object
  "modifiers[i].mods[j].amont", // warning: unknown field (ignored) — the path is `modifiers[i].mods[j].<any unknown key>`
  "modifiers[i].mods[j].amount", // error: amount must be between 0 and 1 (a gate dims, it never amplifies)
  "modifiers[i].mods[j].source", // error: must be a non-empty string (a tag, never a moon) | error: a gate is a tag; a moon is the carrier (use when.moon)
  "modifiers[i].spell.meanDurationDays", // error: must be >= 1 | warning: very long spells (> 50 days) are looked back over at most 400 days
  "modifiers[i].spell.meanStartsPerYear", // error: must be > 0
  "modifiers[i].stage", // error: must be climate or daily
  "modifiers[i].when", // error: predicate must be an object
  "modifiers[i].when.all[j]", // error: predicate must have exactly one key (got none) | error: predicate must have exactly one key (got tag, regime) | error: predicate must be an object | error: unknown predicate "weather" — the grammar is closed
  "modifiers[i].when.all[j].all", // error: must be an array of predicates
  "modifiers[i].when.all[j].any", // error: must be an array of predicates
  "modifiers[i].when.all[j].chance", // error: must be a number in [0,1]
  "modifiers[i].when.all[j].dayOfYear", // error: range must be [lo, hi]
  "modifiers[i].when.all[j].moon.name", // error: moon name required
  "modifiers[i].when.all[j].moon.phase", // error: range must be [lo, hi] | error: range values must be within [0, 1]
  "modifiers[i].when.all[j].not.chance", // error: must be a number in [0,1]
  "modifiers[i].when.all[j].regime", // error: must be a non-empty string
  "modifiers[i].when.all[j].tag", // error: must be a non-empty string
  "modifiers[i].when.all[j].yearPhase", // error: range values must be within [0, 1]
  "regimes", // error: at least one regime needs weight > 0 | error: at least one regime is required
  "regimes[i].apply", // error: apply must be an array
  "regimes[i].apply[j].value", // error: set with a curve is climate stage only
  "regimes[i].id", // error: required | error: duplicate regime id "settled"
  "regimes[i].meanDurationDays", // error: must be >= 1 | warning: above 30: long-lived states belong in a spell modifier, not a regime
  "regimes[i].weight", // error: must be >= 0
];

describe("validator path map", () => {
  test("the normalised paths are exactly the checked-in list", () => {
    expect(normalised).toEqual(EXPECTED_PATHS);
  });

  test("test/fixtures/studio/validator-paths.json is the same list", () => {
    expect(pathsFixture.paths).toEqual(EXPECTED_PATHS);
  });

  test("every emit site in the three validators is pinned", () => {
    expect(emitSites).toBe(EMIT_SITES);
  });

  test("both levels are represented", () => {
    expect(allIssues.filter((i) => i.level === "error").length).toBe(EXPECTED_ERRORS);
    expect(allIssues.filter((i) => i.level === "warning").length).toBe(EXPECTED_WARNINGS);
    expect(EXPECTED_ERRORS + EXPECTED_WARNINGS).toBe(allIssues.length);
  });

  test("the main fixture carries the bulk of the rules in one document", () => {
    // If this drops sharply a rule left the single-document fixture, and with it
    // the interaction the studio's path map is meant to be exercised against.
    expect(mainIssues.length).toBe(MAIN_FIXTURE_ISSUES);
    expect(miniIssues.flat().length).toBe(MINI_FIXTURES.length);
  });

  test("each mini-fixture earns its place: it raises something the main fixture does not", () => {
    const inMain = new Set(mainIssues.map((i) => `${normalisePath(i.path)} :: ${i.message}`));
    for (const [n, issues] of miniIssues.entries()) {
      const why = MINI_FIXTURES[n]!.why;
      expect(issues.length, why).toBeGreaterThan(0);
      expect(
        issues.some((i) => !inMain.has(`${normalisePath(i.path)} :: ${i.message}`)),
        why,
      ).toBe(true);
    }
  });

  test("normalisePath collapses list indices by depth and keeps tuple slots", () => {
    expect(normalisePath("modifiers[3].apply[7].value[0].at")).toBe("modifiers[i].apply[j].value[k].at");
    expect(normalisePath("automation[0].points[2][0]")).toBe("automation[i].points[j][0]");
    expect(normalisePath("automation[0].points[2][1]")).toBe("automation[i].points[j][1]");
    expect(normalisePath("climate.temperature.persistence")).toBe("climate.temperature.persistence");
  });
});
