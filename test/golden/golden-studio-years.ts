/**
 * Golden master for the Studio's year arithmetic on legacy worlds (Seshat P3b
 * step 0, docs/SESHAT-v0.md §14.5 and §14.8). Captured from the code as it
 * was before the year seam existed; every later P3b step must leave it
 * byte-identical, so the internal calendar's Studio output cannot move.
 *
 * It records, for constant years of 360, 365, 365.25, 365.75 and 400 days (and one
 * world whose epoch is not 1): fractionalYear / dayOrdinalAt; the spans every
 * predicate kind draws over windows that straddle years, hold a few days, or
 * span centuries (moons with fractional cycles included); the ruler's ticks at
 * every step size, including 4.5 to 7.5 px per day; the day and window labels;
 * dragToWhen for both branches; and firstDayOfYear on the internal calendar.
 *
 * Numbers are stored as exact strings (`String(n)` round-trips a double, and
 * -0 is kept), so the stored file cannot hide a one-ulp drift.
 */
import type { Modifier, Predicate } from "../../src/core/types";
import { InternalCalendar } from "../../src/plugin/time/internal";
import { firstDayOfYear } from "../../src/studio/model/audition";
import { dragToWhen, laneSub } from "../../src/studio/model/device-lanes";
import { dayLabel, dayRange, dayRangeLabel, windowLabel } from "../../src/studio/model/format";
import { dayOrdinalAt, fractionalYear, spansFor, type SpanCalendar } from "../../src/studio/model/spans";
import { ticks, type Window } from "../../src/studio/model/zoom";

/** Exact, JSON-safe: every number becomes its round-trip string (-0 and non-finite values kept). */
export function enc(x: unknown): unknown {
  if (typeof x === "number") return Object.is(x, -0) ? "-0" : String(x);
  if (Array.isArray(x)) return x.map(enc);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, enc(v)]));
  return x;
}

const SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];
const MOONS = [
  { name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 },
  { name: "Ash", cycleDays: 7.3, phaseAtEpoch: -0.25 },
];
const ERAS = [{ name: "Thaw", from: 3, to: 5 }];

export const WORLDS: ReadonlyArray<{ id: string; yearLength: number; epochYear: number }> = [
  { id: "L360", yearLength: 360, epochYear: 1 },
  { id: "L365", yearLength: 365, epochYear: 1 },
  { id: "L365.25", yearLength: 365.25, epochYear: 1 },
  // a fraction above one half: round(L) and floor(L) differ (clampDay, dayLabel)
  { id: "L365.75", yearLength: 365.75, epochYear: 1 },
  { id: "L400", yearLength: 400, epochYear: 1 },
  { id: "L365-epoch-1962", yearLength: 365, epochYear: 1962 },
];

const PREDICATES: Predicate[] = [
  { yearPhase: [0.45, 0.72] },
  { yearPhase: [0.9, 0.1] },
  { yearPhase: [0, 0.25] },
  { yearPhase: [0, 1] },
  { dayOfYear: [10, 20] },
  { dayOfYear: [0, 0] },
  { dayOfYear: [358, 370] },
  { dayOfYear: [365, 365] },
  { moon: { name: "Sable", phase: [0.95, 0.05] } },
  { moon: { name: "Ash", phase: [0.4, 0.6] } },
  { tag: "season:Summer" },
  { tag: "era:Thaw" },
  { all: [{ tag: "season:Winter" }, { moon: { name: "Sable", phase: [0.4, 0.6] } }] },
] as Predicate[];

/** Windows in the world's own years, offset from its epoch so every world sees the same shapes. */
const WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [-0.1, 2.1],
  [4.48, 4.5],
  [-3.3, 0.7],
  [0.25, 0.75],
  [2.999, 3.004],
  [0.97, 1.03],
  [0, 1100],
];

/** Ruler widths (years) at a 800 px lane: every chooseStep regime, and 4.5 to 7.5 px per day. */
const TICK_WIDTHS = [2 / 365, 5 / 365, 14 / 365, 30 / 365, 800 / (365 * 7.5), 800 / (365 * 6), 800 / (365 * 4.5), 0.5, 1, 3, 10, 40, 150, 600, 1100];

export interface GoldenStudioYears {
  worlds: Array<{ id: string; values: Record<string, unknown> }>;
}

export function buildGoldenStudioYears(): GoldenStudioYears {
  return {
    worlds: WORLDS.map((w) => {
      const cal: SpanCalendar = { yearLength: w.yearLength, epochYear: w.epochYear, seasons: SEASONS, moons: MOONS, eras: ERAS.map((e) => ({ ...e, from: e.from + w.epochYear - 1, to: e.to + w.epochYear - 1 })) };
      const E = w.epochYear;
      const L = w.yearLength;
      const values: Record<string, unknown> = {};

      const days = [-1000, -366, -365, -1, 0, 1, 59, 182, 364, 365, 366, 730, 731, 1461, 100_003];
      values.fractionalYear = days.map((d) => fractionalYear(d, cal));
      values.dayOrdinalAt = [E - 2.5, E, E + 0.5, E + 1, E + 1 + 1 / L, E + 7.123].map((y) => dayOrdinalAt(y, cal));

      const spans: Record<string, unknown> = {};
      for (const [a, b] of WINDOWS) {
        const window: Window = { a: E + a, b: E + b };
        for (const p of PREDICATES) spans[`${JSON.stringify(p)} @ ${a}..${b}`] = spansFor(p, undefined, cal, { window });
      }
      values.spans = spans;

      const tk: Record<string, unknown> = {};
      for (const wy of TICK_WIDTHS) {
        for (const start of [E + 0.7, E + 2.999, E - 0.0003]) {
          const window: Window = { a: start, b: start + wy };
          tk[`${wy} @ ${start}`] = ticks(window, 800, { year: (y) => String(y), day: (y, i) => `${y}:${i}:${dayLabel(i, L)}` });
        }
      }
      values.ticks = tk;

      values.dayLabel = [-1, 0, 0.4, 0.5, 59, 364, 365, 365.6, 400, 1000].map((d) => dayLabel(d, L));
      values.dayRange = [[0.25, 0.1], [0.9, 0.2], [0, 1], [223 / 365, 40 / 365], [0.5, 1 / L]].map(([s, l]) => dayRange(s!, l!, L));
      values.dayRangeLabel = [[0.25, 0.1], [0.9, 0.2], [0, 1], [223 / 365, 40 / 365]].map(([s, l]) => [dayRangeLabel(s!, l!, L), dayRangeLabel(s!, l!, L, { tight: true })]);
      values.windowLabel = [
        [0, 1],
        [0.5, 0.505],
        [0.5, 0.52],
        [2, 4.5],
        [0, 3],
        [-1, 1000],
      ].map(([a, b]) => windowLabel(E + a!, E + b!, L));

      const drag: Record<string, unknown> = {};
      const mod = (when: Predicate): Modifier => ({ id: "m", when, apply: [], tag: "m" });
      const year = E + 2;
      for (const [from, to] of [
        [year + 0.1, year + 0.3],
        [year + 0.95, year + 1.2],
        [year - 0.2, year + 0.05],
        [year, year + 1],
        [year + 10 / L, year + 21 / L],
        [year + 10.4 / L, year + 20.6 / L],
        [year + 0.999, year + 1.5],
        [year + 0.5, year + 0.5 + 1e-12],
      ] as const) {
        drag[`yp ${from}..${to}`] = dragToWhen(mod({ yearPhase: [0.1, 0.2] }), { id: `yp:${year}`, from, to, kind: "clip", editable: true }, from, to, cal);
        drag[`doy ${from}..${to}`] = dragToWhen(mod({ dayOfYear: [10, 20] }), { id: `doy:${year}`, from, to, kind: "clip", editable: true }, from, to, cal);
      }
      values.dragToWhen = drag;
      values.laneSub = PREDICATES.map((p) => laneSub(mod(p), cal));

      {
        const adapter = new InternalCalendar({ yearLength: L, epochYear: E, moons: [], seasons: SEASONS }, () => 0);
        values.firstDayOfYear = [E - 2, E, E + 1, E + 6, E + 40].map((y) => firstDayOfYear(adapter, y));
      }
      return { id: w.id, values: enc(values) as Record<string, unknown> };
    }),
  };
}

/** Exact structural diff; paths read like `L365/spans.<key>.3.from`. */
export function compareGoldenStudioYears(stored: GoldenStudioYears, fresh: GoldenStudioYears): string[] {
  const out: string[] = [];
  const walk = (path: string, a: unknown, b: unknown) => {
    if (Object.is(a, b)) return;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return void out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(path ? `${path}.${k}` : k, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
  };
  for (const [i, w] of fresh.worlds.entries()) walk(w.id, stored.worlds[i]?.values, w.values);
  if (stored.worlds.length !== fresh.worlds.length) out.push(`worlds: ${stored.worlds.length} -> ${fresh.worlds.length}`);
  return out;
}
