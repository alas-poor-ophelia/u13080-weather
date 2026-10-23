/**
 * Seshat P4 step 3 (docs/SESHAT-v0.md §16 D7, §16.7 P6, bead wadjet-01k.15):
 * season marks on dates. A mark is a fraction (as before), a day of the year
 * (`DAY:80`) or a day of a slot directly in the seasons unit
 * (`month:3.21`, stored as a 0-based index). One resolver serves the engine
 * and the adapter; fraction-only lists keep the old float comparison.
 */
import { describe, expect, test } from "bun:test";
import { definitionContent, DAY_LIMIT, Engine, FRENCH_REPUBLICAN as FRENCH, fractionBoundary, GREGORIAN, HEBREW, parse, print, seasonAtPhase, validate, type CalendarAst, type SeasonMarkAst } from "../src/seshat";
import { SeshatCalendar, yearAt } from "../src/plugin/time/seshat";
import { compile, FormError, recognise, type MonthForm } from "../src/plugin/time/form";
import { SeasonCalendar } from "../src/seshat/seasons";
import { flipSeasonTags } from "../src/plugin/time/seasons";
import { calendarOfDefinition, mergeCalendar, planCalendarSave } from "../src/studio/model/definition";

const slot = (name: string, index: number, day: number, unit = "month"): SeasonMarkAst => ({ name, slot: { unit, index, day } });
const greg = (marks: readonly SeasonMarkAst[], extra: Partial<CalendarAst> = {}): CalendarAst => ({ ...GREGORIAN, seasons: { unit: "year", marks }, ...extra });
/** the day of month `m` (1-based), day `d` (1-based) of astronomical year `y` */
const ymd = (e: Engine, y: number, m: number, d: number) => e.dayOf("month", [y], m - 1, d - 1);

describe("text: date marks print and parse", () => {
  test("DAY:N and <unit>:<slot>.<day>, the slot printed as index + the unit's NUMBER; fractions unchanged", () => {
    const ast = greg([{ name: "Thaw", from: 0.25 }, { name: "Spring", day: 80 }, slot("Summer", 5, 21)]);
    const text = print(ast);
    expect(text).toContain("MARK:Thaw=0.25\nMARK:Spring=DAY:80\nMARK:Summer=month:6.21\n");
    expect(parse(text)).toEqual(ast);
    // a NUMBER edit cannot move a mark: the stored index stays, the printed number follows
    const numbered = { ...ast, units: ast.units.map((u) => (u.id === "month" ? { ...u, number: 0 } : u)) };
    expect(print(numbered)).toContain("MARK:Summer=month:5.21");
    expect(parse(print(numbered))).toEqual(numbered);
    expect(() => parse(text.replace("DAY:80", "DAX:80"))).toThrow(/not a season mark/);
  });
});

describe("validation names the season", () => {
  const problems = (marks: readonly SeasonMarkAst[], base: CalendarAst = GREGORIAN) => validate({ ...base, seasons: { unit: "year", marks } });
  test("good date marks pass", () => expect(problems([{ name: "A", day: 1 }, slot("B", 11, 31)])).toEqual([]));
  test("DAY:N needs N >= 1", () => expect(problems([{ name: "A", day: 0 }])).toEqual(['seasons: mark "A" must be on a whole day of the year from 1']));
  test("the day in a slot needs >= 1", () => expect(problems([slot("A", 2, 0)])).toEqual(['seasons: mark "A": the day in the slot must be a whole number from 1']));
  test("the slot is a declared one", () => expect(problems([slot("A", 12, 1)])).toEqual(['seasons: mark "A": "month" has no slot 13']));
  test("the unit is a slot unit directly in the seasons unit", () => {
    expect(problems([slot("A", 0, 1, "year")])).toEqual(['seasons: mark "A": "year" is not a slot unit directly in the seasons unit "year"']);
    expect(problems([slot("A", 0, 1, "nope")])).toEqual(['seasons: mark "A": no unit "nope"']);
    expect(problems([slot("A", 0, 1, "decade")], FRENCH)).toEqual(['seasons: mark "A": "decade" is not a slot unit directly in the seasons unit "year"']);
  });
  test("a filler slot is not an anchor", () => expect(problems([slot("A", 12, 1)], FRENCH)).toEqual(['seasons: mark "A": slot 13 of "month" is a filler slot; a season cannot start in one']));
});

describe("the resolver", () => {
  test("fraction-only lists: byte-identical to the old expression over a wide span, engine and adapter", () => {
    const marks = [{ name: "W", from: 0.9 }, { name: "Sp", from: 0.2 }, { name: "Su", from: 0.45 }, { name: "Au", from: 0.30000000000000004 }];
    const ast = greg(marks);
    const e = new Engine(ast);
    const cal = new SeshatCalendar(print(ast), () => 0);
    const days = [...Array.from({ length: 3000 }, (_, i) => i * 7 - 10_000), ...Array.from({ length: 300 }, (_, i) => -DAY_LIMIT * 3 + i * 300_007), DAY_LIMIT, DAY_LIMIT + 1, -DAY_LIMIT - 1];
    for (const d of days) {
      const y = yearAt(e, d);
      const old = seasonAtPhase(marks, (d - y.start) / y.length);
      expect([d, cal.toContext(d).tags?.find((t) => t.startsWith("season:"))]).toEqual([d, `season:${old}`]);
      if (Math.abs(d) <= DAY_LIMIT) expect([d, e.seasonAt(d)]).toEqual([d, old]);
    }
  });

  test("a slot day past the slot's end clamps (Feb 29 in a common year is Feb 28); before the first mark is the previous year's last", () => {
    const e = new Engine(greg([slot("Leap", 1, 29), slot("Summer", 5, 1)]));
    expect(e.seasonAt(ymd(e, 2023, 2, 28))).toBe("Leap");
    expect(e.seasonAt(ymd(e, 2023, 2, 27))).toBe("Summer");
    expect(e.seasonAt(ymd(e, 2024, 2, 28))).toBe("Summer");
    expect(e.seasonAt(ymd(e, 2024, 2, 29))).toBe("Leap");
    expect(e.seasonAt(ymd(e, 2024, 1, 1))).toBe("Summer");
  });

  test("DAY:366 is skipped in a common year, and the wrap reads the year that skipped it", () => {
    const e = new Engine(greg([slot("Spring", 2, 1), { name: "Last", day: 366 }]));
    expect(e.seasonAt(ymd(e, 2024, 12, 31))).toBe("Last");
    expect(e.seasonAt(ymd(e, 2025, 1, 1))).toBe("Last"); // 2024 had day 366
    expect(e.seasonAt(ymd(e, 2025, 12, 31))).toBe("Spring");
    expect(e.seasonAt(ymd(e, 2026, 1, 1))).toBe("Spring"); // 2025 skipped it: its last resolved mark is Spring
  });

  test("mixed kinds sort by resolved day, ties in declaration order; a fraction mark agrees with the float test", () => {
    const e = new Engine(greg([{ name: "Half", from: 0.5 }, { name: "Start", day: 1 }, { name: "Tie", day: 80 }, slot("Equinox", 2, 21)]));
    for (const y of [2023, 2024]) {
      const start = e.start("year", y);
      const len = e.length("year", y);
      for (let t = 0; t < len; t++) {
        const want = t / len >= 0.5 ? "Half" : t >= ymd(e, y, 3, 21) - start ? "Equinox" : t >= 79 ? "Tie" : "Start";
        expect([y, t, e.seasonAt(start + t)]).toEqual([y, t, want]);
      }
    }
    // in 2024 day 80 is March 20; in 2023 it is March 21, the same day as Equinox: declared later, Equinox wins the tie
    expect(e.seasonAt(ymd(e, 2023, 3, 21))).toBe("Equinox");
    expect(fractionBoundary(0.5, 365)).toBe(183);
    expect(fractionBoundary(0.999, 365)).toBeNull();
  });

  test("Hebrew: a mark in Adar I (index 5, absent in common years) is skipped and the season before it runs on", () => {
    const ast: CalendarAst = { ...HEBREW, seasons: { unit: "year", marks: [slot("Tishri", 0, 1), slot("AdarI", 5, 1), slot("Purim", 6, 14)] } };
    expect(validate(ast)).toEqual([]);
    expect(print(ast)).toContain("MARK:AdarI=month:6.1\nMARK:Purim=month:7.14");
    const e = new Engine(ast);
    const y0 = e.occurrenceAt("year", 0)!.index;
    const years = Array.from({ length: 19 }, (_, i) => y0 + i);
    const leap = years.find((y) => e.slotLengths("month", [y])[5]! > 0)!;
    const common = years.find((y) => e.slotLengths("month", [y])[5] === 0)!;
    expect(e.seasonAt(e.dayOf("month", [leap], 5, 0))).toBe("AdarI");
    expect(e.seasonAt(e.dayOf("month", [leap], 6, 12))).toBe("AdarI");
    expect(e.seasonAt(e.dayOf("month", [leap], 6, 13))).toBe("Purim");
    expect(e.seasonAt(e.dayOf("month", [common], 6, 12))).toBe("Tishri");
    expect(e.seasonAt(e.dayOf("month", [common], 6, 13))).toBe("Purim");
    expect(e.seasonAt(e.start("year", common))).toBe("Tishri");
  });

  test("the adapter's tag is the engine's season; past ±DAY_LIMIT it reads the folded tag day", () => {
    const ast = greg([slot("Spring", 2, 21), slot("Autumn", 8, 23)]);
    const e = new Engine(ast);
    const cal = new SeshatCalendar(print(ast), () => 0);
    for (const d of [0, 100, -5000, DAY_LIMIT, -DAY_LIMIT, DAY_LIMIT + 500, -DAY_LIMIT - 12_345]) {
      expect([d, cal.toContext(d).tags?.find((t) => t.startsWith("season:"))]).toEqual([d, `season:${e.seasonAt(yearAt(e, d).tagDay)}`]);
    }
  });
});

describe("rules read season:<name> (§16.7 P6)", () => {
  test("a rule's TAG:season:Spring holds on the days of that season; tagsAt's output and order are unchanged", () => {
    const rules = [{ id: "r", rule: { kind: "tag" as const, tag: "season:Spring" }, tags: ["planting"] }];
    const ast = greg([slot("Spring", 2, 21), slot("Autumn", 8, 23)], { rules });
    expect(validate(ast)).toEqual([]);
    const e = new Engine(ast);
    const plain = new Engine(greg([slot("Spring", 2, 21), slot("Autumn", 8, 23)]));
    for (let d = -400; d <= 400; d += 3) {
      const tags = e.tagsAt(d);
      expect(tags.slice(0, plain.tagsAt(d).length)).toEqual(plain.tagsAt(d));
      expect([d, tags.includes("planting")]).toEqual([d, e.seasonAt(d) === "Spring"]);
      expect(tags.some((t) => t.startsWith("season:"))).toBe(false);
    }
  });
});

describe("describe() and the southern flip", () => {
  test("date marks project into the year holding day 0, sorted", () => {
    const ast = greg([slot("Autumn", 8, 23), { name: "Spring", day: 80 }, { name: "Mid", from: 0.5 }]);
    const e = new Engine(ast);
    const y = e.occurrenceAt("year", 0)!;
    const got = new SeshatCalendar(print(ast), () => 0).describe().seasons;
    expect(got).toEqual([
      { name: "Spring", from: 79 / y.length },
      { name: "Mid", from: 0.5 },
      { name: "Autumn", from: (e.dayOf("month", [y.index], 8, 22) - y.start) / y.length },
    ]);
  });

  test("the flip reads fractions; a date mark's projection is within ±1 day of where it resolves, in years of either length", () => {
    const ast = greg([slot("Spring", 2, 21), slot("Summer", 5, 21), slot("Autumn", 8, 23), slot("Winter", 11, 21)]);
    const e = new Engine(ast);
    const proj = e.seasonProjection();
    for (let y = 1990; y <= 2030; y++) {
      const start = e.start("year", y);
      const len = e.length("year", y);
      for (const [i, m] of [2, 5, 8, 11].entries()) {
        const exact = e.dayOf("month", [y], m, [20, 20, 22, 20][i]!) - start;
        expect(Math.abs(fractionBoundary(proj.find((p) => p.name === ["Spring", "Summer", "Autumn", "Winter"][i])!.from, len)! - exact)).toBeLessThanOrEqual(1);
      }
    }
    // and the flip itself still runs on those fractions
    const ctx = { dayOrdinal: 0, yearPhase: 0.6, yearLength: 365, tags: ["season:Autumn"] };
    expect(flipSeasonTags(ctx, proj).tags).toEqual([`season:${seasonAtPhase(proj, 0.1)}`]);
  });
});

describe("form and Studio keep date marks", () => {
  const ast = greg([{ name: "Spring", day: 80 }, slot("Autumn", 8, 23)], { bodies: [{ id: "luna", period: { n: 59, d: 2 }, epoch: { n: 0, d: 1 }, moon: { name: "Luna" } }] });
  const TEXT = print(ast);
  const seasonsBlock = (t: string) => t.slice(t.indexOf("BEGIN:VSEASONS"), t.indexOf("END:VSEASONS"));

  test("the form reads such seasons as text", () => {
    expect(recognise(parse(TEXT)).seasons).toEqual({ kind: "text", why: "the seasons use dates" });
  });

  test("a moon edit through Studio Save keeps the date marks byte for byte", () => {
    const base = calendarOfDefinition(parse(TEXT));
    expect(base.seasons.every((s) => Number.isFinite(s.from))).toBe(true);
    const draft = structuredClone(base);
    draft.moons[0]!.name = "Selene";
    const r = mergeCalendar(TEXT, base, draft);
    if (r.kind !== "write") throw new Error(JSON.stringify(r));
    expect(seasonsBlock(r.text)).toBe(seasonsBlock(TEXT));
    expect(parse(r.text).bodies![0]!.moon!.name).toBe("Selene");
    expect(mergeCalendar(TEXT, base, structuredClone(base))).toEqual({ kind: "unchanged" });
  });

  test("a seasons edit on date marks is refused, never turned into fractions", () => {
    const base = calendarOfDefinition(parse(TEXT));
    const draft = structuredClone(base);
    draft.seasons[0]!.from = 0.1;
    expect(mergeCalendar(TEXT, base, draft)).toEqual({ kind: "error", message: "the seasons use dates; edit them as text" });
  });
});

describe("review fixes (Steadfast Hale)", () => {
  /** the season of day `t` of 365-day year 2023, fraction-only (float path) and with a never-reached date mark added (calendar path) */
  const both = (marks: readonly SeasonMarkAst[], t: number) => {
    const out: Array<string | null> = [];
    for (const ms of [marks, [...marks, { name: "C", day: 1000 }]]) {
      const e = new Engine(greg(ms));
      expect(e.length("year", 2023)).toBe(365);
      out.push(e.seasonAt(e.start("year", 2023) + t));
    }
    return out;
  };

  test("a fraction no day reaches stays the wrap season in a mixed list", () => {
    for (const t of [0, 10]) expect(both([{ name: "A", from: 0.5 }, { name: "B", from: 0.999 }], t)).toEqual(["B", "B"]);
    expect(both([{ name: "A", from: 0.5 }, { name: "B", from: 0.999 }], 364)).toEqual(["A", "A"]);
  });

  test("two fractions on one day order by from (the larger wins), not by declaration", () => {
    expect(both([{ name: "Big", from: 0.0751 }, { name: "Small", from: 0.075 }], 28)).toEqual(["Big", "Big"]);
    expect(both([{ name: "Big", from: 0.0751 }, { name: "Small", from: 0.075 }], 27)).toEqual(["Big", "Big"]);
  });

  test("a mark in (364/365, 1) agrees with the old expression near the year's start, fraction-only and mixed", () => {
    const marks = [{ name: "S", from: 0.3 }, { name: "W", from: 0.9986 }];
    const es = [new Engine(greg(marks)), new Engine(greg([...marks, { name: "C", day: 1000 }]))];
    for (const y of [2022, 2023, 2024, 2025]) {
      const start = es[0]!.start("year", y);
      const len = es[0]!.length("year", y);
      for (const t of [0, 1, 2, 5, 30, 108, 109, 110, len - 2, len - 1]) {
        const old = seasonAtPhase(marks, t / len);
        for (const e of es) expect([y, t, e.seasonAt(start + t)]).toEqual([y, t, old]);
      }
    }
  });

  test("the walk back finding nothing falls back to this year's last resolved mark", () => {
    const years = { length: (i: number) => (i === 5 ? 400 : 365), slotLengths: () => [] };
    expect(new SeasonCalendar([{ name: "Q", day: 395 }, { name: "P", day: 390 }], years).at(5, 0)).toBe("Q");
    expect(new SeasonCalendar([{ name: "Q", day: 395 }, { name: "P", day: 390 }], years).at(4, 0)).toBe("P"); // nothing resolves at all: the declaration-last
  });

  test("an error reading the current year surfaces; an earlier year's stops the walk back", () => {
    const boom = (bad: (i: number) => boolean) => ({ length: (i: number) => { if (bad(i)) throw new Error("bug"); return 365; }, slotLengths: () => [] });
    expect(() => new SeasonCalendar([{ name: "A", day: 100 }], boom((i) => i === 0)).at(0, 0)).toThrow("bug");
    expect(new SeasonCalendar([{ name: "A", day: 100 }, { name: "B", day: 200 }], boom((i) => i < 0)).at(0, 0)).toBe("B");
  });

  describe("a months edit keeps slot marks on their month", () => {
    const ast = greg([slot("Spring", 2, 21), { name: "Late", day: 300 }]);
    const months = () => (recognise(ast).months as { kind: "form"; value: MonthForm[] }).value.map((m) => ({ ...m }));
    const marks = (a: CalendarAst) => a.seasons!.marks;
    test("a month inserted before March: the mark follows March", () => {
      const v = months();
      v.splice(1, 0, { name: "Interlude", length: 1 });
      expect(marks(compile(ast, { months: v }))).toEqual([slot("Spring", 3, 21), { name: "Late", day: 300 }]);
    });
    test("March renamed in place: the index stays", () => {
      const v = months();
      v[2] = { ...v[2]!, name: "Mars" };
      expect(marks(compile(ast, { months: v }))).toEqual(marks(ast));
      v.reverse(); // reordered, and March is gone by name: refused
      expect(() => compile(ast, { months: v })).toThrow(FormError);
    });
    test("March removed, or the months removed: refused, naming the season and the month", () => {
      const v = months().filter((m) => m.name !== "March");
      expect(() => compile(ast, { months: v })).toThrow("The season Spring starts in March; March cannot be removed while a season starts in it");
      expect(() => compile(ast, { months: null })).toThrow("The season Spring starts in March; March cannot be removed");
    });
    test("the Studio path: mergeCalendar moves the mark too", () => {
      const text = print(ast);
      const base = calendarOfDefinition(parse(text));
      const draft = structuredClone(base);
      const v = months();
      v.splice(0, 0, { name: "Interlude", length: 1 });
      (draft.form as { months?: unknown }).months = v;
      const r = mergeCalendar(text, base, draft);
      expect(r.kind === "write" && parse(r.text).seasons!.marks[0]).toEqual(slot("Spring", 3, 21));
    });
  });

  test("a rule reading a season: tag no label sets changes the hash; other definitions hash as before", () => {
    const seasons = [slot("Spring", 2, 21), slot("Autumn", 8, 23)];
    const rule = (tag: string) => ({ rules: [{ id: "r", rule: { kind: "tag" as const, tag }, tags: ["planting"] }] });
    expect("seasonTags" in (definitionContent(greg(seasons)) as object)).toBe(false);
    expect("seasonTags" in (definitionContent(greg(seasons, rule("holiday"))) as object)).toBe(false);
    expect((definitionContent(greg(seasons, rule("season:Spring"))) as { seasonTags?: boolean }).seasonTags).toBe(true);
    expect("seasonTags" in (definitionContent(greg(seasons, { ...rule("season:Spring"), days: [{ day: 5, tags: ["season:Spring"] }] })) as object)).toBe(false);
    // the same rule over a tag nobody reads as a season hashed like this before the flag; the flag is the only new field
    const flagged = definitionContent(greg(seasons, rule("season:Spring"))) as Record<string, unknown>;
    expect(Object.keys(flagged).filter((k) => !(k in (definitionContent(greg(seasons, rule("holiday"))) as object)))).toEqual(["seasonTags"]);
  });

  test("a seasons edit on a date world is refused plainly by Studio Save", () => {
    const text = print(greg([{ name: "Spring", day: 80 }, slot("Autumn", 8, 23)]));
    const base = calendarOfDefinition(parse(text));
    const draft = structuredClone(base);
    draft.seasons[0]!.from = 0.1;
    expect(planCalendarSave({ source: "seshat", calendar: base }, text, { calendar: draft, base, source: "seshat" })).toEqual({ kind: "refuse", message: "the seasons use dates; edit them as text (Edit definition)." });
  });

  test("southern zones: a calendar rule reads the unflipped season; the zone sees the flipped tag", () => {
    const rules = [{ id: "r", rule: { kind: "tag" as const, tag: "season:Spring" }, tags: ["planting"] }];
    const ast = greg([slot("Spring", 2, 21), slot("Autumn", 8, 23)], { rules });
    const e = new Engine(ast);
    const cal = new SeshatCalendar(print(ast), () => 0);
    const proj = e.seasonProjection();
    const d = ymd(e, 2024, 4, 15);
    const ctx = cal.toContext(d);
    expect(ctx.tags).toContain("planting");
    expect(ctx.tags).toContain("season:Spring");
    const south = flipSeasonTags(ctx, proj);
    expect(south.tags).toContain("season:Autumn");
    expect(south.tags).toContain("planting"); // the rule's tag is the calendar's, northern
  });
});
