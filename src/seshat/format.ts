/**
 * Formatting and strict parsing of days (docs/SESHAT-v0.md §4.2, Q2).
 *
 * A pattern is literal text with tokens in braces; `{{` and `}}` are literal
 * braces. A token names a declared unit and optional fields:
 *
 *   {u}        the occurrence's number: index + the unit's `number` (default
 *              0 for a cycle, 1 for a slot unit)
 *   {u:name}   the label name (a cycle's label, a slot's name)
 *   {u:day}    the day within the occurrence, from 1; {u:day0} from 0
 *   …:padN     zero-pad the number to N digits (the sign stays in front)
 *
 * Tokens are coordinates or derived. Coordinates determine the day: a top
 * cycle's number, each slot level's number (or its name, when the unit's
 * slots all have distinct names), and the day within the deepest of them.
 * Everything else (weekday names, a cycle's labels, a second cycle) is
 * derived: printed, and checked when parsing. A pattern whose coordinates do
 * not reach a single day is format-only: `format` uses it, `parse` refuses
 * it rather than guess (the Calendar Round repeats every 18,980 days).
 *
 * `format(engine, day)` uses the pattern named "default" (else the first),
 * or "filler" for a day in a filler slot of the default pattern's units.
 * `parse(engine, text)` resolves each parseable pattern top-down and accepts
 * a day only when formatting it gives `text` back exactly.
 */
import type { CalendarAst, FormatAst, SlotsUnitAst, UnitAst } from "./ast";
import { DAY_LIMIT } from "./day";
import type { Engine } from "./engine";

type Field = "num" | "name" | "day" | "day0";
interface Token {
  readonly unit: string;
  readonly field: Field;
  readonly pad: number;
}
type Part = string | Token;

/** A compiled pattern: its parts, and the coordinate chain from a top cycle down (null when format-only). */
export interface CompiledFormat {
  readonly name: string;
  readonly parts: readonly Part[];
  readonly chain: readonly string[] | null;
  /** whether the chain's deepest unit needs a day token (it does unless every occurrence the pattern serves is one day) */
  readonly dayToken: Token | null;
}

/** Parse a pattern into literal text and tokens; errors are plain sentences. */
function tokenize(pattern: string): { parts: Part[]; errors: string[] } {
  const parts: Part[] = [];
  const errors: string[] = [];
  let lit = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if ((ch === "{" || ch === "}") && pattern[i + 1] === ch) {
      lit += ch;
      i++;
      continue;
    }
    if (ch === "}") {
      errors.push(`a lone "}" at ${i} (write "}}" for a brace)`);
      continue;
    }
    if (ch !== "{") {
      lit += ch;
      continue;
    }
    const end = pattern.indexOf("}", i);
    if (end < 0) {
      errors.push(`"{" at ${i} is never closed`);
      break;
    }
    const [unit, ...fields] = pattern.slice(i + 1, end).split(":");
    let field: Field = "num";
    let pad = 0;
    for (const f of fields) {
      if (f === "name" || f === "day" || f === "day0") field = f;
      else if (/^pad[1-9]$/.test(f)) pad = Number(f.slice(3));
      else errors.push(`unknown field ":${f}" in {${pattern.slice(i + 1, end)}}`);
    }
    if (lit) parts.push(lit);
    lit = "";
    parts.push({ unit: unit!, field, pad });
    i = end;
  }
  if (lit) parts.push(lit);
  return { parts, errors };
}

const isSlots = (u: UnitAst | undefined): u is SlotsUnitAst => u?.kind === "slots";

/** Distinct, all present: a slot unit whose names can stand for its numbers. */
function namesAreCoordinates(u: SlotsUnitAst): boolean {
  const names = u.slots.map((s) => s.name);
  return names.every((n) => n !== undefined && n !== "") && new Set(names).size === names.length;
}

/** Every occurrence of `u` the pattern can serve is one day long (filler patterns serve only filler slots). */
function oneDay(u: UnitAst, fillerOnly: boolean): boolean {
  if (u.kind === "cycle") return u.crossing === undefined && u.length === 1 && !u.gears?.length && !u.stages?.length && !u.ledger?.length;
  const slots = fillerOnly ? u.slots.filter((s) => s.filler) : u.slots;
  // the longest a slot can be: its length plus every gear that could add to it (Shieldmeet: 0 + 1)
  return slots.length > 0 && slots.every((s) => typeof s.length === "number" && s.length + (s.gears ?? []).reduce((a, g) => a + Math.max(0, g.add), 0) <= 1);
}

/** Check and compile one pattern against a calendar. Errors are for malformed patterns; a format-only pattern is not an error. */
export function compileFormat(f: FormatAst, ast: CalendarAst): { compiled: CompiledFormat | null; errors: string[] } {
  const { parts, errors } = tokenize(f.pattern);
  const units = new Map(ast.units.map((u) => [u.id, u]));
  const tokens = parts.filter((p): p is Token => typeof p !== "string");
  for (const t of tokens) if (!units.has(t.unit)) errors.push(`no unit "${t.unit}"`);
  if (errors.length) return { compiled: null, errors: errors.map((e) => `format "${f.name}": ${e}`) };

  // coordinate levels: a number, or a slot name that names exactly one slot
  const coord = new Set(tokens.filter((t) => t.field === "num" || (t.field === "name" && isSlots(units.get(t.unit)) && namesAreCoordinates(units.get(t.unit) as SlotsUnitAst))).map((t) => t.unit));
  const depth = (id: string): number => {
    let d = 0;
    for (let u = units.get(id); isSlots(u); u = units.get(u.in)) d++;
    return d;
  };
  const chainOf = (id: string): string[] => {
    const out = [id];
    for (let u = units.get(id); isSlots(u); u = units.get(u.in)) out.unshift(u.in);
    return out;
  };
  let chain: string[] | null = null;
  // the deepest complete chain of slot coordinates; a derived extra token does not spoil it
  for (const id of [...coord].filter((x) => isSlots(units.get(x))).sort((a, b) => depth(b) - depth(a))) {
    const c = chainOf(id);
    if (c.every((x) => coord.has(x))) {
      chain = c;
      break;
    }
  }
  if (!chain) {
    const cycles = [...coord].filter((x) => !isSlots(units.get(x)));
    const withDay = cycles.filter((x) => tokens.some((t) => t.unit === x && (t.field === "day" || t.field === "day0")));
    chain = cycles.length === 1 ? cycles : withDay.length === 1 ? withDay : null;
  }
  let dayToken: Token | null = null;
  if (chain) {
    const leaf = chain[chain.length - 1]!;
    dayToken = tokens.find((t) => t.unit === leaf && (t.field === "day" || t.field === "day0")) ?? null;
    if (!dayToken && !oneDay(units.get(leaf)!, f.name === "filler")) chain = null;
  }
  // a filler slot above the leaf has no children, so its days would print the deeper tokens empty and share
  // one text: only the automatic default may have one, and only when a parseable "filler" pattern takes those days
  if (chain && chain.slice(0, -1).some((x) => isSlots(units.get(x)) && (units.get(x) as SlotsUnitAst).slots.some((sl) => sl.filler))) {
    const def = (ast.formats ?? []).find((x) => x.name === "default") ?? ast.formats?.[0];
    const filler = (ast.formats ?? []).find((x) => x.name === "filler");
    const covered = f.name !== "filler" && def?.name === f.name && filler !== undefined && compileFormat(filler, ast).compiled?.chain != null;
    if (!covered) chain = null;
  }
  // two tokens with nothing between them cannot be told apart ("20261019" splits more than one way)
  for (let i = 0; i + 1 < parts.length; i++) if (typeof parts[i] !== "string" && typeof parts[i + 1] !== "string") chain = null;
  return { compiled: { name: f.name, parts, chain, dayToken }, errors: [] };
}

/** Validator obligations for a calendar's formats (malformed patterns, duplicate or empty names). */
export function checkFormats(ast: CalendarAst): string[] {
  const errors: string[] = [];
  const names = (ast.formats ?? []).map((f) => f.name);
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i))) errors.push(`format "${n}" is declared more than once`);
  for (const f of ast.formats ?? []) {
    if (typeof f.name !== "string" || !f.name) errors.push("a format needs a name");
    if (typeof f.pattern !== "string") errors.push(`format "${f.name}": the pattern is not a string`);
    else errors.push(...compileFormat(f, ast).errors);
  }
  for (const u of ast.units) if (u.number !== undefined && !Number.isSafeInteger(u.number)) errors.push(`unit "${u.id}": number ${String(u.number)} is not a whole number`);
  return errors;
}

// ---------------------------------------------------------------------------
// Format and parse over an engine
// ---------------------------------------------------------------------------

const compiled = new WeakMap<Engine, Map<string, CompiledFormat>>();

function formatsOf(engine: Engine): Map<string, CompiledFormat> {
  let m = compiled.get(engine);
  if (!m) {
    m = new Map();
    for (const f of engine.ast.formats ?? []) {
      const c = compileFormat(f, engine.ast).compiled;
      if (c) m.set(f.name, c); // the engine's validator already refused malformed patterns
    }
    compiled.set(engine, m);
  }
  return m;
}

function pick(engine: Engine, name: string | undefined): CompiledFormat {
  const all = formatsOf(engine);
  const f = name !== undefined ? all.get(name) : (all.get("default") ?? all.values().next().value);
  if (!f) throw new RangeError(name !== undefined ? `calendar "${engine.ast.name}" has no format "${name}"` : `calendar "${engine.ast.name}" declares no formats`);
  return f;
}

function unitNumber(engine: Engine, id: string): number {
  const u = engine.ast.units.find((x) => x.id === id)!;
  return u.number ?? (u.kind === "cycle" ? 0 : 1);
}

function padded(n: number, width: number): string {
  const s = String(Math.abs(n)).padStart(width, "0");
  return n < 0 ? `-${s}` : s;
}

function render(engine: Engine, f: CompiledFormat, day: number): string {
  let out = "";
  for (const p of f.parts) {
    if (typeof p === "string") {
      out += p;
      continue;
    }
    if (p.field === "name") {
      out += engine.labelAt(p.unit, day)?.name ?? "";
      continue;
    }
    const o = engine.occurrenceAt(p.unit, day);
    if (!o) continue; // the day has no place in this unit (a filler day of an enclosing unit)
    const n = p.field === "num" ? o.index + unitNumber(engine, p.unit) : day - o.start + (p.field === "day" ? 1 : 0);
    out += padded(n, p.pad);
  }
  return out;
}

/** Is `day` in a filler slot of any unit the pattern's chain (or tokens) reads? */
function inFiller(engine: Engine, f: CompiledFormat, day: number): boolean {
  const ids = new Set([...(f.chain ?? []), ...f.parts.flatMap((p) => (typeof p === "string" ? [] : [p.unit]))]);
  for (const id of ids) {
    const u = engine.ast.units.find((x) => x.id === id)!;
    if (u.kind !== "slots") continue;
    const at = engine.positionOf(id, day);
    if (at && u.slots[at.index]!.filler) return true;
  }
  return false;
}

/** The day as text: the named pattern, or the default (the "filler" pattern for a filler day, when declared). */
export function formatDay(engine: Engine, day: number, name?: string): string {
  if (name !== undefined) return render(engine, pick(engine, name), day);
  const def = pick(engine, undefined);
  const filler = formatsOf(engine).get("filler");
  return render(engine, filler && filler !== def && inFiller(engine, def, day) ? filler : def, day);
}

/** Whether a declared pattern can be parsed (its coordinates reach a single day). */
export function isParseable(engine: Engine, name: string): boolean {
  return pick(engine, name).chain !== null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function namesOf(engine: Engine, unit: string): string[] {
  const u = engine.ast.units.find((x) => x.id === unit)!;
  const names = u.kind === "slots" ? u.slots.map((s) => s.name ?? "") : (u.labels ?? []).map((l) => l.name ?? "");
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

/** Resolve text under one pattern to a candidate day, or null. Values must be safe integers. */
function resolve(engine: Engine, f: CompiledFormat, text: string): number | null {
  if (!f.chain) return null;
  const tokens = f.parts.filter((p): p is Token => typeof p !== "string");
  const re = new RegExp(`^${f.parts.map((p) => (typeof p === "string" ? escapeRe(p) : p.field === "name" ? `(${namesOf(engine, p.unit).map(escapeRe).join("|")})` : "(-?\\d+)")).join("")}$`, "u");
  const m = re.exec(text);
  if (!m) return null;
  const value = (t: Token): number | string => (t.field === "name" ? m[tokens.indexOf(t) + 1]! : Number(m[tokens.indexOf(t) + 1]));
  const indices: number[] = [];
  for (const id of f.chain) {
    const num = tokens.find((t) => t.unit === id && t.field === "num");
    if (num) {
      const v = value(num) as number;
      if (!Number.isSafeInteger(v)) return null;
      indices.push(v - unitNumber(engine, id));
      continue;
    }
    const name = tokens.find((t) => t.unit === id && t.field === "name")!;
    const u = engine.ast.units.find((x) => x.id === id) as SlotsUnitAst;
    indices.push(u.slots.findIndex((s) => s.name === value(name)));
  }
  let offset = 0;
  if (f.dayToken) {
    const v = value(f.dayToken) as number;
    if (!Number.isSafeInteger(v)) return null;
    offset = v - (f.dayToken.field === "day" ? 1 : 0);
  }
  // the top occurrence must lie on the day line before anything below it is asked for (a sixteen-digit year)
  const top = f.chain[0]!;
  const ti = indices[0]!;
  if (Math.abs(ti) > 3 * DAY_LIMIT) return null;
  const start = engine.start(top, ti);
  const end = engine.start(top, ti + 1);
  // the occurrence must overlap the day line (the last year on it runs past the limit; its days up to the limit are real).
  // A second layer: parseDay also drops any day past the limit. This one keeps the engine from being asked about
  // occurrences the validator never checked (it proves slot sums on the day line only).
  if (start > DAY_LIMIT || end <= -DAY_LIMIT) return null;
  if (f.chain.length === 1) return offset >= 0 && offset < end - start ? start + offset : null;
  // down the chain: each slot in range, not empty, and (above the leaf) not a filler slot, which has no children
  const path = [ti];
  for (let j = 1; j < f.chain.length; j++) {
    const id = f.chain[j]!;
    const u = engine.ast.units.find((x) => x.id === id) as SlotsUnitAst;
    const slot = indices[j]!;
    if (slot < 0 || slot >= u.slots.length) return null;
    const lens = engine.slotLengths(id, path);
    if (lens[slot]! === 0) return null;
    if (j < f.chain.length - 1) {
      if (u.slots[slot]!.filler) return null;
      path.push(slot);
      continue;
    }
    if (offset < 0 || offset >= lens[slot]!) return null;
    return engine.dayOf(id, path, slot, offset);
  }
  return null;
}

/**
 * The day that `text` names under the named pattern, or under the first
 * parseable pattern that formats back to exactly `text`; null when none does.
 * A format-only pattern cannot be named here (it would have to guess).
 */
export function parseDay(engine: Engine, text: string, name?: string): number | null {
  if (name !== undefined && !isParseable(engine, name)) throw new RangeError(`format "${name}" is format-only: its tokens do not name a single day`);
  const automatic = new Set([pick(engine, undefined).name, "filler"]);
  // naming the default or the filler pattern names the automatic spelling, which is either of them
  const all = [...formatsOf(engine).values()].filter((f) => f.chain);
  const tries = name === undefined ? all : automatic.has(name) ? all.filter((f) => automatic.has(f.name)) : [pick(engine, name)];
  for (const f of tries) {
    // resolve checks every coordinate first, so the engine is only asked for days that exist
    const d = resolve(engine, f, text);
    if (d === null || Math.abs(d) > DAY_LIMIT) continue;
    // the default and filler patterns are one spelling, chosen per day, named or not; any other pattern is its own.
    // So "Hammer 1372 DR" (the filler pattern on a day that is not a festival) is not a second spelling of 1 Hammer.
    if ((automatic.has(f.name) ? formatDay(engine, d) : formatDay(engine, d, f.name)) === text) return d;
  }
  return null;
}
