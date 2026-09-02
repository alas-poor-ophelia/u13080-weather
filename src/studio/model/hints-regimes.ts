/**
 * Hint table for the `Regimes · STATES` window (SPEC §3.1's hint bar, §3.4).
 *
 * The header owns `hints.ts`; a window that lands later owns its own table so
 * two beads never edit the same object literal. The *shape* is the same —
 * `[name, detail]`, joined with `hints.ts`'s `HINT_SEPARATOR` so the one
 * delegated listener on the studio root parses both tables identically.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose,
 * no trailing full stop. The name says what the control is; the detail says
 * what moving it writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const REGIME_HINTS: Record<string, Hint> = {
  "regimes.swatch": ["State colour", "the tint the regimes lane draws this state with"],
  "regimes.name": ["State", "the id devices gate on; double-click to rename and they follow"],
  "regimes.weight": ["How often", "relative weight the roll picks this state by"],
  "regimes.dwell": ["How long", "mean days a run lasts once the roll picks it"],
  "regimes.remove": ["Remove state", "drops it from the zone; the last state is kept"],
  "regimes.add": ["Add state", "a new state at weight 0.10 and 7 d"],
  "regimes.share": ["Share of the year", "weight × dwell, normalised across the states"],
  "regimes.apply": ["What changes", "the value this state writes while it runs"],
  "regimes.applyMute": ["Op power", "silences this op without deleting it"],
  "regimes.applyAdd": ["Add a change", "pick the curve this state edits"],
  "regimes.applyRemove": ["Remove the change", "drops this op from the state"],
};

/**
 * The keys the window uses. `test/studio-regimes-hints.test.ts` scans
 * `src/studio/ui/windows/regimes.ts` and holds this list against what it asks
 * for, in both directions — the same contract `HEADER_HINT_KEYS` carries for
 * the header, so a control added without a hint fails the unit gate rather
 * than printing a raw key into the hint bar.
 */
export const REGIME_HINT_KEYS: readonly string[] = [
  "regimes.swatch",
  "regimes.name",
  "regimes.weight",
  "regimes.dwell",
  "regimes.remove",
  "regimes.add",
  "regimes.share",
  "regimes.apply",
  "regimes.applyMute",
  "regimes.applyAdd",
  "regimes.applyRemove",
];

/** The `data-hint` attribute value for `key`; an unknown key is returned as-is, so a gap is visible rather than blank. */
export const regimeHint: HintLookup = makeHintLookup(REGIME_HINTS);
