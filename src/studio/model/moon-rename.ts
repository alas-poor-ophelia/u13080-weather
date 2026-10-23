/**
 * A moon rename carries its references (bead wadjet-noy, ruled 2026-10-23):
 * predicates match moons BY NAME, so when a moon keeps its identity and
 * changes its name, every reference to the old name is rewritten to the new
 * one in the same save. No warn-and-list.
 *
 * What names a moon in persisted settings (the survey):
 *  - `zones[].modifiers[].when`: `{ moon: { name } }` leaves, at any depth
 *    inside `all` / `any` / `not` (a custom device's predicate nests freely);
 *  - `zones[].modifiers[].id` of a studio moon layer, `layer:<param>:moon:<X>`
 *    (`compile.ts` finds the ☾ layer by that id, so it is a reference too);
 *  - `devicePresets[].when`, the same predicate shape.
 * Nothing else holds a moon name: gate sources are tags and refuse `moon:`
 * (`validateProfile`), days carry no `moon:` tag, eras / automation lanes /
 * regimes / overrides / bands hold ops and numbers only, and the Seshat
 * definition's own rules name bodies by id, which a rename keeps.
 *
 * Renames apply simultaneously (each name is looked up in the ORIGINAL map),
 * so a swap A→B, B→A swaps the references instead of collapsing them. A name
 * no rename mentions, including one no moon carries, is left as it is.
 * Every function returns its input object unchanged (same reference) when it
 * has nothing to rename, so untouched parts stay byte-identical.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { Modifier, Predicate, ZoneProfile } from "../../core/types";
import type { DevicePreset } from "../../plugin/settings";
import { parseLayerId } from "./compile";

/** old name → new name; identity pairs are never stored */
export type MoonRenames = ReadonlyMap<string, string>;

type NamedMoon = { readonly name: string; readonly id?: string | undefined };

/** Drop identity pairs and any rename whose old or new name is ambiguous (held by two moons), which would merge two moons' references. */
function checked(pairs: Array<[string, string]>, before: readonly NamedMoon[], after: readonly NamedMoon[]): Map<string, string> {
  const count = (list: readonly NamedMoon[], name: string) => list.filter((m) => m.name === name).length;
  const out = new Map<string, string>();
  for (const [from, to] of pairs) {
    if (from === to || count(before, from) !== 1 || count(after, to) !== 1) continue;
    out.set(from, to);
  }
  return out;
}

/**
 * The renames between two moon lists as the Studio draft tracks a moon: by
 * body id when every moon on both sides carries one (a definition world), by
 * position when none does and the count is unchanged (the legacy calendar,
 * whose windows write `calendar.moons[i]`). Anything else (ids on one side
 * only, a legacy list that grew or shrank) has no renames: a moon that lost
 * its identity is a delete and a create.
 */
export function moonRenames(before: readonly NamedMoon[], after: readonly NamedMoon[]): Map<string, string> {
  const withId = (l: readonly NamedMoon[]) => l.every((m) => m.id !== undefined);
  const withoutId = (l: readonly NamedMoon[]) => l.every((m) => m.id === undefined);
  const pairs: Array<[string, string]> = [];
  if (withId(before) && withId(after)) {
    for (const a of after) {
      const b = before.find((x) => x.id === a.id);
      if (b) pairs.push([b.name, a.name]);
    }
  } else if (withoutId(before) && withoutId(after) && before.length === after.length) {
    before.forEach((b, i) => pairs.push([b.name, after[i]!.name]));
  }
  return checked(pairs, before, after);
}

/**
 * The legacy settings Moons row's rule: a line renames a moon only when the
 * row keeps its count and order and that line differs from the stored moon in
 * its name alone (cycle, phase at day 0 and named phases as the row writes
 * them). Any other change on a line is a delete and a create, as before.
 * `same(a, b)` compares two moons with their names set equal.
 */
export function rowMoonRenames<M extends NamedMoon>(before: readonly M[], after: readonly M[], same: (a: M, b: M) => boolean): Map<string, string> {
  if (before.length !== after.length) return new Map();
  const pairs: Array<[string, string]> = [];
  before.forEach((b, i) => {
    const a = after[i]!;
    if (a.name !== b.name && same({ ...b, name: a.name }, a)) pairs.push([b.name, a.name]);
  });
  return checked(pairs, before, after);
}

/** A predicate with every `moon` leaf renamed; the same object when none is. */
export function renameMoonsInPredicate(p: Predicate, renames: MoonRenames): Predicate {
  if (renames.size === 0) return p;
  if ("all" in p) {
    const of = p.all.map((q) => renameMoonsInPredicate(q, renames));
    return of.every((q, i) => q === p.all[i]) ? p : { ...p, all: of };
  }
  if ("any" in p) {
    const of = p.any.map((q) => renameMoonsInPredicate(q, renames));
    return of.every((q, i) => q === p.any[i]) ? p : { ...p, any: of };
  }
  if ("not" in p) {
    const of = renameMoonsInPredicate(p.not, renames);
    return of === p.not ? p : { ...p, not: of };
  }
  if ("moon" in p) {
    const to = renames.get(p.moon.name);
    return to === undefined ? p : { ...p, moon: { ...p.moon, name: to } };
  }
  return p;
}

/** The moon a studio ☾ layer id names, renamed; null when the id is not a moon layer or its moon is not renamed. */
function renamedLayerId(id: string, renames: MoonRenames): string | null {
  const parsed = parseLayerId(id);
  if (!parsed || parsed.kind !== "moon" || parsed.scope === undefined) return null;
  const to = renames.get(parsed.scope);
  return to === undefined ? null : id.slice(0, id.length - parsed.scope.length) + to;
}

/**
 * A zone with every moon reference renamed (its `when` predicates and its ☾
 * layer ids); the same object when nothing names a renamed moon. A layer id
 * whose new form another modifier already holds (an orphaned layer for the
 * new name) keeps its old id, so ids stay unique; its predicate still follows.
 */
export function renameMoonsInZone(z: ZoneProfile, renames: MoonRenames): ZoneProfile {
  if (renames.size === 0 || !Array.isArray(z.modifiers)) return z;
  const newIds = z.modifiers.map((m) => renamedLayerId(m.id, renames));
  // ids that stay as they are, so a renamed id never lands on one of them
  const kept = new Set(z.modifiers.filter((_, i) => newIds[i] === null).map((m) => m.id));
  let changed = false;
  const modifiers = z.modifiers.map((m, i): Modifier => {
    const when = m.when === undefined ? undefined : renameMoonsInPredicate(m.when, renames);
    const id = newIds[i] !== null && !kept.has(newIds[i]!) ? newIds[i]! : m.id;
    if (when === m.when && id === m.id) return m;
    changed = true;
    return { ...m, id, ...(when !== undefined ? { when } : {}) };
  });
  return changed ? { ...z, modifiers } : z;
}

/** Device presets with every moon predicate renamed; the same array when none is. */
export function renameMoonsInPresets(presets: DevicePreset[], renames: MoonRenames): DevicePreset[] {
  if (renames.size === 0) return presets;
  let changed = false;
  const out = presets.map((p) => {
    const when = p.when === undefined ? undefined : renameMoonsInPredicate(p.when, renames);
    if (when === p.when) return p;
    changed = true;
    return { ...p, when: when! };
  });
  return changed ? out : presets;
}

/** Settings (or any slice holding zones and device presets) with every moon reference renamed and nothing else touched. */
export function renameMoonReferences<S extends { zones: ZoneProfile[]; devicePresets?: DevicePreset[] }>(s: S, renames: MoonRenames): S {
  if (renames.size === 0) return s;
  const zones = s.zones.map((z) => renameMoonsInZone(z, renames));
  const presets = s.devicePresets === undefined ? undefined : renameMoonsInPresets(s.devicePresets, renames);
  const zonesChanged = zones.some((z, i) => z !== s.zones[i]);
  if (!zonesChanged && presets === s.devicePresets) return s;
  return { ...s, ...(zonesChanged ? { zones } : {}), ...(presets !== s.devicePresets ? { devicePresets: presets } : {}) };
}

/**
 * The Studio's drafts with the references of `renames` renamed, in place (the
 * store's convention): every zone draft and the world's device presets.
 */
export function renameMoonsInDrafts(d: { zones: Record<string, ZoneProfile>; world: { devicePresets: DevicePreset[] } }, renames: MoonRenames): void {
  if (renames.size === 0) return;
  for (const [id, z] of Object.entries(d.zones)) {
    const next = renameMoonsInZone(z, renames);
    if (next !== z) d.zones[id] = next;
  }
  d.world.devicePresets = renameMoonsInPresets(d.world.devicePresets, renames);
}

/**
 * What the Studio Save amends into every draft its history holds (store
 * `amend`): `renames` is the draft's renames against the calendar it was
 * seeded from (`moonRenames(base, draft)`), and a draft gets the pairs its own
 * moons carry. A draft from before the rename still names the moon as
 * `base` does, so it gets none; a draft from after it gets them, so undoing
 * the rename (or any step after it) and redoing it keeps the moon and its
 * references together. A moon rename never renames references by itself in
 * the draft: this is the one place they follow, so they never move twice.
 */
export function followMoonRenames(base: readonly NamedMoon[], renames: MoonRenames): (d: { zones: Record<string, ZoneProfile>; world: { calendar: { moons: readonly NamedMoon[] }; devicePresets: DevicePreset[] } }) => void {
  return (d) => {
    const own = moonRenames(base, d.world.calendar.moons);
    const subset = new Map([...own].filter(([from, to]) => renames.get(from) === to));
    renameMoonsInDrafts(d, subset);
  };
}
