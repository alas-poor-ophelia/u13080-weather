/**
 * P3c step 3 (docs/SESHAT-v0.md §15.5, §15.9 B1 B2): which days' weather a
 * calendar change can reach. The search against a brute-force comparison, and
 * the generator facts it rests on, through the real World: records before the
 * first differing day are identical, records settle again after the last one
 * plus the carry, and a change inside the year holding day 0 reaches far days
 * when a spell modifier is tuned on that year.
 */
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/profile";
import { PRESETS } from "../src/generated/presets";
import type { Modifier, ZoneProfile } from "../src/core/types";
import { print, type CalendarAst } from "../src/seshat";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { BLAST_CARRY, blastRadius, describeBlast, type BlastRadius } from "../src/plugin/time/blast";
import { definitionFromLegacy, SeshatCalendar } from "../src/plugin/time/seshat";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { World } from "../src/plugin/world";

const PLAIN = (() => {
  const r = definitionFromLegacy(DEFAULT_SETTINGS.calendar);
  if ("refused" in r) throw new Error(r.refused);
  return r.ast;
})();
const cal = (ast: CalendarAst) => new SeshatCalendar(print(ast), () => 0);
const feastOn = (day: number, count = 1): CalendarAst => ({ ...PLAIN, days: Array.from({ length: count }, (_, i) => ({ day: day + i, name: "Feast", tags: ["feast"] })) });

/** every day in the window, compared whole, with no staging: the reference the search must match */
function bruteForce(a: SeshatCalendar, b: SeshatCalendar, from: number, to: number): { first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  for (let d = from; d <= to; d++) {
    if (canonicalJson(a.toContext(d)) !== canonicalJson(b.toContext(d)) || canonicalJson(a.yearOfDay(d)) !== canonicalJson(b.yearOfDay(d))) {
      first ??= d;
      last = d;
    }
  }
  return { first, last };
}

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const FEAST: Modifier = { id: "feast", when: { tag: "feast" }, apply: [{ param: "wind.speed", op: "offset", value: 14 }], tag: "feast-wind" };
// a spell over a yearly window (days 100 to 110) and any feast day: its start chance is tuned on how many such days the year holding day 0 has
const FEAST_SPELL: Modifier = { id: "feast-spell", when: { any: [{ dayOfYear: [100, 110] }, { tag: "feast" }] }, spell: { meanStartsPerYear: 10, meanDurationDays: 6 }, apply: [{ param: "wind.speed", op: "offset", value: 14 }], tag: "feast-spell" };
const zone = (mods: Modifier[]): ZoneProfile => ({ id: "z", name: "z", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: mods });
function world(ast: CalendarAst, mods: Modifier[]): World {
  const a = cal(ast);
  const time = new TimeRegistry(a.id);
  time.register(a);
  return new World({ seed: "blast", zones: [zone(mods)], eras: [], overrides: [] }, time);
}
/** the weather of a day, without its provenance stamp (which names the calendar's hash, and is meant to change) */
const report = (w: World, d: number) => {
  const { provenance: _p, ...weather } = w.getReport("z", { dayOrdinal: d });
  return canonicalJson(weather);
};

describe("the search", () => {
  test("the same calendar: no day differs", async () => {
    const r = await blastRadius(cal(PLAIN), cal(PLAIN), 0, { spells: true, years: 3 });
    expect(r).toMatchObject({ first: null, last: null, everyDay: false });
    expect(describeBlast(r, String, 3)).toBe("No day within 3 years of today reads differently, so the weather there is unchanged.");
  });

  test("a marked day: first and last are that day, as a day-by-day comparison finds", async () => {
    const before = cal(PLAIN);
    const after = cal(feastOn(400));
    const r = await blastRadius(before, after, 100, { spells: false, years: 3 });
    expect(r).toMatchObject({ first: 400, last: 400, everyDay: false });
    expect(bruteForce(before, after, r.from, r.to)).toEqual({ first: 400, last: 400 });
    expect(describeBlast(r, (d) => `day ${d}`, 3)).toBe(`Weather may change in every zone from day 400 through day ${400 + BLAST_CARRY}.`);
  });

  test("a year-length change differs from the window's start: every day within the window", async () => {
    const before = cal(PLAIN);
    const after = cal({ ...PLAIN, units: [{ ...(PLAIN.units[0] as { length: number }), length: 360 } as CalendarAst["units"][number]] });
    const r = await blastRadius(before, after, 0, { spells: false, years: 2 });
    const brute = bruteForce(before, after, r.from, r.to);
    expect({ first: r.first, last: r.last }).toEqual(brute);
    expect(r.first).toBe(r.from);
    expect(describeBlast(r, String, 2)).toBe("Weather may change in every zone on every day within 2 years of today.");
  });

  test("a change inside the year holding day 0 is every day on a world with spells, and only that day without", async () => {
    const before = cal(PLAIN);
    const after = cal(feastOn(5));
    const withSpells = await blastRadius(before, after, 10_000, { spells: true, years: 2 });
    expect(withSpells.everyDay).toBe(true);
    expect(describeBlast(withSpells, String)).toContain("on every day");
    const without = await blastRadius(before, after, 10_000, { spells: false, years: 2 });
    expect(without).toMatchObject({ first: null, last: null, everyDay: false });
  });

  test("the window ends: a difference running to its end reads 'onward'", () => {
    const r: BlastRadius = { from: 0, to: 1000, first: 300, last: 1000, everyDay: false };
    expect(describeBlast(r, (d) => `day ${d}`)).toBe("Weather may change in every zone from day 300 onward.");
  });

  test("tick is awaited every chunk, so a caller can yield", async () => {
    let ticks = 0;
    await blastRadius(cal(PLAIN), cal(PLAIN), 0, { spells: false, years: 1, chunk: 100, tick: () => {
        ticks++;
        return Promise.resolve();
      },
    });
    expect(ticks).toBe(Math.floor((2 * 365 + 1) / 100));
  });
});

describe("the generator facts the search rests on (real World)", () => {
  // day 205 of its year: outside the spell's yearly window, so the feast is the only new reason to start one
  const X = 1300;

  test("records before the first differing day are identical, they differ on it, and settle after the last plus the carry", () => {
    // a plain modifier on one feast day; a spell on a run of 20 (a start on any one day is a draw, on twenty near-certain)
    for (const [mods, count] of [[[FEAST], 1], [[FEAST_SPELL], 20]] as Array<[Modifier[], number]>) {
      const a = world(PLAIN, mods);
      const b = world(feastOn(X, count), mods);
      const last = X + count - 1;
      for (let d = X - 300; d < X; d++) expect(report(b, d)).toBe(report(a, d));
      expect(Array.from({ length: count + 60 }, (_, i) => X + i).some((d) => report(b, d) !== report(a, d))).toBe(true);
      for (let d = last + BLAST_CARRY + 1; d < last + BLAST_CARRY + 200; d++) expect(report(b, d)).toBe(report(a, d));
    }
  });

  test("a change inside the year holding day 0 reaches far days through a spell modifier (the one global read)", () => {
    const a = world(PLAIN, [FEAST_SPELL]);
    const b = world(feastOn(5), [FEAST_SPELL]);
    const far = Array.from({ length: 2000 }, (_, i) => 20_000 + i);
    expect(far.some((d) => report(b, d) !== report(a, d))).toBe(true);
    // and without a spell, the same change stays local
    const c = world(PLAIN, [FEAST]);
    const e = world(feastOn(5), [FEAST]);
    expect(far.every((d) => report(e, d) === report(c, d))).toBe(true);
  });
});
