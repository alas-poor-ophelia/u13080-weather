/**
 * The ORRERY window's editors' half of the hint tables (docs/SESHAT-v0.md
 * §18; bead wadjet-b6x, slice 5a onward).
 *
 * Same house rules as `hints.ts` (SPEC §9): product microcopy, sentence
 * case, no explainer prose, no trailing full stop. The *name* says what the
 * control is; the *detail* says what moving it does or writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const ORRERY_HINTS: Record<string, Hint> = {
  "orrery.addBody": ["Add body", "adds a moon with the default phases to the draft; Save writes it"],
  "orrery.bodyName": ["Moon name", "renames the moon; zone conditions that name it follow on Save"],
  "orrery.period": ["Period", "days per turn, kept exact until the knob leaves its step; drag ↕, or double-click to type"],
  "orrery.epoch": ["Epoch", "the body's phase on day 0, as a fraction of a turn; the units that follow it keep their numbers"],
  "orrery.moladDays": ["Period days", "whole days of the molad"],
  "orrery.moladHours": ["Period hours", "hours of the molad, 0 to 23"],
  "orrery.moladParts": ["Period parts", "parts of an hour, 0 to 1079 (1080 to the hour)"],
  "orrery.phaseName": ["Phase name", "renames the phase; refused while a rule names it"],
  "orrery.phaseAt": ["Phase start", "where the phase begins, as a fraction of the turn"],
  "orrery.phaseRemove": ["Remove phase", "takes the phase out of the list; refused while a rule names it"],
  "orrery.phaseRule": ["Rule", "a rule that reads this phase by name; selects its lamp"],
  "orrery.addPhase": ["Add phase", "inserts a phase at the middle of the largest gap"],
  "orrery.removeBody": ["Remove body", "removes the moon from the draft; refused while a unit follows it"],
};

/**
 * The keys the Orrery's editors use. `test/studio-hints-orrery.test.ts` scans
 * `src/studio/ui/windows/orrery*.ts` and asserts this list is exactly what
 * they ask for, so a control added without a hint fails the unit gate.
 */
export const ORRERY_HINT_KEYS: readonly string[] = Object.keys(ORRERY_HINTS);

/** The `data-hint` attribute value for `key` (an unknown key shows as itself). */
export const orreryHint: HintLookup = makeHintLookup(ORRERY_HINTS);
