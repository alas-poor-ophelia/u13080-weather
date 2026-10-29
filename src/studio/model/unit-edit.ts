/**
 * Edits to a cycle unit as a whole and to its labels (docs/SESHAT-v0.md
 * §18.3, §18.6 items 1 and 2; bead wadjet-b6x, slice 5e, the labelled cycle).
 * Pure: AST in, AST out, no DOM, no store.
 *
 * - `setCycleLabels` and `setCycleAnchor` write a unit's `cycle:` slice
 *   (anchor and labels, ast-edit.ts). A one-day labelled cycle (the weekday)
 *   and the plain cycle that runs with it (the week: as many days as there
 *   are labels, its anchor in step) are a PAIR, as the form reads them
 *   (form.ts `findWeek`): a label count change gives the week the new length,
 *   and an anchor move moves both by the same days, so they stay in step.
 * - `renameUnit` and `removeUnit` change what no slice holds (a unit's id,
 *   the formats and rules that name it), so a Save replays them as
 *   OPERATIONS: `unitOps` reads them off the base and the draft (the Orrery
 *   adds no unit: a unit of the base that the draft lacks was renamed or
 *   removed), and `replayUnitOps` makes them on the definition stored at
 *   Save time first, stale when the unit changed there since the seed, or
 *   when what is stored now refuses them (a rule added outside that reads a
 *   removed unit). The slices are then replayed as before.
 * - Every refusal names what is wrong in on-screen terms; `problems()` is the
 *   caller's.
 */
import { canonicalJson } from "../../core/profile";
import { ID, type By, type CalendarAst, type CycleUnitAst, type FormatAst, type LabelAst, type RuleAst, type RuleDefAst, type UnitAst } from "../../seshat";
import { declaredAs, weekdayCycle, withSlice, type AstEdit, type SliceKey } from "./ast-edit";

const refuse = (reason: string): AstEdit => ({ refused: true, reason });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x);
const mod = (a: number, m: number): number => {
  const r = a % m;
  return r < 0 ? r + m : r + 0;
};

function cycleUnit(ast: CalendarAst, id: string): CycleUnitAst | undefined {
  const u = ast.units.find((x) => x.id === id);
  return u?.kind === "cycle" ? u : undefined;
}

// ---- what names a unit

/** The unit ids a format pattern's tokens name (`{u}`, `{u:name}` …; `{{`, `}}` and `{@…}` name none). */
export function formatUnits(pattern: string): string[] {
  const out: string[] = [];
  mapPattern(pattern, (u) => {
    out.push(u);
    return u;
  });
  return out;
}

/** `pattern` with each token's unit id passed through `f`; literal text, escaped braces and placeholders as written. */
function mapPattern(pattern: string, f: (unit: string) => string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if ((ch === "{" || ch === "}") && pattern[i + 1] === ch) {
      out += ch + ch;
      i++;
      continue;
    }
    const end = ch === "{" ? pattern.indexOf("}", i) : -1;
    if (end < 0) {
      out += ch;
      continue;
    }
    const inner = pattern.slice(i + 1, end);
    if (inner.startsWith("@")) out += `{${inner}}`;
    else {
      const at = inner.indexOf(":");
      const unit = at < 0 ? inner : inner.slice(0, at);
      out += `{${f(unit)}${at < 0 ? "" : inner.slice(at)}}`;
    }
    i = end;
  }
  return out;
}

/** `r` with every unit id it reads passed through `f` (`r` itself when none changes). */
function mapRuleUnits(r: RuleAst, f: (unit: string) => string, depth = 0): RuleAst {
  if (depth > 256 || typeof r !== "object" || r === null) return r;
  const sub = (x: RuleAst): RuleAst => mapRuleUnits(x, f, depth + 1);
  switch (r.kind) {
    case "all":
    case "any": {
      const of = r.of.map(sub);
      return of.every((x, i) => x === r.of[i]) ? r : { ...r, of };
    }
    case "not":
    case "shift": {
      const of = sub(r.of);
      return of === r.of ? r : ({ ...r, of });
    }
    case "first": {
      const after = sub(r.after);
      const of = sub(r.of);
      return after === r.after && of === r.of ? r : { ...r, after, of };
    }
    case "phase":
    case "dayIn":
    case "index": {
      if (typeof r.unit !== "string") return r;
      const unit = f(r.unit);
      return unit === r.unit ? r : ({ ...r, unit });
    }
    case "recur": {
      const freq = f(r.freq);
      const by = r.by?.map((b): By => {
        const unit = f(b.unit);
        return unit === b.unit ? b : ({ ...b, unit });
      });
      const byChanged = by !== undefined && by.some((b, i) => b !== r.by![i]);
      if (freq === r.freq && !byChanged) return r;
      return { ...r, freq, ...(by ? { by } : {}) };
    }
    default:
      return r;
  }
}

/** How a rule reads a unit: by its labels (a BYLABEL filter) or by number (anything else: an index, a phase, a day, BYNTH, BYDAY, a frequency). */
export type UnitRead = { readonly rule: RuleDefAst; readonly how: "label" | "number"; readonly by?: By };

/** Every read of unit `id` in the named rules. */
export function unitReads(ast: CalendarAst, id: string): UnitRead[] {
  const out: UnitRead[] = [];
  for (const rule of ast.rules ?? []) {
    const walk = (r: RuleAst, depth: number): void => {
      if (depth > 256 || typeof r !== "object" || r === null) return;
      switch (r.kind) {
        case "all":
        case "any":
          for (const x of r.of) walk(x, depth + 1);
          return;
        case "not":
        case "shift":
          walk(r.of, depth + 1);
          return;
        case "first":
          walk(r.after, depth + 1);
          walk(r.of, depth + 1);
          return;
        case "phase":
        case "dayIn":
        case "index":
          if (r.unit === id) out.push({ rule, how: "number" });
          return;
        case "recur":
          if (r.freq === id) out.push({ rule, how: "number" });
          for (const b of r.by ?? []) if (typeof b === "object" && b !== null && b.unit === id) out.push({ rule, how: "label" in b ? "label" : "number", by: b });
          return;
        default:
          return;
      }
    };
    walk(rule.rule, 0);
  }
  return out;
}

const ruleName = (r: RuleDefAst): string => r.name ?? r.id;

/**
 * What reads unit `id`, in on-screen terms (empty when nothing does): the formats that print it, the rules that
 * read it, the seasons that divide it, the gears that count it, the slot units inside it, and the stages whose
 * weekday tests are titled by its labels.
 */
export function unitReaders(ast: CalendarAst, id: string): string[] {
  const out: string[] = [];
  for (const f of ast.formats ?? []) if (formatUnits(f.pattern).includes(id)) out.push(`the format "${f.name}" prints it`);
  const seen = new Set<string>();
  for (const r of unitReads(ast, id)) {
    if (seen.has(r.rule.id)) continue;
    seen.add(r.rule.id);
    out.push(`the rule "${ruleName(r.rule)}" reads it`);
  }
  if (ast.seasons?.unit === id) out.push("the seasons divide it");
  for (const g of ast.gears) if (g.on === id) out.push(`the gear "${g.id}" counts it`);
  for (const u of ast.units) if (u.kind === "slots" && u.in === id) out.push(`the ${u.id} sits in it`);
  for (const u of ast.units) {
    if (u.kind !== "cycle") continue;
    const mods = new Set((u.stages ?? []).flatMap((s) => s.rules.flatMap((r) => ("residue" in r ? [r.residue.mod] : []))));
    for (const m of mods) if (weekdayCycle(ast, m)?.id === id) out.push(`the ${u.id}'s stages name its days`);
  }
  return [...new Set(out)];
}

// ---- rename and remove

const ID_WORDS = "lower-case letters, digits and hyphens, starting with a letter";

/**
 * Rename unit `from` to `to`, and every place that names it: the formats' tokens, the rules' reads (BYLABEL and
 * the rest), the seasons, the gears that count it, the slot units inside it and the exceptions that set its slots.
 * The year is not renamed here (the form reads it by its id); an id another part declares is refused.
 */
export function renameUnit(ast: CalendarAst, from: string, to: string): AstEdit {
  const u = ast.units.find((x) => x.id === from);
  if (!u) return refuse(`there is no unit "${from}"`);
  const id = to.trim();
  if (id === from) return { ast };
  if (from === "year") return refuse("the year keeps its id: the form and the seasons read it by name");
  if (!ID.test(id)) return refuse(`a unit's id is ${ID_WORDS}; "${id}" is not one`);
  const taken = declaredAs(ast, id);
  if (taken) return refuse(`the id "${id}" is already taken by a ${taken}; units, gears, rules and bodies share one list of ids`);
  const f = (x: string): string => (x === from ? id : x);
  const units = ast.units.map((x): UnitAst => {
    let next: UnitAst = x.id === from ? { ...x, id } : x;
    if (next.kind === "slots" && next.in === from) next = { ...next, in: id };
    if (next.kind === "cycle" && next.ledger?.some((e) => e.kind === "slots" && e.unit === from)) next = { ...next, ledger: next.ledger.map((e) => (e.kind === "slots" && e.unit === from ? { ...e, unit: id } : e)) };
    return next;
  });
  const out: CalendarAst = {
    ...ast,
    units,
    gears: ast.gears.map((g) => (g.on === from ? { ...g, on: id } : g)),
    ...(ast.formats ? { formats: ast.formats.map((x): FormatAst => ({ ...x, pattern: mapPattern(x.pattern, f) })) } : {}),
    ...(ast.rules ? { rules: ast.rules.map((r) => ({ ...r, rule: mapRuleUnits(r.rule, f) })) } : {}),
    ...(ast.seasons ? { seasons: ast.seasons.unit === from ? { ...ast.seasons, unit: id } : ast.seasons } : {}),
  };
  return { ast: out };
}

/** Remove unit `id`; refused, naming the first reader, while anything reads it (`unitReaders`). */
export function removeUnit(ast: CalendarAst, id: string): AstEdit {
  const u = ast.units.find((x) => x.id === id);
  if (!u) return refuse(`there is no unit "${id}"`);
  if (id === "year") return refuse("the year is the calendar's own cycle; it cannot be removed");
  const readers = unitReaders(ast, id);
  if (readers.length) return refuse(`${readers[0]}${readers.length > 1 ? ` (and ${readers.length - 1} more)` : ""}; change that first`);
  return { ast: { ...ast, units: ast.units.filter((x) => x !== u) } };
}

// ---- labels and the anchor

/**
 * The plain cycle that runs with labelled one-day cycle `id` (the week beside the weekday, as the form reads them):
 * the one other constant cycle, not the year, as many days long as `id` has labels and with its anchor in step.
 * Undefined when there is none, or more than one.
 */
export function cyclePartner(ast: CalendarAst, id: string): (CycleUnitAst & { readonly anchor: number }) | undefined {
  const u = cycleUnit(ast, id);
  if (!u || u.crossing || u.length !== 1 || !u.labels?.length) return undefined;
  const n = u.labels.length;
  const found = ast.units.filter((x): x is CycleUnitAst => x.kind === "cycle" && x !== u && x.id !== "year" && !x.crossing && x.length === n && !x.labels?.length && !x.gears?.length && !x.stages?.length && !x.ledger?.length && mod(x.anchor - u.anchor, n) === 0);
  return found.length === 1 ? (found[0] as CycleUnitAst & { readonly anchor: number }) : undefined;
}

/** Whether label `l` carries `x` as a rule's label filter reads it (a name, or "#tag"). */
const carries = (l: LabelAst, x: string): boolean => (x.startsWith("#") ? (l.tags?.includes(x.slice(1)) ?? false) : l.name === x);

/**
 * Why unit `id`'s labels cannot become `labels` (`from[i]`: the index label i had, null for a new one), or null:
 * a rule's label filter on the unit would match other days. A changed count moves every day's label (occurrence k
 * carries label k mod count), so it is refused while any filter reads the unit by label; with the count kept, a
 * rename onto or away from a name a filter reads is refused.
 */
export function cycleLabelProblem(ast: CalendarAst, id: string, labels: readonly LabelAst[], from: ReadonlyArray<number | null>): string | null {
  const u = cycleUnit(ast, id);
  if (!u) return null;
  const was = u.labels ?? [];
  for (const r of unitReads(ast, id)) {
    if (r.how !== "label" || !r.by || !("label" in r.by)) continue;
    if (labels.length !== was.length) return `the rule "${ruleName(r.rule)}" reads the ${id} by its labels, and a new count moves every day's label; change it first (Edit definition)`;
    for (const x of r.by.label) {
      if (typeof x !== "string") continue;
      const before = was.flatMap((l, j) => (carries(l, x) ? [j] : []));
      const after = labels.flatMap((l, i) => (carries(l, x) ? [from[i] ?? -1] : [])).sort((a, b) => a - b);
      if (!same(after, before)) return `the rule "${ruleName(r.rule)}" reads the ${id} labelled "${x}"; change it first (Edit definition)`;
    }
  }
  return null;
}

/**
 * Set cycle unit `id`'s labels (`from` as in `cycleLabelProblem`; omitted: label for label). Its pair, the week,
 * takes the new count as its length, keeping its anchor while it still lines up (else the weekday's, as the form
 * does). Blank names are refused (a label without a name keeps none: its tags name it).
 */
export function setCycleLabels(ast: CalendarAst, id: string, labels: readonly LabelAst[], from?: ReadonlyArray<number | null>): AstEdit {
  const u = cycleUnit(ast, id);
  if (!u) return refuse(`there is no cycle unit "${id}"`);
  if (!u.labels?.length) return refuse(`the ${id} has no labels`);
  if (labels.length === 0) return refuse(`the ${id} needs at least one label; remove the cycle instead`);
  for (const l of labels) if (l.name !== undefined && (typeof l.name !== "string" || l.name.trim() === "")) return refuse("a label's name cannot be blank");
  const was = from ?? labels.map((_, i) => i);
  if (was.length !== labels.length) return refuse("every label needs to say where it came from");
  const why = cycleLabelProblem(ast, id, labels, was);
  if (why) return refuse(why);
  const partner = labels.length !== u.labels.length ? cyclePartner(ast, id) : undefined;
  let out = withSlice(ast, `cycle:${id}`, { ...(u.crossing ? {} : { anchor: u.anchor }), labels: labels.map((l) => ({ ...l })) });
  if (!out) return refuse(`there is no cycle unit "${id}"`);
  if (partner && !u.crossing) {
    const n = labels.length;
    const anchor = mod(partner.anchor - u.anchor, n) === 0 ? partner.anchor : u.anchor;
    out = withSlice(out, `length:${partner.id}`, n);
    out = out && withSlice(out, `cycle:${partner.id}`, { anchor });
    if (!out) return refuse(`the ${partner.id} cannot follow the ${id}`);
  }
  return { ast: out };
}

/**
 * Why unit `id`'s anchor cannot move, or null: a rule reads it by number (an index, a phase, a day, BYNTH, a
 * frequency, which would then match other days), a gear counts it, or an exception is written against its
 * occurrences. A label filter follows the labels, so it does not refuse the move.
 */
export function anchorProblem(ast: CalendarAst, id: string): string | null {
  const u = cycleUnit(ast, id);
  if (!u) return `there is no cycle unit "${id}"`;
  if (u.crossing) return `the ${id} starts by a crossing, so it has no anchor`;
  if (u.ledger?.length) return `the ${id} has exceptions written against its occurrences; change them first (Exceptions)`;
  const r = unitReads(ast, id).find((x) => x.how === "number");
  if (r) return `the rule "${ruleName(r.rule)}" reads the ${id} by number; change it first (Edit definition)`;
  const g = ast.gears.find((x) => x.on === id);
  if (g) return `the gear "${g.id}" counts the ${id}; it would engage on other days`;
  return null;
}

/**
 * Move cycle unit `id`'s anchor (the day its occurrence 0 starts) to `anchor`; its pair, the week, moves by the
 * same days, so the two stay in step (form.ts `findWeek` reads them together). Refused for `anchorProblem`'s
 * reasons, on the unit and on its pair.
 */
export function setCycleAnchor(ast: CalendarAst, id: string, anchor: number): AstEdit {
  const u = cycleUnit(ast, id);
  if (!u) return refuse(`there is no cycle unit "${id}"`);
  if (!isInt(anchor)) return refuse(`an anchor is a whole day; ${String(anchor)} is not one`);
  if (!u.crossing && anchor === u.anchor) return { ast };
  const why = anchorProblem(ast, id);
  if (why) return refuse(why);
  if (u.crossing) return refuse(`the ${id} starts by a crossing, so it has no anchor`);
  const partner = cyclePartner(ast, id);
  if (partner) {
    const p = anchorProblem(ast, partner.id);
    if (p) return refuse(`the ${partner.id} moves with the ${id}, and ${p.replace(/^the /, "")}`);
  }
  const delta = anchor - u.anchor;
  let out = withSlice(ast, `cycle:${id}`, { anchor, ...(u.labels ? { labels: u.labels } : {}) });
  if (out && partner) out = withSlice(out, `cycle:${partner.id}`, { anchor: partner.anchor + delta, ...(partner.labels ? { labels: partner.labels } : {}) });
  if (!out) return refuse(`there is no cycle unit "${id}"`);
  if (!isInt(anchor) || (partner && !isInt(partner.anchor + delta))) return refuse("that anchor is too far from day 0 to count exactly");
  return { ast: out };
}

/**
 * The anchor that puts label `label` on day `day`, nearest `anchor` (the unit's as the edit began, so a knob back
 * at its first label gives that anchor back exactly): occurrence k = floor((day − anchor) / length) carries label
 * k mod count, and the anchor moves by whole occurrences, at most half the labels either way.
 */
export function anchorFor(anchor: number, length: number, count: number, day: number, label: number): number {
  const k = Math.floor((day - anchor) / length);
  let shift = mod(label - k, count);
  if (shift > count / 2) shift -= count;
  return anchor - shift * length;
}

// ---- a Save: renames and removals replayed as operations

/** A change to a unit that no slice holds. */
export type UnitOp = { readonly kind: "rename"; readonly from: string; readonly to: string } | { readonly kind: "remove"; readonly id: string };

/**
 * The renames and removals that take `base`'s units to `draft`'s, in order, or null when the draft's units are not
 * the base's with some renamed and some removed (a unit added, or the order changed). Two lists are walked side by
 * side: an id both have is kept; a draft id the base lacks is the base unit at that place renamed; else the base
 * unit was removed.
 */
export function unitOps(base: CalendarAst, draft: CalendarAst): UnitOp[] | null {
  const ids = new Set(base.units.map((u) => u.id));
  const ops: UnitOp[] = [];
  let j = 0;
  for (let i = 0; i < base.units.length; i++) {
    const b = base.units[i]!;
    const d = draft.units[j];
    if (d && d.id === b.id) {
      j++;
      continue;
    }
    if (d && !ids.has(d.id) && d.kind === b.kind) {
      ops.push({ kind: "rename", from: b.id, to: d.id });
      j++;
      continue;
    }
    ops.push({ kind: "remove", id: b.id });
  }
  return j === draft.units.length ? ops : null;
}

/** `ast` with `ops` made in order, or the first refusal. */
export function applyUnitOps(ast: CalendarAst, ops: readonly UnitOp[]): AstEdit {
  let out = ast;
  for (const op of ops) {
    const r = op.kind === "rename" ? renameUnit(out, op.from, op.to) : removeUnit(out, op.id);
    if ("refused" in r) return r;
    out = r.ast;
  }
  return { ast: out };
}

/**
 * Make the draft's renames and removals (`ops`, from `base`) on `stored`, the definition at Save time: each is
 * stale when its unit changed in storage since the seed, or when storage now refuses it (an id taken there, a
 * reader added there). `base` comes back with the same operations made, so the slices compare like with like.
 */
export function replayUnitOps(stored: CalendarAst, base: CalendarAst, ops: readonly UnitOp[]): { readonly stored: CalendarAst; readonly base: CalendarAst } | { readonly stale: string } {
  let s = stored;
  let b = base;
  for (const op of ops) {
    const id = op.kind === "rename" ? op.from : op.id;
    const was = b.units.find((u) => u.id === id);
    const now = s.units.find((u) => u.id === id);
    if (!now || !same(now, was)) return { stale: `the ${id} changed outside the studio since this edit` };
    const rs = op.kind === "rename" ? renameUnit(s, op.from, op.to) : removeUnit(s, op.id);
    if ("refused" in rs) return { stale: `the ${op.kind === "rename" ? `rename of the ${id}` : `removal of the ${id}`} no longer fits the stored calendar: ${rs.reason}` };
    const rb = op.kind === "rename" ? renameUnit(b, op.from, op.to) : removeUnit(b, op.id);
    if ("refused" in rb) return { stale: rb.reason };
    s = rs.ast;
    b = rb.ast;
  }
  return { stored: s, base: b };
}

/**
 * What a `cycle:` edit reads outside its slice: the rules that read the unit (a label filter by name, a read by
 * number) and the gears that count it. A Save replays the edit only while these are as the edit saw them
 * (`cycleReplayProblem`).
 */
export function cycleReferences(ast: CalendarAst, id: string): unknown {
  return {
    rules: unitReads(ast, id).map((r) => [r.rule.id, r.how, r.by ?? null]),
    gears: ast.gears.filter((g) => g.on === id).map((g) => g.id),
  };
}

/** Why slice `key` (a `cycle:` slice) cannot be replayed onto `stored`, or null (definition.ts `mergeLayers`, beside `replayProblem`). */
export function cycleReplayProblem(key: SliceKey, base: CalendarAst, stored: CalendarAst): string | null {
  if (!key.startsWith("cycle:")) return null;
  const id = key.slice("cycle:".length);
  if (same(cycleReferences(stored, id), cycleReferences(base, id))) return null;
  return `a rule or a gear that reads the ${id} changed outside the studio since this edit`;
}
