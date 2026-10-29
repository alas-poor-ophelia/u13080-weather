/**
 * The Orrery editors' hint table is a contract with the DOM, as the other
 * windows' are (`test/studio-hints-seasons.test.ts`): every key the editors
 * ask for exists, and the table holds exactly the keys they ask for. The
 * window files import Obsidian, so the check is a source scan.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { ORRERY_HINTS, ORRERY_HINT_KEYS, orreryHint } from "../src/studio/model/hints-orrery";

const FILES = ["../src/studio/ui/windows/orrery.ts", "../src/studio/ui/windows/orrery-body.ts"];
const SOURCES = await Promise.all(FILES.map((f) => Bun.file(new URL(f, import.meta.url)).text()));

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const src of SOURCES) for (const m of src.matchAll(/orreryHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("orrery editor hints", () => {
  test("every key the editors use exists in ORRERY_HINTS", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => ORRERY_HINTS[k] === undefined)).toEqual([]);
  });
  test("ORRERY_HINT_KEYS is exactly what the editors ask for", () => {
    expect(keysUsed()).toEqual([...ORRERY_HINT_KEYS].sort());
  });
  test("names and details are non-empty and free of trailing full stops", () => {
    for (const [key, [name, detail]] of Object.entries(ORRERY_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });
  test("orreryHint round-trips through parseHint", () => {
    for (const key of Object.keys(ORRERY_HINTS)) expect(parseHint(orreryHint(key))).toEqual(ORRERY_HINTS[key]!);
  });
});
