/**
 * A new world's calendar (docs/SESHAT-v0.md §15.6, ruled 2026-10-21): a world
 * with no data.json at all starts on a plain calendar definition, 365-day
 * years, the default moon and no seasons, named "Calendar", and records that
 * it was born on a definition (`calendar.origin`), so the legacy calendar is
 * never offered to it.
 *
 * Only a missing data.json makes a new world: a data.json missing a field is
 * an existing world, and `migrateSettings` fills the field from the legacy
 * defaults as before, so no stored world ever changes calendar on load.
 * (A fresh device that loads before Sync has delivered data.json also reads
 * as new: bead wadjet-1ou.) Pure: no Obsidian imports.
 */
import { print } from "../seshat";
import { SESHAT_ID } from "./calendars";
import type { WadjetSettings } from "./settings";
import { definitionFromLegacy, prepareDefinition } from "./time/seshat";

/** The name a new world's calendar starts with. */
export const NEW_WORLD_CALENDAR = "Calendar";

/**
 * Put a new world on the plain definition, in place. Leaves the settings as
 * they are (the legacy calendar) if the defaults ever could not form one.
 * @param s settings as `migrateSettings` made them from no data.json
 */
export function startNewWorld(s: WadjetSettings): void {
  const r = definitionFromLegacy(s.calendar);
  if ("refused" in r) return;
  // no seasons: no seasons field at all (an empty one is a different calendar to the hash)
  const { seasons, ...rest } = r.ast;
  const prepared = prepareDefinition(print({ ...rest, name: NEW_WORLD_CALENDAR, ...(seasons?.marks.length ? { seasons } : {}) }));
  if ("error" in prepared) return;
  s.calendar.definition = prepared.text;
  s.calendar.origin = "definition";
  s.activeTimeAdapter = SESHAT_ID;
}
