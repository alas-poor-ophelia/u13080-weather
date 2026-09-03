/**
 * Regimes — the pure half of the `Regimes · STATES` window (SPEC §3.4, §6,
 * PLAN D13, D14).
 *
 * A regime is the zone's sticky day-to-day weather state: `{ id, weight,
 * meanDurationDays, apply? }`. The roll picks one by relative weight, keeps it
 * for a geometric run around `meanDurationDays`, then picks again. The UI
 * vocabulary maps one-to-one onto those fields — **how often** = `weight`,
 * **how long** = `meanDurationDays`, **share of the year** = `weight × dwell`
 * normalised (`audition.ts`'s `shareOfYear`), **what changes** = `apply`.
 *
 * Two rules this file exists to enforce:
 *
 *  - **The id is the display name** (PLAN D13). There is no separate `name`
 *    field, so a rename is an id change, and an id change is only safe if
 *    every `{ regime: "<old>" }` predicate in the zone's modifiers moves with
 *    it. `renameState` does both, deeply, through `all` / `any` / `not`.
 *  - **A zone keeps at least one state.** `validateProfile` makes an empty
 *    `regimes[]` an error, so `removeState` refuses rather than writing a
 *    draft the studio would immediately have to complain about.
 *
 * Colour is view state (PLAN D14): the cycle here is the default, and the
 * leaf's persisted `view.colours.regimes` overrides it per position.
 *
 * Pure: no Obsidian imports, no DOM (PLAN D3).
 */
import type { ModifierOp, Predicate, ZoneProfile } from "../../core/types";
import type { Units } from "../../core/units";
import { uniqueId } from "../../plugin/zones";
import { shareOfYear } from "./audition";
import { channelOrNull, type Channel } from "./compile";
import { applyPhrase, describeOp, paramName } from "./copy";
import { tabular } from "./format";
import { cycleAt, REGIME_CYCLE } from "./palette";

/**
 * The six data colours a regime swatch cycles through (SPEC §9), from
 * `model/palette.ts`. Neutral grey leads because the first state of a real
 * preset is the *ordinary* weather — the channel hues are spent on the states
 * that do something, so this is a different order from the band cycle.
 */
export const REGIME_COLOURS: readonly string[] = REGIME_CYCLE;

/**
 * The Regimes lane's second label line (SPEC §3.2): how many states there are
 * and how much of the year each one holds — the same shares the Era-zoom
 * collapse draws as a bar. The label column ellipsizes it, so the most
 * important reading (the count, then the biggest share) comes first.
 */
export function laneSub(zone: Pick<ZoneProfile, "regimes">): string {
  const regimes = zone.regimes;
  if (regimes.length === 0) return "no states";
  const shares = shareOfYear(regimes).map((s) => `${s.id} ${Math.round(s.share * 100)}%`);
  return `${regimes.length} states · ${shares.join(" · ")}`;
}

/** The state a new `＋ state` lands on: rare-ish and short, so it never silently reshapes the year. */
const NEW_STATE_WEIGHT = 0.1;
const NEW_STATE_DWELL = 7;
/** `uniqueId`'s base for a new state — "state", "state-2", "state-3" … */
const NEW_STATE_BASE = "state";

/**
 * The swatch colour for the regime at `index`. `view` is the leaf's persisted
 * `view.colours.regimes` (palette indices by list position, PLAN D14): a finite
 * entry there overrides the cycle, anything else falls back to position.
 */
export function colourOf(index: number, view: number[] | undefined): string {
  const override = view?.[index];
  const pick = typeof override === "number" && Number.isFinite(override) ? override : index;
  return cycleAt(pick, REGIME_CYCLE);
}

/**
 * Append a new state and return its id. `taken` adds ids the caller wants
 * avoided beyond the zone's own regimes (nothing else shares the namespace
 * today, but a caller staging several adds needs it).
 */
export function addState(z: ZoneProfile, taken?: Iterable<string>): string {
  const ids = new Set<string>(z.regimes.map((r) => r.id));
  if (taken !== undefined) for (const t of taken) ids.add(t);
  const id = uniqueId(NEW_STATE_BASE, ids);
  z.regimes.push({ id, weight: NEW_STATE_WEIGHT, meanDurationDays: NEW_STATE_DWELL });
  return id;
}

/**
 * Remove the state `id`. Refuses — returning `false` — when it is the last one
 * (SPEC §6: the slot cannot be emptied) or when there is no such state.
 */
export function removeState(z: ZoneProfile, id: string): boolean {
  if (z.regimes.length <= 1) return false;
  const at = z.regimes.findIndex((r) => r.id === id);
  if (at < 0) return false;
  z.regimes.splice(at, 1);
  return true;
}

/**
 * Rename the state `id` to `name` and return the id it actually got. The name
 * is trimmed; a blank name, an unknown `id`, or a name that resolves back to
 * the current id are all no-ops. A collision with another state is resolved by
 * `uniqueId` ("storm" → "storm-2"), and **every `{ regime: "<old>" }` predicate
 * in `z.modifiers` is rewritten** — deeply, through `all` / `any` / `not` —
 * so a device gated on this state follows it (PLAN D13).
 */
export function renameState(z: ZoneProfile, id: string, name: string): string {
  const regime = z.regimes.find((r) => r.id === id);
  if (regime === undefined) return id;
  const trimmed = name.trim();
  if (trimmed === "") return id;
  const others = new Set(z.regimes.filter((r) => r !== regime).map((r) => r.id));
  const next = uniqueId(trimmed, others);
  if (next === id) return id;
  regime.id = next;
  for (const m of z.modifiers ?? []) if (m.when !== undefined) rewriteRegimeRefs(m.when, id, next);
  return next;
}

/** Rewrite `{ regime: from }` to `{ regime: to }` in place, through every composite. */
function rewriteRegimeRefs(p: Predicate, from: string, to: string): void {
  if (typeof p !== "object" || p === null) return;
  if ("all" in p) {
    if (Array.isArray(p.all)) for (const q of p.all) rewriteRegimeRefs(q, from, to);
    return;
  }
  if ("any" in p) {
    if (Array.isArray(p.any)) for (const q of p.any) rewriteRegimeRefs(q, from, to);
    return;
  }
  if ("not" in p) {
    rewriteRegimeRefs(p.not, from, to);
    return;
  }
  if ("regime" in p && p.regime === from) p.regime = to;
}

/** How often the roll picks this state, relative to the others. Clamped to ≥ 0 (`validateProfile`'s rule). */
export function setWeight(z: ZoneProfile, id: string, weight: number): void {
  const regime = z.regimes.find((r) => r.id === id);
  if (regime === undefined) return;
  regime.weight = Number.isFinite(weight) ? Math.max(0, weight) : 0;
}

/** How long a run lasts once picked, in days. Clamped to ≥ 1 (`validateProfile`'s rule). */
export function setDwell(z: ZoneProfile, id: string, days: number): void {
  const regime = z.regimes.find((r) => r.id === id);
  if (regime === undefined) return;
  regime.meanDurationDays = Number.isFinite(days) ? Math.max(1, days) : 1;
}

/** The state's ops — the live array, so a caller may read indices off it. `[]` when it has none. */
export function applyFor(z: ZoneProfile, id: string): ModifierOp[] {
  return z.regimes.find((r) => r.id === id)?.apply ?? [];
}

/** Set one op's value. `clamp` has no single value and is left alone. */
export function setApplyValue(z: ZoneProfile, id: string, opIndex: number, value: number): void {
  const op = applyFor(z, id)[opIndex];
  if (op === undefined || op.op === "clamp") return;
  if (!Number.isFinite(value)) return;
  op.value = value;
}

/** Append an op to the state, creating `apply` when it is the first. */
export function addApply(z: ZoneProfile, id: string, op: ModifierOp): void {
  const regime = z.regimes.find((r) => r.id === id);
  if (regime === undefined) return;
  if (regime.apply === undefined) regime.apply = [];
  regime.apply.push(op);
}

/** Remove one op. An emptied `apply` is dropped rather than written as `[]` — the field is optional. */
export function removeApply(z: ZoneProfile, id: string, opIndex: number): void {
  const regime = z.regimes.find((r) => r.id === id);
  if (regime?.apply === undefined) return;
  if (opIndex < 0 || opIndex >= regime.apply.length) return;
  regime.apply.splice(opIndex, 1);
  if (regime.apply.length === 0) delete regime.apply;
}

/**
 * The mixer's per-chain mute, applied to a regime (SPEC §3.3, §6: the Regimes
 * slot is fixed in every chain and carries per-chain mute only). Regime ops
 * bypass the modifier engine, so the mute is per-op `enabled` on the ops of
 * that channel (PLAN §0.1); un-muting deletes the flag rather than writing
 * `enabled: true`, so a never-muted state stays byte-identical.
 */
export function setApplyChainMute(z: ZoneProfile, id: string, chain: Channel, muted: boolean): void {
  for (const op of applyFor(z, id)) {
    if (channelOrNull(op.param) !== chain) continue;
    if (muted) op.enabled = false;
    else delete op.enabled;
  }
}

/**
 * The SHARE OF THE YEAR bar: each state's normalised `weight × dwell`
 * (`audition.ts`'s `shareOfYear`, the same arithmetic the roll implies) with
 * its swatch colour. `view` is the leaf's `view.colours.regimes`, so the bar
 * and the lane agree on the tints.
 */
export function shareBar(z: ZoneProfile, view?: number[]): Array<{ id: string; share: number; colour: string }> {
  return shareOfYear(z.regimes).map((s, i) => ({ id: s.id, share: s.share, colour: colourOf(i, view) }));
}

/**
 * A state's apply knobs wear their OWN short names, not the shared `target`
 * vocabulary (`model/copy.ts`). The prototype keeps two lists for a reason:
 * a device's precipitation knob is "precip" because the device already says
 * what it does, but a state's two precipitation knobs are the transition
 * probabilities and have to be told apart — `wet→wet` (a wet day follows a
 * wet one) and `dry→wet` (a wet day follows a dry one) read as behaviour,
 * where "precip · precip" reads as a bug. Anything not in this table falls
 * back to the shared name.
 */
const REGIME_TARGET_NAMES: Record<string, string> = {
  "precipitation.pww": "wet→wet",
  "precipitation.pwd": "dry→wet",
  "temperature.mean": "temp",
  "temperature.diurnalRange": "day swing",
  "temperature.diurnal": "day swing",
  "wind.speed": "wind",
  "cloud.dry": "sky",
  "cloud.wet": "sky",
};

/** The apply knob's label — `wet→wet`, `day swing`, `sky`. */
export function regimeTargetName(param: string): string {
  return REGIME_TARGET_NAMES[param] ?? paramName(param);
}

/** One op as a state reads it: `wet→wet ×1.25`. `describeOp`'s value, this file's name. */
export function regimeApplyText(op: ModifierOp, units: Units = "metric"): string {
  const described = describeOp(op, { units });
  const generic = paramName(op.param);
  return described.startsWith(`${generic} `) ? `${regimeTargetName(op.param)}${described.slice(generic.length)}` : described;
}

/**
 * The line under a state's name: what it does to the baseline while it runs,
 * or the prototype's `— no apply · baseline as-is` when it does nothing. A
 * state with no apply is not broken — it IS the ordinary weather (SPEC §6) —
 * so it says so rather than showing an empty row.
 */
export function applySummary(z: ZoneProfile, id: string, units: Units = "metric"): string {
  const ops = applyFor(z, id);
  if (ops.length === 0) return "— no apply · baseline as-is";
  return ops.map((op) => regimeApplyText(op, units)).join(" · ");
}

/**
 * The WRITES footer's grammar (SPEC law 5): one line of `regimes[]` in the
 * engine's own vocabulary — param paths intact, values formatted — not
 * `JSON.stringify`, which is what sized this panel at 1500 px.
 *
 *   regimes [ { normal w 0.70 · 12 d }, { wet-spell w 0.15 · 6 d · scale[precipitation.pww ×1.25] } ]
 */
export function regimesWrites(z: ZoneProfile): string {
  const states = z.regimes.map((r) => {
    const head = `${r.id} w ${tabular(r.weight, 2)} · ${tabular(Math.round(r.meanDurationDays), 0)} d`;
    const ops = (r.apply ?? []).map((op) => `${op.op}[${applyPhrase(op).replace(/^apply /, "")}]`);
    return `{ ${ops.length === 0 ? head : `${head} · ${ops.join(" ")}`} }`;
  });
  return `regimes [ ${states.join(", ")} ]`;
}
