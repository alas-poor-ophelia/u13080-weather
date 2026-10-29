/**
 * The Orrery's pure model (docs/SESHAT-v0.md §18.3 D6–D8, §18.6 items 3, 7,
 * 11 and 13; bead wadjet-b6x): parts and groups, segments with states, pick
 * points, the NOW readout, projection and picking, empty states, and the
 * Levanah fixture. Every per-day fact is checked against the engine itself.
 */
import { describe, expect, test } from "bun:test";
import { Engine, GREGORIAN, HARPTOS, HEBREW, printPart, problems, ROMAN, type CalendarAst, type PartId } from "../src/seshat";
import { buildOrrery, CAMERA, crossingMark, easeCamera, layoutLabels, orbit, orreryProblems, paintState, partInfo, pickPart, problemPart, problemsByPart, project, VIEWS, yearFacts, dayFacts, zoom, type OrreryModel, type PickPoint } from "../src/studio/model/orrery-geometry";
import { ESCAPED, LEVANAH, LUNAR } from "./fixtures/orrery";

function model(ast: CalendarAst, day: number): OrreryModel {
  const m = buildOrrery(ast, day + 0.5);
  if (m.kind !== "orrery") throw new Error(`no orrery: ${m.message}`);
  return m;
}
const rows = (m: OrreryModel, label: string) => m.groups.find((g) => g.label === label)?.rows.map((r) => r.id) ?? null;
const row = (m: OrreryModel, id: PartId) => m.groups.flatMap((g) => g.rows).find((r) => r.id === id)!;
const segs = (m: OrreryModel, part: PartId) => m.segments.filter((s) => s.part === part);
const now = (m: OrreryModel, part: PartId | null) => Object.fromEntries(partInfo(m, part).now.map((r) => [r.key, r.value]));
const angle = (p: readonly number[]) => Math.atan2(p[0]!, -p[2]!);
const TAU = Math.PI * 2;
const mod = (a: number, m: number) => ((a % m) + m) % m;

describe("parts and groups", () => {
  test("Gregorian: units, the leap gear lit in a leap year, no crossing or stages", () => {
    const m = model(GREGORIAN, 20000); // 2024-10-04
    expect(m.groups.map((g) => g.label)).toEqual(["DRIVE", "BODIES · C1", "UNITS · C2", "GEARS · C3"]);
    expect(rows(m, "UNITS · C2")).toEqual(["unit:year", "unit:month", "unit:week", "unit:weekday"]);
    expect(row(m, "gear:leap")).toMatchObject({ spec: "+4 −100 +400", lit: true });
    expect(row(m, "unit:year").spec).toBe("365 +1 d");
    expect(m.today.date).toBe("2024-10-04");
    // the weekday wheel's label under the index is the engine's
    expect(m.labels.find((l) => l.part === "unit:weekday" && l.state === "hot")?.text).toBe("Friday");
    expect(now(m, "unit:weekday").label).toBe(new Engine(GREGORIAN).labelAt("weekday", 20000)!.name);
  });

  test("Hebrew: the crossing base, the 235 : 19 train, two stages read off the engine's own levels", () => {
    const e = new Engine(HEBREW);
    const m = model(HEBREW, 20708);
    expect(rows(m, "CROSSING · YEAR BASE")).toEqual(["crossing:year", "train:year"]);
    expect(row(m, "train:year").spec).toBe("235 : 19");
    const train = now(m, "train:year");
    expect(train["long years"]).toBe("7 in 19");
    expect(train["this year"]).toBe(`crossing ${e.startTrace("year", 5786).baseIndex}`);
    expect(train["next year"]).toBe(`crossing ${e.startTrace("year", 5787).baseIndex}`);
    expect(e.startTrace("year", 5787).baseIndex - e.startTrace("year", 5786).baseIndex).toBe(13); // 5787 is a leap year: 13 months
    expect(rows(m, "STAGES · C4")).toEqual(["stage:year:0", "stage:year:1"]);
    expect(row(m, "gear:leap").spec).toBe("7 of 19");
    expect(segs(m, "train:year").length).toBeGreaterThan(0);
    // the trace is the engine's own levels: its last level is the start, its base the molad day, over a span of years
    for (let j = 5600; j < 5900; j++) {
      const t = e.startTrace("year", j);
      expect(t.levels.at(-1)).toBe(e.start("year", j));
      expect(t.baseStart).toBe(t.levels[0]!);
    }
    // a year whose start some stage moves: the pawl is hot, the row lit, the trace ends on the engine's start
    let k = 5780;
    while (e.startTrace("year", k).levels.at(-1) === e.startTrace("year", k).levels[0]) k++;
    const moved = model(HEBREW, e.start("year", k));
    const tr = moved.year.trace;
    expect(tr.levels.at(-1)).toBe(e.start("year", k));
    expect(tr.start).toBe(e.start("year", k));
    const i = tr.levels.findIndex((s, j) => j > 0 && s !== tr.levels[j - 1]) - 1;
    expect(row(moved, `stage:year:${i}`).lit).toBe(true);
    expect(segs(moved, `stage:year:${i}`).some((s) => s.state === "hot")).toBe(true);
    expect(tr.fired[i]).toBeGreaterThanOrEqual(0);
  });

  test("README sanity figures, through the model: Hebrew 5787 starts on D20708 with 385 days; 1492 DR has 366", () => {
    const h = model(HEBREW, 20708).year;
    expect([h.number, h.start, h.length]).toEqual([5787, 20708, 385]);
    expect(model(HEBREW, 20707).year.number).toBe(5786);
    // by hand: 1491 years of 365 days before 1 Hammer 1492 DR, plus Shieldmeet in each year divisible by 4 (4, 8, … 1488 DR: 372)
    const dr1492 = 1491 * 365 + 372;
    expect(dr1492).toBe(544_587);
    const y = model(HARPTOS, dr1492 + 100).year;
    expect([y.number, y.start, y.length]).toEqual([1492, dr1492, 366]);
  });

  test("Harptos: filler bosses, the Shieldmeet ghost in a common year, the tenday band", () => {
    const e = new Engine(HARPTOS);
    const common = model(HARPTOS, e.start("year", 1490));
    expect(row(common, "unit:month").spec).toBe("12 + 6 filler");
    expect(row(common, "unit:tenday").spec).toBe("3 × 10");
    expect(segs(common, "slot:month:10").every((s) => s.state === "ghost")).toBe(true); // Shieldmeet, length 0
    const leap = model(HARPTOS, e.start("year", 1491));
    expect(segs(leap, "slot:month:10").some((s) => s.state !== "ghost")).toBe(true);
    expect(segs(leap, "slot:month:1").length).toBeGreaterThan(0); // Midwinter, a filler
    expect(segs(leap, "slot:tenday:0").length).toBeGreaterThan(0);
    expect(leap.picks.some((p) => p.part === "unit:tenday")).toBe(true);
    // a festival day has no tenday: no tenday band is hot
    const midwinter = e.dayOf("month", [1491], 1, 0);
    const fm = model(HARPTOS, midwinter);
    expect(fm.today.positions.get("tenday")).toBeNull();
    expect(fm.segments.some((s) => s.part?.startsWith("slot:tenday") && s.state === "hot")).toBe(false);
    expect(fm.today.date).toBe("Midwinter 1492 DR");
  });

  test("Roman: ledger set-screws for the shown year (a pinned start; the switch with its tag)", () => {
    const e = new Engine(ROMAN);
    const pinned = model(ROMAN, e.start("year", 600));
    expect(pinned.year.ledger.map((s) => [s.part, s.kind])).toEqual([["ledger:year:0", "starts"]]);
    expect(pinned.year.trace.pinned).toBe(true);
    const julian = model(ROMAN, e.start("year", 1901));
    expect(julian.year.ledger).toEqual([{ part: "ledger:year:1", kind: "switch", tag: "rule changes from year 754" }]);
    expect(julian.labels.some((l) => l.part === "ledger:year:1" && l.text === "rule changes from year 754" && !l.onlySelected)).toBe(true);
    expect(rows(julian, "LEDGER · C6")).toEqual(["ledger:year:0", "ledger:year:1"]);
    expect(row(julian, "ledger:year:1").lit).toBe(true);
    expect(row(julian, "ledger:year:0").lit).toBe(false);
    const ideal = model(ROMAN, e.start("year", 100));
    expect(ideal.year.ledger).toEqual([]);
  });

  test("a body-driven year: the rod from the body's mark, dated season marks, rule lamps from the engine", () => {
    const e = new Engine(LUNAR);
    const m = model(LUNAR, 30);
    expect(rows(m, "BODIES · C1")).toEqual(["body:moon"]);
    expect(rows(m, "CROSSING · YEAR BASE")).toEqual(["crossing:year", "train:year"]);
    expect(rows(m, "SEASONS")).toEqual(["seasons"]);
    expect(row(m, "seasons").spec).toBe("3 marks · dated");
    expect(crossingMark(LUNAR, "year")).toEqual({ body: "moon", phase: 0 });
    expect(crossingMark({ ...LUNAR, units: [{ ...(LUNAR.units[0] as never as object), crossing: { body: { id: "moon", mark: { n: 1, d: 4 } }, index: { a: 12, c: 0, L: 1 } } } as never, LUNAR.units[1]!] }, "year")!.phase).toBe(0.25);
    // the rod runs from the mark on the moon's orbit (y = 1.15 + 0.05 below) down to the index arm
    const rod = segs(m, "crossing:year").find((s) => s.a[1] > 1 && s.b[1] < 0.5)!;
    expect(rod).toBeDefined();
    expect(mod(angle(rod.a) - Math.PI, TAU)).toBeCloseTo(0, 9);
    expect(now(m, "crossing:year").K).toBe("0");
    expect(partInfo(m, "crossing:year").sub).toBe("Each year begins on the day Moon reaches its New phase");
    // the year starts on the day the engine says: the crossing day, same day
    expect(m.year.start).toBe(e.start("year", 0));
    expect(m.year.trace.baseStart).toBe(m.year.start);
    // season marks: one per kind, at the days the engine's season calendar resolves
    const marks = m.year.seasons.map((s) => [s.name, s.kind, s.at]);
    const resolved = e.seasonCalendar()!.year(m.year.index, true)!.map((r) => [r.name, r.at]);
    expect(marks.map(([n, , at]) => [n, at])).toEqual(resolved);
    expect(marks.map(([n, k]) => [n, k])).toEqual([["Thaw", "fraction"], ["Bloom", "day"], ["Harvest", "slot"]]);
    expect(m.today.season).toBe(e.seasonAt(30));
    // the two dated marks carry pin heads (four segments each) above the posts' tops
    expect(segs(m, "seasons").filter((s) => Math.max(s.a[1], s.b[1]) > 0.071).length).toBe(8);
    // lamps: lit exactly on the days the engine's own rule holds (and dark on the skipped day)
    let lit = 0;
    for (let d = 0; d < 200; d++) {
      const day = model(LUNAR, d);
      const holds = e.tagsAt(d).includes("full");
      expect(segs(day, "rule:full").some((s) => s.state === "hot"), `D${d}`).toBe(holds);
      expect(row(day, "rule:full").lit).toBe(holds);
      if (holds) lit++;
    }
    expect(lit).toBeGreaterThan(5);
    expect(e.days.holds({ kind: "phase", body: "moon", from: 0, to: 1 }, 100)).toBe(true);
    expect(model(LUNAR, 100).today.rules.get("full")).toBe(false);
    // the skip and the day label are set-screws at their days
    expect(m.year.ledger.map((s) => [s.part, s.kind, s.day])).toEqual([["day:0", "day", 10], ["rule:full", "skip", 100]]);
  });

  test("Levanah (§18.6 item 13): the molad mark sits where the body is at crossing 0, six hours past its phase 0", () => {
    const m = model(LEVANAH, 20708);
    const P = 765_433 / 25_920;
    const mark = crossingMark(LEVANAH, "year")!;
    expect(mark.body).toBe("levanah");
    expect(mark.phase).toBeCloseTo(0.25 / P, 12);
    expect(mark.phase).not.toBe(0);
    const bar = segs(m, "crossing:year")[0]!;
    const mid = [(bar.a[0] + bar.b[0]) / 2, 0, (bar.a[2] + bar.b[2]) / 2];
    expect(mod(angle(mid) - Math.PI, TAU) / TAU).toBeCloseTo(mark.phase, 9);
    expect(now(m, "crossing:year").mark).toBe(`Levanah at phase ${mark.phase.toFixed(6)}`);
    // the body's own phase on the day comes from the engine
    expect(m.today.bodies.get("levanah")).toBe(new Engine(LEVANAH).bodyPhase("levanah", 20708));
    // the dates are Hebrew's: Levanah changes no fact of the calendar
    expect(m.year).toMatchObject({ number: 5787, start: 20708, length: 385 });
  });
});

describe("the model's geometry", () => {
  const cases: Array<[string, CalendarAst, number]> = [
    ["Gregorian", GREGORIAN, 20000],
    ["Hebrew", HEBREW, 20708],
    ["Harptos", HARPTOS, 544795],
    ["Roman", ROMAN, -300000],
    ["Lunar", LUNAR, 30],
    ["Levanah", LEVANAH, 20708],
  ];
  for (const [name, ast, day] of cases)
    test(`${name}: finite points, and every part drawn or picked is a part the calendar has`, () => {
      const m = model(ast, day);
      const parts = new Set<PartId>();
      for (const s of m.segments) {
        expect([...s.a, ...s.b].every(Number.isFinite)).toBe(true);
        if (s.part) parts.add(s.part);
      }
      for (const p of m.picks) parts.add(p.part);
      for (const l of m.labels) if (l.part) parts.add(l.part);
      for (const g of m.groups) for (const r of g.rows) parts.add(r.id);
      for (const p of parts) expect(printPart(ast, p), p).not.toBeNull();
      for (const p of parts) expect(partInfo(m, p).code, p).not.toBe("—");
      expect(partInfo(m, null).now[0]).toEqual({ key: "today", value: m.today.date });
    });

  test("per-year facts are memoised by AST identity and year (§18.3 D7)", () => {
    const a = yearFacts(HEBREW, 5786);
    expect(yearFacts(HEBREW, 5786)).toBe(a);
    expect(model(HEBREW, 20708).year).toBe(a!);
    expect(model(HEBREW, 20800).year).toBe(a!);
    const clone = { ...HEBREW };
    expect(yearFacts(clone, 5786)).not.toBe(a);
    expect(yearFacts(clone, 5786)).toEqual(a);
  });

  test("the fraction of the day turns the crank and the ring; the whole day holds every fact", () => {
    const a = buildOrrery(GREGORIAN, 20000.1) as OrreryModel;
    const b = buildOrrery(GREGORIAN, 20000.9) as OrreryModel;
    expect(a.today).toBe(b.today);
    expect(a.rotation).toBeGreaterThan(b.rotation);
    expect(a.segments.length).toBe(b.segments.length);
  });

  test("the transport day is clamped to the day line", () => {
    const m = buildOrrery(GREGORIAN, 1e12) as OrreryModel;
    expect(m.clamped).toBe(true);
    expect(Math.floor(m.day)).toBe(10_000_000);
    expect((buildOrrery(GREGORIAN, Number.NaN) as OrreryModel).clamped).toBe(true);
  });
});

describe("empty and faulted states", () => {
  test("facts outside the day line, or of a part-day, are null, not a throw", () => {
    expect(yearFacts(HEBREW, 1e9)).toBeNull();
    expect(yearFacts(HEBREW, 0.5)).toBeNull();
    expect(dayFacts(HEBREW, 1e12)).toBeNull();
    expect(dayFacts(HEBREW, 0.5)).toBeNull();
    expect(dayFacts(HEBREW, 20708)!.date).toBe("1 Tishri 5787");
  });

  test("a slots ledger entry: one set-screw on the post in its year, and the engine's months", () => {
    const e = new Engine(ESCAPED);
    const y2 = model(ESCAPED, e.start("year", 2) + 5);
    expect(y2.year.ledger).toEqual([{ part: "ledger:year:0", kind: "slots", tag: "month lengths set" }]);
    expect(y2.year.slots.find((t) => t.unit === "month")!.lengths).toEqual([125, 120, 120]);
    expect(segs(y2, "ledger:year:0").length).toBe(5);
    expect(y2.picks.some((p) => p.part === "ledger:year:0")).toBe(true);
    expect(row(y2, "ledger:year:0").lit).toBe(true);
    expect(now(y2, "ledger:year:0")["this year"]).toBe("applies");
    const y1 = model(ESCAPED, e.start("year", 1) + 5);
    expect(y1.year.ledger.map((s) => s.part)).toEqual([]);
    expect(y1.year.slots.find((t) => t.unit === "month")!.lengths).toEqual([120, 120, 125]);
    expect(segs(y1, "ledger:year:0")).toEqual([]);
    // the escaped names reach the scope as names
    expect(model(ESCAPED, 0).labels.filter((l) => l.part?.startsWith("slot:")).map((l) => l.text)).toEqual(["A,b", "C;d=e", "#x\\y:z"]);
    expect(model(ESCAPED, 3).year.ledger).toEqual([{ part: "day:0", kind: "day", day: 3, tag: "Feast: one, two" }]);
  });

  test("no definition: nothing to draw, never a throw", () => {
    expect(buildOrrery(null, 0)).toEqual({ kind: "empty", reason: "none", message: "no calendar definition", problems: [] });
    expect(buildOrrery(undefined, 0).kind).toBe("empty");
  });

  test("a faulted definition: nothing to draw, with the validator's problems", () => {
    const bad: CalendarAst = { ...GREGORIAN, units: GREGORIAN.units.map((u) => (u.id === "month" && u.kind === "slots" ? { ...u, slots: u.slots.map((s, i) => (i === 0 ? { ...s, length: 100 } : s)) } : u)) };
    const m = buildOrrery(bad, 20000);
    expect(m.kind).toBe("empty");
    if (m.kind !== "empty") return;
    expect(m.reason).toBe("fault");
    expect(m.problems).toEqual(problems(bad));
    expect(m.message).toBe(problems(bad)[0]!.message);
    expect(yearFacts(bad, 0)).toBeNull();
    expect(buildOrrery({} as CalendarAst, 0).kind).toBe("empty");
    expect(buildOrrery({ name: "x", gears: [], units: [] }, 0).kind).toBe("empty");
  });
});

describe("LEDs", () => {
  test("each problem location maps to a part", () => {
    expect(problemPart({ message: "m", unit: "year", entry: 2 })).toBe("ledger:year:2");
    expect(problemPart({ message: "m", unit: "month" })).toBe("unit:month");
    expect(problemPart({ message: "m", gear: "leap" })).toBe("gear:leap");
    expect(problemPart({ message: "m", body: "moon" })).toBe("body:moon");
    expect(problemPart({ message: "m", rule: "full" })).toBe("rule:full");
    expect(problemPart({ message: "m", day: 0 })).toBe("day:0");
    expect(problemPart({ message: "m", code: "V3" })).toBe("calendar");
    const by = problemsByPart([{ message: "a", gear: "leap" }, { message: "b", gear: "leap" }, { message: "c" }]);
    expect(by.get("gear:leap")!.map((p) => p.message)).toEqual(["a", "b"]);
    expect(by.get("calendar")!.length).toBe(1);
  });

  test("real problems land on parts the calendar has, and light the list's rows", () => {
    const bad: CalendarAst = { ...ROMAN, units: ROMAN.units.map((u) => (u.kind === "cycle" ? { ...u, ledger: [...(u.ledger ?? []), { kind: "slots", from: 2000, unit: "month", lengths: [1] }] } : u)) };
    const found = orreryProblems(bad);
    expect(found.length).toBeGreaterThan(0);
    expect(orreryProblems(bad)).toBe(found); // memoised by identity
    for (const p of found) expect(printPart(bad, problemPart(p)), problemPart(p)).not.toBeNull();
    expect(found.some((p) => problemPart(p) === "ledger:year:2")).toBe(true);
    const m = buildOrrery(GREGORIAN, 20000, { problems: [{ message: "x", gear: "leap" }] }) as OrreryModel;
    expect(row(m, "gear:leap").issues).toBe(1);
    expect(row(m, "unit:year").issues).toBe(0);
  });
});

describe("camera, projection and picking", () => {
  const vp = { width: 800, height: 600 };

  test("the camera target projects to the centre at the camera's distance", () => {
    for (const cam of Object.values(VIEWS)) {
      const q = project(cam, vp, [0, CAMERA.targetY, 0])!;
      expect(q.x).toBeCloseTo(400, 9);
      expect(q.y).toBeCloseTo(300, 9);
      expect(q.depth).toBeCloseTo(cam.dist, 9);
    }
    // up is up on screen; behind the near plane is nothing
    expect(project(VIEWS.side, vp, [0, 1, 0])!.y).toBeLessThan(300);
    const behind = { ...VIEWS.side, pitch: 0, yaw: 0 };
    expect(project(behind, vp, [0, CAMERA.targetY, behind.dist])).toBeNull();
  });

  test("the nearest pick within 13 px wins", () => {
    const cam = VIEWS.top;
    const picks: PickPoint[] = [
      { p: [0, CAMERA.targetY, 0], part: "dayline" },
      { p: [0.05, CAMERA.targetY, 0], part: "seasons" },
    ];
    const a = project(cam, vp, picks[0]!.p)!;
    const b = project(cam, vp, picks[1]!.p)!;
    expect(pickPart(picks, cam, vp, a.x + 1, a.y)).toBe("dayline");
    expect(pickPart(picks, cam, vp, b.x - 1, b.y)).toBe("seasons");
    expect(pickPart(picks, cam, vp, a.x, a.y + 12.9)).toBe("dayline");
    expect(pickPart(picks, cam, vp, a.x, a.y + 13.1)).toBeNull();
  });

  test("picking the model: each pick point picks a part drawn at that spot", () => {
    const m = model(HEBREW, 20708);
    const cam = VIEWS.iso;
    for (const pk of m.picks.filter((_, i) => i % 7 === 0)) {
      const q = project(cam, vp, pk.p);
      if (!q) continue;
      const got = pickPart(m.picks, cam, vp, q.x, q.y)!;
      const at = m.picks.filter((x) => x.part === got).map((x) => project(cam, vp, x.p)).filter((x) => x !== null);
      expect(at.some((x) => Math.hypot(x.x - q.x, x.y - q.y) < 1e-6)).toBe(true);
    }
  });

  test("orbit, zoom and easing stay in range and arrive", () => {
    expect(orbit(VIEWS.iso, 0, 1e6).pitch).toBe(CAMERA.pitchMax);
    expect(orbit(VIEWS.iso, 0, -1e6).pitch).toBe(CAMERA.pitchMin);
    expect(orbit(VIEWS.iso, 100, 0).yaw).toBeCloseTo(0.32 - 0.8, 12);
    expect(zoom(VIEWS.iso, 1e6).dist).toBe(CAMERA.distMax);
    expect(zoom(VIEWS.iso, -1e6).dist).toBe(CAMERA.distMin);
    let cam = VIEWS.iso;
    let moving = true;
    for (let i = 0; i < 300 && moving; i++) ({ camera: cam, moving } = easeCamera(cam, VIEWS.top, 1 / 60));
    expect(moving).toBe(false);
    expect(cam).toEqual(VIEWS.top);
  });

  test("selection promotes to sel (a unit's slots with it); problems to err", () => {
    const s = { a: [0, 0, 0], b: [1, 0, 0], state: "line", part: "slot:month:3" } as const;
    expect(paintState(s, { selected: "unit:month", hover: null })).toBe("sel");
    expect(paintState(s, { selected: null, hover: "slot:month:3" })).toBe("sel");
    expect(paintState(s, { selected: null, hover: null, errors: new Set<PartId>(["slot:month:3"]) })).toBe("err");
    expect(paintState({ ...s, state: "grid" }, { selected: "slot:month:3", hover: null })).toBe("grid");
  });

  test("labels: the index date places first; selected-only labels wait for their part", () => {
    const m = model(HARPTOS, 544795);
    const measure = (t: string) => t.length * 7;
    const placed = layoutLabels(m.labels, VIEWS.iso, vp, { selected: null, hover: null }, measure);
    expect(placed[0]!.text).toBe(m.today.date);
    expect(placed[0]!.part).toBe("dayline");
    const ghost = m.labels.filter((l) => l.onlySelected);
    expect(ghost.length).toBeGreaterThan(0);
    for (const g of ghost) expect(placed.some((p) => p.part === g.part && p.text === g.text)).toBe(false);
    const sel = layoutLabels(m.labels, VIEWS.iso, vp, { selected: ghost[0]!.part, hover: null }, measure);
    expect(sel.some((p) => p.part === ghost[0]!.part && p.state === "sel")).toBe(true);
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const [a, b] = [placed[i]!, placed[j]!];
        // a small label placed later never overlaps an earlier one's plate (padded 2 px across, 1 px down)
        if (!b.big) expect(b.x < a.x + a.w + 2 && b.x + b.w > a.x - 2 && b.y < a.y + a.h + 1 && b.y + b.h > a.y - 1).toBe(false);
      }
  });
});
