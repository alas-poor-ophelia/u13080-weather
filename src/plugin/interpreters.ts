/**
 * Interpreter registry (docs/API.md "Interpreters"). Wadjet reports weather;
 * what weather MEANS for a game (travel, hazards, rulings) lives in
 * interpreters other plugins register. Wadjet ships none and gives `facet`
 * no meaning beyond a free-form grouping key. Pure: no Obsidian imports.
 */
import type { Classification } from "../core/classify";
import type { WeatherReport } from "../core/report";
import type { TimeContext } from "./time/adapter";

export interface InterpretContext {
  zoneId: string;
  /** `classify(report)` */
  classification: Classification;
  /** `timeAt(report.dayOrdinal, report.zoneId)` carrying `report.hour` when the report has one */
  time: TimeContext;
  /** whatever the caller passed to `interpret(id, report, options)` */
  options?: Record<string, unknown>;
}

export interface WeatherInterpreter<T = unknown> {
  /** namespaced, e.g. "my-system.mood"; unique among live registrations */
  id: string;
  /** shown in pickers */
  label: string;
  /** free-form grouping key; Wadjet gives it no meaning */
  facet: string;
  description?: string;
  /** synchronous by contract */
  interpret: (report: WeatherReport, ctx: InterpretContext) => T;
  /** optional: one line of text for a result, used by the code block's `interpret:` option */
  format?: (result: T) => string;
}

export interface InterpreterInfo {
  id: string;
  label: string;
  facet: string;
  description?: string;
}

/** An Error with a machine-readable `code`. */
export type CodedError = Error & { code: string };
export function codedError(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code });
}

export class InterpreterRegistry {
  private readonly byId = new Map<string, WeatherInterpreter>();

  constructor(private readonly changed: (facet: string) => void) {}

  /** Throws a TypeError on a malformed interpreter and an Error with code "wadjet-duplicate-id" when the id is taken. */
  register(i: WeatherInterpreter): () => void {
    if (typeof i !== "object" || i === null) throw new TypeError("An interpreter must be an object.");
    for (const k of ["id", "label", "facet"] as const) {
      if (typeof i[k] !== "string" || i[k] === "") throw new TypeError(`Interpreter ${k} must be a non-empty string.`);
    }
    if (typeof i.interpret !== "function") throw new TypeError(`Interpreter "${i.id}" needs an interpret function.`);
    if (i.format !== undefined && typeof i.format !== "function") throw new TypeError(`Interpreter "${i.id}": format must be a function.`);
    if (this.byId.has(i.id)) throw codedError("wadjet-duplicate-id", `An interpreter with id "${i.id}" is already registered; unregister it first.`);
    // Keyed on the id and facet as registered: a later mutation of the object can't strand or misreport the entry.
    const { id, facet } = i;
    this.byId.set(id, i);
    this.changed(facet);
    return () => {
      if (this.byId.get(id) !== i) return;
      this.byId.delete(id);
      this.changed(facet);
    };
  }

  list(facet?: string): InterpreterInfo[] {
    const out: InterpreterInfo[] = [];
    for (const i of this.byId.values()) {
      if (facet !== undefined && i.facet !== facet) continue;
      out.push({ id: i.id, label: i.label, facet: i.facet, ...(typeof i.description === "string" ? { description: i.description } : {}) });
    }
    return out;
  }

  get(id: string): WeatherInterpreter | null {
    return this.byId.get(id) ?? null;
  }

  /** Unknown id: RangeError. An interpreter that throws: Error naming the id, original in `cause`. */
  run(id: string, report: WeatherReport, ctx: InterpretContext): unknown {
    const i = this.byId.get(id);
    if (!i) throw new RangeError(`Unknown interpreter "${id}".`);
    try {
      return i.interpret(report, ctx);
    } catch (e) {
      throw new Error(`Interpreter "${id}" failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }

  clear(): void {
    this.byId.clear();
  }
}

/** One line for a result: the interpreter's format(), else compact JSON. Never throws. */
export function formatInterpretation(i: WeatherInterpreter, result: unknown): string {
  if (typeof i.format === "function") {
    try {
      return String(i.format(result));
    } catch (e) {
      return `(format failed: ${e instanceof Error ? e.message : String(e)})`;
    }
  }
  try {
    return typeof result === "string" ? result : (JSON.stringify(result) ?? String(result));
  } catch {
    return String(result);
  }
}
