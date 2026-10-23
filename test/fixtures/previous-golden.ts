/**
 * The previous generator's dense oracle (test/golden/previous/dense.json.gz, dumped by
 * scripts/golden-previous.ts at c773f5d^) and the worlds rebuilt from it with HEAD's API.
 * Shared by test/golden-previous.test.ts and test/keep.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Override, WeatherReport } from "../../src/core/report";
import type { Era, ZoneProfile } from "../../src/core/types";
import type { GeneratorMode } from "../../src/core/version";
import type { FrozenDay } from "../../src/plugin/keep";
import type { InternalCalendarConfig } from "../../src/plugin/settings";
import { TimeRegistry, type TimeAdapter } from "../../src/plugin/time/adapter";
import { InternalCalendar } from "../../src/plugin/time/internal";
import { World } from "../../src/plugin/world";
import { almanac } from "../../scripts/golden-previous";

export type Body = Omit<WeatherReport, "provenance">;
export interface ZoneOut {
  zoneId: string;
  provenance: WeatherReport["provenance"];
  daily: Body[];
  hourly: Array<{ day: number; reports: Body[] }>;
}
export interface Fixture {
  id: string;
  calendar: { kind: "internal"; config: InternalCalendarConfig } | { kind: "almanac"; noYearLength: boolean };
  eras: Era[];
  zones: ZoneProfile[];
  calendarHash: string;
  edgeDays: number[];
  hourlyDays: number[];
  out: ZoneOut[];
}
export interface Golden {
  header: { generatorVersion: string; seed: string; from: number; to: number };
  fixtures: Fixture[];
}

export const golden = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(import.meta.dir, "../golden/previous/dense.json.gz"))))) as Golden;

/** The fixture's calendar as `mode` runs it (only the internal calendar has a mode). */
export function adapterOf(f: Fixture, mode: GeneratorMode): TimeAdapter {
  return f.calendar.kind === "internal" ? new InternalCalendar(f.calendar.config, () => 0, undefined, mode) : almanac(f.calendar.noYearLength);
}

/** The fixture's world under `mode`, with optional pins and kept weather. */
export function worldOf(f: Fixture, mode: GeneratorMode, extra: { overrides?: Override[]; frozen?: FrozenDay[] } = {}): World {
  const adapter = adapterOf(f, mode);
  const time = new TimeRegistry(adapter.id);
  time.register(adapter);
  return new World({ seed: golden.header.seed, zones: f.zones, eras: f.eras, overrides: extra.overrides ?? [], ...(extra.frozen ? { frozen: extra.frozen } : {}), generatorMode: mode }, time);
}

/** A report without its provenance, as the oracle stores it. */
export const body = (r: WeatherReport): string => {
  const { provenance: _p, ...rest } = r;
  return JSON.stringify(rest);
};
