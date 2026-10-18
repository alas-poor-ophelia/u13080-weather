/**
 * A compiled calendar (docs/SESHAT-v0.md §5): day from unit index in closed
 * form, unit index from day by an estimate from the mean length corrected by
 * whole steps. Everything is integer arithmetic on safe integers.
 */
import type { CalendarAst, CycleUnitAst, SlotsUnitAst } from "./ast";
import { DAY_LIMIT } from "./day";
import { gearBelow, gearDensity, gearDeviation, gearMatches, type GearAst } from "./gear";
import { validate } from "./validate";

/** Where a day falls in one unit: the occurrence (a cycle's index, or a slot's index in its parent) and the days into it. */
export interface Position {
  readonly index: number;
  readonly offset: number;
}

export class Engine {
  private readonly units = new Map<string, CycleUnitAst | SlotsUnitAst>();
  private readonly gears = new Map<string, GearAst>();
  private readonly means = new Map<string, number>();
  /** V4: the most whole steps indexAt may need to correct its estimate, per cycle unit */
  private readonly steps = new Map<string, number>();

  constructor(readonly ast: CalendarAst) {
    const errors = validate(ast);
    if (errors.length) throw new RangeError(`calendar "${ast.name}" is invalid: ${errors.join("; ")}`);
    for (const g of ast.gears) this.gears.set(g.id, g);
    for (const u of ast.units) {
      this.units.set(u.id, u);
      if (u.kind !== "cycle") continue;
      const terms = (u.gears ?? []).map((t) => ({ add: t.add, g: this.gears.get(t.gear)! }));
      this.means.set(u.id, u.length + terms.reduce((a, t) => a + t.add * gearDensity(t.g), 0));
      // start(i) − anchor − mean·i is Σ add·(gearBelow(i) − density·i), and each gear's term stays within gearDeviation of 0
      const deviation = terms.reduce((a, t) => a + Math.abs(t.add) * gearDeviation(t.g), 0);
      const shortest = u.length + terms.reduce((a, t) => a + Math.min(0, t.add), 0);
      this.steps.set(u.id, Math.ceil(deviation / shortest) + 2);
    }
  }

  /** The day on which occurrence `index` of cycle unit `id` starts. */
  start(id: string, index: number): number {
    const u = this.cycle(id);
    let s = u.anchor + u.length * index;
    for (const t of u.gears ?? []) s += t.add * gearBelow(this.gears.get(t.gear)!, index);
    return s;
  }

  /** Days in occurrence `index` of cycle unit `id`: by definition the gap between two starts, so the two can never disagree. */
  length(id: string, index: number): number {
    return this.start(id, index + 1) - this.start(id, index);
  }

  /** The occurrence of cycle unit `id` that holds `day` (a whole day within ±DAY_LIMIT). */
  indexAt(id: string, day: number): number {
    const u = this.cycle(id);
    if (!Number.isSafeInteger(day) || Math.abs(day) > DAY_LIMIT) throw new RangeError(`day ${day} is not a whole day within ±${DAY_LIMIT}`);
    // estimate from the mean, then correct by whole steps; V4 bounds how many
    let i = Math.floor((day - u.anchor) / this.means.get(id)!);
    let left = this.steps.get(id)!;
    while (this.start(id, i) > day) i = this.step(id, i, -1, left--);
    while (this.start(id, i + 1) <= day) i = this.step(id, i, 1, left--);
    return i;
  }

  private step(id: string, i: number, by: number, left: number): number {
    if (left <= 0) throw new Error(`unreachable: "${id}" needed more correction steps than its V4 bound`);
    return i + by;
  }

  /**
   * Slot lengths of slot unit `id` inside one occurrence of its parent. `path`
   * addresses that occurrence from the cycle down: [year] for a month,
   * [year, month] for a décade. Gear terms read the cycle index, path[0].
   */
  slotLengths(id: string, path: readonly number[]): number[] {
    const u = this.slots(id);
    const total = this.occurrenceLength(u.in, path);
    let fixed = 0;
    const lens = u.slots.map((s) => {
      if (s.length === "slack") return 0;
      let len = s.length;
      for (const t of s.gears ?? []) if (gearMatches(this.gears.get(t.gear)!, path[0]!)) len += t.add;
      fixed += len;
      return len;
    });
    const slack = u.slots.findIndex((s) => s.length === "slack");
    if (slack >= 0) lens[slack] = total - fixed;
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

  /** The day `offset` days into slot `slot` of unit `id`, inside the parent occurrence at `path` (see slotLengths). */
  dayOf(id: string, path: readonly number[], slot: number, offset: number): number {
    const lens = this.slotLengths(id, path);
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= lens.length) throw new RangeError(`"${id}" has no slot ${slot}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= lens[slot]!) throw new RangeError(`slot ${slot} of "${id}" at [${path.join(", ")}] has ${lens[slot]} days; no day ${offset}`);
    let d = this.occurrenceStart(this.slots(id).in, path);
    for (let i = 0; i < slot; i++) d += lens[i]!;
    return d + offset;
  }

  /** The path of every occurrence holding `day` from the cycle down to `id`, and the days into the last one. */
  private locate(id: string, day: number): { path: number[]; offset: number } | null {
    const u = this.units.get(id);
    if (!u) throw new RangeError(`no unit "${id}"`);
    if (u.kind === "cycle") {
      const index = this.indexAt(id, day);
      return { path: [index], offset: day - this.start(id, index) };
    }
    const parent = this.locate(u.in, day);
    if (!parent || this.isFiller(u.in, parent.path)) return null;
    let offset = parent.offset;
    const lens = this.slotLengths(id, parent.path);
    for (let i = 0; i < lens.length; i++) {
      if (offset < lens[i]!) return { path: [...parent.path, i], offset };
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

  private cycle(id: string): CycleUnitAst {
    const u = this.units.get(id);
    if (u?.kind !== "cycle") throw new RangeError(`"${id}" is not a cycle unit`);
    return u;
  }
}
