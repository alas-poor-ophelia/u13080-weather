/**
 * P3c step 4 (docs/SESHAT-v0.md §15.5, §15.9 S2): the ledger as a part of
 * the form model. Marked days are day labels; a skipped day of a named rule
 * is the rule's exclusion list in one normal form; pins, slot overrides and
 * switches stay on the cycle unit; problems name their entry.
 */
import { describe, expect, test } from "bun:test";
import { GREGORIAN, ROMAN, print, type CalendarAst, type RuleAst } from "../src/seshat";
import { compile, recognise, type LedgerForm } from "../src/plugin/time/form";
import { prepareDefinition, SeshatCalendar } from "../src/plugin/time/seshat";

const FEAST: RuleAst = { kind: "dates", days: [10, 375, 740] };
const DEF: CalendarAst = { ...GREGORIAN, rules: [{ id: "feast", rule: FEAST, tags: ["feast"] }] };
const ledgerOf = (ast: CalendarAst): LedgerForm => {
  const p = recognise(ast).ledger;
  if (p.kind !== "form") throw new Error(p.why);
  return p.value;
};
const cal = (ast: CalendarAst) => new SeshatCalendar(print(ast), () => 0);
const hash = (ast: CalendarAst) => cal(ast).configHash();

describe("the ledger part", () => {
  test("Roman's ledger reads back as fields, entry for entry", () => {
    const l = ledgerOf(ROMAN);
    const year = ROMAN.units.find((u) => u.id === "year");
    expect(year?.kind === "cycle" ? year.ledger?.length : undefined).toBe(l.units.year!.length);
    expect(l.units.year!.length).toBeGreaterThan(0);
    expect(print(compile(ROMAN, { ledger: l }))).toBe(print(ROMAN));
  });

  test("a marked day carries its tags; removing it gives back the calendar", () => {
    const l = ledgerOf(DEF);
    const marked = compile(DEF, { ledger: { ...l, days: [{ day: 500, name: "Coronation", tags: ["coronation"] }] } });
    expect(cal(marked).toContext(500).tags).toContain("coronation");
    expect(cal(marked).toContext(501).tags).not.toContain("coronation");
    const back = compile(marked, { ledger: { ...l, days: [] } });
    expect(print(back)).toBe(print(DEF));
  });

  test("skipping a day of a named rule: that day loses the rule's tag, the others keep it; one sorted form; none gives back the rule", () => {
    const l = ledgerOf(DEF);
    expect(l.skips).toEqual({});
    const skipped = compile(DEF, { ledger: { ...l, skips: { feast: [375] } } });
    expect(skipped.rules![0]!.rule).toEqual({ kind: "all", of: [FEAST, { kind: "not", of: { kind: "dates", days: [375] } }] });
    const c = cal(skipped);
    expect(c.toContext(375).tags).not.toContain("feast");
    expect(c.toContext(10).tags).toContain("feast");
    expect(c.toContext(740).tags).toContain("feast");
    // several skips, given in any order and with repeats, are written once, sorted
    const two = compile(DEF, { ledger: { ...l, skips: { feast: [740, 10, 740] } } });
    expect(two.rules![0]!.rule).toEqual({ kind: "all", of: [FEAST, { kind: "not", of: { kind: "dates", days: [10, 740] } }] });
    expect(ledgerOf(two).skips).toEqual({ feast: [10, 740] });
    // and none again is the rule as it was, hash and all
    const back = compile(two, { ledger: { ...ledgerOf(two), skips: {} } });
    expect(print(back)).toBe(print(DEF));
    expect(hash(back)).toBe(hash(DEF));
  });

  test("a stored skip list written another way is kept as written while it is unchanged", () => {
    const unsorted: CalendarAst = { ...DEF, rules: [{ id: "feast", rule: { kind: "all", of: [FEAST, { kind: "not", of: { kind: "dates", days: [740, 10] } }] }, tags: ["feast"] }] };
    const l = ledgerOf(unsorted);
    expect(l.skips).toEqual({ feast: [740, 10] });
    // an edit elsewhere in the ledger leaves the rule exactly as stored
    expect(compile(unsorted, { ledger: { ...l, days: [{ day: 3, name: "x" }] } }).rules).toEqual(unsorted.rules);
    expect(compile(unsorted, { ledger: l }).rules).toEqual(unsorted.rules);
  });

  test("a slot override: one year's month lengths; a list that does not fill the year is refused on that entry", () => {
    const l = ledgerOf(GREGORIAN);
    const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // 1971 (index 1971, 365 days) given a 29-day February and a 30-day December
    const ok = compile(GREGORIAN, { ledger: { ...l, units: { year: [{ kind: "slots", from: 1971, unit: "month", lengths: lengths.map((n, i) => (i === 11 ? 30 : n)) }] } } });
    expect("text" in prepareDefinition(print(ok))).toBe(true);
    const bad = compile(GREGORIAN, { ledger: { ...l, units: { year: [{ kind: "slots", from: 1971, unit: "month", lengths }] } } });
    const r = prepareDefinition(print(bad));
    if (!("error" in r)) throw new Error("expected a refusal");
    expect(r.problems.some((p) => p.unit === "year" && p.entry === 0)).toBe(true);
  });

  test("a pin moves one year's start; removing it gives back the calendar", () => {
    const l = ledgerOf(GREGORIAN);
    const pinned = compile(GREGORIAN, { ledger: { ...l, units: { year: [{ kind: "starts", from: 1973, startsOn: 1097 }] } } });
    expect(cal(pinned).yearStart(1973)).toBe(1097);
    expect(print(compile(pinned, { ledger: l }))).toBe(print(GREGORIAN));
  });
});
