/**
 * Moon flip scan (Seshat P0 step 0, docs/SESHAT-v0.md §8.1).
 *
 * Before Seshat P0 the internal calendar computed a moon's phase in floats:
 * wrap((d / cycleDays + phaseAtEpoch) % 1). Since P0 it is exact: cycleDays
 * and phaseAtEpoch are rationals (from their shortest round-trip decimal) and
 * the phase is one integer remainder divided once. This records every day in
 * ±MAX_DAY_ORDINAL where the old float phase and the exact phase land on
 * different sides of a predicate boundary the calendar golden uses (the
 * pre-P0 capture found none), and checks that the shipped InternalCalendar
 * really is the exact formula.
 *
 *   bun run scripts/moon-flip-scan.ts          # check against test/golden/moon-flips.json
 *   bun run scripts/moon-flip-scan.ts --write  # rewrite it
 */
import { InternalCalendar } from "../src/plugin/time/internal";
import { MAX_DAY_ORDINAL } from "../src/plugin/world";
import { MOON_BOUNDARIES, MOONS_365, MOONS_400 } from "../test/golden/golden-cal";

interface Moon {
  name: string;
  cycleDays: number;
  phaseAtEpoch: number;
}
interface Flip {
  day: number;
  float: number;
  exact: number;
  boundaries: number[];
}
interface MoonScan extends Moon {
  /** days where float and exact phase differ at all, and the largest such difference */
  differingDays: number;
  maxAbsDiff: number;
  flips: Flip[];
}

/** The shortest round-trip decimal of x as an exact fraction n/d (d a power of ten). */
function decimal(x: number): { n: bigint; d: bigint } {
  const s = String(x);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`unsupported number ${s}`);
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const n = BigInt(int! + frac) * (neg ? -1n : 1n);
  return { n, d: 10n ** BigInt(frac.length) };
}

/** Today's float phase, the same expression as InternalCalendar.toContext. */
function floatPhase(d: number, m: Moon): number {
  const x = (d / m.cycleDays + m.phaseAtEpoch) % 1;
  const r = x - Math.floor(x);
  return r === 1 ? 0 : r;
}

/** Exact phase: (d·Q/P + E/F) mod 1 = ((d·Q·F + E·P) mod P·F) / (P·F), divided once. */
function exactPhase(d: number, p: { n: bigint; d: bigint }, e: { n: bigint; d: bigint }): number {
  const den = p.n * e.d;
  let num = (BigInt(d) * p.d * e.d + e.n * p.n) % den;
  if (num < 0n) num += den;
  return Number(num) / Number(den);
}

function scan(m: Moon): MoonScan {
  const p = decimal(m.cycleDays);
  const e = decimal(m.phaseAtEpoch);
  const flips: Flip[] = [];
  let differingDays = 0;
  let maxAbsDiff = 0;
  for (let d = -MAX_DAY_ORDINAL; d <= MAX_DAY_ORDINAL; d++) {
    const f = floatPhase(d, m);
    const x = exactPhase(d, p, e);
    if (f === x) continue;
    differingDays++;
    maxAbsDiff = Math.max(maxAbsDiff, Math.min(Math.abs(f - x), 1 - Math.abs(f - x))); // distance on the circle
    const crossed = MOON_BOUNDARIES.filter((b) => f >= b !== x >= b);
    if (crossed.length) flips.push({ day: d, float: f, exact: x, boundaries: crossed });
  }
  return { ...m, differingDays, maxAbsDiff, flips };
}

// Guard: since P0, the real InternalCalendar must equal the exact formula (and so differ from the old float one).
const moons: Moon[] = [...MOONS_365, ...MOONS_400.map((m) => ({ ...m, name: `${m.name}@400` }))];
const cal = new InternalCalendar({ yearLength: 365, epochYear: 1, moons: [...MOONS_365, ...MOONS_400], seasons: [] }, () => 0);
for (let i = 0; i < 20_000; i++) {
  const d = Math.round((i / 20_000 - 0.5) * 2 * MAX_DAY_ORDINAL);
  const ctx = cal.toContext(d).moons!;
  moons.forEach((m, j) => {
    if (ctx[j]!.phase !== exactPhase(d, decimal(m.cycleDays), decimal(m.phaseAtEpoch))) throw new Error(`exactPhase disagrees with InternalCalendar at day ${d} for ${m.name}`);
  });
}

const t0 = performance.now();
const result = { range: [-MAX_DAY_ORDINAL, MAX_DAY_ORDINAL], boundaries: MOON_BOUNDARIES, moons: moons.map(scan) };
const ms = Math.round(performance.now() - t0);
const summary = result.moons.map((m) => `${m.name} (${m.cycleDays}, ${m.phaseAtEpoch}): ${m.flips.length} flip(s), ${m.differingDays} days differ, max ${m.maxAbsDiff.toExponential(2)}`).join("; ");

const path = new URL("../test/golden/moon-flips.json", import.meta.url);
if (process.argv.includes("--write")) {
  await Bun.write(path, JSON.stringify(result, null, 1) + "\n");
  console.log(`wrote ${path.pathname} in ${ms} ms: ${summary}`);
} else {
  const stored = JSON.stringify(await Bun.file(path).json());
  const ok = stored === JSON.stringify(result);
  console.log(`${ok ? "moon flip scan OK" : "MOON FLIP SCAN DRIFT"} (${ms} ms): ${summary}`);
  process.exit(ok ? 0 : 1);
}
