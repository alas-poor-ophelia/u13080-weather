/**
 * Built-in zone resolver `wadjet.frontmatter`: a note names its zone in the
 * `weather-zone` frontmatter key, by zone id or by zone name. An exact id
 * match wins over a case-insensitive name match. Registered by the plugin on
 * load like any third-party resolver, first in the chain. Pure: the plugin
 * passes in a frontmatter reader backed by the metadata cache.
 */
import type { ZoneResolver } from "./world";

export const FRONTMATTER_RESOLVER_ID = "wadjet.frontmatter";
export const FRONTMATTER_KEY = "weather-zone";

export function frontmatterResolver(readFrontmatter: (path: string) => Record<string, unknown> | null | undefined, zones: () => ReadonlyArray<{ id: string; name: string }>): ZoneResolver {
  return {
    id: FRONTMATTER_RESOLVER_ID,
    kinds: ["note"],
    resolve: (locator) => {
      if (locator.kind !== "note") return null;
      const raw = readFrontmatter(locator.path)?.[FRONTMATTER_KEY];
      if (typeof raw !== "string" && typeof raw !== "number") return null;
      const value = String(raw).trim();
      if (!value) return null;
      const list = zones();
      const byId = list.find((z) => z.id === value);
      if (byId) return byId.id;
      const lower = value.toLowerCase();
      return list.find((z) => z.name.toLowerCase() === lower)?.id ?? null;
    },
  };
}
