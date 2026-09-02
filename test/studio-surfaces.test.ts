/**
 * wadjet-9f9.45 — `view.ts`'s `SURFACES` list, and the one registrar per
 * floating-window id.
 *
 * The defect this pins: `header.ts` used to register a *placeholder* builder
 * under `atlas` ("Atlas — coming in a later bead") and `atlas-surface.ts`
 * registered the real one. Both wrote to the same id, and the only thing that
 * decided which survived was mount order — the header happens to come first in
 * `SURFACES`, so the real builder happened to win. Reorder that list, or drop
 * `createAtlasSurface` from it, and the header's SRC chip opens an empty panel
 * with no test to say so.
 *
 * The placeholder is gone. What is left to protect is the invariant it hid:
 * **every window id has exactly one registrar, and the surface that owns it is
 * actually mounted.** `src/studio/ui/**` imports `obsidian`, which is
 * typings-only under `bun test`, so this is a source scan — the same technique
 * `studio-hints.test.ts` and `studio-units-audit.test.ts` use.
 */
import { readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const UI = new URL("../src/studio/ui/", import.meta.url);

const view = await Bun.file(new URL("view.ts", UI)).text();

/** Every `.ts` file under `src/studio/ui/**`, relative to that directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, UI), { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(`${rel}/`));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** The factory names listed in `view.ts`'s `SURFACES`, in mount order. */
function surfaceList(): string[] {
  const m = /const SURFACES: ReadonlyArray<\(\) => Surface> = \[([\s\S]*?)\];/.exec(view);
  if (m === null) throw new Error("SURFACES not found in src/studio/ui/view.ts — has it been renamed or retyped?");
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every name `view.ts` imports from a `./x` module, mapped to that module. */
function viewImports(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of view.matchAll(/import \{([^}]+)\} from "\.\/([\w./-]+)";/g)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (name.length > 0) out.set(name, m[2]!);
    }
  }
  return out;
}

describe("view.ts · SURFACES", () => {
  const surfaces = surfaceList();

  test("the scan itself finds a plausible list (a regex regression would make everything below vacuous)", () => {
    expect(surfaces.length).toBeGreaterThanOrEqual(10);
    for (const name of surfaces) expect(name).toMatch(/^create\w+Surface$/);
  });

  test("lists the atlas surface, so the header's SRC chip can never open an empty panel", () => {
    expect(surfaces).toContain("createAtlasSurface");
    expect(viewImports().get("createAtlasSurface")).toBe("atlas-surface");
  });

  test("the header mounts first and the hint bar second (the order `view.ts` documents)", () => {
    expect(surfaces[0]).toBe("createHeaderSurface");
    expect(surfaces[1]).toBe("createHintBarSurface");
  });

  test("no surface is listed twice, and every one is imported", () => {
    expect(new Set(surfaces).size).toBe(surfaces.length);
    const imports = viewImports();
    for (const name of surfaces) expect(imports.has(name)).toBe(true);
  });
});

describe("floating windows · one registrar per id", () => {
  const files = walk("");

  test("only the atlas surface registers the Atlas panel", () => {
    expect(files).toContain("atlas-surface.ts");
    expect(files).toContain("header.ts");
  });

  test("`windows.register(ATLAS_WINDOW, …)` appears exactly once in src/studio/ui/**", async () => {
    const hits: string[] = [];
    for (const file of files) {
      const src = await Bun.file(new URL(file, UI)).text();
      if (/windows\.register\(\s*ATLAS_WINDOW/.test(src)) hits.push(file);
    }
    expect(hits).toEqual(["atlas-surface.ts"]);
  });

  test("header.ts opens the Atlas by the window module's own id and never registers a body for it", async () => {
    const header = await Bun.file(new URL("header.ts", UI)).text();
    expect(header).toContain('import { ATLAS_WINDOW } from "./windows/atlas";');
    expect(header).toContain("windows.open(ATLAS_WINDOW)");
    expect(header).not.toContain("windows.register(");
    // The placeholder body itself, so the exact regression cannot come back.
    expect(header).not.toContain("wadjet-studio-window-placeholder");
    expect(header).not.toContain("coming in a later bead");
  });
});
