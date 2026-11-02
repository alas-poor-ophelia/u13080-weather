/**
 * `api.seshat` (docs/API.md §1b): another plugin's way to the world's calendar
 * definition. Built without Obsidian, like the API object around it.
 *
 * A `SeshatCalendarView` is a snapshot of one definition over its own engine,
 * so it never changes under a caller and internals stay free to change:
 * `adapters-changed` means ask `calendar()` again.
 */
import type { CalendarAst, LabelAst, Position, Problem, RuleAst } from "../seshat";
import { print } from "../seshat";
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

export interface SeshatAPI {
  /** the definition the world runs; null when it runs another calendar or its stored definition cannot run */
  calendar: () => SeshatCalendarView | null;
  /** run any definition without touching the world, under the checks a world's calendar must pass */
  compile: (input: string | CalendarAst) => { calendar: SeshatCalendarView } | { problems: Problem[] };
  /** open the Studio with the calendar editor up, as the ruler's Calendar button does */
  openEditor: () => Promise<void>;
}

export interface SeshatApiHost {
  time: TimeRegistry;
  /** throws once the plugin has unloaded */
  live: () => void;
  openEditor?: () => Promise<void>;
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
      let text: string;
      try {
        if (typeof input === "string") text = input;
        else if (typeof input === "object" && input !== null) text = print(input);
        else return { problems: [{ message: "a definition is Seshat text or a calendar AST" }] };
      } catch (e) {
        return { problems: [{ message: e instanceof Error ? e.message : String(e) }] };
      }
      const prepared = prepareDefinition(text);
      if ("error" in prepared) return { problems: prepared.problems };
      const view = viewOf(prepared.text);
      return typeof view === "string" ? { problems: [{ message: view }] } : { calendar: view };
    },
    openEditor: async () => {
      host.live();
      if (!host.openEditor) throw new Error("This host has no calendar editor.");
      await host.openEditor();
    },
  });
}
