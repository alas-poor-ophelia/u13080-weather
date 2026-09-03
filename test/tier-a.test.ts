import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { evalCurve } from "../src/core/curve";
import { applyTierA, describeTierA, latitudeBaselineC, rankPresets, tierAAdjustment } from "../src/core/tier-a";
import type { Preset } from "../src/core/types";

const dir = new URL("../presets/", import.meta.url);
const presets: Preset[] = await Promise.all(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => Bun.file(new URL(f, dir)).json() as Promise<Preset>),
);

describe("Tier A", () => {
  test("latitude baseline reproduces the Azgaar anchors", () => {
    expect(latitudeBaselineC(0)).toBe(27);
    expect(latitudeBaselineC(16)).toBeCloseTo(27 - 16 * 0.15, 9);
    expect(latitudeBaselineC(90)).toBeCloseTo(-30, 9);
    expect(latitudeBaselineC(-90)).toBeCloseTo(-15, 9);
    expect(latitudeBaselineC(50)).toBeLessThan(latitudeBaselineC(40));
  });

  test("nearest preset is sensible for archetypal geographies", () => {
    const pick = (g: Parameters<typeof rankPresets>[0]) => rankPresets(g, presets)[0]!.preset.id;
    expect(pick({ latitude: 61, altitude: 20, continentality: 0.1, orographic: "windward" })).toBe("fjord-coast");
    expect(pick({ latitude: 2, altitude: 10, continentality: 0.1, orographic: "none" })).toBe("equatorial-rainforest");
    expect(pick({ latitude: -24, altitude: 500, continentality: 0.9, orographic: "none" })).toBe("red-desert");
    expect(pick({ latitude: 64, altitude: 100, continentality: 1, orographic: "none" })).toBe("frozen-heartland");
    expect(["alpine-pass", "pamir-plateau"]).toContain(pick({ latitude: 40, altitude: 3500, continentality: 0.9, orographic: "none" }));
    expect(pick({ latitude: 37, altitude: 30, continentality: 0.3, orographic: "none" })).toBe("olive-coast");
  });

  test("unstated continentality: axis ignored in matching, preset's own swing kept", () => {
    const fjord = presets.find((p) => p.id === "fjord-coast")!;
    const adj = tierAAdjustment({ latitude: 62, altitude: 30, orographic: "windward" }, fjord.match);
    expect(adj.amplitudeScale).toBe(1);
    expect(describeTierA(fjord, adj)).not.toContain("continentality");
    const withCont = rankPresets({ latitude: 62, altitude: 30, continentality: fjord.match.continentality, orographic: "windward" }, presets)[0]!;
    const without = rankPresets({ latitude: 62, altitude: 30, orographic: "windward" }, presets)[0]!;
    expect(without.preset.id).toBe(withCont.preset.id);
    expect(without.distance).toBeCloseTo(withCont.distance, 9);
  });

  test("adjustments: lapse rate, latitude shift, continentality, hemisphere", () => {
    const fjord = presets.find((p) => p.id === "fjord-coast")!;
    const adj = tierAAdjustment({ latitude: -60, altitude: 1012, continentality: 0.1, orographic: "windward" }, fjord.match);
    expect(adj.altitudeDeltaC).toBeCloseTo(-6.5, 6);
    expect(adj.hemisphereFlipped).toBe(true);
    expect(adj.amplitudeScale).toBeCloseTo(1, 9);
    // same |lat| but southern hemisphere: Azgaar's south pole is warmer → small positive delta
    expect(adj.latitudeDeltaC).toBeGreaterThan(0);

    const out = applyTierA(fjord.climate, adj);
    // seasons flipped: the preset's July value now appears in January
    expect(evalCurve(out.temperature.mean, 0.04)).toBeCloseTo(evalCurve(fjord.climate.temperature.mean, 0.54) + adj.latitudeDeltaC + adj.altitudeDeltaC, 6);
    expect(out.temperature.phase).toBeCloseTo((fjord.climate.temperature.phase + 0.5) % 1, 9);
    // other curves are shifted too, not just temperature
    expect(evalCurve(out.precipitation.pww, 0.04)).toBeCloseTo(evalCurve(fjord.climate.precipitation.pww, 0.54), 9);
    // precipitation amounts untouched
    expect(out.precipitation.scale).not.toBe(fjord.climate.precipitation.scale); // shifted array (new identity)
    expect(evalCurve(out.precipitation.scale, 0.3)).toBeCloseTo(evalCurve(fjord.climate.precipitation.scale, 0.8), 9);

    const text = describeTierA(fjord, adj);
    expect(text).toContain("Closest match: Bergen (");
    expect(text).toContain("−6.5 °C for altitude");
    expect(text).toContain("flipped");
  });

  test("no adjustment when geography equals the station", () => {
    const p = presets.find((x) => x.id === "olive-coast")!;
    const adj = tierAAdjustment({ latitude: p.match.latitude, altitude: p.match.altitude, continentality: p.match.continentality, orographic: p.match.orographic }, p.match);
    expect(adj.latitudeDeltaC).toBe(0);
    expect(adj.altitudeDeltaC).toBe(0);
    expect(adj.amplitudeScale).toBe(1);
    expect(adj.hemisphereFlipped).toBe(false);
    expect(applyTierA(p.climate, adj)).toEqual(p.climate);
    expect(describeTierA(p, adj)).toContain("No adjustment");
  });
});
