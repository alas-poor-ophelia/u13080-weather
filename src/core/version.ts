/**
 * Version strings that appear in WeatherReport.provenance (DESIGN-v1.md §6).
 *
 * - RNG_VERSION lives in rng.ts and is frozen with it.
 * - GENERATOR_VERSION changes whenever generator *math* changes. A build ships
 *   the current generator plus the one before it (PREVIOUS_GENERATOR_VERSION),
 *   the latter only so a world can be upgraded on its own terms (SESHAT-v0
 *   §17, ruling R1). Each world records the version it last accepted, and a
 *   change is shown to the user until acknowledged, never silent.
 * - SCHEMA_VERSION is the WeatherReport shape. 0 until alpha ships.
 */
export { RNG_VERSION } from "./rng";
export const GENERATOR_VERSION = "wadjet-gen/0.0.4" as const;
/** The generator before GENERATOR_VERSION: a world stamped with it keeps running it until upgraded (§17 R2). */
export const PREVIOUS_GENERATOR_VERSION = "wadjet-gen/0.0.3" as const;
export const SCHEMA_VERSION = 0 as const;

/**
 * Which generator a world runs. Per instance (createGenerator, ModifierEngine,
 * InternalCalendar, World, the Studio audition), never a module global: a
 * freeze runs both modes in one process (§17.5 item 4).
 */
export type GeneratorMode = "current" | "previous";

/** The mode a world stamped `storedVersion` runs: exactly PREVIOUS_GENERATOR_VERSION gives "previous", anything else "current" (§17 R2). */
export function modeFor(storedVersion: string | undefined): GeneratorMode {
  return storedVersion === PREVIOUS_GENERATOR_VERSION ? "previous" : "current";
}

/** The version string a mode stamps in provenance.generatorVersion. */
export function generatorVersionOf(mode: GeneratorMode): string {
  return mode === "previous" ? PREVIOUS_GENERATOR_VERSION : GENERATOR_VERSION;
}
