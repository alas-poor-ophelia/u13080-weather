/**
 * The Atlas window (SPEC §3.4 "Atlas · STATION", PLAN §5.4).
 *
 * The zone's *source*, in two modes behind one Segmented, over one shared map:
 *
 *   STATION    every shipped station as a dot in Köppen climate space, the
 *              list beside it by STATION NAME, a record card for the one
 *              selected with its year of temperature against the zone's
 *              current base, and `Re-base zone → X`.
 *   GEOGRAPHY  a place rather than a station: the zone dot dragged ↕ latitude
 *              ↔ terrain across the same map, knobs for latitude / altitude /
 *              continentality, and the closest match Tier A picks for it —
 *              live, as the knobs move — behind `Match by geography → X`.
 *
 * Four things worth knowing before editing this file:
 *
 *  - **Every rule about what a re-base or a match writes lives in
 *    `model/atlas.ts`**, not here (PLAN D3). This file is the map, the list,
 *    the knobs and two buttons; the two buttons call one pure function each
 *    and put the result in the draft under `history: true`.
 *  - **Geography mode is a scratchpad until the button is pressed.** The knobs
 *    and the map move a *window-local* `Geography`, not the draft, so the
 *    closest-match card can follow a drag without the zone's source flickering
 *    between stations on the way. It is seeded from `zone.geography` (or, when
 *    the zone has none, from the station it is currently based on) and
 *    re-seeded whenever the studio is pointed at another zone.
 *  - **The KIND badge follows `mode`, which is not store state.** `mode` is a
 *    window-local toggle (like `Geography` below); `WindowBuild.badge`/`level`
 *    (`windows.ts`, wadjet-9f9.35) are only re-pulled on a store tick, so they
 *    cannot follow a change that never touches the store. The badge is
 *    therefore still written directly from this body's own `repaint()`, found
 *    from this body's own panel ancestor — the one place the panel's chrome is
 *    touched from a body. `level` (SPEC §3.9, `flipSeasons`) *is* store state,
 *    so it uses the shared mechanism like every other window.
 *  - **The map and the two sparks are drawn here, not by Chart.** Both need
 *    marks Chart does not carry — soft climate blobs with their own labels, a
 *    per-dot name, a dashed comparison curve and a 0 °C guide — and neither is
 *    reusable anywhere else in the studio, so the component bin stays closed
 *    at nine (SPEC §0 law 3). All geometry is the prototype's, in its own
 *    480 × 380 and 196 × 50 user spaces; `model/atlas.ts` computes the
 *    positions, this file only draws them.
 *
 * Continentality carries an *unset* state, mirroring `AddZoneModal`'s "adjust
 * the seasonal swing" toggle: off omits the axis from `Geography` entirely,
 * which both drops it from the match distance and keeps the matched station's
 * own seasonal swing (`core/types.ts`, `Geography.continentality`).
 */
import { Notice } from "obsidian";
import type { Geography, Orographic, Preset, ZoneProfile } from "../../../core/types";
import type { Units } from "../../../core/units";
import {
  adjustedSpark,
  climateSpace,
  CLIMATE_BLOBS,
  latitudeBaselineC,
  latitudeForBaselineC,
  matchByGeography,
  matchParts,
  presetOf,
  previewMatch,
  rebase,
  SPACE_H,
  SPACE_UNITS_PER_C,
  SPACE_W,
  spaceXForTerrain,
  sparkOf,
  stationDescription,
  stationOf,
  stations,
  terrainForSpaceX,
  tierAAdjustment,
  zonePoint,
  type KoppenGroup,
  type Station,
} from "../../model/atlas";
import { grammar } from "../../model/copy";
import { format, unitLabel } from "../../model/format";
import { atlasHint } from "../../model/hints-atlas";
import type { StudioState } from "../../model/state";
import { ledLevel, unitKey } from "../../model/validation";
import { createSegmented, type SegmentedComponent } from "../components";
import { createKnob, type KnobComponent } from "../components/knob";
import { beginDrag, markDragTarget } from "../pointer";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";

/** The id the Atlas panel is opened under — the same constant `header.ts`'s SRC chip opens. */
export const ATLAS_WINDOW = "atlas";

type Mode = "station" | "geography";

/** SPEC §3.4: latitude −90…90, altitude 0…5000 m, continentality 0…1. */
const LATITUDE_SPEC = { min: -90, max: 90, step: 1, neutral: 0 } as const;
const ALTITUDE_SPEC = { min: 0, max: 5000, step: 10 } as const;
const CONTINENTALITY_SPEC = { min: 0, max: 1, step: 0.05 } as const;

/** The spark's own user space (`proto-markup/1267-vst-atlas.html`): 196 × 50, 0 °C at 26.6. */
const SPARK_W = 196;
const SPARK_H = 50;
const SPARK_ZERO_Y = 26.6;
/** −30 °C at the floor, +35 °C at the ceiling — the prototype's fixed scale, so two sparks compare. */
const SPARK_MIN_C = -30;
const SPARK_SPAN_C = 65;

/** The three terrain columns the map's x axis is, driest first. */
const TERRAIN: readonly Orographic[] = ["leeward", "none", "windward"];

/** `AddZoneModal`'s defaults, for a zone that has never been described as a place. */
const DEFAULT_GEOGRAPHY: Geography = { latitude: 45, altitude: 200, orographic: "none" };
const DEFAULT_CONTINENTALITY = 0.5;

/** The palette a Köppen group carries, on its blob, its dots and its rows (SPEC §9). */
const GROUP_COLOR: Record<KoppenGroup, string> = {
  A: "var(--wadjet-studio-wind)",
  B: "var(--wadjet-studio-temp)",
  C: "var(--wadjet-studio-precip)",
  D: "var(--wadjet-studio-moon)",
  E: "var(--wadjet-studio-moon)",
};

/** The prototype's terrain words: `open` for none, the slope names otherwise. */
function terrainLabel(o: Orographic): string {
  return o === "windward" ? "windward" : o === "leeward" ? "leeward" : "open";
}

/**
 * `60.4°` / `−35.0°` — degrees of latitude, real minus, no unit table needed.
 * One decimal, like the prototype; the hemisphere stays in the sign rather
 * than becoming an `N`/`S` suffix, so the knob's typed entry still reads back
 * what it printed.
 */
function latitudeText(v: number): string {
  return `${format(v, "count", "metric", { digits: 1 }).text}°`;
}

/**
 * `1 240 m` — metres above sea level. `core/units.ts` has no elevation table,
 * so this is metric on both settings; the station card quotes the dataset's
 * own `elevationM` the same way.
 */
function altitudeText(v: number): string {
  return `${format(v, "count", "metric").text} m`;
}

/** `0.10 coast` / `0.90 interior` — the prototype's reading of the axis. */
function continentalityText(v: number, units: Units): string {
  const n = format(v, "fraction", units).text;
  return v < 0.25 ? `${n} coast` : v > 0.7 ? `${n} interior` : n;
}

/** `2° … 14 °C` — the one number pair that says what a station is. */
function rangeText(min: number, max: number, units: Units): string {
  const lo = format(min, "temperature", units, { digits: 0 });
  const hi = format(max, "temperature", units, { digits: 0 });
  return `${lo.text}° … ${hi.text} ${hi.unit}`;
}

/** A body button — a real button for the keyboard, hinted like everything else. */
function actionButton(parent: HTMLElement, o: { hint: string; part: string; text?: string; onClick: () => void }): HTMLElement {
  const el = parent.createDiv({
    cls: "wadjet-studio-atlas-action",
    attr: { role: "button", tabindex: "0", "data-hint": o.hint, "data-part": o.part },
  });
  if (o.text !== undefined) el.setText(o.text);
  el.addEventListener("click", () => {
    if (!el.hasClass("is-disabled")) o.onClick();
  });
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (!el.hasClass("is-disabled")) o.onClick();
  });
  return el;
}

/** Twelve monthly means as a polyline in the spark's own 196 × 50 space. */
function sparkPoints(values: number[]): string {
  return values
    .map((v, i) => {
      const x = ((i + 0.5) / values.length) * SPARK_W;
      const y = SPARK_H - 4 - ((v - SPARK_MIN_C) / SPARK_SPAN_C) * (SPARK_H - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export const buildAtlasWindow: WindowBuilder = (ctx: SurfaceContext): WindowBuild => {
  let unsubscribe: (() => void) | null = null;

  let mode: Mode = "station";
  let selected: string | null = null;
  /** the working place, seeded from the zone; only the button writes it */
  let geo: Geography = { ...DEFAULT_GEOGRAPHY };
  let continentality = DEFAULT_CONTINENTALITY;
  let useContinentality = false;
  /** the zone the scratchpad above was seeded from */
  let seededFrom: string | null = null;
  /** the mode the WRITES footer was last pulled for; see `repaint` */
  let footedMode: string | null = null;
  let listSignature = "";

  function zone(state: StudioState = ctx.store.get()): ZoneProfile | null {
    const id = state.view.zoneId;
    return id !== null ? (state.zones[id] ?? null) : null;
  }

  /** The place as the match sees it: continentality is an axis only while it is on. */
  function place(): Geography {
    return useContinentality ? { ...geo, continentality } : { ...geo };
  }

  /** The station the zone currently sits on — the `base` chip and the dashed spark. */
  function baseStation(z: ZoneProfile | null): Station | null {
    const id = z?.preset?.id;
    return id === undefined ? null : stationOf(id);
  }

  /**
   * Point the scratchpad and the selection at `z`. A zone described as a place
   * brings its own geography; one that is not is read from the station it sits
   * on, so the map opens where the zone actually is rather than at a default.
   */
  function seed(z: ZoneProfile | null): void {
    seededFrom = z?.id ?? null;
    selected = z?.preset?.id ?? null;
    const g = z?.geography;
    if (g !== undefined) {
      geo = { latitude: g.latitude, altitude: g.altitude, orographic: g.orographic };
      useContinentality = g.continentality !== undefined;
      continentality = g.continentality ?? DEFAULT_CONTINENTALITY;
      return;
    }
    const station = selected === null ? null : stationOf(selected);
    geo = station === null ? { ...DEFAULT_GEOGRAPHY } : { latitude: station.latitude, altitude: station.altitude, orographic: station.orographic };
    useContinentality = false;
    continentality = DEFAULT_CONTINENTALITY;
  }

  // --- the body: the map on the left, the controls on the right -------------

  const root = createDiv({ cls: "wadjet-studio-atlas" });

  const mapBox = root.createDiv({ cls: "wadjet-studio-atlas-mapbox", attr: { "data-hint": atlasHint("atlas.map"), "data-part": "atlas-map" } });
  const mapSvg = mapBox.createSvg("svg", { cls: "wadjet-studio-atlas-map", attr: { viewBox: `0 0 ${SPACE_W} ${SPACE_H}`, preserveAspectRatio: "xMidYMid meet" } });
  markDragTarget(mapBox);

  const side = root.createDiv({ cls: "wadjet-studio-atlas-side" });

  const modeRow = side.createDiv({ cls: "wadjet-studio-atlas-moderow" });
  const modeSeg: SegmentedComponent = createSegmented(modeRow, {
    options: [
      { value: "station", label: "Station", hint: atlasHint("atlas.mode") },
      { value: "geography", label: "Geography", hint: atlasHint("atlas.mode") },
    ],
    value: mode,
    onChange: (value) => {
      mode = value === "geography" ? "geography" : "station";
      repaint();
    },
  });
  modeSeg.el.setAttr("data-part", "atlas-mode");

  // --- station mode ---------------------------------------------------------

  const stationPane = side.createDiv({ cls: "wadjet-studio-atlas-pane" });
  const list = stationPane.createDiv({ cls: "wadjet-studio-atlas-list", attr: { role: "listbox", "data-part": "atlas-list" } });

  const card = stationPane.createDiv({ cls: "wadjet-studio-atlas-card", attr: { "data-hint": atlasHint("atlas.card"), "data-part": "atlas-card" } });
  const cardHead = card.createDiv({ cls: "wadjet-studio-atlas-cardhead" });
  const cardName = cardHead.createSpan({ cls: "wadjet-studio-atlas-cardname", attr: { "data-part": "atlas-card-name" } });
  const cardKoppen = cardHead.createSpan({ cls: "wadjet-studio-atlas-koppen" });
  const cardStats = card.createDiv({ cls: "wadjet-studio-atlas-cardstats" });
  const cardText = card.createDiv({ cls: "wadjet-studio-atlas-cardtext" });
  const cardSpark = card.createSvg("svg", { cls: "wadjet-studio-atlas-spark", attr: { viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: "none", "data-hint": atlasHint("atlas.spark"), "data-part": "atlas-spark" } });
  const cardSparkLabel = card.createDiv({ cls: "wadjet-studio-atlas-sparklabel" });

  stationPane.createDiv({ cls: "wadjet-studio-atlas-fill" });
  const stationActions = stationPane.createDiv({ cls: "wadjet-studio-atlas-actions" });
  actionButton(stationActions, { hint: atlasHint("atlas.close"), part: "atlas-close", text: "Close", onClick: () => ctx.windows.close(ATLAS_WINDOW) });
  const rebaseBtn = actionButton(stationActions, { hint: atlasHint("atlas.rebase"), part: "atlas-rebase", onClick: () => doRebase() });
  rebaseBtn.addClass("is-primary");

  // --- geography mode -------------------------------------------------------

  const geoPane = side.createDiv({ cls: "wadjet-studio-atlas-pane" });

  const knobRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-knobs" });
  const latitude: KnobComponent = createKnob(knobRow, {
    spec: LATITUDE_SPEC,
    value: geo.latitude,
    label: "latitude",
    size: "lg",
    color: "var(--wadjet-studio-temp)",
    hint: atlasHint("atlas.latitude"),
    fmt: latitudeText,
    onChange: (value) => {
      geo = { ...geo, latitude: value };
      repaint();
    },
  });
  latitude.el.setAttr("data-part", "atlas-latitude");

  const altitude: KnobComponent = createKnob(knobRow, {
    spec: ALTITUDE_SPEC,
    value: geo.altitude,
    label: "altitude",
    size: "lg",
    color: "var(--wadjet-studio-moon)",
    hint: atlasHint("atlas.altitude"),
    fmt: altitudeText,
    onChange: (value) => {
      geo = { ...geo, altitude: value };
      repaint();
    },
  });
  altitude.el.setAttr("data-part", "atlas-altitude");

  const continental: KnobComponent = createKnob(knobRow, {
    spec: CONTINENTALITY_SPEC,
    value: continentality,
    label: "continentality",
    size: "lg",
    color: "var(--wadjet-studio-gold)",
    hint: atlasHint("atlas.continentality"),
    fmt: (v) => continentalityText(v, ctx.units()),
    disabled: true,
    onChange: (value) => {
      continentality = value;
      repaint();
    },
  });
  continental.el.setAttr("data-part", "atlas-continentality");

  const terrainRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-row" });
  terrainRow.createSpan({ cls: "wadjet-studio-atlas-rowlabel", text: "terrain" });
  const terrainSeg: SegmentedComponent = createSegmented(terrainRow, {
    options: TERRAIN.map((o) => ({ value: o, label: terrainLabel(o), hint: atlasHint("atlas.terrain") })),
    value: geo.orographic,
    onChange: (value) => {
      const picked = TERRAIN.find((o) => o === value) ?? "none";
      geo = { ...geo, orographic: picked };
      repaint();
    },
  });
  terrainSeg.el.setAttr("data-part", "atlas-terrain");

  const swingRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-row" });
  swingRow.createSpan({ cls: "wadjet-studio-atlas-rowlabel", text: "swing" });
  const swingSeg: SegmentedComponent = createSegmented(swingRow, {
    options: [
      { value: "station", label: "station's own", hint: atlasHint("atlas.swing") },
      { value: "adjust", label: "adjust", hint: atlasHint("atlas.swing") },
    ],
    value: "station",
    onChange: (value) => {
      useContinentality = value === "adjust";
      repaint();
    },
  });
  swingSeg.el.setAttr("data-part", "atlas-swing");

  const matchCard = geoPane.createDiv({ cls: "wadjet-studio-atlas-match", attr: { "data-hint": atlasHint("atlas.match"), "data-part": "atlas-match" } });
  const matchHead = matchCard.createDiv({ cls: "wadjet-studio-atlas-cardhead" });
  matchHead.createSpan({ cls: "wadjet-studio-atlas-rowlabel", text: "closest match" });
  const matchName = matchHead.createSpan({ cls: "wadjet-studio-atlas-cardname", attr: { "data-part": "atlas-match-name" } });
  const matchKoppen = matchHead.createSpan({ cls: "wadjet-studio-atlas-koppen" });
  matchHead.createDiv({ cls: "wadjet-studio-atlas-fill" });
  const matchDistance = matchHead.createSpan({ cls: "wadjet-studio-atlas-matchdistance", attr: { "data-part": "atlas-match-distance" } });
  const matchText = matchCard.createDiv({ cls: "wadjet-studio-atlas-matchtext", attr: { "data-part": "atlas-match-text" } });
  const matchSpark = matchCard.createSvg("svg", { cls: "wadjet-studio-atlas-spark", attr: { viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: "none" } });
  const matchSparkLabel = matchCard.createDiv({ cls: "wadjet-studio-atlas-sparklabel" });

  geoPane.createDiv({ cls: "wadjet-studio-atlas-fill" });
  const geoActions = geoPane.createDiv({ cls: "wadjet-studio-atlas-actions" });
  actionButton(geoActions, { hint: atlasHint("atlas.close"), part: "atlas-geo-close", text: "Close", onClick: () => ctx.windows.close(ATLAS_WINDOW) });
  const matchBtn = actionButton(geoActions, { hint: atlasHint("atlas.matchbtn"), part: "atlas-matchbtn", onClick: () => doMatch() });
  matchBtn.addClass("is-primary");

  // --- the two writes -------------------------------------------------------

  /** Replace the pointed-at draft with `next`. One discrete, undoable action. */
  function commit(next: ZoneProfile): void {
    ctx.store.update(
      (s) => {
        const id = s.view.zoneId;
        if (id !== null && s.zones[id] !== undefined) s.zones[id] = next;
      },
      { history: true },
    );
  }

  function doRebase(): void {
    const z = zone();
    if (z === null || selected === null || presetOf(selected) === null) return;
    const result = rebase(z, selected);
    commit(result.zone);
    new Notice(result.provenance, 8000);
  }

  function doMatch(): void {
    const z = zone();
    if (z === null) return;
    const result = matchByGeography(z, place());
    commit(result.zone);
    new Notice(result.provenance, 8000);
    if (result.flipped) new Notice("Seasons flipped for this zone (southern hemisphere match)", 8000);
  }

  // --- the map --------------------------------------------------------------

  /**
   * Drag the zone dot: ↕ moves it through temperature, which is a latitude,
   * and ↔ moves it between the terrain columns. Landing on the map in Station
   * mode adopts the selected station's place first, so the drag starts from
   * where the dot already is (the prototype's `atlasDotDown`).
   */
  function onMapDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const box = mapSvg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const scale = SPACE_W / box.width;
    if (mode !== "geography") {
      const station = selected === null ? null : stationOf(selected);
      if (station !== null) {
        geo = { latitude: station.latitude, altitude: station.altitude, orographic: station.orographic };
        useContinentality = false;
        continentality = station.continentality;
      }
      mode = "geography";
    }
    const startLat = geo.latitude;
    const south = startLat < 0;
    const baseC = latitudeBaselineC(startLat);
    const startX = spaceXForTerrain(geo.orographic);
    ev.preventDefault();
    beginDrag(ev, {
      capture: mapSvg,
      onMove: (_e, dx, dy) => {
        const wantC = baseC - (dy * scale) / SPACE_UNITS_PER_C;
        const lat = Number(latitudeForBaselineC(wantC, south).toFixed(1));
        geo = { ...geo, latitude: Math.max(-90, Math.min(90, lat)), orographic: terrainForSpaceX(startX + dx * scale) };
        repaint();
      },
    });
    repaint();
  }

  mapBox.addEventListener("pointerdown", onMapDown);

  function paintMap(): void {
    mapSvg.empty();
    for (const b of CLIMATE_BLOBS) {
      // `cls` must be an array here: createSvg hands a bare string straight to
      // classList.add, which rejects anything with a space in it.
      mapSvg.createSvg("ellipse", { cls: ["wadjet-studio-atlas-blob", `is-group-${b.group.toLowerCase()}`], attr: { cx: b.cx, cy: b.cy, rx: b.rx, ry: b.ry } });
    }
    for (const b of CLIMATE_BLOBS) {
      const color = b.group === "D-E" ? GROUP_COLOR.D : GROUP_COLOR[b.group];
      mapSvg.createSvg("text", { cls: "wadjet-studio-atlas-bloblabel", attr: { x: b.labelX, y: b.labelY, fill: color } }).setText(b.label);
    }

    const highlight = mode === "geography" ? (previewMatch(place())?.candidate.preset.id ?? null) : selected;
    // The map is the curated ten plus, when the panel is pointing at one of
    // the other sixteen, that station as a guest: what the panel is about is
    // never off the map (the list can reach every shipped station).
    const points = climateSpace(highlight);
    let zoneX = 0;
    let zoneY = 0;
    let linkTo: { x: number; y: number } | null = null;
    if (mode === "geography") {
      const p = zonePoint(place());
      if (p !== null) {
        zoneX = p.x;
        zoneY = p.y;
        // Only ever to a dot the map draws. The match is the highlight, so it
        // is on the map either way — curated or as the guest above.
        linkTo = points.some((q) => q.id === p.matchId) ? { x: p.matchX, y: p.matchY } : null;
      }
    } else {
      const at = points.find((p) => p.id === selected);
      zoneX = at?.x ?? 0;
      zoneY = at?.y ?? 0;
    }

    for (const p of points) {
      const on = p.id === highlight;
      const dot = mapSvg.createSvg("circle", {
        cls: "wadjet-studio-atlas-dot",
        attr: { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: on ? 7 : 4.5, fill: GROUP_COLOR[p.group], "data-id": p.id, "data-hint": atlasHint("atlas.station"), tabindex: "0", role: "button" },
      });
      dot.toggleClass("is-on", on);
      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selected = p.id;
        mode = "station";
        repaint();
      });
      mapSvg
        .createSvg("text", { cls: "wadjet-studio-atlas-dotlabel", attr: { x: p.labelX.toFixed(1), y: p.labelY.toFixed(1), "text-anchor": p.anchor } })
        .setText(p.name);
    }

    if (linkTo !== null) {
      mapSvg.createSvg("line", { cls: "wadjet-studio-atlas-link", attr: { x1: zoneX.toFixed(1), y1: zoneY.toFixed(1), x2: linkTo.x.toFixed(1), y2: linkTo.y.toFixed(1) } });
    }
    if (zoneX > 0 || zoneY > 0) {
      mapSvg.createSvg("circle", { cls: "wadjet-studio-atlas-zonering", attr: { cx: zoneX.toFixed(1), cy: zoneY.toFixed(1), r: 11 } });
      mapSvg.createSvg("circle", { cls: "wadjet-studio-atlas-zonecore", attr: { cx: zoneX.toFixed(1), cy: zoneY.toFixed(1), r: 3 } });
    }
  }

  // --- paint ---------------------------------------------------------------

  /**
   * The KIND badge lives in the panel chrome; `mode` is local state a store
   * tick never sees (see the file header), so this body's own panel is its
   * ancestor and the badge is found from here rather than pulled by `windows.ts`.
   */
  function paintBadge(): void {
    const badge = root.closest(".wadjet-studio-window")?.querySelector(".wadjet-studio-window-badge");
    if (badge instanceof HTMLElement) badge.setText(mode === "station" ? "STATION" : "GEOGRAPHY");
  }

  function paintList(z: ZoneProfile | null): void {
    const baseId = baseStation(z)?.id ?? null;
    const key = `${selected ?? ""}|${baseId ?? ""}`;
    if (key === listSignature) return;
    listSignature = key;
    list.empty();
    for (const s of stations()) {
      const row = list.createDiv({
        cls: "wadjet-studio-atlas-station",
        attr: { role: "option", tabindex: "0", "aria-selected": s.id === selected ? "true" : "false", "data-hint": atlasHint("atlas.station"), "data-part": "atlas-station", "data-id": s.id },
      });
      row.toggleClass("is-selected", s.id === selected);
      row.createSpan({ cls: "wadjet-studio-atlas-stationdot" }).setCssProps({ "--wadjet-studio-atlas-color": GROUP_COLOR[s.group] });
      row.createSpan({ cls: "wadjet-studio-atlas-stationname", text: s.name });
      row.createDiv({ cls: "wadjet-studio-atlas-fill" });
      if (s.id === baseId) row.createSpan({ cls: "wadjet-studio-atlas-stationbase", text: "base" });
      row.createSpan({ cls: "wadjet-studio-atlas-stationkoppen", text: s.koppen });
      const pick = (): void => {
        selected = s.id;
        repaint();
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        pick();
      });
    }
  }

  /** One spark: the comparison record dashed, the subject solid, 0 °C dotted through. */
  function paintSpark(svg: SVGElement, base: number[] | null, subject: number[] | null, color: string): void {
    svg.empty();
    svg.createSvg("line", { cls: "wadjet-studio-atlas-sparkzero", attr: { x1: 0, x2: SPARK_W, y1: SPARK_ZERO_Y, y2: SPARK_ZERO_Y } });
    if (base !== null) svg.createSvg("polyline", { cls: "wadjet-studio-atlas-sparkbase", attr: { points: sparkPoints(base) } });
    if (subject !== null) svg.createSvg("polyline", { cls: "wadjet-studio-atlas-sparkline", attr: { points: sparkPoints(subject), stroke: color } });
  }

  function paintCard(station: Station | null, z: ZoneProfile | null): void {
    const units = ctx.units();
    const base = baseStation(z);
    const preset = station === null ? null : presetOf(station.id);
    const basePreset: Preset | null = base === null ? null : presetOf(base.id);

    cardName.setText(station?.name ?? "No station selected");
    cardKoppen.setText(station?.koppen ?? "—");
    cardKoppen.setCssProps({ "--wadjet-studio-atlas-color": station === null ? "var(--wadjet-studio-text-dim)" : GROUP_COLOR[station.group] });
    // The prototype's card title line is the name and the class, nothing else,
    // and its stats line is ONE line: the temperature pair and the wet days.
    // The years of record and the country stay on the record, off the card.
    const wet = station === null ? "" : format(station.wetDays, "count", units).text;
    cardStats.setText(station === null ? "—" : grammar(rangeText(station.minC, station.maxC, units), `wet ${wet} d/yr`));
    // One sentence, ending in a period, quoting the SAME wet-day figure.
    cardText.setText(station === null ? "" : stationDescription(station, wet));

    paintSpark(cardSpark, basePreset === null ? null : sparkOf(basePreset), preset === null ? null : sparkOf(preset), station === null ? "var(--wadjet-studio-text-dim)" : GROUP_COLOR[station.group]);
    const by = `mean ${unitLabel("temperature", units)} by month`;
    cardSparkLabel.setText(base === null || station === null ? by : `${by} · ${base.name} (dashed) vs ${station.name}`);

    const isBase = station !== null && base !== null && station.id === base.id && z?.geography === undefined;
    rebaseBtn.setText(station === null ? "Re-base zone" : isBase ? "✓ current base" : `Re-base zone → ${station.name}`);
    rebaseBtn.toggleClass("is-done", isBase);
    rebaseBtn.toggleClass("is-disabled", station === null || z === null || isBase);
    rebaseBtn.setAttr("aria-disabled", station === null || z === null || isBase ? "true" : "false");
  }

  function paintGeography(z: ZoneProfile | null): void {
    latitude.update({ value: geo.latitude });
    altitude.update({ value: geo.altitude });
    continental.update({ value: continentality, disabled: !useContinentality });
    swingSeg.update({ value: useContinentality ? "adjust" : "station" });
    terrainSeg.update({ value: geo.orographic });

    const preview = previewMatch(place());
    const station = preview === null ? null : stationOf(preview.candidate.preset.id);
    const color = station === null ? "var(--wadjet-studio-text-dim)" : GROUP_COLOR[station.group];
    matchName.setText(station?.name ?? "—");
    matchKoppen.setText(station?.koppen ?? "—");
    matchKoppen.setCssProps({ "--wadjet-studio-atlas-color": color });
    matchDistance.setText(preview === null ? "" : `match Δ ${preview.candidate.distance.toFixed(2)}`);

    const parts = matchParts(place());
    matchText.setText(preview === null ? "No station ships to match this place." : parts.length > 0 ? parts.join(" · ") : "no adjustment");
    // The full sentence the button's Notice will carry, one hover away.
    matchText.setAttr("title", preview?.provenance ?? "");

    const preset = preview?.candidate.preset ?? null;
    const adj = preset === null ? null : tierAAdjustment(place(), preset.match);
    paintSpark(matchSpark, preset === null ? null : sparkOf(preset), preset === null || adj === null ? null : adjustedSpark(preset, adj), color);
    const by = `mean ${unitLabel("temperature", ctx.units())} by month`;
    matchSparkLabel.setText(station === null ? by : `${by} · ${station.name} record (dashed) → adjusted`);

    const already = z?.preset?.matched === "auto" && z.preset.id === preset?.id && z.geography !== undefined && sameGeography(z.geography, place());
    matchBtn.setText(preview === null ? "Match by geography" : already ? "✓ current base" : `Match by geography → ${station?.name ?? preview.candidate.preset.name}`);
    matchBtn.toggleClass("is-done", already);
    matchBtn.toggleClass("is-disabled", preview === null || already);
    matchBtn.setAttr("aria-disabled", preview === null || already ? "true" : "false");
  }

  function sameGeography(a: Geography, b: Geography): boolean {
    return a.latitude === b.latitude && a.altitude === b.altitude && a.orographic === b.orographic && (a.continentality ?? null) === (b.continentality ?? null);
  }

  /**
   * Repaint from the live state. The list is guarded by its own signature, so
   * a store tick that changed nothing this panel shows touches no DOM — and
   * the hidden pane is not painted at all.
   */
  function repaint(): void {
    const state = ctx.store.get();
    const z = zone(state);
    // A zone switch (or the first paint) re-seeds the scratchpad and the
    // selection; an edit inside the same zone leaves the user's place alone.
    if ((z?.id ?? null) !== seededFrom) {
      seed(z);
      listSignature = "";
    }

    stationPane.toggleClass("is-hidden", mode !== "station");
    geoPane.toggleClass("is-hidden", mode !== "geography");
    modeSeg.update({ value: mode });
    paintBadge();
    paintMap();

    // `writes` is pull-based: the window manager re-reads it on a STORE tick,
    // and `mode` is window-local (it is not in the store at all). Without this
    // the footer would keep naming the other mode's grammar until something
    // else moved the world, and SPEC law 5 asks it to be true now.
    if (mode !== footedMode) {
      footedMode = mode;
      ctx.windows.renderAll(state);
    }

    if (mode === "station") {
      paintList(z);
      paintCard(selected === null ? null : stationOf(selected), z);
    } else {
      paintGeography(z);
    }
  }

  // --- pull-based readout ----------------------------------------------------

  /** The exact grammar this panel produces (SPEC law 5) — what the buttons would write. */
  function writes(): string {
    if (mode === "station") {
      const id = selected ?? zone()?.preset?.id ?? null;
      return grammar(id === null ? "zone.preset { — }" : `zone.preset { id ${id}, matched manual }`, "climate copied from the station record");
    }
    const g = place();
    const parts = matchParts(g);
    const match = previewMatch(g);
    const described = grammar(
      `latitude ${g.latitude.toFixed(1)}`,
      `altitude ${Math.round(g.altitude)}`,
      g.continentality === undefined ? null : `continentality ${g.continentality.toFixed(2)}`,
      `terrain ${terrainLabel(g.orographic)}`,
    );
    return grammar(`zone.geography { ${described} }`, match === null ? null : `preset ${match.candidate.preset.id} (auto)`, `Tier A ${parts.length > 0 ? parts.join(", ") : "—"}`);
  }

  unsubscribe = ctx.store.subscribe(() => repaint());
  repaint();

  return {
    title: "Atlas",
    // Prototype width (`proto-markup/`): a design constant, not a function of the content.
    width: 720,
    // A reader, not a snapshot. `mode` is window-local, so the chrome would
    // otherwise keep the badge it was opened with — and worse, any later
    // `update()` (a `writes` tick) re-stamps the badge from `props`, undoing
    // the direct poke `paintBadge()` makes. `renderAll` re-pulls this.
    badge: () => (mode === "station" ? "STATION" : "GEOGRAPHY"),
    badgeColor: "var(--wadjet-studio-wind)",
    body: root,
    led: { on: true, scope: "device" },
    // `flipSeasons` is the one core-validated path this window owns (SPEC §3.9 mapIssue).
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "zone" }))),
    writes,
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
      mapBox.removeEventListener("pointerdown", onMapDown);
      modeSeg.destroy();
      swingSeg.destroy();
      terrainSeg.destroy();
      latitude.destroy();
      altitude.destroy();
      continental.destroy();
      root.remove();
    },
  };
};
