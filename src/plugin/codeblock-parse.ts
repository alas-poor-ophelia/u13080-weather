/**
 * Parser for the ```wadjet codeblock body. Pure.
 *
 *   zone: greywold-highlands      (required unless a default zone exists)
 *   date: today | +3 | -1 | <dayOrdinal> | <adapter date string>
 *   hour: 14                      (optional)
 *   style: card | line | prose | table | value
 *   range: 7                      (table only; days from `date`)
 *   field: precipitation.amount   (value only; a ConvertedReport leaf)
 *   units: metric | imperial      (optional; default is the setting)
 *   interpret: my-system.mood     (optional; interpreter ids, comma list)
 */
import { isReportField, type ReportField, type Units } from "../core/units";

export interface CodeblockSpec {
  zone?: string;
  date: string;
  hour?: number;
  style: "card" | "line" | "prose" | "table" | "value";
  range: number;
  field?: ReportField;
  units?: Units;
  /** interpreter ids whose result is shown under the card/line/prose */
  interpret?: string[];
  errors: string[];
}

const STYLES = new Set(["card", "line", "prose", "table", "value"]);

export function parseCodeblock(source: string): CodeblockSpec {
  const spec: CodeblockSpec = { date: "today", style: "card", range: 7, errors: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z]+)\s*:\s*(.*)$/);
    if (!m) {
      spec.errors.push(`cannot parse line "${line}"`);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    switch (key) {
      case "zone":
        spec.zone = val;
        break;
      case "date":
        spec.date = val || "today";
        break;
      case "hour": {
        const h = Number(val);
        if (!Number.isFinite(h) || h < 0 || h >= 24) spec.errors.push(`hour must be 0–23.99 (got "${val}")`);
        else spec.hour = h;
        break;
      }
      case "style":
        if (STYLES.has(val)) spec.style = val as CodeblockSpec["style"];
        else spec.errors.push(`style must be card, line, prose, table or value (got "${val}")`);
        break;
      case "field":
        if (isReportField(val)) spec.field = val;
        else spec.errors.push(`unknown field "${val}" (see docs/API.md for the list)`);
        break;
      case "units":
        if (val === "metric" || val === "imperial") spec.units = val;
        else spec.errors.push(`units must be metric or imperial (got "${val}")`);
        break;
      case "range": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 366) spec.errors.push(`range must be 1–366 (got "${val}")`);
        else spec.range = n;
        break;
      }
      case "interpret": {
        const ids = val.split(",").map((x) => x.trim()).filter(Boolean);
        if (ids.length === 0) spec.errors.push("interpret needs at least one interpreter id");
        else spec.interpret = ids;
        break;
      }
      default:
        spec.errors.push(`unknown key "${key}"`);
    }
  }
  if (spec.style === "value" && !spec.field) spec.errors.push("style: value needs a field, e.g. field: precipitation.amount");
  if (spec.interpret && (spec.style === "table" || spec.style === "value")) spec.errors.push("interpret works with the card, line and prose styles");
  return spec;
}

/**
 * Which zone a block shows. An explicit `zone:` wins. Otherwise the resolver
 * chain is asked about the note itself (`{ kind: "note", path }`, which is
 * where the built-in `weather-zone` frontmatter resolver answers), then the
 * first zone. `viaResolver` tells the caller the answer can change when the
 * note's metadata does.
 */
export function pickCodeblockZone(spec: Pick<CodeblockSpec, "zone">, sourcePath: string, resolve: (path: string) => string | null, firstZone: string | undefined): { zoneId: string | undefined; viaResolver: boolean } {
  if (spec.zone !== undefined) return { zoneId: spec.zone, viaResolver: false };
  let resolved: string | null = null;
  try {
    resolved = sourcePath ? resolve(sourcePath) : null;
  } catch {
    resolved = null;
  }
  return { zoneId: resolved ?? firstZone, viaResolver: true };
}

/** Resolve the `date` field to a dayOrdinal given "today" and an optional adapter parser. */
export function resolveDate(date: string, today: number | null, parse?: (s: string) => number | null): { day: number | null; error?: string } {
  const d = date.trim();
  if (d === "today" || d === "") return today === null ? { day: null, error: "no current date: set one in Wadjet settings or use an explicit date" } : { day: today };
  const rel = d.match(/^([+-])\s*(\d+)$/);
  if (rel) {
    if (today === null) return { day: null, error: "relative dates need a current date" };
    const n = Number(rel[2]);
    return { day: rel[1] === "+" ? today + n : today - n };
  }
  if (/^-?\d+$/.test(d)) return { day: Number(d) };
  const parsed = parse?.(d) ?? null;
  return parsed === null ? { day: null, error: `cannot parse date "${d}"` } : { day: parsed };
}
