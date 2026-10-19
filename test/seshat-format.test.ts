/**
 * Seshat P2 step 5 (docs/SESHAT-v0.md §4.2): formatting and strict parsing.
 *
 *   - identity: parse(format(d)) = d for every calendar whose default
 *     pattern names a single day, densely around day 0 and today and strided
 *     over ±1,000,000 days (a gate, not a proof: the structural check in
 *     compileFormat is the proof obligation);
 *   - independent oracles where one exists: Date (Gregorian ISO), ICU
 *     (Hebrew, 1900–2040, outside its disputed years), the Dershowitz–Reingold
 *     formulas (Maya Long Count and Calendar Round);
 *   - strictness: non-canonical, out-of-range and inconsistent text is null;
 *   - structure: which patterns are parseable and which are format-only.
 */
import { describe, expect, test } from "bun:test";
import { BALINESE, checkFormats, DAY_LIMIT, Engine, FRENCH_REPUBLICAN, formatDay, GREGORIAN, HARPTOS, HEBREW, isParseable, MAYA, parseDay, type CalendarAst } from "../src/seshat";
import { SESHAT_FIXTURES } from "./fixtures/seshat/calendars";

const DAY_MS = 86_400_000;
const utc = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const TODAY = utc(2026, 10, 19);
const mod = (a: number, m: number) => ((a % m) + m) % m;
const amod = (a: number, m: number) => mod(a - 1, m) + 1;

describe("format then parse is the identity", () => {
  // the default is the pattern named "default", else the first (format.ts pick); Balinese's is format-only
  const covered = Object.entries(SESHAT_FIXTURES).filter(([, ast]) => {
    const def = (ast.formats ?? []).find((f) => f.name === "default") ?? ast.formats?.[0];
    return def !== undefined && isParseable(new Engine(ast), def.name);
  });
  test("every calendar but the format-only Balinese pawukon has a parseable default", () => {
    expect(Object.keys(SESHAT_FIXTURES).filter((f) => !covered.some(([c]) => c === f))).toEqual(["balinese.seshat"]);
  });
  for (const [file, ast] of covered) {
    const e = new Engine(ast);
    test(`${file}: every day near day 0 and today, and strided over ±1,000,000 days`, () => {
      const days = [...Array.from({ length: 4001 }, (_, i) => i - 2000), ...Array.from({ length: 4001 }, (_, i) => TODAY + i - 2000)];
      for (let d = -1_000_000; d <= 1_000_000; d += 997) days.push(d);
      const bad: string[] = [];
      for (const d of days) {
        const text = formatDay(e, d);
        const back = parseDay(e, text);
        if (back !== d && bad.length < 5) bad.push(`${d} "${text}" -> ${back}`);
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("formats against independent implementations", () => {
  test("Gregorian default is ISO 8601 (Date) for years 1000–9999", () => {
    const e = new Engine(GREGORIAN);
    const bad: string[] = [];
    for (let d = utc(1000, 1, 1); d <= utc(9999, 12, 31); d += 37) {
      const want = new Date(d * DAY_MS).toISOString().slice(0, 10);
      if (formatDay(e, d) !== want && bad.length < 5) bad.push(`${d}: ${formatDay(e, d)} vs ${want}`);
    }
    expect(bad).toEqual([]);
  });

  test("Gregorian long names the weekday Date names", () => {
    const e = new Engine(GREGORIAN);
    const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (let d = TODAY - 400; d <= TODAY + 400; d++) expect(formatDay(e, d, "long").split(" ")[0]).toBe(NAMES[new Date(d * DAY_MS).getUTCDay()]);
  });

  test("Hebrew default matches ICU (day, month, year) every day 1900–2040 (ICU's 'Adar II' is the AST's 'Adar')", () => {
    const e = new Engine(HEBREW);
    const f = new Intl.DateTimeFormat("en-u-ca-hebrew", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
    const bad: string[] = [];
    for (let d = utc(1900, 1, 1); d <= utc(2040, 12, 31); d++) {
      const p = f.formatToParts(new Date(d * DAY_MS));
      const get = (t: string) => p.find((x) => x.type === t)!.value;
      const want = `${get("day")} ${get("month") === "Adar II" ? "Adar" : get("month")} ${get("year")}`;
      if (formatDay(e, d) !== want && bad.length < 5) bad.push(`${d}: ${formatDay(e, d)} vs ${want}`);
    }
    expect(bad).toEqual([]);
  });

  test("Maya Long Count and Calendar Round match the Dershowitz–Reingold formulas over ±20,000 days", () => {
    const e = new Engine(MAYA);
    const NAMES = ["Imix", "Ik'", "Ak'b'al", "K'an", "Chikchan", "Kimi", "Manik'", "Lamat", "Muluk", "Ok", "Chuwen", "Eb'", "B'en", "Ix", "Men", "Kib'", "Kab'an", "Etz'nab'", "Kawak", "Ajaw"];
    const MONTHS = ["Pop", "Wo'", "Sip", "Sotz'", "Sek", "Xul", "Yaxk'in", "Mol", "Ch'en", "Yax", "Sak'", "Keh", "Mak", "K'ank'in", "Muwan", "Pax", "K'ayab", "Kumk'u", "Wayeb"];
    for (let d = -20_000; d <= 20_000; d += 3) {
      const n = d - -1_856_305;
      const haab = mod(n + 348, 365);
      const lc = [Math.floor(n / 144_000), Math.floor(mod(n, 144_000) / 7_200), Math.floor(mod(n, 7_200) / 360), Math.floor(mod(n, 360) / 20), mod(n, 20)].join(".");
      expect(formatDay(e, d)).toBe(lc);
      expect(formatDay(e, d, "round")).toBe(`${amod(n + 4, 13)} ${NAMES[amod(n + 20, 20) - 1]} ${mod(haab, 20)} ${MONTHS[Math.floor(haab / 20)]}`);
    }
  });
});

describe("filler days", () => {
  test("Harptos festivals use the filler pattern and parse back, Shieldmeet included", () => {
    const e = new Engine(HARPTOS);
    const seen = new Set<string>();
    for (let d = 0; d < 365 * 8 + 2; d++) {
      const text = formatDay(e, d);
      if (!/^\d/.test(text)) seen.add(text.split(" ").slice(0, -2).join(" "));
      expect(parseDay(e, text)).toBe(d);
    }
    expect([...seen].sort()).toEqual(["Feast of the Moon", "Greengrass", "Highharvestide", "Midsummer", "Midwinter", "Shieldmeet"]);
    expect(isParseable(e, "filler")).toBe(true);
    // the filler pattern is not a second spelling of an ordinary day, nor the default of a festival
    expect(parseDay(e, "Hammer 1 DR")).toBeNull();
    expect(parseDay(e, "1 Hammer 1 DR")).toBe(0);
    expect(parseDay(e, formatDay(e, 30, "default"))).toBeNull(); // "1 Midwinter 1 DR"
    expect(parseDay(e, "Midwinter 1 DR")).toBe(30);
  });
});

describe("strict parsing", () => {
  const e = new Engine(GREGORIAN);
  const today = formatDay(e, TODAY);

  test("only the canonical spelling of a real day parses", () => {
    expect(today).toBe("2026-10-19");
    expect(parseDay(e, today)).toBe(TODAY);
    for (const t of ["2026-10-9", "2026-1-19", "2026-10-19 ", " 2026-10-19", "2026-02-30", "2026-13-01", "2026-00-10", "2026-10-00", "02026-10-19", "+2026-10-19", "2026/10/19", "", "x"]) expect([t, parseDay(e, t)]).toEqual([t, null]);
    expect(parseDay(e, "99999999999999999999-01-01")).toBeNull();
  });

  test("a derived token must agree: the long form with the wrong weekday is not a day", () => {
    const right = formatDay(e, TODAY, "long");
    const weekday = right.split(" ")[0]!;
    const other = weekday === "Sunday" ? "Monday" : "Sunday";
    expect(parseDay(e, right, "long")).toBe(TODAY);
    expect(parseDay(e, right.replace(weekday, other), "long")).toBeNull();
    // with no name, every parseable pattern is tried
    expect(parseDay(e, right)).toBe(TODAY);
  });

  test("a format-only pattern formats but will not parse", () => {
    const maya = new Engine(MAYA);
    const bali = new Engine(BALINESE);
    expect(isParseable(maya, "round")).toBe(false);
    expect(() => parseDay(maya, formatDay(maya, 0, "round"), "round")).toThrow(/format-only/);
    expect(parseDay(maya, formatDay(maya, 0, "round"))).toBeNull();
    expect(isParseable(bali, "default")).toBe(false);
    expect(formatDay(bali, 0)).toBe(`${bali.labelAt("saptawara", 0)!.name} ${bali.labelAt("pancawara", 0)!.name} ${bali.labelAt("wuku", 0)!.name}`);
  });
});

// review 2026-10-19 (Mara Stonegaze): each of these was a repro
describe("review repros", () => {
  test("a year past the day line is null in every calendar, not a crash; the DAY_LIMIT edge round-trips", () => {
    for (const [, ast] of Object.entries(SESHAT_FIXTURES)) {
      const e = new Engine(ast);
      for (const f of ast.formats ?? []) {
        if (!isParseable(e, f.name)) continue;
        // default and filler are one automatic spelling: the canonical text of a day is formatDay without a name
        const automatic = f.name === "default" || f.name === "filler";
        for (const d of [DAY_LIMIT, -DAY_LIMIT]) expect(parseDay(e, automatic ? formatDay(e, d) : formatDay(e, d, f.name), f.name)).toBe(d);
        const huge = formatDay(e, 0, f.name).replace(/-?\d+/, "4503599627370496");
        expect(parseDay(e, huge, f.name)).toBeNull();
        expect(parseDay(e, formatDay(e, 0, f.name).replace(/-?\d+/, "9007199254740991"))).toBeNull();
      }
    }
  });

  test("a pattern whose chain passes a filler slot above its leaf is format-only (Sansculottides have no décade)", () => {
    const fr = (pattern: string, extra: CalendarAst["formats"] = []): Engine => new Engine({ ...FRENCH_REPUBLICAN, formats: [{ name: "default", pattern }, ...extra] });
    expect(isParseable(fr("{year}/{month}/{decade}/{decade:day}"), "default")).toBe(false);
    expect(isParseable(fr("{year}/{month}/{month:day}"), "default")).toBe(true);
    // the automatic default may pass one when a parseable filler pattern takes those days
    const both = fr("{year}/{month}/{decade}/{decade:day}", [{ name: "filler", pattern: "{year}/{month}/{month:day}" }]);
    expect(isParseable(both, "default")).toBe(true);
    for (let d = -3000; d <= 3000; d++) expect(parseDay(both, formatDay(both, d))).toBe(d);
  });

  test("two tokens with nothing between them are format-only; padding does not rescue them", () => {
    const g = (pattern: string) => isParseable(new Engine({ ...GREGORIAN, formats: [{ name: "default", pattern }] }), "default");
    expect(g("{year}{month:pad2}{month:day:pad2}")).toBe(false);
    expect(g("{month:name}{year}-{month:day}")).toBe(false);
    expect(g("{year}-{month:pad2}-{month:day:pad2}")).toBe(true);
  });

  test("naming the default or the filler pattern still means the one automatic spelling", () => {
    const h = new Engine(HARPTOS);
    expect(parseDay(h, "Hammer 1372 DR", "filler")).toBeNull();
    expect(parseDay(h, "1 Midwinter 1 DR", "default")).toBeNull();
    expect(parseDay(h, "Midwinter 1 DR", "default")).toBe(30);
    expect(parseDay(h, "Midwinter 1 DR", "filler")).toBe(30);
  });

  test("Harptos holds Shieldmeet in the years its gear names (DR divisible by 4), and the Long Count ends a b'ak'tun on 21 December 2012", () => {
    const h = new Engine(HARPTOS);
    const years: number[] = [];
    for (let d = 0; d < 365 * 12 + 3; d++) {
      const t = formatDay(h, d);
      if (t.startsWith("Shieldmeet ")) years.push(Number(t.split(" ")[1]));
    }
    expect(years).toEqual([4, 8, 12]);
    expect(formatDay(new Engine(MAYA), utc(2012, 12, 21))).toBe("13.0.0.0.0");
  });
});

describe("pattern structure", () => {
  const withFormats = (...patterns: string[]): CalendarAst => ({ ...GREGORIAN, formats: patterns.map((pattern, i) => ({ name: i ? `p${i}` : "default", pattern })) });
  const parseable = (pattern: string) => isParseable(new Engine(withFormats(pattern)), "default");

  test("parseable only when the coordinates reach a single day", () => {
    expect(parseable("{year}-{month}-{month:day}")).toBe(true);
    expect(parseable("{month:day} {month:name} {year}")).toBe(true); // month names are distinct: a coordinate
    expect(parseable("day {year:day} of {year}")).toBe(true);
    expect(parseable("{week} {week:day0}")).toBe(true); // a cycle and the day in it
    expect(parseable("{month:name} {month:day}")).toBe(false); // no year
    expect(parseable("{year} {month:day}")).toBe(false); // no month
    expect(parseable("{year}-{month}")).toBe(false); // no day in the month
    expect(parseable("{weekday:name} {year}")).toBe(false); // a weekday name is derived
    expect(parseable("{{literal}} {year}-{month}-{month:day}")).toBe(true);
    expect(formatDay(new Engine(withFormats("{{x}} {year:day:pad3}")), utc(2026, 1, 1))).toBe("{x} 001");
  });

  test("the validator refuses malformed patterns, duplicate names and non-integer numbers", () => {
    expect(checkFormats(withFormats("{moon}"))).toEqual(['format "default": no unit "moon"']);
    expect(checkFormats(withFormats("{year:colour}"))[0]).toContain('unknown field ":colour"');
    expect(checkFormats(withFormats("{year"))[0]).toContain("never closed");
    expect(checkFormats(withFormats("year}"))[0]).toContain('lone "}"');
    expect(checkFormats({ ...GREGORIAN, formats: [{ name: "a", pattern: "{year}" }, { name: "a", pattern: "{year}" }] })).toContain('format "a" is declared more than once');
    expect(checkFormats({ ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "year" ? { ...u, number: 0.5 } : u)) })[0]).toContain("not a whole number");
    expect(() => new Engine(withFormats("{moon}"))).toThrow(RangeError);
  });
});
