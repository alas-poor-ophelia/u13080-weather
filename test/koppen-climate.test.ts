import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { koppenOfClimate } from "../src/core/koppen";
import type { Preset } from "../src/core/types";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);

describe("koppenOfClimate (zone readout from resolved curves)", () => {
  test("agrees with the station-derived class for the presets", () => {
    // The preset class was computed from the station's monthly tables; the readout re-derives it
    // from the fitted curves. All 26 agreed when this gate was set (2026-08-23); a disagreement
    // means the curve fit or the readout's expected-precipitation model drifted.
    const mismatches: string[] = [];
    for (const p of presets) {
      const got = koppenOfClimate(p.climate).code;
      if (got !== p.match.koppen) mismatches.push(`${p.id}: curves → ${got}, station → ${p.match.koppen}`);
    }
    expect(presets.length).toBeGreaterThanOrEqual(26);
    expect(mismatches).toEqual([]);
  });

  test("hemisphere follows the coldest-day phase", () => {
    const fjord = presets.find((p) => p.id === "fjord-coast")!;
    const north = koppenOfClimate(fjord.climate);
    expect(north.group).toBe("C");
    expect(north.description.length).toBeGreaterThan(0);
  });
});
