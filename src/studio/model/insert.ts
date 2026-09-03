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

/**
 * One row of the popover's KINDS list (SPEC §3.6).
 *
 * Three strings, three registers, on purpose (bead wadjet-6rw.6):
 *  - `label` is the product name the row wears (`Moon-bound`);
 *  - `badge` is the kind pill the rack unit wears too, so the picker's rows
 *    and the cards they create read as the same vocabulary — its colour comes
 *    from `copy.ts:kindColor(badge)`;
 *  - `sub` is the grammar the row *writes*, in the register SPEC law 5 asks a
 *    WRITES footer for (`when.moon · phase window`);
 *  - `hint` is the teaching, and only ever reaches the hint bar (SPEC §9).
 */
export interface InsertKindOption {
  kind: DeviceKind;
  /**
   * The row's own value, and its `data-kind`. It is the `kind` for every row
   * but `Curse`, which is a *flagged* tag device and so shares `kind: "tag"`
   * with the row above it (PLAN D17) — two rows, one `DeviceKind`.
   */
  value: string;
  label: string;
  /** the kind pill: TRIM · MOON · SPELL · TAG · CURSE · DICE */
  badge: string;
  /** the row's trailing mono grammar — what picking it writes */
  sub: string;
  hint: string;
  /** the display flag the row writes onto the modifier (`Modifier.badge`); absent = none */
  flag?: "curse";
}

/**
 * The kinds the picker offers, one per `Predicate` shape (SPEC §3.6), in the
 * WHEN segmented's own order (`device-edit.ts`'s `WHEN_KINDS`) — plus `Curse`,
 * which is not a sixth shape but the tag row again, wearing the word and the
 * hue its author picked for it (PLAN D17). The choice is made HERE and nowhere
 * else: the device window has no toggle, because the badge is a name, not a
 * setting.
 */
const INSERT_KINDS: readonly InsertKindOption[] = [
  { kind: "trim", value: "trim", label: "Trim", badge: "TRIM", sub: "always on · no when", hint: "always on — a constant offset or scale" },
  { kind: "moon", value: "moon", label: "Moon-bound", badge: "MOON", sub: "when.moon · phase window", hint: "gated to a named phase of a moon" },
  { kind: "spell", value: "spell", label: "Spell", badge: "SPELL", sub: "when.yearPhase + spell · random runs", hint: "rolls its own runs inside a year window" },
  { kind: "tag", value: "tag", label: "Tag-gated", badge: "TAG", sub: "when.tag · season: / era:", hint: "on while a season or era tag is active" },
  { kind: "tag", value: "curse", label: "Curse", badge: "CURSE", sub: "when.tag · a curse the tale can name", hint: "a tag-gated device that reads as a curse", flag: "curse" },
  { kind: "chance", value: "chance", label: "Chance", badge: "DICE", sub: "when.chance · a share of days", hint: "a small chance on any day" },
];

/**
 * The kind pill a preset row wears — the same badge its kind's row carries,
 * except that a preset saved from a curse carries the flag too and so keeps its
 * own word (`flag`, `presets.ts`).
 */
export function badgeForKind(kind: DeviceKind, flag?: "curse"): string {
  const wanted = flag === "curse" && kind === "tag" ? "curse" : kind;
  return INSERT_KINDS.find((k) => k.value === wanted)?.badge ?? kind.toUpperCase();
}

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
export function insertDevice(z: ZoneProfile, kind: DeviceKind, chain: Channel, calendar: CalendarDescription | null, flag?: "curse"): string {
  const taken = z.modifiers.map((m) => m.id);
  const device = newDevice(kind, chain, calendar, taken, flag);
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
