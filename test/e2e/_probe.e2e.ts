import { cpSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { installPlugin, launchObsidian, withApp, DATA_JSON } from "./obsidian";

const AUDIT = "C:/Dev/U+13080/docs/handoff/climate-studio/audit";
const SEL = ".workspace-leaf-content[data-type='wadjet-studio']";
const WINDOWS = ["regimes", "device:sable-stormtide", "channel:temperature", "atlas"];

test.skipIf(process.env["WADJET_PROBE"] !== "1")("probe knob arcs on first paint", async () => {
  installPlugin();
  const ob = await launchObsidian();
  cpSync(path.join(AUDIT, "world.json"), DATA_JSON);
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
  for (const id of WINDOWS) {
    await withApp(ob.page, (app, a: { id: string }) => {
      const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0];
      leaf.view.store.update((s: any) => { s.view.windowPos[a.id] = { x: 40, y: 40, z: 60 }; });
      leaf.view.windows.open(a.id);
    }, { id });
    await ob.page.waitForTimeout(600);
    const rows = await ob.page.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll(".wadjet-studio-knob").forEach((k) => {
        const arc = k.querySelector(".wadjet-studio-knob-arc");
        const track = k.querySelector(".wadjet-studio-knob-track");
        const r = arc?.getBoundingClientRect();
        const t = track?.getBoundingClientRect();
        out.push({
          label: k.querySelector(".wadjet-studio-knob-label")?.textContent,
          value: k.querySelector(".wadjet-studio-knob-value")?.textContent,
          d: arc?.getAttribute("d") ?? null,
          arcBox: r ? [Math.round(r.width), Math.round(r.height)] : null,
          trackBox: t ? [Math.round(t.width), Math.round(t.height)] : null,
          stroke: arc ? getComputedStyle(arc).stroke : null,
          connected: arc?.isConnected,
        });
      });
      return out;
    });
    console.log("=== WINDOW", id);
    for (const r of rows) console.log(JSON.stringify(r));
    await withApp(ob.page, (app, a: { id: string }) => { app.workspace.getLeavesOfType("wadjet-studio")[0].view.windows.close(a.id); }, { id });
    await ob.page.keyboard.press("Escape");
  }
  await ob.close();
}, 300_000);
