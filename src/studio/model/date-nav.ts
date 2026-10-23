/**
 * Studio date navigation (bead wadjet-n1z): the header's go-to box reads a
 * date the way the active calendar writes it, moves the window onto that day,
 * and the day card names its day in the same words. Pure: no Obsidian
 * imports (PLAN D3); the calendar's own parse and format are handed in.
 */
import { centreOn, type Window, type ZoomBounds } from "./zoom";
import type { YearSeam } from "./years";

export type GoTo = { ok: true; day: number } | { ok: false; message: string };

/**
 * A typed date: whatever the calendar's own `parse` accepts (a definition's
 * parseable formats, the internal calendar's `Year 3, day 12` and `3-12`, a
 * third-party adapter's own), or a whole day number. Never throws: a parser
 * that throws reads as no date.
 */
export function parseGoTo(text: string, parse?: (text: string) => number | null): GoTo {
  const t = text.trim();
  if (t === "") return { ok: false, message: "type a date" };
  let day: number | null = null;
  if (parse) {
    try {
      const d = parse(t);
      day = typeof d === "number" && Number.isSafeInteger(d) ? d : null;
    } catch {
      day = null;
    }
  }
  if (day === null && /^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) day = n;
  }
  return day === null ? { ok: false, message: "not a date in this calendar" } : { ok: true, day };
}

/**
 * The window centred on the middle of `day`, its width kept (the day card's
 * own jump does the same). `null` when the day lies outside the timeline the
 * Studio can show: the clamp would leave the window somewhere else.
 */
export function goToWindow(w: Window, day: number, years: YearSeam, bounds: ZoomBounds): Window | null {
  let centre: number;
  try {
    centre = years.dayMid(day);
  } catch {
    return null; // past the calendar's own day range
  }
  if (!Number.isFinite(centre) || centre < bounds.min || centre > bounds.max) return null;
  return centreOn(w, centre, bounds);
}

/**
 * The day card's title: the day as the calendar writes it (its default
 * format, the one typed dates use), or `Day N` when the calendar has no
 * format or its format throws.
 */
export function dayTitle(day: number, formatDay?: (day: number) => string): string {
  if (formatDay) {
    try {
      const s = formatDay(day);
      if (typeof s === "string" && s.trim() !== "") return s;
    } catch {
      // fall through to the bare number
    }
  }
  return `Day ${day}`;
}
