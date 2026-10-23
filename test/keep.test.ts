/**
 * Kept weather (docs/SESHAT-v0.md §17.2 "Frozen days" and "Acceptance", §17.5 items 5-7 and 10; bead
 * wadjet-9lc step 2): the store, the scan, the upgrade, and the World's read path over it.
 */
import { describe, expect, test } from "bun:test";
import type { DailyRecord } from "../src/core/generator";
import { profileHash } from "../src/core/profile";
import type { Override, WeatherReport } from "../src/core/report";
import { GENERATOR_VERSION, PREVIOUS_GENERATOR_VERSION } from "../src/core/version";
import { ApiController } from "../src/plugin/api";
import { commitKeep, storedForm, dropKeptZone, freezeRange, keepSourceOf, keptSpan, MAX_KEPT_DAYS, mergeKept, readKept, removeKeptWeather, scanKeep, upgradeWorld, writeKept, type FrozenDay, type KeepSource } from "../src/plugin/keep";
import { DEFAULT_SETTINGS, migrateSettings, type WadjetSettings } from "../src/plugin/settings";
import { TimeRegistry } from "../src/plugin/time/adapter";
import { InternalCalendar } from "../src/plugin/time/internal";
import type { World } from "../src/plugin/world";
import { rollYear } from "../src/studio/model/audition";
import { adapterOf, golden, worldOf, type Fixture } from "./fixtures/previous-golden";

const SEED = golden.header.seed;
const fixture = (id: string): Fixture => golden.fixtures.find((f) => f.id === id)!;
const sourceOf = (f: Fixture, overrides: Override[] = []): KeepSource => ({ state: { seed: SEED, zones: f.zones, eras: f.eras, overrides }, adapter: (m) => adapterOf(f, m) });
const fast = { tick: () => Promise.resolve() };
/** what data.json does to the store: a JSON round trip, then the load */
const persisted = (s: WadjetSettings): WadjetSettings => migrateSettings(JSON.parse(JSON.stringify(s)));
const stats = { acceptanceBytes: 0, acceptanceDays: 0 };

describe("acceptance: freeze, upgrade, read again (§17.2)", () => {
  const FROM = 0;
  const TO = 399;
  for (const f of golden.fixtures) {
    test(
      `${f.id}: kept days read the same in full, the rest differ only in provenance, the pin holds`,
      async () => {
        // a pin on the first edge day in the range (edge days are where 0.0.4 moves), on the first zone
        const pinDay = f.edgeDays.find((d) => d >= FROM && d <= TO) ?? 100;
        const pinZone = f.zones[0]!.id;
        const pin: Override = { zoneId: pinZone, dayOrdinal: pinDay, patch: { note: "kept under a pin", temperature: { high: 40 } } };
        const before = worldOf(f, "previous", { overrides: [pin] });

        // the daily report and all 24 hourly ones
        const read = (w: World, zoneId: string, d: number): string[] => [w.getReport(zoneId, { dayOrdinal: d }), ...Array.from({ length: 24 }, (_, hour) => w.getReport(zoneId, { dayOrdinal: d, hour }))].map((r) => JSON.stringify(r));
        const captured = new Map<string, string[]>();
        const capturedRange = new Map<string, string[]>();
        for (const z of f.zones) {
          for (let d = FROM; d <= TO; d++) captured.set(`${z.id}|${d}`, read(before, z.id, d));
          capturedRange.set(z.id, before.getRange(z.id, FROM, TO).map((r) => JSON.stringify(r)));
        }

        const progress: number[] = [];
        const res = await freezeRange(sourceOf(f, [pin]), f.zones.map((z) => z.id), FROM, TO, { ...fast, onProgress: (done) => progress.push(done) });
        if (res.kind !== "ok") throw new Error(`freeze: ${res.kind}`);
        expect(progress.at(-1)).toBe(f.zones.length * (TO - FROM + 1));
        expect(res.scan.unstorable).toBe(0);
        console.log(`kept ${f.id}: ${res.scan.zones.map((z) => `${z.zoneId} ${z.kept}/${z.scanned}`).join(", ")}`);
        expect(res.total).toBeGreaterThan(0);
        expect(res.total).toBeLessThan(MAX_KEPT_DAYS);
        for (const k of res.frozen) expect(k.provenance).toEqual({ generatorVersion: PREVIOUS_GENERATOR_VERSION, calendarHash: before.calendarHash(), profileHash: profileHash(before.getZone(k.zoneId)!) });

        const settings: WadjetSettings = { ...DEFAULT_SETTINGS, worldSeed: SEED, generatorVersion: PREVIOUS_GENERATOR_VERSION, zones: f.zones, eras: f.eras, overrides: [pin], frozen: [] };
        const up = upgradeWorld(settings, res.scan.days);
        if (up.kind !== "ok") throw new Error("upgrade refused");
        expect(up.settings.generatorVersion).toBe(GENERATOR_VERSION);
        expect(settings.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
        const loaded = persisted(up.settings);
        stats.acceptanceBytes += JSON.stringify(loaded.frozen).length;
        stats.acceptanceDays += res.total;
        const frozen = readKept(loaded.frozen).days;
        expect(frozen.length).toBe(res.total);
        const after = worldOf(f, "current", { overrides: [pin], frozen });
        const kept = new Set(frozen.map((k) => `${k.zoneId}|${k.dayOrdinal}`));

        const stripped = (s: string): string => {
          const r = JSON.parse(s) as WeatherReport;
          const { generatorVersion: _g, calendarHash: _c, ...p } = r.provenance;
          return JSON.stringify({ ...r, provenance: p });
        };
        const bad: string[] = [];
        let unstoredMoved = 0;
        for (const z of f.zones) {
          const range = after.getRange(z.id, FROM, TO).map((r) => JSON.stringify(r));
          for (let d = FROM; d <= TO; d++) {
            const key = `${z.id}|${d}`;
            const was = [...captured.get(key)!, capturedRange.get(z.id)![d - FROM]!];
            const now = [...read(after, z.id, d), range[d - FROM]!];
            if (kept.has(key)) {
              if (now.join() !== was.join()) bad.push(`kept ${key}`);
            } else {
              if (now.map(stripped).join() !== was.map(stripped).join()) bad.push(`unstored ${key}`);
              const p = (JSON.parse(now[0]!) as WeatherReport).provenance;
              if (p.generatorVersion !== GENERATOR_VERSION || p.calendarHash !== after.calendarHash()) bad.push(`provenance ${key}`);
              if (now[0] !== was[0]) unstoredMoved++;
            }
          }
        }
        expect(bad.slice(0, 10)).toEqual([]);
        // every unstored day's provenance names the current generator now
        expect(unstoredMoved).toBe(f.zones.length * (TO - FROM + 1) - frozen.length);

        const pinned = after.getReport(pinZone, { dayOrdinal: pinDay });
        expect(pinned.overridden).toBe(true);
        expect(pinned.temperature.high).toBe(40);
        expect(JSON.stringify(pinned)).toBe(captured.get(`${pinZone}|${pinDay}`)![0]!);

        // the API reads through the same path
        const time = new TimeRegistry(after.time.active!.id);
        time.register(after.time.active!);
        const api = new ApiController({ version: "9.9.9", world: after, time, units: () => "metric" });
        api.markReady();
        const first = frozen[0]!;
        expect(JSON.stringify(api.api.getReport(first.zoneId, { dayOrdinal: first.dayOrdinal }))).toBe(captured.get(`${first.zoneId}|${first.dayOrdinal}`)![0]!);

        // editing the zone's climate later leaves its kept days, and their provenance, alone (§17.5 item 8)
        const edited = f.zones.map((z) => (z.id === first.zoneId ? { ...z, name: `${z.name} (edited)`, modifiers: [] } : z));
        const w2 = worldOf({ ...f, zones: edited }, "current", { overrides: [pin], frozen });
        expect(w2.getReport(first.zoneId, { dayOrdinal: first.dayOrdinal }).provenance.profileHash).toBe(first.provenance.profileHash);
        expect(w2.getReport(first.zoneId, { dayOrdinal: first.dayOrdinal }).provenance.profileHash).not.toBe(profileHash(edited.find((z) => z.id === first.zoneId)!));
      },
      180_000,
    );
  }
  test("data.json size of the acceptance stores", () => {
    console.log(`acceptance stores: ${stats.acceptanceDays} kept days, ${stats.acceptanceBytes} bytes (${Math.round(stats.acceptanceBytes / Math.max(1, stats.acceptanceDays))} per day)`);
  });
});

const rec = (day: number): DailyRecord => ({ dayOrdinal: day, yearPhase: 0.1, regime: "fair", wet: false, precipMm: 0, precipType: "none", tempMean: 5, tempHigh: 9, tempLow: 1, tempResidual: 0.2, humidity: 0.5, cloudCover: 0.3, windSpeedKph: 10, windDirectionDeg: 200, calm: false, tags: [] });
const entry = (day: number, zoneId = "north"): FrozenDay => ({ zoneId, dayOrdinal: day, record: rec(day), provenance: { generatorVersion: PREVIOUS_GENERATOR_VERSION, calendarHash: "h", profileHash: "p" } });
const zonesNamed = (...ids: string[]): WadjetSettings["zones"] => ids.map((id) => ({ ...fixture("internal-365").zones[0]!, id }));

describe("the store in data.json (migrateSettings)", () => {
  test("absent is none, silently; a fresh list each time", () => {
    const msgs: string[] = [];
    const a = migrateSettings({}, (m) => msgs.push(m));
    expect(a.frozen).toEqual([]);
    expect(a.frozen).not.toBe(DEFAULT_SETTINGS.frozen);
    expect(a.frozen).not.toBe(migrateSettings({}).frozen);
    expect(msgs).toEqual([]);
  });

  test("a value that is not a list is kept as it is through load and save, reported, and not used", () => {
    for (const v of [{ v: 2, days: [1, 2] }, "x", 3, null]) {
      const msgs: string[] = [];
      const s = migrateSettings({ frozen: v }, (m) => msgs.push(m));
      expect(JSON.stringify(persisted(s).frozen)).toBe(JSON.stringify(v));
      expect(readKept(s.frozen).days).toEqual([]);
      expect(msgs.length).toBe(1);
      expect(msgs[0]).toContain("left as it is in data.json and not used");
      // an upgrade that keeps days carries it as an unreadable item of the list
      const up = upgradeWorld({ ...s, zones: zonesNamed("north") }, [entry(1)]);
      if (up.kind !== "ok") throw new Error("refused");
      expect(JSON.stringify(up.settings.frozen)).toBe(JSON.stringify([entry(1), v]));
      expect(readKept(persisted(up.settings).frozen).days).toEqual([entry(1)]);
    }
  });

  test("entries that do not parse are kept as they are, with one message; a good list is kept as stored", () => {
    const good = [entry(1), entry(2)];
    const msgs: string[] = [];
    const s = migrateSettings({ frozen: good }, (m) => msgs.push(m));
    expect(s.frozen).toBe(good);
    expect(msgs).toEqual([]);
    const broken: unknown[] = [
      entry(3),
      { ...entry(4), dayOrdinal: 4.5 },
      { ...entry(5), record: { ...rec(5), tempMean: "5" } },
      { ...entry(6), record: { ...rec(6), humidity: null } },
      { ...entry(7), record: { ...rec(8) } },
      { ...entry(9), provenance: { generatorVersion: "g", calendarHash: "h" } },
      { ...entry(10), zoneId: "" },
      { ...entry(11), record: { ...rec(11), precipType: "hail" } },
      { shape: "from a later version", days: [1, 2, 3] },
      entry(13),
    ];
    const raw = JSON.stringify(broken);
    const m2 = migrateSettings({ frozen: JSON.parse(raw) as unknown }, (m) => msgs.push(m));
    expect(readKept(m2.frozen).days.map((e) => e.dayOrdinal)).toEqual([3, 13]);
    expect(msgs).toEqual(["8 kept weather days are not readable by this version of Wadjet. They are left as they are in data.json and not used, so those days show the current generator's weather."]);
    // load then save: byte for byte
    expect(JSON.stringify(persisted(m2).frozen)).toBe(raw);
    // writers keep every unreadable entry as it was
    const unread = broken.filter((_, i) => ![0, 9].includes(i)).map((e) => JSON.stringify(e));
    const up = upgradeWorld({ ...m2, zones: zonesNamed("north") }, [entry(20)]);
    if (up.kind !== "ok") throw new Error("refused");
    const after = (persisted(up.settings).frozen as unknown[]).map((e) => JSON.stringify(e));
    for (const u of unread) expect(after).toContain(u);
    expect(readKept(up.settings.frozen).days.map((e) => e.dayOrdinal)).toEqual([3, 13, 20]);
    const dropped = (dropKeptZone(m2.frozen, "north") as unknown[]).map((e) => JSON.stringify(e));
    expect(dropped).toEqual(unread);
    expect(writeKept(m2.frozen, []).map((e) => JSON.stringify(e))).toEqual(unread);
    expect(removeKeptWeather(m2).frozen).toEqual([]);
  });

  test("re-freezing replaces by (zone, day), never appends, and de-duplicates the stored list", () => {
    const a = [entry(1), entry(2), entry(1, "south"), { ...entry(2), provenance: { ...entry(2).provenance, generatorVersion: "dup" } }];
    const b = [{ ...entry(2), provenance: { ...entry(2).provenance, generatorVersion: "x" } }, entry(3)];
    const m = mergeKept(a, b);
    expect(m.map((e) => `${e.zoneId}${e.dayOrdinal}`)).toEqual(["north1", "north2", "north3", "south1"]);
    expect(m.find((e) => e.dayOrdinal === 2)!.provenance.generatorVersion).toBe("x");
    expect(mergeKept(m, b).length).toBe(4);
    expect(mergeKept(a, []).length).toBe(3);
  });

  test("the cap refuses and changes nothing, or keeps the most recent whole days; other zones' days do not count", () => {
    const many = Array.from({ length: MAX_KEPT_DAYS }, (_, i) => entry(i));
    expect(commitKeep([], many).kind).toBe("ok");
    expect(commitKeep(many, many).kind).toBe("ok");
    expect(commitKeep(many, [entry(MAX_KEPT_DAYS)])).toEqual({ kind: "over-cap", added: 1, total: MAX_KEPT_DAYS + 1, cap: MAX_KEPT_DAYS, fitFromDay: null });
    // days of a deleted zone are not counted
    expect(commitKeep(many, [entry(5, "south")], { zoneIds: ["south"] }).kind).toBe("ok");

    const s: WadjetSettings = { ...DEFAULT_SETTINGS, generatorVersion: PREVIOUS_GENERATOR_VERSION, zones: zonesNamed("north", "south"), frozen: many.slice(0, 1990) };
    // 20 new days in two zones (10 days × 2): only the newest 5 whole days fit beside 1,990
    const scan = [...Array.from({ length: 10 }, (_, i) => entry(3000 + i)), ...Array.from({ length: 10 }, (_, i) => entry(3000 + i, "south"))];
    const refused = upgradeWorld(s, scan);
    expect(refused).toEqual({ kind: "over-cap", added: 20, total: 2010, cap: MAX_KEPT_DAYS, fitFromDay: 3005 });
    expect(s.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
    const recent = upgradeWorld(s, scan, { mostRecent: true });
    if (recent.kind !== "ok") throw new Error("refused");
    expect({ added: recent.added, trimmed: recent.trimmed, total: recent.total, fromDay: recent.fromDay }).toEqual({ added: 10, trimmed: 10, total: 2000, fromDay: 3005 });
    expect(recent.settings.generatorVersion).toBe(GENERATOR_VERSION);
    expect(readKept(recent.settings.frozen).days.filter((e) => e.dayOrdinal >= 3000).map((e) => `${e.zoneId}${e.dayOrdinal}`)).toEqual(["north3005", "north3006", "north3007", "north3008", "north3009", "south3005", "south3006", "south3007", "south3008", "south3009"]);
  });

  test("upgrade without keeping, remove, a zone's lifecycle, the span", () => {
    const stored = [entry(4), entry(9, "south"), entry(12, "gone")];
    const s: WadjetSettings = { ...DEFAULT_SETTINGS, generatorVersion: PREVIOUS_GENERATOR_VERSION, zones: zonesNamed("north", "south"), frozen: stored };
    const up = upgradeWorld(s);
    expect(up.kind === "ok" && up.settings.generatorVersion === GENERATOR_VERSION && up.settings.frozen === stored).toBe(true);
    expect(removeKeptWeather(s).frozen).toEqual([]);
    expect(s.frozen).toBe(stored);
    expect(readKept(dropKeptZone(s.frozen, "south")).days.map((e) => e.zoneId)).toEqual(["north", "gone"]);
    expect(dropKeptZone(s.frozen, "nowhere")).toBe(s.frozen);
    expect(keptSpan(s)).toEqual({ count: 2, fromDay: 4, toDay: 9, zones: 2 });
    expect(keptSpan({ ...s, frozen: [] })).toBeNull();
  });

  test("data.json size of 2,000 kept days", () => {
    // real records from the dense fixture, with full provenance
    const f = fixture("internal-365");
    const w = worldOf(f, "previous");
    const days: FrozenDay[] = [];
    for (const z of f.zones) for (const r of w.generatedRecords(z.id, 0, 999)) days.push({ zoneId: z.id, dayOrdinal: r.dayOrdinal, record: r, provenance: { generatorVersion: PREVIOUS_GENERATOR_VERSION, calendarHash: w.calendarHash(), profileHash: profileHash(z) } });
    const bytes = JSON.stringify(days.slice(0, MAX_KEPT_DAYS)).length;
    const pretty = JSON.stringify(days.slice(0, MAX_KEPT_DAYS), null, 2).length;
    console.log(`2,000 kept days: ${bytes} bytes compact JSON, ${pretty} bytes indented by 2`);
    expect(bytes).toBeLessThan(1_500_000);
  });
});


describe("storedForm", () => {
  test("a record with a non-finite number would not survive data.json, so the scan skips it", () => {
    expect(storedForm(rec(3))).toEqual(rec(3));
    expect(storedForm({ ...rec(3), tempResidual: Number.NaN })).toBeNull();
    expect(storedForm({ ...rec(3), windSpeedKph: Infinity })).toBeNull();
  });
});

describe("scanKeep", () => {
  const f = fixture("internal-360");
  const zones = f.zones.map((z) => z.id);

  test("refusals are results: a range over the cap, backwards, a zone that is not there", async () => {
    expect((await scanKeep(sourceOf(f), zones, 0, 3660, fast)).kind).toBe("refused");
    expect((await scanKeep(sourceOf(f), zones, 0, 3659, { ...fast, chunkDays: 4000, signal: AbortSignal.abort() })).kind).toBe("cancelled");
    expect((await scanKeep(sourceOf(f), zones, 10, 9, fast)).kind).toBe("refused");
    expect(await scanKeep(sourceOf(f), ["ghost"], 0, 9, fast)).toEqual({ kind: "refused", message: 'There is no zone "ghost".' });
  });

  test("Cancel between chunks stops the scan", async () => {
    const ctl = new AbortController();
    const seen: number[] = [];
    const res = await scanKeep(sourceOf(f), zones, 0, 999, {
      ...fast,
      chunkDays: 100,
      signal: ctl.signal,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(1000);
        if (done >= 300) ctl.abort();
      },
    });
    expect(res.kind).toBe("cancelled");
    expect(seen).toEqual([100, 200, 300]);
  });

  test("a macrotask tick lets other work run between chunks", async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 0);
    const res = await scanKeep(sourceOf(f), zones, 0, 9, { tick: () => new Promise((res) => setTimeout(res, 0)) });
    expect(res.kind).toBe("done");
    expect(ticked).toBe(true);
  });

  test("keepSourceOf: the internal calendar per mode, the same adapter otherwise", () => {
    const s: WadjetSettings = { ...DEFAULT_SETTINGS, calendar: { ...DEFAULT_SETTINGS.calendar, yearLength: 360 } };
    const internal = new InternalCalendar(s.calendar, () => 0, undefined, "previous");
    const src = keepSourceOf(s, internal);
    expect((src.adapter("current") as InternalCalendar).generatorMode).toBe("current");
    expect((src.adapter("previous") as InternalCalendar).generatorMode).toBe("previous");
    const other = adapterOf(fixture("almanac"), "current");
    expect(keepSourceOf(s, other).adapter("previous")).toBe(other);
  });
});

describe("the World over kept days", () => {
  const f = fixture("internal-365");
  const zoneId = f.zones[0]!.id;
  const DAY = 40;

  test("a store change re-reads the day, fires profiles-changed for its zone, and never poisons the generator cache", () => {
    const w = worldOf(f, "current");
    const events: Array<{ all: boolean; zoneIds: readonly string[] }> = [];
    w.on("profiles-changed", (p) => events.push(p));
    const generated = JSON.stringify(w.getReport(zoneId, { dayOrdinal: DAY }));
    const generatedRange = JSON.stringify(w.getRange(zoneId, DAY - 2, DAY + 2));
    const rec = w.generatedRecords(zoneId, DAY, DAY)[0]!;
    const k: FrozenDay = { zoneId, dayOrdinal: DAY, record: { ...rec, tempMean: rec.tempMean + 10, tags: [...rec.tags, "kept"] }, provenance: { generatorVersion: "wadjet-gen/old", calendarHash: "old-hash", profileHash: "old-profile" } };
    const state = { seed: SEED, zones: f.zones, eras: f.eras, overrides: [], generatorMode: "current" as const };

    w.setState({ ...state, frozen: [k] });
    expect(events.at(-1)).toMatchObject({ all: false, zoneIds: [zoneId] });
    const r = w.getReport(zoneId, { dayOrdinal: DAY, hour: 13 });
    expect(r.conditions).toContain("kept");
    expect(r.provenance.generatorVersion).toBe("wadjet-gen/old");
    expect(r.provenance.calendarHash).toBe("old-hash");
    expect(r.provenance.profileHash).toBe("old-profile");
    const ranged = w.getRange(zoneId, DAY - 1, DAY + 1);
    expect(ranged.map((x) => x.conditions.includes("kept"))).toEqual([false, true, false]);
    expect(ranged[0]!.provenance.calendarHash).toBe(w.calendarHash());
    // the generator's own record is untouched
    expect(w.generatedRecords(zoneId, DAY, DAY)[0]).toBe(rec);

    // the same list again, or a new list with the same content (a synced copy), changes no zone
    w.setState({ ...state, frozen: [k] });
    expect(events.at(-1)).toMatchObject({ all: false, zoneIds: [] });
    w.setState({ ...state, frozen: JSON.parse(JSON.stringify([k])) as FrozenDay[] });
    expect(events.at(-1)).toMatchObject({ all: false, zoneIds: [] });
    // an orphan entry (no such zone) changes no zone either
    w.setState({ ...state, frozen: [k, { ...k, zoneId: "ghost" }] });
    expect(events.at(-1)).toMatchObject({ all: false, zoneIds: [] });

    w.setState({ ...state, frozen: [] });
    expect(events.at(-1)).toMatchObject({ all: false, zoneIds: [zoneId] });
    expect(JSON.stringify(w.getReport(zoneId, { dayOrdinal: DAY }))).toBe(generated);
    expect(JSON.stringify(w.getRange(zoneId, DAY - 2, DAY + 2))).toBe(generatedRange);
  });

  test("a kept day of a zone that is gone is ignored, and a pin still applies over a kept day", () => {
    const plain = worldOf(f, "current");
    const ghost: FrozenDay = { zoneId: "ghost", dayOrdinal: DAY, record: plain.generatedRecords(zoneId, DAY, DAY)[0]!, provenance: { generatorVersion: "x", calendarHash: "y", profileHash: "z" } };
    const w = worldOf(f, "current", { frozen: [ghost] });
    for (const z of f.zones) expect(JSON.stringify(w.getRange(z.id, 0, 99))).toBe(JSON.stringify(plain.getRange(z.id, 0, 99)));
    expect(() => w.getReport("ghost", { dayOrdinal: DAY })).toThrow(RangeError);

    const rec = plain.generatedRecords(zoneId, DAY, DAY)[0]!;
    const k: FrozenDay = { zoneId, dayOrdinal: DAY, record: { ...rec, tags: ["kept"] }, provenance: { generatorVersion: "x", calendarHash: "y", profileHash: "z" } };
    const pinned = worldOf(f, "current", { frozen: [k], overrides: [{ zoneId, dayOrdinal: DAY, patch: { note: "pin", conditions: ["pinned"] } }] }).getReport(zoneId, { dayOrdinal: DAY });
    expect(pinned.overridden).toBe(true);
    expect(pinned.conditions).toEqual(["kept", "pinned"]);
  });
});

describe("the Studio audition in previous mode", () => {
  test("its year equals World.getReport in previous mode, day for day", () => {
    const f = fixture("internal-365");
    const zone = f.zones[0]!;
    const world = worldOf(f, "previous");
    const year = rollYear({ zone, eras: f.eras, seed: SEED, adapter: adapterOf(f, "previous"), year: 1, salt: 0, mode: "previous" });
    expect(year.days.length).toBe(365);
    const bad = year.days.filter((d) => JSON.stringify(d.report) !== JSON.stringify(world.getReport(zone.id, { dayOrdinal: d.dayOrdinal }))).map((d) => d.dayOrdinal);
    expect(bad).toEqual([]);
    expect(year.days[0]!.report.provenance.generatorVersion).toBe(PREVIOUS_GENERATOR_VERSION);
  });
});
