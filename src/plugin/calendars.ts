/**
 * Which calendar a world runs, and the stored Seshat definition's life cycle
 * (docs/SESHAT-v0.md §13.2, §13.7, §13.11 B2/M1/M3). Pure (no Obsidian
 * imports) so main.ts delegates and the tests drive it directly.
 *
 * - The `seshat` adapter is registered only while the world stores a
 *   definition; it shares the current day, its writer and its listeners with
 *   the internal calendar.
 * - Every switch goes through `setActive`: settings, the registry's active
 *   id, World's keys and the active subscription move together, and
 *   `time-changed` and `adapters-changed` fire once each. While this class
 *   registers `seshat` itself, `quiet` is true and main.ts skips the registry
 *   echo it would otherwise turn into events. Opting out keeps the
 *   definition and the registration (the settings' Calendar plugin chooser can switch
 *   back); nothing unregisters `seshat` while the plugin runs.
 * - A definition is stored only as printed by `prepareDefinition` (NFC,
 *   parsed, validated, world-checked). A stored value that cannot run is a
 *   fault: kept byte for byte, never re-printed, never replaced by the
 *   legacy calendar.
 * - Writes roll back: a failed save puts every field back and leaves the
 *   running adapter as it was.
 */
import type { TimeRegistry } from "./time/adapter";
import { prepareDefinition, SeshatCalendar } from "./time/seshat";
import type { PreviousCalendar, WadjetSettings } from "./settings";
import type { World } from "./world";

export const SESHAT_ID = "seshat";
export const INTERNAL_ID = "internal";

export interface CalendarsHost {
  settings: () => WadjetSettings;
  time: TimeRegistry;
  world: World;
  /** save data.json; rejects when the write fails */
  save: () => Promise<void>;
  /** the shared current-day writer (store and save, rolling back on failure) */
  writeDay: (d: number) => Promise<void>;
  /** push the settings into World (fires profiles-changed when a key moved) */
  rebuild: () => void;
  emitTimeChanged: () => void;
  emitAdaptersChanged: () => void;
  syncActiveSubscription: () => void;
}

/** A definition the user offered could not be stored: why, and its line when the parser named one. */
export class DefinitionError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `Line ${line}: ${message}`);
    this.name = "DefinitionError";
  }
}

export class Calendars {
  /** the registered seshat adapter; null while the world stores no definition */
  seshat: SeshatCalendar | null = null;
  /** true while this class changes the registry itself */
  quiet = false;

  constructor(private readonly host: CalendarsHost) {
    const s = host.settings();
    // a world set to run a definition that stores none (a hand edit, a sync conflict) is a fault, never the internal calendar
    if (s.calendar.definition !== undefined || s.activeTimeAdapter === SESHAT_ID) this.mount(s.calendar.definition);
  }

  /** The adapter for the world's stored definition, created and registered once; later loads update it in place. */
  private mount(stored: unknown): SeshatCalendar {
    if (this.seshat) {
      this.seshat.update(stored);
      return this.seshat;
    }
    const s = this.host.settings;
    const a = new SeshatCalendar(stored, () => s().currentDayOrdinal, (d) => this.host.writeDay(d));
    this.quietly(() => void this.host.time.register(a));
    this.seshat = a;
    return a;
  }

  private quietly(f: () => void): void {
    this.quiet = true;
    try {
      f();
    } finally {
      this.quiet = false;
    }
  }

  /** The calendar as it is now, for the undo record (§15.9 S6): the stored definition (if any) and the active adapter. */
  private snapshot(): PreviousCalendar {
    const c = this.host.settings().calendar;
    return { ...("definition" in c ? { definition: c.definition } : {}), activeTimeAdapter: this.host.settings().activeTimeAdapter };
  }

  /** Put the undo record back as it was (a write that failed). */
  private restorePrevious(was: PreviousCalendar | undefined): void {
    const c = this.host.settings().calendar;
    if (was === undefined) delete c.previous;
    else c.previous = was;
  }

  /** The stored definition's fault, or null (also null when the world stores none). */
  fault(): string | null {
    const f = this.seshat?.fault;
    return f ? (f.line === undefined ? f.message : `line ${f.line}: ${f.message}`) : null;
  }

  /**
   * Make `id` the active calendar (the settings' Calendar plugin chooser, Change calendar…'s way back). The
   * stored definition stays when the world leaves `seshat`. Fires
   * time-changed and adapters-changed once each when the effective calendar
   * changed. A failed save puts the old choice back.
   */
  async setActive(id: string): Promise<void> {
    const s = this.host.settings();
    const before = this.host.time.active;
    const prevId = s.activeTimeAdapter;
    const wasPrevious = s.calendar.previous;
    if (id !== prevId) s.calendar.previous = this.snapshot();
    s.activeTimeAdapter = id;
    try {
      await this.host.save();
    } catch (e) {
      if (s.activeTimeAdapter === id) s.activeTimeAdapter = prevId;
      this.restorePrevious(wasPrevious);
      throw e;
    }
    this.host.world.setActiveAdapter(s.activeTimeAdapter);
    this.host.syncActiveSubscription();
    if (this.host.time.active !== before) {
      this.host.emitTimeChanged();
      this.host.emitAdaptersChanged();
    }
  }

  /**
   * Opt in: store `text` (checked and printed first) as the definition and
   * make `seshat` active, in one save. Throws DefinitionError, changing
   * nothing, when the text cannot run as a world calendar, or when it would
   * replace a different stored definition (one kept from an earlier opt-out,
   * or a faulted one kept byte for byte) without `replaceStored`. On a world
   * that already runs `seshat` it is a definition edit (saveDefinition).
   */
  async optIn(text: string, opts: { replaceStored?: boolean } = {}): Promise<void> {
    if (this.seshat && this.host.time.active === this.seshat) return this.saveDefinition(text);
    const prepared = prepareDefinition(text);
    if ("error" in prepared) throw new DefinitionError(prepared.error, prepared.line);
    const s = this.host.settings();
    const kept = s.calendar.definition;
    if (kept !== undefined && kept !== prepared.text && !opts.replaceStored) throw new DefinitionError("This world already stores a calendar definition; switching to another one replaces it, so it has to be asked for.");
    const before = { definition: s.calendar.definition, had: "definition" in s.calendar, active: s.activeTimeAdapter, previous: s.calendar.previous };
    s.calendar.previous = this.snapshot();
    s.calendar.definition = prepared.text;
    s.activeTimeAdapter = SESHAT_ID;
    try {
      await this.host.save();
    } catch (e) {
      this.restorePrevious(before.previous);
      if (s.calendar.definition === prepared.text) {
        if (before.had) s.calendar.definition = before.definition;
        else delete s.calendar.definition;
      }
      if (s.activeTimeAdapter === SESHAT_ID) s.activeTimeAdapter = before.active;
      throw e;
    }
    this.mount(prepared.text);
    this.host.world.setActiveAdapter(SESHAT_ID);
    this.host.syncActiveSubscription();
    this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }

  /**
   * Store an edited definition (the settings row, a repair). Throws
   * DefinitionError, changing nothing, when it cannot run. When the hash
   * moved, World fires profiles-changed all:true (its calendar key carries
   * the hash) and an active seshat fires time-changed; adapters-changed fires
   * whenever the stored text changed, since describe() and format() read it.
   */
  async saveDefinition(text: string): Promise<void> {
    const prepared = prepareDefinition(text);
    if ("error" in prepared) throw new DefinitionError(prepared.error, prepared.line);
    const s = this.host.settings();
    const prev = s.calendar.definition;
    if (prev === prepared.text && !this.seshat?.fault) return;
    const hashBefore = this.seshat?.configHash();
    const wasPrevious = s.calendar.previous;
    s.calendar.previous = this.snapshot();
    s.calendar.definition = prepared.text;
    try {
      await this.host.save();
    } catch (e) {
      if (s.calendar.definition === prepared.text) s.calendar.definition = prev;
      this.restorePrevious(wasPrevious);
      throw e;
    }
    const a = this.mount(prepared.text);
    this.host.rebuild();
    const active = this.host.time.active === a;
    if (active && a.configHash() !== hashBefore) this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }

  /** Whether `undo` would succeed: there is a record, and a definition it would run can run. */
  canUndo(): boolean {
    const p = this.host.settings().calendar.previous;
    if (!p) return false;
    // a stored definition is text; anything else would be put back as garbage
    if ("definition" in p && typeof p.definition !== "string") return false;
    if (p.activeTimeAdapter !== SESHAT_ID) return true;
    return typeof p.definition === "string" && !("error" in prepareDefinition(p.definition));
  }

  /**
   * Undo the last calendar change (bead wadjet-24p, §15.9 S6): the stored
   * definition and the active calendar go back to what they were before it,
   * and the current pair becomes the record, so undoing again redoes. One
   * save; a failed save changes nothing. Throws DefinitionError, changing
   * nothing, when there is no record or the definition it would run cannot
   * run. Fires time-changed when the running calendar changed, adapters-changed
   * always, and profiles-changed through World when the calendar's key moved.
   */
  async undo(): Promise<void> {
    const s = this.host.settings();
    const p = s.calendar.previous;
    if (!p) throw new DefinitionError("there is no calendar change to undo");
    if (!this.canUndo()) throw new DefinitionError("the calendar before the last change cannot run, so it cannot be restored");
    const was = { had: "definition" in s.calendar, definition: s.calendar.definition, active: s.activeTimeAdapter, previous: p };
    const activeBefore = this.host.time.active;
    const hashBefore = this.seshat?.configHash();
    s.calendar.previous = this.snapshot();
    if ("definition" in p) s.calendar.definition = p.definition;
    else delete s.calendar.definition;
    s.activeTimeAdapter = p.activeTimeAdapter;
    try {
      await this.host.save();
    } catch (e) {
      if (was.had) s.calendar.definition = was.definition;
      else delete s.calendar.definition;
      s.activeTimeAdapter = was.active;
      s.calendar.previous = was.previous;
      throw e;
    }
    // the adapter follows the stored value: a record with no definition leaves none loaded (Parallax, P3c step 5)
    if (s.calendar.definition !== undefined || s.activeTimeAdapter === SESHAT_ID) this.mount(s.calendar.definition);
    else this.seshat?.update(undefined);
    // a switch re-keys World first (a switch is not a profile change); without one, rebuild sees the edit and fires all:true
    if (s.activeTimeAdapter !== was.active) this.host.world.setActiveAdapter(s.activeTimeAdapter);
    this.host.rebuild();
    this.host.syncActiveSubscription();
    const active = this.host.time.active;
    if (active !== activeBefore || (active === this.seshat && this.seshat.configHash() !== hashBefore)) this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }
}
