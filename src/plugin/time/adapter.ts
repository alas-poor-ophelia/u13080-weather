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

/** Static description of a calendar for UIs (PLAN §3): what to show, not how to compute it. */
export interface CalendarDescription {
  /** display name for the badge: "internal calendar" or the plugin's name */
  label: string;
  /** true for every adapter except the internal one, unless it opts into editing */
  readOnly: boolean;
  yearLength: number;
  epochYear?: number;
  /** from = yearPhase */
  seasons: Array<{ name: string; from: number }>;
  moons: Array<{ name: string; cycleDays: number; phaseAtEpoch?: number; phases?: Array<{ name: string; at: number }> }>;
  /** where the user edits this calendar, shown as "edit in <label>" */
  editHint?: string;
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
  /** optional: static description of the calendar for UIs; absent = opaque calendar */
  describe?(): CalendarDescription;
}

/** Registry change notification: a `TimeAdapter` was registered or unregistered. */
export interface TimeRegistryChange {
  id: string;
  kind: "register" | "unregister";
}

export class TimeRegistry {
  private readonly adapters = new Map<string, TimeAdapter>();
  private readonly listeners = new Set<(change: TimeRegistryChange) => void>();
  constructor(private activeId: string) {}

  /** Subscribe to register/unregister notifications; returns an unsubscribe function. */
  onChange(cb: (change: TimeRegistryChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private notify(change: TimeRegistryChange): void {
    for (const cb of this.listeners) cb(change);
  }

  register(a: TimeAdapter): () => void {
    this.adapters.set(a.id, a);
    this.notify({ id: a.id, kind: "register" });
    return () => {
      if (this.adapters.get(a.id) === a) {
        this.adapters.delete(a.id);
        this.notify({ id: a.id, kind: "unregister" });
      }
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
