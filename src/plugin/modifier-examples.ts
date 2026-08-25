/**
 * The modifier grammar as shown inside the zone editor, and the copy-paste
 * examples (DESIGN-v1.md §3). Pure: no Obsidian imports, unit-tested for
 * validity against a real preset zone.
 */
import { CURVE_PATHS, SCALAR_PATHS } from "../core/curve-ops";
import type { Modifier } from "../core/types";

export interface ModifierExample {
  title: string;
  /** one sentence of what it does and what it needs */
  blurb: string;
  modifier: Modifier;
}

export const MODIFIER_EXAMPLES: readonly ModifierExample[] = [
  {
    title: "Stormtide under a full moon",
    blurb: "Wetter and windier while the moon named Sable is near full. Needs a moon called Sable in Settings → Calendar.",
    modifier: {
      id: "sable-stormtide",
      stage: "daily",
      when: { moon: { name: "Sable", phase: [0.88, 1.0] } },
      apply: [
        { param: "precipitation.pwd", op: "scale", value: 1.5 },
        { param: "wind.speed", op: "offset", value: 12 },
      ],
      tag: "stormtide",
    },
  },
  {
    title: "Ashfall spells",
    blurb: "Dry, dark runs of days: about one spell a year in late summer, lasting a couple of weeks.",
    modifier: {
      id: "ashfall",
      stage: "daily",
      when: { yearPhase: [0.61, 0.72] },
      spell: { meanStartsPerYear: 0.6, meanDurationDays: 18 },
      apply: [
        { param: "precipitation.pwd", op: "set", value: 0 },
        { param: "precipitation.pww", op: "set", value: 0 },
        { param: "cloud.dry", op: "set", value: 0.95 },
      ],
      tag: "ashfall",
    },
  },
  {
    title: "Dark-moon calm",
    blurb: "Clearer, stiller and drier around the new moon. Needs a moon called Sable in Settings → Calendar.",
    modifier: {
      id: "dark-calm",
      stage: "daily",
      when: { moon: { name: "Sable", phase: [0.94, 0.06] } },
      apply: [
        { param: "wind.speed", op: "scale", value: 0.5 },
        { param: "cloud.dry", op: "scale", value: 0.5 },
        { param: "precipitation.pwd", op: "scale", value: 0.6 },
      ],
      tag: "dark-calm",
    },
  },
  {
    title: "The valley where it never rains",
    blurb: "A climate-stage curse: no rain, ever, and dry air. Rewrites the zone's curves once rather than acting per day.",
    modifier: {
      id: "never-rains",
      stage: "climate",
      apply: [
        { param: "precipitation.pwd", op: "set", value: 0 },
        { param: "precipitation.pww", op: "set", value: 0 },
        { param: "humidity.dry", op: "clamp", max: 0.3 },
      ],
      tag: "cursed-dry",
    },
  },
  {
    title: "Sky-fire (flavour only)",
    blurb: "About one day in fifty, outside wet spells, the card says sky-fire and nothing else changes. The shape for omens and auroras.",
    modifier: {
      id: "sky-fire",
      stage: "daily",
      when: { all: [{ chance: 0.02 }, { not: { regime: "wet-spell" } }] },
      apply: [],
      tag: "sky-fire",
    },
  },
];

/** Plain-text grammar card: one entry per line group. */
export const MODIFIER_GRAMMAR: ReadonlyArray<{ heading: string; lines: string[] }> = [
  {
    heading: "Shape",
    lines: [
      '{ "id": "…", "stage": "daily", "when": <predicate>, "spell": { … }, "apply": [ <op>, … ], "tag": "…" }',
      "stage: daily (default) applies per day when `when` holds; climate edits the curves once, unconditionally.",
      "Lines below are annotated with // comments; the editor accepts them, so paste freely.",
      "tag: added to the day's conditions while the modifier is active — useful on its own for flavour.",
    ],
  },
  {
    heading: "Predicates (when)",
    lines: [
      '{ "moon": { "name": "Sable", "phase": [0.88, 1.0] } }   // phase 0 = new, 0.5 = full; ranges wrap',
      '{ "yearPhase": [0.61, 0.72] }   // 0 = start of the year; ranges wrap',
      '{ "dayOfYear": [150, 200] }   // inclusive',
      '{ "tag": "season:Winter" }   // a calendar tag (season:…, era:…) or one set by another modifier',
      '{ "regime": "<regime id>" }   // the background pattern in force today',
      '{ "chance": 0.05 }   // seeded per day: a 5% freak day',
      '{ "all": [ … ] }   { "any": [ … ] }   { "not": <predicate> }   // combine',
    ],
  },
  {
    heading: "Ops (apply)",
    lines: [
      '{ "param": "wind.speed", "op": "offset", "value": 12 }',
      'op: set · offset · scale · clamp (with "min" / "max"). Applied in list order.',
    ],
  },
  {
    heading: "Params",
    lines: [`curves: ${CURVE_PATHS.join(", ")}`, `scalars: ${SCALAR_PATHS.join(", ")}`],
  },
  {
    heading: "Which one?",
    lines: ["A single freak day → chance. A run of days → spell (meanStartsPerYear, meanDurationDays). Always-on background → a regime. A whole age of the world → an era (Settings → Calendar). More recipes: docs/EXAMPLES.md."],
  },
];
