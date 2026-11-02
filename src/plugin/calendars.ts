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
import { parse } from "../seshat";
import { moonRenames, renameMoonReferences, type MoonRenames } from "../studio/model/moon-rename";
import type { TimeRegistry } from "./time/adapter";
import { prepareDefinition, SeshatCalendar } from "./time/seshat";
import type { PreviousCalendar, WadjetSettings } from "./settings";
import { UNDO_STEPS } from "./settings";
import type { World } from "./world";
import { UPGRADE_FIRST, worldMode } from "./upgrade";

/**
 * A calendar change's kept weather (SESHAT-v0 §17.5 item 8): `removeKept` empties `settings.frozen` in the
 * change's own save (put back when the save fails).
 */
export interface KeptChoice {
  removeKept?: boolean;
}

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
  /**
   * A save renamed moons and their references in settings (bead wadjet-zoy):
   * called once the write landed and before anything is rebuilt, so an open
   * Studio renames the references its drafts hold while they all still carry
   * the old names.
   */
  moonsRenamed?: (renames: MoonRenames) => void;
}

/**
 * The moon renames between two stored definitions, matched by body UID (bead
 * wadjet-zoy): a body whose UID is on both sides and whose MOON name changed.
 * With `sameOrbit`, only a body whose period and epoch are unchanged counts
 * (undo's rule: a switch to another definition that happens to reuse a UID is
 * not a rename). A side that is not text or does not parse has none.
 */
export function definitionMoonRenames(before: unknown, after: unknown, opts: { sameOrbit?: boolean } = {}): Map<string, string> {
  const moons = (text: unknown) => {
    if (typeof text !== "string") return null;
    try {
      return (parse(text).bodies ?? []).flatMap((b) => (b.moon ? [{ id: b.id, name: b.moon.name, orbit: JSON.stringify([b.period, b.epoch]) }] : []));
    } catch {
      return null;
    }
  };
  const a = moons(before);
  const b = moons(after);
  if (!a || !b) return new Map();
  // a body whose orbit moved is matched under a second id, so it never pairs
  const keyed = (l: typeof a) => (opts.sameOrbit ? l.map((m) => ({ ...m, id: `${m.id}\u0000${m.orbit}` })) : l);
  return moonRenames(keyed(a), keyed(b));
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

  /**
   * Calendar writes run one at a time (§19.2): each changes settings, awaits the save, and on a failure puts back what
   * it changed, so two overlapping would undo each other's work. The last write still wins.
   */
  private turn: Promise<unknown> = Promise.resolve();
  private inTurn(write: () => Promise<void>): Promise<void> {
    const run = this.turn.then(write, write);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The calendar as it is now, for the undo record (§15.9 S6): the stored definition (if any) and the active adapter. */
  private snapshot(): PreviousCalendar {
    const c = this.host.settings().calendar;
    return { ...("definition" in c ? { definition: c.definition } : {}), activeTimeAdapter: this.host.settings().activeTimeAdapter };
  }

  /**
   * A calendar change is about to be stored: the calendar as it is now goes on the undo history, and what was undone
   * can no longer be redone. Returns what puts the records back, for a write that fails.
   */
  private record(): () => void {
    const c = this.host.settings().calendar;
    const undo = this.undoRecords();
    if (c.previous) c.earlier = [...(c.earlier ?? []), c.previous].slice(-(UNDO_STEPS - 1));
    c.previous = this.snapshot();
    delete c.undone;
    return undo;
  }

  /** What puts the undo records back as they are now. */
  private undoRecords(): () => void {
    const c = this.host.settings().calendar;
    const was = { previous: c.previous, earlier: c.earlier, undone: c.undone };
    return () => {
      if (was.previous === undefined) delete c.previous;
      else c.previous = was.previous;
      if (was.earlier === undefined) delete c.earlier;
      else c.earlier = was.earlier;
      if (was.undone === undefined) delete c.undone;
      else c.undone = was.undone;
    };
  }

  /**
   * A world on the previous generator never runs a calendar definition (SESHAT-v0 §17.5 item 9): it is upgraded
   * first. Throws DefinitionError, before anything changes, for a change that would make it run one. A world
   * stamped 0.0.3 that already runs a definition runs the current generator (worldMode) and is not refused.
   */
  private refusePrevious(): void {
    if (worldMode(this.host.settings()) === "previous") throw new DefinitionError(UPGRADE_FIRST);
  }

  /** Empty the kept weather when asked (`removeKept`); returns the undo for a save that failed. */
  private dropKept(opts: KeptChoice): () => void {
    if (!opts.removeKept) return () => undefined;
    const s = this.host.settings();
    const was = s.frozen;
    const none: unknown[] = [];
    s.frozen = none;
    return () => {
      if (s.frozen === none) s.frozen = was;
    };
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
  setActive(id: string, opts: KeptChoice = {}): Promise<void> {
    return this.inTurn(() => this.doSetActive(id, opts));
  }

  private async doSetActive(id: string, opts: KeptChoice): Promise<void> {
    if (id === SESHAT_ID) this.refusePrevious();
    const s = this.host.settings();
    const before = this.host.time.active;
    const prevId = s.activeTimeAdapter;
    const modeBefore = worldMode(s);
    const unrecord = id !== prevId ? this.record() : () => undefined;
    s.activeTimeAdapter = id;
    const undrop = this.dropKept(opts);
    try {
      await this.host.save();
    } catch (e) {
      if (s.activeTimeAdapter === id) s.activeTimeAdapter = prevId;
      unrecord();
      undrop();
      throw e;
    }
    this.host.world.setActiveAdapter(s.activeTimeAdapter);
    // a 0.0.3 world leaving a definition runs the previous generator again (worldMode): World takes the mode
    if (opts.removeKept || worldMode(s) !== modeBefore) this.host.rebuild();
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
  optIn(text: string, opts: { replaceStored?: boolean } & KeptChoice = {}): Promise<void> {
    return this.inTurn(() => this.doOptIn(text, opts));
  }

  private async doOptIn(text: string, opts: { replaceStored?: boolean } & KeptChoice): Promise<void> {
    this.refusePrevious();
    if (this.seshat && this.host.time.active === this.seshat) return this.doSaveDefinition(text, opts.removeKept ? { removeKept: true } : {});
    const prepared = prepareDefinition(text);
    if ("error" in prepared) throw new DefinitionError(prepared.error, prepared.line);
    const s = this.host.settings();
    const kept = s.calendar.definition;
    if (kept !== undefined && kept !== prepared.text && !opts.replaceStored) throw new DefinitionError("This world already stores a calendar definition; switching to another one replaces it, so it has to be asked for.");
    const before = { definition: s.calendar.definition, had: "definition" in s.calendar, active: s.activeTimeAdapter };
    const unrecord = this.record();
    s.calendar.definition = prepared.text;
    s.activeTimeAdapter = SESHAT_ID;
    const undrop = this.dropKept(opts);
    try {
      await this.host.save();
    } catch (e) {
      undrop();
      unrecord();
      if (s.calendar.definition === prepared.text) {
        if (before.had) s.calendar.definition = before.definition;
        else delete s.calendar.definition;
      }
      if (s.activeTimeAdapter === SESHAT_ID) s.activeTimeAdapter = before.active;
      throw e;
    }
    this.mount(prepared.text);
    this.host.world.setActiveAdapter(SESHAT_ID);
    if (opts.removeKept) this.host.rebuild();
    this.host.syncActiveSubscription();
    this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }

  /**
   * Rename the references of `renames` in settings (zones, device presets);
   * returns the undo for a save that failed.
   */
  private renameReferences(renames: MoonRenames): () => void {
    const s = this.host.settings();
    const was = { zones: s.zones, presets: s.devicePresets };
    const renamed = renameMoonReferences(s, renames);
    s.zones = renamed.zones;
    if (renamed.devicePresets !== undefined) s.devicePresets = renamed.devicePresets;
    return () => {
      if (s.zones === renamed.zones) s.zones = was.zones;
      if (renamed.devicePresets !== was.presets && s.devicePresets === renamed.devicePresets && was.presets !== undefined) s.devicePresets = was.presets;
    };
  }

  /**
   * Store an edited definition (the settings row, a repair). Throws
   * DefinitionError, changing nothing, when it cannot run. When the hash
   * moved, World fires profiles-changed all:true (its calendar key carries
   * the hash) and an active seshat fires time-changed; adapters-changed fires
   * whenever the stored text changed, since describe() and format() read it.
   *
   * `renames` (bead wadjet-zoy): moons this edit renames, whose references in
   * zones and device presets are renamed in the same save; `"byUid"` derives
   * them from the stored and the new text (Edit definition: a VBODY whose UID
   * stayed and whose MOON name changed). None by default: the Studio Save has
   * renamed them itself, and Change calendar's switch is not a rename.
   */
  saveDefinition(text: string, opts: { renames?: MoonRenames | "byUid" } & KeptChoice = {}): Promise<void> {
    return this.inTurn(() => this.doSaveDefinition(text, opts));
  }

  private async doSaveDefinition(text: string, opts: { renames?: MoonRenames | "byUid" } & KeptChoice): Promise<void> {
    const prepared = prepareDefinition(text);
    if ("error" in prepared) throw new DefinitionError(prepared.error, prepared.line);
    const s = this.host.settings();
    const prev = s.calendar.definition;
    if (prev === prepared.text && !this.seshat?.fault) return;
    const hashBefore = this.seshat?.configHash();
    const renames = opts.renames === "byUid" ? definitionMoonRenames(prev, prepared.text) : (opts.renames ?? new Map<string, string>());
    const unrecord = this.record();
    s.calendar.definition = prepared.text;
    const unrename = this.renameReferences(renames);
    const undrop = this.dropKept(opts);
    try {
      await this.host.save();
    } catch (e) {
      if (s.calendar.definition === prepared.text) s.calendar.definition = prev;
      unrecord();
      unrename();
      undrop();
      throw e;
    }
    if (renames.size > 0) this.host.moonsRenamed?.(renames);
    const a = this.mount(prepared.text);
    this.host.rebuild();
    const active = this.host.time.active === a;
    if (active && a.configHash() !== hashBefore) this.host.emitTimeChanged();
    this.host.emitAdaptersChanged();
  }

  /**
   * Follow settings replaced from outside (Sync delivered a newer data.json; bead wadjet-7md). `adopt`
   * swaps the settings in; nothing is saved. The adapter follows the stored definition as undo's does
   * (remounted when the text changed), the world switches calendar if the stored choice did, and World is
   * rebuilt (profiles-changed, all:true when the seed or the running calendar's config moved). Fires
   * time-changed when the running calendar, its config or the current day changed, and adapters-changed
   * when the running calendar or the stored text changed.
   */
  follow(adopt: () => void): void {
    const before = this.host.settings();
    const was = { active: this.host.time.active, id: before.activeTimeAdapter, text: before.calendar.definition, day: before.currentDayOrdinal };
    const hashOf = (a: typeof was.active) => {
      try {
        return a?.configHash();
      } catch {
        return undefined;
      }
    };
    const hashBefore = hashOf(was.active);
    adopt();
    const s = this.host.settings();
    const textChanged = s.calendar.definition !== was.text;
    if (s.calendar.definition !== undefined || s.activeTimeAdapter === SESHAT_ID) {
      if (textChanged || !this.seshat) this.mount(s.calendar.definition);
    } else this.seshat?.update(undefined);
    if (s.activeTimeAdapter !== was.id) this.host.world.setActiveAdapter(s.activeTimeAdapter);
    this.host.rebuild();
    this.host.syncActiveSubscription();
    const active = this.host.time.active;
    if (active !== was.active || hashOf(active) !== hashBefore || s.currentDayOrdinal !== was.day) this.host.emitTimeChanged();
    if (active !== was.active || textChanged) this.host.emitAdaptersChanged();
  }

  /** Whether record `p` can be put back: a definition it would run can run. */
  private runnable(p: PreviousCalendar | undefined): boolean {
    if (!p) return false;
    // a stored definition is text; anything else would be put back as garbage
    if ("definition" in p && typeof p.definition !== "string") return false;
    if (p.activeTimeAdapter !== SESHAT_ID) return true;
    return typeof p.definition === "string" && !("error" in prepareDefinition(p.definition));
  }

  /** Whether `undo` would succeed: there is a record, and a definition it would run can run. */
  canUndo(): boolean {
    return this.runnable(this.host.settings().calendar.previous);
  }

  /** Whether `redo` would succeed. */
  canRedo(): boolean {
    const u = this.host.settings().calendar.undone;
    return this.runnable(u?.[u.length - 1]);
  }

  /**
   * Undo the last calendar change (bead wadjet-24p, §15.9 S6): the stored
   * definition and the active calendar go back to what they were before it,
   * and the current pair can be redone. Undoing again steps back further, through
   * the last UNDO_STEPS changes. One save; a failed save changes nothing. Throws DefinitionError, changing
   * nothing, when there is no record or the definition it would run cannot
   * run. Fires time-changed when the running calendar changed, adapters-changed
   * always, and profiles-changed through World when the calendar's key moved.
   * A moon the change renamed (same body UID and orbit, another name) is
   * renamed back with its references in the same save, and forward again on
   * redo (bead wadjet-zoy; derived from the two definitions, nothing stored).
   */
  undo(opts: KeptChoice = {}): Promise<void> {
    return this.inTurn(() => this.doUndo(opts));
  }

  private async doUndo(opts: KeptChoice): Promise<void> {
    const c = this.host.settings().calendar;
    const p = c.previous;
    if (!p) throw new DefinitionError("there is no calendar change to undo");
    return this.restore(p, opts, () => {
      c.undone = [...(c.undone ?? []), this.snapshot()].slice(-UNDO_STEPS);
      const older = c.earlier?.[c.earlier.length - 1];
      if (older) c.previous = older;
      else delete c.previous;
      if (c.earlier && c.earlier.length > 1) c.earlier = c.earlier.slice(0, -1);
      else delete c.earlier;
    });
  }

  /** Put back the change undone last. The same events as `undo`. */
  redo(opts: KeptChoice = {}): Promise<void> {
    return this.inTurn(() => this.doRedo(opts));
  }

  private async doRedo(opts: KeptChoice): Promise<void> {
    const c = this.host.settings().calendar;
    const p = c.undone?.[c.undone.length - 1];
    if (!p) throw new DefinitionError("there is no calendar change to redo");
    return this.restore(p, opts, () => {
      if (c.previous) c.earlier = [...(c.earlier ?? []), c.previous].slice(-(UNDO_STEPS - 1));
      c.previous = this.snapshot();
      if (c.undone!.length > 1) c.undone = c.undone!.slice(0, -1);
      else delete c.undone;
    });
  }

  /** Store record `p` as the calendar, `move` having moved the records (undo's or redo's way). */
  private async restore(p: PreviousCalendar, opts: KeptChoice, move: () => void): Promise<void> {
    const s = this.host.settings();
    if (p.activeTimeAdapter === SESHAT_ID) this.refusePrevious();
    if (!this.runnable(p)) throw new DefinitionError("the calendar before the last change cannot run, so it cannot be restored");
    const was = { had: "definition" in s.calendar, definition: s.calendar.definition, active: s.activeTimeAdapter };
    const activeBefore = this.host.time.active;
    const hashBefore = this.seshat?.configHash();
    const unmove = this.undoRecords();
    move();
    if ("definition" in p) s.calendar.definition = p.definition;
    else delete s.calendar.definition;
    s.activeTimeAdapter = p.activeTimeAdapter;
    const renames = definitionMoonRenames(was.definition, s.calendar.definition, { sameOrbit: true });
    const unrename = this.renameReferences(renames);
    const undrop = this.dropKept(opts);
    try {
      await this.host.save();
    } catch (e) {
      undrop();
      if (was.had) s.calendar.definition = was.definition;
      else delete s.calendar.definition;
      s.activeTimeAdapter = was.active;
      unmove();
      unrename();
      throw e;
    }
    if (renames.size > 0) this.host.moonsRenamed?.(renames);
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
