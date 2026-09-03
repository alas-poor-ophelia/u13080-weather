/**
 * WHEN · tag — the season/era tags the device fires on, as removable chips
 * plus a `＋` menu of the ones it does not have yet (SPEC §5).
 */
import { Menu } from "obsidian";
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { setWhen } from "../../../model/device-edit";
import { deviceHint } from "../../../model/hints-device";
import { createChip } from "../../components";
import type { DeviceWindowContext } from "./context";
import { tagColour, tagSources } from "./geometry";
import { iconButton } from "./icon-button";

/**
 * The selected tags only, each removable, plus a `＋` that offers the rest
 * in a menu — the prototype's compact picker, not an inline list of every
 * tag the world has ever heard of.
 */
export function buildTag(c: DeviceWindowContext, parent: HTMLElement, tags: string[], description: CalendarDescription | null): void {
  const seasons = description?.seasons ?? [];
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
