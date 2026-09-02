/**
 * Pure edits over the world's era timeline (SPEC §3.4 "Era", §2 "world · N
 * zones"). Eras are world scope: `renameEra` is the one edit here that reaches
 * outside `world.eras` itself, because a rename must carry every zone's
 * `era:<old name>` predicates and mod-matrix gates along with it (SPEC §7
 * "Era" — the tag an era hands out is its name).
 *
 * Every function here mutates its `WorldDraft`/`ZoneProfile` arguments in
 * place (the store's own convention, `model/store.ts`) and leaves
 * `validateEras` error-free on the era(s) it touched — callers still run the
 * real validator (SPEC §3.9); this file just never *introduces* an error a
 * clean draft didn't already have.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { ERA_TAG_PREFIX } from "../../core/eras";
import type { Era, ModifierOp, Predicate, ZoneProfile } from "../../core/types";
import type { WorldDraft } from "./state";

function findEra(world: WorldDraft, name: string): Era | undefined {
  return world.eras.find((e) => e.name === name);
}

/** `"Era 1"`, `"Era 2"`, … — the first not already taken. */
function uniqueEraName(taken: Iterable<string>): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const candidate = `Era ${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

/** `base`, or `base 2`, `base 3`, … the first not already taken. */
function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * Recursively rewrite a bare `{ tag: oldTag }` leaf to `newTag`, anywhere it
 * sits inside `all`/`any`/`not` composites. A custom device's predicate can be
 * arbitrarily nested (SPEC §5, `devices.ts` `customDevice`), so a rename must
 * walk the whole tree rather than assume the studio's own flat shapes.
 */
function rewriteTag(p: Predicate, oldTag: string, newTag: string): Predicate {
  if ("tag" in p) return p.tag === oldTag ? { tag: newTag } : p;
  if ("all" in p) return { all: p.all.map((q) => rewriteTag(q, oldTag, newTag)) };
  if ("any" in p) return { any: p.any.map((q) => rewriteTag(q, oldTag, newTag)) };
  if ("not" in p) return { not: rewriteTag(p.not, oldTag, newTag) };
  return p;
}

/** A whole calendar year — `Era.from`/`Era.to` are always integers (`validateEras`). */
function wholeYear(n: number): number {
  return Math.round(n);
}

/**
 * A new era spanning `[from, to]` (`to` omitted = open-ended), named uniquely.
 * Returns the name it was given.
 */
export function addEra(world: WorldDraft, from: number, to?: number): string {
  const name = uniqueEraName(world.eras.map((e) => e.name));
  const f = wholeYear(from);
  const era: Era = to === undefined ? { name, from: f } : { name, from: f, to: Math.max(wholeYear(to), f) };
  world.eras.push(era);
  return name;
}

/**
 * Rename `name` to `newName` (uniquified against every other era), then
 * rewrite `{ tag: "era:<old>" }` predicates and `mods[].source` on every
 * zone's modifiers so nothing goes on gating a tag the era no longer hands
 * out. A blank/unchanged `newName` is a no-op. Returns the name actually
 * used.
 */
export function renameEra(world: WorldDraft, zones: Record<string, ZoneProfile>, name: string, newName: string): string {
  const era = findEra(world, name);
  if (era === undefined) return name;
  const trimmed = newName.trim();
  if (trimmed === "" || trimmed === era.name) return era.name;
  const others = world.eras.filter((e) => e !== era).map((e) => e.name);
  const unique = uniqueName(trimmed, others);
  if (unique === era.name) return unique;

  const oldTag = ERA_TAG_PREFIX + era.name;
  const newTag = ERA_TAG_PREFIX + unique;
  era.name = unique;

  for (const zone of Object.values(zones)) {
    for (const mod of zone.modifiers) {
      if (mod.when !== undefined) mod.when = rewriteTag(mod.when, oldTag, newTag);
      if (mod.mods !== undefined) for (const gate of mod.mods) if (gate.source === oldTag) gate.source = newTag;
    }
  }
  return unique;
}

/** `to === undefined` opens the era to the end of time; otherwise `to` is clamped up to `from`. */
export function setSpan(world: WorldDraft, name: string, from: number, to: number | undefined): void {
  const era = findEra(world, name);
  if (era === undefined) return;
  const f = wholeYear(from);
  era.from = f;
  if (to === undefined) delete era.to;
  else era.to = Math.max(wholeYear(to), f);
}

/** Absent = enabled (`Era.enabled`'s own convention); only `false` is ever written. */
export function setEnabled(world: WorldDraft, name: string, enabled: boolean): void {
  const era = findEra(world, name);
  if (era === undefined) return;
  if (enabled) delete era.enabled;
  else era.enabled = false;
}

export function removeEra(world: WorldDraft, name: string): void {
  const at = world.eras.findIndex((e) => e.name === name);
  if (at >= 0) world.eras.splice(at, 1);
}

/** Appends one op to `era.apply`, creating the array if this is the era's first. */
export function addOp(world: WorldDraft, name: string, op: ModifierOp): void {
  const era = findEra(world, name);
  if (era === undefined) return;
  if (era.apply === undefined) era.apply = [];
  era.apply.push(op);
}

/** `set`/`offset`/`scale` carry a plain numeric `value`; a `clamp` op has none and is left alone. */
export function setOpValue(world: WorldDraft, name: string, index: number, value: number): void {
  const op = findEra(world, name)?.apply?.[index];
  if (op === undefined || op.op === "clamp") return;
  op.value = value;
}

export function removeOp(world: WorldDraft, name: string, index: number): void {
  const era = findEra(world, name);
  if (era?.apply === undefined) return;
  era.apply.splice(index, 1);
}

/** Absent = enabled (`ModifierOp.enabled`'s own convention); only `false` is ever written. */
export function setOpEnabled(world: WorldDraft, name: string, index: number, enabled: boolean): void {
  const op = findEra(world, name)?.apply?.[index];
  if (op === undefined) return;
  if (enabled) delete op.enabled;
  else op.enabled = false;
}
