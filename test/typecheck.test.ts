/**
 * The type contract inside `bun test`: the project typecheck (which compiles
 * test/types/conformance.ts, the identity check between types/wadjet.d.ts and
 * the source) and the declaration file on its own with skipLibCheck off
 * (types/tsconfig.json), so an undefined name in it can't hide. Both are the
 * repo's own tsc, run under bun so the same command works on every platform.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tscJs = join(root, "node_modules", "typescript", "bin", "tsc");

function tsc(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync([process.execPath, tscJs, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("typecheck", () => {
  test("tsc --noEmit -p tsconfig.json (includes test/types/conformance.ts)", () => {
    const r = tsc("--noEmit", "-p", "tsconfig.json");
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "" });
  }, 60_000);

  test("types/wadjet.d.ts compiles on its own with skipLibCheck off", () => {
    const r = tsc("-p", "types/tsconfig.json");
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "" });
  }, 60_000);

  test("every name types/wadjet.d.ts exports is in the conformance list", async () => {
    const dts = await Bun.file(new URL("../types/wadjet.d.ts", import.meta.url)).text();
    const conformance = await Bun.file(new URL("./types/conformance.ts", import.meta.url)).text();
    const exported = [...dts.matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1]!);
    expect(exported.length).toBeGreaterThan(20);
    const missing = exported.filter((name) => !new RegExp(`\\bD\\.${name}\\b`).test(conformance));
    expect(missing).toEqual([]);
  });
});
