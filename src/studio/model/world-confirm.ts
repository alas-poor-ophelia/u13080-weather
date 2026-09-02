/**
 * Session-scoped "first world edit confirms" flag (SPEC §2 "the first world
 * edit per session should confirm"; PLAN §7 "one Notice-with-buttons (Modal)
 * — one per session").
 *
 * World-scoped state (seasons, moons, eras, …) touches every zone at once.
 * The first time any studio window is about to write one in a session, the
 * caller shows a confirm modal; this module is just the flag that decides
 * whether to ask, so every world-editing window shares one "asked already"
 * state without owning a copy of it.
 *
 * Module-level, not persisted anywhere: a fresh plugin load — a fresh
 * session — always asks again. Pure: no Obsidian imports (PLAN D3).
 */
let confirmed = false;

/** True until the Guildmaster has confirmed a world edit this session. */
export function needsWorldConfirm(): boolean {
  return !confirmed;
}

/** Call once the Guildmaster picks Continue on the confirm modal. */
export function markWorldConfirmed(): void {
  confirmed = true;
}

/** Test-only: put the flag back to "ask again" — mirrors a fresh session. */
export function resetWorldConfirm(): void {
  confirmed = false;
}
