/**
 * The device window's hint table is a contract with its DOM: every control the
 * window builds carries `data-hint`, and every one of those attributes is
 * built by `deviceHint(key)`. A control added without an entry would render
 * the raw key into the hint bar.
 *
 * `src/studio/ui/windows/device.ts` imports Obsidian, so it cannot be imported
 * under `bun test` (the `obsidian` package is typings only). The check is a
 * source scan, in both directions — the same shape as `studio-hints.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { DEVICE_HINTS, DEVICE_HINT_KEYS, deviceHint } from "../src/studio/model/hints-device";

const WINDOW_SOURCE = await Bun.file(new URL("../src/studio/ui/windows/device.ts", import.meta.url)).text();

function keysUsedByWindow(): string[] {
  const found = new Set<string>();
  for (const m of WINDOW_SOURCE.matchAll(/deviceHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("device hints", () => {
  test("every key the device window uses exists in DEVICE_HINTS", () => {
    const used = keysUsedByWindow();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => DEVICE_HINTS[k] === undefined)).toEqual([]);
  });

  test("DEVICE_HINT_KEYS is exactly what device.ts asks for", () => {
    expect(keysUsedByWindow()).toEqual([...DEVICE_HINT_KEYS].sort());
  });

  // The name and the preset control moved into the shared window chrome
  // (SPEC §3.4 "one title row"), which carries no `data-hint` of its own, so
  // they are no longer this table's business.
  test("the table covers every section SPEC 3.4 lists for a device", () => {
    for (const key of ["device.power", "device.when", "device.spell", "device.op", "device.mod", "device.remove"]) {
      expect(DEVICE_HINT_KEYS).toContain(key);
    }
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(DEVICE_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("deviceHint round-trips through parseHint and takes a detail override", () => {
    for (const key of DEVICE_HINT_KEYS) expect(parseHint(deviceHint(key))).toEqual(DEVICE_HINTS[key]!);
    expect(parseHint(deviceHint("device.spell.duration", "70 days is longer than a season"))).toEqual(["Duration", "70 days is longer than a season"]);
  });

  test("an unknown key is visible rather than blank", () => {
    expect(deviceHint("nope.missing")).toBe("nope.missing");
  });
});
