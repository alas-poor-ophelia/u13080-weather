/**
 * The generator upgrade against a real Obsidian (docs/SESHAT-v0.md §17.3 step 3, bead wadjet-9lc): a world on
 * the previous generator (stamped wadjet-gen/0.0.3) with one zone whose modifier window starts on day 73, the
 * exact window edge the 0.0.4 generator moves. The walk reads day 73 through the plugin API, opens Settings,
 * presses Upgrade…, keeps the default range, and checks that day 73 reads the same, the Kept weather row
 * appears and the Generator row is gone.
 *
 * It brings its own world and puts back what it found (the launcher's fixture restore, or no data.json), so it
 * passes filtered (`bun run test:e2e test/e2e/upgrade.e2e.ts`) and in the full walk, in any file order.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PRESETS } from "../../src/generated/presets";
import { zoneFromPreset } from "../../src/plugin/zones";
import { DATA_JSON, installPlugin, launchObsidian, withApp, type Obsidian } from "./obsidian";

let ob: Obsidian;
let sw: Page | undefined;
/** data.json as the launcher left it (the fixture, or none), put back in afterAll */
let found: string | null = null;

const EDGE_DAY = 73;
const TODAY = 400;
const fjord = PRESETS.find((p) => p.id === "fjord-coast")!;
const zone = zoneFromPreset({ name: "Edgewater", preset: fjord, existingIds: new Set() }).zone;
zone.modifiers = [{ id: "edge", when: { yearPhase: [0.2, 0.4] }, apply: [{ param: "temperature.mean", op: "offset", value: 4 }], tag: "edge" }];
const WORLD = {
  worldSeed: "e2e-upgrade",
  generatorVersion: "wadjet-gen/0.0.3",
  currentDayOrdinal: TODAY,
  units: "metric",
  calendar: {
    yearLength: 365,
    epochYear: 1,
    moons: [],
    seasons: [
      { name: "Spring", from: 0 },
      { name: "Summer", from: 0.25 },
      { name: "Autumn", from: 0.5 },
      { name: "Winter", from: 0.75 },
    ],
  },
  zones: [zone],
  overrides: [],
  eras: [],
};

async function reloadWadjet(): Promise<void> {
  await withApp(ob.page, async (app) => {
    if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    await app.plugins.enablePlugin("wadjet");
  });
  await ob.page.waitForFunction(() => (window as unknown as { Wadjet?: { ready?: boolean } }).Wadjet?.ready === true, null, { timeout: 15_000 });
}

const report = (day: number): Promise<string> =>
  withApp(ob.page, (_app, a: { zone: string; day: number }) => JSON.stringify((window as unknown as { Wadjet: { getReport: (z: string, t: { dayOrdinal: number }) => unknown } }).Wadjet.getReport(a.zone, { dayOrdinal: a.day })), { zone: zone.id, day });

async function allNotices(): Promise<string[]> {
  const out: string[] = [];
  for (const w of ob.app.windows()) if (!w.isClosed()) out.push(...(await w.locator(".notice").allTextContents()));
  return out;
}

async function openWadjetSettings(): Promise<Page> {
  await withApp(ob.page, (app) => {
    app.setting.open();
    app.setting.openTabById("wadjet");
  });
  for (let i = 0; i < 40 && !sw; i++) {
    sw = ob.app.windows().find((x) => x !== ob.page && !x.isClosed());
    if (!sw) await ob.page.waitForTimeout(250);
  }
  if (!sw) throw new Error("settings window did not open");
  await sw.locator(".vertical-tab-content .setting-item-heading .setting-item-name:text-is('World')").waitFor({ state: "visible", timeout: 10_000 });
  return sw;
}

const tab = () => sw!.locator(".vertical-tab-content");
const row = (name: string) => tab().locator(`.setting-item:has(> .setting-item-info > .setting-item-name:text-is("${name}"))`);
const modal = () => sw!.locator(".modal-container .modal");

beforeAll(async () => {
  installPlugin();
  ob = await launchObsidian();
  found = existsSync(DATA_JSON) ? readFileSync(DATA_JSON, "utf8") : null;
  writeFileSync(DATA_JSON, JSON.stringify(WORLD, null, 2));
  await reloadWadjet();
});

afterAll(async () => {
  if (ob) {
    await withApp(ob.page, async (app) => {
      app.setting.close();
      if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    }).catch(() => undefined);
    if (found === null) rmSync(DATA_JSON, { force: true });
    else writeFileSync(DATA_JSON, found);
    await ob.close();
  }
});

describe("generator upgrade (wadjet-9lc step 3)", () => {
  let edge = "";

  test("a 0.0.3 world runs the previous generator: the load Notice says so, and the Generator row offers Upgrade…", async () => {
    expect((await allNotices()).some((t) => t.includes("This world keeps the old one (0.0.3), so its weather stays as you saw it, until you upgrade it in Settings → World → Generator."))).toBe(true);
    edge = await report(EDGE_DAY);
    expect(JSON.parse(edge).provenance.generatorVersion).toBe("wadjet-gen/0.0.3");
    await openWadjetSettings();
    expect(await row("Generator").isVisible()).toBe(true);
    expect(await row("Generator").locator(".setting-item-description").textContent()).toBe("This world runs the previous weather generator (0.0.3), so its weather is unchanged. Upgrading changes some days; you can keep the days you have already used.");
    expect(await row("Generator").locator("button:has-text('Acknowledge')").count()).toBe(0);
    expect(await row("Kept weather").isVisible()).toBe(false);
  });

  test("Change calendar… on the previous generator asks to upgrade first (§17.5 item 9)", async () => {
    await tab().locator("button:has-text('Change calendar…')").click();
    await modal().waitFor({ state: "visible", timeout: 5_000 });
    expect(await modal().textContent()).toContain("Upgrade the generator first.");
    expect(await modal().locator("button:has-text('Switch calendar')").count()).toBe(0);
    await modal().locator("button:has-text('Cancel')").click();
    await modal().waitFor({ state: "detached", timeout: 5_000 });
  });

  test("Upgrade…, keep the default year, Keep and upgrade: the edge day reads the same, the Kept weather row appears, the Generator row goes", async () => {
    await row("Generator").locator("button:has-text('Upgrade…')").click();
    const dialog = modal().filter({ hasText: "Keep the weather from" });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    // the default start: one year before the current day, as the calendar writes it
    const fmt = (d: number) => withApp(ob.page, (_app, n: number) => (window as unknown as { Wadjet: { format: (d: number) => string } }).Wadjet.format(n), d);
    expect(await dialog.locator("input[type='text']").inputValue()).toBe(await fmt(TODAY - 365));
    const status = dialog.locator(".wadjet-upgrade-status");
    await expect.poll(async () => (await status.textContent()) ?? "", { timeout: 15_000 }).toBe("2 days in 1 zone will be kept; the rest come out the same.");

    await dialog.locator("button.mod-cta:has-text('Keep and upgrade')").click();
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    await expect.poll(async () => (await allNotices()).some((t) => t.includes("This world now runs the new weather generator (0.0.4). 2 days kept from the previous generator.")), { timeout: 5_000 }).toBe(true);

    expect(await report(EDGE_DAY)).toBe(edge);
    const saved = JSON.parse(readFileSync(DATA_JSON, "utf8")) as { generatorVersion: string; frozen: Array<{ dayOrdinal: number }> };
    expect(saved.generatorVersion).toBe("wadjet-gen/0.0.4");
    expect(saved.frozen.map((f) => f.dayOrdinal)).toEqual([EDGE_DAY, 146]);

    await expect.poll(() => row("Kept weather").isVisible(), { timeout: 5_000 }).toBe(true);
    expect(await row("Kept weather").locator(".setting-item-description").textContent()).toBe(`2 days kept from the previous generator (from ${await fmt(EDGE_DAY)} to ${await fmt(146)}). Editing a zone's climate does not change them.`);
    expect(await row("Generator").isVisible()).toBe(false);
    // kept days are not pins
    expect(await tab().locator(".setting-group.mod-list:has(.setting-item-heading .setting-item-name:text-is('Pinned days')) .setting-item.mod-empty-state").count()).toBe(1);
  });

  test("Remove asks first, then the kept weather goes and the edge day shows the new generator", async () => {
    await row("Kept weather").locator("button:has-text('Remove')").click();
    const confirm = modal().filter({ hasText: "Remove the kept weather?" });
    await confirm.waitFor({ state: "visible", timeout: 5_000 });
    expect(await confirm.textContent()).toContain("The 2 kept days show the generator's weather again.");
    await confirm.locator("button:has-text('Remove')").click();
    await confirm.waitFor({ state: "detached", timeout: 5_000 });
    await expect.poll(() => row("Kept weather").isVisible(), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => (JSON.parse(readFileSync(DATA_JSON, "utf8")) as { frozen: unknown[] }).frozen.length, { timeout: 5_000 }).toBe(0);
    const now = JSON.parse(await report(EDGE_DAY)) as { provenance: { generatorVersion: string } };
    expect(now.provenance.generatorVersion).toBe("wadjet-gen/0.0.4");
    expect(JSON.stringify(now)).not.toBe(edge);
    expect(ob.errors.filter((e) => e.includes("U+13080") || e.includes("Wadjet"))).toEqual([]);
  });
});
