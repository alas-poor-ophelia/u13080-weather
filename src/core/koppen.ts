/**
 * Köppen–Geiger classification from 12 monthly mean temperatures (°C) and
 * 12 monthly precipitation totals (mm).
 *
 * Thresholds follow Peel, Finlayson & McMahon (2007), Hydrol. Earth Syst. Sci.
 * 11:1633–1644, Table 1 — the widely used modern criteria (C/D boundary at
 * 0 °C rather than Köppen's original −3 °C).
 *
 * Months are "calendar" bins: the caller supplies 12 evenly spaced samples
 * of the annual cycle (DESIGN-v1.md §2 "Köppen readout"), and `northern`
 * says which half is summer. Diagnostic only; never feeds generation.
 */
import { evalCurve } from "./curve";
import type { ClimateParams } from "./types";

export interface KoppenResult {
  code: string;
  group: "A" | "B" | "C" | "D" | "E";
  description: string;
}

const DESCRIPTIONS: Record<string, string> = {
  Af: "tropical rainforest",
  Am: "tropical monsoon",
  Aw: "tropical savanna",
  BWh: "hot desert",
  BWk: "cold desert",
  BSh: "hot steppe",
  BSk: "cold steppe",
  Csa: "hot-summer Mediterranean",
  Csb: "warm-summer Mediterranean",
  Csc: "cold-summer Mediterranean",
  Cwa: "monsoon-influenced humid subtropical",
  Cwb: "subtropical highland",
  Cwc: "cold subtropical highland",
  Cfa: "humid subtropical",
  Cfb: "temperate oceanic",
  Cfc: "subpolar oceanic",
  Dsa: "hot-summer Mediterranean continental",
  Dsb: "warm-summer Mediterranean continental",
  Dsc: "dry-summer subarctic",
  Dsd: "extremely cold dry-summer subarctic",
  Dwa: "monsoon-influenced hot-summer continental",
  Dwb: "monsoon-influenced warm-summer continental",
  Dwc: "monsoon-influenced subarctic",
  Dwd: "monsoon-influenced extremely cold subarctic",
  Dfa: "hot-summer humid continental",
  Dfb: "warm-summer humid continental",
  Dfc: "subarctic",
  Dfd: "extremely cold subarctic",
  ET: "tundra",
  EF: "ice cap",
};

/** The class in words — `Cfb` → `oceanic`. The code itself when it is not one of the thirty. */
export function describeKoppen(code: string): string {
  return DESCRIPTIONS[code] ?? code;
}

/**
 * Köppen readout of a zone's resolved climate (DESIGN-v1.md §2): the
 * temperature and precipitation curves sampled at 12 evenly spaced
 * yearPhase bins. Expected precipitation per bin is days × stationary
 * wet-day probability (pwd / (1 − pww + pwd)) × mean wet-day amount
 * (gamma shape × scale). Hemisphere comes from the coldest-day phase.
 * Diagnostic only; never feeds generation.
 */
export function koppenOfClimate(climate: ClimateParams): KoppenResult {
  const tempC: number[] = [];
  const precipMm: number[] = [];
  const p = climate.precipitation;
  const daysPerBin = 365.25 / 12;
  for (let i = 0; i < 12; i++) {
    const t = (i + 0.5) / 12;
    tempC.push(evalCurve(climate.temperature.mean, t));
    const pww = evalCurve(p.pww, t);
    const pwd = evalCurve(p.pwd, t);
    const denom = 1 - pww + pwd;
    const piWet = denom <= 0 ? 0 : pwd / denom;
    precipMm.push(Math.max(0, daysPerBin * piWet * evalCurve(p.shape, t) * evalCurve(p.scale, t)));
  }
  const coldest = climate.temperature.phase;
  const northern = coldest < 0.25 || coldest >= 0.75;
  return classifyKoppen(tempC, precipMm, northern);
}

export function classifyKoppen(tempC: readonly number[], precipMm: readonly number[], northern: boolean): KoppenResult {
  if (tempC.length !== 12 || precipMm.length !== 12) throw new RangeError("classifyKoppen: need 12 monthly values each");
  const T = tempC as number[];
  const P = precipMm as number[];
  const MAT = T.reduce((a, b) => a + b, 0) / 12;
  const MAP = P.reduce((a, b) => a + b, 0);
  const Tmax = Math.max(...T);
  const Tmin = Math.min(...T);

  // Summer half: Apr–Sep (N) or Oct–Mar (S), by bin index.
  const summerIdx = northern ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winterIdx = northern ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
  const pick = (idx: number[]) => idx.map((i) => P[i]!);
  const Ps = pick(summerIdx);
  const Pw = pick(winterIdx);
  const Psum = Ps.reduce((a, b) => a + b, 0);
  const Pwin = Pw.reduce((a, b) => a + b, 0);
  const Psdry = Math.min(...Ps);
  const Pswet = Math.max(...Ps);
  const Pwdry = Math.min(...Pw);
  const Pwwet = Math.max(...Pw);
  const Pmin = Math.min(...P);
  const monthsAbove10 = T.filter((t) => t >= 10).length;

  const done = (code: string): KoppenResult => ({
    code,
    group: code[0] as KoppenResult["group"],
    description: DESCRIPTIONS[code] ?? code,
  });

  // B first (Peel 2007 evaluation order): dryness threshold: Pthreshold = 2*MAT + {28 | 0 | 14}; B if MAP < 10*Pthreshold
  let Pth = 2 * MAT;
  if (Psum >= 0.7 * MAP) Pth += 28;
  else if (Pwin >= 0.7 * MAP) Pth += 0;
  else Pth += 14;
  if (MAP < 10 * Pth) {
    const w = MAP < 5 * Pth ? "W" : "S";
    const hk = MAT >= 18 ? "h" : "k";
    return done(`B${w}${hk}`);
  }

  // E
  if (Tmax < 10) return done(Tmax >= 0 ? "ET" : "EF");

  // A
  if (Tmin >= 18) {
    if (Pmin >= 60) return done("Af");
    if (Pmin >= 100 - MAP / 25) return done("Am");
    return done("Aw");
  }

  const seasonal = (): string => {
    if (Psdry < 40 && Psdry < Pwwet / 3) return "s";
    if (Pwdry < Pswet / 10) return "w";
    return "f";
  };
  const warmth = (group: "C" | "D"): string => {
    if (Tmax >= 22) return "a";
    if (monthsAbove10 >= 4) return "b";
    if (group === "D" && Tmin < -38) return "d";
    return "c";
  };

  if (Tmin > 0) return done(`C${seasonal()}${warmth("C")}`);
  return done(`D${seasonal()}${warmth("D")}`);
}
