/**
 * Version strings that appear in WeatherReport.provenance (DESIGN-v1.md §6).
 *
 * - RNG_VERSION lives in rng.ts and is frozen with it.
 * - GENERATOR_VERSION changes whenever generator *math* changes. Worlds pin
 *   it; a change is a user-visible "upgrade generator" action, never silent.
 * - SCHEMA_VERSION is the WeatherReport shape. 0 until alpha ships.
 */
export { RNG_VERSION } from "./rng";
export const GENERATOR_VERSION = "wadjet-gen/0.0.3" as const;
export const SCHEMA_VERSION = 0 as const;
