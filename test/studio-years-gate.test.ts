/**
 * The year seam's structural gate, as a ratchet (docs/SESHAT-v0.md §14.8 C4):
 * outside src/studio/model/years.ts, the Studio reads a calendar's year
 * length or epoch year only where this list allows, and never more often
 * than it says. Each P3b step moves sites onto the seam and lowers these
 * counts (and must lower them here: an unchanged list fails when a count
 * drops, so the ratchet cannot silently loosen); none may rise, and no file
 * may join. When P3b ends the list holds only the duration scales §14.4
 * leaves approximate.
 *
 * A count is the number of lines matching yearLength, epochYear or
 * DEFAULT_YEAR_LENGTH as words (comments included: a comment that names one
 * is usually next to code that reads it).
 */
import { describe, expect, test } from "bun:test";

const ALLOWED: Record<string, number> = {
  "src/studio/model/audition.ts": 4,
  "src/studio/model/automation-edit.ts": 2,
  "src/studio/model/channel-edit.ts": 2,
  "src/studio/model/channel-series.ts": 3,
  "src/studio/model/device-lanes.ts": 4,
  "src/studio/model/devices.ts": 4,
  "src/studio/model/format.ts": 11,
  "src/studio/model/hints-audition.ts": 2,
  "src/studio/model/mixer.ts": 5,
  "src/studio/model/spans.ts": 10,
  "src/studio/model/zoom.ts": 1,
  "src/studio/ui/audition.ts": 6,
  "src/studio/ui/day-card.ts": 2,
  "src/studio/ui/header.ts": 3,
  "src/studio/ui/playlist.ts": 5,
  "src/studio/ui/rows/automation-row.ts": 4,
  "src/studio/ui/rows/channel-row.ts": 4,
  "src/studio/ui/rows/device-rows.ts": 6,
  "src/studio/ui/rows/regimes-row.ts": 7,
  "src/studio/ui/ruler.ts": 7,
  "src/studio/ui/windows/channel.ts": 6,
  "src/studio/ui/windows/device/constants.ts": 1,
  "src/studio/ui/windows/device/index.ts": 1,
  "src/studio/ui/windows/device/when-year-window.ts": 8,
  "src/studio/ui/windows/device/when.ts": 4,
  "src/studio/ui/windows/era.ts": 1,
  "src/studio/ui/windows/forcings.ts": 3,
  "src/studio/ui/windows/seasons.ts": 7,
};

const PATTERN = /\byearLength\b|\bepochYear\b|\bDEFAULT_YEAR_LENGTH\b/;

describe("the year seam's ratchet", () => {
  test("no Studio file reads a year length or epoch more often than allowed, and the list is exact", async () => {
    const counts: Record<string, number> = {};
    for await (const f of new Bun.Glob("src/studio/**/*.ts").scan(".")) {
      const path = f.replaceAll("\\", "/");
      if (path === "src/studio/model/years.ts") continue;
      const n = (await Bun.file(f).text()).split("\n").filter((l) => PATTERN.test(l)).length;
      if (n > 0) counts[path] = n;
    }
    // exact: a rise is a new direct read; a drop must be written down so the ratchet tightens
    expect(Object.fromEntries(Object.entries(counts).sort())).toEqual(Object.fromEntries(Object.entries(ALLOWED).sort()));
  });
});
