/**
 * Settings persistence without Obsidian imports, so it can be tested with a
 * fake `saveData`.
 *
 * `SaveQueue` runs one write at a time. Each write reads the settings
 * snapshot when it STARTS, so the last write to land is always the newest
 * state, whatever order the host's promises settle in. Calls made while a
 * write is waiting to start share that write (coalescing); a call made while
 * a write is running queues one more.
 *
 * A save is user-initiated unless the caller marks it `automatic` (a change
 * from another plugin or a script through the public API). A write that
 * several calls share is automatic only if every one of them was.
 */
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  /** the queued write that has not started yet, shared by every save() until it starts */
  private pending: Promise<void> | null = null;
  /** true while every call sharing `pending` was automatic */
  private pendingAutomatic = true;
  /** writes queued or running */
  private open = 0;

  /**
   * @param write the host's saveData; `automatic` is true when no user-initiated call shares the write
   * @param snapshot the settings object as it is now
   * @param alive false once the plugin is unloaded; a write that has not started by then is skipped
   */
  constructor(
    private readonly write: (data: unknown, automatic: boolean) => Promise<void>,
    private readonly snapshot: () => unknown,
    private readonly alive: () => boolean,
  ) {}

  /** Resolves once a write that started after this call has finished; rejects if that write failed. */
  save(opts: { automatic?: boolean } = {}): Promise<void> {
    const automatic = opts.automatic === true;
    if (this.pending) {
      if (!automatic) this.pendingAutomatic = false;
      return this.pending;
    }
    this.pendingAutomatic = automatic;
    this.open++;
    const p = this.tail.then(async () => {
      this.pending = null;
      const auto = this.pendingAutomatic;
      if (!this.alive()) return;
      await this.write(this.snapshot(), auto);
    });
    this.pending = p;
    this.tail = p.then(
      () => void this.open--,
      () => void this.open--,
    );
    return p;
  }

  /** True while a write is queued or running. */
  get busy(): boolean {
    return this.open > 0;
  }

  /** Resolves once no write is queued or running (bead wadjet-7md); never rejects. */
  async settled(): Promise<void> {
    while (this.open > 0) await this.tail;
  }
}

/**
 * Set a value and save; if the save fails, put the old value back (unless
 * something else has replaced the value meanwhile) and rethrow, so memory
 * never claims what the disk refused.
 */
export async function setAndSave<T>(get: () => T, set: (v: T) => void, value: T, save: () => Promise<void>): Promise<void> {
  const before = get();
  set(value);
  try {
    await save();
  } catch (e) {
    if (Object.is(get(), value)) set(before);
    throw e;
  }
}

/** The Notice shown once when a new world steps aside for synced settings (bead wadjet-1ou). */
export const YIELD_NOTICE =
  "Wadjet found this vault's synced settings after starting a new world here, so it did not save over them. Reload Obsidian (or turn the plugin off and on) to use the synced world.";

/** What a refused save rejects with, so a caller that rolls back on failure does. */
export const YIELD_ERROR = "Wadjet did not save: this vault's synced settings arrived after it started a new world here. Reload Obsidian to use them.";

/** The Notice shown when data.json was not what the new world's first write put there (bead wadjet-1ou). */
export const CONFLICT_NOTICE =
  "A synced copy of Wadjet's settings arrived while Wadjet was saving its new world in this vault. Wadjet will not save again this session. Reload Obsidian (or turn the plugin off and on) to use the synced copy.";

/** What the first write rejects with when the disk does not hold what it wrote. */
export const CONFLICT_ERROR = "Wadjet's first save of a new world met a synced copy of its settings. Reload Obsidian to use the synced copy.";

/** Why a new world yielded: synced settings found before writing, or a different file found after the first write. */
export type YieldReason = "synced" | "conflict";

/**
 * JSON with object keys sorted, as a value round-trips through data.json
 * (undefined members dropped), so two settings objects compare by content.
 */
export function canonicalJson(v: unknown): string {
  const plain: unknown = v === undefined ? null : JSON.parse(JSON.stringify(v));
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x !== null && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, sort(o[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(sort(plain));
}

/**
 * The first save of a new world (bead wadjet-1ou). A world with no data.json
 * may be a fresh device that Obsidian Sync has not reached yet, so it is not
 * saved at startup; its first save waits for a change, and before writing
 * re-reads the disk. If settings have arrived meanwhile (or the host reports
 * an outside change), the world yields: nothing is written, the user is told
 * once, and every later save is refused until the plugin is reloaded. After
 * one successful save the world is no longer new.
 *
 * The first write must be the user's: an automatic save (another plugin or a
 * script moving the day at startup, before a slow Sync has delivered) while
 * the world is new writes nothing and resolves; the change stays in memory
 * and goes to disk with the first user-initiated save. Once saved, automatic
 * saves write as any other.
 *
 * Right after the first write the disk is read once more; if it does not hold
 * what was written, a synced copy arrived during the write: the world yields
 * and says so. That cannot undo a lost copy, only make it visible.
 *
 * - `saved`: an existing world, or a new one that has saved; saves pass.
 * - `new`: started with no data.json and not saved yet.
 * - `yielded`: synced settings arrived while new; every save is refused.
 */
export class FirstSave {
  private state: "saved" | "new" | "yielded" = "saved";
  /** true while a write that began in the `new` state is running: an outside change then is most likely that write */
  private writing = false;
  /**
   * What data.json holds as far as Wadjet knows (canonical JSON): what it loaded, its last successful write, or
   * the last outside copy it adopted; null when unknown. An outside change that reads back as this is an echo
   * of Wadjet's own write (bead wadjet-7md).
   */
  private known: string | null = null;

  /**
   * @param read the host's loadData: what is on disk now
   * @param onYield told once, when the world yields, and why
   */
  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly onYield: (reason: YieldReason) => void,
  ) {}

  get current(): "saved" | "new" | "yielded" {
    return this.state;
  }

  /** Whether `data` (as read from data.json) is what Wadjet last loaded, wrote or adopted. */
  isKnown(data: unknown): boolean {
    return this.known !== null && canonicalJson(data) === this.known;
  }

  /** data.json was read (at load) or an outside copy adopted: it holds `data` now. */
  noteDisk(data: unknown): void {
    this.known = canonicalJson(data);
  }

  /** The world started with no data.json. */
  startNew(): void {
    this.state = "new";
  }

  /**
   * The host's saveData, behind the first-save check. Rejects with YIELD_ERROR once yielded, and with
   * CONFLICT_ERROR when the first write is found overwritten. An automatic save while new resolves, writing nothing.
   */
  guard(write: (data: unknown) => Promise<void>): (data: unknown, automatic?: boolean) => Promise<void> {
    return async (data, automatic = false) => {
      if (this.state === "new" && automatic) return;
      if (this.state === "new") {
        // a read that throws (a corrupt or empty data.json) rejects here: nothing written, still new
        const found = await this.read();
        if (found !== null && found !== undefined) this.yieldNow("synced");
      }
      if (this.state === "yielded") throw new Error(YIELD_ERROR);
      // what is written, taken now: `data` is the live settings object, which may change while the write runs
      const sent = canonicalJson(data);
      if (this.state !== "new") {
        await write(data);
        this.known = sent;
        return;
      }
      this.writing = true;
      try {
        await write(data);
        let same = false;
        try {
          same = canonicalJson(await this.read()) === sent;
        } catch {
          same = false;
        }
        if (!same) {
          this.yieldNow("conflict");
          throw new Error(CONFLICT_ERROR);
        }
        this.state = "saved";
        this.known = sent;
      } finally {
        this.writing = false;
      }
    };
  }

  /** data.json changed on disk from outside (the host's onExternalSettingsChange). */
  external(): void {
    if (this.state === "new" && !this.writing) this.yieldNow("synced");
  }

  private yieldNow(reason: YieldReason): void {
    if (this.state !== "new") return;
    this.state = "yielded";
    this.onYield(reason);
  }
}

/**
 * data.json changed from outside on a saved world (bead wadjet-7md): what to adopt, or null to keep the
 * settings in memory. Waits for any queued or running write first and reads after it, so a stale outside
 * copy never lands over a newer local write; a write queued while reading means read again. Null when the
 * read fails or is not an object (a partial Sync write: another change event follows), when it is what
 * Wadjet last loaded, wrote or adopted (its own write echoing), or when `alive` turns false.
 */
export async function readExternal(deps: { read: () => Promise<unknown>; queue: SaveQueue; first: FirstSave; alive: () => boolean; log?: (msg: string, e?: unknown) => void }): Promise<Record<string, unknown> | null> {
  const log = deps.log ?? ((msg: string, e?: unknown) => console.warn(`U+13080 Weather: ${msg}`, ...(e === undefined ? [] : [e])));
  for (;;) {
    await deps.queue.settled();
    if (!deps.alive()) return null;
    let found: unknown;
    try {
      found = await deps.read();
    } catch (e) {
      log("data.json changed but could not be read; keeping the settings in memory.", e);
      return null;
    }
    if (!deps.alive()) return null;
    if (deps.queue.busy) continue;
    if (found === null || typeof found !== "object" || Array.isArray(found)) {
      log("data.json changed but does not hold settings; keeping the settings in memory.");
      return null;
    }
    if (deps.first.isKnown(found)) return null;
    return found as Record<string, unknown>;
  }
}
