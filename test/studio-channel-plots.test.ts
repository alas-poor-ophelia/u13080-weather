/**
 * The channel editor's plot geometry, held against the prototype's own markup.
 *
 * Each plot in `windows/channel.ts` is an SVG of a fixed height, and that
 * height is not a taste call — it is the number the prototype's editor markup
 * carries (`docs/handoff/climate-studio/audit/proto-markup/0250`, `0345`,
 * `0415`, `0480`). The window imports Obsidian, so it cannot be imported under
 * `bun test`; the check reads its text instead, the way
 * `studio-hints-channel.test.ts` does.
 */
import { describe, expect, test } from "bun:test";

const SOURCE = await Bun.file(new URL("../src/studio/ui/windows/channel.ts", import.meta.url)).text();

/** The prototype editor each channel's window is drawn from. */
const PROTO_FILE: Record<string, string> = {
  TEMPERATURE: "0250-temperature-editor.html",
  PRECIPITATION: "0345-precip-editor.html",
  WIND: "0415-wind-editor.html",
  SKY: "0480-sky-editor.html",
};

/**
 * The transcribed table. A plot's height in the prototype is the height of the
 * `<svg>` it is drawn in — 770 wide on the three full-column channels, 560 on
 * WIND, whose left column is spent on the 216 px rose.
 */
const PROTO_PLOT_HEIGHTS: Record<string, number[]> = {
  TEMPERATURE: [330],
  PRECIPITATION: [170, 140, 86],
  WIND: [180, 80],
  SKY: [160, 120],
};

/** Only the plot SVGs: the rose is a 216-wide square, not a plot. */
const PLOT_SVG_WIDTHS = new Set([770, 560]);

async function markupPlotHeights(file: string): Promise<number[]> {
  const html = await Bun.file(new URL(`../docs/handoff/climate-studio/audit/proto-markup/${file}`, import.meta.url)).text();
  const out: number[] = [];
  for (const m of html.matchAll(/<svg width="(\d+)" height="(\d+)"/g)) {
    if (PLOT_SVG_WIDTHS.has(Number(m[1]))) out.push(Number(m[2]));
  }
  return out;
}

/** The `height:` values inside one channel spec's `plots: [ … ]` block. */
function specPlotHeights(name: string): number[] {
  const start = SOURCE.indexOf(`const ${name}: ChannelWindowSpec = {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = SOURCE.indexOf("plots: [", start);
  const to = SOURCE.indexOf("schema:", from);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return [...SOURCE.slice(from, to).matchAll(/height: (\d+)/g)].map((m) => Number(m[1]));
}

/**
 * `chartPad`'s own rule, mirrored so the test can say what a plot's *drawn*
 * rectangle comes to. The stylesheet runs the channel editor's season tint the
 * full height of the plot (`.wadjet-studio-channel-win-chart
 * .wadjet-studio-chart-tint`), the way the prototype's band rects do, so the
 * rendered plot is the spec height and the pad is headroom inside it.
 */
function chartPad(height: number): { top: number; bottom: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return { top: clamp(Math.round(height * 0.12), 8, 20), bottom: clamp(Math.round(height * 0.08), 6, 12) };
}

describe("studio channel editor plots", () => {
  test("the transcribed table is what the prototype markup actually says", async () => {
    for (const [name, file] of Object.entries(PROTO_FILE)) {
      expect([name, await markupPlotHeights(file)]).toEqual([name, PROTO_PLOT_HEIGHTS[name]!]);
    }
  });

  test("every plot spec is the prototype's own SVG height", () => {
    for (const name of Object.keys(PROTO_FILE)) {
      expect([name, specPlotHeights(name)]).toEqual([name, PROTO_PLOT_HEIGHTS[name]!]);
    }
  });

  test("the editor's season tint runs the whole plot, as the prototype's band rects do", async () => {
    const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
    const rule = css.slice(css.indexOf(".wadjet-studio-channel-win-chart .wadjet-studio-chart-tint"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("height: 100%");
    expect(rule.slice(0, rule.indexOf("}"))).toContain("y: 0");
  });

  test("each plot keeps headroom inside that height rather than growing past it", () => {
    for (const heights of Object.values(PROTO_PLOT_HEIGHTS)) {
      for (const h of heights) {
        const pad = chartPad(h);
        expect(pad.top).toBeGreaterThanOrEqual(8);
        expect(pad.top).toBeLessThanOrEqual(20);
        expect(pad.bottom).toBeGreaterThanOrEqual(6);
        expect(pad.bottom).toBeLessThanOrEqual(12);
        // Headroom, not half the plot: the shortest one is the 86 px amount.
        expect(pad.top + pad.bottom).toBeLessThan(h / 2);
      }
    }
  });
});
