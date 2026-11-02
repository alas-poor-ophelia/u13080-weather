/**
 * What the settings tab's Calendar group says and offers (bead wadjet-44d,
 * from the Guildmaster's live check 2026-10-21: the group showed adapter ids,
 * `internal` and `seshat`, and hid the definition dialog unless the internal
 * calendar was active, so it never said what the world runs on). Pure, so
 * the wording and the choices are unit-tested without the Obsidian API;
 * settings-tab.ts renders what this returns.
 *
 * One row names the calendar the world runs on, in words, with today's date
 * in it, and offers the actions that make sense from there:
 *  - `change`: the calendar dialog (a preset, the stored definition, pasted
 *    text; on a world that came from the legacy calendar, that calendar as a
 *    definition, and the way back to it);
 *  - `edit`: the definition's text, on a world that runs one (a faulted one
 *    included, so it can be repaired);
 *  - `undo`: the last calendar change undone (bead wadjet-24p), when there is
 *    one that can run.
 * The legacy calendar (the old internal calendar) is named and offered only
 * on worlds that came from it (§15.1 R3, ruled 2026-10-21). A calendar plugin
 * is chosen in a second row, by name, shown only when one is installed.
 *
 * A definition is described by its own structure (definitionSummary), not
 * by a fixed sentence: "years of 365 or 366 days · 12 months · 7-day weeks".
 */
import { baseKind, Engine, type CalendarAst, type SlotsUnitAst } from "../seshat";
import { followOf } from "./time/form";

export type CalendarAction = "change" | "edit" | "undo" | "redo";

export interface CalendarRowInput {
  /** the resolved active adapter's id ("internal", "seshat", a plugin's) */
  activeId: string;
  /** the internal calendar's settings (shown when it is active) */
  internal: { yearLength: number; epochYear: number };
  /** the running definition's name, when the world runs one; null otherwise */
  definition: string | null;
  /** the running definition's structure (definitionSummary), when the world runs one */
  structure?: string | null;
  /** why the stored definition cannot run, when the world runs it; null otherwise */
  fault: string | null;
  /** the stored definition's name, when one is stored (whether or not the world runs it) */
  stored: string | null;
  /** today as the active calendar writes it */
  today: string;
  /** installed calendar plugins (not the internal calendar, not the definition) */
  plugins: ReadonlyArray<{ id: string; label: string }>;
  /** the world came from the legacy calendar (its origin is not "definition") */
  legacyOrigin: boolean;
  /** the last calendar change can be undone */
  canUndo: boolean;
  /** a change that was undone can be put back */
  canRedo: boolean;
}

export interface CalendarRow {
  /** the row's title: what the world runs on */
  name: string;
  desc: string;
  actions: CalendarAction[];
  /** the calendar-plugin chooser (id -> label), or null when no calendar plugin is installed */
  choices: Record<string, string> | null;
}

const lengthOf = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));

export function calendarRow(i: CalendarRowInput): CalendarRow {
  const choices = i.plugins.length === 0 ? null : chooser(i);
  const undo: CalendarAction[] = [...(i.canUndo ? (["undo"] as const) : []), ...(i.canRedo ? (["redo"] as const) : [])];
  if (i.activeId === "seshat") {
    if (i.fault !== null) {
      return {
        name: `${i.stored ?? "Calendar definition"} (cannot run)`,
        desc: `The world's calendar definition cannot run: ${i.fault}. No weather is made until it is fixed; the stored text is kept exactly as it is. Edit it to repair it, or choose another calendar with Change calendar….`,
        actions: ["edit", "change", ...undo],
        choices,
      };
    }
    return {
      name: `${i.definition ?? i.stored ?? "Calendar definition"} (calendar definition)`,
      desc: `${i.structure ? `${capitalise(i.structure)}. ` : ""}Today is ${i.today}.`,
      actions: ["edit", "change", ...undo],
      choices,
    };
  }
  if (i.activeId !== "internal") {
    const label = i.plugins.find((p) => p.id === i.activeId)?.label ?? i.activeId;
    return {
      name: `${label} (calendar plugin)`,
      desc: `This world takes its calendar from the ${label} plugin; edit it there. Today is ${i.today}.`,
      actions: ["change", ...undo],
      choices,
    };
  }
  const kept = i.stored !== null ? ` A calendar definition (${i.stored}) is also stored; Change calendar… can switch back to it.` : "";
  return {
    name: "Legacy calendar",
    desc: `This world runs on the legacy calendar, the one Wadjet had before calendar definitions: years of ${lengthOf(i.internal.yearLength)} days from year ${i.internal.epochYear}, with the seasons and moons below. Today is ${i.today}.${kept}`,
    actions: ["change", ...undo],
    choices,
  };
}

/** The calendar-plugin chooser, by name: the legacy calendar (worlds that came from it), the stored definition (if any), every installed plugin. */
function chooser(i: CalendarRowInput): Record<string, string> {
  const out: Record<string, string> = i.legacyOrigin || i.activeId === "internal" ? { internal: "Legacy calendar" } : {};
  if (i.stored !== null) out.seshat = `${i.stored} (calendar definition)`;
  for (const p of i.plugins) out[p.id] = `${p.label} (calendar plugin)`;
  return out;
}

const capitalise = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);
const plural = (id: string, n: number) => (n === 1 ? id : id.endsWith("s") ? id : id.endsWith("y") && !/[aeiou]y$/.test(id) ? `${id.slice(0, -1)}ies` : `${id}s`);
/** "365", "365 or 366", "353 to 385": the distinct values of a sample, as a range when there are more than two. */
function spread(values: Iterable<number>): string {
  const v = [...new Set(values)].sort((a, b) => a - b);
  if (v.length === 0) return "";
  if (v.length === 1) return String(v[0]);
  if (v.length === 2) return `${v[0]} or ${v[1]}`;
  return `${v[0]} to ${v.at(-1)}`;
}

/** Years sampled either side of the current year: 401 covers the Gregorian 400-year rule and a 19-year lunisolar cycle many times over. */
const SAMPLE_YEARS = 200;
const summaries = new WeakMap<CalendarAst, Map<number, string>>();

/**
 * A definition's structure in one line, read off the definition itself
 * (bead wadjet-44d): its year lengths, the units inside the year and inside
 * those, its other repeating units, days outside every unit, seasons, moons
 * and named days. Each part is read independently: a part the engine cannot
 * answer is left out rather than failing the whole line.
 *
 * Years are sampled around `aroundDay` (the world's current day), not day 0:
 * a calendar's years can differ by era (the Roman preset's Republican years
 * run 355 to 378 days, its Julian ones 365 or 366), and the world is wherever
 * today is.
 */
export function definitionSummary(ast: CalendarAst, aroundDay = 0): string {
  let byDay = summaries.get(ast);
  if (!byDay) summaries.set(ast, (byDay = new Map<number, string>()));
  const cached = byDay.get(aroundDay);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  let engine: Engine | null = null;
  try {
    engine = new Engine(ast);
  } catch {
    engine = null;
  }
  const e = engine;
  const tryPart = (f: () => string | null) => {
    try {
      const t = f();
      if (t) parts.push(t);
    } catch {
      // a part the engine cannot answer is left out
    }
  };
  const y0 = e?.occurrenceAt("year", aroundDay)?.index ?? 0;
  const years = Array.from({ length: 2 * SAMPLE_YEARS + 1 }, (_, k) => y0 - SAMPLE_YEARS + k);
  if (e) tryPart(() => `years of ${spread(years.map((i) => e.length("year", i)))} days`);
  // a year that follows a body says which (§16): "years follow Moon"
  const year = ast.units.find((u) => u.id === "year");
  const yf = year?.kind === "cycle" ? followOf(ast, year) : null;
  if (yf) parts.push(`years follow ${yf.body}`);
  // units whose parent is the year: how many there are in a year (slots of length 0 do not count), and days in none
  const slotUnits = ast.units.filter((u): u is SlotsUnitAst => u.kind === "slots");
  for (const u of slotUnits.filter((x) => x.in === "year")) {
    if (!e) break;
    tryPart(() => {
      const counts: number[] = [];
      const outside: number[] = [];
      for (const i of years) {
        const lens = e.slotLengths(u.id, [i]);
        counts.push(lens.filter((l, k) => l > 0 && !u.slots[k]?.filler).length);
        outside.push(lens.reduce((sum, l, k) => (u.slots[k]?.filler ? sum + l : sum), 0));
      }
      const n = spread(counts);
      const extra = outside.some((x) => x > 0) ? ` + ${spread(outside)} ${Math.max(...outside) === 1 ? "day" : "days"} outside them` : "";
      return `${n} ${plural(u.id, Math.max(...counts))}${extra}`;
    });
  }
  // units inside those: how many per parent, over the first sampled year
  for (const u of slotUnits.filter((x) => x.in !== "year")) {
    if (!e) break;
    tryPart(() => {
      const parent = slotUnits.find((x) => x.id === u.in);
      if (!parent || parent.in !== "year") return null;
      const counts: number[] = [];
      const parentLens = e.slotLengths(parent.id, [y0]);
      parentLens.forEach((l, m) => {
        if (l > 0 && !parent.slots[m]?.filler) counts.push(e.slotLengths(u.id, [y0, m]).filter((x, k) => x > 0 && !u.slots[k]?.filler).length);
      });
      return `${spread(counts)} ${plural(u.id, Math.max(...counts))} per ${parent.id}`;
    });
  }
  // other repeating units: a constant cycle is "N-day weeks"; a one-day cycle of names is "N weekday names"
  for (const u of ast.units) {
    if (u.kind !== "cycle" || u.id === "year") continue;
    tryPart(() => {
      const f = followOf(ast, u);
      if (f) return `${plural(u.id, 2)} follow ${f.body}`;
      if (baseKind(u) !== "constant") return plural(u.id, 2);
      const len = (u as { length: number }).length;
      if (len === 1 && u.labels?.length) return `${u.labels.length} ${u.id} names`;
      return `${len}-day ${plural(u.id, 2)}`;
    });
  }
  const seasons = ast.seasons?.marks.length ?? 0;
  if (seasons) parts.push(`${seasons} ${seasons === 1 ? "season" : "seasons"}`);
  const moons = (ast.bodies ?? []).filter((b) => b.moon).length;
  if (moons) parts.push(`${moons} ${moons === 1 ? "moon" : "moons"}`);
  const rules = (ast.rules ?? []).filter((r) => r.tags?.length).length;
  if (rules) parts.push(`${rules} named ${rules === 1 ? "rule" : "rules"}`);
  const days = ast.days?.length ?? 0;
  if (days) parts.push(`${days} named ${days === 1 ? "day" : "days"}`);
  const out = parts.join(" · ");
  if (byDay.size > 64) byDay.clear(); // the current day moves; keep the memo small
  byDay.set(aroundDay, out);
  return out;
}
