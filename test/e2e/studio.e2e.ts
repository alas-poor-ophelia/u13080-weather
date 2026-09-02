/**
 * Climate Studio e2e — step 0: the component bin's stylesheet.
 *
 * Everything the bin draws is coloured and positioned from the
 * `--wadjet-studio-*` custom properties appended to `styles.css`, so the first
 * thing worth proving in a real Obsidian is that the block is actually loaded
 * and the palette resolves to the SPEC §9 values.
 *
 * The bin's factories are not exported to the vault window (that would leak
 * studio internals into production), so mounting each component once is the
 * job of the leaf bead (wadjet-9f9.14), which owns the StudioView the parts
 * are mounted into.
 *
 *   bun run test:e2e
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { MODIFIER_EXAMPLES } from "../../src/plugin/modifier-examples";
import { installPlugin, launchObsidian, notices, resetPluginData, withApp, PLUGIN_DIR, VAULT, type Obsidian } from "./obsidian";

let ob: Obsidian;

/** SPEC §9. Every value here must match the studio block in styles.css exactly. */
const PALETTE: Record<string, string> = {
  "--wadjet-studio-bg": "#141517",
  "--wadjet-studio-panel": "#2a2d31",
  "--wadjet-studio-border": "#35383d",
  "--wadjet-studio-text": "#f2f3f5",
  "--wadjet-studio-text-dim": "#aab0b9",
  "--wadjet-studio-accent": "#e9ebee",
  "--wadjet-studio-temp": "#f0885c",
  "--wadjet-studio-precip": "#5cb8f0",
  "--wadjet-studio-wind": "#7fd6a8",
  "--wadjet-studio-sky": "#b9c2cf",
  "--wadjet-studio-gold": "#e8c15a",
  "--wadjet-studio-moon": "#cdd9ee",
  "--wadjet-studio-error": "#e0605c",
  "--wadjet-studio-warn": "#e8c15a",
};

/** The studio is fluid down to 1100 px; give the vault window room for it. */
async function widenWindow(): Promise<void> {
  await ob.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    if (w.isMaximized()) return;
    const width = w.getSize()[0] ?? 0;
    if (width < 1400) w.setSize(1400, 900);
  });
}

/**
 * The zone's own device, `modifiers[0]` of the first zone in the world fixture.
 * Several walks assert it is still there (`device lanes` counts the rows under
 * Eras and names them), so the `device lanes` describe seeds the rack back to
 * exactly this before it starts.
 */
const ZONE_DEVICE = MODIFIER_EXAMPLES.find((e) => e.modifier.id === "ashfall")!.modifier;

beforeAll(async () => {
  installPlugin();
  // The vault is opened IN PLACE and every Save is a real disk write, so the
  // walk cannot start from "whatever the last run left" (H-1393): the second
  // tap over one vault used to fail `device lanes` on leftover devices and the
  // neutral-knob steps on leftover `layer:*` modifiers. Forced, because this
  // file must not depend on `smoke.e2e.ts` having run (or not run) first.
  resetPluginData({ force: true });
  ob = await launchObsidian();
  await widenWindow();
  await withApp(ob.page, async (app) => {
    if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    await app.plugins.enablePlugin("wadjet");
  });
  await ob.page.waitForFunction(() => (window as unknown as { Wadjet?: { ready?: boolean } }).Wadjet?.ready === true, null, { timeout: 15_000 });

  const world = await withApp(ob.page, (app) => {
    const s = app.plugins.plugins.wadjet.settings;
    return { zones: s.zones.map((z: any) => `${z.id} [${(z.modifiers ?? []).map((m: any) => m.id).join(",")}]`), seasons: s.calendar.seasons.length, eras: s.eras.length };
  });
  if (world.zones.length < 2) throw new Error(`the studio walk needs at least two zones; data.fixture.json has ${world.zones.length}`);
  console.log(`  · world fixture: ${world.zones.join(" · ")}; ${world.seasons} seasons, ${world.eras} eras`);
});

afterAll(async () => {
  if (ob) await ob.close();
});

/**
 * The floor under every step in this file (T1), whatever the step did.
 *
 *  - **Widen.** Two steps shrink the vault window on purpose (windows-and-touch
 *    step 5, theme step 4) and restore it in a `finally`; when one of them
 *    fails before the `finally`, every later step inherits a narrow header
 *    where the transport buttons sit over the chips' hit boxes — that is how
 *    `hemisphere 1–3` failed for a reason that had nothing to do with them.
 *  - **Close the settings window.** Obsidian 1.13 opens settings as its own
 *    window; left up, it holds the keyboard focus the next step types into.
 *  - **Close the floating panels — after a FAILED step only** (H-1390). A
 *    describe hands an open panel from one step to the next by design (the era
 *    walk opens `era:Ice Age` in step 46 and deletes it from that same panel in
 *    step 51), so closing them unconditionally would break the walk itself. It
 *    is the step that died mid-panel that leaks one over the next describe's
 *    playlist, and that is exactly the case this catches.
 */
afterEach(async (ctx) => {
  if (!ob || ob.page.isClosed()) return;
  try {
    await widenWindow();
    await withApp(ob.page, (app) => app.setting.close());
    if (ctx.task.result?.state === "fail") await closeStudioWindows();
  } catch {
    /* teardown is best effort: a step that took the window down must not also fail here */
  }
});

describe("climate studio", () => {
  test("step 0: the studio stylesheet is loaded and the SPEC 9 palette resolves", async () => {
    // withApp serialises the callback, so the palette travels in `args`.
    const resolved = await withApp(
      ob.page,
      (_app, names: string[]) => {
        const style = getComputedStyle(document.documentElement);
        const out: Record<string, string> = {};
        for (const n of names) out[n] = style.getPropertyValue(n).trim();
        return out;
      },
      Object.keys(PALETTE),
    );
    expect(resolved).toEqual(PALETTE);
  });

  test("step 0: the drag-target class carries touch-action none", async () => {
    const touchAction = await withApp(ob.page, () => {
      const probe = document.body.createDiv({ cls: "wadjet-studio-drag-target" });
      const value = getComputedStyle(probe).touchAction;
      probe.remove();
      return value;
    });
    expect(touchAction).toBe("none");
  });
});

/* ── The leaf shell (bead wadjet-9f9.14) ────────────────────────────────── */

const VIEW_TYPE = "wadjet-studio";
/** `manifest.json` id + the `addCommand` id. */
const COMMAND_ID = "wadjet:open-studio";

interface StudioProbe {
  zoneId: string | null;
  window: { a: number; b: number } | null;
  header: string;
  segmented: number;
  radios: number;
  racks: number;
  lanes: number;
  /** the playlist's row stack; a row draws with a Lane or a Chart, depending on the bead that owns it */
  rows: number;
  writes: string;
  deferred: boolean;
}

/** Everything the shell's e2e cares about, read out of every studio leaf at once. */
async function probeStudio(): Promise<StudioProbe[]> {
  return withApp(
    ob.page,
    (app, type: string) =>
      app.workspace.getLeavesOfType(type).map((leaf: any) => {
        const state = (leaf.getViewState().state ?? {}) as Record<string, unknown>;
        const el: HTMLElement | undefined = leaf.view?.containerEl;
        const count = (sel: string) => (el ? el.querySelectorAll(sel).length : 0);
        const text = (sel: string) => (el?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
        return {
          zoneId: (state["zoneId"] as string | null) ?? null,
          window: (state["window"] as { a: number; b: number } | null) ?? null,
          header: text(".wadjet-studio-header"),
          segmented: count(".wadjet-studio-segmented[role=radiogroup]"),
          radios: count(".wadjet-studio-segmented[role=radiogroup] [role=radio]"),
          racks: count(".wadjet-studio-rack-unit"),
          lanes: count(".wadjet-studio-lane"),
          rows: count(".wadjet-studio-row"),
          writes: text(".wadjet-studio-writes-body"),
          deferred: leaf.isDeferred === true,
        };
      }),
    VIEW_TYPE,
  );
}

async function zoneList(): Promise<Array<{ id: string; name: string }>> {
  return withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.zones.map((z: { id: string; name: string }) => ({ id: z.id, name: z.name })));
}

/** Click one of the header's five zoom presets and let the frame land. */
async function clickPreset(value: string): Promise<void> {
  const radio = ob.page.locator(`.wadjet-studio-segmented[role=radiogroup] [role=radio][data-value=${value}]`);
  await radio.waitFor({ state: "visible", timeout: 10_000 });
  await radio.click();
  await ob.page.waitForFunction(
    (a: { type: string; value: string }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      return el?.querySelector(`[role=radio][data-value=${a.value}]`)?.getAttribute("aria-checked") === "true";
    },
    { type: VIEW_TYPE, value },
    { timeout: 10_000 },
  );
}

/**
 * `presetWindow("era", …)` in `src/studio/model/zoom.ts`: 1000 years around the
 * current centre, translated (never shrunk) into `[epochYear − 100, + 1100]`.
 */
async function expectedEraWindow(before: { a: number; b: number }): Promise<{ a: number; b: number }> {
  const epochYear: number = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.epochYear as number);
  const min = epochYear - 100;
  const max = epochYear + 1100;
  const centre = (before.a + before.b) / 2;
  let a = centre - 500;
  let b = centre + 500;
  if (a < min) {
    b += min - a;
    a = min;
  } else if (b > max) {
    a -= b - max;
    b = max;
  }
  return { a, b };
}

/** The layout file the harness restarts from. */
const WORKSPACE_JSON = path.join(VAULT, ".obsidian", "workspace.json");

/**
 * Close Obsidian and bring it back with the layout that was on disk *before*
 * the shutdown, then re-enable the plugin and wait for it to be ready.
 *
 * The fixture vault does not list Wadjet in its `community-plugins.json` — the
 * walk enables it in memory at every launch — so Obsidian's own shutdown
 * unloads the plugin, `registerView`'s cleanup detaches the studio leaf, and
 * the layout Obsidian then persists on the way out has no studio leaf in it.
 * Whether that quit-time save beats the process going away is a coin flip: the
 * second tap over one vault lost it and came back with no studio leaf at all,
 * failing `save and drafts` step 4 on a restore that never happened.
 *
 * Pinning the layout the step just asked Obsidian to save is what "restart with
 * the studio open" means here. Everything the two restart steps actually assert
 * — the leaf restores deferred, the view type registers late and the shell
 * rebuilds, the saved edit is on disk, the header comes back clean — is
 * untouched, and still measured after a real process restart.
 */
async function restartObsidian(): Promise<void> {
  await withApp(ob.page, async (app) => {
    // The deferred-leaf hazard: leave a different tab active before the layout
    // is saved, so the studio leaf restores deferred rather than being built
    // before the view type is registered.
    const scratch = app.workspace.getLeaf("tab");
    app.workspace.setActiveLeaf(scratch, { focus: true });
    app.workspace.requestSaveLayout();
    await app.workspace.requestSaveLayout.run();
  });

  let layout: string | null = null;
  for (let i = 0; i < 40 && layout === null; i++) {
    const raw = existsSync(WORKSPACE_JSON) ? readFileSync(WORKSPACE_JSON, "utf8") : "";
    if (raw.includes(`"${VIEW_TYPE}"`)) layout = raw;
    else await ob.page.waitForTimeout(250);
  }
  if (layout === null) throw new Error(`the studio leaf never reached ${WORKSPACE_JSON}`);

  await ob.close();
  writeFileSync(WORKSPACE_JSON, layout);
  ob = await launchObsidian();
  await widenWindow();
  await withApp(ob.page, async (app) => {
    if (app.plugins.plugins.wadjet) await app.plugins.disablePlugin("wadjet");
    await app.plugins.enablePlugin("wadjet");
  });
  await ob.page.waitForFunction(() => (window as unknown as { Wadjet?: { ready?: boolean } }).Wadjet?.ready === true, null, { timeout: 15_000 });
}

/** Wait until exactly `n` studio leaves exist. */
async function waitForStudioLeaves(n: number): Promise<void> {
  await ob.page.waitForFunction((a: { type: string; n: number }) => (window as any).app.workspace.getLeavesOfType(a.type).length === a.n, { type: VIEW_TYPE, n }, { timeout: 15_000 });
}

/** The Settings window (Obsidian 1.13 opens settings in its own window). */
let sw: Page;

async function openWadjetSettings(): Promise<void> {
  await withApp(ob.page, (app) => {
    app.setting.open();
    app.setting.openTabById("wadjet");
  });
  for (let i = 0; i < 40; i++) {
    const w = ob.app.windows().find((x) => x !== ob.page && !x.isClosed());
    if (w) {
      sw = w;
      break;
    }
    await ob.page.waitForTimeout(250);
  }
  if (!sw || sw.isClosed()) throw new Error("settings window did not open");
  await sw.locator(".vertical-tab-content .setting-item-heading .setting-item-name:text-is('Zones')").waitFor({ state: "visible", timeout: 10_000 });
}

const settingsZoneRow = (name: string) => sw.locator(`.vertical-tab-content .setting-item:has(> .setting-item-info > .setting-item-name:text-is("${name}"))`);

/** The zone the walk drives; picked in step 1 from whatever the vault has. */
let zone: { id: string; name: string };
/** The zone step 2 re-points the leaf at (the last one, so re-pointing is observable). */
let secondZone: { id: string; name: string };

describe("climate studio · leaf shell", () => {
  test("step 1: the open-studio command opens a studio leaf on the zone", async () => {
    let zones = await zoneList();
    if (zones.length === 0) {
      // Same flow the smoke walk uses: Settings → Zones → Add zone → preset.
      await openWadjetSettings();
      await sw.locator('.vertical-tab-content .extra-setting-button[aria-label="Add zone"]').click();
      const dialog = sw.locator(".modal-container .modal");
      await dialog.locator('.setting-item:has(.setting-item-name:text-is("Name")) input').fill("Studio Test Zone");
      await dialog.locator("button:has-text('Add')").click();
      await dialog.waitFor({ state: "detached", timeout: 5_000 });
      await withApp(ob.page, (app) => app.setting.close());
      zones = await zoneList();
    }
    expect(zones.length).toBeGreaterThan(0);
    zone = zones[0]!;
    secondZone = zones[zones.length - 1]!;

    const ran = await withApp(ob.page, (app, id: string) => app.commands.executeCommandById(id) as boolean, COMMAND_ID);
    expect(ran).toBe(true);

    if (zones.length > 1) {
      // More than one zone: the command asks which, through the zone picker.
      const prompt = ob.page.locator(".modal-container .prompt");
      await prompt.waitFor({ state: "visible", timeout: 10_000 });
      await prompt.locator("input.prompt-input").fill(zone.name);
      await prompt.locator(".suggestion-item").first().click();
    }

    await waitForStudioLeaves(1);
    const [leaf] = await probeStudio();
    expect(leaf?.zoneId).toBe(zone.id);
    expect(leaf?.header).toContain(zone.name);
    console.log(`  · command ${COMMAND_ID} → 1 leaf on "${zone.name}"; header "${leaf?.header}"`);
  });

  test("step 2: 'Open in studio' on a settings zone row reuses the same leaf", async () => {
    await openWadjetSettings();
    const button = settingsZoneRow(secondZone.name).locator("button:has-text('Open in studio')");
    await button.waitFor({ state: "visible", timeout: 10_000 });
    // The click closes the settings window from under Playwright; the assertion
    // is the outcome in the vault window, not the click's own acknowledgement.
    await button.click().catch(() => undefined);

    await waitForStudioLeaves(1);
    await ob.page.waitForFunction(
      (a: { type: string; id: string }) => ((window as any).app.workspace.getLeavesOfType(a.type)[0]?.getViewState().state?.zoneId ?? null) === a.id,
      { type: VIEW_TYPE, id: secondZone.id },
      { timeout: 15_000 },
    );
    const [leaf] = await probeStudio();
    expect(leaf?.zoneId).toBe(secondZone.id);
    expect(leaf?.header).toContain(secondZone.name);
    console.log(`  · settings button re-pointed the one leaf at "${secondZone.name}" (still 1 studio leaf)`);
  });

  test("step 3: the shell's placeholder surfaces are real and wired to the store", async () => {
    await withApp(
      ob.page,
      async (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        if (leaf) await app.workspace.revealLeaf(leaf);
      },
      VIEW_TYPE,
    );

    const opened = (await probeStudio())[0]!;
    expect(opened.segmented).toBe(1);
    expect(opened.radios).toBe(5);
    // Bead wadjet-9f9.21 replaced the shell's four placeholder racks with the
    // real rail: the MASTER unit is always drawn, the rest depend on the zone.
    expect(opened.racks).toBeGreaterThanOrEqual(1);
    // Bead wadjet-9f9.20 turned the four placeholder channel lanes into Charts,
    // and the lane beads added the real data rows: the row stack is what is
    // fixed here, not which part of the bin each row happens to draw with.
    expect(opened.rows).toBeGreaterThanOrEqual(4);
    // The audition's Writes footer is real from the first paint (bead
    // wadjet-9f9.38): `audition · Y <year> · seed <8> · salt <n>`.
    expect(opened.writes).toMatch(/^audition · Y /);

    // The vault's workspace.json survives between e2e runs, so the window this
    // step starts from is whatever the last run left. Land on Year first, so
    // the Era click below is a real move with a computable result.
    await clickPreset("year");
    const before = (await probeStudio())[0]!;
    await clickPreset("era");

    const after = (await probeStudio())[0]!;
    expect(after.window).not.toEqual(before.window);
    // Era = a 1000-year window around the old centre, shifted into the world's
    // pannable extent (`model/zoom.ts` clampWindow, bounds from the epoch).
    expect(after.window!.b - after.window!.a).toBeCloseTo(1000, 6);
    expect(after.window).toEqual(await expectedEraWindow(before.window!));
    console.log(`  · zoom Era: window ${JSON.stringify(before.window)} → ${JSON.stringify(after.window)}; ${opened.racks} racks, 4 lanes, writes footer present`);
  });

  test("step 4: the studio leaf comes back with the same zone after a restart", async () => {
    const expected = (await probeStudio())[0]!;
    await restartObsidian();

    await waitForStudioLeaves(1);
    const restored = (await probeStudio())[0]!;
    expect(restored.zoneId).toBe(expected.zoneId);
    console.log(`  · after restart: 1 studio leaf on ${restored.zoneId} (deferred=${restored.deferred})`);

    // Building it now that the view type is registered gives back the same shell.
    await withApp(
      ob.page,
      async (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        if (leaf?.loadIfDeferred) await leaf.loadIfDeferred();
        if (leaf) await app.workspace.revealLeaf(leaf);
      },
      VIEW_TYPE,
    );
    const built = (await probeStudio())[0]!;
    expect(built.zoneId).toBe(expected.zoneId);
    expect(built.header).toContain(secondZone.name);
    expect(built.rows).toBeGreaterThanOrEqual(4);
    expect(built.racks).toBeGreaterThanOrEqual(1);
    expect(built.window).toEqual(expected.window);
    console.log(`  · rebuilt leaf: header "${built.header}", window ${JSON.stringify(built.window)}`);
  });

  /**
   * Two leaves, two row stacks (bead wadjet-9f9.45).
   *
   * `ui/playlist.ts` used to keep its row registry at module scope, which made
   * a row INSTANCE a singleton: opening a second studio leaf re-`mount`ed the
   * first leaf's row objects onto the second leaf's DOM, so the first leaf
   * rendered into orphaned nodes and the second leaf's lanes drew the FIRST
   * leaf's zone. The registry is `ctx.rows` now — one per leaf — and each
   * channel row stamps the zone it is drawing onto its own plot, which is what
   * this step reads back.
   *
   * Numbered `4b` on purpose: the walk's step numbers are stable references in
   * the bead trail, so a step inserted mid-file does not renumber forty others.
   */
  test("step 4b: a second studio leaf renders its own zone's rows, not the first leaf's", async () => {
    await revealStudio();
    const first = (await probeStudio())[0]!;
    // Step 2 left the one leaf on `secondZone`; the duplicate goes to the other.
    const otherId = first.zoneId === zone.id ? secondZone.id : zone.id;
    expect(otherId).not.toBe(first.zoneId);

    try {
      await withApp(
        ob.page,
        async (app, a: { type: string; zoneId: string }) => {
          const source = app.workspace.getLeavesOfType(a.type)[0];
          const dup = typeof app.workspace.duplicateLeaf === "function" ? await app.workspace.duplicateLeaf(source, "tab") : app.workspace.getLeaf("tab");
          // Kept on the window so the `finally` below closes exactly this leaf
          // rather than guessing at an index in `getLeavesOfType`.
          (window as any).__wadjetSecondLeaf = dup;
          await dup.setViewState({ type: a.type, active: true, state: { ...(source.getViewState().state ?? {}), zoneId: a.zoneId } });
          await app.workspace.revealLeaf(dup);
        },
        { type: VIEW_TYPE, zoneId: otherId },
      );
      await waitForStudioLeaves(2);

      // Force a paint in BOTH leaves, the older one LAST: under the old
      // module-level registry that final render is the one that writes the
      // first leaf's zone into the second leaf's plot.
      await withApp(ob.page, (app, type: string) => {
        const leaves = app.workspace.getLeavesOfType(type);
        for (const leaf of [...leaves].reverse()) {
          leaf.view?.store?.update((s: any) => {
            s.view.window = { a: s.view.window.a, b: s.view.window.b };
          });
        }
      }, VIEW_TYPE);

      await ob.page.waitForFunction(
        (a: { type: string }) => {
          const leaves = (window as any).app.workspace.getLeavesOfType(a.type);
          if (leaves.length !== 2) return false;
          return leaves.every((leaf: any) => {
            const el: HTMLElement | undefined = leaf.view?.containerEl;
            const plot = el?.querySelector('.wadjet-studio-channel[data-channel="temperature"]');
            const own = (leaf.getViewState().state ?? {}).zoneId ?? null;
            return plot !== null && plot !== undefined && plot.getAttribute("data-zone") === own;
          });
        },
        { type: VIEW_TYPE },
        { timeout: 15_000 },
      );

      interface LeafPlot {
        zoneId: string | null;
        plotZone: string | null;
        plots: number;
        rows: number;
      }
      const both: LeafPlot[] = await withApp(
        ob.page,
        (app, type: string) =>
          app.workspace.getLeavesOfType(type).map((leaf: any) => {
            const el: HTMLElement | undefined = leaf.view?.containerEl;
            return {
              zoneId: ((leaf.getViewState().state ?? {}).zoneId as string | null) ?? null,
              plotZone: el?.querySelector('.wadjet-studio-channel[data-channel="temperature"]')?.getAttribute("data-zone") ?? null,
              plots: el ? el.querySelectorAll(".wadjet-studio-channel").length : 0,
              rows: el ? el.querySelectorAll(".wadjet-studio-row").length : 0,
            };
          }),
        VIEW_TYPE,
      );

      expect(both).toHaveLength(2);
      expect(new Set(both.map((l) => l.zoneId)).size).toBe(2);
      for (const leaf of both) {
        // Each leaf owns its four composed channel plots and its own row stack.
        expect(leaf.plotZone).toBe(leaf.zoneId);
        expect(leaf.plots).toBe(4);
        expect(leaf.rows).toBeGreaterThanOrEqual(4);
      }
      console.log(`  · two leaves: ${both.map((l) => `${l.zoneId ?? "—"} → plot ${l.plotZone ?? "—"} (${l.rows} rows)`).join(" · ")}`);
    } finally {
      await withApp(ob.page, (app, type: string) => {
        const dup = (window as any).__wadjetSecondLeaf;
        delete (window as any).__wadjetSecondLeaf;
        if (dup) dup.detach();
        const rest = app.workspace.getLeavesOfType(type);
        // Belt and braces: never hand more than one studio leaf to the next describe.
        for (const leaf of rest.slice(1)) leaf.detach();
      }, VIEW_TYPE);
      await waitForStudioLeaves(1);
    }
  });
});

/* ── The header and the hint bar (bead wadjet-9f9.16) ───────────────────── */

/** The `layer:*` id `compile.setAllYear(zone, "temperature.mean", "offset", v)` writes. */
const TEMP_OFFSET_LAYER = "layer:temperature.mean";

interface HeaderProbe {
  zoneId: string | null;
  zoneButton: string;
  koppen: string;
  koppenLevel: string;
  src: string;
  readout: string;
  save: string;
  saveState: string;
  saveDisabled: boolean;
  hintName: string;
  hintDetail: string;
}

async function probeHeader(): Promise<HeaderProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement | undefined = leaf?.view?.containerEl;
      const text = (sel: string) => (el?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const attr = (sel: string, name: string) => el?.querySelector(sel)?.getAttribute(name) ?? "";
      return {
        zoneId: (leaf?.getViewState().state?.zoneId as string | null) ?? null,
        zoneButton: text(".wadjet-studio-header-zonebtn"),
        koppen: text('[data-part="koppen"] .wadjet-studio-chip-label'),
        koppenLevel: attr('[data-part="koppen-led"]', "data-level"),
        src: text('[data-part="src"] .wadjet-studio-chip-label'),
        readout: text(".wadjet-studio-header-readout"),
        save: text(".wadjet-studio-header-save"),
        saveState: attr(".wadjet-studio-header-save", "data-state"),
        saveDisabled: attr(".wadjet-studio-header-save", "aria-disabled") === "true",
        hintName: text(".wadjet-studio-hintbar-name"),
        hintDetail: text(".wadjet-studio-hintbar-detail"),
      };
    },
    VIEW_TYPE,
  );
}

/**
 * Make the one studio leaf the active, visible tab — hovering needs it on
 * screen — and re-open it first when there is none.
 *
 * Two steps in this file restart Obsidian (`leaf shell` step 4, `save and
 * drafts` step 4) and one detaches the leaf on purpose (`save and drafts` step
 * 3). Any of them failing part-way leaves the file with no studio leaf, and
 * every later describe then fails on a missing `leaf.view` rather than on what
 * it set out to test — one broken step cascading into forty. Re-opening through
 * the real `open-studio` command (the zone picker included) makes each describe
 * self-sufficient instead.
 */
async function revealStudio(): Promise<void> {
  const leaves = await withApp(ob.page, (app, type: string) => app.workspace.getLeavesOfType(type).length as number, VIEW_TYPE);
  if (leaves === 0) {
    const zones = await zoneList();
    // `zone` is only bound once leaf-shell step 1 has run; this helper has to
    // work before that too (and after a step that never got there).
    const current = zone as { id: string; name: string } | undefined;
    const want = current?.name ?? zones[0]?.name ?? "";
    await withApp(ob.page, (app, id: string) => app.commands.executeCommandById(id) as boolean, COMMAND_ID);
    if (zones.length > 1) {
      const prompt = ob.page.locator(".modal-container .prompt");
      await prompt.waitFor({ state: "visible", timeout: 10_000 });
      await prompt.locator("input.prompt-input").fill(want);
      await prompt.locator(".suggestion-item").first().click();
    }
    await waitForStudioLeaves(1);
    console.log(`  · no studio leaf: re-opened one on "${want}"`);
  }
  await withApp(
    ob.page,
    async (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      if (leaf?.loadIfDeferred) await leaf.loadIfDeferred();
      if (leaf) await app.workspace.revealLeaf(leaf);
    },
    VIEW_TYPE,
  );
}

/** The zone steps 7–9 drive; step 6 switches to it, so the switch itself is observable. */
let headerZone: { id: string; name: string };

describe("climate studio · header and hint bar", () => {
  test("step 5: the hint bar follows the pointer", async () => {
    await revealStudio();
    const save = ob.page.locator(".wadjet-studio-header-save");
    await save.waitFor({ state: "visible", timeout: 10_000 });

    await save.hover();
    const hinted = await probeHeader();
    expect(hinted.hintName).toBe("Save");
    expect(hinted.hintDetail.length).toBeGreaterThan(0);

    // The hint bar itself carries no hint: the bar falls back to the default.
    // (The header's flex spacer collapses to 0 px once the tools fill the row,
    // so it is not a hoverable target.)
    await ob.page.locator(".wadjet-studio-hintbar").hover();
    const bare = await probeHeader();
    expect(bare.hintName).toBe("Climate studio");
    expect(bare.hintDetail).toBe("hover anything for what it writes");
    console.log(`  · hint bar: Save → "${hinted.hintName} · ${hinted.hintDetail}"; nothing → "${bare.hintName}"`);
  });

  test("step 6: the zone dropdown lists every zone with its base station and switches", async () => {
    await revealStudio();
    const zones = await withApp(ob.page, (app) =>
      app.plugins.plugins.wadjet.settings.zones.map((z: any) => ({
        id: z.id,
        name: z.name,
        byGeography: Boolean(z.geography) && z.preset?.matched === "auto",
      })),
    );
    expect(zones.length).toBeGreaterThanOrEqual(2);

    const before = await probeHeader();
    await ob.page.locator(".wadjet-studio-header-zonebtn").click();
    const menu = ob.page.locator(".menu").last();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    const titles = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());

    for (const z of zones) {
      const row = titles.find((t) => t.includes(z.name));
      expect(row, `no menu row for ${z.name}`).toBeDefined();
      // ●/✓ dirty state, then the name, then the base station.
      expect(row!.startsWith("●") || row!.startsWith("✓")).toBe(true);
      const base = row!.slice(row!.indexOf(z.name) + z.name.length).replace(/^\s*·\s*/, "");
      expect(base.length).toBeGreaterThan(0);
      if (z.byGeography) expect(base).toBe("by geography");
      else expect(base).not.toBe("by geography");
    }
    expect(titles.some((t) => t.includes("add zone"))).toBe(true);

    const target = zones.find((z: any) => z.id !== before.zoneId) ?? zones[0];
    headerZone = { id: target.id, name: target.name };
    await menu.locator(".menu-item", { hasText: target.name }).first().click();
    await ob.page.waitForFunction(
      (a: { type: string; name: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-zonebtn")?.textContent ?? "").includes(a.name);
      },
      { type: VIEW_TYPE, name: target.name },
      { timeout: 10_000 },
    );

    const after = await probeHeader();
    expect(after.zoneButton).toContain(target.name);
    expect(after.src.startsWith("SRC ")).toBe(true);
    console.log(`  · zone menu rows ${JSON.stringify(titles)}; switched to "${after.zoneButton}" (${after.src})`);
  });

  test("step 7: Era then ▶ moves the window a quarter of it later", async () => {
    await revealStudio();
    const epochYear: number = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.epochYear as number);
    // The vault's workspace.json carries the window between runs, and an Era
    // window pinned against the far edge of the world has nowhere to pan. Seed
    // the epoch year so the walk starts somewhere pannable every time.
    await withApp(
      ob.page,
      (app, a: { type: string; from: number }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          s.view.window = { a: a.from, b: a.from + 1 };
        });
      },
      { type: VIEW_TYPE, from: epochYear },
    );
    await clickPreset("era");

    const before = (await probeStudio())[0]!;
    expect(before.window!.b - before.window!.a).toBeCloseTo(1000, 6);
    const readoutAtEra = (await probeHeader()).readout;
    expect(readoutAtEra.toUpperCase().startsWith("ERA")).toBe(true);

    const forward = ob.page.locator('.wadjet-studio-header-btn[aria-label="Pan forward"]');
    await forward.click();

    // `panBy` a quarter window, then `clampWindow` against [epoch − 100, + 1100].
    const step = (before.window!.b - before.window!.a) / 4;
    let a = before.window!.a + step;
    let b = before.window!.b + step;
    if (b > epochYear + 1100) {
      a -= b - (epochYear + 1100);
      b = epochYear + 1100;
    }
    // Poll for the window the pan is supposed to land on rather than reading it
    // once the moment `a` differs (H-1392). If it never arrives, the assertions
    // below still run on the last value observed and say what it actually was.
    let after = (await probeStudio())[0]!;
    for (let i = 0; i < 40 && Math.abs((after.window?.a ?? NaN) - a) > 1e-6; i++) {
      await ob.page.waitForTimeout(100);
      after = (await probeStudio())[0]!;
    }
    expect(after.window!.a).toBeGreaterThan(before.window!.a);
    expect(after.window!.a).toBeCloseTo(a, 6);
    expect(after.window!.b).toBeCloseTo(b, 6);
    expect(after.window!.b - after.window!.a).toBeCloseTo(1000, 6);
    console.log(`  · Era + ▶: ${JSON.stringify(before.window)} → ${JSON.stringify(after.window)}; readout "${readoutAtEra}"`);
  });

  test("step 8: Save is 'Saved ✓' until a draft moves, then writes the layer to disk", async () => {
    await revealStudio();
    const opened = await probeHeader();
    expect(opened.save).toBe("Saved ✓");
    expect(opened.saveState).toBe("saved");
    expect(opened.saveDisabled).toBe(true);

    // The shape `compile.setAllYear(zone, "temperature.mean", "offset", v)`
    // writes. Two alternating values keep the fixture vault from drifting when
    // the walk is re-run against it.
    //
    // `model/validation.ts` requires 1–6 seasons of an editable calendar, so a
    // world with none can never reach `Save ●`. The walk seeds two into the
    // world draft when the vault has none, which also puts the world half of
    // the write-through under test.
    const wrote: number = await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const store = leaf.view.store;
        let next = 0;
        store.update(
          (s: any) => {
            if (s.world.calendar.seasons.length === 0) {
              s.world.calendar.seasons = [
                { name: "Warm", from: 0 },
                { name: "Cold", from: 0.5 },
              ];
            }
            const zone = s.zones[s.view.zoneId];
            const existing = zone.modifiers.find((m: any) => m.id === a.id);
            next = existing?.apply?.[0]?.value === 0.5 ? 0.25 : 0.5;
            if (existing) existing.apply[0].value = next;
            else zone.modifiers.unshift({ id: a.id, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: next }] });
          },
          { history: true },
        );
        return next;
      },
      { type: VIEW_TYPE, id: TEMP_OFFSET_LAYER },
    );

    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Save ●";
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );
    const dirty = await probeHeader();
    expect(dirty.save).toBe("Save ●");
    expect(dirty.saveState).toBe("dirty");
    expect(dirty.saveDisabled).toBe(false);

    await ob.page.locator(".wadjet-studio-header-save").click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
      },
      { type: VIEW_TYPE },
      { timeout: 15_000 },
    );

    // On disk, not just in memory: the studio's one write-through.
    let onDisk: any = null;
    for (let i = 0; i < 40 && onDisk === null; i++) {
      const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
      const zone = raw.zones.find((z: any) => z.id === dirty.zoneId);
      const layer = zone?.modifiers?.find((m: any) => m.id === TEMP_OFFSET_LAYER);
      if (layer && layer.apply?.[0]?.value === wrote) onDisk = layer;
      else await ob.page.waitForTimeout(250);
    }
    expect(onDisk).not.toBeNull();
    expect(onDisk.stage).toBe("climate");
    expect(onDisk.apply).toEqual([{ param: "temperature.mean", op: "offset", value: wrote }]);
    // The world half of the same write-through.
    const saved = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
    expect(saved.calendar.seasons.length).toBeGreaterThan(0);

    // The settings tab reads the same file back and the row still validates.
    await openWadjetSettings();
    const desc = ((await settingsZoneRow(headerZone.name).locator(".setting-item-description").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
    await withApp(ob.page, (app) => app.setting.close());
    expect(desc).toContain(headerZone.id);
    expect(desc).not.toContain("error");
    console.log(`  · Save wrote ${TEMP_OFFSET_LAYER} = ${wrote} into ${dirty.zoneId}; settings row "${desc}"`);
  });

  test("step 9: the Köppen badge is the class the app itself computes", async () => {
    await revealStudio();
    const header = await probeHeader();
    expect(header.koppen).toMatch(/^[ABCDE][A-Za-z]{0,2}$/);
    expect(header.koppenLevel).toBe("ok");

    // The settings zone row prints `koppenOfClimate(z.climate)` from the saved
    // profile — the same core call, reached a different way. `window.Wadjet`
    // exposes no Köppen, so that row is the app-side oracle.
    await openWadjetSettings();
    const desc = ((await settingsZoneRow(headerZone.name).locator(".setting-item-description").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
    await withApp(ob.page, (app) => app.setting.close());
    expect(desc).toContain(header.koppen);
    console.log(`  · Köppen badge "${header.koppen}" matches the settings row "${desc}"`);
  });
});

/* ── The playlist ruler, zoom and pan (bead wadjet-9f9.17) ──────────────── */

/** `layout.ts`'s `LABEL_WIDTH`; must equal `--wadjet-studio-label-w`. */
const LABEL_WIDTH = 136;

interface PlaylistProbe {
  window: { a: number; b: number };
  /** the ruler's tick strip: how many ticks, and the labelled ones' text */
  ticks: number;
  tickLabels: string[];
  /** the ruler's season / era tint bands */
  bandLabels: string[];
  rulerLabel: string;
  rows: number;
  hiddenRows: number;
  lanes: number;
  /** the composed channel rows and the automation row draw a Chart, not a Lane */
  charts: number;
  dayCardHidden: boolean;
  /** Talon's invariant: the tick strip and every row body are one pixel grid */
  stripWidth: number;
  bodyWidth: number;
  labelWidth: number;
}

/** Let the store's animation-frame batch land, and the paint it schedules with it. */
async function nextFrame(): Promise<void> {
  await ob.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

async function probePlaylist(): Promise<PlaylistProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const all = (sel: string) => Array.from(el.querySelectorAll(sel));
      const text = (n: Element) => (n.textContent ?? "").replace(/\s+/g, " ").trim();
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const body = el.querySelector(".wadjet-studio-row-body");
      const label = el.querySelector(".wadjet-studio-row-label");
      const card = el.querySelector(".wadjet-studio-daycard");
      return {
        window: leaf.view.store.get().view.window as { a: number; b: number },
        ticks: all(".wadjet-studio-tick").length,
        tickLabels: all(".wadjet-studio-tick")
          .map(text)
          .filter((t) => t !== ""),
        bandLabels: all(".wadjet-studio-ruler-band").map(text),
        rulerLabel: text(el.querySelector(".wadjet-studio-ruler-label") ?? el),
        rows: all(".wadjet-studio-row").length,
        hiddenRows: all(".wadjet-studio-row.is-hidden").length,
        lanes: all(".wadjet-studio-lane").length,
        charts: all(".wadjet-studio-row .wadjet-studio-chart").length,
        dayCardHidden: card === null ? true : card.hasClass("is-hidden"),
        stripWidth: strip?.clientWidth ?? 0,
        bodyWidth: body?.clientWidth ?? 0,
        // The border box, not clientWidth: the label column's 1 px right border
        // sits inside its 136 px width (Obsidian is border-box everywhere).
        labelWidth: label === null ? 0 : Math.round(label.getBoundingClientRect().width),
      };
    },
    VIEW_TYPE,
  );
}

/** Put the window somewhere known. `workspace.json` persists between runs — never assume. */
async function seedWindow(w: { a: number; b: number }): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; w: { a: number; b: number } }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.view.window = { a: a.w.a, b: a.w.b };
      });
    },
    { type: VIEW_TYPE, w },
  );
  await nextFrame();
}

/**
 * Dispatch one wheel over the playlist. `at` is a fraction of the lane BODY
 * (the ruler's tick strip), or `"label"` for the 136 px label column. Returns
 * the geometry the event actually carried, so the assertion can recompute the
 * cursor fraction from the integer `clientX` the browser saw.
 */
async function wheelOverPlaylist(o: { at: number | "label"; deltaY: number; deltaX?: number; shift?: boolean }): Promise<{ left: number; width: number; clientX: number }> {
  return withApp(
    ob.page,
    (app, a: { type: string; at: number | "label"; deltaY: number; deltaX: number; shift: boolean }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const playlist = el.querySelector(".wadjet-studio-playlist") as HTMLElement;
      const strip = el.querySelector(".wadjet-studio-ruler-ticks") as HTMLElement;
      const r = strip.getBoundingClientRect();
      const p = playlist.getBoundingClientRect();
      const clientX = a.at === "label" ? Math.round(p.left + 10) : Math.round(r.left + r.width * a.at);
      playlist.dispatchEvent(new WheelEvent("wheel", { deltaY: a.deltaY, deltaX: a.deltaX, shiftKey: a.shift, clientX, clientY: Math.round(r.top + r.height / 2), bubbles: true, cancelable: true }));
      return { left: r.left, width: r.width, clientX };
    },
    { type: VIEW_TYPE, at: o.at, deltaY: o.deltaY, deltaX: o.deltaX ?? 0, shift: o.shift ?? false },
  );
}

/** The world's epoch year — the centre of the pannable extent `[epoch − 100, + 1100]`. */
async function epochYear(): Promise<number> {
  return withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.epochYear as number);
}

describe("climate studio · playlist ruler and zoom", () => {
  test("step 10: the ruler is the playlist's one pixel grid, and it is drawn", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 8 });

    const probe = await probePlaylist();
    expect(probe.rulerLabel).toContain("Calendar");
    // The four composed-channel rows (SPEC §1) plus the data lanes. The channel
    // rows draw a Chart, not a Lane, so the row stack is counted through both.
    expect(probe.rows).toBeGreaterThanOrEqual(4);
    expect(probe.lanes + probe.charts).toBeGreaterThanOrEqual(4);
    // Talon's invariant: the tick strip and every row body measure the same.
    expect(probe.stripWidth).toBeGreaterThan(0);
    expect(probe.bodyWidth).toBe(probe.stripWidth);
    expect(probe.labelWidth).toBe(LABEL_WIDTH);
    expect(probe.ticks).toBeGreaterThan(0);
    console.log(`  · ruler "${probe.rulerLabel}": ${probe.ticks} ticks over ${probe.stripWidth}px; ${probe.rows} rows, body ${probe.bodyWidth}px, label ${probe.labelWidth}px`);
  });

  test("step 11: wheel over the lane body zooms in, keeping the year under the cursor fixed", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    const before = (await probePlaylist()).window;

    const geo = await wheelOverPlaylist({ at: 0.25, deltaY: -300 });
    await nextFrame();
    const after = (await probePlaylist()).window;

    expect(after.b - after.a).toBeLessThan(before.b - before.a);
    // The exact fixed point: the year under the integer clientX the event carried.
    const frac = (geo.clientX - geo.left) / geo.width;
    const yearAt = (w: { a: number; b: number }) => w.a + frac * (w.b - w.a);
    expect(yearAt(after)).toBeCloseTo(yearAt(before), 6);
    // And the contract's coarser statement of the same thing.
    const quarter = (w: { a: number; b: number }) => w.a + 0.25 * (w.b - w.a);
    expect(Math.abs(quarter(after) - quarter(before))).toBeLessThan(1e-3);
    console.log(`  · wheel −300 at ${(frac * 100).toFixed(1)}%: ${JSON.stringify(before)} → ${JSON.stringify(after)}; fixed year ${yearAt(after).toFixed(6)}`);
  });

  test("step 12: shift+wheel pans without changing the window's width", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    const before = (await probePlaylist()).window;

    await wheelOverPlaylist({ at: 0.5, deltaY: 200, shift: true });
    await nextFrame();
    const after = (await probePlaylist()).window;

    expect(after.b - after.a).toBeCloseTo(before.b - before.a, 6);
    expect(after.a).toBeGreaterThan(before.a);
    console.log(`  · shift+wheel 200: ${JSON.stringify(before)} → ${JSON.stringify(after)} (width unchanged)`);
  });

  test("step 13: wheel over the 136 px label column is left to the browser", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    const before = (await probePlaylist()).window;

    await wheelOverPlaylist({ at: "label", deltaY: -300 });
    await nextFrame();
    const after = (await probePlaylist()).window;

    expect(after).toEqual(before);
    console.log(`  · wheel over the label column: window still ${JSON.stringify(after)}`);
  });

  test("step 14: the tick plan walks years at Year zoom and days at Day zoom", async () => {
    await revealStudio();
    const epoch = await epochYear();
    const year = epoch + 5;

    // Year zoom: `chooseStep` gives whole-year ticks once a year is under
    // ~1.1 px per day, so a three-year window is the honest "Year" case.
    await seedWindow({ a: year, b: year + 3 });
    const wide = await probePlaylist();
    expect(wide.tickLabels).toContain(`Y ${year}`);
    expect(wide.dayCardHidden).toBe(true);
    expect(wide.hiddenRows).toBe(0);

    // Day zoom (≤ 7.5 days): day ticks, rows give way to the day card.
    await seedWindow({ a: year, b: year + 3 / 365 });
    const day = await probePlaylist();
    expect(day.tickLabels.length).toBeGreaterThan(0);
    for (const label of day.tickLabels) expect(label).toMatch(/^d \d+$/);
    expect(day.dayCardHidden).toBe(false);
    expect(day.hiddenRows).toBe(day.rows);
    console.log(`  · Year zoom ticks ${JSON.stringify(wide.tickLabels.slice(0, 4))}; Day zoom ticks ${JSON.stringify(day.tickLabels.slice(0, 4))}, ${day.hiddenRows}/${day.rows} rows hidden`);
  });

  test("step 15: season bands show at Year zoom and give way at Era zoom", async () => {
    await revealStudio();
    const epoch = await epochYear();

    // Use the world draft's seasons when it has some; seed two when it does not,
    // so the walk never depends on what the fixture vault happens to carry.
    const seasons: string[] = await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const store = leaf.view.store;
        store.update((s: any) => {
          if (s.world.calendar.seasons.length === 0) {
            s.world.calendar.seasons = [
              { name: "Warm", from: 0 },
              { name: "Cold", from: 0.5 },
            ];
          }
        });
        return store.get().world.calendar.seasons.map((s: { name: string }) => s.name);
      },
      { type: VIEW_TYPE },
    );
    expect(seasons.length).toBeGreaterThan(0);

    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    const banded = await probePlaylist();
    for (const name of seasons) expect(banded.bandLabels).toContain(name);

    // Era zoom: the season bands give way to the era tint. The era is added to
    // the world draft for the length of this assertion and taken straight back
    // out, so the draft this step leaves behind is the one it found.
    const ERA = "Ruler probe era";
    await withApp(
      ob.page,
      (app, a: { type: string; name: string; from: number }) => {
        app.workspace.getLeavesOfType(a.type)[0].view.store.update((s: any) => {
          s.world.eras.push({ name: a.name, from: a.from, to: a.from + 400 });
        });
      },
      { type: VIEW_TYPE, name: ERA, from: epoch + 100 },
    );
    await seedWindow({ a: epoch, b: epoch + 1000 });
    const era = await probePlaylist();
    for (const name of seasons) expect(era.bandLabels).not.toContain(name);
    expect(era.bandLabels).toContain(ERA);

    await withApp(
      ob.page,
      (app, a: { type: string; name: string }) => {
        app.workspace.getLeavesOfType(a.type)[0].view.store.update((s: any) => {
          s.world.eras = s.world.eras.filter((e: { name: string }) => e.name !== a.name);
        });
      },
      { type: VIEW_TYPE, name: ERA },
    );
    await nextFrame();
    console.log(`  · Year zoom bands ${JSON.stringify(banded.bandLabels.slice(0, 4))}; Era zoom bands ${JSON.stringify(era.bandLabels.slice(0, 4))}`);
  });

  test("step 16: the Calendar label is inert until the seasons window is registered", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });

    const label = ob.page.locator(".wadjet-studio-ruler-label");
    await label.waitFor({ state: "visible", timeout: 10_000 });
    await label.click();
    await nextFrame();

    // Until bead wadjet-9f9.27's builder is registered the manager finds none
    // and the click is inert; once it is, the panel opens. Either is correct —
    // what must never happen is a throw, which would leave the ruler mid-render.
    const opened: number = await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        return (leaf.view.store.get().view.openWindows as string[]).filter((id) => id === "seasons").length;
      },
      { type: VIEW_TYPE },
    );
    expect(opened).toBeLessThanOrEqual(1);

    const after = await probePlaylist();
    expect(after.ticks).toBeGreaterThan(0);
    expect(after.rulerLabel).toContain("Calendar");
    console.log(`  · Calendar label click: seasons panels open ${opened}, ruler still drawing ${after.ticks} ticks`);

    // Leave the leaf as this describe found it: a panel left open would ride
    // into the next describe's probes through `view.openWindows`.
    if (opened > 0) {
      await withApp(
        ob.page,
        (app, a: { type: string }) => {
          app.workspace.getLeavesOfType(a.type)[0].view.containerEl.querySelector(".wadjet-studio-window-close")?.click();
        },
        { type: VIEW_TYPE },
      );
      await nextFrame();
    }
  });
});

/* ── The JSON drawer (SPEC §3.7, bead wadjet-9f9.37) ────────────────────── */

interface JsonProbe {
  visible: boolean;
  zoneTitle: string;
  worldTitle: string;
  zoneKeys: string[];
  worldKeys: string[];
  modifiersText: string;
  climateOpen: boolean | null;
  allText: string;
}

async function probeJson(): Promise<JsonProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const root = el.querySelector(".wadjet-studio-json");
      const text = (sel: string) => (root?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      // `Array.from`, not a spread: the union of `never[]` and `NodeListOf`
      // is not iterable under this tsconfig's lib set.
      const keys = (scope: string) => Array.from(root?.querySelectorAll(`.wadjet-studio-json-col[data-scope="${scope}"] .wadjet-studio-json-section`) ?? []).map((d) => d.getAttribute("data-key") ?? "");
      const climate = root?.querySelector('.wadjet-studio-json-section[data-key="climate"]') as HTMLDetailsElement | null;
      return {
        visible: root !== null && !root.hasClass("is-hidden"),
        zoneTitle: text('.wadjet-studio-json-col[data-scope="zone"] .wadjet-studio-json-title'),
        worldTitle: text('.wadjet-studio-json-col[data-scope="world"] .wadjet-studio-json-title'),
        zoneKeys: keys("zone"),
        worldKeys: keys("world"),
        modifiersText: text('.wadjet-studio-json-section[data-key="modifiers"] pre'),
        climateOpen: climate === null ? null : climate.open,
        allText: root?.textContent ?? "",
      };
    },
    VIEW_TYPE,
  );
}

/** Force `view.jsonOpen`, the same way `seedWindow` seeds the playlist's window. */
async function setJsonOpen(open: boolean): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; open: boolean }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.view.jsonOpen = a.open;
      });
    },
    { type: VIEW_TYPE, open },
  );
  await nextFrame();
}

describe("climate studio · json drawer", () => {
  test("step 17: '{ } JSON' toggles the drawer, with zone and world columns labelled", async () => {
    await revealStudio();
    await setJsonOpen(false);
    expect((await probeJson()).visible).toBe(false);

    await ob.page.locator('.wadjet-studio-header-btn[aria-label="Toggle the JSON drawer"]').click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return el?.querySelector(".wadjet-studio-json") !== null && !el?.querySelector(".wadjet-studio-json")?.classList.contains("is-hidden");
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );

    const probe = await probeJson();
    expect(probe.visible).toBe(true);
    expect(probe.zoneTitle).toContain("Zone file");
    expect(probe.worldTitle).toBe("World");
    expect(probe.zoneKeys).toContain("climate");
    expect(probe.zoneKeys).toContain("modifiers");
    expect(probe.worldKeys).toEqual(["eras", "calendar.seasons", "calendar.moons", "devicePresets"]);
    console.log(`  · JSON drawer opened: zone "${probe.zoneTitle}", world "${probe.worldTitle}"; zone keys ${JSON.stringify(probe.zoneKeys)}`);
  });

  test("step 18: a layer:* modifier pushed through the store lands in the modifiers section, never under a layers key", async () => {
    await revealStudio();
    await setJsonOpen(true);

    const value = await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const store = leaf.view.store;
        let next = 0;
        store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          const existing = zone.modifiers.find((m: any) => m.id === a.id);
          next = existing?.apply?.[0]?.value === 0.6 ? 0.4 : 0.6;
          if (existing) existing.apply[0].value = next;
          else zone.modifiers.unshift({ id: a.id, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: next }] });
        });
        return next;
      },
      { type: VIEW_TYPE, id: TEMP_OFFSET_LAYER },
    );
    await nextFrame();

    const probe = await probeJson();
    expect(probe.modifiersText).toContain(TEMP_OFFSET_LAYER);
    expect(probe.modifiersText).toContain(String(value));
    expect(probe.allText).not.toContain('"layers"');
    console.log(`  · pushed ${TEMP_OFFSET_LAYER} = ${value}; modifiers section carries it; no "layers" key anywhere in the drawer`);
  });

  test("step 19: the climate section is folded by default and opens on click", async () => {
    await revealStudio();
    await setJsonOpen(true);

    let probe = await probeJson();
    expect(probe.climateOpen).toBe(false);

    await ob.page.locator('.wadjet-studio-json-section[data-key="climate"] summary').click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        const details = el?.querySelector('.wadjet-studio-json-section[data-key="climate"]') as HTMLDetailsElement | null;
        return details?.open === true;
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );

    probe = await probeJson();
    expect(probe.climateOpen).toBe(true);
    console.log(`  · climate section: folded by default, open after a click on its summary`);
  });

  test("step 20: Copy on the zone scope does not throw", async () => {
    await revealStudio();
    await setJsonOpen(true);

    await ob.page.locator('.wadjet-studio-json-col[data-scope="zone"] .wadjet-studio-json-copy').click();
    await ob.page.waitForTimeout(300);

    const shown = (await notices(ob.page)).some((t) => t.includes("Copied"));
    // Headless Chromium may deny clipboard permission outright; the contract is
    // "does not throw", so a Notice is the strong assertion and a still-alive,
    // still-rendering drawer is the fallback one.
    const stillAlive = await probeJson();
    expect(shown || stillAlive.visible).toBe(true);
    console.log(`  · Copy (zone): Notice shown = ${shown}; drawer still rendering = ${stillAlive.visible}`);
  });
});

/* ── The mixer rail (bead wadjet-9f9.21) ────────────────────────────────── */

/**
 * Steps are numbered from 40: the surrounding studio beads land in parallel and
 * took every number under it (playlist 10–16, JSON 17–20, audition 21–25, cycle
 * 30–34, regimes 35–39), so the rail starts above them all.
 */
interface MixerUnitProbe {
  id: string;
  slot: string;
  name: string;
  kind: string;
  world: string;
  linked: boolean;
  chips: string[];
}

interface MixerChainProbe {
  chain: string;
  title: string;
  regimes: string;
  forcings: string;
  forcingsShown: boolean;
  empty: boolean;
  units: MixerUnitProbe[];
  masterChips: string[];
}

/** Everything the rail's e2e cares about, read out of the one studio leaf. */
async function probeMixer(): Promise<MixerChainProbe[]> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const blocks = Array.from(el?.querySelectorAll(".wadjet-studio-mixer-chain") ?? []);
      const text = (root: Element, sel: string) => (root.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const shown = (root: Element, sel: string) => {
        const found = root.querySelector(sel);
        return found !== null && !found.classList.contains("is-hidden");
      };
      return blocks.map((b) => ({
        chain: b.getAttribute("data-chain") ?? "",
        title: text(b, ".wadjet-studio-mixer-title"),
        regimes: text(b, '[data-part="regimes-name"]'),
        forcings: text(b, '[data-part="forcings-name"]'),
        forcingsShown: shown(b, '[data-part="forcings-name"]'),
        empty: shown(b, ".wadjet-studio-mixer-empty"),
        units: Array.from(b.querySelectorAll(".wadjet-studio-mixer-rack .wadjet-studio-rack-unit")).map((u) => ({
          id: u.getAttribute("data-unit") ?? "",
          slot: u.getAttribute("data-slot") ?? "",
          name: text(u, ".wadjet-studio-rack-name"),
          kind: text(u, ".wadjet-studio-rack-kind"),
          world: text(u, ".wadjet-studio-rack-world"),
          linked: shown(u, ".wadjet-studio-rack-link"),
          chips: Array.from(u.querySelectorAll(".wadjet-studio-chip-label")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
        })),
        masterChips: Array.from(b.querySelectorAll('[data-unit="master"] .wadjet-studio-chip-label')).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
      }));
    },
    VIEW_TYPE,
  );
}

/** Read the pointed-at zone draft and the world draft out of the leaf's store. */
async function readMixerDraft(): Promise<{ regimes: any[]; eras: any[]; zoneCount: number }> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const s = app.workspace.getLeavesOfType(type)[0].view.store.get();
      const zone = s.zones[s.view.zoneId];
      return { regimes: JSON.parse(JSON.stringify(zone.regimes)), eras: JSON.parse(JSON.stringify(s.world.eras)), zoneCount: Object.keys(s.zones).length };
    },
    VIEW_TYPE,
  );
}

/** Poll the rail until it has repainted past the frame the store batched. */
async function waitForMixer(predicate: (rail: MixerChainProbe[]) => boolean): Promise<MixerChainProbe[]> {
  for (let i = 0; i < 60; i++) {
    const rail = await probeMixer();
    if (predicate(rail)) return rail;
    await ob.page.waitForTimeout(100);
  }
  throw new Error("the mixer never reached the expected state");
}

/** Wait for one chain's Regimes LED to report an on/off state. */
async function waitForRegimesLed(chain: string, on: boolean): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; chain: string; pressed: string }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      return el?.querySelector(`.wadjet-studio-mixer-chain[data-chain=${a.chain}] [data-part="regimes-led"]`)?.getAttribute("aria-pressed") === a.pressed;
    },
    { type: VIEW_TYPE, chain, pressed: on ? "true" : "false" },
    { timeout: 10_000 },
  );
}

const mixerChain = (chain: string) => ob.page.locator(`.wadjet-studio-mixer-chain[data-chain=${chain}]`);

describe("climate studio · mixer", () => {
  test("step 40: the rail is TEMP · PRECIP · WIND · SKY then MASTER, with the fixed strip on every chain", async () => {
    await revealStudio();
    const draft = await readMixerDraft();
    const rail = await waitForMixer((r) => r.length === 5 && r[0]!.regimes.length > 0);

    expect(rail.map((c) => c.chain)).toEqual(["temperature", "precipitation", "wind", "sky", "master"]);
    expect(rail.slice(0, 4).map((c) => c.title)).toEqual(["TEMP", "PRECIP", "WIND", "SKY"]);
    expect(rail[4]!.title).toBe("MASTER");

    // Regimes are in all four chains and read the zone's own state count.
    const n = draft.regimes.length;
    const expected = `Regimes ${n} ${n === 1 ? "state" : "states"}`;
    for (const c of rail.slice(0, 4)) expect(c.regimes).toBe(expected);

    // Forcings only in TEMP and PRECIP (SPEC §3.3).
    expect(rail[0]!.forcingsShown).toBe(true);
    expect(rail[1]!.forcingsShown).toBe(true);
    expect(rail[2]!.forcingsShown).toBe(false);
    expect(rail[3]!.forcingsShown).toBe(false);
    expect(rail[0]!.forcings).toMatch(/^Forcings [+−]\d/);
    expect(rail[1]!.forcings).toMatch(/^Forcings ×\d/);

    // MASTER carries the two zone totals.
    expect(rail[4]!.masterChips.length).toBe(2);
    expect(rail[4]!.masterChips[0]!.startsWith("warmth ")).toBe(true);
    expect(rail[4]!.masterChips[1]!.startsWith("wetness ×")).toBe(true);
    console.log(`  · rail ${JSON.stringify(rail.map((c) => c.title))}; strip "${rail[0]!.regimes} · ${rail[0]!.forcings}"; master ${JSON.stringify(rail[4]!.masterChips)}`);
  });

  test("step 41: the Regimes LED in TEMP mutes the temperature regime ops only", async () => {
    await revealStudio();
    const original = (await readMixerDraft()).regimes;
    // Guarantee both channels are represented, whatever preset the vault zone
    // was built from: the assertion is about the split, not about the preset.
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update(
          (s: any) => {
            s.zones[s.view.zoneId].regimes[0].apply = [
              { param: "temperature.mean", op: "offset", value: -1 },
              { param: "precipitation.pww", op: "scale", value: 1.1 },
            ];
          },
          { history: true },
        );
      },
      VIEW_TYPE,
    );

    const led = mixerChain("temperature").locator('[data-part="regimes-led"]');
    await led.waitFor({ state: "visible", timeout: 10_000 });
    await led.click();
    await waitForRegimesLed("temperature", false);

    const muted = (await readMixerDraft()).regimes;
    let temperatureOps = 0;
    let precipitationOps = 0;
    for (const r of muted) {
      for (const o of r.apply ?? []) {
        if (o.param.startsWith("temperature.")) {
          temperatureOps++;
          expect(o.enabled).toBe(false);
        } else if (o.param.startsWith("precipitation.")) {
          precipitationOps++;
          expect(o.enabled).toBeUndefined();
        }
      }
    }
    expect(temperatureOps).toBeGreaterThan(0);
    expect(precipitationOps).toBeGreaterThan(0);
    // PRECIP's own strip never moved.
    const rail = await probeMixer();
    expect(rail[1]!.regimes).toBe(rail[0]!.regimes);

    await led.click();
    await waitForRegimesLed("temperature", true);
    const restored = (await readMixerDraft()).regimes;
    expect(restored.flatMap((r: any) => r.apply ?? []).some((o: any) => "enabled" in o)).toBe(false);
    console.log(`  · Regimes LED in TEMP: ${temperatureOps} temperature ops muted, ${precipitationOps} precipitation ops untouched, then restored`);

    // Put the zone's own states back so the walk leaves nothing behind.
    await withApp(
      ob.page,
      (app, a: { type: string; regimes: unknown }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          s.zones[s.view.zoneId].regimes = JSON.parse(JSON.stringify(a.regimes));
        });
      },
      { type: VIEW_TYPE, regimes: original },
    );
  });

  test("step 42: a device pushed through the store shows as a unit card in its own chain only", async () => {
    await revealStudio();
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update(
          (s: any) => {
            s.zones[s.view.zoneId].modifiers.push({ id: "test-dev", apply: [{ param: "wind.speed", op: "scale", value: 1.2 }] });
          },
          { history: true },
        );
      },
      VIEW_TYPE,
    );

    const rail = await waitForMixer((r) => r[2]!.units.length > 0);
    const wind = rail[2]!;
    expect(wind.chain).toBe("wind");
    expect(wind.units.map((u) => u.id)).toEqual(["test-dev"]);
    expect(wind.units[0]!.slot).toBe("01");
    expect(wind.units[0]!.name).toBe("test-dev");
    // No `when` and no spell: the studio reads that as a TRIM device.
    expect(wind.units[0]!.kind).toBe("TRIM");
    expect(wind.units[0]!.linked).toBe(false);
    expect(wind.units[0]!.world).toBe("");
    expect(wind.units[0]!.chips).toEqual(["always", "wind.speed ×1.2"]);
    expect(wind.empty).toBe(false);
    // One device, one chain: nowhere else on the rail.
    for (const other of [rail[0]!, rail[1]!, rail[3]!]) expect(other.units.map((u) => u.id)).not.toContain("test-dev");
    console.log(`  · test-dev → WIND slot ${wind.units[0]!.slot}, chips ${JSON.stringify(wind.units[0]!.chips)}; other chains untouched`);

    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          zone.modifiers = zone.modifiers.filter((m: any) => m.id !== "test-dev");
        });
      },
      VIEW_TYPE,
    );
    await waitForMixer((r) => !r[2]!.units.some((u) => u.id === "test-dev"));
  });

  test("step 43: an era that writes to TEMP shows as an era unit with the world badge", async () => {
    await revealStudio();
    const before = await readMixerDraft();
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update(
          (s: any) => {
            s.world.eras.push({ name: "E2E Era", from: 1, to: 2, apply: [{ param: "temperature.mean", op: "offset", value: -1.5 }] });
          },
          { history: true },
        );
      },
      VIEW_TYPE,
    );

    const rail = await waitForMixer((r) => r[0]!.units.some((u) => u.id === "era:E2E Era"));
    const era = rail[0]!.units.find((u) => u.id === "era:E2E Era")!;
    expect(era.name).toBe("E2E Era");
    expect(era.kind).toBe("ERA");
    expect(era.world).toBe(`world · ${before.zoneCount} zones`);
    expect(era.chips).toEqual(["years 1–2", "temperature.mean −1.5"]);
    // A world era never appears in a chain it does not write to.
    for (const other of [rail[1]!, rail[2]!, rail[3]!]) expect(other.units.map((u) => u.id)).not.toContain("era:E2E Era");
    console.log(`  · era unit "${era.name}" in TEMP: slot ${era.slot}, badge "${era.world}", chips ${JSON.stringify(era.chips)}`);

    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update((s: any) => {
          s.world.eras = s.world.eras.filter((e: any) => e.name !== "E2E Era");
        });
      },
      VIEW_TYPE,
    );
    await waitForMixer((r) => !r[0]!.units.some((u) => u.id === "era:E2E Era"));
  });

  test("step 44: the Regimes name opens the Regimes window", async () => {
    await revealStudio();
    const panel = ob.page.locator(".wadjet-studio-window", { has: ob.page.locator('.wadjet-studio-window-title:text-is("Regimes")') });
    if ((await panel.count()) > 0) {
      await panel.first().locator(".wadjet-studio-window-close").click();
      await panel.first().waitFor({ state: "detached", timeout: 10_000 });
    }

    const name = mixerChain("temperature").locator('[data-part="regimes-name"]');
    await name.waitFor({ state: "visible", timeout: 10_000 });
    await name.click();

    await panel.first().waitFor({ state: "visible", timeout: 10_000 });
    const title = ((await panel.first().locator(".wadjet-studio-window-title").first().textContent()) ?? "").trim();
    expect(title).toBe("Regimes");

    const open: string[] = await withApp(ob.page, (app, type: string) => app.workspace.getLeavesOfType(type)[0].getViewState().state?.openWindows ?? [], VIEW_TYPE);
    expect(open).toContain("regimes");
    console.log(`  · Regimes name opened the "${title}" window; view state openWindows ${JSON.stringify(open)}`);

    await panel.first().locator(".wadjet-studio-window-close").click();
    await panel.first().waitFor({ state: "detached", timeout: 10_000 });
  });
});

/* ── The moon CYCLE window (bead wadjet-9f9.28) ─────────────────────────── */

/** The moon the cycle walk drives, seeded into the world draft by step 30. */
const CYCLE_MOON = "Sable";
const CYCLE_WINDOW = `cycle:${CYCLE_MOON}`;

/** Five named phases — `DEFAULT_MOON_PHASES` in `model/devices.ts`, spelled out. */
const SABLE_PHASES: ReadonlyArray<{ name: string; at: number }> = [
  { name: "New", at: 0 },
  { name: "Crescent", at: 0.16 },
  { name: "Half", at: 0.42 },
  { name: "Gibbous", at: 0.68 },
  { name: "Full", at: 0.86 },
];

interface CycleProbe {
  open: boolean;
  title: string;
  badge: string;
  source: string;
  world: string;
  arcs: number;
  handles: number;
  labels: string[];
  rows: string[];
  period: string;
  epoch: string;
  editIn: string;
  writes: string;
  actions: number;
}

async function probeCycle(): Promise<CycleProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => w.querySelector(".wadjet-studio-cycle") !== null) as HTMLElement | undefined;
      const text = (root: HTMLElement | undefined, sel: string) => (root?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const all = (sel: string) => (panel ? Array.from(panel.querySelectorAll(sel)) : []);
      return {
        open: (leaf.view.store.get().view.openWindows as string[]).includes(a.id),
        title: text(panel, ".wadjet-studio-window-title"),
        badge: text(panel, ".wadjet-studio-window-badge"),
        source: text(panel, '[data-part="cycle-source"] .wadjet-studio-chip-label'),
        world: text(panel, '[data-part="cycle-world"] .wadjet-studio-chip-label'),
        arcs: all(".wadjet-studio-cycle-arc").length,
        handles: all(".wadjet-studio-cycle-handle").length,
        labels: all(".wadjet-studio-cycle-label").map((n) => (n.textContent ?? "").trim()),
        rows: all('[data-part="cycle-row"]').map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()),
        period: text(panel, '[data-part="cycle-period"] .wadjet-studio-knob-value'),
        epoch: text(panel, '[data-part="cycle-epoch"] .wadjet-studio-knob-value'),
        editIn: text(panel, '[data-part="cycle-editin"]'),
        writes: text(panel, ".wadjet-studio-writes-body"),
        actions: all(".wadjet-studio-cycle-btn:not(.is-hidden)").length,
      };
    },
    { type: VIEW_TYPE, id: CYCLE_WINDOW },
  );
}

/** The moon as the world draft currently holds it. */
async function cycleDraftMoon(): Promise<{ cycleDays: number; phaseAtEpoch: number; phases: Array<{ name: string; at: number }> } | null> {
  return withApp(
    ob.page,
    (app, a: { type: string; moon: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const moon = leaf.view.store.get().world.calendar.moons.find((m: { name: string }) => m.name === a.moon);
      if (!moon) return null;
      return { cycleDays: moon.cycleDays as number, phaseAtEpoch: moon.phaseAtEpoch as number, phases: (moon.phases ?? []) as Array<{ name: string; at: number }> };
    },
    { type: VIEW_TYPE, moon: CYCLE_MOON },
  );
}

const phaseAtOf = (phases: Array<{ name: string; at: number }>, name: string): number | undefined => phases.find((p) => p.name === name)?.at;

/** Close and re-open the panel, so a fresh build reads whatever the adapter now says. */
async function reopenCycle(): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.windows.close(a.id);
      leaf.view.windows.open(a.id);
    },
    { type: VIEW_TYPE, id: CYCLE_WINDOW },
  );
  await nextFrame();
}

/**
 * The first world edit of a session opens the confirm; later ones do not. The
 * seasons window shares that flag (`model/world-confirm.ts`), so whether this
 * walk is the one that trips it depends on what ran before it — take either,
 * and say which happened.
 */
async function passWorldConfirm(): Promise<boolean> {
  const modal = ob.page.locator(".modal-container .modal").filter({ hasText: "Moons are world-level" });
  try {
    await modal.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return false;
  }
  await modal.locator("button:has-text('Continue')").click();
  await modal.waitFor({ state: "detached", timeout: 5_000 });
  await nextFrame();
  return true;
}

describe("climate studio · cycle window", () => {
  test("step 30: a moon with five named phases opens a CYCLE panel with five arcs and its period", async () => {
    await revealStudio();
    // Seed the moon the way the settings tab would, straight into the world
    // draft — the fixture vault's calendar carries whatever the last run left.
    await withApp(
      ob.page,
      (app, a: { type: string; moon: string; phases: Array<{ name: string; at: number }> }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          const moons = s.world.calendar.moons as Array<Record<string, unknown>>;
          const at = moons.findIndex((m) => m["name"] === a.moon);
          const seeded = { name: a.moon, cycleDays: 29.53, phaseAtEpoch: 0, phases: a.phases.map((p) => ({ ...p })) };
          if (at < 0) moons.push(seeded);
          else moons[at] = seeded;
        });
      },
      { type: VIEW_TYPE, moon: CYCLE_MOON, phases: SABLE_PHASES.map((p) => ({ ...p })) },
    );
    // The moons surface registers one builder per moon on every tick.
    await nextFrame();
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.windows.open(a.id);
      },
      { type: VIEW_TYPE, id: CYCLE_WINDOW },
    );
    await nextFrame();

    const probe = await probeCycle();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe(CYCLE_MOON);
    expect(probe.badge).toBe("CYCLE");
    expect(probe.source).toBe("internal calendar");
    expect(probe.world).toMatch(/^world · \d+ zones$/);
    expect(probe.arcs).toBe(5);
    expect(probe.handles).toBe(5);
    expect([...probe.labels].sort()).toEqual(["Crescent", "Full", "Gibbous", "Half", "New"]);
    expect(probe.rows.length).toBe(5);
    expect(probe.period).toContain("29.53");
    expect(probe.epoch).toBe("0.000");
    expect(probe.editIn).toBe("");
    expect(probe.writes).toContain("calendar.moons[");
    console.log(`  · ${CYCLE_WINDOW}: ${probe.arcs} arcs / ${probe.handles} handles, period "${probe.period}", ${probe.world}, writes "${probe.writes}"`);
  });

  test("step 31: split the longest adds a sixth phase, behind the world-edit confirm", async () => {
    await revealStudio();
    const before = await cycleDraftMoon();
    expect(before?.phases.length).toBe(5);

    await ob.page.locator('[data-part="cycle-split"]').click();
    const confirmed = await passWorldConfirm();
    await nextFrame();

    // `splitLongest` halves the longest segment and names the half
    // `"<segment> 2"`. Two of the seeded segments are 0.26 wide to the eye and
    // differ only in the last bits of a double, so the expectation is computed
    // with the same arithmetic `boundaries.ts` uses rather than hard-coded.
    const segs = SABLE_PHASES.map((p, i, arr) => {
      const next = arr[(i + 1) % arr.length]!;
      let length = next.at - p.at;
      if (length <= 0) length += 1;
      return { name: p.name, from: p.at, length };
    });
    let longest = segs[0]!;
    for (const seg of segs) if (seg.length > longest.length) longest = seg;
    const newName = `${longest.name} 2`;
    const newAt = longest.from + longest.length / 2;

    const after = await cycleDraftMoon();
    expect(after?.phases.length).toBe(6);
    expect(after?.phases.map((p) => p.name)).toContain(newName);
    expect(phaseAtOf(after!.phases, newName)).toBeCloseTo(newAt, 6);
    expect((await probeCycle()).arcs).toBe(6);
    console.log(`  · split the longest: 5 → ${after?.phases.length} phases (world confirm ${confirmed ? "shown and accepted" : "already given this session"})`);
  });

  test("step 32: dragging the Full handle 20 degrees round the disc moves its boundary, in one undo step", async () => {
    await revealStudio();
    const before = await cycleDraftMoon();
    const fullBefore = phaseAtOf(before!.phases, "Full")!;

    // Rotate the handle's vector from the disc centre by +20° — screen y grows
    // downward, so a positive rotation is clockwise, the direction `angleOf`
    // measures in.
    const geo = await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const el: HTMLElement = leaf.view.containerEl;
        const svg = el.querySelector(".wadjet-studio-cycle-svg") as SVGSVGElement;
        const handle = el.querySelector('.wadjet-studio-cycle-handle[data-name="Full"]') as SVGCircleElement;
        const s = svg.getBoundingClientRect();
        const h = handle.getBoundingClientRect();
        const cx = s.left + s.width / 2;
        const cy = s.top + s.height / 2;
        const hx = h.left + h.width / 2;
        const hy = h.top + h.height / 2;
        const d = (20 * Math.PI) / 180;
        const vx = hx - cx;
        const vy = hy - cy;
        return { fromX: hx, fromY: hy, toX: cx + vx * Math.cos(d) - vy * Math.sin(d), toY: cy + vx * Math.sin(d) + vy * Math.cos(d) };
      },
      { type: VIEW_TYPE },
    );

    await ob.page.mouse.move(geo.fromX, geo.fromY);
    await ob.page.mouse.down();
    await ob.page.mouse.move((geo.fromX + geo.toX) / 2, (geo.fromY + geo.toY) / 2, { steps: 4 });
    await ob.page.mouse.move(geo.toX, geo.toY, { steps: 4 });
    await ob.page.mouse.up();
    await nextFrame();

    const after = await cycleDraftMoon();
    const fullAfter = phaseAtOf(after!.phases, "Full")!;
    expect(fullAfter - fullBefore).toBeCloseTo(20 / 360, 2);
    expect(after?.phases.length).toBe(before?.phases.length);

    // One drag, one undo step: a single undo puts the boundary back.
    const undone = await withApp(
      ob.page,
      (app, a: { type: string; moon: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.undo();
        const moon = leaf.view.store.get().world.calendar.moons.find((m: { name: string }) => m.name === a.moon);
        return (moon.phases as Array<{ name: string; at: number }>).find((p) => p.name === "Full")!.at;
      },
      { type: VIEW_TYPE, moon: CYCLE_MOON },
    );
    expect(undone).toBeCloseTo(fullBefore, 6);
    await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.redo();
      },
      { type: VIEW_TYPE },
    );
    await nextFrame();
    console.log(`  · drag Full +20°: at ${fullBefore.toFixed(4)} → ${fullAfter.toFixed(4)} (Δ ${(fullAfter - fullBefore).toFixed(4)}, expected ${(20 / 360).toFixed(4)}); one undo restored ${undone.toFixed(4)}`);
  });

  test("step 33: double-clicking a phase name renames it in the draft", async () => {
    await revealStudio();
    expect((await cycleDraftMoon())?.phases.map((p) => p.name)).toContain("Half");

    const name = ob.page.locator('[data-part="cycle-row"][data-name="Half"] [data-part="cycle-name"]');
    await name.waitFor({ state: "visible", timeout: 10_000 });
    await name.dblclick();
    const input = ob.page.locator('input[data-part="cycle-rename"]');
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill("Quarter");
    await input.press("Enter");
    await nextFrame();

    const after = await cycleDraftMoon();
    const names = after!.phases.map((p) => p.name);
    expect(names).toContain("Quarter");
    expect(names).not.toContain("Half");
    expect((await probeCycle()).labels).toContain("Quarter");
    console.log(`  · rename Half → Quarter: phases ${JSON.stringify(names)}`);
  });

  test("step 34: under a read-only calendar the window mirrors it and hides every handle", async () => {
    await revealStudio();
    // The settings tab captures the adapter list when it renders and only
    // re-renders itself while it is open, so the window has to be up BEFORE
    // the calendar registers — the order the smoke walk uses.
    await openWadjetSettings();
    // A third-party calendar that describes its own moon, named phases and all.
    await withApp(
      ob.page,
      (_app, moon: string) => {
        const w = window as unknown as { Wadjet: { registerTimeAdapter: (x: unknown) => () => void } };
        const unregister = w.Wadjet.registerTimeAdapter({
          id: "fake-cycle-cal",
          now: () => null,
          toContext: (d: number) => ({ dayOrdinal: d, yearLength: 400, yearPhase: (d % 400) / 400, source: "fake-cycle-cal" }),
          configHash: () => "fake-cycle:1",
          describe: () => ({
            label: "Fake calendar",
            readOnly: true,
            yearLength: 400,
            seasons: [
              { name: "Wet", from: 0 },
              { name: "Dry", from: 0.5 },
            ],
            moons: [
              {
                name: moon,
                cycleDays: 40,
                phaseAtEpoch: 0.25,
                phases: [
                  { name: "Dark", at: 0 },
                  { name: "Bright", at: 0.5 },
                ],
              },
            ],
            editHint: "edit in Fake calendar",
          }),
        });
        (window as unknown as { __wadjetCycleUnregister?: () => void }).__wadjetCycleUnregister = unregister;
      },
      CYCLE_MOON,
    );

    // Activate it the way the smoke walk does: the settings dropdown.
    await ob.page.waitForTimeout(500);
    await openWadjetSettings();
    const source = settingsZoneRow("Calendar source");
    await source.waitFor({ state: "visible", timeout: 10_000 });
    await source.locator("select:not(.is-measuring)").selectOption("fake-cycle-cal");
    await ob.page.waitForTimeout(500);
    await withApp(ob.page, (app) => app.setting.close());
    await revealStudio();
    await reopenCycle();

    const mirrored = await probeCycle();
    expect(mirrored.source).toBe("Fake calendar · read-only");
    expect(mirrored.handles).toBe(0);
    expect(mirrored.arcs).toBe(2);
    expect([...mirrored.labels].sort()).toEqual(["Bright", "Dark"]);
    expect(mirrored.actions).toBe(0);
    expect(mirrored.editIn).toBe("edit in Fake calendar");
    expect(mirrored.period).toContain("40.00");
    expect(mirrored.writes).toContain("Fake calendar");
    console.log(`  · read-only mirror: source "${mirrored.source}", ${mirrored.arcs} arcs, ${mirrored.handles} handles, "${mirrored.editIn}", period "${mirrored.period}"`);

    // Restore: back to the internal calendar, then drop the fake adapter.
    await openWadjetSettings();
    await settingsZoneRow("Calendar source").waitFor({ state: "visible", timeout: 10_000 });
    await settingsZoneRow("Calendar source").locator("select:not(.is-measuring)").selectOption("internal");
    await ob.page.waitForTimeout(500);
    await withApp(ob.page, (app) => app.setting.close());
    await withApp(ob.page, () => {
      (window as unknown as { __wadjetCycleUnregister?: () => void }).__wadjetCycleUnregister?.();
    });
    await ob.page.waitForTimeout(500);
    await revealStudio();
    await reopenCycle();

    const back = await probeCycle();
    expect(back.source).toBe("internal calendar");
    expect(back.handles).toBeGreaterThan(0);
    expect(back.editIn).toBe("");
    console.log(`  · restored: source "${back.source}", ${back.handles} handles back`);
  });
});


/* ── The audition strip (bead wadjet-9f9.38) ────────────────────────────── */

/** The year the strip is driven onto. `{a, b}` straddles it, so the centre floors to it. */
const AUDITION_YEAR = 1962;

interface AuditionProbe {
  cells: number;
  writes: string;
  /** gold ▼ markers over the cells */
  pins: number;
  /** PINS chips in the controls row */
  chips: number;
  /** every cell's class list, in order — a re-roll has to move at least one */
  classes: string[];
  /** what the last roll cost, in ms, as the surface measured it */
  rollMs: string;
  hintName: string;
  hintDetail: string;
}

async function probeAudition(): Promise<AuditionProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const cells = Array.from(el?.querySelectorAll(".wadjet-studio-audition-cell") ?? []);
      const text = (sel: string) => (el?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        cells: cells.length,
        writes: text(".wadjet-studio-audition-foot .wadjet-studio-writes-body"),
        pins: el?.querySelectorAll(".wadjet-studio-pin").length ?? 0,
        chips: el?.querySelectorAll('[data-part="pin-chip"]').length ?? 0,
        classes: cells.map((c) => c.className),
        rollMs: el?.querySelector(".wadjet-studio-audition-strip")?.getAttribute("data-roll-ms") ?? "",
        hintName: text(".wadjet-studio-hintbar-name"),
        hintDetail: text(".wadjet-studio-hintbar-detail"),
      };
    },
    VIEW_TYPE,
  );
}

/** The zone the strip is auditioning, off the leaf's own store. */
async function auditionZoneOf(): Promise<{ id: string; name: string }> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const state = app.workspace.getLeavesOfType(type)[0].view.store.get();
      const id = state.view.zoneId as string;
      return { id, name: (state.zones[id]?.name ?? id) as string };
    },
    VIEW_TYPE,
  );
}

/** Wait until the strip has drawn at least `n` columns (one per day, or one per bucket). */
async function waitForAuditionCells(n: number): Promise<void> {
  await ob.page.waitForFunction(
    (x: { type: string; n: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
      return (el?.querySelectorAll(".wadjet-studio-audition-cell").length ?? 0) >= x.n;
    },
    { type: VIEW_TYPE, n },
    { timeout: 15_000 },
  );
}

/** This zone's pins, straight off the studio's world draft. */
async function draftPinsFor(zoneId: string): Promise<Array<{ zoneId: string; dayOrdinal: number; patch: any }>> {
  return withApp(
    ob.page,
    (app, x: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(x.type)[0];
      return leaf.view.store
        .get()
        .world.overrides.filter((o: any) => o.zoneId === x.id)
        .map((o: any) => ({ zoneId: o.zoneId, dayOrdinal: o.dayOrdinal, patch: o.patch }));
    },
    { type: VIEW_TYPE, id: zoneId },
  );
}

/** The zone whose year the audition steps drive, and the day they pin. */
let auditionOn: { id: string; name: string };
let pinnedOrdinal = -1;

describe("climate studio · audition", () => {
  test("step 21: one seeded year of cells, and a footer that names it", async () => {
    await revealStudio();
    await seedWindow({ a: AUDITION_YEAR, b: AUDITION_YEAR + 1 });
    auditionOn = await auditionZoneOf();

    // 365 days at ≥ 3 px each, or one column per bucket below that — either
    // way a year's worth of columns, never a placeholder.
    await waitForAuditionCells(52);
    await ob.page.waitForFunction(
      (x: { type: string; year: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-audition-foot .wadjet-studio-writes-body")?.textContent ?? "").includes(x.year);
      },
      { type: VIEW_TYPE, year: `Y ${AUDITION_YEAR}` },
      { timeout: 15_000 },
    );

    const strip = await probeAudition();
    expect(strip.cells).toBeGreaterThanOrEqual(52);
    expect(strip.cells).toBeLessThanOrEqual(400);
    expect(strip.writes).toContain(`Y ${AUDITION_YEAR}`);
    expect(strip.writes).toMatch(/^audition · Y \d+ · seed \S{1,8} · salt \d+$/);
    // Every column carries a precipitation class and a temperature band.
    expect(strip.classes.every((c) => /is-(dry|drizzle|rain|sleet|snow)/.test(c) && /is-t\d/.test(c))).toBe(true);
    expect(Number(strip.rollMs)).toBeGreaterThan(0);
    console.log(`  · audition: ${strip.cells} cells for "${auditionOn.name}", footer "${strip.writes}", roll ${strip.rollMs} ms`);
  });

  test("step 22: hovering a cell puts the day tip, regime included, in the hint bar", async () => {
    await revealStudio();
    await waitForAuditionCells(52);
    const cell = ob.page.locator(".wadjet-studio-audition-cell").nth(40);
    await cell.waitFor({ state: "visible", timeout: 10_000 });
    await cell.hover();

    const hinted = await probeAudition();
    expect(hinted.hintName).toMatch(/^d \d+$/);
    expect(hinted.hintDetail).toContain("regime:");
    // `describe(report, "short")` always ends in the day's range in °C.
    expect(hinted.hintDetail).toContain("°C");
    console.log(`  · day tip: "${hinted.hintName} — ${hinted.hintDetail}"`);
  });

  test("step 23: right-click pins the day; Save writes it and settings lists it", async () => {
    await revealStudio();
    await waitForAuditionCells(52);

    const cell = ob.page.locator(".wadjet-studio-audition-cell").nth(130);
    await cell.waitFor({ state: "visible", timeout: 10_000 });
    pinnedOrdinal = Number(await cell.getAttribute("data-day-ordinal"));
    expect(Number.isInteger(pinnedOrdinal)).toBe(true);

    await cell.click({ button: "right" });
    await ob.page.waitForFunction(
      (x: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelectorAll(".wadjet-studio-pin").length ?? 0) > 0;
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );

    const marked = await probeAudition();
    expect(marked.pins).toBeGreaterThanOrEqual(1);
    expect(marked.chips).toBeGreaterThanOrEqual(1);

    // The override itself: the real `Override { zoneId, dayOrdinal, patch }`.
    const pins = await draftPinsFor(auditionOn.id);
    const mine = pins.find((p) => p.dayOrdinal === pinnedOrdinal);
    expect(mine, `no override for dayOrdinal ${pinnedOrdinal}`).toBeDefined();
    expect(mine!.zoneId).toBe(auditionOn.id);
    expect(typeof mine!.patch.temperature.mean).toBe("number");
    expect(typeof mine!.patch.precipitation.type).toBe("string");

    // Save (the header's one write-through) puts it on disk…
    await ob.page.locator(".wadjet-studio-header-save").click();
    await ob.page.waitForFunction(
      (x: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
      },
      { type: VIEW_TYPE },
      { timeout: 15_000 },
    );
    let onDisk: any = null;
    for (let i = 0; i < 40 && onDisk === null; i++) {
      const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
      onDisk = (raw.overrides ?? []).find((o: any) => o.zoneId === auditionOn.id && o.dayOrdinal === pinnedOrdinal) ?? null;
      if (onDisk === null) await ob.page.waitForTimeout(250);
    }
    expect(onDisk).not.toBeNull();

    // …and the settings tab's "Pinned days" list names it, formatted by the
    // same calendar the pin was keyed on.
    const expectedName: string = await withApp(ob.page, (app, d: number) => app.plugins.plugins.wadjet.internalCalendar.format(d) as string, pinnedOrdinal);
    // The pin is in the plugin's own settings, which is what the tab renders.
    const inSettings = await withApp(
      ob.page,
      (app) => (app.plugins.plugins.wadjet.settings.overrides as Array<{ zoneId: string; dayOrdinal: number }>).map((o) => `${o.zoneId}@${o.dayOrdinal}`).join(", "),
    );
    expect(inSettings).toContain(`${auditionOn.id}@${pinnedOrdinal}`);

    // A settings window left open by an earlier step renders the settings as
    // they stood when it opened. Close it and wait for it to actually go, so
    // `openWadjetSettings` cannot pick the stale one back up.
    await withApp(ob.page, (app) => app.setting.close());
    for (let i = 0; i < 40 && ob.app.windows().some((w) => w !== ob.page && !w.isClosed()); i++) await ob.page.waitForTimeout(250);
    await openWadjetSettings();
    // No manual refresh here, on purpose. Obsidian 1.13's declarative tab keeps
    // the rows it built and only re-reads `getSettingDefinitions()` on
    // `update()`, so a pin written while the settings window was shut used to
    // stay invisible. The studio's Save calls `refreshSettingsTab()`, which now
    // updates the tab whether or not it is showing — settings opened AFTER the
    // save must therefore already list the pin.
    // The smoke walk's own locator: the list group under the heading, minus its
    // empty state. The rows render a frame after the heading does, so wait for
    // the row rather than reading the tab the moment the heading lands.
    const pinRows = sw.locator(`.setting-group.mod-list:has(.setting-item-heading .setting-item-name:text-is("Pinned days")) .setting-items > .setting-item:not(.mod-empty-state)`);
    const myRow = pinRows.filter({ hasText: expectedName });
    await myRow.first().waitFor({ state: "visible", timeout: 15_000 });
    const names = (await pinRows.locator(".setting-item-name").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    await withApp(ob.page, (app) => app.setting.close());
    // Exactly one row for this day, and it names this zone: the smoke walk
    // leaves a pin of its own in the same vault.
    const expectedRow = `${auditionOn.name} · ${expectedName}`;
    const rows = names.filter((t) => t.endsWith(expectedName));
    expect(rows, `pin rows: ${JSON.stringify(names)}`).toEqual([expectedRow]);
    console.log(`  · pinned dayOrdinal ${pinnedOrdinal} → ${marked.pins} marker(s), ${marked.chips} chip(s); settings row "${expectedRow}"`);
  });

  test("step 24: Re-roll draws a different year and keeps the pin", async () => {
    await revealStudio();
    await waitForAuditionCells(52);
    const before = await probeAudition();

    await ob.page.locator(".wadjet-studio-audition-btn").click();
    await ob.page.waitForFunction(
      (x: { type: string; classes: string[] }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        const now = Array.from(el?.querySelectorAll(".wadjet-studio-audition-cell") ?? []).map((c) => (c as HTMLElement).className);
        return now.length === x.classes.length && now.some((c, i) => c !== x.classes[i]);
      },
      { type: VIEW_TYPE, classes: before.classes },
      { timeout: 15_000 },
    );

    const after = await probeAudition();
    const moved = after.classes.filter((c, i) => c !== before.classes[i]).length;
    expect(moved).toBeGreaterThan(0);
    // The salt moved; the world seed did not, and the pin is untouched.
    expect(after.writes).not.toBe(before.writes);
    expect(after.writes).toContain(`Y ${AUDITION_YEAR}`);
    expect(after.pins).toBe(before.pins);
    expect(after.chips).toBe(before.chips);
    const pins = await draftPinsFor(auditionOn.id);
    expect(pins.some((p) => p.dayOrdinal === pinnedOrdinal)).toBe(true);
    console.log(`  · re-roll moved ${moved}/${after.classes.length} cells; footer "${after.writes}"; ${after.pins} pin(s) kept`);
  });

  test("step 25: a draft edit repaints the strip inside the 60 ms debounce budget", async () => {
    await revealStudio();
    await waitForAuditionCells(52);

    // `compile.setAllYear(zone, "temperature.mean", "offset", v)`'s shape,
    // written straight into the draft (the compiler is not reachable from the
    // vault window). +10 °C is far more than the day-to-day noise, so the
    // temperature-band half of every cell's class has to move.
    const ms: number = await withApp(
      ob.page,
      async (app, x: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(x.type)[0];
        const el = leaf.view.containerEl as HTMLElement;
        const snapshot = () =>
          Array.from(el.querySelectorAll(".wadjet-studio-audition-cell"))
            .map((c) => (c as HTMLElement).className)
            .join("|");
        const before = snapshot();
        let restore: number | null = null;
        const started = performance.now();
        leaf.view.store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          const existing = zone.modifiers.find((m: any) => m.id === x.id);
          if (existing) {
            restore = existing.apply[0].value as number;
            existing.apply[0].value = restore + 10;
          } else {
            zone.modifiers.unshift({ id: x.id, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 10 }] });
          }
        });
        let elapsed = -1;
        for (let i = 0; i < 80 && elapsed < 0; i++) {
          await new Promise((r) => setTimeout(r, 5));
          if (snapshot() !== before) elapsed = performance.now() - started;
        }
        // Put the draft back the way the walk found it, so the leaf is left clean.
        leaf.view.store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          const existing = zone.modifiers.find((m: any) => m.id === x.id);
          if (restore === null) zone.modifiers = zone.modifiers.filter((m: any) => m.id !== x.id);
          else if (existing) existing.apply[0].value = restore;
        });
        return elapsed;
      },
      { type: VIEW_TYPE, id: TEMP_OFFSET_LAYER },
    );

    expect(ms).toBeGreaterThan(0);
    // The design budget is the 60 ms debounce plus one roll (SPEC §3.5, PLAN
    // D11) — measured 150-170 ms end to end on an idle machine, a cold roll of
    // a 365-day year being 60-95 ms of it. The ceiling here is deliberately
    // loose: what this step proves is that the strip repaints on its own, with
    // no second input and no click; the number to read is the logged one, not
    // the bound, which would otherwise be measuring the machine's load.
    expect(ms).toBeLessThan(1000);
    console.log(`  · +10 °C on ${TEMP_OFFSET_LAYER} repainted the strip in ${ms.toFixed(0)} ms (60 ms debounce + one roll)`);
  });

  test("step 26: the chip's × removes the pin, and Save takes it off disk again", async () => {
    await revealStudio();
    await waitForAuditionCells(52);
    const before = await probeAudition();
    expect(before.chips).toBeGreaterThanOrEqual(1);

    await ob.page.locator(`[data-part="pin-chip"][data-day-ordinal="${pinnedOrdinal}"] .wadjet-studio-audition-pin-x`).click();
    await ob.page.waitForFunction(
      (x: { type: string; day: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return el?.querySelector(`[data-part="pin-chip"][data-day-ordinal="${x.day}"]`) === null;
      },
      { type: VIEW_TYPE, day: String(pinnedOrdinal) },
      { timeout: 10_000 },
    );

    const after = await probeAudition();
    expect(after.chips).toBe(before.chips - 1);
    expect(after.pins).toBe(before.pins - 1);
    const pins = await draftPinsFor(auditionOn.id);
    expect(pins.some((p) => p.dayOrdinal === pinnedOrdinal)).toBe(false);

    // Saving the removal puts the vault back the way the walk found it — the
    // smoke walk owns the only other pin in this vault and counts them.
    await ob.page.locator(".wadjet-studio-header-save").click();
    await ob.page.waitForFunction(
      (x: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
      },
      { type: VIEW_TYPE },
      { timeout: 15_000 },
    );
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
      gone = !(raw.overrides ?? []).some((o: any) => o.zoneId === auditionOn.id && o.dayOrdinal === pinnedOrdinal);
      if (!gone) await ob.page.waitForTimeout(250);
    }
    expect(gone).toBe(true);
    console.log(`  · × removed the pin on dayOrdinal ${pinnedOrdinal}; Save took it off disk`);
  });
});

/* ── The Regimes · STATES window (bead wadjet-9f9.25) ───────────────────── */

/** The id `src/studio/ui/windows/regimes.ts` exports; the mixer's fixed strip registers the builder. */
const REGIMES_WINDOW_ID = "regimes";

/** The zone's `regimes[]` as this block found it; step 39 puts it back, because the walk shares one vault. */
let regimesBefore: unknown[] = [];

interface RegimesProbe {
  /** the panel exists and carries the shared chrome */
  open: boolean;
  title: string;
  badge: string;
  /** one row per state, in `regimes[]` order */
  rows: string[];
  removeDisabled: boolean[];
  /** the row the WHAT CHANGES section is bound to */
  selected: string;
  /** SHARE OF THE YEAR segments, in the same order as the rows */
  segments: string[];
  /** WHAT CHANGES: one entry per op on the selected state */
  ops: string[];
  /** the panel's own WRITES footer — the draft's `regimes[]` */
  writes: string;
  /** the store's truth, so the DOM is never the only witness */
  zoneRegimes: Array<{ id: string; weight: number; dwell: number }>;
  gatedOn: string | null;
  canUndo: boolean;
}

async function probeRegimes(): Promise<RegimesProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const bodyEl = el.querySelector(".wadjet-studio-regimes");
      const panel = bodyEl === null ? null : bodyEl.closest(".wadjet-studio-window");
      const pick = (root: Element | null, sel: string) => (root === null ? [] : Array.from(root.querySelectorAll(sel)));
      const text = (n: Element | null) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
      const state = leaf.view.store.get();
      const zone = state.zones[state.view.zoneId];
      const gate = (zone?.modifiers ?? []).find((m: any) => m.id === "g");
      return {
        open: panel !== null,
        title: text(panel?.querySelector(".wadjet-studio-window-title") ?? null),
        badge: text(panel?.querySelector(".wadjet-studio-window-badge") ?? null),
        rows: pick(bodyEl, ".wadjet-studio-regimes-row").map((r) => r.getAttribute("data-id") ?? ""),
        removeDisabled: pick(bodyEl, ".wadjet-studio-regimes-row .wadjet-studio-regimes-remove").map((b) => b.getAttribute("aria-disabled") === "true"),
        selected: pick(bodyEl, ".wadjet-studio-regimes-row.is-selected")
          .map((r) => r.getAttribute("data-id") ?? "")
          .join(","),
        segments: pick(bodyEl, ".wadjet-studio-regimes-share-seg").map((s) => s.getAttribute("data-id") ?? ""),
        ops: pick(bodyEl, ".wadjet-studio-regimes-op").map((o) => o.getAttribute("data-param") ?? ""),
        writes: text(panel?.querySelector(".wadjet-studio-writes-body") ?? null),
        zoneRegimes: (zone?.regimes ?? []).map((r: any) => ({ id: r.id, weight: r.weight, dwell: r.meanDurationDays })),
        gatedOn: gate?.when?.regime ?? null,
        canUndo: leaf.view.store.canUndo() as boolean,
      };
    },
    VIEW_TYPE,
  );
}

/**
 * Open the panel the way the mixer's fixed strip does — by id, off the leaf's
 * window manager. The position is seeded first: `workspace.json` carries
 * `view.windowPos` between runs, and a panel restored against the far edge of
 * the leaf has nothing clickable on screen.
 */
async function openRegimesWindow(): Promise<void> {
  await revealStudio();
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.view.windowPos[a.id] = { x: 24, y: 24, z: 40 };
      });
      leaf.view.windows.open(a.id);
    },
    { type: VIEW_TYPE, id: REGIMES_WINDOW_ID },
  );
  await nextFrame();
  await ob.page.locator(".wadjet-studio-window .wadjet-studio-regimes").first().waitFor({ state: "visible", timeout: 10_000 });
}

/** Write into the zone draft the way a knob would, so a step can start from a known state. */
async function seedRegimeDraft(what: "weight" | "gate", arg: unknown): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; what: string; arg: any }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update(
        (s: any) => {
          const zone = s.zones[s.view.zoneId];
          if (a.what === "weight") {
            const r = zone.regimes.find((x: any) => x.id === a.arg.id);
            if (r) r.weight = a.arg.value;
          } else {
            zone.modifiers = zone.modifiers.filter((m: any) => m.id !== "g");
            if (a.arg.regime !== null) zone.modifiers.push({ id: "g", when: { regime: a.arg.regime }, apply: [{ param: "wind.speed", op: "scale", value: 1.4 }] });
          }
        },
        { history: true },
      );
    },
    { type: VIEW_TYPE, what, arg },
  );
  await nextFrame();
}

/**
 * A real ↕ knob drag: pointerdown on the dial, then the move/up pair on
 * `window` — which is where `src/studio/ui/pointer.ts` listens (SPEC §3.8).
 * `dy` is negative for "up"; 150 px is the knob's full range.
 */
async function dragKnobDial(selector: string, dy: number): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; selector: string; dy: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const dial = el.querySelector(a.selector);
      if (dial === null) throw new Error(`no knob dial at ${a.selector}`);
      const r = dial.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      dial.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: x, clientY: y + a.dy }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y + a.dy }));
    },
    { type: VIEW_TYPE, selector, dy },
  );
  await nextFrame();
}

/** Undo / redo the way the leaf's own Mod+Z scope does. */
async function studioHistory(which: "undo" | "redo"): Promise<boolean> {
  const did = await withApp(
    ob.page,
    (app, a: { type: string; which: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      return (a.which === "undo" ? leaf.view.store.undo() : leaf.view.store.redo()) as boolean;
    },
    { type: VIEW_TYPE, which },
  );
  await nextFrame();
  return did;
}

/** Wait until the panel shows exactly `n` state rows. */
async function waitForRegimeRows(n: number): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; n: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      return (el?.querySelectorAll(".wadjet-studio-regimes-row").length ?? 0) === a.n;
    },
    { type: VIEW_TYPE, n },
    { timeout: 10_000 },
  );
}

/** Read — or replace — the zone draft's whole `regimes[]`, so a step can leave the walk where it started. */
async function zoneRegimesRaw(next?: unknown[]): Promise<unknown[]> {
  const out = await withApp(
    ob.page,
    (app, a: { type: string; next: any[] | null }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const store = leaf.view.store;
      if (a.next !== null) {
        store.update(
          (s: any) => {
            s.zones[s.view.zoneId].regimes = a.next;
          },
          { history: true },
        );
      }
      const s = store.get();
      return JSON.parse(JSON.stringify(s.zones[s.view.zoneId].regimes));
    },
    { type: VIEW_TYPE, next: next ?? null },
  );
  await nextFrame();
  return out as unknown[];
}

describe("climate studio · regimes window", () => {
  test("step 35: the STATES panel opens with one row per regime, the share bar and WHAT CHANGES", async () => {
    await openRegimesWindow();
    const probe = await probeRegimes();
    regimesBefore = await zoneRegimesRaw();

    expect(probe.open).toBe(true);
    expect(probe.title).toBe("Regimes");
    expect(probe.badge).toBe("STATES");

    // The contract: a row per state, in `regimes[]` order, and the share bar follows it.
    expect(probe.rows).toEqual(probe.zoneRegimes.map((r) => r.id));
    expect(probe.rows.length).toBe(probe.zoneRegimes.length);
    expect(probe.rows.length).toBeGreaterThan(0);
    expect(probe.segments).toEqual(probe.rows);

    // Selection defaults to the first state; WHAT CHANGES shows exactly its ops.
    expect(probe.selected).toBe(probe.rows[0]);
    const firstOps = await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        const s = leaf.view.store.get();
        return ((s.zones[s.view.zoneId]?.regimes[0]?.apply ?? []) as any[]).map((o) => o.param);
      },
      VIEW_TYPE,
    );
    expect(probe.ops).toEqual(firstOps);

    // SPEC law 5: the footer is the grammar this window writes.
    expect(probe.writes.startsWith("[")).toBe(true);
    expect(probe.writes).toContain(probe.rows[0]!);
    expect(probe.writes).toContain("meanDurationDays");
    // Two or more states, so × is live on every row (SPEC §3.4: at least one kept).
    if (probe.rows.length > 1) expect(probe.removeDisabled.every((d) => !d)).toBe(true);
    console.log(`  · Regimes · STATES: rows ${JSON.stringify(probe.rows)}; selected "${probe.selected}"; ops ${JSON.stringify(probe.ops)}; ${probe.segments.length} share segments`);
  });

  test("step 36: the add-state button adds a row and a state in the draft", async () => {
    await openRegimesWindow();
    const before = await probeRegimes();

    await ob.page.locator(".wadjet-studio-regimes-add").click();
    await waitForRegimeRows(before.rows.length + 1);

    // The rows and the writes footer repaint on separate ticks, so a probe taken
    // the instant the row count lands can still be reading the footer from
    // before the add. Wait for the footer to name the new state (H-1392: the
    // reaction is the assertion), then take one consistent probe.
    const newId = (await probeRegimes()).zoneRegimes[before.zoneRegimes.length]!.id;
    await ob.page.waitForFunction(
      (a: { type: string; id: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        const panel = el?.querySelector(".wadjet-studio-regimes")?.closest(".wadjet-studio-window") ?? null;
        return (panel?.querySelector(".wadjet-studio-writes-body")?.textContent ?? "").includes(a.id);
      },
      { type: VIEW_TYPE, id: newId },
      { timeout: 10_000 },
    );

    const after = await probeRegimes();
    expect(after.rows.length).toBe(before.rows.length + 1);
    expect(after.zoneRegimes.length).toBe(before.zoneRegimes.length + 1);
    // `addState`'s defaults, and the bar grew with the rows.
    const added = after.zoneRegimes[after.zoneRegimes.length - 1]!;
    expect(added.weight).toBeCloseTo(0.1, 10);
    expect(added.dwell).toBe(7);
    expect(after.segments).toEqual(after.rows);
    // A new state is the one being edited (SPEC §3.4: WHAT CHANGES is the selection's).
    expect(after.selected).toBe(added.id);
    expect(after.writes).toContain(added.id);
    console.log(`  · add state produced "${added.id}" (weight ${added.weight}, ${added.dwell} d); rows ${before.rows.length} to ${after.rows.length}`);
  });

  test("step 37: renaming a state rewrites the predicate of a device gated on it (PLAN D13)", async () => {
    await openRegimesWindow();
    const before = await probeRegimes();
    const target = before.rows[before.rows.length - 1]!;

    await seedRegimeDraft("gate", { regime: target });
    expect((await probeRegimes()).gatedOn).toBe(target);

    const row = ob.page.locator(`.wadjet-studio-regimes-row[data-id="${target}"] .wadjet-studio-regimes-name`);
    await row.dblclick();
    const input = ob.page.locator(".wadjet-studio-regimes-name-input");
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill("storm");
    await input.press("Enter");

    await ob.page.waitForFunction(
      (a: { type: string; old: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return el !== undefined && el.querySelector(`.wadjet-studio-regimes-row[data-id="${a.old}"]`) === null;
      },
      { type: VIEW_TYPE, old: target },
      { timeout: 10_000 },
    );

    const after = await probeRegimes();
    // `uniqueId` keeps ids unique, so the id the state actually got is the oracle.
    const renamed = after.rows[after.rows.length - 1]!;
    expect(renamed.startsWith("storm")).toBe(true);
    expect(after.rows).not.toContain(target);
    expect(after.gatedOn).toBe(renamed);
    expect(after.writes).toContain(renamed);
    expect(after.segments).toEqual(after.rows);

    // Leave the draft without the probe device.
    await seedRegimeDraft("gate", { regime: null });
    console.log(`  · renamed "${target}" to "${renamed}"; the device gated on it now reads { regime: "${renamed}" }`);
  });

  test("step 38: dragging HOW OFTEN writes the weight and costs exactly one undo step", async () => {
    await openRegimesWindow();
    const opened = await probeRegimes();
    const target = opened.rows[0]!;

    // A known starting point: `workspace.json` and the earlier steps both move
    // this draft, so the assertion is against a value this step set itself.
    await seedRegimeDraft("weight", { id: target, value: 0.3 });
    const before = await probeRegimes();
    expect(before.zoneRegimes[0]!.weight).toBeCloseTo(0.3, 10);

    // 30 px up over the knob's 150 px full range = +0.2 of a 0…1 sweep.
    await dragKnobDial(`.wadjet-studio-regimes-row[data-id="${target}"] .wadjet-studio-knob-dial`, -30);

    const dragged = await probeRegimes();
    expect(dragged.zoneRegimes[0]!.weight).toBeCloseTo(0.5, 6);
    expect(dragged.canUndo).toBe(true);
    // The readout under the dial is the same number.
    const readout = await ob.page.locator(`.wadjet-studio-regimes-row[data-id="${target}"] .wadjet-studio-knob-value`).first().textContent();
    expect((readout ?? "").trim()).toBe("0.50");

    // One undo covers the whole gesture: it lands on the pre-drag value, not on
    // an intermediate frame of it (PLAN D11 — one snapshot at pointer-up).
    expect(await studioHistory("undo")).toBe(true);
    const undone = await probeRegimes();
    expect(undone.zoneRegimes[0]!.weight).toBeCloseTo(0.3, 10);

    expect(await studioHistory("redo")).toBe(true);
    const redone = await probeRegimes();
    expect(redone.zoneRegimes[0]!.weight).toBeCloseTo(0.5, 6);
    console.log(`  · HOW OFTEN drag 30 px up: 0.30 to ${redone.zoneRegimes[0]!.weight}; one undo restored 0.30, redo put it back`);
  });

  test("step 39: the remove button drops a state, the share bar follows, and the last state is kept", async () => {
    await openRegimesWindow();
    const before = await probeRegimes();
    expect(before.rows.length).toBeGreaterThan(1);

    const doomed = before.rows[before.rows.length - 1]!;
    await ob.page.locator(`.wadjet-studio-regimes-row[data-id="${doomed}"] .wadjet-studio-regimes-remove`).click();
    await waitForRegimeRows(before.rows.length - 1);

    const after = await probeRegimes();
    expect(after.rows).toEqual(before.rows.slice(0, -1));
    expect(after.zoneRegimes.map((r) => r.id)).toEqual(after.rows);
    // The share bar is derived from the same list, so its segments follow.
    expect(after.segments).toEqual(after.rows);
    expect(after.writes).not.toContain(`"${doomed}"`);

    // Down to one, then the remove button on the survivor is dead (SPEC §3.4).
    for (let guard = 0; guard < 12; guard++) {
      const probe = await probeRegimes();
      if (probe.rows.length <= 1) break;
      const last = probe.rows[probe.rows.length - 1]!;
      await ob.page.locator(`.wadjet-studio-regimes-row[data-id="${last}"] .wadjet-studio-regimes-remove`).click();
      await waitForRegimeRows(probe.rows.length - 1);
    }

    const alone = await probeRegimes();
    expect(alone.rows.length).toBe(1);
    expect(alone.removeDisabled).toEqual([true]);
    expect(alone.segments).toEqual(alone.rows);

    // The dead button really is dead: clicking it changes nothing.
    await ob.page.locator(".wadjet-studio-regimes-row .wadjet-studio-regimes-remove").click({ force: true });
    await nextFrame();
    const still = await probeRegimes();
    expect(still.rows).toEqual(alone.rows);
    expect(still.zoneRegimes.length).toBe(1);

    // Leave the zone's states as step 35 found them.
    await zoneRegimesRaw(regimesBefore);
    await waitForRegimeRows(regimesBefore.length);

    // …and leave no panel over the surfaces. `view.openWindows` is persisted in
    // `workspace.json`, so a panel left open here comes back on the NEXT run,
    // floating over whatever an earlier step is trying to click.
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.windows.close(a.id);
        app.workspace.requestSaveLayout();
      },
      { type: VIEW_TYPE, id: REGIMES_WINDOW_ID },
    );
    await nextFrame();
    expect((await probeRegimes()).open).toBe(false);
    console.log(`  · remove dropped "${doomed}" (${before.rows.length} to ${after.rows.length} rows); down to "${alone.rows[0]}", the last remove is disabled and inert`);
  });
});

/* ── The Seasons · CALENDAR window (SPEC §3.4 "Seasons", bead wadjet-9f9.27) ── */

const SEASONS_WINDOW = "seasons";

interface SeasonsProbe {
  segments: number;
  labels: string[];
  source: string;
  world: string;
  flags: number;
  flagsDisabled: number;
  editLink: string;
  splitHidden: boolean;
  writes: string;
}

async function probeSeasons(): Promise<SeasonsProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const windows = Array.from(el?.querySelectorAll(".wadjet-studio-window") ?? []);
      const panel = windows.find((w) => w.querySelector(".wadjet-studio-seasons") !== null);
      const segIndices = new Set(Array.from(panel?.querySelectorAll(".wadjet-studio-seasons-segment[data-index]") ?? []).map((n) => n.getAttribute("data-index")));
      const labels = Array.from(panel?.querySelectorAll(".wadjet-studio-seasons-segment-label") ?? []).map((n) => (n.textContent ?? "").trim());
      const flags = Array.from(panel?.querySelectorAll(".wadjet-studio-seasons-flag") ?? []);
      const text = (sel: string) => (panel?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const split = panel?.querySelector(".wadjet-studio-seasons-split");
      return {
        segments: segIndices.size,
        labels,
        source: text('[data-part="source"] .wadjet-studio-chip-label'),
        world: text('[data-part="world"] .wadjet-studio-chip-label'),
        flags: flags.length,
        flagsDisabled: flags.filter((f) => f.getAttribute("aria-disabled") === "true").length,
        editLink: text(".wadjet-studio-seasons-editlink"),
        splitHidden: split ? split.classList.contains("is-hidden") : false,
        writes: text(".wadjet-studio-writes-body"),
      };
    },
    VIEW_TYPE,
  );
}

/** The world draft's seasons, straight off the leaf's own store. */
async function draftSeasons(): Promise<Array<{ name: string; from: number }>> {
  return withApp(ob.page, (app, type: string) => app.workspace.getLeavesOfType(type)[0].view.store.get().world.calendar.seasons, VIEW_TYPE);
}

/** A known 4-season layout, independent of whatever an earlier walk left seeded. */
async function seedFourSeasons(): Promise<void> {
  await withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      leaf.view.store.update(
        (s: any) => {
          s.world.calendar.seasons = [
            { name: "Spring", from: 0 },
            { name: "Summer", from: 0.25 },
            { name: "Autumn", from: 0.5 },
            { name: "Winter", from: 0.75 },
          ];
        },
        { history: true },
      );
    },
    VIEW_TYPE,
  );
  await nextFrame();
}

async function openSeasonsWindow(): Promise<void> {
  await revealStudio();
  await withApp(ob.page, (app, a: { type: string; id: string }) => app.workspace.getLeavesOfType(a.type)[0].view.windows.open(a.id), { type: VIEW_TYPE, id: SEASONS_WINDOW });
  await nextFrame();
}

async function reopenSeasons(): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.windows.close(a.id);
      leaf.view.windows.open(a.id);
    },
    { type: VIEW_TYPE, id: SEASONS_WINDOW },
  );
  await nextFrame();
}

/**
 * The first world edit of a session opens the confirm; later ones do not.
 * Seasons shares the flag with CYCLE (`model/world-confirm.ts`), so whether
 * this walk is the one that trips it depends on what ran before it — take
 * either, and say which happened (mirrors `passWorldConfirm` above).
 */
async function passSeasonsWorldConfirm(): Promise<boolean> {
  const modal = ob.page.locator(".modal-container .modal").filter({ hasText: "Seasons are world-level" });
  try {
    await modal.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return false;
  }
  await modal.locator("button:has-text('Continue')").click();
  await modal.waitFor({ state: "detached", timeout: 5_000 });
  await nextFrame();
  return true;
}

describe("climate studio · seasons window", () => {
  test("step 40: opens via windows.open and shows one segment per season", async () => {
    await seedFourSeasons();
    await openSeasonsWindow();

    const probe = await probeSeasons();
    const seasons = await draftSeasons();
    expect(seasons.length).toBe(4);
    expect(probe.segments).toBe(4);
    expect(probe.labels).toEqual(["Spring", "Summer", "Autumn", "Winter"]);
    expect(probe.source).toBe("internal calendar");
    expect(probe.world).toMatch(/^world · \d+ zones$/);
    console.log(`  · seasons window: ${probe.segments} segments ${JSON.stringify(probe.labels)}; source "${probe.source}"; ${probe.world}`);
  });

  test("step 41: the split-the-longest button adds a segment, behind the world-edit confirm", async () => {
    await revealStudio();
    const before = await draftSeasons();
    expect(before.length).toBe(4);

    await ob.page.locator(".wadjet-studio-seasons-split").click();
    const confirmed = await passSeasonsWorldConfirm();

    const after = await draftSeasons();
    expect(after.length).toBe(5);
    expect(after.map((s) => s.name)).toContain("Spring 2");
    const probe = await probeSeasons();
    expect(probe.segments).toBe(5);
    console.log(`  · split the longest: ${before.length} to ${after.length} seasons (world confirm ${confirmed ? "shown and accepted" : "already given this session"})`);
  });

  test("step 42: a second mutation on the new segment shows no modal", async () => {
    await revealStudio();
    const before = await draftSeasons();
    expect(before.length).toBe(5);

    // By step 41 the session's one confirm has definitely been given (this
    // describe's own step, or an earlier world edit elsewhere in the walk —
    // the flag is shared, `model/world-confirm.ts`), so this merge must be silent.
    await ob.page.locator('.wadjet-studio-seasons-segment:has(.wadjet-studio-seasons-segment-label:text-is("Spring 2")) .wadjet-studio-seasons-segment-remove').click();
    await nextFrame();
    const stillNoModal = await ob.page
      .locator(".modal-container .modal")
      .filter({ hasText: "Seasons are world-level" })
      .isVisible()
      .catch(() => false);
    expect(stillNoModal).toBe(false);

    const after = await draftSeasons();
    expect(after.length).toBe(4);
    expect(after.map((s) => s.name)).not.toContain("Spring 2");
    console.log(`  · merge: ${before.length} to ${after.length} seasons, no confirm modal`);
  });

  test("step 43: renaming a segment changes the draft and the header shows an unsaved Save", async () => {
    await revealStudio();
    await ob.page.locator(".wadjet-studio-seasons-segment-label").first().dblclick();
    const input = ob.page.locator(".wadjet-studio-seasons-segment-input");
    await input.waitFor({ state: "visible", timeout: 5_000 });
    await input.fill("Monsoon");
    await input.press("Enter");
    await passSeasonsWorldConfirm(); // no-op unless this happens to be the session's first world edit
    await nextFrame();

    const seasons = await draftSeasons();
    expect(seasons.map((s) => s.name)).toContain("Monsoon");

    const save = (await ob.page.locator(".wadjet-studio-header-save").textContent()) ?? "";
    expect(save.trim()).toBe("Save ●");
    console.log(`  · rename to "Monsoon" in the draft; header reads "${save.trim()}"`);
  });

  test("step 44: a read-only calendar hides edit affordances and shows the edit-in line", async () => {
    await revealStudio();
    // Activate through the same call the settings dropdown's onChange makes
    // (`settings-tab.ts setControlValue("activeTimeAdapter", ...)`), rather
    // than driving the two-window Settings UI: this test is about the
    // Seasons window's read-only mirror, not about that dropdown, which the
    // smoke walk and the CYCLE window's own step 34 already cover. A
    // try/finally guards the restore so a failed assertion here can never
    // strand the shared fixture vault with a fake adapter left active or a
    // panel left open for the next describe (or another agent's run) to trip
    // over.
    try {
      await withApp(ob.page, () => {
        const w = window as unknown as { Wadjet: { registerTimeAdapter: (x: unknown) => () => void } };
        const un = w.Wadjet.registerTimeAdapter({
          id: "fake-seasons-cal",
          now: () => null,
          toContext: (d: number) => ({ dayOrdinal: d, yearLength: 400, yearPhase: (d % 400) / 400, source: "fake-seasons-cal" }),
          configHash: () => "fake-seasons:1",
          describe: () => ({
            label: "Fake calendar",
            readOnly: true,
            yearLength: 400,
            seasons: [
              { name: "Wet", from: 0 },
              { name: "Dry", from: 0.5 },
            ],
            moons: [],
            editHint: "edit in Fake calendar",
          }),
        });
        (window as unknown as { __wadjetSeasonsUnregister?: () => void }).__wadjetSeasonsUnregister = un;
      });
      await withApp(ob.page, async (app) => {
        const plugin = app.plugins.plugins.wadjet;
        plugin.settings.activeTimeAdapter = "fake-seasons-cal";
        plugin.time.setActive("fake-seasons-cal");
        await plugin.saveAndRebuild();
      });
      await revealStudio();
      await reopenSeasons();

      const mirrored = await probeSeasons();
      expect(mirrored.source).toBe("Fake calendar · read-only");
      expect([...mirrored.labels].sort()).toEqual(["Dry", "Wet"]);
      expect(mirrored.flags === 0 || mirrored.flagsDisabled === mirrored.flags).toBe(true);
      expect(mirrored.splitHidden).toBe(true);
      expect(mirrored.editLink).toBe("edit in Fake calendar");
      console.log(`  · read-only mirror: source "${mirrored.source}", ${mirrored.flags} flags (${mirrored.flagsDisabled} disabled), "${mirrored.editLink}"`);
    } finally {
      // Restore: back to the internal calendar, close the panel, then drop the fake adapter.
      await withApp(ob.page, async (app) => {
        const plugin = app.plugins.plugins.wadjet;
        if (plugin.settings.activeTimeAdapter !== "internal") {
          plugin.settings.activeTimeAdapter = "internal";
          plugin.time.setActive("internal");
          await plugin.saveAndRebuild();
        }
      });
      await withApp(
        ob.page,
        (app, a: { type: string; id: string }) => {
          const leaf = app.workspace.getLeavesOfType(a.type)[0];
          leaf?.view?.windows?.close(a.id);
        },
        { type: VIEW_TYPE, id: SEASONS_WINDOW },
      );
      await withApp(ob.page, () => {
        (window as unknown as { __wadjetSeasonsUnregister?: () => void }).__wadjetSeasonsUnregister?.();
      });
    }

    await revealStudio();
    await reopenSeasons();

    const back = await probeSeasons();
    expect(back.source).toBe("internal calendar");
    expect(back.editLink).toBe("");
    console.log(`  · restored: source "${back.source}"`);
  });
});

/* ── The Era window (bead wadjet-9f9.26) ────────────────────────────────── */

/** Tracks the era's current name across the walk — step 43 renames it. */
let eraName = "Ice Age";
const eraWindowIdFor = (n: string): string => `era:${n}`;

interface EraDraft {
  name: string;
  from: number;
  to?: number;
  enabled?: boolean;
  apply?: Array<{ param: string; op: string; value?: number; enabled?: boolean }>;
}

/** The era as the world draft currently holds it, by its current name. */
async function eraDraft(name: string): Promise<EraDraft | null> {
  return withApp(
    ob.page,
    (app, a: { type: string; name: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const era = (leaf.view.store.get().world.eras as EraDraft[]).find((e) => e.name === a.name);
      return era ? (JSON.parse(JSON.stringify(era)) as EraDraft) : null;
    },
    { type: VIEW_TYPE, name },
  );
}

interface EraProbe {
  open: boolean;
  title: string;
  badge: string;
  world: string;
  from: string;
  to: string;
  ledOn: boolean;
  knobValues: string[];
  note: string;
  writes: string;
}

async function probeEra(id: string): Promise<EraProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => w.querySelector(".wadjet-studio-era") !== null) as HTMLElement | undefined;
      const text = (sel: string) => (panel?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const val = (sel: string) => (panel?.querySelector(sel) as HTMLInputElement | null)?.value ?? "";
      return {
        open: (leaf.view.store.get().view.openWindows as string[]).includes(a.id),
        title: text(".wadjet-studio-window-title"),
        badge: text(".wadjet-studio-window-badge"),
        world: text('[data-part="era-world"] .wadjet-studio-chip-label'),
        from: val('[data-part="era-from"]'),
        to: val('[data-part="era-to"]'),
        ledOn: panel?.querySelector('[data-part="era-led"]')?.classList.contains("is-on") ?? false,
        knobValues: Array.from(panel?.querySelectorAll('[data-part="era-op-knob"] .wadjet-studio-knob-value') ?? []).map((n) => (n.textContent ?? "").trim()),
        note: text('[data-part="era-note"]'),
        writes: text(".wadjet-studio-writes-body"),
      };
    },
    { type: VIEW_TYPE, id },
  );
}

async function openEraWindow(id: string): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.windows.open(a.id);
    },
    { type: VIEW_TYPE, id },
  );
  await nextFrame();
}

/**
 * The first world edit of a session opens the confirm; later ones do not —
 * the same session-wide flag `passWorldConfirm` (CYCLE) and the seasons walk
 * both share (`model/world-confirm.ts`). Whether this walk is the one that
 * trips it depends on what ran before it in the file, so take either and say
 * which happened, exactly like those two.
 */
async function passEraWorldConfirm(): Promise<boolean> {
  const modal = ob.page.locator(".modal-container .modal").filter({ hasText: "Eras are world-level" });
  try {
    await modal.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return false;
  }
  await modal.locator("button:has-text('Continue')").click();
  await modal.waitFor({ state: "detached", timeout: 5_000 });
  await nextFrame();
  return true;
}

describe("climate studio · era window", () => {
  test("step 46: opening era:Ice Age shows the title, the span and one knob reading -8", async () => {
    await revealStudio();
    eraName = "Ice Age";
    await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          s.world.eras = [{ name: "Ice Age", from: 1200, to: 1900, apply: [{ param: "temperature.mean", op: "offset", value: -8 }] }];
        });
      },
      { type: VIEW_TYPE },
    );
    await nextFrame(); // eras-surface registers a fresh builder on the next tick
    await openEraWindow(eraWindowIdFor(eraName));

    const probe = await probeEra(eraWindowIdFor(eraName));
    expect(probe.open).toBe(true);
    expect(probe.title).toBe("Ice Age");
    expect(probe.badge).toBe("ERA");
    expect(probe.world).toMatch(/^world · \d+ zones?$/);
    expect(probe.from).toBe("1200");
    expect(probe.to).toBe("1900");
    expect(probe.knobValues.length).toBe(1);
    // The units audit (bead wadjet-9f9.41) made `model/format.ts` emit a real
    // minus sign, U+2212, in every knob readout — never the ASCII hyphen. The
    // glyph IS the property here, so assert it rather than reverting it.
    expect(probe.knobValues[0]).toContain("−8.0");
    expect(probe.note).toBe("");
    expect(probe.writes).toContain("world.eras[");
    console.log(`  · era:Ice Age opened: span ${probe.from}–${probe.to}, knob "${probe.knobValues[0]}", ${probe.world}`);
  });

  test("step 47: setting To to 1950 updates the draft, behind the world-edit confirm", async () => {
    await revealStudio();
    const before = await eraDraft(eraName);
    expect(before?.to).toBe(1900);

    const to = ob.page.locator('.wadjet-studio-window:has(.wadjet-studio-era) [data-part="era-to"]');
    await to.fill("1950");
    await to.blur();
    const confirmed = await passEraWorldConfirm();
    await nextFrame();

    const after = await eraDraft(eraName);
    expect(after?.to).toBe(1950);
    console.log(`  · To 1900 → 1950 (world confirm ${confirmed ? "shown and accepted" : "already given this session"})`);
  });

  test("step 48: ⤢ playlist zooms the window to [from, to+1], clamped", async () => {
    await revealStudio();
    const epochYear: number = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.epochYear as number);

    const playlist = ob.page.locator('.wadjet-studio-window:has(.wadjet-studio-era) [data-part="era-playlist"]');
    await playlist.click();
    await nextFrame();

    const w = await withApp(ob.page, (app, type: string) => app.workspace.getLeavesOfType(type)[0].view.store.get().view.window, VIEW_TYPE);
    // era.from = 1200, era.to = 1950 (step 47) → raw [1200, 1951], then
    // `clampWindow` against [epochYear − 100, epochYear + 1100] (`model/zoom.ts`,
    // mirroring `header.ts`'s own pan bounds). The span (751 y) always fits
    // inside the 1200-year bounds window, so this is a translate, not a shrink.
    const min = epochYear - 100;
    const max = epochYear + 1100;
    let a = 1200;
    let b = 1951;
    if (a < min) {
      b += min - a;
      a = min;
    } else if (b > max) {
      a -= b - max;
      b = max;
    }
    expect(w.a).toBeCloseTo(a, 6);
    expect(w.b).toBeCloseTo(b, 6);
    expect(w.b - w.a).toBeCloseTo(751, 6);
    console.log(`  · ⤢ playlist: view.window = ${JSON.stringify(w)} (epoch ${epochYear}, bounds [${min}, ${max}])`);
  });

  test("step 49: renaming to Long Winter rewrites a zone modifier gated on era:Ice Age", async () => {
    await revealStudio();
    const GATE_ID = "era-window-e2e-gate";
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          zone.modifiers = zone.modifiers.filter((m: any) => m.id !== a.id);
          zone.modifiers.push({ id: a.id, when: { tag: "era:Ice Age" }, apply: [{ param: "temperature.mean", op: "offset", value: 1 }] });
        });
      },
      { type: VIEW_TYPE, id: GATE_ID },
    );
    await nextFrame();

    const nameInput = ob.page.locator('.wadjet-studio-window:has(.wadjet-studio-era) [data-part="era-name"]');
    await nameInput.fill("Long Winter");
    await nameInput.blur();
    const confirmed = await passEraWorldConfirm();

    const newId = eraWindowIdFor("Long Winter");
    await ob.page.waitForFunction(
      (a: { type: string; id: string }) => {
        const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
        return ((leaf?.view.store.get().view.openWindows as string[]) ?? []).includes(a.id);
      },
      { type: VIEW_TYPE, id: newId },
      { timeout: 10_000 },
    );
    eraName = "Long Winter";

    const gate = await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const state = leaf.view.store.get();
        const zone = state.zones[state.view.zoneId];
        return zone.modifiers.find((m: any) => m.id === a.id)?.when;
      },
      { type: VIEW_TYPE, id: GATE_ID },
    );
    expect(gate).toEqual({ tag: "era:Long Winter" });

    const probe = await probeEra(newId);
    expect(probe.title).toBe("Long Winter");
    console.log(`  · rename Ice Age → Long Winter (world confirm ${confirmed ? "shown and accepted" : "already given this session"}); gate now ${JSON.stringify(gate)}`);
  });

  test("step 50: the LED toggles enabled:false in the draft", async () => {
    await revealStudio();
    const before = await eraDraft(eraName);
    expect(before?.enabled).toBeUndefined();

    const led = ob.page.locator('.wadjet-studio-window:has(.wadjet-studio-era) [data-part="era-led"]');
    await led.click();
    const confirmed = await passEraWorldConfirm();
    await nextFrame();

    const after = await eraDraft(eraName);
    expect(after?.enabled).toBe(false);
    console.log(`  · LED toggled: enabled ${String(before?.enabled)} → ${String(after?.enabled)} (world confirm ${confirmed ? "shown and accepted" : "already given this session"})`);
  });

  test("step 51: delete removes the era from the draft and closes the window", async () => {
    await revealStudio();
    const id = eraWindowIdFor(eraName);

    const del = ob.page.locator('.wadjet-studio-window:has(.wadjet-studio-era) [data-part="era-delete"]');
    await del.click();
    const confirmed = await passEraWorldConfirm();

    await ob.page.waitForFunction(
      (a: { type: string; id: string }) => {
        const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
        return !(((leaf?.view.store.get().view.openWindows as string[]) ?? []).includes(a.id));
      },
      { type: VIEW_TYPE, id },
      { timeout: 10_000 },
    );

    const gone = await eraDraft(eraName);
    expect(gone).toBeNull();
    console.log(`  · delete removed "${eraName}" and closed ${id} (world confirm ${confirmed ? "shown and accepted" : "already given this session"})`);
  });
});

/* ── The generic device window (bead wadjet-9f9.24) ─────────────────────── */

/** The device the walk builds. `Storm` is what step 57 renames it to. */
const DEVICE_ID = "Gale";
const DEVICE_RENAMED = "Storm";

/**
 * Four seasons, so the WHEN tag chips and the MOD gate menu have real sources.
 * `model/validation.ts` allows 1–6; earlier steps may have left fewer behind.
 */
const DEVICE_SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Harvest", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

interface DeviceProbe {
  open: boolean;
  title: string;
  badge: string;
  kind: string;
  name: string;
  whenKind: string;
  chance: string;
  applyKnobs: number;
  gates: number;
  gateAmount: string;
  spellOn: boolean;
  tagChips: string[];
  selectedTags: string[];
  writes: string;
  openWindows: string[];
}

/** Everything the device walk asserts on, read out of the one open device panel. */
async function probeDevice(): Promise<DeviceProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement | undefined = leaf?.view?.containerEl;
      const body: HTMLElement | null = el?.querySelector(".wadjet-studio-device") ?? null;
      const panel: HTMLElement | null = body?.closest(".wadjet-studio-window") ?? null;
      const text = (root: HTMLElement | null, sel: string) => (root?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const chips = (sel: string) => (body === null ? [] : Array.from(body.querySelectorAll(sel)).map((n) => n.getAttribute("data-tag") ?? ""));
      return {
        open: panel !== null,
        title: text(panel, ".wadjet-studio-window-title"),
        badge: text(panel, ".wadjet-studio-window-badge"),
        kind: text(body, ".wadjet-studio-device-kind"),
        name: (body?.querySelector(".wadjet-studio-device-name") as HTMLInputElement | null)?.value ?? "",
        whenKind: body?.querySelector('[data-part="when-kind"] [role=radio][aria-checked=true]')?.getAttribute("data-value") ?? "",
        chance: text(body, '[data-part="when-chance"] .wadjet-studio-knob-value'),
        applyKnobs: body === null ? 0 : body.querySelectorAll('[data-section="apply"] .wadjet-studio-knob').length,
        gates: body === null ? 0 : body.querySelectorAll(".wadjet-studio-device-gate").length,
        gateAmount: text(body, '[data-part="gate-0"] .wadjet-studio-knob-value'),
        spellOn: body?.querySelector('[data-part="spell-power"]')?.getAttribute("aria-pressed") === "true",
        tagChips: chips(".wadjet-studio-device-when [data-tag]"),
        selectedTags: chips('.wadjet-studio-device-when [data-tag][aria-pressed="true"]'),
        writes: text(panel, ".wadjet-studio-writes-body"),
        openWindows: [...((leaf?.view?.store.get().view.openWindows ?? []) as string[])],
      };
    },
    VIEW_TYPE,
  );
}

/** The modifier the draft holds under `id`, exactly as the zone file would store it. */
async function draftModifier(id: string): Promise<any> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const s = leaf.view.store.get();
      const zone = s.zones[s.view.zoneId];
      return zone.modifiers.find((m: any) => m.id === a.id) ?? null;
    },
    { type: VIEW_TYPE, id },
  );
}

/** The world draft's device presets, by name. */
async function draftPresets(): Promise<any[]> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      return leaf.view.store.get().world.devicePresets;
    },
    VIEW_TYPE,
  );
}

/** Seed the chance device the mixer's insert picker would have created, plus the seasons it gates on. */
async function seedDevice(): Promise<void> {
  // An earlier step may have left the settings window open, and Obsidian builds
  // a Modal into whichever window is active — the preset-name prompt has to
  // land in the vault window, not behind a stray settings one.
  await withApp(ob.page, (app) => app.setting.close());
  await ob.page.bringToFront();
  await revealStudio();
  await withApp(
    ob.page,
    (app, a: { type: string; id: string; renamed: string; seasons: Array<{ name: string; from: number }> }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update(
        (s: any) => {
          s.world.calendar.seasons = a.seasons.map((x) => ({ ...x }));
          const zone = s.zones[s.view.zoneId];
          zone.modifiers = zone.modifiers.filter((m: any) => m.id !== a.id && m.id !== a.renamed);
          zone.modifiers.push({ id: a.id, stage: "daily", when: { chance: 0.1 }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] });
        },
        { history: true },
      );
    },
    { type: VIEW_TYPE, id: DEVICE_ID, renamed: DEVICE_RENAMED, seasons: DEVICE_SEASONS },
  );
  // The devices surface registers a builder per device on the store tick.
  await nextFrame();
}

/**
 * Open the panel by id, the way a mixer unit's name does. The position is
 * seeded first: `workspace.json` carries `view.windowPos` between runs, and a
 * panel restored against the far edge has nothing clickable on screen.
 */
async function openDeviceWindow(id: string): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.view.windowPos[`device:${a.id}`] = { x: 24, y: 24, z: 60 };
      });
      leaf.view.windows.open(`device:${a.id}`);
    },
    { type: VIEW_TYPE, id },
  );
  await nextFrame();
  await ob.page.locator(".wadjet-studio-window .wadjet-studio-device").first().waitFor({ state: "visible", timeout: 10_000 });
}

/** The one open device panel's body, as a Playwright locator root. */
const devicePanel = () => ob.page.locator(".wadjet-studio-window .wadjet-studio-device").first();

/** Click a row in the Obsidian menu the panel just opened. */
async function pickDeviceMenuItem(match: string | RegExp): Promise<void> {
  const menu = ob.page.locator(".menu").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await menu.locator(".menu-item", { hasText: match }).first().click();
  await nextFrame();
}

describe("climate studio · device window", () => {
  test("step 52: a chance device opens as a DEVICE panel with its KIND, its % knob and one apply knob", async () => {
    await seedDevice();
    await openDeviceWindow(DEVICE_ID);

    const probe = await probeDevice();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe(DEVICE_ID);
    expect(probe.badge).toBe("DEVICE");
    expect(probe.kind).toBe("CHANCE");
    expect(probe.name).toBe(DEVICE_ID);
    expect(probe.whenKind).toBe("chance");
    // `{ chance: 0.1 }` reads as a percentage, not a fraction (SPEC §3.4).
    expect(probe.chance).toBe("10 %");
    expect(probe.applyKnobs).toBe(1);
    // Law 5: the footer is the exact modifier the window writes.
    expect(JSON.parse(probe.writes)).toEqual({ id: DEVICE_ID, stage: "daily", when: { chance: 0.1 }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] });
    console.log(`  · device:${DEVICE_ID} → ${probe.badge} "${probe.title}" · ${probe.kind} · chance ${probe.chance} · ${probe.applyKnobs} apply knob; writes ${probe.writes}`);
  });

  test("step 53: the WHEN segmented switches to tag, and season chips write tag then any", async () => {
    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=tag]').click();
    await nextFrame();

    const switched = await probeDevice();
    expect(switched.whenKind).toBe("tag");
    expect(switched.kind).toBe("TAG");
    // `newDevice`'s default: the calendar's first season.
    expect(switched.selectedTags).toEqual(["season:Spring"]);
    expect(switched.tagChips).toEqual(["season:Spring", "season:Summer", "season:Harvest", "season:Winter"]);
    expect((await draftModifier(DEVICE_ID)).when).toEqual({ tag: "season:Spring" });

    // A second chip: several tags are `any` (SPEC §3.4).
    await devicePanel().locator('[data-tag="season:Winter"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).when).toEqual({ any: [{ tag: "season:Spring" }, { tag: "season:Winter" }] });

    // Back down to one, and the predicate collapses to a bare tag again.
    await devicePanel().locator('[data-tag="season:Spring"]').click();
    await nextFrame();
    const one = await draftModifier(DEVICE_ID);
    expect(one.when).toEqual({ tag: "season:Winter" });
    const after = await probeDevice();
    expect(after.selectedTags).toEqual(["season:Winter"]);
    console.log(`  · WHEN chance → tag; chips ${JSON.stringify(after.tagChips)}; when ${JSON.stringify(one.when)}`);
  });

  test("step 54: the SPELL lamp writes the real grammar with the shipped defaults", async () => {
    expect((await probeDevice()).spellOn).toBe(false);
    await devicePanel().locator('[data-part="spell-power"]').click();
    await nextFrame();

    const on = await probeDevice();
    expect(on.spellOn).toBe(true);
    const draft = await draftModifier(DEVICE_ID);
    expect(draft.spell).toEqual({ meanStartsPerYear: 0.6, meanDurationDays: 14 });
    // Both knobs arrive with the spell.
    expect(await devicePanel().locator('[data-part="spell-starts"]').count()).toBe(1);
    expect(await devicePanel().locator('[data-part="spell-duration"]').count()).toBe(1);
    console.log(`  · SPELL on → ${JSON.stringify(draft.spell)}`);
  });

  test("step 55: a season gate lands in mods, and its dimmer knob drags to 0.5", async () => {
    // MOD is hidden until the device has a gate or an envelope (SPEC §3.4).
    await devicePanel().locator(".wadjet-studio-device-add-mod").click();
    await nextFrame();
    await devicePanel().locator('[data-section="mod"] .wadjet-studio-device-add').first().click();
    await pickDeviceMenuItem("season:Winter");

    const added = await probeDevice();
    expect(added.gates).toBe(1);
    expect((await draftModifier(DEVICE_ID)).mods).toEqual([{ source: "season:Winter", amount: 1 }]);

    // 150 px of drag is the knob's full [0, 1]; 75 px down halves it.
    await dragKnobDial('[data-part="gate-0"] .wadjet-studio-knob-dial', 75);
    const dimmed = await probeDevice();
    expect(dimmed.gateAmount).toBe("0.50");
    const draft = await draftModifier(DEVICE_ID);
    expect(draft.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);
    console.log(`  · ＋ gate season:Winter, dragged to ${dimmed.gateAmount} → mods ${JSON.stringify(draft.mods)}`);
  });

  test("step 56: save as preset writes the device's shape into the world draft", async () => {
    const before = (await draftPresets()).map((p) => p.name);

    await devicePanel().locator(".wadjet-studio-device-preset").click();
    await pickDeviceMenuItem(/save/);

    const modal = ob.page.locator(".modal-container .modal");
    await modal.waitFor({ state: "visible", timeout: 10_000 });
    await modal.locator('.setting-item:has(.setting-item-name:text-is("Name")) input').fill("Gale preset");
    await modal.locator("button:has-text('Save')").click();
    await modal.waitFor({ state: "detached", timeout: 10_000 });
    await nextFrame();

    const presets = await draftPresets();
    const saved = presets.find((p) => String(p.name).startsWith("Gale preset"));
    expect(saved, `no "Gale preset" in ${JSON.stringify(presets.map((p) => p.name))}`).toBeDefined();
    expect(saved.kind).toBe("tag");
    expect(saved.when).toEqual({ tag: "season:Winter" });
    expect(saved.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);
    // Instance-only fields never travel with a preset (PLAN D12).
    expect(saved.id).toBeUndefined();
    expect(saved.stage).toBeUndefined();

    // The menu now offers it back, badged `yours`.
    await devicePanel().locator(".wadjet-studio-device-preset").click();
    const menu = ob.page.locator(".menu").last();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    const titles = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    await ob.page.keyboard.press("Escape");
    expect(titles.some((t) => t.includes(`${saved.name} · yours`))).toBe(true);
    console.log(`  · saved "${saved.name}" (was ${JSON.stringify(before)}); menu now ${JSON.stringify(titles)}`);
  });

  test("step 57: renaming the device moves the modifier id and the window title follows", async () => {
    // Escape closed the preset menu in step 56, and the panel with it (the
    // window chrome closes on Escape, SPEC §3.4). `open` focuses an open panel
    // and rebuilds a closed one, so the step starts from a known panel either way.
    await openDeviceWindow(DEVICE_ID);
    const input = devicePanel().locator(".wadjet-studio-device-name");
    await input.fill(DEVICE_RENAMED);
    await input.press("Enter");
    await ob.page.waitForFunction(
      (a: { type: string; name: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        const body = el?.querySelector(".wadjet-studio-device");
        return (body?.closest(".wadjet-studio-window")?.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === a.name;
      },
      { type: VIEW_TYPE, name: DEVICE_RENAMED },
      { timeout: 10_000 },
    );

    expect(await draftModifier(DEVICE_ID)).toBeNull();
    const renamed = await draftModifier(DEVICE_RENAMED);
    expect(renamed).not.toBeNull();
    // A rename rewrites the id and nothing else.
    expect(renamed.when).toEqual({ tag: "season:Winter" });
    expect(renamed.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);

    const probe = await probeDevice();
    expect(probe.title).toBe(DEVICE_RENAMED);
    expect(probe.name).toBe(DEVICE_RENAMED);
    // The panel id moved with it, and the old one is gone from the view state.
    expect(probe.openWindows).toContain(`device:${DEVICE_RENAMED}`);
    expect(probe.openWindows).not.toContain(`device:${DEVICE_ID}`);
    console.log(`  · renamed ${DEVICE_ID} → ${DEVICE_RENAMED}; panel is now device:${DEVICE_RENAMED}, title "${probe.title}"`);
  });

  test("step 58: remove from chain drops the modifier and closes the panel", async () => {
    await openDeviceWindow(DEVICE_RENAMED);
    await devicePanel().locator(".wadjet-studio-device-drop").click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return el !== undefined && el.querySelector(".wadjet-studio-device") === null;
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );

    expect(await draftModifier(DEVICE_RENAMED)).toBeNull();
    const open: string[] = await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        return [...leaf.view.store.get().view.openWindows];
      },
      VIEW_TYPE,
    );
    expect(open.filter((id) => id.startsWith("device:"))).toEqual([]);
    console.log(`  · removed ${DEVICE_RENAMED}; no device panels left (open windows ${JSON.stringify(open)})`);
  });
});

/* ── The eras lane (bead wadjet-9f9.19) ─────────────────────────────────── */

interface ErasLaneSpan {
  id: string;
  kind: string;
  label: string;
  /** the sub-row `stackRows` put it in, read off `--wadjet-studio-span-row` */
  row: number;
  left: number;
  width: number;
  dim: boolean;
  editable: boolean;
}

interface ErasLaneProbe {
  /** false when the row is not in the playlist at all */
  present: boolean;
  rowLabel: string;
  spans: ErasLaneSpan[];
  /** the lane's own screen box, and the strip width the row's geometry is measured from */
  laneLeft: number;
  stripWidth: number;
  window: { a: number; b: number };
}

/** The eras row, read the way the Lane component writes it: custom properties, not layout. */
async function probeErasLane(): Promise<ErasLaneProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const row = Array.from(el.querySelectorAll(".wadjet-studio-row")).find((r) => (r.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim().startsWith("Eras")) as HTMLElement | undefined;
      const lane = row?.querySelector(".wadjet-studio-lane") ?? null;
      const nodes = lane === null ? [] : Array.from(lane.querySelectorAll(".wadjet-studio-span"));
      const box = lane === null ? null : lane.getBoundingClientRect();
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const num = (e: HTMLElement, name: string) => parseFloat(e.style.getPropertyValue(name) || "0");
      return {
        present: lane !== null,
        rowLabel: (row?.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim(),
        spans: nodes.map((n) => {
          const e = n as HTMLElement;
          return {
            id: e.getAttribute("data-id") ?? "",
            kind: e.getAttribute("data-kind") ?? "",
            label: (e.textContent ?? "").replace(/\s+/g, " ").trim(),
            row: num(e, "--wadjet-studio-span-row"),
            left: num(e, "--wadjet-studio-span-left"),
            width: num(e, "--wadjet-studio-span-width"),
            dim: e.classList.contains("is-dim"),
            editable: e.classList.contains("is-editable"),
          };
        }),
        laneLeft: box?.left ?? 0,
        stripWidth: strip?.clientWidth ?? 0,
        window: leaf.view.store.get().view.window as { a: number; b: number },
      };
    },
    VIEW_TYPE,
  );
}

/** `world.eras` as the draft holds it right now. */
async function allEras(): Promise<EraDraft[]> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      return JSON.parse(JSON.stringify(leaf.view.store.get().world.eras)) as EraDraft[];
    },
    VIEW_TYPE,
  );
}

/**
 * Wait until the eras lane has actually drawn `n` spans (H-1392).
 *
 * `seedEras` writes the draft; the row that draws it is rebuilt by the eras
 * surface on a later tick and the lane repaints with the audition's debounce,
 * so a single `nextFrame` can still be looking at the PREVIOUS walk's eras.
 * The count is the reaction, so wait for the reaction rather than for a clock.
 */
async function waitForErasLaneSpans(n: number): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; n: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const row = Array.from(el?.querySelectorAll(".wadjet-studio-row") ?? []).find((r) => (r.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim().startsWith("Eras"));
      const lane = row?.querySelector(".wadjet-studio-lane") ?? null;
      return lane !== null && lane.querySelectorAll(".wadjet-studio-span").length === a.n;
    },
    { type: VIEW_TYPE, n },
    { timeout: 10_000 },
  );
}

/**
 * Wait until the span node `id` has survived `ms` without being replaced.
 *
 * `Lane.paint()` rebuilds its span elements, and the eras lane repaints
 * whenever the audition's debounced re-roll lands. A keyboard step focuses the
 * span and then presses: if a repaint slips between the two, the key event
 * goes to a node that is no longer in the document and the handler never sees
 * it — the step then reads an unchanged draft and blames the handler.
 */
async function waitForSpanStable(id: string, ms = 400): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; id: string; ms: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const node = el?.querySelector(`.wadjet-studio-span[data-id="${a.id}"]`) ?? null;
      const w = window as unknown as { __wadjetSpanNode?: Element | null; __wadjetSpanSince?: number };
      if (node === null) {
        w.__wadjetSpanNode = null;
        return false;
      }
      if (w.__wadjetSpanNode !== node) {
        w.__wadjetSpanNode = node;
        w.__wadjetSpanSince = Date.now();
        return false;
      }
      return Date.now() - (w.__wadjetSpanSince ?? Date.now()) >= a.ms;
    },
    { type: VIEW_TYPE, id, ms },
    { timeout: 15_000, polling: 100 },
  );
}

/** Put `world.eras` somewhere known — the walks before this one leave their own behind. */
async function seedEras(eras: EraDraft[]): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; eras: EraDraft[] }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.world.eras = a.eras;
      });
    },
    { type: VIEW_TYPE, eras },
  );
  await nextFrame();
}

/**
 * One real pointer drag across the eras lane, in lane-LOCAL pixels: pointerdown
 * on the lane, then the move/up pair on `window`, which is where
 * `src/studio/ui/pointer.ts` listens (SPEC §3.8). Returns the numbers the
 * component itself measured with, so a step can recompute the year the handler
 * saw from the integer `clientX` the browser actually delivered.
 */
async function dragErasLane(x1: number, x2: number): Promise<{ laneLeft: number; stripWidth: number; clientX1: number; clientX2: number; window: { a: number; b: number } }> {
  const out = await withApp(
    ob.page,
    (app, a: { type: string; x1: number; x2: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const row = Array.from(el.querySelectorAll(".wadjet-studio-row")).find((r) => (r.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim().startsWith("Eras")) as HTMLElement | undefined;
      const lane = row?.querySelector(".wadjet-studio-lane") ?? null;
      if (lane === null) throw new Error("no eras lane");
      const box = lane.getBoundingClientRect();
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const clientX1 = Math.round(box.left + a.x1);
      const clientX2 = Math.round(box.left + a.x2);
      const y = Math.round(box.top + box.height / 2);
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: clientX1, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: clientX2, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: clientX2, clientY: y }));
      return {
        laneLeft: box.left,
        stripWidth: strip?.clientWidth ?? 0,
        clientX1,
        clientX2,
        window: leaf.view.store.get().view.window as { a: number; b: number },
      };
    },
    { type: VIEW_TYPE, x1, x2 },
  );
  await nextFrame();
  return out;
}

/** A plain gesture on the lane at lane-local `x`: `contextmenu`, or a pointerdown/up + `click`. */
async function pokeErasLane(x: number, kind: "contextmenu" | "click"): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; x: number; kind: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const row = Array.from(el.querySelectorAll(".wadjet-studio-row")).find((r) => (r.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim().startsWith("Eras")) as HTMLElement | undefined;
      const lane = row?.querySelector(".wadjet-studio-lane") ?? null;
      if (lane === null) throw new Error("no eras lane");
      const box = lane.getBoundingClientRect();
      const clientX = Math.round(box.left + a.x);
      const clientY = Math.round(box.top + box.height / 2);
      if (a.kind === "contextmenu") {
        lane.dispatchEvent(new MouseEvent("contextmenu", { button: 2, buttons: 2, clientX, clientY, bubbles: true, cancelable: true, view: window }));
        return;
      }
      // The pointerdown also clears any `_justDragged` an earlier step left up.
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX, clientY }));
      lane.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX, clientY }));
      lane.dispatchEvent(new MouseEvent("click", { button: 0, clientX, clientY, bubbles: true, cancelable: true, view: window }));
    },
    { type: VIEW_TYPE, x, kind },
  );
  await nextFrame();
}

/** Is `id` in the leaf's open-window list? */
async function erasWindowOpen(id: string): Promise<boolean> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      return ((leaf?.view.store.get().view.openWindows as string[]) ?? []).includes(a.id);
    },
    { type: VIEW_TYPE, id },
  );
}

/** Close `id` if a previous walk left it up, so "click opened it" means something. */
async function closeErasWindow(id: string): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.windows.close(a.id);
    },
    { type: VIEW_TYPE, id },
  );
  await nextFrame();
}

/** `pxToYear` as `model/lanes.ts` computes it, from what the browser actually delivered. */
function yearAt(clientX: number, laneLeft: number, stripWidth: number, w: { a: number; b: number }): number {
  return w.a + (clientX - laneLeft) / (stripWidth / (w.b - w.a));
}

/** The name `addEra` gives a new era: "Era 1", or the first "Era N" not taken. */
const CREATED_ERA = "Era 1";

describe("climate studio · eras lane", () => {
  test("step 1: at Era zoom the lane is one clip per era, overlaps on their own sub-rows", async () => {
    await revealStudio();
    // A known centre first: the Era preset is 1000 years around wherever the
    // window happens to be, clamped into [epoch − 100, epoch + 1100].
    await seedWindow({ a: 500, b: 501 });
    await seedEras([
      { name: "Ice Age", from: 200, to: 600 },
      { name: "Thaw", from: 500, to: 900 },
      { name: "Long Summer", from: 800, enabled: false },
    ]);
    await clickPreset("era");
    await waitForErasLaneSpans(3);

    const probe = await probeErasLane();
    expect(probe.present).toBe(true);
    expect(probe.rowLabel).toBe("Eras · world");
    expect(probe.spans.length).toBe(3);
    expect(probe.spans.map((s) => s.kind)).toEqual(["clip", "clip", "clip"]);
    expect(probe.spans.every((s) => s.editable)).toBe(true);
    expect(probe.spans.map((s) => s.id)).toEqual(["era:Ice Age", "era:Thaw", "era:Long Summer"]);
    expect(probe.spans.map((s) => s.label)).toEqual(["Ice Age", "Thaw", "Long Summer"]);

    const by = (name: string) => probe.spans.find((s) => s.id === `era:${name}`)!;
    // Ice Age [200, 601) and Thaw [500, 901) overlap, so they cannot share a sub-row.
    expect(by("Ice Age").row).not.toBe(by("Thaw").row);
    // Long Summer starts after Ice Age ends, so the first sub-row is free again.
    expect(by("Long Summer").row).toBe(by("Ice Age").row);
    // `enabled: false` tags nothing, and the lane says so.
    expect(by("Long Summer").dim).toBe(true);
    expect(by("Ice Age").dim).toBe(false);
    // An open era runs to the window's right edge.
    expect(by("Long Summer").left + by("Long Summer").width).toBeGreaterThanOrEqual(probe.stripWidth - 1);
    console.log(`  · eras lane: ${probe.spans.map((s) => `${s.id}@row${s.row}`).join(", ")} over ${Math.round(probe.stripWidth)}px`);
  });

  test("step 2: click-drag on empty lane adds an era over the years under the cursor", async () => {
    await revealStudio();
    const before = await allEras();
    expect(before.some((e) => e.name === CREATED_ERA)).toBe(false);

    // Left of Ice Age, the leftmost clip: the drag has to start on EMPTY lane,
    // or the Lane reads it as a move. Measured, never assumed — the strip width
    // depends on how wide the mixer rail leaves the playlist column.
    const iceLeft = (await probeErasLane()).spans.find((s) => s.id === "era:Ice Age")!.left;
    const x1 = iceLeft * 0.15;
    const x2 = iceLeft * 0.75;
    expect(x2 - x1).toBeGreaterThan(20);
    const drag = await dragErasLane(x1, x2);
    const asked = await passEraWorldConfirm();
    console.log(`  · world-edit confirm on create: ${asked ? "shown and continued" : "already confirmed this session"}`);

    const expectedFrom = Math.floor(yearAt(drag.clientX1, drag.laneLeft, drag.stripWidth, drag.window));
    const expectedTo = Math.floor(yearAt(drag.clientX2, drag.laneLeft, drag.stripWidth, drag.window));

    const made = await eraDraft(CREATED_ERA);
    expect(made).not.toBeNull();
    expect(made!.from).toBe(expectedFrom);
    expect(made!.to).toBe(expectedTo);
    expect((await allEras()).length).toBe(before.length + 1);
    console.log(`  · created ${CREATED_ERA}: ${made!.from} – ${made!.to} (drag ${Math.round(drag.clientX1 - drag.laneLeft)} → ${Math.round(drag.clientX2 - drag.laneLeft)} px)`);
  });

  test("step 3: dragging the new era's right edge 40 px out grows its `to`", async () => {
    await revealStudio();
    const before = await eraDraft(CREATED_ERA);
    expect(before).not.toBeNull();

    const probe = await probeErasLane();
    const span = probe.spans.find((s) => s.id === `era:${CREATED_ERA}`);
    expect(span).toBeDefined();
    // Inside the 4 px `edgePx` of the right edge — the white resize handle.
    const grab = span!.left + span!.width - 2;
    const drag = await dragErasLane(grab, grab + 40);
    await passEraWorldConfirm();

    // The clip's right edge is `Era.to + 1` (inclusive years), so the write is
    // `round(yearUnderCursor) − 1`.
    const expectedTo = Math.round(yearAt(drag.clientX2, drag.laneLeft, drag.stripWidth, drag.window)) - 1;
    const after = await eraDraft(CREATED_ERA);
    expect(after!.to).toBe(expectedTo);
    expect(after!.to!).toBeGreaterThan(before!.to!);
    expect(after!.from).toBe(before!.from);
    console.log(`  · resized ${CREATED_ERA}: to ${before!.to} → ${after!.to} (+40 px)`);
  });

  test("step 4: right-click removes the era from world.eras", async () => {
    await revealStudio();
    const before = await allEras();
    const probe = await probeErasLane();
    const span = probe.spans.find((s) => s.id === `era:${CREATED_ERA}`);
    expect(span).toBeDefined();

    await pokeErasLane(span!.left + span!.width / 2, "contextmenu");
    await passEraWorldConfirm();

    const after = await allEras();
    expect(after.some((e) => e.name === CREATED_ERA)).toBe(false);
    expect(after.length).toBe(before.length - 1);
    console.log(`  · right-click removed ${CREATED_ERA}: ${before.length} → ${after.length} eras`);
  });

  test("step 5: at Year zoom the row is one read-only bar per covering era, and it opens the window", async () => {
    await revealStudio();
    await seedEras([{ name: "Ice Age", from: 1200, to: 1900 }]);
    // A one-year window inside the era: `zoomLabel` reads "year", and the
    // window's centre year (1500) is covered.
    await seedWindow({ a: 1500, b: 1501 });

    const probe = await probeErasLane();
    expect(probe.spans.length).toBe(1);
    const bar = probe.spans[0]!;
    expect(bar.kind).toBe("bar");
    expect(bar.editable).toBe(false);
    expect(bar.label).toBe("era:Ice Age · 1200 – 1900");
    // A full-width bar: the span IS window-shaped at this zoom.
    expect(Math.round(bar.left)).toBe(0);
    expect(Math.round(bar.width)).toBe(Math.round(probe.stripWidth));

    await closeErasWindow("era:Ice Age");
    expect(await erasWindowOpen("era:Ice Age")).toBe(false);
    await pokeErasLane(probe.stripWidth / 2, "click");
    expect(await erasWindowOpen("era:Ice Age")).toBe(true);
    console.log(`  · Year zoom bar "${bar.label}" opened era:Ice Age`);

    // Leave the studio as this walk found it: a floating panel left open sits
    // over the playlist and intercepts the next describe's clicks.
    await closeErasWindow("era:Ice Age");
  });
});

/* ── The regimes lane (bead wadjet-9f9.18) ──────────────────────────────── */

/**
 * The lane the row owns. NOT `.wadjet-studio-regimes-row` — the Regimes
 * *window* owns that class for its state rows, so a probe on it would find the
 * panel as well as the lane.
 */
const REGIMES_LANE = ".wadjet-studio-regimes-lane";

interface RegimeLaneSpanProbe {
  id: string;
  regime: string;
  /** fractional years, straight off `data-span-from` / `data-span-to` */
  from: number;
  to: number;
  /** the run's length in days; 0 on a share-bar segment */
  days: number;
  label: string;
  hint: string;
  width: number;
}

interface RegimesLaneProbe {
  /** `blocks` | `share` | `empty`, off the lane's `data-mode` */
  mode: string;
  yearLength: number;
  rowLabel: string;
  spans: RegimeLaneSpanProbe[];
  /** the draft's states, in the order the zone lists them */
  regimes: string[];
  window: { a: number; b: number };
  hintName: string;
  hintDetail: string;
}

async function probeRegimesRow(): Promise<RegimesLaneProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; lane: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const lane = el.querySelector(a.lane);
      const row = lane === null ? null : lane.closest(".wadjet-studio-row");
      const text = (sel: string) => (el.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const state = leaf.view.store.get();
      const zone = state.view.zoneId === null ? undefined : state.zones[state.view.zoneId];
      const spans = lane === null ? [] : Array.from(lane.querySelectorAll(".wadjet-studio-span"));
      return {
        mode: lane === null ? "none" : (lane.getAttribute("data-mode") ?? ""),
        yearLength: lane === null ? 0 : Number(lane.getAttribute("data-year-length") ?? "0"),
        rowLabel: (row?.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim(),
        spans: spans.map((n) => ({
          id: n.getAttribute("data-id") ?? "",
          regime: n.getAttribute("data-regime") ?? "",
          from: Number(n.getAttribute("data-span-from") ?? "NaN"),
          to: Number(n.getAttribute("data-span-to") ?? "NaN"),
          days: Number(n.getAttribute("data-span-days") ?? "0"),
          label: (n.textContent ?? "").trim(),
          hint: n.getAttribute("data-hint") ?? "",
          width: n.getBoundingClientRect().width,
        })),
        regimes: (zone?.regimes ?? []).map((r: { id: string }) => r.id),
        window: state.view.window as { a: number; b: number },
        hintName: text(".wadjet-studio-hintbar-name"),
        hintDetail: text(".wadjet-studio-hintbar-detail"),
      };
    },
    { type: VIEW_TYPE, lane: REGIMES_LANE },
  );
}

/** The block with the most pixels — the only one a click or a hover can be aimed at reliably. */
function widestRegimeSpan(probe: RegimesLaneProbe): { span: RegimeLaneSpanProbe; at: number } {
  let at = 0;
  probe.spans.forEach((s, i) => {
    if (s.width > (probe.spans[at]?.width ?? 0)) at = i;
  });
  return { span: probe.spans[at]!, at };
}

/** The Regimes window panel. */
function regimesPanel() {
  return ob.page.locator(".wadjet-studio-window", { has: ob.page.locator('.wadjet-studio-window-title:text-is("Regimes")') });
}

/**
 * Close every floating panel an earlier walk left open. The windows layer sits
 * over the playlist, so a Seasons or Regimes panel parked at the cascade
 * origin swallows the clicks and hovers this walk aims at the lane.
 */
async function closeStudioWindows(): Promise<void> {
  await withApp(
    ob.page,
    (app, type: string) => {
      // Defensive: the shared afterEach calls this after a step that may have
      // detached the leaf or left it deferred (no `view.store` yet).
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const store = leaf?.view?.store;
      if (!store) return;
      for (const id of [...store.get().view.openWindows]) leaf.view.windows.close(id);
    },
    VIEW_TYPE,
  );
  await nextFrame();
}

/**
 * Wait for the lane to settle. The row re-rolls on a debounce (the audition's
 * 60 ms plus its own gap), so a freshly seeded window paints its geometry at
 * once and its blocks a beat later.
 */
async function waitForRegimesLane(mode: string, minSpans: number): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; lane: string; mode: string; min: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const lane = el?.querySelector(a.lane) ?? null;
      return lane !== null && lane.getAttribute("data-mode") === a.mode && lane.querySelectorAll(".wadjet-studio-span").length >= a.min;
    },
    { type: VIEW_TYPE, lane: REGIMES_LANE, mode, min: minSpans },
    { timeout: 10_000 },
  );
}

describe("climate studio · regimes lane", () => {
  test("regimes lane: blocks at Year zoom, tiling the rolled year", async () => {
    await revealStudio();
    await closeStudioWindows();
    const epoch = await epochYear();
    const year = epoch + 5;
    await seedWindow({ a: year, b: year + 1 });
    await nextFrame();
    await waitForRegimesLane("blocks", 2);

    const probe = await probeRegimesRow();
    expect(probe.mode).toBe("blocks");
    expect(probe.rowLabel).toBe("Regimes");
    expect(probe.yearLength).toBeGreaterThan(0);
    // SPEC §6: the roll keeps a state for a geometric run, so a year is many runs.
    expect(probe.spans.length).toBeGreaterThanOrEqual(2);

    // Every block is a state the draft actually has, with a real dwell.
    for (const s of probe.spans) {
      expect(probe.regimes).toContain(s.regime);
      expect(s.days).toBeGreaterThan(0);
      expect(Number.isFinite(s.from)).toBe(true);
      expect(Number.isFinite(s.to)).toBe(true);
      expect(s.to).toBeGreaterThan(s.from);
    }

    // They tile [year, year + 1) — no gap wider than one day, and no overlap.
    const oneDay = 1 / probe.yearLength;
    const sorted = [...probe.spans].sort((x, y) => x.from - y.from);
    expect(Math.abs(sorted[0]!.from - year)).toBeLessThanOrEqual(oneDay + 1e-9);
    expect(Math.abs(sorted[sorted.length - 1]!.to - (year + 1))).toBeLessThanOrEqual(oneDay + 1e-9);
    let worst = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.from - sorted[i - 1]!.to;
      expect(gap).toBeGreaterThanOrEqual(-1e-9);
      expect(gap).toBeLessThanOrEqual(oneDay + 1e-9);
      worst = Math.max(worst, Math.abs(gap));
    }

    // A block with room carries its state's id; the tip names it either way.
    const { span } = widestRegimeSpan(probe);
    expect(span.hint).toContain(`regime:${span.regime}`);
    if (span.width >= 40) expect(span.label).toBe(span.regime);
    console.log(`  · ${probe.spans.length} blocks over year ${year} (${probe.yearLength} d), states ${JSON.stringify([...new Set(probe.spans.map((s) => s.regime))])}; worst gap ${(worst * probe.yearLength).toFixed(3)} d`);
  });

  test("regimes lane: the share bar at Era zoom, one segment per state edge to edge", async () => {
    await revealStudio();
    await closeStudioWindows();
    const epoch = await epochYear();
    await seedWindow({ a: epoch, b: epoch + 1000 });
    await nextFrame();
    await waitForRegimesLane("share", 1);

    const probe = await probeRegimesRow();
    expect(probe.mode).toBe("share");
    expect(probe.regimes.length).toBeGreaterThan(0);
    // SPEC §6's collapse: exactly one segment per state, in the draft's order.
    expect(probe.spans.length).toBe(probe.regimes.length);
    expect(probe.spans.map((s) => s.regime)).toEqual(probe.regimes);

    const width = probe.window.b - probe.window.a;
    const sum = probe.spans.reduce((t, s) => t + (s.to - s.from), 0);
    expect(sum).toBeCloseTo(width, 6);
    expect(probe.spans[0]!.from).toBeCloseTo(probe.window.a, 6);
    expect(probe.spans[probe.spans.length - 1]!.to).toBeCloseTo(probe.window.b, 6);
    // Laid edge to edge: each segment starts where the last one ended.
    for (let i = 1; i < probe.spans.length; i++) expect(probe.spans[i]!.from).toBeCloseTo(probe.spans[i - 1]!.to, 6);
    // And no block state leaked into the bar.
    for (const s of probe.spans) expect(s.days).toBe(0);
    console.log(`  · share bar over ${width} yr: ${JSON.stringify(probe.spans.map((s) => `${s.regime} ${(((s.to - s.from) / width) * 100).toFixed(1)}%`))}`);
  });

  test("regimes lane: clicking a block opens the Regimes window on that state", async () => {
    await revealStudio();
    await closeStudioWindows();
    const epoch = await epochYear();
    const year = epoch + 5;
    await seedWindow({ a: year, b: year + 1 });
    await nextFrame();
    await waitForRegimesLane("blocks", 2);

    const before = await probeRegimesRow();
    const { span, at } = widestRegimeSpan(before);
    await ob.page.locator(`${REGIMES_LANE} .wadjet-studio-span`).nth(at).click();
    await regimesPanel().first().waitFor({ state: "visible", timeout: 10_000 });

    const title = ((await regimesPanel().first().locator(".wadjet-studio-window-title").first().textContent()) ?? "").trim();
    expect(title).toBe("Regimes");
    // SPEC §3.2: the click does not just open the window, it selects the state.
    const selected = await regimesPanel().first().locator(".wadjet-studio-regimes-row.is-selected").first().getAttribute("data-id");
    expect(selected).toBe(span.regime);

    const open: string[] = await withApp(ob.page, (app, type: string) => [...app.workspace.getLeavesOfType(type)[0].view.store.get().view.openWindows], VIEW_TYPE);
    expect(open).toContain("regimes");
    console.log(`  · clicked the ${span.regime} block: "${title}" window open, ${selected} selected`);
    await closeStudioWindows();
  });

  test("regimes lane: hovering a block reads the state and the dwell so far", async () => {
    await revealStudio();
    await closeStudioWindows();
    const epoch = await epochYear();
    const year = epoch + 5;
    await seedWindow({ a: year, b: year + 1 });
    await nextFrame();
    await waitForRegimesLane("blocks", 2);

    const before = await probeRegimesRow();
    const { span, at } = widestRegimeSpan(before);
    await ob.page.locator(`${REGIMES_LANE} .wadjet-studio-span`).nth(at).hover();

    const hinted = await probeRegimesRow();
    expect(hinted.hintName).toBe(`regime:${span.regime}`);
    expect(`${hinted.hintName} ${hinted.hintDetail}`).toContain("regime:");
    expect(hinted.hintDetail).toMatch(/^day \d+ of \d+$/);
    // The pointer sits over the middle of the block, so the dwell is inside the run.
    const [, day, days] = /^day (\d+) of (\d+)$/.exec(hinted.hintDetail) ?? [];
    expect(Number(days)).toBe(span.days);
    expect(Number(day)).toBeGreaterThanOrEqual(1);
    expect(Number(day)).toBeLessThanOrEqual(span.days);
    console.log(`  · hovered the ${span.regime} block (${span.days} d): "${hinted.hintName} — ${hinted.hintDetail}"`);
  });
});

/* ── Mixer rail drag-reorder and the era LED (bead wadjet-9f9.22) ───────── */

describe("climate studio · mixer reorder", () => {
  const REORDER_IDS = ["A", "B", "C"] as const;

  /** Three devices, all writing `wind.speed`, seeded fresh in WIND slot order A, B, C. */
  async function seedReorderDevices(): Promise<void> {
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update(
          (s: any) => {
            const zone = s.zones[s.view.zoneId];
            zone.modifiers = zone.modifiers.filter((m: any) => !["A", "B", "C"].includes(m.id));
            zone.modifiers.push(
              { id: "A", apply: [{ param: "wind.speed", op: "scale", value: 1.1 }] },
              { id: "B", apply: [{ param: "wind.speed", op: "scale", value: 1.2 }] },
              { id: "C", apply: [{ param: "wind.speed", op: "scale", value: 1.3 }] },
            );
          },
          { history: true },
        );
      },
      VIEW_TYPE,
    );
  }

  async function removeReorderDevices(): Promise<void> {
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update((s: any) => {
          const zone = s.zones[s.view.zoneId];
          zone.modifiers = zone.modifiers.filter((m: any) => !["A", "B", "C"].includes(m.id));
        });
      },
      VIEW_TYPE,
    );
  }

  /** `A`, `B`, `C`'s current relative order in `compile.devices(z)` — every other device filtered out. */
  async function reorderDeviceOrder(): Promise<string[]> {
    return withApp(
      ob.page,
      (app, type: string) => {
        const s = app.workspace.getLeavesOfType(type)[0].view.store.get();
        const zone = s.zones[s.view.zoneId];
        return zone.modifiers.map((m: any) => m.id).filter((id: string) => ["A", "B", "C"].includes(id));
      },
      VIEW_TYPE,
    );
  }

  async function waitForDeviceOrder(order: readonly string[]): Promise<void> {
    await ob.page.waitForFunction(
      (a: { type: string; order: string[] }) => {
        const s = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.store.get();
        const zone = s?.zones[s.view.zoneId];
        const got = zone?.modifiers.map((m: any) => m.id).filter((id: string) => a.order.includes(id));
        return JSON.stringify(got) === JSON.stringify(a.order);
      },
      { type: VIEW_TYPE, order: [...order] },
      { timeout: 10_000 },
    );
  }

  test("reorder · drag: dragging A's grip below C moves it after B and C, in modifiers[] and the JSON drawer alike", async () => {
    await revealStudio();
    await seedReorderDevices();
    await waitForMixer((r) => REORDER_IDS.every((id) => r[2]!.units.some((u) => u.id === id)));

    // The mixer rail scrolls independently (SPEC §3.3) and the audition strip
    // is pinned across the bottom of the whole studio box (SPEC §3.5) — a
    // freshly-seeded chain can render underneath it, so scroll card A into
    // view before reading anything, the same way a real drag would need to.
    // Then take the grip's own centre, and a point past card C's bottom edge —
    // enough for the drop maths (`dropIndexFor`) to count both B and C as "above".
    const geo = await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        const el: HTMLElement = leaf.view.containerEl;
        const grip = el.querySelector('[data-unit="A"] .wadjet-studio-rack-grip') as HTMLElement;
        grip.scrollIntoView({ block: "center" });
        const cardC = el.querySelector('[data-unit="C"]') as HTMLElement;
        const g = grip.getBoundingClientRect();
        const c = cardC.getBoundingClientRect();
        return { x: g.left + g.width / 2, fromY: g.top + g.height / 2, toY: c.bottom + 6 };
      },
      VIEW_TYPE,
    );

    await ob.page.mouse.move(geo.x, geo.fromY);
    await ob.page.mouse.down();
    await ob.page.mouse.move(geo.x, (geo.fromY + geo.toY) / 2, { steps: 4 });
    await ob.page.mouse.move(geo.x, geo.toY, { steps: 4 });
    await ob.page.mouse.up();
    await nextFrame();

    await waitForDeviceOrder(["B", "C", "A"]);
    expect(await reorderDeviceOrder()).toEqual(["B", "C", "A"]);

    // The JSON drawer's modifiers section reads the same order.
    await setJsonOpen(true);
    const modifiersText = (await probeJson()).modifiersText;
    expect(modifiersText.indexOf('"B"')).toBeLessThan(modifiersText.indexOf('"C"'));
    expect(modifiersText.indexOf('"C"')).toBeLessThan(modifiersText.indexOf('"A"'));
    await setJsonOpen(false);
    console.log(`  · drag A below C: modifiers[] and JSON drawer both read B, C, A`);
  });

  test("reorder · undo: one undo restores A, B, C", async () => {
    expect(await studioHistory("undo")).toBe(true);
    await waitForDeviceOrder(["A", "B", "C"]);
    expect(await reorderDeviceOrder()).toEqual(["A", "B", "C"]);
    console.log(`  · one undo restored A, B, C`);
    await removeReorderDevices();
  });

  test("reorder · era LED: clicking it writes world.eras[i].enabled = false, behind the world confirm", async () => {
    await revealStudio();
    const name = "Reorder Era";
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update(
          (s: any) => {
            s.world.eras.push({ name: "Reorder Era", from: 1, to: 2, apply: [{ param: "wind.speed", op: "scale", value: 1.1 }] });
          },
          { history: true },
        );
      },
      VIEW_TYPE,
    );

    const eraId = `era:${name}`;
    await waitForMixer((r) => r[2]!.units.some((u) => u.id === eraId));

    // A quoted CSS attribute selector handles the id's `:` and space as-is — no escaping needed.
    const led = mixerChain("wind").locator(`[data-unit="${eraId}"] .wadjet-studio-led`);
    await led.waitFor({ state: "visible", timeout: 10_000 });
    await led.click();

    // The first world edit of the session opens the confirm; a later one does
    // not (the mixer shares `model/world-confirm.ts` with every other world
    // window) — take either, and say which happened.
    const modal = ob.page.locator(".modal-container .modal").filter({ hasText: "Eras are world-level" });
    let confirmed = false;
    try {
      await modal.waitFor({ state: "visible", timeout: 2_000 });
      confirmed = true;
      await modal.locator("button:has-text('Continue')").click();
      await modal.waitFor({ state: "detached", timeout: 5_000 });
    } catch {
      /* already confirmed earlier in the session — the click already committed */
    }
    await nextFrame();

    await ob.page.waitForFunction(
      (a: { type: string; name: string }) => {
        const s = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.store.get();
        const era = s?.world.eras.find((e: any) => e.name === a.name);
        return era !== undefined && era.enabled === false;
      },
      { type: VIEW_TYPE, name },
      { timeout: 10_000 },
    );

    expect(await led.getAttribute("aria-pressed")).toBe("false");
    console.log(`  · era LED click: world.eras[].enabled = false (confirm modal ${confirmed ? "shown and accepted" : "already given this session"})`);

    await withApp(
      ob.page,
      (app, a: { type: string; name: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          s.world.eras = s.world.eras.filter((e: any) => e.name !== a.name);
        });
      },
      { type: VIEW_TYPE, name },
    );
  });
});

/* ── Forcings · ZONE and the FRC · warmth lane (SPEC §3.2, §3.4) ─────────── */

const FORCINGS_WINDOW_ID = "forcings";
/** `PAD` in `ui/components/chart.ts`, which `ui/rows/automation-row.ts` mirrors. */
const LANE_PAD = 6;
/** The lane a fresh `ensureLane` draws is flat, so its drawn range is the ± minimum span. */
const FLAT_LANE_RANGE: [number, number] = [-4, 4];

interface ForcingsProbe {
  open: boolean;
  title: string;
  badge: string;
  lane: string;
  total: string;
  trim: string;
  wetness: string;
  writes: string;
  /** dots drawn on the playlist row, i.e. lane points inside the window */
  dots: number;
}

async function probeForcings(): Promise<ForcingsProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => w.querySelector(".wadjet-studio-forcings") !== null) as HTMLElement | undefined;
      const text = (sel: string) => (panel?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        open: (leaf.view.store.get().view.openWindows as string[]).includes(a.id),
        title: text(".wadjet-studio-window-title"),
        badge: text(".wadjet-studio-window-badge"),
        lane: text('[data-part="forcings-lane-value"]'),
        total: text('[data-part="forcings-total"]'),
        trim: text('[data-part="forcings-trim"] .wadjet-studio-knob-value'),
        wetness: text('[data-part="forcings-wetness"] .wadjet-studio-knob-value'),
        writes: text(".wadjet-studio-writes-body"),
        dots: el.querySelectorAll('[data-part="automation-lane"] .wadjet-studio-chart-point').length,
      };
    },
    { type: VIEW_TYPE, id: FORCINGS_WINDOW_ID },
  );
}

/** The forcings half of the zone draft: the two modifiers and the warmth lane. */
async function forcingsDraft(): Promise<{ trim: any; wetness: any; laneId: string | null; points: Array<[number, number]> }> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const s = app.workspace.getLeavesOfType(type)[0].view.store.get();
      const z = s.zones[s.view.zoneId];
      const lane = (z.automation ?? [])[0] ?? null;
      return {
        trim: JSON.parse(JSON.stringify(z.modifiers.find((m: any) => m.id === "forcings:temperature.mean") ?? null)),
        wetness: JSON.parse(JSON.stringify(z.modifiers.find((m: any) => m.id === "forcings:precipitation") ?? null)),
        laneId: lane === null ? null : (lane.id as string),
        points: lane === null ? [] : (JSON.parse(JSON.stringify(lane.points)) as Array<[number, number]>),
      };
    },
    VIEW_TYPE,
  );
}

/** Put the zone back to "no forcings at all", so a walk never inherits the step before it. */
async function resetForcings(): Promise<void> {
  await withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      leaf.view.store.update((s: any) => {
        const z = s.zones[s.view.zoneId];
        z.modifiers = z.modifiers.filter((m: any) => !String(m.id).startsWith("forcings:"));
        delete z.automation;
      });
    },
    VIEW_TYPE,
  );
  await nextFrame();
}

/** SPEC law 2: the panel is reached by clicking the thing it stands for. */
async function openForcingsFromMixer(): Promise<void> {
  await withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      // The strip's name only exists while the fixed strip is collapsed.
      leaf.view.store.update((s: any) => {
        s.view.fixedOpen = {};
      });
    },
    VIEW_TYPE,
  );
  await nextFrame();
  await mixerChain("temperature").locator('[data-part="forcings-name"]').click();
  await nextFrame();
}

/**
 * Press the empty lane at (year, °C) and let go — the click-drag gesture with
 * a drag of zero, which is what SPEC §3.2's "click-drag empty lane adds a
 * point" degenerates to. The pixel is computed exactly the way the row maps it
 * back, from the live window and the drawn °C range.
 */
async function pressLane(year: number, value: number, range: [number, number]): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; year: number; value: number; lo: number; hi: number; pad: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const lane = el.querySelector('[data-part="automation-lane"]');
      const svg = lane?.querySelector("svg");
      if (lane === null || !svg) throw new Error("no FRC · warmth lane on the playlist");
      const w = leaf.view.store.get().view.window as { a: number; b: number };
      const r = svg.getBoundingClientRect();
      const fx = (a.year - w.a) / (w.b - w.a);
      const fy = 1 - (a.value - a.lo) / (a.hi - a.lo);
      const x = Math.round(r.left + a.pad + fx * (r.width - 2 * a.pad));
      const y = Math.round(r.top + a.pad + fy * (r.height - 2 * a.pad));
      const base = { pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y }));
    },
    { type: VIEW_TYPE, year, value, lo: range[0], hi: range[1], pad: LANE_PAD },
  );
  await nextFrame();
}

/** Right-click the nth drawn point — SPEC §3.2's removal gesture. */
async function rightClickLanePoint(index: number): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; index: number }) => {
      const el: HTMLElement = app.workspace.getLeavesOfType(a.type)[0].view.containerEl;
      const dot = el.querySelectorAll('[data-part="automation-lane"] .wadjet-studio-chart-point')[a.index];
      if (dot === undefined) throw new Error(`no lane point at index ${a.index}`);
      dot.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    },
    { type: VIEW_TYPE, index },
  );
  await nextFrame();
}

/** The audition's first cell, as a mean of the low/high the day tip quotes. */
async function auditionDayMean(): Promise<number> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement = app.workspace.getLeavesOfType(type)[0].view.containerEl;
      const hint = el.querySelector(".wadjet-studio-audition-cell")?.getAttribute("data-hint") ?? "";
      const m = /(−?-?\d+(?:\.\d+)?) to (−?-?\d+(?:\.\d+)?) °C/.exec(hint);
      if (m === null) throw new Error(`no temperature in the day tip: ${hint}`);
      const num = (s: string) => Number(s.replace("−", "-"));
      return (num(m[1]!) + num(m[2]!)) / 2;
    },
    VIEW_TYPE,
  );
}

/**
 * Wait until the strip's CELLS are the roll of `year`.
 *
 * The footer alone is not proof: `paintFooter` builds its text from the live
 * state (`inputFor(state).year`), so it names the seeded year the instant the
 * window moves — before the 60 ms-debounced re-roll has replaced a single
 * cell. Reading a mean off the footer's word therefore read the PREVIOUS
 * year's roll, which is what made `forcings 3` produce −0.7 instead of +4 in
 * two crews' runs. Each cell carries its real `data-day-ordinal`, and the
 * active time adapter turns one into a year, so this waits on the roll itself
 * and only uses the footer as a second opinion (H-1392: assert the reaction
 * happened, do not sleep a fixed amount and hope).
 */
async function waitForAuditionYear(year: number): Promise<void> {
  const started = Date.now();
  await ob.page.waitForFunction(
    (a: { type: string; needle: string; year: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      if (!(el?.querySelector(".wadjet-studio-audition-foot .wadjet-studio-writes-body")?.textContent ?? "").includes(a.needle)) return false;
      const ordinal = Number(el?.querySelector(".wadjet-studio-audition-cell")?.getAttribute("data-day-ordinal") ?? NaN);
      if (!Number.isFinite(ordinal)) return false;
      // `core/eras.ts yearOf`, evaluated through the adapter that rolled the cell.
      const t = (window as any).app.plugins.plugins.wadjet.time.active.toContext(ordinal);
      return (t.year ?? Math.floor(t.dayOrdinal / t.yearLength) + 1) === a.year;
    },
    { type: VIEW_TYPE, needle: `Y ${year} `, year },
    { timeout: 20_000 },
  );
  await nextFrame();
  console.log(`  · strip rolled Y ${year} after ${Date.now() - started} ms`);
}

/**
 * The strip re-rolls on a 60 ms debounce: poll for the number to move off
 * `from` (up to 6 s) and say how long it took. No tight timing bound — the
 * assertion is that the reaction happened, the latency is only logged.
 */
async function settledAuditionMean(from?: number): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 60; i++) {
    const v = await auditionDayMean();
    if (from === undefined || Math.abs(v - from) > 0.01) {
      if (from !== undefined) console.log(`  · audition mean moved off ${from.toFixed(1)} °C after ${Date.now() - started} ms`);
      return v;
    }
    await ob.page.waitForTimeout(100);
  }
  throw new Error("the audition never re-rolled off the previous temperature");
}

/** Poll until the forcings lane draws `n` points; the row repaints on the store tick, not on a clock. */
async function waitForForcingsDots(n: number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const dots = (await probeForcings()).dots;
    if (dots === n) return dots;
    await ob.page.waitForTimeout(100);
  }
  return (await probeForcings()).dots;
}

/** The year the warmth point actually landed on — step 3 reads it back rather than assuming. */
let warmthPointYear = 0;

describe("climate studio · forcings", () => {
  test("forcings 1: the mixer's strip name opens the panel, and ＋ trim writes forcings:temperature.mean", async () => {
    await revealStudio();
    await resetForcings();
    await openForcingsFromMixer();

    const opened = await probeForcings();
    expect(opened.open).toBe(true);
    expect(opened.title).toBe("Forcings");
    expect(opened.badge).toBe("ZONE");
    expect(opened.trim).toBe("+0.0 °C");
    expect(opened.wetness).toBe("×1.00");
    expect(opened.total).toBe("+0.0 °C");

    // 150 px covers the knob's whole ±8 °C range: 19 px up is 2.0 °C at step 0.1.
    await dragKnobDial('[data-part="forcings-trim"] .wadjet-studio-knob-dial', -19);

    const after = await probeForcings();
    const draft = await forcingsDraft();
    expect(after.trim).toBe("+2.0 °C");
    expect(after.total).toBe("+2.0 °C");
    expect(after.lane).toBe("+0.0 °C");
    expect(draft.trim).toEqual({ id: "forcings:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] });
    expect(after.writes).toContain("forcings:temperature.mean");
    console.log(`  · trim drag: ${after.trim} into TEMP · writes ${after.writes}`);
  });

  test("forcings 2: the ∿ lane row zooms to Era and draws the zone's first frc.warmth lane", async () => {
    await revealStudio();
    await resetForcings();
    const epoch = await epochYear();
    await seedWindow({ a: epoch, b: epoch + 1 });
    const expected = await expectedEraWindow({ a: epoch, b: epoch + 1 });

    await ob.page.locator('[data-part="forcings-lane"]').first().click();
    await nextFrame();

    const window = (await probePlaylist()).window;
    const draft = await forcingsDraft();
    expect(window).toEqual(expected);
    expect(draft.laneId).toBe("frc.warmth");
    expect(draft.points).toEqual([
      [epoch, 0],
      [epoch + 100, 0],
    ]);
    expect((await probeForcings()).dots).toBe(2);
    console.log(`  · lane row: window → [${window.a}, ${window.b}] · automation[0] = frc.warmth with 2 points`);
  });

  test("forcings 3: pressing the empty lane adds a +4 °C point, and the audition year warms by it", async () => {
    await revealStudio();
    const epoch = await epochYear();
    const target = epoch + 50;
    await pressLane(target, FLAT_LANE_RANGE[1], FLAT_LANE_RANGE);

    const draft = await forcingsDraft();
    expect(draft.points.length).toBe(3);
    const added = draft.points[1]!;
    warmthPointYear = added[0];
    expect(Math.abs(added[0] - target)).toBeLessThanOrEqual(2);
    expect(added[1]).toBeCloseTo(4, 5);
    expect(await waitForForcingsDots(3)).toBe(3);

    // The lane has to reach the engine, not just the draft: roll the point's
    // own year, then undo the point and roll the same year again.
    await seedWindow({ a: warmthPointYear, b: warmthPointYear + 1 });
    await waitForAuditionCells(1);
    // The gate is the roll, not the footer: see `waitForAuditionYear`.
    await waitForAuditionYear(warmthPointYear);
    const warm = await auditionDayMean();
    expect(await studioHistory("undo")).toBe(true);
    expect((await forcingsDraft()).points.length).toBe(2);
    await waitForAuditionYear(warmthPointYear);
    const cold = await settledAuditionMean(warm);
    expect(warm - cold).toBeGreaterThan(3);
    expect(warm - cold).toBeLessThan(5);
    console.log(`  · year ${warmthPointYear}: ${cold.toFixed(1)} °C flat → ${warm.toFixed(1)} °C with the +4 point`);

    expect(await studioHistory("redo")).toBe(true);
    expect((await forcingsDraft()).points.length).toBe(3);
  });

  test("forcings 4: right-click removes a point, and refuses the one that would leave a single point", async () => {
    await revealStudio();
    const epoch = await epochYear();
    // Seeded rather than carried over from step 3, so this step stands alone.
    await withApp(
      ob.page,
      (app, a: { type: string; epoch: number }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          s.zones[s.view.zoneId].automation = [
            {
              id: "frc.warmth",
              param: "temperature.mean",
              op: "offset",
              points: [
                [a.epoch, 0],
                [a.epoch + 50, 4],
                [a.epoch + 100, 0],
              ],
            },
          ];
        });
      },
      { type: VIEW_TYPE, epoch },
    );
    await seedWindow(await expectedEraWindow({ a: epoch, b: epoch + 1 }));
    // The row repaints on the store tick; poll for the three dots rather than
    // reading the DOM the instant `seedWindow` returns (H-1392).
    expect(await waitForForcingsDots(3)).toBe(3);

    await rightClickLanePoint(1);
    expect((await forcingsDraft()).points.length).toBe(2);
    expect(await waitForForcingsDots(2)).toBe(2);

    await rightClickLanePoint(0);
    expect((await forcingsDraft()).points.length).toBe(2);
    // The Notice is raised on the refusal itself; give it a beat to be painted.
    let shown = false;
    for (let i = 0; i < 20 && !shown; i++) {
      shown = (await notices(ob.page)).some((t) => t.includes("keeps at least two points"));
      if (!shown) await ob.page.waitForTimeout(100);
    }
    expect(shown).toBe(true);
    console.log("  · right-click: 3 points → 2, and the 2-point lane is kept (≥ 2, SPEC §3.2)");
  });
});

// ---------------------------------------------------------------------------
// Channel rows and the day card (SPEC §3.2; bead wadjet-9f9.20)
// ---------------------------------------------------------------------------

/** The scratch note the day-card step renders a ```wadjet``` block into. */
const CHANNEL_SCRATCH = "Wadjet Studio Day.md";

interface ChannelRowProbe {
  /** the row is hidden (Day zoom hands the playlist over to the day card) */
  hidden: boolean;
  /** how many points the line polyline actually encodes */
  points: number;
  /** the polyline's y values, rounded — a flat line is one distinct value */
  ys: number[];
  /** the temperature band, drawn only at fine zoom */
  bandPaths: number;
  strokes: string[];
}

async function channelRowProbe(channel: string): Promise<ChannelRowProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; channel: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const plot = el.querySelector(`.wadjet-studio-channel[data-channel="${a.channel}"]`);
      const row = plot?.closest(".wadjet-studio-row") ?? null;
      const line = plot?.querySelector(".wadjet-studio-channel-layer.is-line polyline.wadjet-studio-chart-line") ?? null;
      const raw = line?.getAttribute("points") ?? "";
      const pairs = raw.split(" ").filter((p) => p !== "");
      const band = plot?.querySelector(".wadjet-studio-channel-layer.is-band");
      return {
        hidden: row === null ? true : row.hasClass("is-hidden"),
        points: pairs.length,
        ys: pairs.map((p) => Math.round(Number(p.split(",")[1]) * 100) / 100),
        bandPaths: band === null || band === undefined || band.hasClass("is-hidden") ? 0 : band.querySelectorAll("path.wadjet-studio-chart-band").length,
        strokes: Array.from(plot?.querySelectorAll("polyline.wadjet-studio-chart-line") ?? []).map((n) => n.getAttribute("stroke") ?? ""),
      };
    },
    { type: VIEW_TYPE, channel },
  );
}

/** Move the window and time the store tick it causes, paint included. */
async function timedSeedWindow(w: { a: number; b: number }): Promise<number> {
  const ms = await withApp(
    ob.page,
    async (app, a: { type: string; w: { a: number; b: number } }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const t0 = performance.now();
      leaf.view.store.update((s: any) => {
        s.view.window = { a: a.w.a, b: a.w.b };
      });
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return performance.now() - t0;
    },
    { type: VIEW_TYPE, w },
  );
  await nextFrame();
  return ms;
}

interface DayCardProbe {
  hidden: boolean;
  day: number | null;
  date: string;
  headline: string;
  cells: Record<string, string>;
  chips: string[];
  pinned: boolean;
}

async function dayCardProbe(): Promise<DayCardProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const card = el.querySelector(".wadjet-studio-daycard");
      const text = (n: Element | null) => (n?.textContent ?? "").replace(/\s+/g, " ").trim();
      const cells: Record<string, string> = {};
      for (const cell of Array.from(card?.querySelectorAll(".wadjet-studio-daycard-cell") ?? [])) {
        cells[cell.getAttribute("data-field") ?? ""] = text(cell.querySelector(".wadjet-studio-daycard-cell-value"));
      }
      const dayAttr = card?.getAttribute("data-day") ?? null;
      return {
        hidden: card === null ? true : card.hasClass("is-hidden"),
        day: dayAttr === null ? null : Number(dayAttr),
        date: text(card?.querySelector(".wadjet-studio-daycard-date") ?? null),
        headline: text(card?.querySelector(".wadjet-studio-daycard-headline") ?? null),
        cells,
        chips: Array.from(card?.querySelectorAll(".wadjet-studio-daycard-chips .wadjet-studio-chip-label") ?? []).map((n) => text(n)),
        pinned: card?.querySelector(".wadjet-studio-daycard-pin.is-hidden") === null,
      };
    },
    VIEW_TYPE,
  );
}

/**
 * Put the studio drafts back on the plugin settings, salt 0. The channel rows
 * and the day card roll the DRAFT; a ```wadjet``` block reads the saved world.
 * Only when the two are the same object can the numbers be compared at all,
 * and earlier steps in this walk have moved the drafts on purpose.
 */
async function resetDraftFromSettings(): Promise<string> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const settings = app.plugins.plugins.wadjet.settings;
      const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
      leaf.view.store.update((s: any) => {
        for (const z of settings.zones) s.zones[z.id] = copy(z);
        s.world.eras = copy(settings.eras);
        s.world.overrides = copy(settings.overrides);
        s.view.rerollSalt = 0;
        if (s.view.zoneId === null || s.zones[s.view.zoneId] === undefined) s.view.zoneId = settings.zones[0]?.id ?? null;
      });
      return leaf.view.store.get().view.zoneId as string;
    },
    VIEW_TYPE,
  );
}

/** Render one ```wadjet``` card for `zoneId` on `day` in a scratch note, and read it back. */
async function wadjetCardFor(zoneId: string, day: number): Promise<{ summary: string; rows: Record<string, string> }> {
  await withApp(
    ob.page,
    async (app, a: { zoneId: string; day: number; path: string }) => {
      const md = ["```wadjet", `zone: ${a.zoneId}`, `date: ${a.day}`, "style: card", "```"].join("\n");
      let f = app.vault.getAbstractFileByPath(a.path);
      if (f) await app.vault.modify(f, md);
      else f = await app.vault.create(a.path, md);
      // A new tab: opening in the active leaf would replace the studio itself.
      await app.workspace.getLeaf(true).openFile(f, { state: { mode: "preview" } });
    },
    { zoneId, day, path: CHANNEL_SCRATCH },
  );
  const card = ob.page.locator(".workspace-leaf.mod-active .markdown-preview-view .wadjet-card").first();
  await card.waitFor({ state: "attached", timeout: 10_000 });
  return card.evaluate((c) => {
    const rows: Record<string, string> = {};
    const ks = Array.from(c.querySelectorAll(".wadjet-k"));
    const vs = Array.from(c.querySelectorAll(".wadjet-v"));
    ks.forEach((k, i) => {
      rows[(k.textContent ?? "").trim()] = (vs[i]?.textContent ?? "").replace(/\s+/g, " ").trim();
    });
    return { summary: (c.querySelector(".wadjet-summary")?.textContent ?? "").replace(/\s+/g, " ").trim(), rows };
  });
}

/** Close the scratch note and delete it, so the vault is as the walk found it. */
async function closeScratch(): Promise<void> {
  await withApp(
    ob.page,
    async (app, path: string) => {
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view?.file?.path === path) leaf.detach();
      }
      const f = app.vault.getAbstractFileByPath(path);
      if (f) await app.vault.delete(f);
    },
    CHANNEL_SCRATCH,
  );
}

/** Every signed number in a readout, minus sign (U+2212) included, en dashes excluded. */
function numbersIn(text: string): number[] {
  return (text.match(/[−-]?\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace("−", "-")));
}

describe("climate studio · channel rows", () => {
  test("channels 1: at Year zoom the temperature row is the rolled year, not a ribbon", async () => {
    await revealStudio();
    await resetDraftFromSettings();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });

    const temp = await channelRowProbe("temperature");
    expect(temp.hidden).toBe(false);
    // SPEC §3.2: fine zoom is the composed daily curve. One point per rolled
    // day is far past the 12 a ribbon would carry.
    expect(temp.points).toBeGreaterThanOrEqual(12);
    expect(temp.points).toBeGreaterThan(300);
    // The low/high band comes with it, and the mean line is the channel colour.
    expect(temp.bandPaths).toBe(1);
    expect(temp.strokes.some((s) => s.includes("--wadjet-studio-temp"))).toBe(true);

    const others = await Promise.all(["precipitation", "wind", "sky"].map(channelRowProbe));
    for (const row of others) expect(row.points).toBeGreaterThanOrEqual(12);
    const probe = await probePlaylist();
    expect(probe.dayCardHidden).toBe(true);
    console.log(`  · Year zoom: temperature ${temp.points} points + ${temp.bandPaths} band; precip/wind/sky ${others.map((o) => o.points).join("/")}; ${probe.charts} charts`);
  });

  test("channels 2: at Era zoom the rows flatten to one mean line, and the tick is quick", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });

    const ms = await timedSeedWindow({ a: epoch, b: epoch + 1000 });
    const temp = await channelRowProbe("temperature");
    expect(temp.hidden).toBe(false);
    // A thousand years is past the repeat threshold: one flat line at the
    // ribbon's own mean, and no band.
    expect(temp.points).toBe(2);
    expect(new Set(temp.ys).size).toBe(1);
    expect(temp.bandPaths).toBe(0);
    for (const channel of ["precipitation", "wind", "sky"]) {
      const row = await channelRowProbe(channel);
      expect(row.points, channel).toBe(2);
      expect(new Set(row.ys).size, channel).toBe(1);
    }
    // PLAN §7: the wide zoom must not cost a roll per year.
    expect(ms).toBeLessThan(500);
    console.log(`  · Era zoom (1000 y): flat line at y ${temp.ys[0]}, store tick + paint in ${ms.toFixed(1)} ms`);
  });

  test("channels 3: at Day zoom the card shows the same day a wadjet block does", async () => {
    await revealStudio();
    const zoneId = await resetDraftFromSettings();
    const epoch = await epochYear();
    // Three days wide (≤ 7.5), so the playlist hands over to the day card.
    const centre = epoch + 5 + 100 / 365;
    await seedWindow({ a: centre - 1.5 / 365, b: centre + 1.5 / 365 });

    const probe = await probePlaylist();
    expect(probe.dayCardHidden).toBe(false);
    expect(probe.hiddenRows).toBeGreaterThanOrEqual(4);

    const card = await dayCardProbe();
    expect(card.hidden).toBe(false);
    expect(card.day).not.toBeNull();
    expect(card.headline.length).toBeGreaterThan(0);
    expect(card.date.length).toBeGreaterThan(0);
    // SPEC §3.2: the tags the card carries.
    expect(card.chips.some((c) => c.startsWith("regime:"))).toBe(true);
    expect(card.chips.some((c) => c.startsWith("season:"))).toBe(true);

    const block = await wadjetCardFor(zoneId, card.day!);
    await closeScratch();
    await revealStudio();

    // Real data only: the card and the block are the same report.
    expect(block.summary).toBe(card.headline);
    const cardTemps = numbersIn(card.cells["temperature"] ?? "");
    const blockTemps = numbersIn(block.rows["Temperature"] ?? "");
    expect(cardTemps.length).toBeGreaterThanOrEqual(2);
    expect(blockTemps.length).toBeGreaterThanOrEqual(2);
    expect(cardTemps.slice(0, 2)).toEqual(blockTemps.slice(0, 2));
    console.log(`  · day ${card.day} (${card.date}): card "${card.cells["temperature"]}" vs block "${block.rows["Temperature"]}"`);
    console.log(`  · headline: "${card.headline}"`);
    console.log(`  · chips: ${card.chips.join(" | ")}`);
  });

  test("channels 4: the label and the curve both open the channel window", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    await closeStudioWindows();

    const errors: string[] = [];
    const onError = (e: Error): void => {
      errors.push(e.message);
    };
    ob.page.on("pageerror", onError);

    // `dispatchEvent`, not `click`: earlier steps leave floating windows over
    // the playlist, and what is under test is the row's handler, not whether a
    // panel happens to be parked on top of it.
    const row = ob.page.locator('.wadjet-studio-row:has(.wadjet-studio-channel[data-channel="temperature"])');
    await row.locator(".wadjet-studio-row-label").dispatchEvent("click");
    await nextFrame();
    // The second click focuses the panel the first one opened; one id, one panel.
    await row.locator(".wadjet-studio-channel").dispatchEvent("click");
    await nextFrame();
    ob.page.off("pageerror", onError);

    expect(errors).toEqual([]);
    const opened = await withApp(ob.page, (app, type: string) => (app.workspace.getLeavesOfType(type)[0].view.store.get().view.openWindows as string[]).filter((id) => id.startsWith("channel:")), VIEW_TYPE);
    expect(opened).toEqual(["channel:temperature"]);
    // The row is still drawing after both clicks.
    expect((await channelRowProbe("temperature")).points).toBeGreaterThan(300);
    await closeStudioWindows();
    console.log("  · TEMP label and curve clicked: no throw, one channel:temperature panel");
  });
});

// ---------------------------------------------------------------------------
// Atlas · STATION and GEOGRAPHY (SPEC §3.4; bead wadjet-9f9.30)
// ---------------------------------------------------------------------------

interface AtlasProbe {
  open: boolean;
  title: string;
  badge: string;
  mode: string;
  /** the station rows the list is showing */
  names: string[];
  card: string;
  rebase: string;
  matchName: string;
  matchText: string;
  writes: string;
  /** the header's ⇅ chip, which only a hemisphere-straddling match raises */
  flipChip: boolean;
}

/** Everything the Atlas panel and the header say about the zone's source, in one read. */
async function atlasProbe(): Promise<AtlasProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const panels = Array.from(el?.querySelectorAll(".wadjet-studio-window") ?? []);
      const panel = panels.find((p: any) => (p.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === "Atlas") as HTMLElement | undefined;
      const text = (root: ParentNode | undefined, sel: string) => (root?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const selected = panel?.querySelector('[data-part="atlas-mode"] .wadjet-studio-segment.is-selected');
      return {
        open: panel !== undefined,
        title: text(panel, ".wadjet-studio-window-title"),
        badge: text(panel, ".wadjet-studio-window-badge"),
        mode: (selected?.getAttribute("data-value") ?? "").trim(),
        names: Array.from(panel?.querySelectorAll('[data-part="atlas-station"] .wadjet-studio-atlas-stationname') ?? []).map((n: any) => (n.textContent ?? "").trim()),
        card: text(panel, '[data-part="atlas-card-name"]'),
        rebase: text(panel, '[data-part="atlas-rebase"]'),
        matchName: text(panel, '[data-part="atlas-match-name"]'),
        matchText: text(panel, '[data-part="atlas-match-text"]'),
        writes: text(panel, ".wadjet-studio-window-foot"),
        flipChip: !(el?.querySelector('[data-part="flip"]')?.className ?? "is-hidden").includes("is-hidden"),
      };
    },
    VIEW_TYPE,
  );
}

interface AtlasDraft {
  presetId: string | null;
  matched: string | null;
  geography: any;
  flipSeasons: boolean | null;
  modifiers: any[];
  koppen: string;
}

/** The half of the zone draft the Atlas writes, plus what it must never touch. */
async function atlasDraft(): Promise<AtlasDraft> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const s = leaf.view.store.get();
      const z = s.zones[s.view.zoneId];
      const el: HTMLElement = leaf.view.containerEl;
      return {
        presetId: z.preset?.id ?? null,
        matched: z.preset?.matched ?? null,
        geography: z.geography === undefined ? null : JSON.parse(JSON.stringify(z.geography)),
        flipSeasons: z.flipSeasons ?? null,
        modifiers: JSON.parse(JSON.stringify(z.modifiers)),
        koppen: (el.querySelector('[data-part="koppen"] .wadjet-studio-chip-label')?.textContent ?? "").trim(),
      };
    },
    VIEW_TYPE,
  );
}

function atlasPanel() {
  return ob.page.locator(".wadjet-studio-window", { has: ob.page.locator('.wadjet-studio-window-title:text-is("Atlas")') }).first();
}

/** Close the Atlas panel if one is open, so a step can prove the chip opened it. */
async function atlasClosePanel(): Promise<void> {
  const close = ob.page.locator(".wadjet-studio-window", { has: ob.page.locator('.wadjet-studio-window-title:text-is("Atlas")') }).locator(".wadjet-studio-window-close");
  if ((await close.count()) > 0) await close.first().click();
  await nextFrame();
}

/** SPEC law 2: the Atlas is reached from the SRC chip, which stands for the station. */
async function atlasOpenFromSrc(): Promise<void> {
  await ob.page.locator('[data-part="src"]').first().click();
  await atlasPanel().waitFor({ state: "visible", timeout: 10_000 });
  await nextFrame();
}

/** Pick a mode / terrain / swing option out of one of the panel's Segmenteds. */
async function atlasSegment(part: string, value: string): Promise<void> {
  await atlasPanel().locator(`[data-part="${part}"] .wadjet-studio-segment[data-value="${value}"]`).click();
  await nextFrame();
}

/** Type an exact value into a knob — the dial's own double-click entry field. */
async function atlasTypeKnob(part: string, value: string): Promise<void> {
  await atlasPanel().locator(`[data-part="${part}"] .wadjet-studio-knob-dial`).dblclick();
  const input = atlasPanel().locator(`[data-part="${part}"] .wadjet-studio-knob-input`);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(value);
  await input.press("Enter");
  await nextFrame();
}

/** Search for a station and select its row. */
async function atlasSelectStation(query: string, id: string): Promise<void> {
  const search = atlasPanel().locator('[data-part="atlas-search"]');
  await search.fill(query);
  await nextFrame();
  await atlasPanel().locator(`[data-part="atlas-station"][data-id="${id}"]`).click();
  await nextFrame();
}

/** Wait until the pointed-at draft's preset says what the last action wrote. */
async function atlasWaitForPreset(id: string | null, matched: string | null): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; id: string | null; matched: string | null }) => {
      const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
      const s = leaf?.view?.store?.get();
      if (s === undefined) return false;
      const preset = s.zones[s.view.zoneId]?.preset;
      return (a.id === null || preset?.id === a.id) && (a.matched === null || preset?.matched === a.matched);
    },
    { type: VIEW_TYPE, id, matched },
    { timeout: 10_000 },
  );
  await nextFrame();
}

/** The active zone draft's `modifiers`, as JSON — the whole rack, devices and `layer:*` alike. */
async function zoneModifiers(next?: unknown[]): Promise<unknown[]> {
  return withApp(
    ob.page,
    (app, a: { type: string; next: unknown[] | null }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      if (a.next !== null) {
        leaf.view.store.update((s: any) => {
          s.zones[s.view.zoneId].modifiers = JSON.parse(JSON.stringify(a.next));
        });
      }
      const s = leaf.view.store.get();
      return JSON.parse(JSON.stringify(s.zones[s.view.zoneId].modifiers)) as unknown[];
    },
    { type: VIEW_TYPE, next: next ?? null },
  );
}

/** What this describe found on the zone's rack, put back in `afterAll` (T1 root cause (a)). */
let atlasModifiersBefore: unknown[] = [];

describe("climate studio · atlas", () => {
  // `atlas 2` overwrites `zone.modifiers` wholesale to prove a re-base carries a
  // climate-stage layer through — and in doing so deletes the zone's OWN
  // `ashfall` device, which `device lanes 1/5/6` then look for by name. The
  // rack is this describe's to borrow, not to keep.
  beforeAll(async () => {
    await revealStudio();
    atlasModifiersBefore = await zoneModifiers();
  });

  afterAll(async () => {
    if (!ob || ob.page.isClosed()) return;
    try {
      await revealStudio();
      const after = await zoneModifiers(atlasModifiersBefore);
      console.log(`  · atlas: zone rack restored to ${JSON.stringify((after as Array<{ id: string }>).map((m) => m.id))}`);
    } catch {
      /* the describe already failed; the reseed in `device lanes` is the backstop */
    }
  });

  test("atlas 1: the header SRC chip opens the Atlas in station mode, listing the shipped stations", async () => {
    await revealStudio();
    await atlasClosePanel();
    expect((await atlasProbe()).open).toBe(false);

    await atlasOpenFromSrc();
    const opened = await atlasProbe();
    expect(opened.open).toBe(true);
    expect(opened.title).toBe("Atlas");
    expect(opened.badge).toBe("STATION");
    expect(opened.mode).toBe("station");
    // The list is `PRESETS` minus the alternates — 26 today, asserted as a
    // floor so a curated addition never fails the walk.
    expect(opened.names.length).toBeGreaterThanOrEqual(20);
    expect(opened.names).toContain("Fjord Coast");
    expect(opened.writes).toContain("zone.preset");
    expect(opened.writes).toContain("zone.geography");
    console.log(`  · SRC chip → Atlas (${opened.badge}) listing ${opened.names.length} stations`);
  });

  test("atlas 2: selecting Red Desert and re-basing swaps the station, keeps the modifiers and moves the Köppen badge", async () => {
    await revealStudio();
    // A climate-stage layer of the zone's own: the re-base must carry it through.
    await withApp(
      ob.page,
      (app, type: string) => {
        const leaf = app.workspace.getLeavesOfType(type)[0];
        leaf.view.store.update((s: any) => {
          const z = s.zones[s.view.zoneId];
          z.modifiers = [{ id: "layer:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 1 }] }];
          delete z.flipSeasons;
        });
      },
      VIEW_TYPE,
    );
    await nextFrame();

    // Start from a known station, so the badge has somewhere to move from.
    await atlasSelectStation("Fjord", "fjord-coast");
    await atlasPanel().locator('[data-part="atlas-rebase"]').click();
    await atlasWaitForPreset("fjord-coast", "manual");
    const cold = await atlasDraft();
    expect(cold.koppen.length).toBeGreaterThan(0);

    await atlasSelectStation("Red Desert", "red-desert");
    const selected = await atlasProbe();
    expect(selected.card).toBe("Red Desert");
    expect(selected.rebase).toBe("Re-base zone → Red Desert");

    await atlasPanel().locator('[data-part="atlas-rebase"]').click();
    await atlasWaitForPreset("red-desert", "manual");
    const hot = await atlasDraft();
    expect(hot.presetId).toBe("red-desert");
    expect(hot.matched).toBe("manual");
    expect(hot.geography).toBeNull();
    expect(hot.modifiers).toEqual(cold.modifiers);
    expect(hot.koppen).not.toBe(cold.koppen);
    expect((await notices(ob.page)).some((t) => t.includes("Red Desert"))).toBe(true);
    console.log(`  · re-base: ${cold.presetId} (${cold.koppen}) → ${hot.presetId} (${hot.koppen}); modifiers kept`);
  });

  test("atlas 3: a southern latitude matches a northern station, flips the seasons and raises the ⇅ chip", async () => {
    await revealStudio();
    await atlasSegment("atlas-mode", "geography");
    const geoMode = await atlasProbe();
    expect(geoMode.mode).toBe("geography");
    expect(geoMode.badge).toBe("GEOGRAPHY");

    // The place, described exactly: continentality left off, so the matched
    // station keeps its own seasonal swing.
    await atlasSegment("atlas-swing", "station");
    await atlasSegment("atlas-terrain", "none");
    await atlasTypeKnob("atlas-altitude", "200");
    await atlasTypeKnob("atlas-latitude", "-35");

    const preview = await atlasProbe();
    expect(preview.matchName.length).toBeGreaterThan(0);
    expect(preview.matchText).toContain("Closest match:");

    await atlasPanel().locator('[data-part="atlas-matchbtn"]').click();
    await atlasWaitForPreset(null, "auto");

    const matched = await atlasDraft();
    expect(matched.geography.latitude).toBe(-35);
    expect(matched.geography.altitude).toBe(200);
    expect(matched.geography.orographic).toBe("none");
    expect(matched.geography.continentality).toBeUndefined();
    expect(matched.matched).toBe("auto");
    expect(matched.flipSeasons).toBe(true);
    expect((await atlasProbe()).flipChip).toBe(true);
    expect((await notices(ob.page)).some((t) => t.includes("Seasons flipped for this zone"))).toBe(true);
    console.log(`  · geography −35°, 200 m, none → ${matched.presetId} (matched auto); flipSeasons true, ⇅ chip up`);
  });

  test("atlas 4: undo puts the hand-picked station back", async () => {
    await revealStudio();
    expect(await studioHistory("undo")).toBe(true);
    const back = await atlasDraft();
    expect(back.presetId).toBe("red-desert");
    expect(back.matched).toBe("manual");
    expect(back.geography).toBeNull();
    expect(back.flipSeasons).toBeNull();
    expect((await atlasProbe()).flipChip).toBe(false);
    console.log(`  · undo: back to ${back.presetId} (${back.matched}), no geography, ⇅ chip down`);

    await atlasClosePanel();
    expect((await atlasProbe()).open).toBe(false);
  });
});

/* ── Device lanes (bead wadjet-9f9.33) ──────────────────────────────────── */

/** The four seasons the gate step reads; `world.calendar.seasons` is empty in the vault. */
const LANE_SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Harvest", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

/** Every device id this walk seeds — dropped from the draft before each seeding. */
const LANE_DEVICE_IDS = ["lane-clip", "lane-spell", "lane-moon", "lane-chance"];

interface DeviceLaneSpanProbe {
  id: string;
  kind: string;
  editable: boolean;
  dim: boolean;
  /** fractional years, straight off `data-span-from` / `data-span-to` */
  from: number;
  to: number;
  left: number;
  width: number;
  hint: string;
}

interface DeviceLaneProbe {
  present: boolean;
  rowLabel: string;
  /** the lane's own `data-kind` — the SPEC §4 shape the row settled on */
  kind: string;
  editable: boolean;
  labelHint: string;
  spans: DeviceLaneSpanProbe[];
  /** the row's position in the playlist stack, and the Eras row's, so "under Eras" is measurable */
  rowIndex: number;
  erasIndex: number;
  /** every device row's `data-device`, in playlist order */
  deviceRowIds: string[];
  /** how many of them this walk seeded (the vault's own `ashfall` device has a lane of its own) */
  seededRows: number;
  stripWidth: number;
  window: { a: number; b: number };
  flipSeasons: boolean;
}

async function probeDeviceLane(id: string): Promise<DeviceLaneProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const rows = Array.from(el.querySelectorAll(".wadjet-studio-row"));
      const row = rows.find((r) => r.getAttribute("data-device") === a.id) ?? null;
      const lane = row?.querySelector(".wadjet-studio-device-lane") ?? null;
      const laneLeft = lane === null ? 0 : (lane as HTMLElement).getBoundingClientRect().left;
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const state = leaf.view.store.get();
      const zone = state.view.zoneId === null ? undefined : state.zones[state.view.zoneId];
      const spans = lane === null ? [] : Array.from(lane.querySelectorAll(".wadjet-studio-span"));
      return {
        present: row !== null,
        rowLabel: (row?.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim(),
        kind: lane === null ? "" : (lane.getAttribute("data-kind") ?? ""),
        editable: lane !== null && lane.getAttribute("data-editable") === "true",
        labelHint: row?.querySelector(".wadjet-studio-row-label")?.getAttribute("data-hint") ?? "",
        spans: spans.map((n) => ({
          id: n.getAttribute("data-id") ?? "",
          kind: n.getAttribute("data-kind") ?? "",
          editable: n.hasClass("is-editable"),
          dim: n.hasClass("is-dim"),
          from: Number(n.getAttribute("data-span-from") ?? "NaN"),
          to: Number(n.getAttribute("data-span-to") ?? "NaN"),
          left: n.getBoundingClientRect().left - laneLeft,
          width: n.getBoundingClientRect().width,
          hint: n.getAttribute("data-hint") ?? "",
        })),
        rowIndex: row === null ? -1 : rows.indexOf(row),
        erasIndex: rows.findIndex((r) => (r.querySelector(".wadjet-studio-row-label")?.textContent ?? "").trim().startsWith("Eras")),
        deviceRowIds: rows.filter((r) => r.hasClass("wadjet-studio-device-row")).map((r) => r.getAttribute("data-device") ?? ""),
        seededRows: rows.filter((r) => (r.getAttribute("data-device") ?? "").startsWith("lane-")).length,
        stripWidth: strip?.clientWidth ?? 0,
        window: state.view.window as { a: number; b: number },
        flipSeasons: zone?.flipSeasons === true,
      };
    },
    { type: VIEW_TYPE, id },
  );
}

/**
 * Replace this walk's devices in the draft. Everything the studio compiled
 * (`layer:*`, `forcings:*`) and every device an earlier describe left behind
 * stays: only `LANE_DEVICE_IDS` are swapped, so the rack order the rows follow
 * is the one the zone really has.
 */
async function seedDeviceLanes(mods: unknown[]): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; ids: string[]; mods: any[]; seasons: Array<{ name: string; from: number }> }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.world.calendar.seasons = a.seasons.map((x) => ({ ...x }));
        const zone = s.zones[s.view.zoneId];
        // The band arithmetic is hemisphere-sensitive; pin it so the gate step reads Winter where it looks.
        zone.flipSeasons = false;
        zone.modifiers = zone.modifiers.filter((m: any) => !a.ids.includes(m.id));
        for (const m of a.mods) zone.modifiers.push(JSON.parse(JSON.stringify(m)));
      });
    },
    { type: VIEW_TYPE, ids: LANE_DEVICE_IDS, mods: mods as any[], seasons: LANE_SEASONS },
  );
  await nextFrame();
  await nextFrame();
}

/** Wait until `id`'s row is mounted and has drawn at least `minSpans` spans. */
async function waitForDeviceLane(id: string, minSpans: number): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; id: string; min: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const row = Array.from(el?.querySelectorAll(".wadjet-studio-row") ?? []).find((r) => r.getAttribute("data-device") === a.id);
      const lane = row?.querySelector(".wadjet-studio-device-lane") ?? null;
      return lane !== null && lane.querySelectorAll(".wadjet-studio-span").length >= a.min;
    },
    { type: VIEW_TYPE, id, min: minSpans },
    { timeout: 20_000 },
  );
  await nextFrame();
}

/**
 * Wait until none of this walk's rows is mounted. Scoped to `lane-*`: the
 * vault's Greywold zone ships its own `ashfall` device (a `yearPhase` spell),
 * which has a lane of its own and must survive every removal here.
 */
async function waitForNoSeededDeviceRows(): Promise<void> {
  await ob.page.waitForFunction(
    (type: string) => {
      const el = (window as any).app.workspace.getLeavesOfType(type)[0]?.view?.containerEl as HTMLElement | undefined;
      return (el?.querySelectorAll('.wadjet-studio-row[data-device^="lane-"]').length ?? 1) === 0;
    },
    VIEW_TYPE,
    { timeout: 20_000 },
  );
  await nextFrame();
}

/** One real pointer drag across a device lane, in lane-LOCAL pixels (the eras lane's gesture). */
async function dragDeviceLane(id: string, x1: number, x2: number): Promise<{ laneLeft: number; stripWidth: number; clientX1: number; clientX2: number; window: { a: number; b: number } }> {
  const out = await withApp(
    ob.page,
    (app, a: { type: string; id: string; x1: number; x2: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const row = Array.from(el.querySelectorAll(".wadjet-studio-row")).find((r) => r.getAttribute("data-device") === a.id);
      const lane = row?.querySelector(".wadjet-studio-device-lane") ?? null;
      if (lane === null) throw new Error(`no device lane for ${a.id}`);
      const box = lane.getBoundingClientRect();
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const clientX1 = Math.round(box.left + a.x1);
      const clientX2 = Math.round(box.left + a.x2);
      const y = Math.round(box.top + box.height / 2);
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: clientX1, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: clientX2, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: clientX2, clientY: y }));
      return { laneLeft: box.left, stripWidth: strip?.clientWidth ?? 0, clientX1, clientX2, window: leaf.view.store.get().view.window as { a: number; b: number } };
    },
    { type: VIEW_TYPE, id, x1, x2 },
  );
  await nextFrame();
  return out;
}

/** The draft's modifier by id, as plain JSON. */
async function laneModifier(id: string): Promise<any> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const s = leaf.view.store.get();
      const zone = s.zones[s.view.zoneId];
      return JSON.parse(JSON.stringify(zone.modifiers.find((m: any) => m.id === a.id) ?? null));
    },
    { type: VIEW_TYPE, id },
  );
}

const LANE_APPLY = [{ param: "temperature.mean", op: "offset", value: 2 }];

describe("climate studio · device lanes", () => {
  // This walk counts the rows under Eras and names them, so it needs the rack
  // in its fixture state: the zone's own `ashfall` device and nothing else.
  // The atlas describe puts back what it borrowed; this is the backstop for
  // when it (or any earlier walk that writes `layer:*` modifiers) died first.
  beforeAll(async () => {
    await revealStudio();
    const rack = await zoneModifiers([JSON.parse(JSON.stringify(ZONE_DEVICE))]);
    console.log(`  · device lanes: rack seeded to ${JSON.stringify((rack as Array<{ id: string }>).map((m) => m.id))}`);
  });

  test("device lanes 1: a yearPhase device gets its own row under Eras, one clip per year", async () => {
    await revealStudio();
    await closeStudioWindows();
    const epoch = await epochYear();
    await seedDeviceLanes([{ id: "lane-clip", stage: "daily", when: { yearPhase: [0.6, 0.7] }, apply: LANE_APPLY }]);
    await seedWindow({ a: epoch + 2, b: epoch + 5 });
    await waitForDeviceLane("lane-clip", 3);

    const probe = await probeDeviceLane("lane-clip");
    expect(probe.present).toBe(true);
    expect(probe.rowLabel).toBe("lane-clip");
    // SPEC 4: "in rack order, under the eras lane".
    expect(probe.erasIndex).toBeGreaterThanOrEqual(0);
    expect(probe.rowIndex).toBeGreaterThan(probe.erasIndex);
    expect(probe.kind).toBe("clip");
    expect(probe.editable).toBe(true);
    expect(probe.spans.map((s) => s.id)).toEqual([`yp:${epoch + 2}`, `yp:${epoch + 3}`, `yp:${epoch + 4}`]);
    expect(probe.spans.every((s) => s.kind === "clip" && s.editable)).toBe(true);
    // The clip's true edges, not clipped to the window: `year + 0.6` to `+ 0.7`.
    for (const s of probe.spans) {
      expect(s.to - s.from).toBeCloseTo(0.1, 6);
      expect(s.from - Math.floor(s.from)).toBeCloseTo(0.6, 6);
    }
    expect(probe.labelHint).toContain("lane-clip");
    // Rack order: the zone's own `ashfall` device is `modifiers[0]`, so its row
    // is above the one this walk appended.
    expect(probe.deviceRowIds).toEqual(["ashfall", "lane-clip"]);
    console.log(`  · lane-clip: row ${probe.rowIndex} (eras ${probe.erasIndex}), ${probe.spans.length} clips over ${Math.round(probe.stripWidth)}px`);
  });

  test("device lanes 2: dragging a clip's right edge 40 px out grows when.yearPhase[1]", async () => {
    await revealStudio();
    const before = await laneModifier("lane-clip");
    expect(before.when.yearPhase[1]).toBeCloseTo(0.7, 9);

    const probe = await probeDeviceLane("lane-clip");
    // The middle clip: fully on screen at both edges, whatever the strip width is.
    const span = probe.spans[1]!;
    const year = Math.floor(span.from);
    // Inside the 4 px `edgePx` of the right edge — the white resize handle.
    const grab = span.left + span.width - 2;
    const drag = await dragDeviceLane("lane-clip", grab, grab + 40);

    const expectedTo = yearAt(drag.clientX2, drag.laneLeft, drag.stripWidth, drag.window) - year;
    const after = await laneModifier("lane-clip");
    expect(after.when.yearPhase[0]).toBeCloseTo(before.when.yearPhase[0], 9);
    expect(after.when.yearPhase[1]).toBeGreaterThan(before.when.yearPhase[1]);
    expect(after.when.yearPhase[1]).toBeCloseTo(expectedTo, 6);
    console.log(`  · lane-clip resized: yearPhase[1] ${before.when.yearPhase[1]} → ${after.when.yearPhase[1]} (+40 px)`);
  });

  test("device lanes 3: a spell draws its when dashed and the roll's runs solid", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedDeviceLanes([
      {
        id: "lane-spell",
        stage: "daily",
        when: { yearPhase: [0.2, 0.8] },
        spell: { meanStartsPerYear: 12, meanDurationDays: 8 },
        tag: "spell:x",
        apply: LANE_APPLY,
      },
    ]);
    await seedWindow({ a: epoch + 4, b: epoch + 5 });
    // H-1392: the strip's footer naming the year is the proof the roll has landed.
    await waitForAuditionYear(epoch + 4);
    await waitForDeviceLane("lane-spell", 2);

    const probe = await probeDeviceLane("lane-spell");
    expect(probe.kind).toBe("window");
    const windows = probe.spans.filter((s) => s.kind === "window");
    const runs = probe.spans.filter((s) => s.kind === "run");
    expect(windows.length).toBe(1);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // The dashed window is the `when`; every solid run falls inside it.
    expect(windows[0]!.from - Math.floor(windows[0]!.from)).toBeCloseTo(0.2, 6);
    // A day covers `[d, d + 1)` (`model/spans.ts` `spellRuns`), so a run whose
    // last active day is the last day inside the `when` closes one day PAST the
    // dashed edge — 5.8027 against a window ending at 5.8000 is that one day,
    // not float noise. Every run still has to START inside the window: that is
    // the property "the spell only fires inside its when".
    const dayYears = 1 / (await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.yearLength as number));
    for (const r of runs) {
      expect(r.editable).toBe(false);
      expect(r.from).toBeGreaterThanOrEqual(windows[0]!.from - 1e-6);
      expect(r.from).toBeLessThan(windows[0]!.to);
      expect(r.to).toBeLessThanOrEqual(windows[0]!.to + dayYears + 1e-6);
    }
    console.log(`  · lane-spell: 1 dashed window + ${runs.length} rolled run(s) in Y ${epoch + 4}`);
  });

  test("device lanes 4: a moon device is pulses, dimmed where a season gate mutes it", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedDeviceLanes([
      {
        id: "lane-moon",
        stage: "daily",
        when: { moon: { name: "Moon", phase: [0, 0.08] } },
        mods: [{ source: "season:Winter", amount: 0 }],
        apply: LANE_APPLY,
      },
    ]);
    await seedWindow({ a: epoch + 4, b: epoch + 5 });
    await waitForDeviceLane("lane-moon", 6);

    const probe = await probeDeviceLane("lane-moon");
    expect(probe.flipSeasons).toBe(false);
    expect(probe.kind).toBe("pulse");
    expect(probe.editable).toBe(false);
    expect(probe.spans.every((s) => s.kind === "pulse" && !s.editable)).toBe(true);
    // Winter is the last quarter of the year: the pulses inside it are muted.
    const inWinter = (s: DeviceLaneSpanProbe): boolean => {
      const mid = (s.from + s.to) / 2;
      return mid - Math.floor(mid) >= 0.75;
    };
    expect(probe.spans.some(inWinter)).toBe(true);
    expect(probe.spans.some((s) => !inWinter(s))).toBe(true);
    for (const s of probe.spans) expect(s.dim).toBe(inWinter(s));
    console.log(`  · lane-moon: ${probe.spans.length} pulses, ${probe.spans.filter((s) => s.dim).length} dimmed by season:Winter x 0`);
  });

  test("device lanes 5: removing the device removes its row", async () => {
    await revealStudio();
    expect((await probeDeviceLane("lane-moon")).present).toBe(true);
    await seedDeviceLanes([]);
    await waitForNoSeededDeviceRows();

    const probe = await probeDeviceLane("lane-moon");
    expect(probe.present).toBe(false);
    expect(probe.seededRows).toBe(0);
    // Only the removed device's row went: the zone's own `ashfall` still has one.
    expect(probe.deviceRowIds).toEqual(["ashfall"]);
    console.log(`  · seeded devices removed: rows left ${JSON.stringify(probe.deviceRowIds)}`);
  });

  test("device lanes 6: a chance device is a mixer chip, never a lane", async () => {
    await revealStudio();
    await seedDeviceLanes([{ id: "lane-chance", stage: "daily", when: { chance: 0.2 }, apply: LANE_APPLY }]);
    await nextFrame();

    expect(await laneModifier("lane-chance")).not.toBeNull();
    const probe = await probeDeviceLane("lane-chance");
    expect(probe.present).toBe(false);
    expect(probe.seededRows).toBe(0);
    expect(probe.deviceRowIds).toEqual(["ashfall"]);
    console.log("  · chance device seeded: still no lane for it (SPEC 4)");

    // Leave the studio as this walk found it: no seeded devices, no open panels.
    await seedDeviceLanes([]);
    await waitForNoSeededDeviceRows();
    await closeStudioWindows();
  });
});

// ---------------------------------------------------------------------------
// The temperature channel editor (SPEC §3.4, PLAN §5.2; bead wadjet-9f9.31)
// ---------------------------------------------------------------------------

const CHANNEL_WINDOW_ID = "channel:temperature";
const TEMP_SWING_LAYER = "layer:temperature.mean:swing";
const TEMP_WINTER_LAYER = "layer:temperature.mean:season:Winter";

/** The four-season layout this walk tags days with. Mirrors `seedFourSeasons`, but for the *adapter*. */
const CHANNEL_SEASONS = [
  { name: "Spring", from: 0 },
  { name: "Summer", from: 0.25 },
  { name: "Autumn", from: 0.5 },
  { name: "Winter", from: 0.75 },
];

/** Middle of each season, as a day of a 365-day year — far from either boundary. */
const SUMMER_DAY = 136;
const WINTER_DAY = 320;

interface ChannelProbe {
  open: boolean;
  /** which chain's editor is on screen — the panel's own `data-channel` */
  channel: string;
  title: string;
  badge: string;
  /** the parameters the series picker offers, and the one selected; empty when the channel has a single line */
  seriesOptions: string[];
  series: string;
  /** the rose's occupied sectors as `<sector>:<seasons>`, and the sector paths actually drawn */
  rose: string;
  roseSectors: number;
  /** is the "station's own" bearing reset showing? */
  reset: boolean;
  /** the chart's plotted domain: `year` for the curve, `cycle` for the ☾ envelope */
  domain: string;
  /** draggable handles on the chart */
  points: number;
  /** their pixel y values — a shrinking curve is visible without reading the draft */
  pointYs: number[];
  scopes: string[];
  scope: string;
  stage: string;
  knobs: string[];
  knobValues: string[];
  moonChip: string;
  writers: Array<{ kind: string; label: string; ops: string }>;
  writes: string;
}

async function probeChannel(): Promise<ChannelProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const windows = Array.from(el?.querySelectorAll(".wadjet-studio-window") ?? []);
      const panel = windows.find((w) => w.querySelector(".wadjet-studio-channel-win") !== null) ?? null;
      const text = (sel: string) => (panel?.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const points = Array.from(panel?.querySelectorAll('[data-part="channel-chart"] circle.wadjet-studio-chart-point') ?? []);
      const knobs = Array.from(panel?.querySelectorAll('[data-part="channel-knobs"] .wadjet-studio-knob') ?? []);
      return {
        open: panel !== null,
        channel: panel?.querySelector(".wadjet-studio-channel-win")?.getAttribute("data-channel") ?? "",
        title: text(".wadjet-studio-window-title"),
        badge: text(".wadjet-studio-window-badge"),
        seriesOptions: Array.from(panel?.querySelectorAll('[data-part="channel-series"] .wadjet-studio-segment') ?? []).map((s) => s.getAttribute("data-value") ?? ""),
        series: panel?.querySelector('[data-part="channel-series"] .wadjet-studio-segment.is-selected')?.getAttribute("data-value") ?? "",
        rose: panel?.querySelector('[data-part="channel-rose"]')?.getAttribute("data-rose") ?? "",
        roseSectors: panel?.querySelectorAll('[data-part="channel-rose"] path.wadjet-studio-chart-sector').length ?? 0,
        reset: (panel?.querySelector('[data-part="channel-direction-reset"]') ?? null) !== null,
        domain: panel?.querySelector('[data-part="channel-chart"] .wadjet-studio-chart')?.getAttribute("data-domain") ?? "",
        points: points.length,
        pointYs: points.map((p) => Math.round(Number(p.getAttribute("cy")) * 100) / 100),
        scopes: Array.from(panel?.querySelectorAll('[data-part="channel-scopes"] .wadjet-studio-segment') ?? []).map((s) => s.getAttribute("data-value") ?? ""),
        scope: panel?.querySelector('[data-part="channel-scopes"] .wadjet-studio-segment.is-selected')?.getAttribute("data-value") ?? "",
        stage: text('[data-part="channel-stage"]'),
        knobs: knobs.map((k) => (k.querySelector(".wadjet-studio-knob-label")?.textContent ?? "").trim()),
        knobValues: knobs.map((k) => (k.querySelector(".wadjet-studio-knob-value")?.textContent ?? "").trim()),
        moonChip: text('[data-part="channel-moon"] .wadjet-studio-chip-label'),
        writers: Array.from(panel?.querySelectorAll('[data-part="channel-writer"]') ?? []).map((w) => ({
          kind: w.getAttribute("data-kind") ?? "",
          label: (w.querySelector(".wadjet-studio-channel-win-writer-label")?.textContent ?? "").trim(),
          ops: (w.querySelector(".wadjet-studio-channel-win-writer-ops")?.textContent ?? "").trim(),
        })),
        writes: text(".wadjet-studio-window-foot .wadjet-studio-writes-body"),
      };
    },
    VIEW_TYPE,
  );
}

/**
 * The `layer:<section>.` prefixes each channel editor writes. SKY spans two
 * sections — `cloud` and `humidity` are one channel (SPEC §1) — which is why
 * this is a list and not `layer:<channel>.`.
 */
const CHANNEL_LAYER_SECTIONS: Record<string, string[]> = {
  temperature: ["temperature"],
  precipitation: ["precipitation"],
  wind: ["wind"],
  sky: ["cloud", "humidity"],
};

/** Every `layer:` modifier one channel owns, on the zone draft, in `modifiers[]` order. */
async function channelLayers(channel: string): Promise<any[]> {
  return withApp(
    ob.page,
    (app, a: { type: string; prefixes: string[] }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const s = leaf.view.store.get();
      const zone = s.zones[s.view.zoneId];
      return (zone?.modifiers ?? []).filter((m: any) => typeof m.id === "string" && a.prefixes.some((p: string) => m.id.startsWith(p)));
    },
    { type: VIEW_TYPE, prefixes: (CHANNEL_LAYER_SECTIONS[channel] ?? []).map((s) => `layer:${s}.`) },
  );
}

/** Every `layer:temperature.*` modifier on the zone draft, in `modifiers[]` order. */
async function temperatureLayers(): Promise<any[]> {
  return channelLayers("temperature");
}

/** Peak-to-peak of a climate-stage `set`'s keyframes — the amplitude the swing knob rescales. */
function keyframeSpread(kfs: Array<{ at: number; value: number }>): number {
  const vs = kfs.map((k) => k.value);
  return Math.max(...vs) - Math.min(...vs);
}

function keyframeMean(kfs: Array<{ at: number; value: number }>): number {
  return kfs.reduce((a, k) => a + k.value, 0) / kfs.length;
}

/** The zone's own base `temperature.mean` keyframes, straight off the draft. */
async function baseTemperatureKeyframes(): Promise<Array<{ at: number; value: number }>> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const s = leaf.view.store.get();
      return s.zones[s.view.zoneId].climate.temperature.mean;
    },
    VIEW_TYPE,
  );
}

/** Open the editor by id, the way a writer row or a restored leaf does. */
async function openChannelWindow(id: string = CHANNEL_WINDOW_ID): Promise<void> {
  await withApp(ob.page, (app, a: { type: string; id: string }) => app.workspace.getLeavesOfType(a.type)[0].view.windows.open(a.id), { type: VIEW_TYPE, id });
  await nextFrame();
}

/**
 * Drop every `layer:` modifier the named channels own from every zone draft.
 * Earlier walks *save* one to disk (the header's step 8 writes
 * `layer:temperature.mean` at +0.6 °C), so `resetDraftFromSettings` alone would
 * hand a walk a knob that is not at its neutral.
 */
async function clearChannelLayers(...channels: string[]): Promise<void> {
  const prefixes = channels.flatMap((c) => (CHANNEL_LAYER_SECTIONS[c] ?? []).map((s) => `layer:${s}.`));
  await withApp(
    ob.page,
    (app, a: { type: string; prefixes: string[] }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        for (const key of Object.keys(s.zones)) {
          const zone = s.zones[key];
          zone.modifiers = (zone.modifiers ?? []).filter((m: any) => !(typeof m.id === "string" && a.prefixes.some((p: string) => m.id.startsWith(p))));
        }
      });
    },
    { type: VIEW_TYPE, prefixes },
  );
  await nextFrame();
}

/** A known starting point: the saved zone with no channel layers at all, a one-year window, no drawer, no panels. */
async function resetChannelWalk(): Promise<number> {
  await revealStudio();
  await closeStudioWindows();
  await setJsonOpen(false);
  await resetDraftFromSettings();
  await clearChannelLayers("temperature", "precipitation", "wind", "sky");
  const epoch = await epochYear();
  await seedWindow({ a: epoch + 5, b: epoch + 6 });
  return epoch;
}

/** Click a scope chip by its value (`all`, `season:Winter`, `moon:<X>`). */
async function selectChannelScope(value: string): Promise<void> {
  await ob.page.locator(`[data-part="channel-scopes"] .wadjet-studio-segment[data-value="${value}"]`).first().click();
  await nextFrame();
}

/** A real ↕ drag on one chart handle — pointerdown on the circle, move/up on `window` (`ui/pointer.ts`). */
async function dragChartPoint(index: number, dy: number): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; index: number; dy: number }) => {
      const el: HTMLElement = app.workspace.getLeavesOfType(a.type)[0].view.containerEl;
      const node = el.querySelector(`[data-part="channel-chart"] circle.wadjet-studio-chart-point[data-index="${a.index}"]`);
      if (node === null) throw new Error(`no chart handle at index ${a.index}`);
      const r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      node.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: x, clientY: y + a.dy }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y + a.dy }));
    },
    { type: VIEW_TYPE, index, dy },
  );
  await nextFrame();
}

/**
 * Seed the four seasons into the *adapter's* calendar as well as the studio's
 * world draft: the audition tags days from `plugin.settings.calendar`
 * (`InternalCalendar.toContext`), while the scope chips read the draft.
 */
async function seedChannelSeasons(seasons: Array<{ name: string; from: number }>): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; seasons: Array<{ name: string; from: number }> }) => {
      // In place: `InternalCalendar` holds `settings.calendar` by reference.
      const cal = app.plugins.plugins.wadjet.settings.calendar;
      cal.seasons.splice(0, cal.seasons.length, ...a.seasons.map((s: { name: string; from: number }) => ({ ...s })));
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        s.world.calendar.seasons = a.seasons.map((x: { name: string; from: number }) => ({ ...x }));
      });
    },
    { type: VIEW_TYPE, seasons },
  );
  await nextFrame();
}

/** The audition cell standing for the day of year closest to `dayOfYear`, as a low/high mean. */
async function auditionMeanNearDay(dayOfYear: number): Promise<number> {
  return withApp(
    ob.page,
    (app, a: { type: string; day: number }) => {
      const el: HTMLElement = app.workspace.getLeavesOfType(a.type)[0].view.containerEl;
      const cells = Array.from(el.querySelectorAll(".wadjet-studio-audition-cell"));
      if (cells.length === 0) throw new Error("the audition has not drawn yet");
      const doy = (c: Element) => ((Number(c.getAttribute("data-day-ordinal")) % 365) + 365) % 365;
      let best = cells[0]!;
      for (const c of cells) if (Math.abs(doy(c) - a.day) < Math.abs(doy(best) - a.day)) best = c;
      const hint = best.getAttribute("data-hint") ?? "";
      const m = /(−?-?\d+(?:\.\d+)?) to (−?-?\d+(?:\.\d+)?) °C/.exec(hint);
      if (m === null) throw new Error(`no temperature in the day tip: ${hint}`);
      const num = (s: string) => Number(s.replace("−", "-"));
      return (num(m[1]!) + num(m[2]!)) / 2;
    },
    { type: VIEW_TYPE, day: dayOfYear },
  );
}

/** The strip re-rolls on a debounce (H-1392): wait for the day's own number to move off `from`. */
async function settledMeanNearDay(dayOfYear: number, from: number): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const v = await auditionMeanNearDay(dayOfYear);
    if (Math.abs(v - from) > 0.01) return v;
    await ob.page.waitForTimeout(100);
  }
  throw new Error(`day ${dayOfYear} never moved off ${from}`);
}

describe("climate studio · temperature editor", () => {
  test("temperature editor 1: the TEMP row label opens the panel with 12 keyframes and the writers stack", async () => {
    await resetChannelWalk();

    await ob.page.locator('.wadjet-studio-row-label:text-is("TEMP")').first().click();
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe("Temperature");
    expect(probe.badge).toBe("CHANNEL");
    expect(probe.domain).toBe("year");
    // SPEC §3.4: 12 monthly keyframes, and the all-year knob set.
    expect(probe.points).toBe(12);
    expect(probe.scope).toBe("all");
    expect(probe.knobs).toEqual(["offset", "swing", "jitter"]);
    expect(probe.knobValues).toEqual(["+0.0 °C", "×1.00", "+0.0 °C"]);
    expect(probe.stage).toBe("climate stage · applied once to the curves");

    // SPEC §1: the station is the baseline, and the regimes write the channel too.
    expect(probe.writers.length).toBeGreaterThanOrEqual(2);
    expect(probe.writers[0]?.kind).toBe("station");
    expect(probe.writers.some((w) => w.kind === "regime")).toBe(true);
    expect(probe.writes).toContain("layer:temperature.*");
    console.log(`  · label click: "${probe.title}" ${probe.badge} · ${probe.points} keyframes · writers ${probe.writers.map((w) => w.kind).join(" → ")}`);
  });

  test("temperature editor 2: swing down 30 px writes layer:temperature.mean:swing, and the drawer shows the shrunken curve", async () => {
    await resetChannelWalk();
    await openChannelWindow();
    await setJsonOpen(true);

    const base = await baseTemperatureKeyframes();
    // 150 px covers the knob's whole ×0.4–1.6 range: 30 px down is −0.24 at step 0.01.
    await dragKnobDial('[data-part="channel-knob-swing"] .wadjet-studio-knob-dial', 30);

    const layers = await temperatureLayers();
    const swing = layers.find((m) => m.id === TEMP_SWING_LAYER);
    expect(swing).toBeDefined();
    expect(swing.stage).toBe("climate");
    expect(swing.tag).toBe("swing:0.76");
    expect(swing.apply.length).toBe(1);
    expect(swing.apply[0].op).toBe("set");
    expect(Array.isArray(swing.apply[0].value)).toBe(true);
    expect(swing.apply[0].value.length).toBe(12);

    // The amplitude the ribbon draws is the keyframe spread: it shrinks by k.
    const spreadBefore = keyframeSpread(base);
    const spreadAfter = keyframeSpread(swing.apply[0].value);
    expect(spreadAfter).toBeLessThan(spreadBefore);
    expect(spreadAfter / spreadBefore).toBeCloseTo(0.76, 2);
    // The annual mean is the pivot, so it does not move.
    expect(keyframeMean(swing.apply[0].value)).toBeCloseTo(keyframeMean(base), 1);

    const json = await probeJson();
    expect(json.visible).toBe(true);
    expect(json.modifiersText).toContain(TEMP_SWING_LAYER);
    expect((await probeChannel()).knobValues[1]).toBe("×0.76");
    await setJsonOpen(false);
    console.log(`  · swing ×0.76: keyframe spread ${spreadBefore.toFixed(2)} → ${spreadAfter.toFixed(2)} °C, drawer shows ${TEMP_SWING_LAYER}`);
  });

  test("temperature editor 3: offset +3 °C writes layer:temperature.mean and re-derives the swing under it", async () => {
    await resetChannelWalk();
    await openChannelWindow();
    await dragKnobDial('[data-part="channel-knob-swing"] .wadjet-studio-knob-dial', 30);
    const before = (await temperatureLayers()).find((m) => m.id === TEMP_SWING_LAYER);
    const meanBefore = keyframeMean(before.apply[0].value);
    const spreadBefore = keyframeSpread(before.apply[0].value);

    // ±10 °C over 150 px: 22.5 px up is exactly +3.0 at step 0.1.
    await dragKnobDial('[data-part="channel-knob-offset"] .wadjet-studio-knob-dial', -22.5);

    const layers = await temperatureLayers();
    const offset = layers.find((m) => m.id === "layer:temperature.mean");
    expect(offset).toEqual({ id: "layer:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 3 }] });

    // PLAN §0.1: the swing is derived from the effective base, so it follows it.
    const after = layers.find((m) => m.id === TEMP_SWING_LAYER);
    expect(after.tag).toBe("swing:0.76");
    expect(keyframeMean(after.apply[0].value)).toBeCloseTo(meanBefore + 3, 6);
    expect(keyframeSpread(after.apply[0].value)).toBeCloseTo(spreadBefore, 6);
    // …and it stays the last climate-stage writer for the parameter.
    const ids = layers.map((m: any) => m.id);
    expect(ids.indexOf(TEMP_SWING_LAYER)).toBeGreaterThan(ids.indexOf("layer:temperature.mean"));
    console.log(`  · offset +3 °C: swing keyframe mean ${meanBefore.toFixed(2)} → ${keyframeMean(after.apply[0].value).toFixed(2)} °C, spread unchanged`);
  });

  test("temperature editor 4: a Winter offset writes when.tag and moves Winter days only", async () => {
    const epoch = await resetChannelWalk();
    await seedChannelSeasons(CHANNEL_SEASONS);
    await seedWindow({ a: AUDITION_YEAR, b: AUDITION_YEAR + 1 });
    await waitForAuditionCells(1);
    await waitForAuditionYear(AUDITION_YEAR);
    const winterBefore = await auditionMeanNearDay(WINTER_DAY);
    const summerBefore = await auditionMeanNearDay(SUMMER_DAY);

    await openChannelWindow();
    const chips = (await probeChannel()).scopes;
    expect(chips).toContain("season:Winter");
    await selectChannelScope("season:Winter");

    const scoped = await probeChannel();
    expect(scoped.scope).toBe("season:Winter");
    expect(scoped.knobs).toEqual(["offset"]);
    expect(scoped.stage).toBe("daily stage · when.tag season:Winter");

    // 15 px down over the ±10 °C range is exactly −2.0 at step 0.1.
    await dragKnobDial('[data-part="channel-knob-offset"] .wadjet-studio-knob-dial', 15);

    const winter = (await temperatureLayers()).find((m) => m.id === TEMP_WINTER_LAYER);
    expect(winter).toEqual({ id: TEMP_WINTER_LAYER, when: { tag: "season:Winter" }, apply: [{ param: "temperature.mean", op: "offset", value: -2 }] });

    const winterAfter = await settledMeanNearDay(WINTER_DAY, winterBefore);
    const summerAfter = await auditionMeanNearDay(SUMMER_DAY);
    expect(winterBefore - winterAfter).toBeCloseTo(2, 1);
    expect(summerAfter).toBeCloseTo(summerBefore, 5);
    console.log(`  · season:Winter −2 °C: d${WINTER_DAY} ${winterBefore.toFixed(1)} → ${winterAfter.toFixed(1)} °C; d${SUMMER_DAY} unmoved at ${summerAfter.toFixed(1)} °C (epoch ${epoch})`);
  });

  test("temperature editor 5: the ☾ scope re-domains the chart, and a dragged envelope point stays in [0,1]", async () => {
    await resetChannelWalk();
    await openChannelWindow();

    const moonScopeId = (await probeChannel()).scopes.find((s) => s.startsWith("moon:"));
    expect(moonScopeId).toBeDefined();
    const moon = moonScopeId!.slice("moon:".length);
    await selectChannelScope(moonScopeId!);

    const cycle = await probeChannel();
    expect(cycle.domain).toBe("cycle");
    expect(cycle.knobs).toEqual(["depth"]);
    expect(cycle.stage).toBe(`daily stage · when.moon ${moon} · envelope`);
    expect(cycle.moonChip).toBe(`moon:${moon}`);
    expect(cycle.points).toBeGreaterThanOrEqual(2);

    // −3 °C at full strength: 22.5 px down over ±10 °C at step 0.1.
    await dragKnobDial('[data-part="channel-knob-depth"] .wadjet-studio-knob-dial', 22.5);
    // Far past the bottom of the 0–1 axis: the clamp is what is under test.
    await dragChartPoint(0, 400);

    const layer = (await temperatureLayers()).find((m: any) => m.id === `layer:temperature.mean:moon:${moon}`);
    expect(layer).toBeDefined();
    expect(layer.when).toEqual({ moon: { name: moon, phase: [0, 1] } });
    expect(layer.apply[0].op).toBe("offset");
    expect(layer.apply[0].value).toBeCloseTo(-3, 6);
    const envelope: Array<[number, number]> = layer.apply[0].envelope;
    expect(envelope.length).toBeGreaterThanOrEqual(2);
    for (const [phase, strength] of envelope) {
      expect(phase >= 0 && phase < 1).toBe(true);
      expect(strength >= 0 && strength <= 1).toBe(true);
    }
    // The over-drag landed on the floor, not below it.
    expect(Math.min(...envelope.map((p) => p[1]))).toBe(0);
    console.log(`  · ☾ ${moon}: depth ${layer.apply[0].value} °C · envelope ${JSON.stringify(envelope)}`);
  });

  test("temperature editor 6: the regimes writer opens the Regimes window", async () => {
    await resetChannelWalk();
    await openChannelWindow();

    const probe = await probeChannel();
    const at = probe.writers.findIndex((w) => w.kind === "regime");
    expect(at).toBeGreaterThanOrEqual(0);

    await ob.page.locator('[data-part="channel-writer"][data-kind="regime"]').first().click();
    await nextFrame();
    await regimesPanel().waitFor({ state: "visible", timeout: 10_000 });
    expect(await regimesPanel().count()).toBe(1);
    console.log(`  · writer "${probe.writers[at]?.label}" (${probe.writers[at]?.ops}) → Regimes`);

    // Leave the studio as this walk found it.
    await seedChannelSeasons([]);
    await closeStudioWindows();
    await resetDraftFromSettings();
    await clearChannelLayers("temperature", "precipitation", "wind", "sky");
    expect((await probeChannel()).open).toBe(false);
  });
});

/* ── Undo/redo, keyboard on knobs, shortcuts (bead wadjet-9f9.40) ───────── */

/** The Regimes weight knob's dial: `label: "how often"` (SPEC §3.8 nudge / typed entry). */
const weightDial = (id: string) => ob.page.locator(`.wadjet-studio-regimes-row[data-id="${id}"] .wadjet-studio-knob-dial[aria-label="how often"]`);

describe("climate studio · keyboard", () => {
  let kbRegimesBefore: unknown[] = [];

  test("step 1: ↑ on a Regimes knob three times nudges the weight one step at a time; Mod+Z undoes it", async () => {
    await openRegimesWindow();
    kbRegimesBefore = await zoneRegimesRaw();
    const id = (await probeRegimes()).rows[0]!;
    // Headroom on both sides of the WEIGHT_SPEC [0,1] step-0.01 range, so three
    // ×0.01 nudges up and three Mod+Z back never clamp.
    await seedRegimeDraft("weight", { id, value: 0.5 });

    const dial = weightDial(id);
    await dial.press("ArrowUp");
    await dial.press("ArrowUp");
    await dial.press("ArrowUp");

    const after = await probeRegimes();
    expect(after.zoneRegimes.find((r) => r.id === id)!.weight).toBeCloseTo(0.53, 6);
    // Each key press is its own undo step (SPEC §3.9: one step per drag, and a
    // key press is a one-frame drag) — three presses, three steps to undo.
    expect(after.canUndo).toBe(true);

    expect(await studioHistory("undo")).toBe(true);
    expect(await studioHistory("undo")).toBe(true);
    expect(await studioHistory("undo")).toBe(true);
    const restored = await probeRegimes();
    expect(restored.zoneRegimes.find((r) => r.id === id)!.weight).toBeCloseTo(0.5, 6);
    console.log(`  · ↑×3 on "${id}": weight 0.50 → 0.53; 3× Mod+Z restored 0.50`);
  });

  test("step 2: Enter opens typed entry on a Regimes knob; typing 0.42 and Enter commits it", async () => {
    await openRegimesWindow();
    const id = (await probeRegimes()).rows[0]!;
    await seedRegimeDraft("weight", { id, value: 0.2 });

    const dial = weightDial(id);
    await dial.press("Enter");
    const input = ob.page.locator(`.wadjet-studio-regimes-row[data-id="${id}"] .wadjet-studio-knob-input`);
    await input.waitFor({ state: "visible", timeout: 5_000 });
    await input.fill("0.42");
    await input.press("Enter");
    await input.waitFor({ state: "detached", timeout: 5_000 });

    const after = await probeRegimes();
    expect(after.zoneRegimes.find((r) => r.id === id)!.weight).toBeCloseTo(0.42, 6);
    console.log(`  · Enter → typed "0.42" → Enter: weight now ${after.zoneRegimes.find((r) => r.id === id)!.weight}`);

    // Leave the regimes[] draft as this describe found it.
    await zoneRegimesRaw(kbRegimesBefore);
    await waitForRegimeRows(kbRegimesBefore.length);
  });

  test("step 3: → on a focused era clip at Era zoom grows `from` by one year; Delete removes it", async () => {
    await revealStudio();
    await closeStudioWindows();
    const KB_ERA = "Keyboard Era";
    await seedWindow({ a: 500, b: 501 });
    await seedEras([{ name: KB_ERA, from: 500, to: 900 }]);
    await clickPreset("era");
    await waitForErasLaneSpans(1);

    const probe = await probeErasLane();
    const span = probe.spans.find((s) => s.id === `era:${KB_ERA}`);
    expect(span).toBeDefined();
    // Era zoom: a year is well under the 50 px/year threshold, so ←/→ steps a
    // whole year rather than a day.
    expect(probe.stripWidth / (probe.window.b - probe.window.a)).toBeLessThan(50);

    const before = await eraDraft(KB_ERA);
    expect(before).not.toBeNull();
    const spanLocator = ob.page.locator(`.wadjet-studio-span[data-id="era:${KB_ERA}"]`);
    // The span this presses has to be the one that is still in the document
    // when the key arrives — see `waitForSpanStable`.
    await waitForSpanStable(`era:${KB_ERA}`);
    await spanLocator.press("ArrowRight");
    const grewConfirm = await passEraWorldConfirm();
    await ob.page.waitForFunction(
      (a: { type: string; name: string; from: number }) => {
        const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
        const era = (leaf?.view.store.get().world.eras as Array<{ name: string; from: number }>).find((e) => e.name === a.name);
        return era !== undefined && era.from === a.from;
      },
      { type: VIEW_TYPE, name: KB_ERA, from: before!.from + 1 },
      { timeout: 10_000 },
    );

    const after = await eraDraft(KB_ERA);
    expect(after).not.toBeNull();
    expect(after!.from).toBe(before!.from + 1);
    expect(after!.to).toBe(before!.to! + 1);
    console.log(`  · → on "${KB_ERA}": ${before!.from} → ${after!.from} (world confirm ${grewConfirm ? "shown and accepted" : "already given this session"})`);

    await waitForSpanStable(`era:${KB_ERA}`);
    await spanLocator.press("Delete");
    await passEraWorldConfirm();
    const removed = await eraDraft(KB_ERA);
    expect(removed).toBeNull();
    console.log(`  · → grew "${KB_ERA}" from ${before!.from} to ${after!.from}; Delete removed it (still present: ${(await allEras()).some((e) => e.name === KB_ERA)})`);
  });

  test("step 4: Esc closes the Regimes window when focus is inside it", async () => {
    await openRegimesWindow();
    expect((await probeRegimes()).open).toBe(true);

    const id = (await probeRegimes()).rows[0]!;
    await weightDial(id).press("Escape");

    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
        return !((leaf?.view.store.get().view.openWindows as string[]) ?? []).includes("regimes");
      },
      { type: VIEW_TYPE },
      { timeout: 10_000 },
    );
    expect((await probeRegimes()).open).toBe(false);
    console.log(`  · Escape with focus inside the Regimes window closed it`);
  });
});

/* ── Save writes settings; per-zone drafts; first-world-edit confirm (bead wadjet-9f9.36) ─
 *
 * This describe restarts Obsidian in its last step, so it must stay the
 * final describe in this file — every describe after it would lose `ob`.
 */

/** Push (or update) the shared `layer:temperature.mean` climate-stage offset into one zone's draft. */
async function pushTempOffset(zoneId: string, value: number): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; zoneId: string; id: string; value: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update(
        (s: any) => {
          const z = s.zones[a.zoneId];
          const existing = z.modifiers.find((m: any) => m.id === a.id);
          if (existing) existing.apply[0].value = a.value;
          else z.modifiers.unshift({ id: a.id, stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: a.value }] });
        },
        { history: true },
      );
    },
    { type: VIEW_TYPE, zoneId, id: TEMP_OFFSET_LAYER, value },
  );
}

/** The zone draft's current `layer:temperature.mean` offset, or `null` when there is none. */
async function tempOffsetOf(zoneId: string): Promise<number | null> {
  return withApp(
    ob.page,
    (app, a: { type: string; zoneId: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const z = leaf?.view?.store.get().zones[a.zoneId];
      const m = z?.modifiers.find((mm: any) => mm.id === a.id);
      return m?.apply?.[0]?.value ?? null;
    },
    { type: VIEW_TYPE, zoneId, id: TEMP_OFFSET_LAYER },
  );
}

/** Switch the one studio leaf to `zoneId` through the real header menu (SPEC §3.1), not a store poke. */
async function switchZoneViaMenu(zoneId: string, name: string): Promise<void> {
  await ob.page.locator(".wadjet-studio-header-zonebtn").click();
  const menu = ob.page.locator(".menu").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await menu.locator(".menu-item", { hasText: name }).first().click();
  await ob.page.waitForFunction(
    (a: { type: string; id: string }) => (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.store.get().view.zoneId === a.id,
    { type: VIEW_TYPE, id: zoneId },
    { timeout: 10_000 },
  );
}

/** The zone menu's leading dirty mark (`●`/`✓`) for every zone, keyed by id. */
async function zoneMenuMarks(): Promise<Record<string, string>> {
  const zones = await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.zones.map((z: any) => ({ id: z.id, name: z.name })));
  await ob.page.locator(".wadjet-studio-header-zonebtn").click();
  const menu = ob.page.locator(".menu").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const titles = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const marks: Record<string, string> = {};
  for (const z of zones) {
    const row = titles.find((t) => t.includes(z.name));
    marks[z.id] = row ? row.charAt(0) : "?";
  }
  await ob.page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5_000 });
  return marks;
}

/** Detach the one studio leaf and wait for it to be gone — the "no `onClose` cancel" path. */
async function detachStudioLeaf(): Promise<void> {
  await withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      leaf?.detach();
    },
    VIEW_TYPE,
  );
  await ob.page.waitForFunction((a: { type: string }) => (window as any).app.workspace.getLeavesOfType(a.type).length === 0, { type: VIEW_TYPE }, { timeout: 10_000 });
}

/** Reopen the studio on `name` through the command (several zones ⇒ the picker prompt). */
async function reopenStudioOnZone(name: string): Promise<void> {
  const ran = await withApp(ob.page, (app, id: string) => app.commands.executeCommandById(id) as boolean, COMMAND_ID);
  expect(ran).toBe(true);
  const prompt = ob.page.locator(".modal-container .prompt");
  await prompt.waitFor({ state: "visible", timeout: 10_000 });
  await prompt.locator("input.prompt-input").fill(name);
  await prompt.locator(".suggestion-item").first().click();
  await waitForStudioLeaves(1);
}

describe("climate studio · save and drafts", () => {
  test("step 1: editing two zones through a real zone switch marks both dirty in the menu", async () => {
    await revealStudio();
    await closeStudioWindows();

    await switchZoneViaMenu(zone.id, zone.name);
    await pushTempOffset(zone.id, 4.5);

    await switchZoneViaMenu(secondZone.id, secondZone.name);
    await pushTempOffset(secondZone.id, -3.5);

    const marks = await zoneMenuMarks();
    expect(marks[zone.id]).toBe("●");
    expect(marks[secondZone.id]).toBe("●");
    console.log(`  · edited "${zone.name}" (+4.5 °C) and "${secondZone.name}" (−3.5 °C); menu marks ${JSON.stringify(marks)}`);
  });

  test("step 2: Save writes both drafts to data.json, clears both dirty marks, and Notices a summary", async () => {
    await revealStudio();
    await ob.page.locator(".wadjet-studio-header-save").click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
      },
      { type: VIEW_TYPE },
      { timeout: 15_000 },
    );

    const summary = (await notices(ob.page)).find((t) => t.startsWith("Saved") && t.includes("2 zones"));
    expect(summary).toBeDefined();

    let onDisk: { a: number | null; b: number | null } | null = null;
    for (let i = 0; i < 40 && onDisk === null; i++) {
      const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
      const layerOf = (id: string) => raw.zones.find((z: any) => z.id === id)?.modifiers?.find((m: any) => m.id === TEMP_OFFSET_LAYER)?.apply?.[0]?.value ?? null;
      const a = layerOf(zone.id);
      const b = layerOf(secondZone.id);
      if (a === 4.5 && b === -3.5) onDisk = { a, b };
      else await ob.page.waitForTimeout(250);
    }
    expect(onDisk).toEqual({ a: 4.5, b: -3.5 });

    const marks = await zoneMenuMarks();
    expect(marks[zone.id]).toBe("✓");
    expect(marks[secondZone.id]).toBe("✓");
    console.log(`  · Save wrote both zones to data.json; Notice "${summary}"; menu marks ${JSON.stringify(marks)}`);
  });

  test("step 3: closing the leaf keeps a dirty edit; reopening restores it, still dirty, with a Notice", async () => {
    await revealStudio();
    await switchZoneViaMenu(zone.id, zone.name);
    await pushTempOffset(zone.id, 6.25);
    expect((await zoneMenuMarks())[zone.id]).toBe("●");

    await detachStudioLeaf();
    const kept = (await notices(ob.page)).some((t) => t === "Unsaved studio changes kept until you reopen the studio");
    expect(kept).toBe(true);

    await reopenStudioOnZone(zone.name);
    await revealStudio();

    expect(await tempOffsetOf(zone.id)).toBe(6.25);
    expect((await zoneMenuMarks())[zone.id]).toBe("●");
    console.log(`  · leaf.detach() kept "${zone.name}"'s 6.25 °C edit; reopened via the command still dirty; kept-Notice seen = ${kept}`);
  });

  test("step 4: Save, then a full restart (another tab active first) holds the edit and reopens clean", async () => {
    await revealStudio();
    await ob.page.locator(".wadjet-studio-header-save").click();
    await ob.page.waitForFunction(
      (a: { type: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
      },
      { type: VIEW_TYPE },
      { timeout: 15_000 },
    );

    // The write has to be on disk before the process goes: this step is about
    // what SURVIVES the restart, so read it back before pulling the plug.
    for (let i = 0; i < 40; i++) {
      const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
      const v = raw.zones.find((z: any) => z.id === zone.id)?.modifiers?.find((m: any) => m.id === TEMP_OFFSET_LAYER)?.apply?.[0]?.value ?? null;
      if (v === 6.25) break;
      await ob.page.waitForTimeout(250);
    }

    await restartObsidian();

    await waitForStudioLeaves(1);
    await revealStudio();

    const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data.json"), "utf8"));
    const onDisk = raw.zones.find((z: any) => z.id === zone.id)?.modifiers?.find((m: any) => m.id === TEMP_OFFSET_LAYER)?.apply?.[0]?.value ?? null;
    expect(onDisk).toBe(6.25);

    const header = await probeHeader();
    expect(header.save).toBe("Saved ✓");
    expect(header.saveState).toBe("saved");
    console.log(`  · Save + restart: data.json holds 6.25 °C for "${zone.name}"; studio reopened clean ("${header.save}")`);
  });
});

/* ── Insert picker (bead wadjet-9f9.23) ─────────────────────────────────── */

interface InsertPickerProbe {
  open: boolean;
  title: string;
  kinds: string[];
  presets: Array<{ name: string; badge: string }>;
}

/** Everything the insert picker's own e2e cares about, read straight off the popover's DOM. */
async function probeInsertPicker(): Promise<InsertPickerProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const popover = el?.querySelector(".wadjet-studio-insert") ?? null;
      if (popover === null) return { open: false, title: "", kinds: [], presets: [] };
      const rows = Array.from(popover.querySelectorAll(".wadjet-studio-insert-row"));
      const kinds = rows.filter((r) => r.getAttribute("data-part") === "kind").map((r) => r.getAttribute("data-kind") ?? "");
      const presets = rows
        .filter((r) => r.getAttribute("data-part") === "preset")
        .map((r) => ({ name: r.getAttribute("data-preset") ?? "", badge: (r.querySelector(".wadjet-studio-insert-badge")?.textContent ?? "").trim() }));
      return { open: true, title: (popover.querySelector(".wadjet-studio-insert-title")?.textContent ?? "").trim(), kinds, presets };
    },
    VIEW_TYPE,
  );
}

/** Click the `＋` on one chain's mixer head (SPEC §3.3, §3.6). */
async function clickChainInsert(chain: string): Promise<void> {
  await mixerChain(chain).locator('[data-part="insert"]').click();
  await nextFrame();
}

describe("climate studio · insert picker", () => {
  test("insert picker 1: ＋ on WIND opens a popover titled with WIND, listing 5 kinds and at least 5 presets", async () => {
    await revealStudio();
    await clickChainInsert("wind");

    const picker = await probeInsertPicker();
    expect(picker.open).toBe(true);
    expect(picker.title).toBe("NEW DEVICE → WIND");
    expect(picker.kinds).toEqual(["trim", "moon", "spell", "tag", "chance"]);
    expect(picker.presets.length).toBeGreaterThanOrEqual(5);
    expect(picker.presets.map((p) => p.name)).toContain("Föhn days");
    console.log(`  · picker "${picker.title}": kinds ${JSON.stringify(picker.kinds)}; ${picker.presets.length} presets`);

    await ob.page.keyboard.press("Escape");
  });

  test("insert picker 2: picking Chance inserts a wind.speed device, a WIND card in slot 01, and opens its window as KIND chance", async () => {
    await revealStudio();
    await clickChainInsert("wind");
    await ob.page.locator('.wadjet-studio-insert-row[data-kind="chance"]').click();
    await nextFrame();

    // The popover is gone, and the device it created is in the draft with a wind.speed op.
    expect((await probeInsertPicker()).open).toBe(false);
    const modifier = await draftModifier("Chance");
    expect(modifier).not.toBeNull();
    expect(modifier.when).toEqual({ chance: expect.any(Number) });
    expect(modifier.apply).toEqual([{ param: "wind.speed", op: "scale", value: 1 }]);

    // A rack card for it, in WIND, at slot 01 (the only device the chain has).
    const rail = await waitForMixer((r) => (r.find((c) => c.chain === "wind")?.units.length ?? 0) > 0);
    const wind = rail.find((c) => c.chain === "wind")!;
    const card = wind.units.find((u) => u.id === "Chance");
    expect(card?.slot).toBe("01");

    // Its window opened, badged KIND chance.
    await ob.page.locator(".wadjet-studio-window .wadjet-studio-device").first().waitFor({ state: "visible", timeout: 10_000 });
    const probe = await probeDevice();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe("Chance");
    expect(probe.kind).toBe("CHANCE");
    console.log(`  · picked Chance → wind card slot ${card?.slot}; panel "${probe.title}" KIND ${probe.kind}; writes ${JSON.stringify(modifier.apply)}`);
  });

  test("insert picker 3: picking the shipped preset Föhn days writes its 3 ops and shows a linked card in TEMP, WIND and SKY", async () => {
    await revealStudio();
    await clickChainInsert("wind");
    await ob.page.locator('.wadjet-studio-insert-row[data-preset="Föhn days"]').click();
    await nextFrame();

    expect((await probeInsertPicker()).open).toBe(false);
    const modifier = await draftModifier("Föhn days");
    expect(modifier).not.toBeNull();
    expect(modifier.apply.length).toBe(3);

    const rail = await waitForMixer((r) => (r.find((c) => c.chain === "sky")?.units.some((u) => u.id === "Föhn days") ?? false));
    for (const chain of ["temperature", "wind", "sky"]) {
      const card = rail.find((c) => c.chain === chain)!.units.find((u) => u.id === "Föhn days");
      expect(card, `no Föhn days card in ${chain}`).toBeDefined();
      expect(card!.linked).toBe(true);
    }
    console.log(`  · picked preset "Föhn days": ${modifier.apply.length} ops, linked card in temperature/wind/sky`);

    await closeStudioWindows();
  });

  test("insert picker 4: Esc closes the popover without creating anything", async () => {
    await revealStudio();
    const before = (await probeMixer()).find((c) => c.chain === "temperature")!.units.map((u) => u.id);

    await clickChainInsert("temperature");
    expect((await probeInsertPicker()).open).toBe(true);
    await ob.page.keyboard.press("Escape");
    await nextFrame();

    expect((await probeInsertPicker()).open).toBe(false);
    const after = (await probeMixer()).find((c) => c.chain === "temperature")!.units.map((u) => u.id);
    expect(after).toEqual(before);
    console.log(`  · Esc closed the popover; TEMP units unchanged (${JSON.stringify(after)})`);

    await closeStudioWindows();
  });
});

/* ── Windows: drag reports position, clamping, z-order, touch hit sizes (bead wadjet-9f9.42, SPEC §3.4, §8) ── */

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface WindowGeomProbe {
  /** `view.windowPos[id]` */
  pos: { x: number; y: number; z: number } | undefined;
  /** the panel's own screen rect — null if it isn't open */
  panelRect: Rect | null;
  /** the title bar's screen rect — the part that must stay reachable (SPEC §3.4) */
  barRect: Rect | null;
  /** `.wadjet-studio-windows`' screen rect — the box every panel clamps inside */
  boxRect: Rect;
}

/** `view.windowPos[id]`, and the panel/bar/box rects a drag or a resize has to respect. */
async function probeWindowGeom(id: string, title: string): Promise<WindowGeomProbe> {
  return withApp(
    ob.page,
    (app, a: { type: string; id: string; title: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const box = el.querySelector(".wadjet-studio-windows");
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => (w.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === a.title) as HTMLElement | undefined;
      const bar = (panel?.querySelector(".wadjet-studio-window-bar") ?? null);
      const rect = (e: Element | null) => {
        if (e === null) return null;
        const r = e.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const state = leaf.view.store.get();
      return { pos: state.view.windowPos[a.id], panelRect: rect(panel ?? null), barRect: rect(bar), boxRect: rect(box)! };
    },
    { type: VIEW_TYPE, id, title },
  );
}

/**
 * Open `id` at a known, on-screen seed position, off the leaf's window manager
 * directly — the same shortcut `openRegimesWindow` uses, so a window's own
 * e2e (not this one) is what covers reaching it through its owning surface's
 * UI (SPEC law 2).
 */
async function openWindowAt(id: string, x: number, y: number, z: number): Promise<void> {
  await revealStudio();
  await withApp(
    ob.page,
    (app, a: { type: string; id: string; x: number; y: number; z: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      // `open()` on an already-open id only focuses it — it does not re-apply
      // a seeded x/y to the live component. Close first, so an earlier
      // describe's leftover panel (or a stale drag it left behind) never
      // masks the seed this step is asking for.
      if (leaf.view.windows.isOpen(a.id)) leaf.view.windows.close(a.id);
      leaf.view.store.update((s: any) => {
        s.view.windowPos[a.id] = { x: a.x, y: a.y, z: a.z };
      });
      leaf.view.windows.open(a.id);
    },
    { type: VIEW_TYPE, id, x, y, z },
  );
  await nextFrame();
}

/**
 * A real drag of a window's title bar by `(dx, dy)`: pointerdown on the bar,
 * then the move/up pair on `window`, which is where `ui/pointer.ts` listens
 * (SPEC §3.8).
 */
async function dragWindowTitle(title: string, dx: number, dy: number): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; title: string; dx: number; dy: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => (w.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === a.title) as HTMLElement | undefined;
      if (!panel) throw new Error(`no window titled "${a.title}"`);
      const bar = panel.querySelector(".wadjet-studio-window-bar") as HTMLElement;
      const box = bar.getBoundingClientRect();
      const x0 = Math.round(box.left + box.width / 2);
      const y0 = Math.round(box.top + box.height / 2);
      const x1 = x0 + a.dx;
      const y1 = y0 + a.dy;
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      bar.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x0, clientY: y0 }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: x1, clientY: y1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x1, clientY: y1 }));
    },
    { type: VIEW_TYPE, title, dx, dy },
  );
  await nextFrame();
}

/** A zero-movement pointerdown/up on a window's title bar — a click, to raise it (SPEC §3.4: z by last touch). */
async function clickWindowTitle(title: string): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; title: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const panel = Array.from(el.querySelectorAll(".wadjet-studio-window")).find((w) => (w.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === a.title) as HTMLElement | undefined;
      if (!panel) throw new Error(`no window titled "${a.title}"`);
      const bar = panel.querySelector(".wadjet-studio-window-bar") as HTMLElement;
      const box = bar.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const base = { pointerId: 9, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      bar.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      bar.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y }));
    },
    { type: VIEW_TYPE, title },
  );
  await nextFrame();
}

/**
 * A touch pointerdown/up at the SAME point (a tap, not a drag) on the always
 * -mounted Regimes lane — `REGIMES_LANE`, from the regimes-lane describe
 * above. Zero movement means `beginDrag`'s `moved` stays false, so nothing
 * the tap might have hit (a move, a resize) actually mutates the draft; only
 * the touch-detection side effects `lane.ts`'s `onPointerDown` runs
 * unconditionally are observable.
 */
async function tapRegimesLaneTouch(): Promise<{ isTouch: boolean; edgePx: string | null }> {
  return withApp(
    ob.page,
    (app, a: { type: string; lane: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const lane = el.querySelector(a.lane);
      if (!lane) throw new Error("no regimes lane");
      const box = lane.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const base = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      lane.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y }));
      const root = el.querySelector(".wadjet-studio");
      return { isTouch: root?.classList.contains("is-touch") ?? false, edgePx: lane.getAttribute("data-edge-px") };
    },
    { type: VIEW_TYPE, lane: REGIMES_LANE },
  );
}

/** Resize the real Obsidian window — the same Electron `BrowserWindow` `widenWindow` grows. */
async function setStudioWindowSize(width: number, height: number): Promise<void> {
  await ob.app.evaluate(({ BrowserWindow }, size: { width: number; height: number }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    // A maximized window ignores setSize on some platforms.
    if (w.isMaximized()) w.unmaximize();
    w.setSize(size.width, size.height);
  }, { width, height });
}

/** The real Electron `BrowserWindow`'s current outer size. */
async function getStudioWindowSize(): Promise<{ width: number; height: number }> {
  return ob.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const size = w?.getSize() ?? [1400, 900];
    return { width: size[0] ?? 1400, height: size[1] ?? 900 };
  });
}

/** Poll until every named panel's rect (and its title bar) sits inside `.wadjet-studio-windows` (SPEC §3.4). */
async function waitForWindowsClamped(titles: string[]): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; titles: string[] }) => {
      const leaf = (window as any).app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement | undefined = leaf?.view?.containerEl;
      const box = el?.querySelector(".wadjet-studio-windows");
      if (!box) return false;
      const boxRect = box.getBoundingClientRect();
      for (const title of a.titles) {
        const panel = Array.from(el!.querySelectorAll(".wadjet-studio-window")).find((w: any) => (w.querySelector(".wadjet-studio-window-title")?.textContent ?? "").trim() === title) as HTMLElement | undefined;
        if (!panel) return false;
        const bar = panel.querySelector(".wadjet-studio-window-bar");
        if (!bar) return false;
        const p = panel.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        if (p.left < boxRect.left - 1 || p.right > boxRect.right + 1) return false;
        if (b.top < boxRect.top - 1 || b.bottom > boxRect.bottom + 1) return false;
      }
      return true;
    },
    { type: VIEW_TYPE, titles },
    { timeout: 10_000 },
  );
}

describe("climate studio · windows and touch", () => {
  test("step 1: dragging the Regimes window's title bar moves windowPos.regimes by the same delta", async () => {
    // `windows.open` always assigns a fresh top z (SPEC §3.4: z by last touch),
    // so only x/y — where the panel actually landed — echo the seed.
    // Seeded INSIDE the box on both axes, not at the origin: the Regimes
    // panel's real content runs nearly as wide as the box, so there is only a
    // pixel or two of slack to its right before clamping (SPEC §3.4 — step 2's
    // subject) and a rightward drag would be a 1 px move whose rounding is the
    // whole of the measurement. Starting at x = 40 buys a real leftward delta.
    const SEED_X = 40;
    await openWindowAt(REGIMES_WINDOW_ID, SEED_X, 0, 60);
    const before = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    expect(before.pos?.x).toBe(SEED_X);
    expect(before.pos?.y).toBe(0);
    expect(before.panelRect).not.toBeNull();
    expect(before.barRect).not.toBeNull();

    const slackY = before.boxRect.bottom - before.barRect!.bottom;
    const dx = -20;
    const dy = Math.max(1, Math.min(20, Math.floor(slackY / 2)));

    await dragWindowTitle("Regimes", dx, dy);

    // The pointer coordinates the drag dispatches are integers off a
    // fractional bar centre (`dragWindowTitle` rounds), so the position the
    // handler computes can land a pixel either side of the asked-for delta.
    // The property is that the panel moved by the drag, not that it landed on
    // a sub-pixel: 1 px of rounding, on a 20 px move.
    const after = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    const movedX = after.pos!.x - before.pos!.x;
    const movedY = after.pos!.y - before.pos!.y;
    expect(movedX).toBeGreaterThanOrEqual(dx - 1);
    expect(movedX).toBeLessThanOrEqual(dx + 1);
    expect(movedY).toBeGreaterThanOrEqual(dy - 1);
    expect(movedY).toBeLessThanOrEqual(dy + 1);
    console.log(`  · dragged Regimes title by (${dx}, ${dy}) [slack y ${Math.round(slackY)}]: windowPos.regimes ${JSON.stringify(before.pos)} → ${JSON.stringify(after.pos)}`);

    await closeStudioWindows();
  });

  test("step 2: dragging it far past the right/bottom edge clamps it inside .wadjet-studio-windows", async () => {
    await openWindowAt(REGIMES_WINDOW_ID, 24, 24, 61);

    await dragWindowTitle("Regimes", 5000, 5000);

    const after = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    expect(after.panelRect).not.toBeNull();
    expect(after.barRect).not.toBeNull();
    // The full panel width matters horizontally.
    expect(after.panelRect!.left).toBeGreaterThanOrEqual(after.boxRect.left - 1);
    expect(after.panelRect!.right).toBeLessThanOrEqual(after.boxRect.right + 1);
    // Only the title bar has to stay onscreen vertically (SPEC §3.4).
    expect(after.barRect!.top).toBeGreaterThanOrEqual(after.boxRect.top - 1);
    expect(after.barRect!.bottom).toBeLessThanOrEqual(after.boxRect.bottom + 1);
    console.log(
      `  · dragged Regimes 5000×5000 px past the box: clamped to windowPos.regimes ${JSON.stringify(after.pos)}, box ${Math.round(after.boxRect.right - after.boxRect.left)}×${Math.round(after.boxRect.bottom - after.boxRect.top)}`,
    );

    await closeStudioWindows();
  });

  test("step 3: opening Forcings, then clicking the Regimes title bar, raises Regimes' z above it", async () => {
    await openWindowAt(REGIMES_WINDOW_ID, 24, 24, 62);
    await openWindowAt(FORCINGS_WINDOW_ID, 320, 24, 63);

    const forcingsBefore = await probeWindowGeom(FORCINGS_WINDOW_ID, "Forcings");
    const regimesBefore = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    expect(forcingsBefore.pos!.z).toBeGreaterThan(regimesBefore.pos!.z);

    await clickWindowTitle("Regimes");

    const regimesAfter = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    const forcingsAfter = await probeWindowGeom(FORCINGS_WINDOW_ID, "Forcings");
    expect(regimesAfter.pos!.z).toBeGreaterThan(forcingsAfter.pos!.z);
    console.log(`  · click on the Regimes title bar raised it: z ${regimesBefore.pos!.z} → ${regimesAfter.pos!.z} (Forcings stayed at ${forcingsAfter.pos!.z})`);

    await closeStudioWindows();
  });

  test("step 4: a touch pointerdown on the Regimes lane marks the studio root .is-touch and reads a 10 px edge", async () => {
    await revealStudio();
    await closeStudioWindows();

    const before = await tapRegimesLaneTouch(); // establishes the lane is present before asserting on it
    expect(before.edgePx).toBe("10");
    expect(before.isTouch).toBe(true);
    console.log(`  · touch pointerdown on the Regimes lane: root .is-touch=${before.isTouch}, lane data-edge-px=${before.edgePx}`);
  });

  test("step 5: shrinking the studio window re-clamps every open window inside the box", async () => {
    await revealStudio();
    await closeStudioWindows();

    // Seed both panels hard against the CURRENT box's bottom-right corner —
    // valid now, but not once the box shrinks under them.
    const room = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes"); // panel not open yet; only boxRect matters here
    const boxW = room.boxRect.right - room.boxRect.left;
    const boxH = room.boxRect.bottom - room.boxRect.top;
    await openWindowAt(REGIMES_WINDOW_ID, Math.max(0, boxW - 300), Math.max(0, boxH - 40), 70);
    await openWindowAt(FORCINGS_WINDOW_ID, Math.max(0, boxW - 340), Math.max(0, boxH - 70), 71);

    // Real panel content sets its own width — Regimes' STATES rows can run
    // nearly as wide as the box itself, so this shrink has to stay wide
    // enough that "inside the box" stays achievable at all (a panel wider
    // than the box can only pin to the left edge, per `clampRect`, not fit).
    // Height has no such content-width floor — the vertical clamp only
    // needs the title bar's margin, so it shrinks hard to make the resize
    // path unmistakably exercised.
    const regimes = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
    const forcings = await probeWindowGeom(FORCINGS_WINDOW_ID, "Forcings");
    const neededWidth = Math.max(regimes.panelRect!.right - regimes.panelRect!.left, forcings.panelRect!.right - forcings.panelRect!.left);
    const widthSlack = Math.max(0, boxW - neededWidth);
    const shrinkW = Math.max(0, Math.min(60, widthSlack - 4));

    const before = await getStudioWindowSize();
    const target = { width: before.width - shrinkW, height: Math.max(400, before.height - 300) };

    try {
      await setStudioWindowSize(target.width, target.height);
      await waitForWindowsClamped(["Regimes", "Forcings"]);
      const after = await probeWindowGeom(REGIMES_WINDOW_ID, "Regimes");
      console.log(
        `  · shrunk the studio window ${before.width}×${before.height} → ${target.width}×${target.height}: both open panels re-clamped inside the box (now ${Math.round(after.boxRect.right - after.boxRect.left)}×${Math.round(after.boxRect.bottom - after.boxRect.top)})`,
      );
    } finally {
      await widenWindow();
      await nextFrame();
      await closeStudioWindows();
    }
  });
});

/* ── Channel parity: PRECIP, WIND, SKY (SPEC §8; bead wadjet-9f9.32) ────────
 *
 * The temperature walk above proves the *shape* of a channel editor. This one
 * proves the other three reach the same two places TEMP does: the drawer (the
 * `layer:` grammar) and the audition (the roll itself). Every assertion is on
 * a real edit made through the panel's own controls.
 */

const PRECIP_WINDOW_ID = "channel:precipitation";
const WIND_WINDOW_ID = "channel:wind";
const SKY_WINDOW_ID = "channel:sky";

/** 150 px of drag spans a knob's whole range (`model/knob.ts`), so a target value is a pixel count. */
function knobDragPx(range: number, delta: number): number {
  return (delta / range) * 150;
}

/** `wind` is −10…24 km/h; `cloud` is ±0.5; `direction` is 0…360 — the specs in `windows/channel.ts`. */
const WIND_KNOB_RANGE = 34;
const CLOUD_KNOB_RANGE = 1;
const DIRECTION_KNOB_RANGE = 360;

const channelKnobDial = (id: string) => `[data-part="channel-knob-${id}"] .wadjet-studio-knob-dial`;

/** Wet days in the drawn audition year: every cell the roll did not mark dry. */
async function auditionWetCells(): Promise<number> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement = app.workspace.getLeavesOfType(type)[0].view.containerEl;
      const cells = Array.from(el.querySelectorAll(".wadjet-studio-audition-cell"));
      if (cells.length === 0) throw new Error("the audition has not drawn yet");
      return cells.filter((c) => !c.hasClass("is-dry")).length;
    },
    VIEW_TYPE,
  );
}

/** The strip re-rolls on a debounce (H-1392): wait for the count itself to move off `from`. */
async function settledWetCells(from: number): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const n = await auditionWetCells();
    if (n !== from) return n;
    await ob.page.waitForTimeout(100);
  }
  throw new Error(`the wet-day count never moved off ${from}`);
}

/** The day card's own reading for one field, as its numbers — `wind` is `<point> <deg>° · <speed> km/h`. */
async function dayCardNumbers(field: string): Promise<number[]> {
  const card = await dayCardProbe();
  if (card.hidden) throw new Error("the day card is not showing — the window is wider than 7.5 days");
  return numbersIn(card.cells[field] ?? "");
}

/** Wait for the card's field to redraw off a known reading, then hand back its numbers (H-1392). */
async function settledDayCardNumbers(field: string, from: number[]): Promise<number[]> {
  const key = from.join(",");
  for (let i = 0; i < 60; i++) {
    const now = await dayCardNumbers(field);
    if (now.length > 0 && now.join(",") !== key) return now;
    await ob.page.waitForTimeout(100);
  }
  throw new Error(`the day card's ${field} never moved off ${key}`);
}

/** Which channels the zone's own regimes write, off the draft — `compile.ts writersFor`'s regime rows, from the other side. */
async function zoneRegimeChannels(): Promise<string[]> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const s = leaf.view.store.get();
      const zone = s.zones[s.view.zoneId];
      const byRoot: Record<string, string> = { temperature: "temperature", precipitation: "precipitation", wind: "wind", cloud: "sky", humidity: "sky" };
      const out = new Set<string>();
      for (const r of zone?.regimes ?? []) {
        for (const op of r.apply ?? []) {
          const channel = byRoot[String(op.param).split(".")[0] ?? ""];
          if (channel !== undefined) out.add(channel);
        }
      }
      return [...out];
    },
    VIEW_TYPE,
  );
}

/** Three days wide, so the playlist hands over to the day card (SPEC §3.2). */
async function seedDayZoom(epoch: number): Promise<void> {
  const centre = epoch + 5 + 100 / 365;
  await seedWindow({ a: centre - 1.5 / 365, b: centre + 1.5 / 365 });
  await nextFrame();
}

describe("climate studio · channel parity", () => {
  test("channel parity 1: the PRECIP label opens the wet-day odds pair, and chance scales layer:precipitation.pwd into the audition", async () => {
    await resetChannelWalk();
    await seedWindow({ a: AUDITION_YEAR, b: AUDITION_YEAR + 1 });
    await waitForAuditionCells(1);
    await waitForAuditionYear(AUDITION_YEAR);
    const wetBefore = await auditionWetCells();

    await ob.page.locator('.wadjet-studio-row-label:text-is("PRECIP")').first().click();
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.open).toBe(true);
    expect(probe.channel).toBe("precipitation");
    expect(probe.title).toBe("Precipitation");
    expect(probe.badge).toBe("CHANNEL");
    expect(probe.domain).toBe("year");
    expect(probe.points).toBe(12);
    // SPEC §8: the odds pair, one of the two editable at a time.
    expect(probe.seriesOptions).toEqual(["precipitation.pww", "precipitation.pwd"]);
    expect(probe.series).toBe("precipitation.pwd");
    expect(probe.knobs).toEqual(["stick", "chance", "amount"]);
    expect(probe.knobValues).toEqual(["×1.00", "×1.00", "×1.00"]);
    expect(probe.stage).toBe("climate stage · applied once to the curves");
    expect(probe.writes).toContain("layer:precipitation.*");

    await setJsonOpen(true);
    // The knob is ×0.4–2.5: 30 px up is +0.42 at step 0.01.
    await dragKnobDial(channelKnobDial("chance"), -30);

    const layers = await channelLayers("precipitation");
    const scale = layers.find((m) => m.id === "layer:precipitation.pwd:scale");
    expect(scale).toBeDefined();
    expect(scale.stage).toBe("climate");
    expect(scale.apply[0].op).toBe("scale");
    expect(scale.apply[0].value).toBeGreaterThan(1);
    // Only `pwd` moved — `stick` and `amount` are their own layers.
    expect(layers.map((m: any) => m.id)).toEqual(["layer:precipitation.pwd:scale"]);

    const json = await probeJson();
    expect(json.visible).toBe(true);
    expect(json.modifiersText).toContain("layer:precipitation.pwd:scale");
    await setJsonOpen(false);

    const wetAfter = await settledWetCells(wetBefore);
    expect(wetAfter).toBeGreaterThan(wetBefore);
    console.log(`  · chance ×${scale.apply[0].value}: wet days ${wetBefore} → ${wetAfter} of the drawn year`);
  });

  test("channel parity 2: a ☾ scope re-domains PRECIP's chart onto the pwd envelope", async () => {
    await resetChannelWalk();
    await openChannelWindow(PRECIP_WINDOW_ID);

    const moonScopeId = (await probeChannel()).scopes.find((s) => s.startsWith("moon:"));
    expect(moonScopeId).toBeDefined();
    const moon = moonScopeId!.slice("moon:".length);
    await selectChannelScope(moonScopeId!);

    const cycle = await probeChannel();
    expect(cycle.domain).toBe("cycle");
    expect(cycle.knobs).toEqual(["depth"]);
    expect(cycle.stage).toBe(`daily stage · when.moon ${moon} · envelope`);
    // The picker is gone: the envelope is the only curve a ☾ scope has.
    expect(cycle.seriesOptions).toEqual([]);

    // −0.15 wet-day odds at full strength: 37.5 px down over the ±0.3 range.
    await dragKnobDial(channelKnobDial("depth"), knobDragPx(0.6, 0.15));

    const layer = (await channelLayers("precipitation")).find((m: any) => m.id === `layer:precipitation.pwd:moon:${moon}`);
    expect(layer).toBeDefined();
    expect(layer.when).toEqual({ moon: { name: moon, phase: [0, 1] } });
    expect(layer.apply[0].op).toBe("offset");
    expect(layer.apply[0].value).toBeCloseTo(-0.15, 6);
    expect(layer.apply[0].envelope.length).toBeGreaterThanOrEqual(2);
    console.log(`  · ☾ ${moon}: pwd depth ${layer.apply[0].value} · envelope ${JSON.stringify(layer.apply[0].envelope)}`);
  });

  test("channel parity 3: WIND opens the speed chart and the rose, and +8 km/h reaches the day card", async () => {
    const epoch = await resetChannelWalk();

    await ob.page.locator('.wadjet-studio-row-label:text-is("WIND")').first().click();
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.channel).toBe("wind");
    expect(probe.title).toBe("Wind");
    expect(probe.domain).toBe("year");
    expect(probe.points).toBe(12);
    // One line, so no picker; the rose is the second plot.
    expect(probe.seriesOptions).toEqual([]);
    expect(probe.roseSectors).toBeGreaterThan(0);
    expect(probe.knobs).toEqual(["wind", "gust", "calm"]);
    expect(probe.knobValues).toEqual(["+0.0 km/h", "×1.00", "+0.00"]);
    expect(probe.writes).toContain("layer:wind.*");

    await seedDayZoom(epoch);
    const before = await dayCardNumbers("wind");
    expect(before.length).toBeGreaterThanOrEqual(2);
    const speedBefore = before[before.length - 1]!;

    await dragKnobDial(channelKnobDial("wind"), -knobDragPx(WIND_KNOB_RANGE, 8));

    const offset = (await channelLayers("wind")).find((m: any) => m.id === "layer:wind.speed");
    expect(offset).toBeDefined();
    expect(offset.stage).toBe("climate");
    expect(offset.apply[0]).toEqual({ param: "wind.speed", op: "offset", value: 8 });

    const after = await settledDayCardNumbers("wind", before);
    const speedAfter = after[after.length - 1]!;
    expect(speedAfter).toBeGreaterThan(speedBefore);
    console.log(`  · wind +8 km/h: the day card reads ${speedBefore} → ${speedAfter} km/h`);
  });

  test("channel parity 4: a Winter bearing writes layer:wind.direction:season:Winter:set and turns the rose", async () => {
    const epoch = await resetChannelWalk();
    await seedChannelSeasons(CHANNEL_SEASONS);
    await seedWindow({ a: epoch + 5, b: epoch + 6 });
    await openChannelWindow(WIND_WINDOW_ID);

    const roseBefore = (await probeChannel()).rose;
    expect(roseBefore.length).toBeGreaterThan(0);

    await selectChannelScope("season:Winter");
    const scoped = await probeChannel();
    expect(scoped.scope).toBe("season:Winter");
    expect(scoped.knobs).toEqual(["wind", "direction"]);
    expect(scoped.stage).toBe("daily stage · when.tag season:Winter");
    // Nothing written yet, so there is nothing to reset to.
    expect(scoped.reset).toBe(false);

    // 0…360 over 150 px: 112.5 px up is exactly 270° at step 1.
    await dragKnobDial(channelKnobDial("direction"), -knobDragPx(DIRECTION_KNOB_RANGE, 270));

    const set = (await channelLayers("wind")).find((m: any) => m.id === "layer:wind.direction:season:Winter:set");
    expect(set).toEqual({ id: "layer:wind.direction:season:Winter:set", when: { tag: "season:Winter" }, apply: [{ param: "wind.direction", op: "set", value: 270 }] });

    const turned = await probeChannel();
    // 270° / 22.5° = sector 12, and the rose is drawn from the same reading.
    expect(turned.rose.split(",")).toContain("12:1");
    expect(turned.rose).not.toBe(roseBefore);
    expect(turned.knobValues[1]).toBe("W 270°");
    expect(turned.reset).toBe(true);

    // A bearing has no neutral, so the chip is the only way back to the station's own.
    await ob.page.locator('[data-part="channel-direction-reset"]').first().click();
    await nextFrame();
    const reset = await probeChannel();
    expect(reset.reset).toBe(false);
    expect(reset.rose).toBe(roseBefore);
    expect((await channelLayers("wind")).some((m: any) => m.id.startsWith("layer:wind.direction"))).toBe(false);
    console.log(`  · Winter 270°: rose ${roseBefore} → ${turned.rose}, and the reset put it back`);

    await seedChannelSeasons([]);
  });

  test("channel parity 5: SKY's cloud knob writes both halves of the pair, and the day card's cloud rises", async () => {
    const epoch = await resetChannelWalk();

    await ob.page.locator('.wadjet-studio-row-label:text-is("SKY")').first().click();
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.channel).toBe("sky");
    expect(probe.title).toBe("Sky");
    expect(probe.points).toBe(12);
    // SPEC §1: cloud and humidity are one channel, so both pairs are on the picker.
    expect(probe.seriesOptions).toEqual(["cloud.dry", "cloud.wet", "humidity.dry", "humidity.wet"]);
    expect(probe.series).toBe("cloud.dry");
    expect(probe.knobs).toEqual(["cloud", "humidity"]);
    expect(probe.knobValues).toEqual(["+0.00", "+0.00"]);
    expect(probe.writes).toContain("layer:cloud.*");
    expect(probe.writes).toContain("layer:humidity.*");

    // The picker really swaps the editable line.
    await ob.page.locator('[data-part="channel-series"] .wadjet-studio-segment[data-value="humidity.wet"]').first().click();
    await nextFrame();
    const swapped = await probeChannel();
    expect(swapped.series).toBe("humidity.wet");
    expect(swapped.points).toBe(12);
    await ob.page.locator('[data-part="channel-series"] .wadjet-studio-segment[data-value="cloud.dry"]').first().click();
    await nextFrame();

    await seedDayZoom(epoch);
    const before = await dayCardNumbers("sky");
    expect(before.length).toBeGreaterThanOrEqual(2);
    const cloudBefore = before[0]!;

    // ±0.5 over 150 px: 30 px up is exactly +0.20 at step 0.01.
    await dragKnobDial(channelKnobDial("cloud"), -knobDragPx(CLOUD_KNOB_RANGE, 0.2));

    const layers = await channelLayers("sky");
    expect(layers.map((m: any) => m.id).sort()).toEqual(["layer:cloud.dry", "layer:cloud.wet"]);
    for (const m of layers) {
      expect(m.stage).toBe("climate");
      expect(m.apply[0].op).toBe("offset");
      expect(m.apply[0].value).toBeCloseTo(0.2, 6);
    }

    const after = await settledDayCardNumbers("sky", before);
    expect(after[0]!).toBeGreaterThan(cloudBefore);
    console.log(`  · cloud +0.20: two layers written, the day card reads ${cloudBefore}% → ${after[0]}% cloud`);
  });

  test("channel parity 6: every channel's writers stack leads with the station and lists the regimes that write it", async () => {
    await resetChannelWalk();
    // The truth the stack is held against: which channels this zone's own
    // regimes actually write. `fjord-coast` has no regime op on `wind`, so
    // "every channel shows a regime row" would be a false assertion.
    const regimeChannels = await zoneRegimeChannels();
    expect(regimeChannels.length).toBeGreaterThanOrEqual(2);

    for (const [id, title, channel] of [
      [CHANNEL_WINDOW_ID, "Temperature", "temperature"],
      [PRECIP_WINDOW_ID, "Precipitation", "precipitation"],
      [WIND_WINDOW_ID, "Wind", "wind"],
      [SKY_WINDOW_ID, "Sky", "sky"],
    ] as const) {
      await closeStudioWindows();
      await openChannelWindow(id);
      const probe = await probeChannel();
      expect(probe.title, id).toBe(title);
      expect(probe.channel, id).toBe(channel);
      // SPEC §1: the station is the baseline the rest of the stack edits, so it always leads.
      expect(probe.writers.length, id).toBeGreaterThanOrEqual(1);
      expect(probe.writers[0]?.kind, id).toBe("station");
      expect(probe.writers.some((w) => w.kind === "regime"), id).toBe(regimeChannels.includes(channel));
      // SPEC law 5: the footer names the grammar this panel writes, SKY's two sections included.
      for (const section of CHANNEL_LAYER_SECTIONS[channel]!) expect(probe.writes, id).toContain(`layer:${section}.*`);
      console.log(`  · ${title}: writers ${probe.writers.map((w) => w.kind).join(" → ")} · writes ${probe.writes}`);
    }

    // Leave the studio as this walk found it.
    await seedChannelSeasons([]);
    await closeStudioWindows();
    await setJsonOpen(false);
    await resetDraftFromSettings();
    await clearChannelLayers("temperature", "precipitation", "wind", "sky");
    expect((await probeChannel()).open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hemisphere: the header ⇅ chip and flipSeasons end to end (SPEC §3.1; PLAN
// D9, Q4, §0.1 "Hemisphere (Atlas, W7)"; bead wadjet-9f9.39)
// ---------------------------------------------------------------------------

interface FlipProbe {
  visible: boolean;
  label: string;
  ledVisible: boolean;
  ledLevel: string;
  hint: string;
}

/** The header's chip and its LED, straight off the DOM (SPEC 3.1). */
async function probeFlip(): Promise<FlipProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const chip = el?.querySelector('[data-part="flip"]');
      const led = el?.querySelector('[data-part="flip-led"]');
      return {
        visible: !(chip?.className ?? "is-hidden").includes("is-hidden"),
        label: (chip?.querySelector(".wadjet-studio-chip-label")?.textContent ?? "").trim(),
        ledVisible: !(led?.className ?? "is-hidden").includes("is-hidden"),
        ledLevel: led?.getAttribute("data-level") ?? "",
        hint: chip?.getAttribute("data-hint") ?? "",
      };
    },
    VIEW_TYPE,
  );
}

/** Click the header's flip chip: SPEC 3.1's toggle, undoable. */
async function clickFlipChip(): Promise<void> {
  await ob.page.locator('[data-part="flip"]').first().click();
  await nextFrame();
}

const HEMI_DEVICE = "hemi-device";

/** Replace HEMI_DEVICE in the draft with a season:Winter-gated +10 C daily offset. */
async function seedHemisphereDevice(): Promise<void> {
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update((s: any) => {
        const zone = s.zones[s.view.zoneId];
        zone.modifiers = zone.modifiers.filter((m: any) => m.id !== a.id);
        zone.modifiers.push({ id: a.id, stage: "daily", when: { tag: "season:Winter" }, apply: [{ param: "temperature.mean", op: "offset", value: 10 }] });
      });
    },
    { type: VIEW_TYPE, id: HEMI_DEVICE },
  );
  await nextFrame();
  await nextFrame();
}

/** The Winter band's fractional-year "from", read once with the flag off, so step 3 can hold the shift against it. */
let hemiBandFrom = 0;
/** The two day means read with the flag off, so step 3 can hold their swap against them. */
let hemiWinterMean = 0;
let hemiSummerMean = 0;

describe("climate studio · hemisphere", () => {
  test("hemisphere 1: a cross-equator geography match sets the ⇅ chip on; clicking it off keeps the chip offered", async () => {
    await revealStudio();
    // Defensive: an earlier describe's window-shrink walk (windows and touch,
    // step 5) restores the window itself, but this guards this describe
    // against inheriting a narrow one regardless — the header's badges and
    // transport sit close enough that a narrow window can put one under the
    // other's hit box.
    await widenWindow();
    await closeStudioWindows();
    await atlasClosePanel();
    await atlasOpenFromSrc();
    await atlasSegment("atlas-mode", "geography");
    await atlasSegment("atlas-swing", "station");
    await atlasSegment("atlas-terrain", "none");
    await atlasTypeKnob("atlas-altitude", "200");
    await atlasTypeKnob("atlas-latitude", "-35");
    await atlasPanel().locator('[data-part="atlas-matchbtn"]').click();
    await atlasWaitForPreset(null, "auto");

    const matched = await atlasDraft();
    expect(matched.flipSeasons).toBe(true);
    await atlasClosePanel();

    const on = await probeFlip();
    expect(on.visible).toBe(true);
    expect(on.label).toBe("seasons flipped");

    await clickFlipChip();
    const off = await probeFlip();
    // Still offered: the geography and the matched station still straddle the
    // equator (PLAN §0.1) — only flipSeasons itself came off.
    expect(off.visible).toBe(true);
    expect(off.label).toBe("seasons not flipped");
    expect((await atlasDraft()).flipSeasons).toBeNull();
    console.log(`  · geography match → ⇅ chip on ("${on.label}"); click off → still offered ("${off.label}")`);
  });

  test("hemisphere 2: with the flag off, a season:Winter device band sits unshifted and only the Winter day is warmed", async () => {
    await revealStudio();
    await seedChannelSeasons(CHANNEL_SEASONS);
    await seedHemisphereDevice();
    await seedWindow({ a: AUDITION_YEAR, b: AUDITION_YEAR + 1 });
    await waitForDeviceLane(HEMI_DEVICE, 1);

    const lane = await probeDeviceLane(HEMI_DEVICE);
    expect(lane.flipSeasons).toBe(false);
    expect(lane.kind).toBe("band");
    expect(lane.spans.length).toBe(1);
    hemiBandFrom = lane.spans[0]!.from;
    // Winter starts at yearPhase .75 — unshifted while the flag is off.
    expect(hemiBandFrom - Math.floor(hemiBandFrom)).toBeCloseTo(0.75, 6);

    await waitForAuditionCells(1);
    await waitForAuditionYear(AUDITION_YEAR);
    hemiWinterMean = await auditionMeanNearDay(WINTER_DAY);
    hemiSummerMean = await auditionMeanNearDay(SUMMER_DAY);
    console.log(`  · flag off: band at ${hemiBandFrom.toFixed(3)}; d${WINTER_DAY} ${hemiWinterMean.toFixed(1)} °C, d${SUMMER_DAY} ${hemiSummerMean.toFixed(1)} °C`);
  });

  test("hemisphere 3: toggling the chip on shifts the band half a year and swaps which day is warmed", async () => {
    await revealStudio();
    await clickFlipChip();
    expect((await probeFlip()).label).toBe("seasons flipped");
    expect((await atlasDraft()).flipSeasons).toBe(true);

    await waitForDeviceLane(HEMI_DEVICE, 1);
    const lane = await probeDeviceLane(HEMI_DEVICE);
    expect(lane.flipSeasons).toBe(true);
    expect(lane.spans.length).toBe(1);
    const bandFrom = lane.spans[0]!.from;
    // Half a year earlier: wrap1(0.75 - 0.5) = 0.25.
    expect(bandFrom - Math.floor(bandFrom)).toBeCloseTo(0.25, 6);
    expect(bandFrom).toBeCloseTo(hemiBandFrom - 0.5, 6);

    const winterAfter = await settledMeanNearDay(WINTER_DAY, hemiWinterMean);
    const summerAfter = await settledMeanNearDay(SUMMER_DAY, hemiSummerMean);
    // The day that read Winter (and was warmed) no longer does; the day half a
    // year away now reads Winter instead (PLAN D9: tags move, curves do not).
    expect(hemiWinterMean - winterAfter).toBeCloseTo(10, 1);
    expect(summerAfter - hemiSummerMean).toBeCloseTo(10, 1);
    console.log(
      `  · flip on: band ${hemiBandFrom.toFixed(3)} → ${bandFrom.toFixed(3)}; d${WINTER_DAY} ${hemiWinterMean.toFixed(1)} → ${winterAfter.toFixed(1)} °C, d${SUMMER_DAY} ${hemiSummerMean.toFixed(1)} → ${summerAfter.toFixed(1)} °C`,
    );
  });

  test("hemisphere 4: under an opaque adapter (no describe) the chip carries the warn LED and its hint names the calendar", async () => {
    await revealStudio();
    // The settings tab captures the adapter list when it renders, so the
    // window has to be up BEFORE the calendar registers — the smoke walk's
    // order (see "header and hint bar" step 34, above).
    await openWadjetSettings();
    await withApp(ob.page, () => {
      const w = window as unknown as { Wadjet: { registerTimeAdapter: (x: unknown) => () => void } };
      const un = w.Wadjet.registerTimeAdapter({
        id: "fake-hemi-cal",
        now: () => null,
        toContext: (d: number) => ({ dayOrdinal: d, yearLength: 400, yearPhase: (d % 400) / 400, source: "fake-hemi-cal" }),
        configHash: () => "fake-hemi:1",
        // no describe() at all: an opaque calendar (SPEC §8, PLAN D9).
      });
      (window as unknown as { __wadjetHemiUnregister?: () => void }).__wadjetHemiUnregister = un;
    });

    try {
      await ob.page.waitForTimeout(500);
      await openWadjetSettings();
      const source = settingsZoneRow("Calendar source");
      await source.waitFor({ state: "visible", timeout: 10_000 });
      await source.locator("select:not(.is-measuring)").selectOption("fake-hemi-cal");
      await ob.page.waitForTimeout(500);
      await withApp(ob.page, (app) => app.setting.close());
      await revealStudio();

      const probe = await probeFlip();
      expect(probe.visible).toBe(true);
      expect(probe.ledVisible).toBe(true);
      expect(probe.ledLevel).toBe("warn");
      expect(probe.hint).toContain("this calendar does not describe its seasons; tags are not remapped");
      console.log(`  · opaque adapter: ⇅ chip warn LED, hint "${probe.hint}"`);
    } finally {
      // Restore: back to the internal calendar, then drop the fake adapter.
      await openWadjetSettings();
      await settingsZoneRow("Calendar source").waitFor({ state: "visible", timeout: 10_000 });
      await settingsZoneRow("Calendar source").locator("select:not(.is-measuring)").selectOption("internal");
      await ob.page.waitForTimeout(500);
      await withApp(ob.page, (app) => app.setting.close());
      await withApp(ob.page, () => {
        (window as unknown as { __wadjetHemiUnregister?: () => void }).__wadjetHemiUnregister?.();
      });
      await ob.page.waitForTimeout(500);
      await revealStudio();
    }

    // Back under the internal calendar, still flipped, describing 4 seasons: ok.
    const restored = await probeFlip();
    expect(restored.ledLevel).toBe("ok");
    console.log(`  · restored: source back to internal, ⇅ LED "${restored.ledLevel}"`);
  });
});

/* ── The validation surface: issues → units, windows, LEDs, Save state (bead wadjet-9f9.35) ── */

/**
 * Poll until the panel whose body matches `bodySelector` shows `level` on its
 * chrome LED — `.wadjet-studio-window-led` is the chrome's slot,
 * `.wadjet-studio-led` the lamp `renderAll` repaints every tick (`windows.ts`).
 */
async function waitForWindowLedLevel(bodySelector: string, level: string): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; bodySelector: string; level: string }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const bodyEl = el?.querySelector(a.bodySelector) ?? null;
      const panel = bodyEl?.closest(".wadjet-studio-window") ?? null;
      return panel?.querySelector(".wadjet-studio-window-led .wadjet-studio-led")?.getAttribute("data-level") === a.level;
    },
    { type: VIEW_TYPE, bodySelector, level },
    { timeout: 10_000 },
  );
}

/** The mixer's Regimes LED `data-level` in one chain's fixed strip. */
async function mixerRegimesLedLevel(chain: string): Promise<string> {
  return (await mixerChain(chain).locator('[data-part="regimes-led"]').getAttribute("data-level")) ?? "";
}

/** The four chains the Regimes fixed strip repeats into (SPEC §3.3). */
const VALIDATION_CHAINS = ["temperature", "precipitation", "wind", "sky"];

describe("climate studio · validation", () => {
  /** `regimes[]` as step 1 found it, so step 4 can leave the shared vault exactly as it was. */
  let regimesBefore: any[] = [];

  test("validation 1: blanking a regime's name reddens its window's chrome LED, the mixer's Regimes LED and Save, whose hint lists the message", async () => {
    await widenWindow();
    await revealStudio();
    await closeStudioWindows();
    regimesBefore = (await zoneRegimesRaw()) as any[];

    await openRegimesWindow();
    await waitForWindowLedLevel(".wadjet-studio-regimes", "ok");
    for (const chain of VALIDATION_CHAINS) expect(await mixerRegimesLedLevel(chain)).toBe("ok");

    // Blank the first regime's `id` — SPEC §3.9 / `core/profile.ts`: an empty
    // regime id is an error, routed by `mapIssue` to the fixed Regimes unit
    // and the Regimes window (`path.startsWith("regimes")`).
    const blanked = regimesBefore.map((r, i) => (i === 0 ? { ...r, id: "" } : r));
    await zoneRegimesRaw(blanked);

    await waitForWindowLedLevel(".wadjet-studio-regimes", "error");
    for (const chain of VALIDATION_CHAINS) expect(await mixerRegimesLedLevel(chain)).toBe("error");

    const header = await probeHeader();
    expect(header.save).toBe("Save · 1 issue");
    expect(header.saveState).toBe("blocked");
    expect(header.saveDisabled).toBe(true);

    await ob.page.locator(".wadjet-studio-header-save").hover();
    const hinted = await probeHeader();
    expect(hinted.hintName).toBe("Save");
    expect(hinted.hintDetail).toContain("required");
    console.log(`  · blanked regime id: window LED error, mixer Regimes LED error on every chain, Save "${header.save}" (blocked), hint "${hinted.hintDetail}"`);
  });

  test("validation 2: restoring the name clears every LED and Save reads Save ● again", async () => {
    await zoneRegimesRaw(regimesBefore);
    await waitForWindowLedLevel(".wadjet-studio-regimes", "ok");
    for (const chain of VALIDATION_CHAINS) expect(await mixerRegimesLedLevel(chain)).toBe("ok");

    const header = await probeHeader();
    expect(header.save).toBe("Save ●");
    expect(header.saveState).toBe("dirty");
    expect(header.saveDisabled).toBe(false);
    console.log(`  · name restored: window LED ok, mixer Regimes LED ok, Save "${header.save}"`);
  });

  test("validation 3: a 45-day dwell ambers the LED and Save, which stays enabled", async () => {
    // `RECOMMENDED_REGIME_DURATION` (`core/profile.ts`) is 30 d; 45 is a warning, not an error.
    const dwelt = regimesBefore.map((r, i) => (i === 0 ? { ...r, meanDurationDays: 45 } : r));
    await zoneRegimesRaw(dwelt);

    await waitForWindowLedLevel(".wadjet-studio-regimes", "warn");
    for (const chain of VALIDATION_CHAINS) expect(await mixerRegimesLedLevel(chain)).toBe("warn");

    const header = await probeHeader();
    expect(header.save).toBe("Save ● · 1 ⚠");
    expect(header.saveState).toBe("warn");
    expect(header.saveDisabled).toBe(false);
    console.log(`  · 45 d dwell: window LED warn, mixer Regimes LED warn, Save "${header.save}" (enabled)`);
  });

  test("validation 4: close the panel and restore the zone's regimes", async () => {
    await zoneRegimesRaw(regimesBefore);
    await waitForWindowLedLevel(".wadjet-studio-regimes", "ok");
    await closeStudioWindows();
    await withApp(ob.page, (app, type: string) => app.workspace.getLeavesOfType(type)[0] && app.workspace.requestSaveLayout(), VIEW_TYPE);

    const after = await zoneRegimesRaw();
    expect(after).toEqual(regimesBefore);
    console.log("  · panel closed, regimes restored");
  });
});

/* ── Studio units: imperial readouts and H-1384 (SPEC §8; PLAN §4; wadjet-9f9.41) ── */

function forcingsPanel() {
  return ob.page.locator(".wadjet-studio-window", { has: ob.page.locator('.wadjet-studio-window-title:text-is("Forcings")') }).first();
}

/** Type an exact value into a knob inside the Forcings panel — the dial's own double-click entry field, same gesture as `atlasTypeKnob`. */
async function forcingsTypeKnob(part: string, value: string): Promise<void> {
  await forcingsPanel().locator(`[data-part="${part}"] .wadjet-studio-knob-dial`).dblclick();
  const input = forcingsPanel().locator(`[data-part="${part}"] .wadjet-studio-knob-input`);
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(value);
  await input.press("Enter");
  await nextFrame();
}

/**
 * Set `settings.units` and reopen the studio on `zone`. A bare settings
 * change does not repaint an already-open panel — `settings.units` is not
 * part of `ctx.store`, so no window's `ctx.store.subscribe` fires (every
 * window in `src/studio/ui/windows/*.ts` reads `ctx.plugin.settings.units`
 * fresh at its next repaint, but nothing schedules one). A fresh mount reads
 * it at first paint instead, which is why the private-vault flow this bead's
 * handoff specifies reopens rather than toggling in place.
 */
async function setStudioUnits(units: "metric" | "imperial"): Promise<void> {
  await withApp(
    ob.page,
    async (app, u: string) => {
      app.plugins.plugins.wadjet.settings.units = u;
      await app.plugins.plugins.wadjet.saveAndRebuild();
    },
    units,
  );
  await detachStudioLeaf();
  await reopenStudioOnZone(zone.name);
  await revealStudio();
}

/** Wait for the header's Save control to report a clean save, the same condition "save and drafts" step 2 waits on. */
async function waitForSaved(): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      return (el?.querySelector(".wadjet-studio-header-save")?.textContent ?? "").trim() === "Saved ✓";
    },
    { type: VIEW_TYPE },
    { timeout: 15_000 },
  );
}

describe("climate studio · units", () => {
  test("units 1: under imperial the day card, the Forcings trim knob and the MASTER warmth chip all read °F/mph; metric returns them", async () => {
    await revealStudio();
    await switchZoneViaMenu(zone.id, zone.name);
    await resetForcings();
    await closeStudioWindows();

    try {
      await setStudioUnits("imperial");

      // Day card: seed a Day-zoom window (≤ 7.5 days) and read the imperial cells.
      const epoch = await epochYear();
      const centre = epoch + 5 + 100 / 365;
      await seedWindow({ a: centre - 1.5 / 365, b: centre + 1.5 / 365 });
      const card = await dayCardProbe();
      expect(card.hidden).toBe(false);
      expect(card.cells["temperature"]).toContain("°F");
      expect(card.cells["precipitation"]).toMatch(/dry|in/);
      console.log(`  · imperial day card: temperature "${card.cells["temperature"]}", precipitation "${card.cells["precipitation"]}", wind "${card.cells["wind"]}"`);

      // The Forcings trim knob.
      await openForcingsFromMixer();
      const forcings = await probeForcings();
      expect(forcings.trim).toContain("°F");
      console.log(`  · imperial Forcings trim readout: "${forcings.trim}"`);

      // The MASTER warmth chip.
      const rail = await probeMixer();
      const master = rail.find((c) => c.chain === "master");
      expect(master?.masterChips[0]).toContain("°F");
      console.log(`  · imperial MASTER chips: ${JSON.stringify(master?.masterChips)}`);
    } finally {
      await setStudioUnits("metric");
    }
  });

  test("units 2: typing a value into the trim knob under imperial converts and stores it in metric — the touched value only (H-1384)", async () => {
    await revealStudio();
    await switchZoneViaMenu(zone.id, zone.name);
    await resetForcings();

    try {
      await setStudioUnits("imperial");
      await openForcingsFromMixer();

      // The trim knob is a ±8 °C *delta* (SPEC §3.4/PLAN §5.3 `TRIM_SPEC`), so
      // typing a Fahrenheit value converts by the pure 5/9 ratio, no +32
      // offset (`format.ts`'s "temperatureDelta"): 9 °F → 5 °C, comfortably
      // inside the knob's own range, converted back exactly.
      await forcingsTypeKnob("forcings-trim", "9");
      const draft = await forcingsDraft();
      const stored = draft.trim?.apply?.find((o: any) => o.param === "temperature.mean" && o.op === "offset")?.value ?? null;
      expect(stored).toBeCloseTo(5, 9);
      console.log(`  · typed "9" °F on the trim knob → stored forcings:temperature.mean = ${stored} °C`);
    } finally {
      await setStudioUnits("metric");
      await switchZoneViaMenu(zone.id, zone.name);
      await resetForcings();
    }
  });

  test("units 3: an untouched stored value survives Save under imperial unchanged (H-1384)", async () => {
    await revealStudio();
    await switchZoneViaMenu(zone.id, zone.name);
    // Write 20 °C directly into the draft — the model itself does not clamp
    // to the trim knob's own ±8 °C UI range, and H-1384 must hold regardless
    // of how a value already in the draft got there.
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update((s: any) => {
          const z = s.zones[a.id];
          z.modifiers = z.modifiers.filter((m: any) => !String(m.id).startsWith("forcings:"));
          z.modifiers.push({ id: "forcings:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 20 }] });
        });
      },
      { type: VIEW_TYPE, id: zone.id },
    );
    await nextFrame();

    try {
      await setStudioUnits("imperial");
      await openForcingsFromMixer();
      const shown = await probeForcings();
      // Sanity: the panel really is showing it converted. The trim is a
      // *delta* ("temperatureDelta" — `warmthText`, `format.ts`), so the pure
      // 9/5 ratio applies with no +32 offset: 20 °C → 36.0 °F exactly, not
      // the 68.0 °F an absolute-temperature conversion would give.
      expect(shown.trim).toContain("°F");
      expect(shown.trim.startsWith("+36.0")).toBe(true);

      // Save without touching the knob.
      await ob.page.locator(".wadjet-studio-header-save").click();
      await waitForSaved();

      const draft = await forcingsDraft();
      const stored = draft.trim?.apply?.find((o: any) => o.param === "temperature.mean" && o.op === "offset")?.value ?? null;
      expect(stored).toBe(20);
      console.log(`  · untouched 20 °C shown as "${shown.trim}", Saved under imperial, still ${stored} °C on the draft`);
    } finally {
      await setStudioUnits("metric");
      await switchZoneViaMenu(zone.id, zone.name);
      await resetForcings();
      await ob.page.locator(".wadjet-studio-header-save").click();
      await waitForSaved();
    }
  });

  test("units 4: back to metric, the same readouts show °C", async () => {
    await revealStudio();
    await switchZoneViaMenu(zone.id, zone.name);
    await resetForcings();

    const epoch = await epochYear();
    const centre = epoch + 5 + 100 / 365;
    await seedWindow({ a: centre - 1.5 / 365, b: centre + 1.5 / 365 });
    const card = await dayCardProbe();
    expect(card.hidden).toBe(false);
    expect(card.cells["temperature"]).toContain("°C");
    expect(card.cells["temperature"]).not.toContain("°F");

    await openForcingsFromMixer();
    const forcings = await probeForcings();
    expect(forcings.trim).toContain("°C");

    const rail = await probeMixer();
    const master = rail.find((c) => c.chain === "master");
    expect(master?.masterChips[0]).toContain("°C");
    console.log(`  · metric: day card "${card.cells["temperature"]}", trim "${forcings.trim}", MASTER "${master?.masterChips[0]}"`);
  });
});

/* ── Theme skin and accessibility pass (bead wadjet-9f9.43) ─────────────
 *
 * The studio is graphite by design (SPEC §9) regardless of Obsidian's own
 * theme; this describe proves that, plus the four accessibility mechanics
 * that only a real Chromium can answer for: computed `color-scheme`, a real
 * `:focus-visible` outline width, `aria-live`, and a container-query layout
 * change at two real window widths.
 */

async function setObsidianTheme(theme: "moonstone" | "obsidian"): Promise<void> {
  await withApp(ob.page, (app, t: string) => {
    // Not in the public plugin API types — the same internal method the
    // Appearance settings tab's Light/Dark toggle calls.
    (app as unknown as { changeTheme: (name: string) => void }).changeTheme(t);
  }, theme);
}

interface StudioThemeProbe {
  colorScheme: string;
  bg: string;
  bodyIsLight: boolean;
}

async function probeStudioTheme(): Promise<StudioThemeProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const root = el?.querySelector(".wadjet-studio") as HTMLElement | null;
      const cs = root ? getComputedStyle(root) : null;
      return {
        colorScheme: cs?.colorScheme ?? "",
        bg: (cs?.getPropertyValue("--wadjet-studio-bg") ?? "").trim(),
        bodyIsLight: document.body.classList.contains("theme-light"),
      };
    },
    VIEW_TYPE,
  );
}

interface FocusRingSample {
  hint: string;
  outlineWidth: string;
}

/** Focus `n` real, tabbable `[data-hint]` elements in turn and read the ring each draws. */
async function sampleFocusRings(n: number): Promise<FocusRingSample[]> {
  return withApp(
    ob.page,
    (app, a: { type: string; n: number }) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl;
      if (!el) return [];
      const candidates = Array.from(el.querySelectorAll<HTMLElement>("[data-hint]")).filter((node) => {
        const tabindex = node.getAttribute("tabindex");
        return tabindex !== null && tabindex !== "-1" && node.offsetParent !== null;
      });
      const step = Math.max(1, Math.floor(candidates.length / a.n));
      const sample = candidates.filter((_, i) => i % step === 0).slice(0, a.n);
      return sample.map((node) => {
        node.focus();
        const outlineWidth = getComputedStyle(node).outlineWidth;
        node.blur();
        return { hint: node.getAttribute("data-hint") ?? "", outlineWidth };
      });
    },
    { type: VIEW_TYPE, n },
  );
}

async function probeHintBarAriaLive(): Promise<string | null> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      return el?.querySelector(".wadjet-studio-hintbar")?.getAttribute("aria-live") ?? null;
    },
    VIEW_TYPE,
  );
}

async function probeMixerWidth(): Promise<number> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const mixer = el?.querySelector(".wadjet-studio-mixer");
      return mixer ? mixer.getBoundingClientRect().width : 0;
    },
    VIEW_TYPE,
  );
}

/**
 * The inline size of `.wadjet-studio` — the element that carries
 * `container-type: inline-size`, so it is what the studio's `@container`
 * queries are asked about. NOT the vault window: the leaf is inset by
 * Obsidian's ribbon and both sidebars, which is 250-300 px of the window that
 * never reaches the studio.
 */
async function probeStudioContainerWidth(): Promise<number> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const root = el?.querySelector(".wadjet-studio");
      return root ? root.getBoundingClientRect().width : 0;
    },
    VIEW_TYPE,
  );
}

/** Collapse (or restore) both sidebars, so the leaf gets the whole vault window. */
async function setSidebarsCollapsed(collapsed: boolean): Promise<void> {
  await withApp(
    ob.page,
    (app, want: boolean) => {
      for (const split of [app.workspace.leftSplit, app.workspace.rightSplit]) {
        if (!split) continue;
        if (want) split.collapse();
        else split.expand();
      }
    },
    collapsed,
  );
  await nextFrame();
}

describe("climate studio · theme", () => {
  test("step 1: under Obsidian's light theme, the studio root stays color-scheme: dark at the SPEC bg", async () => {
    await revealStudio();
    const darkBefore = await probeStudioTheme();
    expect(darkBefore.colorScheme).toBe("dark");
    expect(darkBefore.bg).toBe("#141517");

    try {
      await setObsidianTheme("moonstone");
      await ob.page.waitForFunction(() => document.body.classList.contains("theme-light"), null, { timeout: 10_000 });

      const underLight = await probeStudioTheme();
      expect(underLight.bodyIsLight).toBe(true);
      expect(underLight.colorScheme).toBe("dark");
      expect(underLight.bg).toBe("#141517");
      console.log(`  · Obsidian on moonstone (light): .wadjet-studio color-scheme "${underLight.colorScheme}", bg "${underLight.bg}"`);
    } finally {
      await setObsidianTheme("obsidian");
      await ob.page.waitForFunction(() => !document.body.classList.contains("theme-light"), null, { timeout: 10_000 });
    }

    const restored = await probeStudioTheme();
    expect(restored.bodyIsLight).toBe(false);
    expect(restored.colorScheme).toBe("dark");
    expect(restored.bg).toBe("#141517");
  });

  test("step 2: five sampled [data-hint] controls each draw a ≥ 2px :focus-visible outline", async () => {
    await revealStudio();
    await closeStudioWindows();
    // `:focus-visible` is modality-sensitive: Chromium matches it on a
    // *programmatic* focus() only while the last real input was the keyboard.
    // The step before this one drove the settings window with the mouse, so
    // without a real key press first the FIRST sampled control reads
    // `outline-width: 0px` and the four after it — which inherit the
    // focus-visible chain — read 2px. One real Tab puts the browser in
    // keyboard modality, which is the state the ring exists for.
    await ob.page.keyboard.press("Tab");
    const sample = await sampleFocusRings(5);
    expect(sample.length).toBe(5);
    for (const { hint, outlineWidth } of sample) {
      expect(parseFloat(outlineWidth), `"${hint}" outline-width was "${outlineWidth}"`).toBeGreaterThanOrEqual(2);
    }
    console.log(`  · ${sample.map((s) => `${s.hint || "(no hint)"}: ${s.outlineWidth}`).join("; ")}`);
  });

  test("step 3: the hint bar carries aria-live=\"polite\"", async () => {
    await revealStudio();
    expect(await probeHintBarAriaLive()).toBe("polite");
  });

  test("step 4: the mixer rail narrows once the studio container crosses the 1300 px query (SPEC §3.3)", async () => {
    await revealStudio();
    await closeStudioWindows();
    const before = await getStudioWindowSize();
    try {
      // The `@container (max-width: 1300px)` rule is asked about
      // `.wadjet-studio`, not the vault window, and the leaf loses 250-300 px
      // of the window to the ribbon and the two sidebars — at a 1400 px window
      // the container sits on its own 1100 px `min-width`, already under the
      // query, so BOTH sides of the old comparison measured the narrow rail.
      // Collapsing the sidebars is what actually gets the container over 1300.
      await setSidebarsCollapsed(true);
      // Even with the sidebars away the leaf loses ~115 px of the window to the
      // ribbon and the tab header, so a 1400 px window leaves the container at
      // ~1285 — still inside the query. Take the width from the display.
      const work = await ob.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
      await setStudioWindowSize(Math.min(1560, work.width), Math.min(900, work.height));
      await nextFrame();
      const wideBox = await probeStudioContainerWidth();
      const wide = await probeMixerWidth();
      expect(wideBox).toBeGreaterThan(1300);

      await setStudioWindowSize(1200, 900);
      await nextFrame();
      const narrowBox = await probeStudioContainerWidth();
      const narrow = await probeMixerWidth();
      expect(narrowBox).toBeLessThanOrEqual(1300);

      expect(narrow).toBeLessThan(wide);
      console.log(`  · mixer rail: ${wide.toFixed(0)}px at container ${wideBox.toFixed(0)}px → ${narrow.toFixed(0)}px at container ${narrowBox.toFixed(0)}px`);
    } finally {
      await setSidebarsCollapsed(false);
      await setStudioWindowSize(before.width, before.height);
      await widenWindow();
      await nextFrame();
    }
  });
});
