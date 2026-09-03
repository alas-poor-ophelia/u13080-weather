/**
 * The mixer rail's half of the hint table (SPEC §3.1, §3.3).
 *
 * `hints.ts` is the header's contract and is scanned against
 * `HEADER_HINT_KEYS`; the rail keeps its own table so a bead can add a control
 * without touching a file another bead owns. The two halves share the same
 * grammar — `[name, detail]` joined by `HINT_SEPARATOR` — so one delegated
 * listener on the studio root still reads both.
 *
 * `ui/insert-picker.ts` (SPEC §3.6) borrows this table for its own rows too —
 * `insert.kind` and `insert.preset` below — but is not scanned by
 * `MIXER_HINT_KEYS` (that list is exactly what `ui/mixer.ts` asks for); the
 * picker overrides each row's detail with its own one-line hint or badge.
 *
 * House rules (SPEC §9): product microcopy, sentence case, no explainer prose.
 * The *name* says what the control is; the *detail* says what moving it writes.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { makeHintLookup, type Hint, type HintLookup } from "./hints";

export const MIXER_HINTS: Record<string, Hint> = {
  "mixer.chain": ["Chain", "every source that writes to this channel, in signal order"],
  // Chrome, so lower case (see the note over `HINTS` in `hints.ts`), and the
  // second clause is the prototype's: the picker offers a KIND or a saved
  // preset, and dropping that clause left the two-column picker unexplained.
  "mixer.insert": ["insert", "add a device to this chain · a new one from a kind, or a saved preset"],
  "mixer.strip": ["Fixed strip", "expand regimes and forcings into full unit cards"],
  "mixer.regimes.led": ["Regimes power", "writes enabled: false on every regime op in this chain"],
  "mixer.regimes.name": ["Regimes", "open the states window"],
  "mixer.forcings.led": ["Forcings power", "writes enabled: false on the zone forcings for this chain"],
  "mixer.forcings.name": ["Forcings", "open the zone forcings window"],
  "mixer.unit.led": ["Device power", "writes enabled: false on this device's ops in this chain"],
  "mixer.unit.name": ["Device", "open this device's window"],
  "mixer.unit.grip": ["Reorder", "drag to move this device in the chain"],
  "mixer.era.led": ["Era power", "writes world.eras[i].enabled — world-scoped, confirmed once per session"],
  "mixer.era.name": ["Era", "open the era window"],
  "mixer.master.led": ["Forcings master", "the zone offsets every chain is measured against"],
  "mixer.master.warmth": ["Warmth", "trim plus the FRC lane at the window's centre year"],
  "mixer.master.wetness": ["Wetness", "scales both wet-day probabilities"],
  "mixer.empty": ["Empty chain", "nothing writes to this channel yet"],
  "insert.kind": ["Device kind", "insert a new device of this shape"],
  "insert.preset": ["Preset", "insert a ready-made device"],
};

/**
 * The keys `src/studio/ui/mixer.ts` uses. `test/studio-hints-mixer.test.ts`
 * scans the surface and holds it against this list in both directions, so a
 * control added without a hint (or a hint left behind by a deleted control)
 * fails the unit gate rather than showing a raw key in the hint bar.
 */
export const MIXER_HINT_KEYS: readonly string[] = [
  "mixer.chain",
  "mixer.insert",
  "mixer.strip",
  "mixer.regimes.led",
  "mixer.regimes.name",
  "mixer.forcings.led",
  "mixer.forcings.name",
  "mixer.unit.led",
  "mixer.unit.name",
  "mixer.unit.grip",
  "mixer.era.led",
  "mixer.era.name",
  "mixer.master.led",
  "mixer.master.warmth",
  "mixer.master.wetness",
  "mixer.empty",
];

/** The `data-hint` value for `key`; an unknown key renders as itself, never blank. */
export const mixerHint: HintLookup = makeHintLookup(MIXER_HINTS);
