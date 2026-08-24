/**
 * Golden master for the generator: fjord-coast preset, fixed seed, a window
 * that crosses block boundaries (−70 … 70 spans blocks −2, −1, 0, 1).
 * Floats compared at 1e-9 relative (see rng.ts cross-engine note).
 */
import { Generator, gregorianTime, type DailyRecord } from "../../src/core/generator";
import { GENERATOR_VERSION, RNG_VERSION } from "../../src/core/version";
import type { Preset } from "../../src/core/types";

export interface GoldenGen {
  generatorVersion: string;
  rngVersion: string;
  presetId: string;
  presetContentHash: string;
  seed: string;
  from: number;
  to: number;
  records: DailyRecord[];
}

export const GEN_SEED = "golden-seed";
export const GEN_FROM = -70;
export const GEN_TO = 70;

export function buildGoldenGen(preset: Preset): GoldenGen {
  const g = new Generator({ seed: GEN_SEED, zoneId: preset.id, climate: preset.climate, regimes: preset.regimes, timeOf: gregorianTime });
  return {
    generatorVersion: GENERATOR_VERSION,
    rngVersion: RNG_VERSION,
    presetId: preset.id,
    presetContentHash: preset.contentHash,
    seed: GEN_SEED,
    from: GEN_FROM,
    to: GEN_TO,
    records: g.range(GEN_FROM, GEN_TO),
  };
}

const REL_TOL = 1e-9;
function close(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300) <= REL_TOL;
}

export function compareGoldenGen(stored: GoldenGen, fresh: GoldenGen): string[] {
  const out: string[] = [];
  for (const k of ["generatorVersion", "rngVersion", "presetId", "presetContentHash", "seed"] as const) {
    if (stored[k] !== fresh[k]) out.push(`${k}: ${stored[k]} -> ${fresh[k]}`);
  }
  if (stored.records.length !== fresh.records.length) out.push(`record count ${stored.records.length} -> ${fresh.records.length}`);
  stored.records.forEach((s, i) => {
    const f = fresh.records[i];
    if (!f) return;
    for (const key of Object.keys(s) as Array<keyof DailyRecord>) {
      const a = s[key];
      const b = f[key];
      const same = typeof a === "number" && typeof b === "number" ? close(a, b) : JSON.stringify(a) === JSON.stringify(b);
      if (!same) out.push(`day ${s.dayOrdinal} ${key}: ${String(a)} -> ${String(b)}`);
    }
  });
  return out;
}
