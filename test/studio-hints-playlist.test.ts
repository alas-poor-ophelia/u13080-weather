/**
 * The playlist's hint table is a contract with its DOM, exactly as
 * `studio-hints.test.ts` holds the header to `HINTS`: every control the
 * playlist surface and the calendar ruler build carries `data-hint`, and every
 * one of those attributes comes from `playlistHint(key)`.
 *
 * `src/studio/ui/playlist.ts` and `src/studio/ui/ruler.ts` both import
 * Obsidian, so they cannot be imported under `bun test` (the `obsidian`
 * package is typings only). The check is therefore a source scan: pull every
 * hint-shaped string literal (`ruler.*`, `playlist.*`, `row.*`) out of the two
 * files and hold it against `PLAYLIST_HINT_KEYS`, in both directions. The
 * literal scan (rather than a `playlistHint("…")` scan) is deliberate: the
 * four channel rows carry their key as data in `CHANNELS`, and a key that
 * never reaches `playlistHint` is just as broken as one that does.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { PLAYLIST_HINTS, PLAYLIST_HINT_KEYS, playlistHint } from "../src/studio/model/hints-playlist";

const SOURCES = await Promise.all(
  ["../src/studio/ui/playlist.ts", "../src/studio/ui/ruler.ts"].map(async (p) => ({
    path: p,
    text: await Bun.file(new URL(p, import.meta.url)).text(),
  })),
);

/** Every hint-shaped key literal the two files carry, deduped and sorted. */
function keysUsed(): string[] {
  const found = new Set<string>();
  for (const { text } of SOURCES) {
    for (const m of text.matchAll(/"((?:ruler|playlist|row)\.[a-z]+)"/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

describe("studio playlist hints", () => {
  test("every key the playlist and the ruler use exists in PLAYLIST_HINTS", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => PLAYLIST_HINTS[k] === undefined)).toEqual([]);
  });

  test("PLAYLIST_HINT_KEYS is exactly what the two files ask for", () => {
    expect(keysUsed()).toEqual([...PLAYLIST_HINT_KEYS].sort());
  });

  test("the table covers the ruler, the playlist and the four channel rows", () => {
    for (const key of ["ruler.calendar", "ruler.ticks", "playlist.window", "playlist.daycard"]) {
      expect(PLAYLIST_HINT_KEYS).toContain(key);
    }
    for (const chain of ["temperature", "precipitation", "wind", "sky"]) {
      expect(PLAYLIST_HINT_KEYS).toContain(`row.${chain}`);
    }
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(PLAYLIST_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      // The separator is reserved for the attribute; it must not open a half.
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("playlistHint round-trips through hints.ts's parseHint", () => {
    for (const key of Object.keys(PLAYLIST_HINTS)) {
      expect(parseHint(playlistHint(key))).toEqual(PLAYLIST_HINTS[key]!);
    }
  });

  test("playlistHint takes a detail override without losing the name", () => {
    expect(parseHint(playlistHint("ruler.calendar", "this calendar does not describe its seasons"))).toEqual(["calendar", "this calendar does not describe its seasons"]);
  });

  test("an unknown key is visible rather than blank", () => {
    expect(playlistHint("nope.missing")).toBe("nope.missing");
  });

  test("the playlist table does not collide with the header's", async () => {
    const { HINTS } = await import("../src/studio/model/hints");
    for (const key of Object.keys(PLAYLIST_HINTS)) expect(HINTS[key], key).toBeUndefined();
  });
});
