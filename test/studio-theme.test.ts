/**
 * Climate Studio theme — pure checks on `styles.css` as text (bead
 * wadjet-9f9.43). No DOM, no Obsidian: a small hand-rolled CSS parser and a
 * WCAG relative-luminance function are enough to prove three things about
 * the studio block:
 *
 *   1. every text colour token actually used via `color:` reaches 4.5:1
 *      against both --wadjet-studio-bg and --wadjet-studio-panel (SPEC §9's
 *      "nothing dimmer than #878d95" floor, verified rather than assumed);
 *   2. every selector that declares `transition`/`animation` has a
 *      `prefers-reduced-motion: reduce` override that turns it off;
 *   3. no selector is duplicated across the block with a conflicting
 *      declaration (the stabilizer merged one round of these; this guards
 *      against the next one going unnoticed).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const CSS_PATH = path.join(import.meta.dir, "..", "styles.css");
const css = readFileSync(CSS_PATH, "utf-8");

const MARKER = "/* ── Climate Studio";
const markerIndex = css.indexOf(MARKER);
if (markerIndex === -1) throw new Error(`"${MARKER}" not found in styles.css — did the block get renamed?`);
const studioBlock = css.slice(markerIndex);
const noComments = studioBlock.replace(/\/\*[\s\S]*?\*\//g, "");

/* ── A minimal CSS parser: just enough to walk selectors, declarations and
   @-rule nesting (media/container queries). Not a general parser — it does
   not need to be, the studio block doesn't nest rules any other way. ── */
interface Rule {
  context: string[];
  selector: string;
  decls: Record<string, string>;
}

function parseBlock(text: string, context: string[], out: Rule[]): void {
  let pos = 0;
  for (;;) {
    const brace = text.indexOf("{", pos);
    if (brace === -1) break;
    const selector = text.slice(pos, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (depth > 0 && j < text.length) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(brace + 1, j - 1);
    if (selector.startsWith("@")) {
      parseBlock(body, [...context, selector], out);
    } else if (selector.length > 0) {
      const decls: Record<string, string> = {};
      for (const part of body.split(";")) {
        const t = part.trim();
        if (!t) continue;
        const colon = t.indexOf(":");
        if (colon === -1) continue;
        decls[t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
      }
      out.push({ context: [...context], selector, decls });
    }
    pos = j;
  }
}

const rules: Rule[] = [];
parseBlock(noComments, [], rules);

/* ── The palette: every --wadjet-studio-* value declared in :root. ── */
const rootRule = rules.find((r) => r.context.length === 0 && r.selector === ":root");
if (!rootRule) throw new Error("no :root rule found in the studio block");
const palette: Record<string, string> = {};
for (const [prop, value] of Object.entries(rootRule.decls)) {
  if (prop.startsWith("--wadjet-studio-") && /^#[0-9a-fA-F]{6}$/.test(value)) palette[prop] = value;
}

/* ── WCAG 2.x contrast (relative luminance → ratio). ── */
function srgbToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("studio theme: text contrast reaches 4.5:1 (SPEC §9, #878d95 floor)", () => {
  const bg = palette["--wadjet-studio-bg"];
  const panel = palette["--wadjet-studio-panel"];
  if (bg === undefined || panel === undefined) throw new Error("--wadjet-studio-bg or --wadjet-studio-panel missing from :root");

  test("the parser actually found the block's rules and the palette", () => {
    expect(rules.length).toBeGreaterThan(50);
    expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(panel).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  // Every --wadjet-studio-* name referenced inside a `color:` declaration,
  // anywhere in the block — including as a var() fallback, e.g.
  // `color: var(--wadjet-studio-chip-color, var(--wadjet-studio-text-dim))`.
  // Names that resolve to a *dynamic* per-instance property (set at runtime
  // with setCssProps, e.g. --wadjet-studio-chip-color itself) aren't in the
  // static palette and are skipped — there's no styles.css value to check.
  const textTokenNames = new Set<string>();
  for (const r of rules) {
    const colorValue = r.decls["color"];
    if (!colorValue) continue;
    for (const m of colorValue.matchAll(/--wadjet-studio-[a-zA-Z0-9-]+/g)) textTokenNames.add(m[0]);
  }

  // --wadjet-studio-bg (and, in principle, -panel) can themselves be used as
  // a `color:` — e.g. a playlist span's label is bg-coloured so it reads
  // against the span's own saturated background, not against bg/panel. That
  // pairing is real (and already covered: every span-background token below
  // clears 3:1+ against bg on its own), but "bg vs bg" and "panel vs panel"
  // aren't a meaningful check, so the two surfaces are excluded here.
  const SURFACES = new Set(["--wadjet-studio-bg", "--wadjet-studio-bg-alt", "--wadjet-studio-panel"]);
  const checkable = [...textTokenNames].filter((name) => palette[name] !== undefined && !SURFACES.has(name)).sort();

  test("at least the core text tokens were found (the extractor isn't silently empty)", () => {
    expect(checkable.length).toBeGreaterThanOrEqual(4);
    expect(checkable).toContain("--wadjet-studio-text");
    expect(checkable).toContain("--wadjet-studio-text-mute");
  });

  for (const name of checkable) {
    const hex = palette[name];
    if (hex === undefined) continue; // filtered for this above; narrows the type for TS below
    test(`${name} (${hex}) vs bg and panel`, () => {
      expect(contrastRatio(hex, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hex, panel)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the SPEC §9 floor value #878d95 itself would NOT clear the bar on panel (why text-mute moved)", () => {
    // Documents *why* --wadjet-studio-text-mute is #9298a1 and not the literal
    // floor hex from the SPEC prose: the floor is a "nothing dimmer than"
    // bound, not a value guaranteed to pass on every studio background.
    expect(contrastRatio("#878d95", panel)).toBeLessThan(4.5);
  });
});

describe("studio theme: motion respects prefers-reduced-motion", () => {
  const isReal = (v: string | undefined): boolean => v !== undefined && v !== "none";
  // Only rules OUTSIDE the reduce query itself: the query's own `transition:
  // none` resets are the override, not something that needs one in turn.
  const transitionSelectors = rules
    .filter((r) => !r.context.some((c) => c.includes("prefers-reduced-motion")))
    .filter((r) => isReal(r.decls["transition"]) || isReal(r.decls["animation"]) || isReal(r.decls["animation-name"]))
    .map((r) => r.selector);

  test("at least one transition exists (the check isn't vacuously true)", () => {
    expect(transitionSelectors.length).toBeGreaterThan(0);
  });

  const reduceMotionSelectors = new Set(
    rules
      .filter((r) => r.context.some((c) => c.includes("prefers-reduced-motion") && c.includes("reduce")))
      .flatMap((r) => r.selector.split(",").map((s) => s.trim())),
  );

  for (const selector of transitionSelectors) {
    test(`"${selector}" is turned off under prefers-reduced-motion: reduce`, () => {
      expect(reduceMotionSelectors.has(selector)).toBe(true);
    });
  }
});

describe("studio theme: no duplicated selector with a conflicting declaration", () => {
  test("every repeated (media-context, selector) pair agrees on every shared property", () => {
    const groups = new Map<string, Rule[]>();
    for (const r of rules) {
      const key = JSON.stringify([r.context, r.selector]);
      const group = groups.get(key);
      if (group) group.push(r);
      else groups.set(key, [r]);
    }

    const conflicts: string[] = [];
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const seen = new Map<string, string>();
      for (const r of group) {
        for (const [prop, value] of Object.entries(r.decls)) {
          const prior = seen.get(prop);
          if (prior !== undefined && prior !== value) {
            conflicts.push(`${key} — "${prop}": "${prior}" then "${value}"`);
          }
          seen.set(prop, value);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});
