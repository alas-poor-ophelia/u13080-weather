/**
 * The audition's hint table, held against the strip the same way
 * `studio-hints.test.ts` holds the header's: `src/studio/ui/audition.ts`
 * imports Obsidian, so the check is a source scan of every `auditionHint("…")`
 * the file asks for.
 *
 * Plus the one hint no static table can hold — the day tip, which is the
 * report's own `describe(…, "short")` and must always name the regime (SPEC
 * §3.5: "hover = day tip (incl. regime)").
 */
import { describe as suite, expect, test } from "bun:test";
import { AUDITION_HINTS, AUDITION_HINT_KEYS, auditionHint, dayTip } from "../src/studio/model/hints-audition";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import { buildReport } from "../src/core/report";
import type { DailyRecord } from "../src/core/generator";

const AUDITION_SOURCE = await Bun.file(new URL("../src/studio/ui/audition.ts", import.meta.url)).text();

function keysUsedByStrip(): string[] {
  const found = new Set<string>();
  for (const m of AUDITION_SOURCE.matchAll(/auditionHint\(\s*"([^"]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

const record: DailyRecord = {
  dayOrdinal: 129,
  yearPhase: 0.36,
  regime: "frontal",
  wet: true,
  precipMm: 4.2,
  precipType: "rain",
  tempMean: 11.5,
  tempHigh: 15,
  tempLow: 8,
  tempResidual: 0.2,
  humidity: 0.82,
  cloudCover: 0.7,
  windSpeedKph: 18,
  windDirectionDeg: 225,
  calm: false,
  tags: [],
};

const report = buildReport(record, "greywold", { seed: "s", provenance: { profileHash: "p", calendarHash: "c" } });

suite("audition hints", () => {
  test("every key the strip uses exists in AUDITION_HINTS", () => {
    const used = keysUsedByStrip();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => AUDITION_HINTS[k] === undefined)).toEqual([]);
  });

  test("AUDITION_HINT_KEYS is exactly what audition.ts asks for", () => {
    expect(keysUsedByStrip()).toEqual([...AUDITION_HINT_KEYS].sort());
  });

  test("auditionHint builds a two-half attribute and honours a detail override", () => {
    expect(parseHint(auditionHint("audition.reroll"))).toEqual(AUDITION_HINTS["audition.reroll"]!);
    expect(auditionHint("audition.reroll", "spelled out")).toBe(`re-roll${HINT_SEPARATOR}spelled out`);
    expect(auditionHint("nope")).toBe("nope");
  });

  test("dayTip names the day, describes the weather and always carries the regime", () => {
    const tip = dayTip(report, 129, 365);
    const [name, detail] = parseHint(tip);
    // `dayOfYear` is 0-based on an AuditionDay, and so is the label — the tip
    // agrees with the ruler under the strip (bead wadjet-9f9.48.2).
    expect(name).toBe("d129");
    expect(detail).toContain("regime:frontal");
    expect(detail).toContain("rain");
    expect(detail.endsWith("regime:frontal")).toBe(true);
  });
});
