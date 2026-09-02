/**
 * The device windows' registration surface (PLAN D11, §4).
 *
 * Every floating panel is opened *by id*, and the manager can only open an id
 * a builder has been registered for — that is what makes `windows.restore()`
 * work after a restart. Device panels are keyed on the modifier id, so the set
 * of registrable ids moves with the draft: a device added by the insert
 * picker, renamed, removed, or swapped out by a zone switch all change it.
 *
 * This surface owns exactly that: it holds no DOM of its own (SPEC law 2 — a
 * device window is reached from a mixer unit or a lane clip, never from global
 * chrome), and its whole job is to keep the manager's builder table and the
 * open panels in step with the zone's modifiers.
 *
 * It re-registers only when the device id set actually changes, so a knob drag
 * that repaints twenty frames costs one string comparison per frame.
 */
import { registerDeviceWindows } from "./windows/device";
import { devices } from "../model/compile";
import type { StudioState } from "../model/state";
import type { Surface, SurfaceContext } from "./surfaces";

/** The zone the studio is pointed at, plus its device ids in chain order. */
function deviceKey(state: StudioState): string {
  const zoneId = state.view.zoneId;
  const zone = zoneId === null ? null : (state.zones[zoneId] ?? null);
  return `${zoneId ?? ""}|${zone === null ? "" : devices(zone).map((m) => m.id).join("\u001f")}`;
}

export function createDevicesSurface(): Surface {
  let ctx: SurfaceContext | null = null;
  let unsubscribe: (() => void) | null = null;
  let key: string | null = null;

  function sync(): void {
    const c = ctx;
    if (c === null) return;
    const next = deviceKey(c.store.get());
    if (next === key) return;
    key = next;
    registerDeviceWindows(c);
  }

  return {
    mount(next) {
      ctx = next;
      sync();
      // Its own subscription rather than `render` alone: a device created by a
      // click handler must be openable before the next surface render lands.
      unsubscribe = next.store.subscribe(() => sync());
    },

    render() {
      sync();
    },

    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      ctx = null;
      key = null;
    },
  };
}
