/**
 * The settings tab's "Current day" field: a date the active calendar writes, or a whole day number.
 * Pure helpers; the tab supplies the calendar's `format` and `parse`.
 */
import { MAX_DAY_ORDINAL } from "./world";
import { withMinus } from "../core/report";

export interface DayText {
  format(d: number): string;
  /** null when the text is not a date this calendar writes; absent when the calendar cannot parse. */
  parse?: (text: string) => number | null;
}

export const BAD_DAY_TEXT = "Not a date this calendar writes, nor a whole day number.";

/** What the field shows: the calendar's date when it reads back to the same day, else the bare day number. */
export function dayFieldText(cal: DayText, d: number): string {
  try {
    const text = cal.format(d);
    if (cal.parse && cal.parse(text) === d) return text;
  } catch {
    // fall through to the bare number
  }
  return String(d);
}

/** The day a typed text means: a whole day number, or a date the calendar parses. null when neither. */
export function parseDayField(cal: DayText, text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[-+]?\d+$/.test(t)) {
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (!cal.parse) return null;
  try {
    const d = cal.parse(t);
    return typeof d === "number" && Number.isSafeInteger(d) ? d : null;
  } catch {
    return null;
  }
}

/** The validation message for the typed text, or undefined when it is a usable day. */
export function validateDayField(cal: DayText, text: string): string | undefined {
  const d = parseDayField(cal, text);
  if (d === null) return BAD_DAY_TEXT;
  if (Math.abs(d) > MAX_DAY_ORDINAL) return `Between ${withMinus(-MAX_DAY_ORDINAL)} and ${MAX_DAY_ORDINAL} only.`;
  return undefined;
}
