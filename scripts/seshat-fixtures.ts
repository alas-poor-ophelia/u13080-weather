/**
 * Writes test/fixtures/seshat/<calendar>.seshat: each P1 calendar printed by
 * Seshat's canonical printer (docs/SESHAT-v0.md §4.1). test/seshat-text.test.ts
 * holds print(ast) === file and parse(file) ≡ ast, so rewriting these is a
 * deliberate act: run it only when a calendar or the spelling changes, then
 * review the diff.
 *
 *   bun run scripts/seshat-fixtures.ts
 */
import { mkdirSync } from "node:fs";
import { SESHAT_FIXTURES } from "../test/fixtures/seshat/calendars";
import { print } from "../src/seshat";

const dir = new URL("../test/fixtures/seshat/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [file, ast] of Object.entries(SESHAT_FIXTURES)) {
  await Bun.write(new URL(file, dir), print(ast));
  console.log(`wrote test/fixtures/seshat/${file}`);
}
