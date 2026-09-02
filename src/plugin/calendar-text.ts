/**
 * Pure parse/serialise/validate helpers for the settings-tab Moons textarea.
 * Kept out of settings-tab.ts (which imports "obsidian") so they can be unit
 * tested directly.
 */
import type { MoonConfig } from "./settings";

/** "name@at" phase token → a phase, or null if malformed. */
function parsePhaseToken(tok: string): { name: string; at: number } | null {
  const i = tok.lastIndexOf("@");
  if (i <= 0) return null;
  const name = tok.slice(0, i).trim();
  const at = Number(tok.slice(i + 1).trim());
  if (!name || !Number.isFinite(at)) return null;
  return { name, at };
}

/**
 * Moons textarea: one moon per line, "name, cycle in days, phase at day 0
 * [, phase name@fraction ...]". Phase tokens are display metadata
 * (MoonConfig.phases, PLAN §2.2); malformed tokens are dropped.
 */
export function parseMoonsText(text: string): MoonConfig[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(",").map((x) => x.trim()))
    .filter((p) => p.length >= 2 && p[0])
    .map((p) => {
      const phases = p
        .slice(3)
        .map(parsePhaseToken)
        .filter((x): x is { name: string; at: number } => x !== null);
      const m: MoonConfig = { name: p[0]!, cycleDays: Number(p[1]) || 29.53, phaseAtEpoch: Number(p[2]) || 0 };
      if (phases.length) m.phases = phases;
      return m;
    });
}

/** Inverse of parseMoonsText: one line per moon, phases appended as name@fraction tokens. */
export function serialiseMoonsText(moons: MoonConfig[]): string {
  return moons
    .map((m) => {
      const base = `${m.name}, ${m.cycleDays}, ${m.phaseAtEpoch}`;
      return m.phases?.length ? `${base}, ${m.phases.map((p) => `${p.name}@${p.at}`).join(", ")}` : base;
    })
    .join("\n");
}

/** Validation for the Moons textarea: the first bad line, or nothing. Checks the base fields and any phase tokens (ascending, [0,1), unique names). */
export function badMoonsLine(text: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const p = raw.split(",").map((x) => x.trim());
    if (!p[0] || p.length < 3 || [p[1], p[2]].some((x) => !Number.isFinite(Number(x)) || x === "")) {
      return `Can't read "${raw.trim()}" — expected a name, cycle in days, and phase at day 0, separated by commas.`;
    }
    let prevAt = -Infinity;
    const seen = new Set<string>();
    for (const tok of p.slice(3)) {
      const phase = parsePhaseToken(tok);
      if (!phase) return `Can't read phase "${tok}" in "${raw.trim()}" — expected name@fraction, e.g. "Full@0.5".`;
      if (phase.at < 0 || phase.at >= 1) return `Phase "${phase.name}" in "${raw.trim()}" must be a fraction of the cycle, 0 up to (not including) 1.`;
      if (phase.at <= prevAt) return `Phase "${phase.name}" in "${raw.trim()}" must come after the previous phase — phases must be listed in ascending order.`;
      if (seen.has(phase.name)) return `Two phases are both named "${phase.name}" in "${raw.trim()}" — phase names must be unique.`;
      seen.add(phase.name);
      prevAt = phase.at;
    }
  }
  return undefined;
}
