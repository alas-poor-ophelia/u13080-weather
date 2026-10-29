/**
 * The Orrery's stage inspector (docs/SESHAT-v0.md §18.3; handoff README
 * "Stage"; bead wadjet-b6x, slice 5d): RULES · FIRST MATCH, one row per rule.
 *
 * - every rule: an LED lit when it is the first to match this year, its
 *   sentence, ↑ ↓ (order is meaning: the first match wins) and ×;
 * - a length rule: `last | this | next` (the bin's segmented control: the
 *   component bin is closed, components/index.ts, SPEC law 3), knobs `runs`
 *   (340–400 d) and `add` (0–3), and a readout of how long that year runs in
 *   the stage below;
 * - a residue rule: a grid of its cells (with a seven-label day cycle, in
 *   weekday order and titled by weekday; the cell this year's start falls on
 *   has the white border), knobs `mod` (2–14) and `add`;
 * - ＋ length rule, ＋ residue rule, Remove stage.
 *
 * NOW (this year's shift, the rule that matched, the start) is the window's,
 * from `partInfo`. The edits are model/orrery-stages.ts's. As in the other
 * editors, every control reads the draft when it commits, a knob's origin is
 * the rule as the editor was built, and the editor never writes the store
 * itself.
 */
import type { CalendarAst, CycleUnitAst, PartId } from "../../../seshat";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import type { StageFacts } from "../../model/orrery-geometry";
import { orreryHint } from "../../model/hints-orrery";
import { addRule, isLength, isResidue, moveRule, removeRule, removeStage, residueCells, residueOf, RUNS, ruleSentence, setLengthRule, setResidueRule, STAGE_ADD, STAGE_MOD, toggleResidue, WINDOWS } from "../../model/orrery-stages";
import { createKnob, createSegmented, type KnobComponent, type SegmentedComponent } from "../components";
import { button, type EditPhase, type PartEditor } from "./orrery-body";

export interface StageEditorDeps {
  /** the draft AST (the one the edits read) */
  ast: CalendarAst;
  unitId: string;
  /** the stage's index in its unit */
  index: number;
  /** the stage this year, read through the engine's start trace, or null when the draft does not run */
  facts: StageFacts | null;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
  /** the part the window selects once the edit in hand lands */
  selectAfter(part: PartId): void;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${-n}`);
const whole = (t: string): number | null => {
  const n = Number(t.replace(/\s*d$/, "").replace("−", "-").replace(/^\+/, "").trim());
  return Number.isSafeInteger(n) ? n : null;
};

/** Build the stage editor into `parent`. */
export function buildStageEditor(parent: HTMLElement, deps: StageEditorDeps): PartEditor {
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
  const { unitId: id, index: i, facts } = deps;
  const u = deps.ast.units.find((x): x is CycleUnitAst => x.kind === "cycle" && x.id === id);
  const stage = u?.stages?.[i];
  if (!stage) return editor;

  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Rules · first match" });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-rules" });
  stage.rules.forEach((r, j) => {
    const row = list.createDiv({ cls: "wadjet-studio-orrery-rule", attr: { "data-part": `rule-${j}` } });
    const head = row.createDiv({ cls: "wadjet-studio-orrery-rule-head" });
    const fired = facts !== null && facts.fired === j;
    const led = head.createSpan({ cls: "wadjet-studio-orrery-led", attr: { "data-hint": orreryHint("orrery.stageFired"), "aria-label": fired ? "the first rule that matches this year" : "does not decide this year" } });
    led.toggleClass("is-lit", fired);
    head.createSpan({ cls: "wadjet-studio-orrery-rule-text", text: ruleSentence(deps.ast, r), attr: { "data-part": `rule-${j}-text` } });
    button(head, "↑", `Read rule ${j + 1} earlier`, orreryHint("orrery.stageRuleUp"), `rule-${j}-up`, () => deps.edit((c) => moveRule(c, id, i, j, -1), "click"));
    button(head, "↓", `Read rule ${j + 1} later`, orreryHint("orrery.stageRuleDown"), `rule-${j}-down`, () => deps.edit((c) => moveRule(c, id, i, j, 1), "click"));
    button(head, "×", `Remove rule ${j + 1}`, orreryHint("orrery.stageRuleRemove"), `rule-${j}-remove`, () => deps.edit((c) => removeRule(c, id, i, j), "click"));
    const knobRow = row.createDiv({ cls: "wadjet-studio-orrery-knobs" });
    const addKnob = (write: (add: number) => (c: CalendarDraft) => CalendarEdit): void => {
      knobs.push(
        createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `rule-${j}-add` } }), {
          spec: { min: Math.min(STAGE_ADD.min, r.add), max: Math.max(STAGE_ADD.max, r.add), step: 1 },
          value: r.add,
          label: "add",
          size: "sm",
          fmt: (v) => `${signed(Math.round(v))} d`,
          parse: (t) => whole(t),
          hint: orreryHint("orrery.stageAdd"),
          onChange: (v, phase) => deps.edit(write(Math.round(v)), phase),
        }),
      );
    };
    if (isLength(r)) {
      const win = createSegmented(row.createDiv({ cls: "wadjet-studio-orrery-rule-window", attr: { "data-part": `rule-${j}-window` } }), {
        options: WINDOWS.map((w) => ({ value: String(w.at), label: w.word, hint: orreryHint("orrery.stageWindow") })),
        value: String(r.length.at),
        onChange: (v) => deps.edit((c) => setLengthRule(c, id, i, j, { at: Number(v) }), "click"),
      });
      win.el.setAttr("aria-label", `Rule ${j + 1} reads the last, this or the next year`);
      parts.push(win);
      knobs.push(
        createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `rule-${j}-runs` } }), {
          spec: { min: Math.min(RUNS.min, r.length.is), max: Math.max(RUNS.max, r.length.is), step: 1 },
          value: r.length.is,
          label: "runs",
          size: "sm",
          fmt: (v) => `${Math.round(v)} d`,
          parse: (t) => whole(t),
          hint: orreryHint("orrery.stageRuns"),
          onChange: (v, phase) => deps.edit((c) => setLengthRule(c, id, i, j, { is: Math.round(v) }), phase),
        }),
      );
      addKnob((add) => (c) => setLengthRule(c, id, i, j, { add }));
      const actual = facts?.lengths[j] ?? null;
      const w = WINDOWS.find((x) => x.at === r.length.at);
      const out = row.createDiv({ cls: "wadjet-studio-orrery-readout", attr: { "data-part": `rule-${j}-actual`, "data-hint": orreryHint("orrery.stageActual") } });
      out.createSpan({ cls: "wadjet-studio-orrery-caps", text: `${w ? w.word : signed(r.length.at)} year` });
      out.createSpan({ cls: "wadjet-studio-orrery-readout-value", text: actual === null ? "—" : `${actual} d` });
      out.toggleClass("is-lit", actual === r.length.is);
    } else if (isResidue(r)) {
      const days = r.residue.in;
      knobs.push(
        createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `rule-${j}-mod` } }), {
          spec: { min: Math.min(STAGE_MOD.min, r.residue.mod), max: Math.max(STAGE_MOD.max, r.residue.mod), step: 1 },
          value: r.residue.mod,
          label: "mod",
          size: "sm",
          fmt: (v) => String(Math.round(v)),
          parse: (t) => whole(t),
          hint: orreryHint("orrery.stageMod"),
          // the days kept are the rule's as the editor was built: a drag through a smaller mod and back keeps them all
          onChange: (v, phase) => deps.edit((c) => setResidueRule(c, id, i, j, { mod: Math.round(v) }, days), phase),
        }),
      );
      addKnob((add) => (c) => setResidueRule(c, id, i, j, { add }));
      const now = facts === null ? -1 : residueOf(r, facts.below);
      const grid = row.createDiv({ cls: "wadjet-studio-orrery-cycle is-residue", attr: { role: "group", "aria-label": `Rule ${j + 1}: the days the start may fall on` } });
      for (const cell of residueCells(deps.ast, r)) {
        const text = cell.label ?? String(cell.residue);
        const el = grid.createDiv({ cls: "wadjet-studio-orrery-cell", text, attr: { role: "button", tabindex: "0", title: cell.label ?? `${cell.residue} of ${r.residue.mod}`, "aria-pressed": cell.on ? "true" : "false", "aria-label": `${cell.label ?? `residue ${cell.residue}`}${cell.residue === now ? ", this year's start" : ""}`, "data-part": `rule-${j}-cell-${cell.residue}`, "data-hint": orreryHint("orrery.stageCell") } });
        el.toggleClass("is-leap", cell.on);
        el.toggleClass("is-now", cell.residue === now);
        el.toggleClass("is-named", cell.label !== null);
        const flip = (): void => deps.edit((c) => toggleResidue(c, id, i, j, cell.residue), "click");
        el.addEventListener("click", flip);
        el.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          flip();
        });
      }
    }
  });

  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "＋ length rule", `Add a length rule to stage ${i + 1}`, orreryHint("orrery.addLengthRule"), "add-length-rule", () =>
    deps.edit((c) => addRule(c, id, i, "length", facts?.lengths.find((x): x is number => x !== null) ?? undefined), "click"),
  );
  button(ops, "＋ residue rule", `Add a weekday rule to stage ${i + 1}`, orreryHint("orrery.addResidueRule"), "add-residue-rule", () => deps.edit((c) => addRule(c, id, i, "residue"), "click"));
  button(ops, "Remove stage", `Remove stage ${i + 1} of the ${id}`, orreryHint("orrery.removeStage"), "remove-stage", () =>
    deps.edit((c) => {
      const r = removeStage(c, id, i);
      if (!("refused" in r)) deps.selectAfter(i > 0 ? `stage:${id}:${i - 1}` : (u?.stages?.length ?? 0) > 1 ? `stage:${id}:0` : u?.crossing ? `crossing:${id}` : `unit:${id}`);
      return r;
    }, "click"),
  ).addClass("is-danger");
  return editor;
}
