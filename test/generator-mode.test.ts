/**
 * wadjet-9lc (docs/SESHAT-v0.md §17.2, §17.3): the GeneratorMode is threaded
 * per instance (step 0), and "previous" runs the 0.0.3 formulas (step 1; the
 * verbatim gate is test/golden-previous.test.ts). The stamped
 * provenance.generatorVersion follows the mode, and a mode change re-keys the
 * world (profiles-changed, all: true).
 */
import { describe, expect, test } from "bun:test";
import { ModifierEngine } from "../src/core/modifiers";
import { legacyMoonPhase } from "../src/core/previous";
import { createGenerator } from "../src/core/profile";
import { bernoulli, drawKey, DrawStream, hash32 } from "../src/core/rng";
import type { DayTime, Modifier, Predicate, ZoneProfile } from "../src/core/types";
import { GENERATOR_VERSION, generatorVersionOf, modeFor, PREVIOUS_GENERATOR_VERSION, type GeneratorMode } from "../src/core/version";
import { PRESETS } from "../src/generated/presets";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World, type WorldState } from "../src/plugin/world";
import { moonPhaseAt } from "../src/studio/model/spans";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
// an envelope on a moon, a phase window, a spell, and a plain modifier on an exact window edge
const MODS: Modifier[] = [
  { id: "tide", when: { moon: { name: "Sable", phase: [0.4, 0.6] } }, apply: [{ param: "wind.speed", op: "offset", value: 8, envelope: [[0.4, 0], [0.5, 1], [0.6, 0]] }], tag: "tide" },
  { id: "thaw", when: { yearPhase: [0.2, 0.4] }, spell: { meanStartsPerYear: 4, meanDurationDays: 5 }, apply: [{ param: "temperature.mean", op: "offset", value: 3 }], tag: "thaw" },
  { id: "thaw-edge", when: { yearPhase: [0.2, 0.4] }, apply: [{ param: "temperature.mean", op: "offset", value: 1 }], tag: "thaw-edge" },
];
const zone: ZoneProfile = { id: "z", name: "z", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: MODS };
const CAL = { yearLength: 365, epochYear: 1, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }], seasons: [{ name: "Spring", from: 0.2 }, { name: "Winter", from: 0.7 }] };

function worldOf(mode: WorldState["generatorMode"]): World {
  const cal = new InternalCalendar(CAL, () => 0, undefined, mode);
  const time = new TimeRegistry(cal.id);
  time.register(cal);
  return new World({ seed: "mode", zones: [zone], overrides: [], ...(mode ? { generatorMode: mode } : {}) }, time);
}

describe("GeneratorMode", () => {
  test("modeFor and generatorVersionOf", () => {
    expect(modeFor(PREVIOUS_GENERATOR_VERSION)).toBe("previous");
    expect(modeFor(GENERATOR_VERSION)).toBe("current");
    expect(modeFor("wadjet-gen/0.0.2")).toBe("current");
    expect(modeFor(undefined)).toBe("current");
    expect(generatorVersionOf("previous")).toBe(PREVIOUS_GENERATOR_VERSION);
    expect(generatorVersionOf("current")).toBe(GENERATOR_VERSION);
  });

  test("createGenerator: the mode reaches the engine, and the two generators differ", () => {
    const cal = new InternalCalendar(CAL, () => 0);
    const timeOf = (d: number) => cal.toContext(d);
    const cur = createGenerator(zone, "mode", timeOf, [], "current");
    const prev = createGenerator(zone, "mode", timeOf, [], "previous");
    expect(prev.engine.mode).toBe("previous");
    expect(createGenerator(zone, "mode", timeOf).engine.mode).toBe("current");
    // day 73 of 365 is yearPhase 0.2 exactly: 0.0.3's wrap puts it an ulp low, outside [0.2, 0.4)
    expect(prev.engine.forDay(73, "").active).not.toContain("thaw-edge");
    expect(cur.engine.forDay(73, "").active).toContain("thaw-edge");
    expect(prev.generator.range(0, 730)).not.toEqual(cur.generator.range(0, 730));
  });

  test("InternalCalendar: previous mode has 0.0.3's float moons and hash; the rest of the day is the same", () => {
    const cur = new InternalCalendar(CAL, () => 0);
    const prev = new InternalCalendar(CAL, () => 0, undefined, "previous");
    expect(prev.generatorMode).toBe("previous");
    // 0.0.3's hash: the inputs alone, no SESHAT_VERSION key
    const moons = CAL.moons.map((m) => ({ name: m.name, cycleDays: m.cycleDays, phaseAtEpoch: m.phaseAtEpoch }));
    const old = `ical:${hash32(JSON.stringify({ y: CAL.yearLength, e: CAL.epochYear, m: moons, s: CAL.seasons }), 0x43414c45).toString(16).padStart(8, "0")}`;
    expect(prev.configHash()).toBe(old);
    expect(cur.configHash()).not.toBe(old);
    let drift = 0;
    for (let d = -400; d < 800; d += 7) {
      const p = prev.toContext(d);
      const c = cur.toContext(d);
      expect(p.moons).toEqual([{ name: "Sable", phase: legacyMoonPhase(29.53, 0, d) }]);
      if (p.moons![0]!.phase !== c.moons![0]!.phase) drift++;
      expect({ ...p, moons: [] }).toEqual({ ...c, moons: [] });
    }
    expect(drift).toBeGreaterThan(0);
    prev.update(CAL, "current");
    expect(prev.generatorMode).toBe("current");
    expect(prev.configHash()).toBe(cur.configHash());
  });

  test("Studio moonPhaseAt follows the mode, so its moon matches the calendar's in each", () => {
    const moon = CAL.moons[0]!;
    for (const mode of ["previous", "current"] as const) {
      const cal = new InternalCalendar(CAL, () => 0, undefined, mode);
      for (let d = -400; d < 800; d += 3) expect(moonPhaseAt(moon, d, mode)).toBe(cal.toContext(d).moons![0]!.phase);
    }
    expect(moonPhaseAt(moon, 0)).toBe(moonPhaseAt(moon, 0, "current"));
  });

  test("World: previous mode stamps 0.0.3 and runs it", () => {
    const cur = worldOf(undefined);
    const prev = worldOf("previous");
    expect(cur.generatorVersion).toBe(GENERATOR_VERSION);
    expect(prev.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    for (const r of [prev.getReport("z", { dayOrdinal: 73 }), ...prev.getRange("z", 0, 30)]) expect(r.provenance.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    expect(prev.getReport("z", { dayOrdinal: 73 }).conditions).not.toContain("thaw-edge");
    expect(cur.getReport("z", { dayOrdinal: 73 }).conditions).toContain("thaw-edge");
  });

  test("World: a mode change fires profiles-changed for every zone and rebuilds the generator", () => {
    const w = worldOf(undefined);
    expect(w.getReport("z", { dayOrdinal: 5 }).provenance.generatorVersion).toBe(GENERATOR_VERSION);
    const seen: Array<{ all: boolean; zoneIds: readonly string[] }> = [];
    w.on("profiles-changed", (p) => seen.push(p));
    w.setState({ seed: "mode", zones: [zone], overrides: [], generatorMode: "previous" });
    expect(seen.at(-1)).toMatchObject({ all: true, zoneIds: ["z"] });
    expect(w.getReport("z", { dayOrdinal: 5 }).provenance.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    w.setState({ seed: "mode", zones: [zone], overrides: [], generatorMode: "previous" });
    expect(seen.at(-1)).toMatchObject({ all: false, zoneIds: [] });
  });
});

/**
 * 0.0.3's spell window, copied from c773f5d's minus side (stripRegime and the old evaluator with the old
 * wrap), as the reference for the window cases the dense oracle cannot tell apart: there every gated
 * spell's old window is empty (365), and counting `=== true` with regime and era terms unknown gives 365
 * too. A positive regime or era term inside the reference year is where the two differ.
 */
function oldWindow(when: Predicate | undefined, timeOf: (d: number) => DayTime, seed: string, zoneId: string, id: string): number {
  const inRange = (x: number, lo: number, hi: number): boolean => {
    const t = ((x % 1) + 1) % 1;
    if (lo === hi) return false;
    return lo < hi ? t >= lo && t < hi : t >= lo || t < hi;
  };
  const ev = (p: Predicate, t: DayTime, d: number): boolean => {
    if ("all" in p) return p.all.every((q) => ev(q, t, d));
    if ("any" in p) return p.any.some((q) => ev(q, t, d));
    if ("not" in p) return !ev(p.not, t, d);
    if ("moon" in p) {
      const m = t.moons?.find((x) => x.name === p.moon.name);
      return m ? inRange(m.phase, p.moon.phase[0], p.moon.phase[1]) : false;
    }
    if ("yearPhase" in p) return inRange(t.yearPhase, p.yearPhase[0], p.yearPhase[1]);
    if ("dayOfYear" in p) return t.dayOfYear === undefined ? false : t.dayOfYear >= p.dayOfYear[0] && t.dayOfYear <= p.dayOfYear[1];
    if ("tag" in p) return t.tags?.includes(p.tag) ?? false;
    if ("regime" in p) return p.regime === "";
    if ("chance" in p) return bernoulli(new DrawStream(drawKey(seed, zoneId, d, `mod:${id}:chance`)), p.chance);
    return false;
  };
  const strip = (p: Predicate): Predicate => {
    if ("all" in p) return { all: p.all.map(strip) };
    if ("any" in p) return { any: p.any.map(strip) };
    if ("not" in p) return { not: strip(p.not) };
    if ("regime" in p) return { all: [] };
    return p;
  };
  if (!when) return 365;
  const w = strip(when);
  let n = 0;
  for (let d = 0; d < 365; d++) if (ev(w, timeOf(d), d)) n++;
  return n === 0 ? 365 : n;
}

describe("previous mode: the spell window is 0.0.3's", () => {
  // a 400-day year with era:Dawn on days 0..199; 0.0.3 scanned days 0..364 whatever the year
  const timeOf = (d: number): DayTime & { yearLength: number } => {
    const y = 400;
    const doy = ((d % y) + y) % y;
    return { yearPhase: doy / y, dayOfYear: doy, year: Math.floor(d / y), yearLength: y, moons: [{ name: "Sable", phase: legacyMoonPhase(29.53, 0, d) }], tags: d >= 0 && d < 200 ? ["era:Dawn"] : [] };
  };
  const spell = { meanStartsPerYear: 4, meanDurationDays: 3 };
  const cases: Record<string, Predicate | undefined> = {
    none: undefined,
    regime: { all: [{ yearPhase: [0.2, 0.5] }, { regime: "wet" }] },
    notRegime: { all: [{ yearPhase: [0.2, 0.5] }, { not: { regime: "wet" } }] },
    anyRegime: { any: [{ yearPhase: [0.2, 0.3] }, { regime: "wet" }] },
    era: { all: [{ yearPhase: [0.1, 0.6] }, { tag: "era:Dawn" }] },
    notEra: { all: [{ yearPhase: [0.1, 0.6] }, { not: { tag: "era:Dawn" } }] },
    moon: { moon: { name: "Sable", phase: [0.2, 0.4] } },
    chance: { all: [{ chance: 0.3 }, { dayOfYear: [10, 300] }] },
  };
  const mods = Object.entries(cases).map(([id, when]): Modifier => ({ id, ...(when ? { when } : {}), spell, apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }));
  const windows = (mode: GeneratorMode) => (new ModifierEngine({ seed: "w", zoneId: "z", modifiers: mods, timeOf, mode }) as unknown as { windowDays: Map<string, number> }).windowDays;

  test("every case matches the 0.0.3 reference, and current mode differs on several", () => {
    const prev = windows("previous");
    const cur = windows("current");
    for (const m of mods) expect({ id: m.id, n: prev.get(m.id) }).toEqual({ id: m.id, n: oldWindow(m.when, timeOf, "w", "z", m.id) });
    expect(prev.get("regime")).toBeLessThan(365);
    expect(prev.get("era")).toBeLessThan(365);
    expect(mods.filter((m) => prev.get(m.id) !== cur.get(m.id)).length).toBeGreaterThan(3);
  });
});
