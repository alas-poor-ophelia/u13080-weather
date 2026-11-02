/**
 * `api.seshat` (docs/API.md §1b): another plugin's way to the world's calendar
 * definition. Built without Obsidian, like the API object around it.
 *
 * A `SeshatCalendarView` is a snapshot of one definition over its own engine,
 * so it never changes under a caller and internals stay free to change:
 * `adapters-changed` means ask `calendar()` again.
 */
import type { CalendarAst, LabelAst, Position, Problem, RuleAst } from "../seshat";
import { DAY_LIMIT, print } from "../seshat";
import type { TimeRegistry } from "./time/adapter";
import { prepareDefinition, SeshatCalendar } from "./time/seshat";

export interface SeshatCalendarView {
  readonly name: string;
  /** the definition as canonical Seshat text */
  readonly text: string;
  /** the definition as stored: every unit, slot, gear, moon, season, format and rule. Frozen */
  readonly definition: CalendarAst;
  /** changes when anything that reaches a day, a tag, a year number, a moon or a match changes */
  readonly hash: string;

  /** the day on which occurrence `index` of cycle unit `unit` starts */
  start: (unit: string, index: number) => number;
  length: (unit: string, index: number) => number;
  /** the occurrence of cycle unit `unit` whose span holds `day`, also a filler day it skips */
  indexAt: (unit: string, day: number) => number;
  /** the occurrence of `unit` holding `day`; null when the day has no place in it (a filler day has no tenday). `start + length` is where the next one starts */
  occurrenceAt: (unit: string, day: number) => { readonly index: number; readonly start: number; readonly length: number } | null;
  /** like occurrenceAt, with the days into it: on a unit that skips filler days, only the days it counts */
  positionOf: (unit: string, day: number) => Position | null;
  /** the lengths of slot unit `unit` inside one parent occurrence; `path` names it from the cycle down: [year], or [year, month] */
  slotLengths: (unit: string, path: readonly number[]) => number[];
  /** the day `offset` days into slot `slot` of `unit`, inside the parent occurrence at `path` */
  dayOf: (unit: string, path: readonly number[], slot: number, offset: number) => number;
  labelAt: (unit: string, day: number) => LabelAst | null;
  /** every tag the day carries, from its units, day labels and named rules; a rule that throws loses only its own tags */
  tagsAt: (day: number) => string[];
  seasonAt: (day: number) => string | null;
  moonsAt: (day: number) => Array<{ name: string; phase: number }>;
  /** a body's phase in [0, 1), or undefined when there is no such body */
  bodyPhase: (body: string, day: number) => number | undefined;
  /** does `rule` hold on `day`? Throws RangeError for a rule that does not fit the calendar, including one that reads weather (a host leaf) */
  holds: (rule: RuleAst, day: number) => boolean;
  /** the day in the default format, or the named one (throws when the definition does not declare it) */
  format: (day: number, name?: string) => string;
  /** a bare day number, or a day in the definition's parseable formats; null when it is neither */
  parse: (text: string) => number | null;
}

/** One plugin's mark on the day line: a day, or a span of days. Weather and calendar rules never read it. */
export interface SeshatMark {
  readonly id: string;
  readonly from: number;
  /** the last day of a span; absent for one day */
  readonly to?: number;
  readonly name?: string;
  readonly tags?: readonly string[];
  /** anything JSON can hold; it comes back as a copy */
  readonly data?: unknown;
}

/** A plugin's own marks, stored by Wadjet under its name and kept outside the calendar. Writes run one at a time. */
export interface SeshatMarks {
  list: () => SeshatMark[];
  /** resolves to the stored mark with its id. Throws TypeError or RangeError for a bad mark, and rejects when the owner's marks would pass the size limit */
  add: (mark: Omit<SeshatMark, "id">) => Promise<SeshatMark>;
  /** resolves false when there is no such mark */
  remove: (id: string) => Promise<boolean>;
  clear: () => Promise<void>;
}

export interface SeshatAPI {
  /** the definition the world runs; null when it runs another calendar or its stored definition cannot run */
  calendar: () => SeshatCalendarView | null;
  /** run any definition without touching the world, under the checks a world's calendar must pass */
  compile: (input: string | CalendarAst) => { calendar: SeshatCalendarView } | { problems: Problem[] };
  /**
   * Replace the definition the world runs, with no question: an edit applies, and undo steps back through it. Resolved
   * once the running calendar has changed. `ok: false` when the world does not run a definition, or this one cannot run.
   */
  setDefinition: (input: string | CalendarAst) => Promise<{ ok: true } | { ok: false; problems: Problem[] }>;
  /** open the Studio with the calendar editor up, as the ruler's Calendar button does */
  openEditor: () => Promise<void>;
  /** the marks plugin `owner` keeps here (use your plugin's id), which never move the weather */
  marks: (owner: string) => SeshatMarks;
}

export interface SeshatApiHost {
  time: TimeRegistry;
  /** run a settings write when its turn comes (the API's own queue) */
  inTurn: <T>(write: () => Promise<T>) => Promise<T>;
  /** throws once the plugin has unloaded */
  live: () => void;
  openEditor?: () => Promise<void>;
  /** store a definition the world runs (main.ts); tests may leave it out */
  saveDefinition?: (text: string) => Promise<void>;
  /** where marks live (main.ts): the settings as they are now, and their save; tests may leave it out */
  marksStore?: { settings: () => { seshatMarks?: Record<string, unknown> }; save: () => Promise<void> };
}

/** How much one plugin may keep here, as JSON: the whole list goes in data.json, which Sync carries to every device. */
export const MARKS_BYTES_MAX = 100_000;

/** A stored mark, or null when it is not one (a later shape, or a hand edit): it is left where it is and not shown. */
function storedMark(v: unknown): SeshatMark | null {
  const m = v as Partial<SeshatMark> | null;
  return typeof m === "object" && m !== null && typeof m.id === "string" && Number.isSafeInteger(m.from) ? (m as SeshatMark) : null;
}

/** A new mark checked and copied: what goes in data.json is plain JSON, whatever the caller handed over. */
function cleanMark(mark: Omit<SeshatMark, "id">, id: string): SeshatMark {
  const day = (v: unknown, what: string): number => {
    if (!Number.isSafeInteger(v)) throw new TypeError(`A mark's ${what} must be a whole day number.`);
    if (Math.abs(v as number) > DAY_LIMIT) throw new RangeError(`A mark's ${what} must be within ±${DAY_LIMIT}.`);
    return v as number;
  };
  const from = day(mark?.from, "from");
  const to = mark.to === undefined ? undefined : day(mark.to, "to");
  if (to !== undefined && to < from) throw new RangeError("A mark's to cannot come before its from.");
  if (mark.name !== undefined && typeof mark.name !== "string") throw new TypeError("A mark's name must be text.");
  if (mark.tags !== undefined && !(Array.isArray(mark.tags) && mark.tags.every((t) => typeof t === "string"))) throw new TypeError("A mark's tags must be a list of text.");
  let data: unknown;
  if (mark.data !== undefined) {
    const text = JSON.stringify(mark.data); // throws on a cycle, here and not in a later save
    if (text === undefined) throw new TypeError("A mark's data must be something JSON can hold.");
    data = JSON.parse(text);
  }
  return { id, from, ...(to !== undefined ? { to } : {}), ...(mark.name !== undefined ? { name: mark.name } : {}), ...(mark.tags !== undefined ? { tags: [...mark.tags] } : {}), ...(data !== undefined ? { data } : {}) };
}

function makeMarks(owner: string, host: SeshatApiHost): SeshatMarks {
  const store = (): NonNullable<SeshatApiHost["marksStore"]> => {
    if (!host.marksStore) throw new Error("This host stores no marks.");
    return host.marksStore;
  };
  const raw = (): unknown[] => {
    const v = store().settings().seshatMarks?.[owner];
    return Array.isArray(v) ? v : [];
  };
  /** Replace this owner's list and save; a failed save puts it back. The settings are read when the turn comes, so Sync replacing them is followed. */
  const write = async (next: unknown[]): Promise<void> => {
    const s = store().settings();
    const was = s.seshatMarks;
    const others = { ...was };
    delete others[owner];
    const all = next.length ? { ...others, [owner]: next } : others;
    if (Object.keys(all).length) s.seshatMarks = all;
    else delete s.seshatMarks;
    try {
      await store().save();
    } catch (e) {
      if (was === undefined) delete s.seshatMarks;
      else s.seshatMarks = was;
      throw e;
    }
  };
  return Object.freeze<SeshatMarks>({
    list: () => {
      host.live();
      return raw()
        .map(storedMark)
        .filter((m): m is SeshatMark => m !== null)
        .map((m) => structuredClone(m));
    },
    add: (mark) => {
      host.live();
      // checked and copied now, so a bad mark throws at the call and a caller's later change to `data` is not stored
      const clean = cleanMark(mark, "");
      return host.inTurn(async () => {
        const list = raw();
        host.live(); // the plugin may have unloaded while this waited, and its save would write nothing
        // random, so a plugin holding the id of a removed mark cannot remove a later one with it
        const taken = new Set(list.map((v) => storedMark(v)?.id));
        let id: string;
        do id = `m${Math.random().toString(36).slice(2, 10)}`;
        while (taken.has(id));
        const stored = { ...clean, id };
        const next = [...list, stored];
        if (new TextEncoder().encode(JSON.stringify(next)).length > MARKS_BYTES_MAX) throw new RangeError(`The marks of "${owner}" would pass ${MARKS_BYTES_MAX} bytes; a plugin with this many records should keep them itself.`);
        await write(next);
        return structuredClone(stored);
      });
    },
    remove: (id) => {
      host.live();
      return host.inTurn(async () => {
        host.live();
        const list = raw();
        const next = list.filter((v) => storedMark(v)?.id !== id);
        if (next.length === list.length) return false;
        await write(next);
        return true;
      });
    },
    clear: () => {
      host.live();
      return host.inTurn(async () => {
        host.live();
        if (raw().length) await write([]);
      });
    },
  });
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

/** The view of a definition that runs, or the reason it cannot. */
function viewOf(text: string): SeshatCalendarView | string {
  const adapter = new SeshatCalendar(text, () => 0);
  const e = adapter.running();
  const definition = adapter.definition();
  const canonical = adapter.text();
  if (!e || !definition || canonical === null) return adapter.fault?.message ?? "the definition cannot run";
  return Object.freeze<SeshatCalendarView>({
    name: definition.name,
    text: canonical,
    definition: deepFreeze(structuredClone(definition)),
    hash: adapter.configHash(),
    start: (unit, index) => e.start(unit, index),
    length: (unit, index) => e.length(unit, index),
    indexAt: (unit, day) => e.indexAt(unit, day),
    occurrenceAt: (unit, day) => e.occurrenceAt(unit, day),
    positionOf: (unit, day) => e.positionOf(unit, day),
    slotLengths: (unit, path) => e.slotLengths(unit, path),
    dayOf: (unit, path, slot, offset) => e.dayOf(unit, path, slot, offset),
    // a copy: the engine's own label must not be reachable from outside
    labelAt: (unit, day) => structuredClone(e.labelAt(unit, day)),
    tagsAt: (day) => e.tagsAt(day, () => undefined),
    seasonAt: (day) => e.seasonAt(day),
    moonsAt: (day) => e.moonsAt(day),
    bodyPhase: (body, day) => e.bodyPhase(body, day),
    holds: (rule, day) => e.days.holds(e.days.bind(rule), day),
    format: (day, name) => (name === undefined ? adapter.format(day) : adapter.formatNamed(day, name)),
    parse: (t) => adapter.parse(t),
  });
}

/** The canonical text of a definition that passes the checks a world's calendar must, or its problems. */
function checkedText(input: string | CalendarAst): string | { problems: Problem[] } {
  let text: string;
  try {
    if (typeof input === "string") text = input;
    else if (typeof input === "object" && input !== null) text = print(input);
    else return { problems: [{ message: "a definition is Seshat text or a calendar AST" }] };
  } catch (e) {
    return { problems: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const prepared = prepareDefinition(text);
  return "error" in prepared ? { problems: prepared.problems } : prepared.text;
}

export function makeSeshatApi(host: SeshatApiHost): SeshatAPI {
  // the view of the stored text last asked for: plugins may ask on every render
  let cached: { stored: unknown; view: SeshatCalendarView | null } | null = null;
  return Object.freeze<SeshatAPI>({
    calendar: () => {
      host.live();
      const a = host.time.active;
      if (!(a instanceof SeshatCalendar) || a.fault) return null;
      const stored = a.stored();
      if (cached && cached.stored === stored) return cached.view;
      const made = viewOf(stored as string);
      const view = typeof made === "string" ? null : made;
      cached = { stored, view };
      return view;
    },
    compile: (input) => {
      host.live();
      const checked = checkedText(input);
      if (typeof checked !== "string") return checked;
      const view = viewOf(checked);
      return typeof view === "string" ? { problems: [{ message: view }] } : { calendar: view };
    },
    setDefinition: async (input) => {
      host.live();
      if (!host.saveDefinition) throw new Error("This host stores no calendar.");
      if (!(host.time.active instanceof SeshatCalendar)) return { ok: false, problems: [{ message: "this world does not run a calendar definition; openEditor leads to Change calendar" }] };
      const checked = checkedText(input);
      if (typeof checked !== "string") return { ok: false, ...checked };
      try {
        await host.saveDefinition(checked);
      } catch (e) {
        return { ok: false, problems: [{ message: e instanceof Error ? e.message : String(e) }] };
      }
      return { ok: true };
    },
    openEditor: async () => {
      host.live();
      if (!host.openEditor) throw new Error("This host has no calendar editor.");
      await host.openEditor();
    },
    marks: (owner) => {
      host.live();
      if (typeof owner !== "string" || owner === "" || owner.length > 200) throw new TypeError("marks needs your plugin's id.");
      return makeMarks(owner, host);
    },
  });
}
