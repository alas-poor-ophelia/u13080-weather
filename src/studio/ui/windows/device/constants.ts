/**
 * The device window's drawing constants: the panel's own geometry, the two
 * prototype charts' boxes, and the per-kind / per-channel tables the header
 * badge and the op menu read. Nothing here reads state.
 */
import type { Channel } from "../../../model/compile";

/** Year length to draw with when the active adapter does not describe itself (SPEC §8). */
export const DEFAULT_YEAR_LENGTH = 365;

/** Prototype width (`proto-markup/1095-vst-device.html`): a design constant, not a function of the content. */
export const PANEL_W = 372;

/**
 * The spell path is narrower (`0905-vst-ashfall.html` l.2): its body is two
 * dials, a lane and an apply row, and the prototype draws it 320 wide. Per-kind
 * widths are what PLAN.md D16 allows — the chrome is shared, the box is not.
 */
export const PANEL_W_SPELL = 320;

/**
 * The tag path is narrower still (`1213-vst-neverain.html` l.2): the prototype
 * draws Neverain 300 wide around a body that is one summary line. Same licence
 * as the spell width above — the chrome is shared, the box is not (PLAN D16).
 */
export const PANEL_W_TAG = 300;

/** The moon gate disc (`proto-markup/0699-vst-stormtide.html`): an 88-unit box, a 34-unit face. */
export const DISC = 88;
export const DISC_C = 44;
export const DISC_R = 34;
export const DISC_FACE_R = 30;
export const HANDLE_R = 6;

/** The envelope chart, in CSS pixels. */
export const ENVELOPE_W = 316;
export const ENVELOPE_H = 84;

/**
 * The moon path's envelope OVERLAY plot (`0699-vst-stormtide.html` l.85-86): a
 * 344 × 98 box around a 310 × 70 plot at x 20, y 8. The four insets are the
 * chart's `pad`, and `styles.css` draws the plot's own panel at the same
 * numbers — the two must stay in step.
 */
export const ENV_W = 344;
export const ENV_H = 98;
export const ENV_PAD = { left: 20, right: 14, top: 8, bottom: 20 } as const;
/** The overlay plots the ONSET, not the whole cycle: 0.70 to full (`envEditor`'s `ex`). */
export const ENV_X0 = 0.7;

/** A spell longer than this earns an amber readout (SPEC §3.9). */
export const LONG_SPELL_DAYS = 50;

/** Envelope points keep this much phase between them, so a drag can never reorder them under itself. */
export const ENVELOPE_MIN_GAP = 0.005;
/** Phases are in [0, 1): the last drawable phase sits just short of the wrap. */
export const LAST_PHASE = 1 - ENVELOPE_MIN_GAP;

/**
 * The KIND pill's text, per kind. It lives in `model/devices.ts` beside
 * `badgeFor`, which reads `CURSE` off the modifier's own display flag rather
 * than its kind; re-exported here so the window's constants still read as one set.
 */
export { KIND_BADGE } from "../../../model/devices";

export const CHANNEL_COLOUR: Record<Channel, string> = {
  temperature: "var(--wadjet-studio-temp)",
  precipitation: "var(--wadjet-studio-precip)",
  wind: "var(--wadjet-studio-wind)",
  sky: "var(--wadjet-studio-sky)",
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  temperature: "Temperature",
  precipitation: "Precipitation",
  wind: "Wind",
  sky: "Sky",
};
