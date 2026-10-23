/**
 * Validation surface: issues → units, windows, LEDs, Save state (PLAN.md §5.5,
 * SPEC.md §3.9).
 *
 * `issuesFor` runs the three core validators (`validateProfile` — which also
 * runs `validateAutomation` internally — plus `validateEras`) against the
 * studio's drafts, plus the studio-only rules the core validators cannot see
 * (seasons/moons are view-state-adjacent, not part of `ZoneProfile`). Every
 * `ValidationIssue.path` the core validators can emit is then routed to a
 * `UnitRef` (a mixer row / rack unit) and a `WindowRef` (a floating window)
 * so the studio always has somewhere to surface it — see
 * `test/fixtures/studio/validator-paths.json` for the full enumerated set
 * this routing is written against.
 *
 * Pure: no Obsidian imports (PLAN D3).
 */
import { validateEras } from "../../core/eras";
import { validateProfile, type ValidationIssue } from "../../core/profile";
import type { Era, ZoneProfile } from "../../core/types";
import type { CalendarAst } from "../../seshat";
import { channelOrNull } from "./compile";

/** climate.<section> → channel; unknown sections fall back to sky so an issue is never dropped. */
const channelOrNullSky = (param: string) => channelOrNull(param) ?? "sky";

export type UnitRef =
  | { kind: "regimes" } // fixed slot 00 in every chain
  | { kind: "device"; id: string } // a zone modifier (device or layer/forcings) by id
  | { kind: "forcings" } // forcings:* modifiers and automation lanes
  | { kind: "era"; name: string }
  | { kind: "channel"; channel: "temperature" | "precipitation" | "wind" | "sky" } // climate.* paths
  | { kind: "zone" } // id, flipSeasons, top-level
  | { kind: "seasons" }
  | { kind: "moon"; name: string }; // studio-only rules

export type WindowRef = "regimes" | "device" | "era" | "forcings" | "channel" | "seasons" | "cycle" | "atlas" | "none";

export interface StudioIssue {
  level: "error" | "warning";
  path: string;
  message: string;
  unit: UnitRef;
  win: WindowRef;
  index?: number;
}

export interface StudioIssuesInput {
  zone: ZoneProfile;
  eras: readonly Era[];
  seasons: ReadonlyArray<{ name: string; from: number }>;
  moons: ReadonlyArray<{ name: string; phases?: ReadonlyArray<{ name: string; at: number }> }>;
  readOnlyCalendar: boolean;
  /** a definition world's own tags (definitionTags): what a zone's `tag` predicates may name besides seasons, eras and moons */
  tags?: readonly string[];
}

/**
 * Every tag a calendar definition sets on its days (bead wadjet-io7): the
 * labels' tags on cycle units, slot tags, day labels' tags and named rules'
 * tags, in that order, each once. Empty with no definition (a legacy world,
 * an opaque or third-party calendar). Read defensively: a definition that
 * cannot run is still read for what it names.
 */
export function definitionTags(ast: CalendarAst | null | undefined): string[] {
  if (!ast) return [];
  const out = new Set<string>();
  const add = (tags: readonly string[] | undefined) => {
    if (Array.isArray(tags)) for (const t of tags) if (typeof t === "string" && t !== "") out.add(t);
  };
  for (const u of ast.units ?? []) {
    if (u.kind === "slots") for (const s of u.slots ?? []) add(s.tags);
    else for (const l of u.labels ?? []) add(l.tags);
  }
  for (const d of ast.days ?? []) add(d.tags);
  for (const r of ast.rules ?? []) add(r.tags);
  return [...out];
}

const MAX_SEASONS = 6;

/**
 * Routes one `ValidationIssue` (from `validateProfile` or `validateEras`) to
 * the unit/window that should show it.
 *
 * `modifiers[i]…` resolves `i` to the modifier's own id: `layer:*` and
 * `forcings:*` ids (compiled UI layers, PLAN §7a) route to their channel /
 * the Forcings strip rather than showing as a device row; anything else is a
 * plain device. `regimes*` → the fixed Regimes slot; `eras[i]…` → the era by
 * name; `automation[i]…` (and the bare `automation` array-shape error) →
 * Forcings; `climate.<section>…` → that section's channel window. `id`,
 * `flipSeasons`, the bare `climate`/`eras` array-shape errors, and anything
 * else unrecognised fall back to the zone itself (`flipSeasons` opens the
 * Atlas window; everything else has no window of its own).
 */
export function mapIssue(issue: ValidationIssue, zone: ZoneProfile, eras: readonly Era[]): StudioIssue {
  const { path, level, message } = issue;
  const base = { level, path, message };

  if (path === "id") return { ...base, unit: { kind: "zone" }, win: "none" };
  if (path === "flipSeasons") return { ...base, unit: { kind: "zone" }, win: "atlas" };
  if (path === "climate") return { ...base, unit: { kind: "zone" }, win: "none" };
  if (path.startsWith("climate.")) {
    const section = path.split(".")[1]!;
    return { ...base, unit: { kind: "channel", channel: channelOrNullSky(section) }, win: "channel" };
  }
  if (path.startsWith("regimes")) return { ...base, unit: { kind: "regimes" }, win: "regimes" };
  if (path.startsWith("automation")) return { ...base, unit: { kind: "forcings" }, win: "forcings" };

  const eraMatch = /^eras\[(\d+)\]/.exec(path);
  if (eraMatch) {
    const idx = Number(eraMatch[1]);
    const name = eras[idx]?.name || `#${idx}`;
    return { ...base, unit: { kind: "era", name }, win: "era" };
  }
  if (path === "eras") return { ...base, unit: { kind: "zone" }, win: "none" };

  const modMatch = /^modifiers\[(\d+)\]/.exec(path);
  if (modMatch) {
    const idx = Number(modMatch[1]);
    const m = zone.modifiers?.[idx];
    const id = m?.id || `#${idx}`;
    if (id.startsWith("layer:")) {
      const param = id.slice("layer:".length).split(":")[0]!;
      return { ...base, unit: { kind: "channel", channel: channelOrNullSky(param) }, win: "channel" };
    }
    if (id.startsWith("forcings:")) return { ...base, unit: { kind: "forcings" }, win: "forcings" };
    return { ...base, unit: { kind: "device", id }, win: "device" };
  }

  return { ...base, unit: { kind: "zone" }, win: "none" };
}

/**
 * Studio-only rules SPEC §3.9 calls for that the core validators cannot see,
 * because seasons and moons live outside `ZoneProfile` (they are world
 * calendar state, read from the active time adapter — PLAN §8 "Time-adapter
 * interface"). Predicate emptiness (tag/moon) and device apply-emptiness are
 * already covered by `validateProfile`'s predicate/op validation and are not
 * repeated here.
 *
 * Season rules only run when the calendar is internal (`!readOnlyCalendar`):
 * a plugin-owned calendar is not the studio's to validate or edit (SPEC §3.4
 * "source badge … `<plugin> · read-only`").
 */
export function studioRules(input: StudioIssuesInput): StudioIssue[] {
  const issues: StudioIssue[] = [];

  if (!input.readOnlyCalendar) {
    const { seasons } = input;
    // A world with no seasons is legal (the plugin ships that way); once seasons exist the window keeps 1–6.
    if (seasons.length > MAX_SEASONS) {
      issues.push({ level: "error", path: "seasons", message: `at most ${MAX_SEASONS} seasons (got ${seasons.length})`, unit: { kind: "seasons" }, win: "seasons" });
    }
    const names = new Set<string>();
    seasons.forEach((s, i) => {
      const where = `seasons[${i}].name`;
      if (!s.name || !s.name.trim()) {
        issues.push({ level: "error", path: where, message: "name is required", unit: { kind: "seasons" }, win: "seasons" });
      } else if (names.has(s.name)) {
        issues.push({ level: "error", path: where, message: `duplicate season name "${s.name}"`, unit: { kind: "seasons" }, win: "seasons" });
      } else {
        names.add(s.name);
      }
    });
  }

  for (const moon of input.moons) {
    if (!moon.phases) continue;
    const names = new Set<string>();
    let prevAt = -Infinity;
    moon.phases.forEach((p, i) => {
      const where = `moons.${moon.name}.phases[${i}]`;
      if (!p.name || !p.name.trim()) {
        issues.push({ level: "error", path: `${where}.name`, message: "name is required", unit: { kind: "moon", name: moon.name }, win: "cycle" });
      } else if (names.has(p.name)) {
        issues.push({ level: "error", path: `${where}.name`, message: `duplicate phase name "${p.name}"`, unit: { kind: "moon", name: moon.name }, win: "cycle" });
      } else {
        names.add(p.name);
      }
      if (!(p.at >= 0 && p.at < 1)) {
        issues.push({ level: "error", path: `${where}.at`, message: "must be in [0,1)", unit: { kind: "moon", name: moon.name }, win: "cycle" });
      } else if (p.at <= prevAt) {
        issues.push({ level: "error", path: `${where}.at`, message: "phase boundaries must be strictly ascending", unit: { kind: "moon", name: moon.name }, win: "cycle" });
      }
      if (Number.isFinite(p.at)) prevAt = p.at;
    });
  }

  return issues;
}

/**
 * A zone literal that looks like a calendar name but is spelled with other
 * Unicode code points: equal to it only after NFC normalization (an accented
 * letter typed as a letter plus a combining mark). Matching compares strings
 * exactly, so such a literal never matches, though it reads the same. Stored
 * zones are never rewritten (docs/SESHAT-v0.md §13.11, ruled 2026-10-19); the
 * warning names the spelling to use. Covered: season, era and moon names in
 * `tag` and `moon` predicates and in gate sources, and on a definition world
 * the definition's own tags (`input.tags`: unit labels, slots, day labels,
 * named rules; bead wadjet-io7).
 */
export function nfcIssues(input: StudioIssuesInput): StudioIssue[] {
  const names = new Map<string, string>(); // NFC form -> the calendar's own spelling
  const add = (n: string) => {
    if (n) names.set(n.normalize("NFC"), n);
  };
  for (const s of input.seasons) add(`season:${s.name}`);
  for (const e of input.eras) add(`era:${e.name}`);
  for (const m of input.moons) {
    add(m.name);
    add(`moon:${m.name}`);
  }
  for (const t of input.tags ?? []) add(t);
  const out: StudioIssue[] = [];
  const check = (literal: string, path: string) => {
    const want = names.get(literal.normalize("NFC"));
    if (want === undefined || want === literal) return;
    const issue = { level: "warning" as const, path, message: `"${literal}" reads like the calendar's "${want}" but is spelled with different Unicode characters, so it never matches. Retype it as the calendar writes it.` };
    out.push(mapIssue(issue, input.zone, input.eras));
  };
  // the draft can be anything the JSON drawer accepted (validateProfile reports the shape errors): read it defensively
  const walk = (p: unknown, path: string): void => {
    if (!p || typeof p !== "object") return;
    const q = p as { all?: unknown; any?: unknown; not?: unknown; tag?: unknown; moon?: { name?: unknown } | null };
    if (Array.isArray(q.all)) q.all.forEach((x, i) => walk(x, `${path}.all[${i}]`));
    if (Array.isArray(q.any)) q.any.forEach((x, i) => walk(x, `${path}.any[${i}]`));
    if ("not" in q) walk(q.not, `${path}.not`);
    if (typeof q.tag === "string") check(q.tag, `${path}.tag`);
    if (q.moon && typeof q.moon === "object" && typeof q.moon.name === "string") check(q.moon.name, `${path}.moon.name`);
  };
  const modifiers: unknown = input.zone.modifiers;
  if (!Array.isArray(modifiers)) return out;
  modifiers.forEach((m: unknown, i) => {
    if (!m || typeof m !== "object") return;
    const mod = m as { when?: unknown; mods?: unknown };
    walk(mod.when, `modifiers[${i}].when`);
    if (Array.isArray(mod.mods))
      mod.mods.forEach((g: unknown, j) => {
        const source = g && typeof g === "object" ? (g as { source?: unknown }).source : undefined;
        if (typeof source === "string") check(source, `modifiers[${i}].mods[${j}].source`);
      });
  });
  return out;
}

/** `validateProfile` (which also runs `validateAutomation`) + `validateEras` + `studioRules` + `nfcIssues`, mapped to units/windows, errors first then warnings, otherwise stable (input order). */
export function issuesFor(input: StudioIssuesInput): StudioIssue[] {
  const profileIssues = validateProfile(input.zone).map((i) => mapIssue(i, input.zone, input.eras));
  const eraIssues = validateEras(input.eras).map((i) => mapIssue(i, input.zone, input.eras));
  const all = [...profileIssues, ...eraIssues, ...studioRules(input), ...nfcIssues(input)];
  const rank = (level: StudioIssue["level"]) => (level === "error" ? 0 : 1);
  // Array#sort is a stable sort (ES2019+): equal-rank issues keep their relative order.
  return all.sort((a, b) => rank(a.level) - rank(b.level));
}

/** Group issues by unit, in the order they arrive — use after `issuesFor` so each bucket is errors-first too. */
export function issuesByUnit(issues: readonly StudioIssue[]): Map<string, StudioIssue[]> {
  const byUnit = new Map<string, StudioIssue[]>();
  for (const issue of issues) {
    const key = unitKey(issue.unit);
    const bucket = byUnit.get(key);
    if (bucket) bucket.push(issue);
    else byUnit.set(key, [issue]);
  }
  return byUnit;
}

export function unitKey(u: UnitRef): string {
  switch (u.kind) {
    case "regimes":
      return "regimes";
    case "device":
      return `device:${u.id}`;
    case "forcings":
      return "forcings";
    case "era":
      return `era:${u.name}`;
    case "channel":
      return `channel:${u.channel}`;
    case "zone":
      return "zone";
    case "seasons":
      return "seasons";
    case "moon":
      return `moon:${u.name}`;
  }
}

/** The LED colour for a unit: red if any error, amber if any warning (no errors), else clean. */
export function ledLevel(issues: readonly StudioIssue[] | undefined): "ok" | "warn" | "error" {
  if (!issues || issues.length === 0) return "ok";
  if (issues.some((i) => i.level === "error")) return "error";
  if (issues.some((i) => i.level === "warning")) return "warn";
  return "ok";
}

/** The Save button's label and whether it blocks the save. Errors block; warnings don't; "Saved ✓" (clean + not dirty) is the caller's own case, not this function's. */
export function saveLabel(issues: readonly StudioIssue[]): { text: string; blocked: boolean } {
  const errors = issues.filter((i) => i.level === "error").length;
  if (errors > 0) return { text: `Save · ${errors} ${errors === 1 ? "issue" : "issues"}`, blocked: true };
  const warnings = issues.filter((i) => i.level === "warning").length;
  if (warnings > 0) return { text: `Save ● · ${warnings} ⚠`, blocked: false };
  return { text: "Save ●", blocked: false };
}
