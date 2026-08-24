/**
 * Shared golden-master builder/comparer. Integer outputs (hash32, hash53)
 * must match EXACTLY. Float outputs (uniform, normal, gamma) must match to
 * 1e-12 relative — see the cross-engine note in src/core/rng.ts.
 */
import type * as Rng from "../../src/core/rng";

export interface Golden {
  rngVersion: string;
  hash: Array<{ key: string; seed: number; h32: number; h53: number; u: number }>;
  streams: Array<{
    key: string;
    uniforms: number[];
    normals: number[];
    gammas: Array<{ shape: number; scale: number; values: number[] }>;
    bernoulli: { p: number; values: boolean[] };
    geometric: { mean: number; values: number[] };
    weighted: { weights: number[]; values: number[] };
  }>;
}

const US = String.fromCharCode(0x1f);

const HASH_KEYS: Array<[string, number]> = [
  ["", 0],
  [" ", 0],
  ["a", 0],
  ["ab", 0],
  ["abc", 0],
  ["abc", 1],
  ["abc", 0xffffffff],
  ["The quick brown fox jumps over the lazy dog", 0],
  ["ünïcødé ☂ 雨", 0],
  [US, 0],
  [`seed${US}zone${US}0${US}wet`, 0],
  [`seed${US}zone${US}-1${US}wet`, 0],
  [`seed${US}zone${US}1000000${US}wet`, 0],
];

const STREAM_KEYS = ["golden-stream-a", "golden-stream-b", US, "a very long key ".repeat(16)];

export function buildGolden(r: typeof Rng): Golden {
  const hash = HASH_KEYS.map(([key, seed]) => ({ key, seed, h32: r.hash32(key, seed), h53: r.hash53(key), u: r.uniform(key) }));
  const dk = r.drawKey("world-seed", "greywold", 12345, "wet");
  hash.push({ key: dk, seed: 0, h32: r.hash32(dk), h53: r.hash53(dk), u: r.uniform(dk) });

  const streams = STREAM_KEYS.map((key) => {
    const take = (n: number, f: (s: Rng.DrawStream) => number) => {
      const s = new r.DrawStream(key);
      return Array.from({ length: n }, () => f(s));
    };
    const bern = new r.DrawStream(key);
    const geo = new r.DrawStream(key);
    const wi = new r.DrawStream(key);
    return {
      key,
      uniforms: take(16, (s) => s.next()),
      normals: take(16, (s) => r.normal(s)),
      gammas: [
        { shape: 0.5, scale: 1, values: take(12, (s) => r.gamma(s, 0.5, 1)) },
        { shape: 0.792, scale: 6.3, values: take(12, (s) => r.gamma(s, 0.792, 6.3)) },
        { shape: 2.5, scale: 3, values: take(12, (s) => r.gamma(s, 2.5, 3)) },
      ],
      bernoulli: { p: 0.3, values: Array.from({ length: 32 }, () => r.bernoulli(bern, 0.3)) },
      geometric: { mean: 12, values: Array.from({ length: 16 }, () => r.geometricDuration(geo, 12)) },
      weighted: { weights: [0.7, 0, 0.15, 0.15], values: Array.from({ length: 32 }, () => r.weightedIndex(wi, [0.7, 0, 0.15, 0.15])) },
    };
  });

  return { rngVersion: r.RNG_VERSION, hash, streams };
}

const REL_TOL = 1e-12;
function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-300);
  return Math.abs(a - b) / scale <= REL_TOL;
}

/** Returns a list of human-readable differences; empty means identical. */
export function compareGolden(stored: Golden, fresh: Golden): string[] {
  const out: string[] = [];
  if (stored.rngVersion !== fresh.rngVersion) out.push(`rngVersion: ${stored.rngVersion} -> ${fresh.rngVersion}`);
  if (stored.hash.length !== fresh.hash.length) out.push(`hash case count: ${stored.hash.length} -> ${fresh.hash.length}`);
  stored.hash.forEach((s, i) => {
    const f = fresh.hash[i];
    if (!f) return;
    if (s.h32 !== f.h32) out.push(`hash32(${JSON.stringify(s.key)}, ${s.seed}): ${s.h32} -> ${f.h32}`);
    if (s.h53 !== f.h53) out.push(`hash53(${JSON.stringify(s.key)}): ${s.h53} -> ${f.h53}`);
    if (!closeEnough(s.u, f.u)) out.push(`uniform(${JSON.stringify(s.key)}): ${s.u} -> ${f.u}`);
  });
  stored.streams.forEach((s, i) => {
    const f = fresh.streams[i];
    if (!f) {
      out.push(`stream ${i} missing`);
      return;
    }
    const k = JSON.stringify(s.key.slice(0, 24));
    s.uniforms.forEach((v, j) => {
      if (!closeEnough(v, f.uniforms[j]!)) out.push(`${k} uniform[${j}]: ${v} -> ${f.uniforms[j]}`);
    });
    s.normals.forEach((v, j) => {
      if (!closeEnough(v, f.normals[j]!)) out.push(`${k} normal[${j}]: ${v} -> ${f.normals[j]}`);
    });
    s.gammas.forEach((g, gi) =>
      g.values.forEach((v, j) => {
        if (!closeEnough(v, f.gammas[gi]!.values[j]!)) out.push(`${k} gamma(${g.shape},${g.scale})[${j}]: ${v} -> ${f.gammas[gi]!.values[j]}`);
      }),
    );
    s.bernoulli.values.forEach((v, j) => {
      if (v !== f.bernoulli.values[j]) out.push(`${k} bernoulli[${j}]: ${v} -> ${f.bernoulli.values[j]}`);
    });
    s.geometric.values.forEach((v, j) => {
      if (v !== f.geometric.values[j]) out.push(`${k} geometric[${j}]: ${v} -> ${f.geometric.values[j]}`);
    });
    s.weighted.values.forEach((v, j) => {
      if (v !== f.weighted.values[j]) out.push(`${k} weighted[${j}]: ${v} -> ${f.weighted.values[j]}`);
    });
  });
  return out;
}
