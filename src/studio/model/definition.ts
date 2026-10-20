/**
 * The Studio on a world that runs a stored Seshat definition (docs/SESHAT-v0.md
 * §13.8, §13.11 B3, M4). Pure: no Obsidian imports.
 *
 * The draft keeps its `{ seasons, moons }` shape, so every window works as it
 * does on the internal calendar. It is seeded from the definition, and Save
 * merges it back into a fresh parse of the stored text:
 *
 * - a moon keeps its body's exact period unless its `cycleDays` changed, and
 *   its exact epoch unless its `phaseAtEpoch` changed (compared as numbers), so a seasons-only
 *   or phases-only edit leaves the bodies, and the hash, alone;
 * - the merge is refused as stale when the stored calendar's seasons or moons
 *   are no longer the ones the draft was seeded from (an edit in settings, or
 *   a switch, while the Studio held unsaved calendar work): the Studio
 *   reseeds instead of overwriting that edit;
 * - a draft whose calendar was not edited writes nothing, so saving a zone
 *   never re-prints the definition;
 * - `rewrites` says the stored text was not canonical (a hand edit with
 *   comments), so the Studio asks before the save removes them.
 */
import { canonicalJson } from "../../core/profile";
import { Body, bodyFor, parse, print, toNumber, type BodyAst, type CalendarAst } from "../../seshat";
import { prepareDefinition } from "../../plugin/time/seshat";
import type { CalendarSource, WorldDraft } from "./state";

export type CalendarDraft = WorldDraft["calendar"];

/** The draft calendar a definition opens as: its season marks as stored, its moons in declaration order. */
export function calendarOfDefinition(ast: CalendarAst): CalendarDraft {
  return {
    seasons: (ast.seasons?.marks ?? []).map((m) => ({ name: m.name, from: m.from })),
    moons: (ast.bodies ?? []).flatMap((b) =>
      b.moon ? [{ name: b.moon.name, cycleDays: toNumber(b.period), phaseAtEpoch: toNumber(b.epoch), ...(b.moon.phases ? { phases: b.moon.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) }] : [],
    ),
  };
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Whether a period and epoch make a body with safe-integer phases. */
function runs(p: { period: BodyAst["period"]; epoch: BodyAst["epoch"] }): boolean {
  try {
    new Body(p.period, p.epoch);
    return true;
  } catch {
    return false;
  }
}

export type MergeResult =
  | { kind: "unchanged" }
  | { kind: "stale"; stored: CalendarDraft }
  | { kind: "error"; message: string }
  | { kind: "write"; text: string; rewrites: boolean };

/**
 * Merge the draft's calendar into the stored definition.
 * @param stored the stored definition text
 * @param base the calendar the draft was seeded from (or last saved as)
 * @param draft the draft calendar
 */
export function mergeCalendar(stored: string, base: CalendarDraft, draft: CalendarDraft): MergeResult {
  if (same(draft, base)) return { kind: "unchanged" };
  let ast: CalendarAst;
  try {
    ast = parse(stored);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const now = calendarOfDefinition(ast);
  if (!same(now, base)) return { kind: "stale", stored: now };

  const seasons = draft.seasons.length || ast.seasons ? { seasons: { unit: ast.seasons?.unit ?? "year", marks: draft.seasons.map((s) => ({ name: s.name, from: s.from })) } } : {};
  // moons are matched by name (predicates match them by name too): two with one name would collapse into one
  const seen = new Set<string>();
  for (const m of draft.moons) {
    if (seen.has(m.name)) return { kind: "error", message: `moon "${m.name}" is declared more than once` };
    seen.add(m.name);
  }
  const baseMoons = new Map(base.moons.map((m) => [m.name, m]));
  const draftMoons = new Map(draft.moons.map((m) => [m.name, m]));
  const bodies: BodyAst[] = [];
  const placed = new Set<string>();
  const moonOf = (d: CalendarDraft["moons"][number]) => ({ name: d.name, ...(d.phases ? { phases: d.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) });
  const exact = (d: CalendarDraft["moons"][number]): { period: BodyAst["period"]; epoch: BodyAst["epoch"] } | string => {
    const b = bodyFor(d.cycleDays, d.phaseAtEpoch);
    return b ? { period: b.period, epoch: b.epoch } : `moon "${d.name}": a cycle of ${d.cycleDays} days cannot run`;
  };
  for (const b of ast.bodies ?? []) {
    if (!b.moon) {
      bodies.push(b);
      continue;
    }
    const d = draftMoons.get(b.moon.name);
    if (!d) continue; // the moon was removed
    placed.add(d.name);
    // each number keeps its exact rational unless that number itself changed
    const was = baseMoons.get(d.name);
    const keepPeriod = was !== undefined && was.cycleDays === d.cycleDays;
    const keepEpoch = was !== undefined && was.phaseAtEpoch === d.phaseAtEpoch;
    if (keepPeriod && keepEpoch) {
      bodies.push({ ...b, moon: moonOf(d) });
      continue;
    }
    const r = exact(d);
    if (typeof r === "string") return { kind: "error", message: r };
    // a kept rational beside a fresh one can be too fine for safe-integer phases; bodyFor's own pair always runs
    const mixed = { period: keepPeriod ? b.period : r.period, epoch: keepEpoch ? b.epoch : r.epoch };
    bodies.push({ ...b, ...(runs(mixed) ? mixed : r), moon: moonOf(d) });
  }
  const ids = new Set(bodies.map((b) => b.id));
  for (const d of draft.moons) {
    if (placed.has(d.name)) continue;
    const r = exact(d);
    if (typeof r === "string") return { kind: "error", message: r };
    let n = 1;
    while (ids.has(`moon-${n}`)) n++;
    ids.add(`moon-${n}`);
    bodies.push({ id: `moon-${n}`, ...r, moon: moonOf(d) });
  }
  const { seasons: _s, bodies: _b, ...rest } = ast;
  const next: CalendarAst = { ...rest, ...seasons, ...(bodies.length ? { bodies } : {}) };
  let text: string;
  try {
    text = print(next);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  const prepared = prepareDefinition(text);
  if ("error" in prepared) return { kind: "error", message: prepared.line === undefined ? prepared.error : `line ${prepared.line}: ${prepared.error}` };
  return { kind: "write", text: prepared.text, rewrites: stored !== print(ast) };
}

export type CalendarPlan =
  /** write nothing to the calendar; `reseed` is the calendar the draft takes afterwards */
  | { kind: "none"; reseed?: CalendarDraft }
  /** write the draft into the internal calendar's fields */
  | { kind: "legacy" }
  /** store this definition text (`rewrites`: ask first, the stored text was hand-edited) */
  | { kind: "definition"; text: string; rewrites: boolean }
  /** save nothing; say why, and show `reseed` (the calendar as stored) when there is one */
  | { kind: "refuse"; message: string; reseed?: CalendarDraft };

/**
 * What a Studio Save does with the world draft's calendar.
 * @param current the calendar the world runs now and its source (`plugin.studioSettings()`)
 * @param stored the stored definition (read when `current.source` is "seshat")
 * @param draft the draft calendar, the calendar it was seeded from (`base`), and that calendar's source
 */
export function planCalendarSave(current: { source: CalendarSource; calendar: CalendarDraft }, stored: unknown, draft: { calendar: CalendarDraft; base: CalendarDraft; source: CalendarSource }): CalendarPlan {
  const touched = !same(draft.calendar, draft.base);
  if (draft.source !== current.source) {
    if (!touched) return { kind: "none", reseed: current.calendar };
    return { kind: "refuse", message: "the world switched calendars since you edited its seasons or moons, so they were not saved. The studio now shows the calendar the world runs; undo brings your edits back.", reseed: current.calendar };
  }
  if (!touched) return { kind: "none" };
  if (current.source === "fault") return { kind: "refuse", message: "the calendar definition cannot run, so its seasons and moons cannot be saved. Fix it in settings." };
  if (current.source === "legacy") return { kind: "legacy" };
  const m = mergeCalendar(typeof stored === "string" ? stored : "", draft.base, draft.calendar);
  switch (m.kind) {
    case "unchanged":
      return { kind: "none" };
    case "error":
      return { kind: "refuse", message: `the calendar edits do not make a calendar that runs (${m.message}).` };
    case "stale":
      return { kind: "refuse", message: "the calendar definition changed outside the studio while you edited it. The studio now shows the stored seasons and moons; undo brings your edits back, and Save then applies them over it.", reseed: m.stored };
    case "write":
      return m.text === stored ? { kind: "none" } : { kind: "definition", text: m.text, rewrites: m.rewrites };
  }
}
