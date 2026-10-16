/**
 * Internal fallback calendar: fixed year length, optional moons and season
 * tags. Enough to run Wadjet with no calendar plugin installed.
 */
import { hash32 } from "../../core/rng";
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
   */
  constructor(
    private cfg: InternalCalendarConfig,
    private current: () => number,
    private write?: (dayOrdinal: number) => void | Promise<void>,
  ) {}

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

  update(cfg: InternalCalendarConfig): void {
    this.cfg = cfg;
  }

  now(): TimeContext {
    return this.toContext(this.current());
  }

  toContext(dayOrdinal: number): TimeContext {
    const y = this.cfg.yearLength;
    const yearIndex = Math.floor(dayOrdinal / y);
    const dayOfYear = dayOrdinal - yearIndex * y;
    const yearPhase = dayOfYear / y;
    const moons = this.cfg.moons.map((m) => ({ name: m.name, phase: wrap((dayOrdinal / m.cycleDays + m.phaseAtEpoch) % 1) }));
    const tags: string[] = [];
    const season = this.seasonAt(yearPhase);
    if (season) tags.push(`season:${season}`);
    return { dayOrdinal, yearPhase, yearLength: y, dayOfYear, year: yearIndex + this.cfg.epochYear, moons, tags, source: this.id };
  }

  seasonAt(yearPhase: number): string | null {
    return seasonAtPhase(this.cfg.seasons, yearPhase);
  }

  configHash(): string {
    // phases are display metadata (PLAN §2.2), not part of the roll — excluded so adding/editing them never invalidates cached weather.
    const moons = this.cfg.moons.map((m) => ({ name: m.name, cycleDays: m.cycleDays, phaseAtEpoch: m.phaseAtEpoch }));
    const json = JSON.stringify({ y: this.cfg.yearLength, e: this.cfg.epochYear, m: moons, s: this.cfg.seasons });
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

  /** "Y-D" (year, day-of-year 1-based) or a bare integer dayOrdinal. */
  parse(text: string): number | null {
    const t = text.trim();
    if (/^-?\d+$/.test(t)) return Number(t);
    const m = t.match(/^(-?\d+)-(\d+)$/);
    if (!m) return null;
    const year = Number(m[1]);
    const doy = Number(m[2]);
    if (doy < 1 || doy > this.cfg.yearLength) return null;
    return (year - this.cfg.epochYear) * this.cfg.yearLength + (doy - 1);
  }

  format(dayOrdinal: number): string {
    const c = this.toContext(dayOrdinal);
    const year = c.year!;
    const season = this.seasonAt(c.yearPhase);
    return `Year ${year}, day ${(c.dayOfYear ?? 0) + 1}${season ? ` (${season})` : ""}`;
  }
}

function wrap(x: number): number {
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}
