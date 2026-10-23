/**
 * The previous generator's verbatim gate (docs/SESHAT-v0.md §17.2 "The oracle",
 * §17.5 item 2; bead wadjet-9lc step 1). test/golden/previous/dense.json.gz was
 * dumped by scripts/golden-previous.ts at c773f5d^, the last commit that ran
 * wadjet-gen/0.0.3. Every fixture is rebuilt here from its stored data with
 * HEAD's API in "previous" mode, and every stored daily and hourly report must
 * come back identical (JSON.stringify, provenance aside), with the stored
 * per-zone provenance. Current mode must differ on at least one day of every
 * fixture and for every case the fixtures target, so the gate is not vacuous.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WeatherReport } from "../src/core/report";
import type { Era, ZoneProfile } from "../src/core/types";
import { PREVIOUS_GENERATOR_VERSION, type GeneratorMode } from "../src/core/version";
import type { InternalCalendarConfig } from "../src/plugin/settings";
import { TimeRegistry, type TimeAdapter } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import { World } from "../src/plugin/world";
import { almanac } from "../scripts/golden-previous";

type Body = Omit<WeatherReport, "provenance">;
interface ZoneOut {
  zoneId: string;
  provenance: WeatherReport["provenance"];
  daily: Body[];
  hourly: Array<{ day: number; reports: Body[] }>;
}
interface Fixture {
  id: string;
  calendar: { kind: "internal"; config: InternalCalendarConfig } | { kind: "almanac"; noYearLength: boolean };
  eras: Era[];
  zones: ZoneProfile[];
  calendarHash: string;
  edgeDays: number[];
  hourlyDays: number[];
  out: ZoneOut[];
}
interface Golden {
  header: { generatorVersion: string; seed: string; from: number; to: number };
  fixtures: Fixture[];
}

const golden = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "golden/previous/dense.json.gz"))))) as Golden;
const { seed: SEED, from: FROM, to: TO } = golden.header;

function worldOf(f: Fixture, mode: GeneratorMode): World {
  const adapter: TimeAdapter = f.calendar.kind === "internal" ? new InternalCalendar(f.calendar.config, () => 0, undefined, mode) : almanac(f.calendar.noYearLength);
  const time = new TimeRegistry(adapter.id);
  time.register(adapter);
  return new World({ seed: SEED, zones: f.zones, eras: f.eras, overrides: [], generatorMode: mode }, time);
}

const body = (r: WeatherReport): string => {
  const { provenance: _p, ...rest } = r;
  return JSON.stringify(rest);
};

/** the modifier tags the fixtures target: each must move in current mode somewhere in the golden */
const CASES = ["yp-edge", "moon-edge", "env-edge", "not-regime", "not-era", "era-spell"] as const;

describe("previous mode reproduces wadjet-gen/0.0.3 (dense oracle)", () => {
  test("the oracle is the previous generator's", () => {
    expect(golden.header.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    expect(golden.fixtures.map((f) => f.id)).toEqual(["internal-365", "internal-360", "internal-400", "almanac", "almanac-no-year-length"]);
  });

  /** per case: did current mode move a day where the case's modifier was active in either mode? */
  const moved = new Map<string, number>(CASES.map((c) => [c, 0]));

  for (const f of golden.fixtures) {
    test(
      `${f.id}: every daily and hourly report, and the provenance`,
      () => {
        const prev = worldOf(f, "previous");
        const cur = worldOf(f, "current");
        expect(prev.calendarHash()).toBe(f.calendarHash);
        let differs = 0;
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

          const now = cur.getRange(z.zoneId, FROM, TO);
          for (let i = 0; i < now.length; i++) {
            const a = now[i]!;
            const b = z.daily[i]!;
            if (body(a) === JSON.stringify(b)) continue;
            differs++;
            for (const c of CASES) if (a.conditions.includes(c) || b.conditions.includes(c)) moved.set(c, moved.get(c)! + 1);
          }
          expect(now[0]!.provenance.calendarHash === z.provenance.calendarHash).toBe(f.calendar.kind !== "internal");
        }
        expect(differs).toBeGreaterThan(0);
      },
      60_000,
    );
  }

  test("current mode moves every targeted case somewhere", () => {
    expect(Object.fromEntries([...moved].filter(([, n]) => n === 0))).toEqual({});
  });
});
