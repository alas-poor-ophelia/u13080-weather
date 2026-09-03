import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { installPlugin, launchObsidian, withApp, DATA_JSON } from "./obsidian";

const AUDIT = "C:/Dev/U+13080/docs/handoff/climate-studio/audit";
const OUT = path.join(AUDIT, "shots-probe-cycle");
const SEL = ".workspace-leaf-content[data-type='wadjet-studio']";

async function boot(world: string) {
  installPlugin();
  const ob = await launchObsidian();
  cpSync(world, DATA_JSON);
  await withApp(ob.page, async (app) => {
    if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    await app.plugins.enablePlugin("wadjet");
  });
  await ob.page.waitForFunction(() => (window as any).Wadjet?.ready === true, null, { timeout: 15_000 });
  await withApp(ob.page, (app) => app.workspace.leftSplit.collapse());
  await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:open-studio"));
  const prompt = ob.page.locator(".modal-container .prompt");
  try { await prompt.waitFor({ state: "visible", timeout: 4_000 }); await prompt.locator(".suggestion-item").first().click(); } catch {}
  await ob.page.waitForSelector(SEL, { timeout: 15_000 });
  await ob.page.waitForTimeout(1000);
  return ob;
}
const openWins = (ob: any) => ob.page.evaluate(() => Array.from(document.querySelectorAll(".wadjet-studio-window")).map((w: any) => (w.getAttribute("data-window") ?? w.className) + " :: " + (w.querySelector(".wadjet-studio-window-title, .wadjet-studio-window-name")?.textContent ?? "").slice(0, 40)));

test.skipIf(process.env["WADJET_PROBE"] !== "1")("probe cycle window reachability", async () => {
  mkdirSync(OUT, { recursive: true });
  // --- audit world ---
  let ob = await boot(path.join(AUDIT, "world.json"));
  console.log("AUDIT day-card moon elements:", await ob.page.evaluate(() => Array.from(document.querySelectorAll("[class*='moon'], [data-part*='moon']")).map((e: any) => e.tagName + "." + e.className.toString().slice(0, 60) + " part=" + e.getAttribute("data-part")).slice(0, 15)));
  await withApp(ob.page, (app) => { const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0]; leaf.view.store.update((s: any) => { s.view.windowPos["device:sable-stormtide"] = { x: 40, y: 40, z: 60 }; }); leaf.view.windows.open("device:sable-stormtide"); });
  await ob.page.waitForTimeout(600);
  console.log("AUDIT wins after device open:", await openWins(ob));
  await withApp(ob.page, (app) => {
    const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0];
    const w = leaf.view.windows; const orig = w.open.bind(w);
    (window as any).__opens = [];
    w.open = (id: string, b?: unknown) => { (window as any).__opens.push(id + (b ? "+builder" : "")); return orig(id, b); };
  });
  const opens = () => ob.page.evaluate(() => JSON.stringify((window as any).__opens));
  const chips = await ob.page.evaluate(() => Array.from(document.querySelectorAll(".wadjet-studio-chip")).filter((e: any) => e.textContent.includes("moon:Sable")).map((e: any, i) => ({ i, text: e.textContent.trim(), role: e.getAttribute("role"), inWindow: !!e.closest(".wadjet-studio-window"), container: (e.closest(".wadjet-studio-window,.wadjet-studio-mixer,.wadjet-studio-playlist,.wadjet-studio-strip"))?.className.split(" ")[0] })));
  console.log("AUDIT moon chips:", JSON.stringify(chips));
  const winChips = ob.page.locator(`.wadjet-studio-window .wadjet-studio-chip:has-text("moon:Sable")`);
  const n = await winChips.count();
  for (let i = 0; i < n; i++) {
    await winChips.nth(i).click(); await ob.page.waitForTimeout(600);
    console.log(`AUDIT after window chip ${i} click: wins=${JSON.stringify(await openWins(ob))} opens=${await opens()}`);
    await withApp(ob.page, (app) => { const v = app.workspace.getLeavesOfType("wadjet-studio")[0].view; try { v.windows.close("cycle:Sable"); } catch {} });
    await ob.page.waitForTimeout(300);
  }
  const gate = ob.page.locator(".wadjet-studio-window svg circle, .wadjet-studio-window [class*='gate']").first();
  console.log("AUDIT gate el:", await gate.count(), await gate.count() ? await gate.evaluate((e: any) => e.tagName + "." + e.getAttribute("class")) : "");
  if (await gate.count()) { await gate.click({ force: true }); await ob.page.waitForTimeout(600); console.log(`AUDIT after gate click: wins=${JSON.stringify(await openWins(ob))} opens=${await opens()}`); }
  // day card at Day zoom
  await ob.page.locator(`${SEL} .wadjet-studio-segment:has-text("Day")`).first().click(); await ob.page.waitForTimeout(800);
  const dayMoon = await ob.page.evaluate(() => Array.from(document.querySelectorAll("[class*='day-card'] svg, [class*='daycard'] svg, [class*='day'] svg")).map((e: any) => e.getAttribute("class") + " parent=" + e.parentElement.className.toString().slice(0, 50)).slice(0, 6));
  console.log("AUDIT day-card svgs:", JSON.stringify(dayMoon));
  const dm = ob.page.locator("[class*='day-card'] svg, [class*='daycard'] svg").first();
  if (await dm.count()) { await dm.click({ force: true }); await ob.page.waitForTimeout(600); console.log(`AUDIT after day moon click: wins=${JSON.stringify(await openWins(ob))} opens=${await opens()}`); }
  await ob.page.screenshot({ path: path.join(OUT, "audit-day-zoom.png") });
  await withApp(ob.page, (app) => { const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0]; leaf.view.windows.open("cycle:Sable"); });
  await ob.page.waitForTimeout(600);
  console.log("AUDIT wins after direct open:", JSON.stringify(await openWins(ob)));
  await ob.page.screenshot({ path: path.join(OUT, "audit-after-chip.png") });
  const disc = ob.page.locator(`${SEL} [data-part*="gate"], ${SEL} .wadjet-studio-device-gate, ${SEL} [class*="moon-disc"], ${SEL} [class*="gate-disc"]`).first();
  console.log("AUDIT gate disc count:", await disc.count(), await disc.count() ? await disc.evaluate((e: any) => e.className.toString()) : "");
  console.log("PAGE ERRORS:", JSON.stringify(ob.errors.slice(0, 5)));
  await ob.close();
  // --- Guildmaster world ---
  ob = await boot(path.join(AUDIT, "gm-data.json"));
  await ob.page.screenshot({ path: path.join(OUT, "gm-default.png") });
  console.log("GM rows:", await ob.page.evaluate(() => Array.from(document.querySelectorAll(".wadjet-studio-row-label, [class*='row-name'], [class*='lane-label']")).map((e: any) => e.textContent.trim().slice(0, 30)).slice(0, 20)));
  console.log("GM moon-ish elements:", await ob.page.evaluate(() => Array.from(document.querySelectorAll("[class*='moon'], [data-part*='moon'], [class*='cycle']")).map((e: any) => e.tagName + "." + e.className.toString().slice(0, 60)).slice(0, 15)));
  try {
    await withApp(ob.page, (app) => { const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0]; leaf.view.store.update((s: any) => { s.view.windowPos["cycle:Moon"] = { x: 40, y: 40, z: 60 }; }); leaf.view.windows.open("cycle:Moon"); });
    await ob.page.waitForTimeout(800);
    console.log("GM wins after cycle:Moon open:", await openWins(ob));
    await ob.page.screenshot({ path: path.join(OUT, "gm-cycle-Moon.png") });
  } catch (e) { console.log("GM cycle open FAIL", String(e).slice(0, 300)); }
  console.log("PAGE ERRORS:", JSON.stringify(ob.errors.slice(0, 5)));
  await ob.close();
}, 300_000);
