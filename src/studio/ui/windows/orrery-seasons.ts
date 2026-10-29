/**
 * The Orrery's Seasons inspector (docs/SESHAT-v0.md §18.3 D8; handoff README
 * "Seasons"; bead wadjet-b6x, slice 5f): MARKS · FROM, one row per mark in
 * declaration order (its colour on the season strip), then `＋ mark`.
 *
 * - A row: the colour swatch (the Studio season palette, as the strip and
 *   the Seasons window draw it), the name, the date it starts on this year,
 *   the `from` switch (fraction | day of year | month · day, the bin's
 *   segmented control: the component bin is closed), the control of its kind
 *   and ×.
 * - fraction: a `from` knob, 0 to 0.995 (a drag back to where it began
 *   keeps the stored fraction exactly); day of year: a `day` knob (`DAY:N`);
 *   month · day: a month dropdown and a `day` knob (`month:M.D`).
 * - Switching the kind keeps the start day this year where it can (the
 *   switch's hint says so).
 *
 * The edits are model/orrery-seasons.ts's: through the draft's seasons field
 * (the Seasons window's draft) while every mark is a fraction, through the
 * AST layer once one is dated. The Seasons window reads the same draft.
 */
import { Menu } from "obsidian";
import type { CalendarAst, SeasonMarkAst } from "../../../seshat";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { fractionWrite } from "../../model/orrery-body";
import { addMark, dayRange, FROM, kindOf, MARK_KINDS, markUnits, removeMark, renameMark, setMarkDay, setMarkFrom, setMarkKind, setMarkSlot, type MarkKind, type SeasonYear } from "../../model/orrery-seasons";
import { cycleColour, SEASON_CYCLE } from "../../model/palette";
import { createKnob, createSegmented, type KnobComponent, type SegmentedComponent } from "../components";
import { button, input, type EditPhase, type PartEditor } from "./orrery-body";

export interface SeasonsEditorDeps {
  /** the draft AST (the one the edits read) */
  ast: CalendarAst;
  /** this year's facts (each mark's day, the year's length, the months' lengths), or null when the draft does not run */
  year: SeasonYear | null;
  /** each mark's start this year, as the day line prints it (null: it falls on no day this year) */
  starts: ReadonlyArray<string | null>;
  /** where each mark sits this year as a fraction (where ＋ mark looks for the largest gap) */
  phases: readonly number[];
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
}

const whole = (t: string): number | null => {
  const n = Number(t.replace(/^day\s*/, "").trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/** Build the Seasons editor into `parent`. */
export function buildSeasonsEditor(parent: HTMLElement, deps: SeasonsEditorDeps): PartEditor {
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
  const marks: readonly SeasonMarkAst[] = deps.ast.seasons?.marks ?? [];
  const units = markUnits(deps.ast);

  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Marks · from${deps.ast.seasons && deps.ast.seasons.unit !== "year" ? ` · over the ${deps.ast.seasons.unit}` : ""}` });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-phases" });
  if (!marks.length) list.createDiv({ cls: "wadjet-studio-orrery-note", text: "No seasons yet." });
  marks.forEach((m, i) => {
    const row = list.createDiv({ cls: "wadjet-studio-orrery-phase wadjet-studio-orrery-mark", attr: { "data-part": `mark-${i}`, "data-kind": kindOf(m) } });
    const sw = row.createSpan({ cls: "wadjet-studio-orrery-swatch", attr: { "aria-hidden": "true" } });
    sw.setCssProps({ "--wadjet-orrery-swatch": cycleColour(i, SEASON_CYCLE) });
    input(row, m.name, `Season ${i + 1} name`, orreryHint("orrery.markName"), `mark-${i}-name`, "wadjet-studio-orrery-phase-name", (text) => deps.edit((c) => renameMark(c, i, text), "click"));
    row.createSpan({ cls: "wadjet-studio-orrery-mark-date", text: deps.starts[i] ?? "— this year", attr: { "data-part": `mark-${i}-date` } });
    button(row, "×", `Remove the season ${m.name}`, orreryHint("orrery.markRemove"), `mark-${i}-remove`, () => deps.edit((c) => removeMark(c, i), "click"));
    const kind = createSegmented(row.createDiv({ cls: "wadjet-studio-orrery-mark-kind", attr: { "data-part": `mark-${i}-kind` } }), {
      options: MARK_KINDS.map((k) => ({ value: k.value, label: k.label, hint: orreryHint("orrery.markKind") })),
      value: kindOf(m),
      onChange: (v) => deps.edit((c) => setMarkKind(c, i, v as MarkKind, deps.year), "click"),
    });
    kind.el.setAttr("aria-label", `How the season ${m.name} starts`);
    parts.push(kind);
    const knobRow = row.createDiv({ cls: "wadjet-studio-orrery-knobs" });
    if ("from" in m) {
      knobs.push(
        createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `mark-${i}-from` } }), {
          spec: { min: 0, max: FROM.max, step: FROM.step.n / FROM.step.d },
          value: Math.min(FROM.max, m.from),
          label: "from",
          size: "sm",
          fmt: (v) => v.toFixed(3),
          hint: orreryHint("orrery.markFrom"),
          // the list as this editor saw it: a drag past a neighbour reorders the field, never edits the neighbour
          onChange: (v, phase) => deps.edit((c) => setMarkFrom(c, i, fractionWrite(v, m.from, FROM.step, FROM.max), marks), phase),
        }),
      );
      return;
    }
    if ("slot" in m) {
      const u = units.find((x) => x.id === m.slot.unit);
      const slotName = (k: number): string => u?.slots[k]?.name ?? `${m.slot.unit} ${k + (u?.number ?? 1)}`;
      const pick = button(knobRow, `${slotName(m.slot.index)} ▾`, `The month the season ${m.name} starts in`, orreryHint("orrery.markSlot"), `mark-${i}-slot`, () => {
        const menu = new Menu();
        (u?.slots ?? []).forEach((_, k) =>
          menu.addItem((item) =>
            item
              .setTitle(slotName(k))
              .setChecked(k === m.slot.index)
              .onClick(() => deps.edit((c) => setMarkSlot(c, i, { unit: m.slot.unit, index: k, day: m.slot.day }), "click")),
          ),
        );
        const box = pick.getBoundingClientRect();
        menu.showAtPosition({ x: box.left, y: box.bottom });
      });
    }
    const day = "day" in m ? m.day : m.slot.day;
    const range = dayRange(m, deps.year);
    knobs.push(
      createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `mark-${i}-day` } }), {
        spec: { min: range.min, max: Math.max(range.min + 1, range.max), step: 1 },
        value: day,
        label: "day",
        size: "sm",
        fmt: (v) => String(Math.round(v)),
        parse: whole,
        hint: orreryHint("orrery.markDay"),
        onChange: (v, phase) => deps.edit((c) => ("slot" in m ? setMarkSlot(c, i, { ...m.slot, day: Math.round(v) }) : setMarkDay(c, i, Math.round(v))), phase),
      }),
    );
  });
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "＋ mark", "Add a season", orreryHint("orrery.addMark"), "add-mark", () => deps.edit((c) => addMark(c, deps.phases), "click"));
  return editor;
}
