/**
 * printPart (docs/SESHAT-v0.md §18.3 D4, bead wadjet-b6x): the canonical text
 * of one part, printed by the same line printers as `print`, so each part
 * appears verbatim in the whole calendar's text.
 */
import { describe, expect, test } from "bun:test";
import { HEBREW, parsePartId, print, printPart, type CalendarAst, type PartId } from "../src/seshat";
import { SESHAT_FIXTURES } from "./fixtures/seshat/calendars";
import { ESCAPED, LUNAR } from "./fixtures/orrery";

/** Every part id the calendar has. */
function partsOf(ast: CalendarAst): PartId[] {
  const out: PartId[] = ["calendar", "dayline"];
  if (ast.seasons) out.push("seasons");
  for (const f of ast.formats ?? []) out.push(`format:${f.name}`);
  for (const b of ast.bodies ?? []) out.push(`body:${b.id}`);
  for (const g of ast.gears) out.push(`gear:${g.id}`);
  for (const u of ast.units) {
    out.push(`unit:${u.id}`);
    if (u.kind === "slots") u.slots.forEach((_, i) => out.push(`slot:${u.id}:${i}`));
    else {
      if (u.crossing) out.push(`crossing:${u.id}`);
      if (u.crossing?.index) out.push(`train:${u.id}`);
      (u.stages ?? []).forEach((_, i) => out.push(`stage:${u.id}:${i}`));
      (u.ledger ?? []).forEach((_, i) => out.push(`ledger:${u.id}:${i}`));
    }
  }
  (ast.days ?? []).forEach((_, i) => out.push(`day:${i}`));
  for (const r of ast.rules ?? []) out.push(`rule:${r.id}`);
  return out;
}

const CALENDARS: Record<string, CalendarAst> = { ...SESHAT_FIXTURES, "lunar (orrery fixture)": LUNAR, "escaped (orrery fixture)": ESCAPED };

/** The first line at or after `from` where `needle` runs whole in `hay`, or -1. */
function runAt(hay: readonly string[], needle: readonly string[], from = 0): number {
  for (let i = from; i + needle.length <= hay.length; i++) if (needle.every((l, j) => hay[i + j] === l)) return i;
  return -1;
}

describe("printPart", () => {
  for (const [name, ast] of Object.entries(CALENDARS)) {
    test(`${name}: every part prints, in its place in print(ast)`, () => {
      const whole = print(ast);
      const chunks = whole.slice(0, -1).split("\n\n");
      const lines = whole.split("\n");
      const text = (p: PartId) => {
        const t = printPart(ast, p);
        expect(t, p).not.toBeNull();
        expect(parsePartId(p), p).not.toBeNull();
        return t!;
      };
      expect(text("calendar")).toBe(whole.slice(0, -1));
      // blocks are whole chunks of the calendar's text
      const blocks: PartId[] = [...(ast.seasons ? ["seasons" as const] : []), ...(ast.bodies ?? []).map((b) => `body:${b.id}` as const), ...ast.gears.map((g) => `gear:${g.id}` as const), ...ast.units.map((u) => `unit:${u.id}` as const), ...(ast.rules ?? []).map((r) => `rule:${r.id}` as const)];
      for (const p of blocks) expect(chunks.includes(text(p)), p).toBe(true);
      // blocks print in declaration order
      const starts = blocks.map((p) => chunks.indexOf(text(p)));
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      // the head: formats in order; day labels: one chunk, in order
      const head = chunks[0]!.split("\n");
      let at = 0;
      for (const f of ast.formats ?? []) {
        at = runAt(head, [text(`format:${f.name}`)], at);
        expect(at, f.name).toBeGreaterThan(0);
      }
      if (ast.formats?.length) expect(runAt(head, text("dayline").split("\n"))).toBeGreaterThan(0);
      if (ast.days?.length) expect(chunks.includes((ast.days ?? []).map((_, i) => text(`day:${i}`)).join("\n"))).toBe(true);
      // a unit's own parts run inside its block, in order: the crossing line, the stages, the ledger; or its slots
      for (const u of ast.units) {
        const block = text(`unit:${u.id}`).split("\n");
        const lo = runAt(lines, block);
        const hi = lo + block.length;
        const kids: PartId[] = u.kind === "slots" ? u.slots.map((_, i) => `slot:${u.id}:${i}` as const) : [...(u.crossing ? [`crossing:${u.id}` as const] : []), ...(u.stages ?? []).map((_, i) => `stage:${u.id}:${i}` as const), ...(u.ledger ?? []).map((_, i) => `ledger:${u.id}:${i}` as const)];
        let cur = lo;
        for (const k of kids) {
          const run = text(k).split("\n");
          const i = runAt(lines, run, cur);
          expect(i, k).toBeGreaterThan(lo);
          expect(i + run.length, k).toBeLessThan(hi);
          cur = i + run.length;
        }
        if (u.kind === "cycle" && u.crossing?.index) expect(text(`train:${u.id}`)).toBe(text(`crossing:${u.id}`));
      }
    });
  }

  test("every kind of part is exercised", () => {
    const kinds = new Set(Object.values(CALENDARS).flatMap((a) => partsOf(a).filter((p) => (printPart(a, p) ?? "") !== "").map((p) => parsePartId(p)!.kind)));
    expect([...kinds].sort()).toEqual(["body", "calendar", "crossing", "day", "dayline", "format", "gear", "ledger", "rule", "seasons", "slot", "stage", "train", "unit"]);
  });

  test("the part is the block a reader expects", () => {
    expect(printPart(HEBREW, "stage:year:1")).toBe("BEGIN:VSTAGE\nLENGTH:AT=0;IS=356;ADD=2\nLENGTH:AT=-1;IS=382;ADD=1\nEND:VSTAGE");
    expect(printPart(HEBREW, "crossing:year")).toBe("CROSSING:765433/25920@D-2092590+1007/2160;INDEX=235/1/19");
    expect(printPart(HEBREW, "train:year")).toBe(printPart(HEBREW, "crossing:year"));
    expect(printPart(HEBREW, "slot:month:1")).toBe("BEGIN:VSLOT\nNAME:Heshvan\nLENGTH:SLACK;MIN=29;MAX=30;FILL=2\nEND:VSLOT");
    expect(printPart(HEBREW, "slot:month:0")).toBe("SLOT:Tishri=30");
    expect(printPart(HEBREW, "gear:leap")).toBe("BEGIN:VGEAR\nUID:leap\nPOSITIONS:ON=year;PERIOD=19;AT=0,3,6,8,11,14,17;OFFSET=-1\nEND:VGEAR");
    expect(printPart(HEBREW, "calendar")).toBe(print(HEBREW).slice(0, -1));
    expect(printPart(LUNAR, "seasons")).toBe("BEGIN:VSEASONS\nUNIT:year\nMARK:Thaw=0.1\nMARK:Bloom=DAY:80\nMARK:Harvest=month:7.1\nEND:VSEASONS");
    expect(printPart(LUNAR, "day:0")).toBe("RDATE:D10;NAME=Founding");
  });

  test("a part the calendar lacks is null; a calendar without formats has an empty day line", () => {
    expect(printPart(HEBREW, "gear:nope")).toBeNull();
    expect(printPart(HEBREW, "slot:month:13")).toBeNull();
    expect(printPart(HEBREW, "stage:year:2")).toBeNull();
    expect(printPart(HEBREW, "seasons")).toBeNull();
    expect(printPart(HEBREW, "ledger:year:0")).toBeNull();
    expect(printPart(HEBREW, "crossing:month")).toBeNull();
    expect(printPart(HEBREW, "bogus" as PartId)).toBeNull();
    expect(printPart({ name: HEBREW.name, gears: HEBREW.gears, units: HEBREW.units }, "dayline")).toBe("");
    expect(printPart({ ...HEBREW, formats: [] }, "dayline")).toBe("FORMATS:");
  });

  test("part ids read back", () => {
    expect(parsePartId("slot:month:12")).toEqual({ kind: "slot", id: "month", index: 12 });
    expect(parsePartId("day:3")).toEqual({ kind: "day", index: 3 });
    expect(parsePartId("format:filler")).toEqual({ kind: "format", id: "filler" });
    expect(parsePartId("seasons")).toEqual({ kind: "seasons" });
    expect(parsePartId("slot:month:01")).toBeNull();
    expect(parsePartId("slot:month")).toBeNull();
    expect(parsePartId("slot:month:9007199254740992")).toBeNull();
    expect(parsePartId("day:99999999999999999999")).toBeNull();
    expect(printPart(HEBREW, "slot:month:9007199254740992")).toBeNull();
  });

  test("escaped names print escaped; the slots ledger entry is its own line", () => {
    expect(printPart(ESCAPED, "slot:month:0")).toBe("SLOT:A\\,b=120");
    expect(printPart(ESCAPED, "slot:month:1")).toBe("SLOT:C\\;d\\=e=120");
    expect(printPart(ESCAPED, "slot:month:2")).toBe("SLOT:\\#x\\\\y\\:z=125");
    expect(printPart(ESCAPED, "day:0")).toBe("RDATE:D3;NAME=Feast\\: one\\, two;TAGS=a\\=b");
    expect(printPart(ESCAPED, "ledger:year:0")).toBe("SLOTS:FROM=2;UNIT=month;LENGTHS=125,120,120");
  });

  test("the crossing line prints alone: a part elsewhere in the unit that cannot print does not stop it", () => {
    const year = HEBREW.units[0]!;
    const bad = { ...HEBREW, units: [{ ...year, stages: [{ rules: [{ add: 1, residue: { mod: 7, in: [1] }, extra: 1 }] }] } as never, HEBREW.units[1]!] } as CalendarAst;
    expect(() => print(bad)).toThrow(/no text form/);
    expect(printPart(bad, "crossing:year")).toBe(printPart(HEBREW, "crossing:year"));
    expect(printPart(bad, "train:year")).toBe(printPart(HEBREW, "crossing:year"));
    expect(() => printPart(bad, "stage:year:0")).toThrow(/no text form/);
  });
});
