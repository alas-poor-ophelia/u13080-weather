/**
 * Minimal launcher for a real Obsidian instance driven by Playwright.
 *
 * - Runs the installed Obsidian's app.asar under the npm `electron` binary.
 * - Uses a throwaway --user-data-dir in TEMP, so it never collides with the
 *   user's running Obsidian (single-instance lock is per data dir).
 * - Opens the vault IN PLACE (no copy). Point WADJET_E2E_VAULT at a vault;
 *   default is the fixture vault in test/e2e/vault.
 * - `withApp(page, fn, args)` evaluates `fn(window.app, args)` inside the
 *   vault window. `fn` is serialised with toString(): it must not close over
 *   outer variables — pass them through `args`.
 *
 * Node-only (vitest). Not part of `bun test`.
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const VAULT = path.resolve(process.env["WADJET_E2E_VAULT"] ?? path.join(HERE, "vault"));
export const PLUGIN_DIR = path.join(VAULT, ".obsidian", "plugins", "wadjet");

export interface Obsidian {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  /** uncaught exceptions + console.error lines seen in the vault window */
  errors: string[];
  close(): Promise<void>;
}

function obsidianAsar(): string {
  if (process.platform === "win32") {
    return path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Obsidian", "resources", "app.asar");
  }
  for (const d of ["/opt/Obsidian", "/usr/lib/Obsidian", "/opt/obsidian", "/usr/lib/obsidian"]) {
    if (existsSync(d)) return path.join(d, "resources", "app.asar");
  }
  throw new Error("Obsidian install not found");
}

function newestAppAsar(): string | null {
  const dir = process.platform === "win32" ? path.join(process.env["APPDATA"] ?? "", "obsidian") : path.join(process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"), "obsidian");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .map((f) => f.match(/^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ file: m[0], v: [Number(m[1]), Number(m[2]), Number(m[3])] as const }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return versions[0] ? path.join(dir, versions[0].file) : null;
}

/** Copy the built plugin (main.js, manifest.json, styles.css) into the vault. */
export function installPlugin(): void {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    const src = path.join(REPO_ROOT, f);
    if (!existsSync(src)) throw new Error(`${f} missing — run \`bun run build\` first`);
    cpSync(src, path.join(PLUGIN_DIR, f));
  }
}

export async function launchObsidian(): Promise<Obsidian> {
  const asar = obsidianAsar();
  if (!existsSync(asar)) throw new Error(`Obsidian app.asar not found at ${asar}`);
  if (!existsSync(VAULT)) throw new Error(`vault not found: ${VAULT}`);

  const dataDir = path.join(os.tmpdir(), "wadjet-e2e-" + randomBytes(4).toString("hex"));
  mkdirSync(dataDir, { recursive: true });
  // The installer's app.asar only bootstraps; the real app code is the newest
  // `obsidian-<version>.asar` in the user data dir, downloaded by auto-update.
  // A fresh data dir has none, so the OLD bundled app would run (no 1.13 API).
  // Carry the user's newest downloaded app asar across.
  const appAsar = newestAppAsar();
  if (appAsar) {
    cpSync(appAsar, path.join(dataDir, path.basename(appAsar)));
    console.log(`  · app asar: ${path.basename(appAsar)}`);
  } else {
    console.warn("  · no downloaded obsidian-*.asar found; the installer-bundled app version will run");
  }
  const hash = randomBytes(8).toString("hex");
  writeFileSync(path.join(dataDir, "obsidian.json"), JSON.stringify({ vaults: { [hash]: { path: VAULT, ts: Date.now() } } }));
  writeFileSync(path.join(dataDir, `${hash}.json`), "{}");

  const quiet = process.env["WADJET_E2E_VISIBLE"] ? [] : ["--require", path.join(HERE, "quiet-launch.cjs"), "--disable-features=CalculateNativeWinOcclusion"];
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
  const app = await electron.launch({ timeout: 60_000, args: [...quiet, asar, `--user-data-dir=${dataDir}`, `obsidian://open?vault=${hash}`] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const errors: string[] = [];
  page.on("pageerror", (e) => {
    errors.push(`pageerror: ${e.message}`);
    console.log(`  ! pageerror: ${e.message.slice(0, 160)}`); // logged live so vitest attributes it to the running test
  });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  // A fresh data dir means the vault is untrusted: Obsidian may show a
  // "restricted mode" / "trust vault" modal. Click through it if present,
  // then close the settings window it tends to open.
  try {
    const btn = page.locator('.modal-button-container button:has-text("Turn off"), .modal-button-container button:has-text("Enable"), .modal-button-container button:has-text("Trust")');
    await btn.first().waitFor({ state: "visible", timeout: 5_000 });
    await btn.first().click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } catch {
    /* no modal — fine */
  }

  await page.waitForFunction(() => (window as unknown as { app?: { workspace?: { layoutReady?: boolean } } }).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
  // Make sure community plugins are allowed (restricted mode off), in-memory only.
  await withApp(page, async (app) => {
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
  });
  // The vault's own plugins load asynchronously after that; some open a
  // settings tab or onboarding modal on first run in a fresh data dir, which
  // would yank the floor out from under a settings-driven test. Wait for them
  // all, then close anything they opened.
  await page.waitForFunction(
    () => {
      const p = (window as unknown as { app: { plugins: { enabledPlugins: Set<string>; plugins: Record<string, unknown> } } }).app.plugins;
      return [...p.enabledPlugins].every((id) => id in p.plugins);
    },
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1_000);
  await withApp(page, (app) => app.setting.close());
  await page.keyboard.press("Escape");

  return {
    app,
    page,
    dataDir,
    errors,
    close: async () => {
      await app.close();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    },
  };
}

export type ObsidianApp = any;

export async function withApp<T, A = undefined>(page: Page, fn: (app: ObsidianApp, args: A) => T | Promise<T>, args?: A): Promise<T> {
  return (await page.evaluate(
    async ({ src, args }) => {
      const f = new Function("args", `return ((${src}))(window.app, args)`) as (a: unknown) => unknown;
      return await f(args);
    },
    { src: fn.toString(), args },
  )) as T;
}

/** Text of every visible Obsidian Notice. */
export async function notices(page: Page): Promise<string[]> {
  return page.locator(".notice").allTextContents();
}
