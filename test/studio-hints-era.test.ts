/**
 * The Era window's hint table, held against the window that uses it — the
 * same source-scan contract `studio-hints-cycle.test.ts` applies to CYCLE.
 * `src/studio/ui/windows/era.ts` imports Obsidian, so it cannot be imported
 * under `bun test`; the check reads its text instead.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { ERA_HINTS, ERA_HINT_KEYS, eraHint } from "../src/studio/model/hints-era";

const ERA_SOURCE = await Bun.file(new URL("../src/studio/ui/windows/era.ts", import.meta.url)).text();

function keysUsedByEra(): string[] {
  const found = new Set<string>();
  for (const m of ERA_SOURCE.matchAll(/eraHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio era hints", () => {
  test("every key the era window uses exists in ERA_HINTS", () => {
    const used = keysUsedByEra();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => ERA_HINTS[k] === undefined)).toEqual([]);
  });

  test("ERA_HINT_KEYS is exactly what era.ts asks for", () => {
    expect(keysUsedByEra()).toEqual([...ERA_HINT_KEYS].sort());
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(ERA_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("eraHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(ERA_HINTS)) expect(parseHint(eraHint(key))).toEqual(ERA_HINTS[key]!);
    expect(eraHint("era.nope")).toBe("era.nope");
    expect(parseHint(eraHint("era.from", "custom detail"))).toEqual(["From", "custom detail"]);
  });
});
