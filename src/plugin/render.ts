/**
 * DOM rendering for the codeblock. Uses Obsidian's HTMLElement helpers
 * (createEl / createDiv / empty), so this file is not unit-tested.
 */
import { compassPoint, describe, withMinus, type WeatherReport } from "../core/report";

export type Units = "metric" | "imperial";

export function fmtTemp(c: number, u: Units): string {
  return u === "imperial" ? `${withMinus(Math.round((c * 9) / 5 + 32))} °F` : `${withMinus(c.toFixed(1))} °C`;
}
export function fmtMm(mm: number, u: Units): string {
  return u === "imperial" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}
export function fmtSpeed(kph: number, u: Units): string {
  return u === "imperial" ? `${Math.round(kph / 1.609)} mph` : `${kph} km/h`;
}
export function fmtKm(km: number, u: Units): string {
  return u === "imperial" ? `${(km / 1.609).toFixed(1)} mi` : `${km.toFixed(1)} km`;
}

const ICON: Record<string, string> = { none: "☀", drizzle: "🌦", rain: "🌧", sleet: "🌨", snow: "❄" };

function icon(r: WeatherReport): string {
  if (r.conditions.includes("fog")) return "🌫";
  if (r.precipitation.type !== "none") return ICON[r.precipitation.type] ?? "🌧";
  if (r.cloudCover >= 0.8) return "☁";
  if (r.cloudCover >= 0.4) return "⛅";
  return "☀";
}

export function renderCard(el: HTMLElement, r: WeatherReport, dateLabel: string, u: Units): void {
  const card = el.createDiv({ cls: "wadjet-card" });
  const head = card.createDiv({ cls: "wadjet-card-head" });
  head.createSpan({ cls: "wadjet-icon", text: icon(r) });
  const title = head.createDiv({ cls: "wadjet-title" });
  title.createDiv({ cls: "wadjet-date", text: dateLabel });
  title.createDiv({ cls: "wadjet-summary", text: describe(r, "short") });
  const grid = card.createDiv({ cls: "wadjet-grid" });
  const row = (k: string, v: string) => {
    grid.createDiv({ cls: "wadjet-k", text: k });
    grid.createDiv({ cls: "wadjet-v", text: v });
  };
  row("Temperature", `${fmtTemp(r.temperature.low, u)} – ${fmtTemp(r.temperature.high, u)}${r.temperature.current !== undefined ? ` (now ${fmtTemp(r.temperature.current, u)})` : ""}`);
  row("Precipitation", r.precipitation.type === "none" ? "none" : `${r.descriptors.precipitation} ${r.precipitation.type}, ${fmtMm(r.precipitation.amountMm, u)}${r.precipitation.active === true ? " — falling now" : ""}`);
  row("Wind", r.wind.speedKph === 0 ? "calm" : `${fmtSpeed(r.wind.speedKph, u)} from the ${compassPoint(r.wind.directionDeg)} (${r.descriptors.wind})`);
  row("Sky", `${r.descriptors.sky}, ${Math.round(r.cloudCover * 100)}% cloud`);
  row("Humidity", `${Math.round(r.humidity * 100)}%`);
  row("Visibility", fmtKm(r.visibilityKm, u));
  if (r.conditions.length) row("Conditions", r.conditions.join(", "));
  if (r.overridden) card.createDiv({ cls: "wadjet-note", text: "pinned (override)" });
}

export function renderLine(el: HTMLElement, r: WeatherReport, dateLabel: string): void {
  el.createSpan({ cls: "wadjet-line", text: `${icon(r)} ${dateLabel}: ${describe(r, "short")}` });
}

export function renderProse(el: HTMLElement, r: WeatherReport, dateLabel: string): void {
  const p = el.createEl("p", { cls: "wadjet-prose" });
  p.createEl("strong", { text: `${dateLabel}. ` });
  p.appendText(describe(r, "prose"));
}

export function renderTable(el: HTMLElement, rows: Array<{ label: string; r: WeatherReport }>, u: Units): void {
  const t = el.createEl("table", { cls: "wadjet-table" });
  const th = t.createEl("thead").createEl("tr");
  for (const h of ["Date", "", "Low", "High", "Precip", "Wind", "Sky"]) th.createEl("th", { text: h });
  const tb = t.createEl("tbody");
  for (const { label, r } of rows) {
    const tr = tb.createEl("tr", { cls: r.overridden ? "wadjet-overridden" : "" });
    tr.createEl("td", { text: label });
    tr.createEl("td", { text: icon(r) });
    tr.createEl("td", { text: fmtTemp(r.temperature.low, u) });
    tr.createEl("td", { text: fmtTemp(r.temperature.high, u) });
    tr.createEl("td", { text: r.precipitation.type === "none" ? "—" : `${r.descriptors.precipitation} ${r.precipitation.type}` });
    tr.createEl("td", { text: r.wind.speedKph === 0 ? "calm" : `${fmtSpeed(r.wind.speedKph, u)} ${compassPoint(r.wind.directionDeg)}` });
    tr.createEl("td", { text: r.descriptors.sky });
  }
}

export function renderError(el: HTMLElement, message: string): void {
  el.createDiv({ cls: "wadjet-error", text: message });
}
