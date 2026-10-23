/**
 * The previous generator's verbatim gate (docs/SESHAT-v0.md §17.2 "The oracle",
 * §17.5 item 2; bead wadjet-9lc step 1). test/golden/previous/dense.json.gz was
 * dumped by scripts/golden-previous.ts at c773f5d^, the last commit that ran
 * wadjet-gen/0.0.3. Every fixture is rebuilt here from its stored data with
 * HEAD's API in "previous" mode, and every stored daily and hourly report must
 * come back identical (JSON.stringify, provenance aside), with the stored
 * per-zone provenance. Current mode must differ on at least one day of every
 * fixture and for every case the fixtures target, so the gate is not vacuous.
 * Each test stands alone, so `bun test -t <fixture>` runs one.
 */
import { describe, expect, test } from "bun:test";
import { PREVIOUS_GENERATOR_VERSION } from "../src/core/version";
import { body, golden, worldOf, type Fixture } from "./fixtures/previous-golden";

const { from: FROM, to: TO } = golden.header;

/** the modifier tags the fixtures target: each must move in current mode somewhere in the golden */
const CASES = ["yp-edge", "moon-edge", "env-edge", "not-regime", "not-era", "era-spell"] as const;

/** Current mode against the oracle: the days that moved, and per case how many moved days carried it in either mode. */
function currentMoves(f: Fixture): { differs: number; moved: Map<string, number>; hashMoved: boolean[] } {
  const cur = worldOf(f, "current");
  const moved = new Map<string, number>(CASES.map((c) => [c, 0]));
  let differs = 0;
  const hashMoved: boolean[] = [];
  for (const z of f.out) {
    const now = cur.getRange(z.zoneId, FROM, TO);
    for (let i = 0; i < now.length; i++) {
      const a = now[i]!;
      const b = z.daily[i]!;
      if (body(a) === JSON.stringify(b)) continue;
      differs++;
      for (const c of CASES) if (a.conditions.includes(c) || b.conditions.includes(c)) moved.set(c, moved.get(c)! + 1);
    }
    hashMoved.push(now[0]!.provenance.calendarHash !== z.provenance.calendarHash);
  }
  return { differs, moved, hashMoved };
}

describe("previous mode reproduces wadjet-gen/0.0.3 (dense oracle)", () => {
  test("the oracle is the previous generator's", () => {
    expect(golden.header.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    expect(golden.fixtures.map((f) => f.id)).toEqual(["internal-365", "internal-360", "internal-400", "almanac", "almanac-no-year-length"]);
  });

  for (const f of golden.fixtures) {
    test(
      `${f.id}: every daily and hourly report, and the provenance`,
      () => {
        const prev = worldOf(f, "previous");
        expect(prev.calendarHash()).toBe(f.calendarHash);
        for (const z of f.out) {
          expect(z.provenance.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
          const daily = prev.getRange(z.zoneId, FROM, TO);
          expect(daily.length).toBe(z.daily.length);
          const bad: number[] = [];
          for (let i = 0; i < daily.length; i++) {
            const r = daily[i]!;
            if (body(r) !== JSON.stringify(z.daily[i])) bad.push(FROM + i);
            expect(r.provenance).toEqual(z.provenance);
          }
          // getReport is the path the dump used; getRange must agree with it (checked on the hourly days)
          for (const h of z.hourly) {
            if (body(prev.getReport(z.zoneId, { dayOrdinal: h.day })) !== JSON.stringify(z.daily[h.day - FROM])) bad.push(h.day);
            for (let hour = 0; hour < 24; hour++) {
              const r = prev.getReport(z.zoneId, { dayOrdinal: h.day, hour });
              if (body(r) !== JSON.stringify(h.reports[hour])) bad.push(h.day + hour / 100);
              expect(r.provenance).toEqual(z.provenance);
            }
          }
          expect({ zone: z.zoneId, mismatched: bad.slice(0, 10), count: bad.length }).toEqual({ zone: z.zoneId, mismatched: [], count: 0 });
        }
        const { differs, hashMoved } = currentMoves(f);
        expect(differs).toBeGreaterThan(0);
        // the internal calendar's hash gained SESHAT_VERSION in 0.0.4; a third-party calendar's did not move
        expect(hashMoved).toEqual(f.out.map(() => f.calendar.kind === "internal"));
      },
      60_000,
    );
  }

  test(
    "current mode moves every targeted case somewhere",
    () => {
      const moved = new Map<string, number>(CASES.map((c) => [c, 0]));
      for (const f of golden.fixtures) for (const [c, n] of currentMoves(f).moved) moved.set(c, moved.get(c)! + n);
      expect(Object.fromEntries([...moved].filter(([, n]) => n === 0))).toEqual({});
    },
    60_000,
  );
});
