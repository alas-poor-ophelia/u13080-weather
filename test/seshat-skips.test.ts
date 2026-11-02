/**
 * Cycles and seasons that skip filler days (docs/SESHAT-v0.md §19.3, §19.4). The oracle for the counted line is a
 * walk of the days themselves; the World Calendar is the reference hard case: every quarter starts on a Sunday, and
 * Worldsday and Leapyear Day are in no week.
 */
import { describe, expect, test } from "bun:test";
import { ApiController } from "../src/plugin/api";
import { Calendars } from "../src/plugin/calendars";
import { migrateSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { flipSeasonTags } from "../src/plugin/time/seasons";
import { World } from "../src/plugin/world";
import { zoneFromPreset } from "../src/plugin/zones";
import { PRESETS } from "../src/generated/presets";
import { SeshatCalendar, worldProblems } from "../src/plugin/time/seshat";
import { DAY_LIMIT, definitionContent, Engine, formatDay, GREGORIAN, HEBREW, parse, ROMAN, print, translate, validate, rational, type CalendarAst, type CycleUnitAst, type RuleAst, type SlotAst } from "../src/seshat";
import { addSeasonMark, removeSeasonMark, setSeasonMark } from "../src/studio/model/ast-edit";
import { seshatDraft, type CalendarEdit } from "../src/studio/model/definition";
import { labelOn, setCycleSkip } from "../src/studio/model/orrery-cycle";
import { setYearToday, yearTodayText } from "../src/studio/model/orrery-slots";
import { addMark, renameMark, seasonsSkipTarget, seasonsWindowLock, setMarkFrom, setSeasonsSkip } from "../src/studio/model/orrery-seasons";
import { anchorProblem, removeUnit, renameUnit, skipTarget } from "../src/studio/model/unit-edit";
import { buildOrrery, type OrreryModel } from "../src/studio/model/orrery-geometry";

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const m = (name: string, length: number): SlotAst => ({ name, length });
const f = (name: string, length = 1): SlotAst => ({ name, length, filler: true });

/** Day 0 is 1 January of year 1. Worldsday ends the year; Leapyear Day follows June in every fourth year. */
const WORLD: CalendarAst = {
  name: "World Calendar",
  formats: [
    { name: "default", pattern: "{weekday:name} {month:day} {month:name} {year}" },
    { name: "filler", pattern: "{month:name} {year}" },
  ],
  gears: [{ id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, offset: -1, sign: 1 }] }],
  seasons: { unit: "year", skips: "month", marks: [{ name: "Spring", from: 0 }, { name: "Autumn", from: 0.5 }] },
  units: [
    { id: "year", kind: "cycle", number: 1, anchor: 0, length: 365, gears: [{ gear: "leap", add: 1 }] },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [m("January", 31), m("February", 30), m("March", 30), m("April", 31), m("May", 30), m("June", 30), { name: "Leapyear Day", length: 0, gears: [{ gear: "leap", add: 1 }], filler: true }, m("July", 31), m("August", 30), m("September", 30), m("October", 31), m("November", 30), m("December", 30), f("Worldsday")],
    },
    { id: "week", kind: "cycle", anchor: 0, length: 7, skips: "month" },
    { id: "weekday", kind: "cycle", anchor: 0, length: 1, skips: "month", labels: NAMES.map((name) => ({ name })) },
  ],
};

const clone = (a: CalendarAst): CalendarAst => structuredClone(a);
const unit = (a: CalendarAst, id: string) => a.units.find((u) => u.id === id) as CycleUnitAst;
const withUnit = (a: CalendarAst, id: string, patch: object): CalendarAst => ({ ...a, units: a.units.map((u) => (u.id === id ? ({ ...u, ...patch }) : u)) });

describe("the World Calendar", () => {
  const e = new Engine(WORLD);
  const dayOf = (year: number, month: string, day: number): number => {
    const u = WORLD.units[1]!;
    const slot = u.kind === "slots" ? u.slots.findIndex((s) => s.name === month) : -1;
    return e.dayOf("month", [year], slot, day - 1);
  };

  test("is valid, and its text round-trips with SKIPS on the units and the seasons", () => {
    expect(validate(WORLD)).toEqual([]);
    const text = print(WORLD);
    expect(text).toContain("SKIPS:month");
    expect(parse(text)).toEqual(WORLD);
    expect(print(parse(text))).toBe(text);
  });

  test("every quarter starts on a Sunday and 31 December is a Saturday, in every year on both sides of day 0", () => {
    for (let y = -400; y <= 400; y++) {
      for (const q of ["January", "April", "July", "October"]) expect(e.labelAt("weekday", dayOf(y, q, 1))?.name).toBe("Sunday");
      expect(e.labelAt("weekday", dayOf(y, "December", 30))?.name).toBe("Saturday");
    }
  });

  test("Worldsday and Leapyear Day are in no week, and the week resumes where it stopped", () => {
    const worldsday = dayOf(5, "December", 30) + 1;
    expect(e.labelAt("month", worldsday)?.name).toBe("Worldsday");
    for (const id of ["week", "weekday"]) {
      expect(e.occurrenceAt(id, worldsday)).toBeNull();
      expect(e.positionOf(id, worldsday)).toBeNull();
      expect(e.labelAt(id, worldsday)).toBeNull();
    }
    const leap = dayOf(3, "June", 30) + 1;
    expect(e.labelAt("month", leap)?.name).toBe("Leapyear Day");
    expect(e.labelAt("weekday", leap)).toBeNull();
    expect(e.labelAt("weekday", leap - 1)?.name).toBe("Saturday");
    expect(e.labelAt("weekday", leap + 1)?.name).toBe("Sunday");
  });

  test("a filler day still falls in one occurrence's span: start(indexAt(d)) ≤ d, also at a week boundary", () => {
    const worldsday = dayOf(5, "December", 30) + 1;
    const k = e.indexAt("week", worldsday);
    expect(e.start("week", k)).toBeLessThanOrEqual(worldsday);
    expect(e.start("week", k + 1)).toBe(worldsday + 1);
    expect(e.length("week", k)).toBe(8); // the span on the line; start + length is the next start
  });

  test("dates: formats read the counted day and the default still parses", () => {
    const d = dayOf(5, "April", 8);
    expect(formatDay(e, d)).toBe("Sunday 8 April 6");
    expect(formatDay(e, dayOf(5, "December", 30) + 1)).toBe("Worldsday 6");
    const counted = new Engine({ ...WORLD, formats: [{ name: "default", pattern: "{week:day}" }] });
    const start = counted.start("week", counted.indexAt("week", dayOf(5, "December", 30)));
    expect(Array.from({ length: 7 }, (_, i) => formatDay(counted, start + i))).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    // across a skipped day the count does not jump
    const lastBefore = dayOf(3, "June", 30);
    const across = counted.start("week", counted.indexAt("week", lastBefore));
    expect(formatDay(counted, lastBefore)).toBe("7");
    expect(across).toBe(lastBefore - 6);
    const crossing = new Engine(withUnit(WORLD, "week", { anchor: 3 }));
    const held = crossing.occurrenceAt("week", dayOf(5, "December", 30))!;
    const fmt = new Engine({ ...withUnit(WORLD, "week", { anchor: 3 }), formats: [{ name: "default", pattern: "{week:day}" }] });
    const worldsday = dayOf(5, "December", 30) + 1;
    expect(held.start).toBeLessThan(worldsday);
    expect(held.start + held.length).toBeGreaterThan(worldsday + 1); // this week spans Worldsday
    const text = Array.from({ length: 8 }, (_, i) => formatDay(fmt, held.start + i));
    expect(text.filter((t) => t !== "")).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(e.indexAt("year", dayOf(5, "April", 8))).toBe(5);
  });
});

describe("the counted line against a walk of the days", () => {
  // filler slots that are constant, geared and overridden; a week anchored off year 0's start; year 0 not at day 0
  const cal: CalendarAst = {
    name: "Walked",
    gears: [
      { id: "leap", on: "year", kind: "intervals", terms: [{ every: 4, sign: 1 }, { every: 100, sign: -1 }, { every: 400, sign: 1 }] },
      { id: "odd", on: "year", kind: "positions", period: 7, positions: [2, 5] },
    ],
    units: [
      { id: "year", kind: "cycle", anchor: 137, length: 60, gears: [{ gear: "leap", add: 1 }, { gear: "odd", add: 2 }], ledger: [{ kind: "slots", from: 2, unit: "part", lengths: [20, 5, 20, 0, 0, 17] }, { kind: "slots", from: -3, unit: "part", lengths: [18, 4, 20, 0, 0, 18] }] },
      { id: "part", kind: "slots", in: "year", slots: [m("A", 20), f("Rest", 3), m("B", 20), { name: "Leap", length: 0, gears: [{ gear: "leap", add: 1 }], filler: true }, { name: "Odd", length: 0, gears: [{ gear: "odd", add: 2 }], filler: true }, m("C", 17)] },
      { id: "week", kind: "cycle", anchor: 145, length: 7, skips: "part" },
      { id: "beat", kind: "cycle", anchor: 145, length: 3, skips: "part", gears: [{ gear: "bump", add: 1 }] },
    ],
  };
  const full: CalendarAst = { ...cal, gears: [...cal.gears, { id: "bump", on: "beat", kind: "intervals", terms: [{ every: 5, sign: 1 }] }] };

  test("is valid", () => expect(validate(full)).toEqual([]));

  const e = new Engine(full);
  const FROM = -6000;
  const TO = 6000;
  const filler = (d: number) => e.inFiller("part", d);

  test("every occurrence holds exactly its counted days, in order, and filler days are in none", () => {
    for (const [id, days] of [["week", (_k: number) => 7], ["beat", (k: number) => 3 + (((k % 5) + 5) % 5 === 0 ? 1 : 0)]] as const) {
      let k = e.indexAt(id, FROM);
      let inK = 0;
      for (let d = e.start(id, k); d < TO; d++) {
        if (filler(d)) {
          expect(e.occurrenceAt(id, d)).toBeNull();
          expect(e.indexAt(id, d)).toBe(k);
          continue;
        }
        if (inK === days(k)) {
          k++;
          inK = 0;
          expect(e.start(id, k)).toBe(d);
        }
        const o = e.occurrenceAt(id, d)!;
        expect(o.index).toBe(k);
        expect(o.start).toBeLessThanOrEqual(d);
        expect(e.positionOf(id, d)).toEqual({ index: k, offset: inK });
        expect(e.countedLength(id, o)).toBe(days(k));
        inK++;
      }
    }
  });

  test("the unit anchor is where occurrence 0 starts", () => {
    expect(e.start("week", 0)).toBe(145);
    expect(e.start("beat", 0)).toBe(145);
  });

  test("translate: the moved calendar reads on d + n what this one reads on d", () => {
    const n = 12_345;
    const moved = new Engine(translate(full, n));
    for (let d = -800; d < 800; d++) {
      expect(moved.occurrenceAt("week", d + n)?.index).toBe(e.occurrenceAt("week", d)?.index);
      expect(moved.positionOf("beat", d + n)).toEqual(e.positionOf("beat", d));
    }
  });

  test("declaration order does not matter", () => {
    const flipped = new Engine({ ...full, units: [...full.units].reverse() });
    for (let d = -300; d < 300; d += 7) expect(flipped.occurrenceAt("week", d)).toEqual(e.occurrenceAt("week", d));
  });

  test("the ends of the day line answer", () => {
    for (const d of [DAY_LIMIT, -DAY_LIMIT, DAY_LIMIT - 1, -DAY_LIMIT + 1]) {
      if (filler(d)) continue;
      const o = e.occurrenceAt("week", d)!;
      expect(o.start).toBeLessThanOrEqual(d);
      expect(o.start + o.length).toBeGreaterThan(d);
    }
  });
});

describe("changing lengths and reset points", () => {
  const CAL = clone(WORLD);
  const e0 = new Engine(CAL);
  const dec30y5 = e0.dayOf("month", [5], 12, 29);

  test("a reset point: a pin starts a week on the named day, and the weekdays after it count from there", () => {
    const a = withUnit(WORLD, "week", { ledger: [{ kind: "starts", from: 100, startsOn: e0.start("week", 100) + 3 }] });
    expect(validate(a)).toEqual([]);
    const e = new Engine(a);
    expect(e.start("week", 100)).toBe(e0.start("week", 100) + 3);
    expect(e.length("week", 99)).toBe(e0.length("week", 99) + 3);
    expect(e.start("week", 99)).toBe(e0.start("week", 99));
    expect(parse(print(a))).toEqual(a);
  });

  test("a length change: from a week on, a rule of its own", () => {
    const at = e0.start("week", 200);
    const a = withUnit(WORLD, "week", { ledger: [{ kind: "switch", from: 200, rule: { anchor: at, length: 5 } }] });
    const problems = validate(a);
    expect(problems).toEqual([]);
    const e = new Engine(a);
    expect(e.start("week", 200)).toBe(at);
    expect(e.countedLength("week", e.occurrenceAt("week", at + 1)!)).toBe(5);
    expect(e.countedLength("week", e.occurrenceAt("week", at - 1)!)).toBe(7);
    expect(parse(print(a))).toEqual(a);
  });

  test("a ledger's overlapping pins are still refused through the counted line (V7)", () => {
    const a = withUnit(WORLD, "week", { ledger: [{ kind: "starts", from: 100, startsOn: e0.start("week", 99) - 1 }] });
    expect(validate(a).some((m) => m.includes("every occurrence needs"))).toBe(true);
  });

  test("a year whose filler changes by the ledger keeps the week in step", () => {
    const months = (WORLD.units[1] as { slots: readonly SlotAst[] }).slots.map((s) => (typeof s.length === "number" ? s.length : 0));
    months[12] = 29; // December one day short
    months[13] = 2; // two Worldsdays that year
    const a: CalendarAst = { ...WORLD, units: WORLD.units.map((u) => (u.id === "year" ? ({ ...u, ledger: [{ kind: "slots", from: 5, unit: "month", lengths: months }] } as typeof u) : u)) };
    expect(validate(a)).toEqual([]);
    const e = new Engine(a);
    expect(e.labelAt("weekday", dec30y5)).toBeNull(); // now the first of two Worldsdays
    expect(e.labelAt("weekday", dec30y5 + 1)).toBeNull();
    expect(e.labelAt("weekday", dec30y5 + 2)?.name).toBe("Saturday"); // January, one day behind
  });
});

describe("rules read the counted days", () => {
  const e = new Engine(WORLD);
  const worldsday = e.dayOf("month", [5], 13, 0);
  const holds = (rule: RuleAst, day: number) => e.days.holds(e.days.bind(rule), day);

  test("a label, an index and a phase are false on a skipped day", () => {
    expect(holds({ kind: "recur", freq: "week", by: [{ unit: "weekday", label: NAMES }] }, worldsday)).toBe(false);
    expect(holds({ kind: "index", unit: "week" }, worldsday)).toBe(false);
    expect(holds({ kind: "index", unit: "week" }, worldsday - 1)).toBe(true);
    expect(holds({ kind: "phase", unit: "week", from: 0, to: 1 }, worldsday)).toBe(false);
  });

  test("FREQ over a skipping unit: the last day of the week is its seventh counted day, across a skip", () => {
    const anchored = withUnit(WORLD, "week", { anchor: 3 });
    const en = new Engine(anchored);
    const spanning = en.occurrenceAt("week", worldsday - 1)!;
    const lastOf: RuleAst = { kind: "recur", freq: "week", by: [{ unit: "week", day: [-1] }] };
    const r = en.days.bind(lastOf);
    const hits = Array.from({ length: spanning.length }, (_, i) => spanning.start + i).filter((d) => en.days.holds(r, d));
    expect(hits).toEqual([spanning.start + spanning.length - 1]);
    const firstOf = en.days.bind({ kind: "recur", freq: "week", setpos: [1] });
    expect(en.days.holds(firstOf, spanning.start)).toBe(true);
    expect(en.days.holds(firstOf, spanning.start + 1)).toBe(false);
  });

  test("a recurrence anchored on a filler day still runs", () => {
    const r: RuleAst = { kind: "recur", freq: "week", anchor: worldsday, by: [{ unit: "weekday", label: ["Sunday"] }] };
    expect(holds(r, worldsday + 1)).toBe(true);
    expect(holds(r, worldsday + 8)).toBe(true);
  });
});

describe("seasons that skip", () => {
  const skipping = new SeshatCalendar(print(WORLD), () => 0);
  const plainAst: CalendarAst = { ...WORLD, seasons: { unit: "year", marks: WORLD.seasons!.marks } };
  const plain = new SeshatCalendar(print(plainAst), () => 0);
  const e = skipping.running()!;
  const worldsday = e.dayOf("month", [5], 13, 0);

  test("without SKIPS a filler day has the season around it, as always", () => {
    expect(plain.running()!.seasonAt(worldsday)).toBe("Autumn");
    expect(plain.toContext(worldsday).seasonless).toBeUndefined();
  });

  test("with SKIPS the calendar says no season, and only on a filler day", () => {
    expect(e.seasonAt(worldsday)).toBeNull();
    expect(e.seasonAt(worldsday - 1)).toBe("Autumn");
    expect(skipping.toContext(worldsday - 1).seasonless).toBeUndefined();
    expect(skipping.format(worldsday)).toBe("Worldsday 6");
    expect(formatDay(new Engine({ ...WORLD, formats: [...WORLD.formats!, { name: "readout", pattern: "{month:name} {@season}" }] }), worldsday, "readout")).toBe("Worldsday ");
    expect(e.days.holds(e.days.bind({ kind: "tag", tag: "season:Autumn" }), worldsday)).toBe(false);
  });

  test("weather reads the same day either way: the tag stays, and a flipped zone still flips it", () => {
    const c = skipping.toContext(worldsday);
    expect(c.seasonless).toBe(true);
    expect(c.tags).toContain("season:Autumn");
    const { seasonless: _ignored, ...rest } = c;
    expect(rest).toEqual({ ...plain.toContext(worldsday) });
    const flipped = flipSeasonTags(c, WORLD.seasons!.marks as Array<{ name: string; from: number }>);
    expect(flipped.tags).toEqual(flipSeasonTags(plain.toContext(worldsday), WORLD.seasons!.marks as Array<{ name: string; from: number }>).tags);
  });

  test("past the day line the adapter stays total and the flag follows the folded day", () => {
    for (const d of [DAY_LIMIT + 1000, -DAY_LIMIT - 1000]) {
      const c = skipping.toContext(d);
      expect(c.dayOrdinal).toBe(d);
      expect(c.tags?.some((t) => t.startsWith("season:"))).toBe(true);
    }
  });

  test("SKIPS reaches the hash, and an absent one leaves it alone", () => {
    expect(definitionContent(WORLD)).not.toEqual(definitionContent(plainAst));
    const noUnits = { ...plainAst, units: plainAst.units.map((u) => ({ ...u, skips: undefined })) } as unknown as CalendarAst;
    expect(JSON.stringify(definitionContent(noUnits))).not.toContain("skips");
  });
});

describe("the adapter and the Orrery on a filler day", () => {
  test("toContext is total on a skipped day and past both ends of the line", () => {
    const a = new SeshatCalendar(print(WORLD), () => 0);
    expect(a.fault).toBeNull();
    const worldsday = a.running()!.dayOf("month", [5], 13, 0);
    expect(a.toContext(worldsday).yearLength).toBe(365);
    for (const d of [DAY_LIMIT, -DAY_LIMIT, DAY_LIMIT + 400, -DAY_LIMIT - 400]) expect(a.toContext(d).dayOrdinal).toBe(d);
  });

  test("toContext on a skipping calendar stays on the warm-up path's budget", () => {
    const a = new SeshatCalendar(print(WORLD), () => 0);
    const t = performance.now();
    for (let d = 0; d < 20_000; d++) a.toContext(d * 37);
    const each = (performance.now() - t) / 20_000;
    console.log(`toContext with SKIPS: ${(each * 1000).toFixed(0)} µs per call`);
    expect(each).toBeLessThan(1); // a bound on a pathological walk, not a benchmark
  });

  test("the Orrery draws on a day the week skips", () => {
    const e = new Engine(WORLD);
    const worldsday = e.dayOf("month", [5], 13, 0);
    const model = buildOrrery(WORLD, worldsday + 0.5) as OrreryModel;
    expect(model).toBeTruthy();
    expect((buildOrrery(WORLD, worldsday + 1.5) as OrreryModel)).toBeTruthy();
  });
});

describe("refusals", () => {
  const refuses = (a: CalendarAst, text: string) => expect(validate(a).join("\n")).toContain(text);
  const WEEK = { id: "week", kind: "cycle", anchor: 0, length: 7, skips: "month" } as const;

  test("SKIPS must name a slot unit under a cycle, with a filler slot on a closed form", () => {
    refuses(withUnit(WORLD, "week", { skips: "nope" }), 'SKIPS "nope" is not a slot unit directly under a cycle unit');
    refuses(withUnit(WORLD, "week", { skips: "year" }), 'SKIPS "year" is not a slot unit directly under a cycle unit');
    const nested: CalendarAst = { ...WORLD, units: [...WORLD.units, { id: "part", kind: "slots", in: "month", slots: [{ length: "slack" }] }, { id: "w2", kind: "cycle", anchor: 0, length: 7, skips: "part" }] };
    refuses(nested, 'SKIPS "part" is not a slot unit directly under a cycle unit');
    const noFiller: CalendarAst = { name: "x", gears: [], units: [{ id: "year", kind: "cycle", anchor: 0, length: 30 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 30)] }, WEEK] };
    refuses(noFiller, 'SKIPS "month" has no filler slot to skip');
    const slack: CalendarAst = { name: "x", gears: [], units: [{ id: "year", kind: "cycle", anchor: 0, length: 30 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 29), { name: "F", length: "slack", filler: true }] }, WEEK] };
    refuses(slack, "must have a number of days, not SLACK or a table");
  });

  test("a parent occurrence must hold a counted day", () => {
    const empty: CalendarAst = { name: "x", gears: [], units: [{ id: "year", kind: "cycle", anchor: 0, length: 30 }, { id: "month", kind: "slots", in: "year", slots: [f("Only", 30)] }, WEEK] };
    refuses(empty, 'could hold only filler days');
    const months = (WORLD.units[1] as { slots: readonly SlotAst[] }).slots.map((s) => (s.filler ? 365 * +(s.name === "Worldsday") : 0));
    const a: CalendarAst = { ...WORLD, units: WORLD.units.map((u) => (u.id === "year" ? ({ ...u, ledger: [{ kind: "slots", from: 8, unit: "month", lengths: months }] } as typeof u) : u)) };
    refuses(a, "occurrence 8 of");
  });

  test("a unit that skips has no crossing, stages or children, and carries no seasons", () => {
    refuses(withUnit(WORLD, "week", { anchor: undefined, length: undefined, crossing: { period: rational(7), at: rational(0) } }), "cannot follow a crossing");
    refuses(withUnit(WORLD, "week", { stages: [{ rules: [{ add: 1, residue: { mod: 7, in: [0] } }] }] }), "cannot have stages");
    refuses({ ...WORLD, units: [...WORLD.units, { id: "d", kind: "slots", in: "week", slots: [{ length: 7 }] }] }, 'cannot sit inside a unit with SKIPS');
    refuses({ ...WORLD, seasons: { unit: "week", marks: [{ name: "A", from: 0 }] } }, "seasons cannot run over a unit with SKIPS");
  });

  test("an anchor or a pin on a filler day", () => {
    const e = new Engine(WORLD);
    const worldsday = e.dayOf("month", [5], 13, 0);
    refuses(withUnit(WORLD, "week", { anchor: worldsday }), `the anchor D${worldsday} is a filler day`);
    refuses(withUnit(WORLD, "week", { ledger: [{ kind: "starts", from: 100, startsOn: worldsday }] }), "is a filler day");
    refuses(withUnit(WORLD, "week", { ledger: [{ kind: "switch", from: 100, rule: { anchor: worldsday, length: 5 } }] }), "is a filler day");
  });

  test("seasons: SKIPS names a slot unit directly in the seasons unit, with a filler", () => {
    refuses({ ...WORLD, seasons: { ...WORLD.seasons!, skips: "nope" } }, 'seasons: SKIPS "nope" is not a slot unit directly in "year"');
    const noFiller: CalendarAst = { name: "x", gears: [], seasons: { unit: "year", skips: "month", marks: [{ name: "A", from: 0 }] }, units: [{ id: "year", kind: "cycle", anchor: 0, length: 30 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 30)] }] };
    refuses(noFiller, 'seasons: SKIPS "month" has no filler slot to skip');
  });

  test("a skipping unit is not a date coordinate, so a format built on it reads but does not parse", () => {
    const a: CalendarAst = { ...WORLD, formats: [{ name: "default", pattern: "{week}/{week:day}" }] };
    expect(validate(a)).toEqual([]);
    const adapter = new SeshatCalendar(print(a), () => 0);
    expect(adapter.format(10)).toMatch(/^\d+\/\d+$/);
    expect(adapter.parse(adapter.format(10))).toBeNull();
  });

  test("a calendar with no SKIPS has no field and no text for it", () => {
    expect(unit(WORLD, "year").skips).toBeUndefined();
    expect(print({ ...WORLD, seasons: undefined, units: WORLD.units.filter((u) => u.kind === "slots" || u.id === "year") } as unknown as CalendarAst)).not.toContain("SKIPS");
  });
});

describe("through the real generator", () => {
  const worldOn = async (definition: CalendarAst) => {
    const { zone } = zoneFromPreset({ name: "Greywold", preset: fjord, existingIds: new Set() });
    const settings = migrateSettings({ worldSeed: "seed", zones: [zone] });
    const save = () => Promise.resolve();
    const time = new TimeRegistry(settings.activeTimeAdapter);
    time.register(new InternalCalendar(settings.calendar, () => settings.currentDayOrdinal, save));
    const state = () => ({ seed: settings.worldSeed, zones: settings.zones, eras: settings.eras, overrides: settings.overrides });
    const world = new World(state(), time);
    const controller = new ApiController({ version: "9.9.9", world, time, units: () => "metric" });
    const calendars = new Calendars({ settings: () => settings, time, world, save, writeDay: save, rebuild: () => world.setState(state()), emitTimeChanged: () => controller.emitTimeChanged(), emitAdaptersChanged: () => world.emit("adapters-changed"), syncActiveSubscription: () => controller.syncActiveSubscription() });
    controller.markReady();
    await calendars.optIn(print(definition));
    return { api: controller.api, zone: zone.id };
  };

  test("seasons that skip leave the weather on every day exactly as it was", async () => {
    const a = await worldOn(WORLD);
    const b = await worldOn({ ...WORLD, seasons: { unit: "year", marks: WORLD.seasons!.marks } });
    const worldsday = new Engine(WORLD).dayOf("month", [5], 13, 0);
    const weather = (w: typeof a, d: number) => {
      const { provenance: _p, ...r } = w.api.getReport(w.zone, { dayOrdinal: d });
      return r;
    };
    for (let d = worldsday - 3; d <= worldsday + 3; d++) expect(weather(a, d)).toEqual(weather(b, d));
    expect(a.api.seshat.calendar()!.seasonAt(worldsday)).toBeNull();
    expect(a.api.timeAt(worldsday).seasonless).toBe(true);
  });

  test("a report at both ends of the world's day range, and on a skipped day", async () => {
    const a = await worldOn(WORLD);
    const worldsday = new Engine(WORLD).dayOf("month", [5], 13, 0);
    for (const d of [DAY_LIMIT, -DAY_LIMIT, worldsday]) expect(a.api.getReport(a.zone, { dayOrdinal: d }).dayOrdinal).toBe(d);
  });
});

describe("found in review", () => {
  test("a slot unit that does not fill its parent is reported, not thrown", () => {
    const short: CalendarAst = { name: "x", gears: [], units: [{ id: "year", kind: "cycle", anchor: 0, length: 10 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 4), m("B", 4), f("F")] }, { id: "week", kind: "cycle", anchor: 0, length: 7, skips: "month" }] };
    expect(validate(short).join()).toContain("slots total 9 days");
    const overshoot: CalendarAst = { name: "x", gears: [{ id: "g", on: "year", kind: "intervals", terms: [{ every: 2, sign: 1 }] }], units: [{ id: "year", kind: "cycle", anchor: 0, length: 10 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 9), { name: "F", length: 1, gears: [{ gear: "g", add: 3 }], filler: true }] }, { id: "week", kind: "cycle", anchor: 0, length: 7, skips: "month", ledger: [{ kind: "starts", from: 3, startsOn: 30 }] }] };
    expect(validate(overshoot).length).toBeGreaterThan(0);
  });

  test("a world calendar's year cannot skip", () => {
    const a: CalendarAst = { name: "x", gears: [], units: [{ id: "era", kind: "cycle", anchor: 0, length: 100 }, { id: "part", kind: "slots", in: "era", slots: [m("A", 49), f("F", 2), m("B", 49)] }, { id: "year", kind: "cycle", anchor: 0, length: 20, skips: "part" }] };
    expect(worldProblems(a).map((p) => p.message).join()).toContain("cannot have SKIPS");
    expect(new SeshatCalendar(print(a), () => 0).fault).not.toBeNull();
  });

  test("Studio edits keep SKIPS: adding, changing and removing a season mark", () => {
    const added = addSeasonMark(WORLD, { name: "Summer", from: 0.25 });
    expect("ast" in added && added.ast.seasons?.skips).toBe("month");
    const removed = removeSeasonMark(WORLD, 0);
    expect("ast" in removed && removed.ast.seasons?.skips).toBe("month");
    const set = setSeasonMark(WORLD, 0, { name: "Spring", from: 0.1 });
    expect("ast" in set && set.ast.seasons?.skips).toBe("month");
  });

  test("the Seasons window hands seasons that skip to the Orrery, and the Orrery edits them", () => {
    expect(seasonsWindowLock(WORLD.seasons)).toBe("skips");
    const draft = seshatDraft(WORLD);
    const edit = addMark(draft, [0, 0.5]);
    if ("refused" in edit) throw new Error(edit.reason);
    expect(edit.calendar.ast?.seasons?.skips).toBe("month");
    expect(edit.calendar.ast?.seasons?.marks.length).toBe(3);
  });

  test("renaming a slot unit carries SKIPS; removing one that is skipped is refused", () => {
    const renamed = renameUnit(WORLD, "month", "moon");
    if (!("ast" in renamed)) throw new Error("refused");
    expect(renamed.ast.seasons?.skips).toBe("moon");
    expect(unit(renamed.ast, "week").skips).toBe("moon");
    expect(unit(renamed.ast, "weekday").skips).toBe("moon");
    expect(validate(renamed.ast)).toEqual([]);
    const removed = removeUnit({ ...WORLD, formats: [] }, "month");
    expect("refused" in removed && removed.reason).toContain("skip its filler days");
  });

  test("the Orrery's day label on a skipping cycle matches the engine, and 'today is' is refused", () => {
    const e = new Engine(WORLD);
    const u = unit(WORLD, "weekday") as CycleUnitAst & { anchor: number };
    for (const d of [0, 364, 365, 366, 400, 2000]) {
      if (e.skipped("weekday", d)) continue;
      expect(NAMES[labelOn(u, d, (id, day) => e.indexAt(id, day))]).toBe(e.labelAt("weekday", d)!.name);
    }
    expect(anchorProblem(WORLD, "weekday")).toContain("skips filler days");
  });
});

describe("the Orrery's switches", () => {
  const stripped = (a: CalendarAst): CalendarAst => ({ ...a, seasons: { unit: "year", marks: a.seasons!.marks }, units: a.units.map((u) => (u.kind === "cycle" ? (({ skips: _s, ...r }) => r)(u) : u)) });
  const PLAIN = stripped(WORLD);
  const done = (r: CalendarEdit) => {
    if ("refused" in r) throw new Error(`refused: ${r.reason}`);
    return r;
  };

  test("a cycle: on writes SKIPS on it and on the week that runs with it, off takes both away", () => {
    const on = done(setCycleSkip(seshatDraft(PLAIN), "weekday", true));
    expect(unit(on.ast, "weekday").skips).toBe("month");
    expect(unit(on.ast, "week").skips).toBe("month");
    expect(validate(on.ast)).toEqual([]);
    const off = done(setCycleSkip(on.calendar, "week", false));
    expect(unit(off.ast, "weekday").skips).toBeUndefined();
    expect(unit(off.ast, "week").skips).toBeUndefined();
    expect(print(off.ast)).not.toContain("SKIPS");
  });

  test("the form shows a skipping week as text, and fields again once it stops", () => {
    const draft = seshatDraft(PLAIN);
    expect(Array.isArray(draft.form?.week)).toBe(true);
    const on = done(setCycleSkip(draft, "weekday", true));
    expect(Array.isArray(on.calendar.form?.week)).toBe(false);
    const off = done(setCycleSkip(on.calendar, "weekday", false));
    expect(Array.isArray(off.calendar.form?.week)).toBe(true);
  });

  test("seasons: on and off keep the marks, including an unsaved fraction edit", () => {
    const draft = seshatDraft(PLAIN);
    const moved = done(setMarkFrom(draft, 1, 0.6, PLAIN.seasons!.marks));
    const on = done(setSeasonsSkip(moved.calendar, true));
    expect(on.ast.seasons?.skips).toBe("month");
    expect((on.ast.seasons?.marks[1] as { from: number }).from).toBe(0.6);
    expect(validate(on.ast)).toEqual([]);
    const renamed = done(renameMark(on.calendar, 0, "Sprout"));
    expect(renamed.ast.seasons?.skips).toBe("month");
    const off = done(setSeasonsSkip(renamed.calendar, false));
    expect(off.ast.seasons?.skips).toBeUndefined();
    expect(off.ast.seasons?.marks.map((x) => x.name)).toEqual(["Sprout", "Autumn"]);
    expect(done(setMarkFrom(off.calendar, 1, 0.7, off.ast.seasons!.marks)).ast.seasons?.marks.length).toBe(2);
  });

  test("the refusals say what to do", () => {
    const none: CalendarAst = { name: "x", gears: [], seasons: { unit: "year", marks: [{ name: "A", from: 0 }] }, units: [{ id: "year", kind: "cycle", anchor: 0, length: 30 }, { id: "month", kind: "slots", in: "year", slots: [m("A", 30)] }, { id: "weekday", kind: "cycle", anchor: 0, length: 1, labels: [{ name: "X" }, { name: "Y" }] }] };
    expect(skipTarget(none)).toBeNull();
    expect(seasonsSkipTarget(none)).toBeNull();
    const a = setCycleSkip(seshatDraft(none), "weekday", true);
    expect("refused" in a && a.reason).toContain("mark a slot as filler");
    const b = setSeasonsSkip(seshatDraft(none), true);
    expect("refused" in b && b.reason).toContain("mark a slot as filler");
    const e = new Engine(WORLD);
    const onFiller = withUnit(withUnit(PLAIN, "weekday", { anchor: e.dayOf("month", [5], 13, 0) }), "week", { anchor: e.dayOf("month", [5], 13, 0) });
    const c = setCycleSkip(seshatDraft(onFiller), "weekday", true);
    expect("refused" in c && c.reason).toContain("is a filler day");
  });
});

describe("today is, on the year", () => {
  const draft = () => seshatDraft(GREGORIAN);
  const edit = (r: CalendarEdit) => {
    if ("refused" in r) throw new Error(r.reason);
    return r;
  };

  test("the calendar moves so the day reads as the date typed; undoing the draft puts it back", () => {
    const day = 20758;
    expect(yearTodayText(GREGORIAN, day)).toBe("2026-11-01");
    const r = edit(setYearToday(draft(), day, "2030-03-15"));
    expect(yearTodayText(r.ast, day)).toBe("2030-03-15");
    expect(new Engine(r.ast).labelAt("month", day)?.name).toBe("March");
  });

  test("a date the calendar cannot read is refused with how the day reads", () => {
    const r = setYearToday(draft(), 20758, "next tuesday");
    expect("refused" in r && r.reason).toContain("is not a date in this calendar");
    expect("refused" in r && r.reason).toContain("2026-11-01");
  });

  test("a calendar that skips, a year on stages and crossings, and one with exceptions all move, and read the date typed", () => {
    for (const cal of [WORLD, HEBREW, ROMAN]) {
      const shown = new Engine(cal);
      const date = formatDay(shown, 1000);
      const r = edit(setYearToday(seshatDraft(cal), 400, date));
      expect(formatDay(new Engine(r.ast), 400)).toBe(date);
      expect(validate(r.ast)).toEqual([]);
    }
  });

  test("a day number off the day line is refused, and so is one too big to write", () => {
    for (const far of ["10000005", "-30000000", "9007199254740993"]) {
      const r = setYearToday(draft(), 20758, far);
      expect("refused" in r && r.reason).toContain("too far from today");
    }
    expect("refused" in setYearToday(draft(), 20758, "20758")).toBe(false);
  });
});
