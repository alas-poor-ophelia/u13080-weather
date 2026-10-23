/**
 * Internal fallback calendar: fixed year length, optional moons and season
 * tags. Enough to run Wadjet with no calendar plugin installed. A thin adapter
 * over a Seshat definition (docs/SESHAT-v0.md §7): the date arithmetic is
 * Seshat's, the season tags and the text format are this adapter's.
 */
import { hash32 } from "../../core/rng";
import { legacyMoonPhase } from "../../core/previous";
import type { GeneratorMode } from "../../core/version";
import { dayIn, dayOf, SESHAT_VERSION, type FixedYearCalendar } from "../../seshat";
import type { InternalCalendarConfig } from "../settings";
import type { CalendarDescription, TimeAdapter, TimeContext } from "./adapter";
import { seasonAtPhase } from "./seasons";
import { assertDayInRange, assertInteger } from "../world";

export class InternalCalendar implements TimeAdapter {
  readonly id = "internal";
  private readonly listeners = new Set<() => void>();
  /**
   * @param current reads the stored current day (settings.currentDayOrdinal)
   * @param write stores a new current day (the plugin writes the setting and saves); `setNow` needs it
   * @param mode the generator the world runs (SESHAT-v0 §17.2): per instance, never global. In "previous"
   *   mode the moons (toContext) and configHash are 0.0.3's: the float moon formula, a hash without SESHAT_VERSION.
   */
  constructor(
    private cfg: InternalCalendarConfig,
    private current: () => number,
    private write?: (dayOrdinal: number) => void | Promise<void>,
    private mode: GeneratorMode = "current",
  ) {}

  /** The generator mode this calendar's moons and hash follow. */
  get generatorMode(): GeneratorMode {
    return this.mode;
  }

  /**
   * Move the current day: store it through `write`, then tell subscribers.
   * Safe integers within ±MAX_DAY_ORDINAL only; the plugin validates before
   * it gets here, this is the last line.
   */
  async setNow(dayOrdinal: number): Promise<void> {
    assertInteger(dayOrdinal, "dayOrdinal");
    assertDayInRange(dayOrdinal, "dayOrdinal");
    if (!this.write) throw new Error("The internal calendar has no place to store the current day.");
    await this.write(dayOrdinal);
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        console.error("U+13080 Weather: an internal calendar subscriber threw.", e);
      }
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Adopt a new config and, when given, a new mode: a reload applies both together (§17.5 item 7). */
  update(cfg: InternalCalendarConfig, mode: GeneratorMode = this.mode): void {
    this.cfg = cfg;
    this.mode = mode;
  }

  now(): TimeContext {
    return this.toContext(this.current());
  }

  toContext(dayOrdinal: number): TimeContext {
    const { year, dayOfYear, yearPhase, moons: exact } = dayIn(this.definition(), dayOrdinal);
    const moons = this.mode === "previous" ? this.cfg.moons.map((m) => ({ name: m.name, phase: legacyMoonPhase(m.cycleDays, m.phaseAtEpoch, dayOrdinal) })) : exact;
    const tags: string[] = [];
    const season = this.seasonAt(yearPhase);
    if (season) tags.push(`season:${season}`);
    return { dayOrdinal, yearPhase, yearLength: this.cfg.yearLength, dayOfYear, year, moons, tags, source: this.id };
  }

  /**
   * The Seshat definition of the stored config, read fresh on every call: the
   * settings tab writes the shared config in place before `update` runs, and
   * the adapter has always seen such an edit at once.
   */
  private definition(): FixedYearCalendar {
    return { year: { anchor: 0, length: this.cfg.yearLength }, epochYear: this.cfg.epochYear, moons: this.cfg.moons };
  }

  seasonAt(yearPhase: number): string | null {
    return seasonAtPhase(this.cfg.seasons, yearPhase);
  }

  configHash(): string {
    // phases are display metadata (PLAN §2.2), not part of the roll — excluded so adding/editing them never invalidates cached weather.
    const moons = this.cfg.moons.map((m) => ({ name: m.name, cycleDays: m.cycleDays, phaseAtEpoch: m.phaseAtEpoch }));
    // SESHAT_VERSION: the algorithm is part of the hash, not only the inputs (docs/SESHAT-v0.md §8.2 item 6).
    // The previous generator (0.0.3) hashed the inputs alone: its calendarHash is kept exactly (§17.2).
    const json =
      this.mode === "previous"
        ? JSON.stringify({ y: this.cfg.yearLength, e: this.cfg.epochYear, m: moons, s: this.cfg.seasons })
        : JSON.stringify({ v: SESHAT_VERSION, y: this.cfg.yearLength, e: this.cfg.epochYear, m: moons, s: this.cfg.seasons });
    return `ical:${hash32(json, 0x43414c45).toString(16).padStart(8, "0")}`;
  }

  /** Static description of this calendar for UIs (PLAN §3). Returns copies, not the live config. */
  describe(): CalendarDescription {
    return {
      label: "internal calendar",
      readOnly: false,
      yearLength: this.cfg.yearLength,
      epochYear: this.cfg.epochYear,
      seasons: [...this.cfg.seasons].sort((a, b) => a.from - b.from).map((s) => ({ ...s })),
      moons: this.cfg.moons.map((m) => ({
        name: m.name,
        cycleDays: m.cycleDays,
        phaseAtEpoch: m.phaseAtEpoch,
        ...(m.phases ? { phases: m.phases.map((p) => ({ ...p })) } : {}),
      })),
    };
  }

  /** "Y-D" (year, day-of-year 1-based), the format() text ("Year Y, day D", season tag optional), or a bare integer dayOrdinal. */
  parse(text: string): number | null {
    const t = text.trim();
    if (/^-?\d+$/.test(t)) return Number(t);
    const m = t.match(/^(-?\d+)-(\d+)$/) ?? t.match(/^Year (-?\d+), day (\d+)(?: \([^)]*\))?$/);
    if (!m) return null;
    const year = Number(m[1]);
    const doy = Number(m[2]);
    if (doy < 1 || doy > this.cfg.yearLength) return null;
    return dayOf(this.definition(), year, doy - 1);
  }

  format(dayOrdinal: number): string {
    const c = this.toContext(dayOrdinal);
    const year = c.year!;
    const season = this.seasonAt(c.yearPhase);
    return `Year ${year}, day ${(c.dayOfYear ?? 0) + 1}${season ? ` (${season})` : ""}`;
  }
}
