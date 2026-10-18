import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, Engine, GREGORIAN, MAYA, validate } from "../src/seshat";

const DAY_MS = 86_400_000;

function gregorianDay(y: number, m: number, d: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime() / DAY_MS;
}

const mod = (a: number, m: number) => ((a % m) + m) % m;
const amod = (a: number, m: number) => mod(a - 1, m) + 1; // 1..m
const NAMES = ["Imix", "Ik'", "Ak'b'al", "K'an", "Chikchan", "Kimi", "Manik'", "Lamat", "Muluk", "Ok", "Chuwen", "Eb'", "B'en", "Ix", "Men", "Kib'", "Kab'an", "Etz'nab'", "Kawak", "Ajaw"];
const MONTHS = ["Pop", "Wo'", "Sip", "Sotz'", "Sek", "Xul", "Yaxk'in", "Mol", "Ch'en", "Yax", "Sak'", "Keh", "Mak", "K'ank'in", "Muwan", "Pax", "K'ayab", "Kumk'u", "Wayeb"];

/**
 * The oracle: Dershowitz & Reingold's Maya formulas, plain division on the
 * day count from the epoch, sharing nothing with the AST's nested units.
 */
function oracle(d: number) {
  const n = d - -1_856_305;
  const haab = mod(n + 348, 365);
  return {
    longCount: [Math.floor(n / 144_000), Math.floor(mod(n, 144_000) / 7_200), Math.floor(mod(n, 7_200) / 360), Math.floor(mod(n, 360) / 20), mod(n, 20)],
    tzolkin: `${amod(n + 4, 13)} ${NAMES[amod(n + 20, 20) - 1]}`,
    haab: `${mod(haab, 20)} ${MONTHS[Math.floor(haab / 20)]}`,
  };
}

describe("seshat: Maya", () => {
  const maya = new Engine(MAYA);
  const read = (d: number) => {
    const digit = (id: string) => maya.positionOf(id, d)!.index;
    const month = maya.positionOf("haab-month", d)!;
    return {
      longCount: [digit("baktun"), digit("katun"), digit("tun"), digit("uinal"), digit("kin")],
      tzolkin: `${maya.labelAt("tzolkin-number", d)!.name} ${maya.labelAt("tzolkin-name", d)!.name}`,
      haab: `${month.offset} ${maya.labelAt("haab-month", d)!.name}`,
    };
  };

  test("the AST is valid; the epoch and 13.0.0.0.0 fall on the documented days", () => {
    expect(validate(MAYA)).toEqual([]);
    expect(read(-1_856_305)).toEqual({ longCount: [0, 0, 0, 0, 0], tzolkin: "4 Ajaw", haab: "8 Kumk'u" });
    // 21 December 2012: 13.0.0.0.0 4 Ajaw 3 K'ank'in
    expect(read(gregorianDay(2012, 12, 21))).toEqual({ longCount: [13, 0, 0, 0, 0], tzolkin: "4 Ajaw", haab: "3 K'ank'in" });
    expect(read(gregorianDay(2012, 12, 20)).longCount).toEqual([12, 19, 19, 17, 19]);
  });

  test("agrees with the Dershowitz-Reingold formulas on every day over ±1,000,000 days, and strided to ±DAY_LIMIT", () => {
    let bad = 0;
    const check = (d: number) => {
      const [a, b] = [read(d), oracle(d)];
      if (JSON.stringify(a) !== JSON.stringify(b)) if (bad++ < 5) expect({ d, a }).toEqual({ d, a: b });
    };
    for (let d = -1_000_000; d <= 1_000_000; d++) check(d);
    for (let d = -DAY_LIMIT; d <= DAY_LIMIT; d += 9_973) check(d);
    expect(bad).toBe(0);
  }, 120_000);

  test("the Calendar Round is 18,980 days (V6): Tzolk'in and Haab' repeat together then, and not sooner", () => {
    expect(maya.round(["tzolkin-number", "tzolkin-name", "haab"])).toBe(18_980);
    expect(maya.round(["tzolkin-number", "tzolkin-name"])).toBe(260);
    const cr = (d: number) => `${read(d).tzolkin} ${read(d).haab}`;
    const d0 = gregorianDay(2012, 12, 21);
    expect(cr(d0 + 18_980)).toBe(cr(d0));
    for (const k of [260, 365, 18_980 / 2]) expect(cr(d0 + k)).not.toBe(cr(d0));
    expect(() => maya.round(["haab-month"])).toThrow(RangeError);
    expect(() => new Engine(GREGORIAN).round(["year"])).toThrow(RangeError);
  });
});

describe("seshat: labels (C5)", () => {
  test("a cycle's label is its occurrence mod the table; a slot's is its own name and tags; tags are collected per day", () => {
    const e = new Engine({
      name: "t",
      gears: [],
      units: [
        { id: "w", kind: "cycle", anchor: 0, length: 1, labels: [{ name: "A", tags: ["even"] }, { name: "B", tags: ["odd"] }] },
        { id: "y", kind: "cycle", anchor: 0, length: 3 },
        { id: "m", kind: "slots", in: "y", slots: [{ name: "Feast", length: 1, filler: true, tags: ["feast"] }, { length: 2 }] },
      ],
    });
    expect(e.labelAt("w", -1)).toEqual({ name: "B", tags: ["odd"] });
    expect(e.labelAt("m", 3)).toEqual({ name: "Feast", tags: ["feast"] });
    expect(e.labelAt("m", 4)).toBeNull();
    expect(e.labelAt("y", 0)).toBeNull();
    expect(e.tagsAt(0)).toEqual(["even", "feast"]);
    expect(e.tagsAt(1)).toEqual(["odd"]);
  });

  test("labels are checked for shape", () => {
    const v = (labels: unknown) => validate({ name: "t", gears: [], units: [{ id: "w", kind: "cycle", anchor: 0, length: 1, labels } as never] }).join();
    expect(v([])).toContain("non-empty list");
    expect(v(["Sunday"])).toContain("must be an object");
    expect(v([{ name: 3 }])).toContain("not a string");
    expect(v([{ tags: ["a", ""] }])).toContain("non-empty strings");
    expect(v([{ tags: ["a", "a"] }])).toContain("listed twice");
    expect(v([{ name: "x", tags: ["a"] }])).toBe("");
    const slot = validate({ name: "t", gears: [], units: [{ id: "y", kind: "cycle", anchor: 0, length: 1 }, { id: "m", kind: "slots", in: "y", slots: [{ length: 1, tags: "feast" } as never] }] }).join();
    expect(slot).toContain("slot 1: its name and tags: tags must be a list");
  });
});
