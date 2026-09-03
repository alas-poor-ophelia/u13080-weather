/**
 * The studio's device model: one `Device` declaration ⇄ one `Modifier`
 * (SPEC §3.4 "Generic device", §3.6, §5; PLAN §2.2, §5).
 *
 * A device is the *editable* face of a modifier. The engine's grammar is a
 * closed set of predicates; the studio exposes five of those shapes as
 * "kinds" (SPEC §3.6 insert picker) and decompiles anything else into a
 * `custom` device that keeps its raw modifier verbatim. Nothing is ever
 * dropped: `toDevice` never throws, and `toModifier` of a custom device
 * returns the modifier it came from with only the editable fields rewritten.
 *
 * Three normalisations happen on the round trip, all semantically neutral:
 *   - an omitted `stage` becomes the explicit `"daily"` it already meant;
 *   - `enabled: true` is dropped (absent = enabled), `enabled: false` is kept;
 *   - a single-element `{ any: [{ tag }] }` collapses to a bare `{ tag }`.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import type { ModGate, Modifier, ModifierOp, Predicate, SpellSpec } from "../../core/types";
import type { CalendarDescription } from "../../plugin/time/adapter";
import type { Channel } from "./compile";
import { applyPhrase, describeOp, grammar, paramName } from "./copy";
import { dayRange } from "./format";
import type { KnobSpec } from "./knob";

/** One per `Predicate` shape the studio exposes; `trim` is "no when" (SPEC §3.6). Mirrors `DevicePreset["kind"]`. */
export type DeviceKind = "trim" | "moon" | "spell" | "tag" | "chance";

/** The WHEN segmented control's options (SPEC §3.4). */
export type WhenKind = "always" | "moon" | "tag" | "yearWindow" | "chance";

/** The studio's four mixer chains (SPEC §3.3). */
export type { Channel } from "./compile";

/**
 * A device's `when`, in the terms the window edits rather than the terms the
 * engine evaluates. `moon.range` is the compiled `[a, b)` the engine sees;
 * `moon.phases` is the named selection it came from, empty when the ends do
 * not sit on phase boundaries (the window then reads "custom range").
 */
export type DeviceWhen =
  | { kind: "always" }
  | { kind: "moon"; moon: string; phases: string[]; range: [number, number] }
  | { kind: "tag"; tags: string[] }
  /**
   * `start`/`length` is the first (and usually only) clip. `extra` carries the
   * rest — the prototype's `＋ add window`, which the engine spells as
   * `{ any: [{ yearPhase }, { yearPhase }] }`. Kept as an optional tail rather
   * than a list so the single-window shape every other caller reads stays the
   * one it already reads.
   */
  | { kind: "yearWindow"; start: number; length: number; extra?: Array<{ start: number; length: number }> }
  | { kind: "chance"; p: number };

/**
 * One declaration, four projections (SPEC §5). `id` is the modifier id and the
 * identity the zone file carries; `name` is what the rack shows — the id with
 * a studio prefix stripped (`layer:` / `forcings:` / `era:`), so for an
 * ordinary device the two are the same string.
 */
export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  enabled: boolean;
  when: DeviceWhen;
  spell?: SpellSpec;
  apply: ModifierOp[];
  mods: ModGate[];
  tag?: string;
  stage: "climate" | "daily";
  /** the modifier could not be decompiled into a kind; `raw` holds it verbatim */
  custom?: true;
  raw?: Modifier;
}

/** The phase names a moon gets when the world has not named its own (SPEC §3.4 CYCLE). */
export const DEFAULT_MOON_PHASES: ReadonlyArray<{ name: string; at: number }> = [
  { name: "New", at: 0 },
  { name: "Crescent", at: 0.16 },
  { name: "Half", at: 0.42 },
  { name: "Gibbous", at: 0.68 },
  { name: "Full", at: 0.86 },
];

/** Ids the studio owns (PLAN §2.3); the rack shows what follows the prefix. */
const ID_PREFIXES = ["layer:", "forcings:", "era:"];

/** A modifier the studio cannot decompile still needs a kind for the rack; it wears the `custom` chip instead. */
const CUSTOM_FALLBACK_KIND: DeviceKind = "trim";

/** Boundary matching tolerance — phase boundaries are authored, not computed. */
const PHASE_EPSILON = 1e-9;

const mod1 = (x: number): number => ((x % 1) + 1) % 1;

/**
 * A year window is stored as `[a, b)` but edited as start + length, and
 * `a + (b − a)` is not always `b` in binary floating point. Authored phases
 * carry nowhere near ten decimals, so rounding there keeps the round trip
 * byte-exact without touching any value a user could mean.
 */
const round10 = (x: number): number => Number(x.toFixed(10));

function clone<T>(v: T): T {
  return structuredClone(v);
}

// ---------------------------------------------------------------------------
// Moon phase names ⇄ compiled range (PLAN §2.2)
// ---------------------------------------------------------------------------

function sortPhases(phases: readonly { name: string; at: number }[]): Array<{ name: string; at: number }> {
  return [...phases].sort((a, b) => a.at - b.at);
}

function indexAt(sorted: ReadonlyArray<{ name: string; at: number }>, at: number): number {
  return sorted.findIndex((p) => Math.abs(p.at - at) < PHASE_EPSILON);
}

/**
 * The `[a, b)` range a named phase selection compiles to: from the first
 * selected boundary to the boundary after the last selected one, wrapping.
 * A contiguous selection is assumed; a non-contiguous one yields the smallest
 * arc that covers every selected phase.
 *
 * Selecting everything (or nothing, or names the moon does not have) is the
 * whole cycle, `[0, 1]` — the engine reads `lo === hi` as *never*, so a full
 * circle can never be written as `[a, a]`. When the caller is in "custom
 * range" mode (`phases` empty) it keeps its own range instead of calling this.
 */
export function moonRange(phases: readonly { name: string; at: number }[], selected: readonly string[]): [number, number] {
  const sorted = sortPhases(phases);
  const n = sorted.length;
  if (n === 0) return [0, 1];
  const chosen = new Set<number>();
  sorted.forEach((p, i) => {
    if (selected.includes(p.name)) chosen.add(i);
  });
  if (chosen.size === 0 || chosen.size === n) return [0, 1];

  let best: [number, number] = [0, 1];
  let bestArc = Number.POSITIVE_INFINITY;
  for (const start of chosen) {
    let lastOffset = 0;
    for (let k = 0; k < n; k++) if (chosen.has((start + k) % n)) lastOffset = k;
    const a = sorted[start]!.at;
    const b = sorted[(start + lastOffset + 1) % n]!.at;
    const arc = mod1(b - a) || 1;
    if (arc < bestArc) {
      bestArc = arc;
      best = [a, b];
    }
  }
  return best;
}

/**
 * The inverse of `moonRange`: the phase names a compiled range covers, or `[]`
 * when its ends do not sit on boundaries (a hand-typed "custom range").
 * `[0, 1]` is the whole cycle and names every phase.
 */
export function phasesFor(phases: readonly { name: string; at: number }[], range: [number, number]): string[] {
  const sorted = sortPhases(phases);
  const n = sorted.length;
  if (n === 0) return [];
  if (range[0] === 0 && range[1] === 1) return sorted.map((p) => p.name);
  const a = mod1(range[0]);
  const b = mod1(range[1]);
  if (a === b) return []; // an empty window, not a selection
  const i = indexAt(sorted, a);
  const j = indexAt(sorted, b);
  if (i === -1 || j === -1) return [];
  const out: string[] = [];
  for (let k = i; k !== j; k = (k + 1) % n) out.push(sorted[k]!.name);
  return out;
}

// ---------------------------------------------------------------------------
// Modifier ⇄ Device
// ---------------------------------------------------------------------------

function everyLeafIsTag(qs: readonly Predicate[]): boolean {
  return qs.every((q) => "tag" in q);
}

/** `{ any: [{ yearPhase }, …] }` — several yearly clips on one device (`＋ add window`). */
function everyLeafIsYearPhase(qs: readonly Predicate[]): boolean {
  return qs.length > 0 && qs.every((q) => "yearPhase" in q);
}

/** Which kind the rack shows for `m`, or `"custom"` when the predicate is outside the studio's five shapes. */
export function kindOf(m: Modifier): DeviceKind | "custom" {
  const w = m.when;
  if (!w) return m.spell ? "spell" : "trim";
  if ("moon" in w) return "moon";
  if ("yearPhase" in w) return "spell";
  if ("tag" in w) return "tag";
  if ("chance" in w) return "chance";
  if ("any" in w && everyLeafIsTag(w.any)) return "tag";
  if ("any" in w && everyLeafIsYearPhase(w.any)) return "spell";
  return "custom";
}

/** The id as the rack shows it: studio prefixes stripped, everything else verbatim. */
export function displayName(m: Modifier): string {
  for (const p of ID_PREFIXES) if (m.id.startsWith(p)) return m.id.slice(p.length);
  return m.id;
}

function whenOf(m: Modifier, calendar: CalendarDescription | null): DeviceWhen | null {
  const w = m.when;
  if (!w) return { kind: "always" };
  if ("moon" in w) {
    const range: [number, number] = [w.moon.phase[0], w.moon.phase[1]];
    const named = calendar?.moons.find((x) => x.name === w.moon.name)?.phases ?? [];
    return { kind: "moon", moon: w.moon.name, phases: phasesFor(named, range), range };
  }
  if ("yearPhase" in w) return { kind: "yearWindow", ...spanOf(w.yearPhase) };
  if ("tag" in w) return { kind: "tag", tags: [w.tag] };
  if ("chance" in w) return { kind: "chance", p: w.chance };
  if ("any" in w && everyLeafIsTag(w.any)) return { kind: "tag", tags: w.any.map((q) => (q as { tag: string }).tag) };
  if ("any" in w && everyLeafIsYearPhase(w.any)) {
    const spans = w.any.map((q) => spanOf((q as { yearPhase: [number, number] }).yearPhase));
    const [first, ...rest] = spans as [{ start: number; length: number }, ...Array<{ start: number; length: number }>];
    return { kind: "yearWindow", ...first, ...(rest.length > 0 ? { extra: rest } : {}) };
  }
  return null;
}

/** `[a, b)` in year phase read back as the start + length the knobs edit, wrap included. */
function spanOf([a, b]: readonly [number, number]): { start: number; length: number } {
  return { start: a, length: round10(b >= a ? b - a : 1 - a + b) };
}

/** `[a, b)` for one clip, wrapped back into the year. */
function phaseOf(w: { start: number; length: number }): [number, number] {
  const end = round10(w.start + w.length);
  return [w.start, end > 1 ? round10(end - 1) : end];
}

/** Every clip a year-window `when` carries, first one first — the mini-lane and the detail rows read this. */
export function yearWindowsOf(w: DeviceWhen): Array<{ start: number; length: number }> {
  if (w.kind !== "yearWindow") return [];
  return [{ start: w.start, length: w.length }, ...(w.extra ?? []).map((e) => ({ start: e.start, length: e.length }))];
}

/** The predicate a `DeviceWhen` compiles to; `null` for "always" (the modifier gets no `when` key). */
function predicateOf(w: DeviceWhen): Predicate | null {
  switch (w.kind) {
    case "always":
      return null;
    case "moon":
      return { moon: { name: w.moon, phase: [w.range[0], w.range[1]] } };
    case "tag":
      return w.tags.length === 1 ? { tag: w.tags[0]! } : { any: w.tags.map((t) => ({ tag: t })) };
    case "yearWindow": {
      const clips = yearWindowsOf(w);
      if (clips.length <= 1) return { yearPhase: phaseOf(w) };
      return { any: clips.map((c) => ({ yearPhase: phaseOf(c) })) };
    }
    case "chance":
      return { chance: w.p };
  }
}

function customDevice(m: Modifier): Device {
  return {
    id: m.id,
    name: displayName(m),
    kind: CUSTOM_FALLBACK_KIND,
    enabled: m.enabled !== false,
    when: { kind: "always" },
    apply: Array.isArray(m.apply) ? [...m.apply] : [],
    mods: Array.isArray(m.mods) ? [...m.mods] : [],
    stage: m.stage ?? "daily",
    ...(m.spell ? { spell: m.spell } : {}),
    ...(m.tag !== undefined ? { tag: m.tag } : {}),
    custom: true,
    raw: m,
  };
}

/**
 * Decompile a modifier into the device the windows edit. Never throws: an
 * unrecognised predicate (`all`, `not`, `regime`, `dayOfYear`, a mixed `any`)
 * produces a `custom` device carrying the modifier verbatim in `raw`.
 *
 * `calendar` supplies the moon's named phase boundaries; pass `null` when the
 * active adapter describes no calendar and every moon range reads as custom.
 */
export function toDevice(m: Modifier, calendar: CalendarDescription | null): Device {
  try {
    const when = whenOf(m, calendar);
    const kind = kindOf(m);
    if (when === null || kind === "custom") return customDevice(clone(m));
    return {
      id: m.id,
      name: displayName(m),
      kind,
      enabled: m.enabled !== false,
      when,
      apply: clone(m.apply),
      mods: m.mods ? clone(m.mods) : [],
      stage: m.stage ?? "daily",
      ...(m.spell ? { spell: clone(m.spell) } : {}),
      ...(m.tag !== undefined ? { tag: m.tag } : {}),
    };
  } catch {
    return customDevice(m);
  }
}

/**
 * Compile a device back to the modifier the zone file stores. A `custom`
 * device keeps its raw predicate and any field the studio does not model;
 * everything the window can edit (power, apply, tag, gates, spell, stage) is
 * written over it.
 */
export function toModifier(d: Device): Modifier {
  const when = d.custom && d.raw ? d.raw.when : predicateOf(d.when);
  const m: Modifier = {
    id: d.id,
    stage: d.stage,
    ...(when ? { when } : {}),
    ...(d.spell ? { spell: clone(d.spell) } : {}),
    apply: clone(d.apply),
    ...(d.tag !== undefined ? { tag: d.tag } : {}),
    ...(d.enabled ? {} : { enabled: false }),
    ...(d.mods.length ? { mods: clone(d.mods) } : {}),
  };
  return d.custom && d.raw ? { ...d.raw, ...m } : m;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * A device's name IS its id (SPEC §7 "UI emits id = name"), so it is kept
 * verbatim rather than slugified — the validator only asks for non-empty and
 * unique. A collision suffixes " 2", " 3", …
 */
export function uniqueDeviceId(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const base = name.trim() || "Device";
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!set.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Defaults for a new device
// ---------------------------------------------------------------------------

/** The neutral op a new device on `channel` starts from — audible only once the user turns a knob. */
export function defaultApplyFor(channel: Channel): ModifierOp {
  switch (channel) {
    case "temperature":
      return { param: "temperature.mean", op: "offset", value: 0 };
    case "precipitation":
      return { param: "precipitation.pwd", op: "scale", value: 1 };
    case "wind":
      return { param: "wind.speed", op: "scale", value: 1 };
    case "sky":
      return { param: "cloud.dry", op: "offset", value: 0 };
  }
}

const KIND_LABELS: Record<DeviceKind, string> = {
  trim: "Trim",
  moon: "Moon-bound",
  spell: "Spell",
  tag: "Tag-gated",
  chance: "Chance",
};

/** Default spell for a new spell device: about one run a year, a fortnight long. */
const DEFAULT_SPELL: SpellSpec = { meanStartsPerYear: 0.6, meanDurationDays: 14 };
const DEFAULT_YEAR_WINDOW = { start: 0.55, length: 0.12 };
/** A moon with no named phases gets a window around full. */
const DEFAULT_MOON_WINDOW: [number, number] = [0.4, 0.6];
const DEFAULT_CHANCE = 0.1;
/** A world with no seasons still needs a legal tag predicate to start from. */
const FALLBACK_SEASON_TAG = "season:Summer";

function defaultWhen(kind: DeviceKind, calendar: CalendarDescription | null): DeviceWhen {
  switch (kind) {
    case "trim":
      return { kind: "always" };
    case "moon": {
      const moon = calendar?.moons[0];
      const named = moon?.phases ?? [];
      const full = named.find((p) => p.name.toLowerCase() === "full");
      const phases = full ? [full.name] : [];
      return { kind: "moon", moon: moon?.name ?? "Moon", phases, range: full ? moonRange(named, phases) : [...DEFAULT_MOON_WINDOW] };
    }
    case "spell":
      return { kind: "yearWindow", ...DEFAULT_YEAR_WINDOW };
    case "tag": {
      const season = calendar?.seasons[0]?.name;
      return { kind: "tag", tags: [season ? `season:${season}` : FALLBACK_SEASON_TAG] };
    }
    case "chance":
      return { kind: "chance", p: DEFAULT_CHANCE };
  }
}

/**
 * A fresh device from the insert picker (SPEC §3.6): the kind's default WHEN,
 * one neutral op for the chain it was added to, a unique name. A `trim` has no
 * `when` and so sits at the climate stage; every other kind is daily.
 */
export function newDevice(kind: DeviceKind, channel: Channel, calendar: CalendarDescription | null, taken: Iterable<string>): Device {
  const when = defaultWhen(kind, calendar);
  const id = uniqueDeviceId(KIND_LABELS[kind], taken);
  return {
    id,
    name: id,
    kind,
    enabled: true,
    when,
    ...(kind === "spell" ? { spell: { ...DEFAULT_SPELL } } : {}),
    apply: [defaultApplyFor(channel)],
    mods: [],
    stage: when.kind === "always" ? "climate" : "daily",
  };
}

// ---------------------------------------------------------------------------
// Chip text
// ---------------------------------------------------------------------------

/** Trim trailing zeros so 0.6 reads "0.6" and 3 reads "3". */
function num(v: number, maxDecimals = 2): string {
  return String(Number(v.toFixed(maxDecimals)));
}

/**
 * The when-chip on a rack unit (SPEC §3.3): `always` · `moon:Sable · Full` ·
 * `season:Harvest` · `days 200–243` · `6 % of days`, with `· + spell 0.6/yr ·
 * 14 d` appended when the device carries a spell. `yearLength` is the active
 * calendar's; it only affects the year-window wording.
 */
export function whenSummary(d: Device, yearLength = 365): string {
  const w = d.when;
  let head: string;
  switch (w.kind) {
    case "always":
      head = "always";
      break;
    case "moon":
      head = `moon:${w.moon} · ${w.phases.length ? w.phases.join(", ") : "custom range"}`;
      break;
    case "tag":
      head = w.tags.length ? w.tags.join(" or ") : "no tag";
      break;
    case "yearWindow": {
      const clips = yearWindowsOf(w);
      if (clips.length > 1) {
        head = `${clips.length} windows`;
        break;
      }
      // The clip's own detail row reads `d223 – d263`; the summary takes its
      // two numbers from the same `format.ts` helper, so the two can never
      // disagree about which day a window starts on (`gap-device-windows.md`
      // "day range off by one", bead wadjet-9f9.48.2). Only the wording
      // differs — a sentence says `days`, a chip says `d`.
      head = `days ${dayRange(w.start, w.length, yearLength).join("–")}`;
      break;
    }
    case "chance":
      head = `${num(w.p * 100, 2)} % of days`;
      break;
  }
  if (!d.spell) return head;
  return `${head} · + spell ${num(d.spell.meanStartsPerYear)}/yr · ${num(d.spell.meanDurationDays)} d`;
}

// ---------------------------------------------------------------------------
// Knob ranges per op
// ---------------------------------------------------------------------------

/** What a knob bound to one op sweeps. Feeds `KnobSpec` in `knob.ts` plus the readout formatter. */
export interface KnobSpecFor {
  min: number;
  max: number;
  /**
   * The value the power arc starts from, or `undefined` where there is no
   * visible detent — see `neutralFor`. `undefined`, not an omitted key, so
   * `exactOptionalPropertyTypes` callers can read it without a branch;
   * `knobRangeOf` turns it back into an optional `KnobSpec.neutral`.
   */
  neutral: number | undefined;
  step: number;
  fmt: (v: number) => string;
}

/**
 * Which surface a knob lives on.
 *
 * The prototype keeps a SEPARATE target table per surface — `Component.TARGETS`
 * plus `APPLY_TARGETS` for a device, `ERA_TARGETS` for an era, `REG_TARGETS`
 * for a regime state — and the same parameter sweeps a different span in each:
 * `temperature.mean offset` is ±8 on a device, −12…+4 on an era and ±6 on a
 * regime. A knob's range is what a *drag does*, not only what the pointer
 * looks like, so the surface has to be part of the lookup.
 */
export type KnobSurface = "device" | "era" | "regime";

/** One prototype target's span. `step` falls back to the parameter's own `ParamShape`. */
interface TargetRange {
  min: number;
  max: number;
  step?: number;
}

/**
 * The prototype's per-surface target tables, keyed `op|param`. The op is part
 * of the key because the same parameter appears under two ops with two
 * different spans — `wind.speed` is `offset 0…24` in `TARGETS` (the moon-bound
 * device rack) and `scale ×0…×3` in `APPLY_TARGETS` (Ashfall's apply grid).
 *
 * Anything absent falls through to the generic derivation below, which is what
 * the plugin did for everything before: a `scale` is ×0…×3, an `offset` is the
 * parameter's symmetric ± range, a `set`/`clamp` is its whole domain.
 */
const DEVICE_RANGES: Record<string, TargetRange> = {
  // Component.TARGETS (l.199-210) — the device rack's bindable targets.
  "scale|precipitation.pwd": { min: 0.5, max: 2.5 },
  "offset|wind.speed": { min: 0, max: 24 },
  "offset|temperature.mean": { min: -8, max: 8 },
  "scale|temperature.diurnalRange": { min: 0.5, max: 1.5 },
  "scale|precipitation.pww": { min: 0.5, max: 2 },
  "scale|precipitation.scale": { min: 0.5, max: 2.5 },
  "scale|wind.calmFraction": { min: 0, max: 2 },
  "set|cloud.dry": { min: 0, max: 1 },
  "offset|humidity.wet": { min: -0.2, max: 0.2 },
  // Component.APPLY_TARGETS (l.137-142) — Ashfall's own grid. `precip` there is
  // one composed target over `precipitation.pww / pwd`; both halves sweep 0…1.
  "set|precipitation.pwd": { min: 0, max: 1 },
  "set|precipitation.pww": { min: 0, max: 1 },
  "scale|wind.speed": { min: 0, max: 3 },
};

/** Component.ERA_TARGETS (l.123-128). An era leans cold, so `temp` is −12…+4, not symmetric. */
const ERA_RANGES: Record<string, TargetRange> = {
  "offset|temperature.mean": { min: -12, max: 4 },
  "scale|precipitation.pwd": { min: 0, max: 1.5 },
  "scale|wind.speed": { min: 0, max: 3 },
  "offset|cloud.dry": { min: -0.3, max: 0.3 },
};

/** Component.REG_TARGETS (l.101-108). */
const REGIME_RANGES: Record<string, TargetRange> = {
  "scale|precipitation.pww": { min: 0, max: 2 },
  "scale|precipitation.pwd": { min: 0, max: 2 },
  "offset|temperature.mean": { min: -6, max: 6 },
  "scale|temperature.diurnalRange": { min: 0.5, max: 2 },
  "scale|wind.speed": { min: 0, max: 3 },
  "offset|cloud.dry": { min: -0.3, max: 0.3 },
};

const SURFACE_RANGES: Record<KnobSurface, Record<string, TargetRange>> = { device: DEVICE_RANGES, era: ERA_RANGES, regime: REGIME_RANGES };

/**
 * The two SPELL knobs, which are not ops and so have no `ModifierOp` to look
 * up. The prototype's generic device chrome drags them `knobOf(starts, 0, 6)`
 * and `knobOf(dur, 1, 60)` (Component.js l.1062-1063); the floor here is 0.05
 * rather than 0 because `profile.ts` rejects `meanStartsPerYear` that is not
 * `> 0` — a knob must not be able to drag a device into an invalid world.
 * Neither carries a `neutral`: a spell has no no-op rate to return to, so both
 * arcs run from the track minimum.
 */
export const SPELL_STARTS_RANGE = { min: 0.05, max: 6, step: 0.1 } as const;
/** @see SPELL_STARTS_RANGE */
export const SPELL_DURATION_RANGE = { min: 1, max: 60, step: 1 } as const;

/**
 * The no-op value a power arc grows out of: ×1 for a `scale`, +0 for an
 * `offset`, and nothing at all for a `set`/`clamp`, which have no value to
 * return to.
 *
 * A detent that lands on either END of the track is suppressed, exactly as the
 * prototype does it (`knobArcD` is handed `ctr`, and `ctr <= 0.01 || ctr >= 0.99`
 * becomes `null`): a centre nobody can see is worse than none, because the arc
 * then reads as a sliver out of the 12 o'clock detent instead of a sweep from
 * the track minimum. This is why `wind.speed offset 0…24` draws a plain
 * left-to-right arc — its "+0" sits *on* the minimum.
 */
function neutralFor(op: ModifierOp["op"], min: number, max: number): number | undefined {
  const value = op === "scale" ? 1 : op === "offset" ? 0 : undefined;
  if (value === undefined || max === min) return undefined;
  const centre = (value - min) / (max - min);
  return centre <= 0.01 || centre >= 0.99 ? undefined : value;
}

/** Metric units; the imperial readout is `format.ts`'s job, not the knob's range. */
const PROBABILITY_PARAMS = new Set(["precipitation.pww", "precipitation.pwd", "humidity.dry", "humidity.wet", "humidity.sd", "cloud.dry", "cloud.wet", "cloud.sd", "wind.calmFraction"]);

interface ParamShape {
  /** absolute domain, used by `set` and `clamp` */
  domain: [number, number];
  /** symmetric ± range for `offset` */
  offset: number;
  step: number;
  unit: string;
}

const DEFAULT_SHAPE: ParamShape = { domain: [-100, 100], offset: 10, step: 0.1, unit: "" };

const PARAM_SHAPES: Record<string, ParamShape> = {
  "temperature.mean": { domain: [-60, 60], offset: 10, step: 0.1, unit: "°C" },
  "temperature.diurnalRange": { domain: [0, 40], offset: 10, step: 0.1, unit: "°C" },
  "temperature.wetDayOffset": { domain: [-20, 20], offset: 10, step: 0.1, unit: "°C" },
  "temperature.wetDayRangeOffset": { domain: [-20, 20], offset: 10, step: 0.1, unit: "°C" },
  "temperature.sd": { domain: [0, 40], offset: 10, step: 0.1, unit: "°C" },
  "temperature.sdHigh": { domain: [0, 40], offset: 10, step: 0.1, unit: "°C" },
  "temperature.sdLow": { domain: [0, 40], offset: 10, step: 0.1, unit: "°C" },
  "temperature.phase": { domain: [0, 1], offset: 0.5, step: 0.01, unit: "" },
  "temperature.persistence": { domain: [0, 0.9], offset: 0.5, step: 0.01, unit: "" },
  "precipitation.shape": { domain: [0, 10], offset: 5, step: 0.05, unit: "" },
  "precipitation.scale": { domain: [0, 100], offset: 50, step: 0.5, unit: "mm" },
  "precipitation.freezingPoint": { domain: [-20, 20], offset: 10, step: 0.1, unit: "°C" },
  "wind.speed": { domain: [0, 200], offset: 50, step: 0.5, unit: "km/h" },
  "wind.speedSd": { domain: [0, 200], offset: 50, step: 0.5, unit: "km/h" },
  "wind.direction": { domain: [0, 360], offset: 180, step: 1, unit: "°" },
  "wind.directionSpread": { domain: [0, 180], offset: 90, step: 1, unit: "°" },
  "wind.wetDayScale": { domain: [0, 3], offset: 1, step: 0.01, unit: "" },
};

const PROBABILITY_SHAPE: ParamShape = { domain: [0, 1], offset: 1, step: 0.01, unit: "" };
/** Every `scale` op with no prototype table entry sweeps the same multiplier range, whatever it multiplies. */
const SCALE_SHAPE = { min: 0, max: 3, step: 0.01 };

function shapeOf(param: string): ParamShape {
  if (PROBABILITY_PARAMS.has(param)) return PROBABILITY_SHAPE;
  return PARAM_SHAPES[param] ?? DEFAULT_SHAPE;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** House style puts a space before a unit word; the degree sign is the exception (`180°`, not `180 °`). */
const NO_SPACE_UNITS = new Set(["°"]);

function plain(unit: string, decimals: number): (v: number) => string {
  return (v) => {
    const n = v.toFixed(decimals);
    if (!unit) return n;
    return NO_SPACE_UNITS.has(unit) ? `${n}${unit}` : `${n} ${unit}`;
  };
}

function signed(unit: string, decimals: number): (v: number) => string {
  return (v) => `${v >= 0 ? "+" : ""}${plain(unit, decimals)(v)}`;
}

/**
 * The knob range for one op on one `surface`.
 *
 * The prototype's own table for that surface wins where it has an entry (see
 * `SURFACE_RANGES` — the same op is a different dial on a device, an era and a
 * regime). Otherwise the generic derivation stands: a `scale` is the ×0…×3
 * multiplier knob, an `offset` is a symmetric ± range in the parameter's own
 * unit (temperature ±10 °C, cloud/probability ±1), and `set`/`clamp` sweep the
 * parameter's whole domain (probabilities 0…1, `wind.direction` 0…360).
 *
 * The range is *display and drag* only. A stored value outside it is clamped
 * on the way onto the dial (`knob.ts`'s `normalise`/`dragToValue`) and never
 * written back.
 */
export function knobSpecFor(op: ModifierOp, surface: KnobSurface = "device"): KnobSpecFor {
  const shape = shapeOf(op.param);
  const override = SURFACE_RANGES[surface][`${op.op}|${op.param}`];
  const generic = op.op === "scale" ? { min: SCALE_SHAPE.min, max: SCALE_SHAPE.max, step: SCALE_SHAPE.step } : op.op === "offset" ? { min: -shape.offset, max: shape.offset, step: shape.step } : { min: shape.domain[0], max: shape.domain[1], step: shape.step };
  const min = override?.min ?? generic.min;
  const max = override?.max ?? generic.max;
  const step = override?.step ?? generic.step;
  const neutral = neutralFor(op.op, min, max);
  const fmt = op.op === "scale" ? (v: number) => `×${v.toFixed(2)}` : op.op === "offset" ? signed(shape.unit, decimalsOf(step)) : plain(shape.unit, decimalsOf(step));
  return { min, max, neutral, step, fmt };
}

/** `spec` as a `KnobSpec` — the same numbers with `neutral` back to being an optional key. */
export function knobRangeOf(spec: KnobSpecFor): KnobSpec {
  return { min: spec.min, max: spec.max, step: spec.step, ...(spec.neutral !== undefined ? { neutral: spec.neutral } : {}) };
}

// ---------------------------------------------------------------------------
// MOD — onset envelopes (SPEC §3.4 "the onset envelope editor", §7 `envelope`)
// ---------------------------------------------------------------------------

/**
 * The named onset shapes the prototype offers on a moon-bound target
 * (`Component.ENVS`). Phases are the moon cycle's, so `Sharp` is a spike just
 * before full and `Ease in` is a slow build into it. A hand-drawn envelope
 * matches none of them and reads as `custom`.
 *
 * The prototype's shapes end at phase 1; phases live in [0, 1) here (1 wraps to
 * 0, `device-edit.ts`'s `wrapPhase`), so each last point sits one thousandth
 * short of the wrap.
 */
export const ENVELOPE_SHAPES: ReadonlyArray<{ name: string; points: ReadonlyArray<readonly [number, number]> }> = [
  {
    name: "Sharp",
    points: [
      [0.88, 0],
      [0.885, 1],
      [0.995, 1],
      [0.999, 0],
    ],
  },
  {
    name: "Ease in",
    points: [
      [0.78, 0],
      [0.88, 0.5],
      [0.94, 1],
      [0.999, 1],
    ],
  },
  {
    name: "Swell",
    points: [
      [0.8, 0],
      [0.9, 0.85],
      [0.94, 1],
      [0.98, 0.85],
      [0.999, 0],
    ],
  },
  {
    name: "Pulse",
    points: [
      [0.92, 0],
      [0.94, 1],
      [0.96, 0],
    ],
  },
  {
    name: "Ramp out",
    points: [
      [0.88, 1],
      [0.96, 0.4],
      [0.999, 0],
    ],
  },
];

/** Authored phases carry three decimals at most; comparing at that precision is what makes a preset recognisable. */
const SAME_POINT = 1e-3;

/** The shape chip's text for one envelope — a preset's name, or `custom` for a drawn one. */
export function envelopeShapeName(points: ReadonlyArray<readonly [number, number]> | undefined): string {
  if (points === undefined || points.length === 0) return "none";
  for (const shape of ENVELOPE_SHAPES) {
    if (shape.points.length !== points.length) continue;
    if (shape.points.every((p, i) => Math.abs(p[0] - points[i]![0]) < SAME_POINT && Math.abs(p[1] - points[i]![1]) < SAME_POINT)) return shape.name;
  }
  return "custom";
}

/** A named shape's points, as a fresh mutable envelope; an unknown name falls back to `Ease in`. */
export function envelopeShape(name: string): Array<[number, number]> {
  const found = ENVELOPE_SHAPES.find((s) => s.name === name) ?? ENVELOPE_SHAPES[1]!;
  return found.points.map(([p, s]): [number, number] => [p, s]);
}

// ---------------------------------------------------------------------------
// APPLY copy and the WRITES grammar (SPEC law 5)
// ---------------------------------------------------------------------------

/**
 * What an apply knob reads *under* its name: the value and its consequence,
 * with the friendly name stripped off `describeOp` so the two can never drift —
 * `0 — no rain`, `0.95 — ash-dark`, `×1.50`, `+12 km/h`.
 */
export function opValueText(op: ModifierOp, units?: "metric" | "imperial"): string {
  const name = paramName(op.param);
  const full = describeOp(op, units === undefined ? {} : { units });
  return full.startsWith(`${name} `) ? full.slice(name.length + 1) : full;
}

/**
 * The engine has no `precip` param: "no rain" is two writes, one to the odds of
 * rain after a dry day and one after a wet one. The prototype hides that seam —
 * its Ashfall APPLY has ONE `precip` column whose field reads
 * `precipitation.pww / pwd` (`1397-logic-class-Component.js` l.139, emitter
 * l.873) — so a device that writes both the same way renders as one column too.
 *
 * Presentation only: nothing is stored, and the pair is a property of the OPS,
 * not of the device's kind. The moment the two writes disagree about anything a
 * reader could see — the op, the number, the mute, the envelope — they are two
 * different edits wearing one hat, and the honest render is two columns.
 */
const COMPOSED_PARAMS = ["precipitation.pwd", "precipitation.pww"] as const;

/** The field string the composed column's gloss carries, in the prototype's own order. */
export const COMPOSED_FIELD = "precipitation.pww / pwd";

/** `[[lower, higher]]` for every pair of ops an APPLY should draw as one column, else `[]`. */
export function composedPairs(apply: readonly ModifierOp[]): Array<[number, number]> {
  const at = COMPOSED_PARAMS.map((p) => {
    const found = apply.flatMap((o, i) => (o.param === p ? [i] : []));
    return found.length === 1 ? found[0]! : -1;
  });
  const [a, b] = [at[0]!, at[1]!];
  if (a < 0 || b < 0) return [];
  const [x, y] = [apply[a]!, apply[b]!];
  if (x.op !== y.op) return [];
  // `clamp` has a floor and a ceiling rather than one number to turn, and it
  // renders as raw text anyway — two of them stay two.
  if (x.op === "clamp" || y.op === "clamp") return [];
  if (x.value !== y.value) return [];
  if ((x.enabled === false) !== (y.enabled === false)) return [];
  if (JSON.stringify(x.envelope ?? null) !== JSON.stringify(y.envelope ?? null)) return [];
  return [[Math.min(a, b), Math.max(a, b)]];
}

/** The `when` clause of the WRITES grammar — engine grammar, product numbers. */
/**
 * A moon gate's end as a number to print: the stored range is `[a, b)` on
 * the cycle, so a gate that runs to the end of the cycle stores `b = 0` — and
 * prints as `1.00`, the way the prototype's own `gate 0.78-1.00` does.
 */
export function moonRangeEnd(range: readonly [number, number]): number {
  return range[1] === 0 && range[0] > 0 ? 1 : range[1];
}

/** `[0.86, 1.00]` — the gate range as the WRITES footer prints it. */
export function moonRangeLabel(range: readonly [number, number]): string {
  return `[${range[0].toFixed(2)}, ${moonRangeEnd(range).toFixed(2)}]`;
}

export function whenPhrase(d: Device): string {
  const w = d.when;
  switch (w.kind) {
    case "always":
      return d.spell ? "" : "stage climate";
    case "moon":
      return `when.moon ${w.moon} ${moonRangeLabel(w.range)}`;
    case "tag":
      return w.tags.length === 1 ? `when.tag ${w.tags[0]}` : `when.any ${w.tags.map((t) => `tag ${t}`).join(", ")}`;
    case "yearWindow":
      return `when.yearPhase ${yearWindowsOf(w)
        .map((c) => `[${c.start.toFixed(2)},${Math.min(1, round10(c.start + c.length)).toFixed(2)}]`)
        .join(" ")}`;
    case "chance":
      return `when.chance ${w.p.toFixed(2)}`;
  }
}

/**
 * The WRITES footer for one device (SPEC law 5): the authored grammar, never
 * the serialised object —
 *
 *   modifiers[0] · when.moon Sable [0.86, 1.00] · apply precipitation.pwd ×1.50,
 *   wind.speed +12 · mods 1
 *
 * `index` is the device's slot in `zone.modifiers`, which is the signal-path
 * position the id alone does not carry.
 *
 * On the **moon path** the tail is named rather than counted, the way the
 * prototype's `stWrites` reads it (`0699` l.106) —
 *
 *   modifiers[0] · when.moon Sable [0.86, 1.00] ·
 *   apply precipitation.pwd ×1.50 ∿ease in, wind.speed +12 · × season:Harvest@72%
 *
 * — because that is the path whose window edits a binding at a time, so the
 * footer has to say which binding carries which onset. Three things stay the
 * plugin's rather than the prototype's, all for law 5: the `modifiers[N]`
 * slot and the `[a, b)` range stay (they are the fields written, and the
 * prototype simply has no rack); the param paths stay whole (`precipitation.pwd`,
 * not the prototype's short `pwd`); and the moon keeps the calendar's own
 * casing (`Sable`, not `sable`) because that string IS `when.moon`. The gates
 * are listed ONCE, not repeated per clause as the prototype does: `mods` hangs
 * off the modifier, not the op, and repeating it would claim a per-binding
 * field the schema does not have (`mod-moon.ts` header).
 */
export function deviceGrammar(d: Device, index: number): string {
  const moon = d.when.kind === "moon";
  const ops = d.apply.map((op) => `${applyPhrase(op).replace(/^apply /, "")}${moon && op.envelope !== undefined ? ` ∿${envelopeShapeName(op.envelope).toLowerCase()}` : ""}`);
  const envelopes = d.apply.filter((op) => op.envelope !== undefined).length;
  return grammar(
    `modifiers[${index}]`,
    d.enabled ? "" : "off",
    whenPhrase(d),
    d.spell ? `spell ${num(d.spell.meanStartsPerYear)}/yr ${num(d.spell.meanDurationDays)} d` : "",
    ops.length > 0 ? `apply ${ops.join(", ")}` : "no apply",
    moon ? d.mods.map((g) => `× ${g.source}@${gatePercent(g.amount)}`).join(" ") : d.mods.length > 0 ? `mods ${d.mods.length}` : "",
    moon || envelopes === 0 ? "" : `envelope ${envelopes}`,
  );
}

/** A gate chip's amount, as the prototype writes it: `72%`. */
export function gatePercent(amount: number): string {
  return `${Math.round(amount * 100)}%`;
}
