/**
 * Golden master for the calendar path (Seshat P0 step 0, docs/SESHAT-v0.md §8.1).
 *
 * The generator golden (golden-gen.ts) runs `gregorianTime` with no moons,
 * seasons, eras, spells or modifiers, so it cannot see a calendar change. This
 * one goes through the real `InternalCalendar` → `World` path (and one
 * third-party adapter) with every calendar-reading feature switched on, and
 * pins each day's TimeContext and WeatherReport EXACTLY (no tolerance): a
 * change that moves a float by one ulp shows up as a diff.
 *
 * Captured on main before any Seshat code; P0 regenerates it once with an
 * enumerated diff, and P1–P3 must leave it byte-identical.
 */
import type { Era, Modifier, ZoneProfile } from "../../src/core/types";
import type { WeatherReport } from "../../src/core/report";
import { TimeRegistry, type TimeAdapter, type TimeContext } from "../../src/plugin/time/adapter";
import { InternalCalendar } from "../../src/plugin/time/internal";
import type { InternalCalendarConfig } from "../../src/plugin/settings";
import { World } from "../../src/plugin/world";
import { PRESETS } from "../../src/generated/presets";
import { makeAdapter } from "../fixtures/api/third-party-calendar";

export const CAL_SEED = "golden-cal-seed";

const FOUR = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

/** Moons with a default period, an odd decimal period with a negative epoch phase, and an epoch phase >= 1. */
export const MOONS_365: InternalCalendarConfig["moons"] = [
  { name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 },
  { name: "Ash", cycleDays: 7.3, phaseAtEpoch: -0.25 },
  { name: "Ember", cycleDays: 33, phaseAtEpoch: 1.2 },
];
export const MOONS_400: InternalCalendarConfig["moons"] = [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0.5 }];

const ERAS: Era[] = [
  { name: "Thaw", from: 3, to: 5 },
  { name: "Ash", from: -10, to: -8, apply: [{ param: "temperature.mean", op: "offset", value: -2 }] },
];

/** Every predicate boundary below that reads a moon phase; the flip scan checks these. */
export const MOON_BOUNDARIES = [0, 0.02, 0.05, 0.4, 0.5, 0.6, 0.95];

/** One modifier of each calendar-reading kind. `moon` is the carrier moon's name in this world. */
function modifiers(moon: string): Modifier[] {
  return [
    { id: "moon-zero", when: { moon: { name: moon, phase: [0, 0.02] } }, apply: [], tag: "moon-zero" },
    { id: "moon-new", when: { moon: { name: moon, phase: [0.95, 0.05] } }, apply: [], tag: "moon-new" },
    { id: "monsoon", when: { yearPhase: [0.45, 0.72] }, apply: [{ param: "precipitation.pwd", op: "scale", value: 2.5 }, { param: "cloud.dry", op: "offset", value: 0.25 }], tag: "monsoon" },
    { id: "doy", when: { dayOfYear: [10, 20] }, apply: [], tag: "doy" },
    {
      id: "spring-tide",
      when: { moon: { name: moon, phase: [0.4, 0.6] } },
      mods: [{ source: "season:Summer", amount: 0.5 }],
      apply: [
        { param: "wind.speed", op: "offset", value: 14, envelope: [[0.4, 0], [0.5, 1], [0.6, 0]] },
        { param: "cloud.dry", op: "offset", value: 0.2, envelope: [[0.4, 0], [0.5, 1], [0.6, 0]] },
      ],
      tag: "spring-tide",
    },
    { id: "moon-fog", when: { moon: { name: moon, phase: [0.95, 0.05] } }, spell: { meanStartsPerYear: 3, meanDurationDays: 5 }, apply: [{ param: "humidity.dry", op: "clamp", min: 0.95 }], tag: "moon-fog" },
    { id: "thaw-winter", when: { all: [{ tag: "season:Winter" }, { tag: "era:Thaw" }] }, spell: { meanStartsPerYear: 12, meanDurationDays: 4 }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.5 }], tag: "thaw-winter" },
    { id: "summer-spell", when: { tag: "season:Summer" }, spell: { meanStartsPerYear: 1, meanDurationDays: 10 }, apply: [{ param: "cloud.dry", op: "offset", value: -0.2 }], tag: "summer-spell" },
  ] as Modifier[];
}

const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;

function zone(id: string, moon: string, flip: boolean): ZoneProfile {
  return { id, name: id, schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: modifiers(moon), ...(flip ? { flipSeasons: true } : {}) };
}

interface WorldSpec {
  id: string;
  adapter: () => TimeAdapter;
  eras: Era[];
  zones: ZoneProfile[];
  days: number[];
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Far samples, including multiples of 2953 (29.53-day moon with phase 0 is exactly new there). */
const FAR = [2953, -2953, 29530, 295300, -295300, 2953000, 1_000_003, -1_234_567, 5_000_000, -5_000_000, 9_999_999, -9_999_999];

export const WORLDS: WorldSpec[] = [
  {
    id: "internal-365",
    adapter: () => new InternalCalendar({ yearLength: 365, epochYear: 1, moons: MOONS_365, seasons: FOUR }, () => 0),
    eras: ERAS,
    zones: [zone("north", "Sable", false), zone("south", "Sable", true)],
    days: [...range(-40, 40), ...range(360, 370), ...range(1003, 1100), ...range(-3290, -3280), ...FAR], // 1003..1094 = Winter of year 3, inside era Thaw
  },
  {
    id: "internal-400",
    adapter: () => new InternalCalendar({ yearLength: 400, epochYear: 1, moons: MOONS_400, seasons: FOUR }, () => 0),
    eras: [],
    zones: [zone("north", "Sable", false)],
    days: [...range(-10, 10), ...range(100, 200), ...range(395, 405), ...FAR], // 100..199 = Summer of a 400-day year
  },
  {
    id: "almanac",
    adapter: makeAdapter,
    eras: ERAS,
    zones: [zone("north", "Ember", false)],
    days: [...range(-10, 10), ...range(200, 300), ...range(1195, 1205), ...range(1595, 1605), ...FAR], // 1600 = leap day of the 401-day year
  },
];

export interface GoldenCalDay {
  day: number;
  time: TimeContext;
  /** the report without provenance (recorded once per zone) */
  report: Omit<WeatherReport, "provenance">;
}
export interface GoldenCalZone {
  zoneId: string;
  provenance: WeatherReport["provenance"];
  days: GoldenCalDay[];
}
export interface GoldenCalWorld {
  id: string;
  calendarHash: string;
  zones: GoldenCalZone[];
}
export interface GoldenCal {
  seed: string;
  worlds: GoldenCalWorld[];
}

export function buildGoldenCal(): GoldenCal {
  return {
    seed: CAL_SEED,
    worlds: WORLDS.map((w) => {
      const adapter = w.adapter();
      const time = new TimeRegistry(adapter.id);
      time.register(adapter);
      const world = new World({ seed: CAL_SEED, zones: w.zones, eras: w.eras, overrides: [] }, time);
      return {
        id: w.id,
        calendarHash: world.calendarHash(),
        zones: w.zones.map((z) => {
          let provenance: WeatherReport["provenance"] | undefined;
          const days = w.days.map((day) => {
            const { provenance: p, ...report } = world.getReport(z.id, { dayOrdinal: day });
            provenance ??= p;
            return { day, time: world.timeAt(day, z.id), report };
          });
          return { zoneId: z.id, provenance: provenance!, days };
        }),
      };
    }),
  };
}

/** Exact structural diff (no float tolerance). Paths read like `internal-365/north/day 12/time.moons.0.phase`. */
export function compareGoldenCal(stored: GoldenCal, fresh: GoldenCal): string[] {
  const out: string[] = [];
  walk("", JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(fresh)), out);
  return out;
}

function walk(path: string, a: unknown, b: unknown, out: string[]): void {
  if (Object.is(a, b)) return;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    out.push(`${label(path)}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) walk(path ? `${path}.${k}` : k, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], out);
}

/** Turn `worlds.0.zones.1.days.7.report.x` into something a person can read. */
function label(path: string): string {
  return path.replace(/^worlds\.(\d+)/, (_, i: string) => WORLDS[Number(i)]?.id ?? `world ${i}`).replace(/\.zones\.(\d+)/, ".zone $1").replace(/\.days\.(\d+)/, ".day#$1");
}
