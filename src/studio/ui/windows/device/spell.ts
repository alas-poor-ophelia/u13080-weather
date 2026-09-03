/**
 * The SPELL section: the on/off toggle in the section head, and the two knobs
 * that describe a run when it is on (SPEC §5).
 */
import { defaultSpell, setSpell } from "../../../model/device-edit";
import { type Device, SPELL_DURATION_RANGE, SPELL_STARTS_RANGE } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { LONG_SPELL_DAYS } from "./constants";
import type { DeviceWindowContext } from "./context";
import { iconButton } from "./icon-button";

// --- SPELL --------------------------------------------------------------

export function buildSpell(c: DeviceWindowContext, d: Device): void {
  const spell = d.spell;
  const sec = c.section("SPELL", "device.spell");
  const toggle = iconButton(sec.head, {
    text: spell === undefined ? "off · every matching day" : "on · random runs",
    label: "Spell",
    hint: deviceHint("device.spell"),
    cls: "wadjet-studio-device-toggle",
    onClick: () => c.mutate((x) => setSpell(x, spell === undefined ? defaultSpell(c.calendar()) : undefined), true),
  });
  toggle.setAttrs({ "data-part": "spell-power", "aria-pressed": spell === undefined ? "false" : "true" });
  if (spell === undefined) {
    sec.content.remove();
    return;
  }

  const knobs = sec.content.createDiv({ cls: "wadjet-studio-device-knobs" });
  c.knob(knobs, {
    part: "spell-starts",
    label: "starts / yr",
    ...SPELL_STARTS_RANGE,
    value: spell.meanStartsPerYear,
    fmt: (v) => String(Number(v.toFixed(2))),
    color: "var(--wadjet-studio-gold)",
    hint: deviceHint("device.spell.starts"),
    onChange: (v, phase) => c.gesture(phase, (x) => setSpell(x, { meanStartsPerYear: v, meanDurationDays: x.spell?.meanDurationDays ?? spell.meanDurationDays })),
  });
  c.knob(knobs, {
    part: "spell-duration",
    label: "duration",
    ...SPELL_DURATION_RANGE,
    value: spell.meanDurationDays,
    fmt: (v) => `${v.toFixed(0)} d`,
    color: spell.meanDurationDays > LONG_SPELL_DAYS ? "var(--wadjet-studio-warn)" : "var(--wadjet-studio-temp)",
    hint: deviceHint("device.spell.duration", spell.meanDurationDays > LONG_SPELL_DAYS ? `${spell.meanDurationDays.toFixed(0)} days is longer than a season` : undefined),
    onChange: (v, phase) => c.gesture(phase, (x) => setSpell(x, { meanStartsPerYear: x.spell?.meanStartsPerYear ?? spell.meanStartsPerYear, meanDurationDays: v })),
  });
}
