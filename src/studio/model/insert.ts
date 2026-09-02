/**
 * The insert picker's pure model (SPEC §3.6 "Insert picker", PLAN D12).
 *
 * `ui/insert-picker.ts` paints the popover; everything it needs to decide what
 * to show and what an insert writes lives here, so the picker itself is a
 * thin dispatcher onto `insertDevice` / `insertPreset` (PLAN D3).
 *
 * Two things worth knowing:
 *
 *  - **A kind's default is `devices.ts`'s, never re-derived here.** `insertKinds`
 *    only supplies the label and one-line hint the popover shows; `newDevice`
 *    still owns the default WHEN and the chain's neutral apply op.
 *  - **A preset keeps its own apply.** The chain the picker was opened from
 *    decides nothing about what a preset writes — only a bare *kind* gets the
 *    chain's default apply (SPEC §3.6: "Picking creates a device with a
 *    default apply for that channel" is about kinds). `chain` is still part of
 *    `insertPreset`'s signature so both branches of the picker can call
 *    through one shape; it is unused today and reserved for a future
 *    chain-aware retarget.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { ZoneProfile } from "../../core/types";
import type { DevicePreset } from "../../plugin/settings";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { normaliseOrder, type Channel } from "./compile";
import { newDevice, toModifier, type DeviceKind } from "./devices";
import { presetToDevice, SHIPPED_PRESETS } from "./presets";
import type { WorldDraft } from "./state";

/** One row of the popover's KINDS list: label + one-line hint (SPEC §3.6). */
export interface InsertKindOption {
  kind: DeviceKind;
  label: string;
  hint: string;
}

/**
 * The five kinds the picker offers, one per `Predicate` shape (SPEC §3.6),
 * in the WHEN segmented's own order (`device-edit.ts`'s `WHEN_KINDS`).
 */
const INSERT_KINDS: readonly InsertKindOption[] = [
  { kind: "trim", label: "Trim", hint: "always on — a constant offset or scale" },
  { kind: "moon", label: "Moon-bound", hint: "gated to a named phase of a moon" },
  { kind: "spell", label: "Spell", hint: "rolls its own runs inside a year window" },
  { kind: "tag", label: "Tag-gated", hint: "on while a season or era tag is active" },
  { kind: "chance", label: "Chance", hint: "a small chance on any day" },
];

/** The popover's KINDS list. A fresh array every call, so a caller may hold it without aliasing the source. */
export function insertKinds(): InsertKindOption[] {
  return INSERT_KINDS.map((k) => ({ ...k }));
}

/** One row of the popover's PRESETS list — shipped first, then the world's own, badged `yours`. */
export interface InsertPresetOption {
  name: string;
  kind: DeviceKind;
  source: "shipped" | "yours";
  preset: DevicePreset;
}

/** Every preset the picker offers: shipped, then `world.devicePresets`, in that order (SPEC §3.6). */
export function presetsFor(world: WorldDraft): InsertPresetOption[] {
  const shipped: InsertPresetOption[] = SHIPPED_PRESETS.map((p) => ({ name: p.name, kind: p.kind, source: "shipped", preset: p }));
  const yours: InsertPresetOption[] = world.devicePresets.map((p) => ({ name: p.name, kind: p.kind, source: "yours", preset: p }));
  return [...shipped, ...yours];
}

/**
 * Insert a fresh device of `kind` into `z`, with the kind's default WHEN and
 * one neutral op for `chain` (`newDevice`). Lands after the existing devices
 * and before `forcings:*` (`normaliseOrder`). Returns the new device's id.
 */
export function insertDevice(z: ZoneProfile, kind: DeviceKind, chain: Channel, calendar: CalendarDescription | null): string {
  const taken = z.modifiers.map((m) => m.id);
  const device = newDevice(kind, chain, calendar, taken);
  z.modifiers.push(toModifier(device));
  normaliseOrder(z);
  return device.id;
}

/**
 * Instantiate `preset` as a device in `z` (`presetToDevice`) — its own WHEN,
 * spell and apply, never retargeted to `chain`. Lands the same way
 * `insertDevice` does. Returns the new device's id.
 */
export function insertPreset(z: ZoneProfile, preset: DevicePreset, chain: Channel, calendar: CalendarDescription | null): string {
  void chain;
  const taken = z.modifiers.map((m) => m.id);
  const device = presetToDevice(preset, calendar, taken);
  z.modifiers.push(toModifier(device));
  normaliseOrder(z);
  return device.id;
}
