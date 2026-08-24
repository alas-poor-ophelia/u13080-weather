/**
 * Parser for CLIGEN .par station files (format confirmed against
 * NO000050540.par — format notes in the maintainer docs, PRESETS.md §3).
 *
 * Units are left EXACTLY as in the file (inches, °F, feet, m/s, Langleys).
 * Conversion happens in convert.ts so the parse step is a faithful
 * transcription that can be tested against a fixture.
 */

export const WIND_DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const;
export type WindDir = (typeof WIND_DIRS)[number];

export interface WindSector {
  /** % of time the wind blows from this sector, per month */
  pct: number[];
  /** mean speed m/s per month */
  mean: number[];
  sd: number[];
  skew: number[];
}

export interface CligenStation {
  country: string;
  name: string;
  latitude: number;
  longitude: number;
  years: number;
  type: number;
  elevationFt: number;
  tp5: number;
  tp6: number;
  /** monthly arrays, 12 entries each, original units */
  meanP: number[]; // inches, mean wet-day amount
  sdP: number[]; // inches
  skewP: number[];
  pww: number[];
  pwd: number[];
  tmaxF: number[];
  tminF: number[];
  sdTmax: number[];
  sdTmin: number[];
  solRad: number[]; // Langleys/day
  sdSol: number[];
  mx5p: number[]; // in/hr
  dewPtF: number[];
  timePk: number[];
  wind: Record<WindDir, WindSector>;
  calmPct: number[];
  windStations: Array<{ name: string; weight: number }>;
}

const MONTHLY_LABELS: Array<[RegExp, keyof CligenStation]> = [
  [/^\s*MEAN P\b/, "meanP"],
  [/^\s*S DEV P\b/, "sdP"],
  [/^\s*SKEW\s+P\b/, "skewP"],
  [/^\s*P\(W\/W\)/, "pww"],
  [/^\s*P\(W\/D\)/, "pwd"],
  [/^\s*TMAX AV\b/, "tmaxF"],
  [/^\s*TMIN AV\b/, "tminF"],
  [/^\s*SD TMAX\b/, "sdTmax"],
  [/^\s*SD TMIN\b/, "sdTmin"],
  [/^\s*SOL\.RAD\b/, "solRad"],
  [/^\s*SD SOL\b/, "sdSol"],
  [/^\s*MX \.5 P\b/, "mx5p"],
  [/^\s*DEW PT\b/, "dewPtF"],
  [/^\s*Time Pk\b/i, "timePk"],
];

/** Pull the 12 trailing numbers from a labelled row. Handles ".47", "-.15", "23.", "1.000". */
function twelve(line: string, label: string): number[] {
  const nums = line.match(/-?\d*\.?\d+\.?/g)?.map(Number) ?? [];
  // Labels like "MX .5 P" and "P(W/W)" contain digits — take the LAST 12 numbers.
  if (nums.length < 12) throw new Error(`cligen-parse: expected 12 values for ${label}, got ${nums.length}: ${line.trim()}`);
  const v = nums.slice(-12);
  if (v.some((x) => !Number.isFinite(x))) throw new Error(`cligen-parse: non-finite value in ${label}`);
  return v;
}

export function parseCligenPar(text: string): CligenStation {
  const lines = text.split(/\r?\n/);
  if (lines.length < 20) throw new Error("cligen-parse: file too short");

  // Header line 0: " Norway    Bergen Florida   " / " United States    Fremont Pass   " →
  // country and name are separated by a run of spaces; either may contain single spaces.
  const h0 = lines[0]!.trim();
  const gap = h0.search(/\s{2,}/);
  const country = gap < 0 ? h0 : h0.slice(0, gap);
  const name = gap < 0 ? "" : h0.slice(gap).trim();

  const h1 = lines[1]!;
  const m1 = h1.match(/LATT=\s*(-?[\d.]+)\s+LONG=\s*(-?[\d.]+)\s+YEARS=\s*([\d.]+)\s+TYPE=\s*(\d+)/);
  if (!m1) throw new Error(`cligen-parse: bad header line 2: ${h1.trim()}`);
  const h2 = lines[2]!;
  const m2 = h2.match(/ELEVATION\s*=\s*(-?[\d.]+)\s+TP5\s*=\s*(-?[\d.]+)\s+TP6\s*=\s*(-?[\d.]+)/);
  if (!m2) throw new Error(`cligen-parse: bad header line 3: ${h2.trim()}`);

  const st: Partial<CligenStation> = {
    country,
    name,
    latitude: Number(m1[1]),
    longitude: Number(m1[2]),
    years: Number(m1[3]),
    type: Number(m1[4]),
    elevationFt: Number(m2[1]),
    tp5: Number(m2[2]),
    tp6: Number(m2[3]),
    wind: {} as Record<WindDir, WindSector>,
    windStations: [],
  };

  let i = 3;
  // Monthly labelled rows
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*%\s*[NESW]{1,3}\b/.test(line)) break;
    const hit = MONTHLY_LABELS.find(([re]) => re.test(line));
    if (hit) (st as Record<string, unknown>)[hit[1]] = twelve(line, hit[1]);
  }
  for (const [, key] of MONTHLY_LABELS) {
    if (!(key in st)) throw new Error(`cligen-parse: missing row ${key}`);
  }

  // Wind sectors: "% N" then MEAN / STD DEV / SKEW rows
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const mdir = line.match(/^\s*%\s*([NESW]{1,3})\b/);
    if (mdir) {
      const dir = mdir[1] as WindDir;
      if (!WIND_DIRS.includes(dir)) throw new Error(`cligen-parse: unknown wind dir ${dir}`);
      const pct = twelve(line, `% ${dir}`);
      const mean = twelve(lines[i + 1] ?? "", `${dir} MEAN`);
      const sd = twelve(lines[i + 2] ?? "", `${dir} STD DEV`);
      const skew = twelve(lines[i + 3] ?? "", `${dir} SKEW`);
      st.wind![dir] = { pct, mean, sd, skew };
      i += 3;
      continue;
    }
    if (/^\s*CALM\b/.test(line)) {
      st.calmPct = twelve(line, "CALM");
      continue;
    }
    if (/---Wind Stations---/.test(line)) {
      // following non-empty line(s): "NAME  ST  weight  NAME  ST  weight ..."
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!.trim();
        if (!l) continue;
        const re = /([A-Z][A-Z0-9 .'()/-]*?)\s+([A-Z]{2})\s+(-?\d*\.\d+|\d+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(l))) st.windStations!.push({ name: `${m[1]!.trim()} ${m[2]}`, weight: Number(m[3]) });
      }
      break;
    }
  }
  for (const d of WIND_DIRS) if (!st.wind![d]) throw new Error(`cligen-parse: missing wind sector ${d}`);
  if (!st.calmPct) throw new Error("cligen-parse: missing CALM row");

  return st as CligenStation;
}
