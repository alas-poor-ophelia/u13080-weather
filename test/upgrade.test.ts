/**
 * The Upgrade dialog's logic (docs/SESHAT-v0.md §17.2 "UX", §17.5 items 6-11; bead wadjet-9lc step 3): the words,
 * the range checks, the count line, the cap, and the flow the dialog runs (scan, upgrade) on the world the e2e
 * step uses. The modals themselves (upgrade-modals.ts) need Obsidian and are walked in test/e2e/upgrade.e2e.ts.
 */
import { describe, expect, test } from "bun:test";
import { PRESETS } from "../src/generated/presets";
import { PREVIOUS_GENERATOR_VERSION, GENERATOR_VERSION } from "../src/core/version";
import { keepSourceOf, keptSpan, MAX_KEPT_DAYS, scanKeep, upgradeWorld, type FrozenDay, type KeepScan } from "../src/plugin/keep";
import { migrateSettings } from "../src/plugin/settings";
import { InternalCalendar } from "../src/plugin/time/internal";
import { MAX_RANGE_DAYS, World } from "../src/plugin/world";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { worldStateOf } from "../src/plugin/keep";
import { zoneFromPreset } from "../src/plugin/zones";
import {
  countLine,
  defaultStart,
  keptCalendarNote,
  keptRowDesc,
  legacyCalendarMoved,
  MOST_RECENT_LABEL,
  overCapLine,
  PREVIOUS_GENERATOR_DESC,
  PREVIOUS_LOAD_NOTICE,
  progressLine,
  rangeProblem,
  readStart,
  SYNC_REVERT_NOTICE,
  syncRevertNotice,
  keptChangedNote,
  legacyCalendarKey,
  worldMode,
  upgradedNotice,
} from "../src/plugin/upgrade";

const fmt = (d: number) => `D${d}`;
type Done = Extract<KeepScan, { kind: "done" }>;
const done = (kept: Array<[string, number]>, unstorable = 0, zones: string[] = [...new Set(kept.map(([z]) => z))]): Done => ({
  kind: "done",
  days: kept.map(([zoneId, dayOrdinal]) => ({ zoneId, dayOrdinal }) as unknown as FrozenDay),
  zones: zones.map((zoneId) => ({ zoneId, scanned: 10, kept: kept.filter(([z]) => z === zoneId).length, unstorable: 0 })),
  scanned: 10 * zones.length,
  unstorable,
  fromDay: 0,
  toDay: 9,
});

describe("the words (§17.2)", () => {
  test("the load Notice, the Generator row and the sync Notice say what the spec says", () => {
    expect(PREVIOUS_LOAD_NOTICE).toBe("Wadjet has a new weather generator (0.0.4). This world keeps the old one (0.0.3), so its weather stays as you saw it, until you upgrade it in Settings → World → Generator.");
    expect(PREVIOUS_GENERATOR_DESC).toBe("This world runs the previous weather generator (0.0.3), so its weather is unchanged. Upgrading changes some days; you can keep the days you have already used.");
    expect(SYNC_REVERT_NOTICE).toBe("Another device moved this world back to the previous weather generator.");
  });

  test("the count line: kept days and the zones they are in, unstorable days only when there are any", () => {
    expect(countLine(done([["a", 1], ["a", 2], ["b", 3]]))).toBe("3 days in 2 zones will be kept; the rest come out the same.");
    expect(countLine(done([["a", 1]]))).toBe("1 day in 1 zone will be kept; the rest come out the same.");
    // zones with nothing kept are not counted
    expect(countLine(done([["a", 1], ["a", 2]], 0, ["a", "b", "c"]))).toBe("2 days in 1 zone will be kept; the rest come out the same.");
    expect(countLine(done([], 0, ["a"]))).toBe("No day in this range changes, so there is nothing to keep; every day comes out the same.");
    expect(countLine(done([["a", 1]], 2))).toBe("1 day in 1 zone will be kept; the rest come out the same. 2 days cannot be stored and will show the new generator's weather.");
    expect(countLine(done(Array.from({ length: 1234 }, (_, i) => ["a", i] as [string, number])))).toStartWith("1,234 days in 1 zone");
  });

  test("progress, the cap, the Notice, the Kept weather row, the calendar note", () => {
    expect(progressLine(0, 0)).toBe("Counting the days that change… 0%");
    expect(progressLine(250, 1000)).toBe("Counting the days that change… 25%");
    expect(MOST_RECENT_LABEL).toBe("Keep the most recent 2,000 days");
    expect(overCapLine({ kind: "over-cap", added: 2500, total: 2500, cap: MAX_KEPT_DAYS, fitFromDay: 812 }, fmt)).toBe("That would keep 2,500 days, more than the 2,000 a world can hold. Keep only the most recent 2,000, or start on D812.");
    expect(overCapLine({ kind: "over-cap", added: 1, total: 2001, cap: MAX_KEPT_DAYS, fitFromDay: null }, fmt)).toBe("That would keep 2,001 days, more than the 2,000 a world can hold.");
    expect(upgradedNotice({ added: 12, trimmed: 0 }, true)).toBe("This world now runs the new weather generator (0.0.4). 12 days kept from the previous generator.");
    expect(upgradedNotice({ added: 2000, trimmed: 1 }, true)).toBe("This world now runs the new weather generator (0.0.4). 2,000 days kept from the previous generator. 1 day before them were left out.");
    expect(upgradedNotice({ added: 0, trimmed: 0 }, true)).toBe("This world now runs the new weather generator (0.0.4). No day needed keeping.");
    expect(upgradedNotice({ added: 0, trimmed: 0 }, false)).toBe("This world now runs the new weather generator (0.0.4). No days were kept.");
    expect(keptRowDesc({ count: 2, fromDay: 73, toDay: 146 }, fmt)).toBe("2 days kept from the previous generator (from D73 to D146). Editing a zone's climate does not change them.");
    expect(keptCalendarNote(1)).toBe("1 kept day stays on its day number and may now fall in another season.");
    expect(keptCalendarNote(1500)).toBe("1,500 kept days stay on their day numbers and may now fall in another season.");
  });
});

describe("the range (§17.2, §17.4 Q4)", () => {
  const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [], seasons: [] }, () => 400);

  test("the default start is one year before the current day", () => {
    expect(defaultStart(400, 365)).toBe(35);
    expect(defaultStart(400, 360)).toBe(40);
    expect(defaultStart(10, 0)).toBe(10 - 365); // a calendar that cannot say: a 365-day year
  });

  test("a start after the current day and a range over the read cap are refused with the reason", () => {
    expect(rangeProblem(400, 400, fmt)).toBeNull();
    expect(rangeProblem(401, 400, fmt)).toBe("The start is after the current day (D400). Choose a day on or before it.");
    expect(rangeProblem(400 - MAX_RANGE_DAYS + 1, 400, fmt)).toBeNull();
    expect(rangeProblem(400 - MAX_RANGE_DAYS, 400, fmt)).toBe("That is 3,661 days. Weather can be kept for at most 3,660 days at a time, the longest range Wadjet reads at once; choose a later start.");
  });

  test("the date box reads a date as the calendar writes it, or a day number (the Current day parser)", () => {
    expect(readStart(cal, "35", 400, fmt)).toEqual({ from: 35 });
    expect(readStart(cal, cal.format(35), 400, fmt)).toEqual({ from: 35 });
    expect(readStart(cal, "Year 2, day 1", 400, fmt)).toEqual({ from: 365 });
    expect(readStart(cal, "soon", 400, fmt)).toEqual({ problem: "Not a date this calendar writes, nor a whole day number." });
    expect(readStart(cal, "500", 400, fmt)).toEqual({ problem: "The start is after the current day (D400). Choose a day on or before it." });
  });
});

describe("the dialog's flow on the e2e world: count, then Keep and upgrade", () => {
  const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
  const zone = zoneFromPreset({ name: "Edgewater", preset: fjord, existingIds: new Set() }).zone;
  // the edge of a yearPhase window: day 73 is phase 0.2 exactly in a 365-day year, which 0.0.3 wraps an ulp low
  zone.modifiers = [{ id: "edge", when: { yearPhase: [0.2, 0.4] }, apply: [{ param: "temperature.mean", op: "offset", value: 4 }], tag: "edge" }];
  const seasons = [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Autumn", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ];
  const settings = () => migrateSettings({ worldSeed: "e2e-upgrade", generatorVersion: PREVIOUS_GENERATOR_VERSION, currentDayOrdinal: 400, calendar: { yearLength: 365, epochYear: 1, moons: [], seasons }, zones: [structuredClone(zone)] });
  const worldOf = (s: ReturnType<typeof settings>) => {
    const time = new TimeRegistry("internal");
    time.register(new InternalCalendar(s.calendar, () => s.currentDayOrdinal, undefined, s.generatorVersion === PREVIOUS_GENERATOR_VERSION ? "previous" : "current"));
    return new World(worldStateOf(s, s.generatorVersion === PREVIOUS_GENERATOR_VERSION ? "previous" : "current"), time);
  };

  test("the default range keeps the two window-edge days; after the upgrade they read the same and the row shows them", async () => {
    const s = settings();
    const before = worldOf(s);
    const edge = JSON.stringify(before.getReport(zone.id, { dayOrdinal: 73 }));
    const from = defaultStart(400, s.calendar.yearLength);
    const scan = await scanKeep(keepSourceOf(s, new InternalCalendar(s.calendar, () => 400)), [zone.id], from, 400, { tick: () => Promise.resolve() });
    if (scan.kind !== "done") throw new Error(scan.kind);
    expect(scan.days.map((d) => d.dayOrdinal)).toEqual([73, 146]);
    expect(countLine(scan)).toBe("2 days in 1 zone will be kept; the rest come out the same.");

    const up = upgradeWorld(s, scan.days);
    if (up.kind !== "ok") throw new Error("over cap");
    expect(up.settings.generatorVersion).toBe(GENERATOR_VERSION);
    expect(upgradedNotice(up, true)).toBe("This world now runs the new weather generator (0.0.4). 2 days kept from the previous generator.");
    const after = worldOf(up.settings);
    expect(after.mode).toBe("current");
    expect(JSON.stringify(after.getReport(zone.id, { dayOrdinal: 73 }))).toBe(edge);
    expect(keptSpan(up.settings)).toEqual({ count: 2, fromDay: 73, toDay: 146, zones: 1 });

    // Upgrade without keeping: the edge day moves
    const bare = upgradeWorld(s, []);
    if (bare.kind !== "ok") throw new Error("over cap");
    expect(JSON.stringify(worldOf(bare.settings).getReport(zone.id, { dayOrdinal: 73 }))).not.toBe(edge);
    expect(keptSpan(bare.settings)).toBeNull();
  });
});

describe("the Studio's legacy save asks about kept weather only when the calendar moves", () => {
  test("seasons or moons changed; a body id alone is not a change", () => {
    const cal = { seasons: [{ name: "Spring", from: 0 }], moons: [{ name: "Luna", cycleDays: 29.5, phaseAtEpoch: 0 }] };
    expect(legacyCalendarMoved(cal, structuredClone(cal))).toBe(false);
    expect(legacyCalendarMoved(cal, { ...cal, moons: [{ id: "luna", name: "Luna", cycleDays: 29.5, phaseAtEpoch: 0 }] })).toBe(false);
    expect(legacyCalendarMoved(cal, { ...cal, moons: [{ name: "Luna", cycleDays: 30, phaseAtEpoch: 0 }] })).toBe(true);
    expect(legacyCalendarMoved(cal, { ...cal, seasons: [{ name: "Spring", from: 0.1 }] })).toBe(true);
  });
});

describe("the mode a world runs, and the sync revert Notice (§17.5 items 7, 9)", () => {
  const w = (generatorVersion: string, activeTimeAdapter: string, definition?: unknown) => ({ generatorVersion, activeTimeAdapter, calendar: definition === undefined ? {} : { definition } });

  test("0.0.3 runs the previous generator except over a calendar definition the world runs", () => {
    expect(worldMode(w(PREVIOUS_GENERATOR_VERSION, "internal"))).toBe("previous");
    // a definition stored but not running does not flip the built-in calendar
    expect(worldMode(w(PREVIOUS_GENERATOR_VERSION, "internal", "BEGIN:VCALENDAR"))).toBe("previous");
    expect(worldMode(w(PREVIOUS_GENERATOR_VERSION, "fantasy-calendar"))).toBe("previous");
    // active "seshat" with nothing stored: no definition runs (no weather at all), so the stamp decides
    expect(worldMode(w(PREVIOUS_GENERATOR_VERSION, "seshat"))).toBe("previous");
    expect(worldMode(w(PREVIOUS_GENERATOR_VERSION, "seshat", "BEGIN:VCALENDAR"))).toBe("current");
    expect(worldMode(w(GENERATOR_VERSION, "internal"))).toBe("current");
    expect(worldMode(w("wadjet-gen/0.0.2", "internal"))).toBe("current");
  });

  test("the Notice names a revert, and on a definition says the current generator stays", () => {
    expect(syncRevertNotice(w(GENERATOR_VERSION, "internal"), w(PREVIOUS_GENERATOR_VERSION, "internal"))).toBe(SYNC_REVERT_NOTICE);
    expect(syncRevertNotice(w(GENERATOR_VERSION, "seshat", "x"), w(PREVIOUS_GENERATOR_VERSION, "seshat", "x"))).toBe(
      "Another device moved this world back to the previous weather generator. This world runs on a calendar definition, which the previous generator never runs on, so its weather still comes from the current one (0.0.4).",
    );
    expect(syncRevertNotice(w(PREVIOUS_GENERATOR_VERSION, "internal"), w(PREVIOUS_GENERATOR_VERSION, "internal"))).toBeNull();
    expect(syncRevertNotice(w(PREVIOUS_GENERATOR_VERSION, "internal"), w(GENERATOR_VERSION, "internal"))).toBeNull();
  });
});

describe("review fixes", () => {
  test("nothing fit under the cap; the legacy rows' offer; what a legacy edit moves", () => {
    expect(upgradedNotice({ added: 0, trimmed: 2400 }, true)).toBe("This world now runs the new weather generator (0.0.4). None of the 2,400 days fit under the cap, so none were kept.");
    expect(keptChangedNote(3)).toBe("You changed the calendar. 3 kept days stay on their day numbers and may now fall in another season.");
    const cal = { yearLength: 365, seasons: [{ name: "Spring", from: 0 }], moons: [{ name: "Luna", cycleDays: 29.5, phaseAtEpoch: 0, phases: [{ name: "New", at: 0 }] }] };
    const key = legacyCalendarKey(cal);
    const renamed = { ...cal.moons[0]!, name: "Selene" };
    const relabelled = { ...cal.moons[0]!, phases: [] };
    expect(legacyCalendarKey({ ...cal, moons: [renamed] })).toBe(key); // a rename
    expect(legacyCalendarKey({ ...cal, moons: [relabelled] })).toBe(key); // a phase label
    expect(legacyCalendarKey({ ...cal, moons: [{ ...cal.moons[0]!, cycleDays: 30 }] })).not.toBe(key);
    expect(legacyCalendarKey({ ...cal, yearLength: 360 })).not.toBe(key);
    expect(legacyCalendarKey({ ...cal, seasons: [] })).not.toBe(key);
  });
});
