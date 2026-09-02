/**
 * Pins (overrides) — the one shape a hand-fixed day is written in.
 *
 * A pin is `Override { zoneId, dayOrdinal, patch }` (`core/report.ts`), and the
 * patch a *new* pin starts from is always the day's own generated weather: a
 * pin says "this day is exactly what the roll said, and it stays that way even
 * if the profile moves". Two surfaces create one — the settings tab's pin
 * editor and the studio's audition strip (SPEC §3.5) — so the reduction lives
 * here rather than in either of them.
 *
 * Pure: a `WeatherReport` in, an `OverridePatch` out. No plugin, no world, no
 * Obsidian — the caller owns fetching the report (and deciding what to do when
 * there isn't one).
 */
import type { OverridePatch, WeatherReport } from "../core/report";

/**
 * A generated report reduced to the fields the pin editor exposes: the whole
 * temperature triple, precipitation type + amount, and the wind vector. The
 * fields left out (humidity, cloud cover, visibility, conditions, descriptors)
 * are re-derived from these by `buildReport`, so a pin that carried them would
 * freeze values the user never chose.
 */
export function generatedPatch(report: WeatherReport): OverridePatch {
  return {
    temperature: { ...report.temperature },
    precipitation: { type: report.precipitation.type, amountMm: report.precipitation.amountMm },
    wind: { ...report.wind },
  };
}
