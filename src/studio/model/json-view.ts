/**
 * The JSON drawer's pure half (SPEC §3.7, bead wadjet-9f9.37).
 *
 * Two views onto the same draft:
 *
 *  - `zoneFileText` is the zone *as it would be saved* — `modifiers`
 *    normalised by `zoneForSave` below (`compile.ts:normaliseOrder` on a
 *    clone, so the draft the windows are editing is never touched — and the
 *    same helper `ui/header.ts commit()` writes through, so the drawer and
 *    Save can never disagree), with `overrides` (which live
 *    on the world draft, not the `ZoneProfile`) appended for display. Keys
 *    keep the order the zone object already carries — "AUTHORED order"
 *    (`src/core/profile.ts:canonicalJson` sorts keys; this deliberately does
 *    not).
 *  - `sections` is the same draft cut into one entry per top-level key, in
 *    the fixed order the drawer draws them, each tagged `zone` or `world` so
 *    the header can label which half of the file a key belongs to. Optional
 *    keys (`preset`, `geography`, `flipSeasons`, `automation`) are omitted
 *    when the zone does not carry them, so an absent key never renders as an
 *    empty section.
 *
 * There is no `layers` key anywhere in either output (SPEC §7a, ratified
 * 2026-09-01): `modifiers` already carries `layer:*` / `forcings:*` in place.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { Override } from "../../core/report";
import type { ZoneProfile } from "../../core/types";
import { normaliseOrder } from "./compile";
import type { WorldDraft } from "./state";

/** One top-level key the drawer draws, tagged by which half of the file it belongs to. */
export interface JsonSection {
  key: string;
  scope: "zone" | "world";
  text: string;
}

/** The order `sections` draws in — SPEC §3.7: zone keys, then world keys. */
const ZONE_KEY_ORDER = ["id", "name", "preset", "geography", "flipSeasons", "climate", "regimes", "modifiers", "automation", "overrides"] as const;
const WORLD_KEY_ORDER = ["eras", "calendar.seasons", "calendar.moons", "devicePresets"] as const;

/**
 * **The zone as Save writes it**, without mutating `zone`: a clone with
 * `modifiers` in the partition `compile.ts:normaliseOrder` fixes (`layer:*` →
 * devices in rack order → `forcings:*`).
 *
 * One source of truth on purpose (bead wadjet-9f9.45). The drawer calls it so
 * its "as it would be saved" heading is true, and `ui/header.ts commit()`
 * calls it so that claim is *actually* true for a zone that arrived out of
 * order through the JSON escape hatch — before, the drawer normalised and the
 * write-through did not, so what the drawer showed and what landed in
 * `data.json` could differ in modifier order.
 *
 * The clone matters: the caller's draft is what every window is bound to, and
 * neither the drawer nor Save may move a device out from under a mid-drag rack.
 */
export function zoneForSave(zone: ZoneProfile): ZoneProfile {
  const clone = structuredClone(zone);
  normaliseOrder(clone);
  return clone;
}

/**
 * The zone the file would save, in AUTHORED key order with 2-space indent —
 * `overrides` (filtered to this zone) appended, since it lives on the world
 * draft, not the `ZoneProfile` itself. Never a `layers` key.
 */
export function zoneFileText(zone: ZoneProfile, overrides: readonly Override[]): string {
  const clone = zoneForSave(zone);
  const out = clone as ZoneProfile & { overrides: Override[] };
  out.overrides = overrides.filter((o) => o.zoneId === zone.id);
  return JSON.stringify(out, null, 2);
}

/** `Curve` and scalar values alike stringify the same way `zoneFileText` would render them. */
function textOf(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * One entry per top-level key, in `ZONE_KEY_ORDER` then `WORLD_KEY_ORDER`.
 * `modifiers` is the normalised order (see `zoneForSave`); `overrides` is
 * `world.overrides` filtered to `zone.id`.
 */
export function sections(zone: ZoneProfile, world: WorldDraft): JsonSection[] {
  const clone = zoneForSave(zone);
  const overrides = world.overrides.filter((o) => o.zoneId === zone.id);

  const zoneValues: Partial<Record<(typeof ZONE_KEY_ORDER)[number], unknown>> = {
    id: clone.id,
    name: clone.name,
    ...(clone.preset !== undefined ? { preset: clone.preset } : {}),
    ...(clone.geography !== undefined ? { geography: clone.geography } : {}),
    ...(clone.flipSeasons !== undefined ? { flipSeasons: clone.flipSeasons } : {}),
    climate: clone.climate,
    regimes: clone.regimes,
    modifiers: clone.modifiers,
    ...(clone.automation !== undefined && clone.automation.length > 0 ? { automation: clone.automation } : {}),
    overrides,
  };

  const worldValues: Record<(typeof WORLD_KEY_ORDER)[number], unknown> = {
    eras: world.eras,
    "calendar.seasons": world.calendar.seasons,
    "calendar.moons": world.calendar.moons,
    devicePresets: world.devicePresets,
  };

  const zoneSections: JsonSection[] = ZONE_KEY_ORDER.filter((k) => k in zoneValues).map((k) => ({ key: k, scope: "zone", text: textOf(zoneValues[k]) }));
  const worldSections: JsonSection[] = WORLD_KEY_ORDER.map((k) => ({ key: k, scope: "world", text: textOf(worldValues[k]) }));

  return [...zoneSections, ...worldSections];
}
