/**
 * The Orrery's body inspector (docs/SESHAT-v0.md §18.3 D2, D8; bead
 * wadjet-b6x, slice 5a): name, period, epoch, the molad's days, hours and
 * parts, the PHASES list and Remove body, for a moon of the draft.
 *
 * Every control reads the draft as it is when it commits (the window's
 * `edit` hands the live calendar and base to the edit, model/orrery-body.ts).
 * A knob's origin is the body as it was when this editor was built, which is
 * the start of the gesture: the window does not rebuild the editor during a
 * drag. The editor never writes the store itself.
 */
import { followersOf } from "../../../plugin/time/form";
import { toNumber, type BodyAst, type CalendarAst, type PartId, type Rational } from "../../../seshat";
import { moveMoon, type CalendarDraft, type CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { phaseName } from "../../model/orrery-geometry";
import { addPhase, epochWrite, fractionWrite, knobWrite, moonOf, phaseRules, removeBody, renameBody, setBodyPhases, type Phase } from "../../model/orrery-body";
import { fromMolad, moladOf, type Molad } from "../../model/rational-knob";
import { createChip, createKnob, type ChipComponent, type KnobComponent, type KnobPhase } from "../components";

/** A commit: a click or typed value is one undo step; knob phases follow the drag-coalescing rule. */
export type EditPhase = KnobPhase | "click";

export interface BodyEditorDeps {
  /** the draft AST the window draws */
  ast: CalendarAst;
  /** the AST the draft was seeded from (the stored body, for a knob's snap-back), or null */
  baseAst: CalendarAst | null;
  /** the draft calendar as the editor is built */
  calendar: CalendarDraft;
  bodyId: string;
  /** the body's phase on the window's day */
  phase: number;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft, base: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
}

export interface BodyEditor {
  setRefusal(reason: string | null): void;
  destroy(): void;
}

/** Every Orrery part editor has this shape (the body's, and slice 5b's year, slot unit and slot editors). */
export type PartEditor = BodyEditor;

const PERIOD_STEP: Rational = { n: 1, d: 100 };
const EPOCH_STEP: Rational = { n: 1, d: 100 };
/** The top of a 0-to-1 fraction knob: 0.99 (a fraction from 0.995 up shows there and snaps back there). */
const FRACTION_MAX = 0.99;

/** An op button (Enter and Space press it too). */
export function button(parent: HTMLElement, text: string, label: string, hint: string, part: string, onClick: () => void): HTMLElement {
  const el = parent.createDiv({ cls: "wadjet-studio-orrery-op", text, attr: { role: "button", tabindex: "0", "aria-label": label, "data-hint": hint, "data-part": part } });
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    onClick();
  });
  return el;
}

/** A text input that commits on change (Enter, or leaving it); Escape puts the drawn value back. */
export function input(parent: HTMLElement, value: string, label: string, hint: string, part: string, cls: string, commit: (text: string) => void): HTMLInputElement {
  const el = parent.createEl("input", { cls, type: "text", attr: { spellcheck: "false", "aria-label": label, "data-hint": hint, "data-part": part } });
  el.value = value;
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") el.blur();
    if (ev.key === "Escape") {
      el.value = value;
      el.blur();
    }
  });
  el.addEventListener("change", () => {
    if (el.value.trim() === value) return;
    commit(el.value);
  });
  return el;
}

/** A body's phases as the draft holds them (the editing surface), in the draft's order. */
function phasesIn(calendar: CalendarDraft, id: string): Phase[] {
  return (calendar.moons.find((m) => m.id === id)?.phases ?? []).map((p) => ({ name: p.name, at: p.at }));
}

/**
 * Build the body editor into `parent`, and the rename input into `title`
 * (which otherwise holds the body's name as text).
 */
export function buildBodyEditor(parent: HTMLElement, title: HTMLElement, deps: BodyEditorDeps): BodyEditor {
  const knobs: KnobComponent[] = [];
  const chips: ChipComponent[] = [];
  const { ast, bodyId: id } = deps;
  const body = (ast.bodies ?? []).find((b) => b.id === id) as BodyAst;
  const moon = moonOf(deps.calendar, ast, id);
  const refusalEl = parent.createDiv({ cls: "wadjet-studio-orrery-refusal is-hidden", attr: { role: "status", "aria-live": "polite" } });
  const setRefusal = (reason: string | null): void => {
    refusalEl.setText(reason ?? "");
    refusalEl.toggleClass("is-hidden", reason === null);
  };
  setRefusal(deps.refusal);
  const done: BodyEditor = {
    setRefusal,
    destroy: () => {
      for (const k of knobs) k.destroy();
      for (const c of chips) c.destroy();
    },
  };
  if (typeof moon === "string") {
    parent.createDiv({ cls: "wadjet-studio-orrery-note", text: `Read-only here: ${moon}.` });
    return done;
  }

  // ---- name, inline
  title.empty();
  title.addClass("is-editable");
  input(title, moon.name, "Moon name", orreryHint("orrery.bodyName"), "body-name", "wadjet-studio-orrery-title-input", (text) => deps.edit((c, b) => renameBody(c, b, id, text), "click"));

  // ---- period and epoch
  const stored = (deps.baseAst?.bodies ?? []).find((b) => b.id === id) ?? null;
  const period = body.period;
  const epoch = body.epoch;
  const knobRow = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
  const days = toNumber(period);
  knobs.push(
    createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "body-period" } }), {
      spec: { min: Math.min(1, days), max: Math.max(60, Math.ceil(days)), step: 0.01, scale: "log" },
      value: days,
      label: "period",
      fmt: (v) => `${v.toFixed(2)} d`,
      parse: (t) => {
        const n = Number(t.replace(/\s*d$/, "").trim());
        return Number.isFinite(n) && n > 0 ? n : null;
      },
      hint: orreryHint("orrery.period"),
      onChange: (v, phase) => deps.edit((c, b) => moveTo(c, b, { period: knobWrite(v, period, stored?.period ?? null, PERIOD_STEP) }), phase),
    }),
  );
  const ep = toNumber(epoch) - Math.floor(toNumber(epoch));
  knobs.push(
    createKnob(knobRow.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "body-epoch" } }), {
      spec: { min: 0, max: FRACTION_MAX, step: 0.01 },
      value: Math.min(FRACTION_MAX, ep),
      label: "epoch",
      fmt: (v) => v.toFixed(2),
      hint: orreryHint("orrery.epoch"),
      // the knob shows the fraction of a turn; the whole turns of the epoch are kept (5a review)
      onChange: (v, phase) => deps.edit((c, b) => moveTo(c, b, { epoch: epochWrite(v, epoch, stored?.epoch ?? null, EPOCH_STEP, FRACTION_MAX) }), phase),
    }),
  );

  // ---- a molad: a body a crossing follows also shows its period in days, hours and parts (n/25920)
  const followers = followersOf(ast, id);
  if (followers.length) {
    const m = moladOf(period);
    const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
    sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Molad · followed by ${followers.join(", ")}${m.exact ? "" : " · ≈"}` });
    const row = sec.createDiv({ cls: "wadjet-studio-orrery-knobs" });
    const part = (key: keyof Molad, label: string, max: number, hint: string): void => {
      knobs.push(
        createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `molad-${key}` } }), {
          spec: { min: 0, max: Math.max(max, m.molad[key]), step: 1 },
          value: m.molad[key],
          label,
          size: "sm",
          fmt: (v) => String(Math.round(v)),
          hint,
          onChange: (v, phase) =>
            deps.edit((c, b) => {
              const next = { ...m.molad, [key]: Math.round(v) };
              // a drag back to where the molad began keeps the period exactly as it was, even one that is no whole
              // number of parts (its knobs show it rounded); one back to the stored molad writes the stored period
              if (next.days === m.molad.days && next.hours === m.molad.hours && next.parts === m.molad.parts) return moveTo(c, b, { period });
              const w = fromMolad(next);
              if (w.kind === "refused") return { refused: true, reason: w.reason };
              const same = (r: Rational | null | undefined): r is Rational => !!r && w.value.n * r.d === r.n * w.value.d;
              return moveTo(c, b, { period: same(period) ? period : same(stored?.period) ? stored.period : w.value });
            }, phase),
        }),
      );
    };
    part("days", "days", 60, orreryHint("orrery.moladDays"));
    part("hours", "hours", 23, orreryHint("orrery.moladHours"));
    part("parts", "parts", 1079, orreryHint("orrery.moladParts"));
  }

  // ---- phases
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Phases" });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-phases" });
  const phases = phasesIn(deps.calendar, id);
  const current = phaseName(body, deps.phase);
  const write = (fn: (ps: Phase[]) => Phase[], phase: EditPhase): void => deps.edit((c, b) => setBodyPhases(c, b, id, fn(phasesIn(c, id))), phase);
  phases.forEach((p, i) => {
    const row = list.createDiv({ cls: "wadjet-studio-orrery-phase", attr: { "data-part": `phase-${i}` } });
    row.toggleClass("is-current", p.name === current);
    input(row, p.name, `Phase ${i + 1} name`, orreryHint("orrery.phaseName"), `phase-${i}-name`, "wadjet-studio-orrery-phase-name", (text) => write((ps) => ps.map((q, j) => (j === i ? { ...q, name: text } : q)), "click"));
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": `phase-${i}-at` } }), {
        spec: { min: 0, max: FRACTION_MAX, step: 0.01 },
        value: Math.min(FRACTION_MAX, p.at),
        label: "at",
        size: "sm",
        fmt: (v) => v.toFixed(2),
        hint: orreryHint("orrery.phaseAt"),
        // a drag back to where the phase began keeps its exact start (5a review)
        onChange: (v, phase) => write((ps) => ps.map((q, j) => (j === i ? { ...q, at: fractionWrite(v, p.at, EPOCH_STEP, FRACTION_MAX) } : q)), phase),
      }),
    );
    button(row, "×", `Remove phase ${p.name}`, orreryHint("orrery.phaseRemove"), `phase-${i}-remove`, () => write((ps) => ps.filter((_, j) => j !== i), "click"));
    const rules = phaseRules(ast, id, p.name);
    if (rules.length) {
      const holder = row.createDiv({ cls: "wadjet-studio-orrery-phase-rules" });
      for (const r of rules) {
        const rule = (ast.rules ?? []).find((x) => x.id === r);
        chips.push(createChip(holder, { label: rule?.name ?? r, icon: "◉", hint: orreryHint("orrery.phaseRule"), onClick: () => deps.select(`rule:${r}`) }));
      }
    }
  });
  if (!phases.length) list.createDiv({ cls: "wadjet-studio-orrery-note", text: "No named phases." });
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "＋ phase", "Add a phase", orreryHint("orrery.addPhase"), "add-phase", () => deps.edit((c, b) => addPhase(c, b, id), "click"));
  button(ops, "Remove body", `Remove the moon ${moon.name}`, orreryHint("orrery.removeBody"), "remove-body", () => deps.edit((c, b) => removeBody(c, b, id), "click")).addClass("is-danger");
  return done;

  function moveTo(c: CalendarDraft, b: CalendarDraft, to: { period?: Rational; epoch?: Rational }): CalendarEdit {
    return moveMoon(c, b, id, to);
  }
}
