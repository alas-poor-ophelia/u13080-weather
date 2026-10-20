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
 *   definition and the registration (the "Calendar source" row can switch
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
import type { WadjetSettings } from "./settings";
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

  /** The stored definition's fault, or null (also null when the world stores none). */
  fault(): string | null {
    const f = this.seshat?.fault;
    return f ? (f.line === undefined ? f.message : `line ${f.line}: ${f.message}`) : null;
  }

  /**
   * Make `id` the active calendar (the "Calendar source" row, opt-out). The
   * stored definition stays when the world leaves `seshat`. Fires
   * time-changed and adapters-changed once each when the effective calendar
   * changed. A failed save puts the old choice back.
   */
  async setActive(id: string): Promise<void> {
    const s = this.host.settings();
    const before = this.host.time.active;
    const prevId = s.activeTimeAdapter;
    s.activeTimeAdapter = id;
    try {
      await this.host.save();
    } catch (e) {
      if (s.activeTimeAdapter === id) s.activeTimeAdapter = prevId;
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
    const before = { definition: s.calendar.definition, had: "definition" in s.calendar, active: s.activeTimeAdapter };
    s.calendar.definition = prepared.text;
    s.activeTimeAdapter = SESHAT_ID;
    try {
      await this.host.save();
    } catch (e) {
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
    s.calendar.definition = prepared.text;
    try {
      await this.host.save();
    } catch (e) {
      if (s.calendar.definition === prepared.text) s.calendar.definition = prev;
      throw e;
    }
    const a = this.mount(prepared.text);
    this.host.rebuild();
    const active = this.host.time.active === a;
    if (active && a.configHash() !== hashBefore) this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }
}
