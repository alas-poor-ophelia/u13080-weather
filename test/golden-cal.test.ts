import { describe, expect, test } from "bun:test";
import { buildGoldenCal, compareGoldenCal, type GoldenCal } from "./golden/golden-cal";
import stored from "./golden/calendar.json";

describe("golden master (calendar path)", () => {
  test(
    "calendar.json matches InternalCalendar -> World and a third-party adapter exactly (moons, seasons, eras, flipSeasons, envelopes, spells)",
    () => {
      expect(compareGoldenCal(stored as unknown as GoldenCal, buildGoldenCal())).toEqual([]);
    },
    30_000,
  );
});
