/**
 * The Studio on a world that runs a stored Seshat definition (docs/SESHAT-v0.md
 * §13.8, §13.11 B3, M4, §15.3). Pure: no Obsidian imports.
 *
 * The draft keeps `{ seasons, moons }` as every window reads them, plus the
 * form model's other fields (`form`: name, year, months, week, where they are
 * fields on the stored definition). It is seeded from the definition, and
 * Save compiles it into a fresh parse of the stored text through the form
 * model (one merge: plugin/time/form.ts `compile`):
 *
 * - only the parts the draft edited are written; every other part of the
 *   stored definition passes through as it is now;
 * - a moon is its body: matched by the body id the draft carries, so a
 *   rename keeps the body and its id, and the draft's order is the order
 *   written (wadjet-dea); a draft without ids (a stash from before) matches
 *   by name;
 * - a moon keeps its body's exact period unless its `cycleDays` changed, and
 *   its exact epoch unless its `phaseAtEpoch` changed (compared as numbers), so
 *   a seasons-only or phases-only edit leaves the bodies, and the hash, alone;
 * - stale per part (§15.9 S5): Save is refused only when a part the draft
 *   edited is no longer what the draft was seeded from (an edit in settings to
 *   the same part); edits to other parts outside the studio pass through;
 * - a draft whose calendar was not edited writes nothing, so saving a zone
 *   never re-prints the definition;
 * - `rewrites` says the stored text was not canonical (a hand edit with
 *   comments), so the Studio asks before the save removes them.
 */
import { canonicalJson } from "../../core/profile";
import { Body, bodyFor, parse, print, toNumber, type BodyAst, type CalendarAst } from "../../seshat";
import { prepareDefinition } from "../../plugin/time/seshat";
import { compile, FormError, recognise, type FormEdits, type MoonForm } from "../../plugin/time/form";
import type { CalendarSource, DraftMoon, FormDraft, WorldDraft } from "./state";

export type CalendarDraft = WorldDraft["calendar"];

const FORM_PARTS = ["name", "year", "months", "week", "ledger"] as const;

/** The draft calendar a definition opens as: its season marks as stored, its moons in declaration order with their body ids, and the parts the form reads as fields. */
export function calendarOfDefinition(ast: CalendarAst): CalendarDraft {
  const f = recognise(ast);
  const form: FormDraft = {};
  for (const k of FORM_PARTS) {
    const p = f[k];
    if (p.kind === "form") (form as Record<string, unknown>)[k] = p.value;
  }
  return {
    seasons: (ast.seasons?.marks ?? []).map((m) => ({ name: m.name, from: m.from })),
    moons: (ast.bodies ?? []).flatMap((b) =>
      b.moon ? [{ id: b.id, name: b.moon.name, cycleDays: toNumber(b.period), phaseAtEpoch: toNumber(b.epoch), ...(b.moon.phases ? { phases: b.moon.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) }] : [],
    ),
    form,
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

type Part = "seasons" | "moons" | (typeof FORM_PARTS)[number];

/** The parts the draft edited: seasons and moons when they differ from the base; a form part only when the draft holds a value for it that differs. */
function editedParts(base: CalendarDraft, draft: CalendarDraft): Part[] {
  const out: Part[] = [];
  if (!same(draft.seasons, base.seasons)) out.push("seasons");
  if (!same(draft.moons, base.moons)) out.push("moons");
  for (const k of FORM_PARTS) if (draft.form?.[k] !== undefined && !same(draft.form[k], base.form?.[k])) out.push(k);
  return out;
}

const partOf = (c: CalendarDraft, k: Part): unknown => (k === "seasons" || k === "moons" ? c[k] : c.form?.[k]);

/** Whether part `k` of the stored calendar is still what the draft was seeded from. A base without moon ids (a stash from an older build) compares moons without them. */
function unchanged(now: CalendarDraft, base: CalendarDraft, k: Part): boolean {
  if (k === "moons" && base.moons.some((m) => m.id === undefined)) return same(now.moons.map(({ id: _id, ...m }) => m), base.moons.map(({ id: _id, ...m }) => m));
  return same(partOf(now, k), partOf(base, k));
}

/**
 * The draft's moons as form moons over the stored bodies: each keeps its body
 * (matched by id, else by name) and that body's exact numbers unless the draft
 * changed them; a moon without a body gets a fresh `moon-N` id.
 */
function moonsOf(ast: CalendarAst, base: readonly DraftMoon[], draft: readonly DraftMoon[]): MoonForm[] | string {
  // predicates match moons by name: two with one name would be one moon to every rule
  const seen = new Set<string>();
  for (const m of draft) {
    if (seen.has(m.name)) return `moon "${m.name}" is declared more than once`;
    seen.add(m.name);
  }
  const bodies = (ast.bodies ?? []).filter((b) => b.moon);
  // two passes, so a moon without an id can never take the body another moon names by id: first every
  // id claims its own body; then a moon without one (a stash from an older build) takes, by name, an
  // unclaimed body whose moon the base had under that name (a name the base lacks is a new moon)
  const owner = new Map<DraftMoon, BodyAst>();
  const claimed = new Set<string>();
  for (const d of draft) {
    if (d.id === undefined || claimed.has(d.id)) continue;
    const b = bodies.find((x) => x.id === d.id);
    if (!b) continue;
    owner.set(d, b);
    claimed.add(b.id);
  }
  for (const d of draft) {
    if (d.id !== undefined || !base.some((m) => m.id === undefined && m.name === d.name)) continue;
    const b = bodies.find((x) => x.moon!.name === d.name && !claimed.has(x.id));
    if (!b) continue;
    owner.set(d, b);
    claimed.add(b.id);
  }
  const baseOf = (d: DraftMoon): DraftMoon | undefined => (d.id !== undefined ? base.find((x) => x.id === d.id) : base.find((x) => x.name === d.name));
  const bodyIds = new Set((ast.bodies ?? []).map((b) => b.id));
  // ids in use: every body's, every id the draft names (so a fresh moon-N never takes one), and those given out
  const taken = new Set([...bodyIds, ...draft.flatMap((d) => (d.id === undefined ? [] : [d.id]))]);
  const given = new Set<string>();
  const out: MoonForm[] = [];
  for (const d of draft) {
    const phases = d.phases ? { phases: d.phases.map((p) => ({ name: p.name, at: p.at })) } : {};
    const b = owner.get(d);
    const was = b ? baseOf(d) : undefined;
    const keepPeriod = was !== undefined && was.cycleDays === d.cycleDays;
    const keepEpoch = was !== undefined && was.phaseAtEpoch === d.phaseAtEpoch;
    if (b && keepPeriod && keepEpoch) {
      out.push({ id: b.id, name: d.name, period: b.period, epoch: b.epoch, ...phases });
      continue;
    }
    const r = bodyFor(d.cycleDays, d.phaseAtEpoch);
    if (!r) return `moon "${d.name}": a cycle of ${d.cycleDays} days cannot run`;
    // a body keeps its id; a draft id with no body (and not another body's) is kept as written; otherwise a fresh moon-N
    let id = b?.id ?? (d.id !== undefined && !bodyIds.has(d.id) && !given.has(d.id) ? d.id : undefined);
    if (id === undefined) {
      let n = 1;
      while (taken.has(`moon-${n}`)) n++;
      id = `moon-${n}`;
      taken.add(id);
    }
    given.add(id);
    // a kept rational beside a fresh one can be too fine for safe-integer phases; bodyFor's own pair always runs
    const mixed = b ? { period: keepPeriod ? b.period : r.period, epoch: keepEpoch ? b.epoch : r.epoch } : r;
    const exact = runs(mixed) ? mixed : { period: r.period, epoch: r.epoch };
    out.push({ id, name: d.name, period: exact.period, epoch: exact.epoch, ...phases });
  }
  return out;
}

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
  const parts = editedParts(base, draft);
  if (parts.some((k) => !unchanged(now, base, k))) return { kind: "stale", stored: now };

  const edits: { -readonly [K in keyof FormEdits]: FormEdits[K] } = {};
  for (const k of parts) {
    if (k === "seasons") edits.seasons = draft.seasons.map((s) => ({ name: s.name, from: s.from }));
    else if (k === "moons") {
      const m = moonsOf(ast, base.moons, draft.moons);
      if (typeof m === "string") return { kind: "error", message: m };
      edits.moons = m;
    } else (edits as Record<string, unknown>)[k] = draft.form![k];
  }
  let next: CalendarAst;
  let text: string;
  try {
    next = compile(ast, edits);
    text = print(next);
  } catch (e) {
    if (e instanceof FormError || e instanceof Error) return { kind: "error", message: e.message };
    return { kind: "error", message: String(e) };
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
      return { kind: "refuse", message: "the calendar definition changed outside the studio while you edited the same part of it. The studio now shows the stored calendar; undo brings your edits back, and Save then applies them over it.", reseed: m.stored };
    case "write":
      return m.text === stored ? { kind: "none" } : { kind: "definition", text: m.text, rewrites: m.rewrites };
  }
}
