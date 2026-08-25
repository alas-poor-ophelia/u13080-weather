import { describe, expect, test } from "bun:test";
import { parseJsonLenient, stripJsonComments } from "../src/plugin/json-lenient";
import { MODIFIER_GRAMMAR } from "../src/plugin/modifier-examples";

describe("lenient JSON for the zone editor", () => {
  test("plain JSON is untouched", () => {
    const s = '{"a": [1, 2, {"b": "x"}], "c": "d"}';
    expect(stripJsonComments(s)).toBe(s);
  });

  test("line and block comments outside strings are dropped", () => {
    const s = `{
      // leading comment
      "id": "x", /* inline */ "value": 12, // trailing
      "url": "http://example.com/a//b", "star": "/* not a comment */"
    }`;
    expect(parseJsonLenient<object>(s)).toEqual({ id: "x", value: 12, url: "http://example.com/a//b", star: "/* not a comment */" });
  });

  test("trailing commas before a closer are dropped, including across comments", () => {
    expect(parseJsonLenient<unknown[] | object>('{"a": 1, "b": [1, 2,], // c\n}')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonLenient<unknown[] | object>('[1, /* x */ 2, ]')).toEqual([1, 2]);
  });

  test("escaped quotes inside strings do not end the string", () => {
    expect(parseJsonLenient<{ q: string }>('{"q": "say \\"hi\\" // still text"}')).toEqual({ q: 'say "hi" // still text' });
  });

  test("real syntax errors still throw", () => {
    expect(() => parseJsonLenient('{"a": }')).toThrow();
    expect(() => parseJsonLenient("{ unterminated /* ")).toThrow();
  });

  test("every concrete JSON line on the grammar card parses as pasted (with its // gloss)", () => {
    // placeholders (… and <…>) are allowed in the JSON part of illustrative lines, not in the gloss
    const lines = MODIFIER_GRAMMAR.flatMap((g) => g.lines).filter((l) => l.startsWith("{") && !/[…<]/.test(stripJsonComments(l)));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const l of lines) expect(() => parseJsonLenient(l)).not.toThrow();
  });
});
