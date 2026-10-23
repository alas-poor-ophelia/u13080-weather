/**
 * P3c step 5 (docs/SESHAT-v0.md §15.6, ruled 2026-10-21): a world with no
 * data.json starts on a plain calendar definition and is recorded as born on
 * one; a data.json missing a field is an existing world and stays where it
 * is. main.ts (Obsidian-bound) is exercised by the e2e smoke walk: no write at
 * startup, an API setNow kept in memory, the first user change saving.
 */
import { describe, expect, test } from "bun:test";
import { parse } from "../src/seshat";
import { migrateSettings } from "../src/plugin/settings";
import { NEW_WORLD_CALENDAR, startNewWorld, vaultSeed } from "../src/plugin/new-world";
import { canonicalJson, CONFLICT_ERROR, FirstSave, SaveQueue, setAndSave, YIELD_ERROR, type YieldReason } from "../src/plugin/persist";
import { recognise } from "../src/plugin/time/form";
import { SeshatCalendar } from "../src/plugin/time/seshat";
import { InternalCalendar } from "../src/plugin/time/internal";

describe("a new world", () => {
  test("starts on a plain definition: 365-day years from year 1, the default moon, no seasons; born on a definition", () => {
    const s = migrateSettings(null);
    startNewWorld(s, "Test vault");
    expect(s.activeTimeAdapter).toBe("seshat");
    expect(s.calendar.origin).toBe("definition");
    const ast = parse(s.calendar.definition as string);
    expect(ast.name).toBe(NEW_WORLD_CALENDAR);
    expect(ast).not.toHaveProperty("seasons");
    const f = recognise(ast);
    expect(f.year).toEqual({ kind: "form", value: { length: 365, firstYear: 1, leap: null } });
    expect(f.moons.kind === "form" && f.moons.value.map((m) => [m.name, m.period])).toEqual([["Moon", { n: 2953, d: 100 }]]);
  });

  test("its days and moon read as the legacy default's do (the same world, now editable as a definition)", () => {
    const s = migrateSettings(null);
    const legacy = new InternalCalendar(s.calendar, () => 0);
    startNewWorld(s, "Test vault");
    const def = new SeshatCalendar(s.calendar.definition, () => 0);
    for (const d of [-400, -1, 0, 1, 200, 364, 365, 3650]) {
      const a = legacy.toContext(d);
      const b = def.toContext(d);
      expect([b.year, b.dayOfYear, b.yearLength]).toEqual([a.year, a.dayOfYear, a.yearLength]);
      expect(b.moons).toEqual(a.moons);
    }
  });

  test("the legacy fields stay filled, so an older build opening a new world runs the legacy calendar (accepted in P3a)", () => {
    const s = migrateSettings(null);
    startNewWorld(s, "Test vault");
    expect(s.calendar.yearLength).toBe(365);
    expect(s.calendar.moons.length).toBe(1);
  });
});

describe("an existing world never changes calendar on load", () => {
  test("an empty or partial data.json is an existing world: it keeps the legacy calendar", () => {
    for (const raw of [{}, { calendar: {} }, { zones: [] }, { activeTimeAdapter: "internal" }]) {
      const s = migrateSettings(raw);
      expect(s.activeTimeAdapter).toBe("internal");
      expect(s.calendar).not.toHaveProperty("origin");
      expect(s.calendar).not.toHaveProperty("definition");
    }
  });
});

/**
 * Bead wadjet-1ou: on a fresh device Sync may not have delivered data.json yet,
 * so a new world is not saved at startup, takes its seed from the vault's name,
 * and its first save checks the disk again before writing.
 */
describe("a new world's seed comes from the vault's name", () => {
  test("16 hex digits like a random seed, the same for a name at every call, different across names", () => {
    const a = vaultSeed("My Vault");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(vaultSeed("My Vault")).toBe(a);
    const names = ["My Vault", "my vault", "My Vault ", "Campaign", "", "Ωmega", "vault-2"];
    expect(new Set(names.map(vaultSeed)).size).toBe(names.length);
  });

  test("startNewWorld sets it; an existing world keeps its stored seed", () => {
    const s = migrateSettings(null);
    startNewWorld(s, "Campaign");
    expect(s.worldSeed).toBe(vaultSeed("Campaign"));
    expect(migrateSettings({ worldSeed: "0123456789abcdef" }).worldSeed).toBe("0123456789abcdef");
  });

  test("no data.json is not a damaged one: migrating it reports no repair, so a new world shows no repair Notice", () => {
    const repairs: string[] = [];
    const s = migrateSettings(null, (m) => repairs.push(m));
    startNewWorld(s, "Fresh");
    migrateSettings(undefined, (m) => repairs.push(m));
    expect(repairs).toEqual([]);
  });
});

/** What a save settled with: "resolved", or the message it rejected with. */
const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "resolved",
    (e: Error) => e.message,
  );

/** A fake disk and host: `disk` is data.json (undefined = none), `writes` every saveData. */
function host(fresh: boolean) {
  const h = {
    disk: undefined as unknown,
    writes: [] as unknown[],
    notices: 0,
    reasons: [] as YieldReason[],
    settings: { worldSeed: vaultSeed("V"), day: 0 },
    first: null as unknown as FirstSave,
    queue: null as unknown as SaveQueue,
  };
  h.first = new FirstSave(
    () => Promise.resolve(h.disk),
    (why) => {
      h.notices++;
      h.reasons.push(why);
    },
  );
  if (fresh) h.first.startNew();
  h.queue = new SaveQueue(
    h.first.guard((data) => {
      const copy = JSON.parse(JSON.stringify(data)) as unknown;
      h.writes.push(copy);
      h.disk = copy;
      return Promise.resolve();
    }),
    () => h.settings,
    () => true,
  );
  return h;
}

describe("the first save of a new world (FirstSave)", () => {
  test("a new world writes nothing until its first change; that save writes it, and it is no longer new", async () => {
    const h = host(true);
    expect(h.first.current).toBe("new");
    expect(h.writes).toEqual([]);
    h.settings.day = 3;
    await h.queue.save();
    expect(h.writes).toEqual([{ worldSeed: vaultSeed("V"), day: 3 }]);
    expect(h.first.current).toBe("saved");
    // after a successful save an outside change is Sync updating a saved world: no yield, saves go on
    h.first.external();
    expect(h.first.current).toBe("saved");
    await h.queue.save();
    expect(h.writes.length).toBe(2);
    expect(h.notices).toBe(0);
  });

  test("data.json arriving before the first change: the save is refused, nothing is written, one Notice, later saves refused too", async () => {
    const h = host(true);
    const synced = { worldSeed: "feedfacefeedface", zones: ["the real world"] };
    h.disk = synced;
    h.settings.day = 5;
    expect(await refusal(h.queue.save())).toBe(YIELD_ERROR);
    expect(h.writes).toEqual([]);
    expect(h.disk).toBe(synced);
    expect(h.first.current).toBe("yielded");
    expect(h.notices).toBe(1);
    expect(await refusal(h.queue.save())).toBe(YIELD_ERROR);
    h.first.external();
    expect(h.writes).toEqual([]);
    expect(h.notices).toBe(1);
  });

  test("a refused save rolls back a caller that restores on failure (setAndSave, as writeCurrentDay and calendars do)", async () => {
    const h = host(true);
    h.disk = { worldSeed: "feedfacefeedface" };
    expect(await refusal(setAndSave(() => h.settings.day, (v) => (h.settings.day = v), 9, () => h.queue.save()))).toBe(YIELD_ERROR);
    expect(h.settings.day).toBe(0);
  });

  test("an outside change while new yields at once (one Notice), and no later save writes", async () => {
    const h = host(true);
    h.first.external();
    expect(h.first.current).toBe("yielded");
    expect(h.notices).toBe(1);
    h.first.external();
    expect(h.notices).toBe(1);
    expect(await refusal(h.queue.save())).toBe(YIELD_ERROR);
    expect(h.writes).toEqual([]);
  });

  test("an outside change while the re-read is pending still stops the write", async () => {
    const h = host(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = new FirstSave(
      async () => {
        await gate;
        return undefined;
      },
      () => h.notices++,
    );
    first.startNew();
    const writes: unknown[] = [];
    const save = first.guard((d) => {
      writes.push(d);
      return Promise.resolve();
    });
    const p = save({});
    first.external();
    release();
    expect(await refusal(p)).toBe(YIELD_ERROR);
    expect(writes).toEqual([]);
    expect(h.notices).toBe(1);
  });

  test("an existing world never re-reads the disk and never yields", async () => {
    let reads = 0;
    const first = new FirstSave(
      () => {
        reads++;
        return Promise.resolve({});
      },
      () => {
        throw new Error("no notice");
      },
    );
    const writes: unknown[] = [];
    const save = first.guard((d) => {
      writes.push(d);
      return Promise.resolve();
    });
    first.external();
    await save({ a: 1 });
    expect(reads).toBe(0);
    expect(writes).toEqual([{ a: 1 }]);
    expect(first.current).toBe("saved");
  });

  test("a failed first write leaves the world new, so the next save checks the disk again", async () => {
    let fail = true;
    let disk: unknown;
    const first = new FirstSave(
      () => Promise.resolve(disk),
      () => undefined,
    );
    first.startNew();
    const save = first.guard((d) => (fail ? Promise.reject(new Error("disk full")) : Promise.resolve(void (disk = d))));
    expect(await refusal(save({}))).toBe("disk full");
    expect(first.current).toBe("new");
    fail = false;
    await save({});
    expect(first.current).toBe("saved");
  });

  test("a re-read that throws (a corrupt or empty data.json): nothing written, still new, the caller rejects and rolls back", async () => {
    let reads = 0;
    const first = new FirstSave(
      () => {
        reads++;
        return Promise.reject(new SyntaxError("Unexpected end of JSON input"));
      },
      () => {
        throw new Error("no notice");
      },
    );
    first.startNew();
    const writes: unknown[] = [];
    const settings = { day: 0 };
    const queue = new SaveQueue(
      first.guard((d) => {
        writes.push(d);
        return Promise.resolve();
      }),
      () => settings,
      () => true,
    );
    expect(await refusal(setAndSave(() => settings.day, (v) => (settings.day = v), 4, () => queue.save()))).toBe("Unexpected end of JSON input");
    expect(settings.day).toBe(0);
    expect(writes).toEqual([]);
    expect(first.current).toBe("new");
    expect(reads).toBe(1);
  });
});

describe("automatic saves (another plugin or a script through the API) and a new world (bead wadjet-1ou)", () => {
  test("while new they resolve and write nothing, without reading the disk; the change stays in memory", async () => {
    const h = host(true);
    h.disk = { worldSeed: "feedfacefeedface" }; // Sync has delivered, but no user save has looked yet
    await setAndSave(() => h.settings.day, (v) => (h.settings.day = v), 7, () => h.queue.save({ automatic: true }));
    expect(h.settings.day).toBe(7);
    expect(h.writes).toEqual([]);
    expect(h.first.current).toBe("new");
    expect(h.notices).toBe(0);
    // the user's save then finds the synced file and yields: the automatic change never reaches the disk
    expect(await refusal(h.queue.save())).toBe(YIELD_ERROR);
    expect(h.writes).toEqual([]);
    expect(h.reasons).toEqual(["synced"]);
  });

  test("the user's first save writes them: the world as it is in memory, automatic changes included", async () => {
    const h = host(true);
    h.settings.day = 7;
    await h.queue.save({ automatic: true });
    await h.queue.save({ automatic: true });
    expect(h.writes).toEqual([]);
    await h.queue.save();
    expect(h.writes).toEqual([{ worldSeed: vaultSeed("V"), day: 7 }]);
    expect(h.first.current).toBe("saved");
  });

  test("once saved, an automatic save writes as before; an existing world writes them too", async () => {
    const h = host(true);
    await h.queue.save();
    h.settings.day = 2;
    await h.queue.save({ automatic: true });
    expect(h.writes).toEqual([
      { worldSeed: vaultSeed("V"), day: 0 },
      { worldSeed: vaultSeed("V"), day: 2 },
    ]);
    const old = host(false);
    await old.queue.save({ automatic: true });
    expect(old.writes.length).toBe(1);
  });

  test("a write shared by automatic and user calls is the user's; one shared only by automatic calls is not", async () => {
    const h = host(true);
    const a = h.queue.save({ automatic: true });
    const b = h.queue.save({ automatic: true });
    expect(a).toBe(b);
    await a;
    expect(h.writes).toEqual([]);
    const c = h.queue.save({ automatic: true });
    const d = h.queue.save();
    expect(c).toBe(d);
    await d;
    expect(h.writes.length).toBe(1);
    expect(h.first.current).toBe("saved");
  });

  test("an automatic save queued behind the user's running first write is written after it", async () => {
    let disk: unknown;
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = new FirstSave(
      () => Promise.resolve(disk),
      () => undefined,
    );
    first.startNew();
    const writes: unknown[] = [];
    const settings = { day: 0 };
    const queue = new SaveQueue(
      first.guard(async (d) => {
        const text = JSON.stringify(d); // saveData serialises when called
        started();
        await gate;
        disk = JSON.parse(text) as unknown;
        writes.push(disk);
      }),
      () => settings,
      () => true,
    );
    const user = queue.save();
    await running;
    settings.day = 9; // an API change while the first write runs: it does not join that write, so it queues behind it
    const auto = queue.save({ automatic: true });
    release();
    await Promise.all([user, auto]);
    expect(writes).toEqual([{ day: 0 }, { day: 9 }]);
    expect(first.current).toBe("saved");
  });

  test("once yielded, an automatic save is refused like any other (so setNow reports the day was not kept)", async () => {
    const h = host(true);
    h.first.external();
    expect(await refusal(h.queue.save({ automatic: true }))).toBe(YIELD_ERROR);
    expect(h.writes).toEqual([]);
  });
});

describe("the first write is checked once (bead wadjet-1ou)", () => {
  test("the disk holds what was written: saved, no Notice; later writes are not re-read", async () => {
    let reads = 0;
    let disk: unknown;
    const first = new FirstSave(
      () => {
        reads++;
        return Promise.resolve(disk);
      },
      () => {
        throw new Error("no notice");
      },
    );
    first.startNew();
    const save = first.guard((d) => {
      // as data.json round-trips it: undefined members dropped, keys in written order
      disk = JSON.parse(JSON.stringify(d)) as unknown;
      return Promise.resolve();
    });
    await save({ b: [1, { y: 2, x: undefined }], a: "z" });
    expect(first.current).toBe("saved");
    expect(reads).toBe(2); // before and after the first write
    await save({ a: "again" });
    expect(reads).toBe(2);
  });

  test("a synced copy lands during the first write: the world yields, says so once, the caller rejects, and no later save writes", async () => {
    const h = host(true);
    const synced = { worldSeed: "feedfacefeedface", zones: ["the real world"] };
    const first = new FirstSave(
      () => Promise.resolve(h.disk),
      (why) => {
        h.notices++;
        h.reasons.push(why);
      },
    );
    first.startNew();
    let writes = 0;
    const save = first.guard(() => {
      writes++;
      h.disk = synced; // Sync replaced the file right after our write
      return Promise.resolve();
    });
    expect(await refusal(save({ worldSeed: vaultSeed("V") }))).toBe(CONFLICT_ERROR);
    expect(first.current).toBe("yielded");
    expect(h.reasons).toEqual(["conflict"]);
    first.external();
    expect(await refusal(save({}))).toBe(YIELD_ERROR);
    expect(writes).toBe(1);
    expect(h.notices).toBe(1);
  });

  test("an outside change reported during the first write is that write, not a yield; the check after it decides", async () => {
    let calls = 0;
    const reads = [undefined, { a: 1 }]; // no file before the write; what was written after it
    const first = new FirstSave(
      () => Promise.resolve(reads[calls++]),
      () => {
        throw new Error("no notice");
      },
    );
    first.startNew();
    const save = first.guard(() => {
      first.external();
      return Promise.resolve();
    });
    await save({ a: 1 });
    expect(first.current).toBe("saved");
  });

  test("a re-read that throws after the first write is a conflict too: the write cannot be confirmed", async () => {
    let n = 0;
    const reasons: YieldReason[] = [];
    const first = new FirstSave(
      () => (n++ === 0 ? Promise.resolve(undefined) : Promise.reject(new Error("EBUSY"))),
      (why) => reasons.push(why),
    );
    first.startNew();
    const save = first.guard(() => Promise.resolve());
    expect(await refusal(save({}))).toBe(CONFLICT_ERROR);
    expect(reasons).toEqual(["conflict"]);
  });

  test("canonicalJson compares content: key order and undefined members do not count, values and array order do", () => {
    expect(canonicalJson({ a: 1, b: { d: [1, 2], c: undefined } })).toBe(canonicalJson({ b: { d: [1, 2] }, a: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ d: [1, 2] })).not.toBe(canonicalJson({ d: [2, 1] }));
    expect(canonicalJson(undefined)).toBe(canonicalJson(null));
  });
});
