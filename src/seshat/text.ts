/**
 * Seshat text (docs/SESHAT-v0.md §4.1): an iCalendar-shaped spelling of the
 * AST, one property per field. `print` is canonical; `parse(print(ast))`
 * deep-equals `ast`, and `print(parse(text)) === text` for canonical text.
 *
 * Lexical rules:
 * - a line is `KEY:VALUE`, KEY uppercase; blank lines are ignored, and a `#`
 *   in column 0 starts a comment line (`#` elsewhere is text);
 * - values escape `\ , ; : = #` with a backslash, a newline as `\n`, a
 *   carriage return as `\r`, and the empty string as `\0`; nothing is trimmed;
 * - a parameter list is `[positional;]KEY=VALUE;…`, lists are `,`-separated;
 * - numbers print as JavaScript's shortest round trip (`-0` kept), day
 *   literals as `D<n>`, rationals as `n` or `n/d` (lowest terms, d > 1), and
 *   a crossing's `at` (a day position) as `D<floor>` or `D<floor>+<n>/<d>`;
 * - a list that may be absent or empty prints an empty marker (`LABELS:`,
 *   `GEARS:` …) when it is empty, so absent and `[]` stay different values.
 *
 * Ids (units, gears, bodies, rules) are `[a-z][a-z0-9-]*`; the printer
 * refuses others. Host and throw rule leaves belong to Wadjet, not to a
 * calendar, and have no spelling.
 */
import type { BodyAst, CalendarAst, CycleRule, DayLabelAst, FormatAst, GearTerm, KeyedLength, LabelAst, LedgerEntry, RuleDefAst, SlotAst, StageAst, StageRule, UnitAst } from "./ast";
import type { GearAst } from "./gear";
import { gcd, type Rational } from "./rational";
import type { By, RuleAst } from "./rule";
import { RULE_DEPTH_MAX } from "./validate";

export const ID = /^[a-z][a-z0-9-]*$/;
const SPECIAL = new Set(["\\", ",", ";", ":", "=", "#"]);

export class SeshatSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = "SeshatSyntaxError";
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  if (s === "") return "\\0";
  let out = "";
  for (const ch of s) out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : SPECIAL.has(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * The text of an escaped value. Escaping is lexical, not layout: a raw special
 * character and a raw empty value are errors (the empty string is `\\0`), so
 * every value has one spelling.
 */
function unesc(s: string, line: number): string {
  if (s === "\\0") return "";
  if (s === "") throw new SeshatSyntaxError("an empty value is written \\0", line);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "\\") {
      if (SPECIAL.has(ch)) throw new SeshatSyntaxError(`"${ch}" must be escaped as "\\${ch}"`, line);
      out += ch;
      continue;
    }
    const next = s[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next !== undefined && SPECIAL.has(next)) out += next;
    else throw new SeshatSyntaxError(`bad escape "\\${next ?? ""}"`, line);
  }
  return out;
}

/** Split on `sep` where it is not escaped. */
function split(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s[++i]!;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The text before and after the first unescaped `sep`, or null. */
function cut(s: string, sep: string): [string, string] | null {
  const parts = split(s, sep);
  return parts.length < 2 ? null : [parts[0]!, parts.slice(1).join(sep)];
}

function num(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`cannot print ${x}`);
  return Object.is(x, -0) ? "-0" : String(x);
}

const NUM = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
function toNum(s: string, line: number): number {
  if (!NUM.test(s)) throw new SeshatSyntaxError(`"${s}" is not a number`, line);
  const x = Number(s);
  if (!Number.isFinite(x)) throw new SeshatSyntaxError(`"${s}" is not a finite number`, line);
  return x;
}

function day(x: number): string {
  if (!Number.isSafeInteger(x)) throw new RangeError(`day ${x} is not a whole day`);
  return `D${num(x)}`;
}
function toDay(s: string, line: number): number {
  if (!s.startsWith("D")) throw new SeshatSyntaxError(`"${s}" is not a day literal (D<n>)`, line);
  const x = toNum(s.slice(1), line);
  if (!Number.isSafeInteger(x)) throw new SeshatSyntaxError(`"${s}" is not a whole day`, line);
  return x;
}

/** A rational as stored; the parser reads only lowest terms with a positive denominator, so nothing else is printed. */
function ratText(r: Rational): string {
  fields(r, "a rational", "n", "d");
  if (!Number.isSafeInteger(r.n) || !Number.isSafeInteger(r.d) || r.d < 1 || gcd(r.n, r.d) !== 1) throw new RangeError(`${num(r.n)}/${num(r.d)} is not a rational in lowest terms`);
  return r.d === 1 ? num(r.n) : `${num(r.n)}/${num(r.d)}`;
}
function toRat(s: string, line: number): Rational {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(s);
  if (!m) throw new SeshatSyntaxError(`"${s}" is not a rational (n or n/d)`, line);
  const n = Number(m[1]);
  const d = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) throw new SeshatSyntaxError(`"${s}" is past the safe integers`, line);
  if (m[2] !== undefined && (d < 2 || gcd(n, d) !== 1)) throw new SeshatSyntaxError(`"${s}" is not in lowest terms with a denominator above 1`, line);
  return { n, d };
}

/** A day position: D<floor> or D<floor>+<r>/<d> with 0 < r < d. Exact for safe integers. */
function dayRatText(x: Rational): string {
  ratText(x);
  if (x.d === 1) return day(x.n);
  let r = x.n % x.d;
  let q = (x.n - r) / x.d;
  if (r < 0) {
    r += x.d;
    q -= 1;
  }
  return `D${num(q)}+${num(r)}/${num(x.d)}`;
}
function toDayRat(s: string, line: number): Rational {
  const m = /^D(-?\d+)(?:\+(\d+)\/(\d+))?$/.exec(s);
  if (!m) throw new SeshatSyntaxError(`"${s}" is not a day position (D<n> or D<n>+<r>/<d>)`, line);
  const q = Number(m[1]);
  if (!Number.isSafeInteger(q)) throw new SeshatSyntaxError(`"${s}" is past the safe integers`, line);
  if (m[2] === undefined) return { n: q, d: 1 };
  const [r, d] = [Number(m[2]), Number(m[3])];
  if (!Number.isSafeInteger(d) || !(r > 0 && r < d) || gcd(r, d) !== 1) throw new SeshatSyntaxError(`"${s}": the fraction must be proper and in lowest terms`, line);
  // exactly: q·d alone can pass 2^53 and round before r is added
  const n = BigInt(q) * BigInt(d) + BigInt(r);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) throw new SeshatSyntaxError(`"${s}" is past the safe integers`, line);
  return { n: Number(n), d };
}

const list = (xs: readonly string[]) => xs.join(",");
const toList = (s: string): string[] => (s === "" ? [] : split(s, ","));

/**
 * The printer writes every field it knows; a field it does not know would
 * vanish on the next save, so it refuses instead (a stored calendar must
 * never lose data silently). Keys holding `undefined` count as absent.
 */
function fields(o: object, what: string, ...known: string[]): void {
  for (const [k, v] of Object.entries(o)) if (v !== undefined && !known.includes(k)) throw new RangeError(`${what} has a field "${k}" with no text form`);
}

function id(s: string): string {
  if (!ID.test(s)) throw new RangeError(`"${s}" is not an id ([a-z][a-z0-9-]*)`);
  return s;
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

export function print(ast: CalendarAst): string {
  fields(ast, "the calendar", "name", "formats", "bodies", "gears", "units", "days", "rules");
  for (const f of ast.formats ?? []) fields(f, `format "${f.name}"`, "name", "pattern");
  for (const b of ast.bodies ?? []) fields(b, `body "${b.id}"`, "id", "period", "epoch");
  const head = ["BEGIN:VCALENDAR", "SESHAT:1", `NAME:${esc(ast.name)}`];
  if (ast.bodies?.length === 0) head.push("BODIES:");
  if (ast.days?.length === 0) head.push("DAYS:");
  if (ast.rules?.length === 0) head.push("RULES:");
  if (ast.formats?.length === 0) head.push("FORMATS:");
  for (const f of ast.formats ?? []) head.push(`FORMAT:${esc(f.name)}=${esc(f.pattern)}`);
  const chunks: string[][] = [head];
  for (const b of ast.bodies ?? []) chunks.push(block("VBODY", [`UID:${id(b.id)}`, `PERIOD:${ratText(b.period)}`, `EPOCH:${ratText(b.epoch)}`]));
  for (const g of ast.gears) chunks.push(block("VGEAR", gearLines(g)));
  for (const u of ast.units) chunks.push(block("VUNIT", unitLines(u)));
  if (ast.days?.length) chunks.push(ast.days.map(dayLine));
  for (const r of ast.rules ?? []) chunks.push(block("VRULE", ruleDefLines(r)));
  chunks.push(["END:VCALENDAR"]);
  return chunks.map((c) => c.join("\n")).join("\n\n") + "\n";
}

const block = (type: string, lines: readonly string[]) => [`BEGIN:${type}`, ...lines, `END:${type}`];
const tags = (t: readonly string[], key = "TAGS:") => `${key}${list(t.map(esc))}`;

/** Gears read as RRULE/EXRULE (§4): `on` sits in every term (FREQ) or in POSITIONS (ON); an `ON:` line only for a gear with no terms. */
function gearLines(g: GearAst): string[] {
  if (g.kind === "positions") fields(g, `gear "${g.id}"`, "id", "on", "kind", "period", "positions", "offset");
  else {
    fields(g, `gear "${g.id}"`, "id", "on", "kind", "terms");
    for (const t of g.terms) fields(t, `a term of gear "${g.id}"`, "every", "offset", "sign");
  }
  const out = [`UID:${id(g.id)}`];
  if (g.kind === "positions") out.push(`POSITIONS:ON=${id(g.on)};PERIOD=${num(g.period)};AT=${list(g.positions.map(num))}${g.offset !== undefined ? `;OFFSET=${num(g.offset)}` : ""}`);
  else if (g.terms.length === 0) out.push(`ON:${id(g.on)}`);
  else for (const t of g.terms) out.push(`${t.sign === -1 ? "EXRULE" : "RRULE"}:FREQ=${id(g.on)};INTERVAL=${num(t.every)}${t.offset !== undefined ? `;OFFSET=${num(t.offset)}` : ""}`);
  return out;
}

function baseLines(r: CycleRule): string[] {
  const out: string[] = [];
  if (r.crossing !== undefined) {
    const c = r.crossing;
    fields(c, "a crossing", "period", "at", "index");
    if (c.index) fields(c.index, "a crossing index", "a", "c", "L");
    out.push(`CROSSING:${ratText(c.period)}@${dayRatText(c.at)}${c.index ? `;INDEX=${num(c.index.a)}/${num(c.index.c)}/${num(c.index.L)}` : ""}`);
  } else out.push(`ANCHOR:${day(r.anchor)}`, `LENGTH:${num(r.length)}`);
  out.push(...gearTermLines(r.gears));
  if (r.stages?.length === 0) out.push("STAGES:");
  for (const s of r.stages ?? []) out.push(...block("VSTAGE", s.rules.map(stageRuleLine)));
  return out;
}

function gearTermLines(gears: readonly GearTerm[] | undefined): string[] {
  if (gears?.length === 0) return ["GEARS:"];
  return (gears ?? []).map((t) => {
    fields(t, "a gear term", "gear", "add");
    return `GEAR:${id(t.gear)}*${num(t.add)}`;
  });
}

function stageRuleLine(r: StageRule): string {
  if ("residue" in r) {
    fields(r, "a stage rule", "add", "residue");
    fields(r.residue, "a residue", "mod", "offset", "in");
  } else {
    fields(r, "a stage rule", "add", "length");
    fields(r.length, "a stage length", "at", "is");
  }
  if ("residue" in r) return `RESIDUE:${num(r.residue.mod)}${r.residue.offset !== undefined ? `;OFFSET=${num(r.residue.offset)}` : ""};IN=${list(r.residue.in.map(num))};ADD=${num(r.add)}`;
  return `LENGTH:AT=${num(r.length.at)};IS=${num(r.length.is)};ADD=${num(r.add)}`;
}

function unitLines(u: UnitAst): string[] {
  if (u.kind === "slots") fields(u, `unit "${u.id}"`, "id", "kind", "number", "in", "slots");
  else fields(u, `unit "${u.id}"`, "id", "kind", "number", "anchor", "length", "crossing", "gears", "stages", "labels", "ledger");
  for (const s of (u.kind === "cycle" ? u.stages : undefined) ?? []) fields(s, `a stage of "${u.id}"`, "rules");
  const out = [`UID:${id(u.id)}`];
  if (u.number !== undefined) out.push(`NUMBER:${num(u.number)}`);
  if (u.kind === "slots") {
    out.push(`IN:${id(u.in)}`);
    for (const s of u.slots) out.push(...slotLines(s));
    return out;
  }
  out.push(...baseLines(u));
  if (u.labels?.length === 0) out.push("LABELS:");
  for (const l of u.labels ?? []) out.push(...labelLines(l));
  if (u.ledger?.length === 0) out.push("LEDGER:");
  for (const e of u.ledger ?? []) out.push(...ledgerLines(e));
  return out;
}

function labelLines(l: LabelAst): string[] {
  fields(l, "a label", "name", "tags");
  if (l.name !== undefined && l.tags === undefined) return [`LABEL:${esc(l.name)}`];
  return block("VLABEL", [...(l.name !== undefined ? [`NAME:${esc(l.name)}`] : []), ...(l.tags !== undefined ? [tags(l.tags)] : [])]);
}

function slotLines(s: SlotAst): string[] {
  fields(s, `slot "${s.name ?? ""}"`, "name", "tags", "length", "min", "max", "fill", "gears", "filler");
  if (typeof s.length === "object") fields(s.length, "a keyed length", "by", "table");
  const plain = s.name !== undefined && typeof s.length === "number" && s.tags === undefined && s.min === undefined && s.max === undefined && s.fill === undefined && s.gears === undefined && s.filler === undefined;
  if (plain) return [`SLOT:${esc(s.name)}=${num(s.length)}`];
  const len = typeof s.length === "number" ? num(s.length) : s.length === "slack" ? "SLACK" : `KEYED;TABLE=${list(s.length.table.map(([p, l]) => `${num(p)}:${num(l)}`))}`;
  const bounds = [s.min !== undefined ? `;MIN=${num(s.min)}` : "", s.max !== undefined ? `;MAX=${num(s.max)}` : "", s.fill !== undefined ? `;FILL=${num(s.fill)}` : ""].join("");
  return block("VSLOT", [
    ...(s.name !== undefined ? [`NAME:${esc(s.name)}`] : []),
    ...(s.tags !== undefined ? [tags(s.tags)] : []),
    `LENGTH:${len}${bounds}`,
    ...gearTermLines(s.gears),
    ...(s.filler !== undefined ? [`FILLER:${s.filler ? "TRUE" : "FALSE"}`] : []),
  ]);
}

function ledgerLines(e: LedgerEntry): string[] {
  if (e.kind === "switch") {
    fields(e, "a ledger switch", "kind", "from", "rule");
    fields(e.rule, "a switch rule", "anchor", "length", "crossing", "gears", "stages");
  } else if (e.kind === "starts") fields(e, "a ledger pin", "kind", "from", "startsOn", "lengths");
  else fields(e, "a ledger slot override", "kind", "from", "unit", "path", "lengths");
  for (const s of (e.kind === "switch" ? e.rule.stages : undefined) ?? []) fields(s, "a stage of a switch", "rules");
  if (e.kind === "switch") return block("VSWITCH", [`FROM:${num(e.from)}`, ...baseLines(e.rule)]);
  if (e.kind === "starts") return [`STARTS:FROM=${num(e.from)};ON=${day(e.startsOn)}${e.lengths !== undefined ? `;LENGTHS=${list(e.lengths.map(num))}` : ""}`];
  return [`SLOTS:FROM=${num(e.from)};UNIT=${id(e.unit)}${e.path !== undefined ? `;PATH=${list(e.path.map(num))}` : ""};LENGTHS=${list(e.lengths.map(num))}`];
}

function dayLine(d: DayLabelAst): string {
  fields(d, "a day label", "day", "name", "tags");
  return `RDATE:${day(d.day)}${d.name !== undefined ? `;NAME=${esc(d.name)}` : ""}${d.tags !== undefined ? `;${tags(d.tags, "TAGS=")}` : ""}`;
}

function ruleDefLines(r: RuleDefAst): string[] {
  fields(r, `rule "${r.id}"`, "id", "rule", "tags");
  return [`UID:${id(r.id)}`, ...(r.tags !== undefined ? [tags(r.tags)] : []), ...ruleLines(r.rule)];
}

const NODE_FIELDS: Record<string, readonly string[]> = {
  all: ["kind", "of"],
  any: ["kind", "of"],
  not: ["kind", "of"],
  phase: ["kind", "unit", "body", "from", "to"],
  dayIn: ["kind", "unit", "from", "to"],
  index: ["kind", "unit", "from", "to"],
  tag: ["kind", "tag"],
  dates: ["kind", "days"],
  recur: ["kind", "freq", "interval", "anchor", "by", "setpos", "count", "until"],
};

/** One rule node as lines; nesting past RULE_DEPTH_MAX is refused here as the validator refuses it (the parser would). */
export function ruleLines(r: RuleAst, depth = 0): string[] {
  if (depth > RULE_DEPTH_MAX) throw new RangeError(`rules nest deeper than ${RULE_DEPTH_MAX}`);
  const known = NODE_FIELDS[r.kind];
  if (known) fields(r, `a "${r.kind}" rule`, ...known);
  switch (r.kind) {
    case "all":
    case "any":
      return block(r.kind.toUpperCase(), r.of.flatMap((q) => ruleLines(q, depth + 1)));
    case "not":
      return block("NOT", ruleLines(r.of, depth + 1));
    case "phase":
      return [`PHASE:${[r.unit !== undefined ? `UNIT=${id(r.unit)}` : "", r.body !== undefined ? `BODY=${id(r.body)}` : "", `FROM=${num(r.from)}`, `TO=${num(r.to)}`].filter(Boolean).join(";")}`];
    case "dayIn":
      return [`DAYIN:UNIT=${id(r.unit)};FROM=${num(r.from)};TO=${num(r.to)}`];
    case "index":
      return [`INDEX:${[`UNIT=${id(r.unit)}`, r.from !== undefined ? `FROM=${num(r.from)}` : "", r.to !== undefined ? `TO=${num(r.to)}` : ""].filter(Boolean).join(";")}`];
    case "tag":
      return [`TAG:${esc(r.tag)}`];
    case "dates":
      return [`DATES:${list(r.days.map(day))}`];
    case "recur": {
      const p = [`FREQ=${id(r.freq)}`];
      if (r.interval !== undefined) p.push(`INTERVAL=${num(r.interval)}`);
      if (r.anchor !== undefined) p.push(`ANCHOR=${day(r.anchor)}`);
      if (r.by?.length === 0) p.push("BY=");
      for (const b of r.by ?? []) p.push(byParam(b));
      if (r.setpos !== undefined) p.push(`SETPOS=${list(r.setpos.map(num))}`);
      if (r.count !== undefined) p.push(`COUNT=${num(r.count)}`);
      if (r.until !== undefined) p.push(`UNTIL=${day(r.until)}`);
      return [`RRULE:${p.join(";")}`];
    }
    default:
      throw new RangeError(`a "${r.kind}" rule has no text form (it belongs to Wadjet, not to a calendar)`);
  }
}

function byParam(b: By): string {
  fields(b, "a recur filter", "unit", "nth", "label", "day");
  if ("nth" in b) return `BYNTH=${id(b.unit)}:${list(b.nth.map(num))}`;
  if ("label" in b) return `BYLABEL=${id(b.unit)}:${list(b.label.map(esc))}`;
  return `BYDAY=${id(b.unit)}:${list(b.day.map(num))}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface Line {
  readonly key: string;
  readonly value: string;
  readonly no: number;
}
interface Component {
  readonly type: string;
  readonly no: number;
  readonly items: ReadonlyArray<{ readonly line: Line } | { readonly block: Component }>;
}

function lex(text: string): Line[] {
  const out: Line[] = [];
  const raw = (text.startsWith("\uFEFF") ? text.slice(1) : text).split("\n");
  for (const [i, l0] of raw.entries()) {
    const l = l0.endsWith("\r") ? l0.slice(0, -1) : l0;
    if (l === "" || l.startsWith("#")) continue;
    const m = /^([A-Z][A-Z-]*):(.*)$/s.exec(l);
    if (!m) throw new SeshatSyntaxError(`expected KEY:VALUE, got "${l}"`, i + 1);
    out.push({ key: m[1]!, value: m[2]!, no: i + 1 });
  }
  return out;
}

/** Deepest BEGIN nesting accepted: real calendars and rules stay under ten; the parser recurses per level. */
export const NESTING_MAX = 200;

function components(lines: Line[]): Component {
  let i = 0;
  const read = (type: string, no: number, depth: number): Component => {
    if (depth > NESTING_MAX) throw new SeshatSyntaxError(`blocks nest deeper than ${NESTING_MAX}`, no);
    const items: Array<{ line: Line } | { block: Component }> = [];
    while (i < lines.length) {
      const l = lines[i++]!;
      if (l.key === "END") {
        if (l.value !== type) throw new SeshatSyntaxError(`END:${l.value} closes BEGIN:${type}`, l.no);
        return { type, no, items };
      }
      if (l.key === "BEGIN") items.push({ block: read(l.value, l.no, depth + 1) });
      else items.push({ line: l });
    }
    throw new SeshatSyntaxError(`BEGIN:${type} is never closed`, no);
  };
  const first = lines[i++];
  if (!first || first.key !== "BEGIN" || first.value !== "VCALENDAR") throw new SeshatSyntaxError("a calendar starts with BEGIN:VCALENDAR", first?.no ?? 1);
  const cal = read("VCALENDAR", first.no, 0);
  if (i < lines.length) throw new SeshatSyntaxError("text after END:VCALENDAR", lines[i]!.no);
  return cal;
}

/** Checked access to a component's lines and blocks. */
class Props {
  constructor(
    private readonly c: Component,
    lines: readonly string[],
    blocks: readonly string[],
  ) {
    for (const it of c.items) {
      if ("line" in it && !lines.includes(it.line.key)) throw new SeshatSyntaxError(`${c.type} has no property ${it.line.key}`, it.line.no);
      if ("block" in it && !blocks.includes(it.block.type)) throw new SeshatSyntaxError(`${c.type} cannot hold ${it.block.type}`, it.block.no);
    }
  }
  all(key: string): Line[] {
    return this.c.items.flatMap((it) => ("line" in it && it.line.key === key ? [it.line] : []));
  }
  one(key: string): Line | undefined {
    const ls = this.all(key);
    if (ls.length > 1) throw new SeshatSyntaxError(`${this.c.type} has ${key} twice`, ls[1]!.no);
    return ls[0];
  }
  req(key: string): Line {
    const l = this.one(key);
    if (!l) throw new SeshatSyntaxError(`${this.c.type} needs ${key}`, this.c.no);
    return l;
  }
  /** an empty marker (`LABELS:`): present means the list is present, even when no item follows */
  marker(key: string): boolean {
    const l = this.one(key);
    if (l && l.value !== "") throw new SeshatSyntaxError(`${key} is a marker and takes no value`, l.no);
    return !!l;
  }
  /** lines with these keys and blocks of these types, in stored order */
  seq(keys: readonly string[], types: readonly string[]): Array<{ line: Line } | { block: Component }> {
    return this.c.items.filter((it) => ("line" in it ? keys.includes(it.line.key) : types.includes(it.block.type)));
  }
  blocks(type: string): Component[] {
    return this.c.items.flatMap((it) => ("block" in it && it.block.type === type ? [it.block] : []));
  }
}

/** `[positional;]K=V;…` with each key at most once unless listed in `many`. */
function params(l: Line, allowed: readonly string[], many: readonly string[] = []): { pos: string | undefined; get: (k: string) => string | undefined; each: Array<[string, string]> } {
  const parts = split(l.value, ";");
  let pos: string | undefined;
  const each: Array<[string, string]> = [];
  for (const [i, p] of parts.entries()) {
    const kv = cut(p, "=");
    if (!kv || !/^[A-Z]+$/.test(kv[0])) {
      if (i > 0) throw new SeshatSyntaxError(`"${p}" in ${l.key} is not KEY=VALUE`, l.no);
      pos = p;
      continue;
    }
    if (!allowed.includes(kv[0])) throw new SeshatSyntaxError(`${l.key} has no parameter ${kv[0]}`, l.no);
    if (!many.includes(kv[0]) && each.some(([k]) => k === kv[0])) throw new SeshatSyntaxError(`${l.key} has ${kv[0]} twice`, l.no);
    each.push(kv);
  }
  return { pos, get: (k) => each.find(([x]) => x === k)?.[1], each };
}

function need<T>(x: T | undefined, what: string, l: Line): T {
  if (x === undefined) throw new SeshatSyntaxError(`${l.key} needs ${what}`, l.no);
  return x;
}

function toId(s: string, l: Line): string {
  if (!ID.test(s)) throw new SeshatSyntaxError(`"${s}" is not an id ([a-z][a-z0-9-]*)`, l.no);
  return s;
}

const nums = (s: string, l: Line) => toList(s).map((x) => toNum(x, l.no));
const texts = (s: string, l: Line) => toList(s).map((x) => unesc(x, l.no));

export function parse(text: string): CalendarAst {
  const cal = components(lex(text));
  const p = new Props(cal, ["SESHAT", "NAME", "BODIES", "DAYS", "RULES", "FORMATS", "FORMAT", "RDATE"], ["VBODY", "VGEAR", "VUNIT", "VRULE"]);
  const version = p.req("SESHAT");
  if (version.value !== "1") throw new SeshatSyntaxError(`SESHAT:${version.value} is not a version this reader knows (1)`, version.no);
  const bodiesMarked = p.marker("BODIES");
  const daysMarked = p.marker("DAYS");
  const rulesMarked = p.marker("RULES");
  const bodies = p.blocks("VBODY").map(body);
  const days = p.all("RDATE").map(dayLabel);
  const rules = p.blocks("VRULE").map(ruleDef);
  const formatsMarked = p.marker("FORMATS");
  const formats = p.all("FORMAT").map((l): FormatAst => {
    const kv = cut(l.value, "=");
    if (!kv) throw new SeshatSyntaxError("FORMAT is <name>=<pattern>", l.no);
    return { name: unesc(kv[0], l.no), pattern: unesc(kv[1], l.no) };
  });
  return {
    name: unesc(p.req("NAME").value, p.req("NAME").no),
    ...(formats.length || formatsMarked ? { formats } : {}),
    ...(bodies.length || bodiesMarked ? { bodies } : {}),
    gears: p.blocks("VGEAR").map(gear),
    units: p.blocks("VUNIT").map(unit),
    ...(days.length || daysMarked ? { days } : {}),
    ...(rules.length || rulesMarked ? { rules } : {}),
  };
}

function body(c: Component): BodyAst {
  const p = new Props(c, ["UID", "PERIOD", "EPOCH"], []);
  const [u, per, ep] = [p.req("UID"), p.req("PERIOD"), p.req("EPOCH")];
  return { id: toId(u.value, u), period: toRat(per.value, per.no), epoch: toRat(ep.value, ep.no) };
}

function gear(c: Component): GearAst {
  const p = new Props(c, ["UID", "ON", "POSITIONS", "RRULE", "EXRULE"], []);
  const u = p.req("UID");
  const gid = toId(u.value, u);
  const pos = p.one("POSITIONS");
  const termLines = p.seq(["RRULE", "EXRULE"], []).map((it) => (it as { line: Line }).line);
  const onLine = p.one("ON");
  if ([pos, onLine, termLines.length ? termLines : undefined].filter(Boolean).length !== 1) throw new SeshatSyntaxError("a gear has POSITIONS, or RRULE/EXRULE terms, or (with no terms) ON", c.no);
  if (pos) {
    const q = params(pos, ["ON", "PERIOD", "AT", "OFFSET"]);
    if (q.pos !== undefined) throw new SeshatSyntaxError("POSITIONS takes only parameters", pos.no);
    const off = q.get("OFFSET");
    return { id: gid, on: toId(need(q.get("ON"), "ON", pos), pos), kind: "positions", period: toNum(need(q.get("PERIOD"), "PERIOD", pos), pos.no), positions: nums(need(q.get("AT"), "AT", pos), pos), ...(off !== undefined ? { offset: toNum(off, pos.no) } : {}) };
  }
  if (onLine) return { id: gid, on: toId(onLine.value, onLine), kind: "intervals", terms: [] };
  const on = new Set<string>();
  const terms = termLines.map((l): Extract<GearAst, { kind: "intervals" }>["terms"][number] => {
    const q = params(l, ["FREQ", "INTERVAL", "OFFSET"]);
    if (q.pos !== undefined) throw new SeshatSyntaxError(`${l.key} takes only parameters`, l.no);
    on.add(toId(need(q.get("FREQ"), "FREQ", l), l));
    const off = q.get("OFFSET");
    return { every: toNum(need(q.get("INTERVAL"), "INTERVAL", l), l.no), ...(off !== undefined ? { offset: toNum(off, l.no) } : {}), sign: (l.key === "EXRULE" ? -1 : 1) };
  });
  if (on.size !== 1) throw new SeshatSyntaxError("every term of a gear reads the same unit (one FREQ)", termLines[0]!.no);
  return { id: gid, on: [...on][0]!, kind: "intervals", terms };
}

const BASE_LINES = ["CROSSING", "ANCHOR", "LENGTH", "GEAR", "GEARS", "STAGES"];

function cycleRule(p: Props, c: Component): CycleRule {
  const cross = p.one("CROSSING");
  const gearsMarked = p.marker("GEARS");
  const gears = p.all("GEAR").map(gearTerm);
  const stagesMarked = p.marker("STAGES");
  const stages = p.blocks("VSTAGE").map(stage);
  const layers = { ...(gears.length || gearsMarked ? { gears } : {}), ...(stages.length || stagesMarked ? { stages } : {}) };
  if (cross) {
    if (p.one("ANCHOR") || p.one("LENGTH")) throw new SeshatSyntaxError("a base is CROSSING or ANCHOR + LENGTH, not both", cross.no);
    const q = params(cross, ["INDEX"]);
    const at = cut(need(q.pos, "<period>@<at>", cross), "@");
    if (!at) throw new SeshatSyntaxError("CROSSING is <period>@<at>", cross.no);
    const ix = q.get("INDEX");
    let index: { a: number; c: number; L: number } | undefined;
    if (ix !== undefined) {
      const parts = ix.split("/");
      if (parts.length !== 3) throw new SeshatSyntaxError("INDEX is <a>/<c>/<L>", cross.no);
      index = { a: toNum(parts[0]!, cross.no), c: toNum(parts[1]!, cross.no), L: toNum(parts[2]!, cross.no) };
    }
    return { crossing: { period: toRat(at[0], cross.no), at: toDayRat(at[1], cross.no), ...(index ? { index } : {}) }, ...layers };
  }
  const [a, len] = [p.one("ANCHOR"), p.one("LENGTH")];
  if (!a || !len) throw new SeshatSyntaxError("a cycle needs CROSSING, or ANCHOR and LENGTH", c.no);
  return { anchor: toDay(a.value, a.no), length: toNum(len.value, len.no), ...layers };
}

function gearTerm(l: Line): GearTerm {
  const m = /^([a-z][a-z0-9-]*)\*(.+)$/.exec(l.value);
  if (!m) throw new SeshatSyntaxError("GEAR is <id>*<add>", l.no);
  return { gear: m[1]!, add: toNum(m[2]!, l.no) };
}

function stage(c: Component): StageAst {
  const p = new Props(c, ["RESIDUE", "LENGTH"], []);
  return {
    rules: p.seq(["RESIDUE", "LENGTH"], []).map((it): StageRule => {
      const l = (it as { line: Line }).line;
      if (l.key === "RESIDUE") {
        const q = params(l, ["OFFSET", "IN", "ADD"]);
        const off = q.get("OFFSET");
        return { add: toNum(need(q.get("ADD"), "ADD", l), l.no), residue: { mod: toNum(need(q.pos, "<mod>", l), l.no), ...(off !== undefined ? { offset: toNum(off, l.no) } : {}), in: nums(need(q.get("IN"), "IN", l), l) } };
      }
      const q = params(l, ["AT", "IS", "ADD"]);
      if (q.pos !== undefined) throw new SeshatSyntaxError("a stage LENGTH takes only parameters", l.no);
      return { add: toNum(need(q.get("ADD"), "ADD", l), l.no), length: { at: toNum(need(q.get("AT"), "AT", l), l.no), is: toNum(need(q.get("IS"), "IS", l), l.no) } };
    }),
  };
}

function unit(c: Component): UnitAst {
  const inLine = c.items.find((it) => "line" in it && it.line.key === "IN");
  if (inLine) {
    const p = new Props(c, ["UID", "NUMBER", "IN", "SLOT"], ["VSLOT"]);
    const [u, i] = [p.req("UID"), p.req("IN")];
    const slots = p.seq(["SLOT"], ["VSLOT"]).map((it) => ("line" in it ? slotLine(it.line) : slotBlock(it.block)));
    return { id: toId(u.value, u), kind: "slots", ...unitNumber(p), in: toId(i.value, i), slots };
  }
  const p = new Props(c, ["UID", "NUMBER", ...BASE_LINES, "LABEL", "LABELS", "LEDGER", "STARTS", "SLOTS"], ["VSTAGE", "VLABEL", "VSWITCH"]);
  const u = p.req("UID");
  const labelsMarked = p.marker("LABELS");
  const labels = p.seq(["LABEL"], ["VLABEL"]).map((it) => ("line" in it ? { name: unesc(it.line.value, it.line.no) } : labelBlock(it.block)));
  const ledgerMarked = p.marker("LEDGER");
  const ledger = p.seq(["STARTS", "SLOTS"], ["VSWITCH"]).map((it) => ("line" in it ? ledgerLine(it.line) : ledgerSwitch(it.block)));
  return {
    id: toId(u.value, u),
    kind: "cycle",
    ...unitNumber(p),
    ...cycleRule(p, c),
    ...(labels.length || labelsMarked ? { labels } : {}),
    ...(ledger.length || ledgerMarked ? { ledger } : {}),
  };
}

function unitNumber(p: Props): { number?: number } {
  const n = p.one("NUMBER");
  return n ? { number: toNum(n.value, n.no) } : {};
}

function labelBlock(c: Component): LabelAst {
  const p = new Props(c, ["NAME", "TAGS"], []);
  const [n, t] = [p.one("NAME"), p.one("TAGS")];
  return { ...(n ? { name: unesc(n.value, n.no) } : {}), ...(t ? { tags: texts(t.value, t) } : {}) };
}

function slotLine(l: Line): SlotAst {
  const kv = cut(l.value, "=");
  if (!kv) throw new SeshatSyntaxError("SLOT is <name>=<length>", l.no);
  return { name: unesc(kv[0], l.no), length: toNum(kv[1], l.no) };
}

function slotBlock(c: Component): SlotAst {
  const p = new Props(c, ["NAME", "TAGS", "LENGTH", "GEAR", "GEARS", "FILLER"], []);
  const [n, t, len, f] = [p.one("NAME"), p.one("TAGS"), p.req("LENGTH"), p.one("FILLER")];
  const q = params(len, ["TABLE", "MIN", "MAX", "FILL"]);
  const kind = need(q.pos, "a length, SLACK or KEYED", len);
  let length: SlotAst["length"];
  if (kind === "SLACK") length = "slack";
  else if (kind === "KEYED") {
    const table = toList(need(q.get("TABLE"), "TABLE", len)).map((row): readonly [number, number] => {
      const kv = cut(row, ":");
      if (!kv) throw new SeshatSyntaxError("a TABLE row is <parent length>:<length>", len.no);
      return [toNum(kv[0], len.no), toNum(kv[1], len.no)];
    });
    length = { by: "parent", table } satisfies KeyedLength;
  } else length = toNum(kind, len.no);
  if (kind !== "KEYED" && q.get("TABLE") !== undefined) throw new SeshatSyntaxError("TABLE belongs to a KEYED length", len.no);
  const [mn, mx, fl] = [q.get("MIN"), q.get("MAX"), q.get("FILL")];
  const gearsMarked = p.marker("GEARS");
  const gears = p.all("GEAR").map(gearTerm);
  if (f && f.value !== "TRUE" && f.value !== "FALSE") throw new SeshatSyntaxError("FILLER is TRUE or FALSE", f.no);
  return {
    ...(n ? { name: unesc(n.value, n.no) } : {}),
    ...(t ? { tags: texts(t.value, t) } : {}),
    length,
    ...(mn !== undefined ? { min: toNum(mn, len.no) } : {}),
    ...(mx !== undefined ? { max: toNum(mx, len.no) } : {}),
    ...(fl !== undefined ? { fill: toNum(fl, len.no) } : {}),
    ...(gears.length || gearsMarked ? { gears } : {}),
    ...(f ? { filler: f.value === "TRUE" } : {}),
  };
}

function ledgerLine(l: Line): LedgerEntry {
  if (l.key === "STARTS") {
    const q = params(l, ["FROM", "ON", "LENGTHS"]);
    const lens = q.get("LENGTHS");
    return { kind: "starts", from: toNum(need(q.get("FROM"), "FROM", l), l.no), startsOn: toDay(need(q.get("ON"), "ON", l), l.no), ...(lens !== undefined ? { lengths: nums(lens, l) } : {}) };
  }
  const q = params(l, ["FROM", "UNIT", "PATH", "LENGTHS"]);
  const path = q.get("PATH");
  return { kind: "slots", from: toNum(need(q.get("FROM"), "FROM", l), l.no), unit: toId(need(q.get("UNIT"), "UNIT", l), l), ...(path !== undefined ? { path: nums(path, l) } : {}), lengths: nums(need(q.get("LENGTHS"), "LENGTHS", l), l) };
}

function ledgerSwitch(c: Component): LedgerEntry {
  const p = new Props(c, ["FROM", ...BASE_LINES], ["VSTAGE"]);
  const f = p.req("FROM");
  return { kind: "switch", from: toNum(f.value, f.no), rule: cycleRule(p, c) };
}

function dayLabel(l: Line): DayLabelAst {
  const q = params(l, ["NAME", "TAGS"]);
  const [n, t] = [q.get("NAME"), q.get("TAGS")];
  return { day: toDay(need(q.pos, "a day", l), l.no), ...(n !== undefined ? { name: unesc(n, l.no) } : {}), ...(t !== undefined ? { tags: texts(t, l) } : {}) };
}

const NODE_LINES = ["PHASE", "DAYIN", "INDEX", "TAG", "DATES", "RRULE"];
const NODE_BLOCKS = ["ALL", "ANY", "NOT"];

function ruleDef(c: Component): RuleDefAst {
  const p = new Props(c, ["UID", "TAGS", ...NODE_LINES], NODE_BLOCKS);
  const [u, t] = [p.req("UID"), p.one("TAGS")];
  const nodes = p.seq(NODE_LINES, NODE_BLOCKS);
  if (nodes.length !== 1) throw new SeshatSyntaxError("a VRULE holds exactly one rule", c.no);
  return { id: toId(u.value, u), ...(t ? { tags: texts(t.value, t) } : {}), rule: node(nodes[0]!) };
}

function node(it: { line: Line } | { block: Component }): RuleAst {
  if ("block" in it) {
    const c = it.block;
    const p = new Props(c, NODE_LINES, NODE_BLOCKS);
    const kids = p.seq(NODE_LINES, NODE_BLOCKS).map(node);
    if (c.type === "NOT") {
      if (kids.length !== 1) throw new SeshatSyntaxError("NOT holds exactly one rule", c.no);
      return { kind: "not", of: kids[0]! };
    }
    return { kind: c.type === "ALL" ? "all" : "any", of: kids };
  }
  const l = it.line;
  switch (l.key) {
    case "PHASE": {
      const q = params(l, ["UNIT", "BODY", "FROM", "TO"]);
      const [u, b] = [q.get("UNIT"), q.get("BODY")];
      return { kind: "phase", ...(u !== undefined ? { unit: toId(u, l) } : {}), ...(b !== undefined ? { body: toId(b, l) } : {}), from: toNum(need(q.get("FROM"), "FROM", l), l.no), to: toNum(need(q.get("TO"), "TO", l), l.no) };
    }
    case "DAYIN": {
      const q = params(l, ["UNIT", "FROM", "TO"]);
      return { kind: "dayIn", unit: toId(need(q.get("UNIT"), "UNIT", l), l), from: toNum(need(q.get("FROM"), "FROM", l), l.no), to: toNum(need(q.get("TO"), "TO", l), l.no) };
    }
    case "INDEX": {
      const q = params(l, ["UNIT", "FROM", "TO"]);
      const [f, t] = [q.get("FROM"), q.get("TO")];
      return { kind: "index", unit: toId(need(q.get("UNIT"), "UNIT", l), l), ...(f !== undefined ? { from: toNum(f, l.no) } : {}), ...(t !== undefined ? { to: toNum(t, l.no) } : {}) };
    }
    case "TAG":
      return { kind: "tag", tag: unesc(l.value, l.no) };
    case "DATES":
      return { kind: "dates", days: toList(l.value).map((x) => toDay(x, l.no)) };
    default:
      return recur(l);
  }
}

function recur(l: Line): RuleAst {
  const q = params(l, ["FREQ", "INTERVAL", "ANCHOR", "BY", "BYNTH", "BYLABEL", "BYDAY", "SETPOS", "COUNT", "UNTIL"], ["BYNTH", "BYLABEL", "BYDAY"]);
  if (q.pos !== undefined) throw new SeshatSyntaxError("RRULE takes only parameters", l.no);
  const by: By[] = [];
  for (const [k, v] of q.each) {
    if (k !== "BYNTH" && k !== "BYLABEL" && k !== "BYDAY") continue;
    const uv = cut(v, ":");
    if (!uv) throw new SeshatSyntaxError(`${k} is <unit>:<values>`, l.no);
    const u = toId(uv[0], l);
    by.push(k === "BYNTH" ? { unit: u, nth: nums(uv[1], l) } : k === "BYLABEL" ? { unit: u, label: texts(uv[1], l) } : { unit: u, day: nums(uv[1], l) });
  }
  const empty = q.get("BY");
  if (empty !== undefined && (empty !== "" || by.length)) throw new SeshatSyntaxError("BY= marks an empty filter list and stands alone", l.no);
  const [iv, an, sp, ct, un] = [q.get("INTERVAL"), q.get("ANCHOR"), q.get("SETPOS"), q.get("COUNT"), q.get("UNTIL")];
  return {
    kind: "recur",
    freq: toId(need(q.get("FREQ"), "FREQ", l), l),
    ...(iv !== undefined ? { interval: toNum(iv, l.no) } : {}),
    ...(an !== undefined ? { anchor: toDay(an, l.no) } : {}),
    ...(by.length || empty !== undefined ? { by } : {}),
    ...(sp !== undefined ? { setpos: nums(sp, l) } : {}),
    ...(ct !== undefined ? { count: toNum(ct, l.no) } : {}),
    ...(un !== undefined ? { until: toDay(un, l.no) } : {}),
  };
}
