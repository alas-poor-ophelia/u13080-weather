import { describe, expect, test } from "bun:test";
import { yearKeyedNote } from "../src/plugin/calendar-change";

describe("the calendar change dialogs name the year-keyed data (wadjet-91c)", () => {
  test("nothing year-keyed: no note", () => {
    expect(yearKeyedNote([], [{}, { automation: [] }])).toBeNull();
  });
  test("eras and lanes are counted and the note says what happens to them", () => {
    expect(yearKeyedNote([{ name: "Ice Age" }, { name: "Drought" }], [{ automation: [{}] }, { automation: [{}, {}] }])).toBe(
      "This world's 2 eras and 3 automation lanes are placed by year number. They are kept as numbers, so after this change they count in the new calendar's years and can fall on other days; check them in the Studio.",
    );
  });
  test("one of them reads in the singular", () => {
    expect(yearKeyedNote([{ name: "Ice Age" }], [])).toBe(
      "This world's 1 era is placed by year number. It is kept as a number, so after this change it counts in the new calendar's years and can fall on other days; check it in the Studio.",
    );
  });
});
