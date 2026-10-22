/**
 * Seshat P4 step 0 and step 1 core (docs/SESHAT-v0.md §16, §16.7; bead
 * wadjet-01k.14): the hash pin over every fixture, the shared season
 * resolver, the resolve pass, and units that follow a body.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { DAY_LIMIT, definitionContent, Engine, epochEditK, parse, print, resolve, resolveCrossing, seasonAtPhase, translate, validate, type BodyAst, type CalendarAst, type CrossingAst, type LiteralCrossingAst, type UnitAst } from "../src/seshat";
import { canonicalJson } from "../src/core/profile";
import { migrateSettings } from "../src/plugin/settings";
import { startNewWorld } from "../src/plugin/new-world";
import { definitionFromLegacy, SeshatCalendar } from "../src/plugin/time/seshat";

const DIR = "test/fixtures/seshat";
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".seshat")).sort();
const text = (f: string) => readFileSync(`${DIR}/${f}`, "utf8");
const contentHash = (ast: CalendarAst) => Bun.hash(canonicalJson(definitionContent(ast))).toString(16);

function legacyDerived(): CalendarAst {
  const r = definitionFromLegacy(migrateSettings(null).calendar);
  if ("refused" in r) throw new Error(r.refused);
  return r.ast;
}
function newWorld(): string {
  const s = migrateSettings(null);
  startNewWorld(s);
  return s.calendar.definition as string;
}

// Pinned 2026-10-22 with the code before P4 (step 0): later steps must not move any of them.
const CONFIG_HASH: Record<string, string> = {
  "bahai.seshat": "seshat:751742bb7466d614",
  "balinese.seshat": "seshat:fault:291d0e6be8359683",
  "coptic.seshat": "seshat:f7e8bf85742ba8a1",
  "ethiopian.seshat": "seshat:17083435e30dc1d0",
  "french-republican-equinox.seshat": "seshat:5332faa947d7bd22",
  "french-republican.seshat": "seshat:abc816528181728f",
  "gregorian.seshat": "seshat:8d480f3d84c047ff",
  "harptos.seshat": "seshat:d29bd14c29bcf491",
  "hebrew.seshat": "seshat:aed82c35402d81e3",
  "islamic-civil.seshat": "seshat:8a12bc7f2c1a3051",
  "islamic-tbla.seshat": "seshat:e80c5f85c51c4bc2",
  "maya.seshat": "seshat:fault:c716a1c2fc546193",
  "roman.seshat": "seshat:7457e581463e6084",
  "legacy-derived": "seshat:46678e4db766715f",
  "new-world": "seshat:ea58f750d03c60c2",
};
// definitionContent itself, also for the fixtures that fault as world calendars (their configHash hashes the raw text)
const CONTENT_HASH: Record<string, string> = {
  "bahai.seshat": "70b6ee83e1d9d6d9",
  "balinese.seshat": "4ee4887d14917b9d",
  "coptic.seshat": "a6d5ee1b76f121dc",
  "ethiopian.seshat": "639d861ac8875be1",
  "french-republican-equinox.seshat": "d1fcf57c4ba353f2",
  "french-republican.seshat": "d99ddc5e9664b58a",
  "gregorian.seshat": "87161f65d107b944",
  "harptos.seshat": "3f8d44a4ea24c687",
  "hebrew.seshat": "d91fdb6150ea6d06",
  "islamic-civil.seshat": "b71410d9b4b43e8b",
  "islamic-tbla.seshat": "f72b8ae3ae50e839",
  "maya.seshat": "bcd0afbd79191d2f",
  "roman.seshat": "8fa65e4b77939630",
};

describe("P4 step 0: the hash pin", () => {
  test("every fixture is pinned (a new fixture must be added here)", () => {
    expect(Object.keys(CONTENT_HASH).sort()).toEqual(FIXTURES);
  });

  test("configHash of every fixture, the legacy-derived definition and the new-world default is unchanged", () => {
    const got: Record<string, string> = {};
    for (const f of FIXTURES) got[f] = new SeshatCalendar(text(f), () => 0).configHash();
    got["legacy-derived"] = new SeshatCalendar(print(legacyDerived()), () => 0).configHash();
    got["new-world"] = new SeshatCalendar(newWorld(), () => 0).configHash();
    expect(got).toEqual(CONFIG_HASH);
  });

  test("definitionContent of every fixture is unchanged, and the resolve pass is the identity on each", () => {
    const got: Record<string, string> = {};
    for (const f of FIXTURES) {
      const ast = parse(text(f));
      expect(resolve(ast)).toBe(ast);
      got[f] = contentHash(ast);
    }
    expect(got).toEqual(CONTENT_HASH);
    const l = legacyDerived();
    expect(resolve(l)).toBe(l);
  });
});

describe("P4 step 0: one season resolver for the engine and the adapter", () => {
  const MARKS = [
    { name: "Spring", from: 0.2 },
    { name: "Summer", from: 0.45 },
    { name: "Autumn", from: 0.7 },
    { name: "Winter", from: 0.95 },
  ];
  const legacy = legacyDerived();
  const worlds: Array<[string, CalendarAst]> = [["legacy-derived", legacy], ["legacy-derived, four seasons", { ...legacy, seasons: { unit: "year", marks: MARKS } }]];
  for (const f of FIXTURES) {
    const ast = parse(text(f));
    if (ast.units.some((u) => u.id === "year")) worlds.push([f, { ...ast, seasons: { unit: "year", marks: MARKS } }]);
  }

  test("engine.seasonAt and toContext's season tag agree on every day of a span, for every world with seasons", () => {
    let checked = 0;
    for (const [name, ast] of worlds) {
      const cal = new SeshatCalendar(print(ast), () => 0);
      if (cal.fault) continue; // not a world calendar (Maya, Balinese)
      const e = new Engine(ast);
      const days = [...Array.from({ length: 1500 }, (_, i) => i - 750), ...[-DAY_LIMIT, -DAY_LIMIT + 1, DAY_LIMIT - 1, DAY_LIMIT], ...Array.from({ length: 200 }, (_, i) => -DAY_LIMIT + i * 100_003)];
      for (const d of days) {
        // the expression both used before step 0, inline: the phase of the year occurrence holding d
        if (Math.abs(d) <= DAY_LIMIT - 1000 && d % 7 === 0) {
          const i = e.indexAt("year", d);
          const y = { start: e.start("year", i), length: e.start("year", i + 1) - e.start("year", i) };
          expect([name, d, e.seasonAt(d)]).toEqual([name, d, seasonAtPhase(ast.seasons?.marks ?? [], (d - y.start) / y.length)]);
        }
        const tag = cal.toContext(d).tags?.find((t) => t.startsWith("season:")) ?? null;
        const want = Math.abs(d) <= DAY_LIMIT ? e.seasonAt(d) : null;
        if (Math.abs(d) <= DAY_LIMIT) expect([name, d, tag]).toEqual([name, d, want === null ? null : `season:${want}`]);
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Units that follow a body
// ---------------------------------------------------------------------------

const MOON: BodyAst = { id: "moon-1", period: { n: 2953, d: 100 }, epoch: { n: 3, d: 10 } };

function lunar(crossing: CrossingAst, bodies: readonly BodyAst[] = [MOON], extra: Partial<UnitAst> = {}): CalendarAst {
  return {
    name: "Lunar",
    bodies,
    gears: [],
    units: [{ id: "month", kind: "cycle", crossing, ...extra } as UnitAst],
  };
}

/** crossing k at (mark − E + K)·P + o, in BigInt, as a literal crossing */
function literalFor(b: BodyAst, mark: [number, number], offset: [number, number] = [0, 1], K = 0): LiteralCrossingAst {
  const [mn, md] = mark.map(BigInt) as [bigint, bigint];
  const [on, od] = offset.map(BigInt) as [bigint, bigint];
  const [pn, pd, en, ed] = [b.period.n, b.period.d, b.epoch.n, b.epoch.d].map(BigInt) as [bigint, bigint, bigint, bigint];
  let n = ((mn * ed - en * md + BigInt(K) * md * ed) * pn) * od + on * md * ed * pd;
  let d = md * ed * pd * od;
  const g = (a: bigint, c: bigint): bigint => (c ? g(c, a % c) : a < 0n ? -a : a);
  const k = g(n, d);
  [n, d] = [n / k, d / k];
  return { period: b.period, at: { n: Number(n), d: Number(d) } };
}

const SAMPLE = [
  ...Array.from({ length: 2000 }, (_, i) => i - 1000),
  ...Array.from({ length: 2000 }, (_, i) => -DAY_LIMIT + i * 9_973),
  -DAY_LIMIT,
  -DAY_LIMIT + 1,
  DAY_LIMIT - 1,
  DAY_LIMIT,
];

function sameDays(a: Engine, b: Engine, unit = "month"): void {
  for (const d of SAMPLE) {
    const [x, y] = [a.occurrenceAt(unit, d)!, b.occurrenceAt(unit, d)!];
    if (x.index !== y.index || x.start !== y.start || x.length !== y.length) expect([d, x]).toEqual([d, y]);
  }
}

describe("P4 step 1: CROSSING:BODY= resolves to the equivalent literal crossing", () => {
  const cases: Array<[string, CrossingAst, LiteralCrossingAst]> = [
    ["mark 0", { body: { id: "moon-1", mark: { n: 0, d: 1 } } }, literalFor(MOON, [0, 1])],
    ["mark 1/2, offset 1/4, K 2", { body: { id: "moon-1", mark: { n: 1, d: 2 }, offset: { n: 1, d: 4 }, k: 2 } }, literalFor(MOON, [1, 2], [1, 4], 2)],
    ["mark 3/7, offset −5/3, K −1", { body: { id: "moon-1", mark: { n: 3, d: 7 }, offset: { n: -5, d: 3 }, k: -1 } }, literalFor(MOON, [3, 7], [-5, 3], -1)],
  ];
  for (const [name, body, literal] of cases) {
    test(`${name}: every sampled day (±10M edges included) reads the same, and it hashes as the literal`, () => {
      const [a, b] = [lunar(body), lunar(literal)];
      expect(validate(a)).toEqual([]);
      sameDays(new Engine(a), new Engine(b));
      expect(definitionContent(a)).toEqual(definitionContent(b));
      expect(print(a)).toContain("CROSSING:BODY=moon-1");
    });
  }

  test("START=after is ceil of the instant: the hand-shifted literal, one day later unless the instant is a whole day", () => {
    const body: CrossingAst = { body: { id: "moon-1", mark: { n: 1, d: 2 } }, start: "after" };
    const lit = literalFor(MOON, [1, 2]);
    const L = BigInt(lit.period.d) * BigInt(lit.at.d) / BigInt(gcdN(lit.period.d, lit.at.d));
    const shifted = { ...lit, at: reduceN(BigInt(lit.at.n) * (L / BigInt(lit.at.d)) + L - 1n, L) };
    const [a, s, c] = [new Engine(lunar(body)), new Engine(lunar(shifted)), new Engine(lunar(lit))];
    sameDays(a, s);
    expect(definitionContent(lunar(body))).toEqual(definitionContent(lunar(shifted)));
    expect(definitionContent(lunar({ ...lit, start: "after" }))).toEqual(definitionContent(lunar(shifted)));
    for (let k = -50; k <= 50; k++) {
      const exact = (k * MOON.period.n) / MOON.period.d + lit.at.n / lit.at.d; // non-integral for this moon
      expect([k, a.start("month", k)]).toEqual([k, Math.ceil(exact)]);
      expect(a.start("month", k)).toBe(c.start("month", k) + 1);
    }
  });

  test("START=after agrees with PHASE:BODY=<id>;FROM=<mark>: each month starts on the first day of the phase run", () => {
    for (const [mark, from, to] of [[{ n: 1, d: 2 }, 0.5, 1], [{ n: 0, d: 1 }, 0, 0.5], [{ n: 1, d: 4 }, 0.25, 0.75]] as const) {
      const e = new Engine(lunar({ body: { id: "moon-1", mark }, start: "after" }));
      const rule = { kind: "phase" as const, body: "moon-1", from, to };
      for (let k = -300; k <= 300; k++) {
        const s = e.start("month", k);
        expect([k, e.days.holds(rule, s), e.days.holds(rule, s - 1)]).toEqual([k, true, false]);
      }
    }
  });

  test("START=after on a whole-day instant is contains: CROSSING:30@D5, and a body (P=30, E=0, mark 0)", () => {
    const P30: BodyAst = { id: "moon-1", period: { n: 30, d: 1 }, epoch: { n: 0, d: 1 } };
    const pairs: Array<[CrossingAst, CrossingAst, readonly BodyAst[]]> = [
      [{ period: { n: 30, d: 1 }, at: { n: 5, d: 1 }, start: "after" }, { period: { n: 30, d: 1 }, at: { n: 5, d: 1 } }, []],
      [{ body: { id: "moon-1", mark: { n: 0, d: 1 } }, start: "after" }, { body: { id: "moon-1", mark: { n: 0, d: 1 } } }, [P30]],
    ];
    for (const [afterC, containsC, bodies] of pairs) {
      const [a, c] = [new Engine(lunar(afterC, bodies)), new Engine(lunar(containsC, bodies))];
      for (let k = -300; k <= 300; k++) expect([k, a.start("month", k)]).toEqual([k, c.start("month", k)]);
      for (const k of [-333_000, -1, 0, 1, 333_000]) expect([k, a.start("month", k)]).toEqual([k, c.start("month", k)]);
    }
  });

  test("START=after with L > 1: whole-day crossings start the same day, the rest one day later", () => {
    // P = 59/2, at 0: crossing k sits at 29.5·k, a whole day for even k only
    const lit = { period: { n: 59, d: 2 }, at: { n: 0, d: 1 } };
    const [a, c] = [new Engine(lunar({ ...lit, start: "after" }, [])), new Engine(lunar(lit, []))];
    let whole = 0;
    for (let k = -400; k <= 400; k++) {
      const x = (59 * k) / 2;
      expect([k, c.start("month", k)]).toEqual([k, Math.floor(x)]);
      expect([k, a.start("month", k)]).toEqual([k, Math.ceil(x)]);
      if (Number.isInteger(x)) whole++;
    }
    expect(whole).toBe(401);
  });

  test("START=after on a literal crossing round-trips through the text and resolves the same way", () => {
    const t = print(lunar({ ...literalFor(MOON, [0, 1]), start: "after" }));
    expect(t).toContain(";START=after");
    expect(parse(t).units[0]).toEqual(lunar({ ...literalFor(MOON, [0, 1]), start: "after" }).units[0]);
    expect(parse(t.replace(";START=after", ";START=contains")).units[0]).toEqual(lunar(literalFor(MOON, [0, 1])).units[0]);
  });

  test("INDEX with a body base: the Hebrew year, following a molad body, reads every day as the preset does", () => {
    const hebrew = parse(text("hebrew.seshat"));
    const year = hebrew.units.find((u) => u.id === "year")!;
    if (year.kind !== "cycle" || !year.crossing || year.crossing.body) throw new Error("the Hebrew year is a literal crossing");
    const { period: P, at } = year.crossing;
    // E = frac(−at/P), K = −floor(−at/P), so (0 − E + K)·P = at exactly
    const xn = -BigInt(at.n) * BigInt(P.d);
    const xd = BigInt(at.d) * BigInt(P.n);
    const fl = xn / xd - (xn % xd !== 0n && xn < 0n ? 1n : 0n);
    const epoch = reduceN(xn - fl * xd, xd);
    const molad: BodyAst = { id: "molad", period: P, epoch };
    const followed: CalendarAst = {
      ...hebrew,
      bodies: [molad],
      units: hebrew.units.map((u) => (u === year ? { ...year, crossing: { body: { id: "molad", mark: { n: 0, d: 1 }, k: Number(-fl) }, index: year.crossing.index! } } : u)),
    };
    expect(validate(followed)).toEqual([]);
    const [a, b] = [new Engine(followed), new Engine(hebrew)];
    sameDays(a, b, "year");
    for (const d of SAMPLE.filter((_, i) => i % 7 === 0)) expect([d, a.occurrenceAt("month", d)]).toEqual([d, b.occurrenceAt("month", d)]);
    expect(parse(print(followed))).toEqual(followed);
  });

  test("text: MARK as a decimal or n/d, defaults normalise to absent, unknown parameters are refused", () => {
    const base = print(lunar({ body: { id: "moon-1", mark: { n: 1, d: 4 } } }));
    expect(base).toContain("CROSSING:BODY=moon-1;MARK=0.25\n");
    const line = (l: string) => parse(base.replace("CROSSING:BODY=moon-1;MARK=0.25", l)).units[0]!;
    expect(line("CROSSING:BODY=moon-1;MARK=1/4")).toEqual(line("CROSSING:BODY=moon-1;MARK=0.25"));
    expect(line("CROSSING:BODY=moon-1;MARK=0.250;OFFSET=0;K=0;START=contains")).toEqual(line("CROSSING:BODY=moon-1;MARK=1/4"));
    expect(line("CROSSING:BODY=moon-1;MARK=1/3;OFFSET=-1/2;K=3;START=after;INDEX=1/0/1")).toEqual({ id: "month", kind: "cycle", crossing: { body: { id: "moon-1", mark: { n: 1, d: 3 }, offset: { n: -1, d: 2 }, k: 3 }, start: "after", index: { a: 1, c: 0, L: 1 } } });
    for (const bad of ["CROSSING:BODY=moon-1;MARK=0;FOO=1", "CROSSING:BODY=moon-1", "CROSSING:2953/100@D0;MARK=0", "CROSSING:2953/100@D0;BODY=moon-1;MARK=0", "CROSSING:BODY=moon-1;MARK=0;START=before", "CROSSING:BODY=moon-1;MARK=0;K=1.5", "CROSSING:BODY=Moon;MARK=0"]) {
      expect(() => line(bad)).toThrow();
    }
    expect(() => print(lunar({ body: { id: "moon-1", mark: { n: 0, d: 1 }, extra: 1 } as never }))).toThrow(/no text form/);
  });
});

describe("P4 step 1: validation of a body reference", () => {
  const errs = (c: CrossingAst, bodies: readonly BodyAst[] = [MOON]) => validate(lunar(c, bodies));

  test("a missing body is an error (the world faults; no fallback)", () => {
    expect(errs({ body: { id: "moon-2", mark: { n: 0, d: 1 } } })).toEqual([`unit "month": crossing follows body "moon-2", which is not declared`]);
    expect(() => new Engine(lunar({ body: { id: "moon-2", mark: { n: 0, d: 1 } } }))).toThrow(/not declared/);
    expect(new SeshatCalendar(print(lunar({ body: { id: "moon-2", mark: { n: 0, d: 1 } } })), () => 0).fault).not.toBeNull();
  });

  test("the mark is in [0, 1); the body's period is at least a day", () => {
    expect(errs({ body: { id: "moon-1", mark: { n: 1, d: 1 } } })[0]).toMatch(/mark must be .* in \[0, 1\)/);
    expect(errs({ body: { id: "moon-1", mark: { n: -1, d: 2 } } })[0]).toMatch(/mark must be/);
    expect(errs({ body: { id: "moon-1", mark: { n: 0, d: 1 } } }, [{ ...MOON, period: { n: 1, d: 2 } }]).join()).toMatch(/follows body "moon-1", whose period 1\/2 is shorter than one day/);
  });

  test("V5 on resolved numbers names the body and the unit", () => {
    const e = errs({ body: { id: "moon-1", mark: { n: 1, d: 1_000_000_007 } } });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^unit "month": crossing following body "moon-1" .* is too fine .* \(V5\)/);
  });

  test("a START=after literal: lowest terms is asked for by name, and V5/V8 name START=after and the instant as written", () => {
    expect(validate(lunar({ period: { n: 60, d: 2 }, at: { n: 0, d: 1 }, start: "after" }, []))[0]).toMatch(/unit "month".*lowest terms/);
    const v8 = validate(lunar({ period: { n: 1, d: 2 }, at: { n: 1, d: 3 }, start: "after" }, []))[0];
    expect(v8).toMatch(/unit "month"/);
    expect(v8).toMatch(/at 1\/3;START=after .*shorter than one day \(V8\)/);
    const v5 = validate(lunar({ period: { n: 2953, d: 100 }, at: { n: 1, d: 999_999_937 }, start: "after" }, []))[0];
    expect(v5).toMatch(/unit "month": crossing 2953\/100 at 1\/999999937;START=after \(instant .*\) is too fine .*\(V5\)/);
  });

  test("a ledger switch rule resolves the same way", () => {
    const sw = (c: CrossingAst): CalendarAst => lunar(literalFor(MOON, [0, 1]), [MOON], { ledger: [{ kind: "switch", from: 10, rule: { crossing: c } }] });
    const [a, b] = [sw({ body: { id: "moon-1", mark: { n: 1, d: 2 } }, start: "after" }), sw({ ...literalFor(MOON, [1, 2]), start: "after" })];
    expect(validate(a)).toEqual([]);
    sameDays(new Engine(a), new Engine(b));
    expect(definitionContent(a)).toEqual(definitionContent(b));
    expect(validate(sw({ body: { id: "nope", mark: { n: 0, d: 1 } } }))[0]).toMatch(/switch .*not declared/);
  });
});

describe("P4 step 1: translate keeps a body-driven unit's numbering (§16.7 P1)", () => {
  const ast = lunar({ body: { id: "moon-1", mark: { n: 1, d: 2 }, offset: { n: 1, d: 3 } }, start: "after" });
  const e = new Engine(ast);
  // P = 29.53, E = 0.3: k = 9 does not wrap the epoch, k = 10 does (10/29.53 > 0.3), the rest wrap many times
  for (const k of [1, 9, 10, -1, -21, 30, 1000, -123_457, 4_000_000]) {
    test(`by ${k} days: every occurrence keeps its index and its start moves by exactly ${k}`, () => {
      const t = translate(ast, k);
      expect(t.bodies).toEqual(translate({ ...ast, units: [] }, k).bodies);
      const m = new Engine(t);
      for (let i = -400; i <= 400; i++) expect([i, m.start("month", i)]).toEqual([i, e.start("month", i) + k]);
      for (const d of SAMPLE.filter((x) => Math.abs(x + k) <= DAY_LIMIT).filter((_, i) => i % 5 === 0)) expect([d, m.indexAt("month", d + k)]).toEqual([d, e.indexAt("month", d)]);
    });
  }

  test("a body the calendar does not hold is refused, not cut loose by shifting the offset", () => {
    expect(() => translate(lunar({ body: { id: "moon-1", mark: { n: 0, d: 1 } } }, []), 5)).toThrow(/crossing of unit "month" follows body "moon-1", which this calendar does not hold; add the body before translating/);
  });
});

describe("P4 step 1: epochEditK moves crossings by the smallest shift", () => {
  const at = (epoch: { n: number; d: number }, k: number) => {
    const r = resolveCrossing({ body: { id: "moon-1", mark: { n: 0, d: 1 }, ...(k ? { k } : {}) } }, new Map([["moon-1", { ...MOON, epoch }]]));
    if ("error" in r) throw new Error(r.error);
    return r.crossing.at.n / r.crossing.at.d;
  };
  const P = MOON.period.n / MOON.period.d;
  for (const [from, to, turns] of [
    [{ n: 99, d: 100 }, { n: 1, d: 100 }, -0.02],
    [{ n: 1, d: 100 }, { n: 99, d: 100 }, 0.02],
    [{ n: 3, d: 10 }, { n: 1, d: 5 }, 0.1],
    [{ n: 0, d: 1 }, { n: 1, d: 2 }, -0.5],
    [{ n: 1, d: 2 }, { n: 0, d: 1 }, -0.5],
    [{ n: 1, d: 3 }, { n: 1, d: 3 }, 0],
    // epochs written past a turn: the K delta takes the whole turns as well
    [{ n: 7, d: 2 }, { n: 1, d: 4 }, 0.25],
    [{ n: -9, d: 4 }, { n: 5, d: 2 }, 0.25],
  ] as const) {
    test(`${from.n}/${from.d} → ${to.n}/${to.d}: crossings move by ${turns} of a turn`, () => {
      const j = epochEditK(from, to);
      expect(Math.abs(turns)).toBeLessThanOrEqual(0.5);
      expect(at(to, j) - at(from, 0)).toBeCloseTo(turns * P, 9);
      // on the result alone, from any starting K: the shift is in [−1/2, 1/2) of a turn
      for (const K of [0, 5, -12]) {
        const shift = (at(to, K + j) - at(from, K)) / P;
        expect(shift).toBeGreaterThanOrEqual(-0.5 - 1e-12);
        expect(shift).toBeLessThan(0.5);
      }
    });
  }
});

function gcdN(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}
function reduceN(n: bigint, d: bigint): { n: number; d: number } {
  const g = (a: bigint, c: bigint): bigint => (c ? g(c, a % c) : a < 0n ? -a : a);
  const k = g(n, d);
  return { n: Number(n / k), d: Number(d / k) };
}
