/**
 * The Calendar window's words (docs/SESHAT-v0.md §15.4, §15.1 R5): how a
 * year, its leap rule and the definition's other parts read on screen, and
 * the WRITES line. Pure: no Obsidian imports (PLAN D3).
 */
import type { LeapTerm, LedgerForm, MonthForm, YearForm } from "../../plugin/time/form";
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

/** What the ledger's words need from the calendar: dates in its own format, and where its years start. */
export interface LedgerView {
  /** a day in the calendar's own format */
  date(day: number): string;
  /** the first day of the year with this displayed number, or null when it cannot say */
  yearStart(year: number): number | null;
  /** the displayed number of the year with occurrence index 0 */
  firstYear: number;
}

/** One ledger entry as the window lists it. */
export interface LedgerRow {
  /** stable within a draft: `unit:<id>:<i>`, `day:<i>`, `skip:<rule>:<day>` */
  readonly key: string;
  /** the first day it touches, for the order of the list (null: unknown, listed last) */
  readonly first: number | null;
  readonly text: string;
  /** a switch's rule is edited as text */
  readonly asText: boolean;
}

/**
 * The ledger as sentences, sorted by the first day each entry touches:
 * marked days, skipped days of named rules, moved year starts, one year's
 * month lengths, and rule switches. Pure.
 */
export function ledgerRows(ledger: LedgerForm, v: LedgerView): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const yearOf = (index: number) => index + v.firstYear;
  for (const [unit, entries] of Object.entries(ledger.units)) {
    entries.forEach((e, i) => {
      const key = `unit:${unit}:${i}`;
      const what = unit === "year" ? `Year ${yearOf(e.from)}` : `${unit} ${e.from}`;
      const start = unit === "year" ? v.yearStart(yearOf(e.from)) : null;
      if (e.kind === "starts") {
        const more = e.lengths?.length ? `, then ${e.lengths.length} more pinned (${e.lengths.join(", ")} days)` : "";
        rows.push({ key, first: e.startsOn, text: `${what} starts on ${v.date(e.startsOn)}${more}`, asText: false });
      } else if (e.kind === "slots") {
        rows.push({ key, first: start, text: `${what}: ${e.unit} lengths ${e.lengths.join(", ")}${e.path?.length ? ` (inside ${e.path.join(".")})` : ""}`, asText: false });
      } else {
        rows.push({ key, first: start, text: `From ${what} on: a different rule`, asText: true });
      }
    });
  }
  ledger.days.forEach((d, i) => {
    const tags = d.tags?.length ? ` (${d.tags.join(", ")})` : "";
    rows.push({ key: `day:${i}`, first: d.day, text: `${v.date(d.day)}: ${d.name ?? "marked"}${tags}`, asText: false });
  });
  for (const [rule, days] of Object.entries(ledger.skips)) {
    for (const day of days) rows.push({ key: `skip:${rule}:${day}`, first: day, text: `${v.date(day)}: rule ${rule} skips this day`, asText: false });
  }
  return rows.sort((a, b) => (a.first ?? Infinity) - (b.first ?? Infinity));
}

/** Month lengths as typed: whole numbers of days, separated by commas or spaces; null when any is not. */
export function parseLengths(text: string): number[] | null {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) return null;
  const out = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  return out.every((n) => Number.isSafeInteger(n)) ? out : null;
}
