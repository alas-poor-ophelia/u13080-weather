/**
 * WHEN · chance — one knob over a seeded roll. Its own file so the WHEN
 * dispatcher has one module per kind (SPEC §5).
 */
import { setWhen } from "../../../model/device-edit";
import { deviceHint } from "../../../model/hints-device";
import type { DeviceWindowContext } from "./context";

export function buildChance(c: DeviceWindowContext, parent: HTMLElement, p: number): void {
  // One flex row, not a knob column (`1095` l.68-72): dial, then the readout
  // and the seeding note beside it. The caption is dropped there because the
  // WHEN segmented already says `chance` two lines up.
  const row = parent.createDiv({ cls: "wadjet-studio-device-chance" });
  c.knob(row, {
    part: "when-chance",
    label: "chance",
    min: 0,
    max: 1,
    step: 0.01,
    value: p,
    fmt: (v) => `${Math.round(v * 100)}% of days`,
    color: "var(--wadjet-studio-wind)",
    hint: deviceHint("device.when.chance"),
    onChange: (v, phase) =>
      c.gesture(phase, (x) => {
        if (x.when.kind === "chance") setWhen(x, { kind: "chance", p: v });
      }),
  });
  row.createSpan({ cls: "wadjet-studio-device-note", text: "seeded · same days every roll" });
}
