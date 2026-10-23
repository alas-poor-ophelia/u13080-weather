/**
 * Seshat P4 step 4a (docs/SESHAT-v0.md §16 D8, §16.4 Rule order, §16.7 P2,
 * P5, P8; bead wadjet-01k.17): a named rule reads a tag only named rules set,
 * evaluated lazily with a per-day memo; a tag a unit label, day label or
 * season also sets keeps its base-only read (P2), pinned against the code
 * before this step; cycles are refused with their path; a failing rule takes
 * its readers down with it; the worst world calendar stays inside a budget.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, Engine, GREGORIAN, parse, print, problems, RULE_MEMO_DAYS, ruleChildren, translate, validate, type CalendarAst, type RuleAst } from "../src/seshat";
import { checkWorldCalendar, SeshatCalendar, WORLD_RULES_MAX } from "../src/plugin/time/seshat";

const DIR = "test/fixtures/seshat";
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".seshat")).sort();

const tag = (t: string): RuleAst => ({ kind: "tag", tag: t });
const SATURDAY: RuleAst = { kind: "recur", freq: "day", by: [{ unit: "weekday", label: ["Saturday"] }] };
const mod = (a: number, m: number) => ((a % m) + m) % m;
/** 1970-01-03 (day 2) was a Saturday */
const isSaturday = (d: number) => d >= 0 && mod(d - 2, 7) === 0;

function digest(lines: (d: number) => string, from: number, to: number): string {
  const h = new Bun.CryptoHasher("sha256");
  for (let d = from; d <= to; d++) h.update(`${d}:${lines(d)}\n`);
  return h.digest("hex").slice(0, 16);
}

/** Counts every named-rule evaluation (EngineDays.named calls holds once per rule and day). */
function counting(e: Engine): { calls: () => number } {
  let n = 0;
  const holds = e.days.holds.bind(e.days);
  const named = new Set((e.ast.rules ?? []).map((r) => r.rule));
  e.days.holds = (r, d) => {
    if (named.has(r)) n++;
    return holds(r, d);
  };
  return { calls: () => n };
}

// market day except holidays: the holiday rule is declared after the market that reads it (evaluation is lazy, not by order)
const HOLIDAYS = [2, 16, 30, 5, 400];
const MARKET: CalendarAst = {
  ...GREGORIAN,
  rules: [
    { id: "market", tags: ["market"], rule: { kind: "all", of: [SATURDAY, { kind: "not", of: tag("holiday") }] } },
    { id: "holiday", tags: ["holiday"], rule: { kind: "dates", days: HOLIDAYS } },
  ],
};

describe("rules read rule tags (§16 D8)", () => {
  test("market day except holidays: every Saturday that is not a holiday, in declaration order", () => {
    expect(validate(MARKET)).toEqual([]);
    const e = new Engine(MARKET);
    // a daily recurrence with no anchor counts from day 0
    for (let d = -400; d <= 1200; d++) {
      const want = [...(isSaturday(d) && !HOLIDAYS.includes(d) ? ["market"] : []), ...(HOLIDAYS.includes(d) ? ["holiday"] : [])];
      expect(e.tagsAt(d)).toEqual(want);
    }
    // a rule bound from outside reads it too
    const bound = e.days.bind(tag("market"));
    expect([9, 16, 23].map((d) => e.days.holds(bound, d))).toEqual([true, false, true]);
  });

  test("a chain: each rule reads the one before it, declared in reverse", () => {
    const n = 12;
    const first: RuleAst = { kind: "dates", days: [10, 20] };
    const rules = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tags: [`t${i}`], rule: i === 0 ? first : tag(`t${i - 1}`) })).reverse();
    const cal: CalendarAst = { ...GREGORIAN, rules };
    expect(validate(cal)).toEqual([]);
    const e = new Engine(cal);
    const all = rules.flatMap((r) => r.tags);
    expect(e.tagsAt(10)).toEqual(all);
    expect(e.tagsAt(11)).toEqual([]);
    // a diamond: two readers of one rule, one reader of both
    const diamond: CalendarAst = {
      ...GREGORIAN,
      rules: [
        { id: "top", tags: ["top"], rule: { kind: "all", of: [tag("left"), tag("right")] } },
        { id: "l", tags: ["left"], rule: tag("base") },
        { id: "r", tags: ["right"], rule: { kind: "not", of: tag("base") } },
        { id: "b", tags: ["base"], rule: SATURDAY },
      ],
    };
    const d = new Engine(diamond);
    expect(d.tagsAt(2)).toEqual(["left", "base"]);
    expect(d.tagsAt(3)).toEqual(["right"]);
  });

  test("a tag several rules set holds when any of them holds", () => {
    const cal: CalendarAst = {
      ...GREGORIAN,
      rules: [
        { id: "reader", tags: ["seen"], rule: tag("mark") },
        { id: "a", tags: ["mark"], rule: { kind: "dates", days: [1] } },
        { id: "b", tags: ["mark", "b"], rule: { kind: "dates", days: [2] } },
      ],
    };
    const e = new Engine(cal);
    expect([0, 1, 2].map((d) => e.tagsAt(d))).toEqual([[], ["seen", "mark"], ["seen", "mark", "b"]]);
  });

  test("translate keeps rule-tag readers: the moved calendar on d + k is the original on d", () => {
    const e = new Engine(MARKET);
    for (const k of [1, -3, 365, 1000]) {
      const m = new Engine(translate(MARKET, k));
      for (let d = -50; d <= 450; d++) expect(m.tagsAt(d + k)).toEqual(e.tagsAt(d));
    }
  });
});

describe("cycles are refused, named by their rules in order", () => {
  test("two rules reading each other, a rule reading itself, a longer loop", () => {
    const pair: CalendarAst = { ...GREGORIAN, rules: [{ id: "a", tags: ["ta"], rule: tag("tb") }, { id: "b", tags: ["tb"], rule: { kind: "any", of: [SATURDAY, tag("ta")] } }] };
    expect(validate(pair)).toEqual([`rules read each other's tags in a cycle: "a" → "b" → "a"`]);
    expect(problems(pair)).toEqual([{ message: `rules read each other's tags in a cycle: "a" → "b" → "a"`, rule: "a" }]);
    expect(() => new Engine(pair)).toThrow(/cycle: "a" → "b" → "a"/);
    const self: CalendarAst = { ...GREGORIAN, rules: [{ id: "ok", tags: ["fine"], rule: SATURDAY }, { id: "me", tags: ["mine"], rule: { kind: "not", of: tag("mine") } }] };
    expect(validate(self)).toEqual([`rules read each other's tags in a cycle: "me" → "me"`]);
    const loop: CalendarAst = {
      ...GREGORIAN,
      rules: [
        { id: "entry", tags: ["e"], rule: tag("x") },
        { id: "x", tags: ["x"], rule: tag("y") },
        { id: "y", tags: ["y"], rule: tag("z") },
        { id: "z", tags: ["z"], rule: { kind: "all", of: [SATURDAY, tag("x")] } },
      ],
    };
    expect(validate(loop)).toEqual([`rules read each other's tags in a cycle: "x" → "y" → "z" → "x"`]);
  });

  test("reading a tag a label also sets is base-only, so it is never an edge (§16.7 P2)", () => {
    const labelled: CalendarAst = {
      ...GREGORIAN,
      days: [{ day: 4, tags: ["fest"] }],
      rules: [{ id: "fest", tags: ["fest"], rule: { kind: "not", of: tag("fest") } }],
    };
    expect(validate(labelled)).toEqual([]);
    const e = new Engine(labelled);
    expect(e.tagsAt(4)).toEqual(["fest"]); // the label; the rule reads the label only, so it fails here
    expect(e.tagsAt(5)).toEqual(["fest"]); // the rule
  });
});

// A world whose rules read tags that labels, day labels and seasons also set. Under the code before
// step 4a (commit 946188c) it was valid and gave the pins below; it must keep giving them (§16.7 P2).
const SHARED: CalendarAst = {
  ...GREGORIAN,
  seasons: { unit: "year", marks: [{ name: "Winter", from: 0 }, { name: "Spring", from: 0.2 }, { name: "Summer", from: 0.45 }, { name: "Autumn", from: 0.7 }] },
  units: GREGORIAN.units.map((u) => (u.id === "weekday" && u.kind === "cycle" ? { ...u, labels: (u.labels ?? []).map((l) => (l.name === "Saturday" || l.name === "Sunday" ? { ...l, tags: ["rest"] } : l)) } : u)),
  days: [{ day: 100, tags: ["feast"] }, { day: 201, name: "Founding", tags: ["feast", "rest"] }],
  rules: [
    { id: "fair", tags: ["feast", "market"], rule: { kind: "recur", freq: "month", by: [{ unit: "month", day: [1] }] } },
    { id: "quiet", tags: ["quiet"], rule: { kind: "all", of: [tag("rest"), { kind: "not", of: tag("feast") }] } },
    { id: "midsummer", tags: ["season:Summer", "fire"], rule: { kind: "dates", days: [5, 6, 7, 400] } },
    { id: "warm", tags: ["warm"], rule: { kind: "any", of: [tag("season:Summer"), tag("season:Spring")] } },
    { id: "rest-too", tags: ["rest"], rule: { kind: "recur", freq: "day", by: [{ unit: "weekday", label: ["Wednesday"] }] } },
    { id: "lazy", tags: ["lazy", "quiet"], rule: tag("rest") },
    { id: "untagged", rule: { kind: "dates", days: [3] } },
  ],
};

describe("shared tags keep base-only reads (§16.7 P2), pinned against the code before step 4a", () => {
  test("tagsAt, toContext and configHash of the shared-tag world are unchanged", () => {
    expect(validate(SHARED)).toEqual([]);
    const e = new Engine(SHARED);
    expect(digest((d) => e.tagsAt(d).join("|"), -1500, 1500)).toBe("b08541aa8fdb92d0");
    expect([100, 201, 5, 6, 7, 31, 32, 400].map((d) => [d, e.tagsAt(d)])).toEqual([
      [100, ["rest", "feast", "warm", "lazy", "quiet"]],
      [201, ["feast", "rest", "warm", "lazy", "quiet"]],
      // midsummer sets season:Summer, but warm reads the season only: day 5 is winter
      [5, ["season:Summer", "fire"]],
      [6, ["season:Summer", "fire", "rest"]],
      [7, ["season:Summer", "fire"]],
      // fair sets feast on the 1st, but quiet reads the day labels' feast only
      [31, ["rest", "feast", "market", "quiet", "lazy", "quiet"]],
      [32, []],
      [400, ["season:Summer", "fire"]],
    ]);
    const a = new SeshatCalendar(print(SHARED), () => 0);
    expect(digest((d) => (a.toContext(d).tags ?? []).join("|"), -1500, 1500)).toBe("d9fc4a4ee583c6ef");
    expect(a.configHash()).toBe("seshat:11b1626ec07c49d0");
  });

  test("tagsAt of every fixture over 3001 days is unchanged (output and order)", () => {
    const PIN: Record<string, string> = { "balinese.seshat": "757ddd96d33219e0" };
    const NONE = "b7bb515703cbe3f1"; // no tags on any of the days
    for (const f of FIXTURES) {
      const e = new Engine(parse(readFileSync(`${DIR}/${f}`, "utf8")));
      expect([f, digest((d) => e.tagsAt(d).join("|"), -1500, 1500)]).toEqual([f, PIN[f] ?? NONE]);
    }
  });
});

describe("a failing rule (§16.4 Rule order)", () => {
  // a COUNT walk past 10^6 days passes validation and throws when it runs
  const WALK: RuleAst = { kind: "recur", freq: "day", anchor: -2_000_000, count: 3_000_000 };
  const FAILING: CalendarAst = {
    ...GREGORIAN,
    rules: [
      { id: "market", tags: ["market"], rule: { kind: "all", of: [SATURDAY, { kind: "not", of: tag("holiday") }] } },
      { id: "holiday", tags: ["holiday"], rule: WALK },
      { id: "either", tags: ["either"], rule: { kind: "any", of: [SATURDAY, tag("holiday")] } },
      { id: "fine", tags: ["fine"], rule: SATURDAY },
    ],
  };

  test("its tags and the tags of every rule that reads it that day are dropped, each reported, the others kept; without onError tagsAt throws", () => {
    const e = new Engine(FAILING);
    expect(() => e.tagsAt(2)).toThrow();
    const seen: Array<[string, string]> = [];
    // day 2 is a Saturday: "either" decides on SATURDAY before it reads the tag, so it keeps its tag
    expect(e.tagsAt(2, (id, err) => seen.push([id, String((err as Error).message)]))).toEqual(["either", "fine"]);
    expect(seen.map(([id]) => id)).toEqual(["market", "holiday"]);
    expect(seen[0]![1]).toBe('reads tag "holiday", set by rule "holiday", which failed on day 2');
    expect(seen[1]![1]).toMatch(/COUNT walks more than/);
    // day 3 is not: "either" reads the failed tag and fails with it
    seen.length = 0;
    expect(e.tagsAt(3, (id, err) => seen.push([id, String((err as Error).message)]))).toEqual([]);
    expect(seen.map(([id]) => id)).toEqual(["holiday", "either"]);
  });

  test("the adapter reports each failing rule once and keeps the rest", () => {
    const rules = [
      { id: "market", tags: ["market"], rule: { kind: "all" as const, of: [SATURDAY, { kind: "not" as const, of: tag("holiday") }] } },
      { id: "holiday", tags: ["holiday"], rule: { kind: "dates" as const, days: [9] } },
      { id: "fine", tags: ["fine"], rule: SATURDAY },
    ];
    const a = new SeshatCalendar(print({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Spring", from: 0 }] }, rules }), () => 0);
    const e = (a as unknown as { engine: Engine }).engine;
    const holds = e.days.holds.bind(e.days);
    const failing = e.ast.rules![1]!.rule;
    e.days.holds = (r, d) => {
      if (r === failing) throw new Error("boom");
      return holds(r, d);
    };
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      expect(a.toContext(9).tags).toEqual(["season:Spring", "fine"]);
      expect(a.toContext(16).tags).toEqual(["season:Spring", "fine"]);
      expect(a.toContext(10).tags).toEqual(["season:Spring"]);
    } finally {
      console.error = orig;
    }
    expect(errors.map((x) => String(x[0]).match(/"([a-z-]+)"/)![1])).toEqual(["market", "holiday"]);
  });
});

describe("evaluation cost (§16.7 P8)", () => {
  /** reads `t` three times, through not, not and any */
  const reader = (t: string): RuleAst => ({ kind: "all", of: [{ kind: "not", of: tag(t) }, { kind: "not", of: tag(t) }, { kind: "any", of: [tag(t), SATURDAY] }] });
  // the worst world calendar this step allows: WORLD_RULES_MAX rules, each reading the one before it
  const chain = (n: number): CalendarAst => ({
    ...GREGORIAN,
    seasons: { unit: "year", marks: [{ name: "Spring", from: 0 }, { name: "Autumn", from: 0.5 }] },
    rules: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tags: [`t${i}`], rule: i === 0 ? SATURDAY : reader(`t${i - 1}`) })).reverse(),
  });

  test("each named rule is evaluated at most once per day, however many rules read it", () => {
    const e = new Engine(chain(WORLD_RULES_MAX));
    const c = counting(e);
    for (let d = 0; d < 200; d++) e.tagsAt(d);
    expect(c.calls()).toBe(200 * WORLD_RULES_MAX);
    for (let d = 0; d < 200; d++) e.tagsAt(d); // memoised
    expect(c.calls()).toBe(200 * WORLD_RULES_MAX);
    // and the memo is bounded
    for (let d = 0; d < RULE_MEMO_DAYS + 500; d++) e.tagsAt(d);
    expect((e.days as unknown as { memo: Map<number, unknown> }).memo.size).toBe(RULE_MEMO_DAYS);
  });

  test(`budget: ${WORLD_RULES_MAX} rules in a chain of depth ${WORLD_RULES_MAX}, toContext over 2000 days within 1000 ms (measured about 110 ms)`, () => {
    const text = print(chain(WORLD_RULES_MAX));
    expect(checkWorldCalendar(parse(text))).toEqual([]);
    const a = new SeshatCalendar(text, () => 0);
    const t0 = performance.now();
    for (let d = 10_000; d < 12_000; d++) a.toContext(d);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
  });

  // step 4b (§16.7 P8): the caps allow WORLD_RULES_MAX rules, no FIRST inside a FIRST, a summed reach of 400 per path
  const shift = (days: number, of: RuleAst): RuleAst => ({ kind: "shift", days, of });
  const first = (within: number, after: RuleAst, of: RuleAst): RuleAst => ({ kind: "first", within, after, of });
  const SPARSE: RuleAst = { kind: "recur", freq: "day", by: [{ unit: "month", day: [1] }, { unit: "weekday", label: ["Monday"] }] };
  const reachWorld = (): CalendarAst => {
    const half = WORLD_RULES_MAX / 2;
    // a chain: each link reaches 12 (FIRST 6 over SHIFT 6 of the link below), 31 links over a bottom SHIFT 16: 388
    const links = Array.from({ length: half }, (_, i) => ({
      id: `c${i}`,
      tags: [`c${i}`],
      rule: i === 0 ? shift(16, SATURDAY) : first(6, shift(6, tag(`c${i - 1}`)), { kind: "any", of: [tag(`c${i - 1}`), shift(-6, reader(`c${i - 1}`))] }),
    }));
    // independent rules, each a full 400: a FIRST 200 whose match is rare (its scans run the whole window), over SHIFTs 200
    const wide = Array.from({ length: half }, (_, i) => ({ id: `w${i}`, tags: [`w${i}`], rule: first(200, shift(200 - i, SPARSE), shift(i + 1, { kind: "any", of: [SPARSE, tag("c0")] })) }));
    return { ...chain(0), rules: [...wide, ...links].reverse() };
  };

  test(`budget: the worst world under the SHIFT/FIRST caps (${WORLD_RULES_MAX} rules, reach 400, chains), toContext over 2000 days within 3000 ms (measured 430 ms alone, 750 to 830 ms in its file, 1070 ms in the full suite)`, () => {
    const text = print(reachWorld());
    expect(checkWorldCalendar(parse(text))).toEqual([]);
    const a = new SeshatCalendar(text, () => 0);
    const t0 = performance.now();
    for (let d = 10_000; d < 12_000; d++) a.toContext(d);
    const ms = performance.now() - t0;
    console.log(`step 4b budget: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
  });
});

describe("reads past the day line and the walkers (§16.7 P5)", () => {
  test("a season read past ±DAY_LIMIT is false, not a throw", () => {
    const e = new Engine({ ...GREGORIAN, seasons: { unit: "year", marks: [{ name: "Spring", from: 0 }] } });
    const r = e.days.bind(tag("season:Spring"));
    expect(e.days.holds(r, 0)).toBe(true);
    expect(e.days.view(DAY_LIMIT + 10).hasTag("season:Spring")).toBe(false);
    expect(e.days.view(-DAY_LIMIT - 1).hasTag("season:Spring")).toBe(false);
    expect(new Engine(MARKET).days.view(DAY_LIMIT + 1).hasTag("holiday")).toBe(false);
  });

  test("ruleChildren reaches every node kind and refuses an unknown one", () => {
    expect(ruleChildren({ kind: "not", of: SATURDAY })).toEqual([SATURDAY]);
    expect(ruleChildren({ kind: "all", of: [SATURDAY, tag("x")] })).toEqual([SATURDAY, tag("x")]);
    expect(ruleChildren(tag("x"))).toEqual([]);
    // step 4b: SHIFT and FIRST are kinds now, with their children
    expect(ruleChildren({ kind: "shift", days: 1, of: SATURDAY })).toEqual([SATURDAY]);
    expect(ruleChildren({ kind: "first", within: 3, after: tag("x"), of: SATURDAY })).toEqual([tag("x"), SATURDAY]);
    expect(() => ruleChildren({ kind: "sideways" } as unknown as RuleAst)).toThrow(/unknown rule kind "sideways"/);
    // the world check reaches a COUNT however deep
    const deep: CalendarAst = { ...GREGORIAN, rules: [{ id: "d", tags: ["d"], rule: { kind: "not", of: { kind: "any", of: [tag("x"), { kind: "all", of: [{ kind: "recur", freq: "day", anchor: 0, count: 3 }] }] } } }] };
    expect(checkWorldCalendar(deep).some((m) => m.includes("COUNT"))).toBe(true);
  });
});

describe("an unknown rule kind is reported, never thrown (Reviewer Dusty Nessa, 2026-10-22)", () => {
  const withRule = (rule: unknown): CalendarAst => ({ ...GREGORIAN, rules: [{ id: "x", tags: ["t"], rule: rule as RuleAst }] });
  for (const [label, rule] of [
    ["at the top", { kind: "shiftless" }],
    ["under not", { kind: "not", of: { kind: "shiftless" } }],
    ["under all", { kind: "all", of: [{ kind: "tag", tag: "t2" }, { kind: "shiftless" }] }],
  ] as const) {
    test(label, () => {
      const ast = withRule(rule);
      let got: string[] = [];
      expect(() => (got = validate(ast))).not.toThrow();
      expect(got.some((m) => m.includes("unknown rule kind"))).toBe(true);
      expect(() => problems(ast)).not.toThrow();
      expect(() => checkWorldCalendar(ast)).not.toThrow();
    });
  }
});
