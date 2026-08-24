/**
 * Bump the plugin version in one move: manifest.json, package.json, versions.json.
 *
 *   bun run bump 0.1.0            # sets the version; versions.json maps it to manifest.minAppVersion
 *   bun run bump 0.1.0 --min 1.13.0   # also raises minAppVersion
 *
 * Then: commit, `git tag <version>` (bare — the Obsidian store requires tag == manifest version),
 * push the tag, and .github/workflows/release.yml does the rest. Refuses to lower a version and
 * refuses a version that is not semver.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [version, ...rest] = process.argv.slice(2);
const minFlag = rest.indexOf("--min");
const minAppVersion = minFlag >= 0 ? rest[minFlag + 1] : undefined;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
if (!version || !SEMVER.test(version)) {
  console.error("usage: bun run bump <semver> [--min <obsidian version>]");
  process.exit(2);
}

const cmp = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
const write = (f: string, v: unknown) => writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

const manifest = read("manifest.json");
const pkg = read("package.json");
const versions = read("versions.json") as Record<string, string>;

if (cmp(version, String(manifest.version)) < 0) {
  console.error(`refusing to go backwards: manifest is ${String(manifest.version)}, asked for ${version}`);
  process.exit(1);
}

manifest.version = version;
if (minAppVersion) manifest.minAppVersion = minAppVersion;
pkg.version = version;
versions[version] = String(manifest.minAppVersion);

write("manifest.json", manifest);
write("package.json", pkg);
write("versions.json", versions);
console.log(`${version} (minAppVersion ${String(manifest.minAppVersion)}) → manifest.json, package.json, versions.json`);
console.log(`next: git commit -am "Release ${version}" && git tag ${version} && git push && git push origin ${version}`);
