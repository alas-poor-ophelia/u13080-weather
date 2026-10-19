/**
 * Seshat P2 step 4 (docs/SESHAT-v0.md §4.1): the text syntax.
 *
 *   - fixtures: every P1 calendar's canonical text is committed; print(ast)
 *     equals the file byte for byte and parse(file) equals the AST;
 *   - grammar fuzz: 10,000 seeded, type-correct but unvalidated ASTs with
 *     hostile strings and every absent-versus-empty distinction must survive
 *     parse(print(x)) exactly, and printing is a fixpoint;
 *   - engine equivalence: P1 calendars mutated within validity (template
 *     mutations, not filtered noise), with a minimum count per mutation kind,
 *     must answer Engine.start the same after a round trip;
 *   - errors: what the parser must refuse, with a line number.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, HEBREW, parse, print, SeshatSyntaxError, validate, type CalendarAst, type RuleAst, type UnitAst } from "../src/seshat";
import { SESHAT_FIXTURES } from "./fixtures/seshat/calendars";

const DIR = new URL("./fixtures/seshat/", import.meta.url);

/** Deep equality where an absent key equals an undefined one, and numbers compare with Object.is (so -0 ≠ 0). */
function same(a: unknown, b: unknown, path = "$"): string | null {
  if (typeof a === "number" || typeof b === "number") return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b ? null : `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => (a as Record<string, unknown>)[k] !== undefined || (b as Record<string, unknown>)[k] !== undefined));
  for (const k of keys) {
    const d = same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

describe("Seshat text: the P1 calendars", () => {
  for (const [file, ast] of Object.entries(SESHAT_FIXTURES)) {
    test(`${file}: print(ast) is the committed file, and parse(file) is the AST`, async () => {
      const text = await Bun.file(new URL(file, DIR)).text();
      expect(print(ast)).toBe(text);
      expect(same(parse(text), ast)).toBeNull();
    });
  }

  test("a commented, non-canonical spelling parses to the same calendar (comments, blank lines, parameters out of order)", async () => {
    const text = await Bun.file(new URL("hebrew-commented.txt", DIR)).text();
    expect(text).toContain("# lo ADU rosh");
    expect(same(parse(text), HEBREW)).toBeNull();
    expect(print(parse(text))).toBe(print(HEBREW));
  });
});

// ---------------------------------------------------------------------------
// Grammar fuzz
// ---------------------------------------------------------------------------

/** mulberry32: a seeded stream, so a failing case can be replayed from its index. */
function stream(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const maybe = <T>(f: () => T): T | undefined => (next() < 0.5 ? f() : undefined);
  /** absent, [] or a short list: every list that may be absent gets all three */
  const listOf = <T>(f: () => T, max = 3): T[] | undefined => {
    const r = next();
    return r < 0.3 ? undefined : r < 0.5 ? [] : Array.from({ length: int(1, max) }, f);
  };
  return { next, int, pick, maybe, listOf };
}

const HOSTILE = ["\ud800", "lone \udfff", "\u2028", "\ufeff", "\u0085", "", " ", "  padded  ", "a,b", "x;y", "k=v", "#tag", "##", "back\\slash", "\\0", "\\n", "new\nline", "cr\rhere", "trail\r", "colon:", ":lead", "Adar I", "ü ñ", "😀", "\t", "D12", "=", ",", ";", "@", "+1/2", "BEGIN:VCALENDAR", "END:VUNIT", "#", "\\", "TRUE"];

function fuzzAst(seed: number): CalendarAst {
  const r = stream(seed);
  const ids = ["a", "year", "month", "x-1", "leap", "z9", "day", "b-c-d"];
  const id = () => r.pick(ids);
  const text = () => (r.next() < 0.6 ? r.pick(HOSTILE) : `${r.pick(HOSTILE)}${r.pick(HOSTILE)}`);
  const int = () => r.pick([0, 1, -1, 7, 29, 365, -2_092_590, 2 ** 52, -(2 ** 52), r.int(-1000, 1000)]);
  const float = () => r.pick([0, -0, 0.45, 0.72, 1, -0.1, 0.30000000000000004, 1e21, 5e-324, 1 / 3, r.next()]);
  // includes the safe-integer edge, where q·d of a mixed day position passes 2^53 (review 2026-10-19)
  const rat = () => r.pick([{ n: 765_433, d: 25_920 }, { n: -4_519_993_393, d: 2160 }, { n: 5, d: 1 }, { n: -7, d: 3 }, { n: 0, d: 1 }, { n: 1, d: 2 }, { n: -(2 ** 53 - 1), d: 3 }, { n: 2 ** 53 - 1, d: 2 }, { n: -9_007_199_254_740_989, d: 7 }, { n: 2 ** 53 - 3, d: 5 }]);
  const tagsOf = () => r.listOf(text);
  const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } => (v === undefined ? {} : ({ [k]: v } as { [P in K]: V }));
  const gearTerms = () => r.listOf(() => ({ gear: id(), add: int() }));
  const stageRule = () => (r.next() < 0.5 ? { add: int(), residue: { mod: int(), ...opt("offset", r.maybe(int)), in: Array.from({ length: r.int(0, 3) }, int) } } : { add: int(), length: { at: int(), is: int() } });
  const stages = () => r.listOf(() => ({ rules: Array.from({ length: r.int(0, 3) }, stageRule) }));
  const base = () => (r.next() < 0.5 ? { anchor: int(), length: int() } : { crossing: { period: rat(), at: rat(), ...opt("index", r.maybe(() => ({ a: int(), c: int(), L: int() }))) } });
  const rule = () => ({ ...base(), ...opt("gears", gearTerms()), ...opt("stages", stages()) });
  const label = () => r.pick([{}, { name: text() }, { tags: tagsOf() ?? [] }, { name: text(), tags: tagsOf() ?? [] }]);
  const ledger = () =>
    r.listOf(() =>
      r.pick([
        () => ({ kind: "switch" as const, from: int(), rule: rule() }),
        () => ({ kind: "starts" as const, from: int(), startsOn: int(), ...opt("lengths", r.listOf(int)) }),
        () => ({ kind: "slots" as const, from: int(), unit: id(), ...opt("path", r.listOf(int)), lengths: Array.from({ length: r.int(0, 3) }, int) }),
      ])(),
    );
  const slot = () => ({
    ...opt("name", r.maybe(text)),
    ...opt("tags", tagsOf()),
    length: r.pick([() => int(), () => "slack" as const, () => ({ by: "parent" as const, table: Array.from({ length: r.int(0, 3) }, () => [int(), int()] as const) })])(),
    ...opt("min", r.maybe(int)),
    ...opt("max", r.maybe(int)),
    ...opt("fill", r.maybe(int)),
    ...opt("gears", gearTerms()),
    ...opt("filler", r.maybe(() => r.next() < 0.5)),
  });
  const unit = (): UnitAst =>
    r.next() < 0.5
      ? ({ id: id(), kind: "cycle", ...opt("number", r.maybe(int)), ...rule(), ...opt("labels", r.listOf(label, 4)), ...opt("ledger", ledger()) })
      : { id: id(), kind: "slots", ...opt("number", r.maybe(int)), in: id(), slots: Array.from({ length: r.int(0, 4) }, slot) };
  const node = (depth: number): RuleAst => {
    const leaves: Array<() => RuleAst> = [
      () => ({ kind: "phase", ...opt("unit", r.maybe(id)), ...opt("body", r.maybe(id)), from: float(), to: float() }),
      () => ({ kind: "dayIn", unit: id(), from: float(), to: float() }),
      () => ({ kind: "index", unit: id(), ...opt("from", r.maybe(int)), ...opt("to", r.maybe(int)) }),
      () => ({ kind: "tag", tag: text() }),
      () => ({ kind: "dates", days: Array.from({ length: r.int(0, 3) }, int) }),
      () => ({
        kind: "recur",
        freq: id(),
        ...opt("interval", r.maybe(int)),
        ...opt("anchor", r.maybe(int)),
        ...opt("by", r.listOf(() => r.pick([() => ({ unit: id(), nth: Array.from({ length: r.int(0, 2) }, int) }), () => ({ unit: id(), label: Array.from({ length: r.int(0, 2) }, text) }), () => ({ unit: id(), day: Array.from({ length: r.int(0, 2) }, int) })])())),
        ...opt("setpos", r.listOf(int)),
        ...opt("count", r.maybe(int)),
        ...opt("until", r.maybe(int)),
      }),
    ];
    if (depth >= 3 || r.next() < 0.5) return r.pick(leaves)();
    return r.pick<() => RuleAst>([() => ({ kind: "all", of: Array.from({ length: r.int(0, 3) }, () => node(depth + 1)) }), () => ({ kind: "any", of: Array.from({ length: r.int(0, 3) }, () => node(depth + 1)) }), () => ({ kind: "not", of: node(depth + 1) })])();
  };
  return {
    name: text(),
    ...opt("formats", r.listOf(() => ({ name: text(), pattern: `${text()}{${id()}}${text()}` }))),
    ...opt("bodies", r.listOf(() => ({ id: id(), period: rat(), epoch: rat() }))),
    gears: Array.from({ length: r.int(0, 2) }, () => (r.next() < 0.5 ? { id: id(), on: id(), kind: "intervals" as const, terms: Array.from({ length: r.int(0, 3) }, () => ({ every: int(), ...opt("offset", r.maybe(int)), sign: r.pick([1, -1] as const) })) } : { id: id(), on: id(), kind: "positions" as const, period: int(), positions: Array.from({ length: r.int(0, 3) }, int), ...opt("offset", r.maybe(int)) })),
    units: Array.from({ length: r.int(0, 3) }, unit),
    ...opt("days", r.listOf(() => ({ day: int(), ...opt("name", r.maybe(text)), ...opt("tags", tagsOf()) }))),
    ...opt("rules", r.listOf(() => ({ id: id(), ...opt("tags", tagsOf()), rule: node(0) }))),
  };
}

describe("Seshat text: grammar fuzz", () => {
  test("10,000 hostile, unvalidated ASTs survive parse(print(x)) exactly, and printing is a fixpoint", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 10_000; seed++) {
      const ast = fuzzAst(seed);
      try {
        const text = print(ast);
        const back = parse(text);
        const diff = same(back, ast);
        if (diff) failures.push(`seed ${seed}: ${diff}`);
        else if (print(back) !== text) failures.push(`seed ${seed}: reprint differs`);
      } catch (e) {
        failures.push(`seed ${seed}: ${(e as Error).message}`);
      }
      if (failures.length >= 5) break;
    }
    expect(failures).toEqual([]);
  });

  test("the fuzz reaches every distinction it is meant to (coverage, not luck)", () => {
    const seen = new Map<string, number>();
    const mark = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1);
    const leaf = (v: unknown, key: string) => {
      if (typeof v === "number" && Object.is(v, -0)) mark("-0");
      if (typeof v === "number" && Math.abs(v) >= 2 ** 52) mark("near 2^53");
      if (typeof v === "string" && v !== "" && HOSTILE.includes(v)) mark(`hostile ${key || "element"}`);
      if (typeof v === "string" && /[\ud800-\udfff]/.test(v)) mark("lone surrogate");
      if (v === "") mark("empty string");
    };
    const walk = (x: unknown, key = "", depth = 0): void => {
      if (Array.isArray(x)) {
        if (x.length === 0 && key) mark(`[] ${key}`);
        for (const v of x) {
          leaf(v, `${key}[]`);
          walk(v, key, depth);
        }
      } else if (typeof x === "object" && x !== null) {
        const o = x as Record<string, unknown>;
        if (typeof o.kind === "string") mark(`kind ${o.kind}`);
        if (key === "labels" && Object.keys(o).length === 0) mark("empty label");
        if (o.kind === "phase") mark(o.unit !== undefined && o.body !== undefined ? "phase both" : o.unit !== undefined ? "phase unit" : o.body !== undefined ? "phase body" : "phase neither");
        if (key === "crossing" && o.index !== undefined) mark("crossing index");
        if ((o.kind === "all" || o.kind === "any" || o.kind === "not") && depth >= 2) mark("rule depth 3+");
        for (const [k, v] of Object.entries(o)) {
          leaf(v, k);
          walk(v, k, o.kind === "all" || o.kind === "any" || o.kind === "not" ? depth + 1 : depth);
        }
      }
    };
    for (let seed = 1; seed <= 10_000; seed++) walk(fuzzAst(seed));
    const want = ["kind cycle", "kind slots", "kind intervals", "kind positions", "kind switch", "kind starts", "kind all", "kind any", "kind not", "kind phase", "kind dayIn", "kind index", "kind tag", "kind dates", "kind recur", "[] tags", "[] labels", "[] ledger", "[] gears", "[] stages", "[] path", "[] lengths", "[] by", "[] setpos", "[] bodies", "[] days", "[] rules", "[] formats", "[] of", "empty label", "-0", "near 2^53", "lone surrogate", "empty string", "hostile name", "hostile tags[]", "hostile label[]", "hostile tag", "phase unit", "phase body", "phase both", "phase neither", "crossing index", "rule depth 3+"];
    for (const k of want) expect([k, (seen.get(k) ?? 0) >= 20]).toEqual([k, true]);
  });
});

// ---------------------------------------------------------------------------
// Engine equivalence on valid mutants
// ---------------------------------------------------------------------------

type Mutation = (ast: CalendarAst, r: ReturnType<typeof stream>) => CalendarAst | null;

const MUTATIONS: Record<string, Mutation> = {
  // two whole-number slots of one slot unit trade lengths: the sum, so the parent, is unchanged
  "swap slot lengths": (ast, r) => {
    const units = ast.units.map((u) => {
      if (u.kind !== "slots") return u;
      const fixed = u.slots.flatMap((s, i) => (typeof s.length === "number" && !s.gears?.length ? [i] : []));
      if (fixed.length < 2) return u;
      const [i, j] = [r.pick(fixed), r.pick(fixed)];
      const slots = u.slots.map((s, k) => (k === i ? { ...s, length: u.slots[j]!.length } : k === j ? { ...s, length: u.slots[i]!.length } : s));
      return { ...u, slots };
    });
    return { ...ast, units };
  },
  "move a constant anchor": (ast, r) => ({ ...ast, units: ast.units.map((u) => (u.kind === "cycle" && u.crossing === undefined ? { ...u, anchor: u.anchor + r.int(-400, 400) } : u)) }),
  "shift an interval gear term": (ast, r) => ({ ...ast, gears: ast.gears.map((g) => (g.kind === "intervals" ? { ...g, terms: g.terms.map((t) => ({ ...t, offset: r.int(0, t.every - 1) })) } : g)) }),
  "add hostile day labels": (ast, r) => ({ ...ast, days: Array.from({ length: r.int(1, 3) }, () => ({ day: r.int(-5000, 5000), name: r.pick(HOSTILE.filter((s) => !/[\u0000-\u001f]/.test(s))), tags: [`t${r.int(0, 9)}`] })) }),
  "add a named rule": (ast, r) => {
    const cycle = ast.units.find((u) => u.kind === "cycle")!;
    return { ...ast, rules: [{ id: "fuzz-rule", tags: [`holiday:${r.int(0, 99)}`], rule: { kind: "recur", freq: cycle.id, by: [{ unit: "day", nth: [r.int(1, 5)] }] } }] };
  },
  "add a body": (ast, r) => ({ ...ast, bodies: [{ id: "fuzz-moon", period: { n: 765_433, d: 25_920 }, epoch: r.pick([{ n: 0, d: 1 }, { n: 1, d: 2 }, { n: 1, d: 3 }, { n: 3, d: 4 }, { n: 7, d: 10 }]) }] }),
};

describe("Seshat text: valid mutants answer the same after a round trip", () => {
  test("every mutation kind reaches validity at least 15 times, and every valid mutant agrees with its round trip on Engine.start over ±2,000 occurrences", () => {
    const accepted = new Map<string, number>();
    const failures: string[] = [];
    let seed = 1;
    for (const [name, base] of Object.entries(SESHAT_FIXTURES)) {
      for (const [kind, mutate] of Object.entries(MUTATIONS)) {
        for (let k = 0; k < 4; k++, seed++) {
          const mutant = mutate(base, stream(seed));
          if (!mutant || validate(mutant).length) continue;
          accepted.set(kind, (accepted.get(kind) ?? 0) + 1);
          const back = parse(print(mutant));
          const diff = same(back, mutant);
          if (diff) {
            failures.push(`${name} ${kind} seed ${seed}: ${diff}`);
            continue;
          }
          const [a, b] = [new Engine(mutant), new Engine(back)];
          for (const u of mutant.units) {
            if (u.kind !== "cycle") continue;
            for (let i = -2000; i <= 2000; i += 7) if (a.start(u.id, i) !== b.start(u.id, i)) failures.push(`${name} ${kind}: ${u.id}[${i}]`);
          }
          expect(b.tagsAt(0)).toEqual(a.tagsAt(0));
        }
      }
    }
    expect(failures).toEqual([]);
    for (const kind of Object.keys(MUTATIONS)) expect([kind, (accepted.get(kind) ?? 0) >= 15]).toEqual([kind, true]);
  });
});

// ---------------------------------------------------------------------------
// What the parser refuses
// ---------------------------------------------------------------------------

describe("Seshat text: errors", () => {
  const greg = print(GREGORIAN);
  const refuse = (text: string, msg: RegExp) => {
    let err: unknown;
    try {
      parse(text);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SeshatSyntaxError);
    expect((err as Error).message).toMatch(msg);
  };

  test("structure: no calendar, an unclosed or mismatched block, text after the end, a line that is not KEY:VALUE", () => {
    refuse("NAME:x\n", /starts with BEGIN:VCALENDAR/);
    refuse(greg.replace("END:VCALENDAR\n", ""), /never closed/);
    refuse(greg.replace("END:VGEAR", "END:VUNIT"), /END:VUNIT closes BEGIN:VGEAR/);
    refuse(`${greg}NAME:again\n`, /text after END:VCALENDAR/);
    refuse(greg.replace("NAME:Gregorian", "name: Gregorian"), /line 3: expected KEY:VALUE/);
  });

  test("properties: unknown, repeated, missing, or in the wrong component", () => {
    refuse(greg.replace("NAME:Gregorian", "NAME:Gregorian\nCOLOUR:red"), /VCALENDAR has no property COLOUR/);
    refuse(greg.replace("UID:leap", "UID:leap\nUID:leap2"), /VGEAR has UID twice/);
    refuse(greg.replace("SESHAT:1\n", ""), /VCALENDAR needs SESHAT/);
    refuse(greg.replace("SESHAT:1", "SESHAT:2"), /SESHAT:2 is not a version/);
    refuse(greg.replace("IN:year", "IN:year\nANCHOR:D0"), /VUNIT has no property ANCHOR/);
    refuse(greg.replace("RRULE:FREQ=year;INTERVAL=4", "RRULE:FREQ=year;INTERVAL=4;BYSETPOS=1"), /RRULE has no parameter BYSETPOS/);
    refuse(greg.replace("EXRULE:FREQ=year", "EXRULE:FREQ=month"), /one FREQ/);
  });

  test("values: a bad escape, a non-number, a rational not in lowest terms, an improper day fraction, a bad id", () => {
    refuse(greg.replace("SLOT:January=31", "SLOT:Jan\\uary=31"), /bad escape "\\u"/);
    refuse(greg.replace("SLOT:January=31", "SLOT:January=thirty"), /"thirty" is not a number/);
    const heb = print(HEBREW);
    refuse(heb.replace("765433/25920", "1530866/51840"), /not in lowest terms/);
    refuse(heb.replace("D-2092590+1007/2160", "D-2092590+2161/2160"), /fraction must be proper/);
    refuse(greg.replace("UID:leap", "UID:Leap"), /"Leap" is not an id/);
  });

  // review 2026-10-19 (Steadfast Hale): each of these was a repro
  test("review repros: the safe-integer edge round-trips exactly; nesting, non-finite numbers and raw specials are syntax errors", () => {
    for (const at of [{ n: -(2 ** 53 - 1), d: 3 }, { n: -9_007_199_254_740_989, d: 7 }, { n: 2 ** 53 - 1, d: 2 }]) {
      const ast: CalendarAst = { name: "edge", gears: [], units: [{ id: "y", kind: "cycle", crossing: { period: { n: 1, d: 1 }, at } }] };
      expect(same(parse(print(ast)), ast)).toBeNull();
    }
    refuse(print(HEBREW).replace("D-2092590+1007/2160", "D-3002399751580332+2/3"), /past the safe integers/);
    refuse("BEGIN:VCALENDAR\n" + "BEGIN:X\n".repeat(1000), /nest deeper than 200/);
    refuse(greg.replace("END:VCALENDAR", "BEGIN:VRULE\nUID:r\n" + "BEGIN:ALL\n".repeat(300) + "END:VCALENDAR"), /nest deeper than 200/);
    refuse(greg.replace("NAME:Gregorian", "NAME:Gregorian\nRDATE:D1e999"), /not a finite number/);
    refuse(greg.replace("NAME:Gregorian", "NAME:Gregorian\nRDATE:D1.5"), /not a whole day/);
    refuse(greg.replace("NAME:Gregorian", "NAME:a:b"), /":" must be escaped/);
    refuse(greg.replace("NAME:Gregorian", "NAME:"), /empty value is written/);
    refuse(greg.replace("SLOT:January=31", "BEGIN:VSLOT\nNAME:January\nTAGS:a,\nLENGTH:31\nEND:VSLOT"), /empty value is written/);
    refuse("", /line 1: a calendar starts with BEGIN:VCALENDAR/);
    expect(same(parse(`\ufeff${greg}`), GREGORIAN)).toBeNull();
  });

  test("the printer refuses what has no spelling: a Wadjet host leaf, a bad id, a non-finite number", () => {
    expect(() => print({ ...GREGORIAN, rules: [{ id: "r", rule: { kind: "host", key: "regime", arg: "wet" } }] })).toThrow(/no text form/);
    expect(() => print({ ...GREGORIAN, gears: [{ ...GREGORIAN.gears[0]!, id: "Leap" }] })).toThrow(/not an id/);
    expect(() => print({ ...GREGORIAN, days: [{ day: Number.NaN }] })).toThrow(/day NaN is not a whole day/);
    expect(() => print({ ...GREGORIAN, rules: [{ id: "r", rule: { kind: "phase", unit: "year", from: Number.NaN, to: 1 } }] })).toThrow(/cannot print NaN/);
  });

  test("the validator now holds every id to the text grammar and refuses control characters", () => {
    expect(validate({ ...GREGORIAN, gears: [{ ...GREGORIAN.gears[0]!, id: "Leap" }], units: GREGORIAN.units.map((u) => (u.kind === "cycle" && u.gears ? { ...u, gears: [{ gear: "Leap", add: 1 }] } : u)) })).toContain('id "Leap" must match [a-z][a-z0-9-]*');
    expect(validate({ ...GREGORIAN, days: [{ day: 0, name: "bell\u0007" }] }).join()).toContain("control character");
    expect(validate({ ...GREGORIAN, bodies: [{ id: "moon", period: { n: -1, d: 1 }, epoch: { n: 0, d: 1 } }] }).join()).toContain('body "moon"');
  });
});
