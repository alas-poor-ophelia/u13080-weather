/**
 * Kept weather (docs/SESHAT-v0.md §17.2 "Frozen days", bead wadjet-9lc step 2).
 *
 * Before a world on the previous generator upgrades, the days it has already
 * used can be kept: each (zone, day) whose reports differ between the two
 * generators stores the previous generator's day record and provenance in
 * `settings.frozen`. The World reads a kept day's record in place of the
 * generated one (pins still apply on top); see world.ts.
 *
 * `settings.frozen` is stored as it was found and never rewritten on load: what
 * Wadjet cannot read (a value that is not a list, an entry of a later shape, one
 * broken by a hand edit) is carried through every save untouched, in the list,
 * and not used. `readKept` gives the entries that are used; every writer here
 * keeps the unreadable ones.
 *
 * Pure: no Obsidian imports. The flow for the Upgrade dialog is
 * `keepSourceOf` → `scanKeep` (the count, chunked, with progress and Cancel)
 * → `upgradeWorld(settings, scan.days)` (refuses past MAX_KEPT_DAYS unless
 * asked to keep the most recent days that fit).
 */
import type { DailyRecord, PrecipType } from "../core/generator";
import { profileHash } from "../core/profile";
import { buildReport, overrideKey, type DescriptorBands } from "../core/report";
import { GENERATOR_VERSION, type GeneratorMode } from "../core/version";
import type { WadjetSettings } from "./settings";
import { TimeRegistry, type TimeAdapter } from "./time/adapter";
import { InternalCalendar } from "./time/internal";
import { MAX_RANGE_DAYS, World, type WorldState } from "./world";

/** One kept day: the previous generator's record for (zone, day), and the provenance it was made under. */
export interface FrozenDay {
  zoneId: string;
  dayOrdinal: number;
  record: DailyRecord;
  provenance: { generatorVersion: string; calendarHash: string; profileHash: string };
}

/** Most kept days a world may hold (§17.5 item 6); entries of zones that no longer exist do not count. */
export const MAX_KEPT_DAYS = 2000;
/** Days per zone generated between yields to the UI. */
export const KEEP_CHUNK_DAYS = 250;

// --- the stored form ----------------------------------------------------------

const PRECIP_TYPES: ReadonlySet<string> = new Set<PrecipType>(["none", "drizzle", "rain", "sleet", "snow"]);
const NUMBER_FIELDS = ["yearPhase", "precipMm", "tempMean", "tempHigh", "tempLow", "tempResidual", "humidity", "cloudCover", "windSpeedKph", "windDirectionDeg"] as const;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored record the report layer can run on: every DailyRecord field with its type, numbers finite, the day matching its entry. */
function isRecord(v: unknown, dayOrdinal: number): v is DailyRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.dayOrdinal !== dayOrdinal) return false;
  if (!NUMBER_FIELDS.every((k) => finite(r[k]))) return false;
  if (typeof r.regime !== "string" || typeof r.wet !== "boolean" || typeof r.calm !== "boolean") return false;
  if (typeof r.precipType !== "string" || !PRECIP_TYPES.has(r.precipType)) return false;
  return Array.isArray(r.tags) && r.tags.every((t) => typeof t === "string");
}

/** A record as data.json will give it back (a JSON round trip), or null when that would not read as a record (a non-finite number becomes null). */
export function storedForm(rec: DailyRecord): DailyRecord | null {
  const back: unknown = JSON.parse(JSON.stringify(rec));
  return isRecord(back, rec.dayOrdinal) ? back : null;
}

/** Does a stored entry parse as a kept day? */
export function isFrozenDay(v: unknown): v is FrozenDay {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.zoneId !== "string" || e.zoneId === "" || typeof e.dayOrdinal !== "number" || !Number.isSafeInteger(e.dayOrdinal)) return false;
  const p = e.provenance as Record<string, unknown> | null | undefined;
  if (typeof p !== "object" || p === null || typeof p.generatorVersion !== "string" || typeof p.calendarHash !== "string" || typeof p.profileHash !== "string") return false;
  return isRecord(e.record, e.dayOrdinal);
}

/** The stored kept weather split: `days` are used; `unread` (a whole value that is not a list, or entries) is carried, not used. */
export interface KeptStore {
  days: FrozenDay[];
  unread: unknown[];
}

const parsed = new WeakMap<object, KeptStore>();

/**
 * The stored `settings.frozen` read: absent is none; a value that is not a list is one unreadable item; a list's
 * entries split into readable and unreadable. The same stored list gives the same result object (cached).
 */
export function readKept(stored: unknown): KeptStore {
  if (stored === undefined) return { days: [], unread: [] };
  if (!Array.isArray(stored)) return { days: [], unread: [stored] };
  const hit = parsed.get(stored);
  if (hit) return hit;
  const days: FrozenDay[] = [];
  const unread: unknown[] = [];
  for (const e of stored as unknown[]) (isFrozenDay(e) ? days : unread).push(e);
  const out = { days, unread };
  parsed.set(stored, out);
  return out;
}

/** The value to store: `days`, then the stored value's unreadable items as they were (a non-list value becomes the list's last item). */
export function writeKept(stored: unknown, days: readonly FrozenDay[]): unknown[] {
  return [...days, ...readKept(stored).unread];
}

/**
 * The repair message for migrateSettings, or null when everything stored is readable. Nothing is removed: what
 * Wadjet cannot read stays in data.json as it was, and is not used.
 */
export function keptRepair(stored: unknown): string | null {
  if (stored === undefined) return null;
  if (!Array.isArray(stored)) return `The kept weather was ${short(stored)}, not a list Wadjet can read. It is left as it is in data.json and not used, so no day shows kept weather.`;
  const n = readKept(stored).unread.length;
  if (n === 0) return null;
  return `${n} kept weather ${n === 1 ? "day is" : "days are"} not readable by this version of Wadjet. ${n === 1 ? "It is" : "They are"} left as ${n === 1 ? "it is" : "they are"} in data.json and not used, so ${n === 1 ? "that day shows" : "those days show"} the current generator's weather.`;
}

function short(v: unknown): string {
  const text = typeof v === "string" ? JSON.stringify(v) : (JSON.stringify(v) ?? `a ${typeof v}`);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** `existing` with every entry of `add` in place of the entry for the same (zone, day): replaced, never appended twice. */
export function mergeKept(existing: readonly FrozenDay[], add: readonly FrozenDay[]): FrozenDay[] {
  const by = new Map<string, FrozenDay>();
  for (const e of existing) by.set(overrideKey(e.zoneId, e.dayOrdinal), e);
  for (const e of add) by.set(overrideKey(e.zoneId, e.dayOrdinal), e);
  return [...by.values()].sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : a.dayOrdinal - b.dayOrdinal));
}

/** The stored kept weather without `zoneId`'s days (a zone deleted, or created with a used id); the same value when it has none. */
export function dropKeptZone(stored: unknown, zoneId: string): unknown {
  const { days } = readKept(stored);
  return days.some((f) => f.zoneId === zoneId) ? writeKept(stored, days.filter((f) => f.zoneId !== zoneId)) : stored;
}

// --- the world on both generators -------------------------------------------------

/** What a scan generates from: the world as it runs, and its active calendar as each generator sees it. */
export interface KeepSource {
  /** seed, zones, eras, bands; overrides and kept days are ignored (a pin's day keeps the record under the pin) */
  state: WorldState;
  /** the active calendar under a mode: only the internal calendar differs between modes */
  adapter: (mode: GeneratorMode) => TimeAdapter;
}

/** The World's state from settings (main.ts builds the live World from it too). */
export function worldStateOf(s: WadjetSettings, generatorMode: GeneratorMode): WorldState {
  return { seed: s.worldSeed, zones: s.zones, eras: s.eras, overrides: s.overrides, frozen: readKept(s.frozen).days, ...(s.bands ? { bands: s.bands } : {}), generatorMode };
}

/** A scan source for this world and its active calendar (the plugin's `world.time.active`). */
export function keepSourceOf(s: WadjetSettings, active: TimeAdapter): KeepSource {
  return {
    state: worldStateOf(s, "previous"),
    adapter: (mode) => (active instanceof InternalCalendar ? new InternalCalendar(s.calendar, () => s.currentDayOrdinal, undefined, mode) : active),
  };
}

function worldIn(source: KeepSource, mode: GeneratorMode): World {
  const adapter = source.adapter(mode);
  const time = new TimeRegistry(adapter.id);
  time.register(adapter);
  return new World({ ...source.state, overrides: [], frozen: [], generatorMode: mode }, time);
}

/** The report body the reader sees for a record (provenance aside): the daily report and the 24 hourly ones. */
function reportsDiffer(a: DailyRecord, b: DailyRecord, zoneId: string, seed: string, bands: DescriptorBands | undefined): boolean {
  const cfg = { seed, generatorVersion: "", provenance: { profileHash: "", calendarHash: "" }, ...(bands ? { bands } : {}) };
  const body = (r: DailyRecord, hour?: number): string => {
    const { provenance: _p, ...rest } = buildReport(r, zoneId, cfg, hour);
    return JSON.stringify(rest);
  };
  if (body(a) !== body(b)) return true;
  for (let hour = 0; hour < 24; hour++) if (body(a, hour) !== body(b, hour)) return true;
  return false;
}

// --- the scan -----------------------------------------------------------------------

export interface KeepZoneCount {
  zoneId: string;
  scanned: number;
  kept: number;
  /** days that differ but whose record would not survive data.json (a non-finite number): skipped, they will show the current generator */
  unstorable: number;
}

export type KeepScan =
  /** `days`: the (zone, day)s whose reports differ, each with the previous generator's record as data.json will hold it */
  | { kind: "done"; days: FrozenDay[]; zones: KeepZoneCount[]; scanned: number; unstorable: number; fromDay: number; toDay: number }
  | { kind: "cancelled" }
  /** the range or a zone id was not one a scan takes; `message` is for the user */
  | { kind: "refused"; message: string }
  /** the calendar or a zone could not make weather */
  | { kind: "failed"; message: string };

export interface KeepScanOptions {
  /** after each chunk: days done and the total (zones × days) */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  chunkDays?: number;
  /** the yield between chunks; a macrotask by default so the UI can paint and Cancel can land */
  tick?: () => Promise<void>;
}

/** a macrotask on the window's timer (popout-safe); tests, which have no window, pass their own tick */
const defaultTick = (): Promise<void> => new Promise((res) => window.setTimeout(res, 0));

/**
 * Which days of [fromDay, toDay] in `zoneIds` the upgrade would change: each (zone, day) is generated under the
 * previous and the current generator and kept where its daily report or any of its 24 hourly reports differs
 * (JSON.stringify, provenance aside; §17.5 item 5). What is kept is the previous record, as it reads back after a
 * JSON round trip; a record that would not read back is skipped and counted (`unstorable`). At most MAX_RANGE_DAYS
 * days; every zone id must be one of the world's. Refusals, a Cancel and a calendar fault are results, not throws.
 */
export async function scanKeep(source: KeepSource, zoneIds: readonly string[], fromDay: number, toDay: number, opts: KeepScanOptions = {}): Promise<KeepScan> {
  if (!Number.isSafeInteger(fromDay) || !Number.isSafeInteger(toDay)) return { kind: "refused", message: "The range must start and end on whole days." };
  if (fromDay > toDay) return { kind: "refused", message: "The range starts after it ends." };
  const span = toDay - fromDay + 1;
  if (span > MAX_RANGE_DAYS) return { kind: "refused", message: `Weather can be kept for at most ${MAX_RANGE_DAYS} days at a time (asked for ${span}).` };
  const unknown = zoneIds.find((id) => !source.state.zones.some((z) => z.id === id));
  if (unknown !== undefined) return { kind: "refused", message: `There is no zone "${unknown}".` };

  const ids = [...new Set(zoneIds)];
  const chunk = Math.max(1, Math.floor(opts.chunkDays ?? KEEP_CHUNK_DAYS));
  const tick = opts.tick ?? defaultTick;
  const total = span * ids.length;
  const days: FrozenDay[] = [];
  const zones: KeepZoneCount[] = [];
  let done = 0;
  try {
    const prev = worldIn(source, "previous");
    const cur = worldIn(source, "current");
    const calendarHash = prev.calendarHash();
    for (const zoneId of ids) {
      const count: KeepZoneCount = { zoneId, scanned: 0, kept: 0, unstorable: 0 };
      zones.push(count);
      const provenance = { generatorVersion: prev.generatorVersion, calendarHash, profileHash: profileHash(prev.getZone(zoneId)!) };
      for (let a = fromDay; a <= toDay; a += chunk) {
        if (opts.signal?.aborted) return { kind: "cancelled" };
        const b = Math.min(toDay, a + chunk - 1);
        const p = prev.generatedRecords(zoneId, a, b);
        const c = cur.generatedRecords(zoneId, a, b);
        for (let i = 0; i < p.length; i++) {
          const pr = p[i]!;
          const cr = c[i]!;
          if (JSON.stringify(pr) === JSON.stringify(cr) || !reportsDiffer(pr, cr, zoneId, source.state.seed, source.state.bands)) continue;
          const record = storedForm(pr);
          if (record !== null) {
            days.push({ zoneId, dayOrdinal: pr.dayOrdinal, record, provenance: { ...provenance } });
            count.kept++;
          } else count.unstorable++;
        }
        count.scanned += p.length;
        done += p.length;
        opts.onProgress?.(done, total);
        await tick();
      }
    }
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  if (opts.signal?.aborted) return { kind: "cancelled" };
  return { kind: "done", days, zones, scanned: done, unstorable: zones.reduce((n, z) => n + z.unstorable, 0), fromDay, toDay };
}

// --- the commit --------------------------------------------------------------------

export interface KeepCommitOptions {
  /** the world's zone ids: only their kept days count toward the cap (all count when absent) */
  zoneIds?: readonly string[];
  /** past the cap, keep the most recent whole days of `add` that fit instead of refusing */
  mostRecent?: boolean;
}

export type KeepCommit =
  /** `frozen`: the world's readable kept weather after the merge; `added` of them came from this scan, `trimmed` of the scan's days were left out (mostRecent), all before `fromDay` */
  | { kind: "ok"; frozen: FrozenDay[]; added: number; trimmed: number; total: number; fromDay: number | null }
  /** the merge would count more than `cap` days; nothing is changed. `fitFromDay`: keeping from this day on would fit (null: nothing fits) */
  | { kind: "over-cap"; added: number; total: number; cap: number; fitFromDay: number | null };

/**
 * Merge a scan's days into the kept weather, replacing by (zone, day). Past MAX_KEPT_DAYS (counting only the
 * world's zones) it refuses, or with `mostRecent` keeps the scan's newest whole days that fit: days are dropped
 * from the oldest, all zones of a day together, and days kept before are never dropped.
 */
export function commitKeep(existing: readonly FrozenDay[], add: readonly FrozenDay[], opts: KeepCommitOptions = {}): KeepCommit {
  const live = opts.zoneIds ? new Set(opts.zoneIds) : null;
  const counts = (e: FrozenDay): boolean => live === null || live.has(e.zoneId);
  const all = mergeKept(existing, add);
  const total = all.filter(counts).length;
  const fromOf = (days: readonly FrozenDay[]): number | null => (days.length ? Math.min(...days.map((d) => d.dayOrdinal)) : null);
  if (total <= MAX_KEPT_DAYS) return { kind: "ok", frozen: all, added: add.length, trimmed: 0, total, fromDay: fromOf(add) };

  // the newest whole days of `add` that fit beside what is already kept
  const addKeys = new Set(add.map((e) => overrideKey(e.zoneId, e.dayOrdinal)));
  let room = MAX_KEPT_DAYS - existing.filter((e) => counts(e) && !addKeys.has(overrideKey(e.zoneId, e.dayOrdinal))).length;
  const byDay = new Map<number, FrozenDay[]>();
  for (const e of add) byDay.set(e.dayOrdinal, [...(byDay.get(e.dayOrdinal) ?? []), e]);
  const kept: FrozenDay[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => b - a)) {
    const group = byDay.get(day)!;
    const need = group.filter(counts).length;
    if (need > room) break;
    room -= need;
    kept.push(...group);
  }
  const fitFromDay = fromOf(kept);
  if (!opts.mostRecent) return { kind: "over-cap", added: add.length, total, cap: MAX_KEPT_DAYS, fitFromDay };
  const frozen = mergeKept(existing, kept);
  return { kind: "ok", frozen, added: kept.length, trimmed: add.length - kept.length, total: frozen.filter(counts).length, fromDay: fitFromDay };
}

/** scanKeep then commitKeep over `existing` (none by default): the freeze in one call. */
export async function freezeRange(
  source: KeepSource,
  zoneIds: readonly string[],
  fromDay: number,
  toDay: number,
  opts: KeepScanOptions & KeepCommitOptions & { existing?: readonly FrozenDay[] } = {},
): Promise<Exclude<KeepScan, { kind: "done" }> | (KeepCommit & { scan: Extract<KeepScan, { kind: "done" }> })> {
  const scan = await scanKeep(source, zoneIds, fromDay, toDay, opts);
  if (scan.kind !== "done") return scan;
  return { ...commitKeep(opts.existing ?? [], scan.days, { zoneIds: opts.zoneIds ?? source.state.zones.map((z) => z.id), ...(opts.mostRecent ? { mostRecent: true } : {}) }), scan };
}

// --- settings ------------------------------------------------------------------------

/**
 * The world upgraded to the current generator, with `kept` (a scan's days) merged into its kept weather;
 * unreadable stored entries are carried. New settings; the argument is not changed. Past MAX_KEPT_DAYS it is
 * refused, changing nothing, unless `mostRecent` (see commitKeep).
 */
export function upgradeWorld(
  s: WadjetSettings,
  kept: readonly FrozenDay[] = [],
  opts: { mostRecent?: boolean } = {},
): { kind: "ok"; settings: WadjetSettings; added: number; trimmed: number; total: number; fromDay: number | null } | Extract<KeepCommit, { kind: "over-cap" }> {
  const c = commitKeep(readKept(s.frozen).days, kept, { zoneIds: s.zones.map((z) => z.id), ...(opts.mostRecent ? { mostRecent: true } : {}) });
  if (c.kind === "over-cap") return c;
  const frozen = kept.length === 0 && c.trimmed === 0 ? s.frozen : writeKept(s.frozen, c.frozen);
  return { kind: "ok", settings: { ...s, generatorVersion: GENERATOR_VERSION, frozen }, added: c.added, trimmed: c.trimmed, total: c.total, fromDay: c.fromDay };
}

/** The world without kept weather, readable or not (the Kept weather row's Remove). New settings. */
export function removeKeptWeather(s: WadjetSettings): WadjetSettings {
  return { ...s, frozen: [] };
}

/** The readable kept days of existing zones, for "N days kept (from A to B)"; null when none. */
export function keptSpan(s: Pick<WadjetSettings, "frozen" | "zones">): { count: number; fromDay: number; toDay: number; zones: number } | null {
  const ids = new Set(s.zones.map((z) => z.id));
  const days = readKept(s.frozen).days.filter((f) => ids.has(f.zoneId));
  if (days.length === 0) return null;
  let fromDay = Infinity;
  let toDay = -Infinity;
  for (const f of days) {
    fromDay = Math.min(fromDay, f.dayOrdinal);
    toDay = Math.max(toDay, f.dayOrdinal);
  }
  return { count: days.length, fromDay, toDay, zones: new Set(days.map((f) => f.zoneId)).size };
}
