/**
 * The Orrery's gear inspector (docs/SESHAT-v0.md §18.3; handoff README
 * "Gear"; bead wadjet-b6x, slice 5c):
 *
 * - the id, renamed inline (every term that names the gear follows);
 * - KIND, intervals | positions in a cycle (the bin's segmented control: the
 *   component bin is closed, components/index.ts, SPEC law 3);
 * - intervals: TERMS rows, each an RRULE + | EXRULE − switch, an `every` knob
 *   (log, 1–500), an `offset` knob (±(every − 1)), an LED lit when the term's
 *   pin is at the pointer this year, and ×; then ＋ term;
 * - positions: the cycle-year grid (gold: a position; white border: this
 *   year), a cell click marks or unmarks it;
 * - FEEDS · WHEN ENGAGED: each length the gear adds to, with an `add` knob
 *   (−30…+30 d) and ×; ＋ feed… lists the counted unit's length and its slots;
 * - Remove gear.
 *
 * NOW (engaged or idle, next, rate "x in y") is the window's, from
 * `partInfo`. The edits are model/orrery-gears.ts's. As in the other editors,
 * every control reads the draft when it commits, a knob's origin is the gear
 * as the editor was built, and the editor never writes the store itself.
 */
import { Menu } from "obsidian";
import type { CalendarAst, GearAst, PartId } from "../../../seshat";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import { switchesReading } from "../../model/ast-edit";
import { orreryHint } from "../../model/hints-orrery";
import { addTerm, cellOf, EVERY, FEED_DAYS, feedsOf, feedTargets, offsetRange, removeGearPart, removeTerm, renameGearIn, setFeed, setKind, setTerm, termEngaged, togglePosition, type FeedTarget } from "../../model/orrery-gears";
import { createKnob, createSegmented, type KnobComponent, type SegmentedComponent } from "../components";
import { button, input, type EditPhase, type PartEditor } from "./orrery-body";

export interface GearEditorDeps {
  /** the draft AST (the one the edits read) */
  ast: CalendarAst;
  gearId: string;
  /** the occurrence index of the unit the gear counts, at the window's day, or null when the draft does not run */
  index: number | null;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft, base: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
  /** the part the window selects once the edit in hand lands (set inside `make`, so a refused or cancelled edit selects nothing) */
  selectAfter(part: PartId): void;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${-n}`);
const whole = (t: string, min: number): number | null => {
  const n = Number(t.replace(/\s*d$/, "").replace("−", "-").trim());
  return Number.isSafeInteger(n) && n >= min ? n : null;
};

/**
 * Build the gear editor into `parent`, and the rename input into `title`.
 */
export function buildGearEditor(parent: HTMLElement, title: HTMLElement, deps: GearEditorDeps): PartEditor {
  const knobs: KnobComponent[] = [];
  const parts: SegmentedComponent[] = [];
  const refusalEl = parent.createDiv({ cls: "wadjet-studio-orrery-refusal is-hidden", attr: { role: "status", "aria-live": "polite" } });
  const setRefusal = (reason: string | null): void => {
    refusalEl.setText(reason ?? "");
    refusalEl.toggleClass("is-hidden", reason === null);
  };
  setRefusal(deps.refusal);
  const editor: PartEditor = {
    setRefusal,
    destroy: () => {
      for (const k of knobs) k.destroy();
      for (const p of parts) p.destroy();
    },
  };
  const g = deps.ast.gears.find((x) => x.id === deps.gearId);
  if (!g) return editor;
  const id = g.id;
  const n = deps.index;

  // ---- id, inline
  title.empty();
  title.addClass("is-editable");
  input(title, id, "Gear id", orreryHint("orrery.gearName"), "gear-name", "wadjet-studio-orrery-title-input", (text) =>
    deps.edit((c, b) => {
      const r = renameGearIn(c, b, id, text);
      if (!("refused" in r)) deps.selectAfter(`gear:${text.trim()}`);
      return r;
    }, "click"),
  );

  // ---- kind
  const kindRow = parent.createDiv({ cls: "wadjet-studio-orrery-toggle", attr: { "data-part": "gear-kind" } });
  kindRow.createSpan({ cls: "wadjet-studio-orrery-toggle-label", text: "kind" });
  const kind = createSegmented(kindRow, {
    options: [
      { value: "intervals", label: "intervals", hint: orreryHint("orrery.gearKind") },
      { value: "positions", label: "positions in a cycle", hint: orreryHint("orrery.gearKind") },
    ],
    value: g.kind,
    onChange: (v) => deps.edit((c, b) => setKind(c, b, id, v as GearAst["kind"]), "click"),
  });
  kind.el.setAttr("aria-label", "Gear kind");
  parts.push(kind);

  if (g.kind === "intervals") buildTerms(parent, g, n, deps, knobs, parts);
  else buildGrid(parent, g, n, deps);

  // ---- feeds
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Feeds · when engaged" });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-feeds" });
  const feeds = feedsOf(deps.ast, id);
  if (!feeds.length) list.createDiv({ cls: "wadjet-studio-orrery-note", text: "Feeds nothing yet: it turns, but adds no days." });
  feeds.forEach((f, i) => {
    const row = list.createDiv({ cls: "wadjet-studio-orrery-feed", attr: { "data-part": `feed-${i}` } });
    const target = row.createSpan({ cls: "wadjet-studio-orrery-feed-target", text: f.label, attr: { role: "button", tabindex: "0", "data-hint": orreryHint("orrery.feedTarget") } });
    const pick = (): void => deps.select(f.target.slot === undefined ? `unit:${f.target.unit}` : `slot:${f.target.unit}:${f.target.slot}`);
    target.addEventListener("click", pick);
    target.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      pick();
    });
    const t: FeedTarget = f.target;
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `feed-${i}-add` } }), {
        spec: { min: Math.min(FEED_DAYS.min, f.add), max: Math.max(FEED_DAYS.max, f.add), step: 1, bipolar: true, neutral: 0 },
        value: f.add,
        label: "add",
        size: "sm",
        fmt: (v) => `${signed(Math.round(v))} d`,
        parse: (text) => whole(text.replace(/^\+/, ""), -Number.MAX_SAFE_INTEGER),
        hint: orreryHint("orrery.feedAdd"),
        onChange: (v, phase) => deps.edit((c, b) => setFeed(c, b, id, t, Math.round(v)), phase),
      }),
    );
    button(row, "×", `Stop feeding ${f.label}`, orreryHint("orrery.feedRemove"), `feed-${i}-remove`, () => deps.edit((c, b) => setFeed(c, b, id, t, null), "click"));
  });
  const switches = switchesReading(deps.ast, id);
  if (switches.length) sec.createDiv({ cls: "wadjet-studio-orrery-note", text: `Also read by the rule change${switches.length === 1 ? "" : "s"} from ${switches.join(", ")} (Exceptions).` });

  // ---- ops
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  const plusFeed = button(ops, "＋ feed…", `Feed another length from ${id}`, orreryHint("orrery.addFeed"), "add-feed", () => {
    const targets = feedTargets(deps.ast, id);
    const menu = new Menu();
    if (!targets.length) menu.addItem((item) => item.setTitle("Nothing left to feed").setDisabled(true));
    for (const x of targets)
      menu.addItem((item) =>
        item
          .setTitle(x.why ? `${x.label} · ${x.why}` : x.label)
          .setDisabled(x.why !== null)
          .onClick(() => deps.edit((c, b) => setFeed(c, b, id, x.target, 1), "click")),
      );
    const box = plusFeed.getBoundingClientRect();
    menu.showAtPosition({ x: box.left, y: box.bottom });
  });
  button(ops, "Remove gear", `Remove the gear ${id}`, orreryHint("orrery.removeGear"), "remove-gear", () =>
    deps.edit((c, b) => {
      const r = removeGearPart(c, b, id);
      if (!("refused" in r)) deps.selectAfter(`unit:${g.on}`);
      return r;
    }, "click"),
  ).addClass("is-danger");
  return editor;
}

/** TERMS: one row per interval term, then ＋ term. */
function buildTerms(parent: HTMLElement, g: GearAst & { kind: "intervals" }, n: number | null, deps: GearEditorDeps, knobs: KnobComponent[], parts: SegmentedComponent[]): void {
  const id = g.id;
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Terms" });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-terms" });
  g.terms.forEach((t, i) => {
    const row = list.createDiv({ cls: "wadjet-studio-orrery-term", attr: { "data-part": `term-${i}` } });
    const pinned = n !== null && termEngaged(t, n);
    const led = row.createSpan({ cls: "wadjet-studio-orrery-led", attr: { "data-hint": orreryHint("orrery.termPin"), "aria-label": pinned ? "pin at the pointer this year" : "pin away from the pointer" } });
    led.toggleClass("is-lit", pinned);
    const sign = createSegmented(row.createDiv({ cls: "wadjet-studio-orrery-term-sign", attr: { "data-part": `term-${i}-sign` } }), {
      options: [
        { value: "1", label: "RRULE +", hint: orreryHint("orrery.termSign") },
        { value: "-1", label: "EXRULE −", hint: orreryHint("orrery.termSign") },
      ],
      value: String(t.sign),
      onChange: (v) => deps.edit((c, b) => setTerm(c, b, id, i, { sign: v === "1" ? 1 : -1 }), "click"),
    });
    sign.el.setAttr("aria-label", `Term ${i + 1} adds or takes away`);
    parts.push(sign);
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `term-${i}-every` } }), {
        spec: { min: EVERY.min, max: Math.max(EVERY.max, t.every), step: 1, scale: "log" },
        value: t.every,
        label: "every",
        size: "sm",
        fmt: (v) => String(Math.round(v)),
        parse: (text) => whole(text, 1),
        hint: orreryHint("orrery.termEvery"),
        onChange: (v, phase) => deps.edit((c, b) => setTerm(c, b, id, i, { every: Math.round(v) }), phase),
      }),
    );
    const range = offsetRange(t.every);
    const offset = t.offset ?? 0;
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `term-${i}-offset` } }), {
        spec: { min: Math.min(range.min, offset), max: Math.max(range.max, offset), step: 1, bipolar: true, neutral: 0 },
        value: offset,
        label: "offset",
        size: "sm",
        fmt: (v) => signed(Math.round(v)),
        parse: (text) => whole(text.replace(/^\+/, ""), -Number.MAX_SAFE_INTEGER),
        hint: orreryHint("orrery.termOffset"),
        onChange: (v, phase) => deps.edit((c, b) => setTerm(c, b, id, i, { offset: Math.round(v) }), phase),
      }),
    );
    button(row, "×", `Remove term ${i + 1}`, orreryHint("orrery.termRemove"), `term-${i}-remove`, () => deps.edit((c, b) => removeTerm(c, b, id, i), "click"));
  });
  const ops = sec.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "＋ term", `Add a term to ${id}`, orreryHint("orrery.addTerm"), "add-term", () => deps.edit((c, b) => addTerm(c, b, id), "click"));
}

/** The cycle-year grid of a table gear: gold cells are its positions, the white border is this year. */
function buildGrid(parent: HTMLElement, g: GearAst & { kind: "positions" }, n: number | null, deps: GearEditorDeps): void {
  const id = g.id;
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Cycle · ${g.period} ${g.on}s${g.offset ? ` · offset ${signed(g.offset)}` : ""}` });
  const grid = sec.createDiv({ cls: "wadjet-studio-orrery-cycle", attr: { role: "group", "aria-label": `${id}: positions in a cycle of ${g.period}` } });
  const now = n === null ? -1 : cellOf(g, n);
  const marked = new Set(g.positions);
  for (let c = 0; c < g.period; c++) {
    const on = marked.has(c);
    const cell = grid.createDiv({ cls: "wadjet-studio-orrery-cell", text: String(c), attr: { role: "button", tabindex: "0", "aria-pressed": on ? "true" : "false", "aria-label": `position ${c}${c === now ? ", this year" : ""}`, "data-part": `cell-${c}`, "data-hint": orreryHint("orrery.gearCell") } });
    cell.toggleClass("is-leap", on);
    cell.toggleClass("is-now", c === now);
    const flip = (): void => deps.edit((cal, b) => togglePosition(cal, b, id, c), "click");
    cell.addEventListener("click", flip);
    cell.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      flip();
    });
  }
}
