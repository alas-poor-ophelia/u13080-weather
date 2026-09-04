/**
 * The device presets the plugin ships (PLAN D12, SPEC §3.6 insert picker).
 *
 * A `DevicePreset` is a modifier *shape*, not a modifier: it has no id, no
 * stage and no tag, because those belong to the instance the rack creates.
 * Values use the real grammar (`meanStartsPerYear` / `meanDurationDays`) and
 * are legal under `validateProfile` — gate strengths sit in [0, 1], probabilities
 * stay in range, every `param` is a real curve path.
 *
 * Shapes are borrowed from the shipped copy-paste examples
 * (`src/plugin/modifier-examples.ts`) so a user who has read the grammar card
 * recognises what the picker inserts: Volcanic is Ashfall with a temperature
 * drop, Spring-tide is Stormtide expressed in named phases.
 *
 * User presets live beside these in `settings.devicePresets` and are badged
 * `yours`; both go through `presetToDevice`.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { Modifier, Predicate } from "../../core/types";
import type { DevicePreset } from "../../plugin/settings";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { DEFAULT_MOON_PHASES, type Device, moonRange, phasesFor, toDevice, toModifier, uniqueDeviceId } from "./devices";

export const SHIPPED_PRESETS: readonly DevicePreset[] = [
  {
    name: "Spring-tide",
    kind: "moon",
    // The full-moon arc of the default phase set, so a world that has named its
    // own phases gets the window retargeted to *its* "Full" (see presetToDevice).
    when: { moon: { name: "Sable", phase: [0.86, 0] } },
    apply: [
      { param: "precipitation.pwd", op: "scale", value: 1.4 },
      { param: "wind.speed", op: "scale", value: 1.25 },
    ],
  },
  {
    name: "Volcanic",
    kind: "spell",
    when: { yearPhase: [0.61, 0.72] },
    spell: { meanStartsPerYear: 0.6, meanDurationDays: 18 },
    apply: [
      { param: "precipitation.pwd", op: "set", value: 0 },
      { param: "precipitation.pww", op: "set", value: 0 },
      { param: "cloud.dry", op: "set", value: 0.95 },
      { param: "temperature.mean", op: "offset", value: -3 },
    ],
  },
  {
    name: "Drought curse",
    kind: "tag",
    // The word is the author's, not the shape's: `badge` is what makes this a
    // CURSE in the picker and on the card it inserts (PLAN D17). Turning the
    // zero back up leaves it a curse; only the flag says so.
    badge: "curse",
    when: { tag: "era:Drought" },
    apply: [{ param: "precipitation.pwd", op: "scale", value: 0 }],
  },
  {
    name: "Monsoon burst",
    kind: "spell",
    when: { yearPhase: [0.45, 0.65] },
    spell: { meanStartsPerYear: 3, meanDurationDays: 6 },
    apply: [
      { param: "precipitation.pwd", op: "scale", value: 1.5 },
      { param: "wind.speed", op: "scale", value: 1.4 },
    ],
  },
  {
    name: "Föhn days",
    kind: "chance",
    when: { chance: 0.06 },
    apply: [
      { param: "temperature.mean", op: "offset", value: 4 },
      { param: "wind.speed", op: "scale", value: 1.8 },
      { param: "cloud.dry", op: "offset", value: -0.3 },
    ],
  },
];

/**
 * Point a preset's moon predicate at the world's own moon. A preset is written
 * against the default phase names (`DEFAULT_MOON_PHASES`); when the target moon
 * has named phases of its own and every borrowed name exists there, the window
 * is recompiled against *its* boundaries — so "Spring-tide" stays a full moon
 * even in a world whose full sits at 0.5.
 */
function retargetMoon(when: Predicate, calendar: CalendarDescription | null): Predicate {
  if (!("moon" in when)) return when;
  const moons = calendar?.moons ?? [];
  if (moons.length === 0) return when;
  const target = moons.find((m) => m.name === when.moon.name) ?? moons[0]!;
  const named = target.phases ?? [];
  const borrowed = phasesFor(DEFAULT_MOON_PHASES, [when.moon.phase[0], when.moon.phase[1]]);
  const transferable = borrowed.length > 0 && borrowed.every((n) => named.some((p) => p.name === n));
  const phase = transferable ? moonRange(named, borrowed) : ([when.moon.phase[0], when.moon.phase[1]] as [number, number]);
  return { moon: { name: target.name, phase } };
}

/**
 * Instantiate a preset as a rack device: a unique name, the kind's stage
 * (`climate` only when there is neither a `when` nor a spell — SPEC §3.4 stage
 * badge), and the preset's ops copied, never shared.
 */
export function presetToDevice(p: DevicePreset, calendar: CalendarDescription | null, taken: Iterable<string>): Device {
  const id = uniqueDeviceId(p.name, taken);
  const m: Modifier = {
    id,
    stage: p.when || p.spell ? "daily" : "climate",
    ...(p.when ? { when: retargetMoon(structuredClone(p.when), calendar) } : {}),
    ...(p.spell ? { spell: { ...p.spell } } : {}),
    apply: structuredClone(p.apply),
    ...(p.mods?.length ? { mods: p.mods.map((g) => ({ ...g })) } : {}),
    ...(p.badge ? { badge: p.badge } : {}),
  };
  return toDevice(m, calendar);
}

/**
 * Save a rack device as a reusable preset (`＋ save "name" as preset`). The
 * instance-only fields — id, stage and the device's own `tag` — are dropped;
 * a custom device keeps its raw predicate, so anything the studio cannot model
 * still stores and reloads.
 */
export function deviceToPreset(d: Device, name: string): DevicePreset {
  const m = toModifier(d);
  return {
    name,
    kind: d.kind,
    ...(m.when ? { when: m.when } : {}),
    ...(m.spell ? { spell: m.spell } : {}),
    apply: m.apply,
    ...(m.mods?.length ? { mods: m.mods } : {}),
    ...(m.badge ? { badge: m.badge } : {}),
  };
}
