/**
 * WHEN · tag — the summary line the prototype's Neverain body IS, then the
 * season/era tags the device fires on, as removable chips plus a `＋` menu of
 * the ones it does not have yet (SPEC §5).
 *
 * A **curse** (`badgeFor` → `CURSE`: the modifier carries `badge: "curse"`,
 * picked in the insert picker) is drawn the way `1213-vst-neverain.html` draws
 * it — a 300 px box whose whole body is that one line. So on a curse the summary
 * row is also a disclosure, and the chips and the APPLY grid hang behind it;
 * `index.ts` reads `curseCollapsed` to know whether to draw APPLY at all. Every
 * other tag device keeps the row *and* everything under it, expanded.
 */
import { Menu } from "obsidian";
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { paramName } from "../../../model/copy";
import { setWhen } from "../../../model/device-edit";
import { badgeFor, composedPairs, type Device, opValueText } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChip } from "../../components";
import type { DeviceWindowContext } from "./context";
import { colourOf, tagColour, tagSources } from "./geometry";
import { iconButton } from "./icon-button";

/**
 * True while a curse's disclosure is shut: the tag chips and the
 * APPLY section are both behind it. One predicate, read by this file and by
 * `index.ts`, so the row and the section can never disagree about the state.
 */
export function curseCollapsed(c: DeviceWindowContext, d: Device): boolean {
  return d.when.kind === "tag" && badgeFor(d) === "CURSE" && !c.applyOpen();
}

/**
 * The summary line (gap2 D4, D5): what the device writes, left, in the op's own
 * CHANNEL hue — the prototype paints its `×0` in the curse orange, which would
 * claim the rain is a temperature, so the plugin keeps the channel's blue — and
 * the gate it fires on, right, in the mute the prototype's own `#9298a1` is.
 *
 * The composed pair (`composedPairs`) is one span here for the same reason it
 * is one APPLY column: two writes a reader cannot tell apart are one edit, and
 * `precip ×0 while active` twice would read as two.
 */
function buildSummary(c: DeviceWindowContext, parent: HTMLElement, d: Device, tags: string[]): void {
  const collapsible = d.when.kind === "tag" && badgeFor(d) === "CURSE";
  const open = c.applyOpen();
  const row = collapsible
    ? iconButton(parent, {
        text: "",
        label: open ? "Hide the tags and the apply grid" : "Show the tags and the apply grid",
        hint: deviceHint("device.when.tagApply"),
        cls: "wadjet-studio-device-summary",
        onClick: () => {
          c.setApplyOpen(!open);
          c.invalidate();
        },
      })
    : parent.createDiv({ cls: "wadjet-studio-device-summary", attr: { "data-hint": deviceHint("device.when.tagSummary") } });
  // One part name for the row, whichever shape it is in: the disclosure is the
  // row, so `aria-expanded` — present only when it can be shut — is what says
  // it is one, rather than a second `data-part` on the same element.
  row.setAttr("data-part", "tag-summary");
  if (collapsible) row.setAttr("aria-expanded", open ? "true" : "false");

  const qualifier = d.spell === undefined ? "while active" : "while running";
  const hidden = new Set(composedPairs(d.apply).map(([, hi]) => hi));
  d.apply.forEach((op, i) => {
    if (hidden.has(i)) return;
    const span = row.createSpan({ cls: "wadjet-studio-device-summary-op" });
    span.createSpan({ text: `${paramName(op.param)} ` });
    const value = span.createSpan({ cls: "wadjet-studio-device-summary-value", text: opValueText(op, c.ctx.units()) });
    value.setCssProps({ "--wadjet-studio-chip-color": colourOf(op.param) });
    span.createSpan({ text: ` ${qualifier}` });
  });

  row.createDiv({ cls: "wadjet-studio-device-spacer" });
  // No `data-tag` on this span: `[data-tag]` under `.wadjet-studio-device-when`
  // is the chip row's contract, and a gate readout is not a removable chip.
  row.createSpan({ cls: "wadjet-studio-device-summary-gate", text: `gate: ${tags.join(" or ")}` });
}

/**
 * The selected tags only, each removable, plus a `＋` that offers the rest
 * in a menu — the prototype's compact picker, not an inline list of every
 * tag the world has ever heard of.
 */
export function buildTag(c: DeviceWindowContext, parent: HTMLElement, d: Device, tags: string[], description: CalendarDescription | null): void {
  const seasons = description?.seasons ?? [];
  buildSummary(c, parent, d, tags);
  if (curseCollapsed(c, d)) return;
  const chips = parent.createDiv({ cls: "wadjet-studio-device-chips" });
  for (const tag of tags) {
    const chip = createChip(chips, {
      label: tag,
      color: tagColour(tag, seasons),
      // A dot, not the ⚑ the MOD gate rows wear: in the prototype the flag
      // belongs to the gate matrix (`0699` l.70) and a WHEN tag is a plain
      // coloured dot (`1095` l.47).
      hint: deviceHint("device.when.tag"),
      ...(tags.length > 1 ? { onClick: () => toggleTag(c, tag) } : {}),
    });
    chip.el.addClass("is-selected");
    chip.el.setAttrs({ "data-tag": tag, "aria-pressed": "true" });
    c.addPart(chip);
  }
  iconButton(chips, {
    text: "＋",
    label: "Add a tag",
    hint: deviceHint("device.when.tagAdd"),
    cls: "wadjet-studio-device-add",
    onClick: (ev) => {
      const menu = new Menu();
      const offered = tagSources(seasons, c.ctx.store.get().world.eras).filter((t) => !tags.includes(t));
      for (const tag of offered) menu.addItem((item) => item.setTitle(tag).onClick(() => toggleTag(c, tag, true)));
      if (offered.length === 0) menu.addItem((item) => item.setTitle("No other seasons or eras").setDisabled(true));
      menu.showAtMouseEvent(ev);
    },
  });
}

/** Toggling the *last* tag off is refused: `{ any: [] }` matches nothing and the validator rejects it. */
function toggleTag(c: DeviceWindowContext, tag: string, addOnly = false): void {
  c.mutate((x) => {
    if (x.when.kind !== "tag") return;
    const has = x.when.tags.includes(tag);
    if (has && addOnly) return;
    const next = has ? x.when.tags.filter((t) => t !== tag) : [...x.when.tags, tag];
    if (next.length === 0) return;
    setWhen(x, { kind: "tag", tags: next });
  }, true);
}
