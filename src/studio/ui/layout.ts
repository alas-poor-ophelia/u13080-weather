/**
 * The studio's shell: the empty boxes every surface is mounted into
 * (PLAN §4, SPEC §3.1–§3.7). This file builds structure and nothing else —
 * no data, no store, no listeners. The surfaces (header, playlist, mixer,
 * audition, JSON drawer) are separate beads that fill these slots.
 *
 * Geometry lives in `styles.css`; the only number duplicated here is
 * `LABEL_WIDTH`, because the playlist's lane maths needs it in JS and CSS at
 * the same value. Chrome is graphite only (SPEC §9): no channel colour is
 * ever set on the shell.
 */

/** The playlist's label column, in px. Must equal `--wadjet-studio-label-w`. */
export const LABEL_WIDTH = 136;

/**
 * The axis gutter between the label column and the lane body, in px. Must
 * equal `--wadjet-studio-axis-w`.
 *
 * SPEC §3.2 puts the channel rows' y-axis values (`15° 10° 5° 0°`, `.5`) at
 * the left of the plot. They are a *column*, not part of the plot: making the
 * gutter its own flex cell keeps the lane body — and therefore every lane
 * span, every tick and every measured width — on exactly the pixels it was on
 * before, so the playlist's geometry contracts do not move.
 */
export const AXIS_WIDTH = 44;

/**
 * One playlist row: a fixed label column (a name line and a live sub-label),
 * an axis gutter, and the body its lane draws into.
 */
export interface Row {
  el: HTMLElement;
  label: HTMLElement;
  /** the label's colour swatch — a lane's LED (SPEC §3.2) */
  dot: HTMLElement;
  /** the label's first line */
  name: HTMLElement;
  /** the label's second line: a live readout of what the lane is showing */
  sub: HTMLElement;
  /** the y-axis column, empty unless the row draws one */
  axis: HTMLElement;
  body: HTMLElement;
}

export interface Shell {
  /** `position: relative` — the box floating windows clamp inside. */
  root: HTMLElement;
  header: HTMLElement;
  /** Zone name and its badges (bead wadjet-9f9.16). */
  headerZone: HTMLElement;
  /** Right-hand side of the header: window readout, transport, zoom, JSON, Save. */
  headerTools: HTMLElement;
  hintBar: HTMLElement;
  /** The 5 px leading marker: gold while a hint is up, graphite at rest. */
  hintDot: HTMLElement;
  hintName: HTMLElement;
  hintDetail: HTMLElement;
  main: HTMLElement;
  /** Scrolls vertically; the ruler is `position: sticky` inside it. */
  playlist: HTMLElement;
  ruler: HTMLElement;
  rulerLabel: HTMLElement;
  /** The ruler's timeline area — the same width every lane body gets. */
  rulerTicks: HTMLElement;
  /** Parent for the playlist rows. */
  lanes: HTMLElement;
  /** The right rail; scrolls independently of the playlist. */
  mixer: HTMLElement;
  audition: HTMLElement;
  auditionBody: HTMLElement;
  /** Where the audition's Writes footer is mounted. */
  auditionFoot: HTMLElement;
  /** Hidden unless `view.jsonOpen`. */
  json: HTMLElement;
  /** Absolute overlay with real dimensions — `createWindow` clamps to it. */
  windows: HTMLElement;
}

export function buildShell(container: HTMLElement): Shell {
  const root = container.createDiv({ cls: "wadjet-studio" });

  const header = root.createDiv({ cls: "wadjet-studio-header" });
  const headerZone = header.createDiv({ cls: "wadjet-studio-header-zone" });
  header.createDiv({ cls: "wadjet-studio-header-spacer" });
  const headerTools = header.createDiv({ cls: "wadjet-studio-header-tools" });

  // aria-live (bead wadjet-9f9.43): the bar's text changes on hover/focus,
  // never on its own, so "polite" queues the announcement rather than
  // interrupting whatever the screen reader is already reading.
  const hintBar = root.createDiv({ cls: "wadjet-studio-hintbar", attr: { "aria-live": "polite" } });
  const hintDot = hintBar.createSpan({ cls: "wadjet-studio-hintbar-dot", attr: { "aria-hidden": "true" } });
  const hintName = hintBar.createSpan({ cls: "wadjet-studio-hintbar-name" });
  const hintDetail = hintBar.createSpan({ cls: "wadjet-studio-hintbar-detail" });

  const main = root.createDiv({ cls: "wadjet-studio-main" });
  const playlist = main.createDiv({ cls: "wadjet-studio-playlist" });
  const ruler = playlist.createDiv({ cls: "wadjet-studio-ruler" });
  const rulerLabel = ruler.createDiv({ cls: "wadjet-studio-ruler-label" });
  ruler.createDiv({ cls: "wadjet-studio-row-axis" });
  const rulerTicks = ruler.createDiv({ cls: "wadjet-studio-ruler-ticks" });
  const lanes = playlist.createDiv({ cls: "wadjet-studio-lanes" });
  const mixer = main.createDiv({ cls: "wadjet-studio-mixer" });

  // The drawer sits BETWEEN the playlist and the audition strip (SPEC §3.5
  // "bottom, pinned"; gap-shell §18): opening it must not unpin the strip.
  const json = root.createDiv({ cls: "wadjet-studio-json" });

  const audition = root.createDiv({ cls: "wadjet-studio-audition" });
  const auditionBody = audition.createDiv({ cls: "wadjet-studio-audition-body" });
  const auditionFoot = audition.createDiv({ cls: "wadjet-studio-audition-foot" });

  const windows = root.createDiv({ cls: "wadjet-studio-windows" });

  return { root, header, headerZone, headerTools, hintBar, hintDot, hintName, hintDetail, main, playlist, ruler, rulerLabel, rulerTicks, lanes, mixer, audition, auditionBody, auditionFoot, json, windows };
}

/** Append a playlist row. The body is the lane's parent and its measuring box. */
export function createRow(lanes: HTMLElement, label: string): Row {
  const el = lanes.createDiv({ cls: "wadjet-studio-row" });
  const labelEl = el.createDiv({ cls: "wadjet-studio-row-label" });
  const head = labelEl.createDiv({ cls: "wadjet-studio-row-label-head" });
  const dot = head.createSpan({ cls: "wadjet-studio-row-dot" });
  const name = head.createSpan({ cls: "wadjet-studio-row-name", text: label });
  const sub = labelEl.createSpan({ cls: "wadjet-studio-row-sub" });
  const axis = el.createDiv({ cls: "wadjet-studio-row-axis" });
  const body = el.createDiv({ cls: "wadjet-studio-row-body" });
  return { el, label: labelEl, dot, name, sub, axis, body };
}

/**
 * The hint bar's one job: `● name  detail` (SPEC §3.1). The name never
 * truncates; the detail ellipsizes with the full text in the native title.
 * `live` lights the marker — gold while the pointer is on something hinted,
 * graphite when the bar is showing its resting default.
 */
export function setHint(shell: Shell, name: string, detail: string, live: boolean): void {
  shell.hintDot.toggleClass("is-live", live);
  shell.hintName.setText(name);
  shell.hintDetail.setText(detail);
  shell.hintBar.setAttr("title", detail === "" ? name : `${name} — ${detail}`);
}
