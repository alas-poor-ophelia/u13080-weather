/**
 * Seshat P4 step 4b (docs/SESHAT-v0.md §16.3, §16.4, §16.7 P5, P7, P8; bead
 * wadjet-01k.17): SHIFT (a node read DAYS days earlier) and FIRST (the first
 * match on or after an anchor, within WITHIN days). Text round-trip and
 * refusals; P7 semantics against a brute-force reference; Kleene unknown off
 * the engine; TimeView refuses them; cycles through SHIFT; the world caps;
 * translate; the first full moon after the equinox, checked by brute force.
 */
import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, definitionContent, Engine, evaluate, GREGORIAN, inPhase, parse, phaseSpan, print, readsOtherDays, ruleCycles, TimeView, translate, validate, type BodyAst, type CalendarAst, type DayView, type RuleAst } from "../src/seshat";
import { canonicalJson } from "../src/core/profile";
import { checkWorldCalendar, ruleReaches, WORLD_RULE_REACH_MAX } from "../src/plugin/time/seshat";

const tag = (t: string): RuleAst => ({ kind: "tag", tag: t });
const dates = (days: readonly number[]): RuleAst => ({ kind: "dates", days });
const shift = (days: number, of: RuleAst): RuleAst => ({ kind: "shift", days, of });
const first = (within: number, after: RuleAst, of: RuleAst): RuleAst => ({ kind: "first", within, after, of });
const SUNDAY: RuleAst = { kind: "recur", freq: "day", by: [{ unit: "weekday", label: ["Sunday"] }] };
const withRules = (rules: NonNullable<CalendarAst["rules"]>, base: CalendarAst = GREGORIAN): CalendarAst => ({ ...base, rules });
const hash = (ast: CalendarAst) => canonicalJson(definitionContent(ast));

/** §16.7 P7 on definite values: scan j = 0 … within. */
function firstRef(match: (d: number) => boolean, anchor: (d: number) => boolean, within: number, d: number): boolean {
  if (!match(d)) return false;
  if (anchor(d)) return true;
  for (let j = 1; j <= within; j++) {
    if (match(d - j)) return false;
    if (anchor(d - j)) return true;
  }
  return false;
}

/** A tiny pseudo-random stream (the fuzz's own is per-file). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

describe("text (§16.3)", () => {
  const ast = withRules([
    { id: "festival", tags: ["festival"], rule: dates([10, 200]) },
    { id: "after", tags: ["after-festival"], rule: shift(1, tag("festival")) },
    { id: "easter", tags: ["easter"], rule: first(7, shift(1, tag("festival")), { kind: "all", of: [SUNDAY, { kind: "not", of: shift(-2, dates([3])) }] }) },
  ]);

  test("SHIFT and FIRST print as blocks, round-trip exactly, and printing is a fixpoint", () => {
    const text = print(ast);
    expect(text).toContain("BEGIN:SHIFT\nDAYS:1\nTAG:festival\nEND:SHIFT\n");
    expect(text).toContain("BEGIN:FIRST\nWITHIN:7\nBEGIN:AFTER\nBEGIN:SHIFT\nDAYS:1\nTAG:festival\nEND:SHIFT\nEND:AFTER\nBEGIN:ALL\n");
    expect(parse(text)).toEqual(ast);
    expect(print(parse(text))).toBe(text);
    // the §16.3 sample's order is the printed one; the parser takes AFTER after the match too
    const swapped = "BEGIN:FIRST\nWITHIN:3\nTAG:b\nBEGIN:AFTER\nTAG:a\nEND:AFTER\nEND:FIRST";
    expect(parse(print(withRules([{ id: "x", rule: tag("x") }])).replace("TAG:x", swapped)).rules![0]!.rule).toEqual(first(3, tag("a"), tag("b")));
  });

  test("malformed blocks are refused with the reason", () => {
    const text = print(ast);
    const bad = (from: string, to: string) => () => parse(text.replace(from, to));
    expect(bad("DAYS:1\nTAG:festival\nEND:SHIFT", "DAYS:1\nTAG:festival\nTAG:x\nEND:SHIFT")).toThrow(/SHIFT holds exactly one rule/);
    expect(bad("BEGIN:SHIFT\nDAYS:1\nTAG:festival", "BEGIN:SHIFT\nTAG:festival")).toThrow(/SHIFT needs DAYS/);
    expect(bad("DAYS:1\nTAG:festival\nEND:SHIFT", "DAYS:1\nWITHIN:2\nTAG:festival\nEND:SHIFT")).toThrow(/SHIFT has no property WITHIN/);
    expect(bad("WITHIN:7\n", "")).toThrow(/FIRST needs WITHIN/);
    expect(bad("WITHIN:7\n", "WITHIN:7\nDAYS:1\n")).toThrow(/FIRST has no property DAYS/);
    expect(bad("WITHIN:7\nBEGIN:AFTER\nBEGIN:SHIFT\nDAYS:1\nTAG:festival\nEND:SHIFT\nEND:AFTER\n", "WITHIN:7\n")).toThrow(/exactly one AFTER/);
    expect(bad("END:AFTER\n", "END:AFTER\nBEGIN:AFTER\nTAG:y\nEND:AFTER\n")).toThrow(/exactly one AFTER/);
    expect(bad("TAG:festival\nEND:SHIFT\nEND:AFTER", "TAG:festival\nEND:SHIFT\nTAG:y\nEND:AFTER")).toThrow(/AFTER holds exactly one rule/);
    expect(() => parse(print(withRules([{ id: "x", rule: tag("x") }])).replace("TAG:x", "BEGIN:AFTER\nTAG:x\nEND:AFTER"))).toThrow(/cannot hold AFTER/);
    expect(bad("DAYS:1\nTAG:festival", "DAYS:one\nTAG:festival")).toThrow();
  });

  test("the printer refuses a field it has no text form for", () => {
    expect(() => print(withRules([{ id: "x", rule: { ...shift(1, tag("a")), colour: 1 } as unknown as RuleAst }]))).toThrow(/a "shift" rule has a field "colour"/);
    expect(() => print(withRules([{ id: "x", rule: { ...first(1, tag("a"), tag("b")), days: 1 } as unknown as RuleAst }]))).toThrow(/a "first" rule has a field "days"/);
  });
});

describe("validation (§16.4)", () => {
  const one = (rule: RuleAst) => validate(withRules([{ id: "x", tags: ["x"], rule }]));
  test("DAYS is a whole number, not 0, |DAYS| ≤ 400; WITHIN is a whole number from 1 to 400", () => {
    for (const d of [1, -1, 400, -400]) expect(one(shift(d, tag("a")))).toEqual([]);
    for (const d of [0, 401, -401, 1.5, Number.NaN]) expect(one(shift(d, tag("a")))).toEqual([`rule "x": SHIFT DAYS must be a whole number of days, not 0, at most 400 either way`]);
    for (const w of [1, 400]) expect(one(first(w, tag("a"), tag("b")))).toEqual([]);
    for (const w of [0, -1, 401, 2.5]) expect(one(first(w, tag("a"), tag("b")))).toEqual([`rule "x": FIRST WITHIN must be a whole number from 1 to 400`]);
  });
  test("children are checked where they sit", () => {
    expect(one(first(3, { kind: "dayIn", unit: "nope", from: 0, to: 1 }, shift(2, { kind: "index", unit: "nope2" })))).toEqual([`rule "x".first.after: no unit "nope"`, `rule "x".first.shift: no unit "nope2"`]);
  });
});

describe("semantics (§16.4, §16.7 P7)", () => {
  // a view over a line of days with no calendar, where every host leaf is unknown
    const line = (tags: Record<number, string[]>) => {
      const mk = (day: number): DayView => ({ day, unitPhase: () => undefined, dayInUnit: () => undefined, index: () => undefined, bodyPhase: () => undefined, hasTag: (t) => (tags[day] ?? []).includes(t), at: mk });
      return mk;
    };
    const run = (tags: Record<number, string[]>, rule: RuleAst, d: number) => evaluate(rule, line(tags)(d), { host: () => undefined });
  test("SHIFT DAYS=1 over a rule-only tag is the day after the festival; DAYS=-1 the day before", () => {
    const FEST = [5, 6, 40, 365, -12];
    const e = new Engine(
      withRules([
        { id: "festival", tags: ["festival"], rule: dates(FEST) },
        { id: "after", tags: ["after"], rule: shift(1, tag("festival")) },
        { id: "eve", tags: ["eve"], rule: shift(-1, tag("festival")) },
      ]),
    );
    for (let d = -30; d <= 400; d++) {
      const tags = e.tagsAt(d);
      expect([d, tags.includes("after")]).toEqual([d, FEST.includes(d - 1)]);
      expect([d, tags.includes("eve")]).toEqual([d, FEST.includes(d + 1)]);
    }
  });

  test("FIRST matches the P7 scan, day by day, over random match and anchor days (direct and through rule tags)", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed);
      const pick = (p: number) => Array.from({ length: 300 }, (_, i) => i - 50).filter(() => r() < p);
      const [M, A] = [pick(0.08 + r() * 0.3), pick(0.02 + r() * 0.1)];
      const within = 1 + Math.floor(r() * 40);
      const e = new Engine(
        withRules([
          { id: "m", tags: ["m"], rule: dates(M) },
          { id: "a", tags: ["a"], rule: dates(A) },
          { id: "direct", tags: ["direct"], rule: first(within, dates(A), dates(M)) },
          { id: "via-tags", tags: ["via-tags"], rule: first(within, tag("a"), tag("m")) },
        ]),
      );
      for (let d = -60; d <= 260; d++) {
        const want = firstRef((x) => M.includes(x), (x) => A.includes(x), within, d);
        const tags = e.tagsAt(d);
        expect([seed, d, tags.includes("direct"), tags.includes("via-tags")]).toEqual([seed, d, want, want]);
      }
    }
  });

  test("an anchor on d itself counts; the scan stops at WITHIN; a match in between hides the anchor", () => {
    const e = new Engine(GREGORIAN);
    const at = (rule: RuleAst, d: number) => e.days.holds(e.days.bind(rule), d);
    expect(at(first(1, dates([10]), dates([10])), 10)).toBe(true);
    expect(at(first(5, dates([10]), dates([15])), 15)).toBe(true);
    expect(at(first(4, dates([10]), dates([15])), 15)).toBe(false);
    expect(at(first(9, dates([10]), dates([12, 15])), 15)).toBe(false);
    expect(at(first(9, dates([10]), dates([12, 15])), 12)).toBe(true);
    expect(at(first(9, dates([10]), dates([12, 15])), 11)).toBe(false);
  });

  test("reads past ±DAY_LIMIT are false, never a throw", () => {
    const e = new Engine(GREGORIAN);
    const at = (rule: RuleAst, d: number) => e.days.holds(e.days.bind(rule), d);
    const every: RuleAst = { kind: "all", of: [] };
    expect(at(shift(1, every), DAY_LIMIT)).toBe(true);
    expect(at(shift(-1, every), DAY_LIMIT)).toBe(false);
    expect(at(shift(1, every), -DAY_LIMIT)).toBe(false);
    // the anchor sits past the line: never seen; one inside the line is
    expect(at(first(5, { kind: "not", of: every }, every), -DAY_LIMIT)).toBe(false);
    expect(at(first(5, dates([-DAY_LIMIT]), dates([-DAY_LIMIT + 3])), -DAY_LIMIT + 3)).toBe(true);
    expect(at(first(5, dates([DAY_LIMIT - 1]), every), DAY_LIMIT)).toBe(false); // every day matches, so d-1 hides it
  });

  test("off the engine, an unknown read propagates as Kleene unknown", () => {
    const m: RuleAst = { kind: "any", of: [tag("m"), { kind: "host", key: "chance", arg: "m" }] };
    // match unknown on d (a host leaf), anchor true on d → unknown
    expect(run({ [-1]: ["hm"], 5: ["a"] }, first(3, tag("a"), m), 5)).toBeUndefined();
    // match true on d, anchor unknown on d, match true on d-1 → unknown ∨ false = unknown
    const ua: RuleAst = { kind: "any", of: [tag("a"), { kind: "host", key: "regime", arg: "a" }] };
    expect(run({ 5: ["m"], 4: ["m"] }, first(3, ua, tag("m")), 5)).toBeUndefined();
    // match true on d, anchor unknown on d, d-1 an anchor with no match → true
    expect(run({ 5: ["m"], 4: ["a"] }, first(3, ua, tag("m")), 5)).toBe(true);
    // a definite false match on d decides at once
    expect(run({}, first(3, ua, tag("m")), 5)).toBe(false);
    // SHIFT carries the unknown from the other day
    expect(run({}, shift(2, ua), 5)).toBeUndefined();
  });

  test("off the engine, FIRST equals the recursive Kleene chain over random three-valued days", () => {
    type K = boolean | undefined;
    const and = (a: K, b: K): K => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);
    const or = (a: K, b: K): K => (a === true || b === true ? true : a === undefined || b === undefined ? undefined : false);
    const not = (a: K): K => (a === undefined ? undefined : !a);
    const tri = (t: string): RuleAst => ({ kind: "any", of: [tag(t), { kind: "all", of: [tag(`${t}?`), { kind: "host", key: "chance", arg: t }] }] });
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const within = 1 + Math.floor(r() * 8);
      const val: Record<string, K[]> = { m: [], a: [] };
      const tags: Record<number, string[]> = {};
      for (let d = 0; d < 20; d++)
        for (const t of ["m", "a"]) {
          const x = r();
          const v: K = x < 0.2 ? undefined : x < (t === "m" ? 0.6 : 0.85) ? false : true;
          val[t]![d] = v;
          (tags[d] ??= []).push(v === true ? t : v === undefined ? `${t}?` : "");
        }
      const get = (t: string, d: number): K => (d < 0 ? false : val[t]![d]!);
      const rest = (d: number, j: number): K => or(get("a", d - j), j >= within ? false : and(not(get("m", d - j - 1)), rest(d, j + 1)));
      for (let d = 0; d < 20; d++) expect([seed, d, run(tags, first(within, tri("a"), tri("m")), d)]).toEqual([seed, d, and(get("m", d), rest(d, 0))]);
    }
  });
});

describe("TimeView has no other days (§16.7 P5)", () => {
  test("binding refuses SHIFT and FIRST anywhere in the tree, and evaluating anyway throws, never a silent false", () => {
    expect(TimeView.bind(tag("a"))).toEqual(tag("a"));
    expect(() => TimeView.bind({ kind: "not", of: shift(1, tag("a")) })).toThrow(/a SHIFT rule reads other days, which a Wadjet day view does not have/);
    expect(() => TimeView.bind({ kind: "any", of: [tag("b"), first(2, tag("a"), tag("b"))] })).toThrow(/a FIRST rule reads other days/);
    expect(readsOtherDays({ kind: "all", of: [tag("a")] })).toBeUndefined();
    const v = new TimeView({ yearPhase: 0, tags: ["a", "b"] }, 3);
    expect(() => evaluate(shift(1, tag("a")), v, { host: () => undefined })).toThrow(/reads other days/);
    expect(() => evaluate(first(2, tag("x"), tag("b")), v, { host: () => undefined })).toThrow(/reads other days/);
    // answers day d alone could decide: the match false on d, and match and anchor both true on d (Parallax, 4b)
    expect(() => evaluate(first(2, tag("x"), tag("nope")), v, { host: () => undefined })).toThrow(/reads other days/);
    expect(() => evaluate(first(2, tag("a"), tag("b")), v, { host: () => undefined })).toThrow(/reads other days/);
  });
});

describe("dependencies (§16.7 P8)", () => {
  test("tags read inside SHIFT, FIRST and AFTER are edges: a rule reading its own tag a day later is a cycle", () => {
    expect(ruleCycles(withRules([{ id: "a", tags: ["a"], rule: shift(1, tag("a")) }]))).toEqual([["a", "a"]]);
    expect(validate(withRules([{ id: "a", tags: ["a"], rule: shift(1, tag("a")) }]))).toEqual([`rules read each other's tags in a cycle: "a" → "a"`]);
    const pair = withRules([
      { id: "a", tags: ["a"], rule: first(3, tag("b"), SUNDAY) },
      { id: "b", tags: ["b"], rule: shift(-2, tag("a")) },
    ]);
    expect(ruleCycles(pair)).toEqual([["a", "b", "a"]]);
  });
});

describe("world caps (§16.7 P8)", () => {
  test("a FIRST inside a FIRST is refused, in the match or the anchor, naming the rule", () => {
    for (const rule of [first(3, first(2, tag("a"), tag("b")), tag("c")), first(3, tag("a"), { kind: "not", of: first(2, tag("a"), tag("b")) })]) {
      expect(checkWorldCalendar(withRules([{ id: "nested", tags: ["n"], rule }]))).toContain(`rule "nested": a world calendar's rules cannot hold a FIRST inside a FIRST`);
    }
    // Easter's shape (a FIRST anchored on a rule a FIRST sets) is not nesting: the inner rule is memoised per day
    const easter = withRules([
      { id: "moon", tags: ["paschal"], rule: first(60, dates([79, 444]), SUNDAY) },
      { id: "easter", tags: ["easter"], rule: first(7, shift(1, tag("paschal")), SUNDAY) },
    ]);
    expect(checkWorldCalendar(easter)).toEqual([]);
    expect(ruleReaches(easter)).toEqual([60, 68]);
  });

  test(`the summed reach along any path, through the rules read, is at most ${WORLD_RULE_REACH_MAX}`, () => {
    const chain = (last: number): CalendarAst =>
      withRules([
        { id: "base", tags: ["t0"], rule: shift(-100, SUNDAY) },
        { id: "mid", tags: ["t1"], rule: { kind: "any", of: [shift(5, tag("t0")), first(200, tag("t0"), shift(-50, SUNDAY))] } },
        { id: "top", tags: ["t2"], rule: { kind: "all", of: [first(last, tag("t1"), SUNDAY), tag("t0")] } },
      ]);
    expect(ruleReaches(chain(100))).toEqual([100, 300, 400]);
    expect(checkWorldCalendar(chain(100))).toEqual([]);
    expect(checkWorldCalendar(chain(101))).toEqual([`rule "top": a world calendar's rule reaches 401 days through SHIFT and FIRST (with the rules it reads); the limit is ${WORLD_RULE_REACH_MAX}`]);
    expect(checkWorldCalendar(withRules([{ id: "far", tags: ["f"], rule: shift(-400, shift(1, SUNDAY)) }]))).toEqual([expect.stringContaining(`rule "far": a world calendar's rule reaches 401 days`)]);
  });
});

describe("translate (§16.7 P5)", () => {
  test("for several k, the moved calendar's rules on d + k are the original's on d", () => {
    const ast = withRules([
      { id: "festival", tags: ["festival"], rule: dates([3, 17, 60, 61]) },
      { id: "after", tags: ["after"], rule: shift(1, { kind: "any", of: [tag("festival"), dates([30])] }) },
      { id: "sunday-after", tags: ["sunday-after"], rule: first(9, { kind: "any", of: [dates([10, 44]), { kind: "recur", freq: "day", anchor: 5, interval: 23 }] }, { kind: "all", of: [SUNDAY, { kind: "not", of: shift(-1, { kind: "index", unit: "day", from: 50, to: 52 }) }] }) },
    ]);
    expect(validate(ast)).toEqual([]);
    const e = new Engine(ast);
    let seen = 0;
    for (const k of [-100_000, -7, -1, 1, 3, 365, 400_001]) {
      const moved = new Engine(translate(ast, k));
      for (let d = -20; d <= 120; d++) {
        const want = e.tagsAt(d);
        seen += want.length;
        expect([k, d, moved.tagsAt(d + k)]).toEqual([k, d, want]);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });
});

describe("the first full moon after the equinox (§16.3, §16.7 P5)", () => {
  const MOON: BodyAst = { id: "moon-1", period: { n: 2953059, d: 100000 }, epoch: { n: 1, d: 3 }, moon: { name: "Moon", phases: [{ name: "New", at: 0 }, { name: "First", at: 0.25 }, { name: "Full", at: 0.5 }, { name: "Last", at: 0.75 }] } };
  const EQUINOX: RuleAst = { kind: "all", of: [tag("season:Spring"), { kind: "not", of: shift(1, tag("season:Spring")) }] };
  const PASCHAL: RuleAst = first(60, EQUINOX, { kind: "phase", body: "moon-1", name: "Full" });
  const ast: CalendarAst = {
    ...GREGORIAN,
    seasons: { unit: "year", marks: [{ name: "Winter", from: 0 }, { name: "Spring", slot: { unit: "month", index: 2, day: 21 } }, { name: "Summer", slot: { unit: "month", index: 5, day: 21 } }] },
    bodies: [MOON],
    rules: [
      { id: "paschal", tags: ["paschal"], rule: PASCHAL },
      { id: "easter", tags: ["easter"], rule: first(7, shift(1, tag("paschal")), SUNDAY) },
    ],
  };

  test("matches a forward scan from each equinox day, and Easter is the Sunday after it", () => {
    expect(validate(ast)).toEqual([]);
    expect(checkWorldCalendar(ast)).toEqual([]);
    // the stored text keeps NAME; the hash sees the resolved span
    expect(print(parse(print(ast)))).toContain("PHASE:BODY=moon-1;NAME=Full");
    const e = new Engine(ast);
    const span = phaseSpan("moon-1", "Full", new Map([["moon-1", MOON]])) as { from: number; to: number };
    const full = (x: number) => inPhase(e.bodyPhase("moon-1", x)!, span.from, span.to);
    const [from, to] = [-800, 4 * 365 + 800];
    const paschal = new Set<number>();
    let equinoxes = 0;
    for (let d = from; d <= to; d++) {
      if (e.seasonAt(d) !== "Spring" || e.seasonAt(d - 1) === "Spring") continue;
      equinoxes++;
      // 21 March: the equinox day in this calendar
      for (let x = d; x <= d + 60; x++)
        if (full(x)) {
          paschal.add(x);
          break;
        }
    }
    expect(equinoxes).toBeGreaterThanOrEqual(6);
    const sundayAfter = (p: number) => {
      for (let x = p + 1; x <= p + 7; x++) if (e.days.holds(SUNDAY, x)) return x;
      return undefined;
    };
    const easter = new Set([...paschal].map(sundayAfter));
    for (let d = from + 70; d <= to; d++) {
      const tags = e.tagsAt(d);
      expect([d, tags.includes("paschal"), tags.includes("easter")]).toEqual([d, paschal.has(d), easter.has(d)]);
    }
    expect(paschal.size).toBe(equinoxes);
  });

  test("hashes: the resolved span is hashed, and a definition without SHIFT or FIRST hashes as before", () => {
    const moved = { ...ast, bodies: [{ ...MOON, moon: { name: "Moon", phases: [{ name: "New", at: 0 }, { name: "Full", at: 0.55 }] } }] };
    expect(hash(moved)).not.toBe(hash(ast));
    const plain = { ...ast, rules: [{ id: "p", tags: ["p"], rule: EQUINOX.kind === "all" ? EQUINOX.of[0]! : EQUINOX }] };
    expect(JSON.stringify(definitionContent(plain))).not.toContain("shift");
  });
});
