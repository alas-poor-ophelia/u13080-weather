/**
 * A compiled calendar (docs/SESHAT-v0.md §5): day from unit index in closed
 * form; unit index from day exactly for a bare base, else by an estimate from
 * the mean length corrected by whole steps. Everything is integer arithmetic
 * on safe integers.
 */
import type { CalendarAst, CycleRule, CycleUnitAst, LabelAst, SlotsUnitAst } from "./ast";
import { Body } from "./body";
import { DAY_LIMIT } from "./day";
import { SeasonCalendar, seasonIn } from "./seasons";
import { resolve } from "./resolve";
import { isPlainConstant } from "./base";
import { EngineDays } from "./engine-view";
import { gearMatcher, lcm, mod, type GearAst } from "./gear";
import { slotLengthsIn } from "./slots";
import { compileUnit } from "./piecewise";
import { traceStart, type StartRule, type StartTrace } from "./start";
import { validate } from "./validate";

/** Where a day falls in one unit: the occurrence (a cycle's index, or a slot's index in its parent) and the days into it. */
export interface Position {
  readonly index: number;
  readonly offset: number;
}

export class Engine {
  private readonly units = new Map<string, CycleUnitAst | SlotsUnitAst>();
  private readonly gears = new Map<string, GearAst>();
  /** each gear's matcher, built once: the engine treats its AST as fixed */
  private readonly matchers = new Map<string, (n: number) => boolean>();
  private readonly rules = new Map<string, StartRule>();
  /** ledger slot overrides (C6), by slot unit and parent path [cycle index, slot indices…] */
  private readonly overrides = new Map<string, readonly number[]>();
  private readonly bodies = new Map<string, Body>();
  /** slot lengths of units that cannot vary (whole-number slots, no gears, no ledger overrides): computed once */
  private readonly fixedLengths = new Map<string, readonly number[]>();
  /** rules over this calendar (§3.5); the named rules (VRULE) are bound through it */
  readonly days: EngineDays;

  /** the resolved calendar the engine runs (resolve.ts): body references and start modes as numbers; print the stored one */
  readonly ast: CalendarAst;

  constructor(stored: CalendarAst) {
    const errors = validate(stored);
    if (errors.length) throw new RangeError(`calendar "${stored.name}" is invalid: ${errors.join("; ")}`);
    const ast = resolve(stored);
    this.ast = ast;
    for (const g of ast.gears) {
      this.gears.set(g.id, g);
      this.matchers.set(g.id, gearMatcher(g));
    }
    for (const b of ast.bodies ?? []) this.bodies.set(b.id, new Body(b.period, b.epoch));
    for (const u of ast.units) {
      this.units.set(u.id, u);
      if (u.kind !== "cycle") continue;
      this.rules.set(u.id, compileUnit(u, this.gears));
      for (const e of u.ledger ?? []) if (e.kind === "slots") this.overrides.set(overrideKey(e.unit, [e.from, ...(e.path ?? [])]), e.lengths);
    }
    const overridden = new Set(ast.units.flatMap((u) => (u.kind === "cycle" ? (u.ledger ?? []) : [])).flatMap((e) => (e.kind === "slots" ? [e.unit] : [])));
    for (const u of ast.units) {
      if (u.kind !== "slots" || overridden.has(u.id)) continue;
      if (u.slots.every((x) => typeof x.length === "number" && !x.gears?.length)) this.fixedLengths.set(u.id, u.slots.map((x) => x.length as number));
    }
    this.days = new EngineDays(this);
  }

  /** The day on which occurrence `index` of cycle unit `id` starts. */
  start(id: string, index: number): number {
    return this.rule(id).start(index);
  }

  /**
   * How occurrence `index` of cycle unit `id` starts (docs/SESHAT-v0.md §18.3 D8): the base occurrence
   * read, each level's start and each stage's matching rule, under the rule that governs it (the unit's
   * own, or the ledger switch in force). `pinned` when a ledger pin sets the start instead; `start` is
   * always `start(id, index)`.
   */
  startTrace(id: string, index: number): StartTrace & { readonly start: number; readonly pinned: boolean; readonly switched: boolean } {
    const u = this.units.get(id);
    if (u?.kind !== "cycle") throw new RangeError(`"${id}" is not a cycle unit`);
    let rule: CycleRule = u;
    let switched = false;
    let pinned = false;
    for (const e of u.ledger ?? []) {
      if (e.kind === "switch" && e.from <= index) [rule, switched] = [e.rule, true];
      if (e.kind === "starts" && index >= e.from && index <= e.from + (e.lengths?.length ?? 0)) pinned = true;
    }
    return { ...traceStart(rule, this.gears, index), start: this.start(id, index), pinned, switched };
  }

  /** Days in occurrence `index` of cycle unit `id`: by definition the gap between two starts, so the two can never disagree. */
  length(id: string, index: number): number {
    return this.start(id, index + 1) - this.start(id, index);
  }

  /** The occurrence of cycle unit `id` that holds `day` (a whole day within ±DAY_LIMIT). */
  indexAt(id: string, day: number): number {
    const rule = this.rule(id);
    if (!Number.isSafeInteger(day) || Math.abs(day) > DAY_LIMIT) throw new RangeError(`day ${day} is not a whole day within ±${DAY_LIMIT}`);
    return rule.indexAt(day);
  }

  /**
   * Slot lengths of slot unit `id` inside one occurrence of its parent. `path`
   * addresses that occurrence from the cycle down: [year] for a month,
   * [year, month] for a décade. Gear terms read the cycle index, path[0].
   */
  slotLengths(id: string, path: readonly number[]): number[] {
    return [...this.slotLengthsWithin(id, path, this.occurrenceLength(this.slots(id).in, path))];
  }

  /** slotLengths when the parent occurrence's length is already known (locate walks down with it). Read-only: it may be the shared memo. */
  private slotLengthsWithin(id: string, path: readonly number[], parentLength: number): readonly number[] {
    const fixed = this.fixedLengths.get(id);
    if (fixed) return fixed; // the validator makes fixed slots fill every parent occurrence
    const u = this.slots(id);
    const lens = slotLengthsIn(u, parentLength, (g) => this.matchers.get(g)!(path[0]!), this.overrides.get(overrideKey(id, path)));
    if (typeof lens === "string") throw new Error(`unreachable: "${id}" at [${path.join(", ")}]: ${lens}`); // the validator checks every reachable occurrence
    return lens;
  }

  /**
   * Where `day` falls in unit `id`, or null when the day has no place in it:
   * it lies in a filler slot of an enclosing unit (a festival day has no
   * décade).
   */
  positionOf(id: string, day: number): Position | null {
    const at = this.locate(id, day);
    return at && { index: at.path[at.path.length - 1]!, offset: at.offset };
  }

  /**
   * The occurrence of unit `id` that holds `day`: a cycle's index, or a slot's
   * index in its parent, with its first day and length. Null when the day lies
   * in a filler slot of an enclosing unit.
   */
  occurrenceAt(id: string, day: number): { readonly index: number; readonly start: number; readonly length: number } | null {
    const u = this.units.get(id);
    if (!u) throw new RangeError(`no unit "${id}"`);
    if (u.kind === "cycle") {
      const index = this.indexAt(id, day);
      const start = this.start(id, index);
      return { index, start, length: this.start(id, index + 1) - start };
    }
    const at = this.locate(id, day);
    if (!at) return null;
    return { index: at.path[at.path.length - 1]!, start: day - at.offset, length: at.length };
  }

  /** The season `day` falls in (the legacy rule over the seasons unit's phase), or null with no seasons. */
  seasonAt(day: number): string | null {
    const s = this.ast.seasons;
    if (!s) return null;
    return seasonIn(s, this.occurrenceAt(s.unit, day)!, day, this.seasonCalendar());
  }

  /**
   * The seasons as phases of the seasons-unit occurrence holding day 0
   * (§16.7 P6): what describe() and the Studio draw. Fractions as stored;
   * date marks projected there (approximate in years of another length).
   * Sorted by phase, ties in declaration order.
   */
  seasonProjection(): Array<{ name: string; from: number }> {
    const s = this.ast.seasons;
    if (!s) return [];
    return this.seasonCalendar()!.project(this.occurrenceAt(s.unit, 0)!.index);
  }

  private seasonCal?: SeasonCalendar;
  /** Date-mark resolution over the seasons unit, memoised per occurrence (§16.7 P6); null with no seasons. */
  seasonCalendar(): SeasonCalendar | null {
    const s = this.ast.seasons;
    if (!s) return null;
    return (this.seasonCal ??= new SeasonCalendar(s.marks, { length: (i) => this.length(s.unit, i), slotLengths: (u, i) => this.slotLengths(u, [i]) }));
  }

  /** The moons on `day`, in declaration order: the bodies with a moon facet, each with its exact phase. */
  moonsAt(day: number): Array<{ name: string; phase: number }> {
    const out: Array<{ name: string; phase: number }> = [];
    for (const b of this.ast.bodies ?? []) if (b.moon) out.push({ name: b.moon.name, phase: this.bodies.get(b.id)!.phaseAt(day) });
    return out;
  }

  /** Phase of body `id` on `day` in [0, 1), exact to one division; undefined for an unknown body. */
  bodyPhase(id: string, day: number): number | undefined {
    return this.bodies.get(id)?.phaseAt(day);
  }

  /** Whether `id` is a cycle unit (it never resets; its index counts from the epoch). */
  isCycle(id: string): boolean {
    return this.units.get(id)?.kind === "cycle";
  }

  /** The parent of slot unit `id`; undefined for a cycle or an unknown id. */
  parentOf(id: string): string | undefined {
    const u = this.units.get(id);
    return u?.kind === "slots" ? u.in : undefined;
  }

  /** Declared slots of slot unit `id` (length-0 slots included). */
  slotCount(id: string): number {
    return this.slots(id).slots.length;
  }

  /** The day `offset` days into slot `slot` of unit `id`, inside the parent occurrence at `path` (see slotLengths). */
  dayOf(id: string, path: readonly number[], slot: number, offset: number): number {
    const lens = this.slotLengths(id, path);
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= lens.length) throw new RangeError(`"${id}" has no slot ${slot}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= lens[slot]!) throw new RangeError(`slot ${slot} of "${id}" at [${path.join(", ")}] has ${lens[slot]} days; no day ${offset}`);
    let d = this.occurrenceStart(this.slots(id).in, path);
    for (let i = 0; i < slot; i++) d += lens[i]!;
    return d + offset;
  }

  /**
   * The path of every occurrence holding `day` from the cycle down to `id`,
   * the days into the last one, and its length. Each level reuses its parent's
   * length rather than recomputing it (that recomputation made nested slot
   * units cost about depth³ per lookup).
   */
  private locate(id: string, day: number): { path: number[]; offset: number; length: number } | null {
    const u = this.units.get(id);
    if (!u) throw new RangeError(`no unit "${id}"`);
    if (u.kind === "cycle") {
      const index = this.indexAt(id, day);
      const start = this.start(id, index);
      return { path: [index], offset: day - start, length: this.start(id, index + 1) - start };
    }
    const parent = this.locate(u.in, day);
    if (!parent || this.isFiller(u.in, parent.path)) return null;
    let offset = parent.offset;
    const lens = this.slotLengthsWithin(id, parent.path, parent.length);
    for (let i = 0; i < lens.length; i++) {
      if (offset < lens[i]!) return { path: [...parent.path, i], offset, length: lens[i]! };
      offset -= lens[i]!;
    }
    throw new Error(`unreachable: day ${day} falls past the slots of "${id}"`); // the validator makes the slots fill the parent
  }

  /** Whether the occurrence of `id` at `path` is a filler slot (it has no children). A cycle occurrence never is. */
  private isFiller(id: string, path: readonly number[]): boolean {
    const u = this.units.get(id)!;
    return u.kind === "slots" && !!u.slots[path[path.length - 1]!]!.filler;
  }

  /** Days in the occurrence of unit `id` at `path`; a filler occurrence has no children to hold. */
  private occurrenceLength(id: string, path: readonly number[]): number {
    this.checkPath(id, path);
    const u = this.units.get(id)!;
    if (u.kind === "cycle") return this.length(id, path[0]!);
    if (this.isFiller(id, path)) throw new RangeError(`slot ${path[path.length - 1]} of "${id}" is a filler slot; nothing nests in it`);
    return this.slotLengths(id, path.slice(0, -1))[path[path.length - 1]!]!;
  }

  private occurrenceStart(id: string, path: readonly number[]): number {
    const u = this.units.get(id)!;
    if (u.kind === "cycle") return this.start(id, path[0]!);
    const lens = this.slotLengths(id, path.slice(0, -1));
    let d = this.occurrenceStart(u.in, path.slice(0, -1));
    for (let i = 0; i < path[path.length - 1]!; i++) d += lens[i]!;
    return d;
  }

  /** A path names one index per level from the cycle down to `id`, each slot index in range. */
  private checkPath(id: string, path: readonly number[]): void {
    let depth = 1;
    for (let u = this.units.get(id)!; u.kind === "slots"; u = this.units.get(u.in)!) depth++;
    if (path.length !== depth || !path.every((i) => Number.isSafeInteger(i))) throw new RangeError(`"${id}" needs a path of ${depth} whole indices, got [${path.join(", ")}]`);
    const u = this.units.get(id)!;
    const i = path[path.length - 1]!;
    if (u.kind === "slots" && (i < 0 || i >= u.slots.length)) throw new RangeError(`"${id}" has no slot ${i}`);
  }

  private slots(id: string): SlotsUnitAst {
    const u = this.units.get(id);
    if (u?.kind !== "slots") throw new RangeError(`"${id}" is not a slot unit`);
    return u;
  }

  /**
   * The label `day` carries in unit `id` (C5): a cycle's label by occurrence
   * (index mod the table's length), or a slot's own name and tags. Null when
   * the unit has no label there, or the day has no place in it.
   */
  labelAt(id: string, day: number): LabelAst | null {
    const u = this.units.get(id);
    if (!u) throw new RangeError(`no unit "${id}"`);
    const at = this.positionOf(id, day);
    if (!at) return null;
    if (u.kind === "cycle") return u.labels?.length ? u.labels[mod(at.index, u.labels.length)]! : null;
    const s = u.slots[at.index]!;
    return s.name === undefined && s.tags === undefined ? null : { ...(s.name !== undefined && { name: s.name }), ...(s.tags && { tags: s.tags }) };
  }

  /**
   * Every tag `day` carries: unit by unit in declaration order, then day
   * labels, then named rules in declaration order (tags are hashed; names are
   * not). Each named rule is evaluated at most once per day (EngineDays.named),
   * also when other rules read its tags. Without `onError`, a rule that throws
   * makes this throw; with it, that rule's tags are left out, and so are the
   * tags of every rule that reads them, the others kept, and `onError` hears
   * each failed rule's id and error.
   */
  tagsAt(day: number, onError?: (ruleId: string, error: unknown) => void): string[] {
    const tags = [...this.days.baseTags(day)];
    for (const [i, r] of (this.ast.rules ?? []).entries()) {
      if (!r.tags?.length) continue;
      if (!onError) {
        if (this.days.named(i, day)) tags.push(...r.tags);
        continue;
      }
      try {
        if (this.days.named(i, day)) tags.push(...r.tags);
      } catch (e) {
        onError(r.id, e);
      }
    }
    return tags;
  }

  /** The tags of units and day labels only: what a rule reads of any tag a unit or day label also sets (§16.7 P2). */
  baseTagsAt(day: number): string[] {
    const tags: string[] = [];
    for (const u of this.ast.units) tags.push(...(this.labelAt(u.id, day)?.tags ?? []));
    for (const d of this.ast.days ?? []) if (d.day === day) tags.push(...(d.tags ?? []));
    return tags;
  }

  /**
   * V6: the days after which the labels of cycle units `ids` all repeat
   * together (the Calendar Round of Tzolk'in and Haab' is 18,980). Each unit
   * needs a constant length and no gear terms or stages; its period is its
   * length times its label count.
   */
  round(ids: readonly string[]): number {
    let p = 1;
    for (const id of ids) {
      const u = this.units.get(id);
      if (u?.kind !== "cycle" || !isPlainConstant(u)) throw new RangeError(`"${id}" is not a constant cycle; its labels have no fixed period`);
      p = lcm(p, u.length * (u.labels?.length || 1));
      if (!Number.isSafeInteger(p)) throw new RangeError(`the round of ${ids.join(", ")} is past the safe integers`);
    }
    return p;
  }

  private rule(id: string): StartRule {
    const r = this.rules.get(id);
    if (!r) throw new RangeError(`"${id}" is not a cycle unit`);
    return r;
  }
}

function overrideKey(unit: string, path: readonly number[]): string {
  return `${unit}|${path.join(",")}`;
}
