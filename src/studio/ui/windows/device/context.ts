/**
 * The handle a device *body* is built against.
 *
 * `index.ts` owns the panel's spine — the store reads, the rebuild scheduling,
 * the section and knob factories, the two shared cursors (`clipAt`, `modOpen`)
 * — and hands every body one object over it. Three of those members exist for
 * a reason worth writing down:
 *
 *  - `addPart`, never the array: `clearParts()` *rebinds* `parts` on every
 *    rebuild, so a body holding the array would be pushing into a dead one.
 *  - `clipAt` / `modOpen` are getter/setter pairs, not values: they are shared
 *    mutable state that `stateKey()` reads, so a copy would go stale the
 *    moment a body moved it.
 *  - `endGesture()` closes a hand-rolled drag the way the knobs do — drop the
 *    live flag, then take one undo snapshot — without a body ever touching the
 *    flag itself.
 */
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import type { Device } from "../../../model/devices";
import type { StudioState } from "../../../model/state";
import type { SurfaceContext } from "../../surfaces";
import type { Part } from "./icon-button";

/** The zone the studio is pointed at, or null when it is pointed at nothing. */
export const zoneOf = (s: StudioState) => (s.view.zoneId === null ? null : (s.zones[s.view.zoneId] ?? null));

/** A section's two halves: the head the caption and its controls sit in, and the body under it. */
export interface Section {
  head: HTMLElement;
  content: HTMLElement;
}

/** Everything `index.ts`'s `knob()` factory takes; `part` becomes the control's `data-part`. */
export interface DeviceKnobOptions {
  part: string;
  label: string;
  min: number;
  max: number;
  step: number;
  neutral?: number;
  value: number;
  fmt: (v: number) => string;
  parse?: (text: string) => number | null;
  hint: string;
  color?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  onChange: (v: number, phase: "drag" | "end" | "key" | "type") => void;
}

export interface DeviceWindowContext {
  ctx: SurfaceContext;
  modifierId: string;
  body: HTMLElement;
  calendar(): CalendarDescription | null;
  mutate(fn: (d: Device) => void, history: boolean): void;
  gesture(phase: "drag" | "end" | "key" | "type", fn: (d: Device) => void): void;
  beginLive(): void;
  endGesture(): void;
  invalidate(): void;
  addPart(part: Part): void;
  section(name: string, hintKey: string, o?: { qualifier?: string; summary?: string }): Section;
  knob(parent: HTMLElement, o: DeviceKnobOptions): HTMLElement;
  clipAt(): number;
  setClipAt(at: number): void;
  modOpen(): boolean;
  setModOpen(open: boolean): void;
  setCancelDrag(cancel: (() => void) | null): void;
}
