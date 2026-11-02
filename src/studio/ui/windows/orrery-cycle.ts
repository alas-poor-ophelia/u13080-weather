/**
 * The Orrery's labelled cycle inspector (docs/SESHAT-v0.md §18.3; handoff
 * README "Labelled cycle"; bead wadjet-b6x, slice 5e): a cycle unit that is
 * not the year and does not start by a crossing.
 *
 * - The title is the unit's id, renamed inline (the formats' `{id…}` tokens
 *   and the rules that read it follow; an id in use is refused).
 * - LABELS: one row per label (rename, ×; the one today carries is
 *   highlighted) and `＋ label`. A new count is a new cycle length, and the
 *   week that runs with the day names follows it.
 * - A `today is` knob over the labels: it moves the anchor so the chosen
 *   label falls on the Orrery's day (the week moves with it). Disabled, with
 *   the reason, while a rule reads the unit by number or a gear counts it.
 * - What reads the unit, and Remove cycle (refused while anything does).
 *
 * The edits are model/orrery-cycle.ts's: through the form's week where the
 * form reads it, through the AST layer elsewhere. As in the other editors,
 * every control reads the draft when it commits, the knob's origin is the
 * anchor as the editor was built, and the editor never writes the store.
 */
import type { CalendarAst, CycleUnitAst, PartId } from "../../../seshat";
import { Engine } from "../../../seshat";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { addLabel, inFormWeek, labelOn, removeCycle, removedWith, removeLabel, renameCycle, renameLabel, setCycleSkip, setTodayIs } from "../../model/orrery-cycle";
import { anchorProblem, anchorWarnings, skipTarget, unitReaders } from "../../model/unit-edit";
import { createKnob, type KnobComponent, type SegmentedComponent } from "../components";
import { button, input, type EditPhase, type PartEditor } from "./orrery-body";
import { toggle } from "./orrery-slots";

export interface CycleEditorDeps {
  /** the draft AST (the one the edits read) */
  ast: CalendarAst;
  /** the draft calendar as the editor is built (whether the form reads the week) */
  calendar: CalendarDraft;
  unitId: string;
  /** the year unit, selected after the cycle is removed */
  yearUnit: string;
  /** the Orrery's own day (`today is` puts a label on it) */
  day: number;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  /** the part the window selects once the edit in hand lands */
  selectAfter(part: PartId): void;
}

/** Build the labelled cycle editor into `parent`, and the rename input into `title`. */
export function buildCycleEditor(parent: HTMLElement, title: HTMLElement, deps: CycleEditorDeps): PartEditor {
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
  const u = deps.ast.units.find((x): x is CycleUnitAst => x.kind === "cycle" && x.id === deps.unitId);
  if (!u || u.crossing) return editor;
  const id = u.id;

  // ---- the id, inline
  title.empty();
  title.addClass("is-editable");
  input(title, id, "Cycle id", orreryHint("orrery.cycleName"), "cycle-name", "wadjet-studio-orrery-title-input", (text) =>
    deps.edit((c) => {
      const r = renameCycle(c, id, text);
      if (!("refused" in r)) deps.selectAfter(`unit:${text.trim()}`);
      return r;
    }, "click"),
  );
  const form = inFormWeek(deps.calendar, deps.ast, id);
  if (form) parent.createDiv({ cls: "wadjet-studio-orrery-note", text: "The form reads this as the week: its day names and the week that runs with them are written together." });

  // ---- labels
  const labels = u.labels ?? [];
  if (labels.length) {
    // a cycle that skips filler days counts on the engine's line; a draft that cannot compile marks no label wrongly, only the first
    const today = labelOn(u, deps.day, (unit, day) => {
      try {
        return new Engine(deps.ast).indexAt(unit, day);
      } catch {
        return 0;
      }
    });
    const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
    sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Labels · ${labels.length}` });
    const list = sec.createDiv({ cls: "wadjet-studio-orrery-phases" });
    labels.forEach((l, i) => {
      const row = list.createDiv({ cls: "wadjet-studio-orrery-phase wadjet-studio-orrery-label", attr: { "data-part": `label-${i}` } });
      row.toggleClass("is-current", i === today);
      input(row, l.name ?? "", `Label ${i + 1}`, orreryHint("orrery.labelName"), `label-${i}-name`, "wadjet-studio-orrery-phase-name", (text) => deps.edit((c) => renameLabel(c, id, i, text), "click"));
      button(row, "×", `Remove label ${l.name ?? i + 1}`, orreryHint("orrery.labelRemove"), `label-${i}-remove`, () => deps.edit((c) => removeLabel(c, id, i), "click"));
    });
    const ops = sec.createDiv({ cls: "wadjet-studio-orrery-ops" });
    button(ops, "＋ label", `Add a label to the ${id}`, orreryHint("orrery.addLabel"), "add-label", () => deps.edit((c) => addLabel(c, id), "click"));

    // ---- today is
    const why = anchorProblem(deps.ast, id);
    const origin = u.anchor;
    const name = (k: number): string => labels[k]?.name ?? String(k + 1);
    const row = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "cycle-today" } }), {
        spec: { min: 0, max: Math.max(1, labels.length - 1), step: 1 },
        value: today,
        label: "today is",
        fmt: (v) => name(Math.round(v)),
        parse: (t) => {
          const typed = t.trim();
          const k = labels.findIndex((l) => l.name === typed);
          if (k >= 0) return k;
          const n = Number(typed);
          return Number.isSafeInteger(n) && n >= 1 && n <= labels.length ? n - 1 : null;
        },
        disabled: why !== null || labels.length < 2,
        hint: orreryHint("orrery.todayIs"),
        onChange: (v, phase) => deps.edit((c) => setTodayIs(c, id, Math.round(v), deps.day, origin), phase),
      }),
    );
    if (why) parent.createDiv({ cls: "wadjet-studio-orrery-note", text: `The anchor stays: ${why}.` });
    else for (const w of anchorWarnings(deps.ast, id)) parent.createDiv({ cls: "wadjet-studio-orrery-note", text: `Moving it: ${w}.`, attr: { "data-part": "cycle-today-warning" } });
  }

  // ---- filler days: a choice only when some month has them
  if (u.skips !== undefined || skipTarget(deps.ast) !== null) {
    const sw = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
    parts.push(toggle(sw, "skips filler days", u.skips !== undefined, orreryHint("orrery.cycleSkips"), "cycle-skips", (on) => deps.edit((c) => setCycleSkip(c, id, on), "click")));
  }

  // ---- what reads it, and remove
  const readers = unitReaders(deps.ast, id);
  if (readers.length) parent.createDiv({ cls: "wadjet-studio-orrery-note", text: `Read here: ${readers.join("; ")}.`, attr: { "data-part": "cycle-readers" } });
  const also = form ? removedWith(deps.calendar, deps.ast, id) : null;
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "Remove cycle", also ? `Remove the ${id} and the ${also}` : `Remove the ${id}`, orreryHint("orrery.removeCycle"), "remove-cycle", () =>
    deps.edit((c) => {
      const r = removeCycle(c, id);
      if (!("refused" in r)) deps.selectAfter(`unit:${deps.yearUnit}`);
      return r;
    }, "click"),
  ).addClass("is-danger");
  return editor;
}
