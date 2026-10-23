/**
 * The Upgrade dialog's words and checks (docs/SESHAT-v0.md §17.2 "UX", bead wadjet-9lc step 3), and the
 * kept-weather lines the settings tab and the calendar dialogs show. Pure: no Obsidian imports; the modals
 * in upgrade-modals.ts put these on screen.
 */
import { canonicalJson } from "../core/profile";
import { GENERATOR_VERSION, modeFor, PREVIOUS_GENERATOR_VERSION, type GeneratorMode } from "../core/version";
import { parseDayField, validateDayField, type DayText } from "./current-day";
import type { KeepCommit, KeepScan } from "./keep";
import { MAX_KEPT_DAYS } from "./keep";
import { MAX_RANGE_DAYS } from "./world";

/** "0.0.4" for "wadjet-gen/0.0.4". */
export const shortVersion = (v: string): string => v.replace(/^wadjet-gen\//, "");
const n = (x: number): string => x.toLocaleString("en");
const days = (x: number): string => `${n(x)} ${x === 1 ? "day" : "days"}`;

/** What the upgrade changes, in one sentence (the four categories of §17, in a worldbuilder's words). */
export const UPGRADE_CHANGES =
  "The new generator changes a few days: days on the exact edge of a modifier's season or moon window, moon phases on this world's own calendar (tiny shifts that can tip a moon condition), and how often spells tied to an era or a weather regime start.";

/** The load Notice on a world that runs the previous generator (§17.2). */
export const PREVIOUS_LOAD_NOTICE = `Wadjet has a new weather generator (${shortVersion(GENERATOR_VERSION)}). This world keeps the old one (${shortVersion(PREVIOUS_GENERATOR_VERSION)}), so its weather stays as you saw it, until you upgrade it in Settings → World → Generator.`;

/** The Generator row on a world that runs the previous generator. */
export const PREVIOUS_GENERATOR_DESC = `This world runs the previous weather generator (${shortVersion(PREVIOUS_GENERATOR_VERSION)}), so its weather is unchanged. Upgrading changes some days; you can keep the days you have already used.`;

/** A synced data.json moved the world from the current generator back to the previous one (§17.5 item 7). */
export const SYNC_REVERT_NOTICE = "Another device moved this world back to the previous weather generator.";

/** The same, on a world whose active calendar is a definition: it keeps the current generator (§17.5 item 9). */
export const SYNC_REVERT_DEFINITION_NOTICE = `${SYNC_REVERT_NOTICE} This world runs on a calendar definition, which the previous generator never runs on, so its weather still comes from the current one (${shortVersion(GENERATOR_VERSION)}).`;

/** The world as the mode reads it: its stamp, its active calendar, and the definition it stores. */
export interface ModeSource {
  generatorVersion: string;
  activeTimeAdapter: string;
  calendar: { definition?: unknown };
}

/**
 * The generator a world runs (§17 R2, §17.5 item 9): the previous one only when it is stamped with the previous
 * version and does not run on a calendar definition. A world stamped 0.0.3 on a definition (a synced revert from
 * an older device) runs the current generator; on the built-in calendar or another plugin's it runs the previous.
 */
export function worldMode(s: ModeSource): GeneratorMode {
  if (s.activeTimeAdapter === "seshat" && typeof s.calendar.definition === "string") return "current";
  return modeFor(s.generatorVersion);
}

/** The Notice after a synced data.json, or null: the stamp moved back from the current generator to the previous one. */
export function syncRevertNotice(before: ModeSource, after: ModeSource): string | null {
  if (modeFor(before.generatorVersion) !== "current" || modeFor(after.generatorVersion) !== "previous") return null;
  return worldMode(after) === "previous" ? SYNC_REVERT_NOTICE : SYNC_REVERT_DEFINITION_NOTICE;
}

/** Shown when the Upgrade dialog finds the world already upgraded (a synced data.json while it was open). */
export const ALREADY_UPGRADED = "This world was already upgraded, on another device.";

/** Why a calendar definition waits for the upgrade (§17.5 item 9). */
export const UPGRADE_FIRST = "Upgrade the generator first. This world runs the previous weather generator, and the previous generator never runs on a calendar definition.";

/** The default start of the kept range: one year before the current day. */
export function defaultStart(today: number, yearLength: number): number {
  const len = Number.isSafeInteger(yearLength) && yearLength > 0 ? yearLength : 365;
  return today - len;
}

/** The range check: a message for a start the dialog refuses, or null. */
export function rangeProblem(from: number, today: number, format: (d: number) => string): string | null {
  if (from > today) return `The start is after the current day (${format(today)}). Choose a day on or before it.`;
  const span = today - from + 1;
  if (span > MAX_RANGE_DAYS) return `That is ${days(span)}. Weather can be kept for at most ${n(MAX_RANGE_DAYS)} days at a time, the longest range Wadjet reads at once; choose a later start.`;
  return null;
}

/** The typed start read: the day, or the message to show under the box. */
export function readStart(cal: DayText, text: string, today: number, format: (d: number) => string): { from: number } | { problem: string } {
  const bad = validateDayField(cal, text);
  if (bad !== undefined) return { problem: bad };
  const from = parseDayField(cal, text)!;
  const problem = rangeProblem(from, today, format);
  return problem === null ? { from } : { problem };
}

/** The count line under the box once a scan is done. */
export function countLine(scan: Extract<KeepScan, { kind: "done" }>): string {
  const kept = scan.days.length;
  const zones = scan.zones.filter((z) => z.kept > 0).length;
  const base = kept === 0 ? "No day in this range changes, so there is nothing to keep; every day comes out the same." : `${days(kept)} in ${n(zones)} ${zones === 1 ? "zone" : "zones"} will be kept; the rest come out the same.`;
  if (scan.unstorable === 0) return base;
  return `${base} ${days(scan.unstorable)} cannot be stored and will show the new generator's weather.`;
}

/** The progress line while counting. */
export function progressLine(done: number, total: number): string {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  return `Counting the days that change… ${pct}%`;
}

/** The line past the cap (§17.5 item 6): the count, and where a start would fit. */
export function overCapLine(c: Extract<KeepCommit, { kind: "over-cap" }>, format: (d: number) => string): string {
  const fit = c.fitFromDay === null ? "" : ` Keep only the most recent ${n(c.cap)}, or start on ${format(c.fitFromDay)}.`;
  return `That would keep ${days(c.total)}, more than the ${n(c.cap)} a world can hold.${fit}`;
}

/** The label of the over-cap choice. */
export const MOST_RECENT_LABEL = `Keep the most recent ${n(MAX_KEPT_DAYS)} days`;

/** The Notice after an upgrade. */
export function upgradedNotice(r: { added: number; trimmed: number }, kept: boolean): string {
  const head = `This world now runs the new weather generator (${shortVersion(GENERATOR_VERSION)}).`;
  if (!kept) return `${head} No days were kept.`;
  if (r.added === 0 && r.trimmed > 0) return `${head} None of the ${n(r.trimmed)} days fit under the cap, so none were kept.`;
  if (r.added === 0) return `${head} No day needed keeping.`;
  const trimmed = r.trimmed > 0 ? ` ${days(r.trimmed)} before them were left out.` : "";
  return `${head} ${days(r.added)} kept from the previous generator.${trimmed}`;
}

/** The Kept weather row (§17.2). */
export function keptRowDesc(span: { count: number; fromDay: number; toDay: number }, format: (d: number) => string): string {
  return `${days(span.count)} kept from the previous generator (from ${format(span.fromDay)} to ${format(span.toDay)}). Editing a zone's climate does not change them.`;
}

/** The legacy calendar rows' offer after an edit (§17.5 item 8). */
export function keptChangedNote(count: number): string {
  return `You changed the calendar. ${keptCalendarNote(count)}`;
}

/**
 * What a legacy calendar edit can move in kept weather: the year length, the seasons, and each moon's orbit. A moon
 * renamed (its references follow it) or a phase label edited is not a change.
 */
export function legacyCalendarKey(c: { yearLength: number; seasons: unknown; moons: ReadonlyArray<{ cycleDays: number; phaseAtEpoch?: number }> }): string {
  return JSON.stringify([c.yearLength, canonicalJson(c.seasons), c.moons.map((m) => [m.cycleDays, m.phaseAtEpoch ?? 0])]);
}

/** The calendar dialogs' line beside the pin warning (§17.5 item 8). */
export function keptCalendarNote(count: number): string {
  return count === 1 ? "1 kept day stays on its day number and may now fall in another season." : `${n(count)} kept days stay on their day numbers and may now fall in another season.`;
}

/** Whether a Studio save moves the legacy calendar's seasons or moons (body ids aside: the legacy calendar stores none). */
export function legacyCalendarMoved(stored: { seasons: unknown; moons: ReadonlyArray<object> }, draft: { seasons: unknown; moons: ReadonlyArray<object> }): boolean {
  const moons = (m: ReadonlyArray<object>) => m.map((x) => canonicalJson(Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"))));
  return canonicalJson(stored.seasons) !== canonicalJson(draft.seasons) || JSON.stringify(moons(stored.moons)) !== JSON.stringify(moons(draft.moons));
}
