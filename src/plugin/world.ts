/**
 * The World: zones + seed + time → reports. Pure (no Obsidian imports) so the
 * public API can be tested directly. main.ts wraps this in the plugin.
 *
 * Generators are cached per zone and rebuilt when the zone's profile hash,
 * the seed, or the calendar config changes. Also owns the zone-resolver chain
 * and the event listeners the public API exposes.
 */
import type { DailyRecord, Generator } from "../core/generator";
import { createGenerator, profileHash, validateProfile, type ValidationIssue } from "../core/profile";
import { buildReport, describe, overrideKey, type DescriptorBands, type Override, type OverridePatch, type WeatherReport } from "../core/report";
import { calendarHashOf, eraModifiers, erasHash, withEraTags } from "../core/eras";
import type { DayTime, Era, ZoneProfile } from "../core/types";
import { generatorVersionOf, type GeneratorMode } from "../core/version";
import { makePayload, type PayloadArgs, type WadjetEvent, type WadjetEventPayloads } from "./events";
import { adapterFault, type TimeAdapter, type TimeContext, type TimeRegistry } from "./time/adapter";
import { codedError } from "./interpreters";
import { hash32 } from "../core/rng";
import type { FrozenDay } from "./keep";

/** World's error when no calendar can make weather: none is registered, or the active one is faulted. */
export const NO_CALENDAR_CODE = "wadjet-no-calendar";
import { flipSeasonTags } from "./time/seasons";

export type ZoneLocator = { kind: "note"; path: string } | { kind: "hex"; mapId: string; q: number; r: number } | { kind: "point"; mapId: string; x: number; y: number } | { kind: "custom"; namespace: string; data: unknown };

/** A resolver needs at least one of `resolve` / `resolveAsync`; registration throws a TypeError otherwise. */
export interface ZoneResolver {
  id: string;
  kinds: ZoneLocator["kind"][];
  resolve?: (locator: ZoneLocator) => string | null;
  resolveAsync?: (locator: ZoneLocator) => Promise<string | null>;
}

/** Per-resolver budget in `resolveZoneAsync`; a slower resolver counts as "no answer". */
export const RESOLVER_TIMEOUT_MS = 2000;
/** Longest `getRange` span, in days (inclusive count). */
export const MAX_RANGE_DAYS = 3660;

export interface WorldState {
  seed: string;
  zones: ZoneProfile[];
  /** world-level era timeline; optional so pure callers can omit it */
  eras?: Era[];
  overrides: Override[];
  bands?: DescriptorBands;
  /** which generator the world runs (SESHAT-v0 §17.2; modeFor(settings.generatorVersion)); absent = "current" */
  generatorMode?: GeneratorMode;
  /**
   * kept weather (SESHAT-v0 §17.2): a kept (zone, day) reports its stored record and provenance instead of
   * generating; entries of a zone not in `zones` are ignored. Replace the list to change it, never edit it in
   * place: the World re-indexes it when the list (or its length) changes, and zone keys carry a hash per zone.
   */
  frozen?: readonly FrozenDay[];
}

/** Throw a TypeError unless `v` is a safe integer (|v| <= 2^53 - 1). */
export function assertInteger(v: unknown, name: string): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new TypeError(`${name} must be an integer (got ${typeof v === "string" ? JSON.stringify(v) : String(v)}).`);
}

/** Largest |dayOrdinal| a calendar's current day may be set to (setNow, advance, the internal calendar's Current day). */
export const MAX_DAY_ORDINAL = 10_000_000;

/** Throw a RangeError unless the integer `day` is within ±MAX_DAY_ORDINAL. */
export function assertDayInRange(day: number, name: string): void {
  if (Math.abs(day) > MAX_DAY_ORDINAL) throw new RangeError(`${name} must be between -${MAX_DAY_ORDINAL} and ${MAX_DAY_ORDINAL} (got ${day}).`);
}

/**
 * The day as the generator sees it: the adapter's context, plus era tags,
 * plus the southern-hemisphere season flip when the zone asks for it. One
 * function, used by the generator and by `timeAt`, so the two never disagree.
 * An adapter with no describe() (opaque calendar) or no seasons cannot be
 * flipped; tags pass through untouched.
 */
export function dayTimeFn(adapter: TimeAdapter, eras: readonly Era[], flip: boolean): (dayOrdinal: number) => TimeContext {
  const seasons = flip ? (adapter.describe?.()?.seasons ?? []) : [];
  // flipSeasonTags spreads its input, so a TimeContext in is a TimeContext out.
  return seasons.length ? (d) => flipSeasonTags(withEraTags(eras, adapter.toContext(d)), seasons) as TimeContext : (d) => withEraTags(eras, adapter.toContext(d));
}

/**
 * Everything about one zone that changes what it reports (seed, eras and bands are the global key). Kept days
 * enter as `kept`, the zone's kept-day fingerprint (a count and hash), never by value.
 */
function zoneKey(zone: ZoneProfile, overrides: readonly Override[], kept: string): string {
  const own = overrides.filter((o) => o.zoneId === zone.id).sort((a, b) => a.dayOrdinal - b.dayOrdinal);
  return `${profileHash(zone)}|${zone.flipSeasons === true ? "flip" : ""}|${zone.name}|${JSON.stringify(own)}${kept}`;
}

type Listener = (payload: never) => void;
interface Keys {
  shared: string;
  zones: Map<string, string>;
  /** the active adapter's id and calendarHash(); null when no adapter is registered */
  calendar: { adapterId: string; hash: string } | null;
}

export class World {
  private generators = new Map<string, { key: string; generator: Generator; hash: string }>();
  private overrideMap = new Map<string, OverridePatch>();
  /** kept days by overrideKey(zone, day), indexed once per store change */
  private keptMap = new Map<string, FrozenDay>();
  /**
   * per zone with kept days, a fingerprint of them (count and a hash of their JSON, computed once per new list):
   * zone keys carry it, so a store change fires profiles-changed for exactly the zones whose kept days changed,
   * and a synced copy with the same content fires nothing
   */
  private keptZones = new Map<string, string>();
  /** the store last indexed, and how long it was: a new list or length is re-indexed */
  private keptSeen: { list: readonly FrozenDay[] | undefined; length: number } = { list: undefined, length: 0 };
  private resolvers: ZoneResolver[] = [];
  private listeners = new Map<WadjetEvent, Set<Listener>>();
  /** What the last setState saw, for the profiles-changed diff. The settings UI mutates state objects in place, so the previous state object can't be diffed; its keys can. */
  private keys: Keys;
  /** per-resolver timeout in resolveZoneAsync (ms); tests shorten it */
  resolverTimeoutMs = RESOLVER_TIMEOUT_MS;
  /** timers for that timeout; the window's by default (popout-safe), swappable where there is no window (tests) */
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (handle) => window.clearTimeout(handle as number),
  };
  ready = false;

  constructor(
    private state: WorldState,
    readonly time: TimeRegistry,
  ) {
    this.indexOverrides();
    this.indexKept();
    this.keys = this.snapshotKeys();
    // an adapter registering or leaving can change the active calendar: re-key, or the next edit is misread
    this.time.onChange(() => this.rekeyCalendar());
  }

  /** Make `id` the active adapter, and re-key so the next calendar edit is measured against it. */
  setActiveAdapter(id: string): void {
    this.time.setActive(id);
    this.rekeyCalendar();
  }

  /**
   * Record which adapter is active and its calendarHash() now, without firing
   * profiles-changed: a switch is not a profile change (it fires time-changed
   * and adapters-changed). Without this, setState compared a later edit
   * against the adapter active before the switch and fired all: false
   * although every report moved (wadjet-439).
   */
  rekeyCalendar(): void {
    this.keys = { ...this.keys, calendar: this.snapshotKeys().calendar };
  }

  // --- state management -------------------------------------------------
  /**
   * Replace the state and fire `profiles-changed` with the zones whose output
   * may have moved. Always fires (`zoneIds` is empty when nothing in the world
   * state changed, e.g. a save of an unrelated setting). `all` is true when
   * the seed, eras or bands changed, or when the active adapter is the same
   * one as last time and its calendarHash() moved (a calendar config edit).
   */
  setState(s: WorldState): void {
    this.state = s;
    this.indexOverrides();
    this.indexKept();
    const prev = this.keys;
    const next = this.snapshotKeys();
    this.keys = next;
    // A calendar edit (year length, moons, seasons, epoch) moves every report. A switch to another
    // adapter is not a profiles change: it fires time-changed and adapters-changed instead.
    const calendarEdited = prev.calendar !== null && next.calendar !== null && prev.calendar.adapterId === next.calendar.adapterId && prev.calendar.hash !== next.calendar.hash;
    const all = prev.shared !== next.shared || calendarEdited;
    const zoneIds = all ? [...next.zones.keys()] : [...new Set([...prev.zones.keys(), ...next.zones.keys()])].filter((id) => prev.zones.get(id) !== next.zones.get(id));
    this.emit("profiles-changed", { all, zoneIds });
  }
  get seed(): string {
    return this.state.seed;
  }
  /** The generator this world runs (§17.2). */
  get mode(): GeneratorMode {
    return this.state.generatorMode ?? "current";
  }
  /** The version stamped in provenance.generatorVersion and reported by the API: the running generator's. */
  get generatorVersion(): string {
    return generatorVersionOf(this.mode);
  }
  private indexOverrides(): void {
    this.overrideMap = new Map(this.state.overrides.map((o) => [overrideKey(o.zoneId, o.dayOrdinal), o.patch]));
  }
  private indexKept(): void {
    const list = this.state.frozen;
    const length = list?.length ?? 0;
    if (list === this.keptSeen.list && length === this.keptSeen.length) return;
    this.keptSeen = { list, length };
    this.keptMap = new Map((list ?? []).map((f) => [overrideKey(f.zoneId, f.dayOrdinal), f]));
    const byZone = new Map<string, FrozenDay[]>();
    for (const f of this.keptMap.values()) byZone.set(f.zoneId, [...(byZone.get(f.zoneId) ?? []), f]);
    this.keptZones = new Map(
      [...byZone].map(([id, days]) => {
        const json = JSON.stringify(days.sort((a, b) => a.dayOrdinal - b.dayOrdinal));
        return [id, `${days.length}:${hash32(json, 0x4b455054).toString(16)}:${json.length}`];
      }),
    );
  }
  /** The kept day for (zone, day), if the store has one. */
  private kept(zoneId: string, dayOrdinal: number): FrozenDay | undefined {
    return this.keptZones.has(zoneId) ? this.keptMap.get(overrideKey(zoneId, dayOrdinal)) : undefined;
  }
  private snapshotKeys(): Keys {
    const eras = this.state.eras ?? [];
    // the mode is shared: a mode change (an Upgrade, a synced downgrade) moves every zone's weather
    const shared = `${this.state.seed}|${eras.length ? erasHash(eras) : ""}|${this.state.bands ? JSON.stringify(this.state.bands) : ""}|${this.mode}`;
    const active = this.time.active;
    let calendar: Keys["calendar"] = null;
    if (active) {
      try {
        calendar = { adapterId: active.id, hash: this.calendarHash() };
      } catch (e) {
        console.error(`U+13080 Weather: time adapter "${active.id}" configHash() threw.`, e);
      }
    }
    return { shared, zones: new Map(this.state.zones.map((z) => [z.id, zoneKey(z, this.state.overrides, this.keptZones.has(z.id) ? `|kept:${this.keptZones.get(z.id)!}` : "")])), calendar };
  }

  // --- zones ------------------------------------------------------------
  listZones(): Array<{ id: string; name: string; issues: ValidationIssue[] }> {
    return this.state.zones.map((z) => ({ id: z.id, name: z.name, issues: validateProfile(z) }));
  }
  getZone(id: string): ZoneProfile | undefined {
    return this.state.zones.find((z) => z.id === id);
  }

  private activeAdapter(): TimeAdapter {
    const a = this.time.active;
    if (!a) throw codedError(NO_CALENDAR_CODE, "No calendar is available.");
    return a;
  }

  /** The active adapter, if it can make weather: a faulted calendar is refused, never replaced by another. */
  private adapterFor(): TimeAdapter {
    const a = this.activeAdapter();
    const fault = adapterFault(a);
    if (fault !== null) throw codedError(NO_CALENDAR_CODE, `No calendar is available: the "${a.id}" calendar cannot run (${fault}).`);
    return a;
  }

  /** The adapter's config hash plus the era timeline: everything calendar-side that changes past weather. A faulted calendar has a hash too (of its raw text), so its repair moves it. */
  calendarHash(): string {
    return calendarHashOf(this.activeAdapter().configHash(), this.state.eras ?? []);
  }

  private generator(zoneId: string): { generator: Generator; hash: string } {
    const zone = this.getZone(zoneId);
    if (!zone) throw new RangeError(`Unknown zone "${zoneId}".`);
    const adapter = this.adapterFor();
    const eras = this.state.eras ?? [];
    const hash = profileHash(zone);
    // flipSeasons is calendar-side, not part of profileHash (D5/D9) — the cache key carries it instead.
    const flip = zone.flipSeasons === true;
    const key = `${this.state.seed}|${hash}|${this.calendarHash()}${flip ? "|flip" : ""}|${this.mode}`;
    const cached = this.generators.get(zoneId);
    if (cached && cached.key === key) return cached;
    const timeOf: (d: number) => DayTime = dayTimeFn(adapter, eras, flip);
    const { generator } = createGenerator(zone, this.state.seed, timeOf, eraModifiers(eras), this.mode);
    const entry = { key, generator, hash };
    this.generators.set(zoneId, entry);
    return entry;
  }

  /**
   * The day as the generator sees it (era tags included). With a zone id the
   * zone's `flipSeasons` is applied too; an unknown zone id is a RangeError.
   */
  timeAt(dayOrdinal: number, zoneId?: string): TimeContext {
    assertInteger(dayOrdinal, "dayOrdinal");
    let flip = false;
    if (zoneId !== undefined) {
      const zone = this.getZone(zoneId);
      if (!zone) throw new RangeError(`Unknown zone "${zoneId}".`);
      flip = zone.flipSeasons === true;
    }
    return dayTimeFn(this.adapterFor(), this.state.eras ?? [], flip)(dayOrdinal);
  }

  // --- reports ----------------------------------------------------------
  /**
   * One report. `time` defaults to `now()` as a daily report (any hour on the
   * current context is dropped). `dayOrdinal` must be an integer and `hour`,
   * when given, a number in [0, 24).
   */
  getReport(zoneId: string, time?: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport {
    let t: { dayOrdinal: number; hour?: number | undefined };
    if (time === undefined) {
      const now = this.now();
      if (!now) throw new Error("The active calendar has no current day; pass a time.");
      t = { dayOrdinal: now.dayOrdinal };
    } else {
      if (typeof time !== "object" || time === null) throw new TypeError(`time must be an object with a dayOrdinal (got ${String(time)}).`);
      t = time;
    }
    assertInteger(t.dayOrdinal, "dayOrdinal");
    if (t.hour !== undefined) {
      if (typeof t.hour !== "number" || !Number.isFinite(t.hour)) throw new TypeError(`hour must be a number (got ${String(t.hour)}).`);
      if (t.hour < 0 || t.hour >= 24) throw new RangeError(`hour must be in [0, 24) (got ${t.hour}).`);
    }
    const { generator, hash } = this.generator(zoneId);
    const kept = this.kept(zoneId, t.dayOrdinal);
    const rec = kept?.record ?? generator.day(t.dayOrdinal);
    const version = kept?.provenance.generatorVersion ?? this.generatorVersion;
    const cal = kept?.provenance.calendarHash ?? this.calendarHash();
    return buildReport(rec, zoneId, { seed: this.state.seed, generatorVersion: version, provenance: { profileHash: kept?.provenance.profileHash ?? hash, calendarHash: cal }, ...(this.state.bands ? { bands: this.state.bands } : {}), overrides: this.overrideMap }, t.hour);
  }

  /** Daily reports for [fromDay, toDay], inclusive. Integer bounds, fromDay <= toDay, at most MAX_RANGE_DAYS days. */
  getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[] {
    assertInteger(fromDay, "fromDay");
    assertInteger(toDay, "toDay");
    if (fromDay > toDay) throw new RangeError(`fromDay (${fromDay}) is after toDay (${toDay}).`);
    if (toDay - fromDay + 1 > MAX_RANGE_DAYS) throw new RangeError(`A range covers at most ${MAX_RANGE_DAYS} days (asked for ${toDay - fromDay + 1}).`);
    const { generator, hash } = this.generator(zoneId);
    const cal = this.calendarHash();
    const version = this.generatorVersion;
    const bands = this.state.bands ? { bands: this.state.bands } : {};
    return generator.range(fromDay, toDay).map((generated) => {
      const kept = this.kept(zoneId, generated.dayOrdinal);
      const rec = kept?.record ?? generated;
      const provenance = { profileHash: kept?.provenance.profileHash ?? hash, calendarHash: kept?.provenance.calendarHash ?? cal };
      return buildReport(rec, zoneId, { seed: this.state.seed, generatorVersion: kept?.provenance.generatorVersion ?? version, provenance, ...bands, overrides: this.overrideMap });
    });
  }

  /**
   * The generator's own records for [fromDay, toDay] (kept days and pins aside), for the kept-weather scan
   * (keep.ts). Same bounds as getRange. The records are the generator's cached ones: read, never change them.
   */
  generatedRecords(zoneId: string, fromDay: number, toDay: number): readonly DailyRecord[] {
    assertInteger(fromDay, "fromDay");
    assertInteger(toDay, "toDay");
    if (fromDay > toDay) throw new RangeError(`fromDay (${fromDay}) is after toDay (${toDay}).`);
    if (toDay - fromDay + 1 > MAX_RANGE_DAYS) throw new RangeError(`A range covers at most ${MAX_RANGE_DAYS} days (asked for ${toDay - fromDay + 1}).`);
    return this.generator(zoneId).generator.range(fromDay, toDay);
  }

  now(): TimeContext | null {
    return this.time.active?.now() ?? null;
  }

  /** Any `style` other than "prose" (a typo, an object) means "short". */
  describe(report: WeatherReport, style?: unknown): string {
    return describe(report, style === "prose" ? "prose" : "short");
  }

  // --- resolvers ----------------------------------------------------------
  registerZoneResolver(r: ZoneResolver): () => void {
    if (typeof r !== "object" || r === null) throw new TypeError("A zone resolver must be an object.");
    if (typeof r.resolve !== "function" && typeof r.resolveAsync !== "function") throw new TypeError(`Zone resolver "${String(r.id)}" needs resolve or resolveAsync.`);
    if (!Array.isArray(r.kinds)) throw new TypeError(`Zone resolver "${String(r.id)}" needs a kinds array.`);
    this.resolvers.push(r);
    this.emit("resolvers-changed");
    return () => {
      if (!this.resolvers.includes(r)) return;
      this.resolvers = this.resolvers.filter((x) => x !== r);
      this.emit("resolvers-changed");
    };
  }
  /** The synchronous chain: resolvers with only `resolveAsync` are skipped. */
  resolveZone(locator: ZoneLocator): string | null {
    for (const r of this.resolvers) {
      if (!r.kinds.includes(locator.kind) || typeof r.resolve !== "function") continue;
      try {
        const id = r.resolve(locator);
        if (id && this.getZone(id)) return id;
      } catch {
        /* a misbehaving resolver must not break others */
      }
    }
    return null;
  }
  /**
   * The chain as it stood when called, using `resolveAsync` where present and
   * `resolve` otherwise. Each async resolver gets `resolverTimeoutMs`; a
   * timeout or a throw counts as null. The zone must still exist after the
   * await (zones can be deleted while a resolver is thinking).
   */
  async resolveZoneAsync(locator: ZoneLocator): Promise<string | null> {
    const chain = this.resolvers.filter((r) => r.kinds.includes(locator.kind));
    for (const r of chain) {
      let id: string | null = null;
      try {
        if (typeof r.resolveAsync === "function") id = await this.withTimeout(r, r.resolveAsync(locator));
        else if (typeof r.resolve === "function") id = r.resolve(locator);
      } catch {
        id = null;
      }
      if (id && this.getZone(id)) return id;
    }
    return null;
  }
  private withTimeout(r: ZoneResolver, p: Promise<string | null>): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timer = this.timers.set(() => {
        console.warn(`U+13080 Weather: zone resolver "${r.id}" took longer than ${this.resolverTimeoutMs} ms; treated as no answer.`);
        resolve(null);
      }, this.resolverTimeoutMs);
      Promise.resolve(p).then(
        (v) => {
          this.timers.clear(timer);
          resolve(v);
        },
        (e: unknown) => {
          this.timers.clear(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  // --- events -------------------------------------------------------------
  on<E extends WadjetEvent>(event: E, cb: (payload: WadjetEventPayloads[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const l = cb as Listener;
    set.add(l);
    return () => {
      set.delete(l);
    };
  }
  /** Fire an event with a frozen payload. A listener that throws (or returns a promise that rejects) is logged and the rest still run. */
  emit<E extends WadjetEvent>(event: E, ...rest: PayloadArgs<E>): void {
    if (event === "ready") this.ready = true;
    const payload = makePayload(event, rest[0]);
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      try {
        const ret: unknown = (cb as (p: WadjetEventPayloads[E]) => unknown)(payload);
        // An async listener's rejection is logged like a synchronous throw, not left unhandled.
        if (typeof ret === "object" && ret !== null && typeof (ret as { then?: unknown }).then === "function") {
          (ret as PromiseLike<unknown>).then(undefined, (e: unknown) => console.error(`U+13080 Weather: a "${event}" listener threw.`, e));
        }
      } catch (e) {
        console.error(`U+13080 Weather: a "${event}" listener threw.`, e);
      }
    }
  }
  /** Drop every listener (plugin unload). */
  clearListeners(): void {
    this.listeners.clear();
  }
}
