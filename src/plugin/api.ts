/**
 * The public API object (docs/API.md §1), built without Obsidian so tests can
 * drive the whole surface. main.ts supplies the host (world, time registry,
 * settings readers) and owns the lifecycle; this module owns the unload
 * guard, the serialised time-control queue, the active-adapter
 * subscription and the interpreter registry.
 *
 * types/wadjet.d.ts is the standalone copy consumers use; test/types/
 * conformance.ts fails to compile if the two drift.
 */
import { classify, type Classification } from "../core/classify";
import { glyph, glyphKey, type GlyphKey } from "../core/glyphs";
import type { WeatherReport } from "../core/report";
import { convertReport, type ConvertedReport, type Units } from "../core/units";
import { GENERATOR_VERSION, RNG_VERSION, SCHEMA_VERSION } from "../core/version";
import type { WadjetEvent, WadjetEventPayloads } from "./events";
import { InterpreterRegistry, codedError, type InterpretContext, type InterpreterInfo, type WeatherInterpreter } from "./interpreters";
import type { CalendarDescription, TimeAdapter, TimeContext, TimeRegistry } from "./time/adapter";
import { assertInteger, type World, type ZoneLocator, type ZoneResolver } from "./world";

/** Bumps whenever members are added to WadjetAPI. */
export const API_VERSION = 1 as const;

/**
 * Public API. Reachable as `app.plugins.plugins.wadjet.api` and
 * `window.Wadjet`. All returned values are plain serialisable objects except
 * `getInterpreter`, which hands back the registered object.
 *
 * Load order: check `api.ready`; if false, wait for the `wadjet:ready`
 * workspace event. After `wadjet:unload` the object is dead: get it again
 * after the next `wadjet:ready`.
 */
export interface WadjetAPI {
  version: string;
  apiVersion: 1;
  ready: boolean;
  schemaVersion: 0;
  generatorVersion: string;
  rngVersion: string;

  getReport: (zoneId: string, time?: TimeContext | { dayOrdinal: number; hour?: number }) => WeatherReport;
  getRange: (zoneId: string, fromDay: number, toDay: number) => WeatherReport[];
  now: () => TimeContext | null;
  listZones: () => Array<{ id: string; name: string }>;
  timeAt: (dayOrdinal: number, zoneId?: string) => TimeContext;
  format: (dayOrdinal: number) => string;
  parse: (text: string) => number | null;

  canSetNow: () => boolean;
  setNow: (dayOrdinal: number) => Promise<boolean>;
  advance: (days: number) => Promise<boolean>;

  registerTimeAdapter: (adapter: TimeAdapter) => () => void;
  registerZoneResolver: (resolver: ZoneResolver) => () => void;
  resolveZone: (locator: ZoneLocator) => string | null;
  resolveZoneAsync: (locator: ZoneLocator) => Promise<string | null>;

  calendar: () => CalendarDescription | null;
  listTimeAdapters: () => Array<{ id: string; label: string; active: boolean }>;

  describe: (report: WeatherReport, style?: "short" | "prose") => string;
  units: () => Units;
  convert: (report: WeatherReport, units?: Units) => ConvertedReport;

  classify: (report: WeatherReport) => Classification;
  glyphKey: (report: WeatherReport) => GlyphKey;
  glyph: (keyOrReport: GlyphKey | WeatherReport, opts?: { size?: number; title?: string }) => string;

  registerInterpreter: (interpreter: WeatherInterpreter) => () => void;
  listInterpreters: (facet?: string) => InterpreterInfo[];
  getInterpreter: (id: string) => WeatherInterpreter | null;
  interpret: <T = unknown>(id: string, report: WeatherReport, options?: Record<string, unknown>) => T;

  on: <E extends WadjetEvent>(event: E, cb: (payload: WadjetEventPayloads[E]) => void) => () => void;
}

export interface ApiHost {
  version: string;
  world: World;
  time: TimeRegistry;
  units: () => Units;
}

export const UNLOADED_CODE = "wadjet-unloaded";

export class ApiController {
  readonly api: WadjetAPI;
  readonly interpreters: InterpreterRegistry;
  private dead = false;
  private chain: Promise<unknown> = Promise.resolve();
  private subscribed: { adapter: TimeAdapter; off: () => void } | null = null;

  constructor(private readonly host: ApiHost) {
    this.interpreters = new InterpreterRegistry((facet) => {
      if (!this.dead) host.world.emit("interpreters-changed", { facet });
    });
    this.api = this.build();
  }

  get unloaded(): boolean {
    return this.dead;
  }

  /** End of onload: flip `ready` and fire the API-level `ready` event. */
  markReady(): void {
    if (this.dead) return;
    this.api.ready = true;
    this.host.world.emit("ready");
  }

  /** Fire `time-changed` for the active adapter (no-op after unload). */
  emitTimeChanged(): void {
    if (this.dead) return;
    let current: number | null = null;
    try {
      current = this.host.world.now()?.dayOrdinal ?? null;
    } catch (e) {
      console.error("U+13080 Weather: the active calendar's now() threw.", e);
    }
    this.host.world.emit("time-changed", { current, adapterId: this.host.time.active?.id ?? "internal" });
  }

  /**
   * Follow the active adapter's own date changes: subscribe to its
   * `subscribe`, dropping the old subscription when the active adapter
   * changes. Call after every register/unregister and every switch.
   */
  syncActiveSubscription(): void {
    const active = this.dead ? undefined : this.host.time.active;
    if (this.subscribed && this.subscribed.adapter === active) return;
    if (this.subscribed) {
      try {
        this.subscribed.off();
      } catch (e) {
        console.error(`U+13080 Weather: unsubscribing from time adapter "${this.subscribed.adapter.id}" threw.`, e);
      }
      this.subscribed = null;
    }
    if (!active || typeof active.subscribe !== "function") return;
    try {
      const off = active.subscribe(() => {
        if (this.subscribed?.adapter === active) this.emitTimeChanged();
      });
      this.subscribed = { adapter: active, off: typeof off === "function" ? off : () => {} };
    } catch (e) {
      console.error(`U+13080 Weather: subscribing to time adapter "${active.id}" threw.`, e);
    }
  }

  /** Run a time-control step after every earlier one has settled (setNow/advance and the settings tab's own day edit share this queue). */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const p = this.chain.then(op);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /**
   * Unload: the flag first, then the `unload` event, then the caller's
   * workspace trigger; then every listener, registration and subscription is
   * dropped. After this every method throws (async ones reject) with code
   * "wadjet-unloaded" and every unsubscriber is a no-op.
   */
  unload(triggerWorkspace: () => void): void {
    if (this.dead) return;
    this.dead = true;
    this.api.ready = false;
    this.host.world.emit("unload");
    try {
      triggerWorkspace();
    } catch (e) {
      console.error("U+13080 Weather: a wadjet:unload handler threw.", e);
    }
    this.host.world.clearListeners();
    this.interpreters.clear();
    this.syncActiveSubscription();
  }

  private assertLive(): void {
    if (this.dead) throw codedError(UNLOADED_CODE, "U+13080 Weather is unloaded. Get app.plugins.plugins.wadjet.api again after the next wadjet:ready event.");
  }

  /** Wrap an unsubscriber so it runs at most once and never after unload. */
  private once(off: () => unknown): () => void {
    let done = false;
    return () => {
      if (done || this.dead) return;
      done = true;
      off();
    };
  }

  /** Move the active calendar to `target()` (computed inside the queue, so back-to-back advances add up). */
  private moveTo(target: () => number | null): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.dead) return false;
      const adapter = this.host.time.active;
      if (!adapter || typeof adapter.setNow !== "function") return false;
      const day = target();
      if (day === null) return false;
      try {
        await adapter.setNow(day);
      } catch (e) {
        console.error(`U+13080 Weather: time adapter "${adapter.id}" failed to set the current day.`, e);
        return false;
      }
      if (this.dead) return false;
      // An adapter that reports its own changes (the internal calendar does) has already fired time-changed through syncActiveSubscription.
      if (typeof adapter.subscribe !== "function") this.emitTimeChanged();
      return true;
    });
  }

  private build(): WadjetAPI {
    const { world, time } = this.host;
    const live = this.assertLive.bind(this);
    const activeAdapter = () => time.active;
    const api: WadjetAPI = {
      version: this.host.version,
      apiVersion: API_VERSION,
      ready: false,
      schemaVersion: SCHEMA_VERSION,
      generatorVersion: GENERATOR_VERSION,
      rngVersion: RNG_VERSION,

      getReport: (zoneId, t) => (live(), world.getReport(zoneId, t)),
      getRange: (zoneId, from, to) => (live(), world.getRange(zoneId, from, to)),
      now: () => (live(), world.now()),
      listZones: () => (live(), world.listZones().map(({ id, name }) => ({ id, name }))),
      timeAt: (d, zoneId) => (live(), world.timeAt(d, zoneId)),
      format: (d) => {
        live();
        assertInteger(d, "dayOrdinal");
        const a = activeAdapter();
        if (typeof a?.format === "function") {
          try {
            return a.format(d);
          } catch (e) {
            console.error(`U+13080 Weather: time adapter "${a.id}" format() threw.`, e);
          }
        }
        return `Day ${d}`;
      },
      parse: (text) => {
        live();
        if (typeof text !== "string") return null;
        const a = activeAdapter();
        if (typeof a?.parse === "function") {
          try {
            const d = a.parse(text);
            return typeof d === "number" && Number.isInteger(d) ? d : null;
          } catch {
            return null;
          }
        }
        const t = text.trim();
        return /^-?\d+$/.test(t) ? Number(t) : null;
      },

      canSetNow: () => (live(), typeof activeAdapter()?.setNow === "function"),
      setNow: async (d) => {
        live();
        assertInteger(d, "dayOrdinal");
        return this.moveTo(() => d);
      },
      advance: async (n) => {
        live();
        assertInteger(n, "days");
        return this.moveTo(() => {
          const now = world.now();
          return now ? now.dayOrdinal + n : null;
        });
      },

      registerTimeAdapter: (a) => (live(), this.once(time.register(a))),
      registerZoneResolver: (r) => (live(), this.once(world.registerZoneResolver(r))),
      resolveZone: (l) => (live(), world.resolveZone(l)),
      resolveZoneAsync: async (l) => {
        live();
        const id = await world.resolveZoneAsync(l);
        return this.dead ? null : id;
      },

      calendar: () => (live(), activeAdapter()?.describe?.() ?? null),
      listTimeAdapters: () => {
        live();
        const activeId = activeAdapter()?.id;
        return time.list().map((id) => {
          const adapter = time.get(id);
          return { id, label: adapter?.describe?.().label ?? id, active: id === activeId };
        });
      },

      describe: (r, style) => (live(), world.describe(r, style)),
      units: () => (live(), this.host.units()),
      convert: (r, units) => (live(), convertReport(r, units ?? this.host.units())),

      classify: (r) => (live(), classify(r)),
      glyphKey: (r) => (live(), glyphKey(r)),
      glyph: (k, opts) => (live(), glyph(k, opts)),

      registerInterpreter: (i) => (live(), this.once(this.interpreters.register(i))),
      listInterpreters: (facet) => (live(), this.interpreters.list(facet)),
      getInterpreter: (id) => (live(), this.interpreters.get(id)),
      interpret: <T = unknown>(id: string, report: WeatherReport, options?: Record<string, unknown>): T => {
        live();
        if (!this.interpreters.get(id)) throw new RangeError(`Unknown interpreter "${id}".`);
        const base = world.timeAt(report.dayOrdinal, world.getZone(report.zoneId) ? report.zoneId : undefined);
        const ctx: InterpretContext = {
          zoneId: report.zoneId,
          classification: classify(report),
          time: report.hour !== undefined ? { ...base, hour: report.hour } : base,
          ...(options !== undefined ? { options } : {}),
        };
        return this.interpreters.run(id, report, ctx) as T;
      },

      on: (event, cb) => (live(), this.once(world.on(event, cb))),
    };
    return api;
  }
}
