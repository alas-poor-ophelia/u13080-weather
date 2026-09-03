/**
 * Screenshot gate for the GENERIC device window (bead wadjet-9f9.48.8): the
 * window every inserted device opens in. One shot per picker kind, then one
 * per WHEN mode on the moon kind, then the spell toggle on — matching
 * docs/handoff/climate-studio/audit/proto-win-device-*.png (proto3.mjs).
 *
 * Skipped unless WADJET_SHOTS=1. WADJET_SHOT_DIR picks the folder.
 */
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { installPlugin, launchObsidian, withApp, DATA_JSON } from "./obsidian";

const AUDIT = "C:/Dev/U+13080/docs/handoff/climate-studio/audit";
const OUT = process.env["WADJET_SHOT_DIR"] ?? path.join(AUDIT, "shots-generic");
const SEL = ".workspace-leaf-content[data-type='wadjet-studio']";
const KINDS = ["trim", "moon", "spell", "tag", "chance"];
const WHEN = ["always", "moon", "tag", "yearWindow", "chance"];

test.skipIf(process.env["WADJET_SHOTS"] !== "1")("screenshot the generic device window", async () => {
  mkdirSync(OUT, { recursive: true });
  installPlugin();
  const ob = await launchObsidian();
  cpSync(path.join(AUDIT, "world.json"), DATA_JSON);
  await ob.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.setSize(1600, 1000); });
  await withApp(ob.page, async (app) => { if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet"); await app.plugins.enablePlugin("wadjet"); });
  await ob.page.waitForFunction(() => (window as any).Wadjet?.ready === true, null, { timeout: 15_000 });
  await withApp(ob.page, (app) => app.workspace.leftSplit.collapse());
  await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:open-studio"));
  const prompt = ob.page.locator(".modal-container .prompt");
  try { await prompt.waitFor({ state: "visible", timeout: 4_000 }); await prompt.locator(".suggestion-item").first().click(); } catch { /* one zone */ }
  await ob.page.waitForSelector(SEL, { timeout: 15_000 });
  await ob.page.waitForTimeout(1200);
  const shot = (n: string) => ob.page.screenshot({ path: path.join(OUT, `real-win-device-${n}.png`) });
  const openDeviceIds = () => withApp(ob.page, (app) => (app.workspace.getLeavesOfType("wadjet-studio")[0].view.store.get().view.openWindows as string[]).filter((id) => id.startsWith("device:")));
  const closeAll = async () => { for (const id of await openDeviceIds()) await withApp(ob.page, (app, a: { id: string }) => { app.workspace.getLeavesOfType("wadjet-studio")[0].view.windows.close(a.id); }, { id }); await ob.page.waitForTimeout(300); };
  const place = async () => { const ids = await openDeviceIds(); const id = ids[ids.length - 1]; if (!id) return; await withApp(ob.page, (app, a: { id: string }) => { const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0]; leaf.view.store.update((s: any) => { s.view.windowPos[a.id] = { x: 40, y: 40, z: 60 }; }); }, { id }); await ob.page.waitForTimeout(400); };
  const insert = async (kind: string) => {
    await closeAll();
    await ob.page.locator(`${SEL} .wadjet-studio-mixer-add`).first().click();
    await ob.page.waitForTimeout(400);
    await ob.page.locator(`.wadjet-studio-insert-row[data-kind="${kind}"]`).first().click();
    await ob.page.waitForTimeout(800);
    await place();
  };
  for (const k of KINDS) { await insert(k); await shot(`kind-${k}`); }
  await insert("moon");
  for (const w of WHEN) {
    try { await ob.page.locator(`.wadjet-studio-window [data-part="when-kind"] [role=radio][data-value="${w}"]`).first().click(); await ob.page.waitForTimeout(600); await shot(`when-${w}`); } catch (e) { console.log("WHEN FAIL", w, String(e).slice(0, 160)); }
  }
  try { await ob.page.locator('.wadjet-studio-window [data-part="spell-power"]').first().click(); await ob.page.waitForTimeout(600); await shot("spell-on"); } catch (e) { console.log("SPELL FAIL", String(e).slice(0, 160)); }
  console.log("PAGE ERRORS:", JSON.stringify(ob.errors.slice(0, 5)));
  await ob.close();
}, 300_000);
