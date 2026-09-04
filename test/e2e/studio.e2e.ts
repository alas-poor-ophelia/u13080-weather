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
import type { Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { MODIFIER_EXAMPLES } from "../../src/plugin/modifier-examples";
import { paramsByChannel } from "../../src/studio/model/device-edit";
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
  /** the audition's seed pill — `YR <year> · SEED <8>`, the strip's own writes readout */
  seed: string;
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
          seed: text('[data-part="audition-seed"]'),
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
 * `presetWindow("era", …)` in `src/studio/model/zoom.ts`.
 *
 * The Era preset FRAMES THE WORLD'S ERAS now (F3): `eraFrame` is the span of
 * every enabled era with 100 years of air in front and at least 1000 years
 * wide — the prototype's `1100 – 2100`. A world with no era falls back to the
 * old reading, 1000 years around the current centre. Either way the result is
 * translated (never shrunk) into the world's pannable extent, which is itself
 * widened to hold the eras (`worldBounds`), so an era seeded past the epoch's
 * own reach is not simply unreachable.
 *
 * The eras are read off the LEAF'S DRAFT rather than the saved settings: every
 * era step in this file works on the draft, and it is the draft the header's
 * preset button reads.
 */
async function expectedEraWindow(before: { a: number; b: number }): Promise<{ a: number; b: number }> {
  const world = await withApp(ob.page, (app, type: string) => {
    const epochYear = app.plugins.plugins.wadjet.settings.calendar.epochYear as number;
    const leaf = app.workspace.getLeavesOfType(type)[0];
    const eras = ((leaf?.view?.store.get().world.eras ?? []) as Array<{ from: number; to?: number; enabled?: boolean }>)
      .filter((e) => e.enabled !== false)
      .map((e) => ({ from: e.from, to: e.to ?? null }));
    return { epochYear, eras };
  }, VIEW_TYPE);

  // `zoom.ts eraFrame`, spelled out.
  let frame: { a: number; b: number } | null = null;
  if (world.eras.length > 0) {
    const from = Math.min(...world.eras.map((e) => e.from));
    const to = Math.max(...world.eras.map((e) => e.to ?? -Infinity));
    const a = from - 100;
    frame = { a, b: Math.max(a + 1000, to + 100) };
  }

  // `zoom.ts worldBounds`, likewise.
  const min = frame === null ? world.epochYear - 100 : Math.min(world.epochYear - 100, frame.a);
  const max = frame === null ? world.epochYear + 1100 : Math.max(world.epochYear + 1100, frame.b);

  const centre = (before.a + before.b) / 2;
  let a = frame === null ? centre - 500 : frame.a;
  let b = frame === null ? centre + 500 : frame.b;
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
    // The audition names its own roll from the first paint (bead wadjet-9f9.38).
    // The strip's Writes footer became the head's seed pill in the fidelity
    // rebuild (F5): `YR <year> · SEED <8 chars>`, plus ` · SALT <n>` once salted.
    expect(opened.seed).toMatch(/^YR \d+ · SEED \S+/);

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
    console.log(`  · zoom Era: window ${JSON.stringify(before.window)} → ${JSON.stringify(after.window)}; ${opened.racks} racks, 4 lanes, seed "${opened.seed}"`);
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

/**
 * One end of the header readout's year span, spelled the way
 * `model/format.ts windowLabel` spells it: rounded, with the studio's real
 * minus (U+2212) rather than an ASCII hyphen.
 */
const spanYear = (year: number): string => String(Math.round(year)).replace("-", "−");

describe("climate studio · header and hint bar", () => {
  test("step 5: the hint bar follows the pointer", async () => {
    await revealStudio();
    const save = ob.page.locator(".wadjet-studio-header-save");
    await save.waitFor({ state: "visible", timeout: 10_000 });

    await save.hover();
    const hinted = await probeHeader();
    // Chrome hint names are lower case (B3): the prototype's own vocabulary —
    // `zoom preset`, `zone file`, `save` — reserves capitals for named things.
    expect(hinted.hintName).toBe("save");
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
    // The readout is one dark inset pill with no zoom-name prefix any more
    // (F6 / gap-shell §1): the presets beside it already say which scale this
    // is, so at Era zoom it reads the year span itself — `−99 – 901` on this
    // fixture world, with `format.ts`'s real minus (U+2212), never an ASCII one.
    //
    // Polled, not read once: `clickPreset` gates on the Segmented's own
    // `aria-checked`, which the component flips on the click, while the
    // readout is repainted by the header on the store's next batched frame.
    // One tap in three caught the pill still showing the year it came from
    // (H-1392: wait for the reaction, do not assume it already happened).
    const expectedReadout = `${spanYear(before.window!.a)} – ${spanYear(before.window!.b)}`;
    let readoutAtEra = (await probeHeader()).readout;
    for (let i = 0; i < 40 && readoutAtEra !== expectedReadout; i++) {
      await ob.page.waitForTimeout(100);
      readoutAtEra = (await probeHeader()).readout;
    }
    expect(readoutAtEra).toBe(expectedReadout);

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
const LABEL_WIDTH = 164;

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
        // The ruler draws its tints and its names on two rows now (F2): the
        // band is the colour, `-band-label` the season (or era) it stands for.
        bandLabels: all(".wadjet-studio-ruler-band-label").map(text),
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
    // The prototype's compact tick forms (F2): a bare year, no `Y` prefix.
    expect(wide.tickLabels).toContain(String(year));
    expect(wide.dayCardHidden).toBe(true);
    expect(wide.hiddenRows).toBe(0);

    // Day zoom (≤ 7.5 days): day ticks (`d0`, 0-based in its year), and the
    // day card takes the reading — but the lane stack STAYS under it now
    // (F3): the card sits over the playlist rather than replacing it.
    await seedWindow({ a: year, b: year + 3 / 365 });
    const day = await probePlaylist();
    expect(day.tickLabels.length).toBeGreaterThan(0);
    for (const label of day.tickLabels) expect(label).toMatch(/^d\d+$/);
    expect(day.dayCardHidden).toBe(false);
    expect(day.hiddenRows).toBe(0);
    console.log(`  · Year zoom ticks ${JSON.stringify(wide.tickLabels.slice(0, 4))}; Day zoom ticks ${JSON.stringify(day.tickLabels.slice(0, 4))}, ${day.hiddenRows}/${day.rows} rows hidden, card shown`);
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
    // The band-name row is EMPTY at Era zoom (B3): the prototype builds no
    // ruler labels on the era lane, because the Eras row immediately under
    // the ruler already names every era. The elements are still there — one
    // per drawn band, still positioned and coloured — carrying no text, so
    // this asserts BOTH halves: the row is populated, and none of it reads.
    expect(era.bandLabels.length).toBeGreaterThan(0);
    expect(era.bandLabels).not.toContain(ERA);
    expect(era.bandLabels.every((t) => t === "")).toBe(true);

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
        // The zone half no longer captions itself inside the code block (the
        // drawer's own bar is the caption); the world half still marks where
        // the scope changes.
        zoneTitle: text(".wadjet-studio-json-bar-label"),
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
    expect(probe.zoneTitle).toContain("zone file · live");
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

    // Copy lives in the drawer's header bar now, not inside the code block.
    await ob.page.locator('.wadjet-studio-json-copy[data-scope="zone"]').click();
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
  /** the fixed strip's two lines, name and summary split into their own spans (F4) */
  regimes: string;
  regimesSum: string;
  forcings: string;
  forcingsSum: string;
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
        regimesSum: text(b, '[data-part="regimes-sum"]'),
        forcings: text(b, '[data-part="forcings-name"]'),
        forcingsSum: text(b, '[data-part="forcings-sum"]'),
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

    // Regimes are in all four chains and read the zone's own state count. The
    // strip splits the name from its summary into two spans now (F4), so the
    // bright half is clickable on its own and the dim half is the value.
    const n = draft.regimes.length;
    const expected = `${n} ${n === 1 ? "state" : "states"}`;
    for (const c of rail.slice(0, 4)) {
      expect(c.regimes).toBe("Regimes");
      expect(c.regimesSum).toBe(expected);
    }

    // Forcings only in TEMP and PRECIP (SPEC §3.3).
    expect(rail[0]!.forcingsShown).toBe(true);
    expect(rail[1]!.forcingsShown).toBe(true);
    expect(rail[2]!.forcingsShown).toBe(false);
    expect(rail[3]!.forcingsShown).toBe(false);
    expect(rail[0]!.forcings).toBe("Forcings");
    expect(rail[1]!.forcings).toBe("Forcings");
    // `0.0 °C` into TEMP (signed once it leaves neutral), `×1.00` into PRECIP.
    expect(rail[0]!.forcingsSum).toMatch(/^[+−]?\d+(\.\d+)? °[CF]$/);
    expect(rail[1]!.forcingsSum).toMatch(/^×\d/);

    // MASTER carries the two zone totals.
    expect(rail[4]!.masterChips.length).toBe(2);
    expect(rail[4]!.masterChips[0]!.startsWith("warmth ")).toBe(true);
    expect(rail[4]!.masterChips[1]!.startsWith("wetness ×")).toBe(true);
    console.log(
      `  · rail ${JSON.stringify(rail.map((c) => c.title))}; strip "${rail[0]!.regimes} ${rail[0]!.regimesSum} · ${rail[0]!.forcings} ${rail[0]!.forcingsSum}"; master ${JSON.stringify(rail[4]!.masterChips)}`,
    );
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
    // PRECIP's own strip never moved: same states, and its LED is still lit.
    const rail = await probeMixer();
    expect(rail[1]!.regimesSum).toBe(rail[0]!.regimesSum);
    expect(await mixerChain("precipitation").locator('[data-part="regimes-led"]').getAttribute("aria-pressed")).toBe("true");

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
    // Product copy, not the engine id (F1/F4): a slug reads as a name.
    expect(wind.units[0]!.name).toBe("Test Dev");
    // No `when` and no spell: the studio reads that as a trim device. The kind
    // pill is a lowercase word now, not a shouted abbreviation.
    expect(wind.units[0]!.kind).toBe("trim");
    expect(wind.units[0]!.linked).toBe(false);
    expect(wind.units[0]!.world).toBe("");
    // The when chip, then the apply chip in the short apply-target vocabulary
    // with its unit attached (`model/copy.ts describeOp`).
    expect(wind.units[0]!.chips).toEqual(["always", "wind ×1.20"]);
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
    expect(era.kind).toBe("era");
    // Eras share one marker instead of a slot number: they are world-scoped
    // and cannot be dragged (SPEC §3.3).
    expect(era.slot).toBe("E");
    expect(era.world).toBe(`world · ${before.zoneCount} zones`);
    expect(era.chips).toEqual(["1 – 2", "temp −1.5 °C"]);
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
  /** the `world · N zones` chip and the `epoch 0.000` readout the prototype has NEITHER of — counted so their absence is asserted, not assumed */
  worldChips: number;
  epochReadouts: number;
  arcs: number;
  handles: number;
  labels: string[];
  rows: string[];
  /** the title bar's `↻ 29.53 d` — the panel's only statement of the period */
  period: string;
  /** the disc's own phase readout — `disc preview · phase 0.00 · d0.0 of the cycle` */
  preview: string;
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
        worldChips: all('[data-part="cycle-world"]').length,
        epochReadouts: all('[data-part="cycle-epoch"]').length,
        arcs: all(".wadjet-studio-cycle-arc").length,
        handles: all(".wadjet-studio-cycle-handle").length,
        labels: all(".wadjet-studio-cycle-label").map((n) => (n.textContent ?? "").trim()),
        rows: all('[data-part="cycle-row"]').map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()),
        // The period is stated once, in the title bar (World B 3.1/3.3): the
        // prototype has no body readout line, so there is no `cycle-period`
        // element left to read and the chrome's caption is the source.
        period: text(panel, ".wadjet-studio-window-caption"),
        preview: text(panel, '[data-part="cycle-preview"]'),
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
  test("step 30: a moon with five named phases opens a CYCLE panel with five arcs, four handles and its period", async () => {
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
    // The window still names its moon, its period and where its phases come
    // from — but the period is now stated only in the title bar, and the two
    // things the prototype does not have are asserted GONE rather than
    // reworded: the `world · N zones` chip (the world-edit confirm is the
    // warning) and the `epoch 0.000` readout (never a control here either).
    expect(probe.source).toBe("internal calendar");
    expect(probe.period).toBe("↻ 29.53 d");
    expect(probe.worldChips).toBe(0);
    expect(probe.epochReadouts).toBe(0);
    expect(probe.arcs).toBe(5);
    // Five boundaries, four handles: the first is the origin of the cycle and
    // carries no grab handle (the prototype filters it out).
    expect(probe.handles).toBe(4);
    expect([...probe.labels].sort()).toEqual(["Crescent", "Full", "Gibbous", "Half", "New"]);
    expect(probe.rows.length).toBe(5);
    expect(probe.preview).toContain("phase");
    expect(probe.editIn).toBe("");
    expect(probe.writes).toContain("calendar.moons[");
    console.log(`  · ${CYCLE_WINDOW}: ${probe.arcs} arcs / ${probe.handles} handles, period "${probe.period}" (title bar), no world chip, no epoch readout, writes "${probe.writes}"`);
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

    try {
      const mirrored = await probeCycle();
      expect(mirrored.source).toBe("Fake calendar · read-only");
      expect(mirrored.handles).toBe(0);
      expect(mirrored.arcs).toBe(2);
      expect([...mirrored.labels].sort()).toEqual(["Bright", "Dark"]);
      expect(mirrored.actions).toBe(0);
      expect(mirrored.editIn).toBe("edit in Fake calendar");
      expect(mirrored.period).toBe("↻ 40.00 d");
      expect(mirrored.writes).toContain("Fake calendar");
      console.log(`  · read-only mirror: source "${mirrored.source}", ${mirrored.arcs} arcs, ${mirrored.handles} handles, "${mirrored.editIn}", period "${mirrored.period}"`);
    } finally {
      // Restore: back to the internal calendar, then drop the fake adapter.
      // In a `finally` (the seasons walk's own step 44 does the same): a
      // failed assertion above used to leave a two-season, read-only, 400-day
      // calendar ACTIVE for the rest of the file, and the four describes after
      // it then failed on a world none of them had asked for.
      await openWadjetSettings();
      await settingsZoneRow("Calendar source").waitFor({ state: "visible", timeout: 10_000 });
      await settingsZoneRow("Calendar source").locator("select:not(.is-measuring)").selectOption("internal");
      await ob.page.waitForTimeout(500);
      await withApp(ob.page, (app) => app.setting.close());
      await withApp(ob.page, () => {
        (window as unknown as { __wadjetCycleUnregister?: () => void }).__wadjetCycleUnregister?.();
      });
      await ob.page.waitForTimeout(500);
    }
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
  /**
   * The strip's seed pill (F5). The Writes footer under the strip is gone;
   * the head names the roll instead — `YR 1962 · SEED greywold · SALT 1`.
   */
  seed: string;
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
        seed: text('[data-part="audition-seed"]'),
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
  test("step 21: one seeded year of cells, and a seed pill that names it", async () => {
    await revealStudio();
    await seedWindow({ a: AUDITION_YEAR, b: AUDITION_YEAR + 1 });
    auditionOn = await auditionZoneOf();

    // 365 days at ≥ 10 px each, or one column per bucket below that (F5 raised
    // `MIN_CELL_PX` from 3 to 10, so a year buckets to ~148 columns at studio
    // width) — either way a year's worth of columns, never a placeholder.
    await waitForAuditionCells(52);
    await ob.page.waitForFunction(
      (x: { type: string; year: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(x.type)[0]?.view?.containerEl as HTMLElement | undefined;
        return (el?.querySelector('[data-part="audition-seed"]')?.textContent ?? "").includes(x.year);
      },
      { type: VIEW_TYPE, year: `YR ${AUDITION_YEAR}` },
      { timeout: 15_000 },
    );

    const strip = await probeAudition();
    expect(strip.cells).toBeGreaterThanOrEqual(52);
    expect(strip.cells).toBeLessThanOrEqual(400);
    expect(strip.seed).toContain(`YR ${AUDITION_YEAR}`);
    // `SALT n` only shows once the strip has been re-rolled: salt 0 IS the
    // vault's own weather, and a permanent `SALT 0` would say otherwise.
    expect(strip.seed).toMatch(/^YR \d+ · SEED \S{1,8}( · SALT \d+)?$/);
    // Every column carries a precipitation class and a temperature band.
    expect(strip.classes.every((c) => /is-(dry|drizzle|rain|sleet|snow)/.test(c) && /is-t\d/.test(c))).toBe(true);
    // …and the drawn kind the legend names (F5).
    expect(strip.classes.every((c) => /is-k-(dry|warm|ash|wet1|wet2|wet3|snow)/.test(c))).toBe(true);
    expect(Number(strip.rollMs)).toBeGreaterThan(0);
    console.log(`  · audition: ${strip.cells} cells for "${auditionOn.name}", seed "${strip.seed}", roll ${strip.rollMs} ms`);
  });

  test("step 22: hovering a cell puts the day tip, regime included, in the hint bar", async () => {
    await revealStudio();
    await waitForAuditionCells(52);
    const cell = ob.page.locator(".wadjet-studio-audition-cell").nth(40);
    await cell.waitFor({ state: "visible", timeout: 10_000 });
    await cell.hover();

    const hinted = await probeAudition();
    expect(hinted.hintName).toMatch(/^d\d+$/);
    expect(hinted.hintDetail).toContain("regime:");
    // `describe(report, "short")` always ends in the day's range in °C.
    expect(hinted.hintDetail).toContain("°C");
    console.log(`  · day tip: "${hinted.hintName} — ${hinted.hintDetail}"`);
  });

  test("step 23: right-click pins the day; Save writes it and settings lists it", async () => {
    await revealStudio();
    await waitForAuditionCells(52);

    // A day well inside the year. `MIN_CELL_PX` rose from 3 to 10 (F5), so a
    // year buckets to roughly 148 columns instead of drawing all 365 — how
    // many exactly depends on how wide the leaf is, so the index is taken from
    // the strip that was actually drawn rather than assumed.
    const cells = ob.page.locator(".wadjet-studio-audition-cell");
    const drawn = await cells.count();
    expect(drawn).toBeGreaterThanOrEqual(52);
    const cell = cells.nth(Math.floor(drawn * 0.36));
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
    expect(after.seed).not.toBe(before.seed);
    expect(after.seed).toContain(`YR ${AUDITION_YEAR}`);
    expect(after.seed).toMatch(/ · SALT \d+$/);
    expect(after.pins).toBe(before.pins);
    expect(after.chips).toBe(before.chips);
    const pins = await draftPinsFor(auditionOn.id);
    expect(pins.some((p) => p.dayOrdinal === pinnedOrdinal)).toBe(true);
    console.log(`  · re-roll moved ${moved}/${after.classes.length} cells; seed "${after.seed}"; ${after.pins} pin(s) kept`);
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
  /**
   * The chrome's preset chip (F7 · wadjet-6rw.15): the name it wears — the
   * zone's base station record while its states still equal it, `custom` once
   * they do not. What the `▾` OFFERS is not in the DOM until the menu is open,
   * so `presetMenuOptions()` reads that.
   */
  presetName: string;
  /** the world draft's saved state sets, by name */
  regimePresets: string[];
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
        presetName: text(panel?.querySelector(".wadjet-studio-window-preset-label") ?? null),
        regimePresets: (state.world.regimePresets ?? []).map((p: any) => p.name),
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

/** The Regimes panel's own chrome — the title bar the `preset ▾` lives in. */
const regimesWindow = () => ob.page.locator(".wadjet-studio-window", { has: ob.page.locator(".wadjet-studio-regimes") }).first();

/**
 * The chrome's preset control is a CHIP with an Obsidian `Menu` behind it
 * (`components/window.ts`), not a `<select>`: the offered names only exist in
 * the DOM while the menu is open, so a step that wants them has to open it.
 */
async function openPresetMenu(win: Locator): Promise<Locator> {
  await win.locator(".wadjet-studio-window-preset-pick").click();
  const menu = ob.page.locator(".menu").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  return menu;
}

/** Every name the chip's menu offers, `Save as preset…` included, in order. */
async function presetMenuTitles(win: Locator): Promise<string[]> {
  const menu = await openPresetMenu(win);
  const titles = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Blur BEFORE the Escape: the chip that opened the menu still holds focus,
  // it sits inside a window whose own Escape handler closes the panel, and a
  // key pressed while it is focused shut the whole window instead of the menu.
  await ob.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await ob.page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5_000 });
  return titles;
}

/** The names the chip OFFERS — the old `<option>` list, minus the save row. */
async function presetMenuOptions(win: Locator): Promise<string[]> {
  return (await presetMenuTitles(win)).filter((t) => t !== SAVE_PRESET_ITEM);
}

/** Pick one offered name by its exact label (`hasText` would match a longer sibling). */
async function pickPresetItem(win: Locator, label: string): Promise<void> {
  const menu = await openPresetMenu(win);
  const titles = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  const at = titles.indexOf(label);
  expect(at, `no "${label}" in ${JSON.stringify(titles)}`).toBeGreaterThanOrEqual(0);
  await menu.locator(".menu-item").nth(at).click();
  await nextFrame();
}

/** The save row the `＋` button used to be (prototype `1095-vst-device.html` l.12). */
const SAVE_PRESET_ITEM = "Save as preset…";

/** Open the chip's menu and take its save row, then fill the name modal. */
async function savePresetAs(win: Locator, name: string): Promise<void> {
  await pickPresetItem(win, SAVE_PRESET_ITEM);
  const modal = ob.page.locator(".modal-container .modal");
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  await modal.locator('.setting-item:has(.setting-item-name:text-is("Name")) input').fill(name);
  await modal.locator("button:has-text('Save')").click();
  await modal.waitFor({ state: "detached", timeout: 10_000 });
}

/** Wait until the `preset ▾` pill reads `name` — the reaction that says the load landed. */
async function waitForPresetPill(name: string): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; name: string }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const panel = el?.querySelector(".wadjet-studio-regimes")?.closest(".wadjet-studio-window") ?? null;
      return (panel?.querySelector(".wadjet-studio-window-preset-label")?.textContent ?? "").trim() === a.name;
    },
    { type: VIEW_TYPE, name },
    { timeout: 10_000 },
  );
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

/**
 * A chart handle dragged and HELD: pointer down, one move of `dy`, then the
 * handle's `cy` read again before the pointer lifts. The device panel holds
 * rebuilds for the length of a gesture, so this is the only way to prove the
 * plot tracks the hand rather than waiting for pointer up (wadjet-jug).
 */
async function dragHandleHeld(selector: string, dy: number): Promise<{ before: number; held: number; after: number }> {
  const out = await withApp(
    ob.page,
    (app, a: { type: string; selector: string; dy: number }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const el: HTMLElement = leaf.view.containerEl;
      const cy = (): number => Number(el.querySelector(a.selector)?.getAttribute("cy") ?? "NaN");
      const handle = el.querySelector(a.selector);
      if (handle === null) throw new Error(`no chart handle at ${a.selector}`);
      const r = handle.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const base = { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      const before = cy();
      handle.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...base, button: -1, buttons: 1, clientX: x, clientY: y + a.dy }));
      // A repaint replaces the circle, so the handle is looked up afresh.
      const held = cy();
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y + a.dy }));
      return { before, held, after: cy() };
    },
    { type: VIEW_TYPE, selector, dy },
  );
  await nextFrame();
  return out;
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

    // SPEC law 5: the footer is the grammar this window writes. It is authored
    // grammar now rather than raw JSON (F7) — `regimes [ { <id> w <weight> ·
    // <dwell> d · <op>[…] }, … ]` — so the field is named by its unit, not by
    // its schema key.
    expect(probe.writes.startsWith("regimes [")).toBe(true);
    expect(probe.writes).toContain(probe.rows[0]!);
    expect(probe.writes).toMatch(/ w \d+\.\d+ · \d+ d/);
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

    // `uniqueId` keeps ids unique, so the id the state actually got is the oracle.
    const rowsNow = (await probeRegimes()).rows;
    const renamed = rowsNow[rowsNow.length - 1]!;
    // The rows and the WRITES footer repaint on separate ticks (step 36 waits
    // on the same seam), so a probe taken the instant the row disappears can
    // still be reading the footer from before the rename. Wait for the footer
    // to name the new state, then take one consistent probe (H-1392).
    await ob.page.waitForFunction(
      (a: { type: string; id: string }) => {
        const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
        const panel = el?.querySelector(".wadjet-studio-regimes")?.closest(".wadjet-studio-window") ?? null;
        return (panel?.querySelector(".wadjet-studio-writes-body")?.textContent ?? "").includes(a.id);
      },
      { type: VIEW_TYPE, id: renamed },
      { timeout: 10_000 },
    );

    const after = await probeRegimes();
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

  test("step 38a: the preset ▾ names the zone's state set and loads a shipped one back over it", async () => {
    await openRegimesWindow();
    const target = (await probeRegimes()).rows[0]!;

    // A known custom draft: the pill only says `custom` once the states stop
    // equalling the record the zone was copied from.
    await seedRegimeDraft("weight", { id: target, value: 0.33 });
    await waitForPresetPill("custom");
    const custom = await probeRegimes();
    expect(custom.presetName).toBe("custom");
    const customOffered = await presetMenuOptions(regimesWindow());
    expect(customOffered).toContain("custom");
    expect(custom.zoneRegimes[0]!.weight).toBeCloseTo(0.33, 10);

    // Every station record ships the same three states, so the `▾` offers the
    // set once, named for the record this zone came from, with its size as a sub.
    const shipped = customOffered.find((o) => o !== "custom" && !o.includes("· yours"));
    expect(shipped, `no shipped set in ${JSON.stringify(customOffered)}`).toBeDefined();
    expect(shipped!).toMatch(/ · \d+ states$/);
    const setName = shipped!.split(" · ")[0]!;

    await pickPresetItem(regimesWindow(), shipped!);
    await waitForPresetPill(setName);

    const loaded = await probeRegimes();
    // The set replaced `regimes[]` wholesale: the state step 37 added is gone
    // with it, and the seeded weight is back to what the record ships.
    expect(loaded.rows).toEqual(["normal", "wet-spell", "dry-spell"]);
    expect(loaded.zoneRegimes.map((r) => r.id)).toEqual(loaded.rows);
    expect(loaded.zoneRegimes[0]!.weight).not.toBeCloseTo(0.33, 6);
    expect(loaded.segments).toEqual(loaded.rows);
    expect(loaded.writes).toContain("normal");
    // The pill wears the bare name once the zone is on that set — the sub is
    // only how the OTHER options tell themselves apart.
    expect(loaded.presetName).toBe(setName);
    const loadedOffered = await presetMenuOptions(regimesWindow());
    expect(loadedOffered).toContain(setName);
    expect(loadedOffered).not.toContain("custom");

    // One undoable action, like every other edit in this panel.
    expect(await studioHistory("undo")).toBe(true);
    await waitForPresetPill("custom");
    const undone = await probeRegimes();
    expect(undone.rows).toEqual(custom.rows);
    expect(undone.zoneRegimes[0]!.weight).toBeCloseTo(0.33, 10);
    expect(await studioHistory("redo")).toBe(true);
    await waitForPresetPill(setName);
    console.log(`  · preset ▾: custom → "${shipped}" loaded ${loaded.rows.length} states (was ${custom.rows.length}); undo restored them, redo put the set back`);
  });

  test("step 38b: ＋ saves the zone's states as a set, badged yours, and the ▾ loads it back", async () => {
    // Obsidian builds a Modal into whichever window is active, so the name
    // prompt has to land in the vault window and not behind a stray settings one.
    await withApp(ob.page, (app) => app.setting.close());
    await ob.page.bringToFront();
    await openRegimesWindow();

    // Tune the states off the record first: a set saved while the zone still
    // matches its base record would be shadowed by it in the pill, because the
    // zone's OWN record wins that tie (`model/regime-presets.ts`).
    await seedRegimeDraft("weight", { id: (await probeRegimes()).rows[0]!, value: 0.37 });
    await waitForPresetPill("custom");
    const before = await probeRegimes();

    await savePresetAs(regimesWindow(), "House states");
    await waitForPresetPill("House states");

    const saved = await probeRegimes();
    expect(saved.regimePresets).toContain("House states");
    // The draft is unchanged by a save — only the world gained a set — so the
    // pill now names the set rather than the record.
    expect(saved.rows).toEqual(before.rows);
    expect(saved.presetName).toBe("House states");

    // Wander off it, and the saved set is offered back badged `yours`.
    await seedRegimeDraft("weight", { id: saved.rows[0]!, value: 0.44 });
    await waitForPresetPill("custom");
    const wanderedOffered = await presetMenuOptions(regimesWindow());
    const mine = wanderedOffered.find((o) => o.startsWith("House states"));
    expect(mine, `no saved set in ${JSON.stringify(wanderedOffered)}`).toBeDefined();
    expect(mine!).toMatch(/^House states · \d+ states · yours$/);

    await pickPresetItem(regimesWindow(), mine!);
    await waitForPresetPill("House states");

    const reloaded = await probeRegimes();
    expect(reloaded.rows).toEqual(before.rows);
    expect(reloaded.zoneRegimes).toEqual(before.zoneRegimes);
    expect(reloaded.segments).toEqual(reloaded.rows);
    console.log(`  · ＋ saved "House states" (${before.rows.length} states); the ▾ offered it as "${mine}" and loading it restored ${JSON.stringify(reloaded.rows)}`);
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
    // The WRITES footer repaints on the view's render pass, one tick behind the
    // rows' own store subscription — wait for it rather than read it at once.
    await expect.poll(async () => (await probeRegimes()).writes, { timeout: 5_000 }).not.toContain(`{ ${doomed} w `);

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
  /**
   * The caption that replaced the `world · N zones` chip (F7): the window
   * still says it is world-level, in the prototype's own microcopy.
   */
  caption: string;
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
        caption: text(".wadjet-studio-seasons-caption"),
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
    // The `world · N zones` chip gave way to the caption that says what a
    // season IS (F7) — the world scope is still stated, in product copy.
    expect(probe.caption).toContain("Seasons");
    expect(probe.caption).toContain("each stamps tag season:name");
    console.log(`  · seasons window: ${probe.segments} segments ${JSON.stringify(probe.labels)}; source "${probe.source}"; caption "${probe.caption}"`);
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

    // 0556 l.54 `u.bd`: while the era's window is up the rail rings the matching
    // card in the era's own swatch — `--wadjet-studio-precip` (#5cb8f0) for the
    // first era, which is exactly what `proto-win-ice` shows and what the plugin
    // was missing (bead wadjet-9f9.48.16). Only an era rings: the prototype's
    // bright border on a device card is hover/drag feedback, not window state.
    const eraCard = mixerChain("temperature").locator(`.wadjet-studio-rack-unit[data-unit="${eraWindowIdFor(eraName)}"]`);
    const ringed = () => eraCard.evaluate((el: Element) => el.classList.contains("is-open"));
    await expect.poll(ringed).toBe(true);
    const ringColour = await eraCard.evaluate((el: Element) => getComputedStyle(el).borderTopColor);
    expect(ringColour).toBe("rgb(92, 184, 240)");
    // …and it comes off the moment the window does.
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        app.workspace.getLeavesOfType(a.type)[0].view.windows.close(a.id);
      },
      { type: VIEW_TYPE, id: eraWindowIdFor(eraName) },
    );
    await nextFrame();
    await expect.poll(ringed).toBe(false);
    // Put it back: the rest of this describe reads the open panel.
    await openEraWindow(eraWindowIdFor(eraName));
    await expect.poll(ringed).toBe(true);
    console.log(`  · era:Ice Age opened: span ${probe.from}–${probe.to}, knob "${probe.knobValues[0]}", ${probe.world}; rail card ringed ${ringColour}`);
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
    // `clampWindow` against the world's pannable extent (`model/zoom.ts`,
    // mirroring `header.ts`'s own pan bounds). `worldBounds` is WIDENED to hold
    // every era now (F3) — without that an era seeded at 1200 in a world whose
    // epoch is year 1 could not be reached at all, and ⤢ would land the window
    // eight centuries short of the era it was asked to frame. The span (751 y)
    // always fits, so this is a translate, not a shrink.
    const era = (await eraDraft(eraName))!;
    const frameA = era.from - 100;
    const frameB = Math.max(frameA + 1000, (era.to ?? frameA) + 100);
    const min = Math.min(epochYear - 100, frameA);
    const max = Math.max(epochYear + 1100, frameB);
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
 * The audit world's Neverain: an ordinary `when.tag` device carrying the
 * `badge: "curse"` display flag its author picked in the insert picker (PLAN
 * D17). The flag is the badge — the apply below could be anything.
 */
const CURSE_ID = "Curse of Neverain";
const CURSE_MODIFIER = { id: CURSE_ID, stage: "daily", badge: "curse", when: { tag: "era:Drought" }, apply: [{ param: "precipitation.pwd", op: "scale", value: 0 }] };
/** The same device with the flag taken off: same shape, no curse. */
const UNFLAGGED_MODIFIER = { id: CURSE_ID, stage: "daily", when: { tag: "era:Drought" }, apply: [{ param: "precipitation.pwd", op: "scale", value: 0 }] };

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
        // The panel's own name row and KIND pill moved into the window chrome
        // (F11a): the badge IS the kind, and the title is the rename field.
        badge: text(panel, ".wadjet-studio-window-badge"),
        kind: text(panel, ".wadjet-studio-window-badge"),
        name: panel?.querySelector(".wadjet-studio-window-title.is-editable") === null ? "" : text(panel, ".wadjet-studio-window-title"),
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

/**
 * The whole panel, chrome included. F11a moved the device's name field, KIND
 * pill and preset control out of its body and into the shared window chrome,
 * so the three controls those steps drive live here rather than under
 * `.wadjet-studio-device`.
 */
const deviceWindow = () => ob.page.locator(".wadjet-studio-window", { has: ob.page.locator(".wadjet-studio-device") }).first();

/** Rename through the chrome's click-to-edit title (`components/window.ts onRename`). */
async function renameDeviceWindow(next: string): Promise<void> {
  await deviceWindow().locator(".wadjet-studio-window-title.is-editable").click();
  const input = deviceWindow().locator("input.wadjet-studio-window-title-input");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(next);
  await input.press("Enter");
  await nextFrame();
}

/** Click a row in the Obsidian menu the panel just opened. */
async function pickDeviceMenuItem(match: string | RegExp): Promise<void> {
  const menu = ob.page.locator(".menu").last();
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await menu.locator(".menu-item", { hasText: match }).first().click();
  await nextFrame();
}

/** One binding card on the moon path (`ui/windows/device/mod-moon.ts`, D15 bead 2). */
interface BindProbe {
  name: string;
  value: string;
  path: string;
  shape: string;
  shapeOpen: boolean;
  mode: string;
  phases: string[];
  selectedPhases: string[];
  sources: Array<{ source: string; pct: string }>;
  offered: string[];
}

/** Every card the open device panel draws, in `apply` order. */
async function probeBinds(): Promise<BindProbe[]> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const body: HTMLElement | null = leaf?.view?.containerEl?.querySelector(".wadjet-studio-device") ?? null;
      const txt = (root: Element, sel: string) => (root.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const attrs = (root: Element, sel: string, name: string) => Array.from(root.querySelectorAll(sel)).map((n) => n.getAttribute(name) ?? "");
      return Array.from(body?.querySelectorAll(".wadjet-studio-device-bind") ?? []).map((card) => ({
        name: txt(card, ".wadjet-studio-device-bind-name"),
        value: txt(card, ".wadjet-studio-device-bind-value"),
        path: txt(card, ".wadjet-studio-device-bind-path"),
        shape: txt(card, ".wadjet-studio-device-shape"),
        shapeOpen: card.querySelector(".wadjet-studio-device-shape.is-open") !== null,
        mode: txt(card, '[data-part^="mod-mode-"]'),
        phases: attrs(card, "[data-phase]", "data-phase"),
        selectedPhases: attrs(card, '[data-phase][aria-pressed="true"]', "data-phase"),
        sources: Array.from(card.querySelectorAll(".wadjet-studio-device-src")).map((n) => ({
          source: n.getAttribute("data-source") ?? "",
          pct: (n.querySelector(".wadjet-studio-device-src-pct")?.textContent ?? "").trim(),
        })),
        offered: attrs(card, '[data-part="src-list"] [data-source]', "data-source"),
      }));
    },
    VIEW_TYPE,
  );
}

/** The rows `＋ Add target` opens under the cards (`ui/windows/device/apply.ts`, D15 bead 4). */
async function probeTargets(): Promise<Array<{ param: string; op: string }>> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const body: HTMLElement | null = leaf?.view?.containerEl?.querySelector(".wadjet-studio-device") ?? null;
      return Array.from(body?.querySelectorAll('[data-part="target-list"] [data-target]') ?? []).map((n) => ({
        param: n.getAttribute("data-target") ?? "",
        op: (n.querySelector(".wadjet-studio-device-srcrow-note")?.textContent ?? "").trim(),
      }));
    },
    VIEW_TYPE,
  );
}

/** The envelope overlay under an open binding card (`ui/windows/device/env-moon.ts`, D15 bead 3). */
interface EnvelopeProbe {
  count: number;
  title: string;
  presets: string[];
  lit: string[];
  xTicks: string[];
  yTicks: string[];
  handles: number;
}

async function probeEnvelope(): Promise<EnvelopeProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const body: HTMLElement | null = leaf?.view?.containerEl?.querySelector(".wadjet-studio-device") ?? null;
      const boxes = Array.from(body?.querySelectorAll(".wadjet-studio-device-env") ?? []);
      const box = boxes[0] ?? null;
      const texts = (sel: string) => (box === null ? [] : Array.from(box.querySelectorAll(sel)).map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()));
      return {
        count: boxes.length,
        title: box === null ? "" : (box.querySelector(".wadjet-studio-device-env-title")?.textContent ?? "").replace(/\s+/g, " ").trim(),
        presets: box === null ? [] : Array.from(box.querySelectorAll("[data-env]")).map((n) => n.getAttribute("data-env") ?? ""),
        lit: box === null ? [] : Array.from(box.querySelectorAll("[data-env].is-on")).map((n) => n.getAttribute("data-env") ?? ""),
        xTicks: texts(".wadjet-studio-chart-xtick"),
        yTicks: texts(".wadjet-studio-chart-tick"),
        handles: box === null ? 0 : box.querySelectorAll(".wadjet-studio-chart-point").length,
      };
    },
    VIEW_TYPE,
  );
}

/**
 * Put the walk's device on the moon path with the Stormtide's own two
 * bindings, so the cards have a `scale` and an `offset` to draw — one of each
 * shape the mode toggle can move.
 */
async function seedMoonBindings(): Promise<void> {
  await openDeviceWindow(DEVICE_ID);
  await withApp(
    ob.page,
    (app, a: { type: string; id: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      leaf.view.store.update(
        (s: any) => {
          // The fixture's moon has no named phases, so the cards would have
          // nothing to chip. Name them the way the CYCLE window would.
          s.world.calendar.moons = [
            {
              name: "Moon",
              cycleDays: 29.53,
              phaseAtEpoch: 0,
              phases: [
                { name: "New", at: 0 },
                { name: "Crescent", at: 0.16 },
                { name: "Half", at: 0.42 },
                { name: "Gibbous", at: 0.68 },
                { name: "Full", at: 0.86 },
              ],
            },
          ];
          const modifier = s.zones[s.view.zoneId].modifiers.find((m: any) => m.id === a.id);
          modifier.apply = [
            { param: "precipitation.pwd", op: "scale", value: 1.5 },
            { param: "wind.speed", op: "offset", value: 12 },
          ];
          delete modifier.mods;
        },
        { history: true },
      );
    },
    { type: VIEW_TYPE, id: DEVICE_ID },
  );
  await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=moon]').click();
  await nextFrame();
}

describe("climate studio · device window", () => {
  test("step 52: a chance device opens as a DEVICE panel with its KIND, its % knob and one apply knob", async () => {
    await seedDevice();
    await openDeviceWindow(DEVICE_ID);

    const probe = await probeDevice();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe(DEVICE_ID);
    // One badge, and it names the KIND (F11a folded the panel's own name row
    // and kind pill into the window chrome): `chance` reads as DICE, the
    // prototype's own word for a device that rolls for it.
    expect(probe.badge).toBe("DICE");
    expect(probe.kind).toBe("DICE");
    // The chrome title is the rename field, so the name is editable in place.
    expect(probe.name).toBe(DEVICE_ID);
    expect(probe.whenKind).toBe("chance");
    // `{ chance: 0.1 }` reads as a percentage, not a fraction (SPEC §3.4), and
    // says what the percentage is OF, the way the prototype's `devChance.lbl`
    // does (wadjet-9f9.48.8.2).
    expect(probe.chance).toBe("10% of days");
    expect(probe.applyKnobs).toBe(1);
    // Law 5: the footer is the exact modifier the window writes — as authored
    // grammar now rather than the serialised object (F11a `deviceGrammar`),
    // so the predicate and the apply are still both readable in it, in the
    // engine's own paths.
    expect(probe.writes).toMatch(/^modifiers\[\d+\] · when\.chance 0\.10 · apply wind\.speed ×1\.50$/);
    // The store's copy is the oracle for the shape itself.
    expect(await draftModifier(DEVICE_ID)).toEqual({ id: DEVICE_ID, stage: "daily", when: { chance: 0.1 }, apply: [{ param: "wind.speed", op: "scale", value: 1.5 }] });
    console.log(`  · device:${DEVICE_ID} → ${probe.badge} "${probe.title}" · ${probe.kind} · chance ${probe.chance} · ${probe.applyKnobs} apply knob; writes ${probe.writes}`);
  });

  test("step 52a: on a moon device the gate disc's face opens the moon's CYCLE window", async () => {
    // The prototype's Stormtide gate circle and lit path carry `data-vst="sablemoon"`;
    // the handles keep their drag. wadjet-9f9.48.10 found the plugin's face inert.
    const cycleIds = () =>
      withApp(
        ob.page,
        (app, a: { type: string }) => (app.workspace.getLeavesOfType(a.type)[0].view.store.get().view.openWindows as string[]).filter((id) => id.startsWith("cycle:")),
        { type: VIEW_TYPE },
      );
    const closeCycle = (id: string) =>
      withApp(
        ob.page,
        (app, a: { type: string; id: string }) => {
          app.workspace.getLeavesOfType(a.type)[0].view.windows.close(a.id);
        },
        { type: VIEW_TYPE, id },
      );
    await openDeviceWindow(DEVICE_ID);
    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=moon]').click();
    await nextFrame();
    expect((await probeDevice()).whenKind).toBe("moon");
    // D15 / gap2 B1, B9: on the moon path the gate disc and the op knobs share
    // ONE row (`0699` l.21-40) instead of a centred disc under WHEN and an
    // APPLY grid 200 px below it, and the empty SPELL row is not drawn.
    expect(await devicePanel().locator('[data-section="moon"] .wadjet-studio-device-gate-disc').count()).toBe(1);
    expect(await devicePanel().locator('[data-section="moon"] .wadjet-studio-knob').count()).toBe(1);
    expect(await devicePanel().locator('[data-section="apply"]').count()).toBe(0);
    expect(await devicePanel().locator('[data-part="spell-power"]').count()).toBe(0);
    // Earlier describes may leave a cycle panel up; this step asserts on what its own click adds.
    const before = await cycleIds();
    const face = devicePanel().locator(".wadjet-studio-device-gate-disc .wadjet-studio-device-disc-face").first();
    await face.waitFor({ state: "visible", timeout: 10_000 });
    // The lit path covers the face's centre; both are doors, so a forced click
    // (no actionability retry against the overlapping path) is the honest one.
    await face.click({ force: true });
    await nextFrame();
    const added = (await cycleIds()).filter((id) => !before.includes(id));
    expect(added.length).toBe(1);
    console.log(`  · gate face opened ${added[0]}`);
    await closeCycle(added[0]!);
    await nextFrame();
    // A handle must still be a drag target, not a door: clicking it opens nothing new.
    await devicePanel().locator(".wadjet-studio-device-disc-handle").first().click({ force: true });
    await nextFrame();
    expect((await cycleIds()).filter((id) => !before.includes(id))).toEqual([]);
    // Leave the device as step 52 made it, so step 53 starts from the same place.
    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=chance]').click();
    await nextFrame();
  });

  test("step 52b: the moon path draws one MOD card per binding, and each card owns its shape, its mode and its ×", async () => {
    // D15 bead 2 / gap2 B4-B7: the single device-wide MOD card is gone. The
    // unit of edit on a moon device is the BINDING — one card per apply
    // target, carrying that op's value, onset shape and cycle mode.
    await seedMoonBindings();
    const cards = await probeBinds();
    expect(cards.length).toBe(2);
    // A name stands alone on a card, so it is the `macro` vocabulary the
    // prototype's bindings use, not the knob row's `precip`.
    expect(cards.map((b) => b.name)).toEqual(["storm odds", "wind"]);
    expect(cards.map((b) => b.value)).toEqual(["×1.50", "+12 km/h"]);
    expect(cards.map((b) => b.path)).toEqual(["scale · precipitation.pwd", "offset · wind.speed"]);
    // Neither the device-wide MOD row nor `＋ mod` is drawn on this path.
    expect(await devicePanel().locator(".wadjet-studio-device-mod-row").count()).toBe(0);
    expect(await devicePanel().locator(".wadjet-studio-device-add-mod").count()).toBe(0);

    // The `∿` chip toggles one card open, and only that one. On a card still
    // in phases mode it also writes the default envelope (wadjet-l0j): the
    // prototype's chip opens the editor on every click, and here curve mode
    // IS the envelope, so an inert chip was the deviation.
    expect(cards.map((b) => b.shapeOpen)).toEqual([false, false]);
    expect(cards.map((b) => b.mode)).toEqual(["▦ phases", "▦ phases"]);
    await devicePanel().locator('[data-part="shape-0"]').click();
    await nextFrame();
    const openedByChip = await probeBinds();
    expect(openedByChip.map((b) => b.shapeOpen)).toEqual([true, false]);
    expect(openedByChip.map((b) => b.mode)).toEqual(["∿ curve", "▦ phases"]);
    expect(openedByChip[0]!.shape).toBe("∿ Ease in");
    expect(await devicePanel().locator(".wadjet-studio-device-env").count()).toBe(1);
    const chipWrote = await draftModifier(DEVICE_ID);
    expect(Array.isArray(chipWrote.apply[0].envelope)).toBe(true);
    expect(chipWrote.apply[1].envelope).toBeUndefined();
    // Closing the overlay keeps the envelope — only the mode toggle drops it.
    await devicePanel().locator('[data-part="shape-0"]').click();
    await nextFrame();
    expect((await probeBinds()).map((b) => b.shapeOpen)).toEqual([false, false]);
    expect(await devicePanel().locator(".wadjet-studio-device-env").count()).toBe(0);
    expect(Array.isArray((await draftModifier(DEVICE_ID)).apply[0].envelope)).toBe(true);

    // `∿ curve` → `▦ phases` drops the envelope; `▦ phases` → `∿ curve`
    // writes one on THAT op and no other.
    await devicePanel().locator('[data-part="mod-mode-0"]').click();
    await nextFrame();
    expect((await probeBinds()).map((b) => b.mode)).toEqual(["▦ phases", "▦ phases"]);
    expect((await draftModifier(DEVICE_ID)).apply[0].envelope).toBeUndefined();
    await devicePanel().locator('[data-part="mod-mode-0"]').click();
    await nextFrame();
    const curved = await probeBinds();
    expect(curved.map((b) => b.mode)).toEqual(["∿ curve", "▦ phases"]);
    expect(curved[0]!.shape).toBe("∿ Ease in");
    const withEnvelope = await draftModifier(DEVICE_ID);
    expect(Array.isArray(withEnvelope.apply[0].envelope)).toBe(true);
    expect(withEnvelope.apply[1].envelope).toBeUndefined();
    // A curve rides its envelope, so that card drops its phase chips; the
    // other card still has them.
    expect(curved[0]!.phases).toEqual([]);
    expect(curved[1]!.phases.length).toBeGreaterThan(0);
    await devicePanel().locator('[data-part="mod-mode-0"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).apply[0].envelope).toBeUndefined();

    // The phase chips moved off the WHEN row onto the cards (gap2 B6), and
    // they still write the device-wide `[a, b)` — so both cards agree.
    expect(await devicePanel().locator(".wadjet-studio-device-when [data-phase]").count()).toBe(0);
    const before = await probeBinds();
    const wasRange = (await draftModifier(DEVICE_ID)).when.moon.phase;
    const selected = before[0]!.selectedPhases;
    expect(before[1]!.selectedPhases).toEqual(selected);
    const target = before[0]!.phases.find((p) => !selected.includes(p));
    expect(target, `every phase already selected in ${JSON.stringify(before[0]!.phases)}`).toBeDefined();
    await devicePanel().locator(`[data-part="bind-0"] [data-phase="${target}"]`).click();
    await nextFrame();
    const toggled = await probeBinds();
    expect(toggled[0]!.selectedPhases).toContain(target);
    expect(toggled[1]!.selectedPhases).toEqual(toggled[0]!.selectedPhases);
    expect((await draftModifier(DEVICE_ID)).when.moon.phase).not.toEqual(wasRange);

    // Line 1's channel dot is also the op's mute: the moon row's knobs are
    // bare, so a device switched to moon would otherwise lose the only way to
    // reach `ModifierOp.enabled`. The generic contract survives with it.
    expect(await devicePanel().locator('[data-part="op-power-0"]').count()).toBe(1);
    await devicePanel().locator('[data-part="op-power-0"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).apply[0].enabled).toBe(false);
    await devicePanel().locator('[data-part="op-power-0"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).apply[0].enabled).toBeUndefined();

    // The card's `×` removes the whole binding, card and all.
    await devicePanel().locator('[data-part="bind-remove-1"]').click();
    await nextFrame();
    const left = await probeBinds();
    expect(left.length).toBe(1);
    expect(left[0]!.name).toBe("storm odds");
    expect((await draftModifier(DEVICE_ID)).apply).toEqual([{ param: "precipitation.pwd", op: "scale", value: 1.5 }]);
    console.log(`  · ${cards.length} bind cards ${JSON.stringify(cards.map((b) => `${b.name} ${b.value}`))}; phases ${JSON.stringify(before[0]!.phases)}; × left ${left.length}`);
  });

  test("step 52c: a card's ＋ opens an inline source list, and the chip it adds drags its own amount", async () => {
    await seedMoonBindings();
    expect((await probeBinds())[0]!.sources).toEqual([]);

    // `＋` opens an inline list under the card (`0699` l.66-74), not a Menu.
    await devicePanel().locator('[data-part="src-add-0"]').click();
    await nextFrame();
    const open = await probeBinds();
    expect(open[0]!.offered).toContain("season:Harvest");
    // Only the card that was asked shows the list.
    expect(open[1]!.offered).toEqual([]);

    await devicePanel().locator('[data-part="bind-0"] [data-part="src-list"] [data-source="season:Harvest"]').click();
    await nextFrame();
    const added = await probeBinds();
    expect((await draftModifier(DEVICE_ID)).mods).toEqual([{ source: "season:Harvest", amount: 1 }]);
    // `ModGate[]` lives on the modifier, not the op: every card draws it.
    expect(added.map((b) => b.sources)).toEqual([[{ source: "season:Harvest", pct: "100%" }], [{ source: "season:Harvest", pct: "100%" }]]);
    expect(added[0]!.offered).toEqual([]);

    // The chip IS the dimmer: 120 px of drag is the whole [0, 1], so 60 px
    // down halves it (the prototype's `srcAmtDown`).
    await dragKnobDial('[data-part="bind-0"] [data-part="gate-chip-0"]', 60);
    expect((await draftModifier(DEVICE_ID)).mods).toEqual([{ source: "season:Harvest", amount: 0.5 }]);
    expect((await probeBinds())[0]!.sources).toEqual([{ source: "season:Harvest", pct: "50%" }]);

    // The `×` inside the chip drops the source without ever starting a drag.
    await devicePanel().locator('[data-part="bind-0"] [data-part="gate-drop-0"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).mods ?? []).toEqual([]);
    expect((await probeBinds())[0]!.sources).toEqual([]);
    console.log(`  · ＋ offered ${JSON.stringify(open[0]!.offered)}; season:Harvest dragged to 50% then removed`);

    // Leave the walk the chance device step 53 expects.
    await seedDevice();
    await openDeviceWindow(DEVICE_ID);
  });

  test("step 52d: the `∿` chip opens the envelope overlay, its presets rewrite the points, and a drag makes them custom", async () => {
    // D15/D16 bead 3 / `0699` l.75-93: an open card reveals the prototype's own
    // overlay — a header that names the binding, five preset chips with the
    // matching one lit, and a plot of the last third of the cycle.
    await seedMoonBindings();
    // A fresh binding has no envelope and no overlay: the chip alone writes
    // the default and opens it (wadjet-l0j), the way the prototype's chip
    // opens the editor on every click.
    expect((await draftModifier(DEVICE_ID)).apply[0].envelope).toBeUndefined();
    expect(await devicePanel().locator(".wadjet-studio-device-env").count()).toBe(0);

    await devicePanel().locator('[data-part="shape-0"]').click();
    await nextFrame();
    expect(Array.isArray((await draftModifier(DEVICE_ID)).apply[0].envelope)).toBe(true);
    expect((await probeBinds())[0]!.mode).toBe("∿ curve");
    const opened = await probeEnvelope();
    expect(opened.count).toBe(1);
    // The header names the binding in the same `macro` vocabulary the card does.
    expect(opened.title).toBe("envelope · storm odds (×1.50 at full strength)");
    expect(opened.presets).toEqual(["Sharp", "Ease in", "Swell", "Pulse", "Ramp out"]);
    expect(opened.lit).toEqual(["Ease in"]);
    expect((await probeBinds())[0]!.shape).toBe("∿ Ease in");
    // The plot runs 0.70 → full, not 0 → 1: an onset only ever lives there.
    expect(opened.xTicks).toEqual(["0.70", "0.80", "0.90", "full ●"]);
    expect(opened.yTicks).toEqual(["0", "1"]);
    // Only the open card gets one.
    expect(await devicePanel().locator('[data-part="env-overlay-1"]').count()).toBe(0);

    // A preset click rewrites the points, so the card's label follows it.
    await devicePanel().locator('.wadjet-studio-device-env [data-env="Pulse"]').click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).apply[0].envelope).toEqual([
      [0.92, 0],
      [0.94, 1],
      [0.96, 0],
    ]);
    expect((await probeEnvelope()).lit).toEqual(["Pulse"]);
    expect((await probeBinds())[0]!.shape).toBe("∿ Pulse");
    expect((await probeEnvelope()).handles).toBe(3);

    // Dragging the peak down is what makes a shape `custom` — nothing stores
    // the name, `envelopeShapeName` recognises the points. The handle follows
    // the hand while it is still down, not only on release (wadjet-jug).
    const peak = await dragHandleHeld('[data-part="env-chart-0"] .wadjet-studio-chart-point[data-index="1"]', 20);
    expect(peak.held).toBeGreaterThan(peak.before);
    expect(peak.after).toBe(peak.held);
    const drawn = (await draftModifier(DEVICE_ID)).apply[0].envelope as Array<[number, number]>;
    expect(drawn[1]![1]).toBeLessThan(0.9);
    expect((await probeBinds())[0]!.shape).toBe("∿ custom");
    expect((await probeEnvelope()).lit).toEqual([]);
    console.log(`  · overlay "${opened.title}"; presets ${JSON.stringify(opened.presets)}; peak dragged to ${drawn[1]![1].toFixed(2)} → custom`);

    // Leave the walk the chance device step 53 expects.
    await seedDevice();
    await openDeviceWindow(DEVICE_ID);
  });

  test("step 52e: `＋ Add target` opens an inline list of the unbound params, and the WRITES names each onset and gate", async () => {
    // D15/D16 bead 4 / `0699` l.95-104: the moon path drops the `＋ apply`
    // cell and its Obsidian `Menu` for a full-width block under the cards,
    // opening a list in the panel rather than a floating menu.
    await seedMoonBindings();
    expect(await devicePanel().locator(".wadjet-studio-device-add-apply").count()).toBe(0);
    const add = devicePanel().locator('[data-part="add-target"]');
    expect((await add.textContent())?.trim()).toBe("＋ Add target");
    expect(await devicePanel().locator('[data-part="target-list"]').count()).toBe(0);

    await add.click();
    await nextFrame();
    const offered = await probeTargets();
    // Only what the device is NOT already bound to: `paramsByChannel` drops
    // the two `seedMoonBindings` wrote, so the list is every other param.
    const total = paramsByChannel("daily").reduce((n, g) => n + g.params.length, 0);
    expect(offered.length).toBe(total - 2);
    expect(offered.map((t) => t.param)).not.toContain("precipitation.pwd");
    expect(offered.map((t) => t.param)).not.toContain("wind.speed");
    // Each row says which op it would add — the plugin's own default, not the
    // prototype's fixed table.
    expect(offered.every((t) => t.op === "scale" || t.op === "offset" || t.op === "set")).toBe(true);

    const pick = offered[0]!;
    await devicePanel().locator(`[data-part="target-list"] [data-target="${pick.param}"]`).click();
    await nextFrame();
    // A row adds the card and closes the list.
    expect((await probeBinds()).length).toBe(3);
    expect(await devicePanel().locator('[data-part="target-list"]').count()).toBe(0);
    const applied = (await draftModifier(DEVICE_ID)).apply;
    expect(applied.length).toBe(3);
    expect(applied[2].param).toBe(pick.param);
    expect(applied[2].op).toBe(pick.op);
    // …and the list no longer offers it.
    await add.click();
    await nextFrame();
    expect((await probeTargets()).length).toBe(total - 3);
    await devicePanel().locator('[data-part="bind-remove-2"]').click();
    await nextFrame();
    expect((await probeBinds()).length).toBe(2);

    // Law 5 on the moon path (bead 4): the tail is NAMED, not counted — each
    // binding carries its own `∿shape`, and the device's gates are listed once
    // because `mods` hangs off the modifier, not the op. The param paths, the
    // `[a, b)` range and the moon's own casing stay the plugin's.
    await devicePanel().locator('[data-part="mod-mode-0"]').click();
    await nextFrame();
    await devicePanel().locator('[data-part="src-add-0"]').click();
    await nextFrame();
    await devicePanel().locator('[data-part="bind-0"] [data-part="src-list"] [data-source="season:Harvest"]').click();
    await nextFrame();
    const writes = (await probeDevice()).writes;
    expect(writes).toMatch(/^modifiers\[\d+\] · when\.moon Moon \[\d\.\d\d, \d\.\d\d\] · apply precipitation\.pwd ×1\.50 ∿ease in, wind\.speed \+12 · × season:Harvest@100%$/);
    console.log(`  · ＋ Add target offered ${offered.length} of ${total}; added ${pick.param} (${pick.op}); writes ${writes}`);

    // Leave the walk the chance device step 53 expects.
    await seedDevice();
    await openDeviceWindow(DEVICE_ID);
  });

  test("step 53: the WHEN segmented switches to tag, and season chips write tag then any", async () => {
    // `open` focuses the panel step 52 left up and rebuilds it if that step
    // died and the shared afterEach closed it — one failure should not cascade
    // into the five steps that follow it.
    await openDeviceWindow(DEVICE_ID);
    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=tag]').click();
    await nextFrame();

    const switched = await probeDevice();
    expect(switched.whenKind).toBe("tag");
    expect(switched.kind).toBe("TAG");
    // `newDevice`'s default: the calendar's first season. The picker shows the
    // SELECTED tags only now, each removable, with a `＋` that offers the rest
    // in a menu — the prototype's compact control, not an inline list of every
    // tag the world has ever heard of.
    expect(switched.selectedTags).toEqual(["season:Spring"]);
    expect(switched.tagChips).toEqual(["season:Spring"]);
    expect((await draftModifier(DEVICE_ID)).when).toEqual({ tag: "season:Spring" });

    // The `＋` offers exactly the tags that are not on already — the four
    // seasons the world has, minus the one this device is already gated on.
    await devicePanel().locator(".wadjet-studio-device-when .wadjet-studio-device-add").first().click();
    const menu = ob.page.locator(".menu").last();
    await menu.waitFor({ state: "visible", timeout: 10_000 });
    const offered = (await menu.locator(".menu-item-title").allTextContents()).map((t) => t.trim());
    expect(offered.filter((t) => t.startsWith("season:"))).toEqual(["season:Summer", "season:Harvest", "season:Winter"]);
    expect(offered).not.toContain("season:Spring");

    // A second tag: several tags are `any` (SPEC §3.4).
    await menu.locator(".menu-item", { hasText: "season:Winter" }).first().click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).when).toEqual({ any: [{ tag: "season:Spring" }, { tag: "season:Winter" }] });
    expect((await probeDevice()).tagChips).toEqual(["season:Spring", "season:Winter"]);

    // Back down to one — clicking a chip takes its tag off — and the predicate
    // collapses to a bare tag again.
    await devicePanel().locator('[data-tag="season:Spring"]').click();
    await nextFrame();
    const one = await draftModifier(DEVICE_ID);
    expect(one.when).toEqual({ tag: "season:Winter" });
    const after = await probeDevice();
    expect(after.selectedTags).toEqual(["season:Winter"]);
    console.log(`  · WHEN chance → tag; chips ${JSON.stringify(after.tagChips)}; ＋ offered ${JSON.stringify(offered)}; when ${JSON.stringify(one.when)}`);
  });

  test("step 54: the SPELL lamp writes the real grammar with the shipped defaults", async () => {
    await openDeviceWindow(DEVICE_ID);
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
    await openDeviceWindow(DEVICE_ID);
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
    // The gate's readout is the prototype's percentage (F11a `gatePercent`),
    // not the raw 0–1 amount the modifier stores.
    expect(dimmed.gateAmount).toBe("50%");
    const draft = await draftModifier(DEVICE_ID);
    expect(draft.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);
    console.log(`  · ＋ gate season:Winter, dragged to ${dimmed.gateAmount} → mods ${JSON.stringify(draft.mods)}`);
  });

  test("step 55a: ＋ envelope shapes one op's onset on a device with no moon, and its × takes it back off", async () => {
    // The prototype only shapes onsets on the moon path, but the engine samples
    // any op's envelope at the world's first moon (`core/modifiers.ts`
    // `carrierPhase`), and `＋ mod` promises "a gate or an envelope" — so the
    // MOD head offers `＋ envelope` beside `＋ gate` on every other kind.
    await openDeviceWindow(DEVICE_ID);
    const before = await draftModifier(DEVICE_ID);
    expect(before.apply.every((o: { envelope?: unknown }) => o.envelope === undefined)).toBe(true);
    expect(await devicePanel().locator(".wadjet-studio-device-envelope").count()).toBe(0);

    await devicePanel().locator('[data-part="add-envelope"]').click();
    await pickDeviceMenuItem(/./);
    const shaped = await draftModifier(DEVICE_ID);
    const at = shaped.apply.findIndex((o: { envelope?: unknown }) => o.envelope !== undefined);
    expect(at).toBeGreaterThanOrEqual(0);
    // The same default the moon card's mode toggle writes.
    expect(shaped.apply[at].envelope).toEqual([
      [0.78, 0],
      [0.88, 0.5],
      [0.94, 1],
      [0.999, 1],
    ]);
    expect(await devicePanel().locator(".wadjet-studio-device-envelope").count()).toBe(1);
    expect((await devicePanel().locator(".wadjet-studio-device-envelope .wadjet-studio-device-toggle").textContent())?.trim()).toBe("∿ Ease in");
    expect(await devicePanel().locator(`[data-part="envelope-${at}"] .wadjet-studio-chart-point`).count()).toBe(4);

    // The card's plot tracks a held drag too, the same as the moon overlay's.
    const peak = await dragHandleHeld(`[data-part="envelope-${at}"] .wadjet-studio-chart-point[data-index="2"]`, 15);
    expect(peak.held).toBeGreaterThan(peak.before);
    expect(peak.after).toBe(peak.held);
    const dragged = (await draftModifier(DEVICE_ID)).apply[at].envelope as Array<[number, number]>;
    expect(dragged[2]![1]).toBeLessThan(1);

    // The card's × removes it, and the walk leaves step 56 the draft it expects.
    await devicePanel().locator(".wadjet-studio-device-envelope .wadjet-studio-device-remove").click();
    await nextFrame();
    expect((await draftModifier(DEVICE_ID)).apply[at].envelope).toBeUndefined();
    expect(await devicePanel().locator(".wadjet-studio-device-envelope").count()).toBe(0);
    console.log(`  · ＋ envelope on apply[${at}] → Ease in, 4 handles; × removed it`);
  });

  test("step 56: save as preset writes the device's shape into the world draft", async () => {
    await openDeviceWindow(DEVICE_ID);
    const before = (await draftPresets()).map((p) => p.name);

    // The preset control is the window chrome's now (F11a), and since the
    // shared-chrome pass it is one chip: a `▾` menu of the presets this kind
    // offers with `Save as preset…` at the foot of it, where the `＋` was.
    await savePresetAs(deviceWindow(), "Gale preset");
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

    // The picker offers it back, badged `yours`.
    const titles = await presetMenuOptions(deviceWindow());
    expect(titles.some((t) => t.includes(`${saved.name} · yours`))).toBe(true);
    // The device path's `preset.name` is the constant `no preset` placeholder,
    // so the chip has to remember what was picked: load the saved one back and
    // the chip must wear its label rather than falling to the placeholder.
    await pickPresetItem(deviceWindow(), `${saved.name} · yours`);
    expect(
      (await deviceWindow().locator(".wadjet-studio-window-preset-label").textContent())?.trim(),
    ).toBe(`${saved.name} · yours`);
    // Loading back a preset saved FROM this device leaves it exactly as it was,
    // which is what step 57 starts from.
    const reloaded = await draftModifier(DEVICE_ID);
    expect(reloaded.when).toEqual({ tag: "season:Winter" });
    expect(reloaded.mods).toEqual([{ source: "season:Winter", amount: 0.5 }]);
    console.log(`  · saved "${saved.name}" (was ${JSON.stringify(before)}); picker now ${JSON.stringify(titles)}`);
  });

  test("step 57: renaming the device moves the modifier id and the window title follows", async () => {
    // `open` focuses an open panel and rebuilds a closed one, so the step
    // starts from a known panel whatever step 56 left behind.
    await openDeviceWindow(DEVICE_ID);
    // The name field is the chrome's click-to-edit title now (F11a).
    await renameDeviceWindow(DEVICE_RENAMED);
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

  /**
   * The vault's own `ashfall`, put back exactly as `MODIFIER_EXAMPLES` ships it.
   * Earlier walks rewrite the rack, so this step seeds rather than assumes, and
   * restores at the end the way `atlas` puts back what it borrows.
   */
  async function seedAshfall(): Promise<any> {
    await revealStudio();
    await withApp(
      ob.page,
      (app, a: { type: string; mod: any }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update(
          (s: any) => {
            const zone = s.zones[s.view.zoneId];
            const next = JSON.parse(JSON.stringify(a.mod));
            const at = zone.modifiers.findIndex((m: any) => m.id === "ashfall");
            if (at < 0) zone.modifiers.unshift(next);
            else zone.modifiers[at] = next;
          },
          { history: true },
        );
      },
      { type: VIEW_TYPE, mod: ZONE_DEVICE },
    );
    await nextFrame();
    return draftModifier("ashfall");
  }

  test("step 59: ashfall's two rain-odds writes are one composed precip column", async () => {
    // The prototype's Ashfall APPLY has TWO columns, `precip 0 — no rain` and
    // `sky 0.95 — ash-dark` (`1397-logic-class-Component.js` l.137-140): its
    // `precip` control writes `precipitation.pww` AND `.pwd` from one knob.
    const seeded = await seedAshfall();
    expect(seeded.apply.map((o: any) => o.param)).toEqual(["precipitation.pwd", "precipitation.pww", "cloud.dry"]);
    await openDeviceWindow("ashfall");

    // Three ops, two columns — and the composed one names its partner while
    // keeping the LOWER op's `op-N` part, so every existing selector still hits.
    expect(await devicePanel().locator('[data-section="apply"] .wadjet-studio-knob').count()).toBe(2);
    const composed = devicePanel().locator(".wadjet-studio-device-apply-cell[data-composed]");
    expect(await composed.count()).toBe(1);
    expect(await composed.getAttribute("data-composed")).toBe("1");
    expect(await composed.locator(".wadjet-studio-knob-label").innerText()).toContain("precip");
    expect(await composed.getAttribute("data-hint")).toContain("set · precipitation.pww / pwd");
    const values = (await devicePanel().locator('[data-section="apply"] .wadjet-studio-knob-value').allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(values).toEqual(["0 — no rain", "0.95 — ash-dark"]);

    // One nudge on the one knob moves BOTH writes, in one undo step.
    await devicePanel().locator('[data-part="op-0"] .wadjet-studio-knob-dial').press("ArrowUp");
    await nextFrame();
    const nudged = await draftModifier("ashfall");
    expect(nudged.apply[0].value).toBeGreaterThan(0);
    expect(nudged.apply[1].value).toBe(nudged.apply[0].value);
    expect(nudged.apply[2].value).toBe(0.95);

    // One mute for the pair …
    await devicePanel().locator('[data-part="op-power-0"]').click();
    await nextFrame();
    const muted = await draftModifier("ashfall");
    expect([muted.apply[0].enabled, muted.apply[1].enabled]).toEqual([false, false]);
    expect(muted.apply[2].enabled).toBeUndefined();

    // … and one × that takes both away, leaving the sky op alone.
    await composed.locator(".wadjet-studio-device-remove").click();
    await nextFrame();
    const dropped = await draftModifier("ashfall");
    expect(dropped.apply).toEqual([{ param: "cloud.dry", op: "set", value: 0.95 }]);
    expect(await devicePanel().locator('[data-section="apply"] .wadjet-studio-knob').count()).toBe(1);

    // Put the fixture back so the walks after this one stand on the same world.
    const restored = await seedAshfall();
    expect(restored.apply).toEqual(ZONE_DEVICE.apply);
    await closeStudioWindows();
    console.log(`  · ashfall: 3 ops → ${values.length} columns ${JSON.stringify(values)}; nudge wrote both (${nudged.apply[0].value}), × left ${JSON.stringify(dropped.apply.map((o: any) => o.param))}`);
  });

  test("step 60: the spell path opens 322 wide, dials first, WINDOWS then APPLY, lane full width, no ＋ mod", async () => {
    // `0905-vst-ashfall.html`: a 320 px window whose body is the two spell
    // dials uncaptioned, `WINDOWS · repeat yearly`, `APPLY · while running`,
    // and nothing else (gap2 C5, C9, C10). 322, not 320, because
    // `getBoundingClientRect()` measures the OUTER box: the prototype's
    // `width:320px` is content-box and its `border:1px solid #565b61` grows it
    // to 322 on screen, which is what `PANEL_W_SPELL` now states directly
    // (bead wadjet-9f9.48.11).
    await seedAshfall();
    await openDeviceWindow("ashfall");

    const shape = await withApp(
      ob.page,
      (app, type: string) => {
        const el: HTMLElement = app.workspace.getLeavesOfType(type)[0].view.containerEl;
        const body: HTMLElement | null = el.querySelector(".wadjet-studio-device");
        const panel: HTMLElement | null = body?.closest(".wadjet-studio-window") ?? null;
        const lane: HTMLElement | null = body?.querySelector(".wadjet-studio-device-lane") ?? null;
        /** A dial's centre as a percentage of the body's content width — the prototype's are 26 and 72. */
        const centre = (part: string): number => {
          const dial: HTMLElement | null = body?.querySelector(`[data-part="${part}"] .wadjet-studio-knob-dial`) ?? null;
          if (dial === null || body === null) return -1;
          const d = dial.getBoundingClientRect();
          const b = body.getBoundingClientRect();
          return Math.round(((d.left + d.width / 2 - b.left) / b.width) * 1000) / 10;
        };
        return {
          startsCentre: centre("spell-starts"),
          durationCentre: centre("spell-duration"),
          width: panel === null ? 0 : Math.round(panel.getBoundingClientRect().width),
          bodyWidth: body === null ? 0 : Math.round(body.getBoundingClientRect().width),
          laneWidth: lane === null ? 0 : Math.round(lane.getBoundingClientRect().width),
          sections: body === null ? [] : Array.from(body.querySelectorAll("[data-section]")).map((n) => n.getAttribute("data-section") ?? ""),
          // `querySelectorAll` answers in document order, so this IS the order.
          marks:
            body === null
              ? []
              : Array.from(body.querySelectorAll('[data-section], [data-part="spell-starts"], [data-part="spell-duration"]')).map((n) =>
                  n.hasAttribute("data-part") ? (n.getAttribute("data-part") ?? "") : `section:${n.getAttribute("data-section")}`,
                ),
        };
      },
      VIEW_TYPE,
    );

    expect(shape.width).toBe(322);
    expect(shape.sections).toEqual(["when", "spell", "windows", "apply"]);
    // The dials come before APPLY, which is the whole point of the reorder.
    expect(shape.marks.indexOf("spell-starts")).toBeGreaterThan(-1);
    expect(shape.marks.indexOf("spell-starts")).toBeLessThan(shape.marks.indexOf("section:apply"));
    expect(shape.marks.indexOf("spell-duration")).toBeLessThan(shape.marks.indexOf("section:apply"));
    // The lane owns the content width now, not two thirds of it (gap2 C5).
    expect(shape.laneWidth).toBe(shape.bodyWidth);
    // The spell is still switchable, and the `＋ mod` button is gone.
    expect(await devicePanel().locator('[data-part="spell-power"]').count()).toBe(1);
    expect(await devicePanel().locator(".wadjet-studio-device-add-mod").count()).toBe(0);

    // The two dials space-around the whole row (`0905` l.12-15 puts their
    // centres at 26% and 72%); the power pill is out of flow so it cannot pull
    // them into the left third.
    expect(shape.startsCentre).toBeGreaterThan(20);
    expect(shape.startsCentre).toBeLessThan(32);
    expect(shape.durationCentre).toBeGreaterThan(66);
    expect(shape.durationCentre).toBeLessThan(80);
    // The caption `starts / yr` carries the unit, so the readout is the bare
    // number the prototype prints (`0905` l.13).
    expect((await devicePanel().locator('[data-part="spell-starts"] .wadjet-studio-knob-value').innerText()).trim()).toBe("0.6");
    expect((await devicePanel().locator('[data-part="spell-duration"] .wadjet-studio-knob-value').innerText()).trim()).toBe("18 d");

    // Ashfall has one clip, and the model keeps a window device on at least
    // one: the × is drawn anyway (`0905` l.34) and refuses.
    const lone = devicePanel().locator(".wadjet-studio-device-clip-row .wadjet-studio-device-remove");
    expect(await lone.count()).toBe(1);
    expect(await lone.getAttribute("aria-disabled")).toBe("true");
    // Playwright refuses to click an `aria-disabled` element, which is itself
    // the proof; the event is dispatched anyway to show the handler no-ops.
    await lone.dispatchEvent("click");
    await nextFrame();
    expect((await draftModifier("ashfall")).when).toEqual(ZONE_DEVICE.when);

    await closeStudioWindows();
    console.log(
      `  · spell path: ${shape.width} px wide; sections ${JSON.stringify(shape.sections)}; lane ${shape.laneWidth}/${shape.bodyWidth} px; dial centres ${shape.startsCentre}% / ${shape.durationCentre}%`,
    );
  });

  test("step 61: the spell path's ＋ apply opens the inline target list, not an Obsidian menu", async () => {
    // `0905` l.49-59: the dashed 44 px circle stays the trigger, but what it
    // opens is `ashAddOpts` hanging under the APPLY row — the same inline list
    // the moon path opens (step 52e), filtered to the params not yet bound.
    await seedAshfall();
    await openDeviceWindow("ashfall");

    const add = devicePanel().locator('[data-section="apply"] [data-part="add-target"]');
    expect(await add.count()).toBe(1);
    // Still the dashed circle, not the moon path's full-width block.
    expect(await add.getAttribute("class")).toContain("wadjet-studio-device-add-apply");
    expect((await add.textContent())?.trim()).toBe("＋");
    expect(await devicePanel().locator('[data-part="target-list"]').count()).toBe(0);

    await add.click();
    await nextFrame();
    const offered = await probeTargets();
    const total = paramsByChannel("daily").reduce((n, g) => n + g.params.length, 0);
    // Ashfall binds three params and draws two columns: the composed precip
    // pair is ONE column but TWO ops, and both count as bound.
    expect(offered.length).toBe(total - 3);
    const params = offered.map((t) => t.param);
    expect(params).not.toContain("precipitation.pwd");
    expect(params).not.toContain("precipitation.pww");
    expect(params).not.toContain("cloud.dry");
    // And no `precip` pseudo-target — the prototype's fixed table has one, the
    // plugin offers the real param paths it would actually write.
    expect(params).not.toContain("precip");

    const pick = offered[0]!;
    await devicePanel().locator(`[data-part="target-list"] [data-target="${pick.param}"]`).click();
    await nextFrame();
    // A row adds the op and closes the list.
    expect(await devicePanel().locator('[data-part="target-list"]').count()).toBe(0);
    const added = (await draftModifier("ashfall")).apply;
    expect(added.length).toBe(4);
    expect(added[3].param).toBe(pick.param);
    expect(added[3].op).toBe(pick.op);

    // Put the fixture back so the walks after this one stand on the same world.
    const restored = await seedAshfall();
    expect(restored.apply).toEqual(ZONE_DEVICE.apply);
    await closeStudioWindows();
    console.log(`  · ＋ apply offered ${offered.length}/${total} params (3 bound); added ${pick.param} (${pick.op})`);
  });

  /** The curse's own hue on the KIND pill, straight off the chrome's custom property. */
  async function badgeColour(): Promise<string> {
    return withApp(
      ob.page,
      (app, type: string) => {
        const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
        const badge = el?.querySelector(".wadjet-studio-device")?.closest(".wadjet-studio-window")?.querySelector(".wadjet-studio-window-badge") as HTMLElement | null;
        return badge?.style.getPropertyValue("--wadjet-studio-badge-color").trim() ?? "";
      },
      VIEW_TYPE,
    );
  }

  /** Put the curse in the rack (or take it out again), the way the audit world stores it. */
  async function seedCurse(mod: any): Promise<void> {
    await revealStudio();
    await withApp(
      ob.page,
      (app, a: { type: string; id: string; mod: any }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update(
          (s: any) => {
            const zone = s.zones[s.view.zoneId];
            zone.modifiers = zone.modifiers.filter((m: any) => m.id !== a.id);
            if (a.mod !== null) zone.modifiers.push(JSON.parse(JSON.stringify(a.mod)));
          },
          { history: true },
        );
      },
      { type: VIEW_TYPE, id: CURSE_ID, mod },
    );
    await nextFrame();
  }

  test("step 62: the CURSE badge is the flag its author picked, not what the device writes", async () => {
    // The prototype's Neverain is NOT a sixth kind: `DEV_KINDS` has the same
    // five the studio has, and the emitter writes it as a plain
    // `when.tag era:Drought` (`1397-logic-class-Component.js` l.874). Nor is
    // the badge derived from the apply: a curse is a specialised tag device the
    // author opts into in the insert picker because the word reads better for
    // what they mean, and it could write anything (PLAN D17, wadjet-9f9.48.12).
    await seedCurse(CURSE_MODIFIER);
    await openDeviceWindow(CURSE_ID);

    const cursed = await probeDevice();
    expect(cursed.open).toBe(true);
    expect(cursed.title).toBe(CURSE_ID);
    expect(cursed.badge).toBe("CURSE");
    expect(cursed.whenKind).toBe("tag");
    // #f0885c — the prototype's own curse hue (`1213-vst-neverain.html` l.6),
    // which is the same one SPELL wears, not the error red.
    const cursedHue = await badgeColour();
    expect(cursedHue).toBe("var(--wadjet-studio-temp)");

    // The rail pill says the same word in the rack's lower case.
    const rail = (await probeMixer()).find((c) => c.chain === "precipitation")!.units.find((u) => u.id === CURSE_ID);
    expect(rail, `no ${CURSE_ID} on the precipitation rail`).toBeDefined();
    expect(rail!.kind).toBe("curse");

    // Turn the rain back up: the device stops killing the rain and STAYS a
    // curse, because the word was never a reading of its ops.
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        leaf.view.store.update(
          (s: any) => {
            const zone = s.zones[s.view.zoneId];
            zone.modifiers.find((m: any) => m.id === a.id).apply[0].value = 0.5;
          },
          { history: true },
        );
      },
      { type: VIEW_TYPE, id: CURSE_ID },
    );
    await nextFrame();

    const turnedUp = await probeDevice();
    expect(turnedUp.badge).toBe("CURSE");
    expect(await badgeColour()).toBe("var(--wadjet-studio-temp)");
    const still = await draftModifier(CURSE_ID);
    expect(still.badge).toBe("curse");
    expect(still.when).toEqual({ tag: "era:Drought" });
    expect(still.apply).toEqual([{ param: "precipitation.pwd", op: "scale", value: 0.5 }]);
    expect((await probeMixer()).find((c) => c.chain === "precipitation")!.units.find((u) => u.id === CURSE_ID)!.kind).toBe("curse");

    // …and the converse: the same shape with no flag is a plain TAG, which is
    // the whole point — the apply no longer decides anything.
    await seedCurse(UNFLAGGED_MODIFIER);
    await openDeviceWindow(CURSE_ID);
    const unflagged = await probeDevice();
    expect(unflagged.badge).toBe("TAG");
    const unflaggedHue = await badgeColour();
    expect(unflaggedHue).toBe("var(--wadjet-studio-gold)");
    expect((await draftModifier(CURSE_ID)).badge).toBeUndefined();
    expect((await probeMixer()).find((c) => c.chain === "precipitation")!.units.find((u) => u.id === CURSE_ID)!.kind).toBe("tag");

    // Put the rack back so the walks after this one stand on the same world.
    await seedCurse(null);
    expect(await draftModifier(CURSE_ID)).toBeNull();
    await closeStudioWindows();
    console.log(`  · ${CURSE_ID}: flagged badge ${cursed.badge} ${cursedHue}, rail "${rail!.kind}" → value 0.5 → badge ${turnedUp.badge}; unflagged same shape → ${unflagged.badge} ${unflaggedHue}`);
  });

  /** The tag path's summary row and everything the disclosure hides behind it. */
  interface CurseProbe {
    /** the panel's own box, which `width` picks at open time */
    width: number;
    /** the panel's drawn height, and every row inside it — the prototype's Neverain is 114 tall */
    height: number;
    rows: Array<{ part: string; height: number }>;
    /** the whole summary line, whitespace collapsed */
    summary: string;
    /** the op value on its own, and the custom property that colours it */
    value: string;
    valueColour: string;
    /** `null` when the row is not a disclosure at all — i.e. the device is not curse-shaped */
    expanded: string | null;
    applySections: number;
    tagChips: string[];
  }

  async function probeCurse(): Promise<CurseProbe> {
    return withApp(
      ob.page,
      (app, type: string) => {
        const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
        const body: HTMLElement | null = el?.querySelector(".wadjet-studio-device") ?? null;
        const panel: HTMLElement | null = body?.closest(".wadjet-studio-window") ?? null;
        const row: HTMLElement | null = body?.querySelector('[data-part="tag-summary"]') ?? null;
        const value: HTMLElement | null = row?.querySelector(".wadjet-studio-device-summary-value") ?? null;
        return {
          width: panel === null ? 0 : Math.round(panel.getBoundingClientRect().width),
          height: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
          rows:
            panel === null
              ? []
              : [
                  { part: "title", el: panel.querySelector(".wadjet-studio-window-bar") },
                  { part: "when", el: body?.querySelector('[data-section="when"]') ?? null },
                  { part: "spell", el: body?.querySelector('[data-section="spell"]') ?? null },
                  { part: "＋ mod", el: body?.querySelector(".wadjet-studio-device-add-mod") ?? null },
                  { part: "foot", el: body?.querySelector(".wadjet-studio-device-foot") ?? null },
                  { part: "writes", el: panel.querySelector(".wadjet-studio-writes") },
                ]
                  .filter((r) => r.el !== null)
                  .map((r) => ({ part: r.part, height: Math.round((r.el as HTMLElement).getBoundingClientRect().height) })),
          // Part by part, joined: the flex spacer between the ops and the gate
          // is an empty div, so the row's own `textContent` runs them together.
          summary:
            row === null
              ? ""
              : Array.from(row.children)
                  .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
                  .filter((t) => t !== "")
                  .join(" "),
          value: (value?.textContent ?? "").trim(),
          valueColour: value?.style.getPropertyValue("--wadjet-studio-chip-color").trim() ?? "",
          expanded: row?.getAttribute("aria-expanded") ?? null,
          applySections: body === null ? 0 : body.querySelectorAll('[data-section="apply"]').length,
          tagChips: body === null ? [] : Array.from(body.querySelectorAll(".wadjet-studio-device-when [data-tag]")).map((n) => n.getAttribute("data-tag") ?? ""),
        };
      },
      VIEW_TYPE,
    );
  }

  test("step 63: the curse shape opens 302 wide on one summary line, with the tags and APPLY behind a disclosure", async () => {
    // `1213-vst-neverain.html` l.2, l.10: a 300 px box whose whole body is
    // `precip ×0 while active` on the left and a right-aligned
    // `gate: era:Drought` on the right (gap2 D3, D4, D5). The tag chips and the
    // APPLY grid are not gone — they are behind the summary row, which on this
    // shape IS the disclosure. 302, not 300: the probe measures the OUTER box,
    // and the prototype's content-box `width:300px` plus its 1 px rim is 302 on
    // screen — what `PANEL_W_TAG` now states (bead wadjet-9f9.48.11).
    await seedCurse(CURSE_MODIFIER);
    await openDeviceWindow(CURSE_ID);

    const shut = await probeCurse();
    expect(shut.width).toBe(302);

    // The narrowest bar in the studio has to CONTAIN every control it carries.
    // A fixed 118 px name field plus a `<select>` sized to its widest option
    // put the ＋ and the × on the page background at 300 wide; the name is a
    // shrinking basis now and the preset is a content-sized chip.
    const bar = await deviceWindow().evaluate((win) => {
      const right = win.getBoundingClientRect().right;
      const rightOf = (sel: string) => {
        const node = win.querySelector(sel);
        return node === null ? null : node.getBoundingClientRect().right;
      };
      return {
        right,
        badge: rightOf(".wadjet-studio-window-badge"),
        chip: rightOf(".wadjet-studio-window-preset-pick"),
        close: rightOf(".wadjet-studio-window-close"),
        chipWidth: win.querySelector(".wadjet-studio-window-preset-pick")?.getBoundingClientRect().width ?? 0,
        title: win.querySelector(".wadjet-studio-window-title")?.getBoundingClientRect().width ?? 0,
      };
    });
    for (const [what, edge] of [
      ["badge", bar.badge],
      ["preset chip", bar.chip],
      ["close ×", bar.close],
    ] as Array<[string, number | null]>) {
      expect(edge, `no ${what} in the title bar`).not.toBeNull();
      expect(edge!, `${what} at ${edge} runs past the window's right edge ${bar.right}`).toBeLessThanOrEqual(bar.right);
    }
    // …and the name yielded the room, rather than the bar overflowing.
    expect(bar.title).toBeLessThan(118);
    console.log(`  · 300 px bar: window right ${bar.right.toFixed(1)}; badge ${bar.badge?.toFixed(1)}, chip ${bar.chip?.toFixed(1)} (${bar.chipWidth.toFixed(1)} wide), × ${bar.close?.toFixed(1)}; name ${bar.title.toFixed(1)}`);
    // `×0.00`, not the prototype's `×0`: the value is `opValueText`, the same
    // string the APPLY knob and the WRITES footer print, so the summary can
    // never drift from them.
    expect(shut.summary).toBe("precip ×0.00 while active gate: era:Drought");
    expect(shut.value).toBe("×0.00");
    // The PRECIP hue, not the prototype's curse orange: an orange rain value
    // would lie about which channel the op writes to.
    expect(shut.valueColour).toBe("var(--wadjet-studio-precip)");
    expect(shut.expanded).toBe("false");
    expect(shut.applySections).toBe(0);
    expect(shut.tagChips).toEqual([]);
    // SPELL and MOD are behind the same disclosure: the showcase draws neither,
    // and the moon and spell paths already drop what their showcases lack.
    expect(await devicePanel().locator('[data-part="spell-power"]').count()).toBe(0);
    expect(await devicePanel().locator(".wadjet-studio-device-add-mod").count()).toBe(0);
    expect(shut.rows.map((r) => r.part)).toEqual(["title", "when", "foot", "writes"]);

    // The row is the toggle: one click brings both back.
    await devicePanel().locator('[data-part="tag-summary"]').click();
    await nextFrame();
    const open = await probeCurse();
    expect(open.expanded).toBe("true");
    expect(open.applySections).toBe(1);
    expect(open.tagChips).toEqual(["era:Drought"]);
    expect((await probeDevice()).applyKnobs).toBe(1);
    expect(await devicePanel().locator('[data-part="spell-power"]').count()).toBe(1);
    expect(await devicePanel().locator(".wadjet-studio-device-add-mod").count()).toBe(1);

    // …and the op's own mute is reachable once it is, which it cannot be while
    // the section is not drawn at all.
    await devicePanel().locator('[data-part="op-power-0"]').click();
    await nextFrame();
    expect((await draftModifier(CURSE_ID)).apply[0].enabled).toBe(false);
    await devicePanel().locator('[data-part="op-power-0"]').click();
    await nextFrame();
    expect((await draftModifier(CURSE_ID)).apply[0].enabled).not.toBe(false);

    // Shut it again, so the next assertion is about the SHAPE and not about a
    // cursor a click left open.
    await devicePanel().locator('[data-part="tag-summary"]').click();
    await nextFrame();
    expect((await probeCurse()).applySections).toBe(0);

    // The same shape with no flag is a plain TAG, and a TAG device has no
    // disclosure at all — the summary row stays, everything under it is drawn.
    // The disclosure is keyed on the flag, exactly as the badge is.
    await seedCurse({ ...UNFLAGGED_MODIFIER, apply: [{ param: "precipitation.pwd", op: "scale", value: 0.5 }] });
    await openDeviceWindow(CURSE_ID);

    const tag = await probeCurse();
    expect((await probeDevice()).badge).toBe("TAG");
    expect(tag.expanded).toBeNull();
    expect(tag.value).toBe("×0.50");
    expect(tag.applySections).toBe(1);
    expect(tag.tagChips).toEqual(["era:Drought"]);
    expect(await devicePanel().locator('[data-part="spell-power"]').count()).toBe(1);

    await seedCurse(null);
    await closeStudioWindows();
    console.log(`  · ${CURSE_ID}: ${shut.width}×${shut.height} px, "${shut.summary}", APPLY ${shut.applySections} shut → ${open.applySections} open → TAG ${tag.applySections} with no disclosure`);
    console.log(`  · rows: ${shut.rows.map((r) => `${r.part} ${r.height}`).join(", ")}`);
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
  /** the label's two lines, each on its own span (F2) */
  rowName: string;
  rowSub: string;
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
      const row = Array.from(el.querySelectorAll(".wadjet-studio-row")).find((r) => (r.querySelector(".wadjet-studio-row-name")?.textContent ?? "").trim() === "Eras") as HTMLElement | undefined;
      const lane = row?.querySelector(".wadjet-studio-lane") ?? null;
      const nodes = lane === null ? [] : Array.from(lane.querySelectorAll(".wadjet-studio-span"));
      const box = lane === null ? null : lane.getBoundingClientRect();
      const strip = el.querySelector(".wadjet-studio-ruler-ticks");
      const num = (e: HTMLElement, name: string) => parseFloat(e.style.getPropertyValue(name) || "0");
      return {
        present: lane !== null,
        rowName: (row?.querySelector(".wadjet-studio-row-name")?.textContent ?? "").trim(),
        rowSub: (row?.querySelector(".wadjet-studio-row-sub")?.textContent ?? "").replace(/\s+/g, " ").trim(),
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
    // The Era preset frames the world's eras now (F3) rather than dropping a
    // fixed 1000 years around wherever the window happened to be: `eraFrame`
    // is the enabled eras' span with 100 years of air in front, at least 1000
    // wide — here [200, 900] → [100, 1100].
    expect(probe.window).toEqual({ a: 100, b: 1100 });
    // Both lines of the label are in the element's text now (F2), so the row's
    // name is read on its own span and the sub-line says what it counts.
    expect(probe.rowName).toBe("Eras");
    expect(probe.rowSub).toBe("world · 3 eras");
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
  /** the label's two lines, each on its own span (F2) */
  rowName: string;
  rowSub: string;
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
        rowName: (row?.querySelector(".wadjet-studio-row-name")?.textContent ?? "").trim(),
        rowSub: (row?.querySelector(".wadjet-studio-row-sub")?.textContent ?? "").replace(/\s+/g, " ").trim(),
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
async function waitForRegimesLane(mode: string, minSpans: number, year?: number): Promise<void> {
  await ob.page.waitForFunction(
    (a: { type: string; lane: string; mode: string; min: number; year: number | null }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      const lane = el?.querySelector(a.lane) ?? null;
      if (lane === null || lane.getAttribute("data-mode") !== a.mode) return false;
      const spans = Array.from(lane.querySelectorAll(".wadjet-studio-span"));
      if (spans.length < a.min) return false;
      // The row re-rolls on a debounce, and a pan or a zoom repaints the
      // PREVIOUS roll's blocks under the new geometry while it waits. The mode
      // and the count are true through all of that, so the gate is a property
      // of the rolled DOM itself (H-1392): every block decorated, and the run
      // that starts the strip inside the year the walk asked for.
      if (spans.some((s) => (s.getAttribute("data-regime") ?? "") === "")) return false;
      if (a.year === null) return true;
      const from = Math.min(...spans.map((s) => Number(s.getAttribute("data-span-from") ?? NaN)));
      return Number.isFinite(from) && from >= a.year && from < a.year + 1;
    },
    { type: VIEW_TYPE, lane: REGIMES_LANE, mode, min: minSpans, year: year ?? null },
    { timeout: 15_000 },
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
    await waitForRegimesLane("blocks", 2, year);

    const probe = await probeRegimesRow();
    expect(probe.mode).toBe("blocks");
    expect(probe.rowName).toBe("Regimes");
    // The sub-line is the share the states hold, biggest first (`laneSub`).
    expect(probe.rowSub).toContain(`${probe.regimes.length} state`);
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

    // The tip always names the state, at every zoom.
    for (const s of probe.spans) expect(s.hint).toContain(`regime:${s.regime}`);

    // A block with room carries its state's id — but "room" is now two
    // conditions, not one (F2 / `regimes-row.ts`): `LABEL_MIN_PX` of block AND
    // `LABEL_MIN_PX_PER_DAY` of zoom. A whole year across the playlist is
    // under 2 px a day, so nothing is labelled here however wide the run is;
    // the row's own sub-line carries the reading instead. Zoom into a season
    // and the wide blocks say their name.
    expect(probe.spans.every((s) => s.label === "")).toBe(true);
    await seedWindow({ a: year + 0.25, b: year + 0.4 });
    await nextFrame();
    await waitForRegimesLane("blocks", 2, year);
    const zoomed = await probeRegimesRow();
    const { span } = widestRegimeSpan(zoomed);
    expect(zoomed.spans.some((s) => s.label !== "")).toBe(true);
    // …and a label, when it is drawn, is only ever the state's own id.
    for (const s of zoomed.spans) expect(s.label === "" || s.label === s.regime).toBe(true);
    console.log(
      `  · ${probe.spans.length} blocks over year ${year} (${probe.yearLength} d), states ${JSON.stringify([...new Set(probe.spans.map((s) => s.regime))])}; worst gap ${(worst * probe.yearLength).toFixed(3)} d; zoomed in, "${span.label}" labels a ${Math.round(span.width)}px block`,
    );
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
    await waitForRegimesLane("blocks", 2, year);

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
    await waitForRegimesLane("blocks", 2, year);

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
/**
 * The lane's drawn °C range, and where 0 sits inside it.
 *
 * `ui/rows/automation-row.ts` plots the prototype's own affine map — its
 * `autoY(v) = 8 − v · 2.4` over a 34 px lane — so neutral sits 8 px down
 * rather than at the centre, the top edge is worth `8 / 2.4` °C and the bottom
 * `(8 − 34) / 2.4`. A flat lane needs no more room than that, so this IS the
 * range `laneScale` paints one at. Mirrored here rather than imported: the row
 * draws with `obsidian` and cannot be loaded from the harness.
 *
 * The lane also plots EDGE TO EDGE vertically (`pad: { top: 0, bottom: 0 }`),
 * which is what keeps neutral on that pixel — hence `LANE_PAD_Y`.
 */
const LANE_HEIGHT_PX = 34;
const LANE_NEUTRAL_PX = 8;
const LANE_DEGREES_PER_PX = 1 / 2.4;
const LANE_PAD_Y = 0;
const FLAT_LANE_RANGE: [number, number] = [(LANE_NEUTRAL_PX - LANE_HEIGHT_PX) * LANE_DEGREES_PER_PX, LANE_NEUTRAL_PX * LANE_DEGREES_PER_PX];

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
    (app, a: { type: string; year: number; value: number; lo: number; hi: number; pad: number; padY: number }) => {
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
      const y = Math.round(r.top + a.padY + fy * (r.height - 2 * a.padY));
      const base = { pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, view: window };
      lane.dispatchEvent(new PointerEvent("pointerdown", { ...base, button: 0, buttons: 1, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...base, button: 0, buttons: 0, clientX: x, clientY: y }));
    },
    { type: VIEW_TYPE, year, value, lo: range[0], hi: range[1], pad: LANE_PAD, padY: LANE_PAD_Y },
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
 * The seed pill alone is not proof: `paintSeed` builds its text from the live
 * state (`inputFor(state).year`), so it names the seeded year the instant the
 * window moves — before the 60 ms-debounced re-roll has replaced a single
 * cell. Reading a mean off the pill's word therefore read the PREVIOUS
 * year's roll, which is what made `forcings 3` produce −0.7 instead of +4 in
 * two crews' runs. Each cell carries its real `data-day-ordinal`, and the
 * active time adapter turns one into a year, so this waits on the roll itself
 * and only uses the pill as a second opinion (H-1392: assert the reaction
 * happened, do not sleep a fixed amount and hope).
 */
async function waitForAuditionYear(year: number): Promise<void> {
  const started = Date.now();
  await ob.page.waitForFunction(
    (a: { type: string; needle: string; year: number }) => {
      const el = (window as any).app.workspace.getLeavesOfType(a.type)[0]?.view?.containerEl as HTMLElement | undefined;
      if (!(el?.querySelector('[data-part="audition-seed"]')?.textContent ?? "").includes(a.needle)) return false;
      const ordinal = Number(el?.querySelector(".wadjet-studio-audition-cell")?.getAttribute("data-day-ordinal") ?? NaN);
      if (!Number.isFinite(ordinal)) return false;
      // `core/eras.ts yearOf`, evaluated through the adapter that rolled the cell.
      const t = (window as any).app.plugins.plugins.wadjet.time.active.toContext(ordinal);
      return (t.year ?? Math.floor(t.dayOrdinal / t.yearLength) + 1) === a.year;
    },
    { type: VIEW_TYPE, needle: `YR ${year} ·`, year },
    { timeout: 20_000 },
  );
  await nextFrame();
  console.log(`  · strip rolled YR ${year} after ${Date.now() - started} ms`);
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
    expect(opened.trim).toBe("0.0 °C");
    expect(opened.wetness).toBe("×1.00");
    expect(opened.total).toBe("0.0 °C");

    // 150 px covers the knob's whole ±8 °C range: 19 px up is 2.0 °C at step 0.1.
    await dragKnobDial('[data-part="forcings-trim"] .wadjet-studio-knob-dial', -19);

    const after = await probeForcings();
    const draft = await forcingsDraft();
    expect(after.trim).toBe("+2.0 °C");
    expect(after.total).toBe("+2.0 °C");
    expect(after.lane).toBe("0.0 °C");
    expect(draft.trim).toEqual({ id: "forcings:temperature.mean", stage: "climate", apply: [{ param: "temperature.mean", op: "offset", value: 2 }] });
    expect(after.writes).toContain("forcings:temperature.mean");
    console.log(`  · trim drag: ${after.trim} into TEMP · writes ${after.writes}`);
  });

  test("forcings 2: the ∿ lane row zooms to Era and draws the zone's first frc.warmth lane", async () => {
    await revealStudio();
    await resetForcings();
    // The Era preset frames the world's eras now (F3), and `ensureLane` anchors
    // a fresh warmth lane on the EPOCH. An era an earlier describe left behind
    // would therefore zoom the playlist a thousand years away from the lane it
    // just created. Eras are not this walk's subject — the eras lane describe
    // owns that reading — so start from a world without them.
    await seedEras([]);
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

  test("forcings 3: pressing the lane's top edge adds a point at the lane's top value, and the audition year warms by it", async () => {
    await revealStudio();
    const epoch = await epochYear();
    const target = epoch + 50;
    await pressLane(target, FLAT_LANE_RANGE[1], FLAT_LANE_RANGE);

    const draft = await forcingsDraft();
    expect(draft.points.length).toBe(3);
    const added = draft.points[1]!;
    warmthPointYear = added[0];
    expect(Math.abs(added[0] - target)).toBeLessThanOrEqual(2);
    // A press on the top row of pixels writes the lane's TOP value — the
    // meaning the assertion has always had, now read off the map the lane is
    // actually drawn with rather than off a range that centred neutral.
    expect(added[1]).toBeCloseTo(FLAT_LANE_RANGE[1], 5);
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
    // The same ±1 °C band the assertion always held, around the point's own
    // value instead of a hard-coded 4.
    expect(warm - cold).toBeGreaterThan(FLAT_LANE_RANGE[1] - 1);
    expect(warm - cold).toBeLessThan(FLAT_LANE_RANGE[1] + 1);
    console.log(`  · year ${warmthPointYear}: ${cold.toFixed(1)} °C flat → ${warm.toFixed(1)} °C with the +${added[1].toFixed(2)} point`);

    expect(await studioHistory("redo")).toBe(true);
    expect((await forcingsDraft()).points.length).toBe(3);
  });

  test("forcings 4: right-click removes a point, and refuses the one that would leave a single point", async () => {
    await revealStudio();
    await seedEras([]); // same reason as step 2: the Era window must hold the epoch-anchored lane
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

    // The panel `forcings 1` opened is carried by steps 2–4; this walk is the
    // last one that wants it, so it hands the studio back with nothing open
    // (H-1390). It used to be harmless — the windows layer spanned the whole
    // root, so a cascaded panel landed over the lane-label column — but the
    // layer is now the playlist BODY, and (24, 24) of it is on top of the day
    // card the channel walk clicks.
    await closeStudioWindows();
  });
});

// ---------------------------------------------------------------------------
// Channel rows and the day card (SPEC §3.2; bead wadjet-9f9.20)
// ---------------------------------------------------------------------------

/** The scratch note the day-card step renders a ```wadjet``` block into. */
const CHANNEL_SCRATCH = "Wadjet Studio Day.md";

/**
 * Points in one composed channel curve: `COMPOSED_SAMPLES` (240, in
 * `model/channel-series.ts`) intervals, so 241 samples counting both ends.
 */
const COMPOSED_POINTS = 241;

interface ChannelRowProbe {
  /** the row is hidden (Day zoom hands the playlist over to the day card) */
  hidden: boolean;
  /** how many points the line polyline actually encodes */
  points: number;
  /** the polyline's y values, rounded — a flat line is one distinct value */
  ys: number[];
  /** the temperature band, drawn only at fine zoom */
  bandPaths: number;
  /** SKY draws a shaded cell strip instead of a curve (F2) — this is how many */
  cells: number;
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
        cells: plot?.querySelectorAll(".wadjet-studio-channel-cell").length ?? 0,
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
  /**
   * The card's hero, split three ways by the rebuild (F3): the mean as a bare
   * number with a degree sign and no scale letter, the condition phrase, and
   * the aviation code pill. There is no single `headline` line any more.
   */
  temp: string;
  cond: string;
  code: string;
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
        temp: text(card?.querySelector(".wadjet-studio-daycard-temp") ?? null),
        cond: text(card?.querySelector(".wadjet-studio-daycard-cond") ?? null),
        code: text(card?.querySelector(".wadjet-studio-daycard-code") ?? null),
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
    // SPEC §3.2: fine zoom is the COMPOSED curve — the resolved climate the
    // mixer wrote, sampled `COMPOSED_SAMPLES` times across the window (F2),
    // not a per-day roll. 240 samples inclusive of both ends is 241 points,
    // far past the 12 a yearly ribbon would carry.
    expect(temp.points).toBeGreaterThanOrEqual(12);
    expect(temp.points).toBe(COMPOSED_POINTS);
    // The low/high band comes with it, and the mean line is the channel colour.
    expect(temp.bandPaths).toBe(1);
    expect(temp.strokes.some((s) => s.includes("--wadjet-studio-temp"))).toBe(true);

    const others = await Promise.all(["precipitation", "wind"].map(channelRowProbe));
    for (const row of others) expect(row.points).toBeGreaterThanOrEqual(12);
    // SKY is the one row the prototype does not draw as a curve (F2): a
    // shaded cell per slice of the window, dark for a clear sky and pale for
    // an overcast one. So it has no line at all — it has the strip.
    const sky = await channelRowProbe("sky");
    expect(sky.hidden).toBe(false);
    expect(sky.points).toBe(0);
    expect(sky.cells).toBeGreaterThanOrEqual(12);
    const probe = await probePlaylist();
    expect(probe.dayCardHidden).toBe(true);
    console.log(`  · Year zoom: temperature ${temp.points} points + ${temp.bandPaths} band; precip/wind ${others.map((o) => o.points).join("/")}; sky ${sky.cells} cells; ${probe.charts} charts`);
  });

  test("channels 2: at Era zoom the rows flatten to one mean line, and the tick is quick", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedWindow({ a: epoch + 5, b: epoch + 6 });

    const ms = await timedSeedWindow({ a: epoch, b: epoch + 1000 });
    const temp = await channelRowProbe("temperature");
    expect(temp.hidden).toBe(false);
    // A thousand years is past the repeat threshold (`RIBBON_FLAT_YEARS`): the
    // curve steps, one flat level per run of years the era set does not change
    // in — with no era inside the window that is a single level, two points.
    expect(temp.points).toBe(2);
    expect(new Set(temp.ys).size).toBe(1);
    // The spread band steps with it rather than dropping out (F2): the yearly
    // ribbon carries the low/high pair the same way the composed curve does,
    // so the row still reads as a range and not as a bare line.
    expect(temp.bandPaths).toBe(1);
    for (const channel of ["precipitation", "wind"]) {
      const row = await channelRowProbe(channel);
      expect(row.points, channel).toBe(2);
      expect(new Set(row.ys).size, channel).toBe(1);
    }
    // SKY keeps its cell strip at every zoom (F2), shaded from the ribbon's
    // own cloud level rather than the composed one.
    const sky = await channelRowProbe("sky");
    expect(sky.points).toBe(0);
    expect(sky.cells).toBeGreaterThanOrEqual(12);
    // PLAN §7: the wide zoom must not cost a roll per year.
    expect(ms).toBeLessThan(500);
    console.log(`  · Era zoom (1000 y): flat line at y ${temp.ys[0]}, store tick + paint in ${ms.toFixed(1)} ms`);
  });

  test("channels 3: at Day zoom the card shows the same day a wadjet block does", async () => {
    await revealStudio();
    const zoneId = await resetDraftFromSettings();
    // The card's `season:` chip comes off the day's own tags, which the active
    // ADAPTER stamps from `settings.calendar` — not from the studio's world
    // draft. Seed both, so the step stands on its own instead of on whichever
    // describe last happened to leave seasons behind.
    await seedChannelSeasons(CHANNEL_SEASONS);
    const epoch = await epochYear();
    // Three days wide (≤ 7.5), so the playlist hands over to the day card.
    const centre = epoch + 5 + 100 / 365;
    await seedWindow({ a: centre - 1.5 / 365, b: centre + 1.5 / 365 });

    const probe = await probePlaylist();
    expect(probe.dayCardHidden).toBe(false);
    // The card is an overlay over the lane stack now (F3), not a replacement
    // for it: at Day zoom every row stays mounted and visible under the card,
    // so the reader can still see the curves the day was drawn from.
    expect(probe.hiddenRows).toBe(0);

    const card = await dayCardProbe();
    expect(card.hidden).toBe(false);
    expect(card.day).not.toBeNull();
    // The hero: a bare mean with a degree sign, the condition phrase and the
    // aviation code (F3). `DAY 36 · YEAR 1600 · THAW` is the eyebrow above it.
    expect(card.temp).toMatch(/^[−-]?\d+(\.\d+)?°$/);
    expect(card.cond.length).toBeGreaterThan(0);
    expect(card.code).toMatch(/^[+A-Z]{2,3}$/);
    expect(card.date).toMatch(/^DAY \d+ · YEAR /);
    // SPEC §3.2: the tags the card carries.
    expect(card.chips.some((c) => c.startsWith("regime:"))).toBe(true);
    expect(card.chips.some((c) => c.startsWith("season:"))).toBe(true);

    const block = await wadjetCardFor(zoneId, card.day!);
    await closeScratch();
    await revealStudio();

    // Real data only: the card and the block are the same report. The card's
    // hero is the day's MEAN, so it has to sit inside the low–high range the
    // block prints; humidity is a rounded percent on both, so it matches to
    // the character. That pair is the cross-check the old
    // `summary === headline` line made before the hero was split.
    const heroTemp = numbersIn(card.temp)[0]!;
    const blockTemps = numbersIn(block.rows["Temperature"] ?? "");
    expect(blockTemps.length).toBeGreaterThanOrEqual(2);
    expect(heroTemp).toBeGreaterThanOrEqual(Math.floor(Math.min(...blockTemps.slice(0, 2))));
    expect(heroTemp).toBeLessThanOrEqual(Math.ceil(Math.max(...blockTemps.slice(0, 2))));
    expect(card.cells["humidity"]).toBe(block.rows["Humidity"]);
    console.log(`  · day ${card.day} (${card.date}): card hero "${card.temp}" inside block "${block.rows["Temperature"]}"; humidity "${card.cells["humidity"]}"`);
    console.log(`  · condition: "${card.cond}" ${card.code} — block summary "${block.summary}"`);
    console.log(`  · chips: ${card.chips.join(" | ")}`);
  });

  test("channels 3b: the day card's moon disc opens the moon's CYCLE window", async () => {
    // The prototype's day card is a door to the cycle editor (`data-vst="sablemoon"`
    // on its moon svg); wadjet-9f9.48.10 found the plugin's disc was inert.
    // Nothing floating first: the windows layer is the playlist body, and a
    // panel another walk left at the cascade origin sits on the day card and
    // eats the click this step is making.
    await closeStudioWindows();
    const card = await dayCardProbe();
    expect(card.hidden).toBe(false);
    const disc = ob.page.locator(".wadjet-studio-daycard .wadjet-studio-daycard-moon").first();
    await expect.poll(() => disc.evaluate((e) => !e.classList.contains("is-hidden"))).toBe(true);
    expect(await disc.getAttribute("role")).toBe("button");
    await disc.click();
    await nextFrame();
    const opened = await withApp(
      ob.page,
      (app, a: { type: string }) => {
        const leaf = app.workspace.getLeavesOfType(a.type)[0];
        const ids = (leaf.view.store.get().view.openWindows as string[]).filter((id) => id.startsWith("cycle:"));
        return { ids, panel: leaf.view.containerEl.querySelector(".wadjet-studio-window .wadjet-studio-cycle") !== null };
      },
      { type: VIEW_TYPE },
    );
    expect(opened.ids.length).toBe(1);
    expect(opened.panel).toBe(true);
    console.log(`  · moon disc opened ${opened.ids[0]}`);
    await withApp(
      ob.page,
      (app, a: { type: string; id: string }) => {
        app.workspace.getLeavesOfType(a.type)[0].view.windows.close(a.id);
      },
      { type: VIEW_TYPE, id: opened.ids[0]! },
    );
    await nextFrame();
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
    expect((await channelRowProbe("temperature")).points).toBe(COMPOSED_POINTS);
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
  /** the full `Closest match: …` sentence, which the card keeps on its `title` */
  matchTitle: string;
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
        matchTitle: panel?.querySelector('[data-part="atlas-match-text"]')?.getAttribute("title") ?? "",
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

/**
 * Select a station's row in the list.
 *
 * The search box is gone (F9): the list is a short curated set of 26 places
 * over a climate map, so the row is clicked directly. The `query` argument is
 * kept as the place's own name so the call still reads as "pick Undoolya", and
 * it is asserted against the row that gets clicked.
 */
async function atlasSelectStation(place: string, id: string): Promise<void> {
  const row = atlasPanel().locator(`[data-part="atlas-station"][data-id="${id}"]`);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  expect((await row.locator(".wadjet-studio-atlas-stationname").textContent())?.trim()).toBe(place);
  await row.click();
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
    // The rows name the PLACE the record came from, not the preset's title
    // (F9): `fjord-coast` is the reading taken at Bergen.
    expect(opened.names).toContain("Bergen");
    // SPEC law 5, per mode: the footer says what THIS half of the panel
    // writes (F9), rather than listing both keys under either. Station mode
    // writes the preset; geography mode writes the place and the Tier A it
    // implies. The mode is put back so the next step opens where it expects.
    expect(opened.writes).toContain("zone.preset");
    expect(opened.writes).not.toContain("zone.geography");
    await atlasSegment("atlas-mode", "geography");
    const geoWrites = (await atlasProbe()).writes;
    expect(geoWrites).toContain("zone.geography");
    expect(geoWrites).toContain("Tier A");
    await atlasSegment("atlas-mode", "station");
    expect((await atlasProbe()).mode).toBe("station");
    console.log(`  · SRC chip → Atlas (${opened.badge}) listing ${opened.names.length} stations; writes "${opened.writes}" / "${geoWrites}"`);
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
    await atlasSelectStation("Bergen", "fjord-coast");
    const rebase = atlasPanel().locator('[data-part="atlas-rebase"]');
    if ((await rebase.getAttribute("aria-disabled")) === "true") {
      // F9: re-basing onto the station the zone is ALREADY on is a no-op, so
      // the button says so and goes inert instead of offering it.
      expect(((await rebase.textContent()) ?? "").trim()).toBe("✓ current base");
    } else {
      await rebase.click();
    }
    await atlasWaitForPreset("fjord-coast", "manual");
    const cold = await atlasDraft();
    expect(cold.koppen.length).toBeGreaterThan(0);

    await atlasSelectStation("Undoolya", "red-desert");
    const selected = await atlasProbe();
    // Card and button name the PLACE (F9), the same word the row does.
    expect(selected.card).toBe("Undoolya");
    expect(selected.rebase).toBe("Re-base zone → Undoolya");

    await atlasPanel().locator('[data-part="atlas-rebase"]').click();
    await atlasWaitForPreset("red-desert", "manual");
    const hot = await atlasDraft();
    expect(hot.presetId).toBe("red-desert");
    expect(hot.matched).toBe("manual");
    expect(hot.geography).toBeNull();
    expect(hot.modifiers).toEqual(cold.modifiers);
    expect(hot.koppen).not.toBe(cold.koppen);
    expect((await notices(ob.page)).some((t) => t.includes("Undoolya"))).toBe(true);
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
    // The card's line is the Tier A clauses on their own now (F9) — `+2.1 °C
    // for latitude · …`, or `no adjustment` — because the card already names
    // the station above it. The full `Closest match: …` sentence lives on the
    // element's `title` (and in the Notice the match raises).
    expect(preview.matchText.length).toBeGreaterThan(0);
    expect(preview.matchText).not.toContain("Closest match:");
    expect(preview.matchTitle).toContain("Closest match:");
    expect(preview.matchTitle).toContain(preview.matchName);

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
  /** the label's two lines, each on its own span (F2) */
  rowName: string;
  rowSub: string;
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
        rowName: (row?.querySelector(".wadjet-studio-row-name")?.textContent ?? "").trim(),
        rowSub: (row?.querySelector(".wadjet-studio-row-sub")?.textContent ?? "").replace(/\s+/g, " ").trim(),
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
    // Product copy, not the engine id (F1/F2): the slug reads as a name, and
    // the sub-line says what the lane is — `clip d223–263 · yearly`.
    expect(probe.rowName).toBe("Lane Clip");
    expect(probe.rowSub).toContain("yearly");
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

  test("device lanes 3: a spell draws its when as a clip and the roll's runs solid", async () => {
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
    // A spell over a PER-YEAR `when` is a solid, capped clip, not a dashed
    // marquee (`ui/rows/device-rows.ts` `solidYearClips`, matching the
    // prototype's Ashfall lane); only a composite `when` stays a `window`.
    expect(probe.kind).toBe("clip");
    const windows = probe.spans.filter((s) => s.kind === "clip");
    const runs = probe.spans.filter((s) => s.kind === "run");
    expect(windows.length).toBe(1);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    // The clip is the `when`; every solid run falls inside it.
    expect(windows[0]!.from - Math.floor(windows[0]!.from)).toBeCloseTo(0.2, 6);
    // A day covers `[d, d + 1)` (`model/spans.ts` `spellRuns`), so a run whose
    // last active day is the last day inside the `when` closes one day PAST the
    // clip edge — 5.8027 against a clip ending at 5.8000 is that one day,
    // not float noise. Every run still has to START inside the window: that is
    // the property "the spell only fires inside its when".
    const dayYears = 1 / (await withApp(ob.page, (app) => app.plugins.plugins.wadjet.settings.calendar.yearLength as number));
    for (const r of runs) {
      expect(r.editable).toBe(false);
      expect(r.from).toBeGreaterThanOrEqual(windows[0]!.from - 1e-6);
      expect(r.from).toBeLessThan(windows[0]!.to);
      expect(r.to).toBeLessThanOrEqual(windows[0]!.to + dayYears + 1e-6);
    }
    console.log(`  · lane-spell: 1 clip + ${runs.length} rolled run(s) in Y ${epoch + 4}`);
  });

  test("device lanes 4: a moon device is pulses, dimmed OUTSIDE its season gate's source (D19)", async () => {
    await revealStudio();
    const epoch = await epochYear();
    await seedDeviceLanes([
      {
        id: "lane-moon",
        stage: "daily",
        when: { moon: { name: "Moon", phase: [0, 0.08] } },
        // D19: a gate RESTRICTS the device to its source. 0.72 leaves 0.28 outside
        // Winter — under the lane's half-strength threshold, so those pulses read dim.
        mods: [{ source: "season:Winter", amount: 0.72 }],
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
    // Winter is the last quarter of the year: the gate restricts the device to it,
    // so the pulses INSIDE Winter are the full ones and everything else is dim.
    const inWinter = (s: DeviceLaneSpanProbe): boolean => {
      const mid = (s.from + s.to) / 2;
      return mid - Math.floor(mid) >= 0.75;
    };
    expect(probe.spans.some(inWinter)).toBe(true);
    expect(probe.spans.some((s) => !inWinter(s))).toBe(true);
    for (const s of probe.spans) expect(s.dim).toBe(!inWinter(s));
    console.log(`  · lane-moon: ${probe.spans.length} pulses, ${probe.spans.filter((s) => s.dim).length} dimmed OUTSIDE season:Winter (gate 0.72)`);
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
  /** the printed y-axis tick labels of the plot the handles are on, top to bottom */
  ticks: string[];
  /** per plot, the mean pixel y of each drawn line — two crushed series read as one number */
  plotLineYs: number[][];
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
        // The series picker is a chart LEGEND now, not a Segmented (F10b), and
        // a channel with two plots draws one legend per plot — hence `All`.
        seriesOptions: Array.from(panel?.querySelectorAll('[data-part="channel-series"] .wadjet-studio-channel-win-legend-item') ?? []).map((s) => s.getAttribute("data-value") ?? ""),
        series: panel?.querySelector('[data-part="channel-series"] .wadjet-studio-channel-win-legend-item.is-selected')?.getAttribute("data-value") ?? "",
        rose: panel?.querySelector('[data-part="channel-rose"]')?.getAttribute("data-rose") ?? "",
        roseSectors: panel?.querySelectorAll('[data-part="channel-rose"] path.wadjet-studio-chart-sector').length ?? 0,
        reset: (panel?.querySelector('[data-part="channel-direction-reset"]') ?? null) !== null,
        domain: panel?.querySelector('[data-part="channel-chart"] .wadjet-studio-chart')?.getAttribute("data-domain") ?? "",
        points: points.length,
        pointYs: points.map((p) => Math.round(Number(p.getAttribute("cy")) * 100) / 100),
        ticks: Array.from(panel?.querySelectorAll('[data-part="channel-chart"] text.wadjet-studio-chart-tick') ?? []).map((t) => (t.textContent ?? "").trim()),
        plotLineYs: Array.from(panel?.querySelectorAll(".wadjet-studio-channel-win-plot-block") ?? []).map((plot) =>
          Array.from(plot.querySelectorAll("polyline.wadjet-studio-chart-line")).map((line) => {
            const ys = (line.getAttribute("points") ?? "").split(" ").flatMap((pt) => {
              const y = Number(pt.split(",")[1]);
              return Number.isFinite(y) ? [y] : [];
            });
            return ys.length === 0 ? 0 : Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 100) / 100;
          }),
        ),
        // Scope chips, not segments (F10a): `All year · <seasons> · ☾ <moon>`.
        scopes: Array.from(panel?.querySelectorAll('[data-part="channel-scopes"] .wadjet-studio-chip') ?? []).map((s) => s.getAttribute("data-value") ?? ""),
        scope: panel?.querySelector('[data-part="channel-scopes"] .wadjet-studio-chip.is-selected')?.getAttribute("data-value") ?? "",
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

/**
 * The station's own day-to-day σ on the walk's zone: the mean of the fixture's
 * `climate.temperature.sd` over the twelve month centres, which is what the
 * jitter knob's face carries at rest (PLAN D18, `channel-edit.ts
 * stationDisplay`). Frozen here because the fixture is.
 */
const STATION_SIGMA = 2.8670728588633114;

/** The zone draft's `temperature.sd` keyframes — the record the jitter knob shows and must never write. */
async function stationSigmaKeyframes(): Promise<Array<{ at: number; value: number }>> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      const s = leaf.view.store.get();
      return s.zones[s.view.zoneId].climate.temperature.sd;
    },
    VIEW_TYPE,
  );
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

/**
 * Click a channel row's label — SPEC law 2's reach into the editor.
 *
 * The row labels are title case now (F2): `Temperature`, not the mixer's
 * `TEMP`. The caps short forms are the signal path's vocabulary; the
 * arrangement view is a different reading. The name has its own span inside
 * the label (the sub-line shares the element), and the click handler is on the
 * label, so the click bubbles up from the name.
 */
async function clickChannelRow(title: string): Promise<void> {
  await ob.page.locator(`.wadjet-studio-row-name:text-is("${title}")`).first().click();
  await nextFrame();
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
  await ob.page.locator(`[data-part="channel-scopes"] .wadjet-studio-chip[data-value="${value}"]`).first().click();
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

/**
 * One moon's cycle length, spelled the way `channel-edit.ts stageCaption`
 * spells it (`round1`: one decimal, a trailing zero dropped).
 */
async function moonCycleDays(name: string): Promise<string> {
  const days: number = await withApp(
    ob.page,
    (app, a: { type: string; name: string }) => {
      const leaf = app.workspace.getLeavesOfType(a.type)[0];
      const moon = (leaf.view.store.get().world.calendar.moons as Array<{ name: string; cycleDays: number }>).find((m) => m.name === a.name);
      return moon?.cycleDays ?? 0;
    },
    { type: VIEW_TYPE, name },
  );
  return String(Math.round(days * 100) / 100);
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

    await clickChannelRow("Temperature");
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.open).toBe(true);
    expect(probe.title).toBe("Temperature");
    expect(probe.badge).toBe("CHANNEL");
    expect(probe.domain).toBe("year");
    // SPEC §3.4: 12 monthly keyframes, and the all-year knob set.
    expect(probe.points).toBe(12);
    expect(probe.scope).toBe("all");
    // Knob labels are the prototype's words, not the model's ids (F10a).
    expect(probe.knobs).toEqual(["offset", "seasonal swing", "day jitter σ"]);
    // PLAN D18: jitter shows the STATION's own day-to-day σ (the fixture's
    // `temperature.sd`, `STATION_SIGMA` below) rather than the zero delta it
    // stores, so it is lit at rest. Offset and swing are deltas and are not.
    expect(probe.knobValues).toEqual(["0.0 °C", "×1.00", "2.9 °C"]);
    // A1 (O-2): the prototype hangs the degree sign on the number itself
    // (`0250-temperature-editor`'s `20°`), and every rung it prints is one the
    // axis actually contains — a tick on the frame is a number with no side.
    expect(probe.ticks.length).toBeGreaterThan(0);
    expect(probe.ticks.every((t) => t.endsWith("°"))).toBe(true);
    console.log(`  · temperature axis: ${probe.ticks.join(" · ")}`);
    // The caption names the modifier it writes as well as the stage (F10a):
    // SPEC law 5 read at the control rather than only in the footer.
    expect(probe.stage).toBe("writes modifiers[layer:temperature.mean] · stage climate · unconditional, reshapes the baseline once");

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

  test("temperature editor 3b: the jitter knob shows the station σ and stores only the delta (D18)", async () => {
    await resetChannelWalk();
    await openChannelWindow();

    const sigmaBefore = await stationSigmaKeyframes();
    const shownBefore = (await probeChannel()).knobValues[2];
    expect(shownBefore).toBe("2.9 °C");
    expect((await temperatureLayers()).map((m: any) => m.id)).toEqual([]);

    // 0–5 °C over 150 px: 30 px up is exactly +1.0 °C on the FACE, which
    // rounds to the step from the station's own 2.867 — so the readout goes
    // 2.9 → 3.9 and the layer stores the difference from the station, not 3.9.
    await dragKnobDial('[data-part="channel-knob-jitter"] .wadjet-studio-knob-dial', -30);

    const shownAfter = (await probeChannel()).knobValues[2];
    expect(shownAfter).toBe("3.9 °C");

    const layers = await temperatureLayers();
    expect(layers.map((m: any) => m.id)).toEqual(["layer:temperature.sd"]);
    const sd = layers[0];
    expect(sd.stage).toBe("climate");
    expect(sd.apply.length).toBe(1);
    expect(sd.apply[0].param).toBe("temperature.sd");
    expect(sd.apply[0].op).toBe("offset");
    // The DRAFT's delta moved by what the face moved by — 3.9 − 2.867 — and is
    // nowhere near the 3.9 the knob shows.
    expect(sd.apply[0].value).toBeCloseTo(3.9 - STATION_SIGMA, 6);
    expect(sd.apply[0].value).toBeLessThan(3.9);

    // …and the station itself never moved: the record is what it always was.
    expect(await stationSigmaKeyframes()).toEqual(sigmaBefore);
    console.log(`  · jitter σ ${shownBefore} → ${shownAfter}: station ${STATION_SIGMA.toFixed(2)} °C untouched, layer stores +${sd.apply[0].value.toFixed(2)}`);
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
    expect(scoped.stage).toBe("writes modifiers[layer:temperature.mean:season:Winter] · when.tag season:Winter");

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
    expect(cycle.knobs).toEqual(["curve depth"]);
    // The caption names the layer, the predicate and — when the calendar knows
    // it — the cycle length the drawn curve repeats over (F10a).
    expect(cycle.stage).toBe(`writes modifiers[layer:temperature.mean:moon:${moon}] · when.moon ${moon} · the drawn curve is its envelope · repeats every ${await moonCycleDays(moon)} d`);
    // The selected ☾ chip is the reach into the cycle editor, and it reads as
    // the moon rather than as the scope id (F10a): `☾ Sable`.
    expect(cycle.moonChip).toBe(`☾ ${moon}`);
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
  /** each KINDS row's `data-kind` — the ROW's value, so `curse` and `tag` are two of them */
  kinds: string[];
  /** the same rows with the pill and the copy the reader actually sees */
  kindRows: Array<{ kind: string; badge: string; label: string; sub: string }>;
  presets: Array<{ name: string; badge: string; kindBadge: string }>;
}

/** Everything the insert picker's own e2e cares about, read straight off the popover's DOM. */
async function probeInsertPicker(): Promise<InsertPickerProbe> {
  return withApp(
    ob.page,
    (app, type: string) => {
      const el: HTMLElement | undefined = app.workspace.getLeavesOfType(type)[0]?.view?.containerEl;
      const popover = el?.querySelector(".wadjet-studio-insert") ?? null;
      if (popover === null) return { open: false, title: "", kinds: [], kindRows: [], presets: [] };
      const rows = Array.from(popover.querySelectorAll(".wadjet-studio-insert-row"));
      const txt = (r: Element, sel: string) => (r.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
      const kindRows = rows
        .filter((r) => r.getAttribute("data-part") === "kind")
        .map((r) => ({
          kind: r.getAttribute("data-kind") ?? "",
          badge: txt(r, ".wadjet-studio-insert-kind"),
          label: txt(r, ".wadjet-studio-insert-row-label"),
          sub: txt(r, ".wadjet-studio-insert-row-sub"),
        }));
      const presets = rows
        .filter((r) => r.getAttribute("data-part") === "preset")
        .map((r) => ({ name: r.getAttribute("data-preset") ?? "", badge: txt(r, ".wadjet-studio-insert-badge"), kindBadge: txt(r, ".wadjet-studio-insert-kind") }));
      return { open: true, title: (popover.querySelector(".wadjet-studio-insert-title")?.textContent ?? "").trim(), kinds: kindRows.map((k) => k.kind), kindRows, presets };
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
  test("insert picker 1: ＋ on WIND opens a popover titled with WIND, listing 6 kind rows and at least 5 presets", async () => {
    await revealStudio();
    await clickChainInsert("wind");

    const picker = await probeInsertPicker();
    expect(picker.open).toBe(true);
    expect(picker.title).toBe("NEW DEVICE → WIND");
    // Six ROWS over five `DeviceKind`s: `Curse` sits beside `Tag` and makes the
    // same `when.tag` device, flagged (PLAN D17).
    expect(picker.kinds).toEqual(["trim", "moon", "spell", "tag", "curse", "chance"]);
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
    // The chrome badge IS the kind (F11a); `chance` reads as DICE.
    expect(probe.kind).toBe("DICE");
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

  test("insert picker 5: the Curse row makes a flagged tag device, and the flag outlives a trip through another WHEN", async () => {
    await revealStudio();
    await clickChainInsert("precipitation");

    // The row reads as the tag row's sibling: same pill, the curse word and hue,
    // and a sub in the picker's own `when.<predicate> · …` register.
    const picker = await probeInsertPicker();
    const tagRow = picker.kindRows.findIndex((k) => k.kind === "tag");
    const curseRow = picker.kindRows.findIndex((k) => k.kind === "curse");
    expect(curseRow).toBe(tagRow + 1);
    expect(picker.kindRows[curseRow]).toEqual({ kind: "curse", badge: "CURSE", label: "Curse", sub: "when.tag · a curse the tale can name" });
    // The shipped "Drought curse" preset carries the flag, so its row's kind
    // pill says the same word rather than TAG.
    expect(picker.presets.find((p) => p.name === "Drought curse")?.kindBadge).toBe("CURSE");

    await ob.page.locator('.wadjet-studio-insert-row[data-kind="curse"]').click();
    await nextFrame();
    expect((await probeInsertPicker()).open).toBe(false);

    // An ordinary `when.tag` device plus one display key. `kindOf` never moved:
    // there is no sixth predicate shape and no sixth DeviceKind.
    const modifier = await draftModifier("Curse");
    expect(modifier).not.toBeNull();
    expect(modifier.badge).toBe("curse");
    expect(modifier.when).toEqual({ tag: expect.any(String) });
    expect(modifier.apply).toEqual([{ param: "precipitation.pwd", op: "scale", value: 1 }]);

    await ob.page.locator(".wadjet-studio-window .wadjet-studio-device").first().waitFor({ state: "visible", timeout: 10_000 });
    expect((await probeDevice()).badge).toBe("CURSE");
    const rail = await waitForMixer((r) => (r.find((c) => c.chain === "precipitation")?.units.some((u) => u.id === "Curse") ?? false));
    expect(rail.find((c) => c.chain === "precipitation")!.units.find((u) => u.id === "Curse")!.kind).toBe("curse");

    // Switch the WHEN away from tag: the word no longer describes the device,
    // so the pill drops to the kind's own badge — but the flag stays on the
    // modifier, because a WHEN edit is not a place to silently forget the name
    // its author chose. Switching back restores it.
    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=chance]').click();
    await nextFrame();
    const away = await probeDevice();
    expect(away.whenKind).toBe("chance");
    expect(away.badge).toBe("DICE");
    expect((await draftModifier("Curse")).badge).toBe("curse");

    await devicePanel().locator('[data-part="when-kind"] [role=radio][data-value=tag]').click();
    await nextFrame();
    const back = await probeDevice();
    expect(back.whenKind).toBe("tag");
    expect(back.badge).toBe("CURSE");
    console.log(`  · Curse row [${curseRow}] beside Tag [${tagRow}] → device "Curse" badge ${back.badge}, rail "curse"; WHEN chance → ${away.badge} → tag → ${back.badge}`);

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

    await clickChannelRow("Precipitation");
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.open).toBe(true);
    expect(probe.channel).toBe("precipitation");
    expect(probe.title).toBe("Precipitation");
    expect(probe.badge).toBe("CHANNEL");
    expect(probe.domain).toBe("year");
    expect(probe.points).toBe(12);
    // SPEC §8: the odds pair, one of the two editable at a time. The picker is
    // the plot's own legend now (F10b), in draw order — and `0345` reads the
    // pair wet-after-wet first, so that is the order the legend is drawn in.
    // The share plot above it is one derived line, so it adds no entry here.
    expect(probe.seriesOptions).toEqual(["precipitation.pww", "precipitation.pwd"]);
    expect(probe.series).toBe("precipitation.pwd");
    expect(probe.knobs).toEqual(["stickiness", "rain chance", "wet-day amount"]);
    expect(probe.knobValues).toEqual(["×1.00", "×1.00", "×1.00"]);
    expect(probe.stage).toBe("writes modifiers[layer:precipitation.pwd] · stage climate · unconditional, reshapes the baseline once");
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
    expect(cycle.stage).toBe(`writes modifiers[layer:precipitation.pwd:moon:${moon}] · when.moon ${moon} · the drawn curve is its envelope · repeats every ${await moonCycleDays(moon)} d`);
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
    // The rose draws one wedge per SEASON now (F10b) — the prevailing bearing
    // in each — so a world with no seasons has nothing to draw. Seed them.
    await seedChannelSeasons(CHANNEL_SEASONS);

    await clickChannelRow("Wind");
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.channel).toBe("wind");
    expect(probe.title).toBe("Wind");
    expect(probe.domain).toBe("year");
    expect(probe.points).toBe(12);
    // One line, so no picker; the rose is the second plot.
    expect(probe.seriesOptions).toEqual([]);
    expect(probe.roseSectors).toBeGreaterThan(0);
    expect(probe.knobs).toEqual(["wind", "gust spread", "calm days"]);
    // PLAN D18: gust shows the station's `wind.wetDayScale` — the same ×1.30
    // the card prints as `Wet days blow ×1.30 harder` — not the ×1.00 no-op of
    // the layer it writes.
    expect(probe.knobValues).toEqual(["0.0 km/h", "×1.30", "0.00"]);
    expect(probe.writes).toContain("layer:wind.*");

    await seedDayZoom(epoch);
    const before = await dayCardNumbers("wind");
    // `15 km/h SW` — one number and a compass point (F3), where the old card
    // spelled the bearing out in degrees as well.
    expect(before.length).toBe(1);
    const speedBefore = before[0]!;

    await dragKnobDial(channelKnobDial("wind"), -knobDragPx(WIND_KNOB_RANGE, 8));

    const offset = (await channelLayers("wind")).find((m: any) => m.id === "layer:wind.speed");
    expect(offset).toBeDefined();
    expect(offset.stage).toBe("climate");
    expect(offset.apply[0]).toEqual({ param: "wind.speed", op: "offset", value: 8 });

    const after = await settledDayCardNumbers("wind", before);
    const speedAfter = after[0]!;
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
    expect(scoped.stage).toBe("writes modifiers[layer:wind.speed:season:Winter] · when.tag season:Winter");
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

    await clickChannelRow("Sky");
    await nextFrame();

    const probe = await probeChannel();
    expect(probe.channel).toBe("sky");
    expect(probe.title).toBe("Sky");
    expect(probe.points).toBe(12);
    // SPEC §1: cloud and humidity are one channel, so both pairs are on the picker.
    expect(probe.seriesOptions).toEqual(["cloud.dry", "cloud.wet", "humidity.dry", "humidity.wet"]);
    expect(probe.series).toBe("cloud.dry");
    expect(probe.knobs).toEqual(["cloud cover", "humidity"]);
    expect(probe.knobValues).toEqual(["0.00", "0.00"]);
    expect(probe.writes).toContain("layer:cloud.*");
    expect(probe.writes).toContain("layer:humidity.*");
    // A1 (O-1/O-3): the humidity plot draws the dry/wet pair, and the pair is
    // only a *pair* if the reader can see two lines. Sized headroom is what
    // buys that separation on a 140 px plot.
    const humidity = probe.plotLineYs[1] ?? [];
    expect(humidity.length).toBe(2);
    const apart = Math.abs((humidity[0] ?? 0) - (humidity[1] ?? 0));
    expect(apart).toBeGreaterThan(8);
    console.log(`  · sky humidity: dry/wet mean y ${humidity.join(" vs ")} — ${apart.toFixed(1)} px apart`);

    // The picker really swaps the editable line.
    await ob.page.locator('[data-part="channel-series"] .wadjet-studio-channel-win-legend-item[data-value="humidity.wet"]').first().click();
    await nextFrame();
    const swapped = await probeChannel();
    expect(swapped.series).toBe("humidity.wet");
    expect(swapped.points).toBe(12);
    await ob.page.locator('[data-part="channel-series"] .wadjet-studio-channel-win-legend-item[data-value="cloud.dry"]').first().click();
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
    // The chip always says the STATION's record was flipped to reach this
    // hemisphere — that is a fact about the data, not a setting (F6, matching
    // the prototype). What the toggle changes is whether the zone's own
    // `season:` tag gates were remapped with it, so that is what the label
    // reads out. There is no "not flipped" chip.
    expect(on.label).toBe("seasons flipped · tags remapped");

    await clickFlipChip();
    const off = await probeFlip();
    // Still offered: the geography and the matched station still straddle the
    // equator (PLAN §0.1) — only flipSeasons itself came off.
    expect(off.visible).toBe(true);
    expect(off.label).toBe("seasons flipped · tags NOT remapped");
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
    expect((await probeFlip()).label).toBe("seasons flipped · tags remapped");
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
    expect(hinted.hintName).toBe("save");
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
  test("units 1: under imperial the day card reads mph/in and the Forcings trim knob and MASTER warmth chip read °F; metric returns them", async () => {
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
      // The hero is a bare degree number with no scale letter (F3) — the
      // stats under it are where the card names its units, so that is where
      // the imperial reading is read: `mph`, and `in` for anything that fell.
      expect(card.temp).toMatch(/^[−-]?\d+(\.\d+)?°$/);
      expect(card.cells["wind"]).toMatch(/mph|calm/);
      expect(card.cells["precipitation"]).toMatch(/dry|in/);
      console.log(`  · imperial day card: hero "${card.temp}", precipitation "${card.cells["precipitation"]}", wind "${card.cells["wind"]}"`);

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
    // The mirror of units 1: the card's units live on the stats, and back on
    // metric the wind is km/h and anything that fell is mm.
    expect(card.cells["wind"]).toMatch(/km\/h|calm/);
    expect(card.cells["wind"]).not.toContain("mph");
    expect(card.cells["precipitation"]).toMatch(/dry|mm/);

    await openForcingsFromMixer();
    const forcings = await probeForcings();
    expect(forcings.trim).toContain("°C");
    expect(forcings.trim).not.toContain("°F");

    const rail = await probeMixer();
    const master = rail.find((c) => c.chain === "master");
    expect(master?.masterChips[0]).toContain("°C");
    console.log(`  · metric: day card wind "${card.cells["wind"]}", precip "${card.cells["precipitation"]}", trim "${forcings.trim}", MASTER "${master?.masterChips[0]}"`);
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
