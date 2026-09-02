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
  | { kind: "yearWindow"; start: number; length: number }
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

/** Which kind the rack shows for `m`, or `"custom"` when the predicate is outside the studio's five shapes. */
export function kindOf(m: Modifier): DeviceKind | "custom" {
  const w = m.when;
  if (!w) return m.spell ? "spell" : "trim";
  if ("moon" in w) return "moon";
  if ("yearPhase" in w) return "spell";
  if ("tag" in w) return "tag";
  if ("chance" in w) return "chance";
  if ("any" in w && everyLeafIsTag(w.any)) return "tag";
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
  if ("yearPhase" in w) {
    const [a, b] = w.yearPhase;
    return { kind: "yearWindow", start: a, length: round10(b >= a ? b - a : 1 - a + b) };
  }
  if ("tag" in w) return { kind: "tag", tags: [w.tag] };
  if ("chance" in w) return { kind: "chance", p: w.chance };
  if ("any" in w && everyLeafIsTag(w.any)) return { kind: "tag", tags: w.any.map((q) => (q as { tag: string }).tag) };
  return null;
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
      const end = round10(w.start + w.length);
      return { yearPhase: [w.start, end > 1 ? round10(end - 1) : end] };
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
      const from = Math.floor(w.start * yearLength);
      const to = Math.floor((w.start + w.length) * yearLength) - 1;
      head = `days ${from}–${to}`;
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
  neutral: number;
  step: number;
  fmt: (v: number) => string;
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
/** Every `scale` op sweeps the same multiplier range, whatever it multiplies. */
const SCALE_SHAPE = { min: 0, max: 3, neutral: 1, step: 0.01 };

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
 * The knob range for one op: a `scale` is always the ×0…×3 multiplier knob,
 * an `offset` is a symmetric ± range in the parameter's own unit (temperature
 * ±10 °C, cloud/probability ±1), and `set`/`clamp` sweep the parameter's whole
 * domain (probabilities 0…1, `wind.direction` 0…360).
 */
export function knobSpecFor(op: ModifierOp): KnobSpecFor {
  const shape = shapeOf(op.param);
  if (op.op === "scale") return { ...SCALE_SHAPE, fmt: (v) => `×${v.toFixed(2)}` };
  const decimals = decimalsOf(shape.step);
  if (op.op === "offset") return { min: -shape.offset, max: shape.offset, neutral: 0, step: shape.step, fmt: signed(shape.unit, decimals) };
  // set / clamp: the parameter's own domain, neutral at the low end (there is no "no-op" value to return to).
  return { min: shape.domain[0], max: shape.domain[1], neutral: shape.domain[0], step: shape.step, fmt: plain(shape.unit, decimals) };
}
