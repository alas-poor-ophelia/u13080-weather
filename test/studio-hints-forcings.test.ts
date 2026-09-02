/**
 * The Forcings window's and the FRC · warmth row's hint table, held against
 * the two files that use it — the same source-scan contract
 * `studio-hints-era.test.ts` applies to the ERA window. Both files import
 * Obsidian, so they cannot be imported under `bun test`; the check reads
 * their text instead.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { FORCINGS_HINTS, FORCINGS_HINT_KEYS, forcingsHint } from "../src/studio/model/hints-forcings";

const SOURCES = await Promise.all(
  ["../src/studio/ui/windows/forcings.ts", "../src/studio/ui/rows/automation-row.ts"].map((p) => Bun.file(new URL(p, import.meta.url)).text()),
);

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const source of SOURCES) for (const m of source.matchAll(/forcingsHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio forcings hints", () => {
  test("every key the window and the row use exists in FORCINGS_HINTS", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => FORCINGS_HINTS[k] === undefined)).toEqual([]);
  });

  test("FORCINGS_HINT_KEYS is exactly what those two files ask for", () => {
    expect(keysUsed()).toEqual([...FORCINGS_HINT_KEYS].sort());
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(FORCINGS_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("forcingsHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(FORCINGS_HINTS)) expect(parseHint(forcingsHint(key))).toEqual(FORCINGS_HINTS[key]!);
    expect(forcingsHint("forcings.nope")).toBe("forcings.nope");
    expect(parseHint(forcingsHint("forcings.trim", "custom detail"))).toEqual(["Trim", "custom detail"]);
  });
});
