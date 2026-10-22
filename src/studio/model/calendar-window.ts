/**
 * The Calendar window's words (docs/SESHAT-v0.md §15.4, §15.1 R5): how a
 * year, its leap rule and the definition's other parts read on screen, and
 * the WRITES line. Pure: no Obsidian imports (PLAN D3).
 */
import type { LeapTerm, MonthForm, YearForm } from "../../plugin/time/form";
import type { FormDraft } from "./state";
import { grammar } from "./copy";

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st */
const ordinal = (n: number): string => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`);

/** One leap term as words: "every 4th year", "every 100th year counting from year 56". */
function termWords(t: LeapTerm): string {
  const each = t.every === 1 ? "every year" : `every ${ordinal(t.every)} year`;
  return t.at === 0 ? each : `${each} counting from year ${t.at}`;
}

/**
 * A year's rule as a sentence, from its own values: "365 days", "365 days; a
 * leap year (366 days) every 4th year, except every 100th year, but every
 * 400th year". Terms after the first read as exceptions and re-inclusions,
 * as the gear counts them.
 */
export function yearWords(y: YearForm): string {
  const base = `${y.length} day${y.length === 1 ? "" : "s"}`;
  if (!y.leap || y.leap.terms.length === 0) return base;
  const days = y.length + y.leap.add;
  const parts = y.leap.terms.map((t, i) => {
    const words = termWords(t);
    if (i === 0) return t.sign === 1 ? words : `not ${words}`;
    return t.sign === 1 ? `but ${words}` : `except ${words}`;
  });
  return `${base}; a leap year (${days} days) ${parts.join(", ")}`;
}

/** A month list as one line: "12 months (one takes the rest)". */
export function monthsWords(months: readonly MonthForm[] | null | undefined): string {
  if (!months || months.length === 0) return "no months";
  const rest = months.some((m) => m.length === "slack") ? " (one takes the rest)" : "";
  return `${months.length} month${months.length === 1 ? "" : "s"}${rest}`;
}

/** A week as one line: "a 7-day week". */
export function weekWords(week: readonly string[] | null | undefined): string {
  if (!week || week.length === 0) return "no week";
  return `a ${week.length}-day week`;
}

/** A month length as typed: a whole number of days, or "rest" (any case); null when it is neither. */
export function parseMonthLength(text: string): number | "slack" | null {
  const t = text.trim().toLowerCase();
  if (t === "rest") return "slack";
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** A month length as shown. */
export function showMonthLength(length: number | "slack"): string {
  return length === "slack" ? "rest" : String(length);
}

/**
 * The WRITES line (SPEC law 5): which parts of the definition the draft
 * holds as fields, one line, never JSON.
 */
export function calendarGrammar(form: FormDraft | undefined): string {
  if (!form) return grammar("calendar", "the legacy calendar's fields");
  const parts = [form.year ? `year ${yearWords(form.year)}` : "year as text", form.months === undefined ? "months as text" : monthsWords(form.months), form.week === undefined ? "week as text" : weekWords(form.week)];
  return grammar(`calendar [${parts.join(" · ")}]`, "the stored definition");
}
