/**
 * wadjet-9f9.41 — Studio · units audit.
 *
 * Every temperature/amount/speed readout in `src/studio/ui/**` must go
 * through `model/format.ts`'s `format()` (SPEC §8; PLAN §4), which routes
 * metric → the reader's `settings.units` and returns the unit suffix as
 * text, never a literal hardcoded string. `src/studio/ui/**` imports
 * `obsidian`, which is typings-only under `bun test` (see
 * `studio-hints.test.ts`), so this is a source scan rather than a render
 * test — the same technique that file uses.
 *
 * The banned literals are the unit suffixes that actually change shape
 * between metric and imperial (`format.ts`'s `toDisplay`/`fromDisplay`):
 * `°C`, `°F`, `km/h`, `mph`, and a bare `mm` (amount). Everything else
 * (`°` alone, `d`, `y`, `%`, `×`) is either unit-invariant or already
 * covered by `format.ts`'s own `unitLabel`, so it is not scanned for.
 *
 * Comments are stripped before scanning: this file's job is catching a
 * literal unit string that reaches the DOM, not policing prose in a
 * docstring that explains a metric constant (`± 8 °C`, `SPEC §5.2`, …) —
 * of which `src/studio/ui/**` has many, all legitimate. Anything that
 * still matches after stripping is either a real bug or belongs on
 * `ALLOWLIST` below, with a comment saying why it is unit-agnostic.
 */
import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const ROOT = new URL("../src/studio/ui/", import.meta.url);

/** Every `.ts` file under `src/studio/ui/**`, recursively, relative to `ROOT`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(`${rel}/`));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** Block comments and line comments removed — a best-effort strip, not a real parser (see file docstring). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const BANNED: Array<{ name: string; pattern: RegExp }> = [
  { name: "°C", pattern: /°C/ },
  { name: "°F", pattern: /°F/ },
  { name: "km/h", pattern: /km\/h/ },
  { name: "mph", pattern: /\bmph\b/ },
  { name: "mm (bare)", pattern: /\bmm\b/ },
];

/**
 * Files (or exact lines) known to carry one of the banned strings outside a
 * comment, and why that is fine — a genuinely unit-agnostic label rather
 * than a hardcoded readout. Empty today: the audit found none (every
 * remaining hit before this bead's fixes was a doc comment, which
 * `stripComments` already removes). Add an entry here, with a reason, the
 * day a real one turns up rather than loosening `BANNED` above.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; line: string }> = [];

function isAllowed(file: string, line: string): boolean {
  return ALLOWLIST.some((a) => a.file === file && line.includes(a.line));
}

describe("studio units audit: no hardcoded unit literals in src/studio/ui/**", () => {
  const files = walk("");

  test("the scan itself finds files (a regression in `walk` would make every other assertion vacuous)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("day-card.ts");
    expect(files).toContain("windows/forcings.ts");
  });

  for (const file of files) {
    test(`${file} carries no literal °C / °F / km/h / mph / mm outside a comment or the allowlist`, async () => {
      const src = await Bun.file(new URL(file, ROOT)).text();
      const stripped = stripComments(src);
      const offenders: string[] = [];
      stripped.split("\n").forEach((line, i) => {
        for (const { name, pattern } of BANNED) {
          if (pattern.test(line) && !isAllowed(file, line)) offenders.push(`${file}:${i + 1} (${name}): ${line.trim()}`);
        }
      });
      expect(offenders).toEqual([]);
    });
  }
});

describe("studio units audit: the tabular-numerals utility exists", () => {
  test("styles.css defines .wadjet-studio-num (and the chip label carries it too, for chip-borne readouts)", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    expect(css).toMatch(/\.wadjet-studio-num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
    expect(css).toMatch(/\.wadjet-studio-chip-label\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  });
});

describe("studio units audit: era/device/regime op knobs know which params are unit-bearing", () => {
  // `model/knob-units.ts` is pure and importable directly (no `obsidian`
  // import), unlike the windows that call it.
  test("temperature/speed/amount params convert; everything else passes through", async () => {
    const { opQuantity } = await import("../src/studio/model/knob-units");
    expect(opQuantity("temperature.mean", true)).toBe("temperatureDelta");
    expect(opQuantity("temperature.mean", false)).toBe("temperature");
    expect(opQuantity("wind.speed", false)).toBe("speed");
    expect(opQuantity("precipitation.scale", false)).toBe("amount");
    // Unit-invariant shapes: no format.ts quantity, the op's own fmt stands.
    expect(opQuantity("wind.direction", true)).toBeNull();
    expect(opQuantity("precipitation.pww", false)).toBeNull();
    expect(opQuantity("temperature.phase", false)).toBeNull();
  });

  test("parseDisplay converts a typed display-unit value back to metric, clamped to the spec's own range", async () => {
    const { parseDisplay } = await import("../src/studio/model/knob-units");
    // A ±8 °C spec (Forcings TRIM_SPEC) — typed "9" °F is a *delta*: 9 × 5/9 = 5 °C, inside range.
    const parse = parseDisplay({ min: -8, max: 8, step: 0.1, neutral: 0 }, "temperatureDelta", "imperial");
    expect(parse("9")).toBeCloseTo(5, 9);
    // Out-of-range typed text clamps in the *display* domain, not the raw metric one.
    expect(parse("1000")).toBeCloseTo(8, 9);
    // metric is always the identity — no display conversion to invert.
    const metricParse = parseDisplay({ min: -8, max: 8, step: 0.1, neutral: 0 }, "temperatureDelta", "metric");
    expect(metricParse("5")).toBe(5);
  });
});
