/**
 * Opting a world into a Seshat definition (docs/SESHAT-v0.md §13.3, §13.11
 * "Day 0", ruled 2026-10-19). Pure: the settings dialog shows what this
 * returns and stores its text through `Calendars.optIn`.
 *
 * - The definition starts from the world's own internal calendar (the same
 *   days, seasons and moons: definitionFromLegacy), a preset (every P1
 *   calendar with a year), or pasted text.
 * - A preset or pasted text can bring the world's seasons and moons along, so
 *   season tags and moon predicates keep working.
 * - Opting in changes what every stored day number means (today, pins,
 *   overrides). The dialog shows today's date in the new calendar and offers
 *   to anchor instead: the definition is translated by k days so that today
 *   reads as the date asked for. Its own bodies move with it; the world's
 *   moons do not (ruled 2026-10-19), so today's moon stays today's moon.
 */
import { BAHAI, COPTIC, ETHIOPIAN, FRENCH_REPUBLICAN, FRENCH_REPUBLICAN_EQUINOX, GREGORIAN, HARPTOS, HEBREW, ISLAMIC_CIVIL, ISLAMIC_TBLA, print, ROMAN, translate, type BodyAst, type CalendarAst } from "../seshat";
import type { InternalCalendarConfig } from "./settings";
import { definitionFromLegacy, moonBodies, prepareDefinition, SeshatCalendar } from "./time/seshat";

/** The calendars a world can start from: every P1 calendar with a year (the Maya count and the pawukon have none). */
export const WORLD_PRESETS: ReadonlyArray<{ readonly id: string; readonly ast: CalendarAst }> = [
  { id: "gregorian", ast: GREGORIAN },
  { id: "islamic-civil", ast: ISLAMIC_CIVIL },
  { id: "islamic-tbla", ast: ISLAMIC_TBLA },
  { id: "hebrew", ast: HEBREW },
  { id: "coptic", ast: COPTIC },
  { id: "ethiopian", ast: ETHIOPIAN },
  { id: "french-republican", ast: FRENCH_REPUBLICAN },
  { id: "french-republican-equinox", ast: FRENCH_REPUBLICAN_EQUINOX },
  { id: "bahai", ast: BAHAI },
  { id: "roman", ast: ROMAN },
  { id: "harptos", ast: HARPTOS },
];

export type OptInSource = { kind: "internal" } | { kind: "preset"; id: string } | { kind: "text"; text: string };

export interface OptInChoice {
  source: OptInSource;
  /** bring the world's seasons and moons into a preset or pasted definition (ignored for "internal", which has them) */
  carry: boolean;
  /** anchor today to this date, written in the new calendar; absent: keep day numbers */
  anchor?: string;
}

export interface OptInPlan {
  /** the canonical text to store */
  text: string;
  /** how today reads in the new calendar */
  today: string;
  /** the translation applied (0 when day numbers are kept) */
  shift: number;
  /** moons whose stored decimals the exact rationals only approximate (the internal calendar already ran them so) */
  lossy: string[];
  /**
   * season and moon names the definition stores in another Unicode form (NFC):
   * a zone that wrote the old form no longer matches them (the Studio flags
   * such zone literals afterwards)
   */
  renamed: string[];
}

/** How `day` reads in a stored definition, as the adapter writes it; null when it cannot. */
export function todayText(text: string, day: number): string | null {
  try {
    const a = new SeshatCalendar(text, () => day);
    return a.fault ? null : a.format(day);
  } catch {
    return null;
  }
}

const errorOf = (r: { error: string; line?: number }) => (r.line === undefined ? r.error : `Line ${r.line}: ${r.error}`);

/**
 * Move a definition so that `today` reads as the date `at` (written as the
 * calendar writes dates, or a bare day number): parse `at` against the
 * definition, then translate it by the difference. Used by Change calendar…
 * and by today is on the Orrery's year.
 */
export function anchorToday(ast: CalendarAst, today: number, at: string): { ast: CalendarAst; shift: number } | { error: string } {
  const date = at.trim();
  if (date === "") return { error: "Write the date today should read, or keep day numbers." };
  const base = print(ast);
  const day = /^-?\d+$/.test(date) ? Number(date) : new SeshatCalendar(base, () => today).parse(date);
  if (day === null) {
    const now = todayText(base, today);
    return { error: `"${date}" is not a date in this calendar.${now === null ? "" : ` Write it as today reads (${now}).`}` };
  }
  const shift = today - day;
  return { ast: translate(ast, shift), shift };
}

/**
 * The definition a choice makes, or why it cannot run. Never throws.
 *
 * The source is translated first (its own bodies move with its dates); the
 * world's seasons and moons are added after, so they stay where the world has
 * them: today's moon is still today's moon.
 * @param cfg the world's internal calendar settings
 * @param today the world's current day number
 */
export function buildOptIn(choice: OptInChoice, cfg: InternalCalendarConfig, today: number): OptInPlan | { error: string } {
  try {
    return build(choice, cfg, today);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function build(choice: OptInChoice, cfg: InternalCalendarConfig, today: number): OptInPlan | { error: string } {
  const src = choice.source;
  // the source, and what of it stays put when anchoring: the world's own moons
  let ast: CalendarAst;
  let worldBodies: BodyAst[] = [];
  let lossy: string[] = [];
  const carried = src.kind === "internal" || choice.carry;
  if (src.kind === "internal") {
    const r = definitionFromLegacy(cfg);
    if ("refused" in r) return { error: `This world's calendar cannot become a definition: ${r.refused}.` };
    const { bodies, ...rest } = r.ast;
    ast = rest;
    worldBodies = bodies ? [...bodies] : [];
    lossy = r.lossy;
  } else if (src.kind === "preset") {
    const p = WORLD_PRESETS.find((x) => x.id === src.id);
    if (!p) return { error: `There is no calendar "${src.id}".` };
    ast = p.ast;
  } else {
    const r = prepareDefinition(src.text);
    if ("error" in r) return { error: errorOf(r) };
    ast = r.ast;
  }

  let shift = 0;
  if (choice.anchor !== undefined) {
    const a = anchorToday(ast, today, choice.anchor);
    if ("error" in a) return a;
    ({ ast, shift } = a);
  }

  if (src.kind !== "internal" && choice.carry) {
    const m = moonBodies(cfg.moons, new Set((ast.bodies ?? []).map((b) => b.id)));
    if ("refused" in m) return { error: m.refused };
    const names = new Set((ast.bodies ?? []).flatMap((b) => (b.moon ? [b.moon.name] : [])));
    const clash = cfg.moons.find((x) => names.has(x.name));
    if (clash) return { error: `The calendar already has a moon named "${clash.name}".` };
    const bad = cfg.seasons.find((x) => !(x.from >= 0 && x.from < 1));
    if (bad) return { error: `The season "${bad.name}" starts at ${bad.from}; a definition needs every start from 0 up to (not including) 1 (Settings → Calendar → Seasons).` };
    ast = { ...ast, seasons: { unit: "year", marks: cfg.seasons.map((x) => ({ name: x.name, from: x.from })) } };
    worldBodies = m.bodies;
    lossy = m.lossy;
  }
  const bodies = [...(ast.bodies ?? []), ...worldBodies];
  const { bodies: _b, ...rest } = ast;
  ast = { ...rest, ...(bodies.length ? { bodies } : {}) };

  const prepared = prepareDefinition(print(ast));
  if ("error" in prepared) return { error: errorOf(prepared) };
  const reads = todayText(prepared.text, today);
  if (reads === null) return { error: `Today (day ${today}) is not a day this calendar can read: it is off the calendar's day line.` };
  const renamed = carried ? [...cfg.seasons.map((x) => x.name), ...cfg.moons.map((x) => x.name)].filter((n) => n !== n.normalize("NFC")) : [];
  return { text: prepared.text, today: reads, shift, lossy, renamed };
}
