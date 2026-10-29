/**
 * Orrery fixtures (docs/SESHAT-v0.md §18, bead wadjet-b6x).
 *
 * - LUNAR: a year that follows a body (twelve crossings of the Moon's New
 *   mark, INDEX=12/0/1), months tiling it with a slack last month, season
 *   marks by fraction, by day of year and by month and day, a day label, and
 *   a named rule (full moons, one skipped).
 * - LEVANAH (§18.6 item 13): the Hebrew preset with a body Levanah sharing
 *   the molad's period, its epoch 579383/765433 placing phase 0 six hours
 *   before crossing 0 (the preset's crossing includes the six-hour shift), so
 *   no geometry may assume the molad mark sits at phase 0.
 */
import { HEBREW, type CalendarAst, type RuleAst } from "../../src/seshat";

const fullMoons: RuleAst = { kind: "all", of: [{ kind: "phase", body: "moon", name: "Full" }, { kind: "not", of: { kind: "dates", days: [100] } }] };

export const LUNAR: CalendarAst = {
  name: "Lunar test",
  formats: [{ name: "default", pattern: "{month:day} {month:name} {year}" }],
  seasons: {
    unit: "year",
    marks: [
      { name: "Thaw", from: 0.1 },
      { name: "Bloom", day: 80 },
      { name: "Harvest", slot: { unit: "month", index: 6, day: 1 } },
    ],
  },
  bodies: [{ id: "moon", period: { n: 2953059, d: 100000 }, epoch: { n: 1, d: 4 }, moon: { name: "Moon", phases: [{ name: "New", at: 0 }, { name: "Full", at: 0.5 }] } }],
  gears: [],
  units: [
    { id: "year", kind: "cycle", number: 1, crossing: { body: { id: "moon", mark: { n: 0, d: 1 } }, index: { a: 12, c: 0, L: 1 } } },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [...[30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30].map((length, i) => ({ name: `M${i + 1}`, length })), { name: "M12", length: "slack", min: 29, max: 30 }],
    },
  ],
  days: [{ day: 10, name: "Founding" }],
  rules: [{ id: "full", name: "Full moon", tags: ["full"], rule: fullMoons }],
};

/**
 * ESCAPED: names that need every escape the printer writes (\ , ; : = #), and
 * a `slots` ledger entry that sets the months of year index 2 (one set-screw
 * on the post in that year only).
 */
export const ESCAPED: CalendarAst = {
  name: "Odd, calendar; #1",
  formats: [{ name: "default", pattern: "{month:day} {month:name} {year}" }],
  gears: [],
  units: [
    { id: "year", kind: "cycle", anchor: 0, length: 365, ledger: [{ kind: "slots", from: 2, unit: "month", lengths: [125, 120, 120] }] },
    {
      id: "month",
      kind: "slots",
      in: "year",
      slots: [
        { name: "A,b", length: 120 },
        { name: "C;d=e", length: 120 },
        { name: "#x\\y:z", length: 125 },
      ],
    },
  ],
  days: [{ day: 3, name: "Feast: one, two", tags: ["a=b"] }],
};

/** Levanah: period 765433/25920 d (the molad's), epoch 579383/765433 (phase 0 six hours before crossing 0). */
export const LEVANAH_BODY = { id: "levanah", period: { n: 765_433, d: 25_920 }, epoch: { n: 579_383, d: 765_433 }, moon: { name: "Levanah", phases: [{ name: "Molad", at: 0 }, { name: "Full", at: 0.5 }] } } as const;

export const LEVANAH: CalendarAst = { ...HEBREW, bodies: [LEVANAH_BODY] };

/** The seven Hebrew day names, Sunday first. */
export const HEBREW_DAYS = ["Rishon", "Sheni", "Shlishi", "Revi'i", "Chamishi", "Shishi", "Shabbat"] as const;

/**
 * HEBREW_WEEK: the Hebrew preset with a one-day weekday cycle (day 3,
 * 1970-01-04, a Sunday, is Rishon), so a stage's weekday test reads by day
 * name: stage 1 (lo ADU rosh) is "starts on Rishon · Revi'i · Shishi → +1".
 */
export const HEBREW_WEEK: CalendarAst = { ...HEBREW, units: [...HEBREW.units, { id: "weekday", kind: "cycle", anchor: 3, length: 1, labels: HEBREW_DAYS.map((name) => ({ name })) }] };

/**
 * HEBREW_LOOSE: HEBREW_WEEK with Heshvan and Kislev taking 28 to 31 days, so
 * a stage edit that moves a year's start by a day still leaves months that
 * fill every year (the real preset's 29-30 holds only under its own stages):
 * the e2e and the stage tests edit a stage and watch the year move.
 */
export const HEBREW_LOOSE: CalendarAst = {
  ...HEBREW_WEEK,
  name: "Hebrew (loose)",
  units: HEBREW_WEEK.units.map((u) => (u.id === "month" && u.kind === "slots" ? ({ ...u, slots: u.slots.map((s) => (s.length === "slack" ? { ...s, min: 28, max: 31 } : s)) }) : u)),
};
