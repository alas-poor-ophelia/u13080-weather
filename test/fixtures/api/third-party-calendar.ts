/**
 * Worked example for docs/API.md §5 (`TimeAdapter`): a fictional calendar
 * plugin, "Almanac of Foo". Demonstrates:
 *  - a variable year length (every 4th year runs a day long — `yearLength`
 *    is reported per `TimeContext`, not fixed);
 *  - two seasons;
 *  - two moons, one with named phases;
 *  - `parse`/`format`, `configHash`, and `describe()`.
 *
 * This file is imported by both docs/API.md (copied verbatim into a code
 * block — keep the two in sync) and test/api-doc.test.ts (imported and
 * exercised directly). Do not add anything here that isn't shown in the doc.
 */
import type { CalendarDescription, TimeAdapter, TimeContext } from "../../../src/plugin/time/adapter";

export function makeAdapter(): TimeAdapter {
  const YEAR_DAYS = 400;
  const LEAP_EVERY = 4; // every 4th year (index 3, 7, 11, ...) runs 401 days
  const CYCLE_DAYS = YEAR_DAYS * (LEAP_EVERY - 1) + (YEAR_DAYS + 1); // 1601
  const EPOCH_YEAR = 1;

  const SEASONS = [
    { name: "Wet", from: 0 },
    { name: "Dry", from: 0.5 },
  ];

  const MOONS = [
    {
      name: "Ember",
      cycleDays: 33,
      phaseAtEpoch: 0,
      phases: [
        { name: "new", at: 0 },
        { name: "waxing", at: 0.25 },
        { name: "full", at: 0.5 },
        { name: "waning", at: 0.75 },
      ],
    },
    { name: "Cinder", cycleDays: 91, phaseAtEpoch: 0.1 },
  ];

  /** Pure arithmetic — O(1) and safe for any finite `dayOrdinal`, including negative and huge ones. */
  function yearInfo(dayOrdinal: number): { year: number; yearStart: number; yearLength: number } {
    const cycleIndex = Math.floor(dayOrdinal / CYCLE_DAYS);
    const dayInCycle = dayOrdinal - cycleIndex * CYCLE_DAYS;
    const isLeapYear = dayInCycle >= YEAR_DAYS * (LEAP_EVERY - 1);
    const yearIndexInCycle = isLeapYear ? LEAP_EVERY - 1 : Math.floor(dayInCycle / YEAR_DAYS);
    const yearStart = cycleIndex * CYCLE_DAYS + yearIndexInCycle * YEAR_DAYS;
    const yearLength = isLeapYear ? YEAR_DAYS + 1 : YEAR_DAYS;
    const year = cycleIndex * LEAP_EVERY + yearIndexInCycle + EPOCH_YEAR;
    return { year, yearStart, yearLength };
  }

  function seasonAt(yearPhase: number): string {
    let cur = SEASONS[SEASONS.length - 1]!;
    for (const s of SEASONS) if (yearPhase >= s.from) cur = s;
    return cur.name;
  }

  function wrap(x: number): number {
    const r = x - Math.floor(x);
    return r === 1 ? 0 : r;
  }

  function toContext(dayOrdinal: number): TimeContext {
    const { year, yearStart, yearLength } = yearInfo(dayOrdinal);
    const dayOfYear = dayOrdinal - yearStart;
    const yearPhase = dayOfYear / yearLength;
    const moons = MOONS.map((m) => ({ name: m.name, phase: wrap(dayOrdinal / m.cycleDays + m.phaseAtEpoch) }));
    return { dayOrdinal, yearPhase, yearLength, dayOfYear, year, moons, tags: [`season:${seasonAt(yearPhase)}`], source: "almanac-of-foo" };
  }

  return {
    id: "almanac-of-foo",
    // This almanac doesn't track a real-world "today" — it only converts ordinals Wadjet gives it.
    now: () => null,
    toContext,
    configHash: () => `almanac:${YEAR_DAYS}:${LEAP_EVERY}`,
    parse(text: string): number | null {
      const t = text.trim();
      return /^-?\d+$/.test(t) ? Number(t) : null;
    },
    format(dayOrdinal: number): string {
      const c = toContext(dayOrdinal);
      return `Year ${c.year}, day ${(c.dayOfYear ?? 0) + 1} of ${c.yearLength}`;
    },
    describe(): CalendarDescription {
      return {
        label: "Almanac of Foo",
        readOnly: true,
        yearLength: YEAR_DAYS,
        epochYear: EPOCH_YEAR,
        seasons: SEASONS.map((s) => ({ ...s })),
        moons: MOONS.map((m) => ({ name: m.name, cycleDays: m.cycleDays, phaseAtEpoch: m.phaseAtEpoch, ...(m.phases ? { phases: m.phases.map((p) => ({ ...p })) } : {}) })),
        editHint: "Almanac of Foo settings",
      };
    },
  };
}
