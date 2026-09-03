/**
 * The studio's data-colour cycles (SPEC §9 "colour reserved for data").
 *
 * SPEC §9 names six data hues — calendar/era gold `#e8c15a`, precip `#5cb8f0`,
 * wind `#7fd6a8`, temp `#f0885c`, moon `#cdd9ee`, sky `#b9c2cf` — and
 * `styles.css` publishes each as a `--wadjet-studio-*` custom property. Two
 * different cycles walk those hues, and they are *not* the same list:
 *
 *  - `DATA_CYCLE` starts on calendar gold, and is the default a caller gets by
 *    passing no `cycle` at all.
 *  - `REGIME_CYCLE` leads with neutral grey, because the first state of a real
 *    preset is the *ordinary* weather; the channel hues are spent on the
 *    states that do something. It is written as literal hexes because a regime
 *    swatch is also drawn where no studio stylesheet is in scope.
 *  - `ERA_CYCLE` and `SEASON_CYCLE` are the two calendar cycles — see their own
 *    doc comments for why each is its own list rather than `DATA_CYCLE`.
 *
 * Colour is view state (PLAN D14): these are the defaults a position falls
 * back to, and the leaf's persisted `view.colours.*` overrides them per index.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */

/** The six band/era/season hues, as CSS custom-property names, gold first. */
export const DATA_CYCLE: readonly string[] = ["--wadjet-studio-gold", "--wadjet-studio-precip", "--wadjet-studio-wind", "--wadjet-studio-temp", "--wadjet-studio-moon", "--wadjet-studio-sky"];

/** The regime swatch cycle, as literal hexes, neutral grey first. */
export const REGIME_CYCLE: readonly string[] = ["#9298a1", "#5cb8f0", "#e8c15a", "#7fd6a8", "#f0885c", "#cdd9ee"];

/**
 * The per-era tint cycle — precip blue, wind green, calendar gold, temp
 * orange, moon, sky. It is its OWN list, not `DATA_CYCLE`: `DATA_CYCLE` leads
 * on gold, which is fine for a *band* that only ever reads as "this is the
 * calendar", but a *specific* era being told apart from its neighbours needs
 * its first two instances to differ, so `ERA_CYCLE` leads on precip blue
 * instead (gold is still in the cycle, third, for the era that lands there).
 *
 * Every place an era is tinted by its own index — the Era-zoom clip in the
 * eras row and the calendar ruler's Era-zoom band (and the curve tint that
 * shares its derivation), the mixer's era unit span chip, and the day card's
 * `era:` chip — reads from here; `state.view.colours.eras` still supplies the
 * persisted per-index override, unchanged. Two places stay fixed calendar
 * gold on purpose, never this cycle: the Eras lane label dot, and the
 * Year-zoom full-width `era:Name · from – to` bar (both SPEC §9 calendar
 * chrome, not a per-era swatch).
 */
export const ERA_CYCLE: readonly string[] = ["--wadjet-studio-precip", "--wadjet-studio-wind", "--wadjet-studio-gold", "--wadjet-studio-temp", "--wadjet-studio-moon", "--wadjet-studio-sky"];

/**
 * The season cycle — wind green, calendar gold, temp orange, precip blue,
 * moon, sky. It is its OWN list, not `DATA_CYCLE`: the prototype's four
 * shipped seasons read Thaw green · High Sun gold · Harvest orange · Deepcold
 * blue, and starting on gold (as `DATA_CYCLE` does, because an *era* band
 * should read as calendar) rotates every one of them onto the wrong hue.
 *
 * Published as `--wadjet-studio-season-1…6` in `styles.css` so the Seasons
 * window, the calendar ruler's season bands and the audition strip's season
 * ticks all reach the same six colours from CSS as well as from TS.
 */
export const SEASON_CYCLE: readonly string[] = ["--wadjet-studio-season-1", "--wadjet-studio-season-2", "--wadjet-studio-season-3", "--wadjet-studio-season-4", "--wadjet-studio-season-5", "--wadjet-studio-season-6"];

/**
 * `cycle`'s entry for `index`, wrapping in both directions (a negative or
 * out-of-range persisted colour index is view state and must never throw).
 */
export function cycleAt(index: number, cycle: readonly string[] = DATA_CYCLE): string {
  const n = cycle.length;
  return cycle[((Math.trunc(index) % n) + n) % n]!;
}

/** `index` into `DATA_CYCLE`, as a CSS colour expression — `var(--wadjet-studio-gold)`. */
export function cycleColour(index: number, cycle: readonly string[] = DATA_CYCLE): string {
  return `var(${cycleAt(index, cycle)})`;
}
