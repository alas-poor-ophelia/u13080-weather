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
 *   - named rules' `id`s (nothing references a rule by id) and display
 *     `name`s (only a format's `{@name}` prints them, §16.4);
 *   - a moon's `phases` (phase names are display, as on the legacy calendar).
 * Kept although they look like labels: slot and label `name`s (a recurrence
 * filter matches by name, BYLABEL), moon names (predicates match moons by
 * name), season names (they are the season tags).
 *
 * Added: `seasonTags: true` when the calendar has seasons and a rule reads a
 * `season:<name>` tag that no label, slot or day sets. Such a rule matches the
 * day's resolved season (§16.7 P6), where before it validated and always read
 * false: the flag gives those definitions a new hash (weather caches refresh),
 * and every other definition hashes exactly as before.
 */
import type { CalendarAst } from "./ast";
import { resolve } from "./resolve";

/**
 * The hashed view of a definition: a plain JSON value, deterministic for a
 * given AST. It hashes the resolved AST (§16.7 P4): a body reference and a
 * start mode hash as the numbers they resolve to, so equal behaviour hashes
 * equal. A crossing that cannot resolve hashes as stored (its world faults).
 */
export function definitionContent(stored: CalendarAst): unknown {
  const ast = resolve(stored);
  return prune({
    ...ast,
    name: undefined,
    formats: undefined,
    units: ast.units.map((u) => (u.id === "year" ? u : { ...u, number: undefined })),
    rules: ast.rules?.map((r) => ({ ...r, id: undefined, name: undefined })),
    bodies: ast.bodies?.map((b) => (b.moon ? { ...b, moon: { ...b.moon, phases: undefined } } : b)),
    seasonTags: readsSeasonTags(ast) ? true : undefined,
  });
}

/** Whether some rule reads a `season:` tag that no unit label, slot or day sets (it reads the resolved season). */
function readsSeasonTags(ast: CalendarAst): boolean {
  if (!ast.seasons || !ast.rules?.length) return false;
  const own = new Set([...ast.units.flatMap((u) => (u.kind === "cycle" ? (u.labels ?? []) : u.slots)).flatMap((l) => l.tags ?? []), ...(ast.days ?? []).flatMap((d) => d.tags ?? [])]);
  const walk = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.some(walk);
    if (typeof x !== "object" || x === null) return false;
    const o = x as Record<string, unknown>;
    if (o.kind === "tag" && typeof o.tag === "string" && o.tag.startsWith("season:") && !own.has(o.tag)) return true;
    return Object.values(o).some(walk);
  };
  return walk(ast.rules.map((r) => r.rule));
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
