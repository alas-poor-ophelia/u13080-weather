/**
 * Seshat P3c step 3 (docs/SESHAT-v0.md §15.2, §15.1 R2): the settings
 * Calendar group's Days in a year, Moons and Seasons rows on a world that runs
 * a definition, bound to the stored definition through the form model.
 */
import { describe, expect, test } from "bun:test";
import { definitionRowEdit, definitionRows, YEAR_EDIT_DESC } from "../src/plugin/calendar-rows";
import { badSeasonsLine, parseSeasonsText, serialiseSeasonsText } from "../src/plugin/calendar-text";
import { DEFAULT_SETTINGS } from "../src/plugin/settings";
import { definitionFromLegacy, SeshatCalendar } from "../src/plugin/time/seshat";
import { GREGORIAN, HEBREW, parse, print, type CalendarAst } from "../src/seshat";

const hash = (text: string) => new SeshatCalendar(text, () => 0).configHash();

function plain(): CalendarAst {
  const r = definitionFromLegacy(DEFAULT_SETTINGS.calendar);
  if ("refused" in r) throw new Error(r.refused);
  return r.ast;
}

// an exact rational the decimal round trip cannot give back (the denominator is past bodyFor's cap)
const MOONY: CalendarAst = {
  ...GREGORIAN,
  bodies: [
    { id: "luna", period: { n: 295299734, d: 9999991 }, epoch: { n: 1234567, d: 9999991 }, moon: { name: "Luna", phases: [{ name: "Full", at: 0.5 }] } },
    { id: "ember", period: { n: 33, d: 1 }, epoch: { n: 0, d: 1 }, moon: { name: "Ember" } },
  ],
};

function written(r: ReturnType<typeof definitionRowEdit>): string {
  if (!("text" in r)) throw new Error(`expected a write, got ${JSON.stringify(r)}`);
  return r.text;
}

describe("seasons text helpers", () => {
  test("parse and serialise round trip; starts are clamped; bad lines are named", () => {
    expect(parseSeasonsText("Wet, 0.1\n\nDry, 1.5\nCold, -1")).toEqual([
      { name: "Wet", from: 0.1 },
      { name: "Dry", from: 0.999 },
      { name: "Cold", from: 0 },
    ]);
    expect(serialiseSeasonsText([{ name: "Wet", from: 0.1 }])).toBe("Wet, 0.1");
    expect(parseSeasonsText("")).toEqual([]);
    expect(badSeasonsLine("Wet, 0.1\n")).toBeUndefined();
    expect(badSeasonsLine("Wet")).toContain('"Wet"');
    expect(badSeasonsLine("Wet, soon")).toContain('"Wet, soon"');
  });
});

describe("definitionRows", () => {
  test("a plain definition: every row is editable and shows the stored values", () => {
    const ast = plain();
    const rows = definitionRows(ast);
    expect(rows.year).toEqual({ kind: "edit", value: DEFAULT_SETTINGS.calendar.yearLength, desc: YEAR_EDIT_DESC });
    expect(rows.moons.kind).toBe("edit");
    expect(rows.seasons.kind).toBe("edit");
    if (rows.seasons.kind === "edit") expect(rows.seasons.value).toBe(serialiseSeasonsText(DEFAULT_SETTINGS.calendar.seasons));
  });

  test("a leap rule (Gregorian): the year is read-only and says both lengths and where it is edited", () => {
    const rows = definitionRows(GREGORIAN);
    expect(rows.year).toEqual({ kind: "read", desc: "365 or 366 days (a leap rule). Edit it in the Studio's calendar window or with Edit definition." });
  });

  test("a year the form reads as text (Hebrew): read-only, with the form model's reason", () => {
    const rows = definitionRows(HEBREW);
    expect(rows.year.kind).toBe("read");
    expect(rows.year.desc).toStartWith("Not a number of days this row can edit: ");
    expect(rows.year.desc).toEndWith("Edit it with Edit definition.");
  });

  test("moons show as decimals, one per line", () => {
    const rows = definitionRows(MOONY);
    expect(rows.moons.kind).toBe("edit");
    if (rows.moons.kind === "edit") expect(rows.moons.value.split("\n").map((l) => l.split(",")[0])).toEqual(["Luna", "Ember"]);
  });
});

describe("definitionRowEdit", () => {
  test("moons: saving the shown text unchanged writes nothing", () => {
    const stored = print(MOONY);
    const rows = definitionRows(parse(stored));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    expect(definitionRowEdit(stored, "moons", rows.moons.value)).toEqual({ unchanged: true });
  });

  test("moons: a phases-only edit keeps every body's exact rational, its id and the hash", () => {
    const stored = print(MOONY);
    const rows = definitionRows(parse(stored));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    const text = rows.moons.value.replace("Full@0.5", "Full@0.4");
    const out = parse(written(definitionRowEdit(stored, "moons", text)));
    expect(out.bodies!.map((b) => [b.id, b.period, b.epoch])).toEqual(MOONY.bodies!.map((b) => [b.id, b.period, b.epoch]));
    expect(out.bodies![0]!.moon!.phases).toEqual([{ name: "Full", at: 0.4 }]);
    expect(hash(print(out))).toBe(hash(stored));
  });

  test("moons: a rename is a new body by name (fresh id, bodyFor's rational); the other moon keeps its body", () => {
    const stored = print(MOONY);
    const rows = definitionRows(parse(stored));
    if (rows.moons.kind !== "edit") throw new Error("moons should be editable");
    const out = parse(written(definitionRowEdit(stored, "moons", rows.moons.value.replace("Luna,", "Selene,"))));
    const selene = out.bodies!.find((b) => b.moon?.name === "Selene")!;
    expect(selene.id).not.toBe("luna");
    expect(out.bodies!.some((b) => b.id === "luna")).toBe(false);
    expect(selene.period).not.toEqual(MOONY.bodies![0]!.period);
    expect(out.bodies!.find((b) => b.moon?.name === "Ember")).toEqual(MOONY.bodies![1]);
    expect(hash(print(out))).not.toBe(hash(stored));
  });

  test("moons: a bad line is refused with the textarea's message", () => {
    const r = definitionRowEdit(print(MOONY), "moons", "Luna, soon, 0");
    expect("error" in r && r.error).toContain('"Luna, soon, 0"');
  });

  test("seasons: adding the first season to a definition without seasons", () => {
    const ast = { ...plain() };
    delete (ast as { seasons?: unknown }).seasons;
    const stored = print(ast);
    expect(parse(stored).seasons).toBeUndefined();
    expect(definitionRows(parse(stored)).seasons).toMatchObject({ kind: "edit", value: "" });
    const out = parse(written(definitionRowEdit(stored, "seasons", "Wet, 0.25")));
    expect(out.seasons).toEqual({ unit: "year", marks: [{ name: "Wet", from: 0.25 }] });
    // nothing else moved
    const { seasons: _s, ...rest } = out;
    expect(print(rest)).toBe(stored);
  });

  test("seasons: clearing the text removes the field, and the hash returns to the calendar without seasons", () => {
    const withSeasons = print({ ...plain(), seasons: { unit: "year", marks: [{ name: "Wet", from: 0 }, { name: "Dry", from: 0.5 }] } });
    const cleared = written(definitionRowEdit(withSeasons, "seasons", ""));
    expect(parse(cleared).seasons).toBeUndefined();
    const bare = { ...plain() };
    delete (bare as { seasons?: unknown }).seasons;
    expect(hash(cleared)).toBe(hash(print(bare)));
  });

  test("year: a length edit on a plain definition writes only the year's length", () => {
    const stored = print(plain());
    const out = parse(written(definitionRowEdit(stored, "year", 400)));
    expect(definitionRows(out).year).toMatchObject({ kind: "edit", value: 400 });
    const before = parse(stored);
    expect(out.units.filter((u) => u.id !== "year")).toEqual(before.units.filter((u) => u.id !== "year"));
    expect(out.seasons).toEqual(before.seasons);
    expect(out.bodies).toEqual(before.bodies);
    expect(definitionRowEdit(stored, "year", DEFAULT_SETTINGS.calendar.yearLength)).toEqual({ unchanged: true });
  });

  test("year: the legacy bounds; a leap rule or a text year is refused", () => {
    const stored = print(plain());
    expect(definitionRowEdit(stored, "year", 0)).toHaveProperty("error");
    expect(definitionRowEdit(stored, "year", 12.5)).toHaveProperty("error");
    expect(definitionRowEdit(print(GREGORIAN), "year", 360)).toHaveProperty("error");
    expect(definitionRowEdit(print(HEBREW), "year", 360)).toHaveProperty("error");
  });
});
