import { describe, expect, test } from "bun:test";
import { buildGoldenStudioYears, compareGoldenStudioYears, type GoldenStudioYears } from "./golden/golden-studio-years";
import stored from "./golden/studio-years.json";

describe("golden master (the Studio's year arithmetic on legacy worlds, Seshat P3b)", () => {
  test("studio-years.json matches spans, ticks, labels, dragToWhen and firstDayOfYear exactly on constant-year worlds", () => {
    expect(compareGoldenStudioYears(stored as unknown as GoldenStudioYears, buildGoldenStudioYears())).toEqual([]);
  });
});
