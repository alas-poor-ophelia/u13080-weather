/**
 * The device panel's id, on its own so every module in the folder can reach it
 * without importing `index.ts` (the footer's `remove from chain` closes the
 * window it lives in). `index.ts` re-exports both names, so the folder's public
 * surface is unchanged.
 */

/** Panel ids are `device:<modifierId>`; the mixer opens one from a unit's name (SPEC law 2). */
export const DEVICE_WINDOW_PREFIX = "device:";

export function deviceWindowId(modifierId: string): string {
  return `${DEVICE_WINDOW_PREFIX}${modifierId}`;
}
