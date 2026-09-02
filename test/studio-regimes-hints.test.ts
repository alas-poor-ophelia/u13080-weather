/**
 * The regimes window's hint table is a contract with its DOM: every control it
 * builds carries `data-hint`, and every one of those attributes comes from
 * `regimeHint(key)`. A control added without an entry would print the raw key
 * into the hint bar — exactly the kind of thing that ships unnoticed.
 *
 * `src/studio/ui/windows/regimes.ts` imports Obsidian, so it cannot be imported
 * under `bun test` (the `obsidian` package is typings only). The check is
 * therefore a source scan, the same one `studio-hints.test.ts` runs against the
 * header.
 */
import { describe, expect, test } from "bun:test";
import { REGIME_HINTS, REGIME_HINT_KEYS, regimeHint } from "../src/studio/model/hints-regimes";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";

const WINDOW_SOURCE = await Bun.file(new URL("../src/studio/ui/windows/regimes.ts", import.meta.url)).text();

function keysUsedByWindow(): string[] {
  const found = new Set<string>();
  for (const m of WINDOW_SOURCE.matchAll(/regimeHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio regimes hints", () => {
  test("every key the window uses exists in REGIME_HINTS", () => {
    const used = keysUsedByWindow();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => REGIME_HINTS[k] === undefined)).toEqual([]);
  });

  test("REGIME_HINT_KEYS is exactly what the window asks for", () => {
    expect(keysUsedByWindow()).toEqual([...REGIME_HINT_KEYS].sort());
  });

  test("the table covers every control SPEC 3.4 lists for the window", () => {
    // swatch · name · how often · how long · × · ＋ state · share bar · apply knob · op LED · op ＋ · op ×
    expect(REGIME_HINT_KEYS.length).toBe(11);
    for (const key of ["regimes.swatch", "regimes.name", "regimes.weight", "regimes.dwell", "regimes.remove", "regimes.add", "regimes.share", "regimes.apply", "regimes.applyMute", "regimes.applyAdd", "regimes.applyRemove"]) {
      expect(REGIME_HINT_KEYS).toContain(key);
    }
  });

  test("names and details are product microcopy, and parse back out of the attribute", () => {
    for (const [key, [name, detail]] of Object.entries(REGIME_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      // The separator belongs to the attribute; neither half may contain it.
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
      expect(detail.includes(HINT_SEPARATOR), key).toBe(false);
      expect(parseHint(regimeHint(key))).toEqual([name, detail]);
    }
  });

  test("regimeHint takes a detail override without losing the name", () => {
    expect(parseHint(regimeHint("regimes.dwell", "over 30 d; a long-lived state belongs in a spell device"))).toEqual(["How long", "over 30 d; a long-lived state belongs in a spell device"]);
  });

  test("an unknown key is visible rather than blank", () => {
    expect(regimeHint("regimes.nope")).toBe("regimes.nope");
  });
});
