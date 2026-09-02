/**
 * The session-scoped "first world edit confirms" flag (`model/world-confirm.ts`,
 * SPEC §2). Small and module-level, but shared by every world-editing window
 * (Seasons, CYCLE, …), so a regression here would silently drop or repeat the
 * confirm across all of them.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { markWorldConfirmed, needsWorldConfirm, resetWorldConfirm } from "../src/studio/model/world-confirm";

describe("world-confirm", () => {
  beforeEach(() => resetWorldConfirm());

  test("a fresh session needs a confirm", () => {
    expect(needsWorldConfirm()).toBe(true);
  });

  test("marking confirmed clears the flag for the rest of the session", () => {
    markWorldConfirmed();
    expect(needsWorldConfirm()).toBe(false);
    // Still false on a second read — it is not a one-shot latch that resets itself.
    expect(needsWorldConfirm()).toBe(false);
  });

  test("resetWorldConfirm puts it back to asking, as a fresh session would start", () => {
    markWorldConfirmed();
    resetWorldConfirm();
    expect(needsWorldConfirm()).toBe(true);
  });
});
