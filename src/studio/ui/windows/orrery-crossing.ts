/**
 * The Orrery's crossing and train inspectors (docs/SESHAT-v0.md §18.3 D8,
 * §18.6 item 11; handoff README "Year (crossing base)", "Molad (crossing)",
 * "Train"; bead wadjet-b6x, slice 5d):
 *
 * - a unit that follows a body: the body it follows (a chip that selects it,
 *   and follow… for another), its sentence (`followSentence`), a MARK knob, an
 *   OFFSET knob in hours, START contains | after (the bin's segmented control:
 *   the component bin is closed, components/index.ts, SPEC law 3) and K as a
 *   readout: every edit keeps the occurrence numbers (ast-edit.ts);
 * - a crossing written as numbers: PERIOD days, hours and parts (1/1080 h,
 *   written n/25920 reduced) and CROSSING 0 hour and parts, with START;
 * - the train: knobs for crossings (log 1–800), years (1–60) and phase.
 *
 * NOW (crossing number and day, mean year, long years in the cycle) is the
 * window's, from `partInfo`. The edits are model/orrery-crossing.ts's. As in
 * the other editors, every control reads the draft when it commits, a knob's
 * origin is the part as the editor was built (and its stored value the
 * base's), and the editor never writes the store itself.
 */
import { Menu } from "obsidian";
import { followSentence } from "../../../plugin/time/form";
import type { CalendarAst, CrossingAst, CycleUnitAst, PartId, Rational } from "../../../seshat";
import { toNumber } from "../../../seshat/rational";
import type { CalendarDraft, CalendarEdit } from "../../model/definition";
import { orreryHint } from "../../model/hints-orrery";
import { crossingIn, crossingZero, followable, followBody, markWrite, MARK_MAX, offsetHours, OFFSET_HOURS, offsetWrite, periodWrite, phaseRange, setCrossingZero, setLiteralPeriod, setMark, setOffset, setStartMode, setTrain, TRAIN, trainIn, zeroWrite } from "../../model/orrery-crossing";
import { moladOf, type Molad } from "../../model/rational-knob";
import { createChip, createKnob, createSegmented, type ChipComponent, type KnobComponent, type SegmentedComponent } from "../components";
import { button, type EditPhase, type PartEditor } from "./orrery-body";

export interface CrossingEditorDeps {
  /** the draft AST (the one the edits read) */
  ast: CalendarAst;
  /** the AST the draft was seeded from (a knob's stored value, for its snap-back), or null */
  baseAst: CalendarAst | null;
  unitId: string;
  /** the occurrence of the unit holding the window's day (a period edit keeps its crossing in place), or null when the scope draws an older calendar */
  occurrence: number | null;
  /** the inline refusal to show, from the last edit */
  refusal: string | null;
  edit(make: (calendar: CalendarDraft) => CalendarEdit, phase: EditPhase): void;
  select(part: PartId): void;
}

const signed = (n: number): string => (n >= 0 ? `+${n}` : `−${-n}`);
const whole = (t: string): number | null => {
  const n = Number(t.replace(/\s*[a-z]+$/i, "").replace("−", "-").replace(/^\+/, "").trim());
  return Number.isSafeInteger(n) ? n : null;
};
const fail = (reason: string): CalendarEdit => ({ refused: true, reason });

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

const storedCrossing = (ast: CalendarAst | null, unitId: string): CrossingAst | null => {
  const u = ast?.units.find((x): x is CycleUnitAst => x.kind === "cycle" && x.id === unitId);
  return u?.crossing ?? null;
};

/** A row of whole-number knobs (days, hours, parts) that write one value together. */
function dhpKnobs(row: HTMLElement, knobs: KnobComponent[], keys: ReadonlyArray<{ key: keyof Molad; label: string; max: number; hint: string; part: string }>, start: Molad, write: (next: Molad, phase: EditPhase) => void): void {
  for (const k of keys)
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": k.part } }), {
        spec: { min: Math.min(0, start[k.key]), max: Math.max(k.max, start[k.key]), step: 1 },
        value: start[k.key],
        label: k.label,
        size: "sm",
        fmt: (v) => String(Math.round(v)),
        parse: (t) => whole(t),
        hint: k.hint,
        onChange: (v, phase) => write({ ...start, [k.key]: Math.round(v) }, phase),
      }),
    );
}

/** START: contains | after, for either kind of crossing. */
function startSwitch(parent: HTMLElement, c: CrossingAst, deps: CrossingEditorDeps, parts: Array<ChipComponent | SegmentedComponent>): void {
  const id = deps.unitId;
  const row = parent.createDiv({ cls: "wadjet-studio-orrery-toggle", attr: { "data-part": "crossing-start" } });
  row.createSpan({ cls: "wadjet-studio-orrery-toggle-label", text: "start" });
  const sw = createSegmented(row, {
    options: [
      { value: "contains", label: "contains", hint: orreryHint("orrery.crossingStart") },
      { value: "after", label: "after", hint: orreryHint("orrery.crossingStart") },
    ],
    value: c.start === "after" ? "after" : "contains",
    onChange: (v) => deps.edit((cal) => setStartMode(cal, id, v === "after"), "click"),
  });
  sw.el.setAttr("aria-label", "The year starts on the day holding the crossing, or after it");
  parts.push(sw);
}

/** Build the crossing editor (the year's crossing base) into `parent`. */
export function buildCrossingEditor(parent: HTMLElement, deps: CrossingEditorDeps): PartEditor {
  const { editor, knobs, parts } = shell(parent, deps.refusal);
  const c = crossingIn(deps.ast, deps.unitId);
  if (typeof c === "string") return editor;
  const id = deps.unitId;
  const stored = storedCrossing(deps.baseAst, id);

  if (c.body) {
    const ref = c.body;
    // ---- the body it follows
    const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
    sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: "Follows" });
    const holder = sec.createDiv({ cls: "wadjet-studio-orrery-chips", attr: { "data-part": "crossing-body" } });
    const body = (deps.ast.bodies ?? []).find((b) => b.id === ref.id);
    parts.push(createChip(holder, { label: body?.moon?.name ?? ref.id, icon: "◐", hint: orreryHint("orrery.crossingBody"), onClick: () => deps.select(`body:${ref.id}`) }));
    const others = followable(deps.ast, id);
    if (others.length) {
      const pick = button(holder, "follow…", `Follow another body with the ${id}`, orreryHint("orrery.crossingFollow"), "crossing-follow", () => {
        const menu = new Menu();
        for (const o of followable(deps.ast, id))
          menu.addItem((item) =>
            item
              .setTitle(o.why ? `${o.name} · ${o.why}` : o.name)
              .setDisabled(o.why !== null)
              .onClick(() => deps.edit((cal) => followBody(cal, id, o.id), "click")),
          );
        const box = pick.getBoundingClientRect();
        menu.showAtPosition({ x: box.left, y: box.bottom });
      });
    }
    const sentence = followSentence(deps.ast, id);
    if (sentence) sec.createDiv({ cls: "wadjet-studio-orrery-note", text: `${sentence}.`, attr: { "data-part": "crossing-sentence" } });

    // ---- mark and offset
    const row = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
    const storedRef = stored?.body?.id === ref.id ? stored.body : null;
    const mark = ref.mark;
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "crossing-mark" } }), {
        spec: { min: 0, max: MARK_MAX, step: 0.01 },
        value: Math.min(MARK_MAX, toNumber(mark)),
        label: "mark",
        fmt: (v) => v.toFixed(2),
        hint: orreryHint("orrery.crossingMark"),
        onChange: (v, phase) => deps.edit((cal) => setMark(cal, id, markWrite(v, mark, storedRef?.mark ?? null)), phase),
      }),
    );
    const offset: Rational = ref.offset ?? { n: 0, d: 1 };
    const hours = offsetHours(offset);
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": "crossing-offset" } }), {
        spec: { min: Math.min(-OFFSET_HOURS, hours), max: Math.max(OFFSET_HOURS, hours), step: 1, bipolar: true, neutral: 0 },
        value: hours,
        label: "offset",
        fmt: (v) => `${signed(Math.round(v))} h`,
        parse: (t) => whole(t),
        hint: orreryHint("orrery.crossingOffset"),
        onChange: (v, phase) => deps.edit((cal) => setOffset(cal, id, offsetWrite(Math.round(v), offset, storedRef ? (storedRef.offset ?? { n: 0, d: 1 }) : null)), phase),
      }),
    );
    startSwitch(parent, c, deps, parts);
    const k = parent.createDiv({ cls: "wadjet-studio-orrery-readout", attr: { "data-part": "crossing-k", "data-hint": orreryHint("orrery.crossingK") } });
    k.createSpan({ cls: "wadjet-studio-orrery-caps", text: "K" });
    k.createSpan({ cls: "wadjet-studio-orrery-readout-value", text: String(ref.k ?? 0) });
    return editor;
  }

  // ---- a crossing written as numbers: the period and crossing 0
  const period = c.period;
  const at = c.at;
  const storedLit = stored && !stored.body ? stored : null;
  const m = moladOf(period);
  // the occurrence holding the window's day, read once as the editor is built: every frame of a drag keeps the same crossing
  const keep = deps.occurrence;
  const sec = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  sec.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Period${m.exact ? "" : " · ≈"}` });
  dhpKnobs(
    sec.createDiv({ cls: "wadjet-studio-orrery-knobs" }),
    knobs,
    [
      { key: "days", label: "days", max: 60, hint: orreryHint("orrery.crossingPeriodDays"), part: "period-days" },
      { key: "hours", label: "hours", max: 23, hint: orreryHint("orrery.crossingPeriodHours"), part: "period-hours" },
      { key: "parts", label: "parts", max: 1079, hint: orreryHint("orrery.crossingPeriodParts"), part: "period-parts" },
    ],
    m.molad,
    (next, phase) =>
      deps.edit((cal) => {
        const w = periodWrite(next, period, storedLit?.period ?? null);
        return typeof w === "string" ? fail(w) : setLiteralPeriod(cal, id, w, keep);
      }, phase),
  );
  if (keep !== null) sec.createDiv({ cls: "wadjet-studio-orrery-note", text: `Keeps this ${id} in place: crossing 0 moves instead.`, attr: { "data-part": "period-keeps" } });
  const z = crossingZero(at);
  const zero = parent.createDiv({ cls: "wadjet-studio-orrery-section" });
  zero.createDiv({ cls: "wadjet-studio-orrery-caps", text: `Crossing 0 · D${z.day}${z.exact ? "" : " · ≈"}` });
  dhpKnobs(
    zero.createDiv({ cls: "wadjet-studio-orrery-knobs" }),
    knobs,
    [
      { key: "hours", label: "hour", max: 23, hint: orreryHint("orrery.crossingZeroHours"), part: "zero-hours" },
      { key: "parts", label: "parts", max: 1079, hint: orreryHint("orrery.crossingZeroParts"), part: "zero-parts" },
    ],
    { days: z.day, hours: z.hours, parts: z.parts },
    (next, phase) =>
      deps.edit((cal) => {
        const w = zeroWrite(next.hours, next.parts, at, storedLit?.at ?? null);
        return typeof w === "string" ? fail(w) : setCrossingZero(cal, id, w);
      }, phase),
  );
  startSwitch(parent, c, deps, parts);
  return editor;
}

/** Build the train editor (the crossing's INDEX a/c/L) into `parent`. */
export function buildTrainEditor(parent: HTMLElement, deps: CrossingEditorDeps): PartEditor {
  const { editor, knobs } = shell(parent, deps.refusal);
  const t = trainIn(deps.ast, deps.unitId);
  if (typeof t === "string") return editor;
  const id = deps.unitId;
  parent.createDiv({ cls: "wadjet-studio-orrery-note", text: `${t.a} crossings in ${t.L} years: year k reads crossing ⌊(${t.a}·k ${t.c < 0 ? "−" : "+"} ${Math.abs(t.c)}) / ${t.L}⌋.`, attr: { "data-part": "train-sentence" } });
  const row = parent.createDiv({ cls: "wadjet-studio-orrery-knobs" });
  parent.createDiv({ cls: "wadjet-studio-orrery-note", text: "Most ratios stop the months adding up; the draft stops running until they do.", attr: { "data-part": "train-warning" } });
  const knob = (part: string, label: string, spec: { min: number; max: number; scale?: "log" }, value: number, hint: string, write: (v: number) => Partial<{ a: number; c: number; L: number }>): void => {
    knobs.push(
      createKnob(row.createDiv({ cls: "wadjet-studio-orrery-knob", attr: { "data-part": part } }), {
        spec: { min: Math.min(spec.min, value), max: Math.max(spec.max, value), step: 1, ...(spec.scale ? { scale: spec.scale } : {}) },
        value,
        label,
        fmt: (v) => String(Math.round(v)),
        parse: (text) => whole(text),
        hint,
        onChange: (v, phase) => deps.edit((cal) => setTrain(cal, id, write(Math.round(v))), phase),
      }),
    );
  };
  knob("train-a", "crossings", { ...TRAIN.a, scale: "log" }, t.a, orreryHint("orrery.trainCrossings"), (a) => ({ a }));
  knob("train-L", "years", TRAIN.L, t.L, orreryHint("orrery.trainYears"), (L) => ({ L }));
  knob("train-c", "phase", phaseRange(t), t.c, orreryHint("orrery.trainPhase"), (c) => ({ c }));
  return editor;
}
