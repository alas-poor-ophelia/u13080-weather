/**
 * What a definition's hash covers (docs/SESHAT-v0.md §13.6, §13.11 B1): the
 * AST with the fields that cannot reach a day, a tag, a year number, a moon or
 * a match removed, and empty optional lists dropped. The plugin hashes this
 * with its own hash (Seshat imports nothing outside src/seshat).
 *
 * Removed, each because nothing that reaches weather reads it:
 *   - the calendar's `name`;
 *   - `formats` (they change `format()`, not a day; the adapter announces a
 *     text change that leaves the hash alone, §13.11 M1);
 *   - `number` on every unit but `year` (only the year's number reaches
 *     `TimeContext.year`, which eras attach by);
 *   - named rules' `id`s (nothing references a rule by id);
 *   - a moon's `phases` (phase names are display, as on the legacy calendar).
 * Kept although they look like labels: slot and label `name`s (a recurrence
 * filter matches by name, BYLABEL), moon names (predicates match moons by
 * name), season names (they are the season tags).
 */
import type { CalendarAst } from "./ast";

/** The hashed view of a definition: a plain JSON value, deterministic for a given AST. */
export function definitionContent(ast: CalendarAst): unknown {
  return prune({
    ...ast,
    name: undefined,
    formats: undefined,
    units: ast.units.map((u) => (u.id === "year" ? u : { ...u, number: undefined })),
    rules: ast.rules?.map((r) => ({ ...r, id: undefined })),
    bodies: ast.bodies?.map((b) => (b.moon ? { ...b, moon: { ...b.moon, phases: undefined } } : b)),
  });
}

/**
 * Optional lists where absent and [] mean the same to every reader (no tags, no
 * gear terms, no ledger…). Required lists are never dropped: an empty residue
 * set or an empty `all` is a statement, not an absence.
 */
const OPTIONAL_LISTS = new Set(["ledger", "gears", "stages", "tags", "days", "rules", "bodies", "path", "by", "phases"]);

/** Drop undefined fields and empty optional lists, recursively; -0 is 0. */
function prune(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(prune);
  if (typeof x !== "object" || x === null) return Object.is(x, -0) ? 0 : x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === undefined || (OPTIONAL_LISTS.has(k) && Array.isArray(v) && v.length === 0)) continue;
    out[k] = prune(v);
  }
  return out;
}
