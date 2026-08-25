/**
 * Internal fallback calendar: fixed year length, optional moons and season
 * tags. Enough to run Wadjet with no calendar plugin installed.
 */
import { hash32 } from "../../core/rng";
import type { InternalCalendarConfig } from "../settings";
import type { TimeAdapter, TimeContext } from "./adapter";

export class InternalCalendar implements TimeAdapter {
  readonly id = "internal";
  constructor(
    private cfg: InternalCalendarConfig,
    private current: () => number,
  ) {}

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
    const s = [...this.cfg.seasons].sort((a, b) => a.from - b.from);
    if (s.length === 0) return null;
    let cur = s[s.length - 1]!;
    for (const x of s) if (yearPhase >= x.from) cur = x;
    return cur.name;
  }

  configHash(): string {
    const json = JSON.stringify({ y: this.cfg.yearLength, e: this.cfg.epochYear, m: this.cfg.moons, s: this.cfg.seasons });
    return `ical:${hash32(json, 0x43414c45).toString(16).padStart(8, "0")}`;
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
