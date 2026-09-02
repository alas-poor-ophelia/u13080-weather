/**
 * The audition strip (SPEC §3.5): one seeded year through the whole signal
 * path, pinned to the bottom of the studio, reacting live to every draft edit.
 *
 * Four things worth knowing before editing this file:
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
 *  - **The cells are width-adaptive.** At `MIN_CELL_PX` or more per day the
 *    strip draws a column per day; below that it draws one column per bucket of
 *    days, coloured and hinted from the bucket's middle day. A bucket never
 *    averages weather into a number no day actually had (SPEC law 4).
 *  - **Markers come from the drafts, not from the roll.** The gold ▼ and the
 *    PINS chips read `state.world.overrides`, so a pin shows the instant it is
 *    written rather than one debounce later.
 *
 * Colour is the palette and nothing else (SPEC §9): the temperature tint is a
 * `color-mix` between `--wadjet-studio-temp` and `--wadjet-studio-moon`, wet
 * days wash `--wadjet-studio-precip` (or `--wadjet-studio-moon` for frozen
 * precipitation) over it, and every piece of chrome is graphite.
 */
import type { PrecipType } from "../../core/generator";
import type { Override } from "../../core/report";
import { generatedPatch } from "../../plugin/pins";
import type { TimeAdapter } from "../../plugin/time/adapter";
import { rollCached, type AuditionDay, type AuditionInput, type AuditionYear } from "../model/audition";
import { dayLabel, yearLabel } from "../model/format";
import { auditionHint, dayTip } from "../model/hints-audition";
import { moonPhaseAt } from "../model/spans";
import type { StudioState } from "../model/state";
import { createChip, createWrites, type ChipComponent, type WritesComponent } from "./components";
import type { Surface, SurfaceContext } from "./surfaces";

/** How long the edits must stop for before the year is re-rolled (PLAN D11). */
export const ROLL_DEBOUNCE_MS = 60;

/** At or above this many pixels per day the strip draws a column per day; below it, buckets. */
export const MIN_CELL_PX = 3;

/** Strip width to assume before the leaf has been laid out (`clientWidth` 0). */
const FALLBACK_STRIP_WIDTH = 900;

/** Precipitation type → the cell's modifier class. The class is what a re-roll visibly changes. */
const PRECIP_CLASS: Record<PrecipType, string> = { none: "is-dry", drizzle: "is-drizzle", rain: "is-rain", sleet: "is-sleet", snow: "is-snow" };

/** Frozen precipitation reads as moonlight, liquid as the precip channel. */
const FROZEN: ReadonlySet<PrecipType> = new Set<PrecipType>(["snow", "sleet"]);

/** Temperature tint domain, in °C: below `COLD` is fully moon, above `WARM` fully temp. */
const COLD = -10;
const WARM = 30;

/** Amount at which a wet day is drawn at full strength, in mm. */
const SOAKED_MM = 15;
const WET_MIN_ALPHA = 0.25;

/** Season bands cycle the four channel colours — data colours, never chrome (SPEC §9). */
const SEASON_TINTS = ["var(--wadjet-studio-temp)", "var(--wadjet-studio-precip)", "var(--wadjet-studio-wind)", "var(--wadjet-studio-sky)"] as const;

/** How many temperature bands a cell's class carries. Coarse on purpose: it is a visual bucket, not a value. */
const TEMP_BANDS = 8;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 0 at `COLD` or below, 1 at `WARM` or above. */
function warmth(meanC: number): number {
  return clamp01((meanC - COLD) / (WARM - COLD));
}

/** The palette expression for a day's temperature: warm end `--wadjet-studio-temp`, cold end `--wadjet-studio-moon`. */
export function tempTint(meanC: number): string {
  const pct = Math.round(warmth(meanC) * 100);
  return `color-mix(in srgb, var(--wadjet-studio-temp) ${pct}%, var(--wadjet-studio-moon))`;
}

/** How strongly a wet day washes over the tint: 0 when dry, `WET_MIN_ALPHA`..1 by amount. */
export function wetAlpha(type: PrecipType, amountMm: number): number {
  if (type === "none") return 0;
  return WET_MIN_ALPHA + (1 - WET_MIN_ALPHA) * clamp01(amountMm / SOAKED_MM);
}

/** The class list a cell carries. Both halves move with the weather, so a re-roll is visible in the DOM. */
export function cellClasses(day: AuditionDay): string {
  const band = Math.min(TEMP_BANDS - 1, Math.max(0, Math.floor(warmth(day.report.temperature.mean) * TEMP_BANDS)));
  return `wadjet-studio-audition-cell ${PRECIP_CLASS[day.report.precipitation.type]} is-t${band}`;
}

/**
 * The day each drawn column stands for. At `MIN_CELL_PX` or more per day that
 * is every day in order; below it, the middle day of each bucket — a real day,
 * never an average.
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

/** SPEC §3.5's Writes footer, and the error form that replaces the cells. */
export function footerText(o: { year: number; seed: string; salt: number } | null, errors: number): string {
  if (errors > 0) return `audition · fix ${errors} ${errors === 1 ? "issue" : "issues"} to roll`;
  if (o === null) return "audition · no zone";
  return `audition · ${yearLabel(o.year)} · seed ${o.seed.slice(0, 8)} · salt ${o.salt}`;
}

export function createAuditionSurface(): Surface {
  let ctx: SurfaceContext | null = null;

  let strip: HTMLElement | null = null;
  let cellsEl: HTMLElement | null = null;
  let marksEl: HTMLElement | null = null;
  let seasonsEl: HTMLElement | null = null;
  let pinsEl: HTMLElement | null = null;
  let controlsEl: HTMLElement | null = null;
  let rerollEl: HTMLElement | null = null;
  let writes: WritesComponent | null = null;
  let pinChips: ChipComponent[] = [];

  /** The columns as drawn: `days[i]` is the day column `i` stands for. */
  let columns: AuditionDay[] = [];
  let rolled: AuditionYear | null = null;
  let timer: number | null = null;
  /** Cells are rebuilt only when the roll or the drawn width actually changed. */
  let paintedKey = "";
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
    columns.forEach((day, i) => {
      const cell = cells.createDiv({
        cls: cellClasses(day),
        attr: { "data-index": String(i), "data-day-ordinal": String(day.dayOrdinal), "data-hint": dayTip(day.report, day.dayOfYear, yearLength) },
      });
      cell.setCssProps({ "--wadjet-studio-audition-tint": tempTint(day.report.temperature.mean) });
      const alpha = wetAlpha(day.report.precipitation.type, day.report.precipitation.amountMm);
      if (alpha > 0) {
        const wet = cell.createDiv({ cls: "wadjet-studio-audition-wet" });
        wet.setCssProps({
          "--wadjet-studio-audition-wet-a": alpha.toFixed(3),
          "--wadjet-studio-audition-wet-c": FROZEN.has(day.report.precipitation.type) ? "var(--wadjet-studio-moon)" : "var(--wadjet-studio-precip)",
        });
      }
    });

    // Season bands: the calendar's own, read off each day's tags so a flipped
    // hemisphere lands where the engine puts it. An opaque calendar has none.
    const described = ctx?.calendar();
    if (described !== null && described !== undefined && described.seasons.length > 0) {
      for (const [n, run] of seasonRuns(days).entries()) {
        const band = seasons.createDiv({ cls: "wadjet-studio-audition-season", attr: { "data-hint": auditionHint("audition.seasons", `${run.name} — edit the bands in Calendar`) } });
        band.setCssProps({
          "--wadjet-studio-audition-x": `${(run.from / Math.max(1, days.length)) * 100}%`,
          "--wadjet-studio-audition-w": `${((run.to - run.from + 1) / Math.max(1, days.length)) * 100}%`,
          "--wadjet-studio-audition-c": SEASON_TINTS[n % SEASON_TINTS.length] ?? SEASON_TINTS[0],
        });
      }
    }

    // Moon-full marks: the first moon only — the strip is 365 px wide at best
    // and a second cycle's ticks would be noise, not information.
    const moon = described?.moons[0];
    if (moon !== undefined && days.length > 0) {
      for (const at of fullMoonIndices(days, moon)) {
        const tick = marks.createDiv({ cls: "wadjet-studio-audition-moon", attr: { "data-hint": auditionHint("audition.moon", `${moon.name} full · ${dayLabel(days[at]!.dayOfYear + 1, days.length)}`) } });
        tick.setCssProps({ "--wadjet-studio-audition-x": `${(at / days.length) * 100}%` });
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
    // Before the first roll there is no year to measure; fall back to the
    // adapter's own year length so a chip never reads `d 1` for every pin.
    const yearLength = days.length > 0 ? days.length : Math.max(1, Math.round(time?.toContext(0).yearLength ?? 365));
    for (const override of myPins(state)) {
      const at = days.findIndex((d) => d.dayOrdinal === override.dayOrdinal);
      const doy = at >= 0 ? days[at]!.dayOfYear : (time?.toContext(override.dayOrdinal).dayOfYear ?? 0);
      const label = dayLabel(doy + 1, yearLength);
      if (at >= 0) {
        const mark = marks.createDiv({ cls: "wadjet-studio-audition-pin wadjet-studio-pin", text: "▼", attr: { "data-day-ordinal": String(override.dayOrdinal), "data-hint": auditionHint("audition.pin", `${label} is fixed by hand — × removes it`) } });
        mark.setCssProps({ "--wadjet-studio-audition-x": `${(at / yearLength) * 100}%` });
      }
      const chip = createChip(list, { label, icon: "●", color: "var(--wadjet-studio-gold)", hint: auditionHint("audition.pin", `${label} is fixed by hand — × removes it`) });
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
    list.toggleClass("is-empty", pinChips.length === 0);
  }

  function paintFooter(state: StudioState): void {
    // A draft the validator rejects has no year to name (SPEC §3.5): the footer
    // says how many issues stand between it and a roll instead.
    const errors = rolled === null || rolled.days.length > 0 ? 0 : rolled.issues.filter((i) => i.level === "error").length;
    const input = inputFor(state);
    writes?.update({ grammar: footerText(input === null ? null : { year: input.year, seed: input.seed, salt: input.salt }, errors) });
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
      // empty year the footer already knows how to describe (SPEC §8).
      try {
        rolled = rollCached(input);
      } catch {
        rolled = null;
      }
      lastRollMs = performance.now() - started;
      strip?.setAttr("data-roll-ms", lastRollMs.toFixed(1));
      paintCells();
    }
    paintPins(state);
    paintFooter(state);
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

      strip = body.createDiv({ cls: "wadjet-studio-audition-strip", attr: { "data-hint": auditionHint("audition.strip") } });
      cellsEl = strip.createDiv({ cls: "wadjet-studio-audition-cells" });
      marksEl = strip.createDiv({ cls: "wadjet-studio-audition-marks" });
      seasonsEl = body.createDiv({ cls: "wadjet-studio-audition-seasons" });

      const controls = body.createDiv({ cls: "wadjet-studio-audition-controls" });
      controlsEl = controls;
      const legend = controls.createDiv({ cls: "wadjet-studio-audition-legend", attr: { "data-hint": auditionHint("audition.legend") } });
      for (const [cls, label] of [
        ["is-dry", "dry"],
        ["is-rain", "rain"],
        ["is-snow", "snow"],
        ["is-pin", "pinned"],
      ] as const) {
        const item = legend.createDiv({ cls: "wadjet-studio-audition-legend-item" });
        item.createDiv({ cls: `wadjet-studio-audition-legend-swatch ${cls}` });
        item.createSpan({ cls: "wadjet-studio-audition-legend-label", text: label });
      }

      pinsEl = controls.createDiv({ cls: "wadjet-studio-audition-pins" });
      pinsEl.createSpan({ cls: "wadjet-studio-audition-pins-label", text: "PINS" });

      rerollEl = controls.createDiv({ cls: "wadjet-studio-audition-btn", text: "↻ Re-roll", attr: { role: "button", tabindex: "0", "aria-label": "Re-roll the audition year", "data-hint": auditionHint("audition.reroll") } });
      rerollEl.addEventListener("click", reroll);
      rerollEl.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        reroll();
      });

      cellsEl.addEventListener("contextmenu", onContextMenu);

      writes = createWrites(next.shell.auditionFoot, { grammar: footerText(null, 0) });
    },

    render(state) {
      // Everything that does not need a roll lands now; the roll itself is
      // debounced, so a knob drag re-rolls once, when it stops.
      paintPins(state);
      paintFooter(state);
      schedule();
    },

    destroy() {
      if (timer !== null) win().clearTimeout(timer);
      timer = null;
      cellsEl?.removeEventListener("contextmenu", onContextMenu);
      for (const chip of pinChips) chip.destroy();
      pinChips = [];
      writes?.destroy();
      writes = null;
      strip?.remove();
      seasonsEl?.remove();
      controlsEl?.remove();
      strip = cellsEl = marksEl = seasonsEl = pinsEl = controlsEl = rerollEl = null;
      columns = [];
      rolled = null;
      paintedKey = "";
      lastRollMs = 0;
      ctx = null;
    },
  };
}
