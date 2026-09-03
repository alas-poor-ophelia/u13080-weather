/**
 * Screenshot gate for the Climate Studio fidelity work (wadjet-6rw).
 *
 * Skipped unless WADJET_SHOTS=1, so `bun run test:e2e` never runs it.
 *
 *   WADJET_SHOTS=1 npx vitest run --config vitest.e2e.config.ts test/e2e/_shot.e2e.ts
 *
 * Env:
 *   WADJET_SHOT_DIR      output folder (default docs/handoff/climate-studio/audit/shots)
 *   WADJET_SHOT_WORLD    data.json to seed (default the audit's world.json, absolute)
 *   WADJET_SHOT_ZOOMS    comma list of zoom presets (default Year,Era,Season,Month,Day; "" = none)
 *   WADJET_SHOT_WINDOWS  comma list of window ids (default all; "" = none)
 *   WADJET_SHOT_EXTRAS   comma list of json,insert,strip (default all; "" = none)
 *   WADJET_SHOT_ENV      1 = on every device window, put binding 0 on the curve
 *                        mode and open its envelope overlay before shooting.
 *                        The audit fixture carries no envelopes, so this is the
 *                        only way to capture the overlay (PLAN D15/D16 bead 3).
 *   WADJET_SHOT_ADD      1 = on every device window, click the `＋` that opens
 *                        the inline target list (`＋ apply` on the spell path,
 *                        `＋ Add target` on the moon one) before shooting. The
 *                        harness cannot hover a floating menu, so this is the
 *                        only way to capture the open list.
 *
 * Compare the output against the prototype captures in
 * C:\Dev\U+13080\docs\handoff\climate-studio\audit\proto-*.png.
 */
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { installPlugin, launchObsidian, withApp, DATA_JSON } from "./obsidian";

const AUDIT = "C:/Dev/U+13080/docs/handoff/climate-studio/audit";
const OUT = process.env["WADJET_SHOT_DIR"] ?? path.join(AUDIT, "shots");
const WORLD = process.env["WADJET_SHOT_WORLD"] ?? path.join(AUDIT, "world.json");
const list = (name: string, def: string): string[] =>
  (process.env[name] ?? def)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const ZOOMS = list("WADJET_SHOT_ZOOMS", "Year,Era,Season,Month,Day");
const WINDOWS = list(
  "WADJET_SHOT_WINDOWS",
  "regimes,seasons,cycle:Sable,forcings,atlas,channel:temperature,channel:precipitation,channel:wind,channel:sky,device:sable-stormtide,device:ashfall,device:neverain,era:Ice Age",
);
const EXTRAS = list("WADJET_SHOT_EXTRAS", "json,insert,strip");
const OPEN_ENV = process.env["WADJET_SHOT_ENV"] === "1";
const OPEN_ADD = process.env["WADJET_SHOT_ADD"] === "1";
const SEL = ".workspace-leaf-content[data-type='wadjet-studio']";

test.skipIf(process.env["WADJET_SHOTS"] !== "1")(
  "screenshot the studio for the fidelity gate",
  async () => {
    mkdirSync(OUT, { recursive: true });
    installPlugin();
    const ob = await launchObsidian();
    cpSync(WORLD, DATA_JSON);
    await ob.app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.setSize(1600, 1000);
    });
    await withApp(ob.page, async (app) => {
      if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
      await app.plugins.enablePlugin("wadjet");
    });
    await ob.page.waitForFunction(() => (window as any).Wadjet?.ready === true, null, { timeout: 15_000 });
    await withApp(ob.page, (app) => app.workspace.leftSplit.collapse());
    await withApp(ob.page, (app) => app.commands.executeCommandById("wadjet:open-studio"));
    const prompt = ob.page.locator(".modal-container .prompt");
    try {
      await prompt.waitFor({ state: "visible", timeout: 4_000 });
      await prompt.locator(".suggestion-item").first().click();
    } catch {
      /* one zone: no picker */
    }
    await ob.page.waitForSelector(SEL, { timeout: 15_000 });
    await ob.page.waitForTimeout(1500);
    const shot = (n: string) => ob.page.screenshot({ path: path.join(OUT, `real-${n}.png`) });
    const zoom = async (z: string) => {
      await ob.page.locator(`${SEL} .wadjet-studio-segment:has-text("${z}")`).first().click();
      await ob.page.waitForTimeout(700);
    };
    for (const z of ZOOMS) {
      await zoom(z);
      await shot(`zoom-${z}`);
    }
    await zoom("Year");
    /** The harness cannot draw an envelope, so it makes one: `∿ curve` then the `∿` chip. */
    const openEnvelope = async (): Promise<void> => {
      const mode = ob.page.locator(`${SEL} [data-part="mod-mode-0"]`).first();
      if ((await mode.count()) === 0) return;
      if ((await mode.getAttribute("aria-pressed")) !== "true") {
        await mode.click();
        await ob.page.waitForTimeout(400);
      }
      const shape = ob.page.locator(`${SEL} [data-part="shape-0"]`).first();
      if ((await shape.count()) === 0) return;
      if ((await shape.getAttribute("aria-pressed")) !== "true") {
        await shape.click();
        await ob.page.waitForTimeout(400);
      }
    };
    /** The `＋` that opens the inline target list, on whichever path draws it. */
    const openAdd = async (): Promise<void> => {
      const add = ob.page.locator(`${SEL} [data-part="add-target"]`).first();
      if ((await add.count()) === 0) return;
      if ((await add.getAttribute("aria-pressed")) === "true") return;
      await add.click();
      await ob.page.waitForTimeout(400);
    };
    for (const id of WINDOWS) {
      try {
        await withApp(
          ob.page,
          (app, a: { id: string }) => {
            const leaf = app.workspace.getLeavesOfType("wadjet-studio")[0];
            leaf.view.store.update((s: any) => {
              s.view.windowPos[a.id] = { x: 40, y: 40, z: 60 };
            });
            leaf.view.windows.open(a.id);
          },
          { id },
        );
        await ob.page.waitForTimeout(800);
        if (OPEN_ENV && id.startsWith("device:")) await openEnvelope();
        if (OPEN_ADD && id.startsWith("device:")) await openAdd();
        await shot(`win-${id.replace(/[^a-z]/gi, "_")}`);
        await withApp(
          ob.page,
          (app, a: { id: string }) => {
            app.workspace.getLeavesOfType("wadjet-studio")[0].view.windows.close(a.id);
          },
          { id },
        );
        await ob.page.keyboard.press("Escape");
      } catch (e) {
        console.log("WIN FAIL", id, String(e).slice(0, 200));
      }
    }
    if (EXTRAS.includes("json")) {
      try {
        const b = ob.page.locator(`${SEL} .wadjet-studio-header-btn:has-text("JSON")`).first();
        await b.click();
        await ob.page.waitForTimeout(700);
        await shot("win-json");
        await b.click();
      } catch (e) {
        console.log("JSON FAIL", String(e).slice(0, 200));
      }
    }
    if (EXTRAS.includes("insert")) {
      try {
        await ob.page.locator(`${SEL} .wadjet-studio-mixer-add`).first().click();
        await ob.page.waitForTimeout(700);
        await shot("win-insert");
        await ob.page.keyboard.press("Escape");
      } catch (e) {
        console.log("INSERT FAIL", String(e).slice(0, 200));
      }
    }
    if (EXTRAS.includes("strip")) {
      try {
        await ob.page.locator(`${SEL} .wadjet-studio-strip`).first().click();
        await ob.page.waitForTimeout(700);
        await shot("strip-open");
      } catch (e) {
        console.log("STRIP FAIL", String(e).slice(0, 200));
      }
    }
    console.log("PAGE ERRORS:", ob.errors.slice(0, 10));
    await ob.close();
  },
  300_000,
);
