/**
 * The channel editor window's hint table, held against the one file that uses
 * it — the same source-scan contract `studio-hints-forcings.test.ts` applies
 * to the Forcings panel. The window imports Obsidian, so it cannot be
 * imported under `bun test`; the check reads its text instead.
 */
import { describe, expect, test } from "bun:test";
import { CHANNEL_EDITOR_HINTS, CHANNEL_EDITOR_HINT_KEYS, channelEditorHint } from "../src/studio/model/hints-channel";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";

const SOURCE = await Bun.file(new URL("../src/studio/ui/windows/channel.ts", import.meta.url)).text();

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const m of SOURCE.matchAll(/channelEditorHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

describe("studio channel editor hints", () => {
  test("every key the window uses exists in CHANNEL_EDITOR_HINTS", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => CHANNEL_EDITOR_HINTS[k] === undefined)).toEqual([]);
  });

  test("CHANNEL_EDITOR_HINT_KEYS is exactly what the window asks for", () => {
    expect(keysUsed()).toEqual([...CHANNEL_EDITOR_HINT_KEYS].sort());
  });

  test("names and details are microcopy, not prose", () => {
    for (const [key, [name, detail]] of Object.entries(CHANNEL_EDITOR_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("channelEditorHint round-trips through parseHint, and an unknown key is visible", () => {
    for (const key of Object.keys(CHANNEL_EDITOR_HINTS)) expect(parseHint(channelEditorHint(key))).toEqual(CHANNEL_EDITOR_HINTS[key]!);
    expect(channelEditorHint("channel.nope")).toBe("channel.nope");
    expect(parseHint(channelEditorHint("channel.swing", "custom detail"))).toEqual(["Swing", "custom detail"]);
  });
});
