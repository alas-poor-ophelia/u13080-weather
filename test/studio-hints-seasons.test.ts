/**
 * The Seasons window's hint table is a contract with the DOM, the same way
 * the header's is (`test/studio-hints.test.ts`): every control the window
 * builds carries `data-hint`, and every one of those attributes is built by
 * `seasonsHint(key)`. A control added without an entry would render the raw
 * key into the hint bar.
 *
 * `src/studio/ui/windows/seasons.ts` imports Obsidian, so it cannot be
 * imported under `bun test` (the `obsidian` package is typings only). The
 * check is therefore a source scan, mirroring `studio-hints.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { SEASONS_HINTS, SEASONS_HINT_KEYS, seasonsHint } from "../src/studio/model/hints-seasons";

const SEASONS_SOURCE = await Bun.file(new URL("../src/studio/ui/windows/seasons.ts", import.meta.url)).text();

/** Every `seasonsHint("key"…)` the window asks for, deduped and sorted. */
function keysUsedBySeasons(): string[] {
  const found = new Set<string>();
  for (const m of SEASONS_SOURCE.matchAll(/seasonsHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("seasons window hints", () => {
  test("every key the window uses exists in SEASONS_HINTS", () => {
    const used = keysUsedBySeasons();
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((k) => SEASONS_HINTS[k] === undefined);
    expect(missing).toEqual([]);
  });

  test("SEASONS_HINT_KEYS is exactly what seasons.ts asks for", () => {
    expect(keysUsedBySeasons()).toEqual([...SEASONS_HINT_KEYS].sort());
  });

  test("the window covers every control SPEC 3.4 'Seasons' lists", () => {
    for (const key of ["seasons.source", "seasons.world", "seasons.flag", "seasons.bar", "seasons.rename", "seasons.merge", "seasons.split", "seasons.day", "seasons.editHint"]) {
      expect(SEASONS_HINT_KEYS).toContain(key);
    }
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(SEASONS_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("seasonsHint round-trips through parseHint", () => {
    for (const key of Object.keys(SEASONS_HINTS)) {
      expect(parseHint(seasonsHint(key))).toEqual(SEASONS_HINTS[key]!);
    }
  });

  test("seasonsHint takes a detail override without losing the name", () => {
    expect(parseHint(seasonsHint("seasons.merge", "only one season left"))).toEqual(["Merge", "only one season left"]);
  });

  test("an unknown key is visible rather than blank", () => {
    expect(seasonsHint("nope.missing")).toBe("nope.missing");
    expect(parseHint("nope.missing")).toEqual(["nope.missing", ""]);
  });
});
