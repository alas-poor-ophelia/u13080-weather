/**
 * The Date display setting (bead wadjet-01k.18): which of a calendar
 * definition's formats Wadjet uses for READ-only date readouts (codeblock
 * labels, command notices and inserted lines, the settings Current day line,
 * the Pinned days list). Typed dates, the Studio header range, stored data and
 * the public `api.format` keep the default format. Pure: no Obsidian imports.
 *
 * The stored value (`calendar.display`) is a format name; absent means the
 * default. A name the definition no longer declares reads as the default,
 * silently. The "filler" format is not a choice: it is part of how the default
 * writes a filler day.
 */
import type { CalendarAst } from "../seshat/ast";

export interface DisplayChoice {
  /** the format's name (the default's own name for the default: an empty value is not a choice Obsidian's dropdown keeps) */
  value: string;
  label: string;
}

/** The name of the format the definition writes by default ("default", else the first), or undefined without formats. */
export function defaultFormatName(ast: CalendarAst): string | undefined {
  const formats = ast.formats ?? [];
  return formats.some((f) => f.name === "default") ? "default" : formats[0]?.name;
}

/** The formats a world can display dates in: the default first, then the others in definition order. */
export function displayChoices(ast: CalendarAst): DisplayChoice[] {
  const def = defaultFormatName(ast);
  if (def === undefined) return [];
  const others = (ast.formats ?? []).map((f) => f.name).filter((n) => n !== def && n !== "filler");
  return [{ value: def, label: def === "default" ? "default" : `${def} (default)` }, ...[...new Set(others)].map((n) => ({ value: n, label: n }))];
}

/** The settings row is shown only on a definition whose formats give more than one choice. */
export function showDisplayRow(ast: CalendarAst | null): boolean {
  return ast !== null && displayChoices(ast).length > 1;
}

/**
 * The format a readout uses: undefined for the default, else a non-default
 * format the definition declares. `override` (a codeblock's `format:`) wins
 * when the definition declares it (the default's name, or "default", picks the
 * default); an unknown override falls back to `setting`; an unknown setting
 * falls back to the default.
 */
export function displayFormat(ast: CalendarAst, setting: string | undefined, override?: string): string | undefined {
  const def = defaultFormatName(ast);
  const extra = new Set(displayChoices(ast).flatMap((c) => (c.value !== def ? [c.value] : [])));
  if (override !== undefined) {
    if (override === "default" || override === def) return undefined;
    if (extra.has(override)) return override;
  }
  return setting !== undefined && extra.has(setting) ? setting : undefined;
}

/** The value the settings dropdown shows: the stored name when it is still a choice, else the default's name. */
export function displayControlValue(ast: CalendarAst | null, setting: string | undefined): string {
  return ast ? (displayFormat(ast, setting) ?? defaultFormatName(ast) ?? "") : "";
}

/** What the dropdown's choice stores: undefined (no field) for the default, else the name. */
export function displaySetting(ast: CalendarAst | null, chosen: string): string | undefined {
  return ast && chosen && displayFormat(ast, undefined, chosen) !== undefined ? chosen : undefined;
}

/** Render with the named format; the default when there is none or when rendering throws. */
export function displayWith(name: string | undefined, named: (name: string) => string, fallback: () => string): string {
  if (name === undefined) return fallback();
  try {
    return named(name);
  } catch {
    return fallback();
  }
}
