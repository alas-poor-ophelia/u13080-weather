/**
 * Minimal launcher for a real Obsidian instance driven by Playwright.
 *
 * - Runs the installed Obsidian's app.asar under the npm `electron` binary.
 * - Uses a throwaway --user-data-dir in TEMP, so it never collides with the
 *   user's running Obsidian (single-instance lock is per data dir).
 * - Opens the vault IN PLACE (no copy). Point WADJET_E2E_VAULT at a vault;
 *   default is the fixture vault in test/e2e/vault.
 * - Deletes the vault's `.obsidian/workspace*.json` ONCE, at the first launch
 *   of a run (H-1380 / H-1381): the vault is opened in place, so a window test
 *   that fails mid-way leaves its open studio panels in persisted view state
 *   and the NEXT run starts with stray floating windows over the header.
 *   Persistence WITHIN a run is untouched, which two steps depend on —
 *   `studio.e2e.ts` step 4 restarts Obsidian and asserts the studio leaf and
 *   its window come back, and `smoke.e2e.ts` does the same for the settings.
 * - Restores the plugin's `data.json` from the committed `data.fixture.json`
 *   ONCE, at the first launch of a run, for the same reason: the walks WRITE
 *   the world (Save is a real disk write), so a second run over the same vault
 *   would otherwise inherit the first run's zones, pins, layers and eras. The
 *   vault's `.obsidian/plugins/` tree is gitignored, so the pristine copy lives
 *   next to this file as `test/e2e/data.fixture.json` and is committed there.
 *   The reset never CREATES a data.json where one is missing: `smoke.e2e.ts`
 *   deliberately deletes it in its own `beforeAll` to prove the world seed is
 *   generated fresh, and putting a seeded world back under it would fail
 *   exactly the thing it is testing. `studio.e2e.ts` asks for the copy
 *   explicitly (`resetPluginData({ force: true })`) so its walk starts from the
 *   fixture whether or not the smoke walk ran first.
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
/** The plugin's persisted world inside the vault. Written by every Save. */
export const DATA_JSON = path.join(PLUGIN_DIR, "data.json");
/** The committed pristine world the fixture vault's walks start from. See `resetPluginData`. */
export const DATA_FIXTURE = path.join(HERE, "data.fixture.json");

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

/** One reset per process, at the first `launchObsidian()`. See `resetWorkspaceState`. */
let workspaceReset = false;
/** One reset per process, at the first `launchObsidian()`. See `resetPluginData`. */
let pluginDataReset = false;

/**
 * Put the plugin's persisted world back to the committed fixture (H-1393).
 *
 * The harness opens the vault IN PLACE and the walks Save for real, so without
 * this a run inherits the previous run's world: leftover `layer:*` modifiers on
 * a zone the next walk expects neutral, a device the atlas walk overwrote, pins
 * an audition step counted, eras a lane step counts spans for.
 *
 * Unforced (the once-per-process call inside `launchObsidian`) it is a
 * *restore*, never a create: a walk that removed `data.json` on purpose —
 * `smoke.e2e.ts`, proving the world seed is generated fresh — keeps its empty
 * world. `studio.e2e.ts` forces it in its own `beforeAll`, so its walk starts
 * from the fixture no matter which file ran before it.
 */
export function resetPluginData(o: { force?: boolean } = {}): boolean {
  if (o.force !== true) {
    if (pluginDataReset) return false;
    pluginDataReset = true;
    if (!existsSync(DATA_JSON)) return false;
  }
  if (!existsSync(DATA_FIXTURE)) throw new Error(`e2e world fixture missing: ${DATA_FIXTURE}`);
  mkdirSync(PLUGIN_DIR, { recursive: true });
  cpSync(DATA_FIXTURE, DATA_JSON);
  console.log("  · reset persisted world: .obsidian/plugins/wadjet/data.json ← data.fixture.json");
  return true;
}

/**
 * Drop the vault's persisted workspace layout (H-1380 / H-1381).
 *
 * Obsidian writes `workspace.json` (and `workspace-mobile.json`) into the
 * vault itself, and the harness opens the vault in place. A studio leaf saves
 * its `openWindows` there, so a window test that fails before it closes its
 * panel hands the stray window to whatever runs first next time — a floating
 * panel over the header intercepts the transport clicks.
 *
 * Once per process, NOT on every launch: a walk that restarts Obsidian mid-run
 * is usually asserting that persisted state survives the restart
 * (`studio.e2e.ts` step 4, `smoke.e2e.ts`'s last step), and wiping the layout
 * under it would fail exactly the thing it is testing.
 */
function resetWorkspaceState(): void {
  if (workspaceReset) return;
  workspaceReset = true;
  const dir = path.join(VAULT, ".obsidian");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!/^workspace.*\.json$/.test(f)) continue;
    rmSync(path.join(dir, f), { force: true });
    console.log(`  · reset persisted layout: .obsidian/${f}`);
  }
}

export async function launchObsidian(o: { extraArgs?: string[] } = {}): Promise<Obsidian> {
  const asar = obsidianAsar();
  if (!existsSync(asar)) throw new Error(`Obsidian app.asar not found at ${asar}`);
  if (!existsSync(VAULT)) throw new Error(`vault not found: ${VAULT}`);
  resetWorkspaceState();
  resetPluginData();

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
  const app = await electron.launch({ timeout: 60_000, args: [...quiet, ...(o.extraArgs ?? []), asar, `--user-data-dir=${dataDir}`, `obsidian://open?vault=${hash}`] });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Obsidian can put a native dialog up on the way out ("save your changes?").
  // Playwright auto-dismisses dialogs when nothing is listening, and if the
  // window has already gone by then the dismiss rejects with "No dialog is
  // showing" — an unhandled rejection vitest counts against the run. Owning
  // the dialog lets that race be swallowed where it happens.
  const onDialog = (d: { dismiss(): Promise<void> }): void => void d.dismiss().catch(() => undefined);
  app.on("window", (w) => w.on("dialog", onDialog));
  page.on("dialog", onDialog);

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
