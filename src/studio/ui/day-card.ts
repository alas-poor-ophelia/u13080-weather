/**
 * The day card (SPEC §3.2 "Day view (≤ 7.5-day window)").
 *
 * Below 7.5 days a curve has nothing left to say, so the playlist hides its
 * rows and the card takes over: the *generated* day under the centre of the
 * window, read straight off the roll. Nothing on it is derived a second way —
 * the headline is `core/report.ts`'s own `describe(report, "short")`, the
 * numbers are that same `WeatherReport`, and the tags are the day's
 * `TimeContext`. A number here and a number a ```wadjet``` block prints for
 * the same date are the same number, which is what the e2e walk asserts
 * (SPEC law 4: real data only).
 *
 * Units are display-only (`model/format.ts`): storage stays metric and the
 * card converts on the way to the screen, per `settings.units`.
 *
 * Pinned days (`state.world.overrides`) carry the audition's gold ▼ and, when
 * the override wrote one, its note — the same marker the strip uses, so a pin
 * reads the same wherever it shows up.
 */
import { describe } from "../../core/report";
import { rollCached, type AuditionDay, type AuditionYear } from "../model/audition";
import { dayLabel, format, yearLabel } from "../model/format";
import { channelHint } from "../model/hints-channels";
import type { StudioState } from "../model/state";
import { createChip, type ChipComponent } from "./components";
import type { RowGeometry } from "./playlist";
import { auditionInputFor, yearGridFor } from "./rows/channel-row";
import type { SurfaceContext } from "./surfaces";

export interface DayCardComponent {
  el: HTMLElement;
  /** Show or hide with the morph, and repaint when the day under the centre moved. */
  render(state: StudioState, geo: RowGeometry): void;
  destroy(): void;
}

/** The marker a pinned day carries, the audition strip's own. */
const PIN_GLYPH = "▼";

/** One labelled readout in the card's grid. */
interface Cell {
  el: HTMLElement;
  value: HTMLElement;
}

function createCell(parent: HTMLElement, field: string, label: string): Cell {
  const el = parent.createDiv({ cls: "wadjet-studio-daycard-cell", attr: { "data-field": field, "data-hint": channelHint("daycard.readout") } });
  el.createDiv({ cls: "wadjet-studio-daycard-cell-label", text: label });
  const value = el.createDiv({ cls: "wadjet-studio-daycard-cell-value" });
  return { el, value };
}

/**
 * The day the window is centred on. `[a, b)` is at most 7.5 days wide here, so
 * the centre is unambiguous; the roll it comes from is the year that centre
 * falls in, with one year of slack either side for calendars whose years are
 * not all the same length.
 */
function centreDay(ctx: SurfaceContext, state: StudioState): { day: AuditionDay; rollKey: string } | null {
  const grid = yearGridFor(ctx);
  if (grid === null) return null;
  const centre = (state.view.window.a + state.view.window.b) / 2;
  const target = Math.floor((centre - grid.epochYear) * grid.yearLength);

  const rolls: AuditionYear[] = [];
  for (const year of [Math.floor(centre), Math.floor(centre) - 1, Math.floor(centre) + 1]) {
    const input = auditionInputFor(ctx, state, year);
    if (input === null) return null;
    const rolled = rollCached(input);
    rolls.push(rolled);
    const exact = rolled.days.find((d) => d.dayOrdinal === target);
    if (exact !== undefined) return { day: exact, rollKey: rolled.key };
    // The first roll almost always holds the day; the neighbours are only
    // consulted when it does not, so a Day-zoom render costs one roll.
    if (rolled.days.length > 0 && target >= rolled.days[0]!.dayOrdinal && target <= rolled.days[rolled.days.length - 1]!.dayOrdinal) break;
  }

  let nearest: { day: AuditionDay; rollKey: string } | null = null;
  for (const rolled of rolls) {
    for (const day of rolled.days) {
      if (nearest === null || Math.abs(day.dayOrdinal - target) < Math.abs(nearest.day.dayOrdinal - target)) nearest = { day, rollKey: rolled.key };
    }
  }
  return nearest;
}

/** The tag chips SPEC §3.2 lists: `season:` `era:` `<moon> %` `regime:`. */
export function dayChips(day: AuditionDay): Array<{ label: string; color: string }> {
  const chips: Array<{ label: string; color: string }> = [];
  for (const tag of day.time.tags ?? []) {
    if (tag.startsWith("season:")) chips.push({ label: tag, color: "var(--wadjet-studio-gold)" });
  }
  for (const tag of day.time.tags ?? []) {
    if (tag.startsWith("era:")) chips.push({ label: tag, color: "var(--wadjet-studio-gold)" });
  }
  for (const moon of day.time.moons ?? []) {
    // Phase is a 0..1 fraction and reads the same in every `settings.units` —
    // `format`'s "percent" quantity is unit-invariant (`toDisplay`), so any
    // units argument gives the same text; "metric" here is arbitrary.
    const phase = format(moon.phase, "percent", "metric", { digits: 0 });
    chips.push({ label: `${moon.name} ${phase.text}${phase.unit}`, color: "var(--wadjet-studio-moon)" });
  }
  chips.push({ label: `regime:${day.record.regime}`, color: "var(--wadjet-studio-text-dim)" });
  return chips;
}

export function createDayCard(parent: HTMLElement, ctx: SurfaceContext, hint: string): DayCardComponent {
  const el = parent.createDiv({ cls: "wadjet-studio-daycard wadjet-studio-playlist-daycard is-hidden", attr: { "data-hint": hint } });

  const head = el.createDiv({ cls: "wadjet-studio-daycard-head", attr: { "data-hint": channelHint("daycard.head") } });
  // `Y 1962 · d 145`, redrawn as the window slides: tabular numerals, from the
  // shared utility (this line has no value class of its own).
  const dateEl = head.createDiv({ cls: "wadjet-studio-daycard-date wadjet-studio-num" });
  const pinEl = head.createDiv({ cls: "wadjet-studio-daycard-pin is-hidden", text: PIN_GLYPH, attr: { "data-hint": channelHint("daycard.pin") } });
  const headline = el.createDiv({ cls: "wadjet-studio-daycard-headline" });
  const grid = el.createDiv({ cls: "wadjet-studio-daycard-grid" });
  const cells = {
    temperature: createCell(grid, "temperature", "Temperature"),
    precipitation: createCell(grid, "precipitation", "Precipitation"),
    wind: createCell(grid, "wind", "Wind"),
    sky: createCell(grid, "sky", "Sky"),
  };
  const chipsEl = el.createDiv({ cls: "wadjet-studio-daycard-chips" });
  const noteEl = el.createDiv({ cls: "wadjet-studio-daycard-note is-hidden" });
  const emptyEl = el.createDiv({ cls: "wadjet-studio-daycard-empty is-hidden", text: "No day here — pick a zone to see the roll" });

  let chips: ChipComponent[] = [];
  /** The last day painted, so a tick that did not move the centre touches no DOM. */
  let painted = "";

  function clearChips(): void {
    for (const chip of chips) chip.destroy();
    chips = [];
  }

  function paint(day: AuditionDay | null, state: StudioState): void {
    const units = ctx.plugin.settings.units;
    el.toggleClass("is-empty", day === null);
    emptyEl.toggleClass("is-hidden", day !== null);
    for (const cell of Object.values(cells)) cell.el.toggleClass("is-hidden", day === null);
    headline.toggleClass("is-hidden", day === null);
    // The day the card is on, in the open: the e2e walk reads it to ask a
    // ```wadjet``` block for the same date, and a reader can see which day a
    // screenshot is of without decoding the calendar label.
    if (day === null) el.removeAttribute("data-day");
    else el.setAttr("data-day", String(day.dayOrdinal));

    if (day === null) {
      dateEl.setText("");
      pinEl.toggleClass("is-hidden", true);
      noteEl.toggleClass("is-hidden", true);
      clearChips();
      return;
    }

    const r = day.report;
    dateEl.setText(`${yearLabel(day.time.year ?? Math.floor(day.dayOrdinal / day.time.yearLength) + 1)} · ${dayLabel(day.dayOfYear, day.time.yearLength)}`);
    headline.setText(describe(r, "short"));

    const t = (v: number): string => {
      const f = format(v, "temperature", units);
      return `${f.text} ${f.unit}`;
    };
    cells.temperature.value.setText(`${t(r.temperature.low)} – ${t(r.temperature.high)} · mean ${t(r.temperature.mean)}`);

    const amount = format(r.precipitation.amountMm, "amount", units);
    cells.precipitation.value.setText(r.precipitation.type === "none" ? "dry" : `${r.precipitation.type} · ${amount.text} ${amount.unit}`);

    const speed = format(r.wind.speedKph, "speed", units);
    const direction = format(r.wind.directionDeg, "direction", units);
    cells.wind.value.setText(r.wind.speedKph === 0 ? "calm" : `${direction.text} · ${speed.text} ${speed.unit}`);

    const cloud = format(r.cloudCover, "percent", units, { digits: 0 });
    const humidity = format(r.humidity, "percent", units, { digits: 0 });
    cells.sky.value.setText(`${cloud.text}${cloud.unit} cloud · ${humidity.text}${humidity.unit} humidity`);

    pinEl.toggleClass("is-hidden", !day.pinned);
    const note = state.world.overrides.find((o) => o.zoneId === r.zoneId && o.dayOrdinal === day.dayOrdinal)?.patch.note ?? "";
    noteEl.setText(note);
    noteEl.toggleClass("is-hidden", !day.pinned || note === "");

    clearChips();
    for (const spec of dayChips(day)) chips.push(createChip(chipsEl, { label: spec.label, color: spec.color, hint: channelHint("daycard.chip") }));
  }

  return {
    el,

    render(state, geo) {
      el.toggleClass("is-hidden", !geo.morph.isDay);
      // Off-screen the card derives nothing: the roll it would need is the
      // expensive half of a Day-zoom render (PLAN §7).
      if (!geo.morph.isDay) return;
      const found = centreDay(ctx, state);
      // The roll key already folds in the profile, the calendar, the eras, the
      // salt and every pin; the day ordinal and the unit system are the rest.
      const key = found === null ? "none" : `${found.rollKey}|${found.day.dayOrdinal}|${ctx.plugin.settings.units}`;
      if (key === painted) return;
      painted = key;
      paint(found?.day ?? null, state);
    },

    destroy() {
      clearChips();
      el.remove();
    },
  };
}
