/**
 * The mixer rail's model (SPEC §3.3): the four chains, the fixed strip
 * (Regimes / Forcings) and the unit cards, plus the per-chain mute that the
 * LEDs write.
 *
 * Everything the rail draws is derived here, so `ui/mixer.ts` stays a painter
 * (PLAN D3: a surface reads state, it never re-derives it). Three rules the
 * rail leans on:
 *
 *  - **A chain is a projection, not a container.** One `Modifier` can write to
 *    several chains at once (that is the ⧉ linked twin); the chain it appears
 *    in is decided op by op, from the op's parameter path (`channelOf`).
 *  - **Per-chain mute is per-op power.** Muting a linked device in TEMP sets
 *    `enabled: false` on that device's *temperature* ops and leaves the rest
 *    alone. A device whose ops all live in one chain has nothing to
 *    distinguish, so its LED is device power (`Modifier.enabled`) — SPEC §3.3,
 *    "on a single-chain unit it is device power".
 *  - **Compiled ids are never units.** `layer:*` is the channel editor's own
 *    scope stack and `forcings:*` is the fixed strip; neither is a rack card.
 *    `compile.devices()` already filters both, plus `era:*`.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { CalendarDescription } from "../../plugin/time/adapter";
import type { Era, Modifier, ModifierOp, ZoneProfile } from "../../core/types";
import type { Units } from "../../core/units";
import { channelOrNull, devices, getWetness, reorderDevice, totalWarmthAt, TRIM_ID, WARMTH_LANE_ID, WETNESS_ID, type Channel } from "./compile";
import { describeOp, displayName, type Vocabulary } from "./copy";
import { kindOf, toDevice, type Device } from "./devices";
import { dayRangeLabel } from "./format";
import { cycleColour, ERA_CYCLE } from "./palette";

/** A mixer chain is a signal channel seen from the rail. Same four values. */
export type Chain = Channel;

/** Rail order, top to bottom (SPEC §3.3). MASTER is not a chain; it is the tail. */
export const CHAINS: readonly Chain[] = ["temperature", "precipitation", "wind", "sky"];

/** The rail's short names. Uppercase is the chain header's own idiom, not a sentence. */
export const CHAIN_LABEL: Record<Chain, string> = {
  temperature: "TEMP",
  precipitation: "PRECIP",
  wind: "WIND",
  sky: "SKY",
};

/** The palette entry each chain is drawn in, ready to hand to a component (SPEC §9). */
export const CHAIN_COLOR_VAR: Record<Chain, string> = {
  temperature: "var(--wadjet-studio-temp)",
  precipitation: "var(--wadjet-studio-precip)",
  wind: "var(--wadjet-studio-wind)",
  sky: "var(--wadjet-studio-sky)",
};

/**
 * The two fixed units at the top of every chain. `regimes` is in all four
 * chains; `forcings` is `null` outside TEMP and PRECIP (SPEC §3.3).
 */
export interface FixedStrip {
  regimes: { count: number; mutedInChain: boolean };
  /**
   * `total` is the number the strip prints: °C into TEMP (trim + the warmth
   * lane at the window's centre year, PLAN §5.3) and the wetness **factor**
   * in PRECIP, which shows `×k` instead of a temperature. `present` is false
   * when the zone carries no forcings for this chain at all, so the rail can
   * dim a neutral readout rather than imply a write.
   */
  forcings: { present: boolean; total: number; mutedInChain: boolean } | null;
}

/** One chip on a unit card: the when summary, an op, or an era's span. */
export interface UnitChip {
  label: string;
  color?: string;
  hint?: string;
  /** Force the leading dot on when the chip carries no colour of its own. */
  dot?: boolean;
}

/**
 * One rack card in a chain. `id` is the modifier id for a device and
 * `era:<name>` for an era unit — which is also that unit's `unitKey` from
 * `validation.ts`, so the LED's level is one lookup either way.
 */
export interface UnitCard {
  /** two digits in rack order, `"01"` first; devices then `"E"` for every era */
  slot: string;
  id: string;
  name: string;
  /** the kind pill's word — `trim`, `moon`, `spell`, `tag`, `chance`, `custom`, `era` */
  kind: string;
  /** ⧉: this device writes to more than one chain — one brain, several rails */
  linked: boolean;
  /** era units only: the zone count behind the `world · N zones` badge */
  world?: number;
  chips: UnitChip[];
  /** device power (`Modifier.enabled`) */
  enabled: boolean;
  /** every op this unit has in this chain is `enabled: false` */
  mutedInChain: boolean;
  /** eras are appended after the devices and never dragged (SPEC §3.3) */
  reorderable: boolean;
}

/** The `era:` id prefix a unit card carries; matches `unitKey({ kind: "era", … })`. */
const ERA_UNIT = "era:";

/** Is this card an era rather than a zone device? */
export function isEraUnit(card: UnitCard): boolean {
  return card.id.startsWith(ERA_UNIT);
}

/** The era's `world.eras[i].name`, recovered from its unit id — the inverse of `ERA_UNIT + e.name`. */
export function eraNameOf(card: UnitCard): string {
  return card.id.slice(ERA_UNIT.length);
}

/** The ops of `m` that write to `chain`. Ops on an unrecognised path belong to no chain. */
export function chainOps(m: Modifier, chain: Chain): ModifierOp[] {
  return m.apply.filter((o) => channelOrNull(o.param) === chain);
}

/** Every chain `m` writes to. Size > 1 is the ⧉ linked twin. */
export function chainsOf(m: Modifier): Set<Chain> {
  const out = new Set<Chain>();
  for (const o of m.apply) {
    const c = channelOrNull(o.param);
    if (c !== null) out.add(c);
  }
  return out;
}

/** Are all of this chain's ops off? False when the device writes nothing here. */
export function isMutedInChain(m: Modifier, chain: Chain): boolean {
  const ops = chainOps(m, chain);
  return ops.length > 0 && ops.every((o) => o.enabled === false);
}

/** `enabled: false` when muted, the field removed when not — absent is the default. */
function setOpPower(ops: readonly ModifierOp[], muted: boolean): void {
  for (const op of ops) {
    if (muted) op.enabled = false;
    else delete op.enabled;
  }
}

/**
 * Mute (or unmute) one device in one chain.
 *
 * A device with ops in **several** chains gets per-op power on this chain's
 * ops, so the other rails keep it. A device whose ops are all in one chain has
 * no per-chain distinction to make, so the LED is device power instead
 * (SPEC §3.3). A device with nothing in this chain, or an unknown id, is a
 * no-op — the rail never shows a card it cannot write.
 */
export function setChainMute(z: ZoneProfile, id: string, chain: Chain, muted: boolean): void {
  const m = z.modifiers.find((x) => x.id === id);
  if (m === undefined) return;
  const ops = chainOps(m, chain);
  if (ops.length === 0) return;
  if (chainsOf(m).size > 1) {
    setOpPower(ops, muted);
    return;
  }
  if (muted) m.enabled = false;
  else delete m.enabled;
}

/** Every regime op that writes to `chain`, across all regimes, in regime order. */
function regimeOps(z: ZoneProfile, chain: Chain): ModifierOp[] {
  const out: ModifierOp[] = [];
  for (const r of z.regimes) for (const o of r.apply ?? []) if (channelOrNull(o.param) === chain) out.push(o);
  return out;
}

/**
 * The Regimes LED. Regime ops bypass the modifier engine, so the generator
 * filters `enabled === false` on `regime.apply` itself (PLAN §0.1) — this is a
 * real mute, not a UI flag.
 */
export function setRegimesChainMute(z: ZoneProfile, chain: Chain, muted: boolean): void {
  setOpPower(regimeOps(z, chain), muted);
}

export function regimesMutedInChain(z: ZoneProfile, chain: Chain): boolean {
  const ops = regimeOps(z, chain);
  return ops.length > 0 && ops.every((o) => o.enabled === false);
}

/** The `forcings:*` id the fixed strip shows in `chain`, or null outside TEMP/PRECIP. */
export function forcingsIdFor(chain: Chain): string | null {
  if (chain === "temperature") return TRIM_ID;
  if (chain === "precipitation") return WETNESS_ID;
  return null;
}

/** The Forcings LED: per-op power on `forcings:temperature.mean` / `forcings:precipitation`. */
export function setForcingsChainMute(z: ZoneProfile, chain: Chain, muted: boolean): void {
  const id = forcingsIdFor(chain);
  if (id === null) return;
  const m = z.modifiers.find((x) => x.id === id);
  if (m === undefined) return;
  setOpPower(m.apply, muted);
}

export function forcingsMutedInChain(z: ZoneProfile, chain: Chain): boolean {
  const id = forcingsIdFor(chain);
  if (id === null) return false;
  const m = z.modifiers.find((x) => x.id === id);
  if (m === undefined || m.apply.length === 0) return false;
  return m.apply.every((o) => o.enabled === false);
}

/** Does the zone actually carry forcings for this chain, or is the readout a neutral 0/×1? */
function forcingsPresent(z: ZoneProfile, chain: Chain): boolean {
  const id = forcingsIdFor(chain);
  if (id === null) return false;
  if (z.modifiers.some((m) => m.id === id)) return true;
  // TEMP's total also carries the FRC · warmth lane, which is not a modifier.
  return chain === "temperature" && (z.automation ?? []).some((l) => l.id === WARMTH_LANE_ID && l.points.length > 0);
}

/**
 * The collapsed strip for one chain. `windowCentreYear` is the playlist
 * window's centre in fractional years: the warmth lane moves over the world's
 * history, so "= total into TEMP" is only meaningful at a year.
 */
export function fixedStripFor(z: ZoneProfile, chain: Chain, windowCentreYear: number): FixedStrip {
  const regimes = { count: z.regimes.length, mutedInChain: regimesMutedInChain(z, chain) };
  if (chain !== "temperature" && chain !== "precipitation") return { regimes, forcings: null };
  const total = chain === "temperature" ? totalWarmthAt(z, windowCentreYear) : getWetness(z);
  return { regimes, forcings: { present: forcingsPresent(z, chain), total, mutedInChain: forcingsMutedInChain(z, chain) } };
}

const slotLabel = (i: number): string => String(i + 1).padStart(2, "0");

/** The slot marker on an era card: appended, never numbered into the rack (SPEC §3.3). */
const ERA_SLOT = "E";

/**
 * Which of `copy.ts`'s two vocabularies a device's op chips speak. A
 * moon-bound device's chip has to stand alone — the card says *when*, not
 * *what*, so the op names itself in full (`storm odds ×1.50`). Every other
 * kind sits under a name that already carries the meaning, so the short apply
 * word is enough (`precip 0 — no rain`).
 */
function vocabularyFor(kind: string): Vocabulary {
  return kind === "moon" ? "macro" : "target";
}

function opChips(ops: readonly ModifierOp[], chain: Chain, kind: string, units: Units): UnitChip[] {
  const out: UnitChip[] = [];
  const seen = new Set<string>();
  for (const o of ops) {
    const label = describeOp(o, { vocabulary: vocabularyFor(kind), units });
    // Two ops can say the same thing in product terms — `precipitation.pwd`
    // and `.pww` set to 0 are both "no rain". The card shows the reading once;
    // the device window is where the individual ops live.
    if (seen.has(label)) continue;
    seen.add(label);
    // A muted op keeps its chip but loses the chain colour, so the card reads
    // as "still declared, currently off" rather than gone.
    out.push(o.enabled === false ? { label, dot: true, hint: `${label} — off in this chain` } : { label, color: CHAIN_COLOR_VAR[chain] });
  }
  return out;
}

/**
 * The rail's short *when* chip. `devices.ts`'s `whenSummary` is the window's
 * sentence — it carries the spell tail as well — where a rack chip only has
 * room for the gate itself: `clip d223–263`, `moon:Sable · Full`, `era:Drought`.
 */
export function railWhenLabel(d: Device, yearLength = 365): string {
  const w = d.when;
  switch (w.kind) {
    case "always":
      return "always";
    case "moon":
      return `moon:${w.moon} · ${w.phases.length ? w.phases.join(", ") : "custom range"}`;
    case "tag":
      return w.tags.length ? w.tags.join(" or ") : "no tag";
    case "yearWindow":
      // `format.ts`'s `dayRange`, never this chip's own arithmetic: flooring
      // the start and subtracting one from the end put `clip d222–261` in the
      // rail beside the playlist's `d223 – d263` for the one Ashfall clip
      // (bead wadjet-9f9.48.2).
      return `clip ${dayRangeLabel(w.start, w.length, yearLength, { tight: true })}`;
    case "chance":
      return `${Math.round(w.p * 100)}% of days`;
  }
}

/** `400 – 900`, or `400 – ∞` for a span with no end (`Era.to` omitted). */
function eraSpanLabel(e: Era): string {
  return `${e.from} – ${e.to === undefined ? "∞" : e.to}`;
}

/**
 * The rack for one chain: the zone's devices that write to it, in
 * `compile.devices()` order (which is the order in `modifiers[]`, the order a
 * drag rewrites), then the world's eras that write to it. Slots run as one
 * sequence across both, so `01` is always the top card.
 *
 * `layer:*` and `forcings:*` never appear: `devices()` filters them, and the
 * eras come from the world draft, never from `modifiers[]`.
 */
export function unitsFor(
  z: ZoneProfile,
  eras: readonly Era[],
  chain: Chain,
  calendar: CalendarDescription | null,
  zoneCount: number,
  units: Units = "metric",
  eraColours: readonly number[] = [],
): UnitCard[] {
  const out: UnitCard[] = [];
  const yearLength = calendar?.yearLength ?? 365;
  let slot = 0;

  for (const m of devices(z)) {
    const ops = chainOps(m, chain);
    if (ops.length === 0) continue;
    const d = toDevice(m, calendar);
    const kind = kindOf(m);
    out.push({
      slot: slotLabel(slot++),
      id: m.id,
      name: displayName(d.name),
      kind,
      linked: chainsOf(m).size > 1,
      chips: [{ label: railWhenLabel(d, yearLength), color: "var(--wadjet-studio-gold)" }, ...opChips(ops, chain, kind, units)],
      enabled: m.enabled !== false,
      mutedInChain: isMutedInChain(m, chain),
      reorderable: true,
    });
  }

  // Eras are appended after every device and share one marker rather than a
  // number, because they are world-scoped and cannot be dragged (SPEC §3.3).
  eras.forEach((e, i) => {
    const ops = (e.apply ?? []).filter((o) => channelOrNull(o.param) === chain);
    if (ops.length === 0) return;
    out.push({
      slot: ERA_SLOT,
      id: ERA_UNIT + e.name,
      name: e.name,
      kind: "era",
      linked: false,
      world: zoneCount,
      chips: [{ label: eraSpanLabel(e), color: cycleColour(eraColours[i] ?? i, ERA_CYCLE) }, ...opChips(ops, chain, "era", units)],
      enabled: e.enabled !== false,
      mutedInChain: ops.every((o) => o.enabled === false),
      reorderable: false,
    });
  });

  return out;
}

/**
 * Drag-reorder one chain's rack (SPEC §3.3 "drag reorders zone devices",
 * PLAN §2.3): `fromSlot`/`toSlot` are 0-based positions among *this chain's*
 * device cards only (`unitsFor`'s device portion, before the eras), in the
 * standard array-move convention — `toSlot` is where the dragged card ends up
 * once it is lifted out, so dropping it back where it started is `fromSlot
 * === toSlot`, a no-op.
 *
 * The move is realised as one `reorderDevice` call against the *global*
 * device order (`compile.devices(z)`), landing the dragged device immediately
 * next to whichever chain neighbour now sits beside it — so a device this
 * chain does not see (e.g. a PRECIP-only device, seen from TEMP) never moves
 * relative to any other device, and `layer:*`/`forcings:*` keep their fixed
 * `normaliseOrder` positions untouched, same as a plain `reorderDevice` call.
 */
export function reorderInChain(z: ZoneProfile, chain: Chain, fromSlot: number, toSlot: number): void {
  const chainIds = devices(z)
    .filter((m) => chainOps(m, chain).length > 0)
    .map((m) => m.id);
  if (fromSlot < 0 || fromSlot >= chainIds.length) return;
  const to = Math.min(Math.max(Math.trunc(toSlot), 0), chainIds.length - 1);
  if (to === fromSlot) return;
  const draggedId = chainIds[fromSlot]!;

  // The chain-local order the drop asked for — the same lift-out-and-drop
  // arithmetic `reorderDevice` itself uses, just scoped to this chain's ids.
  const moved = chainIds.slice();
  moved.splice(fromSlot, 1);
  moved.splice(to, 0, draggedId);
  const nextInChain = moved[to + 1];
  const prevInChain = moved[to - 1];

  // Translate that into a *global* index: land immediately before the chain
  // neighbour that now follows it, or immediately after the one that now
  // precedes it. Either reads correctly once devices outside this chain are
  // filtered back out, and neither touches any other device's own position.
  const allIds = devices(z).map((m) => m.id);
  const draggedGlobal = allIds.indexOf(draggedId);
  let toIndex: number;
  if (nextInChain !== undefined) {
    const nextGlobal = allIds.indexOf(nextInChain);
    toIndex = nextGlobal > draggedGlobal ? nextGlobal - 1 : nextGlobal;
  } else if (prevInChain !== undefined) {
    const prevGlobal = allIds.indexOf(prevInChain);
    toIndex = prevGlobal > draggedGlobal ? prevGlobal : prevGlobal + 1;
  } else {
    return; // a chain with one device has nothing to reorder against
  }
  reorderDevice(z, draggedId, toIndex);
}
