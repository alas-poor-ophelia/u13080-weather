/**
 * Zone authoring helpers (pure). Preset copy-on-select + Tier A.
 */
import { applyTierA, describeTierA, rankPresets, tierAAdjustment } from "../core/tier-a";
import type { Geography, Preset, ZoneProfile } from "../core/types";

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "zone"
  );
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export interface NewZoneOptions {
  name: string;
  preset: Preset;
  geography?: Geography;
  existingIds: ReadonlySet<string>;
}

/** Copy the preset into a new zone; apply Tier A if geography is given. Returns the zone and a provenance sentence. */
export function zoneFromPreset(o: NewZoneOptions): { zone: ZoneProfile; provenance: string } {
  let climate = structuredClone(o.preset.climate);
  let provenance = `Copied from preset "${o.preset.name}" (${o.preset.source.stationName}, ${o.preset.match.koppen}).`;
  if (o.geography) {
    const adj = tierAAdjustment(o.geography, o.preset.match);
    climate = applyTierA(climate, adj);
    provenance = describeTierA(o.preset, adj);
  }
  const zone: ZoneProfile = {
    id: uniqueId(slugify(o.name), o.existingIds),
    name: o.name,
    schemaVersion: 1,
    ...(o.geography ? { geography: o.geography } : {}),
    preset: { id: o.preset.id, contentHash: o.preset.contentHash, matched: o.geography ? "auto" : "manual" },
    climate,
    regimes: structuredClone(o.preset.regimes),
    modifiers: [],
  };
  return { zone, provenance };
}

/** Auto-pick the nearest preset for a geography. */
export function zoneFromGeography(name: string, geography: Geography, presets: readonly Preset[], existingIds: ReadonlySet<string>): { zone: ZoneProfile; provenance: string } {
  const best = rankPresets(
    geography,
    presets.filter((p) => !(p as Preset & { alternate?: boolean }).alternate),
  )[0];
  if (!best) throw new Error("no presets available");
  return zoneFromPreset({ name, preset: best.preset, geography, existingIds });
}
