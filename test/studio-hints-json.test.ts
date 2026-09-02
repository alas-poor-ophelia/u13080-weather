import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { JSON_HINT_KEYS, JSON_HINTS, jsonHint } from "../src/studio/model/hints-json";

describe("json drawer hints", () => {
  test("JSON_HINT_KEYS is exactly the keys in JSON_HINTS", () => {
    expect([...JSON_HINT_KEYS].sort()).toEqual(Object.keys(JSON_HINTS).sort());
  });

  test("names and details are non-empty, sentence case, and free of trailing punctuation", () => {
    for (const [key, [name, detail]] of Object.entries(JSON_HINTS)) {
      expect(name.length, key).toBeGreaterThan(0);
      expect(detail.length, key).toBeGreaterThan(0);
      expect(name.endsWith("."), key).toBe(false);
      expect(detail.endsWith("."), key).toBe(false);
      expect(name.includes(HINT_SEPARATOR), key).toBe(false);
    }
  });

  test("jsonHint round-trips through the shared parseHint", () => {
    for (const key of JSON_HINT_KEYS) expect(parseHint(jsonHint(key))).toEqual(JSON_HINTS[key]!);
  });

  test("an unknown key falls back to itself, matching hints.ts", () => {
    expect(jsonHint("nope")).toBe("nope");
  });
});
