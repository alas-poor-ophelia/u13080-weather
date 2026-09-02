/**
 * The channel rows' hint table is a contract with their DOM, the same way
 * `studio-hints-playlist.test.ts` holds the playlist surface to `PLAYLIST_HINTS`:
 * `ui/rows/channel-row.ts` and `ui/day-card.ts` both import Obsidian, so the
 * check is a source scan of every `channelHint("…")` the two files ask for.
 *
 * The four `row.<channel>` keys themselves stay in `hints-playlist.ts` — they
 * are data on `playlist.ts`'s `CHANNELS` list, which the mixer also reads —
 * so what is asserted here is that `channelRowDetail` gives every one of them
 * a live detail rather than leaving the placeholder copy in place.
 */
import { describe as suite, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { CHANNEL_HINTS, CHANNEL_HINT_KEYS, DAY_CARD_DETAIL, channelHint, channelRowDetail } from "../src/studio/model/hints-channels";
import { PLAYLIST_HINTS, playlistHint } from "../src/studio/model/hints-playlist";
import type { Channel } from "../src/studio/model/compile";

const SOURCES = await Promise.all(
  ["../src/studio/ui/rows/channel-row.ts", "../src/studio/ui/day-card.ts"].map(async (p) => ({
    path: p,
    text: await Bun.file(new URL(p, import.meta.url)).text(),
  })),
);

const CHANNELS: Channel[] = ["temperature", "precipitation", "wind", "sky"];

function keysUsed(): string[] {
  const found = new Set<string>();
  for (const { text } of SOURCES) {
    for (const m of text.matchAll(/channelHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

suite("studio channel hints", () => {
  test("CHANNEL_HINT_KEYS is exactly what the rows and the day card ask for", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used).toEqual([...CHANNEL_HINT_KEYS].sort());
  });

  test("CHANNEL_HINT_KEYS and CHANNEL_HINTS describe the same set", () => {
    expect([...CHANNEL_HINT_KEYS].sort()).toEqual(Object.keys(CHANNEL_HINTS).sort());
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(CHANNEL_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name[0], key).toBe(name[0]!.toUpperCase());
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("channelHint round-trips through hints.ts's parseHint", () => {
    for (const key of Object.keys(CHANNEL_HINTS)) {
      expect(parseHint(channelHint(key))).toEqual(CHANNEL_HINTS[key]!);
    }
  });

  test("an unknown key is visible rather than blank", () => {
    expect(channelHint("nope.missing")).toBe("nope.missing");
  });

  test("every channel has a live row detail that replaces the placeholder copy", () => {
    for (const channel of CHANNELS) {
      const detail = channelRowDetail(channel);
      expect(detail.length, channel).toBeGreaterThan(0);
      expect(detail.endsWith("."), channel).toBe(false);
      expect(detail.includes(HINT_SEPARATOR), channel).toBe(false);
      expect(detail, channel).not.toContain("until the channel rows land");
      // The name half still comes from the playlist's own table.
      expect(parseHint(playlistHint(`row.${channel}`, detail))).toEqual([PLAYLIST_HINTS[`row.${channel}`]![0], detail]);
    }
  });

  test("the day card's detail replaces the playlist table's placeholder too", () => {
    expect(DAY_CARD_DETAIL.length).toBeGreaterThan(0);
    expect(DAY_CARD_DETAIL).not.toContain("arrives with the channel rows");
    expect(parseHint(playlistHint("playlist.daycard", DAY_CARD_DETAIL))).toEqual(["Day card", DAY_CARD_DETAIL]);
  });

  test("the channel table does not collide with the header's, the playlist's or the rows'", async () => {
    const { HINTS } = await import("../src/studio/model/hints");
    const { ROW_HINTS } = await import("../src/studio/model/hints-rows");
    for (const key of Object.keys(CHANNEL_HINTS)) {
      expect(HINTS[key], key).toBeUndefined();
      expect(PLAYLIST_HINTS[key], key).toBeUndefined();
      expect(ROW_HINTS[key], key).toBeUndefined();
    }
  });
});
