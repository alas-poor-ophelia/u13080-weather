/**
 * WHEN · year window — the season-banded lane, the start/length knobs, and the
 * list of clips under it (SPEC §5).
 */
import type { CalendarDescription } from "../../../../plugin/time/adapter";
import { seasonAtPhase } from "../../../../plugin/time/seasons";
import { addYearWindow, removeYearWindow, setYearWindow } from "../../../model/device-edit";
import { type Device, yearWindowsOf } from "../../../model/devices";
import { dayRangeLabel } from "../../../model/format";
import { deviceHint } from "../../../model/hints-device";
import { BAND_TINT_ALPHA, SEASON_CYCLE, tintColour } from "../../../model/palette";
import type { DeviceWindowContext } from "./context";
import { seasonBands, windowSpans } from "./geometry";
import { iconButton } from "./icon-button";

// --- WHEN · year window -------------------------------------------------

export function buildYearWindow(c: DeviceWindowContext, parent: HTMLElement, d: Device, description: CalendarDescription | null, yearLength: number): void {
  const seasons = description?.seasons ?? [];
  const clips = yearWindowsOf(d.when);
  const at = Math.min(c.clipAt(), clips.length - 1);
  const chosen = clips[at] ?? { start: 0, length: 0 };

  parent.createDiv({ cls: "wadjet-studio-device-subhead", text: "WINDOWS · repeat yearly" });

  const top = parent.createDiv({ cls: "wadjet-studio-device-lane-row" });
  const lane = top.createDiv({ cls: "wadjet-studio-device-lane", attr: { "data-hint": deviceHint("device.when.lane") } });
  const stripe = lane.createDiv({ cls: "wadjet-studio-device-lane-stripe" });
  for (const band of seasonBands(seasons)) {
    const seg = stripe.createDiv({ cls: "wadjet-studio-device-band", attr: { "data-name": band.name } });
    seg.setCssProps({
      "--wadjet-studio-device-band-w": `${((band.to - band.from) * 100).toFixed(2)}%`,
      // The season's OWN hue (`SEASON_CYCLE`, so Thaw is green), composited
      // at the prototype's `tc + "55"` third rather than laid on at full
      // strength; the tint carries the whole alpha, the stylesheet adds none.
      "--wadjet-studio-device-band-color": tintColour(band.index, BAND_TINT_ALPHA, SEASON_CYCLE),
    });
  }
  // Positioned elements rather than SVG rects: the prototype's marker is a
  // 45 deg hatch (`1095` l.58), and a `repeating-linear-gradient` cannot fill
  // an SVG shape. The lane is percentage-addressed either way.
  const track = lane.createDiv({ cls: "wadjet-studio-device-track" });
  clips.forEach((clip, i) => {
    for (const [a, b] of windowSpans(clip.start, clip.length)) {
      const mark = track.createDiv({ cls: "wadjet-studio-device-clip", attr: { "data-clip": String(i), "data-selected": i === at ? "true" : "false" } });
      mark.setCssProps({ "--wadjet-studio-device-clip-left": `${(a * 100).toFixed(2)}%`, "--wadjet-studio-device-clip-w": `${((b - a) * 100).toFixed(2)}%` });
    }
  });

  const knobs = top.createDiv({ cls: "wadjet-studio-device-knobs" });
  c.knob(knobs, {
    part: "when-start",
    label: "start",
    min: 0,
    max: 1,
    step: 1 / yearLength,
    value: chosen.start,
    fmt: (v) => `d${Math.round(v * yearLength)} · ${seasonAtPhase(seasons, ((v % 1) + 1) % 1) ?? "—"}`,
    color: "var(--wadjet-studio-gold)",
    hint: deviceHint("device.when.start"),
    onChange: (v, phase) => c.gesture(phase, (x) => setYearWindow(x, at, { start: v, length: yearWindowsOf(x.when)[at]?.length ?? chosen.length })),
  });
  c.knob(knobs, {
    part: "when-length",
    label: "length",
    min: 1 / yearLength,
    max: 0.6,
    step: 1 / yearLength,
    value: chosen.length,
    fmt: (v) => `${Math.round(v * yearLength)} d`,
    color: "var(--wadjet-studio-gold)",
    hint: deviceHint("device.when.length"),
    onChange: (v, phase) => c.gesture(phase, (x) => setYearWindow(x, at, { start: yearWindowsOf(x.when)[at]?.start ?? chosen.start, length: v })),
  });

  const rows = parent.createDiv({ cls: "wadjet-studio-device-clips" });
  clips.forEach((clip, i) => {
    const season = seasonAtPhase(seasons, (((clip.start + clip.length / 2) % 1) + 1) % 1);
    const row = rows.createDiv({ cls: "wadjet-studio-device-clip-row", attr: { "data-clip": String(i), "data-selected": i === at ? "true" : "false", "data-hint": deviceHint("device.when.lane") } });
    row.createDiv({ cls: "wadjet-studio-device-clip-swatch" });
    row.createSpan({ cls: "wadjet-studio-device-clip-label", text: dayRangeLabel(clip.start, clip.length, yearLength) });
    row.createSpan({ cls: "wadjet-studio-device-clip-dur", text: `${Math.round(clip.length * yearLength)} d${season === null ? "" : ` · ${season}`}` });
    row.createDiv({ cls: "wadjet-studio-device-spacer" });
    row.addEventListener("click", () => {
      if (c.clipAt() === i) return;
      c.setClipAt(i);
      c.invalidate();
    });
    if (clips.length > 1) {
      iconButton(row, {
        text: "×",
        label: `Remove window ${i + 1}`,
        hint: deviceHint("device.when.window.remove"),
        cls: "wadjet-studio-device-remove",
        onClick: () => {
          c.setClipAt(0);
          c.mutate((x) => void removeYearWindow(x, i), true);
        },
      });
    }
  });
  iconButton(rows, {
    text: "＋ add window",
    label: "Add a window",
    hint: deviceHint("device.when.window.add"),
    cls: "wadjet-studio-device-wide",
    onClick: () => c.mutate((x) => void addYearWindow(x), true),
  });
}
