/**
 * The panel footer: `remove from chain`, which drops the device and closes the
 * window it is standing in.
 */
import { removeDevice } from "../../../model/device-edit";
import { deviceHint } from "../../../model/hints-device";
import { type DeviceWindowContext, zoneOf } from "./context";
import { iconButton } from "./icon-button";
import { deviceWindowId } from "./ids";

// --- footer -------------------------------------------------------------

export function buildFoot(c: DeviceWindowContext): void {
  const foot = c.body.createDiv({ cls: "wadjet-studio-device-foot" });
  iconButton(foot, {
    text: "remove from chain",
    label: "Remove from chain",
    hint: deviceHint("device.remove"),
    cls: "wadjet-studio-device-drop",
    onClick: () => {
      c.ctx.store.update(
        (s) => {
          const zone = zoneOf(s);
          if (zone !== null) removeDevice(zone, c.modifierId);
        },
        { history: true },
      );
      c.ctx.windows.close(deviceWindowId(c.modifierId));
    },
  });
}
