/**
 * Pure formatting helper for the settings tab's read-only calendar row
 * (PLAN §3, bead wadjet-9f9.11). Kept separate from settings-tab.ts so the
 * string-building logic is unit-testable without the Obsidian API.
 */
import type { CalendarDescription } from "./time/adapter";

/**
 * One-line summary: "year of N days · N seasons · N moons", omitting the
 * seasons/moons segment when that count is 0, with `editHint` appended
 * (space-dot-separated) when present.
 */
export function calendarSummary(d: CalendarDescription): string {
  const parts = [`year of ${d.yearLength} days`];
  if (d.seasons.length > 0) parts.push(`${d.seasons.length} seasons`);
  if (d.moons.length > 0) parts.push(`${d.moons.length} moons`);
  const summary = parts.join(" · ");
  return d.editHint ? `${summary} · ${d.editHint}` : summary;
}
