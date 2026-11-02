/**
 * The ORRERY window's editors' half of the hint tables (docs/SESHAT-v0.md
 * §18; bead wadjet-b6x, slice 5a onward; 5b: year, slot unit and slot; 5c: gear;
 * 5d: crossing, train and stage; 5e: labelled cycle; 5f: seasons).
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
  "orrery.crossingBody": ["Followed body", "the body whose crossings start each year; selects it"],
  "orrery.crossingFollow": ["Follow another body", "the year follows another body's crossings; K moves so the years keep their numbers"],
  "orrery.crossingMark": ["Mark", "the body's phase at the crossing, as a fraction of a turn; K moves so the years keep their numbers"],
  "orrery.crossingOffset": ["Offset", "moves every crossing by whole hours, as a sunset day start; K moves by the turns it crosses"],
  "orrery.crossingStart": ["Start", "the year starts on the day holding the crossing, or on the first day that begins after it"],
  "orrery.crossingK": ["K", "renumbers the crossings so the years keep their numbers when the mark, offset or body moves"],
  "orrery.crossingPeriodDays": ["Period days", "whole days between crossings; keeps this year in place, crossing 0 moves instead"],
  "orrery.crossingPeriodHours": ["Period hours", "hours between crossings, 0 to 23; keeps this year in place, crossing 0 moves instead"],
  "orrery.crossingPeriodParts": ["Period parts", "parts of an hour, 0 to 1079 (1080 to the hour); keeps this year in place, crossing 0 moves instead"],
  "orrery.crossingZeroHours": ["Crossing 0 hour", "the hour of its day crossing 0 falls in, 0 to 23"],
  "orrery.crossingZeroParts": ["Crossing 0 parts", "parts of that hour, 0 to 1079 (1080 to the hour)"],
  "orrery.trainCrossings": ["Crossings", "crossings counted in one turn of the train; most ratios stop the months adding up, and the draft stops running"],
  "orrery.trainYears": ["Years", "years in one turn of the train; most ratios stop the months adding up, and the draft stops running"],
  "orrery.trainPhase": ["Phase", "shifts which years of the train read one crossing more"],
  "orrery.addStage": ["Add stage", "adds a stage after the others with a weekday test that moves nothing yet"],
  "orrery.stageFired": ["Fired", "lit when this rule is the first that matches this year"],
  "orrery.stageRuleUp": ["Read earlier", "moves the rule up; the first rule that matches decides"],
  "orrery.stageRuleDown": ["Read later", "moves the rule down; the first rule that matches decides"],
  "orrery.stageRuleRemove": ["Remove rule", "takes the rule out of the stage; a stage keeps at least one"],
  "orrery.stageAdd": ["Add", "days the start moves when this rule is the first to match, 0 to 3"],
  "orrery.stageWindow": ["Which year", "the rule tests how long the last, this or the next year runs in the stage below"],
  "orrery.stageRuns": ["Runs", "the length in days the rule tests for, 340 to 400"],
  "orrery.stageActual": ["Runs now", "how long that year runs in the stage below; lit when the rule's length matches"],
  "orrery.stageMod": ["Mod", "the cycle the weekday test counts in, 2 to 14; marked days at or past it drop out"],
  "orrery.stageCell": ["Day", "a day the start may fall on for the rule to match; click to mark or unmark it"],
  "orrery.addLengthRule": ["Add length rule", "adds a length test last in the stage that moves nothing yet"],
  "orrery.addResidueRule": ["Add residue rule", "adds a weekday test last in the stage that moves nothing yet"],
  "orrery.removeStage": ["Remove stage", "removes the stage; the stages after it read the one before"],
  "orrery.cycleName": ["Cycle id", "renames the unit; the formats that print it and the rules that read it follow"],
  "orrery.labelName": ["Label", "renames the label; refused while a rule reads it by name"],
  "orrery.labelRemove": ["Remove label", "takes the label out; the cycle is one shorter, and so is the week that runs with it"],
  "orrery.addLabel": ["Add label", "adds a label at the end; the cycle is one longer, and so is the week that runs with it"],
  "orrery.todayIs": ["Today is", "moves the anchor so this label falls on the Orrery's day; the week moves with it"],
  "orrery.cycleSkips": ["Skips filler days", "on: the cycle stops on a filler day and carries on after it, so the days after it move; the week or day names that run with it follow"],
  "orrery.removeCycle": ["Remove cycle", "removes the unit; refused while a format, a rule, a season, a gear or a stage reads it"],
  "orrery.markName": ["Season name", "renames the season; the day line and the weather read the new name"],
  "orrery.markKind": ["From", "how the season's start is written: a fraction of the year, a day of the year, or a day of a month; the start day stays the same this year where it can"],
  "orrery.markFrom": ["From", "where the season starts, as a fraction of the year, 0 to 0.995"],
  "orrery.markDay": ["Day", "the day the season starts on: of the year, or of its month"],
  "orrery.markSlot": ["Month", "the month the season starts in; choose another"],
  "orrery.markRemove": ["Remove season", "takes the season out; removing the last removes the seasons"],
  "orrery.seasonsSkip": ["Skip filler days", "on: a filler day reads as having no season, in dates and rules; weather still uses the season around it"],
  "orrery.addMark": ["Add season", "adds a season at the middle of the longest one, as a fraction of the year"],
};

/**
 * The keys the Orrery's editors use. `test/studio-hints-orrery.test.ts` scans
 * `src/studio/ui/windows/orrery*.ts` and asserts this list is exactly what
 * they ask for, so a control added without a hint fails the unit gate.
 */
export const ORRERY_HINT_KEYS: readonly string[] = Object.keys(ORRERY_HINTS);

/** The `data-hint` attribute value for `key` (an unknown key shows as itself). */
export const orreryHint: HintLookup = makeHintLookup(ORRERY_HINTS);
