/**
 * Seasons by phase (docs/SESHAT-v0.md §13.4): one rule for the legacy
 * internal calendar and for a Seshat definition, so the two cannot drift.
 * Moved here from src/plugin/time/seasons.ts (which re-exports it).
 * Date marks (§16 D7, §16.7 P6): a mark may also name a day of the year or a
 * day of one slot (a month) directly in the seasons unit.
 */

/** A season boundary: `from` is a phase in [0, 1). */
export interface SeasonMark {
  readonly name: string;
  readonly from: number;
}

/** A season that starts on day `day` of the year, 1-based (`MARK:Spring=DAY:80`). */
export interface DaySeasonMark {
  readonly name: string;
  readonly day: number;
}

/**
 * A season that starts on day `day` (1-based) of slot `index` (0-based, as
 * stored; the text prints index + the unit's NUMBER) of slot unit `unit`,
 * which sits directly in the seasons unit (`MARK:Spring=month:3.21`).
 */
export interface SlotSeasonMark {
  readonly name: string;
  readonly slot: { readonly unit: string; readonly index: number; readonly day: number };
}

export type DateSeasonMark = DaySeasonMark | SlotSeasonMark;
/** A stored season mark: a fraction of the year, or a date mark. */
export type SeasonMarkAst = SeasonMark | DateSeasonMark;

/** Whether a stored mark names a date rather than a fraction. */
export function isDateMark(m: SeasonMarkAst): m is DateSeasonMark {
  return typeof m === "object" && m !== null && ("day" in m || "slot" in m);
}

/** Whether any mark of a season list is a date mark (the fraction-only path is byte-identical to before). */
export function seasonsUseDates(seasons: { readonly marks: readonly SeasonMarkAst[] }): boolean {
  return seasons.marks.some(isDateMark);
}

/**
 * The season covering `phase`: the last mark whose `from <= phase`, wrapping to
 * the final mark when `phase` falls before the first one. Returns null when the
 * calendar defines no seasons.
 */
export function seasonAtPhase(seasons: readonly SeasonMark[], phase: number): string | null {
  const s = [...seasons].sort((a, b) => a.from - b.from);
  if (s.length === 0) return null;
  let cur = s[s.length - 1]!;
  for (const x of s) if (phase >= x.from) cur = x;
  return cur.name;
}

/** What a date mark needs of the calendar: each occurrence of the seasons unit, and the slot lengths inside it. */
export interface SeasonYears {
  length(index: number): number;
  /** lengths of the slots of `unit` (a slot unit directly in the seasons unit) inside occurrence `index` */
  slotLengths(unit: string, index: number): readonly number[];
}

/** A mark resolved in one year: `at` days into it (0-based), `order` its place in the declaration. */
interface Resolved {
  readonly at: number;
  readonly name: string;
  readonly order: number;
  /** a fraction mark's stored phase: fraction marks tied on one day order by it, as the float test does */
  readonly from?: number;
}

/** How many years back a day before its year's first resolved mark looks for the previous season. */
const WALK_BACK = 8;
const MEMO_MAX = 256;

/**
 * The first day (0-based, into a year of `length` days) whose float phase
 * `t / length` is at least `from`, or null when no day of the year reaches it:
 * the boundary that agrees with the fraction-only test `phase >= from`.
 */
export function fractionBoundary(from: number, length: number): number | null {
  if (!(length > 0) || !Number.isFinite(from)) return null;
  let t = Math.max(0, Math.ceil(from * length));
  while (t > 0 && (t - 1) / length >= from) t--;
  while (t < length && !(t / length >= from)) t++;
  return t < length ? t : null;
}

/**
 * The day (0-based) mark `m` falls on in a year of `length` days, or null when
 * the year has no such day (§16 D7). `slots` reads slot lengths lazily. A
 * fraction no day of the year reaches falls on `length`, a virtual day just
 * past the year's end: it sorts last, matches no day inside the year, and is
 * the wrap season through the year's last entry, as in the float test.
 */
function markDay(m: SeasonMarkAst, length: number, slots: (unit: string) => readonly number[]): number | null {
  if ("slot" in m) {
    const lens = slots(m.slot.unit);
    const len = lens[m.slot.index] ?? 0;
    if (!(len > 0)) return null; // the slot is absent this year: the mark is skipped
    let at = 0;
    for (let i = 0; i < m.slot.index; i++) at += lens[i]!;
    return at + Math.min(m.slot.day, len) - 1; // a day past the slot's end clamps to its last day
  }
  if ("day" in m) return m.day - 1 < length ? m.day - 1 : null; // past the year's length: skipped
  return fractionBoundary(m.from, length) ?? (length > 0 && Number.isFinite(m.from) ? length : null);
}

/**
 * Within each run of marks on one day (sorted by declaration order), the
 * fraction marks take the fraction places in order of `from`, then
 * declaration: the float test's winner (the larger `from`) comes last, while a
 * date mark keeps its declared place among them (a total order, unlike a
 * pairwise comparator that mixes the two keys).
 */
function orderFractionTies(out: Resolved[]): void {
  for (let i = 0; i < out.length; ) {
    let j = i + 1;
    while (j < out.length && out[j]!.at === out[i]!.at) j++;
    if (j - i > 1) {
      const places: number[] = [];
      for (let k = i; k < j; k++) if (out[k]!.from !== undefined) places.push(k);
      const fr = places.map((k) => out[k]!).sort((a, b) => a.from! - b.from! || a.order - b.order);
      places.forEach((k, n) => (out[k] = fr[n]!));
    }
    i = j;
  }
}

/**
 * Date-mark resolution over the occurrences of one seasons unit, memoised per
 * occurrence index (so toContext stays O(1) amortised). One per engine:
 * `Engine.seasonCalendar()`.
 */
export class SeasonCalendar {
  private readonly memo = new Map<number, readonly Resolved[] | null>();
  constructor(
    private readonly marks: readonly SeasonMarkAst[],
    private readonly years: SeasonYears,
  ) {}

  /**
   * The marks resolved in occurrence `index`, sorted by day; two fraction marks
   * on one day by `from` (the float test's winner, the larger, last), every
   * other tie in declaration order. Null when an earlier year (`current`
   * false) cannot be read, past the day line; the current year always reads,
   * so a real error there surfaces.
   */
  year(index: number, current = false): readonly Resolved[] | null {
    const hit = this.memo.get(index);
    if (hit !== undefined) return hit;
    let out: Resolved[] | null;
    try {
      const length = this.years.length(index);
      const lens = new Map<string, readonly number[]>();
      const slots = (u: string): readonly number[] => {
        let l = lens.get(u);
        if (!l) lens.set(u, (l = this.years.slotLengths(u, index)));
        return l;
      };
      out = [];
      for (const [order, m] of this.marks.entries()) {
        const at = markDay(m, length, slots);
        if (at !== null) out.push(isDateMark(m) ? { at, name: m.name, order } : { at, name: m.name, order, from: m.from });
      }
      out.sort((a, b) => a.at - b.at || a.order - b.order);
      orderFractionTies(out);
    } catch (err) {
      if (current) throw err;
      out = null; // an earlier year past the day line: the walk back stops here
    }
    if (this.memo.size >= MEMO_MAX) this.memo.clear();
    this.memo.set(index, out);
    return out;
  }

  /** The season `at` days into occurrence `index`: the last mark at or before it, else the last mark of an earlier year. */
  at(index: number, at: number): string | null {
    if (this.marks.length === 0) return null;
    const here = this.year(index, true);
    if (here) {
      let cur: Resolved | undefined;
      for (const r of here) {
        if (r.at > at) break;
        cur = r;
      }
      if (cur) return cur.name;
    }
    for (let k = 1; k <= WALK_BACK; k++) {
      const y = this.year(index - k);
      if (y === null) break;
      if (y.length) return y[y.length - 1]!.name;
    }
    // the first year of the line, or every mark skipped for years: this year's last mark, else the list's last
    if (here?.length) return here[here.length - 1]!.name;
    return this.marks[this.marks.length - 1]!.name;
  }

  /**
   * Every mark as a phase of occurrence `index` (§16.7 P6, describe() and the
   * southern flip): fractions as stored; a date mark at its day there over
   * the year's length, a skipped one clamped into the year. Sorted by phase,
   * ties in declaration order.
   */
  project(index: number): Array<{ name: string; from: number }> {
    const length = this.years.length(index);
    const out = this.marks.map((m, order) => {
      if (!isDateMark(m)) return { name: m.name, from: m.from, order };
      let at: number;
      if ("day" in m) at = Math.min(m.day, length) - 1;
      else {
        const lens = this.years.slotLengths(m.slot.unit, index);
        let before = 0;
        for (let i = 0; i < m.slot.index && i < lens.length; i++) before += lens[i]!;
        at = before + Math.max(1, Math.min(m.slot.day, lens[m.slot.index] ?? 0)) - 1;
      }
      return { name: m.name, from: Math.min(Math.max(at, 0), length - 1) / length, order };
    });
    out.sort((a, b) => a.from - b.from || a.order - b.order);
    return out.map(({ name, from }) => ({ name, from }));
  }
}

/**
 * The one season resolver (§16.7 P6): the engine's `seasonAt` and the
 * adapter's `toContext` both read seasons through it. `o` is the occurrence of
 * the seasons unit holding `day` (for the adapter, the year, also past
 * ±DAY_LIMIT). A fraction-only list keeps the float comparison byte-identical
 * to before: (day − start) / length against each `from`. A list with any date
 * mark resolves through `cal` (the engine's SeasonCalendar).
 */
export function seasonIn(seasons: { readonly marks: readonly SeasonMarkAst[] }, o: { readonly index: number; readonly start: number; readonly length: number }, day: number, cal?: SeasonCalendar | null): string | null {
  if (!seasonsUseDates(seasons)) return seasonAtPhase(seasons.marks as readonly SeasonMark[], (day - o.start) / o.length);
  if (!cal) throw new Error("date season marks resolve through the calendar's SeasonCalendar");
  return cal.at(o.index, day - o.start);
}
