/**
 * Code blocks repaint when what they show moves (bead wadjet-6tu, found in
 * the Guildmaster's live check 2026-10-20: after a calendar switch a card
 * kept the old calendar's date label until the note re-rendered).
 *
 *   - the decision is blockRepaintOn (pure): every block repaints on
 *     time-changed and adapters-changed; on profiles-changed only when the
 *     save touched the zone it shows (or every zone);
 *   - main.ts (Obsidian-bound, so a source scan, as test/studio-surfaces does)
 *     attaches the watcher to every block and listens to the three events.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { blockRepaintOn } from "../src/plugin/codeblock-parse";

describe("blockRepaintOn", () => {
  test("a day or calendar change repaints every block", () => {
    expect(blockRepaintOn("time-changed", undefined, "fjord")).toBe(true);
    expect(blockRepaintOn("adapters-changed", undefined, "fjord")).toBe(true);
    expect(blockRepaintOn("time-changed", undefined, undefined)).toBe(true);
  });

  test("a save repaints the blocks whose zone it touched, or all of them when every zone moved", () => {
    expect(blockRepaintOn("profiles-changed", { all: false, zoneIds: ["fjord"] }, "fjord")).toBe(true);
    expect(blockRepaintOn("profiles-changed", { all: false, zoneIds: ["steppe"] }, "fjord")).toBe(false);
    expect(blockRepaintOn("profiles-changed", { all: false, zoneIds: [] }, "fjord")).toBe(false);
    expect(blockRepaintOn("profiles-changed", { all: true, zoneIds: [] }, "fjord")).toBe(true);
  });

  test("a block that errored before it picked a zone repaints on any save (a fix in settings may be what it waits for)", () => {
    expect(blockRepaintOn("profiles-changed", { all: false, zoneIds: [] }, undefined)).toBe(true);
  });
});

describe("main.ts wires every block to it", () => {
  const src = readFileSync("src/plugin/main.ts", "utf8");
  const watcher = src.slice(src.indexOf("class BlockWatcher"));

  test("the watcher is attached to every block, not only to blocks without a zone", () => {
    const render = src.slice(src.indexOf("private renderCodeblock("), src.indexOf("codeblockZone(spec: CodeblockSpec"));
    expect(render).toContain("ctx.addChild(new BlockWatcher(");
    expect(render).not.toMatch(/if \([^)]*\) ctx\.addChild\(new BlockWatcher/);
  });

  test("it listens to time-changed, adapters-changed and profiles-changed, the last through blockRepaintOn", () => {
    expect(watcher).toContain('api.on("time-changed", () => this.rerender())');
    expect(watcher).toContain('api.on("adapters-changed", () => this.rerender())');
    expect(watcher).toMatch(/api\.on\("profiles-changed", \(p\) => \{\s*if \(blockRepaintOn\("profiles-changed", p, this\.shown\)\) this\.rerender\(\);/);
  });
});
