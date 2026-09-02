/**
 * The Atlas window (SPEC §3.4 "Atlas · STATION", PLAN §5.4).
 *
 * The zone's *source*, in two modes behind one Segmented:
 *
 *   STATION    the 26 shipped stations, searchable; a record card for the one
 *              selected, a spark of its year of temperature against the zone's
 *              own, and `Re-base zone → X`.
 *   GEOGRAPHY  a place rather than a station: the zone dot dragged ↕ latitude
 *              ↔ terrain, knobs for latitude / altitude / continentality, and
 *              the closest match Tier A picks for it — live, as the knobs move
 *              — behind `Match by geography → X`.
 *
 * Three things worth knowing before editing this file:
 *
 *  - **Every rule about what a re-base or a match writes lives in
 *    `model/atlas.ts`**, not here (PLAN D3). This file is the list, the knobs,
 *    the chart and two buttons; the two buttons call one pure function each
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
 *
 * Continentality carries an *unset* state, mirroring `AddZoneModal`'s "adjust
 * the seasonal swing" toggle: off omits the axis from `Geography` entirely,
 * which both drops it from the match distance and keeps the matched station's
 * own seasonal swing (`core/types.ts`, `Geography.continentality`).
 */
import { Notice } from "obsidian";
import type { Geography, Orographic, ZoneProfile } from "../../../core/types";
import type { Units } from "../../../core/units";
import { matchByGeography, presetOf, previewMatch, rebase, searchStations, sparkOf, stationOf, type Station } from "../../model/atlas";
import { format } from "../../model/format";
import { atlasHint } from "../../model/hints-atlas";
import type { StudioState } from "../../model/state";
import { ledLevel, unitKey } from "../../model/validation";
import { createChart, createKnob, createSegmented, type ChartComponent, type ChartSeries, type KnobComponent, type SegmentedComponent } from "../components";
import type { SurfaceContext } from "../surfaces";
import type { WindowBuild, WindowBuilder } from "../windows";

/** The id the Atlas panel is opened under — the same constant `header.ts`'s SRC chip opens. */
export const ATLAS_WINDOW = "atlas";

type Mode = "station" | "geography";

/** SPEC §3.4: latitude −90…90, altitude 0…5000 m, continentality 0…1. */
const LATITUDE_SPEC = { min: -90, max: 90, step: 1, neutral: 0 } as const;
const ALTITUDE_SPEC = { min: 0, max: 5000, step: 10 } as const;
const CONTINENTALITY_SPEC = { min: 0, max: 1, step: 0.05 } as const;

/** The spark and the map, in SVG user units. */
const SPARK_W = 296;
const SPARK_H = 62;
const MAP_W = 296;
const MAP_H = 168;

/** The three terrain columns the map's x axis is, in order. */
const TERRAIN: readonly Orographic[] = ["none", "windward", "leeward"];

/** `AddZoneModal`'s defaults, for a zone that has never been described as a place. */
const DEFAULT_GEOGRAPHY: Geography = { latitude: 45, altitude: 200, orographic: "none" };
const DEFAULT_CONTINENTALITY = 0.5;

/** The column centre for a terrain, in the map's [0,1] x axis. */
function terrainX(o: Orographic): number {
  const at = TERRAIN.indexOf(o);
  return ((at < 0 ? 0 : at) + 0.5) / TERRAIN.length;
}

/** Sentence case, for the terrain Segmented and the map's column labels. */
function terrainLabel(o: Orographic): string {
  return o === "windward" ? "Windward" : o === "leeward" ? "Leeward" : "None";
}

/** Which terrain column an x in [0,1] fell in. */
function terrainAt(x: number): Orographic {
  const at = Math.min(TERRAIN.length - 1, Math.max(0, Math.floor(x * TERRAIN.length)));
  return TERRAIN[at] ?? "none";
}

/** `52°` / `−35°` — degrees of latitude, real minus, no unit table needed. */
function latitudeText(v: number): string {
  return `${format(v, "count", "metric").text}°`;
}

/**
 * `1 240 m` — metres above sea level. `core/units.ts` has no elevation table,
 * so this is metric on both settings; the station card quotes the dataset's
 * own `elevationM` the same way.
 */
function altitudeText(v: number): string {
  return `${format(v, "count", "metric").text} m`;
}

function continentalityText(v: number, units: Units): string {
  return format(v, "fraction", units).text;
}

/** A body button — a real button for the keyboard, hinted like everything else. Its text follows the selection, so it is set at paint. */
function actionButton(parent: HTMLElement, o: { hint: string; part: string; onClick: () => void }): HTMLElement {
  const el = parent.createDiv({
    cls: "wadjet-studio-atlas-action",
    attr: { role: "button", tabindex: "0", "data-hint": o.hint, "data-part": o.part },
  });
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

/** Twelve monthly samples as a year-domain line: month centres across [0,1]. */
function sparkSeries(values: number[], color: string): ChartSeries {
  return { points: values.map((v, i): [number, number] => [(i + 0.5) / values.length, v]), color };
}

/** One `label · value` line of the station record card. */
function cardRow(parent: HTMLElement, label: string): HTMLElement {
  const row = parent.createDiv({ cls: "wadjet-studio-atlas-cardrow" });
  row.createSpan({ cls: "wadjet-studio-atlas-cardlabel", text: label });
  return row.createSpan({ cls: "wadjet-studio-atlas-cardvalue" });
}

export const buildAtlasWindow: WindowBuilder = (ctx: SurfaceContext): WindowBuild => {
  let unsubscribe: (() => void) | null = null;

  let mode: Mode = "station";
  let query = "";
  let selected: string | null = null;
  /** the working place, seeded from the zone; only the button writes it */
  let geo: Geography = { ...DEFAULT_GEOGRAPHY };
  let continentality = DEFAULT_CONTINENTALITY;
  let useContinentality = false;
  /** the zone the scratchpad above was seeded from */
  let seededFrom: string | null = null;
  let listSignature = "";

  function zone(state: StudioState = ctx.store.get()): ZoneProfile | null {
    const id = state.view.zoneId;
    return id !== null ? (state.zones[id] ?? null) : null;
  }

  /** The place as the match sees it: continentality is an axis only while it is on. */
  function place(): Geography {
    return useContinentality ? { ...geo, continentality } : { ...geo };
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

  // --- the body ------------------------------------------------------------

  const root = createDiv({ cls: "wadjet-studio-atlas" });

  const modeRow = root.createDiv({ cls: "wadjet-studio-atlas-moderow" });
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

  const stationPane = root.createDiv({ cls: "wadjet-studio-atlas-pane" });
  const search = stationPane.createEl("input", {
    cls: "wadjet-studio-atlas-search",
    type: "text",
    attr: { placeholder: "Search stations", "aria-label": "Search stations", "data-hint": atlasHint("atlas.search"), "data-part": "atlas-search" },
  });
  search.addEventListener("input", () => {
    query = search.value;
    repaint();
  });

  const list = stationPane.createDiv({ cls: "wadjet-studio-atlas-list", attr: { role: "listbox", "data-part": "atlas-list" } });

  const card = stationPane.createDiv({ cls: "wadjet-studio-atlas-card", attr: { "data-hint": atlasHint("atlas.card"), "data-part": "atlas-card" } });
  const cardName = card.createDiv({ cls: "wadjet-studio-atlas-cardname", attr: { "data-part": "atlas-card-name" } });
  const cardCharacter = card.createDiv({ cls: "wadjet-studio-atlas-cardcharacter" });
  const cardStation = cardRow(card, "Station");
  const cardYears = cardRow(card, "Years of record");
  const cardPlace = cardRow(card, "Latitude · altitude");
  const cardKoppen = cardRow(card, "Köppen");

  const sparkBox = stationPane.createDiv({ cls: "wadjet-studio-atlas-spark", attr: { "data-hint": atlasHint("atlas.spark"), "data-part": "atlas-spark" } });
  const spark: ChartComponent = createChart(sparkBox, { kind: "curve", domain: "year", width: SPARK_W, height: SPARK_H, series: [] });

  const rebaseBtn = actionButton(stationPane, { hint: atlasHint("atlas.rebase"), part: "atlas-rebase", onClick: () => doRebase() });

  // --- geography mode -------------------------------------------------------

  const geoPane = root.createDiv({ cls: "wadjet-studio-atlas-pane" });
  const mapBox = geoPane.createDiv({ cls: "wadjet-studio-atlas-map", attr: { "data-hint": atlasHint("atlas.map"), "data-part": "atlas-map" } });
  const map: ChartComponent = createChart(mapBox, {
    kind: "automation",
    domain: "year",
    width: MAP_W,
    height: MAP_H,
    series: [],
    yRange: [LATITUDE_SPEC.min, LATITUDE_SPEC.max],
    editable: true,
    markers: TERRAIN.map((o) => ({ x: terrainX(o), label: terrainLabel(o) })),
    onPoint: (_index, x, y) => {
      geo = { ...geo, latitude: Math.round(Math.min(LATITUDE_SPEC.max, Math.max(LATITUDE_SPEC.min, y))), orographic: terrainAt(x) };
      repaint();
    },
  });

  const knobRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-knobs" });
  const latitude: KnobComponent = createKnob(knobRow, {
    spec: LATITUDE_SPEC,
    value: geo.latitude,
    label: "Latitude",
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
    label: "Altitude",
    color: "var(--wadjet-studio-sky)",
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
    label: "Continentality",
    color: "var(--wadjet-studio-precip)",
    hint: atlasHint("atlas.continentality"),
    fmt: (v) => continentalityText(v, ctx.units()),
    disabled: true,
    onChange: (value) => {
      continentality = value;
      repaint();
    },
  });
  continental.el.setAttr("data-part", "atlas-continentality");

  const swingRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-row" });
  swingRow.createSpan({ cls: "wadjet-studio-atlas-rowlabel", text: "Seasonal swing" });
  const swingSeg: SegmentedComponent = createSegmented(swingRow, {
    options: [
      { value: "station", label: "Station's own", hint: atlasHint("atlas.swing") },
      { value: "adjust", label: "Adjust", hint: atlasHint("atlas.swing") },
    ],
    value: "station",
    onChange: (value) => {
      useContinentality = value === "adjust";
      repaint();
    },
  });
  swingSeg.el.setAttr("data-part", "atlas-swing");

  const terrainRow = geoPane.createDiv({ cls: "wadjet-studio-atlas-row" });
  terrainRow.createSpan({ cls: "wadjet-studio-atlas-rowlabel", text: "Terrain" });
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

  const matchCard = geoPane.createDiv({ cls: "wadjet-studio-atlas-match", attr: { "data-hint": atlasHint("atlas.match"), "data-part": "atlas-match" } });
  const matchName = matchCard.createDiv({ cls: "wadjet-studio-atlas-matchname", attr: { "data-part": "atlas-match-name" } });
  const matchDistance = matchCard.createDiv({ cls: "wadjet-studio-atlas-matchdistance", attr: { "data-part": "atlas-match-distance" } });
  const matchText = matchCard.createDiv({ cls: "wadjet-studio-atlas-matchtext", attr: { "data-part": "atlas-match-text" } });

  const matchBtn = actionButton(geoPane, { hint: atlasHint("atlas.matchbtn"), part: "atlas-matchbtn", onClick: () => doMatch() });

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

  function paintList(): void {
    const rows = searchStations(query);
    const key = `${query}|${selected ?? ""}`;
    if (key === listSignature) return;
    listSignature = key;
    list.empty();
    for (const s of rows) {
      const row = list.createDiv({
        cls: "wadjet-studio-atlas-station",
        attr: { role: "option", tabindex: "0", "aria-selected": s.id === selected ? "true" : "false", "data-hint": atlasHint("atlas.station"), "data-part": "atlas-station", "data-id": s.id },
      });
      row.toggleClass("is-selected", s.id === selected);
      row.createSpan({ cls: "wadjet-studio-atlas-stationname", text: s.name });
      row.createSpan({ cls: "wadjet-studio-atlas-stationkoppen", text: s.koppen });
      row.createSpan({ cls: "wadjet-studio-atlas-stationcharacter", text: s.character });
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
    if (rows.length === 0) list.createDiv({ cls: "wadjet-studio-atlas-empty", text: "No station matches that." });
  }

  function paintCard(station: Station | null, z: ZoneProfile | null): void {
    cardName.setText(station?.name ?? "No station selected");
    cardCharacter.setText(station?.character ?? "");
    cardStation.setText(station === null ? "—" : `${station.sourceName}, ${station.country}`);
    cardYears.setText(station === null ? "—" : format(station.years, "years", ctx.units()).text);
    cardPlace.setText(station === null ? "—" : `${latitudeText(station.latitude)} · ${altitudeText(station.altitude)}`);
    cardKoppen.setText(station?.koppen ?? "—");

    const preset = station === null ? null : presetOf(station.id);
    const series: ChartSeries[] = [];
    // The zone's own year goes in first so the station's line draws over it.
    if (z !== null) series.push(sparkSeries(sparkOf(z), "var(--wadjet-studio-text-dim)"));
    if (preset !== null) series.push(sparkSeries(sparkOf(preset), "var(--wadjet-studio-temp)"));
    spark.update({ series });

    rebaseBtn.setText(station === null ? "Re-base zone" : `Re-base zone → ${station.name}`);
    rebaseBtn.toggleClass("is-disabled", station === null || z === null);
    rebaseBtn.setAttr("aria-disabled", station === null || z === null ? "true" : "false");
  }

  function paintGeography(): void {
    latitude.update({ value: geo.latitude });
    altitude.update({ value: geo.altitude });
    continental.update({ value: continentality, disabled: !useContinentality });
    swingSeg.update({ value: useContinentality ? "adjust" : "station" });
    terrainSeg.update({ value: geo.orographic });
    map.update({ series: [{ points: [[terrainX(geo.orographic), geo.latitude]], color: "var(--wadjet-studio-accent)" }] });

    const preview = previewMatch(place());
    matchName.setText(preview === null ? "—" : preview.candidate.preset.name);
    matchDistance.setText(preview === null ? "" : `distance ${format(preview.candidate.distance, "fraction", ctx.units()).text}`);
    matchText.setText(preview?.provenance ?? "No station ships to match this place.");
    matchBtn.setText(preview === null ? "Match by geography" : `Match by geography → ${preview.candidate.preset.name}`);
    matchBtn.toggleClass("is-disabled", preview === null);
    matchBtn.setAttr("aria-disabled", preview === null ? "true" : "false");
  }

  /**
   * Repaint from the live state. Both panes are guarded by their own
   * signature, so a store tick that changed nothing this panel shows touches
   * no DOM — and the hidden pane is not painted at all.
   */
  function repaint(): void {
    const state = ctx.store.get();
    const z = zone(state);
    // A zone switch (or the first paint) re-seeds the scratchpad and the
    // selection; an edit inside the same zone leaves the user's place alone.
    if ((z?.id ?? null) !== seededFrom) seed(z);

    stationPane.toggleClass("is-hidden", mode !== "station");
    geoPane.toggleClass("is-hidden", mode !== "geography");
    modeSeg.update({ value: mode });
    paintBadge();

    if (mode === "station") {
      paintList();
      paintCard(selected === null ? null : stationOf(selected), z);
    } else {
      paintGeography();
    }
  }

  // --- pull-based readout ----------------------------------------------------

  /** The exact grammar this panel produces (SPEC law 5). */
  function writes(): string {
    const z = zone();
    if (z === null) return "zone.preset · zone.geography";
    const parts = [`zone.preset · ${z.preset === undefined ? "—" : JSON.stringify(z.preset)}`];
    parts.push(`zone.geography · ${z.geography === undefined ? "—" : JSON.stringify(z.geography)}`);
    return parts.join("  ");
  }

  unsubscribe = ctx.store.subscribe(() => repaint());
  repaint();

  return {
    title: "Atlas",
    // The chrome paints this once, at open; `paintBadge()` (called from
    // `repaint()`) keeps it live across a `mode` toggle (see the file header).
    badge: mode === "station" ? "STATION" : "GEOGRAPHY",
    body: root,
    led: { on: true, scope: "device" },
    // `flipSeasons` is the one core-validated path this window owns (SPEC §3.9 mapIssue).
    level: (byUnit) => ledLevel(byUnit.get(unitKey({ kind: "zone" }))),
    writes,
    onClose: () => {
      unsubscribe?.();
      unsubscribe = null;
      modeSeg.destroy();
      swingSeg.destroy();
      terrainSeg.destroy();
      latitude.destroy();
      altitude.destroy();
      continental.destroy();
      spark.destroy();
      map.destroy();
      root.remove();
    },
  };
};
