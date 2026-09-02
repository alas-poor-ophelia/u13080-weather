/**
 * The studio's data-colour cycles (SPEC §9 "colour reserved for data").
 *
 * SPEC §9 names six data hues — calendar/era gold `#e8c15a`, precip `#5cb8f0`,
 * wind `#7fd6a8`, temp `#f0885c`, moon `#cdd9ee`, sky `#b9c2cf` — and
 * `styles.css` publishes each as a `--wadjet-studio-*` custom property. Two
 * different cycles walk those hues, and they are *not* the same list:
 *
 *  - `DATA_CYCLE` starts on calendar gold. The ruler's season/era bands, the
 *    seasons window's segments and the eras lane's clips all use it, and the
 *    gold lead is what makes a band read as *calendar* rather than as data.
 *  - `REGIME_CYCLE` leads with neutral grey, because the first state of a real
 *    preset is the *ordinary* weather; the channel hues are spent on the
 *    states that do something. It is written as literal hexes because a regime
 *    swatch is also drawn where no studio stylesheet is in scope.
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
