/**
 * Exact numbers behind a float knob (docs/SESHAT-v0.md §18.3 D2, §18.6 item 6).
 *
 * A Seshat period or epoch is a reduced Rational; a knob is a float. This
 * module is the edge between them, and it is pure (no DOM, no store):
 *
 *  - A knob remembers the rational it started from (its ORIGIN). A moved value
 *    becomes the knob's display step as a rational (step 1/100 → n/100),
 *    reduced. A value inside the origin's displayed step cell IS the origin,
 *    exactly, so a drag that ends where it began leaves the draft equal to the
 *    stored definition (no dirty dot, no undo step: the store drops a snapshot
 *    whose drafts did not change). 765433/25920 = 29.530594… shows as 29.53;
 *    any knob value that also shows 29.53 writes 765433/25920 back.
 *    487/16 = 30.4375 is off the 0.01 grid; it shows as 30.44 and is kept
 *    exactly until the knob leaves that cell.
 *  - A molad's d·h·parts editor reads and writes n/25920 (1 part = 1/1080 h).
 *  - Every period/epoch write is checked against `Body`'s safe-integer limit
 *    (src/seshat/body.ts: P·Q and 2·P·F must be safe integers, F the epoch's
 *    reduced denominator) and refused with a plain reason when it would not run.
 *
 * Cells round half up (toward +∞), in exact integers for a rational and for a
 * knob's float read at its shortest decimal, so the two agree on a tie.
 */
import { frac, fromNumber, rational, SAFE, toNumber, type Rational } from "../../seshat/rational";

/** A positive rational display step, e.g. 1/100 for a two-decimal readout. */
export type KnobStep = Rational;

/** A typed refusal: the write never reaches the draft, and `reason` is shown at the knob. */
export interface Refused {
  kind: "refused";
  reason: string;
}

function checkStep(step: KnobStep): void {
  if (!(step.n > 0 && step.d > 0)) throw new RangeError(`a knob step must be positive (got ${step.n}/${step.d})`);
}

/** floor(a / b) and the remainder in [0, b), for safe integers with b > 0. */
function divmod(a: number, b: number): [number, number] {
  const m = ((a % b) + b) % b;
  return [(a - m) / b, m];
}

/**
 * The step cell an exact rational shows in: round-half-up of r / step, computed
 * in integers when r.n·step.d and r.d·step.n are safe (always, for a Body that
 * runs and a decimal step), else in floats.
 */
export function cellOf(r: Rational, step: KnobStep): number {
  checkStep(step);
  const a = r.n * step.d;
  const b = r.d * step.n;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return Math.floor(toNumber(r) / toNumber(step) + 0.5);
  const [q, m] = divmod(a, b);
  return m >= b - m ? q + 1 : q; // 2m ≥ b, without forming 2m
}

/**
 * The step cell a knob's float value shows in: `cellOf` of the value as typed
 * (its shortest decimal, `fromNumber`), so 1.005 is in cell 101 of 1/100 as
 * the rational 201/200 is, where a float product (100.49999999999999) is not.
 */
export function cellOfValue(value: number, step: KnobStep): number {
  return cellOf(fromNumber(value), step);
}

/** The rational at the centre of step cell `cell`: cell·step, reduced. Throws a RangeError past safe integers. */
export function cellValue(cell: number, step: KnobStep): Rational {
  checkStep(step);
  return rational(cell * step.n, step.d);
}

/**
 * The rational a knob writes for its float `value`.
 *
 * Inside the origin's displayed step cell this is `origin` itself (the same
 * object, so `===` holds); anywhere else it is that cell on the step grid,
 * reduced. Call it on every phase (drag frames too): mid-drag frames that pass
 * back through the origin's cell then hold the origin as well, and the final
 * ("end") write is what decides whether the gesture changed anything.
 *
 * @param value the knob's float value
 * @param origin the stored rational the knob was seeded from; null for a value with none (every cell is on the grid)
 * @param step the display step (1/100 for a 0.01 readout)
 */
export function knobRational(value: number, origin: Rational | null, step: KnobStep): Rational {
  if (origin !== null && value === toNumber(origin)) return origin; // the knob as seeded, whatever a tie would say
  const cell = cellOfValue(value, step);
  if (origin !== null && cell === cellOf(origin, step)) return origin;
  return cellValue(cell, step);
}

// ---- the Body limit

/** A period and epoch, as a Seshat `BodyAst` stores them. */
export interface BodyPair {
  readonly period: Rational;
  readonly epoch: Rational;
}

export type BodyWrite = { kind: "write"; period: Rational; epoch: Rational } | Refused;

/**
 * Whether `period` and `epoch` make a Body whose phases stay safe integers,
 * exactly the conditions `new Body` enforces (positive period; P·Q and 2·P·F
 * safe, with F the denominator of frac(epoch)). The pair is returned as given.
 */
export function checkBody(period: Rational, epoch: Rational): BodyWrite {
  if (period.n <= 0) return { kind: "refused", reason: "a period must be longer than 0 days" };
  const F = frac(epoch).d;
  if (period.n * period.d > SAFE || 2 * period.n * F > SAFE) {
    return { kind: "refused", reason: `a period of ${period.n}/${period.d} days with an epoch of ${epoch.n}/${epoch.d} turn needs numbers too large to count exactly; choose a rounder value` };
  }
  return { kind: "write", period, epoch };
}

/**
 * Move a body's period, epoch or both, keeping whatever is not moved EXACTLY
 * as stored.
 *
 * A period-only move keeps `stored.epoch` (the same rational, never re-read
 * from a float) and an epoch-only move keeps `stored.period`. If that mixed
 * pair would overflow, the write is REFUSED; it never falls back to a fresh
 * pair.
 *
 * How this sits beside `moonsOf` (src/studio/model/definition.ts): moonsOf keeps
 * a body's stored rationals for the half the draft did not change and takes
 * the changed half from `bodyFor(cycleDays, phaseAtEpoch)`; only when that
 * mixed pair fails `runs` does it take bodyFor's whole pair, which re-derives
 * the epoch from its float (its shortest decimal, approximated to fit the
 * limit). That is the one case in which the epoch is re-derived. A write
 * made here has already passed `checkBody`, so the mixed pair runs and the
 * fallback is not reached; the epoch moves only when the epoch knob moves.
 * (moonsOf reads the period from the draft's float, so a period that is not a
 * short decimal, say n/25920, survives only on a draft that holds rationals:
 * the AST draft of §18.6 step 3, not today's `DraftMoon.cycleDays`.)
 */
export function moveBody(stored: BodyPair, next: { period?: Rational; epoch?: Rational }): BodyWrite {
  return checkBody(next.period ?? stored.period, next.epoch ?? stored.epoch);
}

// ---- the molad: days, hours and parts

/** Parts in a day: 24 hours of 1080 parts (halakim). */
export const PARTS_PER_DAY = 25920;
/** Parts in an hour. */
export const PARTS_PER_HOUR = 1080;

/** A span in days, hours (0 to 23) and parts (0 to 1079). Days may be negative; hours and parts never are. */
export interface Molad {
  days: number;
  hours: number;
  parts: number;
}

/**
 * `r` days as d·h·parts. `exact` is false when `r` is not a whole number of
 * parts (its reduced denominator does not divide 25920); the parts are then
 * rounded half up, so the editor shows the nearest part and writing it back
 * changes the value.
 */
export function moladOf(r: Rational): { molad: Molad; exact: boolean } {
  const total = cellOf(r, { n: 1, d: PARTS_PER_DAY });
  const [days, inDay] = divmod(total, PARTS_PER_DAY);
  const [hours, parts] = divmod(inDay, PARTS_PER_HOUR);
  return { molad: { days, hours, parts }, exact: PARTS_PER_DAY % r.d === 0 };
}

/** The rational for d·h·parts: (d·25920 + h·1080 + p) / 25920, reduced; refused for hours outside 0-23, parts outside 0-1079 or a non-integer. */
export function fromMolad(m: Molad): { kind: "write"; value: Rational } | Refused {
  if (![m.days, m.hours, m.parts].every(Number.isSafeInteger)) return { kind: "refused", reason: "days, hours and parts must be whole numbers" };
  if (m.hours < 0 || m.hours > 23) return { kind: "refused", reason: `hours run from 0 to 23 (got ${m.hours})` };
  if (m.parts < 0 || m.parts >= PARTS_PER_HOUR) return { kind: "refused", reason: `parts run from 0 to 1079 (got ${m.parts})` };
  const n = m.days * PARTS_PER_DAY + m.hours * PARTS_PER_HOUR + m.parts;
  if (!Number.isSafeInteger(n)) return { kind: "refused", reason: "that many days is too large to count exactly" };
  return { kind: "write", value: rational(n, PARTS_PER_DAY) };
}
