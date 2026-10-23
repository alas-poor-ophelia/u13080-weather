/**
 * Seshat P4 step 5 (docs/SESHAT-v0.md §16.1 R2, §16.2 D9, §16.4 Placeholders,
 * §16.7 P9, bead wadjet-01k.18): `{@season}`, `{@phase:<body>}` and `{@name}`
 * in extra formats; a rule's display NAME (unhashed); the default and filler
 * formats refuse placeholders, so the automatic spelling stays typeable.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import { compileFormat, DAY_LIMIT, definitionContent, Engine, formatDay, GREGORIAN, isParseable, parse, parseDay, print, validate, type BodyAst, type CalendarAst, type RuleAst, type SeasonMarkAst } from "../src/seshat";
import { phaseSpan } from "../src/seshat/resolve";
import { inPhase } from "../src/seshat/rule";

const fmt = (pattern: string, name = "extra") => [...GREGORIAN.formats!, { name, pattern }];
const greg = (extra: Partial<CalendarAst>): CalendarAst => ({ ...GREGORIAN, ...extra });
const ymd = (e: Engine, y: number, m: number, d: number) => e.dayOf("month", [y], m - 1, d - 1);
const SATURDAY: RuleAst = { kind: "recur", freq: "day", by: [{ unit: "weekday", label: ["Saturday"] }] };
const WALK: RuleAst = { kind: "recur", freq: "day", anchor: -2_000_000, count: 3_000_000 }; // throws when it runs
const MOON = (phases?: ReadonlyArray<{ name: string; at: number }>): BodyAst => ({ id: "moon-1", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 }, moon: { name: "Luna", ...(phases ? { phases } : {}) } });
const hash = (ast: CalendarAst) => canonicalJson(definitionContent(ast));

describe("{@season}", () => {
  const check = (marks: readonly SeasonMarkAst[]) => {
    const e = new Engine(greg({ seasons: { unit: "year", marks }, formats: fmt("[{@season}]") }));
    const seen = new Set<string>();
    for (let d = -800; d < 800; d += 3) {
      const s = e.seasonAt(d) ?? "";
      seen.add(s);
      expect([d, formatDay(e, d, "extra")]).toEqual([d, `[${s}]`]);
    }
    return seen;
  };
  test("fraction seasons", () => expect(check([{ name: "Winter", from: 0.9 }, { name: "Spring", from: 0.2 }, { name: "Summer", from: 0.45 }]).size).toBe(3));
  test("date seasons", () => expect(check([{ name: "Spring", day: 80 }, { name: "Autumn", slot: { unit: "month", index: 8, day: 22 } }]).size).toBe(2));
  test("no seasons prints nothing; a day past the line prints nothing and does not throw", () => {
    const e = new Engine(greg({ formats: fmt("[{@season}]") }));
    expect(formatDay(e, 0, "extra")).toBe("[]");
    const s = new Engine(greg({ seasons: { unit: "year", marks: [{ name: "A", day: 1 }] }, formats: fmt("[{@season}]") }));
    expect(formatDay(s, 0, "extra")).toBe("[A]");
    const far = new Engine(greg({ seasons: { unit: "year", marks: [{ name: "A", day: 1 }] }, bodies: [MOON([{ name: "P", at: 0 }, { name: "Q", at: 0.5 }])], rules: [{ id: "r", name: "R", tags: ["r"], rule: SATURDAY }], formats: fmt("[{@season}|{@name}|{@phase:moon-1}]") }));
    for (const d of [DAY_LIMIT + 5, -DAY_LIMIT - 5]) expect(() => formatDay(far, d, "extra")).not.toThrow();
    expect(formatDay(far, DAY_LIMIT + 5, "extra")).toMatch(/^\[\|\|[PQ]\]$/);
  });
});

describe("{@phase:<body>}", () => {
  const LAYOUTS: Array<[string, Array<{ name: string; at: number }>]> = [
    ["four, unsorted, the first mark not at 0 (wraps)", [{ name: "Full", at: 0.5 }, { name: "New", at: 0.05 }, { name: "Waxing", at: 0.25 }, { name: "Waning", at: 0.75 }]],
    ["two", [{ name: "Dark", at: 0.8 }, { name: "Bright", at: 0.3 }]],
    ["single mark: the whole turn", [{ name: "Always", at: 0.6 }]],
  ];
  for (const [what, phases] of LAYOUTS) {
    test(`${what}: the phase whose span [mark, next) holds the body's phase, over several lunations`, () => {
      const ast = greg({ bodies: [MOON(phases)], formats: fmt("{@phase:moon-1}") });
      const e = new Engine(ast);
      const bodies = new Map(ast.bodies!.map((b) => [b.id, b]));
      const seen = new Set<string>();
      for (let d = -100; d < 100; d++) {
        const x = e.bodyPhase("moon-1", d)!;
        const want = phases.filter((p) => {
          const s = phaseSpan("moon-1", p.name, bodies) as { from: number; to: number };
          return inPhase(x, s.from, s.to);
        });
        expect(want.length).toBe(1);
        seen.add(want[0]!.name);
        expect([d, formatDay(e, d, "extra")]).toEqual([d, want[0]!.name]);
      }
      expect(seen.size).toBe(phases.length);
    });
  }
  test("a body without phases prints nothing; a missing body is a compile error", () => {
    expect(formatDay(new Engine(greg({ bodies: [MOON()], formats: fmt("<{@phase:moon-1}>") })), 5, "extra")).toBe("<>");
    expect(validate(greg({ formats: fmt("{@phase:moon-1}") }))).toEqual(['format "extra": {@phase:moon-1} names no declared body "moon-1"']);
  });
});

describe("{@name}", () => {
  const ast = greg({
    days: [{ day: 2, name: "Founding" }, { day: 9, tags: ["x"] }],
    rules: [
      { id: "market", name: "Market day", tags: ["market"], rule: SATURDAY },
      { id: "quiet", tags: ["quiet"], rule: SATURDAY }, // no NAME: prints nothing, not its id
      { id: "broken", name: "Broken", tags: ["broken"], rule: WALK },
      { id: "even", name: "Even day", tags: ["even"], rule: { kind: "recur", freq: "day", interval: 2, anchor: 0 } },
    ],
    formats: fmt("{year}:{@name}."),
  });
  const e = new Engine(ast);
  test("RDATE name first, then holding named rules in declaration order, joined with \", \"; a throwing rule adds nothing", () => {
    expect(formatDay(e, 2, "extra")).toBe("1970:Founding, Market day, Even day.");
    expect(formatDay(e, 9, "extra")).toBe("1970:Market day.");
    expect(formatDay(e, 4, "extra")).toBe("1970:Even day.");
    expect(formatDay(e, 3, "extra")).toBe("1970:.");
    expect(() => e.tagsAt(2)).toThrow(); // the rule does fail
  });
  test("the NAME line round-trips, escaped, and is not hashed", () => {
    const hostile = { ...ast, rules: ast.rules!.map((r, i) => (i === 0 ? { ...r, name: "a;b,c=d:e\\f" } : r)) };
    const text = print(hostile);
    expect(text).toContain("UID:market\nNAME:");
    expect(parse(text)).toEqual(hostile);
    expect(hash(hostile)).toBe(hash({ ...ast, rules: ast.rules!.map(({ name: _n, ...r }) => r) }));
  });
  test("a rule NAME must be NFC and a string", () => {
    const bad = { ...ast, rules: [{ id: "r", name: "é", tags: ["t"], rule: SATURDAY }] };
    expect(validate(bad).some((m) => /NFC/.test(m))).toBe(true);
    expect(validate({ ...ast, rules: [{ id: "r", name: 5 as unknown as string, rule: SATURDAY }] })).toContain('rule "r": name 5 is not a string');
  });
});

describe("R2: the default and filler formats stay typeable", () => {
  test("a placeholder in the format named default, in filler, or in the first when none is default, is refused naming the format", () => {
    const msg = (name: string, role: string) => `format "${name}": a placeholder ({@season}, {@phase:<body>}, {@name}) cannot be in ${role}, which must stay one a date can be typed in; put it in another format`;
    expect(validate(greg({ formats: [{ name: "default", pattern: "{year}-{month:pad2}-{month:day:pad2} {@name}" }] }))).toEqual([msg("default", "the default format")]);
    expect(validate(greg({ formats: [{ name: "short", pattern: "{year}-{month:pad2}-{month:day:pad2}{@season}" }, { name: "x", pattern: "{year}" }] }))).toEqual([msg("short", 'the default format (the first, as none is named "default")')]);
    expect(validate(greg({ formats: [...GREGORIAN.formats!, { name: "filler", pattern: "{@name}" }] }))).toEqual([msg("filler", 'the "filler" format')]);
    // in an extra format, and in the first when another is named default, it is fine
    expect(validate(greg({ formats: [{ name: "first", pattern: "{@name}" }, { name: "default", pattern: "{year}-{month:pad2}-{month:day:pad2}" }] }))).toEqual([]);
  });
  test("a placeholder pattern is format-only: naming it in parse throws; parsing without a name uses the default", () => {
    const e = new Engine(greg({ seasons: { unit: "year", marks: [{ name: "A", day: 1 }] }, formats: fmt("{year}-{month:pad2}-{month:day:pad2}{@season}") }));
    expect(isParseable(e, "extra")).toBe(false);
    expect(() => parseDay(e, "1970-01-01A", "extra")).toThrow(/format-only/);
    expect(parseDay(e, "1970-01-01A")).toBeNull();
    expect(parseDay(e, "1970-01-11")).toBe(10);
    expect(compileFormat({ name: "x", pattern: "{year}{@season}" }, GREGORIAN).compiled!.chain).toBeNull();
  });
  test("an unknown placeholder, or a malformed phase one, is a compile error with the known list", () => {
    expect(validate(greg({ formats: fmt("{@weather}") }))).toEqual(['format "extra": unknown placeholder {@weather} (the placeholders are {@season}, {@phase:<body>}, {@name})']);
    expect(validate(greg({ formats: fmt("{@season:pad2}") }))[0]).toMatch(/unknown placeholder \{@season:pad2\}/);
    expect(validate(greg({ formats: fmt("{@phase}") }))).toEqual(['format "extra": {@phase} is not a phase placeholder (write {@phase:<body id>})']);
  });
});

describe("a Gregorian world with a long format", () => {
  test("FORMAT:long prints weekday, day, month, year, season, the moon's phase and the day's names", () => {
    const base = parse(print(GREGORIAN));
    const text = print({
      ...base,
      seasons: { unit: "year", marks: [{ name: "Spring", day: 80 }, { name: "Summer", slot: { unit: "month", index: 5, day: 21 } }, { name: "Autumn", day: 266 }, { name: "Winter", slot: { unit: "month", index: 11, day: 21 } }] },
      bodies: [MOON([{ name: "New", at: 0 }, { name: "Waxing", at: 0.03 }, { name: "Full", at: 0.47 }, { name: "Waning", at: 0.53 }])],
      days: [{ day: 0, name: "Epoch" }],
      rules: [{ id: "market", name: "Market day", tags: ["market"], rule: SATURDAY }],
      formats: [GREGORIAN.formats![0]!, { name: "long", pattern: "{weekday:name} {month:day} {month:name} {year}, {@season}, {@phase:moon-1}{@name}" }],
    });
    // commas are escaped too, as in every text value; §16.3's spelling without "\," is refused by the strict reader
    const LINE = "FORMAT:long={weekday\\:name} {month\\:day} {month\\:name} {year}, {@season}, {@phase\\:moon-1}{@name}";
    const PRINTED = LINE.replaceAll(", ", "\\, ");
    expect(text).toContain(PRINTED);
    expect(() => parse(text.replace(PRINTED, LINE))).toThrow('"," must be escaped as "\\,"');
    const e = new Engine(parse(text));
    expect(validate(parse(text))).toEqual([]);
    // moon-1's phase: 0.3 on day 0, 0.503 on day 6, 0.876 on day 17, 0.011 on day 21 (wrapped to New), 0.908 on 22 October 2026
    const lines = [0, 2, 6, 17, 21, ymd(e, 2026, 10, 22)].map((d) => formatDay(e, d, "long"));
    expect(lines).toEqual([
      "Thursday 1 January 1970, Winter, WaxingEpoch",
      "Saturday 3 January 1970, Winter, WaxingMarket day",
      "Wednesday 7 January 1970, Winter, Full",
      "Sunday 18 January 1970, Winter, Waning",
      "Thursday 22 January 1970, Winter, New",
      "Thursday 22 October 2026, Autumn, Waning",
    ]);
    // the default still formats and parses every day
    for (let d = -400; d < 400; d += 13) expect(parseDay(e, formatDay(e, d))).toBe(d);
  });
});
