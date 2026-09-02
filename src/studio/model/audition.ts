/**
 * The audition: one seeded year of daily records + reports for a zone draft,
 * derived the same way `World` builds a real roll (PLAN §5.1, SPEC §3.5, §6).
 * The regimes lane reads `record.regime` per day off this; the audition
 * strip shows the reports themselves. No Obsidian imports — the time adapter
 * is passed in (PLAN D3).
 *
 * Salting (SPEC §3.5): the "re-roll" button never touches the world seed.
 * `salt: 0` is the real roll — byte-for-byte what `World.getReport` would
 * show for the same zone/seed/year/calendar. Any other salt appends
 * `|audition:<salt>` to the seed handed to `createGenerator`, so a re-roll
 * previews a different draw without disturbing the persisted weather. Pins
 * (`overrides`) are keyed on the real `(zoneId, dayOrdinal)` and applied
 * regardless of salt — a re-roll keeps them.
 */
import { eraModifiers, erasHash, withEraTags, yearOf } from "../../core/eras";
import type { DailyRecord } from "../../core/generator";
import { canonicalJson, createGenerator, profileHash, validateProfile, type ValidationIssue } from "../../core/profile";
import { buildReport, overrideKey, type Override, type WeatherReport } from "../../core/report";
import { hash32 } from "../../core/rng";
import type { Era, Regime, ZoneProfile } from "../../core/types";
import type { TimeAdapter, TimeContext } from "../../plugin/time/adapter";
import { flipSeasonTags } from "../../plugin/time/seasons";

export interface AuditionInput {
  zone: ZoneProfile;
  eras: readonly Era[];
  seed: string;
  adapter: TimeAdapter;
  year: number;
  /** 0 = the real roll (the world seed, unmodified); any other value previews `seed + "|audition:" + salt`. */
  salt: number;
  overrides?: readonly Override[];
}

export interface AuditionDay {
  dayOrdinal: number;
  dayOfYear: number;
  record: DailyRecord;
  report: WeatherReport;
  /**
   * Ids of the daily modifiers that fired on this day, from a second (pure)
   * `engine.forDay(dayOrdinal, record.regime)` — `DailyRecord` does not carry
   * them and adding them there would move the goldens (PLAN §0.1, Spans).
   * `spans.ts spellRuns` reads this to draw a spell's rolled runs.
   */
  active: string[];
  pinned: boolean;
  time: TimeContext;
}

export interface AuditionYear {
  days: AuditionDay[];
  /** dayOfYear, inclusive */
  regimeRuns: Array<{ regime: string; from: number; to: number }>;
  key: string;
  issues: ValidationIssue[];
}

/**
 * Identity of the pins that can change this zone's reports. Overrides are an
 * input to `rollYear` (they are applied to every report), so a cache key that
 * ignored them would hand back a year with the wrong `pinned` marks after a
 * right-click pin. Only this zone's pins count; another zone's cannot show here.
 */
function overridesHash(zoneId: string, overrides: readonly Override[] | undefined): string {
  const mine = (overrides ?? []).filter((o) => o.zoneId === zoneId);
  if (mine.length === 0) return "nopins";
  const j = canonicalJson([...mine].sort((a, b) => a.dayOrdinal - b.dayOrdinal));
  return `${hash32(j, 0x57414a45).toString(16)}:${mine.length.toString(16)}`;
}

/** Cache key: everything that can change what a year's roll looks like. */
export function auditionKey(i: AuditionInput): string {
  const flip = i.zone.flipSeasons === true ? "flip" : "noflip";
  return `${i.seed}|${i.salt}|${profileHash(i.zone)}|${i.adapter.configHash()}|${erasHash(i.eras)}|${flip}|${i.year}|${overridesHash(i.zone.id, i.overrides)}`;
}

/**
 * How many rolled years the studio keeps, across every surface that rolls.
 *
 * A year is ~365 records. Sixteen covers undo/redo, salt flipping and a pan of
 * a few years without a re-roll, on either side of the audition strip's own
 * year.
 */
const ROLL_CACHE_MAX = 16;

/**
 * The studio's one rolled-year cache (PLAN §0.1 stabilization note).
 *
 * The audition strip, the channel rows, the day card and the regimes row all
 * roll the same years through the same `auditionKey`. They used to keep three
 * private caches keyed identically, which agreed on identity but stored the
 * same year three times and made a cold draft cost three rolls. This is that
 * one cache, and `rollCached` is the only door to it.
 *
 * Memoising a pure function keeps this module pure in the sense PLAN D3 means:
 * no DOM, no Obsidian, and the same input still gives the same output.
 */
const ROLL_CACHE = new Map<string, AuditionYear>();

/** `rollYear`, memoised in the studio's one bounded cache; insertion order is eviction order. */
export function rollCached(input: AuditionInput): AuditionYear {
  const year = rollYear(input, ROLL_CACHE);
  while (ROLL_CACHE.size > ROLL_CACHE_MAX) {
    const oldest = ROLL_CACHE.keys().next();
    if (oldest.done === true) break;
    ROLL_CACHE.delete(oldest.value);
  }
  return year;
}

/** True when `input`'s year is already rolled — a repaint that costs nothing. */
export function isRolled(input: AuditionInput): boolean {
  return ROLL_CACHE.has(auditionKey(input));
}

/** The calendar-side identity a report's provenance carries — same formula as `World.calendarHash()`. */
function calendarHashFor(adapter: TimeAdapter, eras: readonly Era[]): string {
  const h = adapter.configHash();
  return eras.length ? `${h}+${erasHash(eras)}` : h;
}

/**
 * The dayOrdinal of `${year}-1`: the adapter's own parser when it has one,
 * else a bounded scan. Starts from an estimate at `(year - 1) * yearLength`
 * (yearLength read from an arbitrary probe context), walks day-by-day toward
 * the year boundary, then walks back to the year's first day.
 */
export function firstDayOfYear(adapter: TimeAdapter, year: number): number {
  const parsed = adapter.parse?.(`${year}-1`);
  if (parsed !== null && parsed !== undefined) return parsed;

  const probeYearLength = Math.max(1, adapter.toContext(0).yearLength);
  const inYear = (d: number) => yearOf(adapter.toContext(d)) === year;

  let d = Math.round((year - 1) * probeYearLength);
  const maxSteps = probeYearLength * 2 + 10;
  for (let steps = 0; steps < maxSteps && !inYear(d); steps++) {
    d += yearOf(adapter.toContext(d)) < year ? 1 : -1;
  }
  if (!inYear(d)) throw new RangeError(`firstDayOfYear: could not find year ${year} near day ${d}`);
  while (inYear(d - 1)) d--;
  return d;
}

/**
 * Runs of `record.regime` across consecutive days (SPEC §6 "how long" —
 * grouped, not per-day). A run breaks on a regime change or a gap in
 * `dayOfYear`. `days` must already be in ascending `dayOfYear` order.
 */
export function regimeRuns(days: readonly Pick<AuditionDay, "dayOfYear" | "record">[]): AuditionYear["regimeRuns"] {
  const runs: AuditionYear["regimeRuns"] = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && last.regime === day.record.regime && day.dayOfYear === last.to + 1) {
      last.to = day.dayOfYear;
    } else {
      runs.push({ regime: day.record.regime, from: day.dayOfYear, to: day.dayOfYear });
    }
  }
  return runs;
}

/** SPEC §6 "share of the year" = weight × dwell, normalised to sum 1; 0 for every regime when all weights are zero. */
export function shareOfYear(regimes: readonly Regime[]): Array<{ id: string; share: number }> {
  const weighted = regimes.map((r) => ({ id: r.id, w: r.weight * r.meanDurationDays }));
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  return weighted.map((x) => ({ id: x.id, share: total > 0 ? x.w / total : 0 }));
}

/**
 * One seeded year through the whole path (SPEC §3.5): builds the same
 * generator `World` would (era tags, hemisphere flip via `flipSeasons`, era
 * modifiers), rolls every day of `i.year`, and builds each day's report with
 * `i.overrides` applied exactly as `World.getReport` applies them (a
 * `Map<overrideKey, patch>` handed to `buildReport`). Memoised on
 * `auditionKey(i)` in the optional `cache`.
 *
 * When `i.zone` fails validation with errors, returns an empty year (with
 * `issues` explaining why) instead of throwing — a draft mid-edit is
 * expected to be transiently invalid.
 */
export function rollYear(i: AuditionInput, cache?: Map<string, AuditionYear>): AuditionYear {
  const key = auditionKey(i);
  const cached = cache?.get(key);
  if (cached) return cached;

  const issues = validateProfile(i.zone);
  if (issues.some((x) => x.level === "error")) {
    const result: AuditionYear = { days: [], regimeRuns: [], key, issues };
    cache?.set(key, result);
    return result;
  }

  const flip = i.zone.flipSeasons === true;
  const seasons = flip ? (i.adapter.describe?.()?.seasons ?? []) : [];
  const timeOf = (d: number): TimeContext => {
    const tagged = withEraTags(i.eras, i.adapter.toContext(d));
    return seasons.length ? (flipSeasonTags(tagged, seasons) as TimeContext) : tagged;
  };

  const genSeed = i.salt !== 0 ? `${i.seed}|audition:${i.salt}` : i.seed;
  const { generator, engine } = createGenerator(i.zone, genSeed, timeOf, eraModifiers(i.eras));

  const profHash = profileHash(i.zone);
  const calendarHash = calendarHashFor(i.adapter, i.eras);
  const overrideMap = new Map((i.overrides ?? []).map((o) => [overrideKey(o.zoneId, o.dayOrdinal), o.patch]));

  const firstDay = firstDayOfYear(i.adapter, i.year);
  const maxDays = Math.max(1, Math.round(i.adapter.toContext(firstDay).yearLength)) * 2 + 10;
  const days: AuditionDay[] = [];
  for (let d = firstDay, n = 0; n < maxDays; d++, n++) {
    const time = timeOf(d);
    if (yearOf(time) !== i.year) break;
    const record = generator.day(d);
    const report = buildReport(record, i.zone.id, { seed: genSeed, provenance: { profileHash: profHash, calendarHash }, overrides: overrideMap });
    const dayOfYear = time.dayOfYear ?? d - firstDay;
    // `engine.forDay` is pure and deterministic (PLAN §0.1): re-invoking it with
    // the regime the generator settled on reproduces exactly the set the roll
    // saw, with no second roll and no change to `DailyRecord`.
    const active = engine.forDay(d, record.regime).active;
    days.push({ dayOrdinal: d, dayOfYear, record, report, active, pinned: overrideMap.has(overrideKey(i.zone.id, d)), time });
  }

  const result: AuditionYear = { days, regimeRuns: regimeRuns(days), key, issues };
  cache?.set(key, result);
  return result;
}
