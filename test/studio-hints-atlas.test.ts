/**
 * The Atlas window's hint table, held against the file that uses it — the same
 * source-scan contract `studio-hints-forcings.test.ts` applies to the Forcings
 * window. `windows/atlas.ts` imports Obsidian, so it cannot be imported under
 * `bun test`; the check reads its text instead.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { ATLAS_HINTS, ATLAS_HINT_KEYS, atlasHint } from "../src/studio/model/hints-atlas";

const SOURCE = await Bun.file(new URL("../src/studio/ui/windows/atlas.ts", import.meta.url)).text();

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/atlasHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio atlas hints", () => {
  test("every key the window uses exists in ATLAS_HINTS", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => ATLAS_HINTS[k] === undefined)).toEqual([]);
  });

  test("ATLAS_HINT_KEYS is exactly what the window asks for", () => {
    expect(keysUsed()).toEqual([...ATLAS_HINT_KEYS].sort());
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(ATLAS_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("atlasHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(ATLAS_HINTS)) expect(parseHint(atlasHint(key))).toEqual(ATLAS_HINTS[key]!);
    expect(atlasHint("atlas.nope")).toBe("atlas.nope");
    expect(parseHint(atlasHint("atlas.latitude", "custom detail"))).toEqual(["Latitude", "custom detail"]);
  });
});
