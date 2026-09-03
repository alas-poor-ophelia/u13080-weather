/**
 * The device window's half of the hint tables (SPEC §3.1 hint bar, §3.4).
 *
 * `model/hints.ts` is the header's table and the shared mechanism (the
 * `name — detail` attribute encoding, `parseHint`, the default hint). This
 * file holds the entries the *device* window asks for, so the beads that write
 * the floating windows do not have to share one file.
 *
 * Same house rules as `hints.ts` (SPEC §9): product microcopy, sentence case,
 * no explainer prose, no trailing full stop. The *name* says what the control
 * is; the *detail* says what moving it writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const DEVICE_HINTS: Record<string, Hint> = {
  // --- title row (SPEC §3.4 shared chrome) ---
  "device.power": ["Power", "enabled: false skips the device at both stages"],

  // --- WHEN ---
  "device.when": ["When", "which days the device is active — the modifier's predicate"],
  "device.when.moon": ["Carrier moon", "opens the cycle editor for this moon"],
  "device.when.moonPick": ["Moon", "which moon carries the device"],
  "device.when.phase": ["Phase", "selected phases compile to one [a, b) window"],
  "device.when.gate": ["Moon gate", "drag either handle to set the phase window"],
  "device.when.tag": ["Tag", "a day carrying the tag matches; several tags are any"],
  "device.when.tagAdd": ["Add a tag", "gate the device on another season or era"],
  "device.when.lane": ["Year window", "the days of the year the device covers"],
  "device.when.start": ["Start", "first day of the window, as a year phase"],
  "device.when.length": ["Length", "how many days the window covers"],
  "device.when.window.add": ["Add a window", "a second clip, repeating every year"],
  "device.when.window.remove": ["Remove window", "drops this clip from the year"],
  "device.when.chance": ["Chance", "the share of days the device fires on"],

  // --- SPELL ---
  "device.spell": ["Spell", "runs start inside the window and last a while"],
  "device.spell.starts": ["Starts a year", "expected number of runs per year"],
  "device.spell.duration": ["Duration", "mean run length in days"],

  // --- APPLY ---
  "device.op": ["Apply", "what the device does to the curve"],
  "device.op.power": ["Op power", "a disabled op never reaches the curves"],
  "device.op.remove": ["Remove op", "drops this parameter from the device"],
  "device.op.add": ["Add an op", "pick a parameter for this device to move"],

  // --- MOD ---
  "device.mod": ["Mod", "gates and onset envelopes — daily stage only"],
  "device.mod.carrier": ["Carrier", "the cycle this device's onset rides — click to edit it"],
  "device.mod.mode": ["Cycle mode", "curve follows the drawn envelope; phases is on or off per phase"],
  "device.gate.source": ["Gate", "the tag that dims this device"],
  "device.gate.amount": ["Amount", "a dimmer: 1 is full strength, 0 mutes"],
  "device.gate.remove": ["Remove gate", "the device runs at full strength again"],
  "device.gate.add": ["Add a gate", "pick a season or era to dim the device on"],
  "device.envelope": ["Envelope", "drag the onset shape across the moon cycle"],
  "device.envelope.shape": ["Onset shape", "a named curve, or the points you drew"],
  "device.envelope.remove": ["Remove envelope", "the op returns to full strength"],

  // --- footer ---
  "device.remove": ["Remove from chain", "deletes the modifier from this zone"],
};

/**
 * The keys the device window uses. `test/studio-hints-device.test.ts` scans
 * `src/studio/ui/windows/device.ts` and asserts this list is exactly what it
 * asks for, so a control added without a hint (or a hint left behind by a
 * deleted control) fails the unit gate rather than showing an empty hint bar.
 */
export const DEVICE_HINT_KEYS: readonly string[] = Object.keys(DEVICE_HINTS);

/**
 * The `data-hint` attribute value for `key`, the device window's mirror of
 * `hints.ts`'s `hintAttr`. An unknown key falls back to the key itself rather
 * than an empty string, so a missing entry shows in the UI instead of silently
 * blanking the bar.
 */
export const deviceHint: HintLookup = makeHintLookup(DEVICE_HINTS);
