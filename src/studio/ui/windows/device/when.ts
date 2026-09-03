/**
 * The WHEN section and its kind dispatcher: the segmented picker in the
 * section head, then whichever kind body the device is on (SPEC §5). Each
 * kind lives in its own `when-*.ts`.
 */
import { WHEN_KINDS, defaultWhenFor, setWhen } from "../../../model/device-edit";
import { type Device, type WhenKind, whenSummary } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { createChip, createSegmented } from "../../components";
import { DEFAULT_YEAR_LENGTH } from "./constants";
import type { DeviceWindowContext } from "./context";
import { buildChance } from "./when-chance";
import { buildMoon } from "./when-moon";
import { buildTag } from "./when-tag";
import { buildYearWindow } from "./when-year-window";

// --- WHEN ---------------------------------------------------------------

export function buildWhen(c: DeviceWindowContext, d: Device): void {
  const description = c.calendar();
  const yearLength = description?.yearLength ?? DEFAULT_YEAR_LENGTH;
  const sec = c.section("WHEN", "device.when", { summary: whenSummary(d, yearLength) });

  if (d.custom === true) {
    c.addPart(createChip(sec.content, { label: "custom", color: "var(--wadjet-studio-warn)", hint: deviceHint("device.when") }));
    sec.content.createSpan({ cls: "wadjet-studio-device-raw", text: JSON.stringify(d.raw?.when ?? null) });
    return;
  }

  const segmented = createSegmented(sec.head, {
    options: WHEN_KINDS.map((k) => ({ value: k.when, label: k.label, hint: deviceHint("device.when") })),
    value: d.when.kind,
    onChange: (value) => c.mutate((x) => setWhen(x, defaultWhenFor(value as WhenKind, c.calendar())), true),
  });
  segmented.el.setAttr("data-part", "when-kind");
  c.addPart(segmented);

  const kindBody = sec.content.createDiv({ cls: "wadjet-studio-device-when" });
  const w = d.when;
  if (w.kind === "always") kindBody.createDiv({ cls: "wadjet-studio-device-note", text: "no predicate → applied once to the curves, not per day" });
  else if (w.kind === "moon") buildMoon(c, kindBody, w.moon, w.phases, w.range, description);
  else if (w.kind === "tag") buildTag(c, kindBody, w.tags, description);
  else if (w.kind === "yearWindow") buildYearWindow(c, kindBody, d, description, yearLength);
  else if (w.kind === "chance") buildChance(c, kindBody, w.p);
}
