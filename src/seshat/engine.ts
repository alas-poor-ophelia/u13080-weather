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

  /** Slot lengths of slot unit `id` inside occurrence `parentIndex` of its parent. */
  slotLengths(id: string, parentIndex: number): number[] {
    const u = this.units.get(id);
    if (u?.kind !== "slots") throw new RangeError(`"${id}" is not a slot unit`);
    let fixed = 0;
    const lens = u.slots.map((s) => {
      if (s.length === "slack") return 0;
      let len = s.length;
      for (const t of s.gears ?? []) if (gearMatches(this.gears.get(t.gear)!, parentIndex)) len += t.add;
      fixed += len;
      return len;
    });
    const slack = u.slots.findIndex((s) => s.length === "slack");
    if (slack >= 0) lens[slack] = this.length(u.in, parentIndex) - fixed;
    return lens;
  }

  /** Where `day` falls in unit `id`. */
  positionOf(id: string, day: number): Position {
    const u = this.units.get(id);
    if (!u) throw new RangeError(`no unit "${id}"`);
    if (u.kind === "cycle") {
      const index = this.indexAt(id, day);
      return { index, offset: day - this.start(id, index) };
    }
    const parent = this.positionOf(u.in, day);
    let offset = parent.offset;
    const lens = this.slotLengths(id, parent.index);
    for (let i = 0; i < lens.length; i++) {
      if (offset < lens[i]!) return { index: i, offset };
      offset -= lens[i]!;
    }
    throw new Error(`unreachable: day ${day} falls past the slots of "${id}"`); // the validator makes the slots fill the parent
  }

  /** The day `offset` days into slot `slot` of unit `id`, inside occurrence `parentIndex` of its parent. */
  dayOf(id: string, parentIndex: number, slot: number, offset: number): number {
    const u = this.units.get(id);
    if (u?.kind !== "slots") throw new RangeError(`"${id}" is not a slot unit`);
    const lens = this.slotLengths(id, parentIndex);
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= lens.length) throw new RangeError(`"${id}" has no slot ${slot}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= lens[slot]!) throw new RangeError(`slot ${slot} of "${id}" in ${u.in} ${parentIndex} has ${lens[slot]} days; no day ${offset}`);
    let d = this.start(u.in, parentIndex);
    for (let i = 0; i < slot; i++) d += lens[i]!;
    return d + offset;
  }

  private cycle(id: string): CycleUnitAst {
    const u = this.units.get(id);
    if (u?.kind !== "cycle") throw new RangeError(`"${id}" is not a cycle unit`);
    return u;
  }
}
