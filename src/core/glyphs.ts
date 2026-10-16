/**
 * Weather glyphs (integration API, DESIGN.md §E as revised by R7).
 *
 * A small, closed, hand-authored line-icon family: monochrome (`currentColor`
 * strokes, plus round-cap dots), square viewBox 0 0 24 24, 1.75 stroke with
 * round caps and joins. The SVG strings carry no scripts, no event handlers,
 * no ids and no external references, so they are safe to insert through
 * DOMParser or innerHTML.
 *
 * `glyphKey(report)` is PRESENTATION, not classification: its precedence is
 * non-normative and may be refined. Consumers that prefer their own art map
 * the key to it.
 */
import { beaufort } from "./classify";
import type { WeatherReport } from "./report";

export type GlyphKey = "clear" | "partly-cloudy" | "cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "heavy-rain" | "sleet" | "snow" | "heavy-snow" | "windy";

export const GLYPH_KEYS: readonly GlyphKey[] = Object.freeze([
  "clear",
  "partly-cloudy",
  "cloudy",
  "overcast",
  "fog",
  "drizzle",
  "rain",
  "heavy-rain",
  "sleet",
  "snow",
  "heavy-snow",
  "windy",
] as const);

/** Precipitation intensity (0..1) at which rain and snow take their heavy glyph. */
export const HEAVY_INTENSITY = 0.6;
/** Beaufort force from which a dry, fog-free day shows the windy glyph (6 = strong breeze). */
export const WINDY_BEAUFORT = 6;

/**
 * Precedence (non-normative presentation, the same order the codeblock icon
 * has always used, extended):
 *   1. fog condition                 → fog
 *   2. precipitation type            → drizzle | rain | sleet | snow
 *      (rain and snow → heavy-rain / heavy-snow when intensity ≥ 0.6)
 *   3. Beaufort ≥ 6                  → windy
 *   4. cloud ≥ 0.8 → overcast; ≥ 0.6 → cloudy; ≥ 0.4 → partly-cloudy; else clear
 */
export function glyphKey(report: WeatherReport): GlyphKey {
  if (report.conditions.includes("fog")) return "fog";
  const heavy = report.precipitation.intensity >= HEAVY_INTENSITY;
  switch (report.precipitation.type) {
    case "none":
      break;
    case "drizzle":
      return "drizzle";
    case "sleet":
      return "sleet";
    case "snow":
      return heavy ? "heavy-snow" : "snow";
    default:
      return heavy ? "heavy-rain" : "rain"; // rain, and any type an override invents
  }
  if (beaufort(report.wind.speedKph) >= WINDY_BEAUFORT) return "windy";
  if (report.cloudCover >= 0.8) return "overcast";
  if (report.cloudCover >= 0.6) return "cloudy";
  if (report.cloudCover >= 0.4) return "partly-cloudy";
  return "clear";
}

// ---------------------------------------------------------------------------
// Art. Every glyph is a list of path `d` strings drawn with the shared stroke.
// Dots are zero-length segments ("h.01"), which round caps turn into discs.
// ---------------------------------------------------------------------------

/** A full cloud sitting on y = 18.5. */
const CLOUD = "M7 18.5h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.3 10.6A4 4 0 0 0 7 18.5Z";
/** A raised cloud sitting on y = 13.5, leaving room for what falls from it. */
const CLOUD_HIGH = "M7.5 13.5h9.5a3 3 0 0 0 .4-5.97A5 5 0 0 0 7.6 6.6A3.5 3.5 0 0 0 7.5 13.5Z";

/** A six-armed snowflake centred on (x, y), arm length r. */
function flake(x: number, y: number, r = 2.1): string {
  const n = (v: number) => String(Math.round(v * 100) / 100);
  const dx = r * 0.5;
  const dy = r * 0.866;
  return `M${n(x - r)} ${n(y)}h${n(2 * r)}M${n(x - dx)} ${n(y - dy)}l${n(2 * dx)} ${n(2 * dy)}M${n(x + dx)} ${n(y - dy)}l${n(-2 * dx)} ${n(2 * dy)}`;
}
const dot = (x: number, y: number) => `M${x} ${y}h.01`;

const ART: Record<GlyphKey, string[]> = {
  clear: [
    "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z",
    "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.28 5.28l1.42 1.42M17.3 17.3l1.42 1.42M5.28 18.72l1.42-1.42M17.3 6.7l1.42-1.42",
  ],
  "partly-cloudy": [
    // the sun clears the cloud; only the rays that would cross it are left out
    "M7.5 4.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z",
    "M7.5 1.5v1.5M1.5 7.5h1.5M12 7.5h1.5M3.26 3.26l1.06 1.06M11.74 3.26l-1.06 1.06M3.26 11.74l1.06-1.06",
    "M9 19.5h9.25a3.25 3.25 0 0 0 .3-6.49A4.75 4.75 0 0 0 9.9 12.1A3.75 3.75 0 0 0 9 19.5Z",
  ],
  cloudy: [CLOUD],
  overcast: [
    // a second cloud behind the first: only its upper right rim shows
    "M10.6 8.2A5 5 0 0 1 19.3 9.8A2.75 2.75 0 0 1 20.3 15",
    "M5.5 20h9.5a3.25 3.25 0 0 0 .3-6.49A4.75 4.75 0 0 0 6.4 12.6A3.5 3.5 0 0 0 5.5 20Z",
  ],
  fog: ["M4 7h16", "M2.5 11h13M18.5 11h3", "M5 15h16", "M3.5 19h6M12.5 19h8"],
  drizzle: [CLOUD_HIGH, dot(8.5, 17), dot(12.5, 17), dot(16.5, 17), dot(10.5, 20.5), dot(14.5, 20.5)],
  rain: [CLOUD_HIGH, "M9 16.5l-1.25 3.5M13 16.5l-1.25 3.5M17 16.5l-1.25 3.5"],
  "heavy-rain": [CLOUD_HIGH, "M8 16l-2 5.5M11.5 16l-2 5.5M15 16l-2 5.5M18.5 16l-2 5.5"],
  sleet: [CLOUD_HIGH, "M9 16.5l-1.25 3.5", flake(15.5, 18.75)],
  snow: [CLOUD_HIGH, flake(8.5, 18.75), flake(15.5, 18.75)],
  "heavy-snow": [CLOUD_HIGH, flake(6.75, 17.75, 1.9), flake(17.25, 17.75, 1.9), flake(12, 20.25, 1.9)],
  windy: ["M3 9h11.5a2.5 2.5 0 1 0-2.5-2.5", "M3 13h15.5a3 3 0 1 1-3 3", "M3 17h8"],
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function isGlyphKey(x: unknown): x is GlyphKey {
  return typeof x === "string" && (GLYPH_KEYS as readonly string[]).includes(x);
}

/**
 * The SVG markup for a glyph key, or for a report's key. `size` sets width and
 * height in px (default 24); `title` adds an accessible <title> (escaped).
 * Unknown keys throw RangeError.
 */
export function glyph(keyOrReport: GlyphKey | WeatherReport, options?: { size?: number; title?: string } | null): string {
  const opts = options ?? {}; // null reads like undefined
  let key: GlyphKey;
  if (typeof keyOrReport === "string") {
    if (!isGlyphKey(keyOrReport)) throw new RangeError(`Unknown glyph key "${String(keyOrReport)}". Known keys: ${GLYPH_KEYS.join(", ")}.`);
    key = keyOrReport;
  } else key = glyphKey(keyOrReport);
  const size = typeof opts.size === "number" && Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 24;
  const title = typeof opts.title === "string" && opts.title !== "" ? opts.title : undefined;
  const a11y = title !== undefined ? ` role="img"` : ` aria-hidden="true"`;
  const paths = ART[key].map((d) => `<path d="${d}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="wadjet-glyph wadjet-glyph-${key}"${a11y}>` +
    (title !== undefined ? `<title>${escapeXml(title)}</title>` : "") +
    paths +
    `</svg>`
  );
}
