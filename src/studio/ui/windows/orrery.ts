/**
 * Seshat · ORRERY (docs/SESHAT-v0.md §18; bead wadjet-b6x, slices 1a-ii and
 * 5a): the world's calendar definition drawn as a machine.
 *
 * - On a Seshat world it draws the DRAFT: `draftAst(world.calendar,
 *   calendarBase)` (model/orrery-body.ts `draftReader`), so an edit anywhere
 *   in the Studio shows here, and the Orrery's own edits go into the same
 *   draft, Save and undo. A draft without the AST layer (another build's
 *   state) draws the stored definition, read-only.
 * - Editors, slice 5a: the body inspector (windows/orrery-body.ts) and the
 *   parts list's ＋ body. Slice 5b: the year, slot unit and slot inspectors
 *   (windows/orrery-slots.ts). The units group shows no ＋: adding a slot
 *   unit (or a cycle) waits for its editor; a slot is added from the slot
 *   unit's own inspector. Slice 5c: the gear inspector
 *   (windows/orrery-gears.ts) and the gears group's ＋ gear.
 * - A draft that does not run (slots that no longer fill their year, the
 *   commonest outcome of a slot edit) keeps the editors open: the scope,
 *   list and NOW draw the last draft that ran, the verdict and TEXT are the
 *   draft's own, and the issue strip says the scope is behind.
 * - Every edit runs behind the session's world confirm;
 *   a click or typed value is one undo step, and a knob drag is one too: its
 *   frames update the store without history and its end calls `snapshot()`
 *   (store.ts). A refusal shows its reason in the inspector and changes
 *   nothing. The title chip shows ● while the calendar draft is dirty, and
 *   its menu's "↺ revert calendar edits" puts the whole calendar part of the
 *   draft (form, seasons and moon edits too) back to its base, as one undo
 *   step, behind the world confirm like every other edit.
 *
 * - A 3-column body (the handoff's 216 px | scope | 284 px): the parts list,
 *   the scope (ui/orrery-canvas.ts) with its view switch, hover tag,
 *   transport, LCD, season strip and scrub bar, and the inspector (NOW from
 *   `partInfo`, chips to related parts, TEXT from `partText`).
 * - The window holds its own day (D7), seeded from today and clamped to the
 *   day line. It never moves `view.window` or the settings.
 * - `problems()` runs on a 200 ms trailing debounce (§18.6 item 7); the last
 *   verdict lights the LEDs, and the issue strip shows the first message.
 * - Fit (§18.6 item 9): the panel is 1200 px wide, which the window CSS caps
 *   at the box − 16; the body height follows the Studio box between 480 and
 *   640 px, and below the centre column's 280 px floor the scope is hidden.
 * - A legacy world, another plugin's calendar and a definition that cannot
 *   run each show a plain message, never an error (§18.6 item 3). The title
 *   bar's calendar chip is the way in on every world (item 12): its menu
 *   opens Change calendar… on the chosen preset, and holds the scope's theme
 *   and scanlines (§18.4 Q2), remembered per Studio view.
 * - The Orrery | Form toggle before the chip is added by
 *   `calendar-mode.ts` (slice 1b), which wraps this builder.
 */
import { Menu, type EventRef } from "obsidian";
import { printPart, type CalendarAst, type PartId, type Problem } from "../../../seshat";
import { OptInModal } from "../../../plugin/calendar-modals";
import { WORLD_PRESETS } from "../../../plugin/opt-in";
import { draftOf, type CalendarDraft, type CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { addBody, draftReader } from "../../model/orrery-body";
import { addGearPart } from "../../model/orrery-gears";
import { buildOrrery, clampDay, partInfo, partText, problemsByPart, orreryProblems, type OrreryModel, type ViewName } from "../../model/orrery-geometry";
import { needsWorldConfirm } from "../../model/world-confirm";
import { ORRERY_RATES, ORRERY_THEMES, orreryFit, scrubDay, scrubFraction, scrubSegments, seasonSegments, stepDay, stepYear, type OrreryTheme } from "../../model/orrery-transport";
import type { StudioIssue } from "../../model/validation";
import { createSegmented, type SegmentedComponent } from "../components";
import { createOrreryCanvas, type OrreryCanvas } from "../orrery-canvas";
import { beginDrag, markDragTarget } from "../pointer";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";
import { confirmWorldEdit, type WorldSubject } from "../world-confirm-modal";
import { buildBodyEditor, type EditPhase, type PartEditor } from "./orrery-body";
import { buildGearEditor } from "./orrery-gears";
import { buildSlotEditor, buildSlotUnitEditor, buildYearEditor } from "./orrery-slots";

/** The id this window is registered and opened under. */
export const ORRERY_WINDOW = "orrery";

/** §18.6 item 7: `problems()` runs this long after the last change. */
export const PROBLEMS_DEBOUNCE_MS = 200;

type Source = "seshat" | "legacy" | "plugin" | "fault";

const VIEW_OPTIONS: ReadonlyArray<{ value: ViewName; label: string }> = [
  { value: "iso", label: "ISO" },
  { value: "top", label: "TOP" },
  { value: "side", label: "SIDE" },
];

const THEME_LABEL: Readonly<Record<OrreryTheme, string>> = { phosphor: "Phosphor", amber: "Amber", studio: "Studio" };

/** Which calendar the world runs, read from the live adapter (the Orrery draws what is stored). */
function sourceOf(ctx: SurfaceContext): Source {
  const id = ctx.plugin.time.active?.id;
  if (id === "seshat") return ctx.plugin.calendars.fault() !== null || !ctx.plugin.calendars.seshat?.definition() ? "fault" : "seshat";
  if (id === undefined || id === "internal") return "legacy";
  return "plugin";
}

/** A part's text as one line, for the WRITES footer. */
function oneLine(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join(" ");
}

/** The parts a part is wired to, for the inspector's chips (cheap: read off the AST). */
function relatedParts(ast: CalendarAst, part: PartId | null): PartId[] {
  if (part === null) return [];
  const [kind, id] = part.split(":") as [string, string | undefined];
  const out: PartId[] = [];
  const cycles = ast.units.filter((u) => u.kind === "cycle");
  if (kind === "body") for (const u of cycles) if (u.kind === "cycle" && u.crossing?.body?.id === id) out.push(`crossing:${u.id}`);
  if (kind === "crossing" || kind === "train") {
    const u = cycles.find((x) => x.id === id);
    if (u?.kind === "cycle" && u.crossing) {
      if (u.crossing.body) out.push(`body:${u.crossing.body.id}`);
      if (kind === "crossing" && u.crossing.index) out.push(`train:${u.id}`);
      if (kind === "train") out.push(`crossing:${u.id}`);
      (u.stages ?? []).forEach((_, i) => out.push(`stage:${u.id}:${i}`));
    }
  }
  if (kind === "gear") {
    for (const u of ast.units) {
      if (u.kind === "slots") u.slots.forEach((s, i) => (s.gears ?? []).some((g) => g.gear === id) && out.push(`slot:${u.id}:${i}`));
      else if ((u.gears ?? []).some((g) => g.gear === id)) out.push(`unit:${u.id}`);
    }
  }
  if (kind === "slot") {
    const [, unit, n] = part.split(":") as [string, string, string];
    const u = ast.units.find((x) => x.id === unit);
    if (u?.kind === "slots") {
      out.push(`unit:${u.id}`);
      for (const g of u.slots[Number(n)]?.gears ?? []) out.push(`gear:${g.gear}`);
    }
  }
  if (kind === "unit") {
    const u = ast.units.find((x) => x.id === id);
    if (u?.kind === "cycle") {
      for (const g of u.gears ?? []) out.push(`gear:${g.gear}`);
      if (u.crossing) out.push(`crossing:${u.id}`);
    } else if (u?.kind === "slots") out.push(`unit:${u.in}`);
  }
  if (kind === "stage") {
    if (cycles.some((u) => u.id === id && u.kind === "cycle" && u.crossing)) out.push(`crossing:${id}`);
  }
  return out;
}

export const buildOrreryWindow: WindowBuilder = (ctx) => {
  const root = createDiv({ cls: "wadjet-studio-orrery" });
  const empty = root.createDiv({ cls: "wadjet-studio-orrery-empty is-hidden" });
  const grid = root.createDiv({ cls: "wadjet-studio-orrery-grid" });
  const listEl = grid.createDiv({ cls: "wadjet-studio-orrery-list", attr: { role: "list", "aria-label": "Calendar parts" } });
  const scopeEl = grid.createDiv({ cls: "wadjet-studio-orrery-scope" });
  const inspEl = grid.createDiv({ cls: "wadjet-studio-orrery-inspector" });

  // ---- state (the window's own: never the store's view.window or the settings)
  let source: Source = sourceOf(ctx);
  let ast: CalendarAst | null = null;
  let day = Math.floor(clampDay(ctx.plugin.settings.currentDayOrdinal + 0.5).day);
  let selected: PartId | null = null;
  let hover: PartId | null = null;
  let playing = false;
  let rate: number = ORRERY_RATES[0];
  let view: ViewName = "iso";
  let model: OrreryModel | null = null;
  let emptyMessage = "";
  /** the last `problems()` verdict, the AST it is for, and whether a newer one is pending */
  let verdict: readonly Problem[] = [];
  let verdictFor: CalendarAst | null = null;
  let stale = false;
  let timer: number | null = null;
  let timerWin: Window | null = null;
  let errors: ReadonlySet<PartId> = new Set();
  // ---- the draft (slice 5a)
  const readDraft = draftReader();
  /** why the draft's pending field edits do not compile (the AST layer is drawn), or null */
  let draftError: string | null = null;
  /** the calendar part of the draft differs from its base (● on the chip) */
  let dirty = false;
  /** the Orrery edits the draft (a Seshat world whose draft carries the AST layer) */
  let editable = false;
  /** bumped whenever the drawn AST changes, so the inspector redraws */
  let revision = 0;
  /** a knob drag is under way: the inspector's controls stay as they are until it ends */
  let dragging = false;
  /** the last edit's refusal, shown in the inspector until the next edit or selection */
  let refusal: string | null = null;
  /** the world confirm is up for a drag (its frames are ignored until it closes) */
  let asking = false;
  /** the next AST change runs `problems()` at once, not after the debounce (a drag's end) */
  let flushNext = false;
  /** problems ran inside a paint: the chrome (LED, issue strip) is refreshed at its end */
  let chromeStale = false;
  let editor: PartEditor | null = null;
  /** the editor is being torn down: a knob's closing "end" only closes its undo step (no re-entrant paint) */
  let tearing = false;
  /** the last draft AST that runs, and the AST the scope draws (the draft, or that one while the draft does not run) */
  let lastDrawn: CalendarAst | null = null;
  let drawnAst: CalendarAst | null = null;
  /** the scope draws `lastDrawn`, not the draft */
  let behind = false;

  const look = (): { theme: OrreryTheme; scanlines: boolean } => ctx.store.get().view.orrery ?? { theme: "phosphor", scanlines: true };

  // ---- the scope
  const canvas: OrreryCanvas = createOrreryCanvas(scopeEl, {
    build: (d) => {
      if (!drawnAst) return null;
      const m = buildOrrery(drawnAst, d, { problems: verdict });
      return m.kind === "orrery" ? m : null;
    },
    onHover: (part) => {
      hover = part;
      paintHover();
    },
    onPick: (part) => select(part),
    onDay: (d) => {
      day = Math.floor(clampDay(d + 0.5).day);
      paint();
    },
    onStop: () => {
      playing = false;
      paint();
    },
  });
  const scan = canvas.el.createDiv({ cls: "wadjet-studio-orrery-scanlines" });
  canvas.el.createDiv({ cls: "wadjet-studio-orrery-vignette" });
  const viewsEl = canvas.el.createDiv({ cls: "wadjet-studio-orrery-views", attr: { "data-hint": "drag · orbit · wheel · zoom · double-click · reset · click a part to inspect it" } });
  const views: SegmentedComponent = createSegmented(viewsEl, {
    options: VIEW_OPTIONS.map((o) => ({ ...o })),
    value: view,
    onChange: (v) => {
      view = v as ViewName;
      canvas.setView(view);
    },
  });
  const hoverTag = canvas.el.createDiv({ cls: "wadjet-studio-orrery-hover is-hidden" });
  hoverTag.createSpan({ cls: "wadjet-studio-orrery-hover-dot" });
  const hoverName = hoverTag.createSpan({ cls: "wadjet-studio-orrery-hover-name" });
  const hoverKind = hoverTag.createSpan({ cls: "wadjet-studio-orrery-hover-kind" });

  const transport = scopeEl.createDiv({ cls: "wadjet-studio-orrery-transport" });
  const keys = transport.createDiv({ cls: "wadjet-studio-orrery-keys", attr: { "data-hint": "‹ › one day · « » one year · ▶ run the day line" } });
  function key(text: string, label: string, onClick: () => void): HTMLElement {
    const el = keys.createDiv({ cls: "wadjet-studio-orrery-key", text, attr: { role: "button", tabindex: "0", "aria-label": label } });
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      onClick();
    });
    return el;
  }
  key("«", "Back one year", () => moveYear(-1));
  key("‹", "Back one day", () => moveTo(stepDay(day, -1)));
  const playKey = key("▶", "Play", () => setPlaying(!playing));
  key("›", "Forward one day", () => moveTo(stepDay(day, 1)));
  key("»", "Forward one year", () => moveYear(1));
  const lcd = transport.createSpan({ cls: "wadjet-studio-orrery-lcd" });
  const dayLbl = transport.createSpan({ cls: "wadjet-studio-orrery-daylbl" });
  transport.createDiv({ cls: "wadjet-studio-orrery-spring" });
  transport.createSpan({ cls: "wadjet-studio-orrery-caps", text: "Rate" });
  const rates = createSegmented(transport.createDiv({ cls: "wadjet-studio-orrery-rates" }), {
    options: ORRERY_RATES.map((r) => ({ value: String(r), label: String(r) })),
    value: String(rate),
    onChange: (v) => {
      rate = Number(v);
      if (playing) canvas.setPlaying(rate);
    },
  });
  transport.createSpan({ cls: "wadjet-studio-orrery-unit", text: "d/s" });

  const strips = scopeEl.createDiv({ cls: "wadjet-studio-orrery-strips" });
  const seasonStrip = strips.createDiv({ cls: "wadjet-studio-orrery-seasons" });
  const scrub = strips.createDiv({ cls: "wadjet-studio-orrery-scrub", attr: { "data-hint": "this year's slots · drag to move the day", role: "slider", tabindex: "0", "aria-label": "Day of the year" } });
  markDragTarget(scrub);
  const scrubSegs = scrub.createDiv({ cls: "wadjet-studio-orrery-scrub-segs" });
  const playhead = scrub.createDiv({ cls: "wadjet-studio-orrery-playhead" });
  let cancelScrub: (() => void) | null = null;

  function scrubAt(clientX: number): void {
    if (!model) return;
    const r = scrub.getBoundingClientRect();
    if (r.width <= 0) return;
    moveTo(scrubDay(model.year, (clientX - r.left) / r.width));
  }
  function onScrubDown(ev: PointerEvent): void {
    if (ev.button !== 0 || !model) return;
    ev.preventDefault();
    setPlaying(false);
    const x0 = ev.clientX;
    scrubAt(x0);
    cancelScrub?.();
    cancelScrub = beginDrag(ev, {
      capture: scrub,
      onMove: (_m, dx) => scrubAt(x0 + dx),
      onEnd: () => (cancelScrub = null),
    });
  }
  function onScrubKey(ev: KeyboardEvent): void {
    const n = ev.key === "ArrowLeft" || ev.key === "ArrowDown" ? -1 : ev.key === "ArrowRight" || ev.key === "ArrowUp" ? 1 : 0;
    if (n === 0) return;
    ev.preventDefault();
    setPlaying(false);
    moveTo(stepDay(day, n));
  }
  scrub.addEventListener("pointerdown", onScrubDown);
  scrub.addEventListener("keydown", onScrubKey);

  // ---- the title bar's calendar chip and its menu
  const chip = createDiv({ cls: "wadjet-studio-orrery-chip is-tail", attr: { role: "button", tabindex: "0", "aria-haspopup": "menu", "aria-label": "Calendar and scope" } });
  const chipLabel = chip.createSpan({ cls: "wadjet-studio-orrery-chip-label" });
  chip.createSpan({ cls: "wadjet-studio-orrery-chip-caret", text: "▾" });
  function openMenu(): void {
    const menu = new Menu();
    const current = source === "seshat" ? ast?.name : null;
    for (const p of WORLD_PRESETS)
      menu.addItem((item) =>
        item
          .setTitle(p.ast.name)
          .setChecked(p.ast.name === current)
          .onClick(() => new OptInModal(ctx.plugin.app, ctx.plugin, () => {}, p.id).open()),
      );
    menu.addItem((item) => item.setTitle("Change calendar…").onClick(() => new OptInModal(ctx.plugin.app, ctx.plugin, () => {}).open()));
    if (editable)
      menu.addItem((item) =>
        item
          .setTitle("↺ revert calendar edits")
          .setDisabled(!dirty)
          .onClick(() => revert()),
      );
    menu.addSeparator();
    const now = look();
    for (const t of ORRERY_THEMES)
      menu.addItem((item) =>
        item
          .setTitle(`Scope: ${THEME_LABEL[t]}`)
          .setChecked(t === now.theme)
          .onClick(() => setLook({ ...look(), theme: t })),
      );
    menu.addItem((item) =>
      item
        .setTitle("Scanlines")
        .setChecked(now.scanlines)
        .onClick(() => setLook({ ...look(), scanlines: !look().scanlines })),
    );
    const box = chip.getBoundingClientRect();
    menu.showAtPosition({ x: box.left, y: box.bottom });
  }
  chip.addEventListener("click", openMenu);
  chip.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    openMenu();
  });

  function setLook(next: { theme: OrreryTheme; scanlines: boolean }): void {
    ctx.store.update((s) => {
      s.view.orrery = next;
    });
    paintLook();
  }
  function paintLook(): void {
    const l = look();
    canvas.setTheme(l.theme);
    scan.toggleClass("is-hidden", !l.scanlines);
    root.setAttr("data-theme", l.theme);
  }

  // ---- the window's chrome reads these
  function refreshChrome(): void {
    ctx.windows.renderAll(ctx.store.get());
  }

  // ---- validation, debounced (§18.6 item 7)
  function cancelProblems(): void {
    if (timer !== null && timerWin) timerWin.clearTimeout(timer);
    timer = null;
  }
  /** Run `problems()` on `of` now; the last verdict stays shown (marked stale) until then. */
  function runProblems(of: CalendarAst): void {
    cancelProblems();
    verdict = orreryProblems(of);
    verdictFor = of;
    stale = false;
    errors = new Set(problemsByPart(verdict).keys());
    canvas.invalidate();
  }
  function scheduleProblems(of: CalendarAst): void {
    cancelProblems();
    stale = true;
    timerWin = root.ownerDocument.defaultView ?? activeWindow;
    timer = timerWin.setTimeout(() => {
      timer = null;
      if (ast !== of) return;
      runProblems(of);
      paint();
      refreshChrome();
    }, PROBLEMS_DEBOUNCE_MS);
  }

  // ---- editing the draft (slice 5a)
  const baseOf = (st: ReturnType<typeof ctx.store.get>): CalendarDraft => st.calendarBase ?? st.saved.world.calendar;
  /** Rebuild the inspector from the draft (a cancelled confirm, a refusal): no control keeps a value the draft does not hold. */
  function redrawInspector(): void {
    inspKey = "";
    paint();
  }
  /**
   * One edit of the draft's calendar, behind the session's world confirm. `make` reads the draft as it is now.
   * A click or typed value is one undo step; drag frames update without history and the drag's end snapshots,
   * so a drag is one step (store.ts); the end also runs `problems()` at once.
   */
  function edit(make: (calendar: CalendarDraft, base: CalendarDraft) => CalendarEdit, phase: EditPhase, subject: WorldSubject = selected?.startsWith("body:") ? "moons" : "calendar"): void {
    if (tearing || closed) {
      // a knob destroyed mid-drag closes its gesture: its frames are already in the store, so they become one step
      if (phase === "end" && dragging) {
        dragging = false;
        ctx.store.snapshot();
      }
      return;
    }
    if (!editable) return;
    if (needsWorldConfirm()) {
      // the confirm cannot interrupt a live gesture: ask first, drag after
      if (phase === "drag" || phase === "end") {
        if (asking) return;
        asking = true;
        const after = () => {
          asking = false;
          dragging = false;
          redrawInspector();
        };
        confirmWorldEdit(ctx.plugin.app, ctx, subject, after, after);
        return;
      }
      confirmWorldEdit(ctx.plugin.app, ctx, subject, () => edit(make, phase, subject), redrawInspector);
      return;
    }
    if (asking) return;
    const st = ctx.store.get();
    const r = make(st.world.calendar, baseOf(st));
    if ((phase === "drag" || phase === "end") && !dragging) {
      // a drag's first frame: anything left uncommitted (a refresh from settings updates without history) becomes
      // its own step first, so undoing the drag goes back to where it began, not past that
      ctx.store.snapshot();
      dragging = true;
    }
    if ("refused" in r) {
      refusal = r.reason;
      editor?.setRefusal(r.reason);
      if (phase === "drag") return;
      dragging = false;
      // earlier frames of the drag may have moved the draft: they are its one step (no AST change is pending
      // from this refusal, so `flushNext` stays as it was: it is set on the success path only)
      if (phase === "end") ctx.store.snapshot();
      redrawInspector();
      return;
    }
    refusal = null;
    editor?.setRefusal(null);
    const write = (x: ReturnType<typeof ctx.store.get>) => {
      x.world.calendar = r.calendar;
    };
    if (phase === "drag") return void ctx.store.update(write);
    dragging = false;
    if (phase === "end") {
      flushNext = true;
      ctx.store.update(write);
      ctx.store.snapshot();
    } else ctx.store.update(write, { history: true });
    inspKey = "";
  }
  /** Put the calendar part of the draft back to its base: the draft drawn is the stored definition again. One undo step. */
  function revert(): void {
    if (!editable || !dirty) return;
    if (needsWorldConfirm()) return void confirmWorldEdit(ctx.plugin.app, ctx, "calendar", () => revertNow(), redrawInspector);
    revertNow();
  }
  function revertNow(): void {
    if (!editable || !dirty) return;
    dragging = false;
    ctx.store.update(
      (x) => {
        x.world.calendar = structuredClone(draftOf(baseOf(x)));
      },
      { history: true },
    );
    refusal = null;
    inspKey = "";
  }
  /** ＋ body: a new moon, selected (also when the edit waits for the world confirm). */
  function addBodyPart(): void {
    edit((c, b) => {
      const r = addBody(c, b, c.ast ?? ast!);
      if (!("refused" in r) && r.id !== undefined) {
        selected = `body:${r.id}`;
        listKey = "";
      }
      return r;
    }, "click", "moons");
  }

  /** ＋ gear: a new gear that feeds nothing, selected (also when the edit waits for the world confirm). */
  function addGearRow(): void {
    edit((c, b) => {
      const r = addGearPart(c, b);
      if (!("refused" in r) && r.id !== undefined) {
        selected = `gear:${r.id}`;
        listKey = "";
      }
      return r;
    }, "click", "calendar");
  }

  /** The editors' `selectAfter`: the part the edit in hand lands on (a moved, added or removed slot). */
  function selectAfter(part: PartId): void {
    selected = part;
    listKey = "";
  }

  // ---- moving the day
  function moveTo(next: number, jump = false): void {
    const d = Math.floor(clampDay(next + 0.5).day);
    if (d === day && !jump) return;
    day = d;
    canvas.setDay(day, jump);
    paint();
  }
  function moveYear(n: number): void {
    // read before stopping: the stop repaints, and a repaint may find no model
    const m = model;
    if (!m) return;
    setPlaying(false);
    moveTo(stepYear(m.ast, m.year, m.today.dayOfYear, n));
  }
  function setPlaying(on: boolean): void {
    if (on === playing) return;
    playing = on;
    canvas.setPlaying(on ? rate : null);
    paintTransport();
  }

  function select(part: PartId | null): void {
    if (part !== selected) refusal = null;
    // a selection rebuilds the inspector: a drag that never sent its end (a knob gone mid-gesture) is over
    dragging = false;
    selected = part;
    canvas.setHighlight({ selected, errors });
    paint();
    refreshChrome();
  }

  // ---- painting
  let listKey = "";
  function paintList(): void {
    const m = model;
    const k = m ? JSON.stringify([m.groups, selected, editable]) : "";
    if (k === listKey) return;
    listKey = k;
    listEl.empty();
    if (!m) return;
    for (const g of m.groups) {
      // a ＋ shows where its editor exists (slice 5a: bodies; 5c: gears); the other groups' ＋ wait for theirs
      const add = editable && (g.add === "body" || g.add === "gear") ? g.add : null;
      // a group's empty header is where its ＋ goes: an empty group without one is left out
      if (!g.rows.length && add === null) continue;
      const group = listEl.createDiv({ cls: "wadjet-studio-orrery-group" });
      const label = group.createDiv({ cls: "wadjet-studio-orrery-group-label" });
      label.createSpan({ text: g.label });
      if (add !== null) {
        const body = add === "body";
        const onAdd = body ? addBodyPart : addGearRow;
        const plus = label.createSpan({ cls: "wadjet-studio-orrery-add", text: "＋", attr: { role: "button", tabindex: "0", "aria-label": body ? "Add a body" : "Add a gear", "data-hint": body ? orreryHint("orrery.addBody") : orreryHint("orrery.addGear"), "data-add": add } });
        plus.addEventListener("click", onAdd);
        plus.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          onAdd();
        });
      }
      for (const r of g.rows) {
        const row = group.createDiv({ cls: "wadjet-studio-orrery-row", attr: { role: "listitem", tabindex: "0", "data-part": r.id, "aria-selected": r.id === selected ? "true" : "false" } });
        row.toggleClass("is-selected", r.id === selected);
        const led = row.createSpan({ cls: "wadjet-studio-orrery-led" });
        led.toggleClass("is-error", r.issues > 0);
        led.toggleClass("is-lit", r.issues === 0 && r.lit);
        if (r.issues > 0) led.setAttr("aria-label", `${r.issues} problem${r.issues === 1 ? "" : "s"}`);
        row.createSpan({ cls: "wadjet-studio-orrery-row-name", text: r.name });
        row.createSpan({ cls: "wadjet-studio-orrery-row-spec", text: r.spec });
        const pick = () => select(r.id === selected ? null : r.id);
        row.addEventListener("click", pick);
        row.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          pick();
        });
      }
    }
  }

  /** Whether `part` is a part of the draft (the scope may be drawing an older AST that lacks it). */
  function inDraft(part: PartId): boolean {
    if (!ast) return false;
    try {
      return printPart(ast, part) !== null;
    } catch {
      return true; // it is there, but prints with an error
    }
  }
  /** The inspector's header and NOW: the model's, or for a part only the draft has, its name and why NOW is empty. */
  function infoOf(m: OrreryModel): ReturnType<typeof partInfo> {
    const info = partInfo(m, selected);
    if (selected === null || !ast || !inDraft(selected)) return info;
    const [kind, id, n] = selected.split(":") as [string, string, string | undefined];
    // a slot of the older AST the scope draws may be another slot of the draft (an added one shifts the rest)
    if (info.code !== "—" && !(behind && kind === "slot")) return info;
    const u = ast.units.find((x) => x.id === id);
    const slot = kind === "slot" && u?.kind === "slots" ? u.slots[Number(n)] : undefined;
    const title = slot && u?.kind === "slots" ? (slot.name ?? `slot ${Number(n) + (u.number ?? 1)}`) : id;
    return { code: kind === "slot" ? "C2 · SLOT" : kind === "gear" ? "C3 · GEAR" : "C2", title, sub: "in the draft · the scope shows the last calendar that runs", now: [{ key: "this year", value: "— (the draft does not run)", tone: "err" }] };
  }
  /** The control in the inspector that has focus (its `data-part`), so a rebuild can give it back. */
  function focusedPart(): string | null {
    const a = inspEl.ownerDocument.activeElement;
    if (!a || !inspEl.contains(a)) return null;
    return a.closest("[data-part]")?.getAttribute("data-part") ?? null;
  }
  /** Give focus back to the control with `part` after a rebuild (a knob's dial, else the control itself). */
  function refocus(part: string | null): void {
    if (part === null) return;
    const el = Array.from(inspEl.querySelectorAll<HTMLElement>("[data-part]")).find((x) => x.getAttribute("data-part") === part);
    if (!el) return;
    const target = el.matches("input, [tabindex]") ? el : el.querySelector<HTMLElement>("input, [tabindex='0']");
    target?.focus();
  }

  let inspKey = "";
  function paintInspector(): void {
    const m = model;
    const k = m ? JSON.stringify([selected, m.today.day, verdictFor === ast, stale, revision, editable, behind]) : "";
    if (k === inspKey) return;
    inspKey = k;
    if (m && dragging && editor) {
      // mid-drag: the editor (and the knob under the pointer) stays; NOW and TEXT follow the draft
      paintReadouts(m);
      return;
    }
    // a keyboard edit rebuilds the inspector: the control that had focus gets it back (5a review)
    const hadFocus = focusedPart();
    const old = editor;
    editor = null;
    tearing = true;
    try {
      old?.destroy();
    } finally {
      tearing = false;
    }
    dragging = false;
    inspEl.empty();
    if (!m) return;
    buildInspector(m);
    refocus(hadFocus);
  }
  function buildInspector(m: OrreryModel): void {
    const info = infoOf(m);
    const head = inspEl.createDiv({ cls: "wadjet-studio-orrery-insp-head" });
    head.createSpan({ cls: "wadjet-studio-orrery-code", text: info.code });
    head.createDiv({ cls: "wadjet-studio-orrery-spring" });
    if (selected !== null) {
      const back = head.createSpan({ cls: "wadjet-studio-orrery-clear", text: "×", attr: { role: "button", tabindex: "0", "aria-label": "Back to the whole calendar" } });
      back.addEventListener("click", () => select(null));
      back.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        select(null);
      });
    }
    const title = inspEl.createDiv({ cls: "wadjet-studio-orrery-title", text: info.title });
    inspEl.createDiv({ cls: "wadjet-studio-orrery-sub", text: info.sub });
    nowEl = inspEl.createDiv({ cls: "wadjet-studio-orrery-section is-now" });
    paintNow(info.now);
    const [kind, id, n] = (selected ?? "").split(":") as [string, string | undefined, string | undefined];
    const draft = ast ?? m.ast;
    const host = (name: string): HTMLElement => inspEl.createDiv({ cls: "wadjet-studio-orrery-editor", attr: { "data-editor": name } });
    const unit = id === undefined ? undefined : draft.units.find((u) => u.id === id);
    if (editable && id !== undefined && (kind === "unit" || kind === "slot") && unit) {
      const deps = { ast: draft, unitId: id, refusal, edit, select: (part: PartId) => select(part), selectAfter };
      if (unit.kind === "cycle" && kind === "unit" && (unit.id === m.year.unit || unit.id === "year")) editor = buildYearEditor(host("year"), deps);
      else if (unit.kind === "slots" && kind === "unit") editor = buildSlotUnitEditor(host("slots"), { ...deps, lengths: lengthsOf(m, unit) });
      else if (unit.kind === "slots" && kind === "slot" && n !== undefined) editor = buildSlotEditor(host("slot"), title, { ...deps, index: Number(n), lengths: lengthsOf(m, unit) });
    }
    if (kind === "gear" && id !== undefined && editable) {
      const g = draft.gears.find((x) => x.id === id);
      // the occurrence of the unit the gear counts, on the window's day (none while the scope draws an older calendar)
      const index = !g || behind || m.ast !== ast ? null : g.on === m.year.unit ? m.year.index : (m.today.positions.get(g.on)?.index ?? null);
      editor = buildGearEditor(host("gear"), title, { ast: draft, gearId: id, index, refusal, edit, select: (part) => select(part), selectAfter });
    }
    if (kind === "body" && id !== undefined && editable) {
      const st = ctx.store.get();
      editor = buildBodyEditor(host("body"), title, {
        ast: draft,
        baseAst: baseOf(st).ast ?? null,
        calendar: st.world.calendar,
        bodyId: id,
        phase: m.today.bodies.get(id) ?? 0,
        refusal,
        edit,
        select: (part) => select(part),
      });
    }
    const related = relatedParts(m.ast, selected);
    if (related.length) {
      const chips = inspEl.createDiv({ cls: "wadjet-studio-orrery-chips" });
      for (const part of related) {
        const c = chips.createSpan({ cls: "wadjet-studio-orrery-link", attr: { role: "button", tabindex: "0", "data-part": part } });
        c.createSpan({ cls: "wadjet-studio-orrery-link-dot" }).toggleClass("is-error", errors.has(part));
        c.createSpan({ text: partInfo(m, part).title });
        c.addEventListener("click", () => select(part));
        c.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          select(part);
        });
      }
    }
    const text = inspEl.createDiv({ cls: "wadjet-studio-orrery-section is-text" });
    text.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Text" });
    textEl = text.createEl("pre", { cls: "wadjet-studio-orrery-text" });
    paintText(m);
  }
  let nowEl: HTMLElement | null = null;
  let textEl: HTMLElement | null = null;
  function paintNow(rows: ReturnType<typeof partInfo>["now"]): void {
    if (!nowEl) return;
    nowEl.empty();
    nowEl.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Now" });
    for (const r of rows) {
      const line = nowEl.createDiv({ cls: "wadjet-studio-orrery-now" });
      line.createSpan({ cls: "wadjet-studio-orrery-now-key", text: r.key });
      const v = line.createSpan({ cls: "wadjet-studio-orrery-now-value", text: r.value, attr: { title: r.value } });
      if (r.tone) v.setAttr("data-tone", r.tone);
    }
  }
  function paintText(m: OrreryModel): void {
    textEl?.setText(partText(ast ?? m.ast, selected) || "(this part writes no text of its own)");
  }
  /** This year's lengths of slot unit `u`'s slots, in the parent occurrence holding the day; null while the scope is behind the draft. */
  function lengthsOf(m: OrreryModel, u: { id: string; in: string }): readonly number[] | null {
    if (behind || m.ast !== ast) return null;
    const t = m.year.slots.find((x) => x.unit === u.id && (u.in === m.year.unit || x.path[x.path.length - 1] === m.today.positions.get(u.in)?.index)) ?? m.year.slots.find((x) => x.unit === u.id);
    return t?.lengths ?? null;
  }
  /** NOW and TEXT only, from the draft as it is (a drag in progress keeps the editor's controls). */
  function paintReadouts(m: OrreryModel): void {
    paintNow(infoOf(m).now);
    paintText(m);
  }

  function paintTransport(): void {
    playKey.setText(playing ? "❚❚" : "▶");
    playKey.setAttr("aria-label", playing ? "Pause" : "Play");
    playKey.toggleClass("is-on", playing);
    const m = model;
    if (!m) return;
    lcd.setText(m.today.date);
    dayLbl.setText(`D${m.today.day} · day ${m.today.dayOfYear + 1} of ${m.year.length}`);
    playhead.setCssProps({ "--wadjet-orrery-at": `${(scrubFraction(m.year, day + 0.5) * 100).toFixed(3)}%` });
    scrub.setAttrs({ "aria-valuemin": "1", "aria-valuemax": String(m.year.length), "aria-valuenow": String(m.today.dayOfYear + 1), "aria-valuetext": m.today.date });
  }

  let stripKey = "";
  function paintStrips(): void {
    const m = model;
    if (!m) return;
    const segs = scrubSegments(m.ast, m.year, m.today);
    const seas = seasonSegments(m.year);
    const k = JSON.stringify([segs, seas]);
    if (k === stripKey) return;
    stripKey = k;
    scrubSegs.empty();
    for (const s of segs) {
      const el = scrubSegs.createSpan({ cls: "wadjet-studio-orrery-seg", attr: { "data-kind": s.kind, title: s.name } });
      el.setCssProps({ "--wadjet-orrery-left": `${(s.left * 100).toFixed(3)}%`, "--wadjet-orrery-width": `${(s.width * 100).toFixed(3)}%` });
    }
    seasonStrip.empty();
    for (const s of seas) {
      const el = seasonStrip.createSpan({ cls: "wadjet-studio-orrery-season", attr: { title: s.name } });
      el.setCssProps({ "--wadjet-orrery-left": `${(s.left * 100).toFixed(3)}%`, "--wadjet-orrery-width": `${(s.width * 100).toFixed(3)}%`, "--wadjet-orrery-season": s.colour });
    }
  }

  function paintHover(): void {
    const m = model;
    hoverTag.toggleClass("is-hidden", hover === null || !m);
    if (hover === null || !m) return;
    const info = partInfo(m, hover);
    hoverName.setText(info.title);
    hoverKind.setText(info.code.toLowerCase());
  }

  function paintChip(): void {
    const label = source === "seshat" ? `${ast?.name ?? "calendar definition"}${dirty ? " ●" : ""}` : source === "legacy" ? "legacy calendar" : source === "fault" ? "definition · cannot run" : `${ctx.calendar()?.label ?? "calendar plugin"} · read-only`;
    chipLabel.setText(label);
    chip.toggleClass("is-dirty", dirty);
  }

  /**
   * Re-read what to draw: on a Seshat world the draft's one AST (its AST layer with the pending field edits
   * compiled over it), else nothing. A changed AST keeps the last verdict, marked stale, until `problems()` has
   * run on it: after the debounce, or at once after a drag's end.
   */
  function resolve(): void {
    source = sourceOf(ctx);
    let next: CalendarAst | null = null;
    draftError = null;
    dirty = false;
    editable = false;
    if (source === "seshat") {
      const st = ctx.store.get();
      const v = st.calendarSource === "seshat" ? readDraft(st.world.calendar, baseOf(st)) : null;
      if (v) {
        next = v.ast;
        draftError = v.error;
        dirty = v.dirty;
        editable = ctx.calendar()?.readOnly !== true;
      } else next = ctx.plugin.calendars.seshat?.definition() ?? null;
    }
    const flush = flushNext;
    flushNext = false;
    if (next === ast) {
      if (flush && stale && ast) {
        runProblems(ast);
        chromeStale = true;
      }
      return;
    }
    ast = next;
    revision++;
    if (!ast) {
      selected = null;
      hover = null;
      dragging = false;
      lastDrawn = null;
      verdict = [];
      verdictFor = null;
      errors = new Set();
      cancelProblems();
      stale = false;
    } else if (flush) {
      runProblems(ast);
      chromeStale = true;
    } else scheduleProblems(ast);
    canvas.invalidate();
  }

  function paint(): void {
    resolve();
    model = null;
    emptyMessage = "";
    if (source === "legacy") emptyMessage = "This world runs on the legacy calendar, which is not a calendar definition, so there is no machine to draw. Change calendar… in the menu above moves the world onto a definition.";
    else if (source === "plugin") emptyMessage = `${ctx.calendar()?.label ?? "A calendar plugin"} supplies this world's days. The orrery draws calendar definitions only; that calendar is edited where it comes from.`;
    else if (source === "fault") emptyMessage = `This world's calendar definition cannot run (${ctx.plugin.calendars.fault() ?? "no definition is loaded"}), so there is nothing to draw. Fix it with Edit definition in the settings, or choose another calendar in the menu above.`;
    else if (ast) {
      drawnAst = ast;
      behind = false;
      let m = buildOrrery(ast, day + 0.5, { problems: verdict });
      if (m.kind === "orrery") lastDrawn = ast;
      else if (editable && lastDrawn && lastDrawn !== ast) {
        // an edit left the draft unable to run (slots that no longer fill the year): its verdict is known now (the
        // build ran problems()), so the LED and the issue strip say why, and the scope keeps the last draft that ran
        if (verdictFor !== ast) {
          runProblems(ast);
          chromeStale = true;
        }
        const was = buildOrrery(lastDrawn, day + 0.5, { problems: verdict });
        if (was.kind === "orrery") {
          m = was;
          drawnAst = lastDrawn;
          behind = true;
        }
      }
      if (m.kind === "orrery") model = m;
      else emptyMessage = `This calendar definition cannot be drawn: ${m.message}.`;
    }
    if (!model) drawnAst = null;
    if (model && selected !== null && partInfo(model, selected).code === "—" && !inDraft(selected)) selected = null;
    empty.setText(emptyMessage);
    empty.toggleClass("is-hidden", model !== null);
    grid.toggleClass("is-hidden", model === null);
    paintChip();
    if (!model) {
      setPlaying(false);
      return;
    }
    canvas.setHighlight({ selected, errors });
    paintList();
    // while playing the inspector waits: rebuilding it 16 times a second would also take its chips from under the pointer
    if (!playing) paintInspector();
    paintTransport();
    paintStrips();
    paintHover();
    root.toggleClass("is-stale", stale);
    if (chromeStale) {
      chromeStale = false;
      refreshChrome();
    }
  }

  // ---- fit (§18.6 item 9), from the Studio box
  let fitObserver: ResizeObserver | null = null;
  let fitWin: Document["defaultView"] = null;
  let fitKey = "";
  function fit(): void {
    const box = ctx.shell.windows;
    const f = orreryFit(box.clientWidth, box.clientHeight);
    const k = `${f.bodyHeight}:${f.scope}`;
    if (k === fitKey) return;
    fitKey = k;
    root.setCssProps({ "--wadjet-orrery-body-h": `${f.bodyHeight}px` });
    grid.toggleClass("is-narrow", !f.scope);
    // a fluid height change can push the panel out of the box: the manager re-clamps
    refreshChrome();
  }
  function observeBox(): void {
    const w = ctx.shell.windows.ownerDocument.defaultView;
    if (w === fitWin) return;
    fitObserver?.disconnect();
    fitObserver = null;
    fitWin = w;
    if (!w) return;
    fitObserver = new w.ResizeObserver(() => fit());
    fitObserver.observe(ctx.shell.windows);
  }
  /** The leaf moved to another window: frames and observers follow it. */
  function rehome(): void {
    if (closed) return;
    observeBox();
    canvas.rehome();
    fit();
    // a timer set on a window that has since gone never fires: set it again on this one
    if (stale && ast && timerWin !== root.ownerDocument.defaultView) scheduleProblems(ast);
  }
  const layoutRef: EventRef = ctx.plugin.app.workspace.on("layout-change", rehome);

  const unsubStore = ctx.store.subscribe(() => {
    paintLook();
    paint();
  });
  const unsubAdapters = ctx.plugin.api.on("adapters-changed", () => paint());
  paintLook();
  canvas.setDay(day, true);
  paint();
  observeBox();
  fit();
  // the builder runs before the manager mounts the panel: once it is in its document (a pop-out's,
  // when the leaf lives in one), frames, observers and the debounce move to that window
  let closed = false;
  queueMicrotask(rehome);

  const build: WindowBuild = {
    title: "Seshat",
    badge: "ORRERY",
    badgeColor: "var(--wadjet-studio-gold)",
    caption: `world · ${Object.keys(ctx.store.get().zones).length} zones`,
    // the handoff's 1200 px; the window CSS caps it at the box − 16 (D5)
    width: 1200,
    head: (slot) => slot.appendChild(chip),
    body: root,
    led: { on: true, hint: "the calendar definition validates (white), or has a problem (red)" },
    level: () => (verdict.length > 0 || draftError !== null ? "error" : "ok"),
    writes: () => {
      if (!model) return source === "seshat" || source === "fault" ? "calendar.definition › (cannot run)" : "calendar.definition › (none: this world runs no definition)";
      if (selected === null) {
        const a = model.ast;
        return `calendar.definition › VCALENDAR ${a.name} · ${a.units.length} units · ${a.gears.length} gears · ${(a.bodies ?? []).length} bodies · ${(a.rules ?? []).length} rules`;
      }
      return `calendar.definition › ${oneLine(partText(ast ?? model.ast, selected)) || selected}`;
    },
    issues: (): StudioIssue[] => {
      if (model && draftError !== null) return [{ level: "error", path: "calendar.definition", message: `the draft does not compile (${draftError}); the Orrery shows the calendar without those edits`, unit: { kind: "zone" }, win: "none" }];
      if (!model || verdict.length === 0) return [];
      const more = verdict.length > 1 ? ` (+${verdict.length - 1} more)` : "";
      return [{ level: "error", path: "calendar.definition", message: `${verdict[0]!.message}${more}${stale ? " · checking…" : ""}${behind ? " · the scope shows the last calendar that runs" : ""}`, unit: { kind: "zone" }, win: "none" }];
    },
    onClose: () => {
      closed = true;
      cancelProblems();
      tearing = true;
      editor?.destroy();
      tearing = false;
      editor = null;
      cancelScrub?.();
      scrub.removeEventListener("pointerdown", onScrubDown);
      scrub.removeEventListener("keydown", onScrubKey);
      ctx.plugin.app.workspace.offref(layoutRef);
      fitObserver?.disconnect();
      fitObserver = null;
      unsubStore();
      unsubAdapters();
      views.destroy();
      rates.destroy();
      canvas.destroy();
    },
  };
  return build;
};
