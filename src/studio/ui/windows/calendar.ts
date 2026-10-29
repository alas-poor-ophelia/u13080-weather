/**
 * Calendar · CALENDAR (docs/SESHAT-v0.md §15.4, §15.1 R1 R5; one window by
 * ruling 2026-10-21): the world's calendar, one part per tab.
 *
 * - Seasons: the Seasons editor (windows/seasons.ts), hosted as it is.
 * - A world that runs a definition: Year (name, length, first year, leap
 *   rules behind "edit rules"), Months, Week. A part the form reads as fields
 *   is edited in the world draft (`world.calendar.form`); Save compiles it
 *   into the stored definition through the Save dialog. A part the form
 *   cannot show says what it is, why, and offers "Edit as text".
 * - The legacy calendar: a Calendar tab saying what it is, with "Change
 *   calendar…"; a calendar plugin: its `· read-only` chip and hint; a
 *   definition that cannot run: the fault and "Edit as text".
 *
 * The tab panel has a fixed height and scrolls inside, so the window keeps
 * its size whichever part is shown. A heavier design pass is bead wadjet-b6x.
 *
 * A field commits on change (Enter or leaving it). Every edit reads the
 * draft as it is at that moment, and the panel is redrawn from the draft
 * right after it, with focus back on the control of the same key (a field
 * being typed in keeps what was typed): no control acts on a stale value.
 */
import { Notice } from "obsidian";
import { canonicalJson } from "../../../core/profile";
import { YEAR_LENGTH_MAX } from "../../../core/modifiers";
import type { LeapTerm, MonthForm, YearForm } from "../../../plugin/time/form";
import { compile, followSentence, recognise, type CalendarForm, type LedgerForm } from "../../../plugin/time/form";
import { prepareDefinition } from "../../../plugin/time/seshat";
import { print, type LedgerEntry } from "../../../seshat";
import { DefinitionModal, OptInModal } from "../../../plugin/calendar-modals";
import { calendarGrammar, ledgerRows, monthsWords, parseLengths, parseMonthLength, showMonthLength, weekWords, yearWords, type LedgerRow } from "../../model/calendar-window";
import { calendarHint } from "../../model/hints-calendar";
import type { FormDraft, StudioState } from "../../model/state";
import { calendarOfDefinition } from "../../model/definition";
import { createChip, createSegmented, type ChipComponent, type SegmentedOption } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder, WindowManager } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";
import { buildSeasonsWindow } from "./seasons";

/** The id this window is registered and opened under. */
export const CALENDAR_WINDOW = "calendar";

export type CalendarTab = "seasons" | "year" | "months" | "week" | "ledger" | "calendar";

/** Open windows' tab switches, by the manager that holds them. */
const switchers = new WeakMap<WindowManager, (tab: CalendarTab) => void>();
/** The tab a window about to open starts on. */
let opening: CalendarTab = "seasons";

/** Open the Calendar window on `tab` (or bring it forward and switch to it). */
export function openCalendarWindow(ctx: SurfaceContext, tab: CalendarTab): void {
  opening = tab;
  ctx.windows.open(CALENDAR_WINDOW);
  switchers.get(ctx.windows)?.(tab);
}

type Source = "seshat" | "legacy" | "fault" | "plugin";

function sourceOf(ctx: SurfaceContext, state: StudioState): Source {
  if (ctx.calendar()?.readOnly) return "plugin";
  return state.calendarSource ?? "legacy";
}

/** The stored definition as the form reads it, or null (no definition running). */
function storedForm(ctx: SurfaceContext): CalendarForm | null {
  const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
  return ast ? recognise(ast) : null;
}

/** A text year in words: "Each year begins on the day Moon reaches its New phase (354 to 355 days, around today)" for a year that follows a body, else its range. */
function yearText(ctx: SurfaceContext): string | null {
  const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
  const follows = ast ? followSentence(ast, "year") : null;
  const range = yearRange(ctx);
  if (!follows) return range;
  return range ? `${follows} (${range}).` : `${follows}.`;
}

/** "353 to 385 days around today": the year lengths a text year has, sampled 200 years either side of today. */
function yearRange(ctx: SurfaceContext): string | null {
  const cal = ctx.plugin.calendars.seshat;
  const today = ctx.plugin.settings.currentDayOrdinal;
  const here = cal?.yearOfDay(today);
  if (!cal || !here) return null;
  const lengths = new Set<number>();
  for (let k = -200; k <= 200; k++) {
    const a = cal.yearStart(here.year + k);
    const b = cal.yearStart(here.year + k + 1);
    if (a !== null && b !== null) lengths.add(b - a);
  }
  const sorted = [...lengths].sort((x, y) => x - y);
  if (sorted.length === 0) return null;
  return sorted.length === 1 ? `${sorted[0]} days` : `${sorted[0]} to ${sorted[sorted.length - 1]} days, around today`;
}


export const buildCalendarWindow: WindowBuilder = (ctx) => {
  const body = createDiv({ cls: "wadjet-studio-calendar" });
  const sourceChip: ChipComponent = createChip(createDiv(), { label: "calendar", hint: calendarHint("calendar.source"), dot: false });
  sourceChip.el.addClasses(["wadjet-studio-calendar-source", "is-tail"]);

  let tab: CalendarTab = opening;
  /** whether the Year tab shows its leap rules as fields (else as their sentence) */
  let rulesOpen = false;
  const tabsEl = body.createDiv({ cls: "wadjet-studio-calendar-tabs", attr: { "data-hint": calendarHint("calendar.tabs") } });
  const stage = body.createDiv({ cls: "wadjet-studio-calendar-stage" });
  // the Seasons editor, hosted whole: built once, shown on its tab
  const seasons: WindowBuild = buildSeasonsWindow(ctx);
  const seasonsHost = stage.createDiv({ cls: "wadjet-studio-calendar-seasons" });
  seasonsHost.appendChild(seasons.body);
  const panel = stage.createDiv({ cls: "wadjet-studio-calendar-panel" });

  const tabOptions = (src: Source): SegmentedOption[] =>
    src === "seshat"
      ? [
          { value: "seasons", label: "Seasons" },
          { value: "year", label: "Year" },
          { value: "months", label: "Months" },
          { value: "week", label: "Week" },
          { value: "ledger", label: "Exceptions" },
        ]
      : [
          { value: "seasons", label: "Seasons" },
          { value: "calendar", label: "Calendar" },
        ];
  /** a tab the current source does not offer falls back to the nearest one it does */
  const fit = (src: Source, t: CalendarTab): CalendarTab => (tabOptions(src).some((o) => o.value === t) ? t : t === "seasons" ? "seasons" : src === "seshat" ? "year" : "calendar");
  const tabs = createSegmented(tabsEl, {
    options: tabOptions(sourceOf(ctx, ctx.store.get())),
    value: fit(sourceOf(ctx, ctx.store.get()), tab),
    onChange: (v) => show(v as CalendarTab),
  });
  function show(next: CalendarTab): void {
    tab = fit(sourceOf(ctx, ctx.store.get()), next);
    tabs.update({ value: tab });
    paint(true);
  }
  switchers.set(ctx.windows, show);

  /**
   * One undoable edit of the draft's form fields, behind the session's world
   * confirm. `edit` reads the draft as it is at commit time, never a value
   * captured when the panel was drawn. A cancelled confirm redraws, so no
   * field keeps a value the draft does not hold.
   */
  function write(edit: (form: FormDraft) => void): void {
    confirmWorldEdit(
      ctx.plugin.app,
      ctx,
      "calendar",
      () => {
        ctx.store.update(
          (s) => {
            s.world.calendar.form ??= {};
            edit(s.world.calendar.form);
          },
          { history: true },
        );
        paint(true);
      },
      () => paint(true),
    );
  }
  const editYear = (fn: (y: YearForm) => YearForm) => write((f) => f.year && (f.year = fn(f.year)));
  const editLeap = (fn: (leap: NonNullable<YearForm["leap"]>) => YearForm["leap"]) => editYear((y) => (y.leap ? { ...y, leap: fn(y.leap) } : y));
  const editMonths = (fn: (list: MonthForm[]) => MonthForm[]) =>
    write((f) => {
      const next = fn([...(f.months ?? [])]);
      f.months = next.length ? next : null;
    });
  const editWeek = (fn: (days: string[]) => string[]) =>
    write((f) => {
      const next = fn([...(f.week ?? [])]);
      f.week = next.length ? next : null;
    });

  function line(parent: HTMLElement, text: string, cls = "wadjet-studio-calendar-line"): HTMLElement {
    return parent.createDiv({ cls, text });
  }

  /** `key` names the control across redraws, so focus comes back to it. */
  function button(parent: HTMLElement, key: string, text: string, label: string, hint: string, onClick: () => void): HTMLElement {
    const el = parent.createDiv({ cls: "wadjet-studio-calendar-button", text, attr: { role: "button", tabindex: "0", "aria-label": label, "data-hint": hint, "data-key": key } });
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      onClick();
    });
    return el;
  }

  /**
   * A field that commits on change (Enter, or leaving it); `parse` refuses a
   * value by returning undefined, and the field shows the draft's value
   * again. `key` names it across redraws.
   */
  function field<T>(parent: HTMLElement, key: string, value: string, label: string, hint: string, cls: string, parse: (text: string) => T | undefined, commit: (v: T) => void, numeric = false): HTMLInputElement {
    const input = parent.createEl("input", {
      cls: `wadjet-studio-calendar-field ${cls}${numeric ? " wadjet-studio-num" : ""}`,
      type: "text",
      attr: { spellcheck: "false", "aria-label": label, "data-hint": hint, "data-key": key, ...(numeric ? { inputmode: "numeric" } : {}) },
    });
    input.value = value;
    input.dataset.drawn = value;
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") input.blur();
      if (ev.key === "Escape") {
        input.value = value;
        input.blur();
      }
    });
    input.addEventListener("change", () => {
      const v = parse(input.value);
      if (v === undefined) {
        input.value = value;
        return;
      }
      commit(v);
    });
    return input;
  }

  // what prepareDefinition would refuse is refused at the field, where it was typed
  const whole = (min: number, max = Number.MAX_SAFE_INTEGER) => (t: string): number | undefined => {
    const n = Number(t.trim());
    return t.trim() !== "" && Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const anyWhole = (t: string): number | undefined => {
    const n = Number(t.trim());
    return t.trim() !== "" && Number.isSafeInteger(n) ? n : undefined;
  };
  const nonZero = (t: string): number | undefined => {
    const n = anyWhole(t);
    return n === 0 ? undefined : n;
  };
  const name = (t: string): string | undefined => (t.trim() === "" ? undefined : t.trim().normalize("NFC"));

  /**
   * Unsaved Studio edits the text editor would lose or collide with: the draft's form fields differ from the
   * stored definition's, or the AST layer or the moons (the Orrery's edits, slice 5a) differ from their base.
   */
  function unsavedFields(): boolean {
    const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
    if (!ast) return false;
    const s = ctx.store.get();
    const draft = s.world.calendar;
    const base = s.calendarBase ?? s.saved.world.calendar;
    if (draft.ast !== undefined && (canonicalJson(draft.ast) !== canonicalJson(base.ast ?? null) || canonicalJson(draft.moons) !== canonicalJson(base.moons))) return true;
    return canonicalJson(draft.form ?? {}) !== canonicalJson(calendarOfDefinition(ast).form ?? {});
  }

  function asText(parent: HTMLElement, key: string, what: string | null, why: string): void {
    if (what) line(parent, what);
    line(parent, `Written as text: ${why}.`, "wadjet-studio-calendar-why");
    button(parent, key, "Edit as text", "Edit the calendar definition as text", calendarHint("calendar.asText"), () => {
      // the text editor opens on the stored definition; the draft's field edits would be lost or collide there
      if (unsavedFields()) return void new Notice("Save or undo the calendar's unsaved edits first: Edit as text opens the stored definition.");
      new DefinitionModal(ctx.plugin.app, ctx.plugin, () => {}).open();
    });
  }

  // ---- the tabs of a definition

  function renderYear(form: FormDraft, stored: CalendarForm | null, why: (k: "name" | "year" | "months" | "week") => string): void {
    const top = panel.createDiv({ cls: "wadjet-studio-calendar-row" });
    top.createSpan({ text: "Name" });
    if (form.name !== undefined) field(top, "name", form.name, "Calendar name", calendarHint("calendar.name"), "is-name", name, (v) => write((f) => (f.name = v)));
    else top.createSpan({ cls: "wadjet-studio-calendar-why", text: "written as text" });

    const y = form.year;
    if (!y) {
      asText(panel, "year.text", yearText(ctx), why("year"));
      return;
    }
    const row = panel.createDiv({ cls: "wadjet-studio-calendar-row" });
    row.createSpan({ text: "Days" });
    field(row, "year.length", String(y.length), "Days in a year", calendarHint("calendar.days"), "is-short", whole(1, YEAR_LENGTH_MAX), (n) => editYear((cur) => ({ ...cur, length: n })), true);
    row.createSpan({ text: "First year" });
    field(row, "year.first", String(y.firstYear), "First year", calendarHint("calendar.firstYear"), "is-short", anyWhole, (n) => editYear((cur) => ({ ...cur, firstYear: n })), true);
    line(panel, yearWords(y), "wadjet-studio-calendar-summary");

    const leap = y.leap;
    const actions = panel.createDiv({ cls: "wadjet-studio-calendar-row" });
    if (leap) {
      button(actions, "leap.toggle", rulesOpen ? "hide rules ▴" : "edit rules ▾", rulesOpen ? "Hide the leap rules" : "Edit the leap rules", calendarHint("calendar.leapToggle"), () => {
        rulesOpen = !rulesOpen;
        paint(true);
      });
    }
    if (leap && rulesOpen) {
      const add = panel.createDiv({ cls: "wadjet-studio-calendar-row is-indented" });
      add.createSpan({ text: "A leap year adds" });
      field(add, "leap.add", String(leap.add), "Days a leap year adds", calendarHint("calendar.leapDays"), "is-short", nonZero, (n) => editLeap((cur) => ({ ...cur, add: n })), true);
      add.createSpan({ text: "days" });
      const setTerm = (i: number, fn: (t: LeapTerm) => LeapTerm) => editLeap((cur) => ({ ...cur, terms: cur.terms.map((x, j) => (j === i ? fn(x) : x)) }));
      leap.terms.forEach((t, i) => {
        const r = panel.createDiv({ cls: "wadjet-studio-calendar-row is-indented" });
        // the first rule makes leap years; a later one is an exception, or an exception to an exception
        if (i === 0) r.createSpan({ text: "Every" });
        else {
          const sign = r.createEl("select", { cls: "wadjet-studio-calendar-select dropdown", attr: { "aria-label": "Adds or removes", "data-hint": calendarHint("calendar.leapSign"), "data-key": `leap.${i}.sign` } });
          sign.createEl("option", { value: "1", text: "But also every" });
          sign.createEl("option", { value: "-1", text: "Except every" });
          sign.value = String(t.sign);
          sign.addEventListener("change", () => setTerm(i, (cur) => ({ ...cur, sign: sign.value === "-1" ? -1 : 1 })));
        }
        field(r, `leap.${i}.every`, String(t.every), "Every how many years", calendarHint("calendar.leapEvery"), "is-short", whole(1), (n) => setTerm(i, (cur) => ({ ...cur, every: n })), true);
        r.createSpan({ text: "years, from year" });
        field(r, `leap.${i}.at`, String(t.at), "Counting from year", calendarHint("calendar.leapFrom"), "is-short", anyWhole, (n) => setTerm(i, (cur) => ({ ...cur, at: n })), true);
        button(r, `leap.${i}.remove`, "×", "Remove this leap rule", calendarHint("calendar.leapRemove"), () =>
          editLeap((cur) => {
            const terms = cur.terms.filter((_, j) => j !== i);
            return terms.length ? { ...cur, terms } : null;
          }),
        );
      });
    }
    if (!leap || rulesOpen) {
      button(actions, "leap.new", leap ? "＋ rule" : "＋ leap years", "Add a leap rule", calendarHint("calendar.leapNew"), () => {
        rulesOpen = true;
        editYear((cur) => {
          const l = cur.leap;
          // exceptions alternate: every 4th, except every 100th, but every 400th
          const next: LeapTerm = l ? { every: (l.terms[l.terms.length - 1]?.every ?? 1) * 25, at: 0, sign: l.terms.length % 2 === 1 ? -1 : 1 } : { every: 4, at: 0, sign: 1 };
          return { ...cur, leap: { add: l?.add ?? 1, terms: [...(l?.terms ?? []), next] } };
        });
      });
    }
    if (stored && stored.others.length) asText(panel, "others.text", `Also ${stored.others.length} more unit${stored.others.length === 1 ? "" : "s"}: ${stored.others.join(", ")}`, "the fields show a year, its months and its week only");
  }

  function renderMonths(months: readonly MonthForm[] | null): void {
    line(panel, monthsWords(months), "wadjet-studio-calendar-summary");
    const grid = panel.createDiv({ cls: "wadjet-studio-calendar-grid" });
    (months ?? []).forEach((m, i) => {
      const cell = grid.createDiv({ cls: "wadjet-studio-calendar-cell" });
      field(cell, `month.${i}.name`, m.name, `Name of month ${i + 1}`, calendarHint("calendar.monthName"), "is-name", name, (v) => editMonths((list) => list.map((x, j) => (j === i ? { ...x, name: v } : x))));
      field(
        cell,
        `month.${i}.length`,
        showMonthLength(m.length),
        `Days in month ${i + 1}, or rest`,
        calendarHint("calendar.monthLength"),
        "is-short",
        (t) => {
          const len = parseMonthLength(t);
          return len === null || len === 0 ? undefined : len;
        },
        // one month takes the rest: marking another moves the mark
        (len) => editMonths((list) => list.map((x, j) => (j === i ? { ...x, length: len } : len === "slack" && x.length === "slack" ? { ...x, length: 30 } : x))),
        true,
      );
      button(cell, `month.${i}.remove`, "×", `Remove month ${i + 1}`, calendarHint("calendar.monthRemove"), () => editMonths((list) => list.filter((_, j) => j !== i)));
    });
    button(panel, "month.new", months?.length ? "＋ month" : "＋ months", "Add a month", calendarHint("calendar.monthNew"), () =>
      editMonths((list) => [...list, { name: `Month ${list.length + 1}`, length: list.some((x) => x.length === "slack") ? 30 : "slack" }]),
    );
  }

  function renderWeek(week: readonly string[] | null): void {
    line(panel, weekWords(week), "wadjet-studio-calendar-summary");
    if (week === null || week.length === 0) {
      button(panel, "week.new", "＋ a week", "Add a week", calendarHint("calendar.weekNew"), () => editWeek(() => ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"]));
      return;
    }
    const grid = panel.createDiv({ cls: "wadjet-studio-calendar-grid" });
    week.forEach((d, i) => {
      const cell = grid.createDiv({ cls: "wadjet-studio-calendar-cell" });
      field(cell, `day.${i}.name`, d, `Name of day ${i + 1}`, calendarHint("calendar.dayName"), "is-name", name, (v) => editWeek((days) => days.map((x, j) => (j === i ? v : x))));
      button(cell, `day.${i}.remove`, "×", `Remove day ${i + 1}`, calendarHint("calendar.dayRemove"), () => editWeek((days) => days.filter((_, j) => j !== i)));
    });
    button(panel, "day.new", "＋ day", "Add a day to the week", calendarHint("calendar.dayNew"), () => editWeek((days) => [...days, `Day ${days.length + 1}`]));
  }

  // ---- the ledger tab

  /** what the "add" row holds while it is filled in; it survives redraws */
  const adding = { kind: "mark", date: "", name: "", tags: "", rule: "", year: "", lengths: "" };

  const editLedger = (fn: (l: LedgerForm) => LedgerForm) => write((f) => f.ledger && (f.ledger = fn(f.ledger)));

  function removeRow(key: string): void {
    const [kind, a, b] = key.split(":");
    editLedger((l) => {
      if (kind === "unit") {
        const rest = (l.units[a!] ?? []).filter((_, i) => i !== Number(b));
        const units = { ...l.units };
        if (rest.length) units[a!] = rest;
        else delete units[a!];
        return { ...l, units };
      }
      if (kind === "day") return { ...l, days: l.days.filter((_, i) => i !== Number(a)) };
      const rest = (l.skips[a!] ?? []).filter((d) => d !== Number(b));
      const skips = { ...l.skips };
      if (rest.length) skips[a!] = rest;
      else delete skips[a!];
      return { ...l, skips };
    });
  }

  /** The draft's ledger checked against the stored definition: each problem on the row it names, the rest above the list. */
  function ledgerProblems(ledger: LedgerForm): { byRow: Map<string, string[]>; loose: string[] } {
    const byRow = new Map<string, string[]>();
    const loose: string[] = [];
    const ast = ctx.plugin.calendars.seshat?.definition();
    if (!ast) return { byRow, loose };
    let text: string;
    try {
      text = print(compile(ast, { ledger }));
    } catch (e) {
      return { byRow, loose: [e instanceof Error ? e.message : String(e)] };
    }
    const r = prepareDefinition(text);
    if (!("error" in r)) return { byRow, loose };
    const add = (key: string, m: string) => byRow.set(key, [...(byRow.get(key) ?? []), m]);
    for (const p of r.problems) {
      if (p.unit !== undefined && p.entry !== undefined) add(`unit:${p.unit}:${p.entry}`, p.message);
      else if (p.day !== undefined) add(`day:${p.day}`, p.message);
      else if (p.rule !== undefined && ledger.skips[p.rule]) for (const d of ledger.skips[p.rule]!) add(`skip:${p.rule}:${d}`, p.message);
      else loose.push(p.message);
    }
    return { byRow, loose };
  }

  /** The draft's year, months or week differ from the stored definition's: dates are still read in the stored one. */
  function unsavedStructure(): boolean {
    const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
    if (!ast) return false;
    const stored = calendarOfDefinition(ast).form ?? {};
    const draft = ctx.store.get().world.calendar.form ?? {};
    return (["year", "months", "week"] as const).some((k) => canonicalJson(draft[k] ?? null) !== canonicalJson(stored[k] ?? null));
  }

  /**
   * @param firstYear the draft's first year: entries are shown and added by the year numbers Save will store
   * @param storedFirstYear the stored definition's: the stored calendar's own yearStart counts from it
   */
  function renderLedger(ledger: LedgerForm, firstYear: number, storedFirstYear: number): void {
    const cal = ctx.plugin.calendars.seshat;
    const date = (d: number): string => {
      try {
        return cal?.format(d) ?? `day ${d}`;
      } catch {
        return `day ${d}`;
      }
    };
    // a displayed year is an index plus the draft's first year; the stored calendar counts from its own
    const rows: LedgerRow[] = ledgerRows(ledger, { date, yearStart: (y) => cal?.yearStart(y - firstYear + storedFirstYear) ?? null, firstYear });
    const { byRow, loose } = ledgerProblems(ledger);
    line(panel, rows.length ? `${rows.length} entr${rows.length === 1 ? "y" : "ies"}, in date order` : "No entries: the calendar runs on its rules alone.", "wadjet-studio-calendar-summary");
    if (unsavedStructure()) line(panel, "Dates here are read and written in the saved calendar. Save the year, month and week edits to use the new ones.", "wadjet-studio-calendar-why");
    for (const m of loose) line(panel, `⚠ ${m}`, "wadjet-studio-calendar-problem");
    for (const row of rows) {
      const r = panel.createDiv({ cls: "wadjet-studio-calendar-row" });
      r.createSpan({ cls: "wadjet-studio-calendar-entry", text: row.text });
      if (row.asText) asTextButton(r, `${row.key}.text`);
      button(r, `${row.key}.remove`, "×", `Remove: ${row.text}`, calendarHint("calendar.ledgerRemove"), () => removeRow(row.key));
      for (const m of byRow.get(row.key) ?? []) line(panel, `⚠ ${m}`, "wadjet-studio-calendar-problem");
    }
    renderAdd(firstYear, ledger);
  }

  function asTextButton(parent: HTMLElement, key: string): void {
    button(parent, key, "Edit as text", "Edit the calendar definition as text", calendarHint("calendar.asText"), () => {
      if (unsavedFields()) return void new Notice("Save or undo the calendar's unsaved edits first: Edit as text opens the stored definition.");
      new DefinitionModal(ctx.plugin.app, ctx.plugin, () => {}).open();
    });
  }

  /** A plain input for the add row: it holds its text in `adding` and commits nothing itself. */
  function addInput(parent: HTMLElement, key: keyof typeof adding, label: string, hint: string, placeholder: string, cls = "is-name"): void {
    const input = parent.createEl("input", { cls: `wadjet-studio-calendar-field ${cls}`, type: "text", attr: { spellcheck: "false", placeholder, "aria-label": label, "data-hint": hint, "data-key": `add.${key}` } });
    input.value = adding[key];
    input.dataset.drawn = adding[key];
    input.addEventListener("input", () => (adding[key] = input.value));
  }

  function renderAdd(firstYear: number, ledger: LedgerForm): void {
    const box = panel.createDiv({ cls: "wadjet-studio-calendar-add" });
    const head = box.createDiv({ cls: "wadjet-studio-calendar-row" });
    head.createSpan({ text: "Add" });
    const kind = head.createEl("select", { cls: "wadjet-studio-calendar-select dropdown", attr: { "aria-label": "What to change", "data-hint": calendarHint("calendar.ledgerKind"), "data-key": "add.kind" } });
    const kinds: Record<string, string> = { mark: "Name a single day", skip: "Cancel one day of a rule", start: "Move one year's first day", lengths: "Set one year's month lengths", switch: "Change a rule from a year onward" };
    for (const [value, text] of Object.entries(kinds)) kind.createEl("option", { value, text });
    kind.value = adding.kind;
    kind.addEventListener("change", () => {
      adding.kind = kind.value;
      paint(true);
    });
    const row = box.createDiv({ cls: "wadjet-studio-calendar-row" });
    const rules = (ctx.plugin.calendars.seshat?.definition()?.rules ?? []).map((r) => r.id);
    const dayOf = (text: string): number | null => {
      const t = text.trim();
      if (/^-?\d+$/.test(t)) return Number(t);
      return ctx.plugin.calendars.seshat?.parse(t) ?? null;
    };
    const today = ctx.plugin.calendars.seshat?.format(ctx.plugin.settings.currentDayOrdinal) ?? "";
    switch (adding.kind) {
      case "mark":
        addInput(row, "date", "Date", calendarHint("calendar.ledgerDate"), today, "is-short-date");
        addInput(row, "name", "Name of the day", calendarHint("calendar.ledgerName"), "Coronation");
        addInput(row, "tags", "Tags, separated by commas", calendarHint("calendar.ledgerTags"), "Tags, comma separated");
        break;
      case "skip": {
        if (!rules.length) {
          line(row, "This calendar has no named rules to cancel a day of.", "wadjet-studio-calendar-why");
          return;
        }
        const sel = row.createEl("select", { cls: "wadjet-studio-calendar-select dropdown", attr: { "aria-label": "Rule", "data-hint": calendarHint("calendar.ledgerRule"), "data-key": "add.rule" } });
        for (const id of rules) sel.createEl("option", { value: id, text: id });
        if (!rules.includes(adding.rule)) adding.rule = rules[0]!;
        sel.value = adding.rule;
        sel.addEventListener("change", () => (adding.rule = sel.value));
        addInput(row, "date", "Date", calendarHint("calendar.ledgerDate"), today, "is-short-date");
        break;
      }
      case "start":
        addInput(row, "year", "Year", calendarHint("calendar.ledgerYear"), "Year", "is-short");
        row.createSpan({ text: "starts on" });
        addInput(row, "date", "Date", calendarHint("calendar.ledgerDate"), today, "is-short-date");
        break;
      case "lengths":
        addInput(row, "year", "Year", calendarHint("calendar.ledgerYear"), "Year", "is-short");
        addInput(row, "lengths", "Month lengths, separated by commas", calendarHint("calendar.ledgerLengths"), "31, 28, 31, …", "is-wide");
        break;
      default:
        line(row, "A switch's rule is written as text.", "wadjet-studio-calendar-why");
        asTextButton(row, "add.switch");
        return;
    }
    button(box, "add.go", "＋ add", "Add the entry", calendarHint("calendar.ledgerAdd"), () => {
      const fail = (m: string) => void new Notice(`Not added: ${m}`);
      // what was typed, read once: a confirm may stay open while the row is redrawn
      const { kind: k, rule, date, name: typedName, tags: typedTags, year, lengths: typedLengths } = adding;
      // the row clears only once the entry is in the draft; a cancelled confirm keeps what was typed
      const commit = (fn: (l: LedgerForm) => LedgerForm) =>
        editLedger((l) => {
          adding.date = adding.name = adding.tags = adding.year = adding.lengths = "";
          return fn(l);
        });
      const yearIndex = (): number | null => (/^-?\d+$/.test(year.trim()) ? Number(year.trim()) - firstYear : null);
      const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
      if (k === "mark") {
        const day = dayOf(date);
        if (day === null) return fail(`"${date}" is not a date in this calendar (write it as ${today}, or a day number).`);
        if (ledger.days.some((d) => d.day === day)) return fail("that day has a name already; remove its entry first.");
        const tags = typedTags.split(",").map((t) => t.trim().normalize("NFC")).filter((t) => t !== "");
        const n = typedName.trim().normalize("NFC");
        commit((l) => ({ ...l, days: [...l.days, { day, ...(n ? { name: n } : {}), ...(tags.length ? { tags } : {}) }].sort((a, b) => a.day - b.day) }));
      } else if (k === "skip") {
        const day = dayOf(date);
        if (day === null) return fail(`"${date}" is not a date in this calendar.`);
        if ((ledger.skips[rule] ?? []).includes(day)) return fail(`rule ${rule} is already cancelled on that day.`);
        // a rule with tags can be checked: it must fall on the day it is to skip
        const tag = ast?.rules?.find((r) => r.id === rule)?.tags?.[0];
        if (tag !== undefined && !(ctx.plugin.calendars.seshat?.toContext(day).tags ?? []).includes(tag)) return fail(`rule ${rule} does not fall on ${date}, so there is nothing to skip.`);
        commit((l) => ({ ...l, skips: { ...l.skips, [rule]: [...(l.skips[rule] ?? []), day] } }));
      } else {
        const from = yearIndex();
        if (from === null) return fail("write a whole year.");
        let entry: LedgerEntry;
        if (k === "start") {
          const day = dayOf(date);
          if (day === null) return fail(`"${date}" is not a date in this calendar.`);
          entry = { kind: "starts", from, startsOn: day };
        } else {
          const lengths = parseLengths(typedLengths);
          if (!lengths) return fail("write the month lengths as whole numbers, separated by commas.");
          const unit = calendarOfMonthsUnit();
          if (unit === null) return fail("this calendar's months are written as text.");
          // checked against the saved months: the entry is validated against the stored calendar
          const slots = ast?.units.find((u) => u.id === unit);
          const count = slots?.kind === "slots" ? slots.slots.length : 0;
          if (lengths.length !== count) return fail(`write ${count} lengths, one per month of the saved calendar.`);
          entry = { kind: "slots", from, unit, lengths };
        }
        // entries are kept in order of their first occurrence (V7)
        commit((l) => ({ ...l, units: { ...l.units, year: [...(l.units.year ?? []), entry].sort((a, b) => a.from - b.from) } }));
      }
    });
  }

  /** The id of the months' slot unit in the stored definition, or null. */
  function calendarOfMonthsUnit(): string | null {
    const ast = ctx.plugin.calendars.seshat?.definition();
    const m = ast?.units.filter((u) => u.kind === "slots" && u.in === "year") ?? [];
    return m.length === 1 ? m[0]!.id : null;
  }

  function renderPanel(state: StudioState): void {
    const src = sourceOf(ctx, state);
    const description = ctx.calendar();
    if (tab === "calendar") {
      if (src === "plugin") {
        line(panel, `${description?.label ?? "A calendar plugin"} supplies this world's days. Edit it there.`);
        if (description?.editHint) line(panel, description.editHint, "wadjet-studio-calendar-why");
      } else if (src === "legacy") {
        // the legacy calendar's years are all one length: the seam's nominal length is that length
        const days = ctx.years()?.nominalLength;
        line(panel, `This world runs on the legacy calendar: ${days === undefined ? "years of one length" : `${days}-day years`}, days numbered within the year. Its seasons are edited on the Seasons tab, its moons in their own windows.`);
        button(panel, "change", "Change calendar…", "Change calendar", calendarHint("calendar.change"), () => new OptInModal(ctx.plugin.app, ctx.plugin, () => {}).open());
      } else asText(panel, "fault.text", null, `the stored definition cannot run (${ctx.plugin.calendars.fault() ?? "unknown"})`);
      return;
    }
    const form = state.world.calendar.form ?? {};
    const stored = storedForm(ctx);
    const why = (k: "name" | "year" | "months" | "week" | "ledger"): string => {
      const p = stored?.[k];
      return p?.kind === "text" ? p.why : "the simple fields cannot show it";
    };
    if (tab === "ledger") {
      const ast = ctx.plugin.calendars.seshat?.definition();
      const yearUnit = ast?.units.find((u) => u.id === "year");
      const storedFirstYear = yearUnit?.kind === "cycle" ? (yearUnit.number ?? 0) : 0;
      const firstYear = form.year?.firstYear ?? storedFirstYear;
      if (form.ledger) renderLedger(form.ledger, firstYear, storedFirstYear);
      else asText(panel, "ledger.text", null, why("ledger"));
    } else if (tab === "year") renderYear(form, stored, why);
    else if (tab === "months") {
      if (form.months !== undefined) renderMonths(form.months);
      else asText(panel, "months.text", null, why("months"));
    } else if (tab === "week") {
      if (form.week !== undefined) renderWeek(form.week);
      else asText(panel, "week.text", null, why("week"));
    }
  }

  /**
   * Redraw when what the panel shows changed, or always after its own edit
   * or a tab switch (`force`): the controls are drawn from the draft, so an
   * edit's indices and values are never stale. Focus returns to the control
   * of the same key, and a field being typed in keeps what was typed.
   */
  let signature = "";
  let drawnTabs = "";
  function paint(force = false): void {
    const state = ctx.store.get();
    const src = sourceOf(ctx, state);
    tab = fit(src, tab);
    // the strip redraws only when its options or its choice change
    const tabsKey = `${src === "seshat"}:${tab}`;
    if (tabsKey !== drawnTabs) {
      drawnTabs = tabsKey;
      tabs.update({ options: tabOptions(src), value: tab });
    }
    // the chip names the calendar on every tab, the Seasons tab included
    const label = ctx.calendar()?.label ?? "calendar";
    sourceChip.update({ label: src === "plugin" ? `${label} · read-only` : src === "legacy" ? "legacy calendar" : src === "fault" ? "definition · cannot run" : "calendar definition" });
    seasonsHost.toggleClass("is-hidden", tab !== "seasons");
    panel.toggleClass("is-hidden", tab === "seasons");
    if (tab === "seasons") return;
    const sig = canonicalJson([tab, rulesOpen, src, state.world.calendar.form ?? null, ctx.calendar()?.label ?? null, ctx.plugin.calendars.seshat?.text() ?? null]);
    if (sig === signature && !force) return;
    signature = sig;
    const active = activeDocument.activeElement;
    const focused = active?.instanceOf(HTMLElement) && panel.contains(active) ? active : null;
    const key = focused?.dataset.key;
    const typed = focused?.instanceOf(HTMLInputElement) && focused.value !== focused.dataset.drawn ? focused.value : null;
    panel.empty();
    renderPanel(state);
    if (key === undefined) return;
    const again = panel.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!again) return;
    if (typed !== null && again.instanceOf(HTMLInputElement)) again.value = typed;
    again.focus();
  }

  const unsubStore = ctx.store.subscribe(() => paint());
  const unsubAdapters = ctx.plugin.api.on("adapters-changed", () => paint());
  paint(true);

  const build: WindowBuild = {
    title: "Calendar",
    width: 420,
    badge: "CALENDAR",
    badgeColor: "var(--wadjet-studio-gold)",
    head: (slot) => slot.appendChild(sourceChip.el),
    body,
    // the Seasons tab keeps the Seasons editor's LED, WRITES and issues
    ...(seasons.led ? { led: seasons.led } : {}),
    level: (byUnit) => seasons.level?.(byUnit) ?? "ok",
    writes: () => (tab === "seasons" ? (seasons.writes?.() ?? "") : calendarGrammar(ctx.store.get().world.calendar.form)),
    issues: () => (tab === "seasons" ? (seasons.issues?.() ?? []) : []),
    onClose: () => {
      switchers.delete(ctx.windows);
      seasons.onClose?.();
      tabs.destroy();
      unsubStore();
      unsubAdapters();
    },
  };
  return build;
};
