/**
 * The SPELL section: the on/off toggle in the section head, and the two knobs
 * that describe a run when it is on (SPEC §5).
 *
 * The spell path (`when.kind === "yearWindow"`) wears it differently: the
 * prototype draws the two dials uncaptioned at the very top of the body, 42 px
 * across, spaced apart (`0905-vst-ashfall.html` l.12-15). It draws no toggle at
 * all — its Ashfall always runs, and the only lamp on that window is the
 * chrome's own power LED (`1397-logic-class-Component.js` l.1275, `afLed`). The
 * toggle is still the one way to take a spell off a device, so it stays, at the
 * end of that row rather than over a caption that is gone.
 */
import { defaultSpell, setSpell } from "../../../model/device-edit";
import { type Device, SPELL_DURATION_RANGE, SPELL_STARTS_RANGE } from "../../../model/devices";
import { deviceHint } from "../../../model/hints-device";
import { LONG_SPELL_DAYS } from "./constants";
import type { DeviceWindowContext } from "./context";
import { iconButton } from "./icon-button";

// --- SPELL --------------------------------------------------------------

export function buildSpell(c: DeviceWindowContext, d: Device, bare = false): void {
  const spell = d.spell;
  if (bare) {
    // `data-spell` is what lets the stylesheet take the toggle out of flow
    // when there are dials to space around, and leave it in flow when the row
    // is only the toggle.
    const row = c.body.createDiv({ cls: "wadjet-studio-device-spell", attr: { "data-section": "spell", "data-spell": spell === undefined ? "off" : "on" } });
    // 42 px in the prototype; `lg` is the studio's 44, and two pixels of dial
    // are not worth a fourth knob size.
    if (spell !== undefined) knobs(c, row, spell, true);
    toggle(c, row, spell);
    return;
  }

  const sec = c.section("SPELL", "device.spell");
  toggle(c, sec.head, spell);
  if (spell === undefined) {
    sec.content.remove();
    return;
  }
  knobs(c, sec.content.createDiv({ cls: "wadjet-studio-device-knobs" }), spell, false);
}

/** `on · random runs` / `off · every matching day` — the one control that adds or drops a spell. */
function toggle(c: DeviceWindowContext, parent: HTMLElement, spell: Device["spell"]): void {
  const el = iconButton(parent, {
    text: spell === undefined ? "off · every matching day" : "on · random runs",
    label: "Spell",
    hint: deviceHint("device.spell"),
    cls: "wadjet-studio-device-toggle",
    onClick: () => c.mutate((x) => setSpell(x, spell === undefined ? defaultSpell(c.calendar()) : undefined), true),
  });
  el.setAttrs({ "data-part": "spell-power", "aria-pressed": spell === undefined ? "false" : "true" });
}

function knobs(c: DeviceWindowContext, parent: HTMLElement, spell: NonNullable<Device["spell"]>, bare: boolean): void {
  c.knob(parent, {
    part: "spell-starts",
    label: "starts / yr",
    ...SPELL_STARTS_RANGE,
    value: spell.meanStartsPerYear,
    // The readout is the bare number where the caption is drawn (`0905` l.13,
    // `devSpellStarts`): `starts / yr` above it already carries the unit. The
    // captioned SPELL section keeps the unit — its caption is the section's.
    fmt: (v) => (bare ? v.toFixed(1) : `${v.toFixed(1)} / yr`),
    color: "var(--wadjet-studio-gold)",
    ...(bare ? { size: "lg" as const } : {}),
    hint: deviceHint("device.spell.starts"),
    onChange: (v, phase) => c.gesture(phase, (x) => setSpell(x, { meanStartsPerYear: v, meanDurationDays: x.spell?.meanDurationDays ?? spell.meanDurationDays })),
  });
  c.knob(parent, {
    part: "spell-duration",
    label: "duration",
    ...SPELL_DURATION_RANGE,
    value: spell.meanDurationDays,
    fmt: (v) => `${v.toFixed(0)} d`,
    color: spell.meanDurationDays > LONG_SPELL_DAYS ? "var(--wadjet-studio-warn)" : "var(--wadjet-studio-temp)",
    ...(bare ? { size: "lg" as const } : {}),
    hint: deviceHint("device.spell.duration", spell.meanDurationDays > LONG_SPELL_DAYS ? `${spell.meanDurationDays.toFixed(0)} days is longer than a season` : undefined),
    onChange: (v, phase) => c.gesture(phase, (x) => setSpell(x, { meanStartsPerYear: x.spell?.meanStartsPerYear ?? spell.meanStartsPerYear, meanDurationDays: v })),
  });
}
