/**
 * Calendar · CALENDAR (docs/SESHAT-v0.md §15.4, §15.1 R1 R5): the world's
 * calendar as fields.
 *
 * - A world that runs a definition: one section per part (name, year, months,
 *   week), in the same order whatever the calendar. A part the form reads as
 *   fields is edited here, in the world draft (`world.calendar.form`); Save
 *   compiles it into the stored definition through the Save dialog. A part
 *   the form cannot show says what it is, why, and offers "Edit as text".
 *   Seasons and moons keep their own windows; this one summarises them.
 * - The legacy calendar: what it is, and "Change calendar…".
 * - A calendar plugin: the `<plugin> · read-only` chip and its own hint.
 * - A definition that cannot run: the fault, and "Edit as text".
 *
 * A field commits on change (Enter or leaving it). Every edit reads the
 * draft as it is at that moment, and the body is redrawn from the draft right
 * after it, with focus back on the control of the same key (a field being
 * typed in keeps what was typed): no control acts on a stale value.
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
import { createChip, type ChipComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit } from "../world-confirm-modal";
import { SEASONS_WINDOW } from "./seasons";

/** The id this window is registered and opened under. */
export const CALENDAR_WINDOW = "calendar";

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

  /**
   * One undoable edit of the draft's form fields, behind the session's world
   * confirm. `edit` reads the draft as it is at commit time, never a value
   * captured when the body was drawn. A cancelled confirm redraws, so no
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

  function section(title: string): HTMLElement {
    const el = body.createDiv({ cls: "wadjet-studio-calendar-section" });
    el.createDiv({ cls: "wadjet-studio-calendar-head", text: title });
    return el;
  }

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

  // ---- the parts of a definition

  function renderYear(y: YearForm): void {
    const el = section("Year");
    line(el, yearWords(y), "wadjet-studio-calendar-summary");
    const row = el.createDiv({ cls: "wadjet-studio-calendar-row" });
    row.createSpan({ text: "Days in a year" });
    field(row, "year.length", String(y.length), "Days in a year", calendarHint("calendar.days"), "is-short", whole(1, YEAR_LENGTH_MAX), (n) => editYear((cur) => ({ ...cur, length: n })), true);
    row.createSpan({ text: "First year" });
    field(row, "year.first", String(y.firstYear), "First year", calendarHint("calendar.firstYear"), "is-short", anyWhole, (n) => editYear((cur) => ({ ...cur, firstYear: n })), true);

    const leap = y.leap;
    if (leap) {
      const add = el.createDiv({ cls: "wadjet-studio-calendar-row" });
      add.createSpan({ text: "A leap year adds" });
      field(add, "leap.add", String(leap.add), "Days a leap year adds", calendarHint("calendar.leapDays"), "is-short", nonZero, (n) => editLeap((cur) => ({ ...cur, add: n })), true);
      add.createSpan({ text: "days, in years matched by" });
      const setTerm = (i: number, fn: (t: LeapTerm) => LeapTerm) => editLeap((cur) => ({ ...cur, terms: cur.terms.map((x, j) => (j === i ? fn(x) : x)) }));
      leap.terms.forEach((t, i) => {
        const r = el.createDiv({ cls: "wadjet-studio-calendar-row is-indented" });
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
        r.createSpan({ text: "years, counting from year" });
        field(r, `leap.${i}.at`, String(t.at), "Counting from year", calendarHint("calendar.leapFrom"), "is-short", anyWhole, (n) => setTerm(i, (cur) => ({ ...cur, at: n })), true);
        button(r, `leap.${i}.remove`, "×", "Remove this leap rule", calendarHint("calendar.leapRemove"), () =>
          editLeap((cur) => {
            const terms = cur.terms.filter((_, j) => j !== i);
            return terms.length ? { ...cur, terms } : null;
          }),
        );
      });
    }
    button(el, "leap.new", leap ? "＋ another rule" : "＋ leap years", "Add a leap rule", calendarHint("calendar.leapNew"), () =>
      editYear((cur) => {
        const l = cur.leap;
        // exceptions alternate: every 4th, except every 100th, but every 400th
        const next: LeapTerm = l ? { every: (l.terms[l.terms.length - 1]?.every ?? 1) * 25, at: 0, sign: l.terms.length % 2 === 1 ? -1 : 1 } : { every: 4, at: 0, sign: 1 };
        return { ...cur, leap: { add: l?.add ?? 1, terms: [...(l?.terms ?? []), next] } };
      }),
    );
  }

  function renderMonths(months: readonly MonthForm[] | null): void {
    const el = section("Months");
    line(el, monthsWords(months), "wadjet-studio-calendar-summary");
    (months ?? []).forEach((m, i) => {
      const r = el.createDiv({ cls: "wadjet-studio-calendar-row" });
      field(r, `month.${i}.name`, m.name, `Name of month ${i + 1}`, calendarHint("calendar.monthName"), "is-name", name, (v) => editMonths((list) => list.map((x, j) => (j === i ? { ...x, name: v } : x))));
      field(
        r,
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
      button(r, `month.${i}.remove`, "×", `Remove month ${i + 1}`, calendarHint("calendar.monthRemove"), () => editMonths((list) => list.filter((_, j) => j !== i)));
    });
    button(el, "month.new", months?.length ? "＋ month" : "＋ months", "Add a month", calendarHint("calendar.monthNew"), () =>
      editMonths((list) => [...list, { name: `Month ${list.length + 1}`, length: list.some((x) => x.length === "slack") ? 30 : "slack" }]),
    );
  }

  function renderWeek(week: readonly string[] | null): void {
    const el = section("Week");
    line(el, weekWords(week), "wadjet-studio-calendar-summary");
    if (week === null || week.length === 0) {
      button(el, "week.new", "＋ a week", "Add a week", calendarHint("calendar.weekNew"), () => editWeek(() => ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"]));
      return;
    }
    week.forEach((d, i) => {
      const r = el.createDiv({ cls: "wadjet-studio-calendar-row" });
      field(r, `day.${i}.name`, d, `Name of day ${i + 1}`, calendarHint("calendar.dayName"), "is-name", name, (v) => editWeek((days) => days.map((x, j) => (j === i ? v : x))));
      button(r, `day.${i}.remove`, "×", `Remove day ${i + 1}`, calendarHint("calendar.dayRemove"), () => editWeek((days) => days.filter((_, j) => j !== i)));
    });
    button(el, "day.new", "＋ day", "Add a day to the week", calendarHint("calendar.dayNew"), () => editWeek((days) => [...days, `Day ${days.length + 1}`]));
  }

  function renderDefinition(state: StudioState): void {
    const form = state.world.calendar.form ?? {};
    const stored = storedForm(ctx);
    const why = (k: "name" | "year" | "months" | "week"): string => {
      const p = stored?.[k];
      return p?.kind === "text" ? p.why : "the simple fields cannot show it";
    };

    const nameEl = section("Name");
    if (form.name !== undefined) field(nameEl, "name", form.name, "Calendar name", calendarHint("calendar.name"), "is-wide", name, (v) => write((f) => (f.name = v)));
    else asText(nameEl, "name.text", null, why("name"));

    if (form.year) renderYear(form.year);
    else asText(section("Year"), "year.text", yearRange(ctx), why("year"));

    if (form.months !== undefined) renderMonths(form.months);
    else asText(section("Months"), "months.text", null, why("months"));

    if (form.week !== undefined) renderWeek(form.week);
    else asText(section("Week"), "week.text", null, why("week"));

    const seasons = state.world.calendar.seasons;
    const moons = state.world.calendar.moons;
    const sky = section("Seasons and moons");
    line(sky, `${seasons.length ? `${seasons.length} season${seasons.length === 1 ? "" : "s"}` : "no seasons"} · ${moons.length ? moons.map((m) => m.name).join(", ") : "no moons"}`);
    button(sky, "seasons.open", "Seasons ▸", "Open the seasons window", calendarHint("calendar.seasons"), () => ctx.windows.open(SEASONS_WINDOW));

    if (stored && stored.others.length) asText(section("Also"), "others.text", `${stored.others.length} more unit${stored.others.length === 1 ? "" : "s"}: ${stored.others.join(", ")}`, "the fields show a year, its months and its week only");
  }

  function render(state: StudioState): void {
    const src = sourceOf(ctx, state);
    const description = ctx.calendar();
    sourceChip.update({ label: src === "plugin" ? `${description?.label ?? "calendar"} · read-only` : src === "legacy" ? "legacy calendar" : src === "fault" ? "definition · cannot run" : "calendar definition" });
    if (src === "plugin") {
      const el = section("Calendar");
      line(el, `${description?.label ?? "A calendar plugin"} supplies this world's days. Edit it there.`);
      if (description?.editHint) line(el, description.editHint, "wadjet-studio-calendar-why");
      return;
    }
    if (src === "legacy") {
      const el = section("Calendar");
      // the legacy calendar's years are all one length: the seam's nominal length is that length
      const days = ctx.years()?.nominalLength;
      line(el, `This world runs on the legacy calendar: ${days === undefined ? "years of one length" : `${days}-day years`}, days numbered within the year. Its seasons and moons are edited in their own windows.`);
      button(el, "change", "Change calendar…", "Change calendar", calendarHint("calendar.change"), () => new OptInModal(ctx.plugin.app, ctx.plugin, () => {}).open());
      return;
    }
    if (src === "fault") {
      asText(section("Calendar"), "fault.text", null, `the stored definition cannot run (${ctx.plugin.calendars.fault() ?? "unknown"})`);
      return;
    }
    renderDefinition(state);
  }

  /**
   * Redraw when what the window shows changed, or always after its own edit
   * (`force`): the controls are drawn from the draft, so an edit's indices
   * and values are never stale. Focus returns to the control of the same key,
   * and a field being typed in keeps what was typed.
   */
  let signature = "";
  function paint(force = false): void {
    const state = ctx.store.get();
    const sig = canonicalJson([sourceOf(ctx, state), state.world.calendar.form ?? null, state.world.calendar.seasons, state.world.calendar.moons.map((m) => m.name), ctx.calendar()?.label ?? null, ctx.plugin.calendars.seshat?.text() ?? null]);
    if (sig === signature && !force) return;
    signature = sig;
    const active = activeDocument.activeElement;
    const focused = active?.instanceOf(HTMLElement) && body.contains(active) ? active : null;
    const key = focused?.dataset.key;
    const typed = focused?.instanceOf(HTMLInputElement) && focused.value !== focused.dataset.drawn ? focused.value : null;
    body.empty();
    render(state);
    if (key === undefined) return;
    const again = body.querySelector<HTMLElement>(`[data-key="${key}"]`);
    if (!again) return;
    if (typed !== null && again.instanceOf(HTMLInputElement)) again.value = typed;
    again.focus();
  }

  const unsubStore = ctx.store.subscribe(() => paint());
  const unsubAdapters = ctx.plugin.api.on("adapters-changed", () => paint());
  paint();

  const build: WindowBuild = {
    title: "Calendar",
    width: 420,
    badge: "CALENDAR",
    badgeColor: "var(--wadjet-studio-gold)",
    head: (slot) => slot.appendChild(sourceChip.el),
    body,
    writes: () => calendarGrammar(ctx.store.get().world.calendar.form),
    onClose: () => {
      unsubStore();
      unsubAdapters();
    },
  };
  return build;
};
