/**
 * The Orrery's transport, scrub bar, season strip and fit (docs/SESHAT-v0.md
 * §18.3 D5 D7, §18.6 items 9 and 14; bead wadjet-b6x, slice 1a-ii). Pure:
 * the window (ui/windows/orrery.ts) only paints what these return.
 *
 * - The Orrery holds its own day (D7). ‹ › move it one day, « » one year
 *   keeping the day of the year (clamped to the target year's length), and
 *   every result stays on the day line (`clampDay`). Nothing here touches
 *   `view.window` or the settings.
 * - The scrub bar is one segment per slot of the year's first slot unit in
 *   the shown year; a press or drag at fraction f of the bar is day
 *   `start + floor(f · length)`, clamped into the year.
 * - The fit (§18.6 item 9) is read from the Studio box, not the Obsidian
 *   window: width min(1200, box − 16), body height 480–640 px, and the scope
 *   hidden once the centre column would fall under 280 px.
 */
import type { CalendarAst } from "../../seshat";
import { clampDay, yearFacts, type DayFacts, type YearFacts } from "./orrery-geometry";

/** The scope's themes (the handoff's `theme` prop); phosphor is the default (§18.4 Q2). */
export type OrreryTheme = "phosphor" | "amber" | "studio";
export const ORRERY_THEMES: readonly OrreryTheme[] = ["phosphor", "amber", "studio"];

/** RATE, in days a second (the handoff's segmented `1 / 7 / 30 / 365`). */
export const ORRERY_RATES = [1, 7, 30, 365] as const;
export type OrreryRate = (typeof ORRERY_RATES)[number];

/** The season palette the handoff cycles (Design tokens). */
export const SEASON_COLOURS = ["#7fd6a8", "#e8c15a", "#f0885c", "#5cb8f0", "#cdd9ee", "#b9c2cf"] as const;

/** The whole day `n` days from `day`, kept on the day line. */
export function stepDay(day: number, n: number): number {
  return Math.floor(clampDay(Math.floor(day) + n + 0.5).day);
}

/**
 * The day `n` years from the day `dayOfYear` days into `year`, on the same
 * day of the year, or the target year's last day when it is shorter (« »).
 * A year past the day line, or one the engine cannot reach, leaves the day
 * where it was.
 */
export function stepYear(ast: CalendarAst, year: YearFacts, dayOfYear: number, n: number): number {
  const here = year.start + dayOfYear;
  if (n === 0) return here;
  let to: YearFacts | null;
  try {
    to = yearFacts(ast, year.index + n);
  } catch {
    to = null;
  }
  if (!to || to.length <= 0) return here;
  const day = to.start + Math.max(0, Math.min(dayOfYear, to.length - 1));
  const c = clampDay(day + 0.5);
  return c.clamped ? here : day;
}

/** The day a press at fraction `f` (0–1) of the scrub bar names: a day of the shown year. */
export function scrubDay(year: YearFacts, f: number): number {
  const at = Number.isFinite(f) ? f : 0;
  return year.start + Math.max(0, Math.min(year.length - 1, Math.floor(at * year.length)));
}

/** Where the playhead sits on the bar for a (fractional) transport day, 0–1. */
export function scrubFraction(year: YearFacts, day: number): number {
  if (year.length <= 0) return 0;
  return Math.max(0, Math.min(1, (day - year.start) / year.length));
}

export type ScrubKind = "filler" | "rest" | "even" | "odd" | "current";

export interface ScrubSegment {
  /** fractions of the bar */
  readonly left: number;
  readonly width: number;
  readonly kind: ScrubKind;
  readonly name: string;
}

/**
 * The scrub bar's segments: one per slot of the year's first slot unit this
 * year (filler gold, a slot that takes the rest grey, the rest alternating,
 * the slot holding the day lit). A slot of length 0 is left out. A year with
 * no slot unit is one segment.
 */
export function scrubSegments(ast: CalendarAst, year: YearFacts, today: DayFacts): ScrubSegment[] {
  const table = year.slots.find((t) => t.path.length === 1);
  if (!table || year.length <= 0) return [{ left: 0, width: 1, kind: "current", name: year.unit }];
  const unit = ast.units.find((u) => u.id === table.unit);
  const slots = unit?.kind === "slots" ? unit.slots : [];
  const number = unit?.kind === "slots" ? (unit.number ?? 1) : 1;
  const out: ScrubSegment[] = [];
  const here = today.day - year.start;
  let at = 0;
  let shown = 0;
  table.lengths.forEach((len, i) => {
    if (len <= 0) return;
    const s = slots[i];
    const current = here >= at && here < at + len;
    const kind: ScrubKind = current ? "current" : s?.filler ? "filler" : s?.length === "slack" ? "rest" : shown % 2 === 0 ? "even" : "odd";
    out.push({ left: at / year.length, width: len / year.length, kind, name: s?.name ?? `${table.unit} ${i + number}` });
    at += len;
    shown++;
  });
  return out;
}

export interface SeasonSegment {
  readonly left: number;
  readonly width: number;
  readonly colour: string;
  readonly name: string;
}

/**
 * The season strip over the scrub bar: each mark runs to the next one, the
 * last wraps to the year's end, and the days before the first mark belong to
 * the season that was running (the last one). Colours follow the marks'
 * declaration order through the season palette.
 */
export function seasonSegments(year: YearFacts): SeasonSegment[] {
  const marks = [...year.seasons].sort((a, b) => a.at - b.at);
  if (!marks.length || year.length <= 0) return [];
  const colour = (order: number) => SEASON_COLOURS[order % SEASON_COLOURS.length]!;
  const out: SeasonSegment[] = [];
  const last = marks[marks.length - 1]!;
  if (marks[0]!.at > 0) out.push({ left: 0, width: marks[0]!.at / year.length, colour: colour(last.order), name: last.name });
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : year.length;
    if (end > m.at) out.push({ left: m.at / year.length, width: (end - m.at) / year.length, colour: colour(m.order), name: m.name });
  });
  return out;
}

/** The handoff's grid: 216 px | scope | 284 px. */
export const ORRERY_COLUMNS = { list: 216, inspector: 284, scopeMin: 280 } as const;
export const ORRERY_WIDTH = 1200;
export const ORRERY_BODY = { min: 480, max: 640 } as const;
/** The panel's chrome around the body: title bar, WRITES footer, one issue line, and the box's 16 px margin. */
export const ORRERY_CHROME = 112;

export interface OrreryFit {
  /** the panel's outer width */
  readonly width: number;
  /** the body's height */
  readonly bodyHeight: number;
  /** false once the centre column would fall under its 280 px floor: the list and inspector stay */
  readonly scope: boolean;
}

/** The Orrery's size in a Studio box of `boxW × boxH` CSS pixels (§18.6 item 9). */
export function orreryFit(boxW: number, boxH: number): OrreryFit {
  const width = Math.max(0, Math.min(ORRERY_WIDTH, Math.floor(boxW) - 16));
  const bodyHeight = Math.max(ORRERY_BODY.min, Math.min(ORRERY_BODY.max, Math.floor(boxH) - ORRERY_CHROME));
  // the panel's 1 px rim on each side is part of its outer width
  const centre = width - 2 - ORRERY_COLUMNS.list - ORRERY_COLUMNS.inspector;
  return { width, bodyHeight, scope: centre >= ORRERY_COLUMNS.scopeMin };
}
