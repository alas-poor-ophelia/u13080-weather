/**
 * A world calendar from a stored Seshat definition (docs/SESHAT-v0.md §13).
 * It sits beside the untouched InternalCalendar: a world opts in by storing
 * a definition and making this adapter (id "seshat") active.
 *
 * - The stored form is canonical Seshat text. A text that does not parse,
 *   validate or pass the world-calendar checks puts the adapter in a fault
 *   state: it stays registered (so its id stays in every event and the Studio
 *   takes its read-only path), describes itself read-only, hashes the raw
 *   text, and never re-prints or saves it (§13.11 B2).
 * - toContext is total (§13.11 B4): a named rule that throws loses its own
 *   tags for that day (the other rules keep theirs) and is reported once.
 *   Beyond Seshat's day line (±DAY_LIMIT, which the generator's warm-up and
 *   spell windows cross near the ends of the world's day range) it
 *   extrapolates as the adapter contract asks: years of the edge year's
 *   length, counted on from the edge year's start, so the year number only
 *   grows and the day of the year runs on by one; moons at the real day; the
 *   day's unit and rule tags from the same day of the edge year. For a
 *   calendar of constant years (every legacy config) that is exact.
 * - The hash covers definitionContent (§13.6): what reaches a day, a tag, a
 *   year number, a moon or a match.
 */
import { hash32 } from "../../core/rng";
import { canonicalJson } from "../../core/profile";
import { bodyFor, DAY_LIMIT, isPlainConstant, definitionContent, Engine, formatDay, parse, parseDay, print, seasonIn, SESHAT_VERSION, SeshatSyntaxError, toNumber, validate, problems, type BodyAst, type CalendarAst, type Problem } from "../../seshat";
import type { InternalCalendarConfig } from "../settings";
import { ADAPTER_FAULT, type CalendarDescription, type FaultReporting, type TimeAdapter, type TimeContext } from "./adapter";
import { assertDayInRange, assertInteger } from "../world";

/** Joins SESHAT_VERSION in the hash: bump when this adapter changes how a day's context is assembled. */
export const SESHAT_ADAPTER_VERSION = "seshat-adapter/1";
/** Named rules a world calendar may carry (each is evaluated for every day the generator reads). */
export const WORLD_RULES_MAX = 64;
/** BYSETPOS scans a whole period per day: a world calendar keeps it to constant periods this short. */
const WORLD_SETPOS_PERIOD_MAX = 400;

/** Why a world cannot run a definition, beyond Seshat's own validation (§13.3, §13.11 B4). */
export function checkWorldCalendar(ast: CalendarAst): string[] {
  return worldProblems(ast).map((p) => p.message);
}

/** `checkWorldCalendar` with each problem's location (§15.9 S1). */
export function worldProblems(ast: CalendarAst): Problem[] {
  const errors: Problem[] = [];
  const year = ast.units.find((u) => u.id === "year");
  if (!year || year.kind !== "cycle") errors.push({ message: 'a world calendar needs a cycle unit with the id "year"', ...(year ? { unit: "year" } : {}) });
  // seasons are phases of the year: yearPhase, describe() and the Studio's seasons window all read them so
  if (ast.seasons && ast.seasons.unit !== "year") errors.push({ message: `a world calendar's seasons run over its year, not "${ast.seasons.unit}"` });
  if ((ast.rules?.length ?? 0) > WORLD_RULES_MAX) errors.push({ message: `a world calendar has at most ${WORLD_RULES_MAX} named rules` });
  const units = new Map(ast.units.map((u) => [u.id, u]));
  const walk = (r: unknown, at: string, rule: string): void => {
    if (typeof r !== "object" || r === null) return;
    const n = r as { kind?: string; of?: unknown; count?: number; setpos?: unknown; freq?: string };
    if (n.kind === "all" || n.kind === "any") for (const q of (n.of as unknown[]) ?? []) walk(q, at, rule);
    if (n.kind === "not") walk(n.of, at, rule);
    if (n.kind !== "recur") return;
    // a COUNT walks every period from its anchor; on a weather path that is a walk per day
    if (n.count !== undefined) errors.push({ message: `${at}: a world calendar's rules cannot use COUNT`, rule });
    if (n.setpos !== undefined) {
      const f = n.freq === "day" ? undefined : units.get(n.freq ?? "");
      const constant = n.freq === "day" || (f?.kind === "cycle" && isPlainConstant(f) && f.length <= WORLD_SETPOS_PERIOD_MAX);
      if (!constant) errors.push({ message: `${at}: a world calendar's BYSETPOS needs a constant period of at most ${WORLD_SETPOS_PERIOD_MAX} days`, rule });
    }
  };
  for (const r of ast.rules ?? []) walk(r.rule, `rule "${r.id}"`, r.id);
  return errors;
}

/**
 * A definition that runs a legacy internal-calendar config day for day, or why
 * it cannot: a fractional year length or epoch year has no whole-day form.
 * Each moon takes the legacy body's own rationals, so its phases are the same
 * floats; `lossy` names a moon whose stored decimals those rationals only
 * approximate (the legacy calendar already ran the approximation; the Studio
 * will show the rational's value).
 */
export function definitionFromLegacy(cfg: InternalCalendarConfig): { ast: CalendarAst; lossy: string[] } | { refused: string } {
  if (!Number.isSafeInteger(cfg.yearLength) || cfg.yearLength < 1) return { refused: `a year of ${cfg.yearLength} days has no whole-day form` };
  if (!Number.isSafeInteger(cfg.epochYear)) return { refused: `epoch year ${cfg.epochYear} is not a whole year` };
  const off = cfg.seasons.find((s) => !(s.from >= 0 && s.from < 1));
  if (off) return { refused: `the season "${off.name}" starts at ${off.from}; a definition needs every start from 0 up to (not including) 1 (Settings → Calendar → Seasons)` };
  const m = moonBodies(cfg.moons, new Set());
  if ("refused" in m) return m;
  const { bodies, lossy } = m;
  return {
    ast: {
      // no formats: the adapter then writes and reads dates as the internal calendar does ("Year 3, day 14 (Summer)", "3-14")
      name: "Internal calendar",
      seasons: { unit: "year", marks: cfg.seasons.map((s) => ({ name: s.name, from: s.from })) },
      ...(bodies.length ? { bodies } : {}),
      gears: [],
      units: [{ id: "year", kind: "cycle", number: cfg.epochYear, anchor: 0, length: cfg.yearLength }],
    },
    lossy,
  };
}

/**
 * The year holding `day`, and the day whose unit and rule tags it carries.
 * Within the day line: the calendar's own year and the day itself. Beyond
 * it: years of the edge year's length counted on from the edge year's start
 * (so the index only grows and the day of the year runs on by one), and the
 * same day of the year in the edge year, or the year next to it on the line
 * when the edge year itself crosses the line.
 */
export function yearAt(e: Engine, day: number): { index: number; start: number; length: number; tagDay: number } {
  if (Math.abs(day) <= DAY_LIMIT) {
    const o = e.occurrenceAt("year", day)!;
    return { index: o.index, start: o.start, length: o.length, tagDay: day };
  }
  const edge = e.occurrenceAt("year", day > 0 ? DAY_LIMIT : -DAY_LIMIT)!;
  const years = Math.floor((day - edge.start) / edge.length);
  const start = edge.start + years * edge.length;
  let tagDay = edge.start + (day - start);
  if (tagDay > DAY_LIMIT) tagDay -= edge.length;
  if (tagDay < -DAY_LIMIT) tagDay += edge.length;
  return { index: edge.index + years, start, length: edge.length, tagDay };
}

/**
 * The first day of the year with occurrence index `index`, on the same model
 * as yearAt: the calendar's own start within the day line; beyond it, the
 * edge year's start plus whole edge-year lengths. yearAt(e, d).start ===
 * yearStartAt(e, yearAt(e, d).index) for every day (tested), so the Studio's
 * year seam and the adapter's toContext never disagree.
 */
export function yearStartAt(e: Engine, index: number): number {
  const hi = e.occurrenceAt("year", DAY_LIMIT)!;
  if (index > hi.index) return hi.start + (index - hi.index) * hi.length;
  const lo = e.occurrenceAt("year", -DAY_LIMIT)!;
  if (index < lo.index) return lo.start + (index - lo.index) * lo.length;
  return e.start("year", index);
}

/**
 * The internal calendar's moons as bodies with the legacy body's own exact
 * rationals (so their phases are the same floats), ids `moon-1`, `moon-2`, …
 * skipping `taken`. `lossy` names a moon whose stored decimals the rationals
 * only approximate.
 */
export function moonBodies(moons: InternalCalendarConfig["moons"], taken: ReadonlySet<string>): { bodies: BodyAst[]; lossy: string[] } | { refused: string } {
  const bodies: BodyAst[] = [];
  const lossy: string[] = [];
  let n = 0;
  for (const m of moons) {
    const b = bodyFor(m.cycleDays, m.phaseAtEpoch);
    if (!b) return { refused: `moon "${m.name}": a cycle of ${m.cycleDays} days cannot run` };
    if (toNumber(b.period) !== m.cycleDays) lossy.push(m.name);
    do n++;
    while (taken.has(`moon-${n}`));
    bodies.push({ id: `moon-${n}`, period: b.period, epoch: b.epoch, moon: { name: m.name, ...(m.phases ? { phases: m.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) } });
  }
  return { bodies, lossy };
}

const hex = (n: number) => n.toString(16).padStart(8, "0");
/** 64 bits from two hash32 seeds: a definition can be long, and the hash keys every cache. */
function hash64(s: string): string {
  return `${hex(hash32(s, 0x53455348))}${hex(hash32(s, 0x41544e31))}`;
}

/**
 * A definition as typed (settings text, an import): names and tags to NFC
 * (§13.8), parsed, validated and held to the world checks, then printed. Only
 * the printed text is ever stored. An error carries the text's line when the
 * parser named one; past the parser, `problems` holds every problem with its
 * location and `error` is the first of them.
 */
export function prepareDefinition(text: string): { text: string; ast: CalendarAst } | { error: string; line?: number; problems: Problem[] } {
  let ast: CalendarAst;
  try {
    ast = parse(text.normalize("NFC"));
  } catch (e) {
    if (!(e instanceof SeshatSyntaxError)) throw e;
    return { error: e.message, line: e.line, problems: [{ message: e.message }] };
  }
  const found = [...problems(ast), ...worldProblems(ast)];
  if (found.length) return { error: found[0]!.message, problems: found };
  return { text: print(ast), ast };
}

export class SeshatCalendar implements TimeAdapter, FaultReporting {
  readonly id = "seshat";
  private engine: Engine | null = null;
  private ast: CalendarAst | null = null;
  private raw: unknown;
  /** why the stored definition cannot run, with its line when the text named one; null when it runs */
  fault: { message: string; line?: number } | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly reported = new Set<string>();

  /**
   * @param stored the stored definition (settings.calendar.definition), canonical text
   * @param current reads the stored current day (shared with the internal calendar)
   * @param write stores a new current day; `setNow` needs it
   */
  constructor(
    stored: unknown,
    private current: () => number,
    private write?: (dayOrdinal: number) => void | Promise<void>,
  ) {
    this.raw = stored;
    this.load(stored);
  }

  /** Load a stored definition (the raw value is kept as given, never rewritten). */
  update(stored: unknown): void {
    this.raw = stored;
    this.load(stored);
  }

  private load(stored: unknown): void {
    this.engine = null;
    this.ast = null;
    this.fault = null;
    if (stored === undefined) {
      this.fault = { message: "the world runs on a calendar definition, but none is stored" };
      return;
    }
    if (typeof stored !== "string") {
      this.fault = { message: "the stored calendar definition is not text" };
      return;
    }
    let ast: CalendarAst;
    try {
      ast = parse(stored);
    } catch (e) {
      if (!(e instanceof SeshatSyntaxError)) throw e;
      this.fault = { message: e.message, line: e.line };
      return;
    }
    const errors = [...validate(ast), ...checkWorldCalendar(ast)];
    if (errors.length) {
      this.fault = { message: errors[0]! };
      return;
    }
    try {
      this.engine = new Engine(ast);
    } catch (e) {
      this.fault = { message: `the definition cannot run: ${e instanceof Error ? e.message : String(e)}` };
      return;
    }
    this.ast = ast;
  }

  [ADAPTER_FAULT](): string | null {
    return this.fault ? (this.fault.line === undefined ? this.fault.message : `line ${this.fault.line}: ${this.fault.message}`) : null;
  }

  /** The stored value as it was given, never rewritten (a fault keeps it byte for byte). */
  stored(): unknown {
    return this.raw;
  }

  /** The definition this adapter runs, or null in a fault. */
  definition(): CalendarAst | null {
    return this.ast;
  }

  /** The stored text as it would be written now (canonical), or null in a fault. */
  text(): string | null {
    return this.ast ? print(this.ast) : null;
  }

  now(): TimeContext | null {
    return this.fault ? null : this.toContext(this.current());
  }

  toContext(dayOrdinal: number): TimeContext {
    const e = this.engine;
    if (!e) return { dayOrdinal, yearPhase: 0, yearLength: 1, tags: [], source: this.id }; // a fault: World refuses before it reads this
    const year = yearAt(e, dayOrdinal);
    const dayOfYear = dayOrdinal - year.start;
    const yearPhase = dayOfYear / year.length;
    const tags: string[] = [];
    // the engine's own season resolver over the year (checkWorldCalendar keeps seasons on the year), past ±DAY_LIMIT too
    const season = e.ast.seasons ? seasonIn(e.ast.seasons, year, dayOrdinal) : null;
    if (season) tags.push(`season:${season}`);
    tags.push(...this.dayTags(e, year.tagDay));
    return {
      dayOrdinal,
      yearPhase,
      yearLength: year.length,
      dayOfYear,
      year: year.index + (this.yearUnit()?.number ?? 0),
      moons: e.moonsAt(dayOrdinal),
      tags,
      source: this.id,
    };
  }

  /** Unit, day-label and named-rule tags; a named rule that throws loses its own tags for the day, reported once per rule. */
  private dayTags(e: Engine, day: number): string[] {
    return e.tagsAt(day, (ruleId, err) => {
      if (this.reported.has(ruleId)) return;
      this.reported.add(ruleId);
      console.error(`U+13080 Weather: the named rule "${ruleId}" in the Seshat calendar failed on day ${day}; its tags are left out.`, err);
    });
  }

  /** The year holding `day` (its number, first day and length), as toContext reads it; null in a fault. The Studio's year seam reads this. */
  yearOfDay(day: number): { year: number; start: number; length: number } | null {
    const e = this.engine;
    if (!e) return null;
    const y = yearAt(e, day);
    return { year: y.index + (this.yearUnit()?.number ?? 0), start: y.start, length: y.length };
  }

  /** The first day of year number `year`; null in a fault. */
  yearStart(year: number): number | null {
    const e = this.engine;
    return e ? yearStartAt(e, year - (this.yearUnit()?.number ?? 0)) : null;
  }

  private yearUnit() {
    return this.ast?.units.find((u) => u.id === "year");
  }

  configHash(): string {
    if (!this.ast) return `seshat:fault:${hash64(typeof this.raw === "string" ? this.raw : JSON.stringify(this.raw) ?? "")}`;
    return `seshat:${hash64(canonicalJson({ v: SESHAT_VERSION, a: SESHAT_ADAPTER_VERSION, c: definitionContent(this.ast) }))}`;
  }

  describe(): CalendarDescription {
    const e = this.engine;
    const ast = this.ast;
    if (!e || !ast) return { label: `Seshat calendar · fault: ${this.fault?.message ?? "not loaded"}`, readOnly: true, yearLength: 1, seasons: [], moons: [] };
    const year0 = e.occurrenceAt("year", 0)!;
    return {
      label: ast.name,
      // the Studio edits its seasons and moons, merged back into the definition (studio/model/definition.ts)
      readOnly: false,
      // the year holding day 0 until the Studio reads each year's own length (P3b)
      yearLength: year0.length,
      epochYear: year0.index + (this.yearUnit()?.number ?? 0),
      seasons: [...(ast.seasons?.marks ?? [])].sort((a, b) => a.from - b.from).map((s) => ({ name: s.name, from: s.from })),
      moons: (ast.bodies ?? []).flatMap((b) =>
        b.moon ? [{ name: b.moon.name, cycleDays: toNumber(b.period), phaseAtEpoch: toNumber(b.epoch), ...(b.moon.phases ? { phases: b.moon.phases.map((p) => ({ name: p.name, at: p.at })) } : {}) }] : [],
      ),
    };
  }

  /** The definition's default format; a calendar without one writes as the internal calendar does: "Year 3, day 14 (Summer)". */
  format(dayOrdinal: number): string {
    const e = this.engine;
    if (!e) return `Day ${dayOrdinal}`;
    if (this.ast?.formats?.length) return formatDay(e, dayOrdinal);
    const c = this.toContext(dayOrdinal);
    const season = c.tags?.find((t) => t.startsWith("season:"))?.slice(7);
    return `Year ${c.year}, day ${(c.dayOfYear ?? 0) + 1}${season ? ` (${season})` : ""}`;
  }

  /** A bare day number, or a day in the definition's parseable formats; without formats, "year-day" as the internal calendar reads it. */
  parse(text: string): number | null {
    const t = text.trim();
    if (/^-?\d+$/.test(t)) return Number(t);
    const e = this.engine;
    if (!e) return null;
    if (this.ast?.formats?.length) return parseDay(e, t);
    const m = /^(-?\d+)-(\d+)$/.exec(t);
    if (!m) return null;
    try {
      const index = Number(m[1]) - (this.yearUnit()?.number ?? 0);
      const start = e.start("year", index);
      const day = start + Number(m[2]) - 1;
      if (Number(m[2]) < 1 || Number(m[2]) > e.length("year", index) || Math.abs(day) > DAY_LIMIT) return null;
      return day;
    } catch {
      return null;
    }
  }

  async setNow(dayOrdinal: number): Promise<void> {
    assertInteger(dayOrdinal, "dayOrdinal");
    assertDayInRange(dayOrdinal, "dayOrdinal");
    if (!this.write) throw new Error("The Seshat calendar has no place to store the current day.");
    await this.write(dayOrdinal);
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (e) {
        console.error("U+13080 Weather: a Seshat calendar subscriber threw.", e);
      }
    }
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
