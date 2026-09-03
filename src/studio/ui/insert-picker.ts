/**
 * The insert picker (SPEC §3.6): the popover a chain's `＋` opens.
 *
 * `NEW DEVICE → <CHAIN LABEL>`, then the five kinds (SPEC §3.6, `model/insert.ts`
 * `insertKinds`), then a `PRESETS` section — shipped first, then the world's
 * own, badged `yours` (`presetsFor`). Picking either inserts the device into
 * the pointed-at zone as one undoable edit and opens its window.
 *
 * Three things worth knowing before editing this file:
 *
 *  - **It is not a floating window.** `WindowManager` (`windows.ts`) is for
 *    the draggable, persistent panels of SPEC §3.4; this is a transient
 *    popover that closes the moment it is used or dismissed, so it is its own
 *    small piece of DOM appended straight to `shell.root` (SPEC §3.6:
 *    "absolute inside `.wadjet-studio-windows` or a dedicated
 *    `.wadjet-studio-popover` layer in `shell.root`") rather than something
 *    `windows.ts` tracks.
 *  - **One picker at a time.** Opening a second one (a different chain's `＋`,
 *    or the same one again) tears down whatever is already open first —
 *    `close()` on the module-level `active` handle — so a stray listener from
 *    an abandoned popover can never outlive it.
 *  - **A freshly created device's window is opened with its builder passed
 *    explicitly** (`ctx.windows.open(deviceWindowId(id), buildDeviceWindow(id))`),
 *    not by id alone: `devices-surface.ts` only re-registers builders on the
 *    next store tick, and the device this popover just created has no builder
 *    registered yet at the moment it closes.
 */
import type { Units } from "../../core/units";
import type { ZoneProfile } from "../../core/types";
import type { CalendarDescription } from "../../plugin/time/adapter";
import { describeOp, kindColor } from "../model/copy";
import { mixerHint } from "../model/hints-mixer";
import { badgeForKind, insertDevice, insertPreset, insertKinds, presetsFor, type InsertPresetOption } from "../model/insert";
import { CHAIN_LABEL, type Chain } from "../model/mixer";
import type { SurfaceContext } from "./surfaces";
import { buildDeviceWindow, deviceWindowId } from "./windows/device";

/** Gap between the anchor row's bottom edge and the popover, in px. */
const OFFSET_Y = 2;

interface ActivePicker {
  el: HTMLElement;
  close: () => void;
}

/** The one open picker, if any. Module-level: only one popover exists at a time (see the file docstring). */
let active: ActivePicker | null = null;

function closeActive(): void {
  if (active === null) return;
  const a = active;
  active = null;
  a.close();
}

/**
 * Sit the popover exactly where the prototype's *inline* picker sits: the full
 * width of the chain header it was opened from, its top edge on that header's
 * bottom edge (`0556-mixer-rail.html`). It still floats — the rail owns its own
 * layout and belongs to another surface — but it reads as the chain's own
 * drawer rather than as an overlay dropped on the rack. Clamped to `root`.
 */
function place(el: HTMLElement, root: HTMLElement, anchorEl: HTMLElement): void {
  const rootRect = root.getBoundingClientRect();
  // The chain header row, not the bare `＋`: the picker spans the chain.
  const row = anchorEl.parentElement ?? anchorEl;
  const rowRect = row.getBoundingClientRect();
  el.setCssProps({ "--wadjet-studio-insert-w": `${Math.round(rowRect.width)}px` });
  const maxX = Math.max(0, rootRect.width - el.offsetWidth);
  const maxY = Math.max(0, rootRect.height - el.offsetHeight);
  const x = Math.min(Math.max(0, rowRect.left - rootRect.left), maxX);
  const y = Math.min(Math.max(0, rowRect.bottom - rootRect.top + OFFSET_Y), maxY);
  el.setCssProps({ "--wadjet-studio-insert-x": `${x}px`, "--wadjet-studio-insert-y": `${y}px` });
}

function badgeText(source: InsertPresetOption["source"]): string {
  return source === "yours" ? "your saved preset" : "shipped preset";
}

/**
 * `precip ×1.40 · wind ×1.25` — what a preset row writes, in product copy.
 *
 * Deduped: two ops can share one product name (`precipitation.pwd` and
 * `.pww` are both `precip`), and `precip 0 — no rain · precip 0 — no rain`
 * tells the reader nothing the first clause did not. The engine paths are
 * still whole in the device window's WRITES footer.
 */
function presetSub(opt: InsertPresetOption, units: Units): string {
  return [...new Set(opt.preset.apply.map((op) => describeOp(op, { units })))].join(" · ");
}

/**
 * Open the picker for `chain`, anchored under `anchorEl` (the chain's `＋`).
 * A no-op when the studio has no pointed-at zone (nothing to insert into).
 */
export function openInsertPicker(ctx: SurfaceContext, chain: Chain, anchorEl: HTMLElement): void {
  closeActive();

  const state = ctx.store.get();
  const zoneId = state.view.zoneId;
  if (zoneId === null) return;
  const calendar: CalendarDescription | null = ctx.calendar();

  const el = ctx.shell.root.createDiv({ cls: "wadjet-studio-insert", attr: { role: "menu", "aria-label": `New device → ${CHAIN_LABEL[chain]}` } });
  const bar = el.createDiv({ cls: "wadjet-studio-insert-bar" });
  bar.createSpan({ cls: "wadjet-studio-insert-title", text: `NEW DEVICE → ${CHAIN_LABEL[chain]}` });
  const closeBtn = bar.createSpan({ cls: "wadjet-studio-insert-close", text: "×", attr: { role: "button", tabindex: "0", "aria-label": "Close the insert picker" } });
  closeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeActive();
  });
  closeBtn.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    closeActive();
  });

  /** Run `action` as one undoable edit, then close the picker and open the new device's window. */
  function insertAndOpen(action: (z: ZoneProfile) => string): void {
    let newId: string | null = null;
    ctx.store.update(
      (s) => {
        const zone = s.view.zoneId === null ? undefined : s.zones[s.view.zoneId];
        if (zone === undefined) return;
        newId = action(zone);
      },
      { history: true },
    );
    closeActive();
    if (newId !== null) ctx.windows.open(deviceWindowId(newId), buildDeviceWindow(newId));
  }

  /**
   * One picker row: kind pill · name · [`yours`] · the grammar it writes.
   * The pill carries the colour (`copy.ts:kindColor`), the row stays neutral —
   * SPEC §9 keeps colour off chrome.
   */
  function row(
    o: { label: string; kindBadge: string; sub: string; hintKey: string; hintDetail: string; attrs: Record<string, string>; badge?: string | undefined; onPick: () => void },
  ): void {
    const r = el.createDiv({ cls: "wadjet-studio-insert-row", attr: { role: "menuitem", tabindex: "0", "data-hint": mixerHint(o.hintKey, o.hintDetail), ...o.attrs } });
    const pill = r.createSpan({ cls: "wadjet-studio-insert-kind", text: o.kindBadge });
    pill.setCssProps({ "--wadjet-studio-insert-kind-color": kindColor(o.kindBadge) });
    r.createSpan({ cls: "wadjet-studio-insert-row-label", text: o.label });
    if (o.badge !== undefined) r.createSpan({ cls: "wadjet-studio-insert-badge", text: o.badge });
    r.createSpan({ cls: "wadjet-studio-insert-row-sub", text: o.sub });
    const onPick = o.onPick;
    r.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onPick();
    });
    r.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      onPick();
    });
  }

  const units: Units = ctx.plugin.settings.units;

  el.createDiv({ cls: "wadjet-studio-insert-section", text: "KINDS" });
  for (const k of insertKinds()) {
    row({
      label: k.label,
      kindBadge: k.badge,
      sub: k.sub,
      hintKey: "insert.kind",
      hintDetail: k.hint,
      attrs: { "data-part": "kind", "data-kind": k.kind },
      onPick: () => insertAndOpen((z) => insertDevice(z, k.kind, chain, calendar)),
    });
  }

  el.createDiv({ cls: "wadjet-studio-insert-section", text: "PRESETS" });
  for (const opt of presetsFor(state.world)) {
    row({
      label: opt.name,
      kindBadge: badgeForKind(opt.kind),
      sub: presetSub(opt, units),
      hintKey: "insert.preset",
      hintDetail: badgeText(opt.source),
      attrs: { "data-part": "preset", "data-preset": opt.name, "data-source": opt.source },
      badge: opt.source === "yours" ? "yours" : undefined,
      onPick: () => insertAndOpen((z) => insertPreset(z, opt.preset, chain, calendar)),
    });
  }

  function onOutsideClick(ev: MouseEvent): void {
    const target = ev.target as Node | null;
    if (target !== null && (el.contains(target) || anchorEl.contains(target))) return;
    closeActive();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    closeActive();
  }
  window.addEventListener("click", onOutsideClick);
  window.addEventListener("keydown", onKeyDown);

  active = {
    el,
    close: () => {
      window.removeEventListener("click", onOutsideClick);
      window.removeEventListener("keydown", onKeyDown);
      el.remove();
    },
  };

  place(el, ctx.shell.root, anchorEl);
}
