/**
 * The day card (SPEC §3.2 "Day view (≤ 7.5-day window)"), rebuilt against the
 * prototype's `0075-day.html`.
 *
 * Below 7.5 days a curve has nothing left to say at *day* resolution, so the
 * card takes the top of the playlist — above the calendar ruler, flush to the
 * column edges — and the whole lane stack keeps running underneath it. It is a
 * readout, not a page: the prototype's shape is an eyebrow, one hero
 * temperature, the condition and its code, four tag chips, a four-row stats
 * column, a moon disc, and a NEIGHBOUR list of the four days either side.
 *
 * Nothing on it is derived a second way — the numbers are the day's own
 * `WeatherReport`, the tags are its `TimeContext`, the moon shape is
 * `model/moon-shape.ts`'s (the CYCLE window's own). A number here and a number
 * a ```wadjet``` block prints for the same date are the same number (SPEC law
 * 4: real data only).
 *
 * Units are display-only (`model/format.ts`): storage stays metric and the
 * card converts on the way to the screen, per `settings.units`.
 *
 * Pinned days (`state.world.overrides`) carry the audition's gold ▼ and, when
 * the override wrote one, its note — the same marker the strip uses.
 */
import { compassPoint } from "../../core/report";
import { rollCached, type AuditionDay, type AuditionYear } from "../model/audition";
import { conditionCode, conditionColour, conditionOf } from "../model/copy";
import { format, yearLabel } from "../model/format";
import { channelHint } from "../model/hints-channels";
import { litShapePath, phaseTint } from "../model/moon-shape";
import { openCycleFor } from "./windows/cycle";
import { cycleColour, ERA_CYCLE, SEASON_CYCLE } from "../model/palette";
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

/** The days either side of the centre the NEIGHBOUR list offers (the prototype's own four). */
const NEIGHBOUR_OFFSETS = [-2, -1, 1, 2] as const;

/** The moon disc's SVG box and the disc inside it — the prototype's 88-unit viewBox. */
const MOON_BOX = 88;
const MOON_R = 30;

/** Cloud cover is reported in eighths, the way an observer counts it. */
const OKTAS = 8;

// ---------------------------------------------------------------------------
// The day's own words (the condition copy itself lives in `model/copy.ts`)
// ---------------------------------------------------------------------------

/** The value of one tag on a day, or `""` — `season:Thaw` → `Thaw`. */
function tagValue(day: AuditionDay, prefix: string): string {
  const tag = (day.time.tags ?? []).find((t) => t.startsWith(prefix));
  return tag === undefined ? "" : tag.slice(prefix.length);
}

/** `DAY 36 · YEAR 1600 · THAW` — the prototype's eyebrow, season included. */
export function dayEyebrow(day: AuditionDay): string {
  const year = day.time.year ?? Math.floor(day.dayOrdinal / day.time.yearLength) + 1;
  const season = tagValue(day, "season:");
  return [`DAY ${day.dayOfYear}`, `YEAR ${yearLabel(year).replace(/^Y /, "")}`, season].filter((p) => p !== "").join(" · ").toUpperCase();
}

/**
 * The tag chips SPEC §3.2 lists: `season:` `era:` `<moon> %` `regime:`, all in
 * the same lowercase tag grammar (`sable 22%`, not `Sable 22%`).
 *
 * `seasons` and `eras` are the world's own ordered NAMES, so each chip takes
 * the same palette entry the calendar ruler paints that band with — the
 * `season:Harvest` chip is the orange the Harvest band is, never a fixed hue.
 */
export function dayChips(day: AuditionDay, seasons: readonly string[] = [], eras: readonly string[] = []): Array<{ label: string; color: string }> {
  const chips: Array<{ label: string; color: string }> = [];
  const bandColour = (name: string, names: readonly string[], cycle?: readonly string[]): string => {
    const at = names.indexOf(name);
    return at < 0 ? "var(--wadjet-studio-text-dim)" : cycleColour(at, cycle);
  };
  const season = tagValue(day, "season:");
  if (season !== "") chips.push({ label: `season:${season}`, color: bandColour(season, seasons, SEASON_CYCLE) });
  const era = tagValue(day, "era:");
  if (era !== "") chips.push({ label: `era:${era}`, color: bandColour(era, eras, ERA_CYCLE) });
  for (const moon of day.time.moons ?? []) {
    // Phase is a 0..1 fraction and reads the same in every `settings.units` —
    // `format`'s "percent" quantity is unit-invariant (`toDisplay`), so any
    // units argument gives the same text; "metric" here is arbitrary.
    const phase = format(moon.phase, "percent", "metric", { digits: 0 });
    chips.push({ label: `${moon.name.toLowerCase()} ${phase.text}${phase.unit}`, color: "var(--wadjet-studio-moon)" });
  }
  chips.push({ label: `regime:${day.record.regime}`, color: "var(--wadjet-studio-text-dim)" });
  return chips;
}

// ---------------------------------------------------------------------------
// The roll under the centre
// ---------------------------------------------------------------------------

/** The centre day and the four either side, all off the same roll. */
interface Roll {
  day: AuditionDay;
  neighbours: AuditionDay[];
  rollKey: string;
}

/**
 * The day the window is centred on, plus its neighbours. `[a, b)` is at most
 * 7.5 days wide here, so the centre is unambiguous; the roll it comes from is
 * the year that centre falls in, with one year of slack either side for
 * calendars whose years are not all the same length (and for a neighbour that
 * falls over the year boundary).
 */
function centreRoll(ctx: SurfaceContext, state: StudioState): Roll | null {
  const grid = yearGridFor(ctx);
  if (grid === null) return null;
  const centre = (state.view.window.a + state.view.window.b) / 2;
  const target = Math.floor((centre - grid.epochYear) * grid.yearLength);

  const rolls: AuditionYear[] = [];
  const by = new Map<number, AuditionDay>();
  for (const year of [Math.floor(centre), Math.floor(centre) - 1, Math.floor(centre) + 1]) {
    const input = auditionInputFor(ctx, state, year);
    if (input === null) return null;
    const rolled = rollCached(input);
    rolls.push(rolled);
    for (const d of rolled.days) by.set(d.dayOrdinal, d);
    const first = rolled.days[0]?.dayOrdinal;
    const last = rolled.days[rolled.days.length - 1]?.dayOrdinal;
    // The first roll almost always holds the day AND its neighbours; the
    // year either side is only rolled when the window sits on a boundary.
    if (first !== undefined && last !== undefined && target - 2 >= first && target + 2 <= last) break;
  }

  const exact = by.get(target);
  const day =
    exact ??
    [...by.values()].reduce<AuditionDay | null>((best, d) => (best === null || Math.abs(d.dayOrdinal - target) < Math.abs(best.dayOrdinal - target) ? d : best), null);
  if (day === null) return null;

  const neighbours: AuditionDay[] = [];
  for (const off of NEIGHBOUR_OFFSETS) {
    const n = by.get(day.dayOrdinal + off);
    if (n !== undefined) neighbours.push(n);
  }
  return { day, neighbours, rollKey: rolls.map((r) => r.key).join("+") };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** One `precip  dry` row in the stats column. */
interface Stat {
  el: HTMLElement;
  value: HTMLElement;
}

function createStat(parent: HTMLElement, field: string, label: string, colour: string): Stat {
  const el = parent.createDiv({ cls: "wadjet-studio-daycard-cell", attr: { "data-field": field, "data-hint": channelHint("daycard.readout") } });
  el.createSpan({ cls: "wadjet-studio-daycard-cell-label", text: label });
  const value = el.createSpan({ cls: "wadjet-studio-daycard-cell-value" });
  value.setCssProps({ "--wadjet-studio-daycard-value-color": colour });
  return { el, value };
}

/** One row of the NEIGHBOUR list: swatch, `day 34 · broken cloud`, temperature. */
interface Neighbour {
  el: HTMLElement;
  swatch: HTMLElement;
  label: HTMLElement;
  temp: HTMLElement;
}

export function createDayCard(parent: HTMLElement, ctx: SurfaceContext, hint: string, jumpToDay: (dayOrdinal: number) => void): DayCardComponent {
  const el = parent.createDiv({ cls: "wadjet-studio-daycard wadjet-studio-playlist-daycard is-hidden", attr: { "data-hint": hint } });

  const panel = el.createDiv({ cls: "wadjet-studio-daycard-panel" });
  const read = panel.createDiv({ cls: "wadjet-studio-daycard-read", attr: { "data-hint": channelHint("daycard.head") } });
  // `DAY 36 · YEAR 1600 · THAW`, redrawn as the window slides. The class stays
  // `-date`: it is the same line the walk reads, in the prototype's grammar.
  const dateEl = read.createDiv({ cls: "wadjet-studio-daycard-date" });
  const hero = read.createDiv({ cls: "wadjet-studio-daycard-hero" });
  const tempEl = hero.createSpan({ cls: "wadjet-studio-daycard-temp wadjet-studio-num" });
  const condEl = hero.createSpan({ cls: "wadjet-studio-daycard-cond" });
  const codeEl = hero.createSpan({ cls: "wadjet-studio-daycard-code" });
  const pinEl = hero.createSpan({ cls: "wadjet-studio-daycard-pin is-hidden", text: PIN_GLYPH, attr: { "data-hint": channelHint("daycard.pin") } });
  const chipsEl = read.createDiv({ cls: "wadjet-studio-daycard-chips" });
  const noteEl = read.createDiv({ cls: "wadjet-studio-daycard-note is-hidden" });

  panel.createDiv({ cls: "wadjet-studio-daycard-gap" });

  const stats = panel.createDiv({ cls: "wadjet-studio-daycard-stats" });
  const cells = {
    precipitation: createStat(stats, "precipitation", "precip", "var(--wadjet-studio-precip)"),
    wind: createStat(stats, "wind", "wind", "var(--wadjet-studio-wind)"),
    sky: createStat(stats, "sky", "cloud", "var(--wadjet-studio-sky)"),
    humidity: createStat(stats, "humidity", "humidity", "var(--wadjet-studio-gold)"),
  };

  // The disc is a door as well as a readout: the prototype's day card opens
  // the moon's CYCLE editor from it (`data-vst="sablemoon"`), SPEC law 2.
  const moon = panel.createDiv({ cls: "wadjet-studio-daycard-moon", attr: { "data-hint": channelHint("daycard.moon"), role: "button", tabindex: "0" } });
  let moonName: string | null = null;
  const openMoon = (): void => {
    if (moonName !== null) openCycleFor(ctx, moonName);
  };
  moon.addEventListener("click", openMoon);
  moon.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openMoon();
  });
  const svg = moon.createSvg("svg", { attr: { viewBox: `0 0 ${MOON_BOX} ${MOON_BOX}`, "aria-hidden": "true" } });
  svg.createSvg("circle", { cls: "wadjet-studio-daycard-moon-disc", attr: { cx: MOON_BOX / 2, cy: MOON_BOX / 2, r: MOON_R + 4 } });
  const moonLit = svg.createSvg("path", { cls: "wadjet-studio-daycard-moon-lit" });
  const moonCaption = moon.createDiv({ cls: "wadjet-studio-daycard-moon-caption" });

  const neighboursEl = el.createDiv({ cls: "wadjet-studio-daycard-neighbours" });
  const neighbours: Neighbour[] = NEIGHBOUR_OFFSETS.map(() => {
    const row = neighboursEl.createDiv({ cls: "wadjet-studio-daycard-neighbour is-hidden", attr: { role: "button", tabindex: "0", "data-hint": channelHint("daycard.neighbour") } });
    return {
      el: row,
      swatch: row.createSpan({ cls: "wadjet-studio-daycard-neighbour-swatch" }),
      label: row.createSpan({ cls: "wadjet-studio-daycard-neighbour-label" }),
      temp: row.createSpan({ cls: "wadjet-studio-daycard-neighbour-temp wadjet-studio-num" }),
    };
  });

  const emptyEl = el.createDiv({ cls: "wadjet-studio-daycard-empty is-hidden", text: "No day here — pick a zone to see the roll" });

  /** A neighbour jumps the window; the row is a button, so Enter and Space do too. */
  function jump(row: HTMLElement): void {
    const ordinal = Number(row.dataset["day"]);
    if (Number.isFinite(ordinal)) jumpToDay(ordinal);
  }
  const onClick = (ev: MouseEvent): void => jump(ev.currentTarget as HTMLElement);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    jump(ev.currentTarget as HTMLElement);
  };
  for (const n of neighbours) {
    n.el.addEventListener("click", onClick);
    n.el.addEventListener("keydown", onKey);
  }

  let chips: ChipComponent[] = [];
  /** The last day painted, so a tick that did not move the centre touches no DOM. */
  let painted = "";

  function clearChips(): void {
    for (const chip of chips) chip.destroy();
    chips = [];
  }

  function paint(roll: Roll | null, state: StudioState): void {
    const units = ctx.plugin.settings.units;
    const day = roll?.day ?? null;
    el.toggleClass("is-empty", day === null);
    emptyEl.toggleClass("is-hidden", day !== null);
    panel.toggleClass("is-hidden", day === null);
    neighboursEl.toggleClass("is-hidden", day === null);
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
    dateEl.setText(dayEyebrow(day));

    const mean = format(r.temperature.mean, "temperature", units);
    tempEl.setText(`${mean.text}°`);
    condEl.setText(conditionOf(r));
    condEl.setCssProps({ "--wadjet-studio-daycard-cond-color": conditionColour(r) });
    codeEl.setText(conditionCode(r));

    const amount = format(r.precipitation.amountMm, "amount", units);
    cells.precipitation.value.setText(r.precipitation.type === "none" ? "dry" : `${amount.text} ${amount.unit}`);

    // `15 km/h E`, the prototype's own rounding — a wind speed to a tenth is
    // false precision on a card whose hero number is a whole degree.
    const speed = format(r.wind.speedKph, "speed", units, { digits: 0 });
    cells.wind.value.setText(r.wind.speedKph === 0 ? "calm" : `${speed.text} ${speed.unit} ${compassPoint(r.wind.directionDeg)}`);

    cells.sky.value.setText(`${Math.round(r.cloudCover * OKTAS)}/${OKTAS} okta`);

    const humidity = format(r.humidity, "percent", units, { digits: 0 });
    cells.humidity.value.setText(`${humidity.text}${humidity.unit}`);

    const phase = day.time.moons?.[0]?.phase;
    moonName = day.time.moons?.[0]?.name ?? null;
    moon.toggleClass("is-hidden", phase === undefined);
    moon.setAttr("aria-label", moonName === null ? "Moon" : `Open the ${moonName} cycle editor`);
    if (phase !== undefined) {
      moonLit.setAttr("d", litShapePath(phase, MOON_BOX / 2, MOON_BOX / 2, MOON_R));
      moonLit.setCssProps({ "--wadjet-studio-daycard-moon-lit": phaseTint(phase).toFixed(2) });
      moonCaption.setText(`phase ${phase.toFixed(2)}`);
    }

    pinEl.toggleClass("is-hidden", !day.pinned);
    const note = state.world.overrides.find((o) => o.zoneId === r.zoneId && o.dayOrdinal === day.dayOrdinal)?.patch.note ?? "";
    noteEl.setText(note);
    noteEl.toggleClass("is-hidden", !day.pinned || note === "");

    clearChips();
    // `dot: false` — a tag chip here wears its colour on the label, the way
    // the prototype's do; the LED belongs to a chip that stands for a device.
    const seasons = (ctx.calendar()?.seasons ?? state.world.calendar.seasons).map((x) => x.name);
    const eras = state.world.eras.map((e) => e.name);
    for (const spec of dayChips(day, seasons, eras)) chips.push(createChip(chipsEl, { label: spec.label, color: spec.color, dot: false, hint: channelHint("daycard.chip") }));

    const list = roll?.neighbours ?? [];
    neighbours.forEach((row, i) => {
      const n = list[i];
      row.el.toggleClass("is-hidden", n === undefined);
      if (n === undefined) {
        row.el.removeAttribute("data-day");
        return;
      }
      row.el.setAttr("data-day", String(n.dayOrdinal));
      row.swatch.setCssProps({ "--wadjet-studio-daycard-swatch": conditionColour(n.report) });
      row.label.setText(`day ${n.dayOfYear} · ${conditionOf(n.report)}`);
      row.temp.setText(`${format(n.report.temperature.mean, "temperature", units).text}°`);
    });
  }

  return {
    el,

    render(state, geo) {
      el.toggleClass("is-hidden", !geo.morph.isDay);
      // Off-screen the card derives nothing: the roll it would need is the
      // expensive half of a Day-zoom render (PLAN §7).
      if (!geo.morph.isDay) return;
      const found = centreRoll(ctx, state);
      // The roll key already folds in the profile, the calendar, the eras, the
      // salt and every pin; the day ordinal and the unit system are the rest.
      const key = found === null ? "none" : `${found.rollKey}|${found.day.dayOrdinal}|${ctx.plugin.settings.units}`;
      if (key === painted) return;
      painted = key;
      paint(found, state);
    },

    destroy() {
      for (const n of neighbours) {
        n.el.removeEventListener("click", onClick);
        n.el.removeEventListener("keydown", onKey);
      }
      clearChips();
      el.remove();
    },
  };
}
