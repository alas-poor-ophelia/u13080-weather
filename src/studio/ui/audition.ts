/**
 * The audition strip (SPEC §3.5): one seeded year through the whole signal
 * path, pinned to the bottom of the studio, reacting live to every draft edit.
 *
 * Five things worth knowing before editing this file:
 *
 *  - **It is the real roll, not a preview of one.** `model/audition.ts`'s
 *    `rollYear` builds the same generator `World` does — the world seed, the
 *    era modifiers, the hemisphere flip, the pins — so at `salt: 0` every cell
 *    is byte-for-byte the weather the vault will report for that day. The
 *    re-roll button bumps `view.rerollSalt`, which salts the *generator* seed
 *    only; the world seed is never touched and the pins are keyed on the real
 *    `(zoneId, dayOrdinal)`, so they survive it (PLAN §5.1).
 *  - **One roll per 60 ms, one build of the cells per roll** (PLAN D11). Every
 *    store tick restarts a 60 ms timer; the roll happens when the edits stop.
 *    The day tip is baked into each cell's `data-hint` at build time, so hover
 *    costs one attribute read and no derivation.
 *  - **The cells are discrete and countable, never a stripe.** A column is
 *    `MIN_CELL_PX` wide including its gutter, so the strip draws one column
 *    per day only while the year fits; below that it draws one column per
 *    bucket of days, coloured and hinted from the bucket's middle day. A
 *    bucket never averages weather into a number no day actually had (law 4).
 *  - **A cell's colour is a *kind*, not a gradient.** `cellKind` sorts a day
 *    into the five the legend names — dry, wet, snow, ashfall, pinned — and
 *    the class it emits is what `styles.css` paints. Temperature still rides
 *    along as `is-t0..7` because the e2e walk reads a re-roll off the class
 *    list, and because a warm dry day is drawn warm.
 *  - **Markers come from the drafts, not from the roll.** The gold ▼ and the
 *    PINS chips read `state.world.overrides`, so a pin shows the instant it is
 *    written rather than one debounce later.
 *
 * The strip carries no Writes footer: SPEC §3.4 puts those on *windows*, and
 * the year and seed the roll used live in the header pill instead.
 *
 * Colour is the palette and nothing else (SPEC §9). Season colours are the
 * ruler's own `SEASON_CYCLE` entry for the same season index, so the bar under
 * the cells, the bands behind the charts and the Seasons window are never
 * three different greens.
 */
import type { PrecipType } from "../../core/generator";
import type { Override } from "../../core/report";
import type { Modifier } from "../../core/types";
import { generatedPatch } from "../../plugin/pins";
import type { TimeAdapter } from "../../plugin/time/adapter";
import { rollCached, type AuditionDay, type AuditionInput, type AuditionYear } from "../model/audition";
import { displayName } from "../model/copy";
import { dayLabel, format, tabular } from "../model/format";
import { auditionHint, dayTip } from "../model/hints-audition";
import { cycleColour, SEASON_CYCLE } from "../model/palette";
import { moonPhaseAt } from "../model/spans";
import type { StudioState } from "../model/state";
import { createChip, type ChipComponent } from "./components";
import type { Surface, SurfaceContext } from "./surfaces";

/** How long the edits must stop for before the year is re-rolled (PLAN D11). */
export const ROLL_DEBOUNCE_MS = 60;

/**
 * Pixels a drawn column occupies, gutter included. The prototype's strip is
 * ~9 px of cell plus a 1.5 px gutter; below that a day stops looking like
 * something you could right-click, which is the whole point of the strip.
 */
export const MIN_CELL_PX = 10;

/** Strip width to assume before the leaf has been laid out (`clientWidth` 0). */
const FALLBACK_STRIP_WIDTH = 900;

/** Precipitation type → the cell's modifier class. The class is what a re-roll visibly changes. */
const PRECIP_CLASS: Record<PrecipType, string> = { none: "is-dry", drizzle: "is-drizzle", rain: "is-rain", sleet: "is-sleet", snow: "is-snow" };

/** Frozen precipitation reads as moonlight, liquid as the precip channel. */
const FROZEN: ReadonlySet<PrecipType> = new Set<PrecipType>(["snow", "sleet"]);

/** Temperature tint domain, in °C: below `COLD` is fully moon, above `WARM` fully temp. */
const COLD = -10;
const WARM = 30;

/** A dry day this warm is drawn on the warm side of graphite, as the prototype's is. */
const WARM_DRY_C = 16;

/** mm at which a wet day steps up a shade. Two steps, three blues — the prototype's own thresholds. */
const WET_MM = 5;
const SOAKED_MM = 13;

/** How many temperature bands a cell's class carries. Coarse on purpose: it is a visual bucket, not a value. */
const TEMP_BANDS = 8;

/** The five colours the legend names, plus the two shades that sit either side of plain wet. */
export type CellKind = "dry" | "warm" | "ash" | "wet1" | "wet2" | "wet3" | "snow";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 0 at `COLD` or below, 1 at `WARM` or above. */
function warmth(meanC: number): number {
  return clamp01((meanC - COLD) / (WARM - COLD));
}

/**
 * The zone's devices that take the rain away — every daily modifier whose
 * `apply` sets or scales a precipitation probability to zero.
 *
 * This is the plugin's answer to the prototype's hard-coded `inAshAt(t)`. The
 * prototype knows its own "Ashfall" device by name; a real vault does not, so
 * the strip asks what a device *does* instead. A day the roll left dry with
 * one of these firing is dry because a device said so, and it earns the
 * ashfall colour — the legend names whichever device that is.
 */
export function noRainDevices(zone: { modifiers?: readonly Modifier[] }): string[] {
  return (zone.modifiers ?? [])
    .filter((m) => (m.stage ?? "daily") === "daily" && m.enabled !== false)
    .filter((m) => m.apply.some((op) => op.enabled !== false && op.param.startsWith("precipitation.p") && (op.op === "set" || op.op === "scale") && op.value === 0))
    .map((m) => m.id);
}

/**
 * Which of the legend's colours a day wears.
 *
 * The order is the prototype's: frozen precipitation wins over liquid, liquid
 * over a shut sky, a shut sky over warmth, warmth over plain graphite. Every
 * branch is a fact the roll already carries — nothing here re-rolls or
 * re-derives the weather (PLAN D3).
 */
export function cellKind(day: AuditionDay, noRain: readonly string[] = []): CellKind {
  const { type, amountMm } = day.report.precipitation;
  if (FROZEN.has(type)) return "snow";
  if (type !== "none") return amountMm > SOAKED_MM ? "wet3" : amountMm > WET_MM ? "wet2" : "wet1";
  if (day.active.some((id) => noRain.includes(id))) return "ash";
  return day.report.temperature.mean > WARM_DRY_C ? "warm" : "dry";
}

/**
 * The class list a cell carries: the precipitation type, the temperature band
 * and the drawn kind. All three move with the weather, so a re-roll is visible
 * in the DOM without reading a colour back out of the computed style.
 */
export function cellClasses(day: AuditionDay, noRain: readonly string[] = []): string {
  const band = Math.min(TEMP_BANDS - 1, Math.max(0, Math.floor(warmth(day.report.temperature.mean) * TEMP_BANDS)));
  const pinned = day.pinned ? " is-pinned" : "";
  return `wadjet-studio-audition-cell ${PRECIP_CLASS[day.report.precipitation.type]} is-t${band} is-k-${cellKind(day, noRain)}${pinned}`;
}

/**
 * The day each drawn column stands for. While a day gets `MIN_CELL_PX` or more
 * that is every day in order; below it, the middle day of each bucket — a real
 * day, never an average.
 */
export function columnDays(days: readonly AuditionDay[], width: number): AuditionDay[] {
  if (days.length === 0) return [];
  const usable = width > 0 ? width : FALLBACK_STRIP_WIDTH;
  if (usable / days.length >= MIN_CELL_PX) return [...days];
  const columns = Math.max(1, Math.min(days.length, Math.floor(usable / MIN_CELL_PX)));
  const out: AuditionDay[] = [];
  for (let i = 0; i < columns; i++) {
    const from = Math.floor((i * days.length) / columns);
    const to = Math.floor(((i + 1) * days.length) / columns);
    out.push(days[Math.min(days.length - 1, Math.floor((from + to - 1) / 2))]!);
  }
  return out;
}

/** Runs of the same `season:` tag across the year, as `[from, to]` indices into `days` (inclusive). */
export function seasonRuns(days: readonly AuditionDay[]): Array<{ name: string; from: number; to: number }> {
  const runs: Array<{ name: string; from: number; to: number }> = [];
  days.forEach((day, i) => {
    const tag = (day.time.tags ?? []).find((t) => t.startsWith("season:"));
    if (tag === undefined) return;
    const name = tag.slice("season:".length);
    const last = runs[runs.length - 1];
    if (last && last.name === name && last.to === i - 1) last.to = i;
    else runs.push({ name, from: i, to: i });
  });
  return runs;
}

/**
 * Indices of the days on which the moon's phase crosses 0.5 — the full moon,
 * read the same way `spans.ts` reads a pulse edge, so a mark lands on the day
 * the predicate would flip on.
 */
export function fullMoonIndices(days: readonly AuditionDay[], moon: { name: string; cycleDays: number; phaseAtEpoch?: number }): number[] {
  const out: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = moonPhaseAt(moon, days[i - 1]!.dayOrdinal);
    const now = moonPhaseAt(moon, days[i]!.dayOrdinal);
    // The wrap at 1 → 0 is not a crossing of 0.5; only a rise through it is.
    if (prev < 0.5 && now >= 0.5) out.push(i);
  }
  return out;
}

/**
 * The header pill: `YR 1962 · SEED greywold`, the prototype's own grammar.
 *
 * `SALT` appears only once it is non-zero, because salt 0 *is* the vault's
 * weather and a permanent `salt 0` would say otherwise. A draft the validator
 * rejects has no year to name (SPEC §3.5): the pill says how many issues stand
 * between it and a roll instead.
 */
export function seedText(o: { year: number; seed: string; salt: number } | null, errors: number): string {
  if (errors > 0) return `FIX ${errors} ${errors === 1 ? "ISSUE" : "ISSUES"} TO ROLL`;
  if (o === null) return "NO ZONE";
  const salt = o.salt === 0 ? "" : ` · SALT ${tabular(o.salt, 0)}`;
  return `YR ${tabular(o.year, 0)} · SEED ${o.seed.slice(0, 8)}${salt}`;
}

/** `10.4 °C` — the number and its unit, the way every readout in the studio spells one (SPEC §8). */
function fmtBoth(f: { text: string; unit: string }): string {
  return f.unit === "" ? f.text : `${f.text} ${f.unit}`;
}

export function createAuditionSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  let headEl: HTMLElement | null = null;
  let seedEl: HTMLElement | null = null;
  let legendEl: HTMLElement | null = null;
  let strip: HTMLElement | null = null;
  let cellsEl: HTMLElement | null = null;
  let marksEl: HTMLElement | null = null;
  let seasonsEl: HTMLElement | null = null;
  let pinsEl: HTMLElement | null = null;
  let pinsLabelEl: HTMLElement | null = null;
  let rerollEl: HTMLElement | null = null;
  let pinChips: ChipComponent[] = [];

  /** The columns as drawn: `days[i]` is the day column `i` stands for. */
  let columns: AuditionDay[] = [];
  let rolled: AuditionYear | null = null;
  let timer: number | null = null;
  /** Cells are rebuilt only when the roll or the drawn width actually changed. */
  let paintedKey = "";
  /** The legend is rebuilt only when a name in it changes. */
  let legendKey: string | null = null;
  /** The zone's rain-taking devices, refreshed with the roll whose cells they colour. */
  let noRainAt: string[] = [];
  /** Measured cost of the last roll, in ms — read by the e2e walk. */
  let lastRollMs = 0;

  // --- state ---------------------------------------------------------------

  function win(): Window {
    return ctx?.shell.root.ownerDocument.defaultView ?? window;
  }

  function adapter(): TimeAdapter | null {
    return ctx?.plugin.time.active ?? null;
  }

  /** The window's centre year, floored — the one year the strip auditions (SPEC §3.5). */
  function centreYear(state: StudioState): number {
    return Math.floor((state.view.window.a + state.view.window.b) / 2);
  }

  function inputFor(state: StudioState): AuditionInput | null {
    const c = ctx;
    const time = adapter();
    if (c === null || time === null) return null;
    const id = state.view.zoneId;
    const zone = id === null ? undefined : state.zones[id];
    if (zone === undefined) return null;
    return {
      zone,
      eras: state.world.eras,
      seed: c.plugin.settings.worldSeed,
      adapter: time,
      year: centreYear(state),
      salt: state.view.rerollSalt,
      overrides: state.world.overrides,
    };
  }

  function myPins(state: StudioState): Override[] {
    const id = state.view.zoneId;
    if (id === null) return [];
    return state.world.overrides.filter((o) => o.zoneId === id).sort((a, b) => a.dayOrdinal - b.dayOrdinal);
  }

  // --- actions -------------------------------------------------------------

  function pin(day: AuditionDay): void {
    const c = ctx;
    if (c === null) return;
    const zoneId = c.store.get().view.zoneId;
    if (zoneId === null) return;
    const patch = generatedPatch(day.report);
    c.store.update(
      (s) => {
        const at = s.world.overrides.findIndex((o) => o.zoneId === zoneId && o.dayOrdinal === day.dayOrdinal);
        const override: Override = { zoneId, dayOrdinal: day.dayOrdinal, patch };
        if (at >= 0) s.world.overrides[at] = override;
        else s.world.overrides.push(override);
      },
      { history: true },
    );
  }

  function unpin(dayOrdinal: number): void {
    const c = ctx;
    if (c === null) return;
    const zoneId = c.store.get().view.zoneId;
    if (zoneId === null) return;
    c.store.update(
      (s) => {
        s.world.overrides = s.world.overrides.filter((o) => !(o.zoneId === zoneId && o.dayOrdinal === dayOrdinal));
      },
      { history: true },
    );
  }

  function reroll(): void {
    ctx?.store.update((s) => {
      s.view.rerollSalt += 1;
    });
  }

  function onContextMenu(ev: MouseEvent): void {
    const target = ev.target instanceof Element ? ev.target.closest(".wadjet-studio-audition-cell") : null;
    if (target === null) return;
    const at = Number(target.getAttribute("data-index"));
    const day = Number.isInteger(at) ? columns[at] : undefined;
    if (day === undefined) return;
    // The studio's own gesture (SPEC §3.8): never let Obsidian's menu open over it.
    ev.preventDefault();
    ev.stopPropagation();
    pin(day);
  }

  // --- painting ------------------------------------------------------------

  function paintCells(): void {
    const cells = cellsEl;
    const marks = marksEl;
    const seasons = seasonsEl;
    if (cells === null || marks === null || seasons === null || strip === null) return;

    const days = rolled?.days ?? [];
    const width = strip.clientWidth;
    const key = `${rolled?.key ?? "none"}|${Math.round(width)}`;
    if (key === paintedKey) return;
    paintedKey = key;

    cells.empty();
    marks.empty();
    seasons.empty();
    columns = columnDays(days, width);

    const yearLength = Math.max(1, days.length);
    const noRain = noRainAt;
    columns.forEach((day, i) => {
      cells.createDiv({
        cls: cellClasses(day, noRain),
        attr: { "data-index": String(i), "data-day-ordinal": String(day.dayOrdinal), "data-hint": dayTip(day.report, day.dayOfYear, yearLength) },
      });
    });

    // Season bands: the calendar's own, read off each day's tags so a flipped
    // hemisphere lands where the engine puts it. An opaque calendar has none.
    // The bar sits above the cells and its names below them, both in the ruler's
    // colour for that season index so the two surfaces agree.
    const state = ctx?.store.get();
    const described = ctx?.calendar();
    if (described !== null && described !== undefined && described.seasons.length > 0) {
      for (const [n, run] of seasonRuns(days).entries()) {
        const colour = cycleColour(state?.view.colours.seasons[n] ?? n, SEASON_CYCLE);
        const hint = auditionHint("audition.seasons", `${run.name} — edit the bands in Calendar`);
        const left = `${(run.from / Math.max(1, days.length)) * 100}%`;
        const band = seasons.createDiv({ cls: "wadjet-studio-audition-season", attr: { "data-hint": hint } });
        band.setCssProps({
          "--wadjet-studio-audition-x": left,
          "--wadjet-studio-audition-w": `${((run.to - run.from + 1) / Math.max(1, days.length)) * 100}%`,
          "--wadjet-studio-audition-c": colour,
        });
        const tick = marks.createSpan({ cls: "wadjet-studio-audition-tick", text: run.name, attr: { "data-hint": hint } });
        tick.setCssProps({ "--wadjet-studio-audition-x": left, "--wadjet-studio-audition-c": colour });
      }
    }

    // Moon-full marks: the first moon only — the strip is one year wide and a
    // second cycle's ticks would be noise, not information.
    const moon = described?.moons[0];
    if (moon !== undefined && days.length > 0) {
      for (const at of fullMoonIndices(days, moon)) {
        const dot = marks.createDiv({ cls: "wadjet-studio-audition-moon", attr: { "data-hint": auditionHint("audition.moon", `${moon.name} full · ${dayLabel(days[at]!.dayOfYear, days.length)}`) } });
        dot.setCssProps({ "--wadjet-studio-audition-x": `${(at / days.length) * 100}%` });
      }
    }

    strip.toggleClass("is-empty", columns.length === 0);
  }

  /** The gold ▼ over every pinned day, and the PINS chips. Both read the drafts, not the roll. */
  function paintPins(state: StudioState): void {
    const marks = marksEl;
    const list = pinsEl;
    if (marks === null || list === null) return;

    for (const chip of pinChips) chip.destroy();
    pinChips = [];
    for (const stale of Array.from(marks.querySelectorAll(".wadjet-studio-audition-pin"))) stale.remove();

    const days = rolled?.days ?? [];
    const time = adapter();
    const units = ctx?.units() ?? "metric";
    // Before the first roll there is no year to measure; fall back to the
    // adapter's own year length so a chip never reads `d0` for every pin.
    const yearLength = days.length > 0 ? days.length : Math.max(1, Math.round(time?.toContext(0).yearLength ?? 365));
    for (const override of myPins(state)) {
      const at = days.findIndex((d) => d.dayOrdinal === override.dayOrdinal);
      const doy = at >= 0 ? days[at]!.dayOfYear : (time?.toContext(override.dayOrdinal).dayOfYear ?? 0);
      // `dayOfYear` is already 0-based, and so is `dayLabel` — no `+ 1`
      // (bead wadjet-9f9.48.2).
      const label = dayLabel(doy, yearLength);
      const hint = auditionHint("audition.pin", `${label} is fixed by hand — × removes it`);
      if (at >= 0) {
        const mark = marks.createDiv({ cls: "wadjet-studio-audition-pin wadjet-studio-pin", text: "▼", attr: { "data-day-ordinal": String(override.dayOrdinal), "data-hint": hint } });
        mark.setCssProps({ "--wadjet-studio-audition-x": `${(at / yearLength) * 100}%` });
      }
      // The chip quotes the pinned weather itself — the patch is the override,
      // so the chip stays true even when the roll under it changes.
      const mean = override.patch.temperature?.mean;
      const kind = override.patch.precipitation?.type;
      const temp = mean === undefined ? "" : ` · ${fmtBoth(format(mean, "temperature", units))}`;
      const sky = kind === undefined ? "" : ` ${kind === "none" ? "dry" : kind}`;
      const chip = createChip(list, { label: `${label}${temp}${sky}`, icon: "▼", color: "var(--wadjet-studio-gold)", hint });
      chip.el.setAttr("data-part", "pin-chip");
      chip.el.setAttr("data-day-ordinal", String(override.dayOrdinal));
      const close = chip.el.createSpan({ cls: "wadjet-studio-audition-pin-x", text: "×", attr: { role: "button", tabindex: "0", "aria-label": `Remove the pin on ${label}` } });
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        unpin(override.dayOrdinal);
      });
      close.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        unpin(override.dayOrdinal);
      });
      pinChips.push(chip);
    }
    // No pins, no PINS label: the prototype shows the group only once it has
    // something in it, and an empty label reads as a broken control.
    pinsLabelEl?.toggleClass("is-hidden", pinChips.length === 0);
    list.toggleClass("is-empty", pinChips.length === 0);
  }

  /**
   * The five swatches the strip's colours mean. Two of them are named after
   * things only THIS world has: the first moon, and the device that takes the
   * rain away — so a vault with a `Neverain` and no `Ashfall` gets a legend
   * that names Neverain.
   */
  function paintLegend(state: StudioState): void {
    const legend = legendEl;
    if (legend === null) return;
    const moon = ctx?.calendar()?.moons[0]?.name ?? "";
    const id = state.view.zoneId;
    const zone = id === null ? undefined : state.zones[id];
    const dry = zone === undefined ? [] : noRainDevices(zone);
    // The legend is lower case throughout — `dry`, `wet`, `snow`, `ashfall`
    // — because each entry names a *kind of day*, not a thing. The one
    // exception is the moon below, which carries a real name (`Sable full`).
    const dryName = dry.length === 1 ? displayName(dry[0]!).toLowerCase() : dry.length > 1 ? "no rain" : "";
    const key = `${moon}|${dryName}`;
    if (key === legendKey) return;
    legendKey = key;
    legend.empty();
    const entries: Array<[string, string]> = [
      ["is-dry", "dry"],
      ["is-wet", "wet"],
      ["is-snow", "snow"],
      ...(dryName === "" ? [] : [["is-ash", dryName] as [string, string]]),
      ["is-moon", moon === "" ? "moon full" : `${moon} full`],
    ];
    for (const [cls, label] of entries) {
      const item = legend.createDiv({ cls: "wadjet-studio-audition-legend-item" });
      item.createDiv({ cls: `wadjet-studio-audition-legend-swatch ${cls}` });
      item.createSpan({ cls: "wadjet-studio-audition-legend-label", text: label });
    }
  }

  function paintSeed(state: StudioState): void {
    // A draft the validator rejects has no year to name (SPEC §3.5).
    const errors = rolled === null || rolled.days.length > 0 ? 0 : rolled.issues.filter((i) => i.level === "error").length;
    const input = inputFor(state);
    seedEl?.setText(seedText(input === null ? null : { year: input.year, seed: input.seed, salt: input.salt }, errors));
    seedEl?.toggleClass("is-error", errors > 0);
  }

  // --- the roll ------------------------------------------------------------

  function doRoll(): void {
    timer = null;
    const c = ctx;
    if (c === null) return;
    const state = c.store.get();
    const input = inputFor(state);
    if (input === null) {
      rolled = null;
      paintedKey = "";
      cellsEl?.empty();
      marksEl?.empty();
      seasonsEl?.empty();
      columns = [];
    } else {
      const started = performance.now();
      // `firstDayOfYear` throws when a third-party adapter cannot reach the
      // year at all. A dead strip would be the worst answer: degrade to the
      // empty year the seed pill already knows how to describe (SPEC §8).
      try {
        rolled = rollCached(input);
      } catch {
        rolled = null;
      }
      lastRollMs = performance.now() - started;
      strip?.setAttr("data-roll-ms", lastRollMs.toFixed(1));
      noRainAt = noRainDevices(input.zone);
      paintCells();
    }
    paintPins(state);
    paintSeed(state);
  }

  function schedule(): void {
    const w = win();
    if (timer !== null) w.clearTimeout(timer);
    timer = w.setTimeout(doRoll, ROLL_DEBOUNCE_MS);
  }

  // --- surface -------------------------------------------------------------

  return {
    mount(next) {
      ctx = next;
      const body = next.shell.auditionBody;

      const head = body.createDiv({ cls: "wadjet-studio-audition-head" });
      headEl = head;
      head.createSpan({ cls: "wadjet-studio-audition-title", text: "Audition" });
      seedEl = head.createSpan({ cls: "wadjet-studio-audition-seed wadjet-studio-num", attr: { "data-part": "audition-seed", "data-hint": auditionHint("audition.seed") } });

      rerollEl = head.createDiv({ cls: "wadjet-studio-audition-btn", text: "⟳ re-roll", attr: { role: "button", tabindex: "0", "aria-label": "Re-roll the audition year", "data-hint": auditionHint("audition.reroll") } });
      rerollEl.addEventListener("click", reroll);
      rerollEl.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        reroll();
      });

      pinsEl = head.createDiv({ cls: "wadjet-studio-audition-pins" });
      pinsLabelEl = pinsEl.createSpan({ cls: "wadjet-studio-audition-pins-label is-hidden", text: "PINS", attr: { "data-hint": auditionHint("audition.pins") } });

      head.createDiv({ cls: "wadjet-studio-audition-spacer" });
      legendEl = head.createDiv({ cls: "wadjet-studio-audition-legend", attr: { "data-hint": auditionHint("audition.legend") } });

      seasonsEl = body.createDiv({ cls: "wadjet-studio-audition-seasons" });
      strip = body.createDiv({ cls: "wadjet-studio-audition-strip", attr: { "data-hint": auditionHint("audition.strip") } });
      cellsEl = strip.createDiv({ cls: "wadjet-studio-audition-cells" });
      marksEl = body.createDiv({ cls: "wadjet-studio-audition-marks" });

      cellsEl.addEventListener("contextmenu", onContextMenu);
    },

    render(state) {
      // Everything that does not need a roll lands now; the roll itself is
      // debounced, so a knob drag re-rolls once, when it stops.
      paintLegend(state);
      paintPins(state);
      paintSeed(state);
      schedule();
    },

    destroy() {
      if (timer !== null) win().clearTimeout(timer);
      timer = null;
      cellsEl?.removeEventListener("contextmenu", onContextMenu);
      for (const chip of pinChips) chip.destroy();
      pinChips = [];
      headEl?.remove();
      seasonsEl?.remove();
      strip?.remove();
      marksEl?.remove();
      headEl = seedEl = legendEl = strip = cellsEl = marksEl = seasonsEl = pinsEl = pinsLabelEl = rerollEl = null;
      columns = [];
      rolled = null;
      paintedKey = "";
      legendKey = null;
      noRainAt = [];
      lastRollMs = 0;
      ctx = null;
    },
  };
}
