/**
 * The Save dialog's choices, as pure functions (docs/SESHAT-v0.md §15.1 R6,
 * R7): the definition a change stores, with day numbers kept or today
 * anchored to a date, and whether the world has the spell modifiers that make
 * a change in the year holding day 0 reach every day.
 */
import type { ZoneProfile } from "../core/types";
import { anchorToday, todayText } from "./opt-in";
import { prepareDefinition } from "./time/seshat";
import { print } from "../seshat";

export interface ChangePlan {
  /** the canonical text to store */
  readonly text: string;
  /** days the calendar moved to anchor today (0: day numbers kept) */
  readonly shift: number;
  /** how today reads in the stored calendar; null when it cannot */
  readonly today: string | null;
}

const errorOf = (r: { error: string; line?: number }) => (r.line === undefined ? r.error : `Line ${r.line}: ${r.error}`);

/**
 * The definition a change stores. `anchor` absent: day numbers are kept;
 * present: the calendar moves so `today` reads as that date.
 */
export function planChange(after: string, today: number, anchor?: string): ChangePlan | { error: string } {
  const prepared = prepareDefinition(after);
  if ("error" in prepared) return { error: errorOf(prepared) };
  if (anchor === undefined) return { text: prepared.text, shift: 0, today: todayText(prepared.text, today) };
  const a = anchorToday(prepared.ast, today, anchor);
  if ("error" in a) return a;
  const moved = prepareDefinition(print(a.ast));
  if ("error" in moved) return { error: errorOf(moved) };
  return { text: moved.text, shift: a.shift, today: todayText(moved.text, today) };
}

/** Whether any zone has a spell modifier: spells are tuned on the year holding day 0 (core/modifiers.ts). */
export function worldHasSpells(zones: readonly ZoneProfile[]): boolean {
  return zones.some((z) => (z.modifiers ?? []).some((m) => m.spell !== undefined && m.enabled !== false));
}

/**
 * What a calendar change does to the world's year-keyed data (wadjet-91c): eras and automation lane points are
 * stored as the calendar's own year numbers, so after a change they count in the new calendar's years and can
 * cover other days, whichever day-number choice is made. Null when the world has none.
 */
export function yearKeyedNote(eras: readonly { readonly name: string }[], zones: readonly { readonly automation?: readonly unknown[] }[]): string | null {
  const lanes = zones.reduce((n, z) => n + (z.automation?.length ?? 0), 0);
  const parts = [
    ...(eras.length ? [`${eras.length} ${eras.length === 1 ? "era" : "eras"}`] : []),
    ...(lanes ? [`${lanes} automation ${lanes === 1 ? "lane" : "lanes"}`] : []),
  ];
  if (!parts.length) return null;
  const they = eras.length + lanes === 1 ? "It is" : "They are";
  return `This world's ${parts.join(" and ")} ${eras.length + lanes === 1 ? "is" : "are"} placed by year number. ${they} kept as ${eras.length + lanes === 1 ? "a number" : "numbers"}, so after this change ${eras.length + lanes === 1 ? "it counts" : "they count"} in the new calendar's years and can fall on other days; check ${eras.length + lanes === 1 ? "it" : "them"} in the Studio.`;
}
