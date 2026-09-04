/**
 * The CYCLE window's hint table, held against the window that uses it — the
 * same source-scan contract `studio-hints.test.ts` applies to the header.
 * `src/studio/ui/windows/cycle.ts` imports Obsidian, so it cannot be imported
 * under `bun test`; the check reads its text instead.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { CYCLE_HINTS, CYCLE_HINT_KEYS, cycleHint } from "../src/studio/model/hints-cycle";

const CYCLE_SOURCE = await Bun.file(new URL("../src/studio/ui/windows/cycle.ts", import.meta.url)).text();

function keysUsedByCycle(): string[] {
  const found = new Set<string>();
  for (const m of CYCLE_SOURCE.matchAll(/cycleHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio cycle hints", () => {
  test("every key the cycle window uses exists in CYCLE_HINTS", () => {
    const used = keysUsedByCycle();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => CYCLE_HINTS[k] === undefined)).toEqual([]);
  });

  test("CYCLE_HINT_KEYS is exactly what cycle.ts asks for", () => {
    expect(keysUsedByCycle()).toEqual([...CYCLE_HINT_KEYS].sort());
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(CYCLE_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("cycleHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(CYCLE_HINTS)) expect(parseHint(cycleHint(key))).toEqual(CYCLE_HINTS[key]!);
    expect(cycleHint("cycle.nope")).toBe("cycle.nope");
    expect(parseHint(cycleHint("cycle.split", "custom detail"))).toEqual(["Split phase", "custom detail"]);
  });
});
