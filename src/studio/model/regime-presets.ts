/**
 * Regime presets — the pure half of the Regimes window's `preset ▾` control
 * (SPEC §3.4 "Regimes · STATES", "Generic device": `＋ save "name" as preset`,
 * load presets of the same kind).
 *
 * A *state set* is the whole of a zone's `regimes[]`. Three things this file
 * exists to settle:
 *
 *  - **A zone's set has a name even though nothing stores one.** A zone is
 *    copied from a shipped station preset (`zone.preset.id`), so while its
 *    states still equal that preset's the pill reads the preset's name —
 *    `Fjord Coast`. The moment a knob moves it reads `custom`, and once a
 *    saved set is loaded it reads that set's name. `currentSetName` is that
 *    resolution, in that order of precedence: the zone's own base record wins
 *    over any other preset that happens to ship the same states.
 *  - **Equality is by value, not by key order.** A set that came back through
 *    the JSON drawer has the same fields in a different order;
 *    `canonicalJson` sorts keys, so the comparison is on content only.
 *  - **A set travels verbatim.** Unlike a `DevicePreset`, `regimes[]` carries
 *    no instance identity (no id, no stage, no slot), so loading is a
 *    replacement and saving is a copy — there is nothing to strip.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */
import { PRESETS } from "../../generated/presets";
import { canonicalJson } from "../../core/profile";
import type { Preset, Regime, ZoneProfile } from "../../core/types";
import type { RegimePreset } from "../../plugin/settings";
import { uniqueId } from "../../plugin/zones";
import type { WorldDraft } from "./state";

/** What the pill reads once the zone's states match no set the studio knows. */
export const CUSTOM_SET = "custom";

/** One entry the `▾` offers: a name, the states behind it, and whether the user wrote it. */
export interface RegimeSet {
  name: string;
  regimes: readonly Regime[];
  /** true for a set out of `world.regimePresets` — the ones badged `yours`. */
  yours: boolean;
}

/**
 * Every shipped station record, alternates included. Alternates are hidden from
 * the *zone creation* picker (`settings-tab.ts`, `atlas.ts`) because they are
 * variants of a place, but a zone may well be based on one — leaving them out
 * would mean a zone whose own base set had no name to show.
 */
const SHIPPED: readonly Preset[] = PRESETS;

/** A set's content, key order normalised, so two sets compare as values. */
function key(regimes: readonly Regime[]): string {
  return canonicalJson(regimes);
}

/**
 * The shipped sets' keys, computed once. `currentSetName` runs on every store
 * tick the Regimes panel is open, and 26 records re-canonicalised each time
 * would be 26 stringifies a frame for an answer that can never change.
 */
let shippedKeys: readonly string[] | null = null;

function shippedKeyAt(index: number): string {
  if (shippedKeys === null) shippedKeys = SHIPPED.map((p) => key(p.regimes));
  return shippedKeys[index] ?? "";
}

/** Are these the same states? Deep, and blind to key order (a JSON round-trip reorders them). */
export function regimesEqual(a: readonly Regime[], b: readonly Regime[]): boolean {
  return key(a) === key(b);
}

/** The `N states` sub the `▾` shows under a set's name. */
export function regimeSetSub(set: Pick<RegimeSet, "regimes">): string {
  return `${set.regimes.length} state${set.regimes.length === 1 ? "" : "s"}`;
}

/**
 * Every set the `▾` offers: the shipped records first, then the world's own,
 * badged `yours` (SPEC §3.6's order).
 *
 * The shipped records are grouped by CONTENT, not listed one per record. Every
 * station record today ships the same three states — `normal / wet-spell /
 * dry-spell` — because what a station record curates is the *climate*, not the
 * day-to-day states; listing all 26 would be 26 identical options. Each
 * distinct set is offered once, under the name of the record it came from, and
 * `zone` decides which record speaks for a group it is in: a Red Desert zone
 * sees its own set called "Red Desert", not whichever record happened to be
 * first in the generated list.
 */
export function regimeSetsOffered(world: Pick<WorldDraft, "regimePresets">, zone?: Pick<ZoneProfile, "preset"> | null): RegimeSet[] {
  const baseId = zone?.preset?.id;
  const groups = new Map<string, number>();
  SHIPPED.forEach((p, i) => {
    const k = shippedKeyAt(i);
    const at = groups.get(k);
    if (at === undefined) groups.set(k, i);
    else if (p.id === baseId) groups.set(k, i);
  });
  return [
    ...[...groups.values()].map((i): RegimeSet => ({ name: SHIPPED[i]!.name, regimes: SHIPPED[i]!.regimes, yours: false })),
    ...world.regimePresets.map((p): RegimeSet => ({ name: p.name, regimes: p.regimes, yours: true })),
  ];
}

/**
 * The name the pill wears for the zone's current states: the zone's own base
 * record while they still equal it, then a user set, then any other shipped
 * record that ships the same states, and `custom` when nothing matches.
 */
export function currentSetName(zone: Pick<ZoneProfile, "regimes" | "preset">, world: Pick<WorldDraft, "regimePresets">): string {
  const mine = key(zone.regimes);
  const baseId = zone.preset?.id;
  const baseAt = baseId === undefined ? -1 : SHIPPED.findIndex((p) => p.id === baseId);
  if (baseAt >= 0 && shippedKeyAt(baseAt) === mine) return SHIPPED[baseAt]!.name;
  const yours = world.regimePresets.find((p) => key(p.regimes) === mine);
  if (yours !== undefined) return yours.name;
  const at = SHIPPED.findIndex((_, i) => shippedKeyAt(i) === mine);
  if (at >= 0) return SHIPPED[at]!.name;
  return CUSTOM_SET;
}

/** The set called `name`, or `null` — the reverse of what the `▾` offered. */
export function regimeSetByName(world: Pick<WorldDraft, "regimePresets">, name: string, zone?: Pick<ZoneProfile, "preset"> | null): RegimeSet | null {
  return regimeSetsOffered(world, zone).find((s) => s.name === name) ?? null;
}

/**
 * Load a set over the zone, in place. The states are the zone's only identity
 * here — devices gate on `{ regime: "<id>" }` by name, so a device gated on a
 * state the incoming set does not have simply stops matching, exactly as it
 * would if the state had been deleted (`removeState`).
 */
export function loadRegimeSet(z: ZoneProfile, regimes: readonly Regime[]): boolean {
  if (regimes.length === 0) return false;
  z.regimes = structuredClone(regimes) as Regime[];
  return true;
}

/** The names already taken, so a save never shadows one (`uniqueId`'s "-2", "-3" suffixing). */
function takenNames(world: Pick<WorldDraft, "regimePresets">): ReadonlySet<string> {
  // Every SHIPPED name, not just the offered representatives: a group's
  // spokesman changes with the zone, and a saved set must not collide with a
  // record name that another zone would surface.
  return new Set([CUSTOM_SET, ...SHIPPED.map((p) => p.name), ...world.regimePresets.map((p) => p.name)]);
}

/** Save the zone's states as a reusable set (`＋ save "name" as preset`). Returns the entry as written. */
export function saveRegimeSet(world: Pick<WorldDraft, "regimePresets">, zone: Pick<ZoneProfile, "regimes">, name: string): RegimePreset | null {
  const trimmed = name.trim();
  if (trimmed === "" || zone.regimes.length === 0) return null;
  const preset: RegimePreset = { name: uniqueId(trimmed, takenNames(world)), regimes: structuredClone(zone.regimes) };
  world.regimePresets.push(preset);
  return preset;
}
