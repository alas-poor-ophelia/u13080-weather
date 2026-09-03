/**
 * `src/studio/model/palette.ts` — the studio's data-colour cycles.
 *
 * Just the cycle orders and `cycleAt`/`cycleColour`'s wrap-and-override
 * behaviour: the cycles themselves are lists of CSS custom-property names, so
 * there is nothing else pure to test here.
 */
import { describe, expect, test } from "bun:test";
import { BAND_TINT_ALPHA, cycleAt, cycleColour, DATA_CYCLE, ERA_CYCLE, REGIME_CYCLE, SEASON_CYCLE, tintColour } from "../src/studio/model/palette";

describe("palette · cycle orders", () => {
  test("DATA_CYCLE leads on calendar gold", () => {
    expect(DATA_CYCLE).toEqual(["--wadjet-studio-gold", "--wadjet-studio-precip", "--wadjet-studio-wind", "--wadjet-studio-temp", "--wadjet-studio-moon", "--wadjet-studio-sky"]);
  });

  test("ERA_CYCLE leads on precip, gold third — its own list, not DATA_CYCLE", () => {
    expect(ERA_CYCLE).toEqual(["--wadjet-studio-precip", "--wadjet-studio-wind", "--wadjet-studio-gold", "--wadjet-studio-temp", "--wadjet-studio-moon", "--wadjet-studio-sky"]);
    expect(ERA_CYCLE).not.toEqual(DATA_CYCLE);
  });

  test("SEASON_CYCLE and REGIME_CYCLE are unaffected", () => {
    expect(SEASON_CYCLE).toEqual(["--wadjet-studio-season-1", "--wadjet-studio-season-2", "--wadjet-studio-season-3", "--wadjet-studio-season-4", "--wadjet-studio-season-5", "--wadjet-studio-season-6"]);
    expect(REGIME_CYCLE).toEqual(["#9298a1", "#5cb8f0", "#e8c15a", "#7fd6a8", "#f0885c", "#cdd9ee"]);
  });
});

describe("palette · cycleAt / cycleColour over ERA_CYCLE", () => {
  test("walks the six era hues in order and wraps", () => {
    expect(cycleAt(0, ERA_CYCLE)).toBe("--wadjet-studio-precip");
    expect(cycleAt(1, ERA_CYCLE)).toBe("--wadjet-studio-wind");
    expect(cycleAt(2, ERA_CYCLE)).toBe("--wadjet-studio-gold");
    expect(cycleAt(5, ERA_CYCLE)).toBe("--wadjet-studio-sky");
    expect(cycleAt(6, ERA_CYCLE)).toBe("--wadjet-studio-precip"); // wraps
  });

  test("a negative index wraps backwards rather than throwing (persisted view state can be garbage)", () => {
    expect(cycleAt(-1, ERA_CYCLE)).toBe("--wadjet-studio-sky");
  });

  test("cycleColour wraps the var name for CSS", () => {
    expect(cycleColour(0, ERA_CYCLE)).toBe("var(--wadjet-studio-precip)");
    expect(cycleColour(2, ERA_CYCLE)).toBe("var(--wadjet-studio-gold)");
  });

  test("cycleColour with no cycle argument still falls back to DATA_CYCLE", () => {
    expect(cycleColour(0)).toBe("var(--wadjet-studio-gold)");
  });
});

describe("palette · tintColour", () => {
  test("composites the cycle hue at the given alpha rather than laying it on flat", () => {
    expect(tintColour(0, BAND_TINT_ALPHA, SEASON_CYCLE)).toBe("color-mix(in srgb, var(--wadjet-studio-season-1) 33%, transparent)");
    expect(tintColour(3, "12%", ERA_CYCLE)).toBe("color-mix(in srgb, var(--wadjet-studio-temp) 12%, transparent)");
  });

  test("BAND_TINT_ALPHA is the prototype's `tc + \"55\"` third, not a full-strength fill", () => {
    expect(BAND_TINT_ALPHA).toBe("33%");
  });

  test("no cycle argument still falls back to DATA_CYCLE, same as cycleColour", () => {
    expect(tintColour(0, "50%")).toBe("color-mix(in srgb, var(--wadjet-studio-gold) 50%, transparent)");
  });
});
