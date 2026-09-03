/**
 * The hint table is a contract with the DOM: every control the header builds
 * carries `data-hint`, and every one of those attributes is built by
 * `hintAttr(key)`. A control added without an entry would render the raw key
 * into the hint bar, which is exactly the kind of thing that ships unnoticed.
 *
 * `src/studio/ui/header.ts` imports Obsidian, so it cannot be imported under
 * `bun test` (the `obsidian` package is typings only). The check is therefore a
 * source scan: pull every `hintAttr("…")` key out of the header's text and hold
 * it against `HEADER_HINT_KEYS`, in both directions.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_HINT, HEADER_HINT_KEYS, HINTS, HINT_SEPARATOR, hintAttr, parseHint } from "../src/studio/model/hints";

const HEADER_SOURCE = await Bun.file(new URL("../src/studio/ui/header.ts", import.meta.url)).text();

/** Every `hintAttr("key"…)` the header asks for, deduped and sorted. */
function keysUsedByHeader(): string[] {
  const found = new Set<string>();
  for (const m of HEADER_SOURCE.matchAll(/hintAttr\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio hints", () => {
  test("every key the header uses exists in HINTS", () => {
    const used = keysUsedByHeader();
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((k) => HINTS[k] === undefined);
    expect(missing).toEqual([]);
  });

  test("HEADER_HINT_KEYS is exactly what header.ts asks for", () => {
    expect(keysUsedByHeader()).toEqual([...HEADER_HINT_KEYS].sort());
  });

  test("the header covers every control SPEC 3.1 lists", () => {
    // zone menu · koppen · src · flip · readout · transport ×4 · presets ×5 · json · save.
    // No undo/redo: the prototype has no history buttons in the header and
    // SPEC §3.1 does not list them; the leaf's own Mod+Z scope keeps the
    // feature reachable (bead wadjet-6rw.6).
    expect(HEADER_HINT_KEYS.length).toBe(16);
    for (const key of ["zone.menu", "zone.koppen", "zone.src", "zone.flip", "transport.readout", "header.json", "header.save"]) {
      expect(HEADER_HINT_KEYS).toContain(key);
    }
    for (const t of ["back", "forward", "out", "in"]) expect(HEADER_HINT_KEYS).toContain(`transport.${t}`);
    for (const p of ["day", "month", "season", "year", "era"]) expect(HEADER_HINT_KEYS).toContain(`zoom.${p}`);
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      // Product microcopy, not prose: no full stops at the end of either half.
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      // The separator is reserved for the attribute; it must not appear inside a half.
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("hintAttr round-trips through parseHint", () => {
    for (const key of Object.keys(HINTS)) {
      expect(parseHint(hintAttr(key))).toEqual(HINTS[key]!);
    }
  });

  test("hintAttr takes a detail override without losing the name", () => {
    expect(parseHint(hintAttr("header.save", "2 issues block the save"))).toEqual(["save", "2 issues block the save"]);
  });

  test("chrome hint names are lower case; only a real name keeps its capital", () => {
    // The prototype writes `zoom preset`, `zone file`, `opposite hemisphere`
    // (`0025-header.html`, `0065-hint-bar-*.html`): a chrome hint names a
    // control, not a thing, and title case made every one read like a proper
    // noun. `Köppen` is the header's one exception — it is a person's name.
    const named = new Set(["zone.koppen"]);
    for (const [key, [name]] of Object.entries(HINTS)) {
      const first = name[0]!;
      if (named.has(key)) expect(first, key).toBe(first.toUpperCase());
      else expect(first, key).toBe(first.toLowerCase());
    }
    expect(HINTS["zoom.day"]![0]).toBe("zoom preset");
    expect(HINTS["header.json"]![0]).toBe("zone file");
  });

  test("an unknown key is visible rather than blank", () => {
    expect(hintAttr("nope.missing")).toBe("nope.missing");
    expect(parseHint("nope.missing")).toEqual(["nope.missing", ""]);
  });

  test("the default hint is what an unhinted hover falls back to", () => {
    expect(DEFAULT_HINT[0]).toBe("Climate studio");
    expect(DEFAULT_HINT[1].length).toBeGreaterThan(0);
  });
});
