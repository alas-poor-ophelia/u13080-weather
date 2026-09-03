/**
 * The era timeline: world-level spans of years that tag every day
 * (`era:<name>`) and may apply daily-stage ops to every zone. Eras are steps
 * on the absolute timeline — a pure function of the day — so they sit inside
 * the determinism contract; they are not cycles (NON-GOALS.md).
 */
import { hash32 } from "./rng";
import { canonicalJson, type ValidationIssue, validateDailyOps } from "./profile";
import type { DayTime, Era, Modifier, ModifierOp } from "./types";

export const ERA_TAG_PREFIX = "era:";

/** The calendar year of a day: what the adapter says, else counted from year 1 at day 0. */
export function yearOf(t: DayTime & { dayOrdinal: number; yearLength: number }): number {
  return t.year ?? Math.floor(t.dayOrdinal / t.yearLength) + 1;
}

export function eraActive(e: Era, year: number): boolean {
  if (e.enabled === false) return false;
  return year >= e.from && (e.to === undefined || year <= e.to);
}

/** Tags for every era covering `year`, in list order. */
export function eraTags(eras: readonly Era[], year: number): string[] {
  return eras.filter((e) => eraActive(e, year)).map((e) => ERA_TAG_PREFIX + e.name);
}

/** Add era tags to a day's time context. */
export function withEraTags<T extends DayTime & { dayOrdinal: number; yearLength: number }>(eras: readonly Era[], t: T): T {
  if (eras.length === 0) return t;
  const tags = eraTags(eras, yearOf(t));
  return tags.length ? { ...t, tags: [...(t.tags ?? []), ...tags] } : t;
}

/**
 * Eras with ops become ordinary daily modifiers gated on their own tag, so
 * they go through the same engine (and the same op semantics) as a zone's
 * modifiers. Ids are `era:<name>`; a zone modifier may not reuse the prefix.
 */
export function eraModifiers(eras: readonly Era[]): Modifier[] {
  return eras.filter((e) => e.enabled !== false && e.apply && e.apply.length > 0).map((e) => ({ id: ERA_TAG_PREFIX + e.name, stage: "daily", when: { tag: ERA_TAG_PREFIX + e.name }, apply: e.apply! }));
}

/**
 * The daily-stage ops every era covering `year` applies, in list order —
 * `eraModifiers`' `apply` arrays with the engine's own two power switches
 * already honoured (a disabled era contributes nothing, and so does a
 * disabled op). Hand the result to `ops.ts`'s `applyDayOps`: this function
 * decides *which* ops are live, never what an op means.
 *
 * The studio's composed curves read it so a plotted year inside an era shows
 * the era's step, exactly as a rolled day inside it does.
 */
export function eraOpsAt(eras: readonly Era[], year: number): ModifierOp[] {
  const out: ModifierOp[] = [];
  for (const e of eras) {
    if (!eraActive(e, year)) continue;
    for (const op of e.apply ?? []) if (op.enabled !== false) out.push(op);
  }
  return out;
}

export function validateEras(eras: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(eras)) return [{ level: "error", path: "eras", message: "must be an array of eras" }];
  const names = new Set<string>();
  eras.forEach((e: Partial<Era>, i) => {
    const where = `eras[${i}]`;
    if (typeof e !== "object" || e === null) {
      issues.push({ level: "error", path: where, message: "era must be an object" });
      return;
    }
    if (typeof e.name !== "string" || !e.name.trim()) issues.push({ level: "error", path: `${where}.name`, message: "name is required" });
    else if (names.has(e.name)) issues.push({ level: "error", path: `${where}.name`, message: `duplicate era name "${e.name}"` });
    else names.add(e.name);
    if (!Number.isInteger(e.from)) issues.push({ level: "error", path: `${where}.from`, message: "from must be a whole year" });
    if (e.to !== undefined) {
      if (!Number.isInteger(e.to)) issues.push({ level: "error", path: `${where}.to`, message: "to must be a whole year (or omitted for open-ended)" });
      else if (Number.isInteger(e.from) && e.to < e.from!) issues.push({ level: "error", path: `${where}.to`, message: "to must not be before from" });
    }
    if (e.apply !== undefined) validateDailyOps(e.apply, `${where}.apply`, issues);
    if (e.enabled !== undefined && typeof e.enabled !== "boolean") issues.push({ level: "error", path: `${where}.enabled`, message: "enabled must be true or false" });
    for (const k of Object.keys(e)) if (!["name", "from", "to", "apply", "enabled"].includes(k)) issues.push({ level: "warning", path: `${where}.${k}`, message: "unknown field (ignored)" });
  });
  return issues;
}

/** Part of the calendar hash: eras change past weather, so they must show in provenance. */
export function erasHash(eras: readonly Era[]): string {
  return `eras:${hash32(canonicalJson(eras), 0x45524153).toString(16).padStart(8, "0")}`;
}
