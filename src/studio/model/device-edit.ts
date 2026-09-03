/**
 * Pure edit helpers for one device (SPEC §3.4 "Generic device", PLAN D12).
 *
 * `devices.ts` is the *translation* (`Modifier` ⇄ `Device`); this file is the
 * *editing*: the small set of mutations the device window performs, expressed
 * over the draft rather than over the DOM. The window does nothing to a zone
 * that is not one of these calls, so what the window can write is enumerable
 * and unit-testable without an Obsidian in the room.
 *
 * Two rules everything here keeps:
 *
 *  - **A helper never leaves the draft invalid.** Every mutation ends in
 *    `restage`, which is what keeps gates and envelopes (daily-stage only, per
 *    `validateProfile`) off a climate-stage modifier, and the dimmer bounds
 *    ([0, 1] for `ModGate.amount` and envelope strength — PLAN §0.1 "Review
 *    gate") are clamped rather than trusted.
 *  - **Identity is the id.** A device's name IS its modifier id (SPEC §7), so
 *    `renameDevice` is the only helper that changes it, and nothing else in the
 *    zone refers to a device — devices have no cross-references, so a rename
 *    rewrites exactly one string.
 *
 * `restage` deviates from the SPEC's badge wording ("climate stage iff no
 * `when` and no spell") in one corner: a device that still carries gates or an
 * op envelope stays *daily* even with no `when`, because the engine rejects
 * both at the climate stage. The badge follows the real stage, so it never
 * claims something the file does not say.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { CURVE_PATHS, SCALAR_PATHS } from "../../core/curve-ops";
import type { ModifierOp, SpellSpec, ZoneProfile } from "../../core/types";
import type { DevicePreset } from "../../plugin/settings";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { type Channel, channelOrNull } from "./compile";
import { type Device, type DeviceKind, type DeviceWhen, type WhenKind, defaultApplyFor, newDevice, toDevice, toModifier, uniqueDeviceId, yearWindowsOf } from "./devices";
import { SHIPPED_PRESETS, deviceToPreset, presetToDevice } from "./presets";
import type { WorldDraft } from "./state";

/** The chain a brand-new op defaults to when the caller does not say (`newOpFor` reads the param instead). */
const DEFAULT_CHANNEL: Channel = "temperature";

/** The WHEN segmented's options in SPEC §3.4 order, and the `DeviceKind` each one is a shape of. */
export const WHEN_KINDS: ReadonlyArray<{ when: WhenKind; kind: DeviceKind; label: string }> = [
  { when: "always", kind: "trim", label: "Always" },
  { when: "moon", kind: "moon", label: "Moon" },
  { when: "tag", kind: "tag", label: "Tag" },
  { when: "yearWindow", kind: "spell", label: "Year window" },
  { when: "chance", kind: "chance", label: "Chance" },
];

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * Phases live in [0, 1) — 1 wraps to 0, so an envelope point can never sit on
 * the exclusive end. A phase that is already in range is returned untouched:
 * `((0.2 % 1) + 1) % 1` is 0.19999999999999996, and an authored point must
 * survive a round trip byte-exact.
 */
function wrapPhase(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v >= 0 && v < 1) return v;
  return ((v % 1) + 1) % 1;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/**
 * Put the device on the stage its own content allows. Climate stage is the
 * unconditional one: no `when`, no spell, and nothing daily-only attached
 * (gates and envelopes are both daily-stage-only in `validateProfile`).
 * A `custom` device keeps whatever stage its raw modifier carried — the studio
 * does not model its predicate and must not second-guess it.
 */
export function restage(d: Device): void {
  if (d.custom) return;
  const daily = d.when.kind !== "always" || d.spell !== undefined || d.mods.length > 0 || d.apply.some((o) => o.envelope !== undefined);
  d.stage = daily ? "daily" : "climate";
}

// ---------------------------------------------------------------------------
// Draft-level: find, edit in place, rename, remove
// ---------------------------------------------------------------------------

/** The device a modifier id decompiles to, or `null` when the zone has no such modifier. */
export function deviceOf(z: ZoneProfile, id: string, calendar: CalendarDescription | null): Device | null {
  const m = z.modifiers.find((x) => x.id === id);
  return m === undefined ? null : toDevice(m, calendar);
}

/**
 * Decompile → mutate → recompile, **in place**: the modifier keeps its index,
 * so editing a device never reorders the chain (order is the signal path,
 * SPEC §1). Returns false when the id is not in the draft.
 */
export function updateDevice(z: ZoneProfile, id: string, fn: (d: Device) => void, calendar: CalendarDescription | null): boolean {
  const at = z.modifiers.findIndex((m) => m.id === id);
  const m = z.modifiers[at];
  if (m === undefined) return false;
  const d = toDevice(m, calendar);
  fn(d);
  restage(d);
  z.modifiers[at] = toModifier(d);
  return true;
}

/**
 * Rename a device: its id becomes `name`, uniquified against every other
 * modifier in the zone. Nothing else is rewritten — no modifier, lane, gate or
 * era refers to a device by id. Returns the id the device now has (the old one
 * when the zone has no such device, or when the name resolves to itself).
 */
export function renameDevice(z: ZoneProfile, id: string, name: string): string {
  const at = z.modifiers.findIndex((m) => m.id === id);
  const m = z.modifiers[at];
  if (m === undefined) return id;
  const taken = z.modifiers.filter((_, i) => i !== at).map((x) => x.id);
  const next = uniqueDeviceId(name, taken);
  if (next === id) return id;
  z.modifiers[at] = { ...m, id: next };
  return next;
}

/** Remove a device from the chain. Returns false when it was not there. */
export function removeDevice(z: ZoneProfile, id: string): boolean {
  const at = z.modifiers.findIndex((m) => m.id === id);
  if (at < 0) return false;
  z.modifiers.splice(at, 1);
  return true;
}

// ---------------------------------------------------------------------------
// WHEN and SPELL
// ---------------------------------------------------------------------------

/**
 * The `when` the WHEN segmented lands on when it switches to `kind` — the same
 * defaults the insert picker uses, borrowed from `newDevice` so the two can
 * never drift apart.
 */
export function defaultWhenFor(kind: WhenKind, calendar: CalendarDescription | null): DeviceWhen {
  const shape = WHEN_KINDS.find((k) => k.when === kind) ?? WHEN_KINDS[0]!;
  return newDevice(shape.kind, DEFAULT_CHANNEL, calendar, []).when;
}

/** The default spell a device gets when SPELL is switched on — `newDevice`'s, again borrowed rather than copied. */
export function defaultSpell(calendar: CalendarDescription | null): SpellSpec {
  return newDevice("spell", DEFAULT_CHANNEL, calendar, []).spell ?? { meanStartsPerYear: 0.6, meanDurationDays: 14 };
}

/** Set the device's WHEN. A `custom` device's predicate is not the studio's to rewrite, so this is a no-op there. */
export function setWhen(d: Device, when: DeviceWhen): void {
  if (d.custom) return;
  d.when = structuredClone(when);
  d.kind = WHEN_KINDS.find((k) => k.when === when.kind)?.kind ?? d.kind;
  restage(d);
}

/**
 * Move one clip of a year-window `when` (`＋ add window`'s siblings included).
 * Index 0 is the primary clip; anything past it lives in `extra`. Out-of-range
 * indices are ignored rather than appended — an add is `addYearWindow`'s job.
 */
export function setYearWindow(d: Device, index: number, clip: { start: number; length: number }): void {
  if (d.when.kind !== "yearWindow") return;
  const clips = yearWindowsOf(d.when);
  if (index < 0 || index >= clips.length) return;
  clips[index] = { start: clip.start, length: clip.length };
  writeYearWindows(d, clips);
}

/**
 * A second (third, …) yearly clip. It lands just after the last one, a
 * fortnight long, the way the prototype's `afAdd` does — never overlapping what
 * is already there, and never past the end of the year.
 */
export function addYearWindow(d: Device): boolean {
  if (d.when.kind !== "yearWindow") return false;
  const clips = yearWindowsOf(d.when);
  const last = clips[clips.length - 1] ?? { start: 0.2, length: 0.04 };
  const start = Math.min(0.9, last.start + last.length + 0.06);
  clips.push({ start, length: Math.min(0.6, 1 - start, 15 / 365) });
  writeYearWindows(d, clips);
  return true;
}

/** Drop one clip. The last one standing stays: a year window with no clip matches nothing. */
export function removeYearWindow(d: Device, index: number): boolean {
  if (d.when.kind !== "yearWindow") return false;
  const clips = yearWindowsOf(d.when);
  if (clips.length <= 1 || index < 0 || index >= clips.length) return false;
  clips.splice(index, 1);
  writeYearWindows(d, clips);
  return true;
}

function writeYearWindows(d: Device, clips: Array<{ start: number; length: number }>): void {
  const [first, ...rest] = clips as [{ start: number; length: number }, ...Array<{ start: number; length: number }>];
  setWhen(d, { kind: "yearWindow", start: first.start, length: first.length, ...(rest.length > 0 ? { extra: rest } : {}) });
}

/** Switch the spell on (with `spell`) or off (`undefined`). */
export function setSpell(d: Device, spell: SpellSpec | undefined): void {
  if (spell === undefined) delete d.spell;
  else d.spell = { meanStartsPerYear: spell.meanStartsPerYear, meanDurationDays: spell.meanDurationDays };
  restage(d);
}

// ---------------------------------------------------------------------------
// APPLY
// ---------------------------------------------------------------------------

/**
 * The neutral op a param starts from: the chain's own default when the param
 * is that chain's default target (`defaultApplyFor`), otherwise an `offset` of
 * zero — audible only once the knob moves, whatever the parameter.
 */
export function newOpFor(param: string): ModifierOp {
  const channel = channelOrNull(param);
  if (channel !== null) {
    const preferred = defaultApplyFor(channel);
    if (preferred.param === param) return { ...preferred };
  }
  return { param, op: "offset", value: 0 };
}

/**
 * The params the `＋` menu may offer, grouped by chain in signal order. The
 * daily stage has already evaluated the curves, so only curve paths are legal
 * there; the climate stage can also `offset` a scalar (`temperature.phase`,
 * `precipitation.freezingPoint`, …). `taken` params are dropped, so the menu
 * never offers a second copy of an op the device already has.
 */
export function paramsByChannel(stage: "climate" | "daily", taken: readonly string[] = []): Array<{ channel: Channel; params: string[] }> {
  const order: Channel[] = ["temperature", "precipitation", "wind", "sky"];
  const all = stage === "climate" ? [...CURVE_PATHS, ...SCALAR_PATHS] : [...CURVE_PATHS];
  const skip = new Set(taken);
  return order
    .map((channel) => ({ channel, params: all.filter((p) => channelOrNull(p) === channel && !skip.has(p)) }))
    .filter((g) => g.params.length > 0);
}

export function addOp(d: Device, op: ModifierOp): void {
  d.apply.push(structuredClone(op));
  restage(d);
}

/** Set one op's value. `clamp` carries no value and is left alone. */
export function setOpValue(d: Device, index: number, value: number): void {
  const op = d.apply[index];
  if (op === undefined || op.op === "clamp") return;
  const next = { ...op } as Extract<ModifierOp, { op: "offset" }>;
  next.value = value;
  d.apply[index] = next;
}

export function removeOp(d: Device, index: number): void {
  if (index < 0 || index >= d.apply.length) return;
  d.apply.splice(index, 1);
  restage(d);
}

/** Per-op power (SPEC §3.3 per-chain mute). Absent = enabled, so switching on deletes the key. */
export function setOpEnabled(d: Device, index: number, on: boolean): void {
  const op = d.apply[index];
  if (op === undefined) return;
  if (on) delete op.enabled;
  else op.enabled = false;
}

// ---------------------------------------------------------------------------
// MOD — gates and envelopes
// ---------------------------------------------------------------------------

/**
 * Add a mod-matrix gate. A gate is always a *tag* (PLAN §2.4): `moon:*` is the
 * carrier, never a gate, and the validator rejects it — so does this. `amount`
 * is a dimmer, clamped into [0, 1].
 */
export function addGate(d: Device, source: string, amount = 1): boolean {
  if (!source.trim() || source.startsWith("moon:")) return false;
  d.mods.push({ source, amount: clamp01(amount) });
  restage(d);
  return true;
}

export function setGateAmount(d: Device, index: number, amount: number): void {
  const gate = d.mods[index];
  if (gate === undefined) return;
  gate.amount = clamp01(amount);
}

export function setGateSource(d: Device, index: number, source: string): void {
  const gate = d.mods[index];
  if (gate === undefined || !source.trim() || source.startsWith("moon:")) return;
  gate.source = source;
}

export function removeGate(d: Device, index: number): void {
  if (index < 0 || index >= d.mods.length) return;
  d.mods.splice(index, 1);
  restage(d);
}

/**
 * The onset envelope on one op: `[phase, strength]` points on the carrier
 * moon's cycle. Phases wrap into [0, 1), strengths clamp into [0, 1] (an
 * envelope dims a device's onset, it never amplifies it — PLAN §0.1), points
 * sort by phase, and an empty list removes the envelope rather than writing
 * the one shape the validator rejects.
 */
export function setEnvelope(d: Device, opIndex: number, envelope: Array<[number, number]> | undefined): void {
  const op = d.apply[opIndex];
  if (op === undefined) return;
  const points = (envelope ?? []).map(([phase, strength]): [number, number] => [wrapPhase(phase), clamp01(strength)]).sort((a, b) => a[0] - b[0]);
  if (points.length === 0) delete op.envelope;
  else op.envelope = points;
  restage(d);
}

/** A neutral envelope (full strength all the way round) — two handles, so it is draggable the moment it appears. */
export function neutralEnvelope(): Array<[number, number]> {
  return [
    [0, 1],
    [0.5, 1],
  ];
}

// ---------------------------------------------------------------------------
// Presets (PLAN D12)
// ---------------------------------------------------------------------------

/** Every preset name already in use — shipped and the user's — so a saved one is never ambiguous in the menu. */
export function presetNames(world: WorldDraft): string[] {
  return [...SHIPPED_PRESETS.map((p) => p.name), ...world.devicePresets.map((p) => p.name)];
}

/**
 * `＋ save "<name>" as preset`: the device's shape (minus id, stage and tag)
 * joins the world's device presets under a unique name. Returns what was
 * stored, so the caller can name it back to the user.
 */
export function saveAsPreset(world: WorldDraft, d: Device, name: string): DevicePreset {
  // `uniqueDeviceId` is the studio's one "make this name unique" rule; presets
  // want exactly the same " 2", " 3" suffixing that devices do.
  const preset = deviceToPreset(d, uniqueDeviceId(name, presetNames(world)));
  world.devicePresets.push(preset);
  return preset;
}

/**
 * Load a preset over a device, in place. Only a preset of the *same kind* may
 * be loaded (the menu never offers another), so the WHEN section the user is
 * looking at keeps its shape. The device's identity — id, name, power — is its
 * own and survives; only the declaration is replaced.
 */
export function loadPreset(d: Device, preset: DevicePreset, calendar: CalendarDescription | null, taken: Iterable<string>): boolean {
  if (preset.kind !== d.kind) return false;
  // `presetToDevice` computes an id from the preset name; a load never renames
  // a device (the window is keyed on the id), so that id is discarded here.
  const fresh = presetToDevice(preset, calendar, taken);
  d.kind = fresh.kind;
  d.when = fresh.when;
  d.apply = fresh.apply;
  d.mods = fresh.mods;
  if (fresh.spell) d.spell = fresh.spell;
  else delete d.spell;
  if (fresh.custom === true && fresh.raw !== undefined) {
    d.custom = true;
    d.raw = fresh.raw;
  } else {
    delete d.custom;
    delete d.raw;
  }
  d.stage = fresh.stage;
  restage(d);
  return true;
}
