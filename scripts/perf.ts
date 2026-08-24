/** Quick timing of the generator against a real preset. `bun run scripts/perf.ts` */
import { Generator, gregorianTime } from "../src/core/generator";
import type { Preset } from "../src/core/types";

const p = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
const g = new Generator({ seed: "perf", zoneId: p.id, climate: p.climate, regimes: p.regimes, timeOf: gregorianTime });

let t = performance.now();
g.day(123456);
console.log(`single cold day (90-day warm-up + 64-day block): ${(performance.now() - t).toFixed(2)} ms`);
t = performance.now();
g.range(0, 365);
console.log(`1 year:   ${(performance.now() - t).toFixed(2)} ms`);
t = performance.now();
g.range(10000, 10000 + 36525);
console.log(`100 years: ${(performance.now() - t).toFixed(1)} ms`);
