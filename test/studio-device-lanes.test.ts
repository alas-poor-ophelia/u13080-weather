/**
 * `model/device-lanes.ts` — the binding between a `Modifier` and the one Lane
 * that draws it (SPEC §4). `spans.ts` already owns the per-shape span
 * arithmetic and has its own walk, so this file checks the three questions
 * this module actually answers: which devices earn a lane, what shape and
 * label the lane has, and what a drag on an editable clip writes back.
 */
import { describe, expect, test } from "bun:test";
import type { Modifier } from "../src/core/types";
import { dragToWhen, hasLane, laneCaption, laneSpec, laneSub, spellRunsKey } from "../src/studio/model/device-lanes";
import { toDevice } from "../src/studio/model/devices";
import type { CalendarDescription } from "../src/plugin/time/adapter";
import { DEVICE_LANE_HINTS, DEVICE_LANE_HINT_KEYS, deviceLaneHint, deviceLaneTip, deviceSpanHintKey } from "../src/studio/model/hints-device-lanes";
import { HINT_SEPARATOR, parseHint } from "../src/studio/model/hints";
import type { Span } from "../src/studio/model/lanes";
import type { Era } from "../src/core/types";
import type { SpanCalendar } from "../src/studio/model/spans";

const CAL: SpanCalendar = {
  yearLength: 360,
  epochYear: 1,
  seasons: [
    { name: "Spring", from: 0 },
    { name: "Summer", from: 0.25 },
    { name: "Harvest", from: 0.5 },
    { name: "Winter", from: 0.75 },
  ],
  moons: [{ name: "Sable", cycleDays: 30, phaseAtEpoch: 0 }],
  eras: [{ name: "Ice Age", from: 2, to: 6 }],
};

/** A device is any modifier the studio did not compile; `apply` is never empty in a valid draft. */
function device(id: string, extra: Partial<Modifier> = {}): Modifier {
  return { id, stage: "daily", apply: [{ param: "temperature.mean", op: "offset", value: 1 }], ...extra };
}

const YEAR_3 = { a: 3, b: 4 };

describe("device lanes · hasLane", () => {
  test("a timed predicate earns a lane", () => {
    expect(hasLane(device("a", { when: { yearPhase: [0.6, 0.7] } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { dayOfYear: [10, 20] } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { moon: { name: "Sable", phase: [0, 0.1] } } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { tag: "season:Winter" } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { tag: "era:Ice Age" } }), CAL.eras)).toBe(true);
  });

  test("always, chance, regime and a foreign tag get no lane (SPEC §4)", () => {
    expect(hasLane(device("a"), CAL.eras)).toBe(false);
    expect(hasLane(device("a", { when: { chance: 0.2 } }), CAL.eras)).toBe(false);
    expect(hasLane(device("a", { when: { regime: "Storm" } }), CAL.eras)).toBe(false);
    expect(hasLane(device("a", { when: { tag: "spell:ashfall" } }), CAL.eras)).toBe(false);
  });

  test("a composite is timed when ANY leaf is — an untimed leaf is ignored, not fatal", () => {
    expect(hasLane(device("a", { when: { all: [{ tag: "season:Winter" }, { chance: 0.2 }] } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { any: [{ chance: 0.2 }, { regime: "Storm" }] } }), CAL.eras)).toBe(false);
    expect(hasLane(device("a", { when: { not: { moon: { name: "Sable", phase: [0, 0.1] } } } }), CAL.eras)).toBe(true);
    expect(hasLane(device("a", { when: { not: { chance: 0.2 } } }), CAL.eras)).toBe(false);
  });

  test("an `era:` tag naming an era the world does not have earns NO lane (Neverain)", () => {
    const neverain = device("neverain", { when: { tag: "era:Drought" }, enabled: false });
    expect(hasLane(neverain, CAL.eras)).toBe(false);
    // The same device in a world that HAS the era is a bar like any other.
    expect(hasLane(neverain, [{ name: "Drought", from: 4, to: 9 }])).toBe(true);
    // A disabled era tags nothing, so it places nothing either.
    expect(hasLane(neverain, [{ name: "Drought", from: 4, to: 9, enabled: false }])).toBe(false);
    expect(laneSpec(neverain, CAL, YEAR_3)).toEqual({ spans: [], editable: false, kind: "none", label: "neverain" });
  });

  test("a spell is a timeline even with no when", () => {
    expect(hasLane(device("a", { spell: { meanStartsPerYear: 2, meanDurationDays: 5 } }), CAL.eras)).toBe(true);
  });
});

describe("device lanes · laneSpec", () => {
  test("a yearPhase device is one editable clip per year, labelled with the device's name", () => {
    const spec = laneSpec(device("Ashfall", { when: { yearPhase: [0.6, 0.7] } }), CAL, { a: 3, b: 6 });
    expect(spec.kind).toBe("clip");
    expect(spec.editable).toBe(true);
    expect(spec.label).toBe("Ashfall");
    expect(spec.spans.map((s) => s.id)).toEqual(["yp:3", "yp:4", "yp:5"]);
    expect(spec.spans.every((s) => s.editable)).toBe(true);
  });

  test("a device with no lane answers with nothing at all, and still names itself", () => {
    const spec = laneSpec(device("Drizzle", { when: { chance: 0.2 } }), CAL, YEAR_3);
    expect(spec).toEqual({ spans: [], editable: false, kind: "none", label: "Drizzle" });
  });

  test("a season tag is a read-only band; an era tag is a read-only bar at Year zoom", () => {
    const band = laneSpec(device("Frost", { when: { tag: "season:Winter" } }), CAL, YEAR_3);
    expect(band.kind).toBe("band");
    expect(band.editable).toBe(false);

    const bar = laneSpec(device("Cold", { when: { tag: "era:Ice Age" } }), CAL, YEAR_3);
    expect(bar.kind).toBe("bar");
    expect(bar.editable).toBe(false);
  });

  test("an era tag is a clip at Era zoom — the kind follows the spans the window produced", () => {
    const spec = laneSpec(device("Cold", { when: { tag: "era:Ice Age" } }), CAL, { a: 0, b: 40 });
    expect(spec.kind).toBe("clip");
    expect(spec.editable).toBe(false);
  });

  test("a moon device is pulses, and a gate at amount 0 dims the ones it mutes", () => {
    const m = device("Stormtide", {
      when: { moon: { name: "Sable", phase: [0, 0.1] } },
      mods: [{ source: "season:Winter", amount: 0 }],
    });
    const spec = laneSpec(m, CAL, YEAR_3);
    expect(spec.kind).toBe("pulse");
    expect(spec.editable).toBe(false);
    expect(spec.spans.length).toBeGreaterThan(0);
    expect(spec.spans.every((s) => s.kind === "pulse")).toBe(true);
    // Winter is the last quarter of the year; the pulses in it are the dim ones.
    expect(spec.spans.some((s) => s.dim === true)).toBe(true);
    expect(spec.spans.some((s) => s.dim !== true)).toBe(true);
    for (const s of spec.spans) expect(s.dim === true).toBe((s.from + s.to) / 2 - 3 >= 0.75);
  });

  test("a composite is one stacked window row, never editable", () => {
    const spec = laneSpec(device("Both", { when: { all: [{ tag: "season:Winter" }, { yearPhase: [0.8, 0.9] }] } }), CAL, YEAR_3);
    expect(spec.kind).toBe("window");
    expect(spec.editable).toBe(false);
  });

  test("a spell draws its when dashed and appends the roll's solid runs", () => {
    const m = device("Spell", { when: { yearPhase: [0.2, 0.8] }, spell: { meanStartsPerYear: 4, meanDurationDays: 5 } });
    // `dayOrdinalAt(3, CAL)` — fractional year 3 is day (3 − epochYear) · 360.
    const base = 720;
    // Two runs inside year 3: days [base + 100 … +102] and a single day later.
    const days = [];
    for (let d = base; d < base + 360; d++) days.push({ dayOrdinal: d, active: (d >= base + 100 && d <= base + 102) || d === base + 200 });
    const spec = laneSpec(m, CAL, YEAR_3, days);

    expect(spec.kind).toBe("window");
    const windows = spec.spans.filter((s) => s.kind === "window");
    const runs = spec.spans.filter((s) => s.kind === "run");
    expect(windows.length).toBe(1);
    expect(runs.length).toBe(2);
    // The `when` clip stays draggable even drawn dashed (`spans.ts`'s contract).
    expect(spec.editable).toBe(true);
    expect(runs[0]!.from).toBeCloseTo(3 + 100 / 360, 9);
    expect(runs[0]!.to).toBeCloseTo(3 + 103 / 360, 9);
    expect(runs.every((s) => s.editable === false)).toBe(true);
  });

  test("without activeDays a spell is the dashed window alone", () => {
    const m = device("Spell", { when: { yearPhase: [0.2, 0.8] }, spell: { meanStartsPerYear: 4, meanDurationDays: 5 } });
    expect(laneSpec(m, CAL, YEAR_3).spans.map((s) => s.kind)).toEqual(["window"]);
  });

  test("past maxSpans the lane is the overflow bar, and it is still not editable", () => {
    const spec = laneSpec(device("Ashfall", { when: { yearPhase: [0.6, 0.7] } }), CAL, { a: 0, b: 1000 });
    expect(spec.spans.map((s) => s.id)).toEqual(["many"]);
    expect(spec.kind).toBe("bar");
    expect(spec.editable).toBe(false);
  });
});

describe("device lanes · dragToWhen", () => {
  const clip = (year: number, from: number, to: number): Span => ({ id: `yp:${year}`, from, to, kind: "clip", editable: true });

  test("a yearPhase clip's new edges become the new phase range", () => {
    const m = device("Ashfall", { when: { yearPhase: [0.6, 0.7] } });
    const next = dragToWhen(m, clip(3, 3.6, 3.7), 3.6, 3.82, CAL);
    expect(next).not.toBeNull();
    expect(next!.when).toEqual({ yearPhase: [0.6, 0.82] });
    // A new object: the draft is replaced, never mutated under the store.
    expect(next).not.toBe(m);
    expect(m.when).toEqual({ yearPhase: [0.6, 0.7] });
  });

  test("the year comes from the span's id, so a clip dragged over new year still writes its own year", () => {
    const m = device("Ashfall", { when: { yearPhase: [0.9, 0.95] } });
    const next = dragToWhen(m, clip(3, 3.9, 3.95), 3.95, 4.05, CAL);
    expect(next!.when).toEqual({ yearPhase: [0.95, 0.05] });
  });

  test("a clip dragged out to a whole year writes the full circle, never the engine's `never`", () => {
    const m = device("Ashfall", { when: { yearPhase: [0.6, 0.7] } });
    expect(dragToWhen(m, clip(3, 3.6, 3.7), 3, 4, CAL)!.when).toEqual({ yearPhase: [0, 1] });
  });

  test("a dayOfYear clip is inclusive at both ends", () => {
    const m = device("Ashfall", { when: { dayOfYear: [100, 110] } });
    const span: Span = { id: "doy:3", from: 3 + 100 / 360, to: 3 + 111 / 360, kind: "clip", editable: true };
    const next = dragToWhen(m, span, 3 + 100 / 360, 3 + 121 / 360, CAL);
    expect(next!.when).toEqual({ dayOfYear: [100, 120] });
  });

  test("a dayOfYear drag is clamped into the year and refused when it would invert", () => {
    const m = device("Ashfall", { when: { dayOfYear: [100, 110] } });
    const span: Span = { id: "doy:3", from: 3, to: 4, kind: "clip", editable: true };
    expect(dragToWhen(m, span, 2.5, 4.5, CAL)!.when).toEqual({ dayOfYear: [0, 359] });
  });

  test("every read-only shape refuses the drag (SPEC §4 sends the edit elsewhere)", () => {
    const cases: Array<Modifier> = [
      device("a", { when: { tag: "season:Winter" } }),
      device("a", { when: { tag: "era:Ice Age" } }),
      device("a", { when: { moon: { name: "Sable", phase: [0, 0.1] } } }),
      device("a", { when: { all: [{ tag: "season:Winter" }, { yearPhase: [0.1, 0.2] }] } }),
      device("a"),
    ];
    for (const m of cases) expect(dragToWhen(m, clip(3, 3.6, 3.7), 3.6, 3.8, CAL)).toBeNull();
  });

  test("a span that is not a per-year clip, and a degenerate drag, write nothing", () => {
    const m = device("Ashfall", { when: { yearPhase: [0.6, 0.7] } });
    const foreign: Span = { id: "many", from: 3, to: 4, kind: "bar", editable: false };
    expect(dragToWhen(m, foreign, 3.6, 3.8, CAL)).toBeNull();
    expect(dragToWhen(m, clip(3, 3.6, 3.7), 3.6, 3.6, CAL)).toBeNull();
  });
});

describe("device lane hints", () => {
  test("DEVICE_LANE_HINT_KEYS and DEVICE_LANE_HINTS describe exactly the same set", () => {
    expect([...DEVICE_LANE_HINT_KEYS].sort()).toEqual(Object.keys(DEVICE_LANE_HINTS).sort());
  });

  test("every entry follows the house rules: non-empty, sentence case, no trailing full stop", () => {
    for (const key of DEVICE_LANE_HINT_KEYS) {
      const [name, detail] = DEVICE_LANE_HINTS[key]!;
      expect(name).not.toBe("");
      expect(name.endsWith(".")).toBe(false);
      expect(detail.endsWith(".")).toBe(false);
      expect(name[0]).toBe(name[0]!.toUpperCase());
    }
  });

  test("every SPEC §4 shape has a hint, keyed by the `data-kind` the Lane writes", () => {
    for (const kind of ["clip", "pulse", "band", "bar", "window", "run"]) expect(deviceSpanHintKey(kind)).toBe(`lane.device.${kind}`);
    // An unknown kind falls back to the lane's own hint rather than a raw key.
    expect(deviceSpanHintKey("nope")).toBe("lane.device.lane");
  });

  test("deviceLaneHint joins the pair the way the hint bar parses it, and passes an unknown key through", () => {
    expect(parseHint(deviceLaneHint("lane.device.clip"))).toEqual(DEVICE_LANE_HINTS["lane.device.clip"]!);
    expect(deviceLaneHint("lane.device.clip")).toContain(HINT_SEPARATOR);
    expect(deviceLaneHint("lane.device.nope")).toBe("lane.device.nope");
  });

  test("the row's own tip names the device and reads its when-summary", () => {
    expect(parseHint(deviceLaneTip("Ashfall", "days 216–251"))).toEqual(["Ashfall", "days 216–251"]);
    expect(deviceLaneTip("Ashfall", "")).toBe("Ashfall");
  });
});

/* ── spellRunsKey (bead wadjet-9f9.45) ──────────────────────────────────── */

describe("spellRunsKey", () => {
  const ERAS: Era[] = [{ name: "Ice Age", from: 2, to: 6 }];
  const SPELL: Modifier = device("ashfall", { when: { yearPhase: [0.2, 0.8] }, spell: { meanStartsPerYear: 4, meanDurationDays: 5 } });
  const base = { modifier: SPELL, eras: ERAS, seed: "world-seed", salt: 0, firstYear: 1962, years: 1 };

  test("the same inputs give the same key", () => {
    expect(spellRunsKey(base)).toBe(spellRunsKey({ ...base, modifier: structuredClone(SPELL), eras: structuredClone(ERAS) }));
  });

  test("key order inside the modifier does not change the key (canonical JSON)", () => {
    const reordered: Modifier = {
      spell: { meanStartsPerYear: 4, meanDurationDays: 5 },
      when: { yearPhase: [0.2, 0.8] },
      apply: [{ param: "temperature.mean", op: "offset", value: 1 }],
      stage: "daily",
      id: "ashfall",
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(SPELL));
    expect(spellRunsKey({ ...base, modifier: reordered })).toBe(spellRunsKey(base));
  });

  test("editing the modifier's CONTENT changes the key, not just its id (H-1391)", () => {
    const rarer = structuredClone(SPELL);
    rarer.spell!.meanStartsPerYear = 12;
    expect(rarer.id).toBe(SPELL.id);
    expect(spellRunsKey({ ...base, modifier: rarer })).not.toBe(spellRunsKey(base));
  });

  test("editing an era's span changes the key, even though the era COUNT is unchanged", () => {
    const moved: Era[] = [{ name: "Ice Age", from: 3, to: 6 }];
    expect(moved.length).toBe(ERAS.length);
    expect(spellRunsKey({ ...base, eras: moved })).not.toBe(spellRunsKey(base));
  });

  test("seed, salt, first year and span each move the key", () => {
    const keys = new Set([
      spellRunsKey(base),
      spellRunsKey({ ...base, seed: "other" }),
      spellRunsKey({ ...base, salt: 1 }),
      spellRunsKey({ ...base, firstYear: 1963 }),
      spellRunsKey({ ...base, years: 2 }),
    ]);
    expect(keys.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The lane label's second line (bead wadjet-6rw.2)
// ---------------------------------------------------------------------------

describe("device lanes · laneCaption", () => {
  const DESCRIBED: CalendarDescription = {
    label: "Test",
    readOnly: false,
    yearLength: 360,
    epochYear: 1,
    seasons: CAL.seasons.map((s) => ({ ...s })),
    moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0, phases: [{ name: "Full", at: 0.86 }, { name: "New", at: 0 }] }],
  };
  const cal = { ...CAL, moons: [{ name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0 }] };
  const caption = (m: Modifier): string => laneCaption(toDevice(m, DESCRIBED), cal);

  test("a moon lane says which moon, which phase and how long the cycle is", () => {
    expect(caption(device("m", { when: { moon: { name: "Sable", phase: [0.86, 1] } } }))).toBe("sable full ↻ 29.5 d");
  });

  test("a mod gate is named in the caption, in product copy", () => {
    const m = device("m", { when: { moon: { name: "Sable", phase: [0.86, 1] } }, mods: [{ source: "season:Harvest", amount: 1 }] });
    expect(caption(m)).toBe("sable full ↻ 29.5 d · gated by Harvest");
  });

  test("a muted gate (amount 0) is not claimed as a gate", () => {
    const m = device("m", { when: { moon: { name: "Sable", phase: [0.86, 1] } }, mods: [{ source: "season:Harvest", amount: 0 }] });
    expect(caption(m)).toBe("sable full ↻ 29.5 d");
  });

  test("every other lane shape has no caption of its own", () => {
    expect(caption(device("c", { when: { dayOfYear: [223, 263] } }))).toBe("");
    expect(caption(device("t", { when: { tag: "era:Ice Age" } }))).toBe("");
    expect(caption(device("a"))).toBe("");
  });
});

describe("device lanes · laneSub", () => {
  test("a moon lane names the cycle its pulses follow", () => {
    expect(laneSub(device("m", { when: { moon: { name: "Sable", phase: [0.8, 1] } } }), CAL)).toBe("active days · ↻ 30 d");
  });

  test("a moon the calendar does not describe still says what the lane IS", () => {
    expect(laneSub(device("m", { when: { moon: { name: "Ghost", phase: [0, 0.2] } } }), CAL)).toBe("active days");
  });

  test("a yearly clip says which days it covers, and that it repeats", () => {
    expect(laneSub(device("c", { when: { dayOfYear: [223, 263] } }), CAL)).toBe("clip d223–263 · yearly");
  });

  test("a yearPhase clip is read in days, on the calendar's own year length", () => {
    expect(laneSub(device("c", { when: { yearPhase: [0.5, 0.75] } }), CAL)).toBe("clip d180–270 · yearly");
  });

  test("it reads the PREDICATE, not the spans, so it is the same at every zoom", () => {
    const m = device("c", { when: { dayOfYear: [223, 263] } });
    expect(laneSub(m, CAL)).toBe(laneSub(m, CAL));
    // A month-wide window shows no clip at all; the label still names one.
    expect(laneSpec(m, CAL, { a: 3.05, b: 3.13 }).spans.some((s) => s.kind === "clip")).toBe(false);
    expect(laneSub(m, CAL)).toBe("clip d223–263 · yearly");
  });

  test("a season or era lane names the tag it is gated on", () => {
    expect(laneSub(device("t", { when: { tag: "season:Harvest" } }), CAL)).toBe("season:Harvest");
    expect(laneSub(device("t", { when: { tag: "era:Ice Age" } }), CAL)).toBe("era:Ice Age");
  });

  test("a composite reads its first TIMED leaf, ignoring the untimed ones", () => {
    expect(laneSub(device("g", { when: { all: [{ chance: 0.2 }, { dayOfYear: [10, 20] }] } }), CAL)).toBe("clip d10–20 · yearly");
  });

  test("a spell with no time in its `when` says what its runs are", () => {
    expect(laneSub(device("s", { spell: { meanStartsPerYear: 0.6, meanDurationDays: 18 } }), CAL)).toBe("spell · 18 d runs");
  });

  test("a device with neither says only that the lane is active days", () => {
    expect(laneSub(device("x"), CAL)).toBe("active days");
  });
});
