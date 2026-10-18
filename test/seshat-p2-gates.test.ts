/**
 * Seshat P2 step-0 gates (docs/SESHAT-v0.md §9): what the predicate migration
 * must leave exactly as it is.
 *
 *   - the frozen predicate oracle (golden-pred.ts) still matches the evaluator;
 *   - running the engine leaves the stored zone, era and modifier objects
 *     untouched, key for key (symbols included), so nothing the migration
 *     caches on them can reach profileHash / erasHash / calendarHash;
 *   - those hashes equal the strings the calendar golden recorded.
 */
import { describe, expect, test } from "bun:test";
import { erasHash } from "../src/core/eras";
import { profileHash } from "../src/core/profile";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { World } from "../src/plugin/world";
import { CAL_SEED, compareGoldenCal, makeWorlds, type GoldenCal } from "./golden/golden-cal";
import { buildGoldenPred } from "./golden/golden-pred";
import storedCal from "./golden/calendar.json";
import storedPred from "./golden/predicates.json";

/** Every own key path of a value, symbols and non-enumerables included. */
function keyPaths(v: unknown, path = "", out: string[] = []): string[] {
  if (typeof v !== "object" || v === null) return out;
  for (const k of Reflect.ownKeys(v)) {
    const p = `${path}/${String(k)}`;
    out.push(p);
    keyPaths((v as Record<PropertyKey, unknown>)[k], p, out);
  }
  return out;
}

describe("Seshat P2 gates", () => {
  test("predicates.json matches the evaluator (both modes, every world, zone and edge)", () => {
    expect(compareGoldenCal(storedPred as unknown as GoldenCal, buildGoldenPred() as unknown as GoldenCal)).toEqual([]);
  });

  test("running the engine leaves zones and eras untouched and their hashes at the golden strings", () => {
    const cal = storedCal as unknown as GoldenCal;
    // fresh objects: the oracle test above has already run engines over the shared WORLDS
    for (const [i, w] of makeWorlds().entries()) {
      const adapter = w.adapter();
      const time = new TimeRegistry(adapter.id);
      time.register(adapter);
      const before = { zones: keyPaths(w.zones), eras: keyPaths(w.eras), json: JSON.stringify([w.zones, w.eras]), erasHash: erasHash(w.eras) };
      const world = new World({ seed: CAL_SEED, zones: w.zones, eras: w.eras, overrides: [] }, time);
      for (const z of w.zones) {
        // spell days look back up to 400 days, so this drives every compiled path
        for (let d = -30; d <= 30; d++) world.getReport(z.id, { dayOrdinal: d });
        const stored = cal.worlds[i]!.zones.find((s) => s.zoneId === z.id)!;
        expect(profileHash(z)).toBe(stored.provenance.profileHash);
      }
      expect(keyPaths(w.zones)).toEqual(before.zones);
      expect(keyPaths(w.eras)).toEqual(before.eras);
      expect(JSON.stringify([w.zones, w.eras])).toBe(before.json);
      expect(erasHash(w.eras)).toBe(before.erasHash);
      expect(world.calendarHash()).toBe(cal.worlds[i]!.calendarHash);
    }
  }, 30_000);
});
