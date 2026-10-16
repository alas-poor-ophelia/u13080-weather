/**
 * Settings persistence without Obsidian imports, so it can be tested with a
 * fake `saveData`.
 *
 * `SaveQueue` runs one write at a time. Each write reads the settings
 * snapshot when it STARTS, so the last write to land is always the newest
 * state, whatever order the host's promises settle in. Calls made while a
 * write is waiting to start share that write (coalescing); a call made while
 * a write is running queues one more.
 */
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  /** the queued write that has not started yet, shared by every save() until it starts */
  private pending: Promise<void> | null = null;

  /**
   * @param write the host's saveData
   * @param snapshot the settings object as it is now
   * @param alive false once the plugin is unloaded; a write that has not started by then is skipped
   */
  constructor(
    private readonly write: (data: unknown) => Promise<void>,
    private readonly snapshot: () => unknown,
    private readonly alive: () => boolean,
  ) {}

  /** Resolves once a write that started after this call has finished; rejects if that write failed. */
  save(): Promise<void> {
    if (this.pending) return this.pending;
    const p = this.tail.then(async () => {
      this.pending = null;
      if (!this.alive()) return;
      await this.write(this.snapshot());
    });
    this.pending = p;
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
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
