import { describe as group, expect, test } from "bun:test";
import { GLYPH_KEYS, glyph, glyphKey, type GlyphKey } from "../src/core/glyphs";
import { buildReport, type WeatherReport } from "../src/core/report";
import { createGenerator } from "../src/core/profile";
import { gregorianTime } from "../src/core/generator";
import { GLYPH_EMOJI, icon } from "../src/plugin/render";
import type { Preset, ZoneProfile } from "../src/core/types";

type ReportOver = Omit<Partial<WeatherReport>, "precipitation" | "wind"> & {
  precipitation?: Partial<WeatherReport["precipitation"]>;
  wind?: Partial<WeatherReport["wind"]>;
};
function mk(over: ReportOver = {}): WeatherReport {
  const { precipitation, wind, ...rest } = over;
  return {
    schemaVersion: 0,
    zoneId: "z",
    dayOrdinal: 1,
    temperature: { high: 18, low: 8, mean: 13 },
    precipitation: { type: "none", amountMm: 0, intensity: 0, ...precipitation },
    humidity: 0.6,
    cloudCover: 0.1,
    wind: { speedKph: 10, directionDeg: 270, ...wind },
    visibilityKm: 30,
    regime: "normal",
    conditions: [],
    descriptors: { temperature: "mild", precipitation: "dry", wind: "breezy", sky: "clear" },
    overridden: false,
    provenance: { worldSeed: "s", generatorVersion: "g", rngVersion: "r", profileHash: "p", calendarHash: "c" },
    ...rest,
  };
}

/** Balanced-tag well-formedness check for the small SVG subset the glyphs use. */
function wellFormed(svg: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<>]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (svg.slice(last, m.index).includes("<")) return false; // a stray, unparsed tag
    last = re.lastIndex;
    const [, close, name, , self] = m;
    if (close) {
      if (stack.pop() !== name) return false;
    } else if (!self) stack.push(name!);
  }
  return stack.length === 0 && !svg.slice(last).includes("<") && svg.startsWith("<svg") && svg.endsWith("</svg>");
}

group("glyphs: the set", () => {
  test("the key set is the documented closed set", () => {
    expect([...GLYPH_KEYS]).toEqual(["clear", "partly-cloudy", "cloudy", "overcast", "fog", "drizzle", "rain", "heavy-rain", "sleet", "snow", "heavy-snow", "windy"]);
    expect(Object.isFrozen(GLYPH_KEYS)).toBe(true);
  });

  test.each([...GLYPH_KEYS])("%p is a safe, well-formed, monochrome 24 by 24 SVG", (key) => {
    const svg = glyph(key);
    expect(wellFormed(svg)).toBe(true);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('width="24" height="24"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain("<path ");
    expect(svg.toLowerCase()).not.toContain("<script");
    expect(svg).not.toMatch(/\son\w+=/i);
    expect(svg.toLowerCase()).not.toContain("href");
    expect(svg).not.toMatch(/url\(|\bid=|<style|<image|<foreignobject/i);
    // monochrome: the only colour is currentColor
    expect(svg.match(/(?:fill|stroke)="([^"]*)"/g)!.every((a) => /="(none|currentColor)"/.test(a))).toBe(true);
    // no path coordinate leaks floating-point noise
    expect(svg).not.toMatch(/\d\.\d{3,}/);
  });

  test("every glyph is distinct", () => {
    expect(new Set(GLYPH_KEYS.map((k) => glyph(k))).size).toBe(GLYPH_KEYS.length);
  });

  test("size sets width and height; bad sizes fall back to 24", () => {
    expect(glyph("rain", { size: 16 })).toContain('width="16" height="16"');
    expect(glyph("rain", { size: 48 })).toContain('width="48" height="48"');
    for (const size of [0, -3, Number.NaN, Infinity]) expect(glyph("rain", { size })).toContain('width="24" height="24"');
  });

  test("title becomes an escaped <title>, and makes the SVG an image for assistive tech", () => {
    const svg = glyph("snow", { title: `<script>alert("x")</script> & 'co'` });
    expect(svg).toContain("<title>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &apos;co&apos;</title>");
    expect(svg.toLowerCase()).not.toContain("<script");
    expect(wellFormed(svg)).toBe(true);
    expect(svg).toContain('role="img"');
    expect(glyph("snow")).toContain('aria-hidden="true"');
    expect(glyph("snow")).not.toContain("<title>");
  });

  test("a report picks its own glyph; an unknown key is a RangeError", () => {
    expect(glyph(mk({ conditions: ["fog"] }))).toBe(glyph("fog"));
    expect(() => glyph("tornado" as GlyphKey)).toThrow(RangeError);
  });
});

group("glyphs: glyphKey precedence (R7)", () => {
  const table: Array<[string, ReportOver, GlyphKey]> = [
    ["fog beats precipitation", { conditions: ["fog"], precipitation: { type: "drizzle", amountMm: 0.3, intensity: 0.01 } }, "fog"],
    ["fog beats wind and cloud", { conditions: ["fog"], wind: { speedKph: 60 }, cloudCover: 1 }, "fog"],
    ["drizzle", { precipitation: { type: "drizzle", amountMm: 0.4, intensity: 0.9 } }, "drizzle"],
    ["rain below 0.6 intensity", { precipitation: { type: "rain", amountMm: 10, intensity: 0.59 } }, "rain"],
    ["rain at 0.6 intensity is heavy", { precipitation: { type: "rain", amountMm: 18.3, intensity: 0.6 } }, "heavy-rain"],
    ["sleet has no heavy variant", { precipitation: { type: "sleet", amountMm: 30, intensity: 0.78 } }, "sleet"],
    ["snow below 0.6 intensity", { precipitation: { type: "snow", amountMm: 4, intensity: 0.18 } }, "snow"],
    ["snow at 0.6 intensity is heavy", { precipitation: { type: "snow", amountMm: 20, intensity: 0.63 } }, "heavy-snow"],
    ["precipitation beats wind", { precipitation: { type: "rain", amountMm: 3, intensity: 0.14 }, wind: { speedKph: 90 } }, "rain"],
    ["Beaufort 6 on a dry day is windy", { wind: { speedKph: 39 }, cloudCover: 0.9 }, "windy"],
    ["Beaufort 5 is not", { wind: { speedKph: 38 }, cloudCover: 0.9 }, "overcast"],
    ["cloud 0.8 is overcast", { cloudCover: 0.8 }, "overcast"],
    ["cloud 0.6 is cloudy", { cloudCover: 0.6 }, "cloudy"],
    ["cloud 0.4 is partly cloudy", { cloudCover: 0.4 }, "partly-cloudy"],
    ["cloud under 0.4 is clear", { cloudCover: 0.39 }, "clear"],
    ["an override's unknown type reads as rain", { precipitation: { type: "hail" as never, amountMm: 5, intensity: 0.2 } }, "rain"],
  ];
  test.each(table)("%s", (_name, over, key) => {
    expect(glyphKey(mk(over))).toBe(key);
  });

  test("every key is reachable", () => {
    const seen = new Set<GlyphKey>(table.map(([, , k]) => k));
    seen.add("clear");
    expect([...GLYPH_KEYS].filter((k) => !seen.has(k))).toEqual([]);
  });

  test("never reads descriptor strings", () => {
    const r = mk({ cloudCover: 0.9 });
    expect(glyphKey({ ...r, descriptors: { temperature: "", precipitation: "flooding", wind: "hurricane", sky: "clear" } })).toBe("overcast");
  });
});

group("render: icon() rides on glyphKey", () => {
  // The codeblock icon as it was before glyphKey existed, kept verbatim as the reference.
  const OLD_ICON: Record<string, string> = { none: "☀", drizzle: "🌦", rain: "🌧", sleet: "🌨", snow: "❄" };
  function oldIcon(r: WeatherReport): string {
    if (r.conditions.includes("fog")) return "🌫";
    if (r.precipitation.type !== "none") return OLD_ICON[r.precipitation.type] ?? "🌧";
    if (r.cloudCover >= 0.8) return "☁";
    if (r.cloudCover >= 0.4) return "⛅";
    return "☀";
  }

  test("every key has an emoji", () => {
    for (const k of GLYPH_KEYS) expect(GLYPH_EMOJI[k].length).toBeGreaterThan(0);
  });

  test("identical to the old icon for every report below Beaufort 6", () => {
    let n = 0;
    for (const type of ["none", "drizzle", "rain", "sleet", "snow"] as const)
      for (const intensity of [0, 0.2, 0.59, 0.6, 0.95])
        for (const cloudCover of [0, 0.2, 0.39, 0.4, 0.6, 0.79, 0.8, 1])
          for (const fog of [false, true])
            for (const speedKph of [0, 20, 38]) {
              const r = mk({
                precipitation: { type, amountMm: type === "none" ? 0 : 5, intensity: type === "none" ? 0 : intensity },
                cloudCover,
                conditions: fog ? ["fog"] : [],
                wind: { speedKph },
              });
              expect(icon(r)).toBe(oldIcon(r));
              n++;
            }
    expect(n).toBe(1200);
  });

  test("at Beaufort 6 and above only dry, fog-free days change (to the windy emoji)", () => {
    for (const type of ["none", "drizzle", "rain", "sleet", "snow"] as const)
      for (const fog of [false, true]) {
        const r = mk({ precipitation: { type, amountMm: type === "none" ? 0 : 5, intensity: type === "none" ? 0 : 0.2 }, conditions: fog ? ["fog"] : [], wind: { speedKph: 60 }, cloudCover: 0.9 });
        expect(icon(r)).toBe(type === "none" && !fog ? "💨" : oldIcon(r));
      }
  });

  test("over a generated year, identical to the old icon except windy dry days", async () => {
    const fjord = (await Bun.file(new URL("../presets/fjord-coast.json", import.meta.url)).json()) as Preset;
    const zone: ZoneProfile = { id: "g", name: "G", schemaVersion: 1, climate: fjord.climate, regimes: fjord.regimes, modifiers: [] };
    const { generator, resolved } = createGenerator(zone, "seed", gregorianTime);
    for (let d = 0; d < 365; d++) {
      const r = buildReport(generator.day(d), "g", { seed: "seed", provenance: { profileHash: resolved.profileHash, calendarHash: "c" } });
      expect(icon(r)).toBe(glyphKey(r) === "windy" ? "💨" : oldIcon(r));
    }
  });
});
