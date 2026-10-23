/**
 * Dense golden of the PREVIOUS generator, wadjet-gen/0.0.3 (docs/SESHAT-v0.md
 * §17.5 item 2, bead wadjet-9lc step 1a). Writes test/golden/previous/dense.json.gz:
 * the JSON, gzipped with Bun.gzipSync (14 MB of JSON is about 0.7 MB gzipped);
 * test/golden-previous.test.ts reads it back with Bun.gunzipSync.
 *
 * THIS SCRIPT RUNS ONLY INSIDE A GIT WORKTREE OF c773f5d^ (80861d7), the last
 * commit that ran 0.0.3. Its relative imports must resolve to THAT commit's
 * src/, so it is copied into the worktree and run there. It refuses to run
 * when GENERATOR_VERSION is not wadjet-gen/0.0.3. At HEAD it is type-checked
 * and linted like every other script (it imports only APIs that exist with the
 * same shape at both commits) but never run, built or tested.
 *
 * Regenerate (from the repo root; the worktree sits inside the repo so
 * node_modules resolves upward):
 *
 *   git worktree add .tmp-oracle-003 c773f5d^
 *   cp scripts/golden-previous.ts .tmp-oracle-003/scripts/
 *   (cd .tmp-oracle-003 && bun run scripts/golden-previous.ts ../test/golden/previous/dense.json.gz)
 *   git worktree remove --force .tmp-oracle-003
 *
 * The output is deterministic: rerunning it must give a byte-identical file
 * (Bun's gzip header carries no timestamp).
 *
 * Every fixture is stored AS DATA (seed, calendar config or adapter
 * description, eras, full zone profiles) so HEAD can rebuild identical worlds
 * with its own API. Reports are stored without `provenance`, which is
 * constant per zone and stored once (the dump asserts that). The comparison
 * form is `JSON.stringify(report without provenance)`; stored reports
 * round-trip through JSON.parse/JSON.stringify unchanged (asserted below).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Era, Modifier, ZoneProfile } from "../src/core/types";
import type { WeatherReport } from "../src/core/report";
import { GENERATOR_VERSION, RNG_VERSION } from "../src/core/version";
import { TimeRegistry, type TimeAdapter, type TimeContext } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import type { InternalCalendarConfig } from "../src/plugin/settings";
import { World } from "../src/plugin/world";
import { PRESETS } from "../src/generated/presets";
import { makeAdapter } from "../test/fixtures/api/third-party-calendar";

const EXPECTED = "wadjet-gen/0.0.3";
const SEED = "golden-previous-seed";
const FROM = -400;
const TO = 1800;
/** hourly reports (hours 0..23) on every HOURLY_EVERY-th day, plus every edge day and the day after it */
const HOURLY_EVERY = 21;
/** yearPhase edges: k/Y is exactly 0.2 or 0.4 for Y = 360, 365, 400, and the old wrap puts it an ulp low */
const EDGES = [0.2, 0.4];

type Calendar = { kind: "internal"; config: InternalCalendarConfig } | { kind: "almanac"; noYearLength: boolean };

interface Fixture {
  id: string;
  calendar: Calendar;
  eras: Era[];
  zones: ZoneProfile[];
}

const FOUR = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

/** Tick: a 10-day moon with phase 0, so phases 0.2 / 0.4 fall on whole days (and 12/10 % 1 lands low). Sable: 29.53 days. */
const MOONS: InternalCalendarConfig["moons"] = [
  { name: "Tick", cycleDays: 10, phaseAtEpoch: 0 },
  { name: "Sable", cycleDays: 29.53, phaseAtEpoch: 0.5 },
];

/** Dawn covers year 1 (the old spell window's reference year); Thaw lies after it; Ash applies ops. */
const ERAS: Era[] = [
  { name: "Dawn", from: 1, to: 2 },
  { name: "Thaw", from: 3, to: 5, apply: [{ param: "temperature.mean", op: "offset", value: 1.5 }] },
  { name: "Ash", from: -1, to: 0, apply: [{ param: "temperature.mean", op: "offset", value: -2 }] },
];

/**
 * `edgeMoon` carries the edge-aligned moon window; `envMoon` the moon-envelope modifier; `summer` and
 * `winter` are season names the calendar actually has (the almanac's are Dry and Wet).
 */
function modifiers(edgeMoon: string, envMoon: string, summer: string, winter: string): Modifier[] {
  return [
    // edge-aligned yearPhase window: day 73/146 of 365, 72/144 of 360, 80/160 of 400
    { id: "yp-edge", when: { yearPhase: [0.2, 0.4] }, apply: [{ param: "temperature.mean", op: "offset", value: 4 }], tag: "yp-edge" },
    // edge-aligned moon window
    { id: "moon-edge", when: { moon: { name: edgeMoon, phase: [0.2, 0.4] } }, apply: [{ param: "wind.speed", op: "offset", value: 10 }], tag: "moon-edge" },
    // moon envelope (sampleEnvelope at the named moon's phase)
    {
      id: "moon-env",
      when: { moon: { name: envMoon, phase: [0.3, 0.7] } },
      apply: [
        { param: "wind.speed", op: "offset", value: 12, envelope: [[0.3, 0], [0.5, 1], [0.7, 0]] },
        { param: "cloud.dry", op: "offset", value: 0.3, envelope: [[0.3, 0], [0.5, 1], [0.7, 0]] },
      ],
      tag: "moon-env",
    },
    // sampleEnvelope's own wrap: a point one ulp below 0.2 then 0 at 0.2. At an exact phase 0.2 the old
    // wrap lands below the first point and reads the wrapping segment (strength 1); 0.0.4 reads 0.
    // (moon-env above is the natural case: envelopes are continuous, so an ulp-low phase is hidden by rounding.)
    {
      id: "env-edge",
      when: { moon: { name: edgeMoon, phase: [0.1, 0.3] } },
      apply: [{ param: "wind.speed", op: "offset", value: 15, envelope: [[0.19999999999999998, 1], [0.2, 0], [0.6, 1]] }],
      tag: "env-edge",
    },
    // yearPhase window with a nontrivial envelope (carrier = the day's first moon, edge-aligned points)
    {
      id: "yp-env",
      when: { yearPhase: [0.6, 0.9] },
      apply: [{ param: "temperature.mean", op: "offset", value: -5, envelope: [[0.2, 0], [0.4, 1], [0.8, 0.25]] }],
      tag: "yp-env",
    },
    // a spell gated on `not regime`: the old estimate strips the regime to true, so the window is empty → 365
    { id: "not-regime", when: { all: [{ yearPhase: [0.45, 0.75] }, { not: { regime: "wet-spell" } }] }, spell: { meanStartsPerYear: 4, meanDurationDays: 5 }, apply: [{ param: "precipitation.pwd", op: "scale", value: 0.3 }, { param: "cloud.dry", op: "offset", value: -0.2 }], tag: "not-regime" },
    // a spell gated on `not era:Dawn`: Dawn covers the old reference year, so the old window is empty → 365
    { id: "not-era", when: { all: [{ tag: `season:${summer}` }, { not: { tag: "era:Dawn" } }] }, spell: { meanStartsPerYear: 6, meanDurationDays: 4 }, apply: [{ param: "temperature.mean", op: "offset", value: -3 }], tag: "not-era" },
    // an era-gated spell: Thaw is not in the old reference year, so the old window is empty → 365
    { id: "era-spell", when: { all: [{ tag: `season:${winter}` }, { tag: "era:Thaw" }] }, spell: { meanStartsPerYear: 12, meanDurationDays: 4 }, apply: [{ param: "precipitation.pwd", op: "scale", value: 1.8 }], tag: "era-spell" },
    // `chance` leaves: a plain modifier on an edge window, and a spell whose window is a chance draw
    { id: "chance-edge", when: { all: [{ chance: 0.5 }, { yearPhase: [0.2, 0.4] }] }, apply: [{ param: "humidity.dry", op: "clamp", min: 0.9 }], tag: "chance-edge" },
    { id: "chance-spell", when: { chance: 0.4 }, spell: { meanStartsPerYear: 3, meanDurationDays: 3 }, apply: [{ param: "wind.speed", op: "offset", value: 8 }], tag: "chance-spell" },
  ] as Modifier[];
}

function zone(id: string, presetId: string, moons: [edge: string, env: string], seasons: [summer: string, winter: string], flip = false): ZoneProfile {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) throw new Error(`no preset ${presetId}`);
  return { id, name: id, schemaVersion: 1, climate: p.climate, regimes: p.regimes, modifiers: modifiers(moons[0], moons[1], seasons[0], seasons[1]), ...(flip ? { flipSeasons: true } : {}) };
}

const TICK: [string, string] = ["Tick", "Sable"];
const EMBER: [string, string] = ["Ember", "Cinder"];
const FOUR_NAMES: [string, string] = ["Summer", "Winter"];
const ALMANAC_NAMES: [string, string] = ["Dry", "Wet"];

const internal = (yearLength: number): Calendar => ({ kind: "internal", config: { yearLength, epochYear: 1, moons: MOONS, seasons: FOUR } });

export const FIXTURES: Fixture[] = [
  { id: "internal-365", calendar: internal(365), eras: ERAS, zones: [zone("north", "fjord-coast", TICK, FOUR_NAMES), zone("south", "monsoon-coast", TICK, FOUR_NAMES, true)] },
  { id: "internal-360", calendar: internal(360), eras: ERAS, zones: [zone("plain", "savanna", TICK, FOUR_NAMES)] },
  { id: "internal-400", calendar: internal(400), eras: ERAS, zones: [zone("north", "fjord-coast", TICK, FOUR_NAMES)] },
  { id: "almanac", calendar: { kind: "almanac", noYearLength: false }, eras: ERAS, zones: [zone("forest", "taiga", EMBER, ALMANAC_NAMES)] },
  { id: "almanac-no-year-length", calendar: { kind: "almanac", noYearLength: true }, eras: ERAS, zones: [zone("sand", "red-desert", EMBER, ALMANAC_NAMES)] },
];

/** The third-party fixture adapter, optionally with `yearLength` removed from every context and from describe(). */
export function almanac(noYearLength: boolean): TimeAdapter {
  const a = makeAdapter();
  if (!noYearLength) return a;
  return {
    ...a,
    toContext(d: number): TimeContext {
      const c: Partial<TimeContext> = { ...a.toContext(d) };
      delete c.yearLength;
      return c as TimeContext;
    },
    describe() {
      const desc: Partial<ReturnType<NonNullable<TimeAdapter["describe"]>>> = { ...a.describe!() };
      delete desc.yearLength;
      return desc as ReturnType<NonNullable<TimeAdapter["describe"]>>;
    },
  };
}

const ALMANAC_DESCRIPTION =
  "test/fixtures/api/third-party-calendar.ts makeAdapter() (Almanac of Foo: 400-day years, every 4th 401, seasons Wet 0 / Dry 0.5, moons Ember 33d @0 and Cinder 91d @0.1; unchanged between c773f5d^ and b3c5ac5). noYearLength: yearLength deleted from every toContext() result and from describe().";

function adapterFor(c: Calendar): TimeAdapter {
  return c.kind === "internal" ? new InternalCalendar(c.config, () => 0) : almanac(c.noYearLength);
}

/** Days whose yearPhase is exactly an edge, plus the day after each. Read from the calendar itself. */
function edgeDays(adapter: TimeAdapter): number[] {
  const out = new Set<number>();
  for (let d = FROM; d <= TO; d++) {
    const t = adapter.toContext(d);
    if (EDGES.includes(t.yearPhase)) {
      out.add(d);
      if (d + 1 <= TO) out.add(d + 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

type Body = Omit<WeatherReport, "provenance">;

function main(): void {
  // widened: at HEAD the constant is a different literal type, and that is exactly the case this guards
  if ((GENERATOR_VERSION as string) !== EXPECTED) throw new Error(`golden-previous runs only inside a worktree of c773f5d^ (found ${GENERATOR_VERSION}, need ${EXPECTED}). See the header.`);
  const outPath = process.argv[2];
  if (!outPath?.endsWith(".json.gz")) throw new Error("usage: bun run scripts/golden-previous.ts <out.json.gz>");
  const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();

  const fixtures = FIXTURES.map((f) => {
    const adapter = adapterFor(f.calendar);
    const time = new TimeRegistry(adapter.id);
    time.register(adapter);
    const world = new World({ seed: SEED, zones: f.zones, eras: f.eras, overrides: [] }, time);
    const edges = edgeDays(adapter);
    const hourlyDays = [...new Set([...edges, ...Array.from({ length: Math.floor((TO - FROM) / HOURLY_EVERY) + 1 }, (_, i) => FROM + i * HOURLY_EVERY)])].sort((a, b) => a - b);
    const zones = f.zones.map((z) => {
      let provenance: WeatherReport["provenance"] | undefined;
      const body = (r: WeatherReport): Body => {
        const { provenance: p, ...rest } = r;
        if (provenance === undefined) provenance = p;
        else if (JSON.stringify(p) !== JSON.stringify(provenance)) throw new Error(`${f.id}/${z.id}: provenance is not constant`);
        const s = JSON.stringify(rest);
        if (JSON.stringify(JSON.parse(s)) !== s) throw new Error(`${f.id}/${z.id} day ${r.dayOrdinal}: report does not round-trip through JSON`);
        return rest;
      };
      const daily: Body[] = [];
      for (let d = FROM; d <= TO; d++) daily.push(body(world.getReport(z.id, { dayOrdinal: d })));
      const hourly = hourlyDays.map((d) => ({ day: d, reports: Array.from({ length: 24 }, (_, h) => body(world.getReport(z.id, { dayOrdinal: d, hour: h }))) }));
      return { zoneId: z.id, provenance: provenance!, daily, hourly };
    });
    return { id: f.id, calendar: f.calendar.kind === "internal" ? f.calendar : { ...f.calendar, description: ALMANAC_DESCRIPTION }, eras: f.eras, zones: f.zones, calendarHash: world.calendarHash(), edgeDays: edges, hourlyDays, out: zones };
  });

  const golden = {
    header: {
      what: "Dense golden of generator wadjet-gen/0.0.3: World.getReport for every day FROM..TO (daily) and hours 0..23 on hourlyDays, per fixture and zone. Reports omit provenance (constant per zone, stored once). Compare via JSON.stringify of the report without provenance. docs/SESHAT-v0.md §17.5 item 2.",
      commit,
      generatorVersion: GENERATOR_VERSION,
      rngVersion: RNG_VERSION,
      seed: SEED,
      from: FROM,
      to: TO,
      regenerate: "git worktree add .tmp-oracle-003 c773f5d^ && cp scripts/golden-previous.ts .tmp-oracle-003/scripts/ && (cd .tmp-oracle-003 && bun run scripts/golden-previous.ts ../test/golden/previous/dense.json.gz) && git worktree remove --force .tmp-oracle-003",
    },
    fixtures,
  };
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Bun.gzipSync(new TextEncoder().encode(JSON.stringify(golden) + "\n")));
  console.log(`wrote ${outPath} (${fixtures.length} fixtures, commit ${commit})`);
}

if (import.meta.main) main();
