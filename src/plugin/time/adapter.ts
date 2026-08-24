/**
 * Time adapter contract (DESIGN-v1.md §1). Adapters collapse any calendar to
 * (dayOrdinal, yearPhase, yearLength) plus optional moons/tags.
 */
import type { DayTime } from "../../core/types";

export interface TimeContext extends DayTime {
  dayOrdinal: number;
  yearLength: number;
  hour?: number;
  source: string;
}

export interface TimeAdapter {
  id: string;
  /** the calendar's current date, or null if it has none */
  now(): TimeContext | null;
  /** MUST be O(1)/O(log n); MUST extrapolate (not throw) outside the calendar's defined range */
  toContext(dayOrdinal: number): TimeContext;
  /** identity of the adapter's configuration, for provenance (§6) */
  configHash(): string;
  /** optional: parse a calendar-native date string to a dayOrdinal */
  parse?(text: string): number | null;
  /** optional: human-readable date */
  format?(dayOrdinal: number): string;
}

export class TimeRegistry {
  private readonly adapters = new Map<string, TimeAdapter>();
  constructor(private activeId: string) {}

  register(a: TimeAdapter): () => void {
    this.adapters.set(a.id, a);
    return () => {
      if (this.adapters.get(a.id) === a) this.adapters.delete(a.id);
    };
  }
  setActive(id: string): void {
    this.activeId = id;
  }
  get active(): TimeAdapter | undefined {
    return this.adapters.get(this.activeId) ?? this.adapters.get("internal");
  }
  get(id: string): TimeAdapter | undefined {
    return this.adapters.get(id);
  }
  list(): string[] {
    return [...this.adapters.keys()];
  }
}
