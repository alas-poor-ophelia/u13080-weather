/**
 * The WHEN section and its kind dispatcher: the segmented picker in the
 * section head, then whichever kind body the device is on (SPEC §5). Each
 * kind lives in its own `when-*.ts`.
 */
import { WHEN_KINDS, defaultWhenFor, setWhen } from "../../../model/device-edit";
import type { Device, WhenKind } from "../../../model/devices";
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
  const sec = c.section("WHEN", "device.when");

  // The stage badge sits between the caption and the segmented, not in the
  // title bar (`1095` l.27, `devStageLbl`): the WHEN row is what decides it.
  sec.head.createSpan({
    cls: "wadjet-studio-device-stage",
    text: d.stage === "climate" ? "climate stage" : "daily stage",
    attr: { "data-part": "stage", "data-hint": deviceHint("device.stage") },
  });

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
  if (w.kind === "always") {
    // `1095` l.34, verbatim: the stage the sentence lands on is the one word
    // in it that is not dim.
    const note = kindBody.createDiv({ cls: "wadjet-studio-device-note", text: "no predicate → " });
    note.createSpan({ cls: "wadjet-studio-device-note-em", text: "climate stage" });
    note.createSpan({ text: " · applied once to the curves, not per day" });
  }
  else if (w.kind === "moon") buildMoon(c, kindBody, w.moon, w.phases, w.range, description);
  else if (w.kind === "tag") buildTag(c, kindBody, w.tags, description);
  else if (w.kind === "yearWindow") buildYearWindow(c, kindBody, d, description, yearLength);
  else if (w.kind === "chance") buildChance(c, kindBody, w.p);
}
