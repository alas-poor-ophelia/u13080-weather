/**
 * The Orrery's year, slot unit and slot inspectors (docs/SESHAT-v0.md §18.3;
 * handoff README "Inspector editors"; bead wadjet-b6x, slice 5b).
 *
 * - Year (constant base): a `length` knob (300–420, wider for a year outside
 *   that) and a chip per gear term, `+N when <gear>`, that selects the gear.
 *   A year that starts by a crossing has no knob here (NOW shows it): its
 *   crossing, train and stages have their own inspectors (slice 5d).
 * - Slot unit: SLOTS · THIS YEAR (n, name, flag, this year's length; a row
 *   selects its slot) and `＋ slot`.
 * - Slot: rename, a `days` knob (0–60), `filler` and `takes the rest`
 *   switches, and ↑ ↓ ＋ slot after · Remove slot.
 *
 * The edits are model/orrery-slots.ts's: through the form's year and months
 * where the form reads them, through the AST layer elsewhere. The switches
 * are the bin's segmented control (off | on): the component bin is closed
 * (components/index.ts, SPEC law 3), and a two-way radiogroup is a switch.
 * As in the body editor, every control reads the draft when it commits, a
 * knob's origin is the part as the editor was built, and the editor never
 * writes the store itself.
 */
import type { CalendarAst, CycleUnitAst, PartId, SlotsUnitAst } from "../../../seshat";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { addSlot, moveSlot, removeSlot, renameSlot, setSlotDays, setSlotFiller, setSlotRest, setYearLength, SLOT_DAYS, slotFlag, yearRange } from "../../model/orrery-slots";
import { createChip, createKnob, createSegmented, type ChipComponent, type KnobComponent, type SegmentedComponent } from "../components";
import { button, input, type EditPhase, type PartEditor } from "./orrery-body";

export interface SlotsEditorDeps {
  /** the draft AST (the one the edits read; the scope may be drawing an older one that runs) */
  ast: CalendarAst;
  unitId: string;
  /** this year's lengths of the unit's slots (the parent occurrence holding the window's day), or null when the draft does not run */
  lengths: readonly number[] | null;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
  /** the part the window selects once the edit in hand lands (set inside `make`, so a refused or cancelled edit selects nothing) */
  selectAfter(part: PartId): void;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${-n}`);

/** The editor's shell: the refusal line, and what `destroy` releases. */
function shell(parent: HTMLElement, refusal: string | null): { editor: PartEditor; knobs: KnobComponent[]; parts: Array<ChipComponent | SegmentedComponent> } {
  const knobs: KnobComponent[] = [];
  const parts: Array<ChipComponent | SegmentedComponent> = [];
  const el = parent.createDiv({ cls: "wadjet-studio-orrery-refusal is-hidden", attr: { role: "status", "aria-live": "polite" } });
  const setRefusal = (reason: string | null): void => {
    el.setText(reason ?? "");
    el.toggleClass("is-hidden", reason === null);
  };
  setRefusal(refusal);
  return {
    knobs,
    parts,
    editor: {
      setRefusal,
      destroy: () => {
        for (const k of knobs) k.destroy();
        for (const p of parts) p.destroy();
      },
    },
  };
}

// ---- the year

export interface YearEditorDeps {
  ast: CalendarAst;
  unitId: string;
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
}

export function buildYearEditor(parent: HTMLElement, deps: YearEditorDeps): PartEditor {
  const { editor, knobs, parts } = shell(parent, deps.refusal);
  const u = deps.ast.units.find((x): x is CycleUnitAst => x.kind === "cycle" && x.id === deps.unitId);
  if (!u) return editor;
  if (u.crossing) {
    parent.createDiv({ cls: "wadjet-studio-orrery-note", text: "This year starts on the day of a crossing, so its length is the days from one crossing to the next: its crossing, train and stages are edited on their own parts (the chips below)." });
    return editor;
  }
  const id = u.id;
  const row = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
  const range = yearRange(u.length);
  knobs.push(
    createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "year-length" } }), {
      spec: { min: range.min, max: range.max, step: 1 },
      value: u.length,
      label: "length",
      fmt: (v) => `${Math.round(v)} d`,
      parse: (t) => {
        const n = Number(t.replace(/\s*d$/, "").trim());
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      },
      hint: orreryHint("orrery.yearDays"),
      onChange: (v, phase) => deps.edit((c) => setYearLength(c, id, Math.round(v)), phase),
    }),
  );
  if (u.gears?.length) {
    const holder = parent.createDiv({ cls: "wadjet-studio-orrery-chips is-gears" });
    for (const t of u.gears) parts.push(createChip(holder, { label: `${signed(t.add)} when ${t.gear}`, icon: "⚙", hint: orreryHint("orrery.yearGear"), onClick: () => deps.select(`gear:${t.gear}`) }));
  }
  return editor;
}

// ---- the slot unit

export function buildSlotUnitEditor(parent: HTMLElement, deps: SlotsEditorDeps): PartEditor {
  const { editor } = shell(parent, deps.refusal);
  const u = deps.ast.units.find((x): x is SlotsUnitAst => x.kind === "slots" && x.id === deps.unitId);
  if (!u) return editor;
  const id = u.id;
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: deps.lengths ? "Slots · this year" : "Slots · as written" });
  const list = sec.createDiv({ cls: "wadjet-studio-orrery-slots", attr: { role: "list" } });
  u.slots.forEach((s, i) => {
    const n = i + (u.number ?? 1);
    const len = deps.lengths?.[i];
    const shown = len !== undefined ? `${len} d` : typeof s.length === "number" ? `${s.length} d` : s.length === "slack" ? "rest" : "by year";
    const row = list.createDiv({ cls: "wadjet-studio-orrery-slot", attr: { role: "listitem", tabindex: "0", "data-part": `slot-row-${i}`, "data-hint": orreryHint("orrery.slotRow"), "aria-label": `${s.name ?? `slot ${n}`}, ${shown}` } });
    row.toggleClass("is-absent", len === 0);
    row.createSpan({ cls: "wadjet-studio-orrery-slot-n", text: String(n) });
    row.createSpan({ cls: "wadjet-studio-orrery-slot-name", text: s.name ?? "—" });
    row.createSpan({ cls: "wadjet-studio-orrery-slot-flag", text: slotFlag(s) });
    row.createSpan({ cls: "wadjet-studio-orrery-slot-len", text: shown });
    const pick = (): void => deps.select(`slot:${id}:${i}`);
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      pick();
    });
  });
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  button(ops, "＋ slot", `Add a slot to the ${id}`, orreryHint("orrery.addSlot"), "add-slot", () =>
    deps.edit((c) => {
      const r = addSlot(c, id, -1);
      if (!("refused" in r) && r.index !== undefined) deps.selectAfter(`slot:${id}:${r.index}`);
      return r;
    }, "click"),
  );
  return editor;
}

// ---- the slot

/** A labelled off | on switch (the bin's segmented control). */
function toggle(parent: HTMLElement, label: string, on: boolean, hint: string, part: string, onChange: (on: boolean) => void): SegmentedComponent {
  const row = parent.createDiv({ cls: "wadjet-studio-orrery-toggle", attr: { "data-part": part } });
  row.createSpan({ cls: "wadjet-studio-orrery-toggle-label", text: label });
  const seg = createSegmented(row, {
    options: [
      { value: "off", label: "off", hint },
      { value: "on", label: "on", hint },
    ],
    value: on ? "on" : "off",
    onChange: (v) => onChange(v === "on"),
  });
  seg.el.setAttr("aria-label", label);
  return seg;
}

/**
 * Build the slot editor into `parent`, and the rename input into `title`.
 * @param index the slot's index in its unit
 */
export function buildSlotEditor(parent: HTMLElement, title: HTMLElement, deps: SlotsEditorDeps & { index: number }): PartEditor {
  const { editor, knobs, parts } = shell(parent, deps.refusal);
  const u = deps.ast.units.find((x): x is SlotsUnitAst => x.kind === "slots" && x.id === deps.unitId);
  const s = u?.slots[deps.index];
  if (!u || !s) return editor;
  const id = u.id;
  const i = deps.index;
  const n = i + (u.number ?? 1);
  const thisYear = deps.lengths?.[i];

  // ---- name, inline
  title.empty();
  title.addClass("is-editable");
  const name = input(title, s.name ?? "", `Slot ${n} name`, orreryHint("orrery.slotName"), "slot-name", "wadjet-studio-orrery-title-input", (text) => deps.edit((c) => renameSlot(c, id, i, text), "click"));
  if (s.name === undefined) name.setAttr("placeholder", `${id} ${n}`);

  // ---- days
  const keyed = typeof s.length === "object";
  const days = typeof s.length === "number" ? s.length : (thisYear ?? 0);
  const row = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
  knobs.push(
    createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "slot-days" } }), {
      spec: { min: SLOT_DAYS.min, max: Math.max(SLOT_DAYS.max, days), step: 1 },
      value: days,
      label: "days",
      fmt: (v) => `${Math.round(v)} d`,
      parse: (t) => {
        const v = Number(t.replace(/\s*d$/, "").trim());
        return Number.isSafeInteger(v) && v >= 0 ? v : null;
      },
      disabled: keyed,
      hint: orreryHint("orrery.slotDays"),
      onChange: (v, phase) => deps.edit((c) => setSlotDays(c, id, i, Math.round(v)), phase),
    }),
  );
  if (keyed) parent.createDiv({ cls: "wadjet-studio-orrery-note", text: "This slot's length follows its year's length, row by row: edit it as text." });
  else if (s.length === "slack") parent.createDiv({ cls: "wadjet-studio-orrery-note", text: "Takes the rest: the knob shows this year's length; moving it fixes the slot at that many days." });

  // ---- switches
  const sw = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  parts.push(toggle(sw, "filler", s.filler === true, orreryHint("orrery.slotFiller"), "slot-filler", (on) => deps.edit((c) => setSlotFiller(c, id, i, on), "click")));
  parts.push(toggle(sw, "takes the rest", s.length === "slack", orreryHint("orrery.slotRest"), "slot-rest", (on) => deps.edit((c) => setSlotRest(c, id, i, on, thisYear ?? days), "click")));

  // ---- ops
  const ops = parent.createDiv({ cls: "wadjet-studio-orrery-ops" });
  const op = (text: string, label: string, hint: string, part: string, make: (c: CalendarDraft) => CalendarEdit & { readonly index?: number }, after: (r: { index?: number }) => PartId): HTMLElement =>
    button(ops, text, label, hint, part, () =>
      deps.edit((c) => {
        const r = make(c);
        if (!("refused" in r)) deps.selectAfter(after(r));
        return r;
      }, "click"),
    );
  op("↑", `Move ${s.name ?? `slot ${n}`} up`, orreryHint("orrery.slotUp"), "slot-up", (c) => moveSlot(c, id, i, -1), () => `slot:${id}:${i - 1}`);
  op("↓", `Move ${s.name ?? `slot ${n}`} down`, orreryHint("orrery.slotDown"), "slot-down", (c) => moveSlot(c, id, i, 1), () => `slot:${id}:${i + 1}`);
  op("＋ slot after", `Add a slot after ${s.name ?? `slot ${n}`}`, orreryHint("orrery.slotAddAfter"), "slot-add-after", (c) => addSlot(c, id, i), (r) => `slot:${id}:${r.index ?? i + 1}`);
  op("Remove slot", `Remove ${s.name ?? `slot ${n}`}`, orreryHint("orrery.slotRemove"), "slot-remove", (c) => removeSlot(c, id, i), () => `unit:${id}`).addClass("is-danger");
  return editor;
}
