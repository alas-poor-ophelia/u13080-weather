/**
 * Golden-master generator / checker for the frozen RNG substrate AND the
 * daily generator.
 *
 *   bun run scripts/golden.ts          # check (exit 1 on drift)
 *   bun run scripts/golden.ts --write  # (re)write the golden files — ONLY when
 *                                      # introducing a new RNG_VERSION /
 *                                      # GENERATOR_VERSION
 *
 * Both golden files are also consumed by bun test, so the suite fails on
 * drift too. This script exists for the explicit write path and for CI logs
 * that show exactly which value moved.
 */
import * as rng from "../src/core/rng";
import type { Preset } from "../src/core/types";
import { GENERATOR_VERSION } from "../src/core/version";
import { buildGolden, compareGolden, type Golden } from "../test/golden/golden";
import { buildGoldenGen, compareGoldenGen, type GoldenGen } from "../test/golden/golden-gen";

const rngPath = new URL("../test/golden/rng-1.json", import.meta.url);
const genPath = new URL("../test/golden/gen-0.0.2.json", import.meta.url);
const write = process.argv.includes("--write");

const freshRng: Golden = buildGolden(rng);
const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
const freshGen: GoldenGen = buildGoldenGen(fjord);

if (write) {
  await Bun.write(rngPath, JSON.stringify(freshRng, null, 2) + "\n");
  console.log(`wrote ${rngPath.pathname} (${rng.RNG_VERSION})`);
  await Bun.write(genPath, JSON.stringify(freshGen, null, 2) + "\n");
  console.log(`wrote ${genPath.pathname} (${GENERATOR_VERSION})`);
  process.exit(0);
}

let failed = false;

const storedRng = (await Bun.file(rngPath).json()) as Golden;
const rngDiffs = compareGolden(storedRng, freshRng);
if (rngDiffs.length === 0) {
  console.log(`rng golden OK (${rng.RNG_VERSION}, ${storedRng.hash.length} hash cases, ${storedRng.streams.length} streams)`);
} else {
  failed = true;
  console.error(`RNG GOLDEN DRIFT — ${rngDiffs.length} difference(s):`);
  for (const d of rngDiffs.slice(0, 40)) console.error("  " + d);
  if (rngDiffs.length > 40) console.error(`  ... ${rngDiffs.length - 40} more`);
}

const storedGen = (await Bun.file(genPath).json()) as GoldenGen;
const genDiffs = compareGoldenGen(storedGen, freshGen);
if (genDiffs.length === 0) {
  console.log(`generator golden OK (${GENERATOR_VERSION}, ${storedGen.records.length} days of ${storedGen.presetId})`);
} else {
  failed = true;
  console.error(`GENERATOR GOLDEN DRIFT — ${genDiffs.length} difference(s):`);
  for (const d of genDiffs.slice(0, 40)) console.error("  " + d);
  if (genDiffs.length > 40) console.error(`  ... ${genDiffs.length - 40} more`);
}

process.exit(failed ? 1 : 0);
