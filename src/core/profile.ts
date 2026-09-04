/**
 * Profile resolution (DESIGN-v1.md §2 "Resolution order"):
 *
 *   stored climate (Tier C, already includes the copied preset + Tier A)
 *   → climate-stage modifiers (unconditional curve edits)
 *   → per day: regime ops → daily-stage modifiers → generate
 *
 * Also: validation (errors block generation, warnings don't) and a
 * profile hash for provenance / cache keys. The hash uses the frozen RNG
 * hash (no crypto dependency; Obsidian mobile has no Bun.CryptoHasher).
 */
import { automationOps, FALLBACK_YEAR_LENGTH, validateAutomation } from "./automation";
import { isCurvePath, isScalarPath, applyClimateOps } from "./curve-ops";
import { Generator, MAX_PERSISTENCE, type GeneratorConfig } from "./generator";
import { type DailyModifierResult, ModifierEngine } from "./modifiers";
import { hash32 } from "./rng";
import type { AutomationLane, ClimateParams, Curve, DayTime, ModGate, Modifier, ModifierOp, Predicate, ZoneProfile } from "./types";

export interface ValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

const RECOMMENDED_PERSISTENCE = 0.9;
const RECOMMENDED_REGIME_DURATION = 30;

function validateCurve(c: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof c === "number") {
    if (!Number.isFinite(c)) issues.push({ level: "error", path, message: "must be finite" });
    return;
  }
  if (Array.isArray(c)) {
    if (c.length === 0) issues.push({ level: "error", path, message: "keyframe array is empty" });
    for (const [i, k] of c.entries()) {
      if (typeof k !== "object" || k === null || typeof (k as { at?: unknown }).at !== "number" || typeof (k as { value?: unknown }).value !== "number") {
        issues.push({ level: "error", path: `${path}[${i}]`, message: "keyframe needs numeric at and value" });
        continue;
      }
      const kf = k as { at: number; value: number };
      if (!(kf.at >= 0 && kf.at < 1)) issues.push({ level: "error", path: `${path}[${i}].at`, message: "must be in [0,1)" });
      if (!Number.isFinite(kf.value)) issues.push({ level: "error", path: `${path}[${i}].value`, message: "must be finite" });
    }
    return;
  }
  if (typeof c === "object" && c !== null) {
    const h = c as { mean?: unknown; amplitude?: unknown; phase?: unknown };
    if (typeof h.mean !== "number" || typeof h.amplitude !== "number") issues.push({ level: "error", path, message: "harmonic needs numeric mean and amplitude" });
    if (typeof h.phase !== "number") issues.push({ level: "error", path: `${path}.phase`, message: "harmonic phase is required (no silent default)" });
    else if (!(h.phase >= 0 && h.phase < 1)) issues.push({ level: "error", path: `${path}.phase`, message: "must be in [0,1)" });
    return;
  }
  issues.push({ level: "error", path, message: "not a Curve" });
}

function validatePredicate(p: Predicate, path: string, issues: ValidationIssue[]): void {
  if (typeof p !== "object" || p === null) {
    issues.push({ level: "error", path, message: "predicate must be an object" });
    return;
  }
  const keys = Object.keys(p);
  if (keys.length !== 1) {
    issues.push({ level: "error", path, message: `predicate must have exactly one key (got ${keys.join(", ") || "none"})` });
    return;
  }
  const k = keys[0]!;
  const v = (p as Record<string, unknown>)[k];
  const range = (r: unknown, where: string, max: number) => {
    if (!Array.isArray(r) || r.length !== 2 || typeof r[0] !== "number" || typeof r[1] !== "number") issues.push({ level: "error", path: where, message: "range must be [lo, hi]" });
    else if (r[0] < 0 || r[1] > max || r[0] > max || r[1] < 0) issues.push({ level: "error", path: where, message: `range values must be within [0, ${max}]` });
  };
  switch (k) {
    case "all":
    case "any":
      if (!Array.isArray(v)) issues.push({ level: "error", path: `${path}.${k}`, message: "must be an array of predicates" });
      else v.forEach((q, i) => validatePredicate(q as Predicate, `${path}.${k}[${i}]`, issues));
      break;
    case "not":
      validatePredicate(v as Predicate, `${path}.not`, issues);
      break;
    case "moon": {
      const m = v as { name?: unknown; phase?: unknown };
      if (typeof m?.name !== "string") issues.push({ level: "error", path: `${path}.moon.name`, message: "moon name required" });
      range(m?.phase, `${path}.moon.phase`, 1);
      break;
    }
    case "yearPhase":
      range(v, `${path}.yearPhase`, 1);
      break;
    case "dayOfYear":
      range(v, `${path}.dayOfYear`, 100000);
      break;
    case "tag":
    case "regime":
      if (typeof v !== "string" || !v) issues.push({ level: "error", path: `${path}.${k}`, message: "must be a non-empty string" });
      break;
    case "chance":
      if (typeof v !== "number" || !(v >= 0 && v <= 1)) issues.push({ level: "error", path: `${path}.chance`, message: "must be a number in [0,1]" });
      break;
    default:
      issues.push({ level: "error", path, message: `unknown predicate "${k}" — the grammar is closed (all, any, not, moon, yearPhase, dayOfYear, tag, regime, chance)` });
  }
}

/** Daily-stage ops outside a profile (the era timeline). */
export function validateDailyOps(ops: ModifierOp[], path: string, issues: ValidationIssue[]): void {
  validateOps(ops, "daily", path, issues);
}

function validateOps(ops: ModifierOp[], stage: "climate" | "daily", path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(ops)) {
    issues.push({ level: "error", path, message: "apply must be an array" });
    return;
  }
  ops.forEach((op, i) => {
    const where = `${path}[${i}]`;
    if (typeof op !== "object" || op === null) {
      issues.push({ level: "error", path: where, message: "op must be an object" });
      return;
    }
    const okPath = stage === "climate" ? isCurvePath(op.param) || isScalarPath(op.param) : isCurvePath(op.param);
    if (!okPath) issues.push({ level: "error", path: `${where}.param`, message: `unknown parameter path "${op.param}"` });
    if (!["set", "offset", "scale", "clamp"].includes(op.op)) issues.push({ level: "error", path: `${where}.op`, message: `unknown op "${(op as { op: string }).op}" — ops are set, offset, scale, clamp` });
    else if (op.op === "clamp") {
      if (op.min === undefined && op.max === undefined) issues.push({ level: "error", path: where, message: "clamp needs min and/or max" });
    } else if (op.op === "set" && typeof op.value !== "number") {
      // A Curve-valued `set` installs a whole annual shape. Only the climate stage still has
      // curves; by the daily stage the parameter is already an evaluated scalar.
      if (stage === "daily") issues.push({ level: "error", path: `${where}.value`, message: "set with a curve is climate stage only" });
      else if (isScalarPath(op.param)) issues.push({ level: "error", path: `${where}.value`, message: `"${op.param}" is a scalar parameter, not a curve — set it to a number` });
      else validateCurve(op.value, `${where}.value`, issues);
    } else if (typeof op.value !== "number" || !Number.isFinite(op.value)) issues.push({ level: "error", path: `${where}.value`, message: "value must be a finite number" });
    if (op.enabled !== undefined && typeof op.enabled !== "boolean") issues.push({ level: "error", path: `${where}.enabled`, message: "enabled must be true or false" });
    if (op.envelope !== undefined) validateEnvelope(op.envelope, op.op, stage, `${where}.envelope`, issues);
  });
}

/**
 * Onset envelope: a non-empty list of [phase in [0,1), strength in [0,1]],
 * daily stage only. Strength is a dimmer — an envelope shapes a device's onset,
 * it never amplifies it past the magnitude the author wrote.
 */
function validateEnvelope(env: Array<[number, number]>, op: string, stage: "climate" | "daily", path: string, issues: ValidationIssue[]): void {
  if (stage === "climate") issues.push({ level: "error", path, message: "envelope is a daily-stage onset shape; climate-stage ops cannot carry one" });
  if (!Array.isArray(env) || env.length === 0) {
    issues.push({ level: "error", path, message: "envelope must be a non-empty array of [phase, strength] points" });
    return;
  }
  env.forEach((pt, i) => {
    const ok = Array.isArray(pt) && pt.length === 2 && typeof pt[0] === "number" && typeof pt[1] === "number" && pt[0] >= 0 && pt[0] < 1 && pt[1] >= 0 && pt[1] <= 1;
    if (!ok) issues.push({ level: "error", path: `${path}[${i}]`, message: "envelope point must be [phase in [0,1), strength in [0,1]]" });
  });
  if (op === "set" || op === "clamp") issues.push({ level: "warning", path, message: "envelope has no effect on set/clamp" });
}

const GATE_FIELDS = ["source", "amount"];

/**
 * Mod-matrix gates: daily stage only, source is a non-empty tag (never a moon —
 * a moon is a carrier, not a gate), amount the gate's STRENGTH in [0, 1] — 1
 * restricts the device to its source, 0 is no gate (PLAN §0 D19).
 */
function validateGates(mods: ModGate[], stage: "climate" | "daily", path: string, issues: ValidationIssue[]): void {
  if (stage === "climate") issues.push({ level: "error", path, message: "gates (mods) are daily-stage only; a climate-stage modifier is unconditional" });
  if (!Array.isArray(mods)) {
    issues.push({ level: "error", path, message: "mods must be an array" });
    return;
  }
  mods.forEach((g, i) => {
    const where = `${path}[${i}]`;
    if (typeof g !== "object" || g === null) {
      issues.push({ level: "error", path: where, message: "gate must be an object" });
      return;
    }
    if (typeof g.source !== "string" || !g.source) issues.push({ level: "error", path: `${where}.source`, message: "must be a non-empty string (a tag, never a moon)" });
    else if (g.source.startsWith("moon:")) issues.push({ level: "error", path: `${where}.source`, message: "a gate is a tag; a moon is the carrier (use when.moon)" });
    if (typeof g.amount !== "number" || !(g.amount >= 0 && g.amount <= 1)) issues.push({ level: "error", path: `${where}.amount`, message: "amount must be between 0 and 1 (gate strength: 1 restricts to the source, 0 is no gate)" });
    for (const k of Object.keys(g)) if (!GATE_FIELDS.includes(k)) issues.push({ level: "warning", path: `${where}.${k}`, message: "unknown field (ignored)" });
  });
}

export function validateProfile(z: ZoneProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!z.id) issues.push({ level: "error", path: "id", message: "required" });
  const c = z.climate;
  if (!c) {
    issues.push({ level: "error", path: "climate", message: "required" });
    return issues;
  }
  const curves: Array<[string, Curve]> = [
    ["climate.temperature.mean", c.temperature?.mean],
    ["climate.temperature.diurnalRange", c.temperature?.diurnalRange],
    ["climate.temperature.wetDayOffset", c.temperature?.wetDayOffset],
    ["climate.temperature.sd", c.temperature?.sd],
    ["climate.precipitation.pww", c.precipitation?.pww],
    ["climate.precipitation.pwd", c.precipitation?.pwd],
    ["climate.precipitation.shape", c.precipitation?.shape],
    ["climate.precipitation.scale", c.precipitation?.scale],
    ["climate.humidity.dry", c.humidity?.dry],
    ["climate.humidity.wet", c.humidity?.wet],
    ["climate.cloud.dry", c.cloud?.dry],
    ["climate.cloud.wet", c.cloud?.wet],
    ["climate.wind.speed", c.wind?.speed],
    ["climate.wind.speedSd", c.wind?.speedSd],
    ["climate.wind.direction", c.wind?.direction],
    ["climate.wind.directionSpread", c.wind?.directionSpread],
    ["climate.wind.calmFraction", c.wind?.calmFraction],
  ];
  for (const [p, cv] of curves) validateCurve(cv, p, issues);
  for (const [p, cv] of [
    ["climate.temperature.sdHigh", c.temperature?.sdHigh],
    ["climate.temperature.sdLow", c.temperature?.sdLow],
    ["climate.temperature.wetDayRangeOffset", c.temperature?.wetDayRangeOffset],
  ] as Array<[string, Curve | undefined]>) {
    if (cv !== undefined) validateCurve(cv, p, issues);
  }

  const rho = c.temperature?.persistence;
  if (typeof rho !== "number" || !(rho >= 0 && rho <= MAX_PERSISTENCE)) issues.push({ level: "error", path: "climate.temperature.persistence", message: `must be in [0, ${MAX_PERSISTENCE}]` });
  else if (rho > RECOMMENDED_PERSISTENCE) issues.push({ level: "warning", path: "climate.temperature.persistence", message: `above ${RECOMMENDED_PERSISTENCE}: a faint seam may appear every ${64} days` });
  if (typeof c.temperature?.phase !== "number" || !(c.temperature.phase >= 0 && c.temperature.phase < 1)) issues.push({ level: "error", path: "climate.temperature.phase", message: "must be in [0,1)" });

  if (!Array.isArray(z.regimes) || z.regimes.length === 0) issues.push({ level: "error", path: "regimes", message: "at least one regime is required" });
  else {
    const ids = new Set<string>();
    z.regimes.forEach((r, i) => {
      if (!r.id || !r.id.trim()) issues.push({ level: "error", path: `regimes[${i}].id`, message: "required" });
      else if (ids.has(r.id)) issues.push({ level: "error", path: `regimes[${i}].id`, message: `duplicate regime id "${r.id}"` });
      if (r.id) ids.add(r.id);
      if (!(r.weight >= 0)) issues.push({ level: "error", path: `regimes[${i}].weight`, message: "must be >= 0" });
      if (!(r.meanDurationDays >= 1)) issues.push({ level: "error", path: `regimes[${i}].meanDurationDays`, message: "must be >= 1" });
      else if (r.meanDurationDays > RECOMMENDED_REGIME_DURATION) issues.push({ level: "warning", path: `regimes[${i}].meanDurationDays`, message: `above ${RECOMMENDED_REGIME_DURATION}: long-lived states belong in a spell modifier, not a regime` });
      if (r.apply) validateOps(r.apply, "daily", `regimes[${i}].apply`, issues);
    });
    if (!z.regimes.some((r) => r.weight > 0)) issues.push({ level: "error", path: "regimes", message: "at least one regime needs weight > 0" });
  }

  const mods = z.modifiers ?? [];
  const mids = new Set<string>();
  mods.forEach((m, i) => {
    const where = `modifiers[${i}]`;
    if (!m.id || !m.id.trim()) issues.push({ level: "error", path: `${where}.id`, message: "required" });
    else if (mids.has(m.id)) issues.push({ level: "error", path: `${where}.id`, message: `duplicate modifier id "${m.id}"` });
    else if (m.id.startsWith("era:")) issues.push({ level: "error", path: `${where}.id`, message: "ids starting with \"era:\" are reserved for the era timeline" });
    if (m.id) mids.add(m.id);
    const stage = m.stage ?? "daily";
    if (stage !== "climate" && stage !== "daily") issues.push({ level: "error", path: `${where}.stage`, message: "must be climate or daily" });
    if (m.enabled !== undefined && typeof m.enabled !== "boolean") issues.push({ level: "error", path: `${where}.enabled`, message: "enabled must be true or false" });
    if (stage === "climate" && (m.when || m.spell)) issues.push({ level: "error", path: where, message: "climate-stage modifiers are unconditional (no when/spell); use stage: daily" });
    if (m.mods !== undefined) validateGates(m.mods, stage, `${where}.mods`, issues);
    if (m.when) validatePredicate(m.when, `${where}.when`, issues);
    if (m.spell) {
      if (!(m.spell.meanStartsPerYear > 0)) issues.push({ level: "error", path: `${where}.spell.meanStartsPerYear`, message: "must be > 0" });
      if (!(m.spell.meanDurationDays >= 1)) issues.push({ level: "error", path: `${where}.spell.meanDurationDays`, message: "must be >= 1" });
      else if (m.spell.meanDurationDays > 50) issues.push({ level: "warning", path: `${where}.spell.meanDurationDays`, message: "very long spells (> 50 days) are looked back over at most 400 days" });
    }
    validateOps(m.apply, stage, `${where}.apply`, issues);
  });
  if (z.flipSeasons !== undefined && typeof z.flipSeasons !== "boolean") issues.push({ level: "error", path: "flipSeasons", message: "flipSeasons must be true or false" });
  validateAutomation(z.automation, issues);
  return issues;
}

/** Canonical JSON (sorted keys) → two frozen 32-bit hashes. Not cryptographic; a stable identity for caching/provenance. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, norm(o[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * Modifier keys that are display-only (never read by the engine) and must be
 * excluded from the provenance hash, so flipping one doesn't move the hash
 * (D20). Extend this list, don't touch `canonicalJson` itself — it has other
 * callers (UI diffing, store dirty checks) that must keep hashing every key.
 */
const HASH_EXCLUDED_MODIFIER_KEYS = ["badge"] as const;

/** `modifiers`, stripped of display-only keys, for hashing only. */
function modifiersForHash(mods: readonly Modifier[]): unknown[] {
  return mods.map((m) => {
    const copy = { ...m } as Record<string, unknown>;
    for (const k of HASH_EXCLUDED_MODIFIER_KEYS) delete copy[k];
    return copy;
  });
}

export function profileHash(z: ZoneProfile): string {
  // `automation` enters the canonical input ONLY when non-empty, so every hash
  // written before automation existed still reproduces (history protection, D5).
  const s = canonicalJson({ climate: z.climate, regimes: z.regimes, modifiers: modifiersForHash(z.modifiers ?? []), ...(z.automation?.length ? { automation: z.automation } : {}) });
  const a = hash32(s, 0x57414a45).toString(16).padStart(8, "0");
  const b = hash32(s, 0x54454a49).toString(16).padStart(8, "0");
  return `wh1:${a}${b}`;
}

export interface ResolvedProfile {
  zoneId: string;
  /** climate after climate-stage modifiers */
  climate: ClimateParams;
  regimes: ZoneProfile["regimes"];
  /**
   * Every `daily`-stage modifier, NOT filtered by `enabled`: the engine is what
   * skips a disabled device, so a UI reading this list still sees it (and can
   * show it greyed) rather than having it vanish from the rack.
   */
  dailyModifiers: Modifier[];
  /** the zone's automation lanes (empty when it has none) */
  automation: AutomationLane[];
  profileHash: string;
  issues: ValidationIssue[];
}

/** Apply climate-stage modifiers; throws if validation has errors. */
export function resolveProfile(z: ZoneProfile): ResolvedProfile {
  const issues = validateProfile(z);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) {
    throw new RangeError(`profile "${z.id}" is invalid:\n` + errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"));
  }
  const mods = z.modifiers ?? [];
  // enabled: absent = on, at both the modifier and the op level
  const climateOps = mods.filter((m) => m.stage === "climate" && m.enabled !== false).flatMap((m) => m.apply.filter((o) => o.enabled !== false));
  const climate = climateOps.length ? applyClimateOps(z.climate, climateOps) : z.climate;
  return {
    zoneId: z.id,
    climate,
    regimes: z.regimes,
    dailyModifiers: mods.filter((m) => (m.stage ?? "daily") === "daily"),
    automation: z.automation ?? [],
    profileHash: profileHash(z),
    issues,
  };
}

/** Build a running Generator for a zone: resolution + modifier engine wired into dailyModifiers. `worldModifiers` are appended (not hashed into the profile — the caller keys on them). */
export function createGenerator(z: ZoneProfile, seed: string, timeOf: (dayOrdinal: number) => DayTime, worldModifiers: readonly Modifier[] = []): { generator: Generator; resolved: ResolvedProfile; engine: ModifierEngine } {
  const resolved = resolveProfile(z);
  // world-level modifiers (the era timeline) run after the zone's own, so a zone can be overridden by its era
  const engine = new ModifierEngine({ seed, zoneId: z.id, modifiers: [...resolved.dailyModifiers, ...worldModifiers], timeOf });
  const cfg: GeneratorConfig = {
    seed,
    zoneId: z.id,
    climate: resolved.climate,
    regimes: resolved.regimes,
    timeOf,
    // automation ops run BEFORE the zone's daily modifiers (climate-stage semantics, D6).
    // With no lanes the callback is byte-for-byte the old one — absent automation changes nothing.
    dailyModifiers: (d, regime) => {
      const m = engine.forDay(d, regime);
      if (!resolved.automation.length) return m;
      // `timeOf` is typed DayTime; the plugin's adapters return a TimeContext that carries
      // dayOrdinal/yearLength, but bare callers (e.g. gregorianTime) supply neither — fall
      // back to the requested ordinal and a FALLBACK_YEAR_LENGTH-day year.
      const t = timeOf(d) as DayTime & { dayOrdinal?: number; yearLength?: number };
      const time = { ...t, dayOrdinal: t.dayOrdinal ?? d, yearLength: t.yearLength ?? FALLBACK_YEAR_LENGTH };
      const out: DailyModifierResult = { ops: [...automationOps(resolved.automation, time), ...m.ops], tags: m.tags, active: m.active };
      return out;
    },
  };
  return { generator: new Generator(cfg), resolved, engine };
}
