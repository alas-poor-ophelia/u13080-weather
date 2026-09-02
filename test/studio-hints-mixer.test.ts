/**
 * The mixer rail's hint table, held against the surface that uses it — the same
 * source-scan contract `studio-hints.test.ts` applies to the header.
 * `src/studio/ui/mixer.ts` imports Obsidian, so it cannot be imported under
 * `bun test`; the check reads its text instead.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { MIXER_HINTS, MIXER_HINT_KEYS, mixerHint } from "../src/studio/model/hints-mixer";

const MIXER_SOURCE = await Bun.file(new URL("../src/studio/ui/mixer.ts", import.meta.url)).text();

function keysUsedByMixer(): string[] {
  const found = new Set<string>();
  for (const m of MIXER_SOURCE.matchAll(/mixerHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio mixer hints", () => {
  test("every key the rail uses exists in MIXER_HINTS", () => {
    const used = keysUsedByMixer();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => MIXER_HINTS[k] === undefined)).toEqual([]);
  });

  test("MIXER_HINT_KEYS is exactly what mixer.ts asks for", () => {
    expect(keysUsedByMixer()).toEqual([...MIXER_HINT_KEYS].sort());
  });

  test("the rail covers every control SPEC 3.3 lists", () => {
    for (const key of ["mixer.chain", "mixer.insert", "mixer.strip", "mixer.regimes.led", "mixer.regimes.name", "mixer.forcings.led", "mixer.forcings.name", "mixer.unit.led", "mixer.unit.name", "mixer.unit.grip", "mixer.empty"]) {
      expect(MIXER_HINT_KEYS).toContain(key);
    }
    for (const key of ["mixer.master.led", "mixer.master.warmth", "mixer.master.wetness"]) expect(MIXER_HINT_KEYS).toContain(key);
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(MIXER_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("mixerHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(MIXER_HINTS)) expect(parseHint(mixerHint(key))).toEqual(MIXER_HINTS[key]!);
    expect(parseHint(mixerHint("mixer.unit.led", "off in this chain"))).toEqual(["Device power", "off in this chain"]);
    expect(mixerHint("mixer.nope")).toBe("mixer.nope");
  });
});
