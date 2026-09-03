/**
 * The device window's drawing constants: the panel's own geometry, the two
 * prototype charts' boxes, and the per-kind / per-channel tables the header
 * badge and the op menu read. Nothing here reads state.
 */
import type { Channel } from "../../../model/compile";
import type { DeviceKind } from "../../../model/devices";

/** Year length to draw with when the active adapter does not describe itself (SPEC §8). */
export const DEFAULT_YEAR_LENGTH = 365;

/** Prototype width (`proto-markup/1095-vst-device.html`): a design constant, not a function of the content. */
export const PANEL_W = 372;

/** The year-window mini-lane, in SVG user units; the element is stretched to the panel by CSS. */
export const LANE_W = 240;
export const LANE_H = 10;

/** The moon gate disc (`proto-markup/0699-vst-stormtide.html`): an 88-unit box, a 34-unit face. */
export const DISC = 88;
export const DISC_C = 44;
export const DISC_R = 34;
export const DISC_FACE_R = 30;
export const HANDLE_R = 6;

/** The envelope chart, in CSS pixels. */
export const ENVELOPE_W = 316;
export const ENVELOPE_H = 84;

/** A spell longer than this earns an amber readout (SPEC §3.9). */
export const LONG_SPELL_DAYS = 50;

/** Envelope points keep this much phase between them, so a drag can never reorder them under itself. */
export const ENVELOPE_MIN_GAP = 0.005;
/** Phases are in [0, 1): the last drawable phase sits just short of the wrap. */
export const LAST_PHASE = 1 - ENVELOPE_MIN_GAP;

/** The KIND pill's text, per kind (the prototype's `DEV_KINDS.badge`). */
export const KIND_BADGE: Record<DeviceKind, string> = {
  trim: "TRIM",
  moon: "MOON",
  spell: "SPELL",
  tag: "TAG",
  chance: "DICE",
};

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
