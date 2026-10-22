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
import { recognise, type CalendarForm } from "../../../plugin/time/form";
import { DefinitionModal, OptInModal } from "../../../plugin/calendar-modals";
import { calendarGrammar, monthsWords, parseMonthLength, showMonthLength, weekWords, yearWords } from "../../model/calendar-window";
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

export type CalendarTab = "seasons" | "year" | "months" | "week" | "calendar";

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

  /** The draft's form fields differ from the stored definition's: unsaved Studio edits. */
  function unsavedFields(): boolean {
    const ast = ctx.plugin.calendars.seshat?.definition() ?? null;
    if (!ast) return false;
    return canonicalJson(ctx.store.get().world.calendar.form ?? {}) !== canonicalJson(calendarOfDefinition(ast).form ?? {});
  }

  function asText(parent: HTMLElement, key: string, what: string | null, why: string): void {
    if (what) line(parent, what);
    line(parent, `Written as text: ${why}.`, "wadjet-studio-calendar-why");
    button(parent, key, "Edit as text", "Edit the calendar definition as text", calendarHint("calendar.asText"), () => {
      // the text editor opens on the stored definition; the draft's field edits would be lost or collide there
      if (unsavedFields()) return void new Notice("Save or undo the calendar's field edits first: Edit as text opens the stored definition.");
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
      asText(panel, "year.text", yearRange(ctx), why("year"));
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

  function renderPanel(state: StudioState): void {
    const src = sourceOf(ctx, state);
    const description = ctx.calendar();
    sourceChip.update({ label: src === "plugin" ? `${description?.label ?? "calendar"} · read-only` : src === "legacy" ? "legacy calendar" : src === "fault" ? "definition · cannot run" : "calendar definition" });
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
    const why = (k: "name" | "year" | "months" | "week"): string => {
      const p = stored?.[k];
      return p?.kind === "text" ? p.why : "the simple fields cannot show it";
    };
    if (tab === "year") renderYear(form, stored, why);
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
