/**
 * The hint tables (SPEC §3.1, PLAN §4).
 *
 * Every interactive element in the studio carries `data-hint="name — detail"`;
 * one delegated listener on the studio root reads the nearest one and paints
 * the hint bar. This file is the single source of that text so the strings can
 * be reviewed as a set rather than found scattered through the DOM code.
 *
 * House rules for anything added here (SPEC §9): product microcopy, sentence
 * case, no explainer prose. The *name* says what the control is; the *detail*
 * says what moving it writes. Names never truncate; details ellipsize.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */

/** `[name, detail]` — the two halves of the hint bar's `● name  detail`. */
export type Hint = readonly [name: string, detail: string];

/** Shown when the pointer is over nothing that carries a hint. */
export const DEFAULT_HINT: Hint = ["Climate studio", "hover anything for what it writes"];

/** The separator between the two halves inside a `data-hint` attribute. */
export const HINT_SEPARATOR = " — ";

/**
 * The zoom presets all share one hint: the prototype names the *control*
 * ("zoom preset") and spends the detail on what the pointer can do, rather
 * than describing the view the button lands on (gap-shell §2).
 */
const ZOOM_HINT: Hint = ["zoom preset", "wheel = zoom under cursor · shift+wheel = pan"];

/**
 * **Chrome hint names are lower case** (bead wadjet-9f9.48.5.3). The prototype
 * writes `zoom preset`, `insert`, `zone file`, `opposite hemisphere`,
 * `timeline`, `audition`, `re-roll` — the name is a *description of the
 * control*, and title case made every one of them read like a proper noun.
 * Capitals are reserved for things that ARE named: a unit (`Regimes`, `Eras`,
 * `Stormtide`), a moon (`Sable full`), a person (`Köppen`).
 */
export const HINTS: Record<string, Hint> = {
  // --- header · zone side (SPEC §3.1) ---
  "zone.menu": ["zone", "this studio edits one zone · switch zones here · eras, calendar and moons are world-level and shared"],
  "zone.koppen": ["Köppen", "the class the compiled climate resolves to — diagnostic only"],
  "zone.src": ["source station", "the real station this zone was copied from — opens the atlas"],
  "zone.flip": ["opposite hemisphere", "the record's curves are shifted half a year here · on: season tag gates remap to this zone's seasons · off: tags read the world calendar"],

  // --- header · tools (SPEC §3.1) ---
  "transport.readout": ["window", "the span the playlist is showing"],
  "transport.back": ["back", "pan a quarter window earlier"],
  "transport.forward": ["forward", "pan a quarter window later"],
  "transport.out": ["zoom out", "widen the window around its centre"],
  "transport.in": ["zoom in", "narrow the window around its centre"],
  "zoom.day": ZOOM_HINT,
  "zoom.month": ZOOM_HINT,
  "zoom.season": ZOOM_HINT,
  "zoom.year": ZOOM_HINT,
  "zoom.era": ZOOM_HINT,
  "header.json": ["zone file", "the live JSON everything here writes"],
  "header.save": ["save", "write the drafts into the world"],
};

/**
 * The keys the header surface uses. `test/studio-hints.test.ts` scans
 * `src/studio/ui/header.ts` and asserts this list is exactly what it asks for,
 * so a control added without a hint (or a hint left behind by a deleted
 * control) fails the unit gate rather than showing an empty hint bar.
 */
export const HEADER_HINT_KEYS: readonly string[] = [
  "zone.menu",
  "zone.koppen",
  "zone.src",
  "zone.flip",
  "transport.readout",
  "transport.back",
  "transport.forward",
  "transport.out",
  "transport.in",
  "zoom.day",
  "zoom.month",
  "zoom.season",
  "zoom.year",
  "zoom.era",
  "header.json",
  "header.save",
];

/** What every hint table's lookup is: `(key, detailOverride?) => data-hint value`. */
export type HintLookup = (key: string, detailOverride?: string) => string;

/**
 * The one lookup, bound to one table (bead wadjet-9f9.45).
 *
 * Fifteen tables live in `hints-*.ts`, one per surface, and every one of them
 * used to hand-copy the same five lines. They are the same five lines by
 * definition — the grammar of a `data-hint` attribute is `parseHint`'s
 * inverse, and `parseHint` is here — so the copy was a place for the two to
 * drift apart, not a place for a table to differ. Each table now exports
 * `makeHintLookup(TABLE)`.
 *
 * The rules the grammar fixes:
 *
 *  - an **unknown key** falls back to the key itself rather than an empty
 *    string, so a missing entry is visible in the UI instead of silently
 *    blanking the bar;
 *  - an **empty detail** (the table's, or an override) yields the name alone,
 *    with no dangling separator;
 *  - a **detail override** replaces the table's detail and nothing else, so a
 *    control can say what *this* instance writes without restating its name.
 */
export function makeHintLookup(table: Record<string, Hint>): HintLookup {
  return (key: string, detailOverride?: string): string => {
    const entry = table[key];
    if (entry === undefined) return key;
    const detail = detailOverride ?? entry[1];
    return detail === "" ? entry[0] : `${entry[0]}${HINT_SEPARATOR}${detail}`;
  };
}

/** The `data-hint` attribute value for a key in the header's own table. */
export const hintAttr: HintLookup = makeHintLookup(HINTS);

/** Split a `data-hint` attribute back into its two halves. */
export function parseHint(attr: string): Hint {
  const at = attr.indexOf(HINT_SEPARATOR);
  if (at < 0) return [attr, ""];
  return [attr.slice(0, at), attr.slice(at + HINT_SEPARATOR.length)];
}
