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
