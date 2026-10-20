/**
 * Seshat P3a step 5 (docs/SESHAT-v0.md §13.3, §13.11 "Day 0"): what opting a
 * world in stores.
 *
 *   - from the world's internal calendar: the definition that runs it day for
 *     day (the step-2 differential holds it to the same weather);
 *   - from a preset, bringing the world's seasons and moons: the moons are the
 *     legacy moons exactly, every day, before and after an anchor;
 *   - anchored: today reads as the date asked for; a date the calendar cannot
 *     read, or an anchor that leaves the day line, is refused;
 *   - every preset opts in, kept or anchored.
 */
import { describe, expect, test } from "bun:test";
import { buildOptIn, WORLD_PRESETS, type OptInPlan } from "../src/plugin/opt-in";
import { InternalCalendar } from "../src/plugin/time/internal";
import { definitionFromLegacy, SeshatCalendar } from "../src/plugin/time/seshat";
import type { InternalCalendarConfig } from "../src/plugin/settings";
import { GREGORIAN, print } from "../src/seshat";

const CFG: InternalCalendarConfig = {
  yearLength: 365,
  epochYear: 1,
  moons: [
    { name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0, phases: [{ name: "Full", at: 0.5 }] },
    { name: "Ash", cycleDays: 7.3, phaseAtEpoch: -0.25 },
  ],
  seasons: [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Autumn", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ],
};
const plan = (r: ReturnType<typeof buildOptIn>): OptInPlan => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
const sameMoons = (a: SeshatCalendar, days: number[]) => {
  const legacy = new InternalCalendar(CFG, () => 0);
  for (const d of days) {
    const got = a.toContext(d).moons!;
    const want = legacy.toContext(d).moons!;
    expect(got.map((m) => m.name)).toEqual(want.map((m) => m.name));
    for (const [i, m] of got.entries()) expect([d, m.name, Object.is(m.phase, want[i]!.phase)]).toEqual([d, m.name, true]);
  }
};
const DAYS = [-100_000, -1, 0, 1, 500, 2953, 123_456, 9_000_000];

describe("from the world's internal calendar", () => {
  test("stores the definition that runs it day for day, and says how today reads", () => {
    const p = plan(buildOptIn({ source: { kind: "internal" }, carry: false }, CFG, 0));
    const r = definitionFromLegacy(CFG);
    if ("refused" in r) throw new Error(r.refused);
    expect(p.text).toBe(print(r.ast));
    expect(p.today).toBe("Year 1, day 1 (Spring)");
    expect(p.shift).toBe(0);
    expect(p.lossy).toEqual([]);
    expect(p.renamed).toEqual([]);
    sameMoons(new SeshatCalendar(p.text, () => 0), DAYS);
  });

  test("anchored, the world's own moons stay where they are; the dates move", () => {
    const p = plan(buildOptIn({ source: { kind: "internal" }, carry: false, anchor: "5-100" }, CFG, 0));
    expect(p.today).toBe("Year 5, day 100 (Summer)");
    sameMoons(new SeshatCalendar(p.text, () => 0), DAYS);
  });

  test("a season that starts outside [0, 1) is refused, naming the Seasons row (Parallax F8)", () => {
    const r = buildOptIn({ source: { kind: "internal" }, carry: false }, { ...CFG, seasons: [{ name: "b", from: 1.2 }] }, 0);
    expect("error" in r && r.error).toContain('the season "b" starts at 1.2');
    expect("error" in r && r.error).toContain("Settings → Calendar → Seasons");
  });

  test("names the definition stores in another Unicode form are listed (Parallax F2)", () => {
    const nfd = "E" + String.fromCharCode(0x0301) + "te" + String.fromCharCode(0x0301);
    const cfg = { ...CFG, seasons: [{ name: nfd, from: 0 }], moons: [{ name: nfd, cycleDays: 29.53, phaseAtEpoch: 0 }] };
    expect(plan(buildOptIn({ source: { kind: "internal" }, carry: false }, cfg, 0)).renamed).toEqual([nfd, nfd]);
    expect(plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: true }, cfg, 0)).renamed).toEqual([nfd, nfd]);
    expect(plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false }, cfg, 0)).renamed).toEqual([]);
  });

  test("a fractional year cannot become a definition", () => {
    expect(buildOptIn({ source: { kind: "internal" }, carry: false }, { ...CFG, yearLength: 365.25 }, 0)).toEqual({ error: "This world's calendar cannot become a definition: a year of 365.25 days has no whole-day form." });
  });
});

describe("from a preset", () => {
  test("bringing the world's seasons and moons: the moons are the legacy moons exactly, every day", () => {
    const p = plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: true }, CFG, 0));
    const a = new SeshatCalendar(p.text, () => 0);
    expect(a.fault).toBeNull();
    expect(a.describe().seasons.map((s) => s.name)).toEqual(["Spring", "Summer", "Autumn", "Winter"]);
    expect(a.describe().moons.map((m) => [m.name, m.phases ?? null])).toEqual([
      ["Sable", [{ name: "Full", at: 0.5 }]],
      ["Ash", null],
    ]);
    sameMoons(a, DAYS);
    expect(p.today).toBe("1970-01-01"); // day 0 is the Unix epoch in the Gregorian preset
  });

  test("a carried moon whose decimals the rationals only approximate is named", () => {
    const odd = { ...CFG, moons: [{ name: "Odd", cycleDays: 29.530588853, phaseAtEpoch: 0.123456789 }] };
    expect(plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: true }, odd, 0)).lossy).toEqual(["Odd"]);
    expect(plan(buildOptIn({ source: { kind: "internal" }, carry: false }, odd, 0)).lossy).toEqual(["Odd"]);
  });

  test("without carrying, the preset is stored as it is", () => {
    const p = plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false }, CFG, 0));
    expect(p.text).toBe(print(GREGORIAN));
  });

  test("an unknown preset is refused", () => {
    expect(buildOptIn({ source: { kind: "preset", id: "nope" }, carry: false }, CFG, 0)).toEqual({ error: 'There is no calendar "nope".' });
  });

  test("every preset opts in, kept and anchored to the date its own format gives a day", () => {
    for (const { id } of WORLD_PRESETS) {
      const kept = plan(buildOptIn({ source: { kind: "preset", id }, carry: true }, CFG, 4321));
      const anchored = plan(buildOptIn({ source: { kind: "preset", id }, carry: true, anchor: plan(buildOptIn({ source: { kind: "preset", id }, carry: true }, CFG, 777_777)).today }, CFG, 4321));
      expect([id, anchored.shift]).toEqual([id, 4321 - 777_777]);
      expect([id, anchored.today]).toEqual([id, plan(buildOptIn({ source: { kind: "preset", id }, carry: true }, CFG, 777_777)).today]);
      expect([id, new SeshatCalendar(kept.text, () => 0).fault, new SeshatCalendar(anchored.text, () => 0).fault]).toEqual([id, null, null]);
    }
  });
});

describe("anchoring today to a date", () => {
  test("today reads as the date asked for, and the moons stay where they were", () => {
    const p = plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: true, anchor: "2026-10-19" }, CFG, 500));
    expect(p.today).toBe("2026-10-19");
    const a = new SeshatCalendar(p.text, () => 500);
    expect(a.format(500)).toBe("2026-10-19");
    expect(a.format(501)).toBe("2026-10-20");
    sameMoons(a, DAYS);
  });

  test("anchor mode with no date yet is refused, not quietly treated as keeping day numbers", () => {
    expect(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false, anchor: "  " }, CFG, 0)).toEqual({ error: "Write the date today should read, or keep day numbers." });
  });

  test("a pasted definition's own body moves with its dates; the world's carried moons do not (ruled 2026-10-19)", () => {
    const own = print({ ...GREGORIAN, bodies: [{ id: "sun", period: { n: 1461, d: 4 }, epoch: { n: 0, d: 1 } }], rules: [{ id: "midsummer", tags: ["midsummer"], rule: { kind: "phase", body: "sun", from: 0.45, to: 0.55 } }] });
    const kept = plan(buildOptIn({ source: { kind: "text", text: own }, carry: true }, CFG, 500));
    const anchored = plan(buildOptIn({ source: { kind: "text", text: own }, carry: true, anchor: "2026-10-19" }, CFG, 500));
    const a = new SeshatCalendar(kept.text, () => 0);
    const b = new SeshatCalendar(anchored.text, () => 0);
    // the source's sun keeps its place among the dates: the same date has the same midsummer tag
    for (let d = -1000; d <= 1000; d += 7) expect([d, b.toContext(d + anchored.shift).tags!.includes("midsummer")]).toEqual([d, a.toContext(d).tags!.includes("midsummer")]);
    // the world's moons are still the world's sky, day for day
    sameMoons(b, DAYS);
  });

  test("a bare day number anchors too: today reads as that day did", () => {
    const p = plan(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false, anchor: "0" }, CFG, 500));
    expect([p.shift, p.today]).toEqual([500, "1970-01-01"]);
  });

  test("a date the calendar cannot read is refused, showing how today reads", () => {
    const r = buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false, anchor: "19 October 2026" }, CFG, 0);
    expect(r).toEqual({ error: '"19 October 2026" is not a date in this calendar. Write it as today reads (1970-01-01).' });
  });

  test("an anchor that moves the calendar off the day line is refused", () => {
    const r = buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false, anchor: "9999-12-31" }, CFG, -9_999_000);
    expect("error" in r && r.error).toMatch(/anchor -\d+ is not a whole day within ±10000000/);
  });
});

describe("buildOptIn never throws", () => {
  test("today off the day line is an error, not a throw", () => {
    expect(buildOptIn({ source: { kind: "preset", id: "gregorian" }, carry: false }, CFG, 50_000_000)).toEqual({ error: "Today (day 50000000) is not a day this calendar can read: it is off the calendar's day line." });
  });
});

describe("from pasted text", () => {
  test("a definition that cannot run is refused with its line", () => {
    const r = buildOptIn({ source: { kind: "text", text: print(GREGORIAN).replace("END:VCALENDAR", "END:VNOTHING") }, carry: false }, CFG, 0);
    expect("error" in r && r.error).toMatch(/^Line \d+: /);
  });

  test("carrying a moon the text already names is refused", () => {
    const text = print({ ...GREGORIAN, bodies: [{ id: "x", period: { n: 30, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Sable" } }] });
    expect(buildOptIn({ source: { kind: "text", text }, carry: true }, CFG, 0)).toEqual({ error: 'The calendar already has a moon named "Sable".' });
    // carried moons take ids the text does not use
    const other = print({ ...GREGORIAN, bodies: [{ id: "moon-1", period: { n: 30, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Pale" } }] });
    const p = plan(buildOptIn({ source: { kind: "text", text: other }, carry: true }, CFG, 0));
    expect(new SeshatCalendar(p.text, () => 0).describe().moons.map((m) => m.name)).toEqual(["Pale", "Sable", "Ash"]);
  });
});
