/**
 * The channel editors' registration surface (PLAN D11, §4).
 *
 * Like `moons-surface.ts` this is a registrar, not a region: it owns no part
 * of the shell. A channel editor is reached from its playlist row's label
 * (SPEC law 2), and `windows.ts` can only open an id a builder has been
 * registered for — so the four ids have to exist before `windows.restore()`
 * runs, or a `channel:temperature` panel the leaf remembered would not come
 * back.
 *
 * All four ids are registered, not just the built one. Bead wadjet-9f9.32
 * fills `CHANNEL_SPECS` in for the other three; until it does, their builder
 * opens a panel that says so, which is still better than a row label that
 * does nothing when clicked.
 *
 * The set of ids is fixed (the four channels are the four signal chains), so
 * unlike the device and cycle surfaces this one registers once at `mount` and
 * has nothing to do per tick.
 */
import { buildChannelWindow, channelWindowId } from "./windows/channel";
import type { Channel } from "../model/compile";
import type { Surface, SurfaceContext } from "./surfaces";

/** The four signal chains, in SPEC §1 order. */
const CHANNELS: readonly Channel[] = ["temperature", "precipitation", "wind", "sky"];

export function createChannelsSurface(): Surface {
  return {
    mount(ctx: SurfaceContext) {
      for (const channel of CHANNELS) ctx.windows.register(channelWindowId(channel), buildChannelWindow(channel));
    },

    render() {
      // The id set never changes: registration is a one-off at mount.
    },

    destroy() {
      // Builders live in the window manager, which `view.ts` destroys itself.
    },
  };
}
