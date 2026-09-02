/**
 * The World: zones + seed + time → reports. Pure (no Obsidian imports) so the
 * public API can be tested directly. main.ts wraps this in the plugin.
 *
 * Generators are cached per zone and rebuilt when the zone's profile hash,
 * the seed, or the calendar config changes.
 */
import type { Generator } from "../core/generator";
import { createGenerator, profileHash, validateProfile, type ValidationIssue } from "../core/profile";
import { buildReport, describe, overrideKey, type DescriptorBands, type Override, type OverridePatch, type WeatherReport } from "../core/report";
import { eraModifiers, erasHash, withEraTags } from "../core/eras";
import type { DayTime, Era, ZoneProfile } from "../core/types";
import type { TimeAdapter, TimeContext, TimeRegistry } from "./time/adapter";
import { flipSeasonTags } from "./time/seasons";

export type ZoneLocator = { kind: "note"; path: string } | { kind: "hex"; mapId: string; q: number; r: number } | { kind: "point"; mapId: string; x: number; y: number } | { kind: "custom"; namespace: string; data: unknown };

export interface ZoneResolver {
  id: string;
  kinds: ZoneLocator["kind"][];
  resolve(locator: ZoneLocator): string | null;
}

export type WorldEvent = "ready" | "profiles-changed" | "time-changed" | "adapters-changed";

export interface WorldState {
  seed: string;
  zones: ZoneProfile[];
  /** world-level era timeline; optional so pure callers can omit it */
  eras?: Era[];
  overrides: Override[];
  bands?: DescriptorBands;
}

export class World {
  private generators = new Map<string, { key: string; generator: Generator; hash: string }>();
  private overrideMap = new Map<string, OverridePatch>();
  private resolvers: ZoneResolver[] = [];
  private listeners = new Map<WorldEvent, Set<() => void>>();
  ready = false;

  constructor(
    private state: WorldState,
    readonly time: TimeRegistry,
  ) {
    this.indexOverrides();
  }

  // --- state management -------------------------------------------------
  setState(s: WorldState): void {
    this.state = s;
    this.indexOverrides();
    this.emit("profiles-changed");
  }
  get seed(): string {
    return this.state.seed;
  }
  private indexOverrides(): void {
    this.overrideMap = new Map(this.state.overrides.map((o) => [overrideKey(o.zoneId, o.dayOrdinal), o.patch]));
  }

  // --- zones ------------------------------------------------------------
  listZones(): Array<{ id: string; name: string; issues: ValidationIssue[] }> {
    return this.state.zones.map((z) => ({ id: z.id, name: z.name, issues: validateProfile(z) }));
  }
  getZone(id: string): ZoneProfile | undefined {
    return this.state.zones.find((z) => z.id === id);
  }

  private adapterFor(): TimeAdapter {
    const a = this.time.active;
    if (!a) throw new Error("No calendar is available.");
    return a;
  }

  /** The adapter's config hash plus the era timeline: everything calendar-side that changes past weather. */
  calendarHash(): string {
    const h = this.adapterFor().configHash();
    const eras = this.state.eras ?? [];
    return eras.length ? `${h}+${erasHash(eras)}` : h;
  }

  private generator(zoneId: string): { generator: Generator; hash: string } {
    const zone = this.getZone(zoneId);
    if (!zone) throw new RangeError(`Unknown zone "${zoneId}".`);
    const adapter = this.adapterFor();
    const eras = this.state.eras ?? [];
    const hash = profileHash(zone);
    // flipSeasons is calendar-side, not part of profileHash (D5/D9) — the cache key carries it instead.
    const flip = zone.flipSeasons === true;
    const key = `${this.state.seed}|${hash}|${this.calendarHash()}${flip ? "|flip" : ""}`;
    const cached = this.generators.get(zoneId);
    if (cached && cached.key === key) return cached;
    // An adapter with no describe() (opaque calendar) or no seasons cannot be flipped; tags pass through untouched.
    const seasons = flip ? (adapter.describe?.()?.seasons ?? []) : [];
    const timeOf = seasons.length ? (d: number): DayTime => flipSeasonTags(withEraTags(eras, adapter.toContext(d)), seasons) : (d: number): DayTime => withEraTags(eras, adapter.toContext(d));
    const { generator } = createGenerator(zone, this.state.seed, timeOf, eraModifiers(eras));
    const entry = { key, generator, hash };
    this.generators.set(zoneId, entry);
    return entry;
  }

  // --- reports ----------------------------------------------------------
  getReport(zoneId: string, time: TimeContext | { dayOrdinal: number; hour?: number }): WeatherReport {
    const { generator, hash } = this.generator(zoneId);
    const rec = generator.day(time.dayOrdinal);
    return buildReport(rec, zoneId, { seed: this.state.seed, provenance: { profileHash: hash, calendarHash: this.calendarHash() }, ...(this.state.bands ? { bands: this.state.bands } : {}), overrides: this.overrideMap }, time.hour);
  }

  getRange(zoneId: string, fromDay: number, toDay: number): WeatherReport[] {
    const { generator, hash } = this.generator(zoneId);
    const cal = this.calendarHash();
    return generator.range(fromDay, toDay).map((rec) => buildReport(rec, zoneId, { seed: this.state.seed, provenance: { profileHash: hash, calendarHash: cal }, ...(this.state.bands ? { bands: this.state.bands } : {}), overrides: this.overrideMap }));
  }

  now(): TimeContext | null {
    return this.time.active?.now() ?? null;
  }

  describe(report: WeatherReport, style?: "short" | "prose"): string {
    return describe(report, style);
  }

  // --- resolvers ----------------------------------------------------------
  registerZoneResolver(r: ZoneResolver): () => void {
    this.resolvers.push(r);
    return () => {
      this.resolvers = this.resolvers.filter((x) => x !== r);
    };
  }
  resolveZone(locator: ZoneLocator): string | null {
    for (const r of this.resolvers) {
      if (!r.kinds.includes(locator.kind)) continue;
      try {
        const id = r.resolve(locator);
        if (id && this.getZone(id)) return id;
      } catch {
        /* a misbehaving resolver must not break others */
      }
    }
    return null;
  }

  // --- events -------------------------------------------------------------
  on(event: WorldEvent, cb: () => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }
  emit(event: WorldEvent): void {
    if (event === "ready") this.ready = true;
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb();
      } catch {
        /* listener errors are not ours */
      }
    }
  }
}
