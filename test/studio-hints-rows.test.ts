/**
 * `hints-rows.ts` is the table the playlist's data rows share, and every row
 * bead appends to it. The check is therefore about the table's own shape —
 * both directions of the key list, the house rules, and the two dynamic tips
 * whose *name* is data — rather than a source scan of one row's file, which
 * would go red the moment the next row bead lands its own keys.
 */
import { describe, expect, test } from "bun:test";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { regimeBlockTip, regimeShareTip, ROW_HINTS, ROW_HINT_KEYS, rowHint } from "../src/studio/model/hints-rows";

describe("studio row hints", () => {
  test("ROW_HINT_KEYS and ROW_HINTS describe exactly the same set", () => {
    expect([...ROW_HINT_KEYS].sort()).toEqual(Object.keys(ROW_HINTS).sort());
  });

  test("every entry follows the house rules: non-empty, sentence case, no trailing full stop", () => {
    for (const key of ROW_HINT_KEYS) {
      const [name, detail] = ROW_HINTS[key]!;
      expect(name).not.toBe("");
      expect(name.endsWith(".")).toBe(false);
      expect(detail.endsWith(".")).toBe(false);
      // Sentence case: the first letter is never a lower-case ASCII letter.
      expect(name[0]).toBe(name[0]!.toUpperCase());
    }
  });

  test("the regimes lane's three states are covered", () => {
    for (const key of ["row.regimes", "row.regimes.share", "row.regimes.issues"]) expect(ROW_HINT_KEYS).toContain(key);
  });

  test("rowHint joins name and detail the way the hint bar parses them", () => {
    const attr = rowHint("row.regimes");
    expect(parseHint(attr)).toEqual(ROW_HINTS["row.regimes"]!);
    expect(attr).toContain(HINT_SEPARATOR);
  });

  test("rowHint takes a detail override and returns an unknown key as-is", () => {
    expect(parseHint(rowHint("row.regimes", "fix 2 issues"))).toEqual(["Regimes", "fix 2 issues"]);
    expect(rowHint("row.nope")).toBe("row.nope");
  });

  test("a block tip names the state the `regime:` way and reads the dwell so far", () => {
    expect(parseHint(regimeBlockTip("Storm", 3, 9))).toEqual(["regime:Storm", "day 3 of 9"]);
  });

  test("a share tip names the state and rounds its share to a whole percent", () => {
    expect(parseHint(regimeShareTip("Calm", 0.256))).toEqual(["regime:Calm", "26% of the year"]);
    expect(parseHint(regimeShareTip("Calm", 0))).toEqual(["regime:Calm", "0% of the year"]);
  });
});
