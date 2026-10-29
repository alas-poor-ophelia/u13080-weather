/**
 * The ORRERY window's editors' half of the hint tables (docs/SESHAT-v0.md
 * §18; bead wadjet-b6x, slice 5a onward; 5b: year, slot unit and slot; 5c: gear).
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
  "orrery.yearDays": ["Year length", "days in a year before any leap rule adds to it; the slots must still fill every year"],
  "orrery.yearGear": ["Leap rule", "a gear that adds days to the year when it engages; selects the gear"],
  "orrery.slotRow": ["Slot", "this year's length of the slot; selects it"],
  "orrery.addSlot": ["Add slot", "adds a slot at the end, as long as the last one; the slots must still fill their parent"],
  "orrery.slotName": ["Slot name", "renames the slot; dates show the new name"],
  "orrery.slotDays": ["Days", "the slot's length in days, 0 for absent; a slot that took the rest takes this many instead"],
  "orrery.slotFiller": ["Filler", "the slot belongs to its parent but to no unit inside it, as a festival day outside every tenday"],
  "orrery.slotRest": ["Takes the rest", "the slot takes whatever the other slots leave of its parent"],
  "orrery.slotUp": ["Move slot up", "swaps the slot with the one before it; a season on either follows its slot"],
  "orrery.slotDown": ["Move slot down", "swaps the slot with the one after it; a season on either follows its slot"],
  "orrery.slotAddAfter": ["Add slot after", "inserts a slot after this one, as long as this one"],
  "orrery.slotRemove": ["Remove slot", "takes the slot out of its unit; refused while a season starts in it"],
  "orrery.addGear": ["Add gear", "adds a gear on every 4th year that feeds nothing yet; Save writes it"],
  "orrery.gearName": ["Gear id", "renames the gear; every length it feeds and every rule change that reads it follow"],
  "orrery.gearKind": ["Kind", "a sum of intervals, or a table of positions in a cycle; the same years stay engaged"],
  "orrery.termPin": ["Pin", "lit when this term's pin is at the pointer this year"],
  "orrery.termSign": ["Add or take away", "RRULE adds the years it matches, EXRULE takes them away; the sum must stay 0 or 1"],
  "orrery.termEvery": ["Every", "the term matches one year in this many; drag ↕, or double-click to type"],
  "orrery.termOffset": ["Offset", "shifts which year of the interval the term matches"],
  "orrery.termRemove": ["Remove term", "takes the term out of the gear; a gear keeps at least one"],
  "orrery.addTerm": ["Add term", "adds a term that takes away every 4th year of the last one"],
  "orrery.gearCell": ["Cycle year", "gold years are leap years; click to mark or unmark one"],
  "orrery.feedTarget": ["Fed length", "a length this gear adds to when it engages; selects it"],
  "orrery.feedAdd": ["Add", "days added to the length when the gear engages, −30 to +30"],
  "orrery.feedRemove": ["Stop feeding", "the length no longer changes when the gear engages"],
  "orrery.addFeed": ["Add feed", "lets the gear add a day to the year's length or to a slot"],
  "orrery.removeGear": ["Remove gear", "removes the gear and what it adds; refused while a rule change in Exceptions reads it"],
};

/**
 * The keys the Orrery's editors use. `test/studio-hints-orrery.test.ts` scans
 * `src/studio/ui/windows/orrery*.ts` and asserts this list is exactly what
 * they ask for, so a control added without a hint fails the unit gate.
 */
export const ORRERY_HINT_KEYS: readonly string[] = Object.keys(ORRERY_HINTS);

/** The `data-hint` attribute value for `key` (an unknown key shows as itself). */
export const orreryHint: HintLookup = makeHintLookup(ORRERY_HINTS);
