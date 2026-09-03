/**
 * Tier A (DESIGN-v1.md §2 "Tier A, precisely"): geography → nearest preset
 * + the cited temperature adjustments. NOT a climate model.
 *
 * Cited:
 *  - latitude → mean temperature: Azgaar FMG v1.99 piecewise constants
 *    (equator 27 °C; tropics to 16 °N / −20 °S at gradient 0.15 °C/deg;
 *    linear to −30 °C at the N pole, −15 °C at the S pole).
 *  - altitude: −6.5 °C/km environmental lapse rate.
 *  - hemisphere: a southern zone matched to a northern preset (or vice
 *    versa) has every curve shifted by half a year.
 *
 * HEURISTIC (bounded, monotone, stated):
 *  - seasonal amplitude scales with continentality as
 *    (0.3 + c_zone) / (0.3 + c_preset).
 */
import { mapCurves, scaleAmplitude, shiftPhase, applyCurveOp } from "./curve-ops";
import { wrapPhase } from "./curve";
import type { ClimateParams, Geography, MatchProfile, Preset } from "./types";

export const AZGAAR = {
  equatorC: 27,
  northPoleC: -30,
  southPoleC: -15,
  tropicN: 16,
  tropicS: -20,
  tropicalGradient: 0.15,
} as const;

export const LAPSE_C_PER_KM = 6.5;
const CONTINENTALITY_FLOOR = 0.3; // HEURISTIC

/** Sea-level baseline temperature by latitude (Azgaar v1.99 calculateTemperatures). */
export function latitudeBaselineC(lat: number): number {
  const a = AZGAAR;
  if (lat >= a.tropicS && lat <= a.tropicN) return a.equatorC - Math.abs(lat) * a.tropicalGradient;
  if (lat > 0) {
    const tAtTropic = a.equatorC - a.tropicN * a.tropicalGradient;
    return tAtTropic + ((lat - a.tropicN) / (90 - a.tropicN)) * (a.northPoleC - tAtTropic);
  }
  const tAtTropic = a.equatorC - Math.abs(a.tropicS) * a.tropicalGradient;
  return tAtTropic + ((Math.abs(lat) - Math.abs(a.tropicS)) / (90 - Math.abs(a.tropicS))) * (a.southPoleC - tAtTropic);
}

export interface MatchCandidate {
  preset: Preset;
  distance: number;
}

/**
 * Weighted distance over the match axes. Latitude compares by |lat| (climate
 * similarity); hemisphere is handled by phase shift, not by distance.
 */
export function presetDistance(g: Geography, m: MatchProfile): number {
  const dLat = Math.abs(Math.abs(g.latitude) - Math.abs(m.latitude)) / 30;
  const dAlt = Math.abs(g.altitude - m.altitude) / 1500;
  const dCont = g.continentality === undefined ? 0 : Math.abs(g.continentality - m.continentality);
  const dOro = g.orographic === m.orographic ? 0 : g.orographic === "none" || m.orographic === "none" ? 0.25 : 0.5;
  return dLat + dAlt + dCont + dOro;
}

export function rankPresets(g: Geography, presets: readonly Preset[]): MatchCandidate[] {
  return presets.map((preset) => ({ preset, distance: presetDistance(g, preset.match) })).sort((a, b) => a.distance - b.distance);
}

export interface TierAAdjustment {
  latitudeDeltaC: number;
  altitudeDeltaC: number;
  amplitudeScale: number;
  hemisphereFlipped: boolean;
}

/** Compute the adjustments a zone's geography implies relative to the preset's station. */
export function tierAAdjustment(g: Geography, m: MatchProfile): TierAAdjustment {
  const latitudeDeltaC = latitudeBaselineC(g.latitude) - latitudeBaselineC(m.latitude);
  const altitudeDeltaC = ((m.altitude - g.altitude) / 1000) * LAPSE_C_PER_KM;
  const amplitudeScale = g.continentality === undefined ? 1 : (CONTINENTALITY_FLOOR + g.continentality) / (CONTINENTALITY_FLOOR + m.continentality);
  const hemisphereFlipped = Math.sign(g.latitude) !== Math.sign(m.latitude) && g.latitude !== 0 && m.latitude !== 0;
  return { latitudeDeltaC, altitudeDeltaC, amplitudeScale, hemisphereFlipped };
}

/** Apply Tier A to a copied preset climate. Returns a new ClimateParams. */
export function applyTierA(climate: ClimateParams, adj: TierAAdjustment): ClimateParams {
  let c = climate;
  if (adj.hemisphereFlipped) {
    c = mapCurves(c, (curve) => shiftPhase(curve, 0.5));
    c = { ...c, temperature: { ...c.temperature, phase: wrapPhase(c.temperature.phase + 0.5) } };
  }
  const meanShift = adj.latitudeDeltaC + adj.altitudeDeltaC;
  if (meanShift !== 0) c = { ...c, temperature: { ...c.temperature, mean: applyCurveOp(c.temperature.mean, { param: "temperature.mean", op: "offset", value: meanShift }) } };
  if (adj.amplitudeScale !== 1) c = { ...c, temperature: { ...c.temperature, mean: scaleAmplitude(c.temperature.mean, adj.amplitudeScale) } };
  return c;
}

/**
 * What Tier A changed, one clause each and nothing else — the pieces
 * `describeTierA` joins into its sentence, and the pieces the Atlas's
 * closest-match card prints on their own line. Empty when nothing moved.
 */
export function tierAParts(adj: TierAAdjustment): string[] {
  const parts: string[] = [];
  if (Math.abs(adj.latitudeDeltaC) >= 0.05) parts.push(`${fmt(adj.latitudeDeltaC)} °C for latitude`);
  if (Math.abs(adj.altitudeDeltaC) >= 0.05) parts.push(`${fmt(adj.altitudeDeltaC)} °C for altitude`);
  if (Math.abs(adj.amplitudeScale - 1) >= 0.01) parts.push(`seasonal swing ×${adj.amplitudeScale.toFixed(2)} for continentality`);
  if (adj.hemisphereFlipped) parts.push("seasons flipped for the opposite hemisphere");
  return parts;
}

/** One-line provenance for the UI: "Closest match: Astana (BSk). Temperature adjusted −3.2 °C for altitude." */
export function describeTierA(preset: Preset, adj: TierAAdjustment): string {
  const parts = tierAParts(adj);
  const head = `Closest match: ${preset.source.place ?? preset.source.stationName} (${preset.match.koppen}, ${preset.name}).`;
  return parts.length ? `${head} Adjusted: ${parts.join("; ")}.` : `${head} No adjustment.`;
}

function fmt(x: number): string {
  return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
}
